import Debug from 'debug'
import { Logger, LogLevelEnum } from '../../specification/index.js'
import { RtuFrameParser } from './parser.js'
import { decodePdu, registerRanges, valueAddresses, evaluateManualConverter } from './decode.js'
import { SnifferStore } from './store.js'
import { BusPortTapTransport, SnifferByteSink, SnifferTransport } from './transport.js'
import { Bus } from '../bus.js'
import { SerialTapTransport } from './serialTap.js'
import {
  ParsedTelegram,
  SnifferBusConfig,
  SnifferDeviceRow,
  SnifferRegisterRow,
  SnifferState,
  SnifferTelegramRow,
  SnifferMappingCreate,
} from './types.js'
import { ConfigBus } from '../configbus.js'
import { ConverterMap } from '../../specification/index.js'
import { ModbusRegisterType, Ientity } from '../../shared/specification/index.js'
import { entityConditions, conditionMatches, readConditionValue } from '../../specification/conditions.js'
import { ImodbusValues } from '../../specification/modbusValues.js'

const debug = Debug('modbus2mqtt:sniffer:service')
const log = new Logger('sniffer:service')

/**
 * Orchestrates the RTU sniffer for one bus: owns the transport(s), feeds the
 * parser, decorates decoded frames, maintains the device/register inventory in
 * the store and exposes the state/query API used by the HTTP routes.
 *
 * The service is transport-agnostic: the transport delivers raw bytes and the
 * service turns them into telegrams. This keeps the parser pure and lets the
 * tests feed synthetic byte streams directly.
 *
 * To make the sniffer reliable in the field the service can drive BOTH
 * transports at once:
 *  - `stack`  hook into the ModbusAPI read/write calls of the active master.
 *  - `tap`    passively listen on tapDevice (dedicated tap / Y-splitter).
 *  - `auto`   (default) starts the tap when configured AND always wires the
 *             stack hook, so traffic is seen even if the tap device is missing
 *             or silent. Errors from either transport are surfaced via state.
 */
/** Creates a tap transport for a config. Injectable for tests. */
export type TapTransportFactory = (device: string, baudRate: number) => SnifferTransport
/** Creates a tap that borrows the bus's already-open serial port (same device case). */
export type BusPortTapFactory = (busId: number) => SnifferTransport

const defaultTapFactory: TapTransportFactory = (device, baudRate) => new SerialTapTransport(device, baudRate)
const defaultBusPortTapFactory: BusPortTapFactory = (busId) => {
  const bus = Bus.getBus(busId)
  if (!bus) throw new Error('bus ' + busId + ' not found for bus-port tap')
  return new BusPortTapTransport(bus)
}

export class SnifferService implements SnifferTransport {
  private parser: RtuFrameParser | undefined
  private transports: SnifferTransport[] = []
  private stackSink: SnifferByteSink
  private tapSink: SnifferByteSink
  private running = false
  private telegramCount = 0
  private startedAt: number | undefined
  private error: string | undefined
  /** Transport descriptions of the currently active transports (diagnostics). */
  private transportLabels: string[] = []
  /** Raw bytes seen by passive taps (bus-port tap / serial tap) since start. */
  private tapByteCount = 0
  /** Monotonic change counter - bumped whenever captured data changes. */
  private changeCounter = 0
  /** One-shot subscribers notified on the next data change (SSE fan-out). */
  private changeWaiters: Array<() => void> = []

  constructor(
    private config: SnifferBusConfig,
    private store: SnifferStore,
    private tapFactory: TapTransportFactory = defaultTapFactory,
    private busPortTapFactory: BusPortTapFactory = defaultBusPortTapFactory
  ) {
    this.stackSink = {
      onBytes: (direction, bytes) => {
        if (!this.parser) return
        // If a serial tap is actively capturing the real wire frames, the
        // stack hook only duplicates them (as synthetic frames reconstructed
        // from the ModbusAPI calls). Feeding both into one parser would
        // double every telegram. Only feed the hook when no tap is running.
        if (this.hasActiveTap()) {
          debug('stack hook bytes dropped: tap is active')
          return
        }
        // The stack hook delivers complete frames as distinct units - parse
        // them immediately (byte-level silence detection is only needed for
        // the tap).
        this.parser.feed(bytes, Date.now())
        this.parser.flush()
      },
      onTapError: (message) => {
        this.error = message
        log.log(LogLevelEnum.error, 'tap runtime error: ' + message)
      },
    }
    // The serial tap forwards raw byte chunks, so it must NOT flush per
    // chunk: frames may span multiple serial reads and the parser's
    // silence-based tick separates them. Complete-frame units (stack hook)
    // use stackSink above, which flushes after every unit.
    this.tapSink = {
      onBytes: (_direction, bytes) => {
        if (!this.parser) return
        this.tapByteCount += bytes.length
        this.parser.feed(bytes, Date.now())
      },
      onTapError: (message) => {
        this.error = message
        log.log(LogLevelEnum.error, 'tap runtime error: ' + message)
      },
    }
  }

  describe(): string {
    return this.transports.map((t) => t.describe()).join(' + ') || `${this.config.mode}@bus${this.config.busId}`
  }

  /** True while a serial tap (not the stack hook) is actively capturing. */
  private hasActiveTap(): boolean {
    return this.transports.some((t) => t.isRunning() && !t.describe().startsWith('stack hook'))
  }

  /** True while actively capturing. */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Entry point for the external stack hook wiring (registry/Bus). The
   * ModbusAPI calls this with observed request/response bytes. It is ALSO
   * invoked by the internal stack transport, so both wiring paths share the
   * same sink.
   */
  feed(direction: 'request' | 'response', bytes: number[]): void {
    this.stackSink.onBytes(direction, bytes)
  }

  /** Returns the sink that the Bus/ModbusAPI should call with stack bytes. */
  getStackSink(): SnifferByteSink {
    return this.stackSink
  }

  /** Reads the config (may have been updated). */
  getConfig(): SnifferBusConfig {
    return this.config
  }

  setConfig(config: SnifferBusConfig): void {
    this.config = config
    this.store.upsertConfig(config)
  }

  getState(): SnifferState {
    return {
      busId: this.config.busId,
      running: this.running,
      startedAt: this.startedAt,
      telegramCount: this.telegramCount,
      deviceCount: this.store.getDevices(this.config.busId).length,
      error: this.error,
      transports: [...this.transportLabels],
      tapBytes: this.tapByteCount,
    }
  }

  /** Current data change counter (incremented per captured telegram). */
  getChangeCounter(): number {
    return this.changeCounter
  }

  /**
   * Registers a one-shot callback that fires on the next data change (new
   * telegram/device/register). Used by the SSE endpoint to fan out "something
   * changed, re-fetch" events to waiting clients. Returns an unsubscribe fn.
   */
  onChange(cb: () => void): () => void {
    this.changeWaiters.push(cb)
    return () => {
      const i = this.changeWaiters.indexOf(cb)
      if (i >= 0) this.changeWaiters.splice(i, 1)
    }
  }

  /** Notifies all one-shot waiters that captured data changed. */
  private notifyChange(): void {
    this.changeCounter++
    const waiters = this.changeWaiters
    this.changeWaiters = []
    waiters.forEach((cb) => {
      try {
        cb()
      } catch {
        /* subscriber errors must not break the capture loop */
      }
    })
  }

  async start(): Promise<void> {
    if (this.running) return
    this.error = undefined
    // Re-create the parser so a restart starts with a clean buffer.
    this.parser = new RtuFrameParser((telegram) => this.handleTelegram(telegram), this.config.frameTimeoutMs ?? 20)
    this.transports = []
    this.running = true
    this.startedAt = Date.now()

    const mode = this.config.mode ?? 'auto'
    // When the tap device IS the bus's own serial port we must NOT open a
    // second connection to it (that would fight the ModbusAPI for the port).
    // Instead we borrow the bus's already-open port via a passive listener and
    // forward every raw byte - this captures ALL traffic on the line, including
    // frames from a foreign master, with zero conflict. A tap on a DIFFERENT
    // device (Y-splitter / dedicated RS485 adapter) uses the classic SerialTap.
    const sameAsBus = this.config.tapDevice && this.config.busSerialport && this.config.tapDevice === this.config.busSerialport
    const useTap =
      (mode === 'tap' && this.config.tapDevice && this.config.tapDevice.length > 0) ||
      (mode === 'auto' && this.config.tapDevice && this.config.tapDevice.length > 0)

    // Always able to capture the active master traffic via the stack hook: this
    // guarantees telegrams whenever the bus does anything, even if the tap
    // device is missing or silent.
    const stack: SnifferTransport = {
      describe: () => `stack hook (bus ${this.config.busId})`,
      start: async () => {
        debug(`sniffer bus ${this.config.busId} stack hook armed`)
      },
      stop: async () => undefined,
      isRunning: () => this.running,
    }
    this.transports.push(stack)
    this.transportLabels = [stack.describe()]
    await stack.start(this.stackSink)

    // The passive capture path must NOT depend on the master being configured:
    // a master (or a foreign master on the same line) can be polled with zero
    // slaves configured. So besides the stack hook (which only sees the active
    // master's own traffic) we ALWAYS try to tap the bus line passively:
    //  1. bus-port tap: borrow the bus's already-open serial port (no extra fd,
    //     sees foreign master RX/TX). Works as soon as the ModbusAPI has the
    //     port open (e.g. a slave is configured) OR after the fallback below
    //     opened it.
    //  2. If the bus port is not open yet (no slaves -> no polling -> ModbusAPI
    //     never connected), open the bus serial device OURSELVES in read-only/
    //     non-exclusive mode (lock:false) so the sniffer hears everything even
    //     when the master has nothing to poll. This is safe: with no slave there
    //     is no ModbusAPI on that device, and with a slave the bus-port tap
    //     already works (fallback only runs when the bus-port tap didn't).
    // A tap on a DIFFERENT device (Y-splitter / dedicated RS485 adapter) always
    // uses the classic SerialTap.
    const differntTap = this.config.tapDevice && !sameAsBus && (mode === 'tap' || mode === 'auto')
    if (differntTap) {
      const tap = this.tapFactory(this.config.tapDevice!, this.config.baudRate ?? 9600)
      try {
        await tap.start(this.tapSink)
        this.transports.push(tap)
        this.transportLabels.push(tap.describe())
        log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} tap active: ${tap.describe()}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Keep the FIRST error; later failures are secondary fallbacks.
        if (!this.error) this.error = msg
        log.log(LogLevelEnum.error, `sniffer bus ${this.config.busId} tap failed, falling back to stack hook: ${msg}`)
        debug(`sniffer bus ${this.config.busId} tap failed: ${msg}`)
      }
    }

    // Always try the passive bus-line capture (bus-port tap first, then a
    // self-opened serial tap on the bus device as fallback).
    let busTapActive = false
    try {
      const tap = this.busPortTapFactory(this.config.busId)
      await tap.start(this.tapSink)
      // start() resolves even when there is nothing to tap yet (the bus has no
      // open serial port). Only treat it as active when it actually listens.
      if (tap.isRunning()) {
        this.transports.push(tap)
        this.transportLabels.push(tap.describe())
        busTapActive = true
        log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} bus-port tap active: ${tap.describe()}`)
      } else {
        log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} bus-port tap idle (no open port yet), using fallback`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!this.error) this.error = msg
      log.log(LogLevelEnum.error, `sniffer bus ${this.config.busId} bus-port tap failed: ${msg}`)
      debug(`sniffer bus ${this.config.busId} bus-port tap failed: ${msg}`)
    }
    // When the bus port is not open yet (no slaves -> ModbusAPI never opened
    // it), the bus-port tap above silently attached to nothing. Open the serial
    // device ourselves (non-exclusive) so a foreign master's frames are still
    // captured. The stack hook remains as a safety net for the active master.
    if (!busTapActive && this.config.busSerialport && this.config.busSerialport.length > 0) {
      const serialTap = this.tapFactory(this.config.busSerialport, this.config.baudRate ?? 9600)
      try {
        await serialTap.start(this.tapSink)
        this.transports.push(serialTap)
        this.transportLabels.push(serialTap.describe())
        log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} serial tap on bus device active: ${serialTap.describe()}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!this.error) this.error = msg
        log.log(LogLevelEnum.error, `sniffer bus ${this.config.busId} serial tap on bus device failed: ${msg}`)
        debug(`sniffer bus ${this.config.busId} serial tap on bus device failed: ${msg}`)
      }
    }

    this.running = true
    this.notifyChange()
    debug(`sniffer bus ${this.config.busId} started (${this.describe()})`)
    log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} started (${this.describe()})`)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    await Promise.all(
      this.transports.map((t) =>
        t.stop().catch((e) => debug('sniffer stop error: ' + (e instanceof Error ? e.message : String(e))))
      )
    )
    this.transports = []
    this.transportLabels = []
    if (this.parser) {
      this.parser.flush()
      this.parser = undefined
    }
    this.notifyChange()
  }

  private handleTelegram(telegram: ParsedTelegram): void {
    this.telegramCount++
    // Decorate the frame with its PDU shape.
    telegram.decoded = decodePdu(telegram)
    // Pair responses with their request BEFORE persisting: a read response has
    // no address of its own - the register list and the telegram table would
    // show an empty Addr column for every response. Copying the request's
    // address/length into the decoded response makes the telegram overview show
    // e.g. "0x03 400 len 1" and lets the register view split multi-register
    // reads into per-address rows.
    const paired = this.pairResponse(telegram)
    if (paired) {
      telegram.decoded = {
        ...telegram.decoded,
        address: paired.request.decoded?.address,
        length: paired.request.decoded?.length,
      }
    }
    this.store.appendTelegram(this.config.busId, telegram)
    this.store.upsertDevice(this.config.busId, telegram)
    this.updateRegisters(telegram)
    this.notifyChange()
  }

  /**
   * Looks up the outstanding request for a response (same slave + function AND
   * matching word count) in the parser's FIFO queue. Returns the request but
   * does NOT consume it here - updateRegisters consumes once the values were
   * split. This lets the telegram table AND the register split share the same
   * pairing.
   *
   * The word count is essential: a read response carries byteCount(1)+words and
   * therefore knows its own word count, while the request knows the register
   * count it asked for. Only a request with the SAME count can be the one this
   * response answers. Without that check a response was paired with an
   * unrelated pending request (e.g. an 8-word read(0,8) answer latched onto a
   * pending read(400,1)) which shifted the value start address and created
   * phantom registers 400..407.
   */
  private pairResponse(telegram: ParsedTelegram): { request: ParsedTelegram } | undefined {
    if (telegram.direction !== 'response') return undefined
    const words = telegram.decoded?.values
    const expected = words ? words.length : undefined
    const req = this.parser?.getLastRequest(telegram.slaveId, telegram.functionCode, expected)
    return req ? { request: req } : undefined
  }

  private updateRegisters(telegram: ParsedTelegram): void {
    // Read responses carry values at a known start address. The address is not
    // in the response itself - we must pair it with the request that started
    // the transaction. The parser keeps a queue of outstanding requests (a
    // fast master pipelines several reads), so we look the oldest one up for
    // this slave+function instead of the single most recent frame. The
    // response's word count must match the request's register count: otherwise
    // the answer belongs to a different (still pending) request and pairing it
    // would write the values to the wrong addresses.
    const words = telegram.decoded?.values
    const expected = words ? words.length : undefined
    const req = this.parser?.getLastRequest(telegram.slaveId, telegram.functionCode, expected)
    if (telegram.direction === 'response' && telegram.decoded?.values && req) {
      const base = req.decoded?.address
      if (base !== undefined) {
        const entries = valueAddresses(telegram, base, telegram.decoded.values)
        entries.forEach((e) => {
          this.store.upsertRegister(this.config.busId, req, e.address, 1, [e.value])
        })
        this.parser?.consumeRequest(req)
        return
      }
    }
    // A read request alone (e.g. scan probe with no responding slave, or a
    // master that polls while we only hear the request side) still reveals the
    // register range the master is interested in. Create the inventory entry
    // so the register table populates immediately; the value stays empty until
    // a matching response arrives.
    if (telegram.direction === 'request' && telegram.decoded?.address !== undefined && telegram.decoded?.length !== undefined) {
      const ranges = registerRanges(telegram)
      ranges?.forEach((r) => {
        for (let a = 0; a < r.quantity; a++) {
          this.store.upsertRegister(this.config.busId, telegram, r.address + a, 1, [])
        }
      })
    }
  }

  private trimTelegrams(): void {
    // The counter must reflect the REAL total telegram count, not a capped
    // value: the UI shows it as "N telegrams" and users expect the true
    // number of frames captured. History retention is bounded in the store
    // (if configured); the counter is not trimmed here anymore.
  }

  // ---- Query API for the HTTP routes ----
  getTelegrams(busId: number, slaveId?: number, limit?: number): SnifferTelegramRow[] {
    return this.store.getTelegrams(busId, slaveId, limit)
  }
  getDevices(busId: number): SnifferDeviceRow[] {
    return this.store.getDevices(busId)
  }
  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[] {
    const rows = this.store.getRegisters(busId, slaveId)
    // Build a condition-values map from ALL register rows of the bus (same
    // slave) so entities whose conditions reference other registers (e.g. a
    // device-type select at 400 gating a temperature at 0) can be evaluated.
    const values = snifferValuesFromRows(rows)
    // No block-merging: every register address is its own row (the user wants
    // a read of N registers to appear as N rows). Multi-word entities (32 bit
    // float etc.) are decoded in enrichRegister by collecting the words of
    // the whole entity from the values map.
    return rows.map((r) => this.enrichRegister(r, values))
  }

  /**
   * Groups consecutive rows of the same slave that belong to one entity (e.g. a
   * 32 bit float read as two holding registers) so the converter receives the
   * full word array. Rows are merged by (slaveId, matching entity range from a
   * template spec); without a spec each row stays as it is.
   */
  /** Re-interprets a single register row after an annotation changed it. */
  refreshRegisterValue(row: SnifferRegisterRow): SnifferRegisterRow {
    const values = snifferValuesFromRows(this.store.getRegisters(row.busId, row.slaveId))
    const enriched = this.enrichRegister(row, values)
    this.notifyChange()
    return enriched
  }

  /**
   * Resolves the specification entity that owns a register and decodes the raw
   * word(s) into the interpreted value + unit. The entity is picked by:
   *  - the slave's specification (resolving reference slaves to their root),
   *  - the matching register type for the function code (0x03 holding, 0x04
   *    analog input, 0x01 coils, 0x02 discrete inputs),
   *  - the register address range (entity.modbusAddress ..+ length).
   * Returns undefined when no template entity matches (the UI then shows the
   * raw words and offers the pencil to annotate manually).
   */
  private enrichRegister(row: SnifferRegisterRow, values: ImodbusValues = emptyValues): SnifferRegisterRow {
    // Manual annotation: the user typed a converter like "number * 0.1" into
    // the register's pencil dialog. It applies only when no template entity
    // owns the register (annotations never override a real template — the
    // template is the source of truth when it exists). Evaluate the expression
    // against the captured words and surface the result; an unparseable
    // description keeps the raw words as the displayed value.
    if (row.annotated && !row.specKey) {
      const manual = evaluateManualConverter(row.converter, row.words)
      if (manual !== undefined) return { ...row, value: String(manual), annotated: true }
      return { ...row, value: row.rawValue, annotated: true }
    }

    const slave = ConfigBus.getSlave(row.busId, row.slaveId)
    if (!slave) return row

    // Resolve reference slaves: the actual spec lives on the root slave.
    let specSlave = slave
    if (slave.referenceSlaveId !== undefined) {
      const root = ConfigBus.getSlave(row.busId, slave.referenceSlaveId)
      if (root) specSlave = root
    }
    if (!specSlave.specification) return row

    const spec = specSlave.specification
    const registerType = functionCodeToRegisterType(row.functionCode)
    const candidates = spec.entities.filter((e) => {
      if (e.modbusAddress === undefined) return false
      if (registerType !== undefined && e.registerType !== registerType) return false
      const len = entityLength(e)
      return row.address >= e.modbusAddress && row.address < e.modbusAddress + len
    })
    if (candidates.length === 0) return row
    // Prefer the entity that starts exactly at the register address. When
    // several entities share the same address (device-type variants gated by
    // conditions on OTHER registers, e.g. 400/501), evaluate their conditions
    // against the captured values and pick the first ACTIVE one. Entities
    // without conditions stay always-active candidates.
    let entity: Ientity | undefined
    const exact = candidates.filter((e) => e.modbusAddress === row.address)
    const pool = exact.length > 0 ? exact : candidates
    // Every candidate with conditions must match the captured values to be
    // active; entities without conditions are always active. This also covers
    // the single-candidate case (a lone conditional entity stays raw until its
    // gating register was captured).
    const active = pool.filter((e) => {
      const conds = entityConditions(e)
      if (conds.length === 0) return true
      return conds.every((c) => conditionMatches(c, readConditionValue(values, c)))
    })
    entity = active[0] ?? pool.find((e) => entityConditions(e).length === 0)
    if (!entity || entity.id === undefined) return row

    const converter = ConverterMap.getConverter(entity)
    if (!converter) return row
    try {
      // Rebuild the entity's full word list from the per-address values map:
      // a 32 bit float occupies 2 registers, decoded from the words of BOTH
      // addresses. Without this, splitting reads into per-address rows would
      // hand float converters only the first word.
      const map =
        registerType === ModbusRegisterType.Coils
          ? values.coils
          : registerType === ModbusRegisterType.DiscreteInputs
            ? values.discreteInputs
            : registerType === ModbusRegisterType.AnalogInputs
              ? values.analogInputs
              : values.holdingRegisters
      const len = entityLength(entity)
      const entityWords: number[] = []
      if (len > 1) {
        for (let a = 0; a < len; a++) {
          const cell = map.get(row.address + a)
          if (cell && cell.data) entityWords.push(...cell.data)
        }
      }
      const words = entityWords.length > 0 ? entityWords : row.words
      const decoded = converter.modbus2mqtt(spec, entity.id, words)
      const uom = entityUom(entity)
      return {
        ...row,
        value: String(decoded),
        converter: entity.converter ?? row.converter,
        uom: uom ?? row.uom,
        specKey: spec.filename ?? row.specKey,
        entityName: entity.name ?? entity.mqttname ?? entity.converter ?? 'unknown',
      }
    } catch (e) {
      debug('enrichRegister: decode failed for bus ' + row.busId + ' slave ' + row.slaveId + ' addr ' + row.address + ': ' + (e instanceof Error ? e.message : String(e)))
      return row
    }
  }
  createMapping(mapping: SnifferMappingCreate): Promise<SnifferRegisterRow> {
    void mapping
    return Promise.resolve({} as SnifferRegisterRow)
  }
}

/** Registry of per-bus sniffer services, keyed by bus id. */
export class ModbusSnifferRegistry {
  private services = new Map<number, SnifferService>()

  constructor(private store: SnifferStore) {}

  get(busId: number): SnifferService | undefined {
    return this.services.get(busId)
  }

  async start(busId: number): Promise<SnifferService> {
    const config = this.store.getConfig(busId)
    if (!config) throw new Error('No sniffer configuration for bus ' + busId)
    let service = this.services.get(busId)
    if (!service) {
      service = new SnifferService(config, this.store)
      this.services.set(busId, service)
    } else service.setConfig(config)
    await service.start()
    return service
  }

  async stop(busId: number): Promise<void> {
    const service = this.services.get(busId)
    if (service) await service.stop()
  }

  stopAll(): Promise<void[]> {
    return Promise.all(Array.from(this.services.values()).map((s) => s.stop()))
  }

  getServices(): SnifferService[] {
    return Array.from(this.services.values())
  }
}

/** Maps a Modbus function code to the ModbusRegisterType it reads/writes. */
function functionCodeToRegisterType(fc: number | undefined): ModbusRegisterType | undefined {
  switch (fc) {
    case 0x01: return ModbusRegisterType.Coils
    case 0x02: return ModbusRegisterType.DiscreteInputs
    case 0x03: return ModbusRegisterType.HoldingRegister
    case 0x04: return ModbusRegisterType.AnalogInputs
    case 0x05: return ModbusRegisterType.Coils
    case 0x06: return ModbusRegisterType.HoldingRegister
    case 0x0f: return ModbusRegisterType.Coils
    case 0x10: return ModbusRegisterType.HoldingRegister
    default: return undefined
  }
}

/** Number of registers an entity occupies on the bus. */
function entityLength(entity: Ientity): number {
  const converter = ConverterMap.getConverter(entity)
  if (converter) return Math.max(1, converter.getModbusLength(entity))
  return 1
}

/** Unit of measurement from the entity's converter parameters (Inumber.uom). */
function entityUom(entity: Ientity): string | undefined {
  const p = entity.converterParameters as { uom?: string } | undefined
  return p?.uom
}

/** A values map with no data - makes every condition evaluate to inactive. */
const emptyValues: ImodbusValues = {
  holdingRegisters: new Map(),
  coils: new Map(),
  discreteInputs: new Map(),
  analogInputs: new Map(),
}

/**
 * Builds an ImodbusValues map from captured sniffer rows (first word per
 * address, holding registers by default). Conditions on other registers are
 * then evaluated against what the sniffer actually saw on the wire.
 */
function snifferValuesFromRows(rows: SnifferRegisterRow[]): ImodbusValues {
  const holdingRegisters = new Map<number, { data: number[] }>()
  const coils = new Map<number, { data: number[] }>()
  const discreteInputs = new Map<number, { data: number[] }>()
  const analogInputs = new Map<number, { data: number[] }>()
  for (const r of rows) {
    if (r.words.length === 0) continue
    // Keep ALL words of the row (a row may carry several words when a single
    // frame was stored as one inventory entry). Word lists per address let
    // enrichRegister rebuild multi-word entities (32 bit float) from the
    // individual address rows without block-merging.
    const entry = { data: [...r.words] }
    switch (functionCodeToRegisterType(r.functionCode)) {
      case ModbusRegisterType.Coils: coils.set(r.address, entry); break
      case ModbusRegisterType.DiscreteInputs: discreteInputs.set(r.address, entry); break
      case ModbusRegisterType.AnalogInputs: analogInputs.set(r.address, entry); break
      default: holdingRegisters.set(r.address, entry); break
    }
  }
  return { holdingRegisters, coils, discreteInputs, analogInputs }
}
