import Debug from 'debug'
import * as fs from 'fs'
import { createRequire } from 'node:module'
import * as path from 'path'

import {
  ParsedTelegram,
  SnifferBusConfig,
  SnifferDeviceRow,
  SnifferRegisterRow,
  SnifferTelegramRow,
  TelegramDirection,
} from './types.js'

const debug = Debug('modbus2mqtt:sniffer:store')
const SQLITE_CORE = 'better-sqlite3'

// The backend runs as ESM ("type": "module"), where `require` is not defined.
// keep the native binding out of the eager module graph so the rest of the
// code stays testable without better-sqlite3 installed.
const esmRequire = createRequire(import.meta.url)

/**
 * Minimal persistence interface so the service can be unit-tested without a
 * real database. The production implementation is SqliteSnifferStore below.
 */
export interface SnifferStore {
  init(): void
  close(): void
  upsertConfig(config: SnifferBusConfig): void
  getConfig(busId: number): SnifferBusConfig | undefined
  getConfigs(): SnifferBusConfig[]
  appendTelegram(busId: number, telegram: ParsedTelegram): void
  getTelegrams(busId: number, slaveId?: number, limit?: number): SnifferTelegramRow[]
  upsertDevice(busId: number, telegram: ParsedTelegram): void
  getDevices(busId: number): SnifferDeviceRow[]
  upsertRegister(busId: number, telegram: ParsedTelegram, address: number, quantity: number, words: number[]): void
  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[]
  deleteBus(busId: number): void
}

/**
 * In-memory SnifferStore for tests and for buses that run without a database.
 * Keeps the same interface; data is lost on restart (acceptable for sniffing).
 */
export class InMemorySnifferStore implements SnifferStore {
  private configs = new Map<number, SnifferBusConfig>()
  private telegrams: SnifferTelegramRow[] = []
  private devices = new Map<string, SnifferDeviceRow>()
  private registers = new Map<string, SnifferRegisterRow>()
  private nextTelegramId = 1

  init(): void {}
  close(): void {}
  upsertConfig(config: SnifferBusConfig): void {
    this.configs.set(config.busId, config)
  }
  getConfig(busId: number): SnifferBusConfig | undefined {
    return this.configs.get(busId)
  }
  getConfigs(): SnifferBusConfig[] {
    return Array.from(this.configs.values())
  }
  appendTelegram(busId: number, telegram: ParsedTelegram): void {
    this.telegrams.push({
      id: this.nextTelegramId++,
      busId,
      timestamp: telegram.timestamp,
      direction: telegram.direction,
      slaveId: telegram.slaveId,
      functionCode: telegram.functionCode,
      crcOk: telegram.crcOk,
      exceptionCode: telegram.exceptionCode,
      decoded: telegram.decoded,
      rawLength: telegram.rawLength,
    })
  }
  getTelegrams(busId: number, slaveId?: number, limit?: number): SnifferTelegramRow[] {
    const list = this.telegrams
      .filter((t) => t.busId === busId && (slaveId === undefined || t.slaveId === slaveId))
      .sort((a, b) => b.id - a.id)
    return limit !== undefined ? list.slice(0, limit) : list
  }
  upsertDevice(busId: number, telegram: ParsedTelegram): void {
    const key = `${busId}:${telegram.slaveId}`
    const existing = this.devices.get(key)
    this.devices.set(key, {
      busId,
      slaveId: telegram.slaveId,
      firstSeen: existing?.firstSeen ?? telegram.timestamp,
      lastSeen: telegram.timestamp,
      requestCount: (existing?.requestCount ?? 0) + (telegram.direction === 'request' ? 1 : 0),
      responseCount: (existing?.responseCount ?? 0) + (telegram.direction === 'response' ? 1 : 0),
      exceptionCount: (existing?.exceptionCount ?? 0) + (telegram.exceptionCode !== undefined ? 1 : 0),
    })
  }
  getDevices(busId: number): SnifferDeviceRow[] {
    return Array.from(this.devices.values())
      .filter((d) => d.busId === busId)
      .sort((a, b) => a.slaveId - b.slaveId)
  }
  upsertRegister(busId: number, telegram: ParsedTelegram, address: number, quantity: number, words: number[]): void {
    const key = `${busId}:${telegram.slaveId}:${address}`
    const existing = this.registers.get(key)
    this.registers.set(key, {
      busId,
      slaveId: telegram.slaveId,
      address,
      quantity,
      words,
      value: existing?.value,
      converter: existing?.converter,
      uom: existing?.uom,
      lastSeen: telegram.timestamp,
      specKey: existing?.specKey,
    })
  }
  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[] {
    return Array.from(this.registers.values())
      .filter((r) => r.busId === busId && (slaveId === undefined || r.slaveId === slaveId))
      .sort((a, b) => a.slaveId - b.slaveId || a.address - b.address)
  }
  deleteBus(busId: number): void {
    this.configs.delete(busId)
    this.telegrams = this.telegrams.filter((t) => t.busId !== busId)
    Array.from(this.devices.keys())
      .filter((k) => k.startsWith(busId + ':'))
      .forEach((k) => this.devices.delete(k))
    Array.from(this.registers.keys())
      .filter((k) => k.startsWith(busId + ':'))
      .forEach((k) => this.registers.delete(k))
  }
}

/**
 * SQLite persistence for the sniffer via better-sqlite3. The module is a
 * production dependency of the backend (injected at runtime); loading it here
 * keeps the rest of the code testable without the native binding.
 */
export class SqliteSnifferStore implements SnifferStore {
  private db: import('better-sqlite3').Database | undefined

  constructor(private dbPath: string) {}

  init(): void {
    if (this.db) return
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    const Database = esmRequire(SQLITE_CORE) as typeof import('better-sqlite3')
    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.migrate()
    debug('sqlite store ready at ' + this.dbPath)
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = undefined
    }
  }

  private migrate(): void {
    if (!this.db) return
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sniffer_config (
        bus_id INTEGER PRIMARY KEY,
        config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sniffer_telegram (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bus_id INTEGER NOT NULL,
        ts TEXT NOT NULL,
        direction TEXT NOT NULL,
        slave_id INTEGER NOT NULL,
        function_code INTEGER NOT NULL,
        crc_ok INTEGER NOT NULL,
        exception_code INTEGER,
        decoded TEXT,
        raw_length INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sniffer_device (
        bus_id INTEGER NOT NULL,
        slave_id INTEGER NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        response_count INTEGER NOT NULL DEFAULT 0,
        exception_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bus_id, slave_id)
      );
      CREATE TABLE IF NOT EXISTS sniffer_register (
        bus_id INTEGER NOT NULL,
        slave_id INTEGER NOT NULL,
        address INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        register_value TEXT,
        register_length INTEGER,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (bus_id, slave_id, address)
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_bus_ts ON sniffer_telegram (bus_id, ts DESC);
    `)
  }

  upsertConfig(config: SnifferBusConfig): void {
    if (!this.db) return
    this.db
      .prepare(
        `INSERT INTO sniffer_config (bus_id, config) VALUES (?, ?)
         ON CONFLICT(bus_id) DO UPDATE SET config = excluded.config`
      )
      .run(config.busId, JSON.stringify(config))
  }
  getConfig(busId: number): SnifferBusConfig | undefined {
    if (!this.db) return undefined
    const row = this.db.prepare('SELECT config FROM sniffer_config WHERE bus_id = ?').get(busId) as
      | { config: string }
      | undefined
    return row ? (JSON.parse(row.config) as SnifferBusConfig) : undefined
  }
  getConfigs(): SnifferBusConfig[] {
    if (!this.db) return []
    return (this.db.prepare('SELECT config FROM sniffer_config').all() as { config: string }[]).map((r) =>
      JSON.parse(r.config)
    ) as SnifferBusConfig[]
  }
  appendTelegram(busId: number, telegram: ParsedTelegram): void {
    if (!this.db) return
    this.db
      .prepare(
        `INSERT INTO sniffer_telegram
           (bus_id, ts, direction, slave_id, function_code, crc_ok, exception_code, decoded, raw_length)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        busId,
        telegram.timestamp,
        telegram.direction,
        telegram.slaveId,
        telegram.functionCode,
        telegram.crcOk ? 1 : 0,
        telegram.exceptionCode ?? null,
        telegram.decoded ? JSON.stringify(telegram.decoded) : null,
        telegram.rawLength
      )
  }
  getTelegrams(busId: number, slaveId?: number, limit?: number): SnifferTelegramRow[] {
    if (!this.db) return []
    const rows =
      slaveId !== undefined
        ? (this.db
            .prepare(
              `SELECT * FROM sniffer_telegram WHERE bus_id = ? AND slave_id = ? ORDER BY id DESC LIMIT ?`
            )
            .all(busId, slaveId, limit ?? 500) as Record<string, unknown>[])
        : (this.db
            .prepare(`SELECT * FROM sniffer_telegram WHERE bus_id = ? ORDER BY id DESC LIMIT ?`)
            .all(busId, limit ?? 500) as Record<string, unknown>[])
    return rows.map((r) => this.rowToTelegram(r))
  }
  private rowToTelegram(r: Record<string, unknown>): SnifferTelegramRow {
    return {
      id: r.id as number,
      busId: r.bus_id as number,
      timestamp: r.ts as string,
      direction: r.direction as TelegramDirection,
      slaveId: r.slave_id as number,
      functionCode: r.function_code as number,
      crcOk: (r.crc_ok as number) === 1,
      exceptionCode: r.exception_code === null ? undefined : (r.exception_code as number),
      decoded: r.decoded ? (JSON.parse(r.decoded as string) as ParsedTelegram['decoded']) : undefined,
      rawLength: r.raw_length as number,
    }
  }
  upsertDevice(busId: number, telegram: ParsedTelegram): void {
    if (!this.db) return
    this.db
      .prepare(
        `INSERT INTO sniffer_device
           (bus_id, slave_id, first_seen, last_seen, request_count, response_count, exception_count)
         VALUES (?, ?, ?, ?, 0, 0, 0)
         ON CONFLICT(bus_id, slave_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           request_count = sniffer_device.request_count + CASE WHEN excluded.request_count = 1 THEN 1 ELSE 0 END,
           response_count = sniffer_device.response_count + CASE WHEN excluded.response_count = 1 THEN 1 ELSE 0 END,
           exception_count = sniffer_device.exception_count + CASE WHEN excluded.exception_count = 1 THEN 1 ELSE 0 END`
      )
      .run(
        busId,
        telegram.slaveId,
        telegram.timestamp,
        telegram.timestamp,
        telegram.direction === 'request' ? 1 : 0,
        telegram.direction === 'response' ? 1 : 0,
        telegram.exceptionCode !== undefined ? 1 : 0
      )
  }
  getDevices(busId: number): SnifferDeviceRow[] {
    if (!this.db) return []
    return this.db
      .prepare('SELECT * FROM sniffer_device WHERE bus_id = ? ORDER BY slave_id')
      .all(busId) as unknown as SnifferDeviceRow[]
  }
  upsertRegister(busId: number, telegram: ParsedTelegram, address: number, quantity: number, words: number[]): void {
    if (!this.db) return
    this.db
      .prepare(
        `INSERT INTO sniffer_register
           (bus_id, slave_id, address, quantity, register_value, register_length, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bus_id, slave_id, address) DO UPDATE SET
           quantity = excluded.quantity,
           register_value = excluded.register_value,
           register_length = excluded.register_length,
           last_seen = excluded.last_seen`
      )
      .run(busId, telegram.slaveId, address, quantity, JSON.stringify(words), words.length, telegram.timestamp)
  }
  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[] {
    if (!this.db) return []
    const rows =
      slaveId !== undefined
        ? (this.db
            .prepare('SELECT * FROM sniffer_register WHERE bus_id = ? AND slave_id = ? ORDER BY address')
            .all(busId, slaveId) as Record<string, unknown>[])
        : (this.db
            .prepare('SELECT * FROM sniffer_register WHERE bus_id = ? ORDER BY slave_id, address')
            .all(busId) as Record<string, unknown>[])
    return rows.map((r) => ({
      busId: r.bus_id as number,
      slaveId: r.slave_id as number,
      address: r.address as number,
      quantity: r.quantity as number,
      words: r.register_value ? (JSON.parse(r.register_value as string) as number[]) : undefined,
      value: undefined,
      converter: undefined,
      uom: undefined,
      lastSeen: r.last_seen as string,
      specKey: undefined,
    }))
  }
  deleteBus(busId: number): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM sniffer_config WHERE bus_id = ?').run(busId)
    this.db.prepare('DELETE FROM sniffer_telegram WHERE bus_id = ?').run(busId)
    this.db.prepare('DELETE FROM sniffer_device WHERE bus_id = ?').run(busId)
    this.db.prepare('DELETE FROM sniffer_register WHERE bus_id = ?').run(busId)
  }
}