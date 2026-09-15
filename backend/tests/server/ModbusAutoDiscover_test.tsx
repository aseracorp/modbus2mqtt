import { expect, it, beforeAll, afterAll } from 'vitest'
import { Config } from '../../src/server/config.js'
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
})

afterAll(() => {
  ModbusAutoDiscover.resetInstance()
  configTestHelper.restore()
  if (tempHelper) tempHelper.cleanup()
})

it('getDiscoveredServers returns empty when nothing discovered', () => {
  const ad = ModbusAutoDiscover.getInstance()
  expect(ad.getDiscoveredServers()).toEqual([])
})

it('blacklistServer persists the host:port to config', () => {
  const ad = ModbusAutoDiscover.getInstance()
  ad.blacklistServer('10.0.0.1', 502)
  const cfg = Config.getConfiguration()
  expect(cfg.modbusAutoDiscoverBlacklist).toContain('10.0.0.1:502')
})

it('blacklistServer filters discovered servers', () => {
  const ad = ModbusAutoDiscover.getInstance()
  // inject a discovered server manually
  ;(ad as any).discovered = [
    { name: 'a', host: '10.0.0.1', port: 502 },
    { name: 'b', host: '10.0.0.2', port: 502 },
  ]
  const before = ad.getDiscoveredServers()
  expect(before.some((s) => s.host === '10.0.0.1')).toBe(false) // blacklisted in prior test
  expect(before.some((s) => s.host === '10.0.0.2')).toBe(true)
})
