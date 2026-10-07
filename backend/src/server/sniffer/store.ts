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
      direction: telegram.direction,
      timestamp: telegram.timestamp,
      slaveId: telegram.slaveId,
      functionCode: telegram.functionCode,
      rawHex: Buffer.from(telegram.raw).toString('hex'),
      crcOk: telegram.crcOk,
      functionName: telegram.decoded?.functionName,
      address: telegram.decoded?.address,
      length: telegram.decoded?.length,
      values: telegram.decoded?.values,
      exceptionCode: telegram.decoded?.exceptionCode,
    })
  }
  getTelegrams(busId: number, slaveId?: number, limit = 200): SnifferTelegramRow[] {
    let rows = this.telegrams.filter((t) => t.busId === busId)
    if (slaveId !== undefined) rows = rows.filter((t) => t.slaveId === slaveId)
    // Newest first, like the SQLite store (ORDER BY id DESC).
    return rows.slice(-limit).reverse()
  }
  upsertDevice(busId: number, telegram: ParsedTelegram): void {
    const key = busId + ':' + telegram.slaveId
    const isReq = telegram.direction === TelegramDirection.request
    const isErr = telegram.decoded?.exceptionCode !== undefined
    const existing = this.devices.get(key)
    this.devices.set(key, {
      busId,
      slaveId: telegram.slaveId,
      firstSeen: existing?.firstSeen ?? telegram.timestamp,
      lastSeen: telegram.timestamp,
      requestCount: (existing?.requestCount ?? 0) + (isReq ? 1 : 0),
      responseCount: (existing?.responseCount ?? 0) + (isReq ? 0 : 1),
      errorCount: (existing?.errorCount ?? 0) + (isErr ? 1 : 0),
      lastFunction: telegram.decoded?.functionName ?? existing?.lastFunction,
    })
  }
  getDevices(busId: number): SnifferDeviceRow[] {
    return Array.from(this.devices.values())
      .filter((d) => d.busId === busId)
      .sort((a, b) => a.slaveId - b.slaveId)
  }
  upsertRegister(busId: number, telegram: ParsedTelegram, address: number, quantity: number, words: number[]): void {
    const key = busId + ':' + telegram.slaveId + ':' + address
    const existing = this.registers.get(key)
    this.registers.set(key, {
      id: existing?.id ?? this.registers.size + 1,
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
        direction TEXT NOT NULL,
        timestamp REAL NOT NULL,
        slave_id INTEGER NOT NULL,
        function_code INTEGER NOT NULL,
        raw_hex TEXT NOT NULL,
        crc_ok INTEGER NOT NULL,
        function_name TEXT,
        address INTEGER,
        length INTEGER,
        register_values TEXT,
        exception_code INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_bus_id ON sniffer_telegram(bus_id, id DESC);
      CREATE TABLE IF NOT EXISTS sniffer_device (
        bus_id INTEGER NOT NULL,
        slave_id INTEGER NOT NULL,
        first_seen REAL NOT NULL,
        last_seen REAL NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        response_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_function TEXT,
        mapping_id INTEGER,
        PRIMARY KEY (bus_id, slave_id)
      );
      CREATE TABLE IF NOT EXISTS sniffer_register (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bus_id INTEGER NOT NULL,
        slave_id INTEGER NOT NULL,
        address INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        words TEXT NOT NULL,
        value TEXT,
        converter TEXT,
        uom TEXT,
        last_seen REAL NOT NULL,
        spec_key TEXT,
        UNIQUE (bus_id, slave_id, address)
      );
    `)
  }

  upsertConfig(config: SnifferBusConfig): void {
    if (!this.db) return
    this.db
      .prepare('INSERT INTO sniffer_config (bus_id, config) VALUES (?, ?) ON CONFLICT(bus_id) DO UPDATE SET config = excluded.config')
      .run(config.busId, JSON.stringify(config))
  }
  getConfig(busId: number): SnifferBusConfig | undefined {
    if (!this.db) return undefined
    const row = this.db.prepare('SELECT config FROM sniffer_config WHERE bus_id = ?').get(busId) as { config: string } | undefined
    return row ? (JSON.parse(row.config) as SnifferBusConfig) : undefined
  }
  getConfigs(): SnifferBusConfig[] {
    if (!this.db) return []
    const rows = this.db.prepare('SELECT config FROM sniffer_config').all() as { config: string }[]
    return rows.map((r) => JSON.parse(r.config) as SnifferBusConfig)
  }

  appendTelegram(busId: number, telegram: ParsedTelegram): void {
    if (!this.db) return
    this.db
      .prepare(
        `INSERT INTO sniffer_telegram
          (bus_id, direction, timestamp, slave_id, function_code, raw_hex, crc_ok,
           function_name, address, length, register_values, exception_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        busId,
        telegram.direction,
        telegram.timestamp,
        telegram.slaveId,
        telegram.functionCode,
        Buffer.from(telegram.raw).toString('hex'),
        telegram.crcOk ? 1 : 0,
        telegram.decoded?.functionName ?? null,
        telegram.decoded?.address ?? null,
        telegram.decoded?.length ?? null,
        telegram.decoded?.values ? JSON.stringify(telegram.decoded.values) : null,
        telegram.decoded?.exceptionCode ?? null
      )
  }

  getTelegrams(busId: number, slaveId?: number, limit = 200): SnifferTelegramRow[] {
    if (!this.db) return []
    const params: unknown[] = [busId]
    let sql =
      `SELECT id, bus_id as busId, direction, timestamp, slave_id as slaveId, function_code as functionCode,
              raw_hex as rawHex, crc_ok as crcOk, function_name as functionName, address, length,
              register_values as registerValue, exception_code as exceptionCode
       FROM sniffer_telegram WHERE bus_id = ?`
    if (slaveId !== undefined) {
      sql += ' AND slave_id = ?'
      params.push(slaveId)
    }
    sql += ' ORDER BY id DESC LIMIT ?'
    params.push(limit)
    const rows = this.db.prepare(sql).all(...params) as SnifferTelegramRow[]
    return rows.map((r) => ({
      ...r,
      crcOk: !!r.crcOk,
      values: (r as unknown as { registerValue?: string }).registerValue
        ? (JSON.parse((r as unknown as { registerValue: string }).registerValue) as number[])
        : undefined,
    }))
  }

  upsertDevice(busId: number, telegram: ParsedTelegram): void {
    if (!this.db) return
    const isReq = telegram.direction === TelegramDirection.request
    const isErr = telegram.decoded?.exceptionCode !== undefined
    this.db
      .prepare(
        `INSERT INTO sniffer_device
           (bus_id, slave_id, first_seen, last_seen, request_count, response_count, error_count, last_function)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bus_id, slave_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           request_count = sniffer_device.request_count + excluded.request_count,
           response_count = sniffer_device.response_count + excluded.response_count,
           error_count = sniffer_device.error_count + excluded.error_count,
           last_function = COALESCE(excluded.last_function, sniffer_device.last_function)`
      )
      .run(
        busId,
        telegram.slaveId,
        telegram.timestamp,
        telegram.timestamp,
        isReq ? 1 : 0,
        isReq ? 0 : 1,
        isErr ? 1 : 0,
        telegram.decoded?.functionName ?? null
      )
  }

  getDevices(busId: number): SnifferDeviceRow[] {
    if (!this.db) return []
    const rows = this.db
      .prepare(
        `SELECT bus_id as busId, slave_id as slaveId, first_seen as firstSeen, last_seen as lastSeen,
                request_count as requestCount, response_count as responseCount, error_count as errorCount,
                last_function as lastFunction, mapping_id as mappingId
         FROM sniffer_device WHERE bus_id = ? ORDER BY slave_id`
      )
      .all(busId) as SnifferDeviceRow[]
    return rows
  }

  upsertRegister(busId: number, telegram: ParsedTelegram, address: number, quantity: number, words: number[]): void {
    if (!this.db) return
    const prev = this.db
      .prepare('SELECT words, value, converter, uom, spec_key as specKey FROM sniffer_register WHERE bus_id=? AND slave_id=? AND address=?')
      .get(busId, telegram.slaveId, address) as { words: string; value?: string; converter?: string; uom?: string; specKey?: string } | undefined
    this.db
      .prepare(
        `INSERT INTO sniffer_register (bus_id, slave_id, address, quantity, words, value, converter, uom, last_seen, spec_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(bus_id, slave_id, address) DO UPDATE SET
           quantity = excluded.quantity,
           words = excluded.words,
           value = COALESCE(excluded.value, sniffer_register.value),
           converter = COALESCE(excluded.converter, sniffer_register.converter),
           uom = COALESCE(excluded.uom, sniffer_register.uom),
           last_seen = excluded.last_seen`
      )
      .run(
        busId,
        telegram.slaveId,
        address,
        quantity,
        JSON.stringify(words),
        prev?.value ?? null,
        prev?.converter ?? null,
        prev?.uom ?? null,
        telegram.timestamp,
        prev?.specKey ?? null
      )
  }

  getRegisters(busId: number, slaveId?: number): SnifferRegisterRow[] {
    if (!this.db) return []
    const params: unknown[] = [busId]
    let sql =
      `SELECT id, bus_id as busId, slave_id as slaveId, address, quantity, words, value, converter, uom,
              last_seen as lastSeen, spec_key as specKey
       FROM sniffer_register WHERE bus_id = ?`
    if (slaveId !== undefined) {
      sql += ' AND slave_id = ?'
      params.push(slaveId)
    }
    sql += ' ORDER BY slave_id, address'
    const rows = this.db.prepare(sql).all(...params) as SnifferRegisterRow[]
    return rows.map((r) => ({ ...r, words: JSON.parse(r.words as unknown as string) as number[] }))
  }

  deleteBus(busId: number): void {
    if (!this.db) return
    this.db.prepare('DELETE FROM sniffer_config WHERE bus_id=?').run(busId)
    this.db.prepare('DELETE FROM sniffer_telegram WHERE bus_id=?').run(busId)
    this.db.prepare('DELETE FROM sniffer_device WHERE bus_id=?').run(busId)
    this.db.prepare('DELETE FROM sniffer_register WHERE bus_id=?').run(busId)
  }
}
