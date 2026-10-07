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