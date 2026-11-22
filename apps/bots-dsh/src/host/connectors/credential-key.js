import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export const CONNECTOR_KEY = 'connector-key'
export const CONNECTOR_KEY_ORIGINS = 'connector-key-origins'
export const KEY_ERROR = 'Could not encrypt the connector credentials. Check the Bot team home and try again.'
export const CREDENTIAL_UNAVAILABLE = 'Connector credentials are unavailable. Restore the matching connector key and try again.'
export const keyFileName = name => name === CONNECTOR_KEY || /^connector-key\.[^\\/]+\.tmp$/.test(name)

export const connectorKeyOriginName = path => createHash('sha256').update(path).digest('hex')

export function readConnectorKeyOrigins(home) {
  const path = join(home, CONNECTOR_KEY_ORIGINS)
  let entries
  try { entries = fs.readdirSync(path, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}$/.test(entry.name)).map(({ name }) => {
    const origin = fs.readFileSync(join(path, name), 'utf8')
    if (!isAbsolute(origin) || connectorKeyOriginName(origin) !== name) throw new Error('The Bot team connector key origin could not be read.')
    return origin
  })
}

export function readConnectorKey(path) {
  let fd
  try {
    // lstat also excludes symlinks on systems without O_NOFOLLOW.
    const entry = fs.lstatSync(path, { bigint: true })
    if (!entry.isFile()) return {}
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
    fd = fs.openSync(path, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0))
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== 32n
      || (process.platform !== 'win32' && (stat.mode & 0o7777n) !== 0o600n)
      || (process.getuid !== undefined && stat.uid !== BigInt(process.getuid()))) return {}
    const bytes = Buffer.alloc(33)
    let count = 0
    while (count < bytes.length) {
      const size = fs.readSync(fd, bytes, count, bytes.length - count, null)
      if (size === 0) break
      count += size
    }
    const current = fs.lstatSync(path, { bigint: true })
    if (count !== 32 || current.dev !== stat.dev || current.ino !== stat.ino || current.ctimeNs !== stat.ctimeNs) return {}
    const hash = createHash('sha256').update(bytes.subarray(0, count)).digest('hex')
    return { bytes: bytes.subarray(0, count), kid: hash.slice(0, 16), identity: `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${hash}` }
  } catch (error) {
    return { missing: fd === undefined && error?.code === 'ENOENT' }
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

export function publishConnectorKey(path, bytes = randomBytes(32)) {
  const home = dirname(path)
  const temp = join(home, `${CONNECTOR_KEY}.${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, bytes)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.linkSync(temp, path)
    if (process.platform !== 'win32') {
      const dir = fs.openSync(home, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
      try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
    }
  } finally {
    fs.unlinkSync(temp)
  }
}
