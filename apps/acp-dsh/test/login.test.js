// Sign-in attempts (login.js, plan v3 2.3): fake native processes and a fake clock; no account,
// network, home or real CLI is touched.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { ANSWER_TIMEOUT_MS, CliLogins, isLoginUrl, LINK_TTL_MS, providerExpiry, RETAIN_MS, STARTUP_MS, STATE_TTL_MS } from '../src/host/login.js'

const CLAUDE = 'acp-claude'
const CODEX = 'acp-codex'
const STATE = 'expected_state_0123456789'
const CLAUDE_URL = `https://claude.com/cai/oauth/authorize?code=true&client_id=public&state=${STATE}&code_challenge=public-challenge`
const CODEX_URL = 'https://auth.openai.com/codex/device'
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

class Clock {
  now = 1_000_000
  jobs = new Map()
  setTimeout = (run, delay) => {
    const timer = { unref() {} }
    this.jobs.set(timer, { run, at: this.now + delay })
    return timer
  }
  clearTimeout = timer => { this.jobs.delete(timer) }
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

const childProcess = () => {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.writes = []
  child.kills = []
  child.exitCode = null
  child.signalCode = null
  child.stdin.on('data', chunk => child.writes.push(String(chunk)))
  child.kill = signal => { child.kills.push(signal); return true }
  child.close = code => { child.exitCode = code; child.emit('close', code) }
  return child
}

function harness(options = {}) {
  const clock = new Clock()
  const selected = { cli: '/managed/cli/current', env: { HOME: '/automagik/private-home', CODEX_HOME: '/automagik/codex', CLAUDE_CONFIG_DIR: '/automagik/claude', PATH: '/runtime/bin', DISABLE_UPDATES: '1' } }
  const children = []
  const checks = []
  const ready = []
  const counts = []
  let signedIn = false
  const logins = new CliLogins({
    resolve: async () => selected,
    signedIn: async (spec, cli, { env }) => { checks.push({ spec, cli, env }); return signedIn },
    onReady: async (id, snapshot) => { ready.push({ id, snapshot }) },
    onChange: count => counts.push(count),
    spawn: (file, args, opts) => {
      const child = childProcess()
      children.push({ file, args, opts, child })
      return child
    },
    now: () => clock.now,
    timers: clock,
    ...options,
  })
  return { logins, clock, selected, children, checks, ready, counts, authenticated: (value = true) => { signedIn = value } }
}

function showClaudeLink(child, url = CLAUDE_URL) {
  // Actual native CLI text is OSC-hyperlinked. Deliberately split inside escapes and the URL.
  const output = `Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\\nPaste code here if prompted > `
  for (let at = 0; at < output.length; at += 7) child.stdout.write(output.slice(at, at + 7))
}

const jsonRequests = child => child.writes.flatMap(chunk => chunk.trim().split('\n')).filter(Boolean).map(line => JSON.parse(line))
const sendJson = (child, value) => child.stdout.write(`${JSON.stringify(value)}\n`)

async function codexWaiting(h, result = {}) {
  const started = h.logins.start(CODEX)
  await settle()
  const child = h.children.at(-1).child
  sendJson(child, { id: jsonRequests(child)[0].id, result: {} })
  await settle()
  const login = jsonRequests(child).find(row => row.method === 'account/login/start')
  sendJson(child, { id: login.id, result: { type: 'chatgptDeviceCode', loginId: 'login-123', verificationUrl: CODEX_URL, userCode: 'ABCD-1234', ...result } })
  await settle()
  return { started, child }
}

test('sign-in URLs reject lookalikes, userinfo, controls, ports, schemes and a Claude link without the manual code', () => {
  assert.equal(isLoginUrl(CODEX, CODEX_URL), true)
  assert.equal(isLoginUrl(CLAUDE, CLAUDE_URL), true)
  assert.equal(isLoginUrl(CLAUDE, `https://claude.ai/oauth/authorize?code=true&state=${STATE}`), true)
  for (const bad of [
    'https://auth.openai.com.evil.test/codex/device',
    'https://auth.openai.com@evil.test/codex/device',
    'https://' + 'user' + '@auth.openai.com/codex/device',
    'https://auth.openai.com:8443/codex/device',
    'http://auth.openai.com/codex/device',
    'javascript:alert(1)',
    'file:///tmp/login',
    'https://auth.openai.com/codex/device#access_token=private',
    'https://auth.openai.com/codex/device?code=private',
    'https://auth.openai.com/codex/device\n',
    'https://auth.openai.com/another-path',
  ]) assert.equal(isLoginUrl(CODEX, bad), false, bad)
  // H5: without code=true the page sends the code to a local callback no other device reaches.
  for (const bad of [
    `https://claude.com/cai/oauth/authorize?state=${STATE}`,
    `https://claude.com/cai/oauth/authorize?code=false&state=${STATE}`,
    'https://claude.com/cai/oauth/authorize?code=true',
    'https://claude.com/cai/oauth/authorize?code=true&state=short',
    `https://claude.com/cai/oauth/authorize?code=true&state=${STATE}#x`,
  ]) assert.equal(isLoginUrl(CLAUDE, bad), false, bad)
  assert.equal(isLoginUrl(CLAUDE, CODEX_URL), false)
  assert.equal(isLoginUrl(CODEX, CLAUDE_URL), false)
})

test('any view gets the live attempt back: a second start, current and status never make another or cancel it', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  assert.equal(h.children.length, 0)
  assert.equal(h.logins.current(CLAUDE), undefined)
  const started = h.logins.start(CLAUDE, { label: 'first-bot' })
  await settle()
  const child = h.children[0].child
  showClaudeLink(child)
  // Another window, a reloaded page, another Bot: the same attempt, never busy.
  const again = h.logins.start(CLAUDE, { label: 'second-bot' })
  assert.equal(again.attemptId, started.attemptId)
  assert.equal(again.openedBy, 'first-bot', 'the opener stays the label')
  assert.deepEqual(h.logins.current(CLAUDE), again)
  assert.equal(h.logins.status(CLAUDE, started.attemptId).url, CLAUDE_URL)
  assert.equal(h.children.length, 1)
  assert.deepEqual(child.kills, [])
  assert.deepEqual(child.writes, [])
  assert.throws(() => h.logins.status(CLAUDE, 'guessed-attempt'), { code: 'acp-login/not-found' })
  assert.throws(() => h.logins.cancel(CLAUDE, 'guessed-attempt'), { code: 'acp-login/not-found' })
  assert.throws(() => h.logins.status(CODEX, started.attemptId), { code: 'acp-login/not-found' })
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'waiting')
  // A label is a name only: anything that is not a plain id is dropped.
  const other = harness()
  t.after(() => other.logins.dispose())
  assert.equal(other.logins.start(CODEX, { label: '../<script>' }).openedBy, undefined)
})

test('Claude accepts only its complete code and sends it directly to the original CLI stdin', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  await settle()
  const { file, args, opts, child } = h.children[0]
  const original = { cli: h.selected.cli, env: { ...h.selected.env } }
  showClaudeLink(child)
  const waiting = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(waiting.prompt.secret, true)
  assert.equal(waiting.expiresBy, 'app')
  h.selected.cli = '/other/newer/claude'
  h.selected.env.HOME = '/other/account'
  for (const bad of ['token-only', 'code#wrong_state', `code\n#${STATE}`, `code\x1b#${STATE}`, `code#extra#${STATE}`, `${'x'.repeat(8192)}#${STATE}`]) {
    assert.throws(() => h.logins.answer(CLAUDE, started.attemptId, bad), { code: 'acp-login/invalid-code' })
  }
  assert.deepEqual(child.writes, [])
  const secret = `private-authorization-code#${STATE}`
  const pending = h.logins.answer(CLAUDE, started.attemptId, secret)
  assert.deepEqual(child.writes, [`${secret}\n`])
  assert.equal(JSON.stringify(pending).includes('private-authorization-code'), false)
  assert.equal(pending.prompt, undefined)
  assert.equal(pending.checking, true)
  assert.equal(file, original.cli)
  assert.deepEqual(args, ['auth', 'login', '--claudeai'])
  assert.equal(opts.env.HOME, original.env.HOME)
  assert.ok(isAbsolute(opts.env.BROWSER))
  assert.equal(existsSync(opts.env.BROWSER), false)
  const browserDirectory = dirname(opts.env.BROWSER)
  assert.deepEqual(readdirSync(browserDirectory), [])
  if (process.platform !== 'win32') assert.equal(statSync(browserDirectory).mode & 0o777, 0o700)
  child.stderr.write(`Credential ${secret} should never be sent to the page`)
  h.authenticated()
  child.close(0)
  await settle()
  const done = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(done.status, 'ready')
  assert.equal(done.url, undefined)
  assert.equal(done.prompt, undefined)
  assert.equal(done.checking, undefined)
  assert.doesNotMatch(JSON.stringify(done), /private-authorization-code|expected_state/)
  assert.equal(h.checks.at(-1).cli, original.cli)
  assert.deepEqual(h.checks.at(-1).env, original.env)
  assert.deepEqual(h.ready[0].snapshot, original)
  assert.equal(existsSync(browserDirectory), false)
})

test('H4: a CLI that stays silent after the code fails at the absolute confirmation deadline', async t => {
  for (const signedIn of [false, true]) {
    const h = harness()
    t.after(() => h.logins.dispose())
    const started = h.logins.start(CLAUDE)
    await settle()
    const child = h.children[0].child
    showClaudeLink(child)
    // Answered close to the link's end: the link expiry no longer applies once a code is sent.
    h.clock.advance(LINK_TTL_MS - 1000)
    h.logins.answer(CLAUDE, started.attemptId, `code#${STATE}`)
    h.clock.advance(5000)
    assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'waiting')
    h.authenticated(signedIn)
    h.clock.advance(ANSWER_TIMEOUT_MS - 5000)
    await settle()
    const view = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(view.status, 'failed')
    assert.ok(child.kills.includes('SIGTERM'))
    assert.equal(h.ready.length, 0)
  }
  assert.ok(ANSWER_TIMEOUT_MS >= 60_000 && ANSWER_TIMEOUT_MS <= 90_000)
})

test('H19: the app limit counts from the link shown; the CLI first has its startup time to print it', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  await settle()
  assert.equal(h.logins.status(CLAUDE, started.attemptId).expiresAt, undefined)
  h.clock.advance(STARTUP_MS - 5000)
  const shownAt = h.clock.now
  showClaudeLink(h.children[0].child)
  const waiting = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(waiting.expiresAt, shownAt + LINK_TTL_MS)
  assert.equal(waiting.expiresBy, 'app')
  h.clock.advance(LINK_TTL_MS - 1)
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'waiting')
  h.clock.advance(1)
  const expired = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(expired.status, 'expired')
  assert.equal(expired.url, undefined)

  const silent = harness()
  t.after(() => silent.logins.dispose())
  const stuck = silent.logins.start(CODEX)
  await settle()
  silent.clock.advance(STARTUP_MS)
  assert.equal(silent.logins.status(CODEX, stuck.attemptId).status, 'failed')
  // An ended attempt is not the live one: the next start makes a new attempt.
  assert.notEqual(silent.logins.start(CODEX).attemptId, stuck.attemptId)
})

test('a deadline timer that fires early sets itself again: the attempt ends with no view reading it', async t => {
  // Node may run a timer a few ms before Date.now() reaches its deadline (cached loop time).
  const clock = new Clock()
  const schedule = clock.setTimeout
  clock.setTimeout = (run, delay) => schedule(run, delay > 1 ? delay - 1 : delay)
  const h = harness({ now: () => clock.now, timers: clock })
  t.after(() => h.logins.dispose())
  h.logins.start(CLAUDE)
  await settle()
  showClaudeLink(h.children[0].child)
  assert.deepEqual(h.counts, [1])
  clock.advance(LINK_TTL_MS)
  assert.deepEqual(h.counts, [1, 0], 'the busy count falls with nobody reading')
  assert.deepEqual(h.children[0].child.kills, ['SIGTERM'])

  const silent = harness({ now: () => clock.now, timers: clock })
  t.after(() => silent.logins.dispose())
  silent.logins.start(CODEX)
  await settle()
  clock.advance(STARTUP_MS)
  assert.deepEqual(silent.counts, [1, 0])
  assert.deepEqual(silent.children[0].child.kills, ['SIGTERM'])
})

test('a provider-reported expiry is honoured: the app never ends a device code before it', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const shownAt = h.clock.now
  const { started } = await codexWaiting(h, { expiresIn: 15 * 60 })
  const waiting = h.logins.status(CODEX, started.attemptId)
  assert.equal(waiting.expiresBy, 'provider')
  assert.equal(waiting.expiresAt, shownAt + 15 * 60 * 1000)
  h.clock.advance(LINK_TTL_MS + 60_000)
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'waiting')
  h.clock.advance(15 * 60 * 1000 - LINK_TTL_MS - 60_000 - 1)
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'waiting')
  h.clock.advance(1)
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'expired')
  // The shapes a report may take, against a real clock: ISO, epoch seconds or milliseconds.
  const now = Date.UTC(2026, 10, 9)
  assert.equal(providerExpiry({ expiresAt: new Date(now + 60_000).toISOString() }, now), now + 60_000)
  assert.equal(providerExpiry({ expiresAt: (now + 60_000) / 1000 }, now), now + 60_000)
  assert.equal(providerExpiry({ expiresAt: now + 60_000 }, now), now + 60_000)
  assert.equal(providerExpiry({ expiresAt: now - 1 }, now), undefined)
  assert.equal(providerExpiry({ expiresAt: now + 10 * 60 * 60 * 1000 }, now), now + 60 * 60 * 1000, 'capped')
  assert.equal(providerExpiry({ expiresIn: 'soon' }, now), undefined)
  assert.equal(providerExpiry({}, now), undefined)
})

test('Codex uses remote device login only, never a callback or a pasted token', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CODEX)
  await settle()
  const { child, args } = h.children[0]
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://'])
  const init = jsonRequests(child)[0]
  assert.equal(init.method, 'initialize')
  assert.deepEqual(init.params.capabilities, { experimentalApi: false })
  child.stdout.write('null\n[]\n42\n"private diagnostic"\ntrue\n')
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'starting')
  sendJson(child, { id: init.id, result: { userAgent: 'fake-codex' } })
  await settle()
  const requested = jsonRequests(child)
  assert.deepEqual(requested.map(row => row.method), ['initialize', 'initialized', 'account/login/start'])
  assert.deepEqual(requested[2].params, { type: 'chatgptDeviceCode' })
  const answer = `${JSON.stringify({ id: requested[2].id, result: { type: 'chatgptDeviceCode', loginId: 'login-123', verificationUrl: CODEX_URL, userCode: 'ABCD-1234' } })}\n`
  for (let at = 0; at < answer.length; at += 5) child.stdout.write(answer.slice(at, at + 5))
  await settle()
  const waiting = h.logins.status(CODEX, started.attemptId)
  assert.equal(waiting.url, CODEX_URL)
  assert.equal(waiting.userCode, 'ABCD-1234')
  assert.equal(waiting.prompt, undefined)
  assert.equal(waiting.expiresBy, 'app')
  assert.throws(() => h.logins.answer(CODEX, started.attemptId, 'unrelated-token'), { code: 'acp-login/invalid' })
  h.authenticated()
  sendJson(child, { method: 'account/login/completed', params: { loginId: 'someone-elses-login', success: true } })
  await settle()
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'waiting')
  sendJson(child, { method: 'account/login/completed', params: { loginId: 'login-123', success: true } })
  await settle()
  const done = h.logins.status(CODEX, started.attemptId)
  assert.equal(done.status, 'ready')
  assert.equal(done.url, undefined)
  assert.equal(done.userCode, undefined)
  assert.equal(h.children.length, 1)
})

test('a successful protocol notification without CLI credentials is a failure, never ready', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const { started, child } = await codexWaiting(h)
  sendJson(child, { method: 'account/login/completed', params: { loginId: 'login-123', success: true } })
  await settle()
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'failed')
  assert.equal(h.ready.length, 0)
})

test('device login errors and unsupported results never fall back to local browser login', async t => {
  for (const response of [
    { error: { code: -32000, message: 'device code login is not enabled for secret-account@example.test' } },
    { error: { code: -32000, message: 'network failed with private-device-token' } },
    { result: { type: 'chatgpt', loginId: 'local', authUrl: 'http://localhost:1455/auth/callback?code=private' } },
    { result: { type: 'chatgptDeviceCode', loginId: 'remote', verificationUrl: CODEX_URL, userCode: 'bad\ncode' } },
    { result: { type: 'chatgptDeviceCode', loginId: 'remote', verificationUrl: `${CODEX_URL}?private=secret`, userCode: 'ABCD-1234' } },
  ]) {
    const h = harness()
    t.after(() => h.logins.dispose())
    const started = h.logins.start(CODEX)
    await settle()
    const child = h.children[0].child
    sendJson(child, { id: jsonRequests(child)[0].id, result: {} })
    await settle()
    const login = jsonRequests(child).find(row => row.method === 'account/login/start')
    sendJson(child, { id: login.id, ...response })
    await settle()
    const failed = h.logins.status(CODEX, started.attemptId)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.url, undefined)
    assert.equal(failed.userCode, undefined)
    assert.doesNotMatch(JSON.stringify(failed), /private|secret-account|localhost/)
    assert.equal(h.children.length, 1)
  }
})

test('Claude and Codex run at the same time, independently; the browser block is scoped and cleaned up', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const browserBefore = process.env.BROWSER
  h.selected.env.BROWSER = '/user/normal-browser'
  const original = { ...h.selected.env }
  const claude = h.logins.start(CLAUDE, { label: 'first-bot' })
  const codex = h.logins.start(CODEX, { label: 'second-bot' })
  await settle()
  assert.equal(h.children.length, 2)
  assert.equal(h.logins.activeAttempts(), 2)
  const nativeClaude = h.children.find(row => row.args[0] === 'auth')
  const nativeCodex = h.children.find(row => row.args[0] === 'app-server')
  const directory = dirname(nativeClaude.opts.env.BROWSER)
  assert.equal(nativeCodex.opts.env.BROWSER, original.BROWSER)
  assert.deepEqual(h.selected.env, original)
  assert.notEqual(claude.attemptId, codex.attemptId)
  showClaudeLink(nativeClaude.child)
  h.logins.cancel(CLAUDE, claude.attemptId)
  assert.equal(existsSync(directory), false)
  assert.equal(h.logins.status(CODEX, codex.attemptId).status, 'starting')
  assert.deepEqual(nativeCodex.child.kills, [])
  assert.equal(h.logins.activeAttempts(), 1)
  h.logins.dispose()
  assert.equal(process.env.BROWSER, browserBefore)
  assert.equal(h.logins.activeAttempts(), 0)
  assert.deepEqual(h.counts, [1, 2, 1, 0])
})

test('cancel before CLI resolution and cancel during confirmation cannot become a late success', async t => {
  const resolving = deferred()
  const h = harness({ resolve: () => resolving.promise })
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  h.logins.cancel(CLAUDE, started.attemptId)
  resolving.resolve(h.selected)
  await settle()
  assert.equal(h.children.length, 0)
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'cancelled')

  const confirming = deferred()
  let checks = 0
  const next = harness({ signedIn: () => ++checks === 1 ? Promise.resolve(false) : confirming.promise })
  t.after(() => next.logins.dispose())
  const running = next.logins.start(CLAUDE)
  await settle()
  next.children[0].child.close(0)
  await settle()
  next.logins.cancel(CLAUDE, running.attemptId)
  confirming.resolve(true)
  await settle()
  assert.equal(next.logins.status(CLAUDE, running.attemptId).status, 'cancelled')
  assert.deepEqual(next.ready, [])
})

test('an ended attempt is readable for its retention, then not found; a stuck process is killed', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  await settle()
  const child = h.children[0].child
  showClaudeLink(child)
  h.clock.advance(LINK_TTL_MS)
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'expired')
  assert.equal(h.logins.current(CLAUDE), undefined)
  assert.deepEqual(child.kills, ['SIGTERM'])
  h.clock.advance(1000)
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL'])
  child.close(0)
  await settle()
  assert.deepEqual(h.ready, [])
  h.clock.advance(RETAIN_MS)
  assert.throws(() => h.logins.status(CLAUDE, started.attemptId), { code: 'acp-login/not-found' })
  assert.equal(h.clock.jobs.size, 0)
})

test('existing authentication returns ready without starting another auth process', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  h.authenticated()
  const started = h.logins.start(CODEX)
  await settle()
  assert.equal(h.logins.status(CODEX, started.attemptId).status, 'ready')
  assert.equal(h.children.length, 0)
  assert.equal(h.ready.length, 1)
})

test('loginTextMatches: a shown state is recognised for a day in any message shape, and only as a boolean', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  assert.equal(h.logins.textMatches(`code#${STATE}`), false, 'nothing shown yet')
  const started = h.logins.start(CLAUDE)
  await settle()
  showClaudeLink(h.children[0].child)
  for (const text of [
    `code#${STATE}`,
    `  here it is: abc123#${STATE}\n`,
    `prefix text abc#${STATE}trailing`,
    `abc#${STATE.slice(0, 10)}\n${STATE.slice(10)}`,
    `abc#${STATE.slice(0, 5)}​${STATE.slice(5)}`,
  ]) assert.equal(h.logins.textMatches(text), true, JSON.stringify(text))
  for (const text of [STATE, `code#${STATE.slice(0, -1)}`, 'code#another_state_0123456789', '', undefined, 42]) {
    assert.equal(h.logins.textMatches(text), false, JSON.stringify(text))
  }
  // The attempt ends (cancel, success, expiry): the state is gone from every view, still recognised.
  h.logins.cancel(CLAUDE, started.attemptId)
  assert.doesNotMatch(JSON.stringify(h.logins.status(CLAUDE, started.attemptId)), new RegExp(STATE))
  assert.equal(h.logins.textMatches(`code#${STATE}`), true)
  assert.equal(JSON.stringify([...h.logins.states.keys()]).includes(STATE), false, 'only keyed hashes are kept')
  h.clock.advance(STATE_TTL_MS - 1)
  assert.equal(h.logins.textMatches(`code#${STATE}`), true)
  h.clock.advance(1)
  assert.equal(h.logins.textMatches(`code#${STATE}`), false)
})

test('disposal ends every attempt, kills the CLI and forgets the states; nothing becomes ready after', async t => {
  const h = harness()
  const { started, child } = await codexWaiting(h)
  h.logins.dispose()
  h.authenticated()
  sendJson(child, { method: 'account/login/completed', params: { loginId: 'login-123', success: true } })
  child.close(0)
  await settle()
  assert.equal(h.ready.length, 0)
  assert.ok(child.kills.includes('SIGTERM'))
  assert.throws(() => h.logins.status(CODEX, started.attemptId), { code: 'acp-login/not-found' })
  assert.throws(() => h.logins.start(CODEX), { code: 'acp-login/disposed' })
  t.after(() => {})
})

test('unsupported OAuth links and oversized process output never echo account diagnostics', async t => {
  for (const output of [
    'If the browser did not open, visit: https://evil.test/oauth/authorize?private=secret\nPaste code here if prompted > ',
    `If the browser did not open, visit: https://claude.com/cai/oauth/authorize?state=${STATE}\nPaste code here if prompted > `,
    'sensitive-account-data'.repeat(4000),
  ]) {
    const h = harness()
    t.after(() => h.logins.dispose())
    const started = h.logins.start(CLAUDE)
    await settle()
    h.children[0].child.stdout.write(output)
    const result = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(result.status, 'failed')
    assert.equal(result.url, undefined)
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(JSON.stringify(result).includes('sensitive-account-data'), false)
    assert.equal(h.logins.textMatches(`x#${STATE}`), false, 'a refused link records no state')
  }
})

// F5: a sign-in never updates the CLI on its own, whoever installed it (clis.js asks --version
// the same way); Automagik's own install keeps a managed CLI current.
test('the sign-in process runs with the CLI\'s own updates off', async () => {
  const h = harness()
  h.selected.env = { HOME: '/automagik/private-home', PATH: '/runtime/bin' }
  await codexWaiting(h)
  assert.equal(h.children[0].opts.env.DISABLE_UPDATES, '1')
  assert.equal(h.children[0].opts.env.HOME, '/automagik/private-home')
})

// #871 (L4): the check runs on every send and delivery for a day after a Claude link was shown,
// so its cost is bounded per call: one keyed hash per distinct candidate, not one per `#token`.
test('loginTextMatches: a megabyte of text costs one hash per distinct candidate, and a state in it is still found', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  h.logins.start(CLAUDE)
  await settle()
  showClaudeLink(h.children[0].child)
  let hashes = 0
  const hashState = h.logins.hashState.bind(h.logins)
  h.logins.hashState = (state) => { hashes += 1; return hashState(state) }
  const counted = (text) => { hashes = 0; const found = h.logins.textMatches(text); return { found, hashes } }
  const other = 'another_state_0123456789x'
  assert.equal(other.length, STATE.length)

  // One token repeated to the megabyte: hashed once, whichever reading it is found in.
  const repeated = `#${other} `.repeat(Math.ceil(1_000_000 / (other.length + 2)))
  assert.ok(repeated.length >= 1_000_000)
  assert.deepEqual(counted(repeated), { found: false, hashes: 1 })

  // Every token different: never more than the stated bound, 2 x 1,000,000 / (length + 1).
  let distinct = ''
  for (let index = 0; distinct.length < 1_000_000; index++) distinct += `#${String(index).padStart(STATE.length, 'a')} `
  const worst = counted(distinct)
  assert.equal(worst.found, false)
  assert.ok(worst.hashes <= Math.ceil(2 * 1_000_000 / (STATE.length + 1)), `${worst.hashes} hashes`)

  // The shown state is found among the repeats, before and after them, in either reading.
  const half = repeated.slice(0, 400_000)
  assert.equal(counted(`${half}code#${STATE} ${half}`).found, true)
  assert.equal(counted(`${half}code#${STATE.slice(0, 7)} ${STATE.slice(7)}`).found, true)
  assert.equal(counted(`code#${STATE} ${half}`).hashes, 1, 'a match ends the check')
  // A token that only starts like the repeated one is its own candidate.
  assert.equal(counted(`#${other} #${other.slice(0, -1)}Z #${other}`).hashes, 2)
})

test('confirmation succeeds before the absolute deadline without renewing it at CLI exit', async t => {
  const activity = []
  const h = harness({ onActivity: value => activity.push(value) })
  t.after(() => h.logins.dispose())
  const start = h.logins.start(CLAUDE)
  await settle()
  const child = h.children[0].child
  showClaudeLink(child)
  assert.deepEqual(h.logins.activity(), { active: 1, confirming: 0 })
  h.logins.answer(CLAUDE, start.attemptId, `code#${STATE}`)
  const until = h.logins.activity().confirmingUntil
  h.clock.advance(ANSWER_TIMEOUT_MS - 1)
  h.authenticated(true)
  child.close(0)
  await settle()
  assert.equal(h.logins.status(CLAUDE, start.attemptId).status, 'ready')
  assert.equal(h.ready.length, 1)
  assert.equal(activity.filter(value => value.confirming > 0).every(value => value.confirmingUntil === until), true)
  assert.deepEqual(h.logins.activity(), { active: 0, confirming: 0 })
})

for (const late of ['signedIn', 'onReady']) {
  test(`absolute confirmation expiry fences deferred ${late}, including a replacement attempt`, async t => {
    const gate = deferred()
    let checking = false
    let commits = 0
    let guard
    const h = harness({
      signedIn: async () => checking ? (late === 'signedIn' ? gate.promise : true) : false,
      onReady: async (_id, _selected, { valid }) => {
        guard = valid
        await gate.promise
        if (valid()) commits++
      },
    })
    t.after(() => h.logins.dispose())
    const start = h.logins.start(CLAUDE)
    await settle()
    const child = h.children[0].child
    showClaudeLink(child)
    h.logins.answer(CLAUDE, start.attemptId, `code#${STATE}`)
    const deadline = h.logins.activity().confirmingUntil
    h.clock.advance(20_000)
    checking = true
    child.close(0)
    await settle()
    assert.equal(h.logins.activity().confirmingUntil, deadline)
    h.clock.advance(ANSWER_TIMEOUT_MS - 20_000)
    assert.equal(h.logins.status(CLAUDE, start.attemptId).status, 'failed')
    assert.deepEqual(h.logins.activity(), { active: 0, confirming: 0 })
    if (guard) assert.equal(guard(), false)
    checking = false
    const replacement = h.logins.start(CLAUDE)
    await settle()
    gate.resolve(true)
    await settle()
    assert.equal(commits, 0)
    assert.notEqual(replacement.attemptId, start.attemptId)
    assert.equal(h.logins.current(CLAUDE).attemptId, replacement.attemptId)
    assert.equal(h.logins.current(CLAUDE).status, 'starting')
  })
}
