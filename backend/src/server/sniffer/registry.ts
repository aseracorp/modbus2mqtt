import Debug from 'debug'
import { join } from 'path'
import { ConfigPersistence } from '../persistence/configPersistence.js'
import { SqliteSnifferStore, SnifferStore } from './store.js'
import { SnifferService } from './snifferService.js'
import { SnifferBusConfig, SnifferRegisterAnnotation, SnifferRegisterRow, SnifferResetResult, SnifferState } from './types.js'
import { Bus } from '../bus.js'

const debug = Debug('modbus2mqtt:sniffer:registry')

/**
 * Application-wide registry of per-bus sniffer services. Owns the SQLite store
 * (dataDir/sqlite/modbus-sniffer.db), wires each bus's ModbusAPI to its
 * sniffer service (stack hook) and manages the start/stop lifecycle.
 *
 * The registry is a singleton, created once at startup (modbus2mqtt.ts), and
 * referenced by the HTTP routes and the bus lifecycle.
 */
export class ModbusSnifferRegistry {
  private static instance: ModbusSnifferRegistry | undefined
  private services = new Map<number, SnifferService>()
  private store: SnifferStore

  private constructor(store: SnifferStore) {
    this.store = store
    this.store.init()
  }

  static getInstance(): ModbusSnifferRegistry {
    if (!ModbusSnifferRegistry.instance) {
      const dbPath = join(ConfigPersistence.dataDir || '.', 'sqlite', 'modbus-sniffer.db')
      ModbusSnifferRegistry.instance = new ModbusSnifferRegistry(new SqliteSnifferStore(dbPath))
    }
    return ModbusSnifferRegistry.instance
  }

  /** Test hook: replace the singleton with a fresh registry over a custom store. */
  static resetForTests(store?: SnifferStore): ModbusSnifferRegistry {
    ModbusSnifferRegistry.instance = new ModbusSnifferRegistry(store ?? new SqliteSnifferStore(':memory:'))
    return ModbusSnifferRegistry.instance
  }

  getStore(): SnifferStore {
    return this.store
  }

  getService(busId: number): SnifferService | undefined {
    return this.services.get(busId)
  }

  /** The RTU serial device the given bus is configured with (if any). */
  private busSerialport(busId: number): string | undefined {
    const bus = Bus.getBus(busId)
    if (!bus) return undefined
    const rtu = bus.properties.connectionData as { serialport?: string }
    return rtu?.serialport
  }

  /** Enriches a config with the current bus serial device before use. */
  private enrichConfig(config: SnifferBusConfig): SnifferBusConfig {
    const serialport = this.busSerialport(config.busId)
    return { ...config, busSerialport: serialport ?? config.busSerialport }
  }

  getConfig(busId: number): SnifferBusConfig | undefined {
    return this.store.getConfig(busId)
  }

  saveConfig(config: SnifferBusConfig): void {
    this.store.upsertConfig(this.enrichConfig(config))
    debug('saved sniffer config for bus ' + config.busId + ' mode=' + config.mode)
  }

  deleteConfig(busId: number): void {
    this.stop(busId)
    this.services.delete(busId)
    this.store.deleteBus(busId)
    debug('deleted sniffer data for bus ' + busId)
  }

  /**
   * Ensures a service exists for the bus and returns its sink for wiring into
   * the Bus/ModbusAPI. Called from Bus construction when a config exists.
   */
  serviceForBus(busId: number, config: SnifferBusConfig): SnifferService {
    const enriched = this.enrichConfig(config)
    let svc = this.services.get(busId)
    if (!svc) {
      svc = new SnifferService(enriched, this.store)
      this.services.set(busId, svc)
    } else svc.setConfig(enriched)
    return svc
  }

  async start(busId: number): Promise<void> {
    const config = this.store.getConfig(busId)
    if (!config) throw new Error('No sniffer configuration for bus ' + busId)
    const svc = this.serviceForBus(busId, config)
    await svc.start()
    this.wireStackHook(busId, svc)
  }

  async stop(busId: number): Promise<void> {
    const svc = this.services.get(busId)
    if (svc) {
      await svc.stop()
      this.unwireStackHook(busId)
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.services.keys()).map((busId) => this.stop(busId)))
  }

  /**
   * Boot-time wiring: attaches every existing bus's ModbusAPI sink to its
   * sniffer service (stack hook) so traffic is captured the moment the sniffer
   * starts, without requiring a manual start after boot. Called once after
   * Bus.readBussesFromConfig().
   */
  wireAllStackHooks(): void {
    for (const busId of Array.from(this.services.keys())) {
      this.wireStackHook(busId, this.services.get(busId)!)
    }
  }

  /**
   * Boot-time auto start: starts sniffer services for buses whose stored config
   * has enabled:true. Idempotent — safe to call on every boot.
   */
  async autoStartEnabled(): Promise<void> {
    const configs = this.store.getConfigs()
    for (const config of configs) {
      if (config.enabled) {
        try {
          await this.start(config.busId)
        } catch (e) {
          debug('autoStartEnabled: bus ' + config.busId + ' failed to start: ' + (e instanceof Error ? e.message : String(e)))
        }
      }
    }
    // Also wire hooks for services that are not enabled yet (so a start via
    // the webui works instantly).
    this.wireAllStackHooks()
  }

  /** Convenience: is any sniffer currently running on the given bus? */
  isRunning(busId: number): boolean {
    return this.services.get(busId)?.isRunning() ?? false
  }

  getState(busId: number): SnifferState | undefined {
    const svc = this.services.get(busId)
    if (!svc) return undefined
    return svc.getState()
  }

  getTelegrams(busId: number, slaveId?: number, limit?: number) {
    return this.store.getTelegrams(busId, slaveId, limit)
  }
  getDevices(busId: number) {
    return this.store.getDevices(busId)
  }
  getRegisters(busId: number, slaveId?: number) {
    // Prefer a service instance (it enriches rows with the template
    // interpretation value/uom/converter). Create one on demand from the
    // stored config so registers are interpreted even when the sniffer is not
    // currently running; enrichRegister tolerates missing specs gracefully.
    const svc = this.services.get(busId)
    if (svc) return svc.getRegisters(busId, slaveId)
    const config = this.store.getConfig(busId)
    if (config) {
      const created = this.serviceForBus(busId, config)
      return created.getRegisters(busId, slaveId)
    }
    return this.store.getRegisters(busId, slaveId)
  }

  /** Persists a manual converter/uom annotation for one register row. */
  annotateRegister(annotation: SnifferRegisterAnnotation): SnifferRegisterRow | undefined {
    const row = this.store.annotateRegister(annotation)
    if (row) this.services.get(annotation.busId)?.refreshRegisterValue(row)
    return row
  }

  /**
   * Clears the sniffer database by renaming the sqlite file with a timestamp
   * suffix and creating a fresh one in its place. Stops all running sniffers
   * first so no service keeps writing into the renamed file.
   */
  async resetDatabase(busId?: number): Promise<SnifferResetResult> {
    // Stop whatever is running (per bus, or all) so no writer keeps the file open.
    if (busId !== undefined) {
      await this.stop(busId)
      this.services.delete(busId)
    } else {
      await this.stopAll()
      this.services.clear()
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const renamed = this.store.resetDatabase(ts)
    debug('resetDatabase: renamed db to ' + renamed)
    return { busId: busId ?? 0, renamedTo: renamed ?? '', recreated: renamed !== undefined }
  }

  /**
   * Wires the bus's ModbusAPI to the sniffer service. The Bus is looked up via
   * the static Bus.getBus() - the wiring is a live adapter from the API's sink
   * to the service's feed().
   */
  private wireStackHook(busId: number, svc: SnifferService): void {
    const bus = Bus.getBus(busId)
    if (!bus) {
      debug('wireStackHook: bus ' + busId + ' not found')
      return
    }
    // Use the service's own stack sink so the parser is fed exactly once and
    // runtime tap errors surface through the same object.
    bus.setSnifferSink(svc.getStackSink())
  }

  private unwireStackHook(busId: number): void {
    const bus = Bus.getBus(busId)
    if (bus) bus.setSnifferSink(undefined)
  }
}
