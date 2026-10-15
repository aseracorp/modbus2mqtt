/** A stream of raw bytes observed on a Modbus RTU bus. */
export interface SnifferByteSink {
  /** Deliver captured bytes. `direction` tells request vs response (best effort). */
  onBytes(direction: 'request' | 'response', bytes: number[]): void
  /** Runtime transport error (e.g. tap device dropped). Optional. */
  onTapError?(message: string): void
}

/**
 * A tap on the already-open serial port of the active bus. Unlike
 * {@link SerialTapTransport} it does NOT open its own serial device - it
 * borrows the bus's open port via {@link Bus.attachSerialTap} and forwards
 * every raw byte (RX via the port's 'data' event, TX by wrapping 'write').
 * Because a Node stream fans out to all listeners, the ModbusAPI keeps its
 * bytes intact while the sniffer observes them - 100% passive, no port
 * conflict. This is how a sniffer on the SAME device as the bus can still see
 * frames sent by a foreign master.
 */
export class BusPortTapTransport implements SnifferTransport {
  private detach: (() => void) | undefined
  private started = false
  constructor(private bus: import('../bus.js').Bus) {}

  describe(): string {
    // NOTE: not prefixed with 'stack hook' on purpose - the service uses this
    // to treat the bus-port tap as an ACTIVE tap, which suppresses the
    // stack-hook feed (no duplicated telegrams).
    return 'bus port (' + this.bus.getName() + ')'
  }

  async start(sink: SnifferByteSink): Promise<void> {
    if (this.started) return
    const result = this.bus.attachSerialTap((direction, bytes) => {
      // frame bytes may arrive in multiple chunks - the sink routes them into
      // the parser which reassembles frames by silence.
      sink.onBytes(direction, bytes)
    })
    if (!result.active) {
      // No open serial port on the bus yet (no slaves -> no polling -> the
      // ModbusAPI never connected). Do NOT mark started: the caller falls back
      // to opening the bus device itself so foreign master traffic is still
      // captured.
      return
    }
    this.detach = result.detach
    this.started = true
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.detach?.()
    this.detach = undefined
    this.started = false
  }

  isRunning(): boolean {
    return this.started
  }
}

/**
 * Transport abstraction for the RTU sniffer. Implementations differ in how they
 * obtain the byte stream (passive serial tap vs hook into the active stack) but
 * all feed an identical {@link SnifferByteSink}.
 */
export interface SnifferTransport {
  /** Human readable description for the UI (e.g. "/dev/ttyUSB1 (tap)"). */
  describe(): string
  /** Start capturing. Must be idempotent. */
  start(sink: SnifferByteSink): Promise<void>
  /** Stop capturing and release resources. Must be idempotent. */
  stop(): Promise<void>
  /** True while the transport is actively capturing. */
  isRunning(): boolean
}
