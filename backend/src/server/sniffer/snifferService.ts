import Debug from 'debug'
import { Logger, LogLevelEnum } from '../../specification/index.js'
import { RtuFrameParser } from './parser.js'
import { decodePdu, valueAddresses } from './decode.js'
import { SnifferStore } from './store.js'
import { SnifferTransport, SnifferByteSink } from './transport.js'
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

const debug = Debug('modbus2mqtt:sniffer:service')
const log = new Logger('sniffer:service')

export const DEFAULT_MAX_TELEGRAMS = 1000

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

const defaultTapFactory: TapTransportFactory = (device, baudRate) => new SerialTapTransport(device, baudRate)

export class SnifferService implements SnifferTransport {
  private parser: RtuFrameParser | undefined
  private transports: SnifferTransport[] = []
  private stackSink: SnifferByteSink
  private running = false
  private telegramCount = 0
  private startedAt: number | undefined
  private error: string | undefined

  constructor(
    private config: SnifferBusConfig,
    private store: SnifferStore,
    private tapFactory: TapTransportFactory = defaultTapFactory
  ) {
    this.stackSink = {
      onBytes: (direction, bytes) => {
        if (!this.parser) return
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
  }

  describe(): string {
    return this.transports.map((t) => t.describe()).join(' + ') || `${this.config.mode}@bus${this.config.busId}`
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
    }
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
    const useTap = mode === 'tap' || (mode === 'auto' && this.config.tapDevice && this.config.tapDevice.length > 0)

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
    await stack.start(this.stackSink)

    if (useTap) {
      const tap = this.tapFactory(this.config.tapDevice!, this.config.baudRate ?? 9600)
      try {
        await tap.start(this.stackSink)
        this.transports.push(tap)
        log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} tap active: ${tap.describe()}`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.error = msg
        // Fall back to the stack hook only — we are still running and will
        // capture the master traffic via the hook.
        log.log(LogLevelEnum.error, `sniffer bus ${this.config.busId} tap failed, falling back to stack hook: ${msg}`)
        debug(`sniffer bus ${this.config.busId} tap failed: ${msg}`)
      }
    }

    this.running = true
    debug(`sniffer bus ${this.config.busId} started (${this.describe()})`)
    log.log(LogLevelEnum.info, `sniffer bus ${this.config.busId} started (${this.describe()})`)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    await Promise.all(
      this.transports.map((t) => t.stop().catch((e) => debug('sniffer stop error: ' + (e instanceof Error ? e.message : String(e)))))
    )
    this.transports = []
    if (this.parser) {
      this.parser.flush()
      this.parser = undefined
    }
  }

  private handleTelegram(telegram: ParsedTelegram): void {
    this.telegramCount++
    // Decorate the frame with its PDU shape.
    telegram.decoded = decodePdu(telegram)
    this.store.appendTelegram(this.config.busId, telegram)
    this.store.upsertDevice(this.config.busId, telegram)
    this.updateRegisters(telegram)
    this.trimTelegrams()
  }

  private updateRegisters(telegram: ParsedTelegram): void {
    // Read responses carry values at a known start address. The address is not
    // in the response itself - we must pair it with the preceding request.
    // The parser tracks the pending request, so we can look it up here.
    if (telegram.direction !== 'response' || !telegram.decoded?.values) return
    const req = this.parser?.getLastRequest()
    if (!req || req.slaveId !== telegram.slaveId) return
    const base = req.decoded?.address
    if (base === undefined) return
    const entries = valueAddresses(telegram, base, telegram.decoded.values)
    entries.forEach((e) => {
      this.store.upsertRegister(this.config.busId, req, e.address, 1, [e.value])
    })
  }

  private trimTelegrams(): void {
    const max = this.config.maxTelegrams ?? DEFAULT_MAX_TELEGRAMS
    if (this.telegramCount > max) {
      // Cheap in-memory trim; the store keeps a bounded history per bus.
      this.telegramCount = max
    }
  }

  // ---- Query API for the HTTP routes ----
  getTelegrams(busId: number, slaveId?: number, limit?: number): SnifferTelegramRow[] {
    return this.store.getTelegrams(busId, slaveId, limit)
  }
  getDevices(busId: number): SnifferDeviceRow[] {
    return this.store.getDevices(busId)
  }
  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[] {
    return this.store.getRegisters(busId, slaveId)
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
