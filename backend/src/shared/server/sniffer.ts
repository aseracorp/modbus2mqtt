/**
 * Shared API types for the RTU sniffer. These travel between backend and
 * frontend via the REST API (@shared/server is mapped into the Angular app).
 */

export type TelegramDirection = 'request' | 'response'

export interface SnifferBusConfig {
  /** Unique bus id (matches the IBus busId). */
  busId: number
  /** Human readable bus name (serial port or host:port). */
  busName?: string
  /** Passively sniff an additional serial port (Y-splitter / dedicated tap). */
  tapDevice?: string
  /**
   * Transport selection:
   *  - 'stack'  hook into the ModbusAPI read/write calls (default, no extra hw)
   *  - 'tap'    passive read from tapDevice
   *  - 'auto'   tapDevice when set, else stack hook
   */
  mode: 'stack' | 'tap' | 'auto'
  /** Frame silence timeout in ms used to separate frames (default 20). */
  frameTimeoutMs?: number
  /** Baud rate for the passive tap port (default 9600). */
  baudRate?: number
  /** Limit the retained telegram history per bus (default 1000). */
  maxTelegrams?: number
  enabled: boolean
}

export interface SnifferState {
  busId: number
  running: boolean
  startedAt?: number
  telegramCount: number
  deviceCount: number
  error?: string
}

export interface SnifferTelegramRow {
  id: number
  busId: number
  direction: TelegramDirection
  timestamp: number
  slaveId: number
  functionCode: number
  rawHex: string
  crcOk: boolean
  functionName?: string
  address?: number
  length?: number
  values?: number[]
  exceptionCode?: number
}

export interface SnifferDeviceRow {
  busId: number
  slaveId: number
  firstSeen: number
  lastSeen: number
  requestCount: number
  responseCount: number
  errorCount: number
  lastFunction?: string
  mappingId?: number
}

export interface SnifferRegisterRow {
  id: number
  busId: number
  slaveId: number
  address: number
  quantity: number
  words: number[]
  value?: string
  converter?: string
  uom?: string
  lastSeen: number
  specKey?: string
}
