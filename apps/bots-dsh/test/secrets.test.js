import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspect } from 'node:util'
import { EDGE_MIN } from '../src/host/secrets.js'
import { apply } from '../index.js'
import { canUse, encodeUrlComponent, normalizeName, redactDeep, redactor, SECRET_NAME } from '../src/host/secrets.js'
import { fakeContext } from './fake-ctx.js'

// Test values are random on every run, so a leak can only come from this run.
const fresh = () => `t-${randomBytes(12).toString('hex')}`

test('names are normalized, then checked', () => {
  assert.equal(normalizeName(' github-token '), 'GITHUB_TOKEN')
  assert.equal(normalizeName('$DSH_SECRET_demo_token'), 'DEMO_TOKEN')
  assert.equal(normalizeName('$env:DSH_SECRET_X1'), 'X1')
  assert.ok(SECRET_NAME.test('GITHUB_TOKEN'))
  for (const bad of ['', '1ABC', '_X', 'A'.repeat(65), 'A B', 'Ä']) assert.ok(!SECRET_NAME.test(bad), bad)
})

test('scope is every Bot or a list', () => {
  assert.ok(canUse({ scope: 'all' }, 'b'))
  assert.ok(canUse({ scope: ['a', 'b'] }, 'b'))
  assert.ok(!canUse({ scope: ['a'] }, 'b'))
  assert.ok(!canUse({ scope: [] }, 'b'))
  assert.ok(!canUse(undefined, 'b'))
  assert.ok(!canUse({ scope: 'all' }, undefined))
})

test('redaction replaces the longest value first, JSON-escaped forms too, and skips short values', () => {
  const long = fresh()
  const inner = long.slice(0, 12)
  const quoted = `${fresh()}"\\x`
  const redact = redactor([{ name: 'INNER', value: inner }, { name: 'LONG', value: long }, { name: 'SHORT', value: 'abc' }, { name: 'Q', value: quoted }])
  assert.equal(redact(`a ${long} b ${inner} c abc`), 'a [secret:LONG] b [secret:INNER] c abc')
  assert.equal(redact(JSON.stringify({ text: quoted })), '{"text":"[secret:Q]"}')
  assert.equal(redact(42), 42)
  const value = { list: ['x', { text: `see ${long}` }], n: 1 }
  const out = redactDeep(value, redact)
  assert.deepEqual(out, { list: ['x', { text: 'see [secret:LONG]' }], n: 1 })
  assert.equal(value.list[1].text, `see ${long}`)
  const clean = { list: ['x'] }
  assert.equal(redactDeep(clean, redact), clean)
})

test('redaction replaces URL-encoded values', () => {
  const value = `${fresh()} /+&?=#'!()* 中文`
  const redact = redactor([{ name: 'TOKEN', value }])
  assert.equal(redact(`https://example.test/mcp?key=${encodeUrlComponent(value)}&mode=1`), 'https://example.test/mcp?key=[secret:TOKEN]&mode=1')
  assert.equal(redact(new URL(`https://example.test/mcp?key=${encodeUrlComponent(value)}`).href), 'https://example.test/mcp?key=[secret:TOKEN]')
  const broken = `${fresh()}\uD800`
  assert.equal(redactor([{ name: 'BROKEN', value: broken }])(`x ${broken}`), 'x [secret:BROKEN]')
})

test('a short key (4 to 7 characters) is replaced only where it stands alone', () => {
  const redact = redactor([{ name: 'PIN', value: '4821' }, { name: 'PW', value: 'cat$1' }, { name: 'SECRET_WORD', value: 'secret' }])
  assert.equal(redact('pin 4821, again "4821"'), 'pin [secret:PIN], again "[secret:PIN]"')
  // Inside a longer number or word it is left alone.
  assert.equal(redact('order 148210 and x4821'), 'order 148210 and x4821')
  assert.equal(redact('login cat$1@host'), 'login [secret:PW]@host')
  assert.equal(redact('concat$12'), 'concat$12')
  // A label already written is not matched again, even when it holds the value.
  assert.equal(redact('secret and 4821'), '[secret:SECRET_WORD] and [secret:PIN]')
  assert.equal(redact('中文4821中文'), '中文4821中文')
})

test('an anywhere redactor matches a short value inside a word, longest value first', () => {
  const long = `pin${'z'.repeat(12)}`
  const short = long.slice(3, 7)
  const entries = [{ name: 'PIN', value: short }, { name: 'LONG', value: long }]
  const redact = redactor(entries, { wholeWords: false })
  assert.equal(redact(`x${short}y`), 'x[secret:PIN]y')
  assert.equal(redact(`x${long}y`), 'x[secret:LONG]y')
})

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Omni', role: 'Channel orchestrator', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: '写作', lab: 'kimi', instructions: '', createdAt: 2 },
    c3: { id: 'c3', sessionId: 'c3', name: 'Coder', role: '代码', lab: 'deepseek', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Team', named: true, members: ['m1', 'b2'], admin: 'm1', mode: 'everyone', notice: '', sessions: { b2: 'g-b2' }, log: [] },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-')), warnings, team = TEAM } = {}) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const contributors = []
  const shellEnv = {
    register(contributor) {
      const entry = { ...contributor, live: true }
      contributors.push(entry)
      return () => { entry.live = false }
    },
  }
  const ctx = fakeContext({ services: { shellEnv } })
  if (warnings !== undefined) ctx.logger = { info() {}, warn: (...args) => warnings.push(args.slice(1).join(' ')) }
  const listeners = {}
  const on = ctx.on
  ctx.on = (name, listener, options) => {
    ;(listeners[name] ??= []).push(listener)
    return on(name, listener, options)
  }
  const delivered = []
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { session: {}, followup: message => delivered.push({ sessionId, text: message.content[0].text, source: message.source }) } }),
  }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  const streamed = []
  ctx.llm.stream = (options) => {
    streamed.push(options)
    return (async function* () {})()
  }
  let route
  ctx.connection.fetch.register = (options) => { route = options; return () => {} }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, agentId, extra = {}) => {
    let concluded = false
    const exec = { agent: { id: agentId }, callId: `call-${agentId}-${name}`, concludeTurn: () => { concluded = true }, ...extra }
    return ctx.registeredTools.get(name).execute(args, exec).then(text => ({ text, concluded }))
  }
  const view = async () => {
    const result = await call('state', {})
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value
  }
  const env = (agentId, command = '') => contributors.filter(entry => entry.live).at(-1)?.resolve({ agent: { id: agentId, session: { header: { id: agentId } } }, arguments: { command } }) ?? {}
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, call, tool, view, env, listeners, delivered, streamed, contributors, stop }
}

// Bootstrap would create a Main Bot when none exists; this team has one, so it only loads.
test('a card saves a key the Bot never sees, and the shell gets it', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()

  const asked = await bench.tool('request_secret', { name: 'demo_token', purpose: '测试' }, 'b2')
  assert.equal(asked.concluded, true)
  assert.match(asked.text, /card asking the user for DEMO_TOKEN is on screen/)
  let team = await bench.view()
  const [request] = team.secretRequests.b2
  assert.equal(request.name, 'DEMO_TOKEN')
  assert.equal(request.kind, 'fill')
  assert.equal(request.status, 'pending')
  assert.equal(request.callId, 'call-b2-request_secret')

  assert.match((await bench.call('secret-set', { requestId: request.id, value: 'abc' })).error.message, /at least 4/)
  const saved = await bench.call('secret-set', { requestId: request.id, value: `  ${value}\n` })
  assert.equal(saved.ok, true)
  assert.deepEqual(Object.keys(saved.value).sort(), ['createdAt', 'name', 'purpose', 'requestedBy', 'scope', 'updatedAt'])
  assert.equal(saved.value.scope, 'all')
  assert.equal(saved.value.requestedBy, 'b2')
  assert.match((await bench.call('secret-set', { requestId: request.id, value })).error.message, /already answered/)

  const file = join(bench.home, 'secrets.json')
  // Windows has no POSIX mode bits: a writable file always stats as 0o666 there.
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).secrets[0].value, value)
  assert.deepEqual(readdirSync(bench.home).filter(name => name.endsWith('.tmp')), [])
  team = await bench.view()
  assert.equal(team.secretRequests.b2[0].status, 'saved')
  assert.deepEqual(team.secrets.map(secret => secret.name), ['DEMO_TOKEN'])
  // Nothing the browser gets holds the value.
  assert.ok(!JSON.stringify(team).includes(value))
  assert.ok(!readFileSync(join(bench.home, 'state.json'), 'utf8').includes(value))

  const note = bench.delivered.at(-1)
  assert.equal(note.sessionId, 'b2')
  assert.equal(note.source.role, 'secret')
  assert.match(note.text, /^\[Secret card\]\nThe user saved DEMO_TOKEN for every Bot\. Use it as \$DSH_SECRET_DEMO_TOKEN in bash, or \$env:DSH_SECRET_DEMO_TOKEN in PowerShell\./)
  assert.ok(!note.text.includes(value))

  // Every Bot (own chat or group Session) gets the variable; other Sessions do not.
  assert.deepEqual(bench.env('b2', 'echo $DSH_SECRET_DEMO_TOKEN'), { DSH_SECRET_DEMO_TOKEN: value })
  assert.deepEqual(bench.env('g-b2'), { DSH_SECRET_DEMO_TOKEN: value })
  assert.deepEqual(bench.env('not-a-bot'), {})
  const live = bench.contributors.filter(entry => entry.live)
  assert.equal(live.length, 1)
  assert.deepEqual(Object.keys(live[0].variables), ['DSH_SECRET_DEMO_TOKEN'])
  assert.equal(live[0].variables.DSH_SECRET_DEMO_TOKEN.description, 'Omni secret DEMO_TOKEN: 测试')

  // Asking again only names the variable.
  const again = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'x' }, 'b2')
  assert.equal(again.concluded, false)
  assert.match(again.text, /already saved and you may use it: \$DSH_SECRET_DEMO_TOKEN/)
  const listed = await bench.tool('list_secrets', {}, 'c3')
  assert.match(listed.text, /- DEMO_TOKEN — 测试 — for every Bot — you may use it as \$DSH_SECRET_DEMO_TOKEN/)
  assert.ok(!listed.text.includes(value))
})

test('a Bot outside the scope gets an allow card, and allowing resolves it', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: '测试' }, 'b2')
  let [request] = (await bench.view()).secretRequests.b2
  assert.equal((await bench.call('secret-set', { requestId: request.id, value, scope: 'bot' })).value.scope.join(), 'b2')
  assert.deepEqual(bench.env('c3'), {})

  // Coder asks too, while a second Writer card would be superseded by the first answer.
  const asked = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'c3')
  assert.match(asked.text, /let you use DEMO_TOKEN/)
  ;[request] = (await bench.view()).secretRequests.c3
  assert.equal(request.kind, 'allow')
  const listed = await bench.tool('list_secrets', {}, 'c3')
  assert.match(listed.text, /for Writer — you may not use it/)

  const allowed = await bench.call('secret-allow', { requestId: request.id })
  assert.deepEqual(allowed.value.scope, ['b2', 'c3'])
  assert.equal((await bench.view()).secretRequests.c3[0].status, 'allowed')
  assert.deepEqual(bench.env('c3'), { DSH_SECRET_DEMO_TOKEN: value })
  assert.match(bench.delivered.at(-1).text, /^\[Secret card\]\nThe user let you use DEMO_TOKEN\./)

  // Settings: narrow the scope, which turns a new card back into an allow card.
  await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: ['b2', 'nope'] })
  assert.deepEqual((await bench.view()).secrets[0].scope, ['b2'])
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'c3')
  const pending = (await bench.view()).secretRequests.c3.at(-1)
  assert.equal(pending.kind, 'allow')
  // Widening it resolves the waiting card and tells Coder.
  await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: 'all' })
  assert.equal((await bench.view()).secretRequests.c3.at(-1).status, 'saved')
  assert.match(bench.delivered.at(-1).text, /The user saved DEMO_TOKEN, and you may use it now\./)

  // Replacing the value keeps the scope; the old value is no longer injected.
  const next = fresh()
  await bench.call('secret-set', { name: 'demo_token', value: next })
  assert.deepEqual(bench.env('c3'), { DSH_SECRET_DEMO_TOKEN: next })
  assert.equal((await bench.view()).secrets[0].scope, 'all')

  // Deleting turns a waiting allow card into a fill card and drops the variable.
  await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: ['b2'] })
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'build' }, 'c3')
  await bench.call('secret-delete', { name: 'DEMO_TOKEN' })
  const team = await bench.view()
  assert.deepEqual(team.secrets, [])
  assert.equal(team.secretRequests.c3.at(-1).kind, 'fill')
  assert.equal(bench.contributors.filter(entry => entry.live).length, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets, [])
})

test('a key\'s purpose can be changed or cleared on its own', async (t) => {
  const bench = start()
  t.after(bench.stop)
  await bench.call('secret-set', { name: 'DEMO_TOKEN', value: fresh(), purpose: 'first', scope: 'all' })

  const changed = await bench.call('secret-update', { name: 'DEMO_TOKEN', purpose: 'renamed' })
  assert.equal(changed.value.purpose, 'renamed')
  assert.equal(changed.value.scope, 'all')
  const cleared = await bench.call('secret-update', { name: 'DEMO_TOKEN', purpose: '' })
  assert.equal(cleared.value.purpose, '')
  const scoped = await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: ['b2'] })
  assert.deepEqual(scoped.value.scope, ['b2'])
  assert.equal(scoped.value.purpose, '')
  const both = await bench.call('secret-update', { name: 'DEMO_TOKEN', scope: 'all', purpose: 'kept' })
  assert.equal(both.value.scope, 'all')
  assert.equal(both.value.purpose, 'kept')
  const saved = JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets[0]
  assert.equal(saved.purpose, 'kept')
  assert.equal(saved.scope, 'all')
})

test('cards stay in a Bot\'s own chat; canceling tells the Bot', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const group = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'x' }, 'g-b2')
  assert.equal(group.concluded, false)
  assert.match(group.text, /only work in your own chat/)
  assert.match((await bench.tool('request_secret', { name: '9bad', purpose: 'x' }, 'b2')).text, /capitals, digits, and underscores/)
  assert.match((await bench.tool('request_secret', { name: 'X_KEY', purpose: 'x' }, 'stranger')).text, /Only Bots/)

  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'first' }, 'b2')
  await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'second' }, 'b2')
  const [first, second] = (await bench.view()).secretRequests.b2
  assert.equal(first.status, 'canceled')
  assert.equal(second.status, 'pending')
  assert.equal((await bench.call('secret-cancel', { requestId: second.id })).ok, true)
  assert.equal((await bench.view()).secretRequests.b2[1].status, 'canceled')
  assert.match(bench.delivered.at(-1).text, /^\[Secret card\]\nThe user canceled your request for DEMO_TOKEN\./)
  assert.match((await bench.call('secret-allow', { requestId: 'gone' })).error.message, /request is gone/)
})

test('a deleted Bot leaves every scope list and takes its cards along', async (t) => {
  const bench = start()
  t.after(bench.stop)
  await bench.call('secret-set', { name: 'API_KEY', value: fresh(), scope: ['b2', 'c3'], purpose: 'p' })
  await bench.tool('request_secret', { name: 'OTHER_KEY', purpose: 'x' }, 'c3')
  assert.equal((await bench.call('delete-bot', { id: 'c3' })).ok, true)
  const team = await bench.view()
  assert.deepEqual(team.secrets[0].scope, ['b2'])
  assert.equal(team.secretRequests.c3, undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets[0].scope, ['b2'])
})

test('tool results and model requests lose the values', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()
  await bench.call('secret-set', { name: 'DEMO_TOKEN', value })
  // The team tools' listener (working_directory) registers first.
  const execute = bench.listeners['tools/execute'].at(-1)
  const ok = await execute({}, async () => ({ isError: false, value: { kind: 'foreground', stdout: { text: `${value}\n`, truncated: false } }, content: [{ type: 'text', text: value }], meta: { stdout: value } }))
  assert.deepEqual(ok, { isError: false, value: { kind: 'foreground', stdout: { text: '[secret:DEMO_TOKEN]\n', truncated: false } }, content: [{ type: 'text', text: '[secret:DEMO_TOKEN]' }], meta: { stdout: '[secret:DEMO_TOKEN]' } })
  const failed = await execute({}, async () => ({ isError: true, error: { message: `bad ${value}` }, content: [{ type: 'text', text: `bad ${value}` }] }))
  assert.equal(failed.content[0].text, 'bad [secret:DEMO_TOKEN]')
  assert.equal(failed.error.message, 'bad [secret:DEMO_TOKEN]')
  const plain = { isError: false, value: 'nothing here' }
  assert.equal(await execute({}, async () => plain), plain)

  // The usage meter registers after the secrets listener.
  const stream = bench.listeners['llm/stream'].at(-2)
  const passed = []
  const next = () => { passed.push(true); return (async function* () {})() }
  const options = {
    provider: 'p', model: 'm', sessionId: 'b2', system: `sys ${value}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: `my key is ${value}` }] }, { role: 'tool', content: [{ type: 'text', text: value }] }],
  }
  stream(options, next)
  assert.equal(passed.length, 0)
  const sent = bench.streamed.at(-1)
  assert.equal(sent.system, 'sys [secret:DEMO_TOKEN]')
  assert.equal(sent.provider, 'p')
  assert.ok(!JSON.stringify(sent).includes(value))
  assert.ok(JSON.stringify(options).includes(value))
  // The rewritten request passes through, even when a value sits inside its own label.
  stream(sent, next)
  assert.equal(passed.length, 1)
  stream({ ...options, system: 'clean', messages: [] }, next)
  assert.equal(passed.length, 2)
})

test('whole tool results preserve fields and redact auxiliary values on success and error', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = fresh()
  await bench.call('secret-set', { name: 'DEMO_TOKEN', value })
  const execute = bench.listeners['tools/execute'].at(-1)
  for (const isError of [false, true]) {
    for (const primary of ['clean', value]) {
      const result = {
        isError,
        value: { text: primary },
        ...(isError ? { error: { message: primary } } : {}),
        content: [{ type: 'text', text: `out ${value}` }],
        meta: { nested: [value], count: 3 },
        additionalContexts: [{ role: 'user', content: [{ type: 'text', text: value }] }],
        extension: { detail: value, keep: true },
      }
      // An outer wrapper sees the complete redacted result before re-rendering.
      const actual = await execute({}, async () => result)
      assert.deepEqual(actual, {
        isError,
        value: { text: primary === value ? '[secret:DEMO_TOKEN]' : primary },
        ...(isError ? { error: { message: primary === value ? '[secret:DEMO_TOKEN]' : primary } } : {}),
        content: [{ type: 'text', text: 'out [secret:DEMO_TOKEN]' }],
        meta: { nested: ['[secret:DEMO_TOKEN]'], count: 3 },
        additionalContexts: [{ role: 'user', content: [{ type: 'text', text: '[secret:DEMO_TOKEN]' }] }],
        extension: { detail: '[secret:DEMO_TOKEN]', keep: true },
      })
      assert.equal(result.content[0].text, `out ${value}`, 'the original is not mutated')
    }
  }
  const clean = { isError: false, value: 'clean', content: [], meta: { count: 3 } }
  assert.equal(await execute({}, async () => clean), clean)
})

test('a restarted host resolves team Sessions and scoped keys before the first shell call', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  const shared = fresh(), scoped = fresh(), denied = fresh()
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({ version: 1, secrets: [
    { name: 'SHARED', value: shared, scope: 'all' },
    { name: 'SCOPED', value: scoped, scope: ['b2'] },
    { name: 'DENIED', value: denied, scope: [] },
    { name: 'HELD', value: 'abc', scope: 'all' },
  ] }))
  // Unnamed groups need the group helpers during roster adoption.
  const team = { ...TEAM, rooms: { r1: { ...TEAM.rooms.r1, named: false } } }
  const bench = start({ home, team })
  t.after(bench.stop)
  // No await, endpoint or tool call can give asynchronous loaders time to finish.
  assert.deepEqual(bench.env('b2'), { DSH_SECRET_SHARED: shared, DSH_SECRET_SCOPED: scoped })
  assert.deepEqual(bench.env('g-b2'), { DSH_SECRET_SHARED: shared, DSH_SECRET_SCOPED: scoped })
  assert.deepEqual(bench.env('c3'), { DSH_SECRET_SHARED: shared })
  assert.deepEqual(bench.env('elsewhere'), {})
  assert.ok(bench.contributors.filter(entry => entry.live).every(entry => !('DSH_SECRET_HELD' in entry.variables)))
})

test('a secrets file that cannot be read blocks every write instead of being overwritten', async (t) => {
  // A directory reads as EISDIR on every platform; no chmod games needed. It has to
  // exist before the plugin loads, or the first read has already found the file empty.
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  mkdirSync(join(home, 'secrets.json'))
  const bench = start({ home })
  t.after(bench.stop)
  const file = join(home, 'secrets.json')
  const denied = await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.message, 'The secrets file could not be read (EISDIR). Omni does not change it; fix or move it and reload.')
  assert.ok(statSync(file).isDirectory())
  // While it stays unreadable, nothing is written; once it is gone, saving works.
  rmSync(file, { recursive: true })
  const saved = await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })
  assert.equal(saved.ok, true, JSON.stringify(saved.error))
})

test('loads racing a save after an unreadable file is gone do not clear the key it saved', async (t) => {
  // Every load reads an unreadable file again; reads that overlapped could land after the
  // save and empty the store (a gone file reads as empty), so the save answered with nothing.
  for (let round = 0; round < 5; round++) {
    const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
    mkdirSync(join(home, 'secrets.json'))
    const bench = start({ home })
    t.after(bench.stop)
    assert.equal((await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })).ok, false)
    rmSync(join(home, 'secrets.json'), { recursive: true })
    const [saved] = await Promise.all([
      bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' }),
      ...Array.from({ length: 8 }, () => bench.call('state', {})),
    ])
    assert.equal(saved.ok, true, JSON.stringify(saved.error))
    assert.equal(saved.value.name, 'TEST_TOKEN')
  }
})

test('a secrets file that is not JSON is kept aside, and the store goes on', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  writeFileSync(join(home, 'secrets.json'), 'not a secrets file\n')
  const bench = start({ home })
  t.after(bench.stop)
  const saved = await bench.call('secret-set', { name: 'TEST_TOKEN', value: '12345678' })
  assert.equal(saved.ok, true, JSON.stringify(saved.error))
  const broken = readdirSync(home).filter(name => name.startsWith('secrets.json.broken-'))
  assert.deepEqual(broken.length, 1)
  assert.equal(readFileSync(join(home, broken[0]), 'utf8'), 'not a secrets file\n')
})

// #484: a value below the write floor can only come from a hand-edited file, and no redactor
// can match it (a 1-3 character value sits inside ordinary words). The loader holds it with a
// warning that names the floor: nothing uses it, yet it stays in secrets.json and in the list
// instead of being silently dropped, and a new longer value lifts the hold.
test('a hand-edited secret below the floor is held with a warning, and never silently dropped', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  const short = 'q7z'
  const long = fresh()
  writeFileSync(join(home, 'secrets.json'), JSON.stringify({
    version: 1,
    secrets: [
      { name: 'SHORT_KEY', value: short, purpose: 'hand-edited', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 2 },
      { name: 'LONG_KEY', value: long, purpose: 'fine', scope: 'all', requestedBy: null, createdAt: 1, updatedAt: 2 },
    ],
  }))
  const warnings = []
  const bench = start({ home, warnings })
  t.after(bench.stop)

  // Loading goes through the tool, which awaits the file read.
  const listed = await bench.tool('list_secrets', {}, 'b2')
  assert.ok(
    warnings.some(line => /secret SHORT_KEY in .*secrets\.json is held: its saved value is shorter than the 4-character minimum; nothing uses it until a longer value is saved/.test(line)),
    warnings.join('\n'),
  )
  assert.equal(warnings.some(line => line.includes(short)), false)

  // The valid key works; the held one reaches no shell, is listed as held, and its value is
  // never in anything a Bot or the browser reads.
  assert.deepEqual(bench.env('b2'), { DSH_SECRET_LONG_KEY: long })
  assert.ok(listed.text.includes('- SHORT_KEY — hand-edited — for every Bot — held: its saved value is shorter than 4 characters, so nothing uses it; save a new value'))
  assert.equal(listed.text.includes(short), false)
  const team = await bench.view()
  assert.deepEqual(team.secrets.map(secret => [secret.name, secret.held]), [['LONG_KEY', undefined], ['SHORT_KEY', true]])
  assert.equal(JSON.stringify(team).includes(short), false)

  // Asking again shows the fill card, so the value can be replaced with a usable one.
  const asked = await bench.tool('request_secret', { name: 'SHORT_KEY', purpose: 'retry' }, 'b2')
  assert.match(asked.text, /card asking the user for SHORT_KEY is on screen/)
  assert.equal((await bench.view()).secretRequests.b2.at(-1).kind, 'fill')

  // Saving another key rewrites the file with the held entry intact: no silent drop.
  const other = fresh()
  assert.equal((await bench.call('secret-set', { name: 'OTHER_KEY', value: other })).ok, true)
  const file = JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets
  assert.equal(file.find(secret => secret.name === 'SHORT_KEY').value, short)

  // A longer value for the held name lifts the hold and reaches the shell.
  const next = fresh()
  assert.equal((await bench.call('secret-set', { name: 'SHORT_KEY', value: next })).ok, true)
  assert.deepEqual(bench.env('c3'), { DSH_SECRET_LONG_KEY: long, DSH_SECRET_OTHER_KEY: other, DSH_SECRET_SHORT_KEY: next })
  assert.equal((await bench.view()).secrets.find(secret => secret.name === 'SHORT_KEY').held, undefined)
})

// #316: a GitHub token request carries the work it is for, and the card asks for no more.
test('a GitHub token request says its work, and the answer names only the permissions it needs', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const asked = await bench.tool('request_secret', { name: 'GITHUB_TOKEN', purpose: 'Push my fix and open the pull request', github: ['edit_code', 'open_prs'] }, 'b2')
  assert.equal(asked.concluded, true)
  assert.match(asked.text, /card asking the user for GITHUB_TOKEN is on screen/)
  assert.match(asked.text, /fine-grained GitHub token with Contents: Read and write, Pull requests: Read and write, for 30 days/)
  assert.doesNotMatch(asked.text, /Issues|Workflows|Administration/)
  const [request] = (await bench.view()).secretRequests.b2
  assert.deepEqual(request.github, ['edit_code', 'open_prs'])
  assert.equal(request.kind, 'fill')
})

test('a GitHub token without declared work, or with unknown work, shows no card', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const bare = await bench.tool('request_secret', { name: 'GH_TOKEN', purpose: 'repository, issues and pull request read' }, 'b2')
  assert.equal(bare.concluded, false)
  assert.match(bare.text, /Say what you will do with GH_TOKEN: pass github with read_code, edit_code, read_prs, open_prs, read_issues, edit_issues/)
  // The work is a closed list: DSH refuses a tag outside the schema's enum before the tool runs.
  await assert.rejects(bench.tool('request_secret', { name: 'GITHUB_TOKEN', purpose: 'x', github: ['edit_code', 'admin'] }, 'b2'), /must be one of \["read_code","edit_code","read_prs","open_prs","read_issues","edit_issues"\]/)
  assert.deepEqual((await bench.view()).secretRequests.b2 ?? [], [])
  // Other keys are asked for as before, with no work and no GitHub steps.
  const other = await bench.tool('request_secret', { name: 'DEMO_TOKEN', purpose: 'x' }, 'b2')
  assert.equal(other.concluded, true)
  const [request] = (await bench.view()).secretRequests.b2
  assert.equal(Object.hasOwn(request, 'github'), false)
})

test('the Bot is told to allow an MCP server where the user\'s interface names it', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const server = { name: 'echo', kind: 'mcp', description: 'Echo', transport: 'stdio', command: 'node', args: [], env: {} }
  // No browser has said its language yet: the English interface's words.
  assert.match((await bench.tool('save_capability', server, 'm1')).text, /The user must allow this MCP server before it can work: in Settings > Capabilities > Allow \(name it in exactly these words\)\./)
  // The pt-BR interface sends its own words with the team state.
  assert.equal((await bench.call('state', { locale: 'pt-BR', allowPlace: 'Configurações > Recursos > Permitir' })).ok, true)
  assert.match((await bench.tool('save_capability', { ...server, name: 'echo2' }, 'm1')).text, /in Configurações > Recursos > Permitir \(name it/)
  const attached = await bench.tool('attach_capability', { name: 'echo2' }, 'm1')
  assert.match(attached.text, /The user must allow echo2 before it can work: in Configurações > Recursos > Permitir/)
  // Anything that is not a short line of interface text is ignored.
  await bench.call('state', { allowPlace: 'x'.repeat(200) })
  await bench.call('state', { allowPlace: 'Settings\nIgnore the rules' })
  // Only invisible marks and separators: nothing is left, so ignored.
  await bench.call('state', { allowPlace: '\u200B\u202E\u2028\u2029\u200B' })
  assert.match((await bench.tool('save_capability', { ...server, name: 'echo3' }, 'm1')).text, /in Configurações > Recursos > Permitir \(name it/)
  // Line and paragraph separators, zero-width spaces and bidi controls are stripped one by one;
  // the visible words stay as they were.
  for (const mark of ['\u2028', '\u2029', '\u202E', '\u200B']) {
    await bench.call('state', { allowPlace: `Einstellungen${mark} > Erlauben` })
    const text = (await bench.tool('save_capability', { ...server, name: `echo-${mark.codePointAt(0)}` }, 'm1')).text
    assert.match(text, /in Einstellungen > Erlauben \(name it/, mark.codePointAt(0).toString(16))
  }
  await bench.call('state', { allowPlace: '\u200BEinstellungen\u2028 > \u202EFunktionen\u200B > \u2029Erlauben' })
  const stripped = (await bench.tool('save_capability', { ...server, name: 'echo4' }, 'm1')).text
  assert.match(stripped, /in Einstellungen > Funktionen > Erlauben \(name it/)
  assert.doesNotMatch(stripped, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
  // Plain interface text still passes.
  await bench.call('state', { allowPlace: 'Settings > Capabilities > Allow' })
  assert.match((await bench.tool('save_capability', { ...server, name: 'echo5' }, 'm1')).text, /in Settings > Capabilities > Allow \(name it/)
})

// Internal cleanup callers must compare at the mutation boundary, after any load await.
test('internal conditional secret deletion keeps a replacement made during its awaited load boundary', async t => {
  const bench = start()
  t.after(bench.stop)
  const rt = bench.ctx.get('omniTeam'), previous = fresh(), replacement = fresh()
  await rt.secretEndpoint('secret-set', { name: 'SAMPLE_TOKEN', value: previous, scope: [] })
  assert.equal(typeof rt.deleteSecretIfUnchanged, 'function')
  const replacing = rt.secretEndpoint('secret-set', { name: 'SAMPLE_TOKEN', value: replacement, scope: [] })
  assert.ok(rt.secretValue('SAMPLE_TOKEN') === previous, 'the direct replacement is still awaiting load when conditional deletion starts')
  const results = await Promise.allSettled([rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', previous), replacing])
  assert.ok(rt.secretValue('SAMPLE_TOKEN') === replacement, 'the replacement remains in the actual secret map')
  const stored = JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets
  assert.ok(stored.find(entry => entry.name === 'SAMPLE_TOKEN')?.value === replacement, 'the replacement remains on disk')
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[0].value, false)
  assert.equal(results[1].status, 'fulfilled')
  assert.ok(!JSON.stringify(await bench.view()).includes(replacement))
})

test('internal conditional secret deletion commits only a matching known value and exposes no endpoint', async t => {
  const bench = start()
  t.after(bench.stop)
  const rt = bench.ctx.get('omniTeam'), value = fresh()
  await rt.secretEndpoint('secret-set', { name: 'SAMPLE_TOKEN', value, scope: [] })
  assert.equal(await rt.deleteSecretIfUnchanged('MISSING_TOKEN', value), false)
  assert.equal(await rt.deleteSecretIfUnchanged('sample_token', value), false, 'an internal exact name is never normalized into a different name')
  assert.equal(await rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', undefined), false)
  assert.equal(await rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', fresh()), false)
  assert.ok(rt.secretValue('SAMPLE_TOKEN') === value)
  assert.equal(await rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', value), true)
  assert.equal(rt.secretValue('SAMPLE_TOKEN'), undefined)
  assert.deepEqual(JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets, [])
  assert.equal((await bench.call('secret-delete-if-unchanged', { name: 'SAMPLE_TOKEN', expectedValue: value })).ok, false)
})

test('internal conditional secret deletion retains keys when the store is read-only or stopped', async t => {
  const bench = start()
  t.after(bench.stop)
  const rt = bench.ctx.get('omniTeam'), value = fresh(), writable = rt.readOnly
  await rt.secretEndpoint('secret-set', { name: 'SAMPLE_TOKEN', value, scope: [] })
  rt.readOnly = () => 'Fixture read-only'
  assert.equal(await rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', value), false)
  assert.ok(rt.secretValue('SAMPLE_TOKEN') === value)
  rt.readOnly = writable
  await bench.ctx.dispose()
  assert.equal(await rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', value), false)
  assert.ok(JSON.parse(readFileSync(join(bench.home, 'secrets.json'), 'utf8')).secrets[0].value === value)
})

test('internal conditional secret deletion keeps an unreadable store untouched', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-secrets-'))
  mkdirSync(join(home, 'secrets.json'))
  const bench = start({ home })
  t.after(bench.stop)
  const rt = bench.ctx.get('omniTeam')
  assert.equal(await rt.deleteSecretIfUnchanged('SAMPLE_TOKEN', fresh()), false)
  assert.ok(statSync(join(home, 'secrets.json')).isDirectory())
})


const shapeSecret = 'Fake-Secret/Value+1 é'
const shapeLabel = '[secret:SHAPE]'
const shapeRedact = redactor([{ name: 'SHAPE', value: shapeSecret }])

test('redactDeep preserves real Errors, subclasses and AggregateError descriptors', () => {
  class ToolError extends Error {}
  const cause = new ToolError(`cause ${shapeSecret}`)
  const error = new ToolError(`failed ${shapeSecret}`, { cause })
  error.extra = { detail: shapeSecret }
  const aggregate = new AggregateError([error, shapeSecret], shapeSecret, { cause: error })
  const copy = redactDeep(aggregate, shapeRedact)
  assert.ok(copy instanceof Error)
  assert.ok(copy instanceof AggregateError)
  assert.equal(copy.constructor, aggregate.constructor)
  assert.equal(Object.getPrototypeOf(copy), Object.getPrototypeOf(aggregate))
  assert.equal(copy.cause, copy.errors[0])
  assert.equal(copy.errors[0].constructor, ToolError)
  assert.equal(Object.getPrototypeOf(copy.errors[0]), ToolError.prototype)
  assert.equal(copy.errors[0].extra.detail, shapeLabel)
  assert.equal(copy.errors[0].cause.message, `cause ${shapeLabel}`)
  assert.equal(copy.errors[1], shapeLabel)
  assert.ok(!inspect(copy, { depth: null, showHidden: true }).includes(shapeSecret))
  for (const [original, actual] of [[aggregate, copy], [error, copy.errors[0]], [cause, copy.errors[0].cause]]) {
    if (Error.isError) assert.ok(Error.isError(actual))
    for (const key of Reflect.ownKeys(original)) {
      const before = Object.getOwnPropertyDescriptor(original, key)
      const after = Object.getOwnPropertyDescriptor(actual, key)
      assert.equal(after.enumerable, before.enumerable)
      assert.equal(after.configurable, before.configurable)
      if ('writable' in before) assert.equal(after.writable, before.writable)
      else assert.ok('value' in after)
      if (typeof after.value === 'string') assert.ok(!after.value.includes(shapeSecret))
    }
    assert.ok(original.message.includes(shapeSecret))
    assert.ok(original.stack.includes(shapeSecret))
  }
})

test('redactDeep copies null prototypes, class instances, keys and symbols safely', () => {
  class Result {
    constructor() { this.text = shapeSecret }
    toJSON() { throw new Error('must not call toJSON') }
    set inherited(value) { throw new Error('must not call setter') }
  }
  const input = Object.create(null)
  const symbol = Symbol('unchanged')
  input.item = new Result()
  input[symbol] = { text: shapeSecret }
  Object.defineProperty(input.item, 'inherited', { value: shapeSecret, enumerable: true })
  input[shapeSecret] = 1
  input[shapeLabel] = 2
  input[`${shapeLabel}#2`] = 3
  Object.defineProperty(input, '__proto__', { value: shapeSecret, enumerable: true })
  Object.freeze(input)
  const copy = redactDeep(input, shapeRedact)
  assert.equal(Object.getPrototypeOf(copy), null)
  assert.equal(Object.getPrototypeOf(copy.item), Result.prototype)
  assert.equal(copy.item.text, shapeLabel)
  assert.equal(copy.item.inherited, shapeLabel)
  assert.equal(copy[symbol], input[symbol])
  assert.equal(copy[shapeLabel], 1)
  assert.equal(copy[`${shapeLabel}#2`], 2)
  assert.equal(copy[`${shapeLabel}#2#2`], 3)
  assert.equal(Object.hasOwn(copy, shapeSecret), false)
  assert.equal(copy.__proto__, shapeLabel)
  assert.equal(input.__proto__, shapeSecret)
  assert.equal(input.item.text, shapeSecret)
  const plain = JSON.parse(`{"__proto__":"${shapeSecret}"}`)
  const safe = redactDeep(plain, shapeRedact)
  assert.equal(Object.getPrototypeOf(safe), Object.prototype)
  assert.equal(safe.__proto__, shapeLabel)
  // URL has no own enumerable string properties, so there is nothing to walk.
  const url = new URL('https://example.test/path')
  assert.equal(redactDeep(url, shapeRedact), url)
})

test('redactDeep preserves frozen sparse arrays and unchanged property descriptors', () => {
  const array = new Array(6)
  array[3] = shapeSecret
  array.extra = { text: shapeSecret }
  const symbol = Symbol('metadata')
  array[symbol] = shapeSecret
  Object.freeze(array)
  const copy = redactDeep(array, shapeRedact)
  assert.ok(Array.isArray(copy))
  assert.equal(copy.length, 6)
  assert.deepEqual(Object.keys(copy), ['3', 'extra'])
  assert.equal(copy[3], shapeLabel)
  assert.equal(copy.extra.text, shapeLabel)
  assert.equal(copy[symbol], shapeSecret)
  for (const index of [0, 1, 2, 4, 5]) assert.equal(index in copy, false)
  assert.deepEqual(Object.getOwnPropertyDescriptor(copy, '3'), { value: shapeLabel, enumerable: true, configurable: false, writable: false })
  assert.deepEqual(Object.getOwnPropertyDescriptor(copy, 'length'), Object.getOwnPropertyDescriptor(array, 'length'))
  assert.equal(array[3], shapeSecret)
})

test('redactDeep keeps clean cycles and copies every dirty ancestor and shared alias', () => {
  const clean = { text: 'ordinary' }
  clean.self = clean
  assert.equal(redactDeep(clean, shapeRedact), clean)
  const a = { s: shapeSecret }, b = { a }
  a.b = b
  const shared = { a, clean }
  const root = { left: shared, right: shared, b }
  const copy = redactDeep(root, shapeRedact)
  assert.notEqual(copy, root)
  assert.equal(copy.left, copy.right)
  assert.equal(copy.left.a.b, copy.b)
  assert.equal(copy.b.a, copy.left.a)
  assert.equal(copy.b.a.s, shapeLabel)
  assert.equal(copy.left.clean, clean)
  assert.ok(!inspect(copy, { depth: null }).includes(shapeSecret))
  assert.equal(a.b, b)
  assert.equal(a.s, shapeSecret)
})

test('redactDeep reads accessors once and isolates throwing getters and inspection traps', () => {
  let reads = 0, failures = 0
  const input = {
    get secret() { reads++; return shapeSecret },
    get bad() { failures++; throw new Error('getter failed') },
    nested: { text: shapeSecret },
  }
  const copy = redactDeep(input, shapeRedact)
  assert.equal(reads, 1)
  assert.equal(failures, 1)
  assert.equal(copy.secret, shapeLabel)
  assert.equal(Object.getOwnPropertyDescriptor(copy, 'secret').get, undefined)
  assert.equal(Object.getOwnPropertyDescriptor(copy, 'bad').get, Object.getOwnPropertyDescriptor(input, 'bad').get)
  const throwTrap = () => { throw new Error('trap failed') }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const opaque of [
    new Proxy({}, { ownKeys: throwTrap }),
    new Proxy({}, { getPrototypeOf: throwTrap }),
    new Proxy({ text: shapeSecret }, { getOwnPropertyDescriptor: throwTrap }),
    revoked.proxy,
  ]) {
    assert.equal(redactDeep(opaque, shapeRedact), opaque)
    const result = redactDeep({ opaque, text: shapeSecret }, shapeRedact)
    assert.equal(result.opaque, opaque)
    assert.equal(result.text, shapeLabel)
  }
  const cleanGetter = { get text() { return 'ordinary' } }
  assert.equal(redactDeep(cleanGetter, shapeRedact), cleanGetter)
  // A failing redactor never hands the text back.
  assert.equal(redactDeep(shapeSecret, throwTrap), '[redacted: redaction failed]')
  // Keys go through the same redactor, so a failing one replaces the key as well.
  assert.deepEqual(Object.entries(redactDeep({ text: shapeSecret }, throwTrap)),
    [['[redacted: redaction failed]', '[redacted: redaction failed]']])
})

test('redactDeep leaves opaque built-ins and their subclasses by reference', () => {
  class SecretMap extends Map {}
  const key = {}
  for (const value of [
    new Map([[shapeSecret, shapeSecret]]), new SecretMap(), new Set([shapeSecret]),
    new WeakMap([[key, key]]), new WeakSet([key]), new Date(), /Fake-Secret/,
    Buffer.from(shapeSecret), new Uint8Array(4), new DataView(new ArrayBuffer(4)),
    new ArrayBuffer(4), new SharedArrayBuffer(4), Promise.resolve(shapeSecret),
    new String(shapeSecret), new Number(12), new Boolean(true), Object(12n), Object(Symbol()),
    new WeakRef(key), function result() {},
  ]) {
    value.text = shapeSecret
    assert.equal(redactDeep(value, shapeRedact), value)
  }
})

test('redactDeep walks 20000 levels without recursion or repeated redaction', () => {
  let root = { text: shapeSecret }
  for (let i = 0; i < 20000; i++) root = { next: root }
  let values = 0
  const copy = redactDeep(root, text => {
    if (text === shapeSecret) values++
    return shapeRedact(text)
  })
  assert.notEqual(copy, root)
  let leaf = copy
  for (let i = 0; i < 20000; i++) leaf = leaf.next
  assert.equal(leaf.text, shapeLabel)
  assert.equal(values, 1)
})

function secretForms(value) {
  const json = JSON.stringify(value).slice(1, -1)
  return [...new Set([value, json, json.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`), encodeURIComponent(value), encodeUrlComponent(value)])]
}

function hexCase(form, choose) {
  let out = ''
  for (let i = 0; i < form.length;) {
    let length = 0
    if (form[i] === '%' && /^[0-9a-fA-F]{2}$/.test(form.slice(i + 1, i + 3))) length = 3
    if (form[i] === '\\' && form[i + 1] === 'u' && /^[0-9a-fA-F]{4}$/.test(form.slice(i + 2, i + 6))) length = 6
    if (length) {
      out += form.slice(i, i + length).replace(/[a-fA-F]/g, c => choose() ? c.toUpperCase() : c.toLowerCase())
      i += length
    } else if (form.slice(i, i + 2) === '\\\\') {
      out += '\\\\'
      i += 2
    } else out += form[i++]
  }
  return out
}

test('redactor covers raw, JSON, ASCII JSON and both URL forms with mixed hex case', () => {
  const value = 'Fake-Secret/Value+1 é Ω 😀 ! ( ) * space % \' " \\ quote'
  const redact = redactor([{ name: 'ENCODING', value }])
  for (const form of secretForms(value)) {
    let alternate = false
    for (const choose of [() => true, () => false, () => (alternate = !alternate)]) {
      const encoded = hexCase(form, choose)
      assert.equal(redact(encoded), '[secret:ENCODING]', encoded)
      assert.equal(redact(`before ${encoded} after`), 'before [secret:ENCODING] after')
    }
  }
  // Escaped backslashes make this literal backslash-u text, whose letters retain case.
  const literal = String.raw`Fake-Literal\\u00e9-finish`
  const literalRedact = redactor([{ name: 'LITERAL', value: literal }])
  assert.equal(literalRedact(literal), '[secret:LITERAL]')
  assert.equal(literalRedact(`before ${literal.replace('00e9', '00E9')} after`), `before ${literal.replace('00e9', '00E9')} after`)
  assert.equal(literalRedact(JSON.stringify(literal).slice(1, -1)), '[secret:LITERAL]')
  for (const ordinary of ['ordinary text', `before ${value.replace('Value', 'value')} after`, `before ${value.replace('Value', 'Vxlue')} after`]) {
    assert.equal(redact(ordinary), ordinary)
  }
})

test('redactor encoding forms satisfy deterministic property cases', () => {
  let seed = 1201
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const pool = [...'aBcD019 !\'()*%"\\/+éΩ中😀\t']
  for (let i = 0; i < 200; i++) {
    const value = `Fake${i}-` + Array.from({ length: 20 }, () => pool[random() % pool.length]).join('') + '-End'
    const redact = redactor([{ name: 'PROPERTY', value }])
    for (const form of secretForms(value)) {
      for (const choose of [() => true, () => false, () => !!(random() & 0x10000)]) {
        assert.equal(redact(hexCase(form, choose)), '[secret:PROPERTY]', `case ${i}: ${form}`)
      }
      const near = `context ${form.replace('Fake', 'Faxe')} context`
      assert.equal(redact(near), near)
      const changedCase = `context ${form.replace('Fake', 'fake')} context`
      assert.equal(redact(changedCase), changedCase)
    }
  }
})

function dshTail(text) {
  const bytes = Buffer.from(text)
  let start = Math.max(0, bytes.length - 64000)
  while ((bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

test('redactor removes secret pieces at DSH tail and head cut edges', () => {
  assert.equal(EDGE_MIN, 12)
  const value = 'Fake-Cut-Secret-0123456789-abcdefghijklmnop-é'
  const redact = redactor([{ name: 'CUT', value }])
  const label = '[secret:CUT]'
  for (const form of secretForms(value)) {
    const piece = form.slice(-20)
    const filler = '\n' + 'z'.repeat(64000 - Buffer.byteLength(piece) - 1)
    const output = 'discarded'.repeat(10000) + form + filler
    const tail = dshTail(output)
    assert.ok(tail.startsWith(piece))
    for (const prefix of ['', '[stderr]\n']) {
      const rendered = `${prefix}${tail}\n[output truncated; full output: /tmp/x]`
      const result = redact(rendered)
      assert.equal(result, `${prefix}${label}${filler}\n[output truncated; full output: /tmp/x]`)
      for (let length = EDGE_MIN; length < piece.length; length++) assert.ok(!result.includes(piece.slice(-length)))
    }
    // `cut` serves a stream text known to be cut; plain text has no cut edge.
    assert.equal(redact.cut(`header\n${form.slice(0, 20)}`), `header\n${label}`)
    assert.equal(redact(`header\n${form.slice(0, 20)}`), `header\n${form.slice(0, 20)}`)
    assert.equal(redact(form.slice(-20)), form.slice(-20))
    assert.equal(redact.cut(`${form.slice(-7)}\n`), `${form.slice(-7)}\n`)
    assert.equal(redact.cut(`header\n${form.slice(0, 7)}`), `header\n${form.slice(0, 7)}`)
    assert.equal(redact.cut(`${form.slice(-11)}\n`), `${form.slice(-11)}\n`)
    assert.equal(redact.cut(`${form.slice(-12)}\n`), `${label}\n`)
    assert.equal(redact(`header ${form.slice(0, 20)}\n[output truncated; full output: /tmp/x]`),
      `header ${label}\n[output truncated; full output: /tmp/x]`)
    // A piece away from a cut edge is ordinary text: a later line, or before a later line.
    assert.equal(redact.cut(`header\n${form.slice(-20)}\nmore`), `header\n${form.slice(-20)}\nmore`)
    assert.equal(redact.cut(`${form.slice(0, 20)}\nmore`), `${form.slice(0, 20)}\nmore`)
  }
  assert.equal(redact('ordinary-start\nordinary-end'), 'ordinary-start\nordinary-end')
  assert.equal(redact(`context ${value.slice(-20)} context`), `context ${value.slice(-20)} context`)
  assert.equal(redact.cut(value.slice(-30)), label, 'the longest eligible piece wins')
  const short = redactor([{ name: 'SHORT', value: 'éééé' }])
  const encodedPiece = encodeURIComponent('éééé').slice(6)
  assert.equal(short(encodedPiece), encodedPiece, 'short original values do not qualify through encoding expansion')
  const labels = redactor([{ name: 'CUT', value }, { name: 'OTHER', value: 'prefix[secret:CUT]' }])
  assert.equal(labels(value), label, 'the edge pass leaves a freshly written label intact')
  assert.equal(labels(label), label, 'the edge pass leaves an existing label intact')
})

test('cut pieces and Error details are redacted through the real tool-result hook', async (t) => {
  const bench = start()
  t.after(bench.stop)
  const value = 'Fake-Hook-Secret-0123456789-abcdefghijklmnop-é'
  await bench.call('secret-set', { name: 'CUT', value })
  const piece = value.slice(-20)
  const filler = '\n' + 'z'.repeat(64000 - Buffer.byteLength(piece) - 1)
  const rendered = `[stderr]\n${dshTail('discard'.repeat(10000) + value + filler)}\n[output truncated; full output: /tmp/x]`
  const original = { isError: true, error: new Error(value, { cause: new Error(value) }), content: [{ type: 'text', text: rendered }] }
  const execute = bench.listeners['tools/execute'].at(-1)
  const result = await execute({}, async () => original)
  assert.equal(result.content[0].text, `[stderr]\n[secret:CUT]${filler}\n[output truncated; full output: /tmp/x]`)
  assert.ok(result.error instanceof Error)
  assert.equal(result.error.message, '[secret:CUT]')
  assert.equal(result.error.cause.message, '[secret:CUT]')
  assert.equal(original.error.message, value)
  assert.equal(original.content[0].text, rendered)
})

test('redactor handles a megabyte and fifty secrets within the scan budget', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({ name: `PERF_${i}`, value: `Fake-${String(i).padStart(2, '0')}-${'q'.repeat(56)}` }))
  assert.ok(entries.every(entry => entry.value.length === 64))
  const redact = redactor(entries)
  const text = 'ordinary-output '.repeat(Math.ceil(1024 * 1024 / 16))
  const start = performance.now()
  assert.equal(redact(text), text)
  const elapsed = performance.now() - start
  assert.ok(elapsed < 500, `no-match scan took ${elapsed.toFixed(1)}ms`)
  const matched = text + '\n' + entries.map(entry => entry.value).join('\n')
  assert.equal(redact(matched), text + '\n' + entries.map(entry => `[secret:${entry.name}]`).join('\n'))
})

test('redactDeep materializes clean getters only when copying and retains hidden properties', () => {
  let reads = 0
  const shared = {
    get clean() { reads++; return 'ordinary' },
    secret: shapeSecret,
  }
  const hidden = { text: shapeSecret }
  Object.defineProperty(shared, 'hidden', { value: hidden })
  const result = redactDeep({ first: shared, second: shared }, shapeRedact)
  assert.equal(reads, 1)
  assert.equal(result.first, result.second)
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.first, 'clean'), { value: 'ordinary', writable: true, enumerable: true, configurable: true })
  assert.equal(result.first.hidden, hidden)
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.first, 'hidden'), Object.getOwnPropertyDescriptor(shared, 'hidden'))
  const cleanError = new Error('ordinary')
  assert.equal(redactDeep(cleanError, shapeRedact), cleanError)
})

test('redactDeep preserves both secret keys that redact to the same label', () => {
  const other = 'Fake-Other-Secret/2'
  const redact = redactor([{ name: 'SHAPE', value: shapeSecret }, { name: 'SHAPE', value: other }])
  const original = { [shapeSecret]: 1, [other]: 2 }
  const result = redactDeep(original, redact)
  assert.deepEqual(result, { [shapeLabel]: 1, [`${shapeLabel}#2`]: 2 })
  assert.deepEqual(Object.keys(original), [shapeSecret, other])
})

test('redactor handles a DSH tail cut inside a UTF-8 character', () => {
  const value = 'Fake-UTF8-é0123456789abcdef'
  const piece = '0123456789abcdef'
  // The byte cutoff lands on the continuation byte of é; DSH advances past it.
  const filler = '\n' + 'z'.repeat(64000 - piece.length - 2)
  const tail = dshTail('discard'.repeat(10000) + value + filler)
  assert.equal(tail, piece + filler)
  const redact = redactor([{ name: 'UTF8', value }])
  assert.equal(redact.cut(tail), '[secret:UTF8]' + filler)
  // DSH's bash collector decodes the byte-exact tail, so the cut byte reads as U+FFFD.
  const bytes = Buffer.from('discard'.repeat(10000) + value + filler)
  const decoded = bytes.subarray(bytes.length - 64000).toString('utf8')
  assert.equal(decoded, '\uFFFD' + piece + filler)
  for (const prefix of ['', '[stderr]\n']) {
    assert.equal(redact(`${prefix}${decoded}\n[output truncated; full output: /tmp/x]`),
      `${prefix}\uFFFD[secret:UTF8]${filler}\n[output truncated; full output: /tmp/x]`)
  }
})

test('encoded short values keep the original whole-value policy', () => {
  const value = 'é!é!'
  for (const form of secretForms(value)) {
    const redact = redactor([{ name: 'SHORT', value }])
    assert.equal(redact(form), '[secret:SHORT]')
    assert.equal(redact(`x${form}y`), `x${form}y`)
    assert.equal(redactor([{ name: 'SHORT', value }], { wholeWords: false })(`x${form}y`), 'x[secret:SHORT]y')
  }
})

test('redactDeep keeps array indices and serves a cut DSH stream text as cut', () => {
  const redact = redactor([{ name: 'PIN', value: '4821' }, { name: 'CUT', value: 'Fake-Stream-Secret-0123456789' }])
  const rows = Array.from({ length: 5000 }, (_, i) => i === 10 ? 'pin 4821' : i)
  const result = redactDeep(rows, redact)
  assert.equal(result.length, 5000)
  assert.equal(result[4821], 4821)
  assert.equal(result[10], 'pin [secret:PIN]')
  assert.equal(Object.keys(result).length, 5000)
  const piece = 'Secret-0123456789'
  const stream = { stdout: { text: `${piece}\nrest`, truncated: true }, other: { text: `${piece}\nrest`, truncated: false } }
  const out = redactDeep(stream, redact)
  assert.equal(out.stdout.text, '[secret:CUT]\nrest')
  assert.equal(out.other, stream.other, 'an uncut text keeps its edges')
})

test('redactor matches a cut piece of a secret that holds another secret', () => {
  const redact = redactor([
    { name: 'DB_PASSWORD', value: 'Fake-Password-1' },
    { name: 'DB_URL', value: 'postgres://admin:Fake-Password-1@db.internal.example:5432/app' },
  ])
  const text = 'min:Fake-Password-1@db.internal.example:5432/app\n[output truncated; full output: /tmp/x]'
  assert.equal(redact(text), '[secret:DB_URL]\n[output truncated; full output: /tmp/x]')
})

test('redactor finds a cut edge for a secret with an astral character', () => {
  const value = 'abcdefghij-0123456789-zz😀ABCDEFGHIJK'
  const redact = redactor([{ name: 'EMOJI', value }])
  assert.equal(redact.cut('zz😀ABCDEFGHIJK\nrest'), '[secret:EMOJI]\nrest')
})

test('cut pieces never take a whole secret apart and honour hex case', () => {
  const notice = '\n[output truncated; full output: /tmp/x]'
  const whole = redactor([
    { name: 'A', value: 'abcdefghijklMNOPQRSTUVWXYZ0123456789' },
    { name: 'B', value: 'foreign-prefix-abcdefghijkl' },
  ])
  assert.equal(whole(`abcdefghijklMNOPQRSTUVWXYZ0123456789\nrest${notice}`), `[secret:A]\nrest${notice}`)
  const hex = redactor([{ name: 'HEX', value: 'Prefix-Secret-Value-éééé' }])
  assert.equal(hex.cut('%c3%a9%c3%a9%c3%a9\nrest'), '[secret:HEX]\nrest')
  assert.equal(hex.cut('%C3%a9%c3%A9%C3%A9\nrest'), '[secret:HEX]\nrest')
  assert.equal(hex.cut('\\u00E9\\u00e9\\u00E9\nrest'), '[secret:HEX]\nrest')
})

test('an escaped backslash before u is literal text, not a Unicode escape', () => {
  const redact = redactor([{ name: 'S', value: 'éabcdefgh' }])
  assert.equal(redact('\\u00E9abcdefgh'), '[secret:S]')
  assert.equal(redact(String.raw`\\u00E9abcdefgh`), String.raw`\\u00E9abcdefgh`)
  assert.equal(redact('\\\\\\u00e9abcdefgh'), '\\\\[secret:S]')
})

test('a long secret does not break redaction of text that does not hold it', () => {
  const redact = redactor([{ name: 'LONG', value: 'é'.repeat(8192) }, { name: 'KEY', value: 'Fake-Key-0123456789' }])
  assert.equal(redact('ordinary'), 'ordinary')
  assert.equal(redact(`ordinary${notice()}`), `ordinary${notice()}`)
  function notice() { return '\n[output truncated; full output: /tmp/x]' }
})

test('redactDeep keeps Error-ness, index range, Array subclasses and NaN identity', () => {
  const redact = redactor([{ name: 'S', value: 'Fake-Secret-0123456789' }, { name: 'MAX', value: '4294967295' }])
  const bare = new Error('Fake-Secret-0123456789')
  Object.setPrototypeOf(bare, null)
  const copy = redactDeep(bare, redact)
  assert.notEqual(copy, bare)
  assert.equal(Object.getPrototypeOf(copy), null)
  assert.equal(copy.message, '[secret:S]')
  assert.ok(!String(copy.stack).includes('Fake-Secret-0123456789'))
  const array = []
  array['4294967295'] = 'ordinary'
  assert.deepEqual(Object.keys(redactDeep(array, redact)), ['[secret:MAX]'])
  class Rows extends Array { last() { return this.at(-1) } }
  const rows = Rows.from(['Fake-Secret-0123456789'])
  const out = redactDeep(rows, redact)
  assert.ok(out instanceof Rows)
  assert.equal(out.last(), '[secret:S]')
  class Result { value = NaN }
  const clean = { result: new Result() }
  assert.equal(redactDeep(clean, redact), clean)
})

test('cut-edge search stays linear for a repetitive secret', () => {
  const redact = redactor([{ name: 'REP', value: 'a'.repeat(16383) + 'b' }])
  const text = ('a'.repeat(16383) + 'c\n[output truncated]').repeat(16)
  const started = performance.now()
  assert.equal(redact(text), text)
  assert.ok(performance.now() - started < 1000, `took ${performance.now() - started} ms`)
})

test('round-two shapes: boundary hex, hidden indices, token cuts, markers, unions, parity', () => {
  const notice = '\n[output truncated]'
  const e9 = redactor([{ name: 'S', value: 'E9-Secret-0123456789' }])
  assert.equal(e9('%E9-Secret-0123456789'), '%[secret:S]')
  const r = redactor([{ name: 'S', value: 'Fake-Secret-0123456789' }])
  const hidden = []
  Object.defineProperty(hidden, '0', { value: 'Fake-Secret-0123456789', enumerable: false })
  assert.ok(!JSON.stringify(redactDeep(hidden, r)).includes('Fake-Secret'))
  const token = redactor([{ name: 'S', value: 'Prefix-Secret-é-abcdefghijklmnop' }])
  assert.equal(token.cut('C3%A9-abcdefghijklmnop\nrest'), '[secret:S]\nrest')
  assert.equal(token.cut('header\nPrefix-Secret-%C3%A'), 'header\n[secret:S]')
  const many = redactor([{ name: 'S', value: 'prefix-abcdefghijklmnop' }])
  assert.equal(many('[stderr]\nordinary\n'.repeat(9) + `[stderr]\nabcdefghijklmnop\nrest${notice}`),
    '[stderr]\nordinary\n'.repeat(9) + `[stderr]\n[secret:S]\nrest${notice}`)
  const union = redactor([
    { name: 'A', value: 'prefix-abcdefghijklmnopqrstuvwxyz0123456789WXYZ' },
    { name: 'B', value: 'WXYZ-OTHER-SECRET-VALUE' },
  ])
  assert.equal(union.cut('abcdefghijklmnopqrstuvwxyz0123456789WXYZ-OTHER-SECRET-VALUE\nrest'), '[secret:A][secret:B]\nrest')
  const parity = redactor([{ name: 'S', value: 'éabcdefgh-long-tail' }])
  assert.equal(parity.cut('literal \\\\u00e9abcdefgh'), 'literal \\\\u00e9abcdefgh')
  const pin = redactor([{ name: 'PIN', value: '4821' }, { name: 'LONG', value: 'abcdefghijklmnop-secret-tail' }])
  assert.equal(pin.cut('order 4821abcdefghijklmnop'), 'order 4821[secret:LONG]')
  const map = new Map()
  map.text = 'Fake-Secret-0123456789'
  Object.setPrototypeOf(map, null)
  assert.equal(redactDeep(map, r), map)
})

test('a pattern too large for the engine still redacts and never throws', () => {
  const r = redactor([{ name: 'LONG', value: 'é'.repeat(8192) }, { name: 'SMALL', value: 'Fake-Key-0123456789' }])
  assert.equal(r('key Fake-Key-0123456789'), 'key [secret:SMALL]')
  assert.equal(r(`x ${'é'.repeat(8192)} y`), 'x [secret:LONG] y')
})

test('a backslash run before a secret stays linear', () => {
  const value = '\\'.repeat(12) + 'Secret-0123456789'
  const r = redactor([{ name: 'S', value }])
  const text = '\\'.repeat(128000) + ' x ' + value
  const started = performance.now()
  assert.equal(r(text), '\\'.repeat(128000) + ' x [secret:S]')
  assert.ok(performance.now() - started < 1000)
})

test('round-three shapes: hidden inner secret, fallback hex case, raw backslash, caching getter, folding', () => {
  const S = 'Fake-Secret-0123456789'
  const inner = redactor([{ name: 'A', value: 'éabcdefghFake-Key-0123456789' }, { name: 'B', value: 'Fake-Key-0123456789' }])
  assert.equal(inner(String.raw`literal \\u00e9abcdefghFake-Key-0123456789`), String.raw`literal \\u00e9abcdefgh[secret:B]`)
  const huge = redactor([{ name: 'L', value: 'é'.repeat(8192) }])
  assert.equal(huge('%c3%a9'.repeat(8192)), '[secret:L]')
  assert.equal(huge('\\u00E9'.repeat(8192)), '[secret:L]')
  const rawValue = String.raw`\private\Fake-Secret-0123456789`
  assert.equal(redactor([{ name: 'S', value: rawValue }])('\\' + rawValue), '\\[secret:S]')
  const r = redactor([{ name: 'S', value: S }])
  const input = { get text() { return this.cached ??= S } }
  assert.ok(!JSON.stringify(redactDeep(input, r)).includes(S))
  assert.equal(redactor([{ name: 'S', value: 'Build-completed-é-secret' }])('build-completed\n[output truncated]'),
    'build-completed\n[output truncated]')
})

test('many whole matches stay linear', () => {
  const S = 'Fake-Secret-0123456789'
  const r = redactor([{ name: 'S', value: S }])
  const started = performance.now()
  assert.equal(r((S + ' ').repeat(64000)), '[secret:S] '.repeat(64000))
  assert.ok(performance.now() - started < 1500)
})

test('round-four cut edges: case-twin secrets, raw backslash prefix, shorter exact border', () => {
  const twins = redactor([{ name: 'A', value: 'ABCDEF0123456789/secret-one' }, { name: 'B', value: 'abcdef0123456789/secret-one' }])
  assert.equal(twins.cut('header ABCDEF0123456789%2Fsecret'), 'header [secret:A]')
  const value = String.raw`\private\Fake-Secret-0123456789`
  assert.equal(redactor([{ name: 'S', value }]).cut('header \\' + value.slice(0, -4)), 'header \\[secret:S]')
  const border = redactor([{ name: 'S', value: 'ABCDEF/123456ABCDEF/123456tail' }])
  assert.equal(border.cut('header abcdef%2F123456ABCDEF%2F123456'), 'header abcdef%2F123456[secret:S]')
})
