import { IBus, IRTUConnection } from '@shared/server'

/**
 * Compute the list of serial ports offered in the RTU tab of the bus editor.
 *
 * Devices that are already in use by *another* bus are filtered out so a port
 * can't be selected twice. The serial port of the bus currently being edited is
 * always kept (and appended if it isn't known to the OS device list, e.g. a
 * manually configured symlink like /dev/ttyModbus that `SerialPort.list()` does
 * not report) - otherwise the saved value would be invisible/uneditable in the
 * mat-select.
 */
export function filterSerialDevices(serialDevices: string[], busses: (IBus | null)[], bus: IBus | null): string[] {
  const devices = [...serialDevices]
  const current = bus != null ? (bus.connectionData as IRTUConnection).serialport : undefined
  for (let didx = 0; didx < devices.length; ) {
    const sd = devices[didx]
    const usedByOther = busses.some(
      (b) =>
        b != null &&
        b !== bus &&
        (b.connectionData as IRTUConnection).serialport != undefined &&
        (b.connectionData as IRTUConnection).serialport === sd
    )
    if (usedByOther) devices.splice(didx, 1)
    else didx++
  }
  if (current != undefined && current.length > 0 && !devices.includes(current)) {
    devices.unshift(current)
  }
  return devices
}
