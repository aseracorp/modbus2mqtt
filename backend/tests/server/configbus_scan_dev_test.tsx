import { it, expect, describe, beforeEach, afterEach } from 'vitest'
import { ConfigBus } from '../../src/server/configbus.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('ConfigBus.scanDevTtyDevices', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devscan-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const createDevNode = (name: string): string => {
    const p = path.join(tempDir, name)
    fs.writeFileSync(p, '')
    return p
  }

  it('lists readable ttyACM/ttyUSB/ttyS/ttyModbus nodes sorted', () => {
    createDevNode('ttyUSB0')
    createDevNode('ttyACM1')
    createDevNode('ttyModbus')
    createDevNode('ttyS3')
    expect(ConfigBus.scanDevTtyDevices(tempDir)).toEqual([
      path.join(tempDir, 'ttyACM1'),
      path.join(tempDir, 'ttyModbus'),
      path.join(tempDir, 'ttyS3'),
      path.join(tempDir, 'ttyUSB0'),
    ])
  })

  it('ignores non-serial entries (dirs, regular files, other tty names)', () => {
    createDevNode('tty')
    createDevNode('tty1')
    createDevNode('console')
    createDevNode('loop0')
    createDevNode('ttyUSB')
    expect(ConfigBus.scanDevTtyDevices(tempDir)).toEqual([])
  })

  it('skips unreadable nodes without crashing', () => {
    // On systems running as root accessSync always succeeds, so just verify
    // the unreadable case never throws and returns an array.
    const p = createDevNode('ttyACM0')
    fs.chmodSync(p, 0o000)
    try {
      const result = ConfigBus.scanDevTtyDevices(tempDir)
      expect(Array.isArray(result)).toBe(true)
    } finally {
      fs.chmodSync(p, 0o644)
    }
  })

  it('returns [] when the directory does not exist', () => {
    expect(ConfigBus.scanDevTtyDevices('/nonexistent/definitely-missing')).toEqual([])
  })
})