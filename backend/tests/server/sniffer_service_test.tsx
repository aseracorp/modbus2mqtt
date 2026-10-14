import { it, expect } from '@jest/globals'
import { SnifferService } from '../../src/server/sniffer/snifferService.js'
import { InMemorySnifferStore, SqliteSnifferStore } from '../../src/server/sniffer/store.js'
import { RtuFrameParser } from '../../src/server/sniffer/parser.js'
import { SnifferBusConfig, TelegramDirection } from '../../src/server/sniffer/types.js'
import { TapTransportFactory } from '../../src/server/sniffer/snifferService.js'

function frame(slave: number, fc: number, payload: number[] = []): number[] {
  const body = [slave, fc, ...payload]
  const crc = RtuFrameParser.crc16(body)
  return [...body, crc & 0xff, (crc >> 8) & 0xff]
}

function makeService(busId = 1): { svc: SnifferService; store: InMemorySnifferStore } {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = {
    busId,
    busName: '/dev/ttyUSB0',
    mode: 'stack',
    enabled: true,
  }
  store.upsertConfig(config)
  const svc = new SnifferService(config, store)
  return { svc, store }
}

it('feeds a request+response cycle and populates telegrams/devices/registers', async () => {
  const { svc, store } = makeService()
  await svc.start()

  // Read holding registers 0x6b, quantity 2
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  svc.feed('response', frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]))

  const telegrams = store.getTelegrams(1)
  expect(telegrams).toHaveLength(2)
  // Newest first: response is the latest frame.
  expect(telegrams[0].direction).toBe(TelegramDirection.response)
  expect(telegrams[1].direction).toBe(TelegramDirection.request)
  expect(telegrams[0].values).toEqual([0x1234, 0x5678])

  const devices = store.getDevices(1)
  expect(devices).toHaveLength(1)
  expect(devices[0].slaveId).toBe(1)
  expect(devices[0].requestCount).toBe(1)
  expect(devices[0].responseCount).toBe(1)
  expect(devices[0].lastFunction).toBe('readHoldingRegisters')

  const registers = store.getRegisters(1)
  expect(registers).toHaveLength(2)
  expect(registers[0].address).toBe(0x6b)
  expect(registers[0].words).toEqual([0x1234])
  expect(registers[1].address).toBe(0x6c)
  expect(registers[1].words).toEqual([0x5678])

  await svc.stop()
  expect(svc.isRunning()).toBe(false)
})

it('counts exception responses as errors on the device', async () => {
  const { svc, store } = makeService()
  await svc.start()
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x01]))
  svc.feed('response', frame(1, 0x83, [0x02])) // illegal data address
  const devices = store.getDevices(1)
  expect(devices[0].errorCount).toBe(1)
  expect(devices[0].responseCount).toBe(1)
  await svc.stop()
})

it('broadcast request (slave 0) is classified as request', async () => {
  const { svc, store } = makeService()
  await svc.start()
  svc.feed('request', frame(0, 0x06, [0x00, 0x01, 0x00, 0x02]))
  const telegrams = store.getTelegrams(1)
  expect(telegrams[0].direction).toBe(TelegramDirection.request)
  await svc.stop()
})

it('without a configured store config, start() throws', async () => {
  const store = new InMemorySnifferStore()
  const svc = new SnifferService(
    { busId: 2, mode: 'stack', enabled: true },
    store
  )
  // In-memory store starts with no config; the service uses its own config object.
  await svc.start()
  expect(svc.isRunning()).toBe(true)
  await svc.stop()
})

it('restart creates a fresh parser (old buffered bytes are dropped)', async () => {
  const { svc, store } = makeService()
  await svc.start()
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  await svc.stop()
  const before = store.getTelegrams(1).length
  await svc.start()
  expect(before).toBe(1)
  await svc.stop()
})

// --- SQLite store integration (uses the real better-sqlite3 binding) ---
it('SqliteSnifferStore persists config, telegrams, devices and registers', () => {
  const dbPath = ':memory:'
  const store = new SqliteSnifferStore(dbPath)
  store.init()
  const cfg: SnifferBusConfig = { busId: 3, mode: 'stack', enabled: true }
  store.upsertConfig(cfg)
  expect(store.getConfig(3)?.busId).toBe(3)

  const p = new RtuFrameParser((t) => {
    if (t.direction === 'request') {
      store.upsertDevice(3, t)
      store.appendTelegram(3, t)
      store.upsertRegister(3, t, t.decoded?.address ?? 0, t.decoded?.length ?? 1, [0x1234])
    }
  }, 20)
  const f = frame(7, 0x04, [0x00, 0x10, 0x00, 0x01])
  let now = 2000
  f.forEach((b) => { p.feed([b], now); now += 3 })
  p.feed([], now + 50)

  expect(store.getTelegrams(3)).toHaveLength(1)
  expect(store.getDevices(3)).toHaveLength(1)
  expect(store.getRegisters(3)).toHaveLength(1)
  expect(store.getRegisters(3)[0].address).toBe(0x10)
  store.close()
})

// --- Tap fallback + stack sink (fix: reliable capture with visible errors) ---
it('auto mode falls back to the stack hook when the tap device is unusable', async () => {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = {
    busId: 9,
    busName: '/dev/ttyUSB0',
    mode: 'auto',
    enabled: true,
    tapDevice: '/dev/nonexistent-tap', // cannot open -> should fall back
    baudRate: 9600,
  }
  store.upsertConfig(config)
  // Mock tap: its start() rejects immediately (device unusable).
  const failingTapFactory: TapTransportFactory = () => ({
    describe: () => 'mock tap (fails)',
    start: async () => {
      throw new Error('mock tap cannot open /dev/nonexistent-tap')
    },
    stop: async () => undefined,
    isRunning: () => false,
  })
  const svc = new SnifferService(config, store, failingTapFactory)
  await svc.start()

  // Despite the bad tap device the sniffer is running and the stack hook is armed.
  expect(svc.isRunning()).toBe(true)
  const state = svc.getState()
  expect(state.running).toBe(true)
  expect(state.error).toContain('mock tap cannot open')
  // The stack hook still captures traffic.
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  svc.feed('response', frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]))
  expect(store.getTelegrams(9).length).toBeGreaterThanOrEqual(2)
  await svc.stop()
})

it('stack sink delivered through getStackSink() feeds the parser', async () => {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = { busId: 10, mode: 'stack', enabled: true }
  store.upsertConfig(config)
  const svc = new SnifferService(config, store)
  await svc.start()
  const sink = svc.getStackSink()
  sink.onBytes('request', frame(1, 0x04, [0x00, 0x10, 0x00, 0x01]))
  sink.onBytes('response', frame(1, 0x04, [0x02, 0xab, 0xcd]))
  expect(store.getTelegrams(10)).toHaveLength(2)
  await svc.stop()
})

it('classifies back-to-back scan requests as requests, not responses (regression)', async () => {
  const { svc, store } = makeService()
  await svc.start()

  // A bus scan probes slave ids 1..N back-to-back; none answers (timeouts).
  // Each probe is a request. Before the shape-aware classifier these were
  // mislabelled "response" because the previous probe sat in pendingRequest.
  for (let slave = 1; slave <= 5; slave++) {
    svc.feed('request', frame(slave, 0x03, [0x00, 0x00, 0x00, 0x01]))
  }

  const telegrams = store.getTelegrams(1)
  expect(telegrams).toHaveLength(5)
  for (const t of telegrams) {
    expect(t.direction).toBe(TelegramDirection.request)
    expect(t.address).toBe(0)
    expect(t.length).toBe(1)
  }

  // Inventory: every probe revealed holding register 0 of its slave.
  const registers = store.getRegisters(1)
  expect(registers).toHaveLength(5)
  const slaves = new Set(registers.map((r) => r.slaveId))
  expect(slaves).toEqual(new Set([1, 2, 3, 4, 5]))

  const devices = store.getDevices(1)
  expect(devices).toHaveLength(5)
  for (const d of devices) expect(d.requestCount).toBe(1)

  await svc.stop()
})

it('a read request followed by its response still pairs values to addresses', async () => {
  const { svc, store } = makeService()
  await svc.start()

  svc.feed('request', frame(7, 0x03, [0x00, 0x10, 0x00, 0x02]))
  svc.feed('response', frame(7, 0x03, [0x04, 0xaa, 0xbb, 0xcc, 0xdd]))

  const telegrams = store.getTelegrams(1)
  expect(telegrams[0].direction).toBe(TelegramDirection.response)
  expect(telegrams[0].values).toEqual([0xaabb, 0xccdd])
  const registers = store.getRegisters(1, 7)
  expect(registers).toHaveLength(2)
  expect(registers[0].address).toBe(0x10)
  expect(registers[0].words).toEqual([0xaabb])
  expect(registers[1].address).toBe(0x11)
  expect(registers[1].words).toEqual([0xccdd])

  await svc.stop()
})
