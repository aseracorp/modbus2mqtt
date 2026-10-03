

import { IModbusResultOrError, ImodbusValues, fileToModbusSpecification, entityConditions } from '../specification/index.js'
import { ModbusRegisterType, ImodbusSpecification, Ientity } from '../shared/specification/index.js'
import {
  QoSLevels,
  Slave,
  qosIntervalMs,
  DEFAULT_QOS_BY_CATEGORY,
  ModbusTasks,
  Islave,
} from '../shared/server/index.js'
import { IconsumerModbusAPI } from './modbusAPI.js'
import { Bus } from './bus.js'
import { Config } from './config.js'
import { MqttDiscover } from './mqttdiscover.js'
import { HttpPush } from './httpPush.js'
import { MqttConnector } from './mqttconnector.js'

/**
 * Modbus RTU frame timing model. A read request of N registers costs an 8-byte frame
 * (addr, fct, start-addr, count, CRC), the responder echoes a (5 + 2N + 2) byte frame and
 * both are separated by the 3.5-character RTU silence gap. At `baudrate` bps with 10 bits
 * per byte that is a pure wire-time estimate; `slavesOnBus` accounts for round-robin
 * fairness between slaves sharing the serial link. Measured per-read durations (from the
 * RTU worker's IModbusResultWithDuration) are preferred when available; this estimate is
 * the fallback and the basis for the "is QoS achievable?" warning.
 */
export function estimateReadDurationMs(registers: number, baudrate: number, slavesOnBus: number): number {
  if (baudrate <= 0 || registers <= 0) return 10 + registers * 2
  const bytesPerMs = baudrate / 10 / 1000
  const requestBytes = 8
  const responseBytes = 5 + 2 * registers + 2
  const silenceChars = 3.5 + 3.5
  const ownMs = (requestBytes + responseBytes + silenceChars) / bytesPerMs
  return ownMs * Math.max(1, slavesOnBus) * 1.15
}

/** QoS levels in ascending interval order — priority order (realtime first). */
export const QOS_LEVELS_BY_PRIORITY: QoSLevels[] = [
  QoSLevels.realtime,
  QoSLevels.fast,
  QoSLevels.regular,
  QoSLevels.slow,
  QoSLevels.static,
]

export interface IQosRegister {
  address: number
  registerType: ModbusRegisterType
  length: number
  qos: number
  intervalMs: number
  lastRead: number // epoch ms of the last successful read; 0 = never read
}

export interface IQosSlavePlan {
  islave: Islave
  busId: number
  api: IconsumerModbusAPI
  registers: IQosRegister[]
  baudrate: number
  slaveCount: number
  maxRegistersPerRequest: number
  pollIntervalMs: number
  warnings: string[]
}

export interface IQosReadBatch {
  registerType: ModbusRegisterType
  startAddress: number
  length: number
  strictestDeadlineMs: number
}

/**
 * Builds the per-register QoS plan of a slave. One entry per physical register
 * (entities sharing an address, e.g. SI/Imperial variants, are deduplicated).
 * Config registers are excluded from the MQTT state / HA discovery (handled via
 * the config API, not polled) - EXCEPT when a config register is the source of a
 * condition (e.g. unit system selecting SI/Imperial variants). Condition-source
 * registers are added with realtime QoS so every conditional entity is evaluated
 * against a fresh selector; without them the entity reports inactive (empty
 * mqttValue) and Home Assistant removes it from the device.
 */
export function buildQosRegisterPlan(
  islave: Islave,
  busId: number,
  api: IconsumerModbusAPI,
  conn: { baudrate?: number },
  slaveCount: number,
  maxRegistersPerRequest: number,
  pollIntervalMs: number
): IQosSlavePlan | undefined {
  const spec = islave.specification
  if (!spec || !spec.entities || spec.entities.length === 0) return undefined
  const registers: IQosRegister[] = []
  const seen = new Set<string>()
  // Add a register at most once: entities sharing an address (e.g. SI/Imperial
  // variants) and condition sources that are also value registers both dedupe here.
  const addRegister = (address: number, registerType: ModbusRegisterType, length: number, qos: number): void => {
    const key = registerType + ':' + address
    if (seen.has(key)) return
    seen.add(key)
    registers.push({
      address,
      registerType,
      length,
      qos,
      intervalMs: qosIntervalMs(qos, pollIntervalMs),
      lastRead: 0,
    })
  }
  for (const ent of spec.entities) {
    if (ent.modbusAddress == undefined || !ent.registerType) continue
    // Config registers are not exposed to MQTT/HA (handled via the config API) and
    // are NOT polled into state - but when a config register is the source of a
    // condition (e.g. unit system selecting SI/Imperial variants) it must still be
    // read, otherwise every conditional entity evaluates as inactive and the entity
    // disappears from Home Assistant. The condition pass below adds it.
    if (ent.category === 'config') continue
    addRegister(ent.modbusAddress, ent.registerType, modbusLengthFor(ent), Number.isFinite(ent.qos as number) ? (ent.qos as number) : defaultQosFor(ent))
  }
  // Condition sources: registers referenced by `condition`/`conditions` that are not
  // already in the plan (often a config register or a register with no entity of its
  // own). Without them `isEntityActiveByValues` reports every conditional entity as
  // inactive - empty mqttValue - and the state payload/discovery deletes the entity
  // in Home Assistant. They are polled realtime (250 ms) so the gated values are
  // always evaluated against a fresh selector.
  for (const ent of spec.entities) {
    for (const c of entityConditions(ent)) {
      const registerType = c.registerType ?? ent.registerType ?? ModbusRegisterType.HoldingRegister
      addRegister(c.register, registerType, 1, QoSLevels.realtime)
    }
  }
  return {
    islave,
    busId,
    api,
    registers,
    baudrate: conn.baudrate ?? 0,
    slaveCount: Math.max(1, slaveCount),
    maxRegistersPerRequest,
    pollIntervalMs,
    warnings: [],
  }
}

export function modbusLengthFor(ent: Ientity): number {
  const cp = ent.converterParameters
  if (ent.converter === 'number' && cp && 'numberFormat' in cp && cp['numberFormat'] === 1) return 2
  if (ent.converter === 'text' && cp && 'stringlength' in cp && typeof cp['stringlength'] === 'number' && cp['stringlength'] > 0)
    return cp['stringlength'] as number
  return 1
}

export function defaultQosFor(ent: { category?: string; entityCategory?: string }): number {
  const cat = ent.category ?? (ent.entityCategory === 'diagnostic' ? 'diagnostic' : 'value')
  return DEFAULT_QOS_BY_CATEGORY[cat] ?? QoSLevels.regular
}

/**
 * Returns the register addresses whose QoS interval elapsed, per registerType,
 * plus the strictest (smallest) deadline among all due registers.
 */
export function dueRegisters(
  plan: IQosSlavePlan,
  now: number
): { due: Map<ModbusRegisterType, number[]>; strictestDeadlineMs: number } {
  const due = new Map<ModbusRegisterType, number[]>()
  let strictestDeadlineMs = Infinity
  for (const reg of plan.registers) {
    const dueAt = reg.lastRead + reg.intervalMs
    if (reg.lastRead === 0 || dueAt <= now) {
      const arr = due.get(reg.registerType) ?? []
      arr.push(reg.address)
      due.set(reg.registerType, arr)
      strictestDeadlineMs = Math.min(strictestDeadlineMs, reg.intervalMs)
    }
  }
  return { due, strictestDeadlineMs }
}

/**
 * Merges due addresses into contiguous read spans (same heuristic as the RTU processor:
 * consecutive within a gap of 10, bounded by maxRegistersPerRequest) but additionally
 * fragments spans whose estimated read duration would exceed the strictest member's QoS
 * deadline — so realtime registers are never starved by a huge slow scan.
 *
 * QoS accounting rules:
 *  - a merged read's QoS is the LOWEST priority (largest interval) of its members,
 *  - its strictest deadline (smallest interval) decides whether it must be fragmented.
 */
export function planReadBatches(
  plan: IQosSlavePlan,
  due: Map<ModbusRegisterType, number[]>
): { batches: IQosReadBatch[]; warnings: string[] } {
  const batches: IQosReadBatch[] = []
  const warnings: string[] = []
  const deadlineOf = (addr: number): number => {
    const reg = plan.registers.find((r) => r.address === addr)
    return reg ? reg.intervalMs : plan.pollIntervalMs
  }
  for (const [registerType, addresses] of due) {
    const sorted = [...addresses].sort((a, b) => a - b)
    let spanStart = -1
    let spanPrev = -1
    let strictest = Infinity
    const flush = (): void => {
      if (spanStart < 0) return
      const spanLength = spanPrev - spanStart + 1
      const estMs = estimateDurationFor(plan, spanLength)
      if (estMs > strictest && spanLength > 1) {
        // Fragment: read the leading (fast) registers now, leave the tail for the next tick.
        const cut = Math.max(1, Math.floor((strictest / estMs) * spanLength))
        warnings.push(
          `Register span ${spanStart}..${spanPrev} (${spanLength} regs) cannot meet its QoS deadline ` +
            `(~${Math.round(estMs)}ms > ${strictest}ms) — reading ${cut} of ${spanLength} registers now, rest next cycle`
        )
        batches.push({ registerType, startAddress: spanStart, length: cut, strictestDeadlineMs: strictest })
        if (spanLength - cut > 0)
          batches.push({ registerType, startAddress: spanStart + cut, length: spanLength - cut, strictestDeadlineMs: strictest })
        spanStart = -1
        spanPrev = -1
        strictest = Infinity
        return
      }
      batches.push({ registerType, startAddress: spanStart, length: spanLength, strictestDeadlineMs: strictest })
      spanStart = -1
      spanPrev = -1
      strictest = Infinity
    }
    for (const addr of sorted) {
      const addrDeadline = deadlineOf(addr)
      if (spanStart < 0) {
        spanStart = addr
        spanPrev = addr
        strictest = addrDeadline
        continue
      }
      const gap = addr - spanPrev
      const spanIfMerged = addr - spanStart + 1
      const estMerged = estimateDurationFor(plan, spanIfMerged)
      const deadlineLimit = Math.min(strictest, addrDeadline)
      const canMerge =
        gap <= 10 &&
        spanIfMerged <= plan.maxRegistersPerRequest &&
        estMerged <= deadlineLimit
      if (canMerge) {
        spanPrev = addr
        strictest = Math.min(strictest, addrDeadline)
        continue
      }
      // A split forced by the QoS timing budget (not by address gaps or the request size
      // limit) means the requested QoS cannot be met on this bus: surface it as a warning.
      if (gap <= 10 && spanIfMerged <= plan.maxRegistersPerRequest && estMerged > deadlineLimit) {
        const msg =
          `Register span ${spanStart}..${addr} (${spanIfMerged} regs) needs ~${Math.round(estMerged)}ms, ` +
          `more than its QoS allows (${deadlineLimit}ms) — fragmented so higher-priority registers are read first`
        if (!warnings.includes(msg)) warnings.push(msg)
      }
      flush()
      spanStart = addr
      spanPrev = addr
      strictest = addrDeadline
    }
    flush()
  }
  // Issue strictest-deadline-first so realtime registers hit the wire before slow ones.
  batches.sort((a, b) => a.strictestDeadlineMs - b.strictestDeadlineMs)
  return { batches, warnings }
}

function estimateDurationFor(plan: IQosSlavePlan, length: number): number {
  if (plan.baudrate > 0) return estimateReadDurationMs(length, plan.baudrate, plan.slaveCount)
  return 10 + length * 2
}

export function mergeValues(fresh: Map<ModbusRegisterType, Map<number, IModbusResultOrError>>, values: ImodbusValues): void {
  // Sticky last-known-value semantics: an address that resolved with an error
  // (IModbusResultOrError.error) must NOT erase a previously known good data
  // value in `fresh`. Otherwise a transient read failure on a condition or
  // device-variable register makes conditional entities flip active↔inactive,
  // and republishDiscoveryIfChanged toggles delete/re-announce every tick -
  // an infinite MQTT discovery republish loop that also makes entities
  // flicker in Home Assistant. Error entries only fill addresses that were
  // never read successfully.
  const merge = (src: Map<number, IModbusResultOrError>, dst: Map<number, IModbusResultOrError>) => {
    src.forEach((v, k) => {
      if (v && v.error != undefined) {
        if (dst.has(k)) return // keep last-known good value
        dst.set(k, v)
      } else {
        dst.set(k, v)
      }
    })
  }
  merge(values.holdingRegisters, fresh.get(ModbusRegisterType.HoldingRegister)!)
  merge(values.analogInputs, fresh.get(ModbusRegisterType.AnalogInputs)!)
  merge(values.coils, fresh.get(ModbusRegisterType.Coils)!)
  merge(values.discreteInputs, fresh.get(ModbusRegisterType.DiscreteInputs)!)
}

/**
 * Marks a register as successfully read only when the merged value actually
 * carries data. Registers whose read resolved with an error keep lastRead
 * unchanged so the QoS deadline pressure retries them on the next tick.
 */
function markReadOk(
  plan: IQosSlavePlan,
  fresh: Map<ModbusRegisterType, Map<number, IModbusResultOrError>>,
  batch: IQosReadBatch,
  now: number
): void {
  const src = fresh.get(batch.registerType)
  for (const reg of plan.registers) {
    if (reg.registerType !== batch.registerType) continue
    if (reg.address < batch.startAddress || reg.address >= batch.startAddress + batch.length) continue
    const v = src?.get(reg.address)
    if (v && v.error == undefined && v.data != undefined && v.data.length > 0) reg.lastRead = now
  }
}
/**
 * Dynamic polling scheduler (PollModes.dynamicPolling).
 *
 * Runs on the same 100ms cadence as the interval poller. For every mode-5 slave it:
 *  1. builds/keeps the per-register QoS plan (interval per QoS level),
 *  2. computes which registers are due right now,
 *  3. merges them into the fewest reads that still meet every member's deadline
 *     (fragmenting oversized spans), and reads them in deadline order,
 *  4. merges fresh values into a sticky last-known-value map so a register that is not
 *     due keeps publishing its last value instead of an empty hole,
 *  5. publishes MQTT/HTTP-push state once per tick when at least one register was read,
 *     and surfaces QoS warnings (surviving in the plan, consumed by the webui / Status).
 */
export class MqttQosPoller {
  private plans = new Map<string, IQosSlavePlan>()
  private lastValues = new Map<string, Map<ModbusRegisterType, Map<number, IModbusResultOrError>>>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private connector: MqttConnector,
    private bus: Bus
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tickPoll().catch((e) => this.log('tick error: ' + (e instanceof Error ? e.message : String(e))))
    }, 100)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.plans.clear()
    this.lastValues.clear()
  }

  private log(msg: string): void {
    console.debug('[qos] ' + msg)
  }

  /** All slave plans with non-empty warnings, keyed by "busId s slaveId". Used by the webui. */
  getWarnings(): Record<string, string[]> {
    const rc: Record<string, string[]> = {}
    this.plans.forEach((plan, key) => {
      if (plan.warnings.length > 0) rc[key] = [...plan.warnings]
    })
    return rc
  }

  private async tickPoll(): Promise<void> {
    if (!this.connector.isConnected()) return
    const now = Date.now()
    for (const islave of this.bus.getSlaves()) {
      if (islave.pollMode !== 5 /* PollModes.dynamicPolling */) continue
      try {
        await this.pollSlave(islave, now)
      } catch (e) {
        this.log('slave ' + islave.slaveid + ' poll error: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
  }

  private async pollSlave(islave: Islave, now: number): Promise<void> {
    const key = this.bus.getId() + 's' + islave.slaveid
    let plan = this.plans.get(key)
    if (!plan || plan.islave !== islave) {
      const rebuilt = this.buildPlan(islave)
      if (!rebuilt) return
      plan = rebuilt
      this.plans.set(key, plan)
    }
    const { due } = dueRegisters(plan, now)
    if (due.size === 0) return // nothing due — keep the last published values as they are

    const { batches, warnings } = planReadBatches(plan, due)
    for (const w of warnings) if (!plan.warnings.includes(w)) plan.warnings.push(w)

    const fresh = this.lastValues.get(key) ?? this.emptyValueMap()
    let anyRead = false
    for (const batch of batches) {
      const addresses = new Set<{ address: number; registerType: ModbusRegisterType }>()
      for (let a = batch.startAddress; a < batch.startAddress + batch.length; a++)
        addresses.add({ address: a, registerType: batch.registerType })
      try {
        const values = await plan.api.readModbusRegister(islave.slaveid, addresses, {
          task: ModbusTasks.poll,
          errorHandling: { retry: true },
        })
        mergeValues(fresh, values)
        // Only registers that actually returned data advance their deadline.
        // Errored addresses stay due and are retried by QoS pressure instead of
        // being treated as "fresh" (which would keep stale values forever).
        markReadOk(plan, fresh, batch, now)
        // anyRead only when at least one register produced data: publishing a
        // state/discovery cycle for nothing but errors is what used to feed the
        // republish loop.
        if (plan.registers.some((r) => r.lastRead === now)) anyRead = true
      } catch (e) {
        // lastRead stays unchanged → the register remains due (deadline pressure retries it)
        this.log('read failed: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
    if (!anyRead) return

    this.lastValues.set(key, fresh)
    await this.publishState(islave, fresh, now)
  }

  private buildPlan(islave: Islave): IQosSlavePlan | undefined {
    // The bus exposes no baudrate getter; derive it from the connection data if it is an RTU bus.
    let baudrate = 0
    const props = (this.bus.properties as { connectionData?: { baudrate?: number } }).connectionData
    if (props) baudrate = props.baudrate ?? 0
    const slaveCount = this.bus.getSlaves().length
    const maxReg = islave.maxRegistersPerRequest ?? 125
    const pollInterval = islave.pollInterval ?? 1000
    return buildQosRegisterPlan(islave, this.bus.getId(), this.bus.getModbusAPI(), { baudrate }, slaveCount, maxReg, pollInterval)
  }

  private emptyValueMap(): Map<ModbusRegisterType, Map<number, IModbusResultOrError>> {
    const m = new Map<ModbusRegisterType, Map<number, IModbusResultOrError>>()
    m.set(ModbusRegisterType.HoldingRegister, new Map())
    m.set(ModbusRegisterType.AnalogInputs, new Map())
    m.set(ModbusRegisterType.Coils, new Map())
    m.set(ModbusRegisterType.DiscreteInputs, new Map())
    return m
  }

  private async publishState(
    islave: Islave,
    valuesMap: Map<ModbusRegisterType, Map<number, IModbusResultOrError>>,
    now: number
  ): Promise<void> {
    const baseTopic = Config.getConfiguration().mqttbasetopic
    const slave = new Slave(this.bus.getId(), islave, baseTopic)
    const spec = islave.specification
    if (!spec) return

    // Reuse the standard values→spec pipeline so converters/conditions/identification
    // behave exactly like the interval poller.
    const values: ImodbusValues = {
      holdingRegisters: valuesMap.get(ModbusRegisterType.HoldingRegister) ?? new Map(),
      analogInputs: valuesMap.get(ModbusRegisterType.AnalogInputs) ?? new Map(),
      coils: valuesMap.get(ModbusRegisterType.Coils) ?? new Map(),
      discreteInputs: valuesMap.get(ModbusRegisterType.DiscreteInputs) ?? new Map(),
    }
    const mspec = fileToModbusSpecification(structuredClone(spec) as never, values)

    if ((slave.shouldPublishMqtt() || slave.hasHttpPush()) && (mspec as ImodbusSpecification).entities) {
      if (slave.shouldPublishMqtt()) {
        this.connector.getMqttClient((mqttClient) => {
          if (!mqttClient) return
          const payload = slave.getStatePayload((mspec as ImodbusSpecification).entities)
          mqttClient.publish(slave.getStateTopic(), payload, (err) => {
            if (err) this.log('mqtt publish failed: ' + err.message)
          })
          mqttClient.publish(slave.getAvailabilityTopic(), 'online', (err) => {
            if (err) this.log('availability publish failed: ' + err.message)
          })
        })
      }
      if (slave.hasHttpPush()) {
        await HttpPush.pushState(slave, mspec as ImodbusSpecification, new Date(now)).catch((e) =>
          this.log('httpPush failed: ' + (e instanceof Error ? e.message : String(e)))
        )
      }
      try {
        MqttDiscover.getInstance().republishDiscoveryIfChanged(slave, mspec as ImodbusSpecification)
      } catch (e) {
        this.log('republishDiscoveryIfChanged failed: ' + (e instanceof Error ? e.message : String(e)))
      }
    }
  }
}
