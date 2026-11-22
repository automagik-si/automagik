import * as filesystem from 'node:fs'
import { createHash, createPublicKey } from 'node:crypto'
import { isAbsolute } from 'node:path'

const MAX_BYTES = 16 * 1024
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = filesystem.constants

function isReadOnly(id, text) {
  const row = text.split('\n').find(line => line.startsWith(`${id} `))
  return row?.split(' ')[5]?.split(',').includes('ro')
}

function readKeys(fs, fd, expectedInstance) {
  const raw = Buffer.alloc(MAX_BYTES + 1)
  let size = 0
  while (size < raw.length) {
    const count = fs.readSync(fd, raw, size, raw.length - size, null)
    if (!count) break
    size += count
  }
  if (size > MAX_BYTES) throw new Error('Caller key file is too large')
  const { version, instance, keys } = JSON.parse(raw.subarray(0, size))
  if (version !== 1 || typeof instance !== 'string' || !instance ||
      (expectedInstance !== undefined && expectedInstance !== instance) ||
      !Array.isArray(keys) || keys.length < 1 || keys.length > 2) throw new Error('Invalid caller key set')
  const entries = new Map()
  for (const { x, kid, alg, crv, d } of keys) {
    if (typeof x !== 'string' || alg !== 'EdDSA' || crv !== 'Ed25519' || d !== undefined) throw new Error('Invalid caller key')
    const rawKey = Buffer.from(x, 'base64url')
    const derived = createHash('sha256').update(rawKey).digest().subarray(0, 16).toString('base64url')
    if (rawKey.length !== 32 || rawKey.toString('base64url') !== x || kid !== derived || entries.has(kid)) {
      throw new Error('Invalid caller key id')
    }
    const key = createPublicKey({ key: { kty: 'OKP', crv, x }, format: 'jwk' })
    entries.set(kid, { key, instance })
  }
  return entries
}

export function createKeySource({ file, expectedInstance, monotonicNow = () => performance.now(), fs = filesystem,
  mountinfo = () => fs.readFileSync('/proc/self/mountinfo', 'utf8'),
}) {
  let keys = new Map(), identity, refreshed = -Infinity, failed = false
  return {
    get(kid) {
      const time = monotonicNow()
      if (failed && time - refreshed < 1000) return undefined
      let fd
      try {
        if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('Untrusted caller key path')
        fd = fs.openSync(file, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0))
        const stat = fs.fstatSync(fd)
        const id = /^mnt_id:\s+(\d+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
        if (!stat.isFile() || stat.size > MAX_BYTES || !id || fs.readlinkSync(`/proc/self/fd/${fd}`) !== file) {
          throw new Error('Untrusted caller key file')
        }
        const next = `${id}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
        const age = time - refreshed
        if (failed || next !== identity || age >= 60_000 || (!keys.has(kid) && age >= 1000)) {
          refreshed = time
          if (!isReadOnly(id, mountinfo())) throw new Error('Untrusted caller key mount')
          keys = readKeys(fs, fd, expectedInstance)
          identity = next
          failed = false
        }
        return keys.get(kid)
      } catch {
        refreshed = time
        failed = true
        keys.clear()
        return undefined
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
      }
    },
  }
}
