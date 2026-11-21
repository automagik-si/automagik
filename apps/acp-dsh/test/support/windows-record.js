import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_OWNER_ENV, recordLogin } from '../../src/host/login-ownership.js'
import { windowsJobName } from '../../src/host/windows-login.js'

const ownership = new URL('../../src/host/login-ownership.js', import.meta.url).href

function child(script, input) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], {
    stdio: ['ignore', 'ignore', 'inherit'], timeout: 15_000, windowsHide: true,
  })
  assert.ifError(run.error)
  assert.equal(run.status, 0)
  return run.pid
}

export const exitedPid = () => child('', null)
export const windowsBirth = { platform: 'win32', start: '1234567' }
export const proved = request => ({ job: 'absent', code: 2, processes: request.processes.map(() => 'dead') })

export function plantWindowsRecord(root, home, {
  ownPid = false, changing = false, supervisor = exitedPid(), member = exitedPid(), appBirth = windowsBirth,
} = {}) {
  const id = randomUUID()
  const job = windowsJobName(id)
  const control = join(root, 'login-jobs', id)
  mkdirSync(control, { recursive: true })
  const identity = { launch: id, pid: supervisor, start: '4321' }
  const members = { launch: id, processes: [{ pid: member, start: '5432' }] }
  writeFileSync(join(control, 'supervisor'), JSON.stringify(identity))
  writeFileSync(join(control, 'members'), JSON.stringify(members))
  let app
  if (ownPid) {
    app = process.pid
    recordLogin({ AUTOMAGIK_BOT_CLI_HOME: home, [LOGIN_OWNER_ENV]: `${app}-${id}` },
      { id, job, appBirth }).update({ kind: 'windows', supervisor })
  } else {
    app = child(`
      import { mkdirSync, writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { recordLogin, LOGIN_OWNER_ENV } from ${JSON.stringify(ownership)}
      const { home, id, job, appBirth, supervisor, changing } = JSON.parse(process.argv[1])
      const owner = process.pid + '-' + id
      recordLogin({ AUTOMAGIK_BOT_CLI_HOME: home, [LOGIN_OWNER_ENV]: owner },
        { id, job, appBirth }).update({ kind: 'windows', supervisor })
      if (changing) {
        const lock = join(home, 'changing')
        mkdirSync(lock)
        writeFileSync(join(lock, 'pid'), String(process.pid))
        writeFileSync(join(lock, 'owner'), owner)
        writeFileSync(join(lock, 'birth'), JSON.stringify(appBirth))
        writeFileSync(join(home, 'paused'), '')
      }
    `, { home, id, job, appBirth, supervisor, changing })
  }
  const file = join(home, 'login-trees', id)
  return { id, job, control, app, file, identity, members,
    record: { owner: `${app}-${id}`, app, appBirth, kind: 'windows', job, supervisor } }
}
