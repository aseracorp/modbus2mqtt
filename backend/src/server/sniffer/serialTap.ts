import Debug from 'debug'
import { SerialPort } from 'serialport'
import { Logger, LogLevelEnum } from '../../specification/index.js'
import { SnifferTransport } from './transport.js'
import { SnifferByteSink } from './transport.js'

const debug = Debug('modbus2mqtt:sniffer:tap')
const log = new Logger('sniffer:tap')

/**
 * Passive serial tap transport. Opens a SECOND serial port (e.g. a dedicated
 * USB-RS485 adapter wired in parallel to the bus or to a Y-splitter) in
 * read-only mode and forwards every byte to the sink. It never writes to the
 * bus, so it is safe to run alongside the active ModbusAPI connection.
 */
export class SerialTapTransport implements SnifferTransport {
  private port: SerialPort | undefined
  private sink: SnifferByteSink | undefined
  private running = false
  private lastError: string | undefined

  constructor(
    private device: string,
    private baudRate: number = 9600,
    private dataBits: 5 | 6 | 7 | 8 = 8,
    private parity: 'none' | 'even' | 'odd' = 'none',
    private stopBits: 1 | 1.5 | 2 = 1
  ) {}

  describe(): string {
    return `${this.device} (tap @ ${this.baudRate} ${this.dataBits}${this.parity[0].toUpperCase()}${this.stopBits})`
  }

  getError(): string | undefined {
    return this.lastError
  }

  async start(sink: SnifferByteSink): Promise<void> {
    if (this.running) return
    if (!this.device) throw new Error('SerialTapTransport: no tap device configured')
    this.sink = sink
    this.lastError = undefined
    return new Promise<void>((resolve, reject) => {
      let port: SerialPort
      try {
        port = new SerialPort({
          path: this.device,
          baudRate: this.baudRate,
          dataBits: this.dataBits,
          parity: this.parity,
          stopBits: this.stopBits,
          // Never lock the port exclusively: the active ModbusAPI may have the
          // same physical device open (Y-splitter / second adapter on the bus).
          lock: false,
        })
      } catch (e) {
        // Synchronous construction failure (bad path, invalid options...).
        this.running = false
        this.lastError = e instanceof Error ? e.message : String(e)
        log.log(LogLevelEnum.error, 'tap open failed (sync): ' + this.lastError)
        reject(new Error(this.lastError))
        return
      }
      // serialport opens asynchronously. Detect both the success and the
      // failure path so a missing/unsafe device surfaces immediately instead
      // of silently idling with running=true and zero telegrams.
      port.on('open', () => {
        this.running = true
        this.port = port
        debug('SerialTapTransport started on ' + this.device)
        log.log(LogLevelEnum.info, 'tap opened ' + this.device)
        resolve()
      })
      port.on('error', (e: Error) => {
        const msg = e instanceof Error ? e.message : String(e)
        this.lastError = msg
        log.log(LogLevelEnum.error, 'tap error on ' + this.device + ': ' + msg)
        // If the port never opened we must reject so the caller can fall back
        // to the stack hook instead of silently staying "running".
        if (!this.running) {
          this.running = false
          try {
            port.close()
          } catch {
            /* ignore */
          }
          reject(new Error('tap failed to open ' + this.device + ': ' + msg))
        } else if (this.sink) {
          // Runtime error after a successful open: keep running but surface it.
          this.sink.onTapError?.(msg)
        }
      })
      port.on('data', (data: Buffer) => {
        if (!this.sink) return
        const bytes = Array.from(data)
        // Split at the transport boundary is handled by the parser's silence
        // detection; just forward the raw bytes. The parser reclassifies
        // responses via the pending-request match.
        this.sink.onBytes('request', bytes)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.sink = undefined
    return new Promise<void>((resolve) => {
      if (this.port) {
        try {
          this.port.close(() => resolve())
        } catch {
          resolve()
        }
        this.port = undefined
      } else resolve()
    })
  }

  isRunning(): boolean {
    return this.running
  }
}