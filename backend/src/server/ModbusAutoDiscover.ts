import { Bonjour } from 'bonjour-service'
import { Config } from './config.js'
import * as os from 'os'
import { LogLevelEnum, Logger } from '../specification/index.js'

const log = new Logger('ModbusAutoDiscover')

export interface DiscoveredModbusServer {
  name: string
  host: string
  port: number
}

/**
 * Discovers Modbus TCP servers over mDNS/DNS-SD ("_modbus._tcp.local" /
 * "_modbus-tcp"). Unlike the previous auto-add behaviour it does NOT create
 * connections on its own — it only keeps a fresh list of advertised servers,
 * excludes blacklisted ones and exposes them through the API so the webui can
 * offer "Add server" / "Ignore" actions.
 */
export class ModbusAutoDiscover {
  private static instance: ModbusAutoDiscover | undefined = undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private discovered: DiscoveredModbusServer[] = []

  static getInstance(): ModbusAutoDiscover {
    if (!ModbusAutoDiscover.instance) ModbusAutoDiscover.instance = new ModbusAutoDiscover()
    return ModbusAutoDiscover.instance
  }

  static resetInstance(): void {
    if (ModbusAutoDiscover.instance) {
      ModbusAutoDiscover.instance.stop()
      ModbusAutoDiscover.instance = undefined
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scan()
  }

  stop(): void {
    this.running = false
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = undefined
    }
  }

  /** Servers currently advertised on the LAN that are not blacklisted. */
  getDiscoveredServers(): DiscoveredModbusServer[] {
    const blacklist = this.getBlacklist()
    return this.discovered.filter((s) => !blacklist.includes(this.key(s.host, s.port)))
  }

  blacklistServer(host: string, port: number): void {
    try {
      const cfg = Config.getConfiguration()
      const blacklist = cfg.modbusAutoDiscoverBlacklist || (cfg.modbusAutoDiscoverBlacklist = [])
      const key = this.key(host, port)
      if (!blacklist.includes(key)) blacklist.push(key)
      cfg.modbusAutoDiscoverBlacklist = blacklist
      new Config().writeConfiguration(cfg)
      log.log(LogLevelEnum.info, `Modbus auto-discovery: blacklisted ${host}:${port}`)
    } catch (e) {
      log.log(LogLevelEnum.error, 'Modbus auto-discovery: blacklist persist failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  private getBlacklist(): string[] {
    try {
      return Config.getConfiguration().modbusAutoDiscoverBlacklist || []
    } catch {
      return []
    }
  }

  private key(host: string, port: number): string {
    return host + ':' + port
  }

  /** One browser socket per private IPv4 interface (loopback + each non-internal IPv4). */
  private allMdnsInterfaces(): string[] {
    const rc: string[] = ['127.0.0.1']
    const nets = os.networkInterfaces()
    for (const addrs of Object.values(nets)) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && a.internal === false) rc.push(a.address)
      }
    }
    return rc
  }

  private async scan(): Promise<void> {
    if (!this.running) return

    // multicast-dns (used by bonjour-service) only sends/joins multicast on ONE
    // interface (opts.interface or the OS default). In a multi-homed Docker
    // container (e.g. compose net + a shared modbus net) the peer's mDNS query
    // would only go out one NIC. Fix: run one browser per non-internal IPv4
    // interface and merge the results.
    const seen = new Map<string, DiscoveredModbusServer>()
    const bonjours: { find(...o: unknown[]): unknown; destroy(): void }[] = []
    try {
      const interfaces = this.allMdnsInterfaces()
      for (const iface of interfaces) {
        try {
          const bonjour = new Bonjour({ interface: iface } as unknown as Record<string, unknown>)
          bonjours.push(bonjour)
          for (const type of ['modbus', 'modbus-tcp']) {
            const browser = bonjour.find({ type, protocol: 'tcp' })
            browser.on('up', (svc: { name?: string; port?: number; addresses?: string[]; host?: string }) => {
              const port = svc.port || 502
              const host = (svc.addresses && svc.addresses.length) ? svc.addresses[0] : (svc.host || 'localhost')
              seen.set(this.key(host, port), { name: svc.name || 'modbus', host, port })
            })
          }
        } catch { /* single-interface failure is not fatal */ }
      }
      if (!bonjours.length) bonjours.push(new Bonjour())

      // collect for a short window, then merge into the known set.
      // mDNS announcements are intermittent, so keep servers from earlier
      // scans even if a single scan misses them (only a blacklist or a full
      // process restart removes them).
      await new Promise<void>((r) => setTimeout(r, 4000))
      bonjours.forEach((b) => { try { b.destroy() } catch { /* ignore */ } })
      const merged = new Map<string, DiscoveredModbusServer>()
      this.discovered.forEach((s) => merged.set(this.key(s.host, s.port), s))
      seen.forEach((v, k) => merged.set(k, v))
      this.discovered = Array.from(merged.values())
      const live = this.getDiscoveredServers().length
      if (this.discovered.length) {
        log.log(LogLevelEnum.info, `Modbus auto-discovery: found ${this.discovered.length} server(s), ${live} usable`)
      }
    } catch (e) {
      log.log(LogLevelEnum.error, 'Modbus mDNS browse error: ' + (e instanceof Error ? e.message : String(e)))
      bonjours.forEach((b) => { try { b.destroy() } catch { /* ignore */ } })
    }

    if (!this.running) return
    this.probeTimer = setTimeout(() => this.scan(), 20000)
  }
}
