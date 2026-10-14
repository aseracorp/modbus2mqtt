import Debug from 'debug'
import { HttpErrorsEnum } from '../../../shared/specification/index.js'
import { apiUri } from '../../../shared/server/index.js'
import { ModbusSnifferRegistry } from '../../sniffer/registry.js'
import { SnifferBusConfig } from '../../sniffer/types.js'
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
}

function requireBusId(ctx: Ctx): number {
  const busId = ctx.query['busid']
  if (busId === undefined || busId === '') throw new ApiError(HttpErrorsEnum.ErrBadRequest, 'busid was not passed')
  return parseInt(busId)
}
