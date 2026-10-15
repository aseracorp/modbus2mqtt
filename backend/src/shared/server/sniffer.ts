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
  /** The serial device the active bus uses (set by the Bus/registry wiring). */
  busSerialport?: string
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
  /** Active capture transports, for diagnosing why a sniffer hears (or does
   *  not hear) bus traffic - e.g. "stack hook (bus 0)" vs "bus-port tap". */
  transports?: string[]
  /** Total raw bytes seen by the passive tap since start (0 = tap sees
   *  nothing on the line, even though the sniffer may be running). */
  tapBytes?: number
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
  /** Modbus function code the registers were read/written with (0x03/0x04/...). */
  functionCode?: number
  words: number[]
  /** Raw register word(s) as captured (joined for display). */
  rawValue?: string
  /** Interpreted value (via the entity template, or the manual annotation). */
  value?: string
  converter?: string
  uom?: string
  /** True when the row is annotated manually (template takes precedence otherwise). */
  annotated?: boolean
  /** The specification entity whose converter decoded the value. */
  entityName?: string
  lastSeen: number
  specKey?: string
}

export interface SnifferRegisterAnnotation {
  busId: number
  slaveId: number
  address: number
  /** Optional human-readable converter/description for the manual annotation. */
  converter?: string
  /** Unit of measurement for the manual annotation. */
  uom?: string
}

export type SnifferResetResult = {
  busId: number
  /** Absolute path of the renamed (old) database file. */
  renamedTo: string
  /** Whether a new empty database was created in its place. */
  recreated: boolean
}
