import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('./fixtures/installation-child.mjs', import.meta.url)
const preload = new URL('./harness-resolve.mjs', import.meta.url).href

function start(shared, installation) {
  const home = join(shared, 'home')
  const child = fork(script, [shared], {
    execArgv: ['--import', preload],
    env: { ...process.env, DSH_HOME: installation, HOME: home, USERPROFILE: home,
      AUTOMAGIK_APP_BROWSER: '0', AUTOMAGIK_PNPM: '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const exited = new Promise(resolve => {
    child.once('error', resolve)
    child.once('exit', (code, signal) => resolve(new Error(`ACP child exited (${signal ?? code})`)))
  })
  const request = async (action, id, email) => {
    const reply = once(child, 'message', { signal: AbortSignal.timeout(7000) }).then(([response]) => response)
    const sent = new Promise((resolve, reject) => {
      child.send({ action, id, email }, error => error ? reject(error) : resolve())
    })
    const [response] = await Promise.race([
      Promise.all([reply, sent]),
      exited.then(error => { throw error }),
    ])
    if (response.error) throw Object.assign(new Error(response.error.message), response.error)
    return response.value
  }
  const stop = async () => {
    if (child.connected) child.disconnect()
    const kill = setTimeout(() => child.kill(), 1000)
    try { await exited } finally { clearTimeout(kill) }
  }
  return { request, stop }
}

async function pair(t, sameInstallation) {
  const shared = mkdtempSync(join(tmpdir(), 'acp-two-installations-'))
  const hosts = []
  t.after(async () => {
    await Promise.all(hosts.map(host => host.stop()))
    rmSync(shared, { recursive: true, force: true })
  })
  mkdirSync(join(shared, 'home'))
  const a = start(shared, join(shared, 'dsh-a'))
  hosts.push(a)
  const first = await a.request('ready')
  const b = start(shared, join(shared, sameInstallation ? 'dsh-a' : 'dsh-b'))
  hosts.push(b)
  const second = await b.request('ready')
  return { a, b, acpHome: join(shared, 'acp'), first, second }
}

function expectAccount(state, email) {
  assert.equal(state.signedIn, email !== undefined)
  assert.equal(state.account?.email, email)
  assert.equal(state.consent, email === undefined ? undefined : 'given')
}

test('two processes sharing ACP storage can change accounts from distinct DSH homes',
  { timeout: 20_000 }, async t => {
    const { a, b, acpHome, first, second } = await pair(t, false)
    for (const result of [first, second]) assert.equal(result.acpHome, acpHome)

    for (const vendor of ['claude', 'codex']) {
      const id = `acp-${vendor}`
      const expected = new Map()
      for (const action of ['login', 'switch', 'sign-out']) {
        for (const [side, host, peer] of [['a', a, b], ['b', b, a]]) {
          const email = action === 'sign-out' ? undefined : `${side}-${vendor}-${action}@example.test`
          await host.request(action, id, email)
          expectAccount(await peer.request('read', id), expected.get(peer))
          expectAccount(await host.request('read', id), email)
          expected.set(host, email)
        }
      }
      assert.notEqual(first.roots[vendor], second.roots[vendor])
      assert.equal([first.roots[vendor], second.roots[vendor]]
        .filter(root => root === join(acpHome, 'cli-homes')).length, 1)
    }
  })

test('two processes using one DSH home still refuse account changes',
  { timeout: 20_000 }, async t => {
    const { b, acpHome, first, second } = await pair(t, true)
    assert.deepEqual(second, first)
    for (const vendor of ['claude', 'codex']) {
      assert.equal(second.roots[vendor], join(acpHome, 'cli-homes'))
      await assert.rejects(b.request('login', `acp-${vendor}`, 'shared@example.test'), {
        code: 'acp-account/busy', message: /Close other Automagik sessions/,
      })
    }
  })
