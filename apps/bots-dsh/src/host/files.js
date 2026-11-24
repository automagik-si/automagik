import fs from 'node:fs'
import { rename as move } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// On Windows a file cannot be replaced while another program has it open: another DSH
// reading the team's state, the search indexer, a virus scanner, a sync client. Those
// readers let go within moments.
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRIES = 6
const WAIT_MS = 40

function syncPath(path, flags) {
  const fd = fs.openSync(path, flags)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function syncFile(path, { parent = false } = {}) {
  syncPath(path, process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
  if (parent) syncContainingDirectory(path)
}

export function syncContainingDirectory(path) {
  if (process.platform !== 'win32') syncPath(dirname(path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
}

/**
 * Moves `temp` over `path`, retrying briefly when Windows reports it busy.
 * Durable writes sync the completed temp file and the directory entry that names
 * it. Their final authority check runs immediately before the synchronous rename.
 * Every retry also runs `check` again.
 */
export async function replaceFile(temp, path, check = () => {}, {
  durable = false, platform = process.platform, sleep = delay, rename = durable ? fs.renameSync : move,
} = {}) {
  if (durable) syncFile(temp)
  for (let attempt = 1; ; attempt += 1) {
    if (durable || attempt > 1) {
      const checked = check()
      if (checked !== undefined) await checked
    }
    try {
      const moved = rename(temp, path)
      if (moved !== undefined) await moved
      break
    } catch (error) {
      if (platform !== 'win32' || attempt >= TRIES || !BUSY.has(error?.code)) throw error
      await sleep(WAIT_MS * attempt)
    }
  }
  if (durable) syncContainingDirectory(path)
}
