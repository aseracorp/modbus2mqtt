/** A stream of raw bytes observed on a Modbus RTU bus. */
export interface SnifferByteSink {
  /** Deliver captured bytes. `direction` tells request vs response (best effort). */
  onBytes(direction: 'request' | 'response', bytes: number[]): void
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
