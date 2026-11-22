import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runStartup } from '../entrypoint.mjs'
import { multiuserMode, startupDecision } from '../profile-multiuser.mjs'

test('mode parsing and startup launch order', async () => {
  for (const [value, mode] of [[undefined, 'off'], ['', 'off'], ['0', 'off'], ['1', 'on'], ['yes', 'invalid']]) {
    assert.equal(multiuserMode(value), mode)
    const events = []
    await runStartup({
      env: { AUTOMAGIK_MULTIUSER: value },
      launchCore: async () => { await Promise.resolve(); events.push('core') },
      launchDsh: () => events.push('dsh'),
      warn: message => events.push(message),
      exit: status => events.push(status),
    })
    assert.deepEqual(events, mode === 'off' ? ['core', 'dsh'] : [startupDecision(mode).reason, 1])
  }
})

test('multiuser startup pins the default or operator decision socket before local env loads',
  async t => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-env-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const workspaceEnv = join(dir, 'workspace.env'), profileEnv = join(dir, 'profile.env')
    const name = 'AUTOMAGIK_GATE_DECISION_SOCKET'
    writeFileSync(workspaceEnv, `${name}=/invalid-workspace-path\n`)
    writeFileSync(profileEnv, `${name}=redirected-by-profile\n`)
    const observed = join(dir, 'observed')
    const program = `
      const [observed, ...files] = process.argv.slice(1)
      for (const file of files) process.loadEnvFile(file)
      require('node:fs').writeFileSync(observed, process.env.AUTOMAGIK_GATE_DECISION_SOCKET)
    `
    for (const [configured, expected] of [
      [undefined, 'automagik-gate-decision'], ['operator-socket', 'operator-socket'],
    ]) {
      const env = { AUTOMAGIK_MULTIUSER: '1' }
      if (configured !== undefined) env[name] = configured
      let started = false
      await runStartup({
        env,
        readiness() {
          assert.equal(env[name], expected)
          return { ready: true }
        },
        launchCore() {},
        launchDsh() {
          const child = spawnSync(process.execPath,
            ['-e', program, observed, workspaceEnv, profileEnv], { env, stdio: 'ignore' })
          assert.ifError(child.error)
          assert.equal(child.status, 0)
          assert.equal(readFileSync(observed, 'utf8'), expected)
          started = true
        },
        warn: assert.fail, exit: assert.fail,
      })
      assert.equal(started, true)
    }
  })

test('multiuser startup refuses an invalid operator decision socket', async () => {
  const blocked = () => assert.fail('startup advanced with an invalid decision socket')
  const events = []
  await runStartup({
    env: { AUTOMAGIK_MULTIUSER: '1', AUTOMAGIK_GATE_DECISION_SOCKET: '/invalid-operator-path' },
    readiness: blocked, launchCore: blocked, launchDsh: blocked,
    warn: line => events.push(line), exit: code => events.push(code),
  })
  assert.deepEqual(events, ['Invalid gate decision socket name', 1])
})
