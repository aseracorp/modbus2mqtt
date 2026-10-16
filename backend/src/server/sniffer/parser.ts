import Debug from 'debug'
import { ParsedTelegram, TelegramDirection } from './types.js'
import { decodePdu } from './decode.js'

const debug = Debug('modbus2mqtt:sniffer:parser')

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
 *  - A frame is ALSO emitted as soon as it is structurally complete in the
 *    buffer (leading addr/fc with a CRC that matches over the frame prefix).
 *    This handles the RS485 half-duplex TX echo: the transceiver loops the
 *    master's own transmission back into RX, so request+echo (or
 *    request+response) can arrive in ONE data chunk without an inter-frame
 *    silence. Buffering them together would merge two valid frames into one
 *    byte string that fails the CRC check and both frames get lost.
 *  - Response frames are matched to the most recent pending request to derive
 *    the slave id when the response starts with a different byte (rare, but the
 *    direction is the primary discriminator anyway).
 *  - A CRC error marks the frame as crcOk=false so the UI can show it; the
 *    payload is still exposed for debugging.
 */
/**
 * True when the payload of `fc` matches the fixed request shape.
 * Read requests (1-4): addr(2)+qty(2). Single writes (5,6): addr(2)+value(2).
 * Multi writes (15,16): addr(2)+qty(2)+byteCount(1)+data.
 */
function requestShapeFor(fc: number, payload: number[]): boolean {
  switch (fc) {
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x04:
      return payload.length === 4
    case 0x05:
    case 0x06:
      return payload.length === 4
    case 0x0f:
    case 0x10: {
      if (payload.length < 5) return false
      const byteCount = payload[4]
      return payload.length === 5 + byteCount
    }
    default:
      return false
  }
}

/** Function codes whose RESPONSE never repeats the request shape (addr+qty). */
const READ_FCS = new Set([0x01, 0x02, 0x03, 0x04])

export class RtuFrameParser {
  private buffer: number[] = []
  private lastByteTime: number = 0
  private pendingRequest: ParsedTelegram | undefined
  /** Requests awaiting a matching response, oldest first. A fast master can
   *  emit several requests before any response arrives (e.g. sequential reads
   *  of different register blocks); response values must be paired back to the
   *  request they belong to, not to the most recent one. */
  private pendingRequests: ParsedTelegram[] = []

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
    }
    // Structural frame completion: as soon as the buffer holds one or more
    // complete frames from the start, emit them immediately. This is what
    // separates a request from its TX echo delivered in the same chunk.
    this.emitCompleteFrames()
    // Cap the buffer so a flood of broken bytes cannot grow it forever.
    if (this.buffer.length >= 512) this.buffer = []
  }

  /** Emits every complete frame at the head of the buffer. */
  private emitCompleteFrames(): void {
    // Loop: after emitting one frame, the remainder of the buffer may itself
    // hold another complete frame (request + echo / request + response).
    while (true) {
      const len = this.frameLengthAt(this.buffer)
      if (len === 0) break
      const frameBytes = this.buffer.splice(0, len)
      this.lastByteTime = 0 // structural completion replaces silence detection
      this.emitFrameBytes(frameBytes)
      if (this.buffer.length === 0) break
    }
  }

  /**
   * Returns the length of the complete Modbus RTU frame at the head of `buf`,
   * or 0 when the head is not (yet) a complete frame. Only a leading address
   * byte plus a function code whose payload length is deterministic (request
   * shape, or a known read/write/exception response) can be validated.
   */
  private frameLengthAt(buf: number[]): number {
    if (buf.length < 4) return 0
    const fc = buf[1]
    // A function code can appear in request AND response shape, and the shapes
    // have different lengths. Read requests (1-4) carry addr(2)+qty(2)=4, while
    // their responses carry byteCount(1)+data. Only the CRC validates a guess,
    // so try every plausible length and accept the one whose CRC matches -
    // picking a single hardcoded length made responses unrecognizable (the
    // 4-byte request guess never matched a 1+byteCount response frame, so the
    // frame stayed in the buffer until it was dropped and almost the whole
    // capture was lost).
    for (const payloadLen of this.candidatePayloadLengths(fc, buf)) {
      if (payloadLen < 0) continue
      const total = 2 + payloadLen + 2 // addr + fc + payload + crc
      if (buf.length < total) continue
      const crcOk = this.crc16(buf.slice(0, total - 2)) === ((buf[total - 1] << 8) | buf[total - 2])
      if (crcOk) return total
    }
    return 0
  }

  /**
   * Plausible payload lengths for a frame starting at buf[0..] with function
   * code `fc`. The caller probes each candidate and accepts the one whose CRC
   * matches. A function code has a request shape and (for reads) a different
   * response shape; both are returned so the CRC can discriminate them.
   * Returns [] when the length is not determinable (silence-based framing).
   */
  private candidatePayloadLengths(fc: number, buf: number[]): number[] {
    // Exception responses: [exceptionCode]. Deterministic length 1.
    if ((fc & 0x80) !== 0) return [1]
    // Read requests (1-4): addr(2)+qty(2) = 4 payload bytes.
    // Read responses (1-4): byteCount(1)+data(byteCount) - length is read from
    // the frame, so request and response are distinguished by the CRC probe.
    if (READ_FCS.has(fc)) {
      const cands: number[] = []
      if (buf.length >= 6) cands.push(4) // request (or a write-shaped echo)
      if (buf.length >= 3) {
        const byteCount = buf[2]
        if (byteCount >= 1 && byteCount <= 250) cands.push(1 + byteCount)
      }
      return cands
    }
    // Single writes (5,6): addr(2)+value(2).
    if (fc === 0x05 || fc === 0x06) return buf.length >= 6 ? [4] : []
    // Multi writes (15,16): addr(2)+qty(2)+byteCount(1)+data.
    if (fc === 0x0f || fc === 0x10) {
      if (buf.length < 7) return []
      return [5 + buf[6]]
    }
    // Other function codes (e.g. 0x08 diagnostics, 0x2b MEI) have
    // non-deterministic lengths: fall back to silence-based framing.
    return []
  }

  /** Flushes the buffer when the silence since the last byte exceeded the timeout. */
  tick(now: number): void {
    if (this.buffer.length > 0 && now - this.lastByteTime > this.frameTimeoutMs) {
      const bytes = this.buffer
      this.buffer = []
      this.emitFrameBytes(bytes)
    }
  }

  /** Flushes a partially filled buffer as a frame (call on stream end / stop). */
  flush(now?: number): void {
    if (now !== undefined) this.tick(now)
    if (this.buffer.length === 0) return
    const bytes = this.buffer
    this.buffer = []
    this.emitFrameBytes(bytes)
  }

  private emitFrameBytes(bytes: number[]): void {
    if (bytes.length < 4) {
      // Too short to be a valid frame (addr+fc+crc) — drop the garbage.
      return
    }
    const slaveId = bytes[0]
    const functionCode = bytes[1]
    // All captured frames carry a CRC: the serial tap sees the full wire
    // frame, and the stack hook (ModbusAPI) appends the CRC when it emits.
    // So the payload is everything between addr+fc and the trailing CRC pair.
    const payload = bytes.slice(2, bytes.length - 2)
    const crcOk = this.crc16(bytes.slice(0, bytes.length - 2)) === ((bytes[bytes.length - 1] << 8) | bytes[bytes.length - 2])
    // Frames without a valid CRC are noise (partial frames, line noise, or
    // bytes captured at the wrong baud) and must not pollute the telegram
    // stream: they carry no decodable address/values and would otherwise
    // drown out real frames. The serial tap sees full wire frames; the stack
    // hook (ModbusAPI) appends the CRC when it emits, so everything that
    // reaches the parser is CRC-checkable.
    if (!crcOk) {
      debug('dropping frame with invalid CRC: ' + bytes.map((b) => b.toString(16).padStart(2, '0')).join(''))
      return
    }
    const telegram: ParsedTelegram = {
      direction: this.classifyDirection(slaveId, functionCode, payload),
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
    if (telegram.direction === TelegramDirection.request) {
      this.pendingRequest = telegram
      // Multiple in-flight requests (fast polling of several blocks) must all
      // stay available for response pairing; cap the queue so a master that
      // never gets answers cannot grow it forever.
      this.pendingRequests.push(telegram)
      if (this.pendingRequests.length > 32) this.pendingRequests.shift()
    }

    this.listener(telegram)
  }

  /**
   * Request frames are sent by the master; response frames by the slave.
   * The parser knows nothing about the transport, so it uses the function
   * code shape: requests carry 0x00-0x7f and responses either 0x80|fc
   * (exceptions) or mirror the request's fc. Since every transaction's
   * response follows its request, we classify by tracking the last request.
   */
  private classifyDirection(slaveId: number, functionCode: number, payload: number[]): TelegramDirection {
    // Exception responses carry the exception flag in the function code.
    if ((functionCode & 0x80) !== 0) return TelegramDirection.response
    if (payload.length > 0 && requestShapeFor(functionCode, payload)) {
      // A known request-shaped frame is a request UNLESS it is a genuine
      // response. Read responses (fc 01-04) NEVER repeat the request shape
      // (byteCount+words, not addr+qty) - so a byte-identical frame to the
      // pending request can only be a master TIMEOUT RETRY, never a response.
      if (READ_FCS.has(functionCode)) return TelegramDirection.request
      // Single/multi-write responses (05,06,0f,10) DO echo the request
      // (addr + value/qty) and are indistinguishable by shape alone. We
      // conservatively treat byte-identical frames (incl. CRC) as a retry.
      if (
        this.pendingRequest &&
        this.pendingRequest.slaveId === slaveId &&
        this.pendingRequest.functionCode === functionCode &&
        this.payloadEqualsPending(payload)
      ) {
        return TelegramDirection.request
      }
      return TelegramDirection.request
    }
    // Broadcast requests are never answered.
    if (slaveId === 0) return TelegramDirection.request
    // With no pending request, a known request function code (but weird
    // payload) is still more likely a request than a response.
    if (!this.pendingRequest && [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x0f, 0x10].includes(functionCode))
      return TelegramDirection.request
    // Fallback: unmatched frames after a request are most likely responses.
    return TelegramDirection.response
  }

  /** True when the current payload is byte-identical to the pending request's payload. */
  private payloadEqualsPending(payload: number[]): boolean {
    if (!this.pendingRequest) return false
    const p = this.pendingRequest.payload
    if (p.length !== payload.length) return false
    for (let i = 0; i < p.length; i++) if (p[i] !== payload[i]) return false
    return true
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
  getLastRequest(slaveId?: number, functionCode?: number, expectedWordCount?: number): ParsedTelegram | undefined {
    // Prefer the OLDEST outstanding request matching slave+fc: a response
    // answers exactly the request that started the transaction, and when the
    // master pipelines several reads the pending list holds them in order.
    if (slaveId !== undefined) {
      const match = this.pendingRequests.find(
        (r) =>
          r.slaveId === slaveId &&
          (functionCode === undefined || r.functionCode === functionCode) &&
          (expectedWordCount === undefined || r.decoded?.length === expectedWordCount)
      )
      if (match) return match
      // A response whose word count matches NO outstanding request must never be
      // paired with an unrelated (shorter/longer) request: that shifted the value
      // start address and produced phantom registers - e.g. an 8-word answer to
      // read(0,8) latched onto a still-pending read(400,1) and was written to
      // 400..407. Leave it unpaired (raw) instead of guessing.
      if (expectedWordCount !== undefined) return undefined
      // Nothing outstanding for this slave+fc: fall back (broadcast probe /
      // scan without a request we ever saw) to the generic-most recent.
    }
    return this.pendingRequest
  }

  /** Removes the given request from the outstanding-pairing queue. */
  consumeRequest(req: ParsedTelegram | undefined): void {
    if (!req) return
    const idx = this.pendingRequests.indexOf(req)
    if (idx >= 0) this.pendingRequests.splice(idx, 1)
  }
}
