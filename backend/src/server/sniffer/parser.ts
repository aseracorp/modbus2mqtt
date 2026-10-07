import { ParsedTelegram, TelegramDirection } from './types.js'
import { decodePdu } from './decode.js'

/**
 * Pure Modbus RTU frame parser. No I/O, no dependencies on the rest of the
 * server: it turns a raw byte stream into telegrams. The stream is fed via
 * {@link RtuFrameParser.feed}; completed frames are delivered to the listener.
 *
 * Frame rules implemented:
 *  - RTU framing: address(1) function(1) payload(n>=0) crc16(2), separated by
 *    a silence of at least 3.5 char times (approximated by frameTimeoutMs).
 *  - Broadcast (slave id 0) requests have no response; the parser still emits
 *    the request frame.
 *  - Response frames are matched to the most recent pending request to derive
 *    the slave id when the response starts with a different byte (rare, but the
 *    direction is the primary discriminator anyway).
 *  - A CRC error marks the frame as crcOk=false so the UI can show it; the
 *    payload is still exposed for debugging.
 */
export class RtuFrameParser {
  private buffer: number[] = []
  private lastByteTime: number = 0
  private pendingRequest: ParsedTelegram | undefined

  constructor(
    private listener: (telegram: ParsedTelegram) => void,
    /** Silence (ms) that separates two frames. Default 20ms (>3.5 chars @9600 8N1). */
    private frameTimeoutMs: number = 20
  ) {}

  /**
   * Feeds the raw byte stream. Byte values are 0..255. `now` is in ms since
   * the epoch and used for the silence detection; it is injected so the parser
   * stays pure and testable.
   */
  feed(data: number[] | Uint8Array, now: number): void {
    // Timeout first: an empty feed (or a feed after a long silence) must flush
    // the buffered frame even when no new byte arrives.
    this.tick(now)
    for (const byte of data) {
      const b = byte & 0xff
      this.buffer.push(b)
      this.lastByteTime = now
      // A request frame is at most 256 bytes (address+fc+255 payload+crc).
      if (this.buffer.length >= 256) this.emitFrame()
    }
  }

  /** Flushes the buffer when the silence since the last byte exceeded the timeout. */
  tick(now: number): void {
    if (this.buffer.length > 0 && now - this.lastByteTime > this.frameTimeoutMs) this.emitFrame()
  }

  /** Flushes a partially filled buffer as a frame (call on stream end / stop). */
  flush(now?: number): void {
    if (now !== undefined) this.tick(now)
    if (this.buffer.length === 0) return
    this.emitFrame()
  }

  private emitFrame(): void {
    if (this.buffer.length < 4) {
      // Too short to be a valid frame (addr+fc+crc) — drop the garbage.
      this.buffer = []
      return
    }
    const bytes = this.buffer
    this.buffer = []

    const slaveId = bytes[0]
    const functionCode = bytes[1]
    const hasCrc = bytes.length >= 4
    const crcOk = hasCrc && this.crc16(bytes.slice(0, bytes.length - 2)) === ((bytes[bytes.length - 1] << 8) | bytes[bytes.length - 2])

    const payload = bytes.slice(2, bytes.length - 2)
    const telegram: ParsedTelegram = {
      direction: this.classifyDirection(slaveId, functionCode),
      timestamp: Date.now() / 1000,
      slaveId,
      functionCode,
      payload,
      raw: bytes,
      crcOk,
    }
    telegram.decoded = decodePdu(telegram)
    // Keep the pending request until the NEXT request arrives: the response
    // listener needs it to map response values back to register addresses.
    if (telegram.direction === TelegramDirection.request) this.pendingRequest = telegram

    this.listener(telegram)
  }

  /**
   * Request frames are sent by the master; response frames by the slave.
   * The parser knows nothing about the transport, so it uses the function
   * code shape: requests carry 0x00-0x7f and responses either 0x80|fc
   * (exceptions) or mirror the request's fc. Since every transaction's
   * response follows its request, we classify by tracking the last request.
   */
  private classifyDirection(slaveId: number, functionCode: number): TelegramDirection {
    // 1) Exception responses carry the exception flag in the function code.
    if ((functionCode & 0x80) !== 0) return TelegramDirection.response
    // 2) A frame whose fc matches the pending request (masked) and whose slave
    //    id equals the request's target is the response to that request.
    if (
      this.pendingRequest &&
      this.pendingRequest.slaveId === slaveId &&
      this.pendingRequest.functionCode === (functionCode & 0x7f)
    ) {
      return TelegramDirection.response
    }
    // 3) Broadcast requests are never answered.
    if (slaveId === 0) return TelegramDirection.request
    // 4) With no pending request, a frame in a known request shape is a request
    //    (the master speaks first on a bus). Known request function codes:
    //    read coils/discrete/holding/input (1-4), write single coil/register
    //    (5,6), write multiple coils/registers (15,16).
    if (!this.pendingRequest) {
      return [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0f, 0x10].includes(functionCode)
        ? TelegramDirection.request
        : TelegramDirection.response
    }
    // 5) Fallback: unmatched frames after a request are most likely responses.
    return TelegramDirection.response
  }

  /** Modbus CRC-16 (poly 0xA001, init 0xFFFF), LSB-first. */
  crc16(data: number[]): number {
    let crc = 0xffff
    for (const byte of data) {
      crc ^= byte
      for (let i = 0; i < 8; i++) {
        if (crc & 1) crc = (crc >> 1) ^ 0xa001
        else crc >>= 1
      }
    }
    return crc & 0xffff
  }

  /** Exposed for tests/diagnostics: the CRC of a byte array without payload knowledge. */
  static crc16(bytes: number[]): number {
    return new RtuFrameParser(() => {}).crc16(bytes)
  }

  reset(): void {
    this.buffer = []
    this.pendingRequest = undefined
  }

  /** The most recent request frame (used to pair response values with addresses). */
  getLastRequest(): ParsedTelegram | undefined {
    return this.pendingRequest
  }
}