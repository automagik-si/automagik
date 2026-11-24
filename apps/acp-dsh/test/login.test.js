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
const SHORT_CLAUDE_QUERY = `A${'b'.repeat(43)}`
const SHORT_CLAUDE_ENDPOINT = 'https://claude.ai/oauth/authorize'
const SHORT_CLAUDE_URL = `${SHORT_CLAUDE_ENDPOINT}?${SHORT_CLAUDE_QUERY}`
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
  ]) assert.equal(isLoginUrl(CODEX, bad), false, 'invalid Codex sign-in link')
  // H5: without code=true the page sends the code to a local callback no other device reaches.
  for (const bad of [
    `https://claude.com/cai/oauth/authorize?state=${STATE}`,
    `https://claude.com/cai/oauth/authorize?code=false&state=${STATE}`,
    'https://claude.com/cai/oauth/authorize?code=true',
    'https://claude.com/cai/oauth/authorize?code=true&state=short',
    `https://claude.com/cai/oauth/authorize?code=true&state=${STATE}#x`,
  ]) assert.equal(isLoginUrl(CLAUDE, bad), false, 'invalid Claude sign-in link')
  assert.equal(isLoginUrl(CLAUDE, SHORT_CLAUDE_URL), false, 'compact Claude sign-in link')
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
    // The fixed cause travels on the ended attempt, so the surface above can say why without
    // ever moving what the CLI printed.
    assert.equal(view.cause, 'the CLI did not confirm the sign-in')
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

test('an ended attempt carries its fixed cause; a live one carries none', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  await settle()
  // Still live: nothing to explain.
  assert.equal(h.logins.status(CLAUDE, started.attemptId).cause, undefined)
  // The CLI exits before it prints a link: the cause names that, and never the CLI's output.
  const child = h.children.at(-1).child
  child.stdout.write('private-account-name failed to authenticate\n')
  child.exitCode = 1
  child.emit('close', 1)
  await settle()
  const view = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(view.status, 'failed')
  assert.equal(view.cause, 'the CLI exited')
  assert.doesNotMatch(JSON.stringify(view), /private-account-name/)
})

test('Claude and Codex run independently with Claude-only sign-in options', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const browserBefore = process.env.BROWSER
  const fullLinkBefore = process.env.CLAUDE_CODE_FULL_SIGN_IN_LINK
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
  assert.equal(nativeClaude.opts.env.CLAUDE_CODE_FULL_SIGN_IN_LINK, '1')
  assert.equal(Object.hasOwn(nativeCodex.opts.env, 'CLAUDE_CODE_FULL_SIGN_IN_LINK'), false)
  assert.deepEqual(h.selected.env, original)
  assert.deepEqual(h.checks.map(({ env }) => env), [original, original])
  assert.notEqual(claude.attemptId, codex.attemptId)
  showClaudeLink(nativeClaude.child)
  h.logins.cancel(CLAUDE, claude.attemptId)
  assert.equal(existsSync(directory), false)
  assert.equal(h.logins.status(CODEX, codex.attemptId).status, 'starting')
  assert.deepEqual(nativeCodex.child.kills, [])
  assert.equal(h.logins.activeAttempts(), 1)
  h.logins.dispose()
  assert.equal(process.env.BROWSER, browserBefore)
  assert.equal(process.env.CLAUDE_CODE_FULL_SIGN_IN_LINK, fullLinkBefore)
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

test('only compact Claude links get the short-link failure and no link is retained', async t => {
  const shortCause = 'short sign-in link unsupported'
  const unsupportedCause = 'unsupported sign-in link'
  const cases = [
    ['compact query', SHORT_CLAUDE_URL, shortCause],
    ['compact query with a suffix', `${SHORT_CLAUDE_URL}&x=1`, shortCause],
    ['bare endpoint', SHORT_CLAUDE_ENDPOINT, unsupportedCause],
    ['manual code without state', `${SHORT_CLAUDE_ENDPOINT}?code=true`, unsupportedCause],
    ['ordinary query parameter', `${SHORT_CLAUDE_ENDPOINT}?x=1`, unsupportedCause],
    ['compact query with a state parameter', `${SHORT_CLAUDE_URL}&state=`, unsupportedCause],
    ['compact query after another component', `${SHORT_CLAUDE_ENDPOINT}?x=1&${SHORT_CLAUDE_QUERY}`, unsupportedCause],
    ['different host', `https://evil.test/oauth/authorize?${SHORT_CLAUDE_QUERY}`, unsupportedCause],
    ['different path', `https://claude.ai/other?${SHORT_CLAUDE_QUERY}`, unsupportedCause],
    ['explicit default port', `https://claude.ai:443/oauth/authorize?${SHORT_CLAUDE_QUERY}`, unsupportedCause],
    // Built through URL so the source holds no address-shaped text (the privacy scan).
    ['userinfo', Object.assign(new URL(SHORT_CLAUDE_URL), { username: 'user' }).href, unsupportedCause],
    ['fragment', `${SHORT_CLAUDE_URL}#x`, unsupportedCause],
  ]
  for (const [label, url, cause] of cases) {
    const h = harness()
    t.after(() => h.logins.dispose())
    const started = h.logins.start(CLAUDE)
    await settle()
    showClaudeLink(h.children[0].child, url)
    const result = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(result.status, 'failed', label)
    assert.equal(result.cause, cause, label)
    assert.equal(result.message, cause === shortCause
      ? 'The CLI returned a short sign-in link this app cannot use yet. Update Automagik and try again.'
      : 'The CLI returned an unsupported sign-in link. Update it and try again.', label)
    assert.equal(Object.hasOwn(result, 'url'), false, label)
    assert.equal(Object.hasOwn(result, 'state'), false, label)
    assert.equal(Object.hasOwn(result, 'prompt'), false, label)
    assert.equal(h.logins.states.size, 0, label)
  }
})

test('a full Claude sign-in link takes precedence over a short link in the same output', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  await settle()
  const { child } = h.children[0]
  child.stdout.write(`visit: ${SHORT_CLAUDE_URL}\n`)
  showClaudeLink(child)
  const result = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(result.status, 'waiting')
  assert.equal(result.url === CLAUDE_URL, true, 'the full Claude sign-in link is shown')
  assert.equal(result.prompt?.id, 'claude-code')
  assert.equal(h.logins.textMatches(`x#${STATE}`), true)
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

// ---- #2048 paste-back: an Antigravity link's state, refused in a chat message (L1) ----------

const AGY_STATE = 'Ab-_.~xyz12345'
const AGY_CALLBACK = `http://localhost:41234/auth/callback?code=4%2F0Abc&state=${AGY_STATE}`
const AGY_LINK = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + `&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback&response_type=code&state=${AGY_STATE}`

test('L1: a remembered Antigravity state is recognised after state= for a day; Claude\'s #state is unchanged', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  assert.equal(h.logins.textMatches(AGY_CALLBACK), false, 'nothing remembered yet')
  h.logins.rememberCallbackState(AGY_STATE)
  // Only its keyed hash and length are kept.
  assert.equal(JSON.stringify([...h.logins.callbackStates.keys()]).includes(AGY_STATE), false)
  assert.deepEqual([...h.logins.callbackLengths], [[AGY_STATE.length, 1]])
  for (const text of [
    AGY_CALLBACK,
    `It ended on (${AGY_CALLBACK}).`,
    `"${AGY_CALLBACK}",`,
    `${AGY_CALLBACK.slice(0, -4)}\n${AGY_CALLBACK.slice(-4)}`,
    AGY_CALLBACK.replace('state=', 'STATE='),
    encodeURIComponent(AGY_CALLBACK),
    AGY_CALLBACK.replace('~', '%7E'),
    `${AGY_LINK} then ${AGY_CALLBACK}`,
    // G8-3: a stray % later in the text does not stop the decoded test.
    `${AGY_CALLBACK.replace('~', '%7E')} worked 100% done`,
  ]) assert.equal(h.logins.textMatches(text), true, text)
  for (const text of [
    AGY_LINK,
    // Google's link with its return address first (G7-1): still its own state, still allowed.
    'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback'
      + `&access_type=offline&state=${AGY_STATE}&client_id=c`,
    AGY_CALLBACK.replace(AGY_STATE, 'Zz-_.~xyz12345'),
    AGY_CALLBACK.replace(AGY_STATE, AGY_STATE.slice(0, -1)),
    'http://localhost:3000/?state=something-else',
    // G8-3: a malformed escape is left raw, and nothing throws.
    'state=%E0%A4%A',
    `${AGY_STATE} alone`,
  ]) assert.equal(h.logins.textMatches(text), false, text)
  // G8-4: only the authority accounts.google.com itself is skipped (a port or userinfo is not).
  assert.equal(h.logins.textMatches(`https://accounts.google.com:443/o/oauth2/auth?state=${AGY_STATE}`), true)
  assert.equal(h.logins.textMatches(`https://u!@accounts.google.com/o/oauth2/auth?state=${AGY_STATE}`), true)
  assert.equal(h.logins.textMatches(`https://ACCOUNTS.GOOGLE.COM/o/oauth2/auth?state=${AGY_STATE}`), false)
  // Claude's #state path is unchanged beside it.
  assert.equal(h.logins.textMatches(`code#${STATE}`), false)
  h.clock.advance(STATE_TTL_MS - 1)
  assert.equal(h.logins.textMatches(AGY_CALLBACK), true)
  h.clock.advance(1)
  assert.equal(h.logins.textMatches(AGY_CALLBACK), false)
  assert.equal(h.logins.callbackStates.size, 0)
  assert.equal(h.logins.callbackLengths.size, 0, 'the lengths are pruned with the states')
  // A refused state (too short, a space) is not remembered.
  h.logins.rememberCallbackState('short')
  h.logins.rememberCallbackState('has a space in it')
  assert.equal(h.logins.callbackStates.size, 0)
})

test('L1: at most 64 state= / state%3d occurrences per reading, and a token cut at 3 x 512 characters', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  h.logins.rememberCallbackState(AGY_STATE)
  // Both spellings count together: the 65th occurrence is not read, the 64th is.
  const filler = n => Array.from({ length: n }, (_, i) => (i % 2 ? 'state=x ' : 'state%3dx ')).join('')
  assert.equal(h.logins.textMatches(`${filler(63)}state=${AGY_STATE}`), true)
  assert.equal(h.logins.textMatches(`${filler(64)}state=${AGY_STATE}`), false)
  // A remembered 512-character state, fully percent-encoded once, still fits in the token.
  const long = 'a'.repeat(511) + '~'
  h.logins.rememberCallbackState(long)
  const encoded = [...long].map(c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`).join('')
  assert.equal(encoded.length, 3 * 512)
  assert.equal(h.logins.textMatches(`http://localhost:41234/auth/callback?code=a&state=${encoded}`), true)
  assert.equal(h.logins.textMatches(`http://localhost:41234/auth/callback?code=a&state=x${encoded}`), false)
})

// Switch account (#2064): a fresh attempt always runs its sign-in and shows its link.
const until = async (done, rounds = 30) => { for (let i = 0; i < rounds && !done(); i++) await settle() }
const UNCHANGED = 'The account did not change. Try again.'
const NOT_FINISHED = 'Sign-in did not finish. Try again.'

async function codexFreshWaiting(h, options = { fresh: true }) {
  const started = h.logins.start(CODEX, options)
  await settle()
  const child = h.children.at(-1).child
  sendJson(child, { id: jsonRequests(child)[0].id, result: {} })
  await settle()
  const login = jsonRequests(child).find(row => row.method === 'account/login/start')
  sendJson(child, { id: login.id, result: { type: 'chatgptDeviceCode', loginId: 'login-123', verificationUrl: CODEX_URL, userCode: 'ABCD-1234' } })
  await settle()
  return { started, child }
}

test('L1: a fresh attempt never takes "already signed in": its sign-in runs and shows its link', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  h.authenticated(true)
  const started = h.logins.start(CLAUDE, { fresh: true })
  await settle()
  assert.equal(h.children.length, 1)
  assert.deepEqual(h.children[0].args, ['auth', 'login', '--claudeai'])
  assert.equal(h.checks.length, 1, 'one status read, recorded and never the result')
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'starting')
  showClaudeLink(h.children[0].child)
  const waiting = h.logins.status(CLAUDE, started.attemptId)
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.url, CLAUDE_URL)
  assert.deepEqual(h.ready, [])

  const codex = harness()
  t.after(() => codex.logins.dispose())
  codex.authenticated(true)
  const { started: device } = await codexFreshWaiting(codex)
  assert.equal(codex.children.length, 1)
  assert.equal(codex.children[0].args[0], 'app-server')
  const view = codex.logins.status(CODEX, device.attemptId)
  assert.equal(view.status, 'waiting')
  assert.equal(view.userCode, 'ABCD-1234')
  assert.deepEqual(codex.ready, [])
})

for (const [name, signedIn, message, cause] of [
  ['L2', true, UNCHANGED, 'the account did not change'],
  ['L2b', false, NOT_FINISHED, 'the CLI exited'],
]) {
  test(`${name}: a fresh Claude that exits 0 before its link is failed; one status read says why (signed in: ${signedIn})`, async t => {
    const failures = []
    const h = harness({ onFail: value => failures.push(value) })
    t.after(() => h.logins.dispose())
    h.authenticated(signedIn)
    const started = h.logins.start(CLAUDE, { fresh: true })
    await settle()
    h.children[0].child.close(0)
    await until(() => h.logins.status(CLAUDE, started.attemptId).settling !== true && h.logins.status(CLAUDE, started.attemptId).status !== 'starting')
    const view = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(view.status, 'failed')
    assert.equal(view.message, message)
    assert.equal(view.cause, cause)
    assert.deepEqual(failures.map(row => row.cause), [cause])
    assert.deepEqual(h.ready, [])
    assert.equal(h.checks.length, 2, 'the start read and one read after the exit')
  })
}

for (const [name, signedIn, message] of [['L3', false, NOT_FINISHED], ['L3b', true, UNCHANGED]]) {
  test(`${name}: a fresh Codex that exits 0 before its device link is failed (signed in: ${signedIn})`, async t => {
    const h = harness()
    t.after(() => h.logins.dispose())
    h.authenticated(signedIn)
    const started = h.logins.start(CODEX, { fresh: true })
    await settle()
    h.children[0].child.close(0)
    await until(() => !['starting', 'waiting'].includes(h.logins.status(CODEX, started.attemptId).status)
      && h.logins.status(CODEX, started.attemptId).settling !== true)
    const view = h.logins.status(CODEX, started.attemptId)
    assert.equal(view.status, 'failed')
    assert.equal(view.message, message)
    assert.deepEqual(h.ready, [])
  })
}

test('L4: a fresh Claude that shows its link and confirms is ready, told it was a Switch', async t => {
  const options = []
  const h = harness({ onReady: async (id, snapshot, value) => { options.push(value) } })
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE, { fresh: true })
  await settle()
  const child = h.children[0].child
  showClaudeLink(child)
  h.logins.answer(CLAUDE, started.attemptId, `code#${STATE}`)
  h.authenticated(true)
  child.close(0)
  await until(() => h.logins.status(CLAUDE, started.attemptId).status === 'ready')
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'ready')
  assert.equal(options.length, 1)
  assert.equal(options[0].existing, false)
  assert.equal(options[0].fresh, true)
})

test('L5b: a fresh attempt whose start read answers "signed in" late still runs its sign-in', async t => {
  const read = deferred()
  const h = harness({ signedIn: () => read.promise })
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE, { fresh: true })
  await settle()
  assert.equal(h.children.length, 0)
  read.resolve(true)
  await settle()
  assert.equal(h.children.length, 1, 'a login child is spawned')
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'starting')
  assert.deepEqual(h.ready, [])
})

test('L5c: a fresh start never joins a live plain attempt; it is refused and the plain one goes on', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const plain = h.logins.start(CLAUDE)
  await settle()
  assert.throws(() => h.logins.start(CLAUDE, { fresh: true }), { code: 'acp-login/busy', message: 'The Bot account is changing.' })
  assert.equal(h.logins.current(CLAUDE).attemptId, plain.attemptId)
  assert.equal(h.logins.status(CLAUDE, plain.attemptId).fresh, undefined)
  assert.deepEqual(h.children[0].child.kills, [])
})

test('L6: only a ready view whose onReady marked it says sameAccount', async t => {
  for (const mark of [true, false]) {
    const h = harness({ onReady: async (id, snapshot, { same }) => { if (mark) same() } })
    t.after(() => h.logins.dispose())
    const started = h.logins.start(CLAUDE, { fresh: true, compare: true })
    await settle()
    const child = h.children[0].child
    showClaudeLink(child)
    assert.equal(h.logins.status(CLAUDE, started.attemptId).sameAccount, undefined, 'never while waiting')
    h.authenticated(true)
    child.close(0)
    await until(() => h.logins.status(CLAUDE, started.attemptId).status === 'ready')
    const view = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(view.status, 'ready')
    assert.equal(view.sameAccount, mark ? true : undefined)
  }
  const failed = harness({ onReady: async (id, snapshot, { same }) => same() })
  t.after(() => failed.logins.dispose())
  const started = failed.logins.start(CLAUDE, { fresh: true })
  await settle()
  failed.children[0].child.close(1)
  await until(() => failed.logins.status(CLAUDE, started.attemptId).settling !== true)
  assert.equal(failed.logins.status(CLAUDE, started.attemptId).sameAccount, undefined)
})

test('L7: a fresh attempt says so in every view, the retained failed one too; a plain one never', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const claude = h.logins.start(CLAUDE, { fresh: true })
  assert.equal(claude.fresh, true)
  await settle()
  showClaudeLink(h.children[0].child)
  assert.equal(h.logins.status(CLAUDE, claude.attemptId).fresh, true)
  h.logins.cancel(CLAUDE, claude.attemptId)
  const fast = harness()
  t.after(() => fast.logins.dispose())
  const early = fast.logins.start(CLAUDE, { fresh: true })
  await settle()
  fast.children[0].child.close(0)
  await until(() => fast.logins.status(CLAUDE, early.attemptId).status === 'failed')
  assert.equal(fast.logins.status(CLAUDE, early.attemptId).fresh, true)

  const codex = harness()
  t.after(() => codex.logins.dispose())
  const { started } = await codexFreshWaiting(codex)
  assert.equal(started.fresh, true)
  assert.equal(codex.logins.status(CODEX, started.attemptId).fresh, true)
  codex.children[0].child.close(1)
  await until(() => codex.logins.status(CODEX, started.attemptId).status === 'failed')
  assert.equal(codex.logins.status(CODEX, started.attemptId).fresh, true)

  const plain = harness()
  t.after(() => plain.logins.dispose())
  const attempt = plain.logins.start(CLAUDE)
  assert.equal(attempt.fresh, undefined)
  await settle()
  showClaudeLink(plain.children[0].child)
  assert.equal(plain.logins.status(CLAUDE, attempt.attemptId).fresh, undefined)
  plain.children[0].child.close(1)
  await settle()
  assert.equal(plain.logins.status(CLAUDE, attempt.attemptId).fresh, undefined)
})

test('L8: a fresh attempt tells onSwitch its start and its end in fixed values; a plain one never', async t => {
  const notes = []
  const h = harness({ onSwitch: value => notes.push(value) })
  t.after(() => h.logins.dispose())
  h.authenticated(true)
  const started = h.logins.start(CLAUDE, { fresh: true })
  await settle()
  showClaudeLink(h.children[0].child)
  h.authenticated(false)
  h.children[0].child.close(1)
  await until(() => notes.length === 2)
  assert.deepEqual(notes, [
    { id: CLAUDE, step: 'start', signedIn: true },
    { id: CLAUDE, step: 'end', status: 'failed', linkShown: true, exit: 'exit 1', signedInAfter: false },
  ])
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'failed')

  const ready = []
  const r = harness({ onSwitch: value => ready.push(value) })
  t.after(() => r.logins.dispose())
  const attempt = r.logins.start(CLAUDE, { fresh: true })
  await settle()
  showClaudeLink(r.children[0].child)
  r.authenticated(true)
  r.children[0].child.close(0)
  await until(() => ready.length === 2)
  assert.deepEqual(ready.at(-1), { id: CLAUDE, step: 'end', status: 'ready', linkShown: true, exit: 'exit 0', same: false })
  assert.equal(r.logins.status(CLAUDE, attempt.attemptId).status, 'ready')

  const plainNotes = []
  const plain = harness({ onSwitch: value => plainNotes.push(value) })
  t.after(() => plain.logins.dispose())
  plain.logins.start(CLAUDE)
  await settle()
  plain.children[0].child.close(1)
  await settle()
  assert.deepEqual(plainNotes, [])
})

test('L9: a plain Claude that exits 0 before any link still confirms by status, as before', async t => {
  const h = harness()
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE)
  await settle()
  h.authenticated(true)
  h.children[0].child.close(0)
  await until(() => h.logins.status(CLAUDE, started.attemptId).status === 'ready')
  assert.equal(h.logins.status(CLAUDE, started.attemptId).status, 'ready')
  assert.equal(h.ready.length, 1)
})

test('L10: a fresh attempt that ends without a sign-in settles: its tree, one read, then onSettled once', async t => {
  for (const [end, signedIn] of [['failed', true], ['failed', false], ['expired', true], ['cancelled', false]]) {
    const settled = []
    const h = harness({ onSettled: value => settled.push(value) })
    t.after(() => h.logins.dispose())
    const started = h.logins.start(CLAUDE, { fresh: true })
    await settle()
    const child = h.children[0].child
    showClaudeLink(child)
    if (end === 'failed') { h.authenticated(signedIn); child.close(1) }
    if (end === 'expired') h.clock.advance(LINK_TTL_MS)
    if (end === 'cancelled') h.logins.cancel(CLAUDE, started.attemptId)
    const ending = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(ending.status, end)
    if (end !== 'failed') {
      // The tree is still alive: the read waits for it.
      assert.equal(ending.settling, true)
      await settle()
      assert.equal(h.logins.status(CLAUDE, started.attemptId).settling, true)
      assert.deepEqual(settled, [])
      h.authenticated(signedIn)
      child.close(0)
    }
    await until(() => settled.length > 0)
    const view = h.logins.status(CLAUDE, started.attemptId)
    assert.equal(view.settling, undefined)
    assert.equal(view.signedInAfter, signedIn)
    assert.equal(settled.length, 1)
    assert.deepEqual({ ...settled[0], valid: undefined }, { id: CLAUDE, attemptId: started.attemptId, signedIn, valid: undefined })
  }

  // A read that throws tells nothing.
  const thrown = []
  let reads = 0
  const broken = harness({ onSettled: value => thrown.push(value), signedIn: async () => { if (++reads > 1) throw new Error('read failed'); return false } })
  t.after(() => broken.logins.dispose())
  const failing = broken.logins.start(CLAUDE, { fresh: true })
  await settle()
  broken.children[0].child.close(1)
  await until(() => thrown.length > 0)
  assert.equal(thrown[0].signedIn, undefined)
  assert.equal(Object.hasOwn(broken.logins.status(CLAUDE, failing.attemptId), 'signedInAfter'), false)

  // SA2-2's read is reused: no third status read.
  const reuse = []
  const again = harness({ onSettled: value => reuse.push(value) })
  t.after(() => again.logins.dispose())
  again.authenticated(true)
  again.logins.start(CLAUDE, { fresh: true })
  await settle()
  again.children[0].child.close(0)
  await until(() => reuse.length > 0)
  assert.equal(again.checks.length, 2)
  assert.equal(reuse[0].signedIn, true)

  // A plain failure and a fresh ready never settle.
  const none = []
  const plain = harness({ onSettled: value => none.push(value) })
  t.after(() => plain.logins.dispose())
  const attempt = plain.logins.start(CLAUDE)
  await settle()
  plain.children[0].child.close(1)
  await settle()
  await settle()
  assert.equal(plain.logins.status(CLAUDE, attempt.attemptId).settling, undefined)
  const fresh = plain.logins.start(CODEX, { fresh: true })
  await settle()
  const codexChild = plain.children.at(-1).child
  sendJson(codexChild, { id: jsonRequests(codexChild)[0].id, result: {} })
  await settle()
  const login = jsonRequests(codexChild).find(row => row.method === 'account/login/start')
  sendJson(codexChild, { id: login.id, result: { type: 'chatgptDeviceCode', loginId: 'login-123', verificationUrl: CODEX_URL, userCode: 'ABCD-1234' } })
  await settle()
  plain.authenticated(true)
  sendJson(codexChild, { method: 'account/login/completed', params: { loginId: 'login-123', success: true } })
  await until(() => plain.logins.status(CODEX, fresh.attemptId).status === 'ready')
  assert.equal(plain.logins.status(CODEX, fresh.attemptId).status, 'ready')
  await settle()
  assert.deepEqual(none, [])
})

test('L10: a fresh attempt that fails or is cancelled before resolve still settles once', async t => {
  // `resolve` throws: the attempt fails in `begin`, and the settle's own resolve throws too.
  const settled = []
  const h = harness({ onSettled: value => settled.push(value), resolve: async () => { throw new Error('busy') } })
  t.after(() => h.logins.dispose())
  const failed = h.logins.start(CLAUDE, { fresh: true })
  await until(() => settled.length > 0)
  assert.equal(h.logins.status(CLAUDE, failed.attemptId).status, 'failed')
  assert.equal(settled.length, 1)
  assert.equal(settled[0].signedIn, undefined)

  // Cancelled before resolve answers: the settle resolves for itself, and the CLI is signed in.
  const late = []
  const resolving = deferred()
  let calls = 0
  const next = harness({ onSettled: value => late.push(value), resolve: () => (++calls === 1 ? resolving.promise : next.selected) })
  t.after(() => next.logins.dispose())
  next.authenticated(true)
  const started = next.logins.start(CLAUDE, { fresh: true })
  next.logins.cancel(CLAUDE, started.attemptId)
  resolving.resolve(next.selected)
  await until(() => late.length > 0)
  assert.equal(late.length, 1)
  assert.equal(late[0].signedIn, true)
  assert.equal(next.logins.status(CLAUDE, started.attemptId).signedInAfter, true)
  assert.equal(next.children.length, 0)
})

test('L10: a settling attempt holds the busy signal, confirming included, until onSettled decided', async t => {
  const order = []
  const read = deferred()
  let reads = 0
  const h = harness({
    answerMs: 30_000,
    signedIn: () => (++reads === 1 ? Promise.resolve(false) : read.promise),
    onSettled: () => { order.push('settled') },
    onChange: count => order.push(`change ${count}`),
  })
  t.after(() => h.logins.dispose())
  const started = h.logins.start(CLAUDE, { fresh: true })
  await settle()
  h.children[0].child.close(1)
  const at = h.clock.now
  await settle()
  assert.equal(h.logins.activeAttempts(), 1)
  assert.deepEqual(h.logins.activity(), { active: 1, confirming: 1, confirmingUntil: at + 30_000 })
  assert.equal(h.logins.status(CLAUDE, started.attemptId).settling, true)
  read.resolve(true)
  await until(() => order.includes('settled'))
  await settle()
  assert.equal(h.logins.activeAttempts(), 0)
  assert.deepEqual(h.logins.activity(), { active: 0, confirming: 0 })
  assert.deepEqual(order, ['change 1', 'settled', 'change 0'])

  // Disposal during a settle: never told, and nothing counts.
  const told = []
  const notes = []
  const held = deferred()
  let count = 0
  const d = harness({ signedIn: () => (++count === 1 ? Promise.resolve(false) : held.promise), onSettled: value => told.push(value), onSwitch: value => notes.push(value) })
  const attempt = d.logins.start(CLAUDE, { fresh: true })
  await settle()
  d.children[0].child.close(1)
  await settle()
  assert.equal(d.logins.activeAttempts(), 1)
  d.logins.dispose()
  held.resolve(true)
  await settle()
  await settle()
  assert.deepEqual(told, [])
  assert.equal(d.logins.activeAttempts(), 0)
  assert.deepEqual(notes.filter(note => note.step === 'end').length, 1)
  assert.ok(attempt.attemptId)
})
