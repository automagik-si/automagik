import { lstatSync } from 'node:fs'
import { userInfo } from 'node:os'
import { posix } from 'node:path'
import { runChild, tracing } from '../bw/run.js'
import { itemOf, loginKeychain } from './parse.js'

const security = '/usr/bin/security'
const namePattern = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.keychain(-db)?$/
export const keychainDirectory = home => posix.join(home, 'Library', 'Keychains')

export function validKeychainPath(home, path) {
  return typeof home === 'string' && posix.isAbsolute(home) && typeof path === 'string'
    && path.isWellFormed() && !path.includes('\0') && posix.dirname(path) === keychainDirectory(home)
    && namePattern.test(posix.basename(path))
}

export function ownedKeychain(path) {
  try {
    const file = lstatSync(path)
    return file.isFile() && file.uid === process.getuid()
  } catch { return false }
}

export function runSecurity(args, limits, {
  platform = process.platform, home, keychainPath, file = security, spawnChild,
} = {}) {
  if (platform !== 'darwin' || tracing()) return Promise.resolve({ failure: 'refused' })
  try {
    home ??= userInfo().homedir
    const path = keychainPath ?? posix.join(keychainDirectory(home), loginKeychain)
    const [command, serviceFlag, service, accountFlag, account, next] = args
    const read = next === '-g'
    if (!validKeychainPath(home, path) || command !== 'find-generic-password' || serviceFlag !== '-s' || accountFlag !== '-a'
      || args.length !== (read ? 8 : 7) || args.at(-2) !== path || args.at(-1) !== path
      || itemOf(path, service, account) === undefined || !ownedKeychain(path)) {
      return Promise.resolve({ failure: 'refused' })
    }
    return runChild(args, limits, { platform, spawnChild },
      () => ({ HOME: home, PATH: '/usr/bin:/bin', LANG: 'C' }),
      () => ({ file, prefix: [] }), {})
  } catch { return Promise.resolve({ failure: 'refused' }) }
}
