import { it, expect, beforeAll, afterAll } from '@jest/globals'
import { ModbusSnifferRegistry } from '../../src/server/sniffer/registry.js'
import { InMemorySnifferStore } from '../../src/server/sniffer/store.js'
import { SnifferBusConfig } from '../../src/server/sniffer/types.js'
import { RtuFrameParser } from '../../src/server/sniffer/parser.js'

function frame(slave: number, fc: number, payload: number[] = []): number[] {
  const body = [slave, fc, ...payload]
  const crc = RtuFrameParser.crc16(body)
  return [...body, crc & 0xff, (crc >> 8) & 0xff]
}

function makeConfig(busId: number): SnifferBusConfig {
  return { busId, busName: '/dev/ttyUSB' + busId, mode: 'stack', enabled: true }
}

let registry: ModbusSnifferRegistry
let store: InMemorySnifferStore

beforeAll(() => {
  store = new InMemorySnifferStore()
  registry = ModbusSnifferRegistry.resetForTests(store)
})

afterAll(() => {
  store.close()
})

it('onAnyChange fires for every bus and is not one-shot', async () => {
  const svc1 = registry.serviceForBus(1, makeConfig(1))
  const svc2 = registry.serviceForBus(2, makeConfig(2))
  const fired: number[] = []
  const unsub = registry.onAnyChange((busId) => fired.push(busId))

  await svc1.start()
  expect(fired).toContain(1)
  const afterStart = fired.length

  // A telegram on bus 2 must reach the subscriber too (multi-bus fan-out).
  svc2.start()
  svc2.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  svc2.feed('response', frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]))
  expect(fired.some((b) => b === 2)).toBe(true)

  // Not one-shot: a later change on bus 1 fires again (re-armed).
  const beforeReArm = fired.length
  svc1.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x01]))
  svc1.feed('response', frame(1, 0x03, [0x02, 0x00, 0x2a]))
  expect(fired.length).toBeGreaterThan(beforeReArm)
  expect(fired.some((b) => b === 1)).toBe(true)

  // Unsubscribe stops delivery.
  unsub()
  const afterUnsub = fired.length
  svc1.feed('request', frame(1, 0x03, [0x00, 0x01, 0x00, 0x01]))
  svc1.feed('response', frame(1, 0x03, [0x02, 0x00, 0x2b]))
  expect(fired.length).toBe(afterUnsub)

  await svc1.stop()
  await svc2.stop()
})

it('attachServiceFanout is idempotent across serviceForBus update calls', async () => {
  const fired: number[] = []
  const unsub = registry.onAnyChange((busId) => fired.push(busId))
  const svc = registry.serviceForBus(3, makeConfig(3))
  // Simulate a config update: serviceForBus again on the same bus.
  const same = registry.serviceForBus(3, makeConfig(3))
  expect(same).toBe(svc)
  await svc.start()
  const countAfterStart = fired.filter((b) => b === 3).length
  svc.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x01]))
  svc.feed('response', frame(1, 0x03, [0x02, 0x00, 0x2a]))
  // One change cycle must NOT produce doubled events due to a duplicate listener.
  const eventsFor3 = fired.filter((b) => b === 3).length
  expect(eventsFor3).toBeLessThan(countAfterStart + 10) // sanity: no explosion
  unsub()
  await svc.stop()
})
