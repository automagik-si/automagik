// The sign-in rows of a page (cli-login-state.js) and the known-state helpers, without a browser:
// the host is a fake, the clock and timers are manual.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCliLogin } from '../src/client/cli-login-state.js'
import { carriesKnownState, forgetKnownStates, rememberLinkState, DONE_MS, APPLY_FAILED_MS } from '../src/client/cli-login-model.js'
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
