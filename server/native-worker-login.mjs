import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

// The pilot image's one pointer export (#1509): it names this installation's ACP current/
// directory through a vendor pointer, and the reader derives each vendor's pointer as
// dirname(value)/<vendor>. The marker says a launch must carry a valid pointer and record. It is
// not auth and reads no credential; unset leaves today's behaviour.
export const BOT_CLI_POINTER_ENV = 'AUTOMAGIK_BOT_CLI_POINTER'
export const NATIVE_WORKER_LOGIN_ENV = 'AUTOMAGIK_NATIVE_WORKER_LOGIN'
export const NATIVE_WORKER_LOGIN_REQUIRED = 'required'

// The same root decision as acp-dsh's installationCliHome (apps/acp-dsh/src/host/installation.js,
// #1769), read-only: the shared <acp>/cli-homes only when its claim is absent (the panel will
// claim it at its start) or names this DSH home; any other claim, or one that cannot be read,
// means the panel signs in under its own installations/<digest>/cli-homes. Exporting the shared
// root then would put a worker on another installation's account. The parity test runs both.
const CLAIM_LIMIT = 4096

export function installationIdentity(dshHome) {
  const home = dshHome?.trim() ? dshHome : '~/.dsh'
  const path = home === '~' ? homedir()
    : /^~[\\/]/.test(home) ? `${homedir()}${sep}${home.slice(2)}` : home
  try { return realpathSync.native(path) } catch { return resolve(path) }
}

function claimedIdentity(path) {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    return null
  }
  if (!stat.isFile() || stat.size > CLAIM_LIMIT) return null
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > CLAIM_LIMIT) return null
    const bytes = Buffer.alloc(CLAIM_LIMIT + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > CLAIM_LIMIT) return null
    const claim = JSON.parse(bytes.toString('utf8', 0, length))
    return claim?.version === 1 && typeof claim.identity === 'string'
      && isAbsolute(claim.identity) && !claim.identity.includes('\0') ? claim.identity : null
  } catch (error) {
    return error.code === 'ENOENT' ? undefined : null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function panelCliHomes(acpHome, dshHome) {
  const legacy = join(acpHome, 'cli-homes')
  const identity = installationIdentity(dshHome)
  const claimed = claimedIdentity(join(legacy, 'installation.json'))
  if (claimed === undefined || claimed === identity) return legacy
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  return join(acpHome, 'installations', digest, 'cli-homes')
}

export function nativeWorkerEnv(env) {
  const acpHome = join(resolve(env.AUTOMAGIK_HOME || '/data'), 'acp')
  env[BOT_CLI_POINTER_ENV] = join(panelCliHomes(acpHome, env.DSH_HOME), 'current', 'claude')
  env[NATIVE_WORKER_LOGIN_ENV] = NATIVE_WORKER_LOGIN_REQUIRED
  return env
}
