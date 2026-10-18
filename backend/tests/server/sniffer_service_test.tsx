import { it, expect } from '@jest/globals'
import { SnifferService } from '../../src/server/sniffer/snifferService.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
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

// --- Phantom register pruning ---
it('prunes phantom register rows (empty words, no template) but keeps real ones', () => {
  // In-memory store: bare request rows (empty words) get pruned; rows with
  // captured words survive; template-backed rows survive even without words.
  const mem = new InMemorySnifferStore()
  const cfg: SnifferBusConfig = { busId: 4, mode: 'stack', enabled: true }
  mem.upsertConfig(cfg)
  const req = { direction: 'request', slaveId: 5, address: 4097, length: 1 } as never
  mem.upsertRegister(4, req as never, 4097, 1, [])                    // phantom
  mem.upsertRegister(4, req as never, 7680, 1, [])                    // phantom
  mem.upsertRegister(4, { ...req, slaveId: 6 } as never, 0, 1, [0x27]) // real value
  expect(mem.prunePhantomRegisters(4)).toBe(2)
  expect(mem.getRegisters(4).map((r) => r.address)).toEqual([0])
  // Template-backed empty rows survive the prune.
  const mem2 = new InMemorySnifferStore()
  mem2.upsertConfig(cfg)
  mem2.upsertRegister(4, req as never, 4097, 1, [])
  mem2.setSlaveTemplate(4, 5, 'thermokon-wrf06.yaml')
  mem2.upsertRegisterDirect({ busId: 4, slaveId: 5, address: 4097, quantity: 1, specKey: 'thermokon-wrf06.yaml' })
  expect(mem2.prunePhantomRegisters(4)).toBe(0)

  // SQLite: same semantics.
  const db = new SqliteSnifferStore(':memory:')
  db.init()
  const p = new RtuFrameParser((t) => {
    if (t.direction === 'request') {
      db.upsertRegister(4, t, t.decoded?.address ?? 0, t.decoded?.length ?? 1, t.decoded?.values ?? [])
    }
  }, 20)
  p.feed(frame(5, 0x03, [0x10, 0x01, 0x00, 0x01]).map((b) => [b]), 1000)
  p.feed([], 1100)
  // A real captured response row (with words) must survive:
  db.upsertRegister(4, { direction: 'response', slaveId: 5, functionCode: 3, timestamp: 1, payload: [], raw: [], crcOk: true, decoded: { address: 0, length: 1 } } as never, 0, 1, [0x27])
  // A second bare-request phantom at 7680:
  db.upsertRegister(4, { direction: 'request', slaveId: 5, functionCode: 3, timestamp: 1, payload: [], raw: [], crcOk: true, decoded: { address: 7680, length: 1 } } as never, 7680, 1, [])
  expect(db.prunePhantomRegisters(4)).toBe(2)
  expect(db.getRegisters(4).map((r) => r.address)).toEqual([0])
  db.close()
})

// --- Per-slave template assignment (sniffer-discovered slaves) ---
it('stores per-slave template assignments (InMemory + SQLite) and restores them after reset', () => {
  // In-memory
  const mem = new InMemorySnifferStore()
  mem.setSlaveTemplate(3, 5, 'thermokon-wrf06.yaml')
  expect(mem.getSlaveTemplate(3, 5)).toBe('thermokon-wrf06.yaml')
  expect(mem.getSlaveTemplate(3, 6)).toBeUndefined()
  expect(mem.getSlaveTemplates(3).get(5)).toBe('thermokon-wrf06.yaml')
  mem.setSlaveTemplate(3, 5, undefined)
  expect(mem.getSlaveTemplate(3, 5)).toBeUndefined()

  // SQLite
  const db = new SqliteSnifferStore(':memory:')
  db.init()
  db.setSlaveTemplate(3, 7, 'some-spec.yaml')
  expect(db.getSlaveTemplate(3, 7)).toBe('some-spec.yaml')
  expect(db.getSlaveTemplates(3).get(7)).toBe('some-spec.yaml')
  // Different bus unaffected
  expect(db.getSlaveTemplate(4, 7)).toBeUndefined()
  // Clearing works
  db.setSlaveTemplate(3, 7, undefined)
  expect(db.getSlaveTemplate(3, 7)).toBeUndefined()
  db.close()
})

it('decodes registers of a sniffer-discovered slave via the store template', async () => {
  const { svc, store } = makeService()
  // Slave 5 is NOT configured in any bus (ConfigBus has no slave 5), but the
  // sniffer-visible template assignment lives in the store.
  store.setSlaveTemplate(1, 5, 'thermokon-wrf06.yaml')

  // Stub ConfigBus.getSlave to return undefined (slave not configured) and
  // ConfigSpecification.getSpecificationByFilename to return a minimal spec so
  // the store-template fallback path in enrichRegister can decode the rows.
  const configBusModule = await import('../../src/server/configbus.js')
  const specModule = await import('../../src/specification/configspec.js')
  const origGetSlave = configBusModule.ConfigBus.getSlave
  const origGetSpec = specModule.ConfigSpecification.getSpecificationByFilename
  configBusModule.ConfigBus.getSlave = () => undefined
  specModule.ConfigSpecification.getSpecificationByFilename = (filename?: string) => ({
    filename: filename ?? 'thermokon-wrf06.yaml',
    entities: [
      {
        id: 1,
        name: 'Unit system',
        converter: 'number',
        registerType: 3, // HoldingRegister
        modbusAddress: 400,
        converterParameters: { multiplier: 1, uom: 'select' },
      },
    ],
    i18n: [],
    files: [],
    status: 0,
    identified: 0,
  })

  try {
    await svc.start()
    // Read holding register 400 (0x190), quantity 1 -> WRF06 "Unit system" select
    svc.feed('request', frame(5, 0x03, [0x01, 0x90, 0x00, 0x01]))
    svc.feed('response', frame(5, 0x03, [0x02, 0x00, 0x01]))

    const registers = store.getRegisters(1, 5)
    expect(registers.length).toBeGreaterThan(0)
    const r400 = registers.find((r) => r.address === 0x190)
    expect(r400).toBeDefined()
    // The service enriches via the store template fallback.
    const regs = svc.getRegisters(1, 5)
    expect(regs.length).toBeGreaterThan(0)
    expect(regs.find((r) => r.address === 0x190)?.specKey).toBe('thermokon-wrf06.yaml')
  } finally {
    configBusModule.ConfigBus.getSlave = origGetSlave
    specModule.ConfigSpecification.getSpecificationByFilename = origGetSpec
    await svc.stop()
  }
})

it('upsertRegisterDirect seeds template registers (incl. description) and keeps captured words', () => {
  // In-memory
  const mem = new InMemorySnifferStore()
  mem.upsertRegisterDirect({
    busId: 1, slaveId: 5, address: 400, quantity: 1,
    functionCode: 0x03, converter: 'number / 10', uom: '°C', description: 'Outdoor temperature', specKey: 'thermokon-wrf06.yaml',
  })
  let rows = mem.getRegisters(1, 5)
  expect(rows.length).toBe(1)
  expect(rows[0].address).toBe(400)
  expect(rows[0].description).toBe('Outdoor temperature')
  expect(rows[0].uom).toBe('°C')
  expect(rows[0].specKey).toBe('thermokon-wrf06.yaml')
  expect(rows[0].words).toEqual([])

  // A later wire capture must keep the template description.
  const { svc, store } = makeService()
  store.upsertRegisterDirect({
    busId: 1, slaveId: 5, address: 400, quantity: 1,
    functionCode: 0x03, converter: 'number', uom: '°C', description: 'Outdoor temperature', specKey: 'thermokon-wrf06.yaml',
  })
  // simulate a frame that updates this row
  // (uses the same store; service start not required for the store call)
  svc.feed('request', frame(5, 0x03, [0x01, 0x90, 0x00, 0x01]))
  svc.feed('response', frame(5, 0x03, [0x02, 0x00, 0x01]))
  const r400 = store.getRegisters(1, 5).find((r) => r.address === 400)
  expect(r400?.description).toBe('Outdoor temperature')
})

it('annotateRegister persists a manual description (InMemory + SQLite)', () => {
  const mem = new InMemorySnifferStore()
  mem.upsertRegisterDirect({ busId: 1, slaveId: 5, address: 402, quantity: 1 })
  const annotated = mem.annotateRegister({
    busId: 1, slaveId: 5, address: 402,
    converter: 'number * 0.1', description: 'Room temperature', uom: '°C',
  })
  expect(annotated?.description).toBe('Room temperature')
  expect(annotated?.annotated).toBe(true)
  expect(mem.getRegisters(1, 5)[0].description).toBe('Room temperature')

  const db = new SqliteSnifferStore(':memory:')
  db.init()
  db.upsertRegisterDirect({ busId: 1, slaveId: 5, address: 402, quantity: 1 })
  const row = db.annotateRegister({
    busId: 1, slaveId: 5, address: 402,
    converter: 'number * 0.1', description: 'Room temperature', uom: '°C',
  })
  expect(row?.description).toBe('Room temperature')
  expect(row?.annotated).toBe(true)
  expect(db.getRegisters(1, 5)[0].description).toBe('Room temperature')
  db.close()
})

it('restores per-slave template assignments after a database reset (file-backed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sniffer-tpl-'))
  const dbPath = path.join(dir, 'modbus-sniffer.db')
  const db = new SqliteSnifferStore(dbPath)
  db.init()
  db.setSlaveTemplate(3, 7, 'some-spec.yaml')
  // No close(): resetDatabase handles the open db itself (checkpoint+rename).
  const renamed = db.resetDatabase('backup')
  expect(renamed).toBeDefined()
  expect(db.getSlaveTemplate(3, 7)).toBe('some-spec.yaml')
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
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

  // Inventory: an unanswered scan probe reveals the slave, but NOT the
  // register it probed — only answered reads/writes create register rows.
  // Otherwise an address scan would litter the register table with phantom
  // rows (e.g. 0..7680) for addresses no slave ever answered.
  const registers = store.getRegisters(1)
  expect(registers).toHaveLength(0)
  const slaves = new Set(registers.map((r) => r.slaveId))
  expect(slaves).toEqual(new Set([]))

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

// --- Fix: auto mode must not open a tap on the SAME device as the active bus ---
it('auto mode with tapDevice == busSerialport starts the bus-port tap (passive, sees foreign master)', async () => {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = {
    busId: 11,
    busName: '/dev/ttyModbus',
    mode: 'auto',
    enabled: true,
    tapDevice: '/dev/ttyModbus', // same as the active bus
    busSerialport: '/dev/ttyModbus',
    baudRate: 38400,
  }
  store.upsertConfig(config)

  // The SerialTap factory must NOT be used in the same-device case (it would
  // open a second port and fight the bus). A mock bus provides the passive tap.
  let serialTapUsed = false
  const factory: TapTransportFactory = () => ({
    describe: () => 'mock serial tap',
    start: async () => {
      serialTapUsed = true
    },
    stop: async () => undefined,
    isRunning: () => serialTapUsed,
  })
  let busTapStarted = false
  const received: { d: 'request' | 'response'; b: number[] }[] = []
  const mockBus = {
    getName: () => '/dev/ttyModbus',
    attachSerialTap: (listener: (d: 'request' | 'response', b: number[]) => void) => {
      busTapStarted = true
      received.push({ d: 'request', b: frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]) })
      received.push({ d: 'response', b: frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]) })
      return () => {
        busTapStarted = false
      }
    },
  } as never
  const busPortFactory = (_busId: number) => ({
    describe: () => 'bus port (/dev/ttyModbus)',
    start: async (sink: { onBytes: (d: 'request' | 'response', b: number[]) => void }) => {
      // simulate what BusPortTapTransport does with the mock bus: feed each
      // raw frame with a silence gap so the parser treats them as separate
      // frames (like real serial reads separated by the inter-frame silence).
      const detach = (mockBus as { attachSerialTap: (l: (d: 'request' | 'response', b: number[]) => void) => () => void }).attachSerialTap
      detach((d, b) => sink.onBytes(d, b))
    },
    stop: async () => undefined,
    isRunning: () => busTapStarted,
  })

  // The real bus port emits bytes over time; simulate that ordering here:
  // feed request, wait the frame timeout, feed response, wait again, flush.
  const feedSink = async (sink: { onBytes: (d: 'request' | 'response', b: number[]) => void }) => {
    for (const r of received) {
      sink.onBytes(r.d, r.b)
      await new Promise((res) => setTimeout(res, 60))
    }
    sink.onBytes('request', [])
  }

  const svc = new SnifferService(config, store, factory, busPortFactory as never)
  await svc.start()

  // The bus-port tap (not a second serial port) must be the active transport.
  expect(serialTapUsed).toBe(false)
  expect(svc.isRunning()).toBe(true)

  // Deliver the observed frames through the bus-port sink with silence gaps.
  const sink = (svc as unknown as { tapSink: { onBytes: (d: 'request' | 'response', b: number[]) => void } }).tapSink
  await feedSink(sink)

  // Frames observed on the bus port are captured (foreign master traffic).
  const telegrams = store.getTelegrams(11)
  expect(telegrams.length).toBeGreaterThanOrEqual(2)
  expect(telegrams.some((t) => t.direction === TelegramDirection.response)).toBe(true)
  await svc.stop()
})

it('auto mode with a DIFFERENT tap device starts the tap and suppresses stack-hook duplicates', async () => {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = {
    busId: 12,
    busName: '/dev/ttyModbus',
    mode: 'auto',
    enabled: true,
    tapDevice: '/dev/ttyUSB1', // Y-splitter adapter
    busSerialport: '/dev/ttyModbus',
    baudRate: 9600,
  }
  store.upsertConfig(config)
  let tapStarted = false
  let tapSink: { onBytes: (d: 'request' | 'response', b: number[]) => void } | undefined
  const factory: TapTransportFactory = () => ({
    describe: () => '/dev/ttyUSB1 (mock tap)',
    start: async (sink) => {
      tapStarted = true
      tapSink = sink
    },
    stop: async () => undefined,
    isRunning: () => tapStarted,
  })
  const svc = new SnifferService(config, store, factory)
  await svc.start()

  expect(tapStarted).toBe(true)

  // Stack hook bytes (synthetic, would duplicate) are dropped while tap runs.
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  svc.feed('response', frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]))
  expect(store.getTelegrams(12)).toHaveLength(0)

  // Real tap frames are captured. The tap feeds raw bytes; frames are
  // separated by the silence gap a real slave leaves before answering.
  tapSink!.onBytes('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  await new Promise((r) => setTimeout(r, 120))
  tapSink!.onBytes('response', frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]))
  await new Promise((r) => setTimeout(r, 60))
  // The tap sink never flushes per chunk: frames are emitted when the next
  // byte group arrives after the silence gap (or on stop). Trigger the
  // parser's silence tick like the next serial chunk would.
  tapSink!.onBytes('request', [])
  await new Promise((r) => setTimeout(r, 30))
  expect(store.getTelegrams(12).length).toBeGreaterThanOrEqual(2)
  const registers = store.getRegisters(12)
  expect(registers.length).toBeGreaterThanOrEqual(1)
  await svc.stop()
})

it('drops frames with an invalid CRC (line noise / partial frames)', () => {
  const received: unknown[] = []
  const parser = new RtuFrameParser((t) => received.push(t), 20)
  const now = 1000
  // A frame whose CRC does not validate (e.g. line noise or a partial read).
  parser.feed([0x01, 0x03, 0x00, 0x6b, 0x00, 0x02, 0xaa, 0xbb], now)
  parser.flush(now + 500)
  expect(received).toHaveLength(0)

  // A real 8-byte frame WITH CRC is still parsed.
  const good = frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02])
  parser.feed(good, now)
  parser.flush(now + 500)
  expect(received).toHaveLength(1)
})

// --- New features: register annotation + database reset (rename) ---
it('annotateRegister persists converter/uom and marks the row annotated', async () => {
  const { svc, store } = makeService()
  await svc.start()
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x01]))
  svc.feed('response', frame(1, 0x03, [0x02, 0x12, 0x34]))

  const regs = store.getRegisters(1)
  expect(regs).toHaveLength(1)
  const row = regs[0]
  expect(row.words).toEqual([0x1234])
  expect(row.rawValue).toBe('4660')

  const annotated = store.annotateRegister({ busId: 1, slaveId: 1, address: row.address, converter: 'number * 0.1', uom: '°C' })
  expect(annotated).toBeDefined()
  expect(annotated!.annotated).toBe(true)
  expect(annotated!.converter).toBe('number * 0.1')
  expect(annotated!.uom).toBe('°C')
  await svc.stop()
})

it('SqliteSnifferStore.resetDatabase renames the file and starts a fresh db', () => {
  const dir = require('os').tmpdir()
  const dbPath = require('path').join(dir, 'sniffer-reset-test-' + Date.now() + '.db')
  const store = new SqliteSnifferStore(dbPath)
  store.init()
  store.upsertConfig({ busId: 5, mode: 'stack', enabled: true })
  const cfg = store.getConfig(5)
  expect(cfg).toBeDefined()

  const renamed = store.resetDatabase('2026-10-14T12-00-00-000Z')
  expect(renamed).toBe(dbPath + '.2026-10-14T12-00-00-000Z')
  // The old file exists under the new name, and the original path is fresh.
  expect(require('fs').existsSync(renamed!)).toBe(true)
  expect(require('fs').existsSync(dbPath)).toBe(true)

  // The renamed (archived) file still contains the old captured data, and the
  // fresh database keeps the sniffer configuration (resetting only clears the
  // captured traffic, the setup must not be lost).
  const oldStore = new SqliteSnifferStore(renamed!)
  oldStore.init()
  expect(oldStore.getConfig(5)).toBeDefined()
  oldStore.close()

  expect(store.getConfig(5)).toBeDefined()
  store.close()

  // cleanup
  require('fs').rmSync(dbPath, { force: true })
  require('fs').rmSync(renamed!, { force: true })
  for (const s of ['-wal', '-shm']) {
    require('fs').rmSync(dbPath + s, { force: true })
    require('fs').rmSync(renamed! + s, { force: true })
  }
})

it('register rows expose rawValue and keep template values after refresh', () => {
  const store = new SqliteSnifferStore(':memory:')
  store.init()
  const p = new RtuFrameParser((t) => {
    if (t.direction === 'request') {
      store.upsertDevice(3, t)
      store.upsertRegister(3, t, t.decoded?.address ?? 0, t.decoded?.length ?? 1, [0x1234])
    }
  }, 20)
  const f = frame(7, 0x04, [0x00, 0x10, 0x00, 0x01])
  let now = 2000
  f.forEach((b) => { p.feed([b], now); now += 3 })
  p.feed([], now + 50)

  const regs = store.getRegisters(3)
  expect(regs).toHaveLength(1)
  expect(regs[0].rawValue).toBe('4660')
  expect(regs[0].functionCode).toBe(0x04)
  // No template configured -> no value/converter/uom, still raw.
  expect(regs[0].value).toBeUndefined()
  store.close()
})

// --- Template interpretation: enrichRegister with a real spec entity ---
it('getRegisters interprets values via the slave template (number converter + uom)', async () => {
  const { svc, store } = makeService()
  await svc.start()
  svc.feed('request', frame(7, 0x04, [0x02, 0x02, 0x00, 0x01])) // read analog input 0x0202, qty 1
  svc.feed('response', frame(7, 0x04, [0x02, 0x01, 0xe7])) // 487 -> 48.7

  // Instead of relying on the live Bus registry, insert the spec entity
  // directly through a mocked ConfigBus.getSlave. The service calls
  // ConfigBus.getSlave(row.busId, row.slaveId) - we stub it for this test.
  const spec = {
    filename: 'test-spec',
    entities: [
      {
        id: 42,
        name: 'Temperature',
        converter: 'number',
        registerType: 4, // AnalogInputs
        modbusAddress: 0x0202,
        converterParameters: { multiplier: 0.1, uom: '°C' },
      },
    ],
    i18n: [],
    files: [],
    status: 0,
    identified: 0,
  }
  const configBusModule = await import('../../src/server/configbus.js')
  const original = configBusModule.ConfigBus.getSlave
  configBusModule.ConfigBus.getSlave = () => ({
    slaveid: 7,
    name: 'Test',
    specification: spec,
  })

  try {
    const regs = svc.getRegisters(1, 7)
    expect(regs).toHaveLength(1)
    expect(regs[0].address).toBe(0x0202)
    // 487 * 0.1 = 48.7
    expect(regs[0].value).toBe('48.7')
    expect(regs[0].uom).toBe('°C')
    expect(regs[0].converter).toBe('number * 0.1')
    expect(regs[0].entityName).toBe('Temperature')
    expect(regs[0].specKey).toBe('test-spec')
  } finally {
    configBusModule.ConfigBus.getSlave = original
  }
  await svc.stop()
})

// --- Condition-aware interpretation (device-type gated entities) ---
it('picks the entity whose conditions match the captured condition register', async () => {
  const { svc, store } = makeService()
  await svc.start()
  // Spec: two entities at address 0 gated by register 400, plus the gating
  // register 400 itself. Mirrors thermokon-wrf06 / ineltec-style templates.
  const spec = {
    filename: 'cond-spec',
    entities: [
      {
        id: 1,
        name: 'Temp type 1',
        converter: 'number',
        registerType: 3, // HoldingRegisters
        modbusAddress: 0,
        converterParameters: { multiplier: 0.1, uom: '°C' },
        conditions: [{ register: 400, comparator: 'eq', value: 1 }],
      },
      {
        id: 2,
        name: 'Temp type 2',
        converter: 'number',
        registerType: 3,
        modbusAddress: 0,
        converterParameters: { multiplier: 0.1, uom: '°C' },
        conditions: [{ register: 400, comparator: 'eq', value: 2 }],
      },
      {
        id: 3,
        name: 'Device type',
        converter: 'select',
        registerType: 3,
        modbusAddress: 400,
        converterParameters: { multiplier: 1, uom: '' },
      },
    ],
    i18n: [],
    files: [],
    status: 0,
    identified: 0,
  }
  const configBusModule = await import('../../src/server/configbus.js')
  const original = configBusModule.ConfigBus.getSlave
  configBusModule.ConfigBus.getSlave = () => ({
    slaveid: 7,
    name: 'Test',
    specification: spec,
  })
  try {
    // Capture device type register 400 = 2 first, then temperature 0 = 486.
    svc.feed('request', frame(7, 0x03, [0x01, 0x90, 0x00, 0x01])) // read 400
    svc.feed('request', frame(7, 0x03, [0x00, 0x00, 0x00, 0x01])) // read 0
    svc.feed('response', frame(7, 0x03, [0x02, 0x00, 0x02])) // 400 = 2
    svc.feed('response', frame(7, 0x03, [0x02, 0x01, 0xe6])) // 0 = 486 -> 48.6

    const regs = svc.getRegisters(1, 7)
    const row0 = regs.find((r) => r.address === 0)
    expect(row0).toBeDefined()
    // Condition 400==2 -> must pick 'Temp type 2' (id 2), value 48.6
    expect(row0!.entityName).toBe('Temp type 2')
    expect(row0!.value).toBe('48.6')
    expect(row0!.uom).toBe('°C')
  } finally {
    configBusModule.ConfigBus.getSlave = original
  }
  await svc.stop()
})

// --- Condition-aware: no matching condition -> keep raw (no interpretation) ---
it('keeps the row raw when no condition matches', async () => {
  const { svc, store } = makeService()
  await svc.start()
  const spec = {
    filename: 'cond-spec2',
    entities: [
      {
        id: 1,
        name: 'Temp type 1',
        converter: 'number',
        registerType: 3,
        modbusAddress: 0,
        converterParameters: { multiplier: 0.1, uom: '°C' },
        conditions: [{ register: 400, comparator: 'eq', value: 1 }],
      },
    ],
    i18n: [],
    files: [],
    status: 0,
    identified: 0,
  }
  const configBusModule = await import('../../src/server/configbus.js')
  const original = configBusModule.ConfigBus.getSlave
  configBusModule.ConfigBus.getSlave = () => ({
    slaveid: 7,
    name: 'Test',
    specification: spec,
  })
  try {
    // Only register 0 read, no value for condition register 400 captured.
    svc.feed('request', frame(7, 0x03, [0x00, 0x00, 0x00, 0x01]))
    svc.feed('response', frame(7, 0x03, [0x02, 0x01, 0xe6]))
    const regs = svc.getRegisters(1, 7)
    const row0 = regs.find((r) => r.address === 0)
    expect(row0).toBeDefined()
    // 400 never seen -> condition unknown -> no interpretation
    expect(row0!.value).toBeUndefined()
    expect(row0!.converter).toBeUndefined()
  } finally {
    configBusModule.ConfigBus.getSlave = original
  }
  await svc.stop()
})

it('pairs response address/length from the request into the telegram row', async () => {
  const { svc, store } = makeService()
  await svc.start()
  // Read holding registers 0x0100, quantity 4
  svc.feed('request', frame(1, 0x03, [0x01, 0x00, 0x00, 0x04]))
  svc.feed('response', frame(1, 0x03, [0x08, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04]))
  const telegrams = store.getTelegrams(1)
  const resp = telegrams.find((t) => t.direction === TelegramDirection.response)
  expect(resp).toBeDefined()
  // The response row now carries the request's address/length (not empty).
  expect(resp!.address).toBe(0x0100)
  expect(resp!.length).toBe(4)
  await svc.stop()
})

it('splits a multi-register read into one register row per address', async () => {
  const { svc, store } = makeService()
  await svc.start()
  // Read 8 holding registers starting at 0
  const values = [0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008]
  const payload: number[] = [values.length * 2]
  values.forEach((v) => payload.push((v >> 8) & 0xff, v & 0xff))
  svc.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x08]))
  svc.feed('response', frame(1, 0x03, payload))
  const regs = store.getRegisters(1)
  expect(regs).toHaveLength(8)
  regs.forEach((r, i) => {
    expect(r.address).toBe(i)
    expect(r.words).toEqual([values[i]])
  })
  await svc.stop()
})

it('bus-port tap starts in stack mode (passive capture of foreign master)', async () => {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = {
    busId: 21,
    busName: '/dev/ttyModbus',
    mode: 'stack',
    enabled: true,
    busSerialport: '/dev/ttyModbus',
    baudRate: 38400,
  }
  store.upsertConfig(config)
  let busTapAttached = false
  let serialTapUsed = false
  const mockBus = {
    getName: () => '/dev/ttyModbus',
    attachSerialTap: () => {
      busTapAttached = true
      return { detach: () => undefined, active: true }
    },
  } as never
  const busPortFactory = (_busId: number) => ({
    describe: () => 'bus port (mock)',
    start: async (sink: { onBytes: (d: 'request' | 'response', b: number[]) => void }) => {
      busTapAttached = true
      const detach = (mockBus as { attachSerialTap: () => { detach: () => void; active: boolean } }).attachSerialTap
      const result = detach()
      if (result.active) result.detach()
      // simulate a foreign master frame observed on the wire
      sink.onBytes('request', frame(3, 0x04, [0x00, 0x00, 0x00, 0x02]))
      sink.onBytes('response', frame(3, 0x04, [0x04, 0x12, 0x34, 0x56, 0x78]))
    },
    stop: async () => undefined,
    isRunning: () => busTapAttached,
  })
  const tapFactory: TapTransportFactory = () => ({
    describe: () => 'mock serial tap',
    start: async () => {
      serialTapUsed = true
    },
    stop: async () => undefined,
    isRunning: () => serialTapUsed,
  })
  const svc = new SnifferService(config, store, tapFactory, busPortFactory as never)
  await svc.start()
  // The passive bus tap is active even in stack mode.
  expect(busTapAttached).toBe(true)
  expect(serialTapUsed).toBe(false)
  await svc.stop()
})

it('falls back to a serial tap on the bus device when the bus-port tap is idle (no open port)', async () => {
  const store = new InMemorySnifferStore()
  const config: SnifferBusConfig = {
    busId: 22,
    busName: '/dev/ttyModbus',
    mode: 'stack',
    enabled: true,
    busSerialport: '/dev/ttyModbus',
    baudRate: 38400,
  }
  store.upsertConfig(config)
  // bus-port tap: attachSerialTap reports NOT active (no open port yet)
  const busPortFactory = (_busId: number) => ({
    describe: () => 'bus port (mock)',
    start: async (sink: { onBytes: (d: 'request' | 'response', b: number[]) => void }) => {
      // simulate a tap that later activates: feed a foreign master frame
      sink.onBytes('request', frame(9, 0x03, [0x01, 0x00, 0x00, 0x02]))
      sink.onBytes('response', frame(9, 0x03, [0x04, 0xAA, 0xBB, 0xCC, 0xDD]))
    },
    stop: async () => undefined,
    // After start() the tap is NOT running -> the service must use the fallback.
    isRunning: () => false,
  })
  let serialTapStarted = false
  const tapFactory: TapTransportFactory = (_dev) => ({
    describe: () => 'mock serial tap on ' + _dev,
    start: async () => {
      serialTapStarted = true
    },
    stop: async () => undefined,
    isRunning: () => serialTapStarted,
  })
  const svc = new SnifferService(config, store, tapFactory, busPortFactory as never)
  await svc.start()
  // The fallback serial tap on the bus device was started.
  expect(serialTapStarted).toBe(true)
  await svc.stop()
})

it('keeps the last known register words when a later request gets no response', async () => {
  const { svc, store } = makeService()
  await svc.start()
  // First cycle: request + response -> register 0x6b has a value.
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x01]))
  svc.feed('response', frame(1, 0x03, [0x02, 0x12, 0x34]))
  let registers = store.getRegisters(1)
  expect(registers[0].words).toEqual([0x1234])
  expect(registers[0].rawValue).toBe('4660')

  // Second cycle: only the request appears on the wire (offline slave,
  // timeout) - the register table must keep the previously captured words
  // instead of wiping them to empty.
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x01]))
  registers = store.getRegisters(1)
  expect(registers[0].words).toEqual([0x1234])
  expect(registers[0].rawValue).toBe('4660')
  await svc.stop()
})

it('pairs a response with the pending request of the SAME length (no phantom registers)', async () => {
  // Regression: a still-pending read(400,1) must not latch an 8-word answer
  // that belongs to read(0,8). Pairing by FIFO alone shifted the value start
  // address to 400 and created registers 400..407 that were never read.
  const { svc, store } = makeService()
  await svc.start()

  // Older, still unanswered single-register read at 400 (as seen on the wire).
  svc.feed('request', frame(1, 0x03, [0x01, 0x90, 0x00, 0x01])) // 400, qty 1
  // The real 8-register poll that the slave DOES answer.
  svc.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x08])) // 0, qty 8
  // Response carries 8 words (byteCount 0x10) -> belongs to read(0,8).
  svc.feed(
    'response',
    frame(1, 0x03, [
      0x10,
      0x00,
      0xfd,
      0x00,
      0x00,
      0x00,
      0x00,
      0x02,
      0xa3,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ])
  )

  const addrs = store.getRegisters(1).map((r) => r.address)
  // Register 0..7 got the values (the real read). The request at 400 was
  // never answered, so NOTHING exists at 400..407 — bare read requests no
  // longer create phantom inventory rows (an address scan would otherwise
  // fill the table with addresses no slave ever answered).
  for (let a = 0; a <= 7; a++) expect(addrs).toContain(a)
  expect(addrs).not.toContain(400)
  expect(addrs).not.toContain(401)
  expect(addrs).not.toContain(407)
  // The value at 0..7 comes from the 8-word response (0x00fd = 253), NOT from
  // an answer to the single-register read at 400.
  const r0 = store.getRegisters(1).find((r) => r.address === 0)
  expect(r0?.words).toEqual([0x00fd])
  const r400 = store.getRegisters(1).find((r) => r.address === 400)
  expect(r400).toBeUndefined()
  await svc.stop()
})

it('a bare request does not wipe previously captured values (SQLite store)', async () => {
  // Regression: the request path in updateRegisters upserts every polled
  // address with an EMPTY word list. With the SQLite store that overwrote
  // words='[]' / raw_value=NULL on every poll, so the register table showed
  // no values for registers that were actually being read and answered.
  const store = new SqliteSnifferStore('/tmp/sniffer-wipe-test.db')
  store.init()
  try {
    const config: SnifferBusConfig = {
      busId: 1,
      busName: '/dev/ttyUSB0',
      mode: 'stack',
      enabled: true,
    }
    store.upsertConfig(config)
    const svc = new SnifferService(config, store)
    await svc.start()

    // Cycle 1: request + response -> register 0 has a value.
    svc.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x01]))
    svc.feed('response', frame(1, 0x03, [0x02, 0x00, 0x2a]))
    let rows = store.getRegisters(1)
    const r0 = rows.find((r) => r.address === 0)
    expect(r0?.words).toEqual([0x002a])

    // Cycle 2: the poll request alone (response not captured) - the value must
    // survive instead of being reset to empty by the request-path upsert.
    svc.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x01]))
    rows = store.getRegisters(1)
    const r0b = rows.find((r) => r.address === 0)
    expect(r0b?.words).toEqual([0x002a])
    expect(r0b?.rawValue).toBe('42')
    await svc.stop()
  } finally {
    store.close()
    try {
      require('fs').unlinkSync('/tmp/sniffer-wipe-test.db')
    } catch {
      /* ignore */
    }
  }
})

it('onChangePersistent fires on every change with the bus id (not one-shot)', async () => {
  const { svc, store } = makeService(7)
  const fired: number[] = []
  const unsub = svc.onChangePersistent((busId) => fired.push(busId))

  await svc.start()
  // start() itself notifies (state transition)
  expect(fired.length).toBeGreaterThanOrEqual(1)
  expect(fired[fired.length - 1]).toBe(7)
  const firedAfterStart = fired.length

  // One telegram cycle -> several notifyChange() calls (telegram, device, regs)
  svc.feed('request', frame(1, 0x03, [0x00, 0x6b, 0x00, 0x02]))
  svc.feed('response', frame(1, 0x03, [0x04, 0x12, 0x34, 0x56, 0x78]))
  expect(fired.length).toBeGreaterThan(firedAfterStart)
  expect(fired.every((b) => b === 7)).toBe(true)

  // Unsubscribe stops delivery
  unsub()
  const after = fired.length
  svc.feed('request', frame(1, 0x03, [0x00, 0x00, 0x00, 0x01]))
  svc.feed('response', frame(1, 0x03, [0x02, 0x00, 0x2a]))
  expect(fired.length).toBe(after)

  await svc.stop()
  store.close()
})

// --- Write request value capture (regression: FC6/FC16 values were dropped) ---
it('write requests (FC6/FC16) update the register values', async () => {
  const { svc, store } = makeService()
  await svc.start()

  // writeSingleRegister 0x0064 (100) = 0x02A3 (675)
  svc.feed('request', frame(5, 0x06, [0x00, 0x64, 0x02, 0xa3]))
  let regs = store.getRegisters(1, 5)
  expect(regs).toHaveLength(1)
  expect(regs[0].address).toBe(0x64)
  expect(regs[0].words).toEqual([0x02a3])
  expect(regs[0].rawValue).toBe('675')

  // writeMultipleRegisters 0x00C8 (200), quantity 2, byteCount 4: 0x0001, 0x0002
  svc.feed('request', frame(5, 0x10, [0x00, 0xc8, 0x00, 0x02, 0x04, 0x00, 0x01, 0x00, 0x02]))
  regs = store.getRegisters(1, 5)
  const byAddr = new Map(regs.map((r) => [r.address, r.words]))
  expect(byAddr.get(0xc8)).toEqual([0x0001])
  expect(byAddr.get(0xc9)).toEqual([0x0002])
  // The earlier write at 0x64 must still be present.
  expect(byAddr.get(0x64)).toEqual([0x02a3])

  // The write response (echo) must not create duplicate rows with empty values.
  svc.feed('response', frame(5, 0x06, [0x00, 0x64, 0x02, 0xa3]))
  regs = store.getRegisters(1, 5)
  const afterResp = new Map(regs.map((r) => [r.address, r.words]))
  expect(afterResp.get(0x64)).toEqual([0x02a3])

  await svc.stop()
})

it('getTelegrams supports the from/to time-range filter', async () => {
  const { svc, store } = makeService()
  await svc.start()
  const base = Math.floor(Date.now() / 1000)
  const t0 = { busId: 1, direction: TelegramDirection.request, timestamp: base, slaveId: 5, functionCode: 3, raw: [0x01, 0x03, 0x00, 0x00, 0x00, 0x01], crcOk: true }
  const t1 = { busId: 1, direction: TelegramDirection.response, timestamp: base + 61, slaveId: 5, functionCode: 3, raw: [0x01, 0x03, 0x02, 0x00, 0x2a], crcOk: true }
  store.appendTelegram(1, t0)
  store.appendTelegram(1, t1)
  const all = store.getTelegrams(1)
  expect(all).toHaveLength(2)
  const filtered = store.getTelegrams(1, undefined, 200, base + 30, base + 90)
  expect(filtered).toHaveLength(1)
  expect(filtered[0].timestamp).toBe(base + 61)
  await svc.stop()
})

it('getRegisterHistoryConverted returns converted values from the history', async () => {
  const { svc, store } = makeService()
  await svc.start()
  const base = Math.floor(Date.now() / 1000)
  // Slave 5 reads register 0; the first response carries raw 486.
  store.appendTelegram(1, { busId: 1, direction: TelegramDirection.response, timestamp: base, slaveId: 5, functionCode: 3, payload: [0x02, 0x01, 0xe6], raw: [0x05, 0x03, 0x02, 0x01, 0xe6], crcOk: true, decoded: { address: 0, length: 1, values: [486], functionName: 'readHoldingRegisters' } })
  store.appendTelegram(1, { busId: 1, direction: TelegramDirection.response, timestamp: base + 60, slaveId: 5, functionCode: 3, payload: [0x02, 0x01, 0xf4], raw: [0x05, 0x03, 0x02, 0x01, 0xf4], crcOk: true, decoded: { address: 0, length: 1, values: [500], functionName: 'readHoldingRegisters' } })
  // Without a spec the converted value falls back to the raw word (enrich returns the row as-is).
  const rows = svc.getRegisterHistoryConverted(1, 5, 0, 100)
  expect(rows.length).toBeGreaterThanOrEqual(2)
  expect(rows[0].address).toBe(0)
  expect(rows[0].rawAddressWord).toBe(500) // newest first
  await svc.stop()
})

it('getRegisterHistoryConverted resolves gating conditions from the full register state', async () => {
  const { svc, store } = makeService()
  await svc.start()
  const spec = {
    filename: 'cond-spec-history',
    entities: [
      {
        id: 1,
        name: 'Temp type 1',
        converter: 'number',
        registerType: 3,
        modbusAddress: 0,
        converterParameters: { multiplier: 0.1, uom: '°C' },
        conditions: [{ register: 400, comparator: 'eq', value: 1 }],
      },
      {
        id: 2,
        name: 'Temp type 2',
        converter: 'number',
        registerType: 3,
        modbusAddress: 0,
        converterParameters: { multiplier: 0.1, uom: '°C' },
        conditions: [{ register: 400, comparator: 'eq', value: 2 }],
      },
    ],
    i18n: [],
  }
  const configBusModule = await import('../../src/server/configbus.js')
  const original = configBusModule.ConfigBus.getSlave
  configBusModule.ConfigBus.getSlave = () => ({
    slaveid: 7,
    name: 'Test',
    specification: spec,
  })
  try {
    // Feed real cycles: 400 = 2 (device type) and 0 = 486 (temperature).
    svc.feed('request', frame(7, 0x03, [0x01, 0x90, 0x00, 0x01])) // read 400
    svc.feed('request', frame(7, 0x03, [0x00, 0x00, 0x00, 0x01])) // read 0
    svc.feed('response', frame(7, 0x03, [0x02, 0x00, 0x02])) // 400 = 2
    svc.feed('response', frame(7, 0x03, [0x02, 0x01, 0xe6])) // 0 = 486 -> 48.6
    const rows = svc.getRegisterHistoryConverted(1, 7, 0, 10)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    // Condition 400==2 selects 'Temp type 2' -> converted 48.6 from raw 486.
    expect(rows[0].convertedValue).toBe('48.6')
    expect(rows[0].rawAddressWord).toBe(486)
  } finally {
    configBusModule.ConfigBus.getSlave = original
  }
  await svc.stop()
})

it('getRegisterHistorySummary aggregates distinct registers in the period', async () => {
  const { svc, store } = makeService()
  await svc.start()
  const base = Math.floor(Date.now() / 1000)
  const tg = (ts, addr, val) => ({ busId: 1, direction: TelegramDirection.response, timestamp: ts, slaveId: 5, functionCode: 3, payload: [0x02, (val >> 8) & 0xff, val & 0xff], raw: [0x05, 0x03, 0x02, (val >> 8) & 0xff, val & 0xff], crcOk: true, decoded: { address: addr, length: 1, values: [val], functionName: 'readHoldingRegisters' } })
  store.appendTelegram(1, tg(base, 0, 100))
  store.appendTelegram(1, tg(base + 10, 0, 200))
  store.appendTelegram(1, tg(base + 20, 400, 2))
  const summary = svc.getRegisterHistorySummary(1)
  expect(summary).toHaveLength(2)
  const a0 = summary.find((r) => r.address === 0)
  expect(a0?.samples).toBe(2)
  expect(a0?.lastRaw).toBe(200)
  const a400 = summary.find((r) => r.address === 400)
  expect(a400?.samples).toBe(1)
  expect(a400?.lastRaw).toBe(2)
  // Time-bounded query only sees the later sample of register 0 (base+10) and
  // register 400 (base+20); the base sample (base+0) is before the window.
  const bounded = svc.getRegisterHistorySummary(1, undefined, base + 5, base + 30)
  expect(bounded.find((r) => r.address === 0)?.samples).toBe(1)
  expect(bounded.find((r) => r.address === 400)?.samples).toBe(1)
  await svc.stop()
})
