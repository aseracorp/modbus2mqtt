import { it, expect } from '@jest/globals'
import { ModbusSnifferRegistry } from '../../src/server/sniffer/registry.js'
import { InMemorySnifferStore } from '../../src/server/sniffer/store.js'
import { SnifferBusConfig } from '../../src/server/sniffer/types.js'

function makeConfig(busId: number): SnifferBusConfig {
  return { busId, busName: '/dev/ttyUSB' + busId, mode: 'stack', enabled: false }
}

it('onAnyChange fires when a service starts and stops (never-started service)', async () => {
  const store = new InMemorySnifferStore()
  store.upsertConfig(makeConfig(1))
  const registry = ModbusSnifferRegistry.resetForTests(store)
  const fired: number[] = []
  registry.onAnyChange((busId) => fired.push(busId))

  // First start: service is created + attached BEFORE svc.start() notifies.
  await registry.start(1)
  expect(fired).toContain(1)

  const afterStart = fired.length
  // Stop notifies again.
  await registry.stop(1)
  expect(fired.length).toBeGreaterThan(afterStart)

  // Start again (existing service) also fires.
  const beforeAgain = fired.length
  await registry.start(1)
  expect(fired.length).toBeGreaterThan(beforeAgain)
  await registry.stop(1)
  store.close()
})
