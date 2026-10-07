import Debug from 'debug'
import { SnifferByteSink } from './transport.js'

const debug = Debug('modbus2mqtt:sniffer:hook')

/**
 * Stack-hook transport (ModbusAPI integration).
 *
 * Instead of wrapping the low-level modbus-serial client (whose methods don't
 * carry a slave id), the ModbusAPI itself calls `emitRequest`/`emitResponse`
 * at the points where slaveId, functionCode, address, length and returned data
 * are all known. This transport implements the SnifferTransport interface so
 * the service can treat "stack hook" and "serial tap" uniformly.
 */
export class StackHookTransport {
  private sink: SnifferByteSink | undefined
  private running = false

  constructor(
    private callbacks: {
      emitRequest: (functionCode: number, address: number, length: number) => void
      emitResponse: (functionCode: number, data: number[]) => void
    }
  ) {}

  describe(): string {
    return 'stack hook'
  }

  isRunning(): boolean {
    return this.running
  }

  start(sink: SnifferByteSink): void {
    this.sink = sink
    this.running = true
    debug('StackHookTransport installed')
  }

  stop(): void {
    this.sink = undefined
    this.running = false
    debug('StackHookTransport removed')
  }
}
