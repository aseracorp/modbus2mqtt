import Debug from 'debug'
import { SerialPort } from 'serialport'
import { SnifferTransport } from './transport.js'
import { SnifferByteSink } from './transport.js'

const debug = Debug('modbus2mqtt:sniffer:tap')

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

  async start(sink: SnifferByteSink): Promise<void> {
    if (this.running) return
    if (!this.device) throw new Error('SerialTapTransport: no tap device configured')
    this.sink = sink
    return new Promise<void>((resolve, reject) => {
      try {
        this.port = new SerialPort({
          path: this.device,
          baudRate: this.baudRate,
          dataBits: this.dataBits,
          parity: this.parity,
          stopBits: this.stopBits,
          // Never lock the port exclusively: the active ModbusAPI may have the
          // same physical device open (Y-splitter / second adapter on the bus).
          lock: false,
        })
        this.port.on('data', (data: Buffer) => {
          if (!this.sink) return
          const bytes = Array.from(data)
          // Split at the transport boundary is handled by the parser's silence
          // detection; just forward the raw bytes. The parser reclassifies
          // responses via the pending-request match.
          this.sink.onBytes('request', bytes)
        })
        this.port.on('error', (e: Error) => {
          debug('tap error: ' + e.message)
        })
        this.running = true
        debug('SerialTapTransport started on ' + this.device)
        resolve()
      } catch (e) {
        this.running = false
        reject(e)
      }
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
