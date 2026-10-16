import { ParsedTelegram, RegisterRange, TelegramDecoded, TelegramDirection } from './types.js'

/**
 * Decodes the payload of a Modbus PDU into a structured form for the UI.
 * Pure functions, no I/O. Function codes follow the Modbus Application
 * Protocol V1.1b (and the 0x2b encapsulation is treated as opaque).
 */
export const FUNCTION_NAMES: Record<number, string> = {
  0x01: 'readCoils',
  0x02: 'readDiscreteInputs',
  0x03: 'readHoldingRegisters',
  0x04: 'readInputRegisters',
  0x05: 'writeSingleCoil',
  0x06: 'writeSingleRegister',
  0x07: 'readExceptionStatus',
  0x08: 'diagnostics',
  0x0b: 'readFifoQueue',
  0x0f: 'writeMultipleRegisters',
  0x10: 'writeMultipleRegisters',
  0x11: 'reportSlaveId',
  0x14: 'readFileRecord',
  0x15: 'writeFileRecord',
  0x16: 'maskWriteRegister',
  0x17: 'readWriteMultipleRegisters',
  0x18: 'readFifoQueue',
  0x2b: 'encapsulatedTransport',
}

/** 2 bytes big-endian: address/quantity used by most PDUs. */
function be16(payload: number[], offset: number): number {
  return (payload[offset] << 8) | payload[offset + 1]
}

/**
 * Decodes payload bytes into a TelegramDecoded. Returns undefined when the
 * frame shape is not recognized (e.g. a custom/encapsulated frame).
 */
export function decodePdu(telegram: ParsedTelegram): TelegramDecoded | undefined {
  const fc = telegram.functionCode
  const p = telegram.payload
  const isException = (fc & 0x80) !== 0
  if (isException) {
    return { functionName: FUNCTION_NAMES[fc & 0x7f], exceptionCode: p.length > 0 ? p[0] : undefined }
  }

  const name = FUNCTION_NAMES[fc]
  if (!name) return undefined

  const direction = telegram.direction
  // Standard read requests (0x01-0x04, 0x0f/0x10 for coils/registers) carry
  // address(2) + quantity(2). Their responses carry byteCount(1) + values.
  const isReadRequest =
    direction === TelegramDirection.request && [0x01, 0x02, 0x03, 0x04].includes(fc)
  const isReadResponse = direction === TelegramDirection.response && [0x01, 0x02, 0x03, 0x04].includes(fc)
  const isWriteRequest = direction === TelegramDirection.request && [0x05, 0x06, 0x0f, 0x10].includes(fc)
  const isWriteResponse = direction === TelegramDirection.response && [0x05, 0x06, 0x0f, 0x10].includes(fc)

  if (isReadRequest && p.length >= 4) {
    const decoded: TelegramDecoded = {
      functionName: name,
      address: be16(p, 0),
      length: be16(p, 2),
    }
    return decoded
  }
  if (isReadResponse && p.length >= 1) {
    const byteCount = p[0]
    const values: number[] = []
    for (let i = 1; i + 1 < p.length && values.length < byteCount / 2; i += 2) {
      values.push(be16(p, i))
    }
    return { functionName: name, byteCount, values }
  }
  if (isWriteRequest && p.length >= 4) {
    const decoded: TelegramDecoded = {
      functionName: name,
      address: be16(p, 0),
      // 0x05/0x06 carry a single value; 0x0f/0x10 carry quantity(2)+byteCount(1)+values.
      length: [0x05, 0x06].includes(fc) ? 1 : p.length >= 4 ? be16(p, 2) : undefined,
    }
    if ([0x05, 0x06].includes(fc) && p.length >= 4) decoded.values = [be16(p, 2)]
    else if (p.length >= 7) {
      const bc = p[4]
      const vals: number[] = []
      for (let i = 5; i + 1 < p.length && vals.length < bc / 2; i += 2) vals.push(be16(p, i))
      decoded.values = vals
    }
    return decoded
  }
  if (isWriteResponse && p.length >= 4) {
    return { functionName: name, address: be16(p, 0), length: [0x05, 0x06].includes(fc) ? 1 : be16(p, 2) }
  }
  // Fallback: expose the payload unchanged for unknown shapes.
  return { functionName: name }
}

/**
 * Extracts address ranges from a decoded request so the service can create/
 * update register inventory entries.
 */
export function registerRanges(telegram: ParsedTelegram): RegisterRange[] | undefined {
  if (telegram.direction !== TelegramDirection.request) return undefined
  const d = telegram.decoded
  if (!d || d.address === undefined || d.length === undefined) return undefined
  return [{ address: d.address, quantity: d.length }]
}

/** Maps a decoded response's values to absolute register addresses. */
export function valueAddresses(telegram: ParsedTelegram, baseAddress: number, values: number[]): { address: number; value: number }[] {
  const rc: { address: number; value: number }[] = []
  values.forEach((v, idx) => rc.push({ address: baseAddress + idx, value: v }))
  return rc
}

/**
 * Evaluates a manual register annotation converter against the captured raw
 * word(s). The UI stores free-form text in the converter field (e.g.
 * "number * 0.1", "value / 10", "0.1", "temperature °C") — this parser
 * extracts the mathematical part and applies it to the numeric raw value.
 *
 * Supported forms (case-insensitive):
 *   - "number * 0.1" / "value * 0.1"   multiply the raw value
 *   - "value / 10" / "number : 2"      divide the raw value
 *   - "0.1" / "x * 0.1" / "* 0.1"      bare multiplier (defaults to multiply)
 *   - "number + 5" / "value - 2"       add/subtract an offset
 *   - "number * 0.1 + 5"               combined multiplier and offset
 *   - anything else (descriptive text) is treated as an opaque label: the raw
 *     value is returned unchanged so the column still shows the raw number.
 *
 * Returns the applied numeric result when the expression was understood,
 * otherwise undefined (caller keeps the raw display).
 */
export function evaluateManualConverter(converter: string | undefined, rawWords: number[]): number | undefined {
  if (!converter || rawWords.length === 0) return undefined
  const raw = rawWords[0]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined

  // Keep only numbers, math operators, the 'v' placeholder and whitespace.
  const expr = converter
    .toLowerCase()
    .replace(/[°]/g, ' ')
    .replace(/[^0-9.v+\-*/:,\s]/g, ' ')
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
  if (!expr) return undefined

  let offset = 0
  let body = expr
  // Trailing offset: "... + 5" / "... - 2.5" (not part of a multiplier/divisor).
  const offMatch = /([+-])\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(expr)
  if (offMatch && !/(\*|\/|:)\s*[0-9.]+\s*$/.test(expr)) {
    offset = parseFloat(offMatch[1] + offMatch[2])
    body = expr.slice(0, offMatch.index).trim()
  }

  let divisor: number | undefined
  const divMatch = /(\/|:)\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(body)
  if (divMatch) {
    divisor = parseFloat(divMatch[2])
    body = body.slice(0, divMatch.index).trim()
  }

  let multiplier: number | undefined
  const stripV = body.replace(/v/g, '').trim()
  const multMatch = /\*\s*([0-9]+(?:\.[0-9]+)?)\s*$/.exec(stripV) || /^([0-9]+(?:\.[0-9]+)?)\s*\*?\s*$/.exec(stripV)
  if (multMatch) multiplier = parseFloat(multMatch[1])

  // Nothing math-like survived -> opaque description, keep the raw value.
  if (multiplier === undefined && divisor === undefined && offset === 0 && !/[0-9]/.test(stripV.replace(/\*/g, ''))) {
    return undefined
  }

  let v = raw
  if (divisor !== undefined && divisor !== 0) v = v / divisor
  else if (multiplier !== undefined && multiplier !== 0) v = v * multiplier
  if (offset !== 0) v = v + offset
  const rounded = Math.round(v * 1e10) / 1e10
  return Number.isFinite(rounded) ? rounded : undefined
}
