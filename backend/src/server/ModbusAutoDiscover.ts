import { Bonjour } from 'bonjour-service'
import ModbusRTU from 'modbus-serial'
import { ConfigBus } from './configbus.js'
import { LogLevelEnum, Logger } from '../specification/index.js'

const log = new Logger('ModbusAutoDiscover')

/**
 * Auto-discovers Modbus TCP servers while none is configured.
 *
 * Many Modbus TCP products announce themselves over mDNS/DNS-SD as
 * "_modbus._tcp.local" (some use "_modbus-tcp"). This looks for such
 * advertisements, verifies each candidate is actually reachable as a
 * Modbus TCP endpoint, and adds the first working one as a bus.
 *
 * Runs on a timer while the config holds no Modbus TCP bus and stops as
 * soon as one exists (added by discovery or manually via the webui/API).
 */
interface ModbusClientLike {
  connectTCP(host: string, opts: { port: number }): Promise<void>
  close(cb?: () => void): void
}

export class ModbusAutoDiscover {
  private static instance: ModbusAutoDiscover | undefined = undefined
  private probeTimer: ReturnType<typeof setTimeout> | undefined
  private running = false
  // injectable for tests
  private clientFactory: () => ModbusClientLike

  constructor(clientFactory?: () => ModbusClientLike) {
    this.clientFactory = clientFactory || (() => new ModbusRTU())
  }

  static getInstance(clientFactory?: () => ModbusClientLike): ModbusAutoDiscover {
    if (!ModbusAutoDiscover.instance) ModbusAutoDiscover.instance = new ModbusAutoDiscover(clientFactory)
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
    this.probe()
  }

  stop(): void {
    this.running = false
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = undefined
    }
  }

  private hasTcpBus(): boolean {
    return ConfigBus.getBussesProperties().some((b) => {
      const c = b.connectionData as { host?: string; serialport?: string }
      return !!c.host
    })
  }

  private async probe(): Promise<void> {
    if (!this.running) return
    if (this.hasTcpBus()) {
      this.stop()
      return
    }

    const discovered = await this.browseMdns()
    if (discovered) return

    if (!this.running) return
    this.probeTimer = setTimeout(() => this.probe(), 20000)
  }

  private async browseMdns(): Promise<boolean> {
    const bonjour = new Bonjour()
    const services: { name: string; port: number; addresses: string[] }[] = []

    const collect = (s: { name?: string; port?: number; addresses?: string[]; host?: string }) => {
      const port = s.port || 502
      const addr = (s.addresses && s.addresses.length) ? s.addresses[0] : (s.host || 'localhost')
      services.push({ name: s.name || 'modbus', port, addresses: [addr] })
    }

    return await new Promise<boolean>((resolvePromise) => {
      let settled = false
      const settle = (ok: boolean) => {
        if (settled) return
        settled = true
        try { bonjour.destroy() } catch { /* ignore */ }
        resolvePromise(ok)
      }

      try {
        // Modbus TCP servers commonly announce as _modbus._tcp or _modbus-tcp
        const b1 = bonjour.find({ type: 'modbus', protocol: 'tcp' })
        const b2 = bonjour.find({ type: 'modbus-tcp', protocol: 'tcp' })
        b1.on('up', collect)
        b2.on('up', collect)

        setTimeout(async () => {
          const seen = new Set<string>()
          for (const s of services) {
            const host = s.addresses[0] || 'localhost'
            const key = `${host}:${s.port}`
            if (seen.has(key)) continue
            seen.add(key)
            if (!this.running) { settle(false); return }
            if (await this.tryAddBus(host, s.port, s.name)) { settle(true); return }
          }
          settle(false)
        }, 4000)
      } catch (e) {
        log.log(LogLevelEnum.error, 'Modbus mDNS browse error: ' + (e instanceof Error ? e.message : String(e)))
        settle(false)
      }
    })
  }

  /** Opens a TCP socket to the candidate and, if reachable, adds it as a Modbus TCP bus. */
  private async tryAddBus(host: string, port: number, name: string): Promise<boolean> {
    return await this.tryAddBusWithClient(this.clientFactory(), host, port, name)
  }

  /** Testable: uses an injected client instead of constructing a ModbusRTU. */
  private async tryAddBusWithClient(client: ModbusClientLike, host: string, port: number, name: string): Promise<boolean> {
    try {
      // connectTCP may hang on an unreachable host, so race it against a timeout.
      await Promise.race([
        client.connectTCP(host, { port }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('connect timeout')), 3000)),
      ])
      const timeout = 1000
      ConfigBus.addBusProperties({ host, port, timeout } as never)
      log.log(LogLevelEnum.info, `Modbus auto-discovery: added TCP bus ${host}:${port} (${name || 'modbus'})`)
      return true
    } catch (e) {
      log.log(LogLevelEnum.info, `Modbus auto-discovery: ${host}:${port} not reachable (${(e as Error).message})`)
      return false
    } finally {
      try { client.close(() => { /* ignore */ }) } catch { /* ignore */ }
    }
  }
}
