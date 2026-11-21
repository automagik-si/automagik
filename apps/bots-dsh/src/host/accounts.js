import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { fromWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'

const MAX_BYTES = 1 << 20
const OVERRIDE = 'AUTOMAGIK_ACCOUNTS_CODEX_HOME'
export const REFRESH = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:?\d\d)$/
const absolute = value => typeof value === 'string' && isAbsolute(value)
const observed = (file, account = null, lastRefresh = null) => ({ file, account, lastRefresh })

// Match the pack's fingerprint, including its UTF-16 code units.
function fingerprint(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) return null
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

function parseAuth(text) {
  let auth
  try { auth = JSON.parse(text) } catch { return observed('present') }
  const account = fingerprint(auth?.tokens?.account_id)
  const refresh = auth?.last_refresh
  return observed('present', /^[0-9a-f]{8}$/.test(account ?? '') ? account : null,
    typeof refresh === 'string' && REFRESH.test(refresh) ? refresh : null)
}

async function readAuth(path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) return observed('unreadable')
    const bytes = Buffer.allocUnsafe(MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null)
      if (bytesRead === 0) break
      size += bytesRead
    }
    return size > MAX_BYTES ? observed('unreadable') : parseAuth(bytes.toString('utf8', 0, size))
  } catch (error) {
    return observed(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : 'unreadable')
  } finally {
    await file?.close()
  }
}

export function install(rt, { env = process.env, homedir = osHomedir } = {}) {
  return windowEndpoint(rt, 'accounts-codex', async (_body, _signal, windowSeen) => {
    if (!fromWindow(windowSeen)) return { reason: 'desktop-only' }
    try {
      const home = absolute(env.HOME) ? env.HOME : homedir()
      const overridden = Object.hasOwn(env, OVERRIDE)
      const homeIsAbsolute = absolute(home)
      const fallback = homeIsAbsolute ? join(home, '.codex') : ''
      const given = overridden ? env[OVERRIDE] : fallback
      if (!absolute(given) || (overridden && (/\p{Cc}/u.test(given) || Buffer.byteLength(given) > 512))) {
        return { codex: { folder: '', ...observed('unreadable') }, proxy: 'unknown' }
      }
      const dir = normalize(given)
      const pathFromHome = homeIsAbsolute ? relative(home, dir) : dir
      const underHome = !isAbsolute(pathFromHome) && pathFromHome !== '..' && !pathFromHome.startsWith('..' + sep)
      const folder = underHome ? join('~', pathFromHome) : dir
      return { codex: { folder: folder.slice(0, 300), ...await readAuth(join(dir, 'auth.json')) }, proxy: 'unknown' }
    } catch {
      return { reason: 'failed', message: "Could not read this computer's accounts." }
    }
  }, { read: true })
}
