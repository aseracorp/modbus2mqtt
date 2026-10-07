// Backend-internal sniffer types. The API-facing row types are shared with the
// frontend via @shared/server (see shared/server/sniffer.ts). TelegramDirection
// is defined here as a VALUE enum (the shared variant is a string union type).
export type {
  SnifferBusConfig,
  SnifferState,
  SnifferTelegramRow,
  SnifferDeviceRow,
  SnifferRegisterRow,
} from '../../shared/server/index.js'
import type {
  SnifferState,
  SnifferTelegramRow,
  SnifferDeviceRow,
  SnifferRegisterRow,
  TelegramDirection as SharedDirection,
} from '../../shared/server/index.js'

/** Direction of a captured telegram relative to the sniffing point. */
export enum TelegramDirection {
  /** From the master (usually the modbus2mqtt stack) to the slave device. */
  request = 'request',
  /** From a slave device back to the master. */
  response = 'response',
}

/** Parsed Modbus RTU telegram (raw wire bytes + decoded PDU). */
export interface ParsedTelegram {
  direction: SharedDirection
  /** Seconds since the unix epoch with millisecond precision (Date.now()/1000). */
  timestamp: number
  slaveId: number
  functionCode: number
  /** Payload after address+function code, before CRC (may be empty). */
  payload: number[]
  /** Raw frame bytes including the CRC. */
  raw: number[]
  crcOk: boolean
  /** Set when the frame was decoded into a known PDU shape. */
  decoded?: TelegramDecoded
}

export interface TelegramDecoded {
  functionName?: string
  address?: number
  length?: number
  byteCount?: number
  values?: number[]
  exceptionCode?: number
}

export interface RegisterRange {
  address: number
  quantity: number
}

export interface SnifferMappingCreate {
  busId: number
  slaveId: number
  address: number
  specModule?: string
  entityId?: number
}

export interface SnifferApi {
  getState(busId: number): SnifferState | undefined
  getTelegrams(busId: number, slaveId?: number, limit?: number): SnifferTelegramRow[]
  getDevices(busId: number): SnifferDeviceRow[]
  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[]
  start(busId: number): Promise<void>
  stop(busId: number): Promise<void>
  createMapping(mapping: SnifferMappingCreate): Promise<SnifferRegisterRow>
}
