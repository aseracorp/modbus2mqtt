import Debug from 'debug'
import { join } from 'path'
import { ConfigPersistence } from '../persistence/configPersistence.js'
import { SqliteSnifferStore, SnifferStore } from './store.js'
import { SnifferService } from './snifferService.js'
import { SnifferBusConfig, SnifferState } from './types.js'
import { Bus } from '../bus.js'
import type { SnifferByteSink } from './transport.js'

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

  getConfig(busId: number): SnifferBusConfig | undefined {
    return this.store.getConfig(busId)
  }

  saveConfig(config: SnifferBusConfig): void {
    this.store.upsertConfig(config)
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
    let svc = this.services.get(busId)
    if (!svc) {
      svc = new SnifferService(config, this.store)
      this.services.set(busId, svc)
    } else svc.setConfig(config)
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
    return this.store.getRegisters(busId, slaveId)
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
    const sink: SnifferByteSink = {
      onBytes: (direction, bytes) => svc.feed(direction, bytes),
    }
    bus.setSnifferSink(sink)
  }

  private unwireStackHook(busId: number): void {
    const bus = Bus.getBus(busId)
    if (bus) bus.setSnifferSink(undefined)
  }
}
