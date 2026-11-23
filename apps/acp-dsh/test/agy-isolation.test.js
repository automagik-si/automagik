// Antigravity in its own home (#2048, isolation amendment): the plugin's real wiring with a
// cliHome, and an `agy` that is a shell script running the fake ACP agent. No real agy runs,
// nothing is downloaded and no credential is read: the fake's "sign-in" is a marker file in
// the HOME it was given.
import assert from 'node:assert/strict'
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply, SERVICE } from '../index.js'
import { AGENTS, isolatedSignInHintOf, launchOf, NO_BUS_ADDRESS } from '../src/host/agents.js'
import { assertGeneration } from '../src/host/cli-generations.js'
import { CliHomes, HOME_ENV, stopRuns, trackRun } from '../src/host/cli-homes.js'
import { CliLogins } from '../src/host/login.js'
import { readSignInLinks } from '../src/host/sign-in-opener.js'

const ID = 'acp-antigravity'
const SPEC = AGENTS[ID]
const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const unixOnly = { skip: process.platform === 'win32' ? 'the fake agy uses a POSIX shebang' : false }
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
// What must never reach agy: the runtime folder, API keys and Cloud credentials, and the switch
// that would stop its own updater. The session bus address it gets is one that never connects.
const PLANTED = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/4242/bus',
  XDG_RUNTIME_DIR: '/run/user/4242',
  GEMINI_API_KEY: 'planted-gemini-key',
  GOOGLE_APPLICATION_CREDENTIALS: '/planted/adc.json',
  AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  DISPLAY: ':99',
  // Not set in these tests unless one says so (I3).
  WAYLAND_DISPLAY: undefined,
}
const NEVER = ['XDG_RUNTIME_DIR', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AGY_CLI_DISABLE_AUTO_UPDATE']

// The person's own environment for this test: a scratch HOME, and the planted variables.
function plant(t, extra = {}) {
  const person = mkdtempSync(join(tmpdir(), 'agy-iso-person-'))
  const values = { ...PLANTED, HOME: person, ...extra }
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  const put = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  for (const [key, value] of Object.entries(values)) put(key, value)
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) put(key, value)
    rmSync(person, { recursive: true, force: true })
  })
  return person
}

const writeCli = (path, env) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh
${Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')}
exec ${quote(process.execPath)} ${quote(FAKE)} "$@"
`)
  chmodSync(path, 0o755)
  return path
}
const lines = file => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, what, ms = 20_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await sleep(25)
  }
}
const gone = (pid) => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
// The agy home the app selects now: the generation the pointer names, else the first home.
const homeOf = (cliHome) => {
  const pointer = join(cliHome, 'current', 'antigravity')
  if (!existsSync(pointer)) return join(cliHome, 'antigravity')
  return join(cliHome, 'homes', 'antigravity', readFileSync(pointer, 'utf8'))
}

function world(t, { platform = 'linux', agentEnv = {}, config = {}, deps = {}, hermes = false, external = true, prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-agy-iso-'))
  prepare?.(dir)
  const cliHome = join(dir, 'acp', 'cli-homes')
  const envFile = join(dir, 'agy-env.jsonl')
  const traceFile = join(dir, 'agy-trace.jsonl')
  const hermesEnv = join(dir, 'hermes-env.jsonl')
  const agy = writeCli(join(dir, 'bin', 'agy'), {
    FAKE_ACP_MODES: 'default', FAKE_ACP_AUTH: 'file', FAKE_ACP_AUTH_METHODS: 'oauth-personal',
    FAKE_ACP_ENV_FILE: envFile, FAKE_ACP_TRACE: traceFile, ...agentEnv,
  })
  const clis = {
    ...(external ? { agy } : {}),
    ...(hermes ? { hermes: writeCli(join(dir, 'bin', 'hermes'), { FAKE_ACP_ENV_FILE: hermesEnv }) } : {}),
  }
  const logs = []
  const logoutCalls = []
  const registered = {}
  const routes = { now: [] }
  const services = {}
  const disposers = []
  const listeners = new Map()
  const session = { id: 's1', header: { cwd: dir }, append: () => ({ seq: 1 }) }
  const agent = {
    session, model: { current: () => ({ provider: ID, model: 'default' }) }, options: { provider: ID },
    status: 'idle', ctx: { tools: { register: () => () => {} } },
  }
  const ctx = {
    logger: { warn: line => logs.push(line), info: line => logs.push(line) },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.adapter = adapter
        routes.now = [...providers]
        const handle = () => { routes.now = [] }
        handle.replace = (next) => { routes.now = [...next] }
        return handle
      },
      listProviders: () => routes.now.map(id => ({ id, name: id })),
    },
    agents: { get: id => (id === 's1' ? agent : undefined), list: () => [agent] },
    get: name => (name === 'approval' ? { request: async () => 'allowed-once' } : undefined),
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} },
    effect: (fn) => { disposers.push(fn()) },
    provide: (name, value) => { services[name] = value },
    emit: () => {},
  }
  const store = {
    binOf: () => undefined, busy: () => false, lastError: () => undefined, lastFailure: () => undefined,
    update: async () => {}, stateOf: () => undefined, markGood: () => {}, rollback: () => undefined, dispose: () => {},
  }
  const live = { claude: false, codex: false, antigravity: true, ...config }
  apply(ctx, live, {
    store, find: name => clis[name], signedIn: async () => undefined, catalogHome: join(dir, 'catalog'),
    cliHome, platform,
    logoutRun: (...args) => { logoutCalls.push(args); args.at(-1)?.(null) },
    ...deps,
  })
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; for (const fn of disposers) fn?.() }
  t.after(async () => { dispose(); await sleep(50); rmSync(dir, { recursive: true, force: true }) })
  const service = services[SERVICE]
  return {
    dir, cliHome, agy, clis, logs, logoutCalls, config: live, service, dispose,
    get adapter() { return registered.adapter },
    home: () => homeOf(cliHome),
    envs: () => lines(envFile),
    hermesEnvs: () => lines(hermesEnv),
    traces: () => lines(traceFile),
    emit(name, payload) { for (const listener of listeners.get(name) ?? []) listener(payload) },
    row: async () => (await service.status()).agents.find(row => row.id === ID),
    async signedIn() {
      // The sign-in answers at once; its end (and the check after it) is when signingIn goes.
      await until(async () => (await this.row()).signingIn !== true, 'the sign-in to end')
      return this.row()
    },
    async turn(text = 'hi') {
      const chunks = []
      const request = markAgentLoopRequest({ provider: ID, model: 'default', sessionId: 's1', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] })
      for await (const chunk of registered.adapter.stream(request)) chunks.push(chunk)
      return chunks
    },
  }
}

const checkIsolated = (entry, home) => {
  assert.equal(entry.values.HOME, home)
  assert.equal(entry.values.USERPROFILE, home)
  for (const [name, folder] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state']]) {
    assert.equal(entry.values[name], join(home, folder), name)
  }
  // They point inside agy's own home, at folders agy never reads (the generation fence needs them).
  assert.equal(entry.values.CODEX_HOME, join(home, '.codex'))
  assert.equal(entry.values.CLAUDE_CONFIG_DIR, join(home, '.claude'))
  assert.equal(entry.values.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(home, '.claude'))
  for (const name of NEVER) assert.equal(entry.names.includes(name), false, name)
  // agy finds the session bus by the user id when the address is unset: it gets one that never connects.
  assert.equal(entry.values.DBUS_SESSION_BUS_ADDRESS, NO_BUS_ADDRESS)
}

test('I1: the probe, a Session and the sign-in each run agy in its own home, without the bus or a key', unixOnly, async (t) => {
  const person = plant(t)
  const w = world(t, { hermes: true, config: { hermes: true } })
  const home = w.home()
  await w.service.refresh()
  assert.equal((await w.row()).signedIn, false)
  const probe = w.envs().at(-1)
  checkIsolated(probe, home)
  assert.equal(probe.cwd, home)
  // A Session: refused as signed out, in its own home, and the chat names Settings.
  const before = w.envs().length
  const chunks = await w.turn()
  assert.equal(chunks.at(-1).reason.failure.message, 'Antigravity (ACP) is not signed in. Sign in to it in Settings, under Coding agents, then send again.')
  assert.ok(w.envs().length > before)
  for (const entry of w.envs().slice(before)) checkIsolated(entry, home)
  // The sign-in.
  const started = w.envs().length
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  for (const entry of w.envs().slice(started)) checkIsolated(entry, home)
  assert.equal(statSync(join(home, '.gemini')).mode & 0o777, 0o700)
  assert.equal(existsSync(join(person, '.gemini')), false)
  // Hermes has no home of its own: it still runs on the person's environment.
  const own = w.hermesEnvs().at(-1)
  assert.equal(own.values.HOME, person)
  assert.equal(own.names.includes('DBUS_SESSION_BUS_ADDRESS'), true)
  // Claude Code and Codex keep the session bus; only agy loses it.
  const other = new CliHomes(join(w.dir, 'other', 'cli-homes'))
  try {
    assert.equal(other.environment('claude').DBUS_SESSION_BUS_ADDRESS, PLANTED.DBUS_SESSION_BUS_ADDRESS)
    assert.equal(other.environment('codex').DBUS_SESSION_BUS_ADDRESS, PLANTED.DBUS_SESSION_BUS_ADDRESS)
    const env = other.environment('antigravity')
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/dev/null/automagik-no-bus')
    assert.ok(env.DBUS_SESSION_BUS_ADDRESS.startsWith('unix:path=/dev/null/'))
  } finally { other.dispose() }
})

test('I2: signed out, then Sign in: signingIn, then signed in; the sign-in is in the agy home only', unixOnly, async (t) => {
  const person = plant(t)
  const w = world(t)
  await w.service.refresh()
  const before = await w.row()
  assert.equal(before.signedIn, false)
  assert.equal(before.appSignIn, true)
  assert.equal(before.signInWhere, undefined)
  assert.equal(before.sharedAccount, undefined)
  const answered = (await w.service.signInNative(ID)).agents.find(row => row.id === ID)
  assert.equal(answered.signingIn, true)
  const after = await w.signedIn()
  assert.equal(after.signedIn, true)
  assert.equal(after.signInError, undefined)
  assert.equal(existsSync(join(w.home(), '.gemini', 'fake-signed-in')), true)
  assert.equal(existsSync(join(person, '.gemini')), false)
  assert.ok(w.logs.includes('acp-dsh: Antigravity offers sign-in methods: oauth-personal; sign-out over ACP: no'), w.logs.join('\n'))
  assert.deepEqual(w.traces().filter(entry => entry.event === 'authenticate').map(entry => entry.methodId), ['oauth-personal'])
})

test('I2b: a sign-in link agy prints reaches the status only when it is Google\'s own, and only while it waits', unixOnly, async (t) => {
  plant(t)
  const google = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
    + '&redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2Fcb&response_type=code&state=s1'
  const w = world(t, { agentEnv: {
    FAKE_ACP_AUTH_STDERR: `Open https://accounts.google.com.evil.example/o/oauth2/v2/auth?response_type=code&client_id=x or ${google} to sign in.`,
    FAKE_ACP_AUTH_HOLD: '1',
  } })
  await w.service.refresh()
  await w.service.signInNative(ID)
  const row = await until(async () => { const now = await w.row(); return now.signInUrl ? now : undefined }, 'the sign-in link')
  assert.equal(row.signInUrl, google)
  assert.equal(row.signingIn, true)
  assert.ok(!w.logs.some(line => line.includes('accounts.google.com')), w.logs.join('\n'))
  // Switched off: the attempt ends and its link goes with it.
  w.config.antigravity = false
  w.emit('loader/volatile-update')
  const after = await w.signedIn()
  assert.equal(after.signInUrl, undefined)
  // Only links that are not Google's: none reaches the status.
  const other = world(t, { agentEnv: { FAKE_ACP_AUTH_STDERR: 'Open https://evil.example/o/oauth2/v2/auth?response_type=code&client_id=x', FAKE_ACP_AUTH_HOLD: '1' }, deps: { nativeSignInMs: 1500 } })
  await other.service.refresh()
  await other.service.signInNative(ID)
  await until(() => other.traces().some(entry => entry.event === 'authenticate'), 'the sign-in to start')
  await sleep(300)
  assert.equal((await other.row()).signInUrl, undefined)
  assert.equal((await other.signedIn()).signInError, 'timeout')
  // Google's page, but a return address that is not agy's loopback listener: never shown.
  const away = [
    google.replace('http%3A%2F%2F127.0.0.1%3A4242%2Fcb', 'https%3A%2F%2Fevil.example%2Fcb'),
    google.replace('http%3A%2F%2F127.0.0.1%3A4242%2Fcb', 'http%3A%2F%2Fevil.example%3A1%2Fcb'),
    google.replace('http%3A%2F%2F127.0.0.1%3A4242%2Fcb', 'http%3A%2F%2F127.0.0.1%2Fcb'),
  ]
  const redirected = world(t, { agentEnv: { FAKE_ACP_AUTH_STDERR: away.join(' '), FAKE_ACP_AUTH_HOLD: '1' }, deps: { nativeSignInMs: 1500 } })
  await redirected.service.refresh()
  await redirected.service.signInNative(ID)
  await until(() => redirected.traces().some(entry => entry.event === 'authenticate'), 'the sign-in to start')
  await sleep(300)
  assert.equal((await redirected.row()).signInUrl, undefined)
  assert.equal((await redirected.signedIn()).signInUrl, undefined)
})

const signInPid = (w, from) => w.envs().slice(from).at(-1)?.pid
async function endsClean(w, from) {
  const pid = await until(() => signInPid(w, from), 'the sign-in process')
  await until(() => gone(pid), 'the sign-in process to exit')
  // Nothing of the attempt stays tracked: a stop of its home answers at once.
  const stopped = await Promise.race([stopRuns(w.home()).then(() => true), sleep(1000).then(() => false)])
  assert.equal(stopped, true)
}

test('I3: a method not offered, a failure, no answer and a switch-off each end the attempt, and its process', unixOnly, async (t) => {
  plant(t)
  for (const [agentEnv, deps, word] of [
    [{ FAKE_ACP_AUTH_METHODS: 'other-method' }, {}, 'unsupported'],
    [{ FAKE_ACP_AUTH_FAIL: '1' }, {}, 'failed'],
    [{ FAKE_ACP_DEAF_TO: 'authenticate' }, { nativeSignInMs: 300 }, 'timeout'],
  ]) {
    const w = world(t, { agentEnv, deps })
    await w.service.refresh()
    const from = w.envs().length
    await w.service.signInNative(ID)
    const row = await w.signedIn()
    assert.equal(row.signInError, word)
    assert.equal(row.signedIn, false)
    // The page gets the word only; the command in the agy home goes to the log (#2048, owner).
    assert.equal(row.cli.signInHint, undefined)
    assert.equal(row.signInUrl, undefined)
    assert.ok(w.logs.some(line => line.startsWith(`acp-dsh: Antigravity: the sign-in ended (${word}); its terminal sign-in, for support: env -i `)), w.logs.join('\n'))
    if (word === 'unsupported') assert.deepEqual(w.traces().filter(entry => entry.event === 'authenticate'), [])
    await endsClean(w, from)
  }
  // Switched off while it waits: the attempt ends, with no error word to show.
  const w = world(t, { agentEnv: { FAKE_ACP_DEAF_TO: 'authenticate' } })
  await w.service.refresh()
  const from = w.envs().length
  await w.service.signInNative(ID)
  await until(() => signInPid(w, from), 'the sign-in process')
  w.config.antigravity = false
  w.emit('loader/volatile-update')
  const row = await w.signedIn()
  assert.equal(row.signInError, undefined)
  await endsClean(w, from)
})

test('I3: the refusals, and no browser on a Linux without a display', unixOnly, async (t) => {
  plant(t)
  const off = world(t, { config: { antigravity: false } })
  await assert.rejects(off.service.signInNative(ID), { code: 'acp-sign-in/off' })
  const missing = world(t, { external: false })
  await assert.rejects(missing.service.signInNative(ID), { code: 'acp-sign-in/missing' })
  await assert.rejects(missing.service.signInNative('acp-hermes'), { code: 'acp-sign-in/unsupported' })
  await assert.rejects(missing.service.signInNative('acp-claude'), { code: 'acp-sign-in/unsupported' })
  // No DISPLAY on Linux: Sign in answers that the browser did not open (#2048, owner), with no
  // command; the command in the agy home goes to the log only.
  delete process.env.DISPLAY
  const bare = world(t)
  assert.equal((await bare.row()).signInWhere, 'terminal')
  assert.equal((await bare.row()).cli.signInHint, undefined)
  await assert.rejects(bare.service.signInNative(ID), { code: 'acp-sign-in/no-display', message: 'The browser did not open. Try again.' })
  assert.ok(bare.logs.some(line => line.startsWith('acp-dsh: Antigravity: there is no browser on this computer; its terminal sign-in, for support: env -i ')
    && line.includes(`HOME='${bare.home()}'`)), bare.logs.join('\n'))
  for (const platform of ['darwin', 'win32']) {
    const other = world(t, { platform })
    assert.equal((await other.row()).signInWhere, undefined)
  }
  // Wayland with no X display: the app opens the browser in the person's session, so it can.
  process.env.WAYLAND_DISPLAY = 'wayland-0'
  try {
    const wayland = world(t)
    assert.equal((await wayland.row()).signInWhere, undefined)
  } finally { delete process.env.WAYLAND_DISPLAY }
})

test('I4: Sign out retires the home, stops its work, keeps the old one, and the next check is signed out', unixOnly, async (t) => {
  plant(t)
  const w = world(t)
  await w.service.refresh()
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  const old = w.home()
  assert.equal(old, join(w.cliHome, 'antigravity'))
  // A Session at work in the old home when the person signs out.
  const turn = w.turn('hang')
  await until(() => w.traces().some(entry => entry.event === 'new-session'), 'the Session to start')
  const result = await w.service.accountSignOutNative(ID)
  assert.equal(result.signedIn, false)
  assert.equal((await w.row()).signedIn, false)
  const chunks = await Promise.race([turn, sleep(10_000).then(() => 'still running')])
  assert.notEqual(chunks, 'still running')
  // A new generation; the old home is kept, with its retired marker.
  const pointer = readFileSync(join(w.cliHome, 'current', 'antigravity'), 'utf8')
  assert.match(pointer, UUID)
  assert.equal(existsSync(join(w.cliHome, 'homes', 'antigravity', pointer)), true)
  assert.equal(existsSync(old), true)
  assert.equal(existsSync(join(old, '.gemini', 'fake-signed-in')), true)
  assert.equal(existsSync(join(w.cliHome, 'retired', 'antigravity', 'legacy')), true)
  // The next check runs agy in the new, empty home.
  const from = w.envs().length
  await w.service.refresh()
  assert.equal((await w.row()).signedIn, false)
  assert.equal(w.envs().slice(from).at(-1).values.HOME, w.home())
  assert.notEqual(w.home(), old)
  assert.ok(w.logs.includes('acp-dsh: Antigravity sign-out over ACP: none'), w.logs.join('\n'))
  assert.deepEqual(w.traces().filter(entry => entry.event === 'logout'), [])
  // agy has no account read and no logout command: those routes still refuse it.
  await assert.rejects(w.service.accountSignOut(ID), { code: 'acp-account/unavailable' })
  await assert.rejects(w.service.accountConfirm(ID), { code: 'acp-account/invalid' })
  // No `<cli> logout` ever runs for agy: Sign out, restart and dispose.
  assert.deepEqual(await w.service.prepareRestart(), { ok: true })
  w.dispose()
  await sleep(50)
  assert.equal(w.logoutCalls.length, 0)
})

test('I5: a catalog kept from the old home does not say signed in after Sign out', unixOnly, async (t) => {
  plant(t)
  const w = world(t)
  await w.service.refresh()
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  await w.service.accountSignOutNative(ID)
  assert.equal((await w.service.inspect(ID)).signedIn, false)
  // The key names the home; an agent with no home keeps its key.
  assert.equal(launchOf(SPEC, '/x/agy', { cliEnv: { HOME: '/h/one' } }).key, 'native /x/agy /h/one')
  assert.equal(launchOf(AGENTS['acp-hermes'], '/x/hermes', { cliEnv: {} }).key, 'native /x/hermes')
})

test('I4: an agy that signs out over ACP is asked to, in the old home, before the retire', unixOnly, async (t) => {
  plant(t)
  const w = world(t, { agentEnv: { FAKE_ACP_LOGOUT: '1' } })
  await w.service.refresh()
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  assert.ok(w.logs.includes('acp-dsh: Antigravity offers sign-in methods: oauth-personal; sign-out over ACP: yes'))
  const old = w.home()
  const started = w.envs().length
  await w.service.accountSignOutNative(ID)
  const logouts = w.traces().filter(entry => entry.event === 'logout')
  assert.deepEqual(logouts.map(entry => entry.home), [old])
  // The logout run itself started isolated in the old home: no bus, no key, every folder there.
  const logoutRuns = w.envs().slice(started).filter(entry => entry.pid === logouts[0].pid)
  assert.equal(logoutRuns.length, 1)
  for (const entry of logoutRuns) checkIsolated(entry, old)
  assert.ok(w.logs.includes('acp-dsh: Antigravity sign-out over ACP: done'))
  assert.notEqual(w.home(), old)

  // One that never answers: Sign out still ends within its wait, and says so.
  const slow = world(t, { agentEnv: { FAKE_ACP_LOGOUT: '1', FAKE_ACP_DEAF_TO: 'logout' }, deps: { nativeLogoutMs: 300 } })
  await slow.service.refresh()
  await slow.service.signInNative(ID)
  assert.equal((await slow.signedIn()).signedIn, true)
  const slowOld = slow.home()
  await slow.service.accountSignOutNative(ID)
  assert.ok(slow.logs.includes('acp-dsh: Antigravity sign-out over ACP: failed'))
  assert.notEqual(slow.home(), slowOld)
})

test('I4: while Sign out waits on agy, a second Sign out and a Sign in are busy', unixOnly, async (t) => {
  plant(t)
  const w = world(t, { agentEnv: { FAKE_ACP_LOGOUT: '1', FAKE_ACP_DEAF_TO: 'logout' }, deps: { nativeLogoutMs: 1500 } })
  await w.service.refresh()
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  const first = w.service.accountSignOutNative(ID)
  await assert.rejects(w.service.accountSignOutNative(ID), { code: 'acp-account/busy' })
  await assert.rejects(w.service.signInNative(ID), { code: 'acp-account/busy' })
  assert.equal((await first).signedIn, false)
})

test('I4: a damaged agy pointer does not stop Sign out; Windows offers none', unixOnly, async (t) => {
  plant(t)
  const w = world(t)
  await w.service.refresh()
  writeFileSync(join(w.cliHome, 'current', 'antigravity'), 'not-a-generation')
  await w.service.accountSignOutNative(ID)
  assert.match(readFileSync(join(w.cliHome, 'current', 'antigravity'), 'utf8'), UUID)
  assert.ok(w.logs.includes('acp-dsh: Antigravity sign-out over ACP: failed'))

  const windows = world(t, { platform: 'win32' })
  await windows.service.refresh()
  assert.equal((await windows.row()).sharedAccount, true)
  await assert.rejects(windows.service.accountSignOutNative(ID), {
    code: 'acp-account/unavailable', message: 'Sign out is not available on Windows. Sign out in Antigravity itself.',
  })
  assert.equal(existsSync(join(windows.cliHome, 'current', 'antigravity')), false)
  assert.equal(windows.logoutCalls.length, 0)
})

test('I6: the terminal command in the agy home, by platform, for the log only; none for what the quoting cannot carry', unixOnly, async (t) => {
  plant(t)
  const w = world(t)
  // Owner decision (#2048): the status carries no command for Antigravity, signed out or not.
  await w.service.refresh()
  const row = await w.row()
  assert.equal(row.signedIn, false)
  assert.equal(Object.hasOwn(row.cli, 'signInHint'), false)
  assert.doesNotMatch(JSON.stringify(row), /acp --login|env -i/)
  // The chat and the login route point to Settings, never to the static command.
  assert.equal(w.adapter.agents.get(ID).signInHint, undefined)
  assert.equal(w.adapter.agents.get(ID).signInWhere, 'settings')
  assert.throws(() => w.service.loginStart(ID), (error) => {
    assert.equal(error.code, 'acp-login/app')
    assert.equal(error.message, 'Sign in to Antigravity in Settings, under Coding agents.')
    return !error.message.includes('agy acp --login')
  })
  // A null hint (an unsafe path) reaches no terminal command either.
  const logins = new CliLogins({ hintOf: () => null })
  try {
    assert.throws(() => logins.start(ID), error => error.code === 'acp-login/invalid' && !error.message.includes('agy acp --login'))
  } finally { logins.dispose() }

  // On POSIX the command reaches no session bus either.
  const at = '/srv/a/.automagik/acp/cli-homes/antigravity'
  assert.equal(isolatedSignInHintOf(SPEC, { path: '/srv/a/bin/agy' }, at, 'linux'),
    `env -i DBUS_SESSION_BUS_ADDRESS='unix:path=/dev/null/automagik-no-bus' PATH="$PATH" TERM="$TERM" LANG="$LANG" HOME='${at}' `
    + `XDG_CONFIG_HOME='${at}/config' XDG_DATA_HOME='${at}/data' XDG_CACHE_HOME='${at}/cache' XDG_STATE_HOME='${at}/state' '/srv/a/bin/agy' acp --login`)
  const win = 'C:\\Users\\a\\.automagik\\acp\\cli-homes\\antigravity'
  const exe = 'C:\\Users\\a\\AppData\\Local\\agy\\bin\\agy.exe'
  assert.equal(isolatedSignInHintOf(SPEC, { path: exe }, win, 'win32'),
    `$env:USERPROFILE="${win}"; $env:HOME="${win}"; $env:HOMEPATH="${win}"; $env:APPDATA="${win}\\roaming"; $env:LOCALAPPDATA="${win}\\local"; & "${exe}" acp --login`)
  for (const [path, at, platform] of [
    ['/srv/a/bin/agy', "/srv/o'hara/cli-homes/antigravity", 'linux'],
    ["/srv/o'hara/bin/agy", '/srv/a/cli-homes/antigravity', 'linux'],
    ['/srv/a`b/bin/agy', '/srv/a/cli-homes/antigravity', 'linux'],
    ['relative/agy', '/srv/a/cli-homes/antigravity', 'linux'],
    ['/srv/a/bin/agy', 'relative/antigravity', 'linux'],
    ['/srv/a/../b/agy', '/srv/a/cli-homes/antigravity', 'linux'],
    ['/srv/a/bin/agy.sh', '/srv/a/cli-homes/antigravity', 'linux'],
    [exe, 'C:\\Users\\a\u201Db\\cli-homes\\antigravity', 'win32'],
    [exe, 'C:\\Users\\a$b\\cli-homes\\antigravity', 'win32'],
    ['C:\\Users\\a`b\\agy.exe', win, 'win32'],
    ['C:\\Users\\a\\agy.cmd', win, 'win32'],
    ['/srv/a/bin/agy', win, 'win32'],
  ]) assert.equal(isolatedSignInHintOf(SPEC, { path }, at, platform), undefined, `${path} ${at}`)
  // The account is shared only on Windows.
  assert.equal((await w.row()).sharedAccount, undefined)
})

test('I7: an agy environment passes the generation fence, and the fence still holds', unixOnly, async (t) => {
  plant(t)
  const root = mkdtempSync(join(tmpdir(), 'agy-iso-fence-'))
  const homes = new CliHomes(join(root, 'cli-homes'))
  t.after(() => { homes.dispose(); rmSync(root, { recursive: true, force: true }) })
  const env = homes.environment('antigravity')
  assert.doesNotThrow(() => assertGeneration(env))
  assert.equal(homes.matches(env), true)
  const run = { spec: { env }, stop: async () => {} }
  assert.doesNotThrow(() => trackRun(run))
  await stopRuns(env[HOME_ENV])
  const broken = { ...env }
  delete broken.CODEX_HOME
  assert.throws(() => assertGeneration(broken), { code: 'acp-account/busy' })
})

test('I8: Sign in on a paused home retires it and signs in to a fresh one, in the same click', unixOnly, async (t) => {
  plant(t)
  // (a) A pause planted in the current home.
  const w = world(t)
  await w.service.refresh()
  const first = w.home()
  writeFileSync(join(first, 'paused'), '')
  await w.service.refresh()
  assert.equal((await w.row()).signedIn, false)
  await w.service.signInNative(ID)
  const row = await w.signedIn()
  assert.equal(row.signedIn, true)
  assert.equal(row.signInError, undefined)
  assert.equal(existsSync(join(w.cliHome, 'retired', 'antigravity', 'legacy')), true)
  const second = w.home()
  assert.notEqual(second, first)
  assert.equal(existsSync(join(second, 'paused')), false)

  // (b) A crash after the pointer moved: the new home is left paused.
  await w.service.accountSignOutNative(ID)
  const third = w.home()
  writeFileSync(join(third, 'paused'), '')
  await w.service.refresh()
  assert.equal((await w.row()).signedIn, false)
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  assert.notEqual(w.home(), third)

  // (c) A change lock still fails closed.
  mkdirSync(join(w.home(), 'changing'))
  await assert.rejects(w.service.signInNative(ID), { code: 'acp-account/busy' })
})

test('I8: a damaged pointer reads signed out, Sign in recovers it, and Check again answers for every agent', unixOnly, async (t) => {
  plant(t)
  const w = world(t)
  await w.service.refresh()
  writeFileSync(join(w.cliHome, 'current', 'antigravity'), 'not-a-generation')
  const status = await w.service.refresh()
  assert.equal(status.agents.find(row => row.id === ID).signedIn, false)
  assert.deepEqual(status.agents.map(row => row.id).sort(), Object.keys(AGENTS).sort())
  await w.service.signInNative(ID)
  assert.equal((await w.signedIn()).signedIn, true)
  assert.match(readFileSync(join(w.cliHome, 'current', 'antigravity'), 'utf8'), UUID)
})

test('I9: a damaged agy pointer never blocks restart or dispose; an unproved Claude stop still does', unixOnly, async (t) => {
  plant(t)
  const w = world(t)
  writeFileSync(join(w.cliHome, 'current', 'antigravity'), 'not-a-generation')
  // The Claude runs are still stopped: a tracked run's stop is called.
  const claudeHomes = new CliHomes(w.cliHome)
  let claudeStops = 0
  const stop = async () => { claudeStops++ }
  trackRun({ spec: { env: claudeHomes.environment('claude') }, stop })
  assert.deepEqual(await w.service.prepareRestart(), { ok: true })
  assert.equal(claudeStops, 1)
  claudeHomes.dispose()

  const d = world(t)
  writeFileSync(join(d.cliHome, 'current', 'antigravity'), 'not-a-generation')
  const instances = join(d.cliHome, 'instances', 'claude')
  assert.ok(readdirSync(instances).length > 0)
  d.dispose()
  await until(() => readdirSync(instances).length === 0, 'the instance records to be withdrawn', 5000)

  // A Claude run whose stop cannot be proved: the step fails, and the records stay.
  const c = world(t)
  writeFileSync(join(c.cliHome, 'current', 'antigravity'), 'not-a-generation')
  const other = new CliHomes(c.cliHome)
  const env = other.environment('claude')
  trackRun({ spec: { env }, stop: () => Promise.reject(new Error('The Bot process has not stopped. Try again.')) })
  const answer = await c.service.prepareRestart()
  assert.deepEqual(answer, { ok: false, step: 'runs' })
  assert.ok(readdirSync(join(c.cliHome, 'instances', 'claude')).length > 0)
  other.dispose()
})

// ---- r5: the app opens the sign-in link; agy never starts a browser (#2048, owner) ----------

const LOCAL_GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + '&redirect_uri=http%3A%2F%2Flocalhost%3A43117%2Fauth%2Fcallback&response_type=code&state=r5'
const STAND_IN = drop => `#!/bin/sh
# Automagik: hands agy's sign-in link to the app. It opens nothing and reads nothing else.
[ "$#" -eq 1 ] || exit 0
case "$1" in https://*) ;; *) exit 0 ;; esac
umask 077
printf '%s\\n' "$1" >> '${drop}/links'
exit 0
`
const ATTEMPT_BIN = /\/sign-in\/[0-9a-f-]{36}\/bin$/
// The env-file line of the sign-in run: the only one whose PATH leads with an attempt's folder.
const standInRuns = w => w.envs().filter(entry => ATTEMPT_BIN.test(entry.pathHead))
const mode = path => statSync(path).mode & 0o777

test('I10: on Linux a stand-in for agy\'s opener, on the sign-in run\'s PATH only, hands the link to the status', unixOnly, async (t) => {
  plant(t)
  const hour = 60 * 60 * 1000
  const OLD = 'aaaaaaaa-1111-2222-3333-444444444444'
  const NEW = 'bbbbbbbb-1111-2222-3333-444444444444'
  const w = world(t, {
    agentEnv: { FAKE_ACP_AUTH_OPEN: LOCAL_GOOGLE, FAKE_ACP_AUTH_HOLD: '1' },
    prepare: (dir) => {
      const root = join(dir, 'acp', 'sign-in')
      for (const name of [OLD, NEW, 'not-an-attempt']) mkdirSync(join(root, name, 'bin'), { recursive: true })
      writeFileSync(join(root, 'cccccccc-1111-2222-3333-444444444444'), '')
      const at = (name, ago) => { const when = new Date(Date.now() - ago); utimesSync(join(root, name), when, when) }
      at(OLD, 2 * hour)
      at(NEW, 60 * 1000)
      at('not-an-attempt', 2 * hour)
      at('cccccccc-1111-2222-3333-444444444444', 2 * hour)
    },
  })
  // Startup sweep: only an attempt's folder older than an hour goes.
  const root = join(w.dir, 'acp', 'sign-in')
  assert.deepEqual(readdirSync(root).sort(), ['bbbbbbbb-1111-2222-3333-444444444444', 'cccccccc-1111-2222-3333-444444444444', 'not-an-attempt'])
  await w.service.refresh()
  await w.turn()
  await w.service.signInNative(ID)
  const row = await until(async () => { const now = await w.row(); return now.signInUrl ? now : undefined }, 'the sign-in link')
  assert.equal(row.signInUrl, LOCAL_GOOGLE)
  assert.equal(row.signingIn, true)
  assert.ok(!w.logs.some(line => line.includes('accounts.google.com')), w.logs.join('\n'))
  assert.deepEqual(w.traces().filter(entry => entry.event === 'opener').map(entry => entry.found), [true])
  // The sign-in run's PATH leads with this attempt's folder, holding only the stand-in.
  const runs = standInRuns(w)
  assert.equal(runs.length, 1)
  const bin = runs[0].pathHead
  const drop = dirname(bin)
  assert.equal(dirname(drop), root)
  assert.match(runs[0].path, /\/bin/)
  assert.deepEqual(readdirSync(bin), ['xdg-open'])
  assert.equal(mode(drop), 0o700)
  assert.equal(mode(bin), 0o700)
  assert.equal(mode(join(bin, 'xdg-open')), 0o700)
  assert.equal(readFileSync(join(bin, 'xdg-open'), 'utf8'), STAND_IN(drop))
  assert.equal(readFileSync(join(drop, 'links'), 'utf8'), `${LOCAL_GOOGLE}\n`)
  // The probe and the Session never get it.
  const others = w.envs().filter(entry => entry.pid !== runs[0].pid)
  assert.ok(others.length >= 2)
  for (const entry of others) assert.doesNotMatch(entry.path, /\/sign-in\//)
  // Switched off: the attempt's folder goes with it.
  w.config.antigravity = false
  w.emit('loader/volatile-update')
  await w.signedIn()
  assert.equal(existsSync(drop), false)
})

test('I10: the stand-in hands over only an https link, and the read never follows a link or waits on a FIFO', unixOnly, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-iso-stand-in-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'xdg-open')
  writeFileSync(script, STAND_IN(dir), { mode: 0o700 })
  for (const args of [['http://example.com/x'], ['file:///etc/passwd'], [LOCAL_GOOGLE, 'extra'], []]) {
    assert.equal(spawnSync(script, args).status, 0)
  }
  assert.equal(existsSync(join(dir, 'links')), false)
  assert.equal(spawnSync(script, [LOCAL_GOOGLE]).status, 0)
  assert.equal(mode(join(dir, 'links')), 0o600)
  assert.deepEqual(readSignInLinks(join(dir, 'links')), [LOCAL_GOOGLE])
  // A line still being written is not read.
  appendFileSync(join(dir, 'links'), 'https://partial')
  assert.deepEqual(readSignInLinks(join(dir, 'links')), [LOCAL_GOOGLE])
  writeFileSync(join(dir, 'elsewhere'), `${LOCAL_GOOGLE}\n`)
  symlinkSync(join(dir, 'elsewhere'), join(dir, 'linked'))
  assert.deepEqual(readSignInLinks(join(dir, 'linked')), [])
  if (spawnSync('mkfifo', [join(dir, 'fifo')]).status === 0) assert.deepEqual(readSignInLinks(join(dir, 'fifo')), [])
  assert.deepEqual(readSignInLinks(join(dir, 'missing')), [])
})

test('I11: on Linux, no acceptable link soon after authenticate ends the attempt as no-browser', unixOnly, async (t) => {
  plant(t)
  for (const [agentEnv, refused] of [
    [{ FAKE_ACP_AUTH_HOLD: '1' }, undefined],
    [{ FAKE_ACP_AUTH_HOLD: '1', FAKE_ACP_AUTH_OPEN: LOCAL_GOOGLE.replace('accounts.google.com', 'evil.example') }, 'evil.example'],
    [{ FAKE_ACP_AUTH_HOLD: '1', FAKE_ACP_AUTH_OPEN: LOCAL_GOOGLE.replace('localhost%3A43117', 'evil.example%3A1') }, 'evil.example'],
  ]) {
    const w = world(t, { agentEnv, deps: { nativeSignInLinkMs: 300 } })
    await w.service.refresh()
    const from = w.envs().length
    await w.service.signInNative(ID)
    const row = await w.signedIn()
    assert.equal(row.signInError, 'no-browser')
    assert.equal(row.signedIn, false)
    assert.equal(row.signInUrl, undefined)
    assert.equal(Object.hasOwn(row.cli, 'signInHint'), false)
    assert.ok(w.logs.some(line => line.startsWith('acp-dsh: Antigravity: the browser did not open (agy handed no sign-in link); its terminal sign-in, for support: env -i ')), w.logs.join('\n'))
    if (refused !== undefined) {
      assert.deepEqual(w.traces().filter(entry => entry.event === 'opener').map(entry => entry.found), [true])
      assert.ok(!w.logs.some(line => line.includes(refused)), w.logs.join('\n'))
    }
    await endsClean(w, from)
    assert.deepEqual(readdirSync(join(w.dir, 'acp', 'sign-in')), [])
  }
  // Two different acceptable links: neither is shown, and the attempt ends.
  const w = world(t, { agentEnv: { FAKE_ACP_AUTH_OPEN: LOCAL_GOOGLE, FAKE_ACP_AUTH_HOLD: '1' } })
  await w.service.refresh()
  await w.service.signInNative(ID)
  await until(async () => (await w.row()).signInUrl, 'the sign-in link')
  const drop = dirname(standInRuns(w)[0].pathHead)
  appendFileSync(join(drop, 'links'), `${LOCAL_GOOGLE.replace('state=r5', 'state=other')}\n`)
  const row = await w.signedIn()
  assert.equal(row.signInError, 'no-browser')
  assert.equal(row.signInUrl, undefined)
  assert.ok(w.logs.some(line => line.startsWith('acp-dsh: Antigravity: the browser did not open (more than one sign-in link); ')), w.logs.join('\n'))
  assert.ok(!w.logs.some(line => line.includes('accounts.google.com')), w.logs.join('\n'))
})

test('I12: macOS stands in as `open` with no link rule; Windows has no stand-in', unixOnly, async (t) => {
  plant(t)
  const mac = world(t, { platform: 'darwin', agentEnv: { FAKE_ACP_AUTH_HOLD: '1' }, deps: { nativeSignInLinkMs: 300 } })
  await mac.service.refresh()
  await mac.service.signInNative(ID)
  await until(() => mac.traces().some(entry => entry.event === 'authenticate'), 'the sign-in to start')
  await sleep(600)
  const waiting = await mac.row()
  assert.equal(waiting.signingIn, true)
  assert.equal(waiting.signInError, undefined)
  assert.deepEqual(readdirSync(standInRuns(mac)[0].pathHead), ['open'])
  mac.config.antigravity = false
  mac.emit('loader/volatile-update')
  await mac.signedIn()
  const linked = world(t, { platform: 'darwin', agentEnv: { FAKE_ACP_AUTH_HOLD: '1', FAKE_ACP_OPENER: 'open', FAKE_ACP_AUTH_OPEN: LOCAL_GOOGLE } })
  await linked.service.refresh()
  await linked.service.signInNative(ID)
  assert.equal((await until(async () => (await linked.row()).signInUrl, 'the sign-in link')), LOCAL_GOOGLE)
  linked.config.antigravity = false
  linked.emit('loader/volatile-update')
  await linked.signedIn()

  const win = world(t, { platform: 'win32', agentEnv: { FAKE_ACP_AUTH_HOLD: '1', FAKE_ACP_AUTH_OPEN: LOCAL_GOOGLE }, deps: { nativeSignInLinkMs: 300 } })
  await win.service.refresh()
  const from = win.envs().length
  await win.service.signInNative(ID)
  await until(() => win.traces().some(entry => entry.event === 'authenticate'), 'the sign-in to start')
  await sleep(600)
  const row = await win.row()
  assert.equal(row.signingIn, true)
  assert.equal(row.signInError, undefined)
  assert.deepEqual(standInRuns(win), [])
  for (const entry of win.envs().slice(from)) assert.doesNotMatch(entry.path, /\/sign-in\//)
  assert.deepEqual(win.traces().filter(entry => entry.event === 'opener').map(entry => entry.found), [false])
  assert.equal(existsSync(join(win.dir, 'acp', 'sign-in')), false)
  win.config.antigravity = false
  win.emit('loader/volatile-update')
  await win.signedIn()
})

test('I13: the two log words ride on the status, equal to the log lines', unixOnly, async (t) => {
  plant(t)
  for (const [agentEnv, deps, overAcp, out] of [
    [{}, {}, 'no', 'none'],
    [{ FAKE_ACP_LOGOUT: '1' }, {}, 'yes', 'done'],
    [{ FAKE_ACP_LOGOUT: '1', FAKE_ACP_DEAF_TO: 'logout' }, { nativeLogoutMs: 300 }, 'yes', 'failed'],
  ]) {
    const w = world(t, { agentEnv, deps })
    await w.service.refresh()
    const before = await w.row()
    assert.equal(before.signOutOverAcp, undefined)
    assert.equal(before.lastSignOut, undefined)
    await w.service.signInNative(ID)
    const row = await w.signedIn()
    assert.equal(row.signedIn, true)
    assert.equal(row.signOutOverAcp, overAcp)
    assert.ok(w.logs.includes(`acp-dsh: Antigravity offers sign-in methods: oauth-personal; sign-out over ACP: ${overAcp}`), w.logs.join('\n'))
    assert.equal(row.lastSignOut, undefined)
    await w.service.accountSignOutNative(ID)
    const after = await w.row()
    assert.equal(after.lastSignOut, out)
    assert.ok(w.logs.includes(`acp-dsh: Antigravity sign-out over ACP: ${out}`), w.logs.join('\n'))
    assert.equal(after.signOutOverAcp, overAcp)
    // A following Sign in click clears the sign-out word.
    await w.service.signInNative(ID)
    assert.equal((await w.row()).lastSignOut, undefined)
    assert.equal((await w.signedIn()).lastSignOut, undefined)
  }
  // A Sign in whose recovery of a paused home fails keeps no sign-out word from that recovery.
  const w = world(t)
  await w.service.refresh()
  await w.service.accountSignOutNative(ID)
  assert.equal((await w.row()).lastSignOut, 'none')
  const home = w.home()
  writeFileSync(join(home, 'paused'), '')
  rmSync(join(home, 'version'), { force: true })
  mkdirSync(join(home, 'version'))
  const logs = w.logs.length
  const answered = (await w.service.signInNative(ID)).agents.find(entry => entry.id === ID)
  assert.equal(answered.signInError, 'failed')
  assert.ok(w.logs.slice(logs).includes('acp-dsh: Antigravity sign-out over ACP: none'), w.logs.slice(logs).join('\n'))
  assert.equal(answered.lastSignOut, undefined)
})
