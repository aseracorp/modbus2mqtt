import Debug from 'debug'
import { RtuFrameParser } from './parser.js'
import { decodePdu, valueAddresses } from './decode.js'
import { SnifferStore } from './store.js'
import { SnifferTransport } from './transport.js'
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

export const DEFAULT_MAX_TELEGRAMS = 1000

/**
 * Orchestrates the RTU sniffer for one bus: owns the transport(s), feeds the
 * parser, decorates decoded frames, maintains the device/register inventory in
 * the store and exposes the state/query API used by the HTTP routes.
 *
 * The service is transport-agnostic: the transport delivers raw bytes and the
 * service turns them into telegrams. This keeps the parser pure and lets the
 * tests feed synthetic byte streams directly.
 */
export class SnifferService implements SnifferTransport {
  private parser: RtuFrameParser | undefined
  private transport: SnifferTransport | undefined
  private sinkImpl: import('./transport.js').SnifferByteSink
  private running = false
  private telegramCount = 0
  private startedAt: number | undefined
  private error: string | undefined

  constructor(
    private config: SnifferBusConfig,
    private store: SnifferStore
  ) {
    this.sinkImpl = {
      onBytes: (direction, bytes) => {
        void direction
        if (!this.parser) return
        this.parser.feed(bytes, Date.now())
      },
    }
  }

  describe(): string {
    return this.transport ? this.transport.describe() : `${this.config.mode}@bus${this.config.busId}`
  }

  /** True while actively capturing. */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Entry point for the ModbusAPI stack hook: the API calls this with the
   * observed request/response bytes. Also used by tests to inject a stream.
   */
  feed(direction: 'request' | 'response', bytes: number[]): void {
    void direction
    if (!this.parser) return
    // The stack hook delivers complete frames as distinct units - parse them
    // immediately (the byte-level silence detection is only needed for the tap).
    this.parser.feed(bytes, Date.now())
    this.parser.flush()
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
    const transport = this.buildTransport()
    this.transport = transport
    this.running = true
    this.startedAt = Date.now()
    try {
      await transport.start(this.sinkImpl)
      debug(`sniffer bus ${this.config.busId} started (${transport.describe()})`)
    } catch (e) {
      this.running = false
      this.transport = undefined
      this.error = e instanceof Error ? e.message : String(e)
      debug(`sniffer bus ${this.config.busId} failed to start: ${this.error}`)
      throw e
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    if (this.transport) {
      try {
        await this.transport.stop()
      } catch (e) {
        debug('sniffer stop error: ' + (e instanceof Error ? e.message : String(e)))
      }
      this.transport = undefined
    }
    if (this.parser) {
      this.parser.flush()
      this.parser = undefined
    }
  }

  private buildTransport(): SnifferTransport {
    // auto: tapDevice when set, otherwise the stack hook (default).
    const useTap =
      this.config.mode === 'tap' || (this.config.mode === 'auto' && this.config.tapDevice && this.config.tapDevice.length > 0)
    if (useTap) {
      return new SerialTapTransport(this.config.tapDevice!, this.config.baudRate ?? 9600)
    }
    // Stack hook: implemented as a lightweight transport marker. The actual
    // bytes are delivered by the ModbusAPI via feed() (see Bus wiring in M5).
    return {
      describe: () => `stack hook (bus ${this.config.busId})`,
      start: async () => {},
      stop: async () => {},
      isRunning: () => this.running,
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
