import { Bonjour } from 'bonjour-service'
import dns from 'dns/promises'
import { Socket } from 'net'
import { Config } from './config.js'
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

  private async scan(): Promise<void> {
    if (!this.running) return

    const bonjour = new Bonjour()
    try {
      const b1 = bonjour.find({ type: 'modbus', protocol: 'tcp' })
      const b2 = bonjour.find({ type: 'modbus-tcp', protocol: 'tcp' })
      const seen = new Map<string, DiscoveredModbusServer>()

      const collect = (s: { name?: string; port?: number; addresses?: string[]; host?: string }) => {
        const port = s.port || 502
        const host = (s.addresses && s.addresses.length) ? s.addresses[0] : (s.host || 'localhost')
        seen.set(this.key(host, port), { name: s.name || 'modbus', host, port })
      }
      b1.on('up', collect)
      b2.on('up', collect)

      // collect for a short window, then merge into the known set.
      // mDNS announcements are intermittent, so keep servers from earlier
      // scans even if a single scan misses them (only a blacklist or a full
      // process restart removes them).
      await new Promise<void>((r) => setTimeout(r, 4000))
      const merged = new Map<string, DiscoveredModbusServer>()
      this.discovered.forEach((s) => merged.set(this.key(s.host, s.port), s))
      seen.forEach((v, k) => merged.set(k, v))

      // Resiliency fallback: also probe well-known Modbus TCP endpoints by
      // Docker-DNS name (mbusd:502 / modbus:502). This works even when mDNS
      // announcements are not heard (e.g. peer on a non-default interface).
      const endpointServers = await this.probeKnownEndpoints()
      endpointServers.forEach((srv) => merged.set(this.key(srv.host, srv.port), srv))

      this.discovered = Array.from(merged.values())
      const live = this.getDiscoveredServers().length
      if (this.discovered.length) {
        log.log(LogLevelEnum.info, `Modbus auto-discovery: found ${this.discovered.length} server(s), ${live} usable`)
      } else {
        log.log(LogLevelEnum.info, 'Modbus auto-discovery: no server found (mDNS + endpoint probe)')
      }
    } catch (e) {
      log.log(LogLevelEnum.error, 'Modbus mDNS browse error: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      try { bonjour.destroy() } catch { /* ignore */ }
    }

    if (!this.running) return
    this.probeTimer = setTimeout(() => this.scan(), 20000)
  }

  /** Well-known Docker-DNS Modbus TCP endpoints to probe as a fallback. */
  private knownEndpoints(): { host: string; port: number }[] {
    return [
      { host: 'mbusd', port: 502 },
      { host: 'modbus', port: 502 },
    ]
  }

  /** Opens a TCP socket to host:port and returns true if the connection succeeds. */
  private async tcpProbe(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const sock = new Socket()
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        try { sock.destroy() } catch { /* ignore */ }
        resolve(ok)
      }
      sock.setTimeout(timeoutMs)
      sock.once('connect', () => finish(true))
      sock.once('timeout', () => finish(false))
      sock.once('error', () => finish(false))
      try { sock.connect(port, host) } catch { finish(false) }
    })
  }

  /** Resolves well-known endpoint hostnames via Docker DNS and probes port 502. */
  private async probeKnownEndpoints(): Promise<DiscoveredModbusServer[]> {
    const found: DiscoveredModbusServer[] = []
    for (const ep of this.knownEndpoints()) {
      try {
        const addrs = await dns.lookup(ep.host, { all: true })
        for (const a of addrs) {
          if (await this.tcpProbe(a.address, ep.port)) {
            // Probe the resolved IP (robust); also keep the name for display.
            found.push({ name: ep.host, host: a.address, port: ep.port })
            log.log(LogLevelEnum.info, `Modbus auto-discovery: endpoint ${ep.host}:${ep.port} -> ${a.address}:${ep.port} reachable`)
          }
        }
      } catch { /* hostname not resolvable (not on this Docker network) - fine */ }
    }
    return found
  }
}
