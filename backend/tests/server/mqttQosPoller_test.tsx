import { expect, test } from 'vitest'
import {
  buildQosRegisterPlan,
  dueRegisters,
  planReadBatches,
  estimateReadDurationMs,
  defaultQosFor,
} from '../../src/server/mqttQosPoller.js'
import { QoSLevels } from '../../src/shared/server/index.js'

function makeSlave(entities: unknown[]) {
  return {
    slaveid: 1,
    pollMode: 5,
    specificationid: 'test',
    pollInterval: 1000,
    specification: { entities },
  } as never
}

function reg(id: number, addr: number, over: Record<string, unknown> = {}) {
  return {
    id,
    registerType: 3,
    modbusAddress: addr,
    readonly: true,
    converter: 'number',
    converterParameters: { multiplier: 1, offset: 0, decimals: 0 },
    ...over,
  }
}

const api = {
  readModbusRegister: async () => {
    return { holdingRegisters: new Map(), analogInputs: new Map(), coils: new Map(), discreteInputs: new Map() }
  },
} as never

test('estimateReadDurationMs grows with registers and baud rate', () => {
  const slow = estimateReadDurationMs(10, 9600, 1)
  const fast = estimateReadDurationMs(10, 19200, 1)
  const many = estimateReadDurationMs(100, 9600, 1)
  expect(slow).toBeGreaterThan(fast)
  expect(many).toBeGreaterThan(slow)
  // TCP/unknown baud rate falls back to a floor
  expect(estimateReadDurationMs(10, 0, 1)).toBeGreaterThan(0)
})

test('defaultQosFor falls back by category', () => {
  expect(defaultQosFor(reg(1, 0))).toBe(QoSLevels.regular)
  expect(defaultQosFor({ ...reg(1, 0), entityCategory: 'diagnostic' })).toBe(QoSLevels.slow)
  expect(defaultQosFor({ ...reg(1, 0), category: 'config' })).toBe(QoSLevels.static)
  // explicit qos wins
  const plan = buildQosRegisterPlan(makeSlave([reg(1, 0, { qos: 0 })]), 0, api, { baudrate: 9600 }, 1, 125, 1000)!
  expect(plan.registers[0].qos).toBe(QoSLevels.realtime)
  expect(plan.registers[0].intervalMs).toBe(250)
})

test('dueRegisters returns only expired intervals, all due when never read', () => {
  const plan = buildQosRegisterPlan(
    makeSlave([reg(1, 100, { qos: 0 }), reg(2, 101, { qos: 1000 })]),
    0,
    api,
    { baudrate: 9600 },
    1,
    125,
    1000
  )!
  const now = 10_000
  const { due } = dueRegisters(plan, now)
  expect(due.get(3)!.length).toBe(2) // never read → both due

  // right after read, nothing is due
  plan.registers[0].lastRead = now
  plan.registers[1].lastRead = now
  const { due: due2 } = dueRegisters(plan, now + 100)
  expect(due2.size).toBe(0)
  // the realtime register (250ms) becomes due again before the slow one (100s)
  const { due: due3 } = dueRegisters(plan, now + 250)
  expect(due3.get(3)!.length).toBe(1)
  expect(due3.get(3)![0]).toBe(100)
})

test('planReadBatches merges contiguous registers and respects maxRegistersPerRequest', () => {
  const plan = buildQosRegisterPlan(
    makeSlave([reg(1, 0), reg(2, 1), reg(3, 2), reg(4, 20), reg(5, 22)]),
    0,
    api,
    { baudrate: 19200 },
    1,
    125,
    1000
  )!
  const due = new Map<number, number[]>()
  due.set(3, [0, 1, 2, 20, 22])
  const { batches } = planReadBatches(plan, due)
  expect(batches.length).toBe(2)
  const first = batches.find((b) => b.startAddress === 0)!
  expect(first.length).toBe(3)
  const second = batches.find((b) => b.startAddress === 20)!
  expect(second.length).toBe(3) // 20..22
})

test('planReadBatches fragments a span that cannot meet its strictest deadline on slow baud', () => {
  const ents = Array.from({ length: 125 }, (_, i) => reg(i + 1, i, { qos: 0 }))
  const plan = buildQosRegisterPlan(makeSlave(ents), 0, api, { baudrate: 9600 }, 1, 125, 1000)!
  const due = new Map<number, number[]>()
  due.set(3, Array.from({ length: 125 }, (_, i) => i))
  const { batches, warnings } = planReadBatches(plan, due)
  // the timing guard splits into multiple read batches (fragmentation)
  expect(batches.length).toBeGreaterThan(1)
  expect(batches[0].strictestDeadlineMs).toBeLessThanOrEqual(250)
  // and a warning explains that the QoS cannot be met on this bus
  expect(warnings.length).toBeGreaterThan(0)
  expect(warnings[0]).toContain('needs ~')
})

test('planReadBatches never exceeds maxRegistersPerRequest', () => {
  const ents = Array.from({ length: 300 }, (_, i) => reg(i + 1, i, { qos: 100 }))
  const plan = buildQosRegisterPlan(makeSlave(ents), 0, api, { baudrate: 19200 }, 1, 125, 1000)!
  const due = new Map<number, number[]>()
  due.set(3, Array.from({ length: 300 }, (_, i) => i))
  const { batches } = planReadBatches(plan, due)
  expect(batches.length).toBeGreaterThanOrEqual(3)
  batches.forEach((b) => expect(b.length).toBeLessThanOrEqual(125))
})

test('deduplicates entities sharing a register (SI/Imperial variants)', () => {
  const plan = buildQosRegisterPlan(
    makeSlave([reg(1, 101, { qos: 1000 }), reg(2, 101, { qos: 1000 })]),
    0,
    api,
    { baudrate: 9600 },
    1,
    125,
    1000
  )!
  expect(plan.registers.length).toBe(1)
})

test('config registers are excluded from the poll plan', () => {
  const plan = buildQosRegisterPlan(
    makeSlave([reg(1, 100), { ...reg(2, 400), category: 'config' }]),
    0,
    api,
    { baudrate: 9600 },
    1,
    125,
    1000
  )!
  expect(plan.registers.map((r) => r.address)).toEqual([100])
})

test('condition-source registers are added to the plan (config or hidden register)', () => {
  // A conditional entity whose condition source is a config register (or a register
  // with no entity of its own) must still be read by the QoS poller. Without it the
  // condition evaluates as inactive, the entity gets an empty mqttValue and
  // Home Assistant deletes it (device "disappears").
  const plan = buildQosRegisterPlan(
    makeSlave([
      reg(1, 0, { converterParameters: { multiplier: 0.1, offset: 0, decimals: 1, numberFormat: 0 } }),
      { ...reg(2, 5), condition: { register: 400, comparator: 'eq', value: 2 } },
      { ...reg(3, 6), condition: { register: 400, comparator: 'eq', value: 3 } },
      { ...reg(4, 400), category: 'config' },
    ]),
    0,
    api,
    { baudrate: 9600 },
    1,
    125,
    1000
  )!
  const addrs = plan.registers.map((r) => r.address)
  // value registers 0,5,6 + condition source 400
  expect(addrs).toContain(400)
  expect(addrs).toContain(0)
  expect(addrs).toContain(5)
  expect(addrs).toContain(6)
  // the condition source is polled realtime (250 ms) so gated values stay fresh
  const condReg = plan.registers.find((r) => r.address === 400)!
  expect(condReg.qos).toBe(QoSLevels.realtime)
  expect(condReg.intervalMs).toBe(250)
})

test('condition register that is also a value register keeps its own QoS', () => {
  // sensor_identification (reg 501) is both a value entity and the condition source
  // for temperature/co2/voc. It must appear exactly once in the plan, with its own
  // QoS (regular), not the condition's realtime override.
  const plan = buildQosRegisterPlan(
    makeSlave([
      reg(1, 501, { qos: 100 }), // regular
      { ...reg(2, 0), condition: { register: 501, bit: 0, comparator: 'eq', value: 1 } },
      { ...reg(3, 5), condition: { register: 501, bit: 5, comparator: 'eq', value: 1 } },
    ]),
    0,
    api,
    { baudrate: 9600 },
    1,
    125,
    1000
  )!
  const entries = plan.registers.filter((r) => r.address === 501)
  expect(entries.length).toBe(1)
  expect(entries[0].qos).toBe(QoSLevels.regular)
})
