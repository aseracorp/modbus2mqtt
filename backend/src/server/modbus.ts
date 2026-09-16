import { ImodbusSpecification, Ispecification } from '../shared/specification/index.js'
import { ConfigSpecification, ConverterMap, ImodbusValues, M2mSpecification, emptyModbusValues } from '../specification/index.js'
import { Ientity, ImodbusEntity } from '../shared/specification/index.js'
import { Config } from './config.js'
import { Observable, Subject } from 'rxjs'
import { Bus } from './bus.js'
import { submitGetHoldingRegisterRequest } from './submitRequestMock.js'
import { IfileSpecification } from '../specification/index.js'
import { LogLevelEnum, Logger } from '../specification/index.js'
import { ImodbusAddress, Islave, ModbusTasks } from '../shared/server/index.js'
import { IconsumerModbusAPI } from './modbusAPI.js'
import Debug from 'debug'
const debug = Debug('modbus')

const debugAction = Debug('actions')

const log = new Logger('modbus')
export class Modbus {
  constructor() {}

  static writeEntityModbus(modbusAPI: IconsumerModbusAPI, slaveid: number, entity: Ientity, modbusValue: number[]): Promise<void> {
    if (entity.modbusAddress && entity.registerType) {
      return modbusAPI.writeModbusRegister(slaveid, entity.modbusAddress, entity.registerType, modbusValue, {
        task: ModbusTasks.writeEntity,
        errorHandling: {},
      })
    }
    throw new Error('No modbusaddress or registerType passed')
  }

  static writeEntityMqtt(
    modbusAPI: IconsumerModbusAPI,
    slaveid: number,
    spec: Ispecification,
    entityid: number,
    mqttValue: string
  ): Promise<void> {
    // this.modbusClient.setID(device.slaveid);
    const entity = spec.entities.find((ent) => ent.id == entityid)
    if (Config.getConfiguration().fakeModbus) {
      return new Promise<void>((resolve) => {
        debug('Fake ModbusWrite')
        resolve()
      })
    } else if (entity) {
      const converter = ConverterMap.getConverter(entity)
      if (entity.modbusAddress !== undefined && entity.registerType && converter) {
        const modbusValue = converter?.mqtt2modbus(spec, entityid, mqttValue)
        if (modbusValue && modbusValue.length > 0) {
          return modbusAPI.writeModbusRegister(slaveid, entity.modbusAddress, entity.registerType, modbusValue, {
            task: ModbusTasks.writeEntity,
            errorHandling: {},
          })
          // TODO:Migrate converter
        } else throw new Error('No modbus address or function code or converter not found for entity ' + entityid + ' ')
      } else throw new Error('No modbus address or function code for entity ' + entityid + ' ')
    } else throw new Error('Entity not found in Specification entityid: ' + entityid + JSON.stringify(spec))
  }

  async readEntityFromModbus(
    modbusAPI: IconsumerModbusAPI,
    slaveid: number,
    spec: Ispecification,
    entityId: number
  ): Promise<ImodbusEntity> {
    const entity = spec.entities.find((ent) => ent.id == entityId)
    if (entity && entity.modbusAddress && entity.registerType) {
      const converter = ConverterMap.getConverter(entity)
      if (converter) {
        const addresses = new Set<ImodbusAddress>()
        for (let i = entity.modbusAddress; i < entity.modbusAddress + converter.getModbusLength(entity); i++)
          addresses.add({ address: i, registerType: entity.registerType })

        const results = Config.getConfiguration().fakeModbus
          ? await submitGetHoldingRegisterRequest(slaveid, addresses)
          : await modbusAPI.readModbusRegister(slaveid, addresses, { task: ModbusTasks.entity, errorHandling: { retry: true } })

        const em = M2mSpecification.copyModbusDataToEntity(spec, entity.id, results)
        if (em) return em
        throw new Error('Unable to copy ModbusData to Entity')
      }
    }
    const msg = 'Bus ' + modbusAPI.getName() + ' has no configured Specification'
    log.log(LogLevelEnum.info, msg)
    throw new Error(msg)
  }

  /*
   * iterates over slave ids starting at slaveid = 1. If one of the holding registers 0,1,2 or 3 returns a value, the slave id is considered to have an attached device.
   * Now, the method tries to find specifications which are supported by the device.
   * So, even if a device was not recognized, but the modbus registers of all identifying entities are available, the slaveId will be considered to hava an attached device.
   * The result, contains an array of all slaveids with an attached device.
   * Additionally it contains an array of public specifications matching the modbus registers of the device plus all local specifications.
   */

  private static populateEntitiesForSpecification(
    specification: IfileSpecification,
    values: ImodbusValues,
    sub: Subject<ImodbusSpecification>
  ) {
    const mspec = M2mSpecification.fileToModbusSpecification(specification!, values)
    if (mspec) sub.next(mspec)
  }
  /**
   * Returns true if the entity is active given the values of its condition register.
   * Entities without a `condition` are always active. Config entities are not read
   * as value registers (they are handled by the config API).
   */
  static isEntityActive(entity: { condition?: { register: number; registerType?: number; bits?: number[]; equals?: number }; modbusAddress?: number; category?: string }, value: number | undefined): boolean {
    if (!entity.condition) return true
    if (value === undefined || value === null) return false // condition register not readable -> not active
    const c = entity.condition
    let hit = false
    if (c.bits && c.bits.length) {
      hit = c.bits.some((bit) => ((value >> bit) & 1) === 1)
    }
    if (c.equals !== undefined && c.equals !== null) {
      if (value === c.equals) hit = true
    }
    return hit
  }

  static async getModbusSpecificationFromData(
    task: ModbusTasks,
    modbusAPI: IconsumerModbusAPI,
    slaveid: number,
    specification: IfileSpecification,
    sub: Subject<ImodbusSpecification>
  ): Promise<void> {
    ConfigSpecification.clearModbusData(specification)
    const info = '(' + modbusAPI.getName() + ',' + slaveid + ')'

    // ---- Phase 1: read condition registers (+ all value registers for a single
    // pass when there are no conditional entities) ----
    const conditionAddresses = new Set<ImodbusAddress>()
    const condRegType: Map<number, number> = new Map()
    for (const ent of specification.entities) {
      if (ent.category === 'config') continue // config regs are handled by the config API
      const c = ent.condition
      if (c) {
        const t = c.registerType ?? EntRegisterType(ent.registerType)
        conditionAddresses.add({ address: c.register, registerType: t })
        if (!condRegType.has(c.register)) condRegType.set(c.register, t)
      }
    }

    // ---- Phase 2: determine active entities, then read only their registers ----
    try {
      let activeEntities = specification.entities.filter((e) => e.category !== 'config')
      let skipReads = new Set<number>() // (address*10+registerType) of inactive entities
      let conditionValues: ImodbusValues | undefined = undefined

      const hasConditional = specification.entities.some((e) => e.condition)
      if (hasConditional) {
        // Read the condition registers first.
        conditionValues = await modbusAPI.readModbusRegister(slaveid, conditionAddresses, { task: task, errorHandling: { retry: true } })
        // Mark inactive entities: clear their modbusAddress so they are not read.
        activeEntities = activeEntities.filter((e) => {
          if (!e.condition) return true
          const type = e.condition.registerType ?? EntRegisterType(e.registerType)
          const val = getRegValue(conditionValues!, type, e.condition.register)
          // If the condition register itself is not readable, keep the entity (best effort) -
          // an unknown condition should not hide a possibly-present sensor.
          if (val === undefined) return true
          return Modbus.isEntityActive(e, val)
        })
      }

      const addresses = new Set<ImodbusAddress>()
      for (const ent of activeEntities) {
        const converter = ConverterMap.getConverter(ent)
        if (ent.modbusAddress != undefined && converter && ent.registerType)
          for (let i = 0; i < converter.getModbusLength(ent); i++) {
            addresses.add({ address: ent.modbusAddress + i, registerType: ent.registerType })
          }
      }

      debugAction('getModbusSpecificationFromData start read from modbus')
      const values = await modbusAPI.readModbusRegister(slaveid, addresses, { task: task, errorHandling: { retry: true } })
      debugAction('getModbusSpecificationFromData end read from modbus')

      // Mark inactive conditional entities so they are reported as not-identified / empty.
      const finalValues = values
      if (hasConditional && conditionValues) {
        for (const ent of specification.entities) {
          if (!ent.condition) continue
          const type = ent.condition.registerType ?? EntRegisterType(ent.registerType)
          const val = getRegValue(conditionValues, type, ent.condition.register)
          if (val === undefined) continue
          if (!Modbus.isEntityActive(ent, val)) {
            // Remove its address data from the result so the entity shows not-identified.
            const e = ent as ImodbusEntityLike
            if (e.modbusAddress !== undefined) {
              finalValues.holdingRegisters.delete(e.modbusAddress)
              finalValues.analogInputs.delete(e.modbusAddress)
              finalValues.coils.delete(e.modbusAddress)
              finalValues.discreteInputs.delete(e.modbusAddress)
            }
          }
        }
      }
      Modbus.populateEntitiesForSpecification(specification!, finalValues, sub)
    } catch (e: any) {
      log.log(LogLevelEnum.error, 'Modbus Read ' + info + ' failed: ' + e.message)
      Modbus.populateEntitiesForSpecification(specification!, emptyModbusValues(), sub)
    }
  }
  static getModbusSpecification(
    task: ModbusTasks,
    modbusAPI: IconsumerModbusAPI,
    slave: Islave,
    specificationFilename: string | undefined,
    failedFunction: (e: unknown) => void
  ): Observable<ImodbusSpecification> {
    debugAction('getModbusSpecification starts (' + modbusAPI.getName() + ',' + slave.slaveid + ')')
    const rc = new Subject<ImodbusSpecification>()
    if (!specificationFilename || specificationFilename.length == 0) {
      if (slave && slave.specificationid && slave.specificationid.length > 0) specificationFilename = slave.specificationid
    }
    if (specificationFilename) {
      const spec = ConfigSpecification.getSpecificationByFilename(specificationFilename)
      if (spec) {
        Modbus.getModbusSpecificationFromData(task, modbusAPI, slave.slaveid, spec, rc)
      } else {
        const msg = 'Specification not found: ' + specificationFilename
        failedFunction(new Error(msg))
      }
    } else {
      const msg = 'No specification passed to  getModbusSpecification'
      debug(msg)
      failedFunction(new Error(msg))
    }
    return rc
  }
}

interface ImodbusEntityLike {
  modbusAddress?: number
  condition?: { register: number; registerType?: number; bits?: number[]; equals?: number }
}
function EntRegisterType(rt: number): number {
  return rt
}
function getRegValue(v: ImodbusValues, registerType: number, address: number): number | undefined {
  let value: { data?: number[] } | undefined
  switch (registerType) {
    case 4: value = v.analogInputs.get(address); break
    case 3: value = v.holdingRegisters.get(address); break
    case 1: value = v.coils.get(address); break
    default: value = v.discreteInputs.get(address); break
  }
  return value && value.data && value.data.length ? value.data[0] : undefined
}

export class ModbusForTest extends Modbus {
  modbusDataToSpecForTest(spec: IfileSpecification): ImodbusSpecification | undefined {
    return M2mSpecification.fileToModbusSpecification(spec)
  }
}
