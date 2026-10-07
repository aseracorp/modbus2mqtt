import { it, expect } from '@jest/globals'
import { RtuFrameParser } from '../../src/server/sniffer/parser.js'
import { decodePdu, registerRanges } from '../../src/server/sniffer/decode.js'
import { ParsedTelegram, TelegramDirection } from '../../src/server/sniffer/types.js'

/** Build a valid RTU frame: [slave, fc, ...payload, crcLo, crcHi]. */
function frame(slave: number, fc: number, payload: number[] = []): number[] {
  const body = [slave, fc, ...payload]
  const crc = RtuFrameParser.crc16(body)
  return [...body, crc & 0xff, (crc >> 8) & 0xff]
}

it('crc16 matches the Modbus reference vector', () => {
  const bytes = [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]
  expect(RtuFrameParser.crc16(bytes)).toBe(0x4b37)
})

it('parses a simple read request (fc 0x03) fed byte-by-byte with silence gaps', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const raw = frame(1, 0x03, [0x00, 0x6b, 0x00, 0x03])
  let now = 1000
  for (const b of raw) {
    parser.feed([b], now)
    now += 5
  }
  parser.feed([], now + 100)
  expect(received).toHaveLength(1)
  const t = received[0]
  expect(t.slaveId).toBe(1)
  expect(t.functionCode).toBe(0x03)
  expect(t.crcOk).toBe(true)
  expect(t.direction).toBe(TelegramDirection.request)
  expect(t.payload).toEqual([0x00, 0x6b, 0x00, 0x03])
  expect(t.raw).toEqual(raw)
  expect(t.decoded?.address).toBe(0x6b)
  expect(t.decoded?.length).toBe(3)
})

it('separates two back-to-back frames on a silence gap', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const f1 = frame(1, 0x03, [0x00, 0x00, 0x00, 0x01])
  const f2 = frame(2, 0x04, [0x00, 0x00, 0x00, 0x02])
  let now = 1000
  f1.forEach((b) => { parser.feed([b], now); now += 3 })
  now += 50
  f2.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.feed([], now + 50)
  expect(received).toHaveLength(2)
  expect(received[0].slaveId).toBe(1)
  expect(received[1].slaveId).toBe(2)
})

it('classifies a read response correctly when a request precedes it', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const req = frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02])
  const resp = frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78])
  let now = 1000
  req.forEach((b) => { parser.feed([b], now); now += 3 })
  now += 50
  resp.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.feed([], now + 50)
  expect(received).toHaveLength(2)
  expect(received[0].direction).toBe(TelegramDirection.request)
  expect(received[1].direction).toBe(TelegramDirection.response)
  expect(received[1].decoded?.values).toEqual([0x1234, 0x5678])
  expect(received[1].decoded?.byteCount).toBe(4)
})

it('marks a frame with a bad CRC as crcOk=false but still emits it', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const raw = frame(5, 0x03, [0x00, 0x00, 0x00, 0x01])
  raw[raw.length - 1] ^= 0xff
  let now = 1000
  raw.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.feed([], now + 50)
  expect(received).toHaveLength(1)
  expect(received[0].crcOk).toBe(false)
  expect(received[0].slaveId).toBe(5)
})

it('drops garbage frames shorter than 4 bytes', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  let now = 1000
  parser.feed([0xde, 0xad], now)
  parser.feed([], now + 50)
  expect(received).toHaveLength(0)
})

it('decodes an exception response (0x83) as response with exceptionCode', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const req = frame(1, 0x03, [0x00, 0x00, 0x00, 0x01])
  const resp = frame(1, 0x83, [0x02])
  let now = 1000
  req.forEach((b) => { parser.feed([b], now); now += 3 })
  now += 50
  resp.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.feed([], now + 50)
  const exception = received.find((t) => t.direction === TelegramDirection.response)
  expect(exception).toBeDefined()
  expect(exception!.decoded?.exceptionCode).toBe(0x02)
  expect(exception!.decoded?.functionName).toBe('readHoldingRegisters')
})

it('decodes a writeMultipleRegisters request (0x10) with values', () => {
  const telegram: ParsedTelegram = {
    direction: TelegramDirection.request,
    timestamp: 0,
    slaveId: 1,
    functionCode: 0x10,
    payload: [0x00, 0x6b, 0x00, 0x02, 0x04, 0x12, 0x34, 0x56, 0x78],
    raw: [], crcOk: true,
  }
  const decoded = decodePdu(telegram)
  expect(decoded?.functionName).toBe('writeMultipleRegisters')
  expect(decoded?.address).toBe(0x6b)
  expect(decoded?.length).toBe(2)
  expect(decoded?.values).toEqual([0x1234, 0x5678])
})

it('registerRanges extracts address ranges from a read request', () => {
  const telegram: ParsedTelegram = {
    direction: TelegramDirection.request,
    timestamp: 0,
    slaveId: 1,
    functionCode: 0x03,
    payload: [0x00, 0x6b, 0x00, 0x02],
    raw: [], crcOk: true,
    decoded: { address: 0x6b, length: 2 },
  }
  expect(registerRanges(telegram)).toEqual([{ address: 0x6b, quantity: 2 }])
  telegram.direction = TelegramDirection.response
  expect(registerRanges(telegram)).toBeUndefined()
})

it('flushes the remaining buffer on explicit flush()', () => {
  const received: ParsedTelegram[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const raw = frame(7, 0x06, [0x00, 0x01, 0x00, 0x02])
  let now = 1000
  raw.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.flush(now + 10)
  expect(received).toHaveLength(1)
  expect(received[0].decoded?.address).toBe(1)
  expect(received[0].decoded?.values).toEqual([2])
})
