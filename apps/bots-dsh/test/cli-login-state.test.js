// The sign-in rows of a page (cli-login-state.js) and the known-state helpers, without a browser:
// the host is a fake, the clock and timers are manual.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCliLogin } from '../src/client/cli-login-state.js'
import { carriesKnownState, forgetKnownStates, rememberCallbackState, rememberLinkState, DONE_MS, APPLY_FAILED_MS } from '../src/client/cli-login-model.js'
import { teamActions } from '../src/client/team-actions.js'
import { createSource, indexRoster } from '../src/client/sources.js'
import { call } from '../src/client/api.js'
import { installLocale } from '../src/client/i18n.js'

const STATE = 'Known_State_0123456789abcdef'
const CLAUDE_URL = `https://claude.ai/oauth/authorize?code=true&state=${STATE}`

function manualTimers() {
  let now = 1_000_000
  let id = 0
  const pending = new Map()
  const timers = {
    setTimeout: (fn, ms) => { pending.set(++id, { fn, at: now + ms }); return id },
    clearTimeout: key => pending.delete(key),
    setInterval: (fn, ms) => { const key = ++id; pending.set(key, { fn, at: now + ms, every: ms }); return key },
    clearInterval: key => pending.delete(key),
  }
  const advance = async (ms) => {
    const until = now + ms
    for (;;) {
      const next = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [key, timer] = next
      now = timer.at
      if (timer.every) timer.at += timer.every
      else pending.delete(key)
      timer.fn()
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    now = until
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  return { timers, advance, now: () => now }
}

function fakeHost(now = Date.now) {
  const calls = []
  const host = { attempt: null, signedIn: false, choice: undefined, endedError: null }
  const view = () => (host.attempt ? { ...host.attempt, ...(host.choice ? { choice: host.choice } : {}) } : null)
  const record = (name, ...args) => { calls.push([name, ...args]) }
  const actions = {
    cliLoginCurrent: async (botId, provider) => { record('current', botId, provider); return host.attempt && ['starting', 'waiting'].includes(host.attempt.status) ? { id: provider, attempt: view() } : { id: provider, attempt: null, ...(host.choice ? { choice: host.choice } : {}) } },
    cliLoginStart: async (botId, provider, model) => {
      record('start', botId, provider, model)
      if (!host.attempt || !['starting', 'waiting'].includes(host.attempt.status)) {
        host.attempt = { id: provider, attemptId: 'attempt_000000000000000000000001', status: 'waiting', openedBy: botId, expiresAt: now() + 600_000,
          url: provider === 'acp-claude' ? CLAUDE_URL : 'https://auth.openai.com/codex/device', ...(provider === 'acp-claude' ? { prompt: { id: 'claude-code', secret: true } } : { userCode: 'ABCD-1234' }) }
      }
      if (model) host.choice = { ref: model, state: 'pending' }
      return view()
    },
    cliLoginStatus: async (botId, provider, attemptId) => { record('status', botId, provider, attemptId); if (host.endedError) throw host.endedError; return view() },
    cliLoginAnswer: async (botId, provider, attemptId, value) => { record('answer', botId, provider, attemptId, value.length); if (!value.endsWith(`#${STATE}`)) throw Object.assign(new Error('Paste the complete code shown by Claude, including the part after #.'), { code: 'bot/invalid' }); host.attempt.status = 'waiting'; host.attempt.checking = true; delete host.attempt.prompt; return view() },
    cliLoginCancel: async (botId, provider, attemptId) => { record('cancel', botId, provider, attemptId); host.attempt.status = 'cancelled'; return view() },
    cliLoginConnections: async () => { record('connections'); return { connections: { 'acp-codex': { id: 'acp-codex', signedIn: host.signedIn }, 'acp-claude': { id: 'acp-claude', signedIn: host.signedIn } } } },
    refreshModels: async () => { record('refresh') },
  }
  return { host, calls, actions, names: () => calls.map(call => call[0]) }
}

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('an explicit entry offers; Sign in starts; ready shows Done and leaves after DONE_MS with no residue', async () => {
  const clock = manualTimers()
  const { host, actions, names } = fakeHost()
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  assert.deepEqual(login.getSnapshot().rows, {})
  await login.open({ botId: 'a', provider: 'acp-codex', ref: 'acp-codex/default' })
  assert.equal(login.getSnapshot().rows.a.stage, 'offer')
  assert.ok(!names().includes('start'), 'the offer starts nothing')
  await login.start('a')
  assert.equal(login.getSnapshot().rows.a.stage, 'attempt')
  assert.equal(login.getSnapshot().rows.a.attempt.userCode, 'ABCD-1234')
  host.attempt.status = 'ready'
  host.choice = { ref: 'acp-codex/default', state: 'applied' }
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.a.stage, 'done')
  await clock.advance(DONE_MS - 1)
  assert.equal(login.getSnapshot().rows.a?.stage, 'done')
  await clock.advance(1)
  assert.deepEqual(login.getSnapshot().rows, {})
  assert.ok(!names().includes('cancel'))
  assert.ok(names().includes('refresh'), 'the model list is read again once signed in')
})

test('sign-in identity is stripped from the shared attempt view and copied onto finished rows', async () => {
  const clock = manualTimers()
  const { host, actions } = fakeHost()
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  const provider = 'acp-codex'
  const signedInAs = { ref: 'ref-work', kind: 'account', email: 'dev@example.test' }
  await login.open({ botId: 'a', provider })
  await login.start('a')
  await login.open({ botId: 'b', provider })
  host.attempt.signedInAs = signedInAs
  await clock.advance(100)
  const waiting = login.getSnapshot().rows
  assert.equal(waiting.a.attempt, waiting.b.attempt)
  assert.equal(Object.hasOwn(waiting.a.attempt, 'signedInAs'), false)

  host.attempt.status = 'ready'
  await clock.advance(100)
  const done = login.getSnapshot().rows
  for (const row of [done.a, done.b]) {
    assert.equal(row.stage, 'done')
    assert.equal(row.attempt, null)
    assert.equal(row.account, undefined)
    assert.deepEqual(row.signedInAs, signedInAs)
    assert.notEqual(row.signedInAs, signedInAs)
    assert.equal(Object.isFrozen(row.signedInAs), true)
  }
  await clock.advance(DONE_MS)
  assert.deepEqual(login.getSnapshot().rows, {})
})

test('a model that could not be applied shows its reason and leaves after APPLY_FAILED_MS', async () => {
  const clock = manualTimers()
  const { host, actions } = fakeHost()
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  await login.open({ botId: 'a', provider: 'acp-codex', ref: 'acp-codex/default' })
  await login.start('a')
  host.attempt.status = 'ready'
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.a.stage, 'done')
  host.choice = { ref: 'acp-codex/default', state: 'failed', message: 'No.', kept: 'deepseek-official/deepseek-flash' }
  await clock.advance(500)
  assert.equal(login.getSnapshot().rows.a.stage, 'applyFailed')
  assert.equal(login.getSnapshot().rows.a.outcome.kept, 'deepseek-official/deepseek-flash')
  await clock.advance(APPLY_FAILED_MS - 1)
  assert.equal(login.getSnapshot().rows.a?.stage, 'applyFailed')
  await clock.advance(1)
  assert.deepEqual(login.getSnapshot().rows, {})
})

test('joining a live attempt never starts a second one; a model chosen while joining is registered through start', async () => {
  const clock = manualTimers()
  const { actions, calls } = fakeHost()
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await login.open({ botId: 'a', provider: 'acp-claude' })
  await login.start('a')
  await login.open({ botId: 'b', provider: 'acp-claude' })
  assert.equal(login.getSnapshot().rows.b.stage, 'attempt', 'joined, no offer')
  assert.equal(calls.filter(call => call[0] === 'start').length, 1, 'joining without a model starts nothing')
  await login.open({ botId: 'c', provider: 'acp-claude', ref: 'acp-claude/default' })
  const starts = calls.filter(call => call[0] === 'start')
  assert.deepEqual(starts.at(-1), ['start', 'c', 'acp-claude', 'acp-claude/default'])
  assert.equal(login.getSnapshot().rows.c.attempt.attemptId, login.getSnapshot().rows.a.attempt.attemptId)
})

test('restore brings a live attempt back only in the Bot that opened it, once per page', async () => {
  const clock = manualTimers()
  const { actions, calls } = fakeHost()
  const first = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await first.open({ botId: 'a', provider: 'acp-codex' })
  await first.start('a')
  first.dispose()
  assert.ok(!calls.some(call => call[0] === 'cancel'), 'a page that goes cancels nothing')
  const page = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await page.restore('b')
  assert.equal(page.getSnapshot().rows.b, undefined)
  await page.restore('a')
  assert.equal(page.getSnapshot().rows.a.stage, 'attempt')
  page.dismiss('a')
  const reads = calls.length
  await page.restore('a')
  assert.equal(calls.length, reads, 'asked once per Bot per page; Not now is not undone')
})

test('an ended attempt asks the agent first: signed in is success, before the expiry a restart, after it expired', async () => {
  for (const [signedIn, expired, stage] of [[true, false, 'done'], [false, false, 'interrupted'], [false, true, 'failed']]) {
    const clock = manualTimers()
    const { host, actions } = fakeHost(clock.now)
    const login = createCliLogin({ actions, timers: clock.timers, now: () => (expired ? clock.now() + 3_600_000 : clock.now()), pollMs: 100 })
    await login.open({ botId: 'a', provider: 'acp-codex' })
    await login.start('a')
    host.signedIn = signedIn
    host.endedError = Object.assign(new Error('Este login terminou. Comece de novo.'), { code: 'bot/login-ended' })
    await clock.advance(100)
    await flush()
    assert.equal(login.getSnapshot().rows.a.stage, stage, `${signedIn} ${expired}`)
  }
})

test('a restart message interrupts; a network failure is read again; late answers are dropped', async () => {
  const clock = manualTimers()
  const { host, actions } = fakeHost()
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  await login.open({ botId: 'a', provider: 'acp-codex' })
  await login.start('a')
  host.endedError = Object.assign(new Error('Could not reach DSH.'), { code: 'NETWORK' })
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.a.stage, 'attempt')
  host.endedError = Object.assign(new Error('A conexão reiniciou. Comece o login de novo.'), { code: 'bot/login-restarted' })
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.a.stage, 'interrupted')
  // A start whose answer comes after Not now draws nothing.
  let release
  const slow = { ...fakeHost(clock.now).actions, cliLoginStart: () => new Promise((resolve) => { release = resolve }) }
  const other = createCliLogin({ actions: slow, timers: clock.timers, now: clock.now })
  await other.open({ botId: 'b', provider: 'acp-codex' })
  const started = other.start('b')
  other.dismiss('b')
  release({ id: 'acp-codex', attemptId: 'attempt_000000000000000000000002', status: 'waiting', url: 'https://auth.openai.com/codex/device' })
  await started
  assert.deepEqual(other.getSnapshot().rows, {})
})

test('in pt-BR an ended or restarted attempt is still known: the page reads the host code, not its translated words', async (t) => {
  // The pt-BR pack's words (locale-pt-br-dsh) and the real api.js, so the message reaches the
  // store as the person reads it.
  const words = { 'This sign-in has ended. Start again.': 'Este login terminou. Comece de novo.', 'The connection restarted. Start sign-in again.': 'A conexão reiniciou. Comece o login de novo.' }
  const off = installLocale({ register: () => () => {}, bind: () => key => words[key] ?? key, getLocale: () => ({ active: 'pt-BR' }) })
  const fetchBefore = globalThis.fetch
  t.after(() => { off(); globalThis.fetch = fetchBefore })
  let refusal = null
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: refusal }) })
  for (const [code, message, stage] of [['bot/login-ended', 'This sign-in has ended. Start again.', 'interrupted'], ['bot/login-restarted', 'The connection restarted. Start sign-in again.', 'interrupted']]) {
    const clock = manualTimers()
    const { actions, calls } = fakeHost(clock.now)
    const login = createCliLogin({ actions: { ...actions, cliLoginStatus: (botId, provider, attemptId, signal) => call('cli-login-status', { botId, provider, attemptId }, signal) }, timers: clock.timers, now: clock.now, pollMs: 100 })
    await login.open({ botId: 'a', provider: 'acp-claude' })
    await login.start('a')
    refusal = { code, message }
    await assert.rejects(call('cli-login-status', {}), error => error.code === code && error.message === words[message] && error.message !== message)
    await clock.advance(100)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(login.getSnapshot().rows.a.stage, stage, code)
    assert.equal(login.getSnapshot().rows.a.attempt, null, 'the stale code field is gone, the editor unlocked')
    if (code === 'bot/login-ended') assert.ok(calls.some(entry => entry[0] === 'connections'), 'an ended attempt asks the agent first')
    const polled = calls.length
    await clock.advance(1_000)
    assert.equal(calls.length, polled, 'the poll stopped')
    login.dispose()
  }
})

test('another model chosen during the sign-in replaces the earlier choice in the host', async () => {
  const clock = manualTimers()
  const { host, actions, calls } = fakeHost(clock.now)
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await login.open({ botId: 'a', provider: 'acp-claude', ref: 'acp-claude/opus' })
  await login.start('a')
  assert.deepEqual(host.choice, { ref: 'acp-claude/opus', state: 'pending' })
  const before = login.getSnapshot().rows.a.attempt.attemptId
  await login.open({ botId: 'a', provider: 'acp-claude', ref: 'acp-claude/sonnet' })
  assert.deepEqual(calls.filter(entry => entry[0] === 'start').at(-1), ['start', 'a', 'acp-claude', 'acp-claude/sonnet'])
  assert.deepEqual(host.choice, { ref: 'acp-claude/sonnet', state: 'pending' }, 'the latest intent is the one applied on ready')
  assert.equal(login.getSnapshot().rows.a.stage, 'attempt')
  assert.equal(login.getSnapshot().rows.a.ref, 'acp-claude/sonnet')
  assert.equal(login.getSnapshot().rows.a.attempt.attemptId, before, 'the live attempt was joined, not opened again')
  // The same model again, or none, sends nothing.
  const starts = calls.filter(entry => entry[0] === 'start').length
  await login.open({ botId: 'a', provider: 'acp-claude', ref: 'acp-claude/sonnet' })
  await login.open({ botId: 'a', provider: 'acp-claude' })
  assert.equal(calls.filter(entry => entry[0] === 'start').length, starts)
})

test('Claude: the link state is kept for the page; a wrong code keeps the step; cancel only when asked', async () => {
  forgetKnownStates()
  const clock = manualTimers()
  const { actions, names } = fakeHost()
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await login.open({ botId: 'a', provider: 'acp-claude' })
  await login.start('a')
  assert.equal(carriesKnownState(`here: code#${STATE}\n`), true)
  assert.equal(carriesKnownState(`code # ${STATE.slice(0, 6)} ${STATE.slice(6)}`), true, 'spaces do not hide it')
  assert.equal(carriesKnownState(`${STATE}`), false, 'only #<state>')
  assert.equal(carriesKnownState('code#Another_state_0000000'), false, 'exact values only')
  assert.equal(await login.answer('a', 'wrong#code'), false)
  assert.equal(login.getSnapshot().rows.a.stage, 'attempt')
  assert.match(login.getSnapshot().rows.a.error, /Paste the complete code/)
  assert.ok(!JSON.stringify(login.getSnapshot()).includes('wrong#code'), 'an answer is never kept')
  assert.equal(await login.answer('a', `auth#${STATE}`), true)
  assert.equal(login.getSnapshot().rows.a.attempt.checking, true)
  login.askCancel('a')
  assert.equal(login.getSnapshot().rows.a.confirm, true)
  login.keepAttempt('a')
  assert.ok(!names().includes('cancel'))
  login.askCancel('a')
  await login.cancel('a')
  assert.deepEqual(login.getSnapshot().rows, {})
  assert.ok(names().includes('cancel'))
  login.dispose()
  assert.equal(carriesKnownState(`x#${STATE}`), true, 'the page keeps the states after the row')
  assert.equal(rememberLinkState('https://claude.ai/oauth/authorize?state=bad'), false)
  forgetKnownStates()
})

test('chooseModelInChat opens the row on a sign-in refusal only; updateBot never opens it', async () => {
  const roster = createSource(indexRoster({ bots: [{ id: 'a', name: 'A', model: 'deepseek-official/deepseek-flash' }], rooms: [], agents: [], models: [], prefs: {} }))
  const opened = []
  const sessions = []
  let refusal = { code: 'bot/sign-in-required', message: 'Sign in' }
  const call = async (endpoint) => { if (endpoint === 'update-bot') throw Object.assign(new Error(refusal.message), { code: refusal.code }) }
  const manager = { open: (options) => { opened.push(options); return Promise.resolve(true) } }
  const actions = teamActions({ call, after: value => value, partFor: id => id, roster, ui: createSource({}), openSession: id => sessions.push(id), loginState: () => manager })
  await assert.rejects(actions.updateBot('a', { model: 'acp-claude/default' }), { code: 'bot/sign-in-required' })
  assert.deepEqual(opened, [])
  assert.equal(await actions.chooseModelInChat('a', 'acp-claude/default'), undefined)
  assert.deepEqual(opened, [{ botId: 'a', provider: 'acp-claude', ref: 'acp-claude/default' }])
  assert.deepEqual(sessions, ['a'])
  refusal = { code: 'bot/refused', message: 'Turn on Claude Code first' }
  await assert.rejects(actions.chooseModelInChat('a', 'acp-claude/default'), { code: 'bot/refused' })
  refusal = { code: 'bot/sign-in-required', message: 'Sign in' }
  await assert.rejects(actions.chooseModelInChat('a', 'deepseek-official/deepseek-pro'), { code: 'bot/sign-in-required' }, 'only an agent model opens a row')
  assert.equal(actions.openCliLogin('nobody', 'acp-claude'), false, 'only a Bot')
  assert.equal(opened.length, 1)
})

// F2: a row about a provider its Bot has left closes by itself; a live attempt stays (it belongs
// to the CLI), and so does a row whose Bot moved within the same provider.
test('a sign-in row closes when its Bot\'s model moves to another provider, except a live attempt', async () => {
  const clock = manualTimers()
  const { host, actions } = fakeHost()
  const models = { a: 'deepseek/flash', b: 'deepseek/flash', c: 'deepseek/flash' }
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100, modelOf: botId => models[botId] })
  // The refused pick leaves the Bot on its model: the row opens and stays.
  await login.open({ botId: 'a', provider: 'acp-claude', ref: 'acp-claude/default' })
  login.followModels()
  assert.equal(login.getSnapshot().rows.a.stage, 'offer', 'opening on another provider than the Bot\'s own is the point')
  // The Bot moves within the row's provider: the row stays.
  models.a = 'acp-claude/opus'
  login.followModels()
  assert.equal(login.getSnapshot().rows.a.stage, 'offer')
  // The Bot moves to another provider: the offer goes.
  models.a = 'openai-codex/gpt-5.6-sol'
  login.followModels()
  assert.equal(login.getSnapshot().rows.a, undefined)
  // A failed row goes the same way.
  await login.open({ botId: 'b', provider: 'acp-codex' })
  await login.start('b')
  host.attempt.status = 'failed'
  host.attempt.message = 'Sign-in did not finish.'
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.b.stage, 'failed')
  models.b = 'deepseek/pro'
  login.followModels()
  assert.equal(login.getSnapshot().rows.b, undefined)
  // A live attempt stays whatever the Bot picks.
  host.attempt = null
  await login.open({ botId: 'c', provider: 'acp-codex' })
  await login.start('c')
  assert.equal(login.getSnapshot().rows.c.stage, 'attempt')
  models.c = 'deepseek/pro'
  login.followModels()
  assert.equal(login.getSnapshot().rows.c.stage, 'attempt', 'the attempt is the CLI\'s, not the Bot\'s pick')
  login.dispose()
})

// ---- Antigravity in a Bot's chat (#2048, r6 parity) ------------------------------------------

const AGY = 'acp-antigravity'
const AGY_STATE = 'Ab-_.~xyz12345'
const AGY_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com'
  + `&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback&response_type=code&state=${AGY_STATE}`
const AGY_CALLBACK = `http://localhost:41234/auth/callback?code=4%2F0Abc&state=${AGY_STATE}`

test('Antigravity: its row shows the link and the address field; the page learns its state; an expired attempt fails with the chat\'s sentence', async () => {
  forgetKnownStates()
  const clock = manualTimers()
  const { actions, host, calls } = fakeHost()
  actions.cliLoginStart = async (botId, provider) => {
    calls.push(['start', botId, provider])
    host.attempt = { id: provider, attemptId: 'attempt_000000000000000000000002', status: 'waiting', openedBy: botId, expiresAt: clock.now() + 240_000, expiresBy: 'app',
      url: AGY_URL, prompt: { id: 'agy-callback', label: 'Sign-in address', secret: true } }
    return { ...host.attempt }
  }
  actions.cliLoginAnswer = async (botId, provider, attemptId, value) => {
    calls.push(['answer', provider, value])
    host.attempt = { ...host.attempt, checking: true }
    delete host.attempt.prompt
    return { ...host.attempt }
  }
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await login.open({ botId: 'a', provider: AGY })
  assert.equal(login.getSnapshot().rows.a.stage, 'offer')
  await login.start('a')
  const row = login.getSnapshot().rows.a
  assert.equal(row.stage, 'attempt')
  assert.equal(row.attempt.url, AGY_URL)
  assert.equal(row.attempt.prompt.id, 'agy-callback')
  // The address it ends on is refused in a message from now on; the link itself is not.
  assert.equal(carriesKnownState(`here: ${AGY_CALLBACK}`), true)
  assert.equal(carriesKnownState(AGY_URL), false)
  assert.equal(await login.answer('a', AGY_CALLBACK), true)
  assert.deepEqual(calls.find(call => call[0] === 'answer'), ['answer', AGY, AGY_CALLBACK])
  assert.equal(login.getSnapshot().rows.a.attempt.checking, true)
  assert.ok(!JSON.stringify(login.getSnapshot()).includes('4%2F0Abc'), 'the address is never kept')
  // acp-dsh ended it as expired: the chat's own sentence.
  host.attempt = { ...host.attempt, status: 'expired', message: 'This sign-in expired. Start again.' }
  delete host.attempt.checking
  await clock.advance(1500)
  assert.equal(login.getSnapshot().rows.a.stage, 'failed')
  assert.equal(login.getSnapshot().rows.a.message, 'This sign-in expired. Start again.')
  login.dispose()
  assert.equal(rememberCallbackState('https://accounts.google.com/o/oauth2/v2/auth?state=short'), false)
  assert.equal(rememberCallbackState(`${AGY_URL}&state=again-0001`), false, 'one state only')
  forgetKnownStates()
})

test('restore asks for an Antigravity attempt too; none adds nothing, one this Bot opened comes back', async () => {
  const clock = manualTimers()
  const { actions, calls } = fakeHost()
  const page = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  await page.restore('a')
  assert.deepEqual(calls.filter(call => call[0] === 'current').map(call => call[2]), ['acp-codex', 'acp-claude', AGY])
  assert.deepEqual(page.getSnapshot().rows, {})
  page.dispose()
  const live = fakeHost()
  live.actions.cliLoginCurrent = async (botId, provider) => (provider === AGY
    ? { id: provider, attempt: { id: provider, attemptId: 'attempt_000000000000000000000003', status: 'waiting', openedBy: 'b', url: AGY_URL } }
    : { id: provider, attempt: null })
  const other = createCliLogin({ actions: live.actions, timers: clock.timers, now: clock.now })
  await other.restore('b')
  assert.equal(other.getSnapshot().rows.b.provider, AGY)
  assert.equal(other.getSnapshot().rows.b.stage, 'attempt')
  other.dispose()
  forgetKnownStates()
})

test('Antigravity guard, client copy: run-wise decode, authority end and the cap, as the host (G8-3, G8-4)', () => {
  forgetKnownStates()
  const S = 'Ab-_.~xyz12345'
  assert.equal(rememberCallbackState('https://accounts.google.com/o/oauth2/v2/auth?client_id=c'
    + `&redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback&response_type=code&state=${S}`), true)
  const cb = `http://localhost:41234/auth/callback?code=x&state=${S}`
  const first = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A41234%2Fauth%2Fcallback'
    + `&access_type=offline&state=${S}&client_id=c`
  for (const text of [
    `${cb.replace('~', '%7E')} worked 100% done`,
    first.replace('accounts.google.com', 'accounts.google.com:443'),
    first.replace('accounts.google.com', 'x!@accounts.google.com'),
    `${first} then ${cb}`,
    `${'state=x '.repeat(63)}${cb}`,
  ]) assert.equal(carriesKnownState(text), true, text)
  for (const text of [
    first,
    first.replace('accounts.google.com', 'ACCOUNTS.GOOGLE.COM'),
    `https://accounts.google.com\\x?state=${S}`,
    `${'state=x '.repeat(64)}${cb}`,
    'state=%E0%A4%A and %zz',
  ]) assert.equal(carriesKnownState(text), false, text)
  forgetKnownStates()
})

// #2064: Switch account. The host's switch hands back its own attempt; the row reads it by id.
const SWITCH_ID = 'attempt_000000000000000000000002'
const AGAIN_ID = 'attempt_000000000000000000000003'
const UNCHANGED = 'The account did not change. Try again.'
function switchHost(now = Date.now) {
  const base = fakeHost(now)
  const { host, calls } = base
  host.byId = new Map()
  host.switches = []
  host.switchError = null
  const keep = view => { host.byId.set(view.attemptId, view); return view }
  const actions = {
    ...base.actions,
    cliLoginSwitch: async (botId, provider) => {
      calls.push(['switch', botId, provider])
      if (host.switchError) throw host.switchError
      const view = host.switches.shift()
      if (view === undefined) return { id: provider, signedIn: false }
      keep(view)
      if (['starting', 'waiting'].includes(view.status)) host.attempt = view
      return { ...view, signedIn: false }
    },
    cliLoginStatus: async (botId, provider, attemptId) => {
      calls.push(['status', botId, provider, attemptId])
      if (host.endedError) throw host.endedError
      const view = host.byId.get(attemptId) ?? (host.attempt?.attemptId === attemptId ? host.attempt : undefined)
      if (view === undefined) throw Object.assign(new Error('This sign-in ended. Start again.'), { code: 'bot/login-ended' })
      return { ...view }
    },
  }
  return { ...base, actions, keep }
}
const freshFailed = (attemptId, extra = {}) => ({ id: 'acp-codex', attemptId, status: 'failed', fresh: true, signedInAfter: true, message: UNCHANGED, ...extra })
async function switchedRow(extra = {}) {
  const clock = manualTimers()
  const h = switchHost(clock.now)
  const login = createCliLogin({ actions: h.actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  h.host.switches.push(freshFailed(SWITCH_ID, extra))
  const switched = await h.actions.cliLoginSwitch('a', 'acp-codex')
  await login.open({ botId: 'a', provider: 'acp-codex', attemptId: switched.attemptId })
  h.calls.length = 0
  return { clock, ...h, login, row: () => login.getSnapshot().rows.a }
}

test('a Switch that ends on the same account: done, saying so with its account, gone after DONE_MS (B2)', async () => {
  const clock = manualTimers()
  const { host, actions } = fakeHost(clock.now)
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  const signedInAs = { ref: 'ref-work', kind: 'account', email: 'dev@example.test' }
  await login.open({ botId: 'a', provider: 'acp-codex' })
  await login.start('a')
  Object.assign(host.attempt, { status: 'ready', fresh: true, sameAccount: true, signedInAs })
  await clock.advance(100)
  const row = login.getSnapshot().rows.a
  assert.equal(row.stage, 'done')
  assert.equal(row.sameAccount, true)
  assert.deepEqual(row.signedInAs, signedInAs)
  await clock.advance(DONE_MS)
  assert.deepEqual(login.getSnapshot().rows, {})
  // A plain ready never carries it.
  await login.open({ botId: 'b', provider: 'acp-codex' })
  host.attempt = null
  await login.start('b')
  host.attempt.status = 'ready'
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.b.stage, 'done')
  assert.equal(login.getSnapshot().rows.b.sameAccount, undefined)
})

test('a switch that already failed is read by its id: failed and switched with its own words, never the offer (B12)', async () => {
  const h = await switchedRow()
  const row = h.row()
  assert.equal(row.stage, 'failed')
  assert.equal(row.switched, true)
  assert.equal(row.stillSignedIn, true)
  assert.equal(row.message, UNCHANGED)
  assert.equal(h.calls.length, 0)
  // Without an id (a host from before it), the current attempt is joined as before.
  const plain = switchHost()
  const login = createCliLogin({ actions: plain.actions, timers: manualTimers().timers })
  await login.open({ botId: 'a', provider: 'acp-codex' })
  assert.equal(login.getSnapshot().rows.a.stage, 'offer')
  assert.deepEqual(plain.calls.map(call => call[0]), ['current'])
})

test('Try again after a failed switch asks first, then switches again and reads that attempt (B6)', async () => {
  const h = await switchedRow()
  h.login.askSwitch('a')
  assert.equal(h.row().confirm, true)
  assert.deepEqual(h.calls, [], 'asking calls nothing')
  h.login.keepAttempt('a')
  assert.equal(h.row().confirm, false)
  h.login.askSwitch('a')
  h.host.switches.push({ id: 'acp-codex', attemptId: AGAIN_ID, status: 'waiting', fresh: true, url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' })
  assert.equal(await h.login.switchAgain('a'), true)
  const row = h.row()
  assert.equal(row.stage, 'attempt')
  assert.equal(row.attempt.attemptId, AGAIN_ID)
  assert.equal(row.switched, undefined)
  assert.equal(row.stillSignedIn, undefined)
  assert.equal(row.confirm, false)
  assert.deepEqual(h.calls.filter(call => call[0] !== 'refresh'), [['switch', 'a', 'acp-codex'], ['status', 'a', 'acp-codex', AGAIN_ID]])
})

test('a plain failure keeps the plain Try again: a sign-in, never a switch (B7)', async () => {
  const clock = manualTimers()
  const h = switchHost(clock.now)
  const login = createCliLogin({ actions: h.actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  await login.open({ botId: 'a', provider: 'acp-codex' })
  await login.start('a')
  h.host.attempt.status = 'failed'
  h.host.attempt.message = 'Sign-in did not finish. Try again.'
  await clock.advance(100)
  assert.equal(login.getSnapshot().rows.a.stage, 'failed')
  h.calls.length = 0
  await login.start('a')
  assert.deepEqual(h.calls.map(call => call[0]), ['start'])
})

test('a refused repeat keeps the failed switched row with the host sentence (B8)', async () => {
  const h = await switchedRow()
  h.login.askSwitch('a')
  const sentence = 'Another Automagik session on this computer is using the Bot account. Close it, then press Sign in again.'
  h.host.switchError = Object.assign(new Error(sentence), { code: 'bot/refused' })
  assert.equal(await h.login.switchAgain('a'), false)
  const row = h.row()
  assert.equal(row.stage, 'failed')
  assert.equal(row.switched, true)
  assert.equal(row.stillSignedIn, true)
  assert.equal(row.confirm, false)
  assert.equal(row.busy, false)
  assert.equal(row.error, sentence)
  assert.ok(!h.calls.some(call => call[0] === 'start'))
})

test('a switch attempt gone from the host: expired fails switched, a restart interrupts with no switch (B9)', async () => {
  for (const [expired, stage] of [[true, 'failed'], [false, 'interrupted']]) {
    for (const fresh of [true, false]) {
      const clock = manualTimers()
      const h = switchHost(clock.now)
      const login = createCliLogin({ actions: h.actions, timers: clock.timers, now: () => (expired ? clock.now() + 3_600_000 : clock.now()), pollMs: 100 })
      const live = h.keep({ id: 'acp-codex', attemptId: SWITCH_ID, status: 'waiting', expiresAt: clock.now() + 600_000, url: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', ...(fresh ? { fresh: true } : {}) })
      h.host.attempt = live
      await login.open({ botId: 'a', provider: 'acp-codex', attemptId: SWITCH_ID })
      assert.equal(login.getSnapshot().rows.a.stage, 'attempt')
      h.host.endedError = Object.assign(new Error('This sign-in ended. Start again.'), { code: 'bot/login-ended' })
      await clock.advance(100)
      await flush()
      const row = login.getSnapshot().rows.a
      assert.equal(row.stage, stage, `${expired} ${fresh}`)
      assert.equal(row.switched, fresh && expired ? true : undefined, `${expired} ${fresh}`)
      if (fresh && expired) assert.equal(row.stillSignedIn, false)
    }
  }
})

test('after a failed switch, a plain sign-in that fails is not a switch (B10)', async () => {
  const h = await switchedRow({ signedInAfter: false })
  assert.equal(h.row().stillSignedIn, false)
  await h.login.start('a')
  assert.equal(h.row().stage, 'attempt')
  assert.equal(h.row().switched, undefined)
  h.host.attempt.status = 'failed'
  h.host.attempt.message = 'Sign-in did not finish. Try again.'
  await h.clock.advance(100)
  assert.equal(h.row().stage, 'failed')
  assert.equal(h.row().switched, undefined)
  assert.equal(h.row().stillSignedIn, undefined)
  h.login.askSwitch('a')
  assert.equal(h.row().confirm, false)
  assert.equal(await h.login.switchAgain('a'), false)
  assert.ok(!h.calls.some(call => call[0] === 'switch'))
})

test('a repeated switch that fails fast shows its own failure, not the earlier one (B13)', async () => {
  const h = await switchedRow({ message: 'The CLI exited before the sign-in finished. Try again.' })
  h.login.askSwitch('a')
  h.host.switches.push(freshFailed(AGAIN_ID))
  assert.equal(await h.login.switchAgain('a'), true)
  const row = h.row()
  assert.equal(row.stage, 'failed')
  assert.equal(row.switched, true)
  assert.equal(row.message, UNCHANGED)
  assert.ok(!h.calls.some(call => call[0] === 'start' || call[0] === 'current'))
  assert.deepEqual(h.calls.find(call => call[0] === 'status'), ['status', 'a', 'acp-codex', AGAIN_ID])
})

test('a settling switch stays an attempt, busy and polled, until its read says what to offer (B16)', async () => {
  for (const after of [true, false]) {
    const clock = manualTimers()
    const h = switchHost(clock.now)
    const login = createCliLogin({ actions: h.actions, timers: clock.timers, now: clock.now, pollMs: 100 })
    h.host.switches.push({ id: 'acp-codex', attemptId: SWITCH_ID, status: 'expired', fresh: true, settling: true, message: 'This sign-in expired. Start again.' })
    await login.open({ botId: 'a', provider: 'acp-codex', attemptId: (await h.actions.cliLoginSwitch('a', 'acp-codex')).attemptId })
    let row = login.getSnapshot().rows.a
    assert.equal(row.stage, 'attempt')
    assert.equal(row.busy, true)
    assert.equal(row.attempt.url, undefined)
    h.host.byId.set(SWITCH_ID, { id: 'acp-codex', attemptId: SWITCH_ID, status: 'expired', fresh: true, signedInAfter: after, message: 'This sign-in expired. Start again.' })
    h.calls.length = 0
    await clock.advance(100)
    assert.deepEqual(h.calls[0], ['status', 'a', 'acp-codex', SWITCH_ID], 'it is polled by its id')
    row = login.getSnapshot().rows.a
    assert.equal(row.stage, 'failed')
    assert.equal(row.busy, false)
    assert.equal(row.switched, true)
    assert.equal(row.stillSignedIn, after)
    login.askSwitch('a')
    assert.equal(login.getSnapshot().rows.a.confirm, after)
    if (!after) {
      h.calls.length = 0
      await login.start('a')
      assert.deepEqual(h.calls.map(call => call[0]), ['start'])
    }
  }
  // A cancelled switch closes its row, settling or not.
  const clock = manualTimers()
  const h = switchHost(clock.now)
  const login = createCliLogin({ actions: h.actions, timers: clock.timers, now: clock.now, pollMs: 100 })
  h.keep({ id: 'acp-codex', attemptId: SWITCH_ID, status: 'cancelled', fresh: true, settling: true })
  await login.open({ botId: 'a', provider: 'acp-codex', attemptId: SWITCH_ID })
  assert.deepEqual(login.getSnapshot().rows, {})
})

test('openCliLogin hands a switch\'s attempt to the row; without one the call is as before (B14)', () => {
  const roster = createSource(indexRoster({ bots: [{ id: 'a', name: 'A', model: 'acp-codex/default' }], rooms: [], agents: [], models: [], prefs: {} }))
  const opened = []
  const manager = { open: (options) => { opened.push(options); return Promise.resolve(true) } }
  const actions = teamActions({ call: async () => {}, after: value => value, partFor: id => id, roster, ui: createSource({}), openSession: () => {}, loginState: () => manager })
  assert.equal(actions.openCliLogin('a', 'acp-codex', undefined, SWITCH_ID), true)
  assert.equal(actions.openCliLogin('a', 'acp-codex'), true)
  assert.equal(actions.openCliLogin('a', 'acp-codex', undefined, 7), true)
  assert.deepEqual(opened, [{ botId: 'a', provider: 'acp-codex', ref: undefined, attemptId: SWITCH_ID },
    { botId: 'a', provider: 'acp-codex', ref: undefined }, { botId: 'a', provider: 'acp-codex', ref: undefined }])
})

test('fresh chat entry replaces idle ordinary rows, and ordinary entry keeps its model and account', async () => {
  const { actions, calls } = fakeHost()
  const provider = 'acp-claude'
  const model = `${provider}/picked`
  const account = { kind: 'account', email: 'old@example.test' }
  const login = createCliLogin({ actions })
  actions.cliLoginCurrent = async (botId, id, { fresh } = {}) => fresh
    ? { id, attempt: null, signedIn: true }
    : { id, attempt: null, account }
  actions.cliLoginConfirm = async (...args) => {
    calls.push(['confirm', ...args])
    return { id: provider, status: 'ready' }
  }
  const row = () => login.getSnapshot().rows.a
  try {
    await login.open({ botId: 'a', provider, ref: model })
    assert.equal(row().stage, 'account')
    await login.open({ botId: 'a', provider, fresh: true })
    assert.equal(row().stage, 'offer')
    assert.equal(row().confirm, true)
    assert.equal(row().account, undefined)
    assert.deepEqual(calls, [])

    await login.open({ botId: 'a', provider })
    assert.equal(row().stage, 'account')
    assert.equal(row().fresh, undefined)
    assert.equal(row().ref, model)
    assert.deepEqual(row().account, account)

    await login.open({ botId: 'a', provider, fresh: true })
    login.dismiss('a')
    assert.equal(row(), undefined)
    assert.deepEqual(calls, [], 'Cancel at the question makes no host mutation')
  } finally { login.dispose() }
})

test('fresh intent always reaches switch admission despite stale or unknown cached status', async () => {
  const clock = manualTimers()
  const provider = 'acp-codex'
  for (const signedIn of [false, undefined]) {
    const { actions, calls } = fakeHost(clock.now)
    const login = createCliLogin({ actions, timers: clock.timers, now: clock.now })
    actions.cliLoginCurrent = async () => ({ id: provider, attempt: null, signedIn })
    const start = actions.cliLoginStart
    actions.cliLoginStart = async () => assert.fail('a stale status must never select ordinary Start')
    actions.cliLoginSwitch = (botId, id, options) => {
      calls.push(['switch', botId, id, options])
      return start(botId, id)
    }
    try {
      await login.open({ botId: 'a', provider })
      await login.open({ botId: 'a', provider, fresh: true })
      assert.equal(login.getSnapshot().rows.a.fresh, true)
      if (signedIn === false) await login.start('a')
      else await login.switchFresh('a')
      assert.deepEqual(calls[0], ['switch', 'a', provider, { fresh: true, keep: true }])
      assert.equal(login.getSnapshot().rows.a.attempt.userCode, 'ABCD-1234')
    } finally { login.dispose() }
  }
})

test('fresh chat joins an already active attempt without starting or switching', async () => {
  const clock = manualTimers()
  const { actions, calls } = fakeHost(clock.now)
  const login = createCliLogin({ actions, timers: clock.timers, now: clock.now })
  const provider = 'acp-claude'
  try {
    await login.open({ botId: 'a', provider })
    await login.start('a')
    await login.open({ botId: 'b', provider, fresh: true })
    const { a, b } = login.getSnapshot().rows
    assert.equal(b.stage, 'attempt')
    assert.equal(b.attempt.attemptId, a.attempt.attemptId)
    assert.equal(calls.filter(([name]) => name === 'start').length, 1)
  } finally { login.dispose() }
})

test('round 2 finding 4: a lost fresh attempt result does not confirm either kind of existing account', async () => {
  for (const consent of ['given', 'needed']) {
    const clock = manualTimers()
    const { actions, host, names } = fakeHost(clock.now)
    const provider = 'acp-codex'
    const login = createCliLogin({ actions, timers: clock.timers, now: clock.now, pollMs: 100 })
    try {
      const current = actions.cliLoginCurrent
      const connections = actions.cliLoginConnections
      actions.cliLoginCurrent = async (...args) => {
        const result = await current(...args)
        return consent === 'needed' && !result.attempt ? { ...result, account: { kind: 'account' } } : result
      }
      actions.cliLoginConnections = async () => {
        const result = await connections()
        result.connections[provider].consent = consent
        return result
      }
      const attempt = await actions.cliLoginStart('a', provider)
      Object.assign(host.attempt, { fresh: true, chatFresh: true })
      await login.restore('a')
      assert.equal(login.getSnapshot().rows.a.attempt.attemptId, attempt.attemptId)
      host.attempt = null
      host.signedIn = true
      host.endedError = Object.assign(new Error('The sign-in has ended.'), { code: 'bot/login-ended' })
      await clock.advance(100)
      assert.equal(login.getSnapshot().rows.a.stage, 'failed', consent)
      assert.equal(login.getSnapshot().rows.a.fresh, true)
      assert.match(login.getSnapshot().rows.a.message, /expired/i)
      assert.equal(names().includes('connections'), false)
    } finally { login.dispose() }
  }
})
