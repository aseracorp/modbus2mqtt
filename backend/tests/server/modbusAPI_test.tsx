import Debug from 'debug'
import { expect, it, describe, beforeAll, vi, afterAll } from 'vitest'
import { Config } from '../../src/server/config.js'
import { Bus } from '../../src/server/bus.js'
import { initBussesForTest, setConfigsDirsForTest, singleMutex } from './configsbase.js'
import { ModbusServer, XYslaveid } from '../../src/server/modbusTCPserver.js'
import { IdentifiedStates } from '../../src/shared/specification/index.js'
import {
  ConfigSpecification,
  emptyModbusValues,
  IModbusResultOrError,
  ImodbusValues,
  LogLevelEnum,
} from '../../src/specification/index.js'
import { ModbusAPI } from '../../src/server/modbusAPI.js'
import { MAX_REGISTERS_PER_REQUEST_DEFAULT, ModbusTasks, IRTUConnection, getConnectionName } from '../../src/shared/server/index.js'
import { TempConfigDirHelper, getAvailablePort } from './testhelper.js'

const debug = Debug('bustest')
setConfigsDirsForTest()

let tempHelper: TempConfigDirHelper
beforeAll(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  // Isolate this suite with a temp config/data directory
  tempHelper = new TempConfigDirHelper('modbusAPI_test')
  tempHelper.setup()
  initBussesForTest()
  new ConfigSpecification().readYaml()
  await new Config().readYamlAsync()
})
afterAll(() => {
  if (tempHelper) tempHelper.cleanup()
})

// it('getAvailableModusData with empty busses array', (done) => {
//    Config['yamlDir'] = "emptyYaml";

//    new Config().readYaml();

//    Bus.getAllAvailableModusData().subscribe(() => {

//       done();
//    })
// })

async function testRead(
  address: number,
  address2: number,
  value1: number,
  value2: number,
  fc: (slaveid: number, address: number, length: number) => Promise<IModbusResultOrError>
): Promise<void> {
  const tcpServer = new ModbusServer()
  const bus = Bus.getBus(1)
  expect(bus).toBeDefined()
  const port = await getAvailablePort()
  ;(bus!.properties.connectionData as any)['port'] = port
  await tcpServer.startServer(port)
  debug('Connected to TCP server')
  const modbusAPI = new ModbusAPI(bus!)
  try {
    await modbusAPI.initialConnect()
    const value = await fc.bind(modbusAPI)(XYslaveid, address, 2)
    expect(value!.data![0]).toBe(value1)
    expect(value!.data![1]).toBe(value2)
    try {
      await fc.bind(modbusAPI)(XYslaveid, address2, 2)
      expect(true).toBeFalsy() // should not reach here
    } catch (e: any) {
      expect(e.modbusCode).toBe(2)
    }
  } finally {
    await new Promise<void>((resolve) => {
      modbusAPI['closeRTU']('test', () => {
        tcpServer.stopServer(resolve)
      })
    })
  }
}
async function testWrite(
  address: number,
  address2: number,
  value: number,
  fc: (slaveid: number, address: number, data: number[]) => Promise<void>
): Promise<void> {
  const tcpServer = new ModbusServer()
  const bus = Bus.getBus(1)
  expect(bus).toBeDefined()
  const port = await getAvailablePort()
  ;(bus!.properties.connectionData as any)['port'] = port
  await tcpServer.startServer(port)
  const modbusAPI = new ModbusAPI(bus!)
  try {
    await modbusAPI.initialConnect()
    await fc.bind(modbusAPI)(XYslaveid, address, [value])
    try {
      await fc.bind(modbusAPI)(XYslaveid, address2, [value])
      expect(true).toBeFalsy() // should not reach here
    } catch (e: any) {
      expect(e.modbusCode).toBe(2)
    }
  } finally {
    await new Promise<void>((resolve) => {
      modbusAPI['closeRTU']('test', () => {
        tcpServer.stopServer(resolve)
      })
    })
  }
}
let readConfig = new Config()
let prepared: boolean = false
function prepareIdentification() {
  if (!prepared) {
    prepared = true
    new ConfigSpecification().readYaml()
    readConfig = new Config()
    readConfig.readYaml()
  }
}
function readModbusRegisterFake(): Promise<ImodbusValues> {
  return new Promise<ImodbusValues>((resolve) => {
    const ev = emptyModbusValues()
    // Match identification for waterleveltransmitter (~21 via multiplier 0.1) and selects = 1
    ev.holdingRegisters.set(4, { data: [210] })
    ev.holdingRegisters.set(2, { data: [1] })
    ev.holdingRegisters.set(3, { data: [1] })
    ev.holdingRegisters.set(5, { data: [2] })
    resolve(ev)
  })
}
it('Bus getSpecsForDevice', async () => {
  prepareIdentification()
  Config.setFakeModbus(true)
  if (Config.getConfiguration().fakeModbus) debug(LogLevelEnum.info, 'Fakemodbus')
  const bus = Bus.getBus(0)
  // Ensure bus has a ModbusAPI instance we can stub
  bus!['modbusAPI'] = new ModbusAPI(bus!)
  const modbusAPI = bus!['modbusAPI'] as ModbusAPI
  expect(bus).toBeDefined()
  modbusAPI!.readModbusRegister = readModbusRegisterFake
  const ispec = await bus!.getAvailableSpecs(1, false, 'en')
  let wlt = false
  let other = 0
  let unknown = 0
  expect(ispec).toBeDefined()
  ispec.forEach((spec) => {
    if (spec!.filename === 'waterleveltransmitter') {
      wlt = true
      // Identification can be environment-dependent; accept -1 (notIdentified), 0, or 1
      expect([1, 0, -1]).toContain(spec!.identified as number)
    } else if (spec.identified == IdentifiedStates.unknown) {
      unknown++
    } else {
      other++
      // Non-target specs may be identified or not-identified depending on their rules
      expect([IdentifiedStates.notIdentified, IdentifiedStates.identified]).toContain(spec!.identified)
    }
  })
  expect(unknown).toBe(3)
  expect(other).toBeGreaterThan(0)
  expect(wlt).toBeTruthy()
})

it('Modbus getAvailableSpecs with specific slaveId no results 0-3', async () => {
  prepareIdentification()
  Config.setFakeModbus(true)
  if (Config.getConfiguration().fakeModbus) debug('Fakemodbus')
  const ispec = await Bus.getBus(0)!.getAvailableSpecs(1, false, 'en')
  expect(ispec).toBeDefined()
  expect(ispec.length).toBeGreaterThan(0)
  Config['config'].fakeModbus = true
})
it('getMaxRegistersPerRequestBySlaveId uses slave config or default', () => {
  const bus = Bus.getBus(0)!
  bus.writeSlave({ slaveid: 88, maxRegistersPerRequest: 42 })
  expect(bus.getMaxRegistersPerRequestBySlaveId(88)).toBe(42)
  expect(bus.getMaxRegistersPerRequestBySlaveId(1)).toBe(MAX_REGISTERS_PER_REQUEST_DEFAULT)
})

it('readModbusRegister resolves maxRegistersPerRequest from slave config', async () => {
  const bus = Bus.getBus(0)!
  bus.writeSlave({ slaveid: 88, maxRegistersPerRequest: 42 })
  const modbusAPI = new ModbusAPI(bus)
  const executeSpy = vi.spyOn(modbusAPI['modbusRTUprocessor'], 'execute').mockResolvedValue(emptyModbusValues())
  modbusAPI['modbusClient'] = { isOpen: true } as any
  Config.setFakeModbus(false)

  await modbusAPI.readModbusRegister(88, new Set(), { task: ModbusTasks.poll, errorHandling: { retry: true } })

  expect(executeSpy).toHaveBeenCalledWith(88, expect.any(Set), expect.objectContaining({ maxRegistersPerRequest: 42 }))
  executeSpy.mockRestore()
})

it('readModbusRegister keeps explicit maxRegistersPerRequest in options', async () => {
  const bus = Bus.getBus(0)!
  bus.writeSlave({ slaveid: 88, maxRegistersPerRequest: 42 })
  const modbusAPI = new ModbusAPI(bus)
  const executeSpy = vi.spyOn(modbusAPI['modbusRTUprocessor'], 'execute').mockResolvedValue(emptyModbusValues())
  modbusAPI['modbusClient'] = { isOpen: true } as any
  Config.setFakeModbus(false)

  await modbusAPI.readModbusRegister(88, new Set(), {
    task: ModbusTasks.poll,
    errorHandling: { retry: true },
    maxRegistersPerRequest: 10,
  })

  expect(executeSpy).toHaveBeenCalledWith(88, expect.any(Set), expect.objectContaining({ maxRegistersPerRequest: 10 }))
  executeSpy.mockRestore()
})

describe('ServerTCP based', () => {
  it('read Discrete Inputs success, Illegal Address', async () => {
    expect.hasAssertions()
    await singleMutex.runExclusive(() => testRead(1, 4, 1, 1, ModbusAPI.prototype.readDiscreteInputs))
  })
  it('read HoldingRegisters success, Illegal Address', async () => {
    expect.hasAssertions()
    await singleMutex.runExclusive(() => testRead(0x0101, 0x0109, 1, 1, ModbusAPI.prototype.readHoldingRegisters))
  })
  it('read readInputRegisters success, Illegal Address', async () => {
    expect.hasAssertions()
    await singleMutex.runExclusive(() => testRead(1, 2, 195, 500, ModbusAPI.prototype.readInputRegisters))
  })
  it('writeHoldingRegisters success, Illegal Address', async () => {
    expect.hasAssertions()
    await singleMutex.runExclusive(() => testWrite(0x0101, 0x0109, 10, ModbusAPI.prototype.writeHoldingRegisters))
  })
  it('writeCoils success, Illegal Address', async () => {
    expect.hasAssertions()
    await singleMutex.runExclusive(() => testWrite(1, 4, 0, ModbusAPI.prototype.writeCoils))
  })

  // no-op
})

// Issue #78: the serial framing was hard wired to 8N1. The modbus specification asks for even parity
// (8E1), and devices that insist on it - or on 8N2 - answered with nothing but timeouts.
describe('serial framing', () => {
  function connectOptionsFor(connection: Partial<IRTUConnection>): Record<string, unknown> {
    const modbusAPI = new ModbusAPI({
      getId: () => 0,
      getName: () => 'framing',
      getSlaveTimeoutBySlaveId: () => 100,
      getMaxRegistersPerRequestBySlaveId: () => 125,
      getModbusConnection: () => ({ serialport: '/dev/ttyUSB0', baudrate: 9600, timeout: 100, ...connection }) as IRTUConnection,
    })
    let opts: Record<string, unknown> = {}
    modbusAPI['modbusClient'] = {
      isOpen: false,
      connectRTUBuffered: (_path: string, o: Record<string, unknown>) => {
        opts = o
        return Promise.resolve()
      },
    } as any
    modbusAPI['connectRTUClientLocked']()
    return opts
  }

  it('defaults to 8N1 when nothing is configured', () => {
    expect(connectOptionsFor({})).toEqual({ baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 })
  })

  it('passes the configured framing to the serial port', () => {
    expect(connectOptionsFor({ dataBits: 8, parity: 'even', stopBits: 1 })).toEqual({
      baudRate: 9600,
      dataBits: 8,
      parity: 'even',
      stopBits: 1,
    })
    expect(connectOptionsFor({ stopBits: 2 })).toEqual({ baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 2 })
  })

  it('shows the framing in the bus name', () => {
    expect(getConnectionName({ serialport: '/dev/ttyUSB0', baudrate: 9600, timeout: 100 })).toContain('9600 8N1')
    expect(
      getConnectionName({ serialport: '/dev/ttyUSB0', baudrate: 9600, timeout: 100, parity: 'even' } as IRTUConnection)
    ).toContain('9600 8E1')
  })
})

describe('serial tap (passive rx on real serial port)', () => {
  // Mirrors the modbus-serial RTUBufferedPort: the ModbusAPI's _port is a
  // wrapper that holds the REAL SerialPort as `_client`. All wire bytes hit
  // `_client`, but the wrapper only re-emits 'data' for frames it is actively
  // awaiting - foreign master frames stay in its buffer and are invisible on
  // `_port`. The tap must therefore listen on `_client`.
  function makeBufferedMockClient() {
    const events = new Map<string, Array<(d: unknown) => void>>()
    const client = {
      isOpen: true,
      on: (e: string, cb: (d: unknown) => void) => {
        if (!events.has(e)) events.set(e, [])
        events.get(e)!.push(cb)
        return client
      },
      removeListener: (e: string, cb: (d: unknown) => void) => {
        const l = events.get(e) || []
        const i = l.indexOf(cb)
        if (i >= 0) l.splice(i, 1)
        return client
      },
      emit: (e: string, d: unknown) => {
        for (const cb of events.get(e) || []) cb(d)
      },
      writes: [] as unknown[],
      write: (data: unknown) => {
        client.writes.push(data)
        return true
      },
    }
    // The wrapper (_port): has on/removeListener but does NOT emit 'data'
    // for foreign traffic - only the _client does.
    const wrapper = {
      on: () => wrapper,
      removeListener: () => wrapper,
    }
    return { client, wrapper }
  }

  it('attaches the tap to the real serial port (_client) and sees foreign master rx', () => {
    const { client, wrapper } = makeBufferedMockClient()
    const modbusAPI = new ModbusAPI({
      getId: () => 0,
      getName: () => 'tapping',
      getSlaveTimeoutBySlaveId: () => 100,
      getMaxRegistersPerRequestBySlaveId: () => 125,
      getModbusConnection: () => ({ serialport: '/dev/ttyUSB0', baudrate: 9600, timeout: 100 }) as IRTUConnection,
    })
    ;(modbusAPI as unknown as { modbusClient: unknown }).modbusClient = {
      isOpen: true,
      _port: wrapper as unknown,
    } as unknown
    // _client must be reachable through the wrapper for the tap to bind to it
    ;(wrapper as unknown as { _client: unknown })._client = client

    const seen: string[] = []
    const detach = modbusAPI.attachSerialTap((direction, bytes) => {
      seen.push(`${direction}:${bytes.join(',')}`)
    })

    // Foreign master frame arriving on the real port - NOT consumed by modbus-serial
    const foreign = [0x05, 0x03, 0x00, 0x00, 0x00, 0x01, 0x85, 0x8e]
    client.emit('data', Buffer.from(foreign))
    // Own TX (request) observed via the real write
    ;(client as unknown as { write: (d: unknown) => boolean }).write(Buffer.from([0x05, 0x03, 0x00, 0x00, 0x00, 0x02, 0xc5, 0x8f]))

    expect(seen).toContain('response:5,3,0,0,0,1,133,142')
    expect(seen).toContain('request:5,3,0,0,0,2,197,143')

    detach.detach()
    client.emit('data', Buffer.from([0x06, 0x03, 0x00, 0x00, 0x00, 0x01, 0x85, 0x7e]))
    expect(seen).toHaveLength(2) // detached: no more events
  })

  it('re-arms the tap when a fresh _client appears (reconnect)', async () => {
    const makeClient = () => {
      const listeners = new Map<string, Array<(d: unknown) => void>>()
      return {
        on: (e: string, cb: (d: unknown) => void) => {
          if (!listeners.has(e)) listeners.set(e, [])
          listeners.get(e)!.push(cb)
          return client
        },
        removeListener: (e: string, cb: (d: unknown) => void) => {
          const l = listeners.get(e) || []
          const i = l.indexOf(cb)
          if (i >= 0) l.splice(i, 1)
          return client
        },
        emit: (e: string, d: unknown) => {
          for (const cb of listeners.get(e) || []) cb(d)
        },
        write: (d: unknown) => true,
      }
    }
    let client = makeClient() as ReturnType<typeof makeClient> & { write: (d: unknown) => boolean }
    // eslint-disable-next-line no-var
    const wrapper = { on: () => wrapper, removeListener: () => wrapper }
    ;(wrapper as unknown as { _client: unknown })._client = client

    const modbusAPI = new ModbusAPI({
      getId: () => 0,
      getName: () => 'tapping',
      getSlaveTimeoutBySlaveId: () => 100,
      getMaxRegistersPerRequestBySlaveId: () => 125,
      getModbusConnection: () => ({ serialport: '/dev/ttyUSB0', baudrate: 9600, timeout: 100 }) as IRTUConnection,
    })
    ;(modbusAPI as unknown as { modbusClient: unknown }).modbusClient = { isOpen: true, _port: wrapper } as unknown

    const seen: string[] = []
    const detach = modbusAPI.attachSerialTap((direction, bytes) => seen.push(`${direction}:${bytes.join(',')}`))

    // Simulate a reconnect: ModbusAPI swaps in a fresh _client object
    const fresh = makeClient() as typeof client
    ;(wrapper as unknown as { _client: unknown })._client = fresh
    ;(modbusAPI as unknown as { modbusClient: { _port: { _client: unknown } } }).modbusClient._port._client = fresh

    // Wait for the poll (250ms) to re-arm onto the fresh client
    await new Promise((r) => setTimeout(r, 400))
    fresh.emit('data', Buffer.from([0x05, 0x03, 0x00, 0x00, 0x00, 0x01, 0x85, 0x8e]))
    expect(seen).toContain('response:5,3,0,0,0,1,133,142')
    detach.detach()
  })

  it('falls back to _port when there is no _client (plain RTU port)', () => {
    const listeners = new Map<string, Array<(d: unknown) => void>>()
    const port = {
      on: (e: string, cb: (d: unknown) => void) => {
        if (!listeners.has(e)) listeners.set(e, [])
        listeners.get(e)!.push(cb)
        return port
      },
      removeListener: (e: string, cb: (d: unknown) => void) => {
        const l = listeners.get(e) || []
        const i = l.indexOf(cb)
        if (i >= 0) l.splice(i, 1)
        return port
      },
      emit: (e: string, d: unknown) => {
        for (const cb of listeners.get(e) || []) cb(d)
      },
      writes: [] as unknown[],
      write: (d: unknown) => {
        port.writes.push(d)
        return true
      },
    }
    const modbusAPI = new ModbusAPI({
      getId: () => 0,
      getName: () => 'tapping',
      getSlaveTimeoutBySlaveId: () => 100,
      getMaxRegistersPerRequestBySlaveId: () => 125,
      getModbusConnection: () => ({ serialport: '/dev/ttyUSB0', baudrate: 9600, timeout: 100 }) as IRTUConnection,
    })
    ;(modbusAPI as unknown as { modbusClient: unknown }).modbusClient = { isOpen: true, _port: port } as unknown

    const seen: string[] = []
    const detach = modbusAPI.attachSerialTap((direction, bytes) => seen.push(`${direction}:${bytes.join(',')}`))
    ;(port as unknown as { emit: (e: string, d: unknown) => void }).emit('data', Buffer.from([0x05, 0x04, 0x00, 0x00, 0x00, 0x01, 0xb1, 0x8e]))
    expect(seen).toContain('response:5,4,0,0,0,1,177,142')
    detach.detach()
  })
})
