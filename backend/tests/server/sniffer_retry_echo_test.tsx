import { it, expect } from '@jest/globals'
import { RtuFrameParser } from '../../src/server/sniffer/parser.js'
import { SnifferService } from '../../src/server/sniffer/snifferService.js'
import { InMemorySnifferStore } from '../../src/server/sniffer/store.js'
import { TelegramDirection } from '../../src/server/sniffer/types.js'

/** Build a valid RTU frame: [slave, fc, ...payload, crcLo, crcHi]. */
function frame(slave: number, fc: number, payload: number[] = []): number[] {
  const body = [slave, fc, ...payload]
  const crc = RtuFrameParser.crc16(body)
  return [...body, crc & 0xff, (crc >> 8) & 0xff]
}

it('classifies a byte-identical RETRY of a read request as request, never as response', () => {
  // A master that gets no answer re-sends the SAME frame after its timeout.
  // The old classifier treated any request-shaped frame that echoed the
  // pending request as a response -> the retry polluted the stream as a fake
  // response with garbage values. A read response (fc 01-04) NEVER has the
  // request shape (addr+qty): it carries byteCount+register words instead.
  const received: TelegramDirection[] = []
  const parser = new RtuFrameParser((t) => received.push(t.direction), 20)
  const req = frame(5, 0x03, [0x01, 0xf5, 0x00, 0x03])
  const retry = frame(5, 0x03, [0x01, 0xf5, 0x00, 0x03]) // identical bytes
  let now = 1000
  req.forEach((b) => { parser.feed([b], now); now += 3 })
  now += 50
  retry.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.feed([], now + 50)
  expect(received).toEqual([TelegramDirection.request, TelegramDirection.request])
})

it('still classifies a REAL read response (byteCount+words) as response', () => {
  const received: TelegramDirection[] = []
  const parser = new RtuFrameParser((t) => received.push(t.direction), 20)
  const req = frame(5, 0x03, [0x01, 0xf5, 0x00, 0x03])
  const resp = frame(5, 0x03, [0x06, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]) // byteCount + 3 words
  let now = 1000
  req.forEach((b) => { parser.feed([b], now); now += 3 })
  now += 50
  resp.forEach((b) => { parser.feed([b], now); now += 3 })
  parser.feed([], now + 50)
  expect(received).toEqual([TelegramDirection.request, TelegramDirection.response])
})

it('separates a request that is immediately followed by its echo (RS485 TX loopback) into two frames', () => {
  // On RS485 half-duplex the transceiver loops the master's own TX back into
  // RX. The bus-port tap delivers request+echo back-to-back (no inter-frame
  // silence). The parser must still emit TWO frames (request + echo/retry),
  // not one merged frame that fails CRC and drops both.
  const received: TelegramDirection[] = []
  const parser = new RtuFrameParser((t) => received.push(t.direction), 20)
  const req = frame(3, 0x04, [0x00, 0x10, 0x00, 0x01])
  let now = 1000
  // Both frames arrive in ONE chunk, no silence between them (worst case).
  parser.feed([...req, ...req], now)
  parser.feed([], now + 50)
  expect(received).toEqual([TelegramDirection.request, TelegramDirection.request])
})

it('service: retry after timeout does not create a fake response register value', async () => {
  const store = new InMemorySnifferStore()
  const config = { busId: 1, mode: 'stack', enabled: true }
  store.upsertConfig(config)
  const svc = new SnifferService(config, store)
  await svc.start()
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02])) // retry, same bytes
  await svc.stop()

  const telegrams = store.getTelegrams(1)
  expect(telegrams).toHaveLength(2)
  for (const t of telegrams) {
    expect(t.direction).toBe(TelegramDirection.request)
    expect(t.values).toBeUndefined() // no garbage "value" from a retry
  }
  // The retry must not count as a response on the device.
  const devices = store.getDevices(1)
  expect(devices[0].requestCount).toBe(2)
  expect(devices[0].responseCount).toBe(0)
})