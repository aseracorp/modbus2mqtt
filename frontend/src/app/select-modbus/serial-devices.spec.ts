import { describe, it, expect } from 'vitest'
import { IBus, IRTUConnection, ITCPConnection } from '@shared/server'
import { filterSerialDevices } from './serial-devices'

function rtuBus(busId: number, serialport: string): IBus {
  return {
    busId,
    connectionData: { serialport, baudrate: 9600, timeout: 100 } as IRTUConnection,
    slaves: [],
  } as IBus
}

function tcpBus(busId: number, host: string): IBus {
  return {
    busId,
    connectionData: { host, port: 502, timeout: 100 } as ITCPConnection,
    slaves: [],
  } as IBus
}

describe('filterSerialDevices', () => {
  it('keeps the configured port of the edited bus even when it is not in the OS device list', () => {
    // Regression for: bus is RTU with serialport /dev/ttyModbus, but SerialPort.list()
    // only reports real tty devices (e.g. /dev/ttyUSB0). The value must stay visible/editable.
    const busses: (IBus | null)[] = [rtuBus(1, '/dev/ttyUSB0'), rtuBus(2, '/dev/ttyModbus'), null]
    const devices = filterSerialDevices(['/dev/ttyUSB0'], busses, busses[1])
    expect(devices).toContain('/dev/ttyModbus')
    expect(devices).not.toContain('/dev/ttyUSB0')
  })

  it("removes devices that belong to another bus but keeps the edited bus's own device", () => {
    const busses: (IBus | null)[] = [rtuBus(1, '/dev/ttyUSB0'), rtuBus(2, '/dev/ttyUSB1'), null]
    const devices = filterSerialDevices(['/dev/ttyUSB0', '/dev/ttyUSB1'], busses, busses[1])
    expect(devices).toEqual(['/dev/ttyUSB1'])
  })

  it('when called without a bus, removes devices already in use (template uses this only to pick input vs select)', () => {
    const busses: (IBus | null)[] = [rtuBus(1, '/dev/ttyUSB0'), null]
    const devices = filterSerialDevices(['/dev/ttyUSB0', '/dev/ttyACM0'], busses, null)
    expect(devices).toEqual(['/dev/ttyACM0'])
  })

  it('ignores TCP-only busses when collecting used ports', () => {
    const busses: (IBus | null)[] = [tcpBus(1, '192.168.0.1'), rtuBus(2, '/dev/ttyUSB0'), null]
    const devices = filterSerialDevices(['/dev/ttyUSB0'], busses, busses[1])
    expect(devices).toEqual(['/dev/ttyUSB0'])
  })

  it('does not duplicate the current port when it is both configured and listed', () => {
    const busses: (IBus | null)[] = [rtuBus(1, '/dev/ttyUSB0'), null]
    const devices = filterSerialDevices(['/dev/ttyUSB0'], busses, busses[0])
    expect(devices.filter((d) => d === '/dev/ttyUSB0')).toHaveLength(1)
  })
})
