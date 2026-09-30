import { expect, it, describe, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { ConfigPersistence } from '../../src/server/persistence/configPersistence.js'

let tempSslDir: string
let originalSslDir: string

beforeAll(() => {
  originalSslDir = ConfigPersistence.sslDir
  tempSslDir = fs.mkdtempSync(join(os.tmpdir(), 'sslfiles-test-'))
  // Top-level certificate files
  fs.writeFileSync(join(tempSslDir, 'fullchain.pem'), 'top-cert')
  fs.writeFileSync(join(tempSslDir, 'privkey.pem'), 'top-key')
  // Certificate in a subdirectory (e.g. dedicated mTLS folder)
  fs.mkdirSync(join(tempSslDir, 'mtls'), { recursive: true })
  fs.writeFileSync(join(tempSslDir, 'mtls', 'client.pem'), 'mtls-cert')
  fs.writeFileSync(join(tempSslDir, 'mtls', 'client.key'), 'mtls-key')
  ConfigPersistence.sslDir = tempSslDir
})

afterAll(() => {
  ConfigPersistence.sslDir = originalSslDir
  if (tempSslDir) fs.rmSync(tempSslDir, { recursive: true, force: true })
})

describe('listSslFiles (recursive)', () => {
  it('lists top-level certificate files', () => {
    const files = new ConfigPersistence().listSslFiles()
    expect(files).toContain('fullchain.pem')
    expect(files).toContain('privkey.pem')
  })

  it('lists certificates in subdirectories as relative forward-slash paths', () => {
    const files = new ConfigPersistence().listSslFiles()
    expect(files).toContain('mtls/client.pem')
    expect(files).toContain('mtls/client.key')
  })

  it('does not include directory entries themselves', () => {
    const files = new ConfigPersistence().listSslFiles()
    expect(files).not.toContain('mtls')
  })

  it('follows symlinks to files (Home Assistant /ssl style)', () => {
    fs.symlinkSync(join(tempSslDir, 'fullchain.pem'), join(tempSslDir, 'alias.pem'))
    fs.symlinkSync('/etc/hostname', join(tempSslDir, 'hostlink'))
    try {
      const files = new ConfigPersistence().listSslFiles()
      expect(files).toContain('alias.pem')
      expect(files).toContain('hostlink')
    } finally {
      fs.rmSync(join(tempSslDir, 'alias.pem'), { force: true })
      fs.rmSync(join(tempSslDir, 'hostlink'), { force: true })
    }
  })

  it('skips dangling symlinks without crashing', () => {
    fs.symlinkSync(join(tempSslDir, 'missing-target.pem'), join(tempSslDir, 'dangling.pem'))
    try {
      const files = new ConfigPersistence().listSslFiles()
      expect(files).not.toContain('dangling.pem')
    } finally {
      fs.rmSync(join(tempSslDir, 'dangling.pem'), { force: true })
    }
  })

  it('does not loop forever on a symlink cycle', () => {
    fs.mkdirSync(join(tempSslDir, 'loop'), { recursive: true })
    fs.symlinkSync(tempSslDir, join(tempSslDir, 'loop', 'back'))
    try {
      // Must terminate and still list the real files.
      const files = new ConfigPersistence().listSslFiles()
      expect(files).toContain('fullchain.pem')
    } finally {
      fs.rmSync(join(tempSslDir, 'loop'), { recursive: true, force: true })
    }
  })

  it('returns empty array when sslDir is not set', () => {
    const saved = ConfigPersistence.sslDir
    ConfigPersistence.sslDir = ''
    try {
      expect(new ConfigPersistence().listSslFiles()).toEqual([])
    } finally {
      ConfigPersistence.sslDir = saved
    }
  })
})

describe('readCertificateFile', () => {
  it('reads a top-level certificate file', () => {
    expect(new ConfigPersistence().readCertificateFile('fullchain.pem')).toBe('top-cert')
  })

  it('reads a certificate file from a subdirectory', () => {
    expect(new ConfigPersistence().readCertificateFile('mtls/client.pem')).toBe('mtls-cert')
  })

  it('returns undefined for a directory path', () => {
    expect(new ConfigPersistence().readCertificateFile('mtls')).toBeUndefined()
  })

  it('refuses path traversal outside the ssl directory', () => {
    expect(new ConfigPersistence().readCertificateFile('../../etc/passwd')).toBeUndefined()
  })

  it('returns undefined for a missing file', () => {
    expect(new ConfigPersistence().readCertificateFile('does-not-exist.pem')).toBeUndefined()
  })
})
