import { expect, it, beforeAll, afterAll, vi } from 'vitest'
import { ConfigBus } from '../../src/server/configbus.js'
import { ModbusAutoDiscover } from '../../src/server/ModbusAutoDiscover.js'
import { setConfigsDirsForTest } from './configsbase.js'
import { ConfigTestHelper, TempConfigDirHelper } from './testhelper.js'

setConfigsDirsForTest()

let configTestHelper: ConfigTestHelper
let tempHelper: TempConfigDirHelper

beforeAll(async () => {
  tempHelper = new TempConfigDirHelper('modbus_autodiscover_test')
  tempHelper.setup()
  configTestHelper = new ConfigTestHelper('modbus-autodiscover-test')
  configTestHelper.setup()
  // Initialize the static bus registry (the real app calls this at startup)
  ConfigBus.readBusses()
})

afterAll(() => {
  ModbusAutoDiscover.resetInstance()
  configTestHelper.restore()
  if (tempHelper) tempHelper.cleanup()
})

it('hasTcpBus detection', () => {
  const ad = ModbusAutoDiscover.getInstance()
  // Capture baseline (other tests may have populated the static registry)
  const baseline = ConfigBus.getBussesProperties().some((b) => !!(b.connectionData as { host?: string }).host)
  // Set nothing; just ensure it reports a boolean matching the registry
  expect(typeof (ad as any).hasTcpBus()).toBe('boolean')
  expect((ad as any).hasTcpBus()).toBe(baseline)
})

it('tryAddBus adds the connection when the endpoint is reachable', async () => {
  const ad = ModbusAutoDiscover.getInstance()
  const before = ConfigBus.getBussesProperties().length
  const clientMock = { connectTCP: vi.fn(() => Promise.resolve()), close: vi.fn((cb) => cb && cb()) }
  const ok = await (ad as any).tryAddBusWithClient(clientMock, '10.1.2.3', 502, 'test-device')
  expect(ok).toBe(true)
  const busses = ConfigBus.getBussesProperties()
  expect(busses.length).toBe(before + 1)
  const added = busses[busses.length - 1]
  expect(added.connectionData).toMatchObject({ host: '10.1.2.3', port: 502 })
})

it('tryAddBus does not add when the endpoint is unreachable', async () => {
  const ad = ModbusAutoDiscover.getInstance()
  const before = ConfigBus.getBussesProperties().length
  const clientMock = { connectTCP: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))), close: vi.fn((cb) => cb && cb()) }
  const ok = await (ad as any).tryAddBusWithClient(clientMock, '10.9.9.9', 502, 'bad-device')
  expect(ok).toBe(false)
  expect(ConfigBus.getBussesProperties().length).toBe(before)
})
