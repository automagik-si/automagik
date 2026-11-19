// Two parts of #970 (experience review 6 and 8).
//
// 6. A first start without network left the agent missing until the next check, hours later.
//    A check that could not reach npm is now known as that, and the install is tried again by
//    itself after 1, 5, 15 and 60 minutes while the connector is missing. What the row says is
//    not changed here.
// 8. Every failed sign-in read the same to the person and left nothing in the log. An attempt
//    that fails now logs a fixed class, where it stood, how the CLI ended and its version.
//    Never what the CLI printed.
//
// No network or real CLI. The retry clock is scripted. The configured registry cases use a fake pnpm.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { apply, CHECK_RETRY_MS, SERVICE } from '../index.js'
import { AGENTS } from '../src/host/agents.js'
import { AdapterStore, latestVersion, registryUnreachable } from '../src/host/install.js'
import { CliLogins, LINK_TTL_MS, STARTUP_MS } from '../src/host/login.js'

const CLAUDE = AGENTS['acp-claude']
const CODEX = AGENTS['acp-codex']
const settle = () => new Promise(resolve => setImmediate(resolve))

// --- 6a. the version check says when it could not reach npm -------------------------------------

const rejected = promise => promise.then(() => assert.fail('it must not answer'), error => error)

test('#970.6: a check that cannot reach npm rejects with the very error it got, and is known as unreachable', async () => {
  const offline = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), { code: 'ENOTFOUND' }) })
  const error = await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => { throw offline } }))
  assert.equal(error, offline, 'the same object: its type, name, message and cause are untouched')
  assert.equal(error.code, undefined)
  assert.equal(registryUnreachable(error), 'ENOTFOUND')
  // undici's own codes, one level deeper or on the error itself.
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { cause: { code: 'ECONNREFUSED' } }) })
  assert.equal(registryUnreachable(await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => { throw refused } }))), 'ECONNREFUSED')
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
  assert.equal(registryUnreachable(await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => { throw reset } }))), 'ECONNRESET')
  // The whole list, one by one.
  const codes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
  for (const code of codes) {
    const failure = Object.assign(new TypeError('fetch failed'), { cause: { code } })
    assert.equal(registryUnreachable(await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => { throw failure } }))), code)
  }
})

test('#970.6: the check\'s own deadline is "timeout"; an abort that is not its own is not', async (t) => {
  // A fetch that never answers and ends when its signal does, with the signal's own reason.
  const hung = (_url, { signal }) => new Promise((_, fail) => { signal.addEventListener('abort', () => fail(signal.reason), { once: true }) })
  // The deadline's timer does not hold the event loop by itself: the row holds it meanwhile.
  const keep = setInterval(() => {}, 1 << 30)
  t.after(() => clearInterval(keep))
  const late = await rejected(latestVersion(CLAUDE.adapter, { fetch: hung, timeoutMs: 1 }))
  assert.equal(late.name, 'TimeoutError', 'the deadline\'s own error, as before')
  assert.equal(registryUnreachable(late), 'timeout')
  // The same with a caller's signal alive beside it (the stores always pass one).
  const alive = new AbortController()
  const lateToo = await rejected(latestVersion(CLAUDE.adapter, { signal: alive.signal, fetch: hung, timeoutMs: 1 }))
  assert.equal(lateToo.name, 'TimeoutError')
  assert.equal(registryUnreachable(lateToo), 'timeout')
  // DSH quitting stops the check: that is not the network.
  const quit = new AbortController()
  const stopping = rejected(latestVersion(CLAUDE.adapter, { signal: quit.signal, fetch: hung, timeoutMs: 60_000 }))
  quit.abort()
  const stopped = await stopping
  assert.equal(stopped, quit.signal.reason)
  assert.equal(registryUnreachable(stopped), undefined)
  // An error that only looks like a timeout is not this check's deadline.
  const lookalike = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  assert.equal(registryUnreachable(await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => { throw lookalike } }))), undefined)
})

test('#970.6: only a closed list of connection failures counts; anything else is what it was', async () => {
  const unknown = [
    new TypeError('Failed to parse URL'),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'SEE_HOME_ME_NPMRC' } }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_INVALID_URL' } }),
    Object.assign(new Error('x'), { code: 42 }),
    new Error('a bug in the caller'),
  ]
  for (const failure of unknown) {
    const error = await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => { throw failure } }))
    assert.equal(error, failure)
    assert.equal(registryUnreachable(error), undefined, failure.message)
  }
  // npm answered: whatever the status, npm was reached.
  for (const status of [400, 404, 408, 429, 500, 503]) {
    const error = await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => ({ ok: false, status }) }))
    assert.equal(error.message, `npm answered ${status} for ${CLAUDE.adapter}`)
    assert.equal(registryUnreachable(error), undefined, String(status))
  }
  const odd = await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => ({ ok: true, json: async () => ({ version: 'latest' }) }) }))
  assert.match(odd.message, /npm gave no version/)
  assert.equal(registryUnreachable(odd), undefined)
  // An answer that is not JSON is not the network either; a connection lost while it is read is.
  const garbled = new SyntaxError('Unexpected token < in JSON')
  assert.equal(registryUnreachable(await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => ({ ok: true, json: async () => { throw garbled } }) }))), undefined)
  const dropped = Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })
  const error = await rejected(latestVersion(CLAUDE.adapter, { fetch: async () => ({ ok: true, json: async () => { throw dropped } }) }))
  assert.equal(error, dropped)
  assert.equal(registryUnreachable(error), 'UND_ERR_SOCKET')
  assert.equal(await latestVersion(CLAUDE.adapter, { fetch: async () => ({ ok: true, json: async () => ({ version: '1.2.3' }) }) }), '1.2.3')
  for (const junk of [undefined, null, 'fetch failed', 7]) assert.equal(registryUnreachable(junk), undefined)
})

function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'acp-check-retry-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

test('#970.6: the store\'s record says a check could not reach npm, and everything else in it is as it was', async (t) => {
  const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  const store = new AdapterStore({ home: scratch(t), latest: pkg => latestVersion(pkg, { fetch: async () => { throw offline } }), install: async () => assert.fail('nothing is installed') })
  assert.equal(await rejected(store.update(CLAUDE.adapter, CLAUDE.bin)), offline)
  const failure = store.lastFailure(CLAUDE.adapter)
  assert.equal(failure.message, 'fetch failed')
  assert.equal(store.lastError(CLAUDE.adapter), 'fetch failed')
  assert.equal(failure.diagnostic, 'fetch failed')
  assert.equal(failure.unreachable, 'ENOTFOUND')
  // Any other failure has no such field, and an error that claims to be one is not believed.
  const claims = Object.assign(new Error('npm answered 404 for it'), { unreachable: 'ENOTFOUND', code: 'acp_registry_unreachable', reason: 'ENOTFOUND' })
  const other = new AdapterStore({ home: scratch(t), latest: async () => { throw claims }, install: async () => {} })
  await assert.rejects(other.update(CLAUDE.adapter, CLAUDE.bin))
  assert.deepEqual(Object.keys(other.lastFailure(CLAUDE.adapter)).sort(), ['diagnostic', 'logPath', 'message'])
})

const FIXTURE_REGISTRY = 'https://registry.example.test/'
const FIXTURE_VERSION = '7.7.7'

function registryStore(t) {
  const root = scratch(t)
  const offline = join(root, 'offline')
  const pnpm = join(root, 'pnpm')
  writeFileSync(pnpm, `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    --registry*|--config.registry*) exit 1 ;;
  esac
done
if [ -f "\${0%/*}/offline" ]; then
  printf '%s\\n' '{"err":{"code":"ERR_PNPM_META_FETCH_FAIL","errno":"ENOTFOUND"}}'
  exit 1
fi
version=1.0.0
if [ "$npm_config_registry" = '${FIXTURE_REGISTRY}' ]; then
  version='${FIXTURE_VERSION}'
fi
printf '{"dependencies":{"%s":"%s"}}\\n' '${CLAUDE.adapter}' "$version" > "$PWD/package.json"
`, { mode: 0o755 })
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected direct registry fetch') })
  t.after(() => fetch.mock.restore())
  const store = new AdapterStore({
    home: join(root, 'adapters'),
    env: { PATH: '', AUTOMAGIK_PNPM: pnpm, npm_config_registry: FIXTURE_REGISTRY },
    install: async (dir, pkg) => {
      const bin = join(dir, 'node_modules', ...pkg.split('/'), CLAUDE.bin)
      mkdirSync(dirname(bin), { recursive: true })
      writeFileSync(bin, '// installed\n')
    },
    check: async () => {},
  })
  return { store, offline, fetch }
}

test('#1640: repairing a missing connector resolves its version through the configured registry', { skip: process.platform === 'win32' }, async (t) => {
  const { store, fetch } = registryStore(t)
  await store.repair(CLAUDE.adapter, CLAUDE.bin)
  assert.equal(store.binOf(CLAUDE.adapter, CLAUDE.bin)?.version, FIXTURE_VERSION)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(store.lastFailure(CLAUDE.adapter), undefined)
})

// --- 6b. the plugin: the sentence in the row, and the retries -----------------------------------

// A clock the row moves: the timers set, with `advance` running the ones that are due.
class Clock {
  now = 0
  jobs = new Map()
  setTimeout = (run, delay) => {
    const timer = { held: true, unref() { timer.held = false } }
    this.jobs.set(timer, { run, at: this.now + delay, delay })
    return timer
  }
  clearTimeout = (timer) => { this.jobs.delete(timer) }
  // Whether any waiting timer would keep the process alive.
  get holding() { return [...this.jobs.keys()].some(timer => timer.held) }
  get delays() { return [...this.jobs.values()].map(job => job.delay) }
  advance(ms) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.now = next[1].at
      this.jobs.delete(next[0])
      next[1].run()
    }
    this.now = end
  }
}

const OFFLINE = { message: 'fetch failed', diagnostic: 'fetch failed', unreachable: 'ENOTFOUND' }

// The plugin over a store the row scripts: `world.fail` is what the next install of each
// connector fails with (a failure record) or undefined to land it.
function plugin(options = {}) { return pluginWith({}, options) }
function pluginWith(given, { claude = true, codex = false, cliStore } = {}) {
  const services = {}
  const registered = {}
  const logs = []
  const cleanups = []
  const clock = new Clock()
  const world = { fail: { [CLAUDE.adapter]: OFFLINE, [CODEX.adapter]: OFFLINE }, bins: {}, failures: {}, updates: [], on: { claude, codex }, found: { claude: '/bin/claude', codex: '/bin/codex' }, ...given }
  const ctx = {
    logger: { warn: message => logs.push(message), info: message => logs.push(message) },
    llm: {
      registerAdapter(_providers, adapter) { registered.adapter = adapter; const handle = () => {}; handle.replace = () => {}; return handle },
      listProviders: () => [],
      listModels: () => new Promise(() => {}),
    },
    agents: { get: () => undefined },
    get: () => undefined,
    provide: (name, value) => { services[name] = value },
    on: () => {},
    effect: (setup) => { cleanups.push(setup()) },
    emit: () => {},
  }
  const store = world.store = given.store ?? {
    binOf: pkg => world.bins[pkg],
    busy: () => false,
    lastError: pkg => world.failures[pkg]?.message,
    lastFailure: pkg => world.failures[pkg],
    update: async (pkg) => {
      world.updates.push(pkg)
      const failure = world.fail[pkg]
      if (failure !== undefined) {
        world.failures[pkg] = failure
        throw new Error(failure.message)
      }
      delete world.failures[pkg]
      world.bins[pkg] = { path: '/x/dist/index.js', version: '1.0.0' }
    },
    dispose: () => {},
  }
  // The plugin's own start-up and regular checks run on real timers: none is set here, so
  // only what a row does installs anything, however long the machine takes.
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval }
  const inert = () => ({ unref() {}, ref() {}, hasRef: () => false })
  globalThis.setTimeout = inert
  globalThis.setInterval = inert
  try {
    apply(ctx, { claude: { get: () => world.on.claude }, codex: { get: () => world.on.codex } }, { store, find: name => world.found[name], signedIn: async () => true, checkTimers: clock, ...(cliStore ? { cliStore } : {}), ...world.login })
  } finally {
    Object.assign(globalThis, real)
  }
  const service = services[SERVICE]
  const row = async id => (await service.status()).agents.find(agent => agent.id === id)
  const stop = () => { for (const cleanup of cleanups.splice(0)) cleanup?.() }
  return { service, row, world, clock, logs, registered, stop }
}

test('#1640: Retry with the configured registry offline recovers automatically when it returns', { skip: process.platform === 'win32' }, async (t) => {
  const { store, offline } = registryStore(t)
  writeFileSync(offline, '')
  // Keep managed CLI installs out of the connector Retry, even in a desktop test environment.
  const cliStore = { find: () => undefined, ensure: async () => {}, lastFailure: () => undefined, busy: () => false }
  const h = pluginWith({ store }, { cliStore })
  t.after(h.stop)
  const id = 'acp-claude'
  const waitForConnector = async (state) => {
    const deadline = performance.now() + 10_000
    let row = await h.row(id)
    while (row.connector.state !== state && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      row = await h.row(id)
    }
    assert.equal(row.connector.state, state, row.connector.error)
    return row
  }

  const { agents } = await h.service.retry(id)
  assert.equal(agents.find(agent => agent.id === id).connector.state, 'installing')
  const failed = await waitForConnector('failed')
  assert.equal(failed.connectorUnreachable, true)
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[0]])

  rmSync(offline)
  h.clock.advance(CHECK_RETRY_MS[0])
  const ready = await waitForConnector('ready')
  assert.equal(ready.connector.version, FIXTURE_VERSION)
  assert.deepEqual(h.clock.delays, [])
})

test('#970.6: what the row and a turn say of a failed install is not changed', async (t) => {
  const h = plugin()
  t.after(h.stop)
  await h.service.retry('acp-claude')
  await settle()
  const row = await h.row('acp-claude')
  assert.deepEqual(row.connector, { state: 'failed', error: 'fetch failed', diagnostic: 'fetch failed' })
  assert.throws(() => h.registered.adapter.agents.get('acp-claude').spawn(), /the last install failed: fetch failed/)
  assert.ok(h.logs.some(line => line.includes(`${CLAUDE.adapter} not installed: fetch failed`)))
})

test('#970.6: the install is tried again by itself after 1, 5, 15 and 60 minutes, then left to the regular check', async (t) => {
  const h = plugin()
  t.after(h.stop)
  assert.deepEqual(CHECK_RETRY_MS, [60_000, 300_000, 900_000, 3_600_000])
  await h.service.retry('acp-claude')
  await settle()
  assert.deepEqual(h.world.updates, [CLAUDE.adapter])
  assert.equal(h.clock.holding, false, 'a waiting retry does not keep the process alive')
  for (const [step, delay] of CHECK_RETRY_MS.entries()) {
    assert.deepEqual(h.clock.delays, [delay], `one retry waits, ${delay / 60_000} min after failure ${step + 1}`)
    h.clock.advance(delay - 1)
    assert.equal(h.world.updates.length, step + 1, 'not before its time')
    h.clock.advance(1)
    await settle()
    assert.equal(h.world.updates.length, step + 2, 'the install was tried again')
  }
  // Every step used: no fifth timer. The check that runs every few hours goes on as before.
  assert.deepEqual(h.clock.delays, [])
  // The person's own Retry still works, and still sets no timer of its own.
  await h.service.retry('acp-claude')
  await settle()
  assert.equal(h.world.updates.length, CHECK_RETRY_MS.length + 2)
  assert.deepEqual(h.clock.delays, [])
})

test('#970.6: once the connector lands the retries are over, and a later outage starts from the first step', async (t) => {
  const h = plugin()
  t.after(h.stop)
  await h.service.retry('acp-claude')
  await settle()
  h.clock.advance(CHECK_RETRY_MS[0])
  await settle()
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[1]])
  // The network is back.
  h.world.fail[CLAUDE.adapter] = undefined
  h.clock.advance(CHECK_RETRY_MS[1])
  await settle()
  assert.equal((await h.row('acp-claude')).connector.state, 'ready')
  assert.deepEqual(h.clock.delays, [])
  // Gone again later (its folder removed, npm unreachable): the first step again.
  delete h.world.bins[CLAUDE.adapter]
  h.world.fail[CLAUDE.adapter] = OFFLINE
  await h.service.retry('acp-claude')
  await settle()
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[0]])
})

test('#970.6: one retry waits at a time, whatever else fails meanwhile', async (t) => {
  const h = plugin()
  t.after(h.stop)
  await h.service.retry('acp-claude')
  await settle()
  // The person's Retry and a turn fail the same way while the first retry waits.
  await h.service.retry('acp-claude')
  await settle()
  assert.throws(() => h.registered.adapter.agents.get('acp-claude').spawn(), /still being installed/)
  await settle()
  assert.equal(h.world.updates.length, 3)
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[0]], 'still the one timer, still the first step')
})

test('#970.6: no retry for a failure that is not the network, for a connector that is here, or for an agent turned off', async (t) => {
  // Not the network: trying again would fail again.
  const other = plugin()
  t.after(other.stop)
  other.world.fail[CLAUDE.adapter] = { message: 'pnpm install failed (exit 1)' }
  await other.service.retry('acp-claude')
  await settle()
  assert.deepEqual(other.clock.delays, [])
  // The connector is here: an update check that could not reach npm waits for the regular check.
  const here = plugin()
  t.after(here.stop)
  here.world.bins[CLAUDE.adapter] = { path: '/x/dist/index.js', version: '1.0.0' }
  await here.service.retry('acp-claude')
  await settle()
  assert.equal(here.world.failures[CLAUDE.adapter].unreachable, 'ENOTFOUND')
  assert.deepEqual(here.clock.delays, [])
  assert.equal((await here.row('acp-claude')).connector.state, 'ready')
  // A network failure followed by another kind: the waiting retry is dropped.
  const mixed = plugin()
  t.after(mixed.stop)
  await mixed.service.retry('acp-claude')
  await settle()
  assert.deepEqual(mixed.clock.delays, [CHECK_RETRY_MS[0]])
  mixed.world.fail[CLAUDE.adapter] = { message: 'pnpm install failed (exit 1)' }
  await mixed.service.retry('acp-claude')
  await settle()
  assert.deepEqual(mixed.clock.delays, [])
  // Turned off while a retry waits (the switch alone, nothing has looked at it yet): when its
  // time comes nothing is installed.
  const off = plugin()
  t.after(off.stop)
  await off.service.retry('acp-claude')
  await settle()
  off.world.on.claude = false
  const before = off.world.updates.length
  off.clock.advance(CHECK_RETRY_MS[0])
  await settle()
  assert.equal(off.world.updates.length, before)
  assert.deepEqual(off.clock.delays, [])
  // Turned on again, the next outage starts from the first step, not where the old one stood.
  off.world.on.claude = true
  await off.service.refresh()
  await off.service.retry('acp-claude')
  await settle()
  assert.deepEqual(off.clock.delays, [CHECK_RETRY_MS[0]])
  // Its CLI removed while a retry waits (nothing has looked for it since): the same.
  const gone = plugin()
  t.after(gone.stop)
  await gone.service.retry('acp-claude')
  await settle()
  gone.world.found.claude = undefined
  const asked = gone.world.updates.length
  gone.clock.advance(CHECK_RETRY_MS[0])
  await settle()
  assert.equal(gone.world.updates.length, asked)
  assert.deepEqual(gone.clock.delays, [])
  // Installed by other means while a retry waits: the same.
  const landed = plugin()
  t.after(landed.stop)
  await landed.service.retry('acp-claude')
  await settle()
  landed.world.bins[CLAUDE.adapter] = { path: '/x/dist/index.js', version: '1.0.0' }
  const tried = landed.world.updates.length
  landed.clock.advance(CHECK_RETRY_MS[0])
  await settle()
  assert.equal(landed.world.updates.length, tried)
  assert.deepEqual(landed.clock.delays, [])
})

test('#970.6: one failed check is one step, however many callers waited on it', async (t) => {
  const h = plugin()
  t.after(h.stop)
  // The store shares one install among its callers, as the real one does.
  let fail
  let shared
  h.world.store.update = (pkg) => {
    h.world.updates.push(pkg)
    shared ??= new Promise((_, reject) => { fail = () => { h.world.failures[pkg] = OFFLINE; shared = undefined; reject(new Error('fetch failed')) } })
    return shared
  }
  // Retry twice and a turn, all on the same check.
  await h.service.retry('acp-claude')
  await h.service.retry('acp-claude')
  assert.throws(() => h.registered.adapter.agents.get('acp-claude').spawn(), /still being installed/)
  assert.equal(h.world.updates.length, 3)
  fail()
  await settle()
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[0]], 'one timer, the first step')
  // The retry fails once more: the second step, not the fourth.
  h.clock.advance(CHECK_RETRY_MS[0])
  await settle()
  fail()
  await settle()
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[1]])
})

test('#970.6: a check that fails after the plugin stopped sets no retry', async () => {
  const h = plugin()
  let fail
  h.world.store.update = pkg => new Promise((_, reject) => { fail = () => { h.world.failures[pkg] = OFFLINE; reject(new Error('fetch failed')) } })
  await h.service.retry('acp-claude')
  h.stop()
  fail()
  await settle()
  assert.deepEqual(h.clock.delays, [])
})

test('#970.6: each connector has its own retries, and stopping the plugin clears them all', async (t) => {
  const h = plugin({ codex: true })
  t.after(h.stop)
  await h.service.retry('acp-claude')
  await h.service.retry('acp-codex')
  await settle()
  assert.deepEqual(h.clock.delays, [CHECK_RETRY_MS[0], CHECK_RETRY_MS[0]])
  const before = h.world.updates.length
  h.stop()
  assert.deepEqual(h.clock.delays, [])
  h.clock.advance(CHECK_RETRY_MS.at(-1))
  await settle()
  assert.equal(h.world.updates.length, before, 'nothing is installed after the plugin stopped')
})

// --- 8. why a sign-in failed, for the log -------------------------------------------------------

const childProcess = () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.writes = []
  child.exitCode = null
  child.signalCode = null
  child.stdin.on('data', chunk => child.writes.push(String(chunk)))
  child.kill = () => true
  child.close = (code, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal) }
  return child
}

// Sign-in attempts over fake CLI processes and a fake clock, recording what `onFail` is told.
function logins(options = {}) {
  const clock = new Clock()
  const children = []
  const failed = []
  let signedIn = false
  const flows = new CliLogins({
    resolve: async () => ({ cli: '/managed/cli', env: { PATH: '/runtime/bin' } }),
    signedIn: async () => signedIn,
    onFail: report => failed.push(report),
    spawn: () => { const child = childProcess(); children.push(child); return child },
    now: () => clock.now,
    timers: clock,
    ...options,
  })
  return { flows, clock, children, failed, authenticated: (value = true) => { signedIn = value } }
}

const SECRET = 'sk-ant-secret-test someone@example.com /home/someone/.claude'
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=public&state=expected_state_0123456789&code_challenge=public-challenge'
const jsonRequests = child => child.writes.flatMap(chunk => chunk.trim().split('\n')).filter(Boolean).map(line => JSON.parse(line))
const sendJson = (child, value) => child.stdout.write(`${JSON.stringify(value)}\n`)

test('#970.8: a CLI that exits before it shows a link is "the CLI exited", with its exit code and nothing it printed', async (t) => {
  const h = logins()
  t.after(() => h.flows.dispose())
  const started = h.flows.start('acp-claude')
  await settle()
  const child = h.children[0]
  child.stderr.write(`Error: ${SECRET}\n`)
  child.stdout.write(`${SECRET}\n`)
  await settle()
  child.close(1)
  await settle()
  assert.equal(h.flows.status('acp-claude', started.attemptId).status, 'failed')
  assert.deepEqual(h.failed, [{ id: 'acp-claude', cause: 'the CLI exited', phase: 'starting', exit: 'exit 1' }])
  assert.equal(JSON.stringify(h.failed).includes('example.com'), false)
})

test('#970.8: a CLI ended by a signal says the signal', async (t) => {
  const h = logins()
  t.after(() => h.flows.dispose())
  h.flows.start('acp-codex')
  await settle()
  h.children[0].close(null, 'SIGKILL')
  await settle()
  assert.deepEqual(h.failed, [{ id: 'acp-codex', cause: 'the CLI exited', phase: 'starting', exit: 'SIGKILL' }])
})

test('#970.8: no link in time, an unsupported link and a CLI that could not start each have their class', async (t) => {
  // Silent until the startup limit.
  const silent = logins()
  t.after(() => silent.flows.dispose())
  silent.flows.start('acp-claude')
  await settle()
  silent.clock.advance(STARTUP_MS + 1)
  assert.deepEqual(silent.failed, [{ id: 'acp-claude', cause: 'no sign-in link in time', phase: 'starting' }])
  // A link to somewhere else.
  const odd = logins()
  t.after(() => odd.flows.dispose())
  odd.flows.start('acp-claude')
  await settle()
  odd.children[0].stdout.write('visit: https://claude.example.net/oauth/authorize?code=true&state=abcdefgh12345678\nPaste code here if prompted > ')
  await settle()
  assert.deepEqual(odd.failed, [{ id: 'acp-claude', cause: 'unsupported sign-in link', phase: 'starting' }])
  // The process cannot be spawned.
  const unstartable = logins()
  t.after(() => unstartable.flows.dispose())
  unstartable.flows.start('acp-codex')
  await settle()
  unstartable.children[0].emit('error', Object.assign(new Error(`spawn ${SECRET} ENOENT`), { code: 'ENOENT' }))
  await settle()
  assert.deepEqual(unstartable.failed, [{ id: 'acp-codex', cause: 'the CLI could not be started', phase: 'starting' }])
  // No CLI at all.
  const none = logins({ resolve: async () => ({ cli: undefined, env: {} }) })
  t.after(() => none.flows.dispose())
  none.flows.start('acp-claude')
  await settle()
  assert.deepEqual(none.failed, [{ id: 'acp-claude', cause: 'no CLI found', phase: 'starting' }])
})

test('#970.8: Codex\'s device sign-in: not enabled, not started, and an answer nobody expected', async (t) => {
  const start = async (answer) => {
    const h = logins()
    t.after(() => h.flows.dispose())
    h.flows.start('acp-codex')
    await settle()
    const child = h.children[0]
    sendJson(child, { id: jsonRequests(child)[0].id, result: {} })
    await settle()
    const login = jsonRequests(child).find(row => row.method === 'account/login/start')
    sendJson(child, { id: login.id, ...answer })
    await settle()
    return h
  }
  assert.deepEqual((await start({ error: { message: `device code login is not enabled for ${SECRET}` } })).failed, [{ id: 'acp-codex', cause: 'device-code login is not enabled', phase: 'starting' }])
  assert.deepEqual((await start({ error: { message: SECRET } })).failed, [{ id: 'acp-codex', cause: 'device sign-in did not start', phase: 'starting' }])
  assert.deepEqual((await start({ result: { type: 'browser', url: `https://example.com/${SECRET}` } })).failed, [{ id: 'acp-codex', cause: 'device sign-in did not start', phase: 'starting' }])
  // The first request itself is refused: nothing the flow knows by name.
  const h = logins()
  t.after(() => h.flows.dispose())
  h.flows.start('acp-codex')
  await settle()
  sendJson(h.children[0], { id: jsonRequests(h.children[0])[0].id, error: { message: SECRET } })
  await settle()
  assert.deepEqual(h.failed, [{ id: 'acp-codex', cause: 'unknown', phase: 'starting' }])
})

test('#970.8: after the link, a CLI that ends without confirming says where the attempt stood', async (t) => {
  const h = logins()
  t.after(() => h.flows.dispose())
  const started = h.flows.start('acp-claude')
  await settle()
  const child = h.children[0]
  child.stdout.write(`visit: ${CLAUDE_URL}\nPaste code here if prompted > `)
  await settle()
  assert.equal(h.flows.status('acp-claude', started.attemptId).status, 'waiting')
  // The CLI exits 0 but the status command still says signed out.
  child.close(0)
  await settle()
  assert.deepEqual(h.failed, [{ id: 'acp-claude', cause: 'the CLI did not confirm the sign-in', phase: 'waiting', exit: 'exit 0' }])
  // A code was given and the CLI died on it.
  const answering = logins()
  t.after(() => answering.flows.dispose())
  const attempt = answering.flows.start('acp-claude')
  await settle()
  answering.children[0].stdout.write(`visit: ${CLAUDE_URL}\nPaste code here if prompted > `)
  await settle()
  answering.flows.answer('acp-claude', attempt.attemptId, 'authorization-code#expected_state_0123456789')
  await settle()
  answering.children[0].close(3)
  await settle()
  assert.deepEqual(answering.failed, [{ id: 'acp-claude', cause: 'the CLI exited', phase: 'answering', exit: 'exit 3' }])
})

test('#970.8: a sign-in that works, expires or is cancelled is not a failure; a listener that throws changes nothing', async (t) => {
  const ok = logins()
  t.after(() => ok.flows.dispose())
  ok.authenticated(true)
  const done = ok.flows.start('acp-claude')
  await settle()
  await settle()
  assert.equal(ok.flows.status('acp-claude', done.attemptId).status, 'ready')
  assert.deepEqual(ok.failed, [])
  const cancelled = logins()
  t.after(() => cancelled.flows.dispose())
  const attempt = cancelled.flows.start('acp-codex')
  await settle()
  cancelled.flows.cancel('acp-codex', attempt.attemptId)
  cancelled.children[0]?.close(null, 'SIGTERM')
  await settle()
  assert.deepEqual(cancelled.failed, [])
  // A link nobody used expires: an expiry, not a failure.
  const idle = logins()
  t.after(() => idle.flows.dispose())
  const waiting = idle.flows.start('acp-claude')
  await settle()
  idle.children[0].stdout.write(`visit: ${CLAUDE_URL}\nPaste code here if prompted > `)
  await settle()
  idle.clock.advance(LINK_TTL_MS + 1)
  assert.equal(idle.flows.status('acp-claude', waiting.attemptId).status, 'expired')
  assert.deepEqual(idle.failed, [])
  // A listener that throws: the attempt still ends as it would.
  const loud = logins({ onFail: () => { throw new Error('listener') } })
  t.after(() => loud.flows.dispose())
  const failing = loud.flows.start('acp-claude')
  await settle()
  loud.children[0].close(1)
  await settle()
  const view = loud.flows.status('acp-claude', failing.attemptId)
  assert.equal(view.status, 'failed')
  assert.equal(view.message, 'Sign-in did not finish. Try again.')
  // With no listener at all (the default), the same.
  const quiet = new CliLogins({ resolve: async () => ({ cli: '/managed/cli', env: {} }), signedIn: async () => false, spawn: () => childProcess(), now: () => 0, timers: new Clock() })
  t.after(() => quiet.dispose())
  const silent = quiet.start('acp-claude')
  await settle()
  assert.equal(quiet.status('acp-claude', silent.attemptId).status, 'starting')
})

test('#970.8: the plugin logs the class, where it stood, the exit and the CLI, and none of the CLI\'s words', async (t) => {
  const logs = []
  const services = {}
  const cleanups = []
  const children = []
  const clock = new Clock()
  const ctx = {
    logger: { warn: message => logs.push(message), info: message => logs.push(message) },
    llm: { registerAdapter() { const handle = () => {}; handle.replace = () => {}; return handle }, listProviders: () => [], listModels: () => new Promise(() => {}) },
    agents: { get: () => undefined },
    get: () => undefined,
    provide: (name, value) => { services[name] = value },
    on: () => {},
    effect: (setup) => { cleanups.push(setup()) },
    emit: () => {},
  }
  const store = { binOf: () => ({ path: '/x/dist/index.js', version: '1.0.0' }), busy: () => false, lastError: () => undefined, lastFailure: () => undefined, update: async () => {}, dispose: () => {} }
  const loginTimers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now }
  apply(ctx, { claude: { get: () => true }, codex: { get: () => false } }, {
    store,
    find: name => `/bin/${name}`,
    signedIn: async () => false,
    loginSpawn: () => { const child = childProcess(); children.push(child); return child },
    loginTimers,
    checkTimers: new Clock(),
  })
  t.after(() => { for (const cleanup of cleanups) cleanup?.() })
  services[SERVICE].loginStart('acp-claude')
  for (let turn = 0; turn < 50 && children.length === 0; turn += 1) await settle()
  assert.equal(children.length, 1, 'the CLI was started')
  children[0].stderr.write(`${SECRET}\n`)
  children[0].stdout.write(`${SECRET}\n`)
  await settle()
  children[0].close(1)
  await settle()
  const line = logs.find(message => message.includes('sign-in to'))
  assert.ok(line, 'the failure is logged')
  assert.match(line, /sign-in to Claude Code failed: the CLI exited \(starting, exit 1; CLI version unknown\)$/)
  assert.ok(logs.every(message => !message.includes('example.com') && !message.includes('sk-ant') && !message.includes('/home/someone')), 'nothing the CLI printed is logged')
})

test('#970.8: the version logged is the one the CLI had when the attempt started', async (t) => {
  // A CLI Automagik manages has a known version; it is updated while the attempt runs.
  const managed = { version: '2.0.0' }
  const cliStore = {
    find: (spec, external) => (spec.key === 'claude' ? { path: external ?? '/managed/claude', version: managed.version, managed: true } : undefined),
    ensure: async () => {},
    lastFailure: () => undefined,
    lastError: () => undefined,
    busy: () => false,
    dispose() {},
  }
  const children = []
  const loginClock = new Clock()
  const h = (() => {
    const world = { login: { loginSpawn: () => { const child = childProcess(); children.push(child); return child }, loginTimers: { setTimeout: loginClock.setTimeout, clearTimeout: loginClock.clearTimeout, now: () => loginClock.now }, signedIn: async () => false } }
    return pluginWith(world, { cliStore })
  })()
  t.after(h.stop)
  h.service.loginStart('acp-claude')
  for (let turn = 0; turn < 50 && children.length === 0; turn += 1) await settle()
  assert.equal(children.length, 1, 'the CLI was started')
  managed.version = '2.1.0'
  await h.service.retry('acp-claude')
  children[0].close(1)
  await settle()
  const line = h.logs.find(message => message.includes('sign-in to'))
  assert.match(line, /sign-in to Claude Code failed: the CLI exited \(starting, exit 1; CLI 2\.0\.0\)$/)
})
