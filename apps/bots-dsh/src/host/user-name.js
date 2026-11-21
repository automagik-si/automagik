// The OS user name for a uid, shown as a machine reservation's owner (RFC 0024 R4) so an
// administrator knows whose file it is. /etc/passwd first; then `id -nu`, which also answers for
// users kept in a directory service, as every user on macOS is. A uid no source names reads
// `uid <n>`. Answers are cached for the process.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

const NAME = /^[A-Za-z0-9._][A-Za-z0-9._ -]{0,63}$/

export function createUserName({
  run = execFileSync, read = fs.readFileSync, self = () => process.getuid?.(),
} = {}) {
  const names = new Map()
  let passwd
  return uid => {
    if (names.has(uid)) return names.get(uid)
    let name
    try {
      if (uid === self()) name = os.userInfo().username
    } catch {}
    if (!name) {
      try {
        passwd ??= String(read('/etc/passwd', 'utf8')).split('\n').map(line => line.split(':'))
        name = passwd.find(([, , id]) => id === String(uid))?.[0]
      } catch {}
    }
    if (!name && Number.isSafeInteger(uid) && uid >= 0) {
      try {
        name = String(run('id', ['-nu', String(uid)], {
          encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
        })).trim()
      } catch {}
    }
    const answer = name && NAME.test(name) ? name : `uid ${uid}`
    names.set(uid, answer)
    return answer
  }
}

export const userName = createUserName()
