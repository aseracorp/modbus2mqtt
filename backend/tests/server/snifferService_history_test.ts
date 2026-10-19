import { it, expect, describe, vi } from 'vitest'
import { InMemorySnifferStore } from '../../src/server/sniffer/store.js'
import { SnifferService } from '../../src/server/sniffer/snifferService.js'
import * as configbusMod from '../../src/server/configbus.js'
import * as cspec from '../../src/specification/configspec.js'

/** Minimal Thermokon WRF06 spec mirroring the productive template. */
const spec = {
  filename: 'thermokon-wrf06',
  model: 'WRF06',
  manufacturer: 'Thermokon',
  entities: [
    { id: 1, registerType: 3, converter: 'number', converterParameters: { multiplier: 1, offset: 0, decimals: 0, numberFormat: 0 }, modbusAddress: 501, valid: true, mqttname: 'sensor_identification' },
    { id: 24, registerType: 3, converter: 'select', converterParameters: { multiplier: 1, offset: 0, decimals: 0, options: { 1: 'SI', 2: 'Imperial' } }, modbusAddress: 400, valid: true, mqttname: 'unit_system' },
    { id: 2, registerType: 3, converter: 'number', modbusAddress: 0,
      conditions: [
        { register: 400, comparator: 'eq', value: 1 },
        { register: 501, bit: 0, comparator: 'eq', value: 1 },
      ],
      converterParameters: { multiplier: 0.1, offset: 0, decimals: 1, numberFormat: 0, uom: '°C' }, valid: true, mqttname: 'temperature_si' },
    { id: 25, registerType: 3, converter: 'number', modbusAddress: 0,
      conditions: [
        { register: 400, comparator: 'eq', value: 2 },
        { register: 501, bit: 0, comparator: 'eq', value: 1 },
      ],
      converterParameters: { multiplier: 0.1, offset: 0, decimals: 1, numberFormat: 0, uom: '°F' }, valid: true, mqttname: 'temperature_imperial' },
    { id: 6, registerType: 3, converter: 'number', modbusAddress: 5,
      condition: { register: 501, bit: 5, comparator: 'eq', value: 1 },
      converterParameters: { multiplier: 1, offset: 0, decimals: 0, numberFormat: 0, uom: 'ppm' }, valid: true, mqttname: 'co2' },
  ],
}

const fakeTap = {
  describe: () => 'idle',
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: () => false,
}

function makeService() {
  const store = new InMemorySnifferStore()
  store.upsertConfig({ busId: 0, mode: 'stack', enabled: true })
  const service = new SnifferService({ busId: 0, mode: 'stack', enabled: true }, store, undefined, () => fakeTap)
  return { store, service }
}

describe('sniffer getRegisterHistoryFlat', () => {
  it('splits a multi-register read into one row per address with its own word', async () => {
    // Sniffer-only slave: not in ConfigBus; template comes from the store.
    vi.spyOn(configbusMod.ConfigBus, 'getSlave').mockReturnValue(undefined)
    vi.spyOn(cspec.ConfigSpecification, 'getSpecificationByFilename').mockReturnValue(spec as any)

    const { store, service } = makeService()
    store.setSlaveTemplate(0, 5, 'thermokon-wrf06')
    // Context registers for gating: 400=1 (SI), 501=33 (bit0 Temp + bit5 CO2)
    store.upsertRegisterDirect({ busId: 0, slaveId: 5, address: 400, quantity: 1, functionCode: 3 })
    store.upsertRegisterDirect({ busId: 0, slaveId: 5, address: 501, quantity: 1, functionCode: 3 })
    const regs = store.getRegisters(0, 5)
    regs.find((r) => r.address === 400).words = [1]
    regs.find((r) => r.address === 501).words = [33]

    // A single response carrying 8 words (addr 0..7), as the master reads the
    // whole block at once.
    store.appendTelegram(0, {
      direction: 'response',
      timestamp: 1792346718.158,
      slaveId: 5,
      functionCode: 3,
      payload: [],
      raw: [],
      crcOk: true,
      decoded: { functionName: 'readHoldingRegisters', address: 0, length: 8, values: [249, 0, 0, 0, 0, 521, 0, 0] },
    })

    const rows = service.getRegisterHistoryFlat(0, 5, undefined, undefined, undefined, 50, 0)
    // 8 address rows
    expect(rows).toHaveLength(8)
    // Row for addr 0: raw is ONLY the word at addr 0, interpreted as °C
    const a0 = rows.find((r) => r.address === 0)
    expect(a0?.rawValue).toBe('249')
    expect(a0?.value).toBe('24.9')
    expect(a0?.uom).toBe('°C')
    // Row for addr 5: CO2
    const a5 = rows.find((r) => r.address === 5)
    expect(a5?.rawValue).toBe('521')
    expect(a5?.value).toBe('521')
    // Rows for addresses with no template entity still carry their own word
    const a3 = rows.find((r) => r.address === 3)
    expect(a3?.rawValue).toBe('0')
  })

  it('honours a manual annotation (pencil) over the template', async () => {
    vi.spyOn(configbusMod.ConfigBus, 'getSlave').mockReturnValue(undefined)
    vi.spyOn(cspec.ConfigSpecification, 'getSpecificationByFilename').mockReturnValue(spec as any)

    const { store, service } = makeService()
    store.setSlaveTemplate(0, 5, 'thermokon-wrf06')
    store.upsertRegisterDirect({ busId: 0, slaveId: 5, address: 400, quantity: 1, functionCode: 3 })
    store.upsertRegisterDirect({ busId: 0, slaveId: 5, address: 501, quantity: 1, functionCode: 3 })
    const regs = store.getRegisters(0, 5)
    regs.find((r) => r.address === 400).words = [1]
    regs.find((r) => r.address === 501).words = [33]

    // Manual annotation: user set unit °F (no formula). Template interpretes
    // 250 -> 25.x but the annotated unit must win.
    store.upsertRegisterDirect({
      busId: 0, slaveId: 5, address: 0, quantity: 1, functionCode: 3,
      converter: 'number', uom: '°F', description: 'Temperature', specKey: 'thermokon-wrf06',
    })
    const a0row = store.getRegisters(0, 5).find((r) => r.address === 0)
    a0row.words = [250]
    a0row.rawValue = '250'
    a0row.annotated = true
    expect(a0row).toBeDefined()

    store.appendTelegram(0, {
      direction: 'response',
      timestamp: 1792346718.158,
      slaveId: 5,
      functionCode: 3,
      payload: [],
      raw: [],
      crcOk: true,
      decoded: { functionName: 'readHoldingRegisters', address: 0, length: 1, values: [250] },
    })

    const rows = service.getRegisterHistoryFlat(0, 5, undefined, undefined, undefined, 50, 0)
    const a0 = rows.find((r) => r.address === 0)
    expect(a0?.rawValue).toBe('250')
    expect(a0?.uom).toBe('°F')
  })
})
