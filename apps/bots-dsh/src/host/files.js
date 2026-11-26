import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { open, rename as move } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// On Windows a file cannot be replaced while another program has it open: another DSH
// reading the team's state, the search indexer, a virus scanner, a sync client. Those
// readers let go within moments.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRIES = 6
const WAIT_MS = 40
const NO_DIRECTORY_SYNC = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'])

async function syncPath(path, flags) {
  const handle = await open(path, flags)
  try { await handle.sync() } finally { await handle.close() }
}

export const syncFile = path => syncPath(path, 'r+')

export async function syncDirectory(path) {
  if (process.platform === 'win32') return
  try { await syncPath(path, 'r') } catch (error) {
    if (!NO_DIRECTORY_SYNC.has(error?.code)) throw error
  }
}

// Startup imports and the review key use synchronous, exclusive publication.
export function syncDirectorySync(path) {
  if (process.platform === 'win32') return
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0))
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } catch (error) {
    if (!NO_DIRECTORY_SYNC.has(error?.code)) throw error
  }
}

const publicationPrefix = name => `.${name}.publish-`
export const isHostPublicationTemp = (file, name) => file.startsWith(publicationPrefix(name)) &&
  /^[a-f0-9-]{36}\.tmp$/.test(file.slice(publicationPrefix(name).length))

// The only extra link allowed is the publisher's own private temporary.
// It can survive a process stop between the link and the unlink.
export function hasOnlyHostPublicationLinks(path, info) {
  return info.nlink === 1 || (info.nlink === 2 && fs.readdirSync(dirname(path)).some(name => {
    if (!isHostPublicationTemp(name, basename(path))) return false
    const temp = fs.lstatSync(join(dirname(path), name), { throwIfNoEntry: false })
    return temp?.isFile() && temp.dev === info.dev && temp.ino === info.ino
  }))
}

export function publishHostFile(path, bytes) {
  const dir = dirname(path)
  const temp = join(dir, `${publicationPrefix(basename(path))}${randomUUID()}.tmp`)
  const fd = fs.openSync(temp, 'wx', 0o600)
  try {
    try {
      fs.writeFileSync(fd, bytes)
      fs.fsyncSync(fd)
    } finally { fs.closeSync(fd) }
    fs.linkSync(temp, path)
  } finally { fs.rmSync(temp, { force: true }) }
  syncDirectorySync(dir)
}

/**
 * Moves `temp` over `path`, trying again for a moment while Windows reports `path` busy.
 * `check` runs before each new try and can throw or reject to stop, as when the lock that allows the
 * write was lost in the meantime. `options` injects what only a test has to decide: the
 * platform that makes busy codes retried, the wait between tries, and the move itself
 * (no runner makes a real rename fail with EBUSY).
 */
export async function replaceFile(temp, path, check = () => {}, { platform = process.platform, sleep = delay, rename = move } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rename(temp, path)
    } catch (error) {
      if (platform !== 'win32' || attempt >= TRIES || !BUSY.has(error?.code)) throw error
      await sleep(WAIT_MS * attempt)
      const checked = check()
      if (checked !== undefined) await checked
    }
  }
}
