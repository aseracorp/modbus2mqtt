import Debug from 'debug'
import { HttpErrorsEnum } from '../../../shared/specification/index.js'
import { apiUri } from '../../../shared/server/index.js'
import { ModbusSnifferRegistry } from '../../sniffer/registry.js'
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

  // GET /api/sniffer/telegrams?busid=1[&slaveid=1][&limit=100]
  r.get(apiUri.snifferTelegrams, (ctx) => {
    const busId = requireBusId(ctx)
    const slaveId = ctx.query['slaveid'] !== undefined ? parseInt(ctx.query['slaveid']) : undefined
    const limit = ctx.query['limit'] !== undefined ? parseInt(ctx.query['limit']) : 200
    return ok(registry.getTelegrams(busId, slaveId, limit))
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
      uom?: string
    }
    if (body.busId === undefined || body.slaveId === undefined || body.address === undefined)
      throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busId, slaveId and address are required')
    const row = registry.annotateRegister({
      busId: body.busId,
      slaveId: body.slaveId,
      address: body.address,
      converter: body.converter,
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

  // GET /api/sniffer/events?busid=1  (Server-Sent Events)
  // Long-lived stream: the server writes a "change" event whenever captured
  // data (telegrams/devices/registers/state) changes for the bus. The client
  // re-fetches the tables on each event instead of polling every 2s. A
  // keep-alive comment is written periodically so proxies don't drop the idle
  // connection.
  r.raw.get(apiUri.snifferEvents, (req, res) => {
    const busIdRaw = req.query['busid']
    const busId = busIdRaw !== undefined && busIdRaw !== '' ? parseInt(String(busIdRaw)) : NaN
    if (Number.isNaN(busId)) {
      res.status(400).setHeader('Content-Type', 'text/plain').send('busid was not passed')
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()
    res.write(': connected\n\n')

    let unsub: () => void = () => undefined
    const seen = registry.getChangeCounter(busId)
    const send = () => {
      res.write('event: change\n')
      res.write('data: ' + JSON.stringify({ busId, counter: registry.getChangeCounter(busId) }) + '\n\n')
    }
    // Subscribe after the initial state check so a change between the two is
    // caught by the counter comparison below.
    unsub = registry.onChange(busId, () => {
      try {
        send()
      } catch {
        try { unsub() } catch { /* already gone */ }
      }
    })
    if (registry.getChangeCounter(busId) !== seen) send()

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
    const slave = bus.getSlaveBySlaveId(body.slaveId)
    if (!slave) throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'slave not found on bus: ' + body.slaveId)
    const specId = body.specificationid && body.specificationid.trim() !== '' ? body.specificationid.trim() : undefined
    slave.specificationid = specId
    bus.writeSlave(slave)
    // Re-interpret every register row of the slave so the table reflects the
    // new template (or the raw values after detach).
    const regs = registry.getRegisters(body.busId, body.slaveId)
    return created({ busId: body.busId, slaveId: body.slaveId, specificationid: specId, registers: regs })
  })
}

function requireBusId(ctx: Ctx): number {
  const busId = ctx.query['busid']
  if (busId === undefined || busId === '') throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busid was not passed')
  return parseInt(busId)
}
