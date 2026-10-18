import Debug from 'debug'
import { HttpErrorsEnum } from '../../../shared/specification/index.js'
import { apiUri } from '../../../shared/server/index.js'
import { ModbusSnifferRegistry } from '../../sniffer/registry.js'
import { ConfigSpecification } from '../../../specification/configspec.js'
import { entityLength, entityUom } from '../../sniffer/snifferService.js'
import { SnifferBusConfig } from '../../sniffer/types.js'
import { Bus } from '../../bus.js'
import { ApiError, Ctx, Registrar, created, ok } from '../routeHelpers.js'

const debug = Debug('httpserver:sniffer')

/**
 * HTTP API for the RTU sniffer. All endpoints require a busid (query param).
 * The sniffer is RTU-focused: it observes the bus traffic of the active
 * ModbusAPI (stack hook) or a dedicated passive tap port (see SnifferBusConfig).
 */
export function registerSnifferRoutes(r: Registrar): void {
  const registry = ModbusSnifferRegistry.getInstance()

  // GET /api/sniffer/config?busid=1 -> the current sniffer config for the bus
  r.get(apiUri.snifferConfig, (ctx) => {
    const busId = requireBusId(ctx)
    const config = registry.getConfig(busId)
    return ok(config ?? { busId, mode: 'stack', enabled: false })
  })

  // POST /api/sniffer/config {busId, mode, tapDevice?, ...} -> save config
  r.post(apiUri.snifferConfig, (ctx) => {
    const config = ctx.body as SnifferBusConfig
    if (!config || config.busId === undefined) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busId required')
    config.mode = config.mode ?? 'stack'
    config.enabled = config.enabled ?? false
    registry.saveConfig(config)
    debug('saved sniffer config for bus ' + config.busId)
    return created({ busId: config.busId })
  })

  // POST /api/sniffer/start?busid=1 -> start the sniffer for the bus
  r.post(apiUri.snifferStart, async (ctx) => {
    const busId = requireBusId(ctx)
    await registry.start(busId)
    return created({ busId, running: true })
  })

  // POST /api/sniffer/stop?busid=1
  r.post(apiUri.snifferStop, async (ctx) => {
    const busId = requireBusId(ctx)
    await registry.stop(busId)
    return ok({ busId, running: false })
  })

  // GET /api/sniffer/state?busid=1
  r.get(apiUri.snifferState, (ctx) => {
    const busId = requireBusId(ctx)
    const state = registry.getState(busId)
    return ok(state ?? { busId, running: false })
  })

  // GET /api/sniffer/telegrams?busid=1[&slaveid=1][&limit=100][&offset=0][&from=<epochSec>][&to=<epochSec>]
  // Without an offset the response stays a plain array (legacy consumers like
  // the classic webui expect that). With an explicit offset it returns
  // { rows, total } so paged tables can show totals + navigate.
  r.get(apiUri.snifferTelegrams, (ctx) => {
    const busId = requireBusId(ctx)
    const slaveId = ctx.query['slaveid'] !== undefined ? parseInt(ctx.query['slaveid']) : undefined
    const limit = ctx.query['limit'] !== undefined ? parseInt(ctx.query['limit']) : 200
    const offsetRaw = ctx.query['offset']
    const hasOffset = offsetRaw !== undefined && offsetRaw !== ''
    const offset = hasOffset ? parseInt(String(offsetRaw)) : 0
    const from = ctx.query['from'] !== undefined && ctx.query['from'] !== ''
      ? parseFloat(ctx.query['from']) : undefined
    const to = ctx.query['to'] !== undefined && ctx.query['to'] !== ''
      ? parseFloat(ctx.query['to']) : undefined
    const rows = registry.getTelegrams(busId, slaveId, limit, from, to, offset)
    if (!hasOffset) return ok(rows)
    const total = registry.countTelegrams(busId, slaveId, from, to)
    return ok({ rows, total })
  })

  // GET /api/sniffer/registers/history?busid=1&slaveid=5&address=0[&limit=500][&from=<epochSec>][&to=<epochSec>]
  // Returns response telegrams that carried values for the register (newest
  // first). Each point includes `convertedValue` (interpreted via the template
  // entity, when decodable) and `rawAddressWord` (the raw register word) - the
  // data source for the value trend chart.
  r.get(apiUri.snifferRegisterHistory, (ctx) => {
    const busId = requireBusId(ctx)
    const slaveId = ctx.query['slaveid'] !== undefined ? parseInt(ctx.query['slaveid']) : undefined
    const address = ctx.query['address'] !== undefined ? parseInt(ctx.query['address']) : undefined
    if (slaveId === undefined || address === undefined)
      throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'slaveid and address are required')
    const limit = ctx.query['limit'] !== undefined ? parseInt(ctx.query['limit']) : 500
    const from = ctx.query['from'] !== undefined && ctx.query['from'] !== ''
      ? parseFloat(ctx.query['from']) : undefined
    const to = ctx.query['to'] !== undefined && ctx.query['to'] !== ''
      ? parseFloat(ctx.query['to']) : undefined
    const service = registry.getService(busId)
    if (!service) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'no sniffer service for bus ' + busId)
    return ok(service.getRegisterHistoryConverted(busId, slaveId, address, limit, from, to))
  })

  // GET /api/sniffer/history/summary?busid=1[&slaveid=5][&from=..][&to=..][&address=0]
  // Register-centric history: distinct registers that carried values in the
  // period, with sample count, latest raw + interpreted value. Drives the
  // History view (lists registers, not telegrams).
  r.get(apiUri.snifferHistorySummary, (ctx) => {
    const busId = requireBusId(ctx)
    const slaveId = ctx.query['slaveid'] !== undefined ? parseInt(ctx.query['slaveid']) : undefined
    const address = ctx.query['address'] !== undefined ? parseInt(ctx.query['address']) : undefined
    const from = ctx.query['from'] !== undefined && ctx.query['from'] !== '' ? parseFloat(ctx.query['from']) : undefined
    const to = ctx.query['to'] !== undefined && ctx.query['to'] !== '' ? parseFloat(ctx.query['to']) : undefined
    const service = registry.getService(busId)
    if (!service) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'no sniffer service for bus ' + busId)
    return ok(service.getRegisterHistorySummary(busId, slaveId, from, to, address))
  })

  // GET /api/sniffer/history/flat?busid=1[&slaveid=][&from=][&to=][&address=][&limit=][&offset=]
  // Flat value history: every response telegram carrying register values as a
  // single row (registers-table columns + timestamp), sorted by timestamp.
  r.get(apiUri.snifferHistoryFlat, (ctx) => {
    const busId = requireBusId(ctx)
    const slaveId = ctx.query['slaveid'] !== undefined ? parseInt(ctx.query['slaveid']) : undefined
    const address = ctx.query['address'] !== undefined ? parseInt(ctx.query['address']) : undefined
    const from = ctx.query['from'] !== undefined && ctx.query['from'] !== '' ? parseFloat(ctx.query['from']) : undefined
    const to = ctx.query['to'] !== undefined && ctx.query['to'] !== '' ? parseFloat(ctx.query['to']) : undefined
    const limit = ctx.query['limit'] !== undefined ? parseInt(ctx.query['limit']) : 500
    const offset = ctx.query['offset'] !== undefined ? parseInt(ctx.query['offset']) : 0
    const service = registry.getService(busId)
    if (!service) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'no sniffer service for bus ' + busId)
    const rows = service.getRegisterHistoryFlat(busId, slaveId, from, to, address, limit, offset)
    const total = registry.countTelegrams(busId, slaveId, from, to)
    return ok({ rows, total })
  })

  // GET /api/sniffer/devices?busid=1
  r.get(apiUri.snifferDevices, (ctx) => {
    const busId = requireBusId(ctx)
    return ok(registry.getDevices(busId))
  })

  // GET /api/sniffer/registers?busid=1[&slaveid=1]
  r.get(apiUri.snifferRegisters, (ctx) => {
    const busId = requireBusId(ctx)
    const slaveId = ctx.query['slaveid'] !== undefined ? parseInt(ctx.query['slaveid']) : undefined
    return ok(registry.getRegisters(busId, slaveId))
  })

  // POST /api/sniffer/registers/annotation {busId, slaveId, address, converter?, uom?}
  // Persists a manual converter/uom annotation for a register row (used when no
  // template entity decodes the register). Template-interpreted rows are not
  // affected - a template always wins.
  r.post(apiUri.snifferRegisterAnnotation, (ctx) => {
    const body = (ctx.body ?? {}) as {
      busId?: number
      slaveId?: number
      address?: number
      converter?: string
      description?: string
      uom?: string
    }
    if (body.busId === undefined || body.slaveId === undefined || body.address === undefined)
      throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busId, slaveId and address are required')
    const row = registry.annotateRegister({
      busId: body.busId,
      slaveId: body.slaveId,
      address: body.address,
      converter: body.converter,
      description: body.description,
      uom: body.uom,
    })
    if (!row) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'register row not found')
    return created(row)
  })

  // POST /api/sniffer/reset?busid=1 (busid optional: reset all buses)
  // Renames the sniffer database file (timestamp suffix) and starts a fresh one,
  // so the captured history is archived instead of deleted.
  r.post(apiUri.snifferReset, async (ctx) => {
    const busId = ctx.query['busid'] !== undefined && ctx.query['busid'] !== '' ? parseInt(ctx.query['busid']) : undefined
    return ok(await registry.resetDatabase(busId))
  })

  // GET /api/sniffer/events[?busid=1]  (Server-Sent Events)
  // Long-lived stream: the server writes a "change" event whenever captured
  // data (telegrams/devices/registers/state) changes. With a busid only that
  // bus's events are pushed; without a busid a single global stream pushes
  // events for ALL buses (payload carries the affected busIds). The client
  // re-fetches the tables on each event instead of polling every 2s. A
  // keep-alive comment is written periodically so proxies don't drop the idle
  // connection.
  r.raw.get(apiUri.snifferEvents, (req, res) => {
    const busIdRaw = req.query['busid']
    const busId = busIdRaw !== undefined && busIdRaw !== '' ? parseInt(String(busIdRaw)) : NaN
    const global = Number.isNaN(busId)

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
    res.write(': connected\n\n')

    let unsub: () => void = () => undefined
    const send = (payload: unknown) => {
      try {
        res.write('event: change\n')
        res.write('data: ' + JSON.stringify(payload) + '\n\n')
      } catch {
        try { unsub() } catch { /* already gone */ }
      }
    }

    if (global) {
      // Global stream: one subscriber that re-fans per-bus changes to this
      // client. Payload = the buses that changed since the last event (with
      // their current change counters).
      let lastCounters = new Map<number, number>()
      unsub = registry.onAnyChange((changedBusId) => {
        const prev = lastCounters.get(changedBusId) ?? 0
        lastCounters.set(changedBusId, registry.getChangeCounter(changedBusId))
        // Only fire when the counter actually advanced (protects against
        // duplicate fan-out when a service is re-attached).
        if (registry.getChangeCounter(changedBusId) !== prev) {
          send({
            busIds: [changedBusId],
            counters: { [changedBusId]: registry.getChangeCounter(changedBusId) },
          })
        }
      })
      // Seed counters so the next change (even of a bus that never fired
      // before) produces an event. Do it AFTER subscribing.
      for (const busId of registry.getServiceIds()) {
        lastCounters.set(busId, registry.getChangeCounter(busId))
      }
    } else {
      // Per-bus stream (legacy).
      const seen = registry.getChangeCounter(busId)
      const sendBus = () => send({ busId, counter: registry.getChangeCounter(busId) })
      // Subscribe after the initial state check so a change between the two is
      // caught by the counter comparison below.
      unsub = registry.onChange(busId, sendBus)
      if (registry.getChangeCounter(busId) !== seen) sendBus()
    }

    const keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n')
      } catch {
        clearInterval(keepAlive)
      }
    }, 25000)
    req.on('close', () => {
      clearInterval(keepAlive)
      try { unsub() } catch { /* ignore */ }
    })
  })

  // GET /api/sniffer/slave-templates?busid=1 -> per-slave template assignments
  // stored in the sniffer database (for slaves discovered on the wire that are
  // not configured in the bus). Returns [{busId, slaveId, specificationid}].
  r.get(apiUri.snifferSlaveTemplates, (ctx) => {
    const busId = requireBusId(ctx)
    const templates = registry.getSlaveTemplates(busId)
    return ok(Array.from(templates.entries()).map(([slaveId, specificationid]) => ({ busId, slaveId, specificationid })))
  })

  // POST /api/sniffer/registers/template {busId, slaveId, specificationid?}
  // Assigns an existing specification (template) to the slave, so the register
  // table can interpret the slave's registers via the template entities.
  // Pass specificationid = '' / null to detach the template again. After the
  // assignment the affected register rows are re-interpreted immediately.
  r.post(apiUri.snifferRegisterTemplate, (ctx) => {
    const body = (ctx.body ?? {}) as { busId?: number; slaveId?: number; specificationid?: string | null }
    if (body.busId === undefined || body.slaveId === undefined)
      throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busId and slaveId are required')
    const bus = Bus.getBus(body.busId)
    if (!bus) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'bus not found: ' + body.busId)
    const specId = body.specificationid && body.specificationid.trim() !== '' ? body.specificationid.trim() : undefined
    const slave = bus.getSlaveBySlaveId(body.slaveId)
    if (slave) {
      // Configured slave: the template lives in the bus config as usual.
      slave.specificationid = specId
      bus.writeSlave(slave)
    } else {
      // Sniffer-discovered slave (seen on the wire but not configured in the
      // bus): persist the assignment in the sniffer store so the register
      // table can interpret the rows anyway.
      const storeSpecId = registry.getSlaveTemplate(body.busId, body.slaveId)
      if (!specId && !storeSpecId) {
        throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'slave not found on bus and no template stored for it: ' + body.slaveId)
      }
      registry.setSlaveTemplate(body.busId, body.slaveId, specId)
    }
    // Seed every template entity as a register row (including conditional
    // entities that were not seen on the wire yet) so assigning a template
    // immediately fills the table with addresses, converters, units and the
    // register description. Rows that were already captured keep their words.
    const store = registry.getStore()
    if (specId && store && specId !== '') {
      const spec = ConfigSpecification.getSpecificationByFilename(specId)
      if (spec) {
        for (const e of spec.entities) {
          if (e.modbusAddress === undefined) continue
          const len = entityLength(e)
          store.upsertRegisterDirect({
            busId: body.busId,
            slaveId: body.slaveId,
            address: e.modbusAddress,
            quantity: len,
            functionCode: registerTypeToFunctionCode(e.registerType),
            converter: e.converter,
            uom: entityUom(e),
            description: e.name ?? e.mqttname ?? undefined,
            specKey: spec.filename,
          })
        }
      }
    }
    // Re-interpret every register row of the slave so the table reflects the
    // new template (or the raw values after detach).
    const regs = registry.getRegisters(body.busId, body.slaveId)
    return created({ busId: body.busId, slaveId: body.slaveId, specificationid: specId, registers: regs })
  })
}


/** Maps a ModbusRegisterType back to a representative function code (best-effort). */
function registerTypeToFunctionCode(rt: import('../../../shared/specification/index.js').ModbusRegisterType | undefined): number | undefined {
  switch (rt) {
    case 1 /* HoldingRegister */: return 0x03
    case 2 /* AnalogInputs */: return 0x04
    case 3 /* Coils */: return 0x01
    case 4 /* DiscreteInputs */: return 0x02
    default: return undefined
  }
}

function requireBusId(ctx: Ctx): number {
  const busId = ctx.query['busid']
  if (busId === undefined || busId === '') throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busid was not passed')
  return parseInt(busId)
}
