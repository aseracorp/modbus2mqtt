import { expect, it } from 'vitest'
import { ModbusRegisterType } from '../../src/shared/specification/index.js'
import { ModbusRTUProcessor } from '../../src/server/modbusRTUprocessor.js'
import { ModbusRTUQueue } from '../../src/server/modbusRTUqueue.js'
import { ImodbusAddress, MAX_REGISTERS_PER_REQUEST_DEFAULT, ModbusTasks } from '../../src/shared/server/index.js'

function addAddresses(addresses: Set<ImodbusAddress>, registerType: ModbusRegisterType, startAddress: number, endAddress: number) {
  for (let idx = startAddress; idx < endAddress; idx++)
    addresses.add({
      address: idx,
      registerType: registerType,
    })
}

const defaultOptions = { task: ModbusTasks.deviceDetection, errorHandling: { retry: true } }

it('prepare', () => {
  const addresses = new Set<ImodbusAddress>()
  addAddresses(addresses, ModbusRegisterType.HoldingRegister, 0, 4)
  addAddresses(addresses, ModbusRegisterType.HoldingRegister, 7, 9)
  addAddresses(addresses, ModbusRegisterType.HoldingRegister, 27, 29)

  addAddresses(addresses, ModbusRegisterType.Coils, 0, 4)

  const queue = new ModbusRTUQueue()
  const modbusProcessor = new ModbusRTUProcessor(queue)
  const preparedAddresses = modbusProcessor['prepare'](1, addresses, MAX_REGISTERS_PER_REQUEST_DEFAULT)
  expect(preparedAddresses.addresses.length).toBe(3)
  expect(preparedAddresses.addresses[0].address).toBe(0)
  expect(preparedAddresses.addresses[0].length).toBe(4)
  expect(preparedAddresses.addresses[0].registerType).toBe(ModbusRegisterType.Coils)
  expect(preparedAddresses.addresses[1].address).toBe(0)
  expect(preparedAddresses.addresses[1].length).toBe(9)
  expect(preparedAddresses.addresses[1].registerType).toBe(ModbusRegisterType.HoldingRegister)
  expect(preparedAddresses.addresses[2].address).toBe(27)
  expect(preparedAddresses.addresses[2].length).toBe(2)
  expect(preparedAddresses.addresses[2].registerType).toBe(ModbusRegisterType.HoldingRegister)
})

it('prepare never exceeds maxRegistersPerRequest for sparse non-contiguous ranges', () => {
  const addresses = new Set<ImodbusAddress>()
  for (let a = 0; a <= 195; a += 5) {
    addresses.add({ address: a, registerType: ModbusRegisterType.HoldingRegister })
  }

  const queue = new ModbusRTUQueue()
  const modbusProcessor = new ModbusRTUProcessor(queue)
  const preparedAddresses = modbusProcessor['prepare'](1, addresses, 40)
  expect(preparedAddresses.addresses.length).toBeGreaterThan(1)
  preparedAddresses.addresses.forEach((chunk) => {
    expect(chunk.length).toBeLessThanOrEqual(40)
  })
})

it('prepare splits sparse ranges without filling address holes', () => {
  const addresses = new Set<ImodbusAddress>()
  ;[0, 5, 10, 15].forEach((a) => addresses.add({ address: a, registerType: ModbusRegisterType.HoldingRegister }))

  const queue = new ModbusRTUQueue()
  const modbusProcessor = new ModbusRTUProcessor(queue)
  const preparedAddresses = modbusProcessor['prepare'](1, addresses, 5)
  expect(preparedAddresses.addresses).toEqual([
    { address: 0, length: 1, registerType: ModbusRegisterType.HoldingRegister },
    { address: 5, length: 1, registerType: ModbusRegisterType.HoldingRegister },
    { address: 10, length: 1, registerType: ModbusRegisterType.HoldingRegister },
    { address: 15, length: 1, registerType: ModbusRegisterType.HoldingRegister },
  ])
})

it('prepare splits at per-slave maxRegistersPerRequest', () => {
  const addresses = new Set<ImodbusAddress>()
  addAddresses(addresses, ModbusRegisterType.HoldingRegister, 0, 100)

  const queue = new ModbusRTUQueue()
  const modbusProcessor = new ModbusRTUProcessor(queue)
  const preparedAddresses = modbusProcessor['prepare'](1, addresses, 90)
  expect(preparedAddresses.addresses.length).toBe(2)
  expect(preparedAddresses.addresses[0].address).toBe(0)
  expect(preparedAddresses.addresses[0].length).toBe(90)
  expect(preparedAddresses.addresses[1].address).toBe(90)
  expect(preparedAddresses.addresses[1].length).toBe(10)
})

it('execute', async () => {
  const addresses = new Set<ImodbusAddress>()
  addAddresses(addresses, ModbusRegisterType.HoldingRegister, 0, 4)
  addAddresses(addresses, ModbusRegisterType.HoldingRegister, 7, 9)
  addAddresses(addresses, ModbusRegisterType.Coils, 0, 4)

  const queue = new ModbusRTUQueue()
  const modbusProcessor = new ModbusRTUProcessor(queue)
  const resultPromise = modbusProcessor.execute(1, addresses, defaultOptions)
  // Wait for queue to be ready
  setTimeout(() => {
    const entries = queue.getEntries()
    queue.clear()
    entries.forEach((qe) => {
      if (qe.address.registerType == ModbusRegisterType.Coils) qe.onResolve(qe, [1, 1, 0, 0])
      else if (qe.address.address == 0 && qe.address.length != undefined && qe.address.length > 1) {
        const e: any = new Error('Timeout')
        e.errno = 'ETIMEDOUT'
        qe.onError(qe, e)
      }
    })
  }, 100)
  const result = await resultPromise
  expect(result.coils.size).toBe(4)
  result.coils.forEach((res) => {
    expect(res.error).not.toBeDefined()
    expect(res.data).toBeDefined()
  })
  expect(result.holdingRegisters.size).toBe(9)
  result.holdingRegisters.forEach((res) => {
    expect(res.error).toBeDefined()
    expect(res.data).not.toBeDefined()
  })
})
