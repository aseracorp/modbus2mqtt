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
