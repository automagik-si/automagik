// The stand-in for agy's browser opener during an in-app sign-in (#2048, owner): agy runs its
// opener by name from PATH with the sign-in link as its only argument. For the sign-in run only,
// a folder of this attempt's own leads that PATH with a script that opens nothing and appends
// the link to `links` in the attempt's folder. acp-dsh reads it from there, checks it
// (isSignInUrl) and hands it to the app, which shows it as a link with Copy; a person's click
// opens it. No environment variable, socket or listener carries anything: the folder is the
// channel, owner only, inside this installation's `acp` folder (the same file system agy already
// runs from).
import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { SIGN_IN_OPENERS, signInOpenerScript } from './agents.js'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
// An attempt lasts at most nativeSignInMs (10 minutes): an hour spares another live attempt.
export const STALE_MS = 60 * 60 * 1000
const MAX_READ = 64 * 1024

/** The folder that holds every attempt's own: `<acp>/sign-in`. */
export const signInRoot = acpHome => join(acpHome, 'sign-in')

/**
 * Makes this attempt's folder with its stand-in opener (`bin/xdg-open` on Linux, `bin/open` on
 * macOS), each owner only. Undefined where there is none (Windows), or when the folder's path
 * cannot be written into the script; whatever was made by then is removed.
 * @returns {{ dir: string, bin: string, links: string } | undefined}
 */
export function makeSignInOpener(acpHome, platform) {
  const name = SIGN_IN_OPENERS[platform]
  if (typeof name !== 'string' || typeof acpHome !== 'string') return undefined
  const dir = join(signInRoot(acpHome), randomUUID())
  const script = signInOpenerScript(dir)
  if (script === undefined) return undefined
  const bin = join(dir, 'bin')
  try {
    mkdirSync(signInRoot(acpHome), { recursive: true, mode: 0o700 })
    mkdirSync(dir, { mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    writeFileSync(join(bin, name), script, { mode: 0o700, flag: 'wx' })
    chmodSync(join(bin, name), 0o700)
  } catch {
    removeSignInOpener(dir)
    return undefined
  }
  return { dir, bin, links: join(dir, 'links') }
}

/** Removes an attempt's folder by its own path. */
export function removeSignInOpener(dir) {
  if (typeof dir !== 'string') return
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

/**
 * The complete lines handed over so far, at most 64 KiB of them. The file is opened without
 * following a link and without waiting (a FIFO planted there must not block DSH), and only a
 * regular file is read.
 * @returns {string[]}
 */
export function readSignInLinks(file) {
  let fd
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch { return [] }
  try {
    if (!fstatSync(fd).isFile()) return []
    const buffer = Buffer.alloc(MAX_READ)
    let size = 0
    for (;;) {
      const read = readSync(fd, buffer, size, MAX_READ - size, null)
      if (read <= 0) break
      size += read
      if (size >= MAX_READ) break
    }
    const text = buffer.subarray(0, size).toString('utf8')
    const end = text.lastIndexOf('\n')
    return end < 0 ? [] : text.slice(0, end).split('\n').filter(Boolean)
  } catch {
    return []
  } finally {
    try { closeSync(fd) } catch {}
  }
}

/**
 * Removes attempts left behind (a crash, a kill): only folders named like an attempt, older than
 * STALE_MS, each by its own path. Another installation's live attempt is newer and stays.
 */
export function sweepSignInOpeners(acpHome, now = Date.now()) {
  if (typeof acpHome !== 'string') return
  const root = signInRoot(acpHome)
  let names
  try { names = readdirSync(root) } catch { return }
  for (const name of names) {
    if (!UUID.test(name)) continue
    const path = join(root, name)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || now - stat.mtimeMs <= STALE_MS) continue
      rmSync(path, { recursive: true, force: true })
    } catch {}
  }
}
