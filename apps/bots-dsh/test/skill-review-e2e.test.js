import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createGate } from '../../../server/gate.mjs'
import { COOKIE, createOwner, principalOf, SessionStore } from '../../../server/gate-store.mjs'
import { apply } from '../index.js'
import { call as clientCall } from '../src/client/api.js'
import { teamActions } from '../src/client/team-actions.js'
import { SKILL_CHECK_HISTORY } from '../src/host/skill-check-version.js'
import { skillHash, textSkillMd } from '../src/host/skill-library-rules.js'
import { CLEAN_REVIEW } from './fixtures/skill-review-model.js'

const botId = 'b-aaaaaaaaaa'
const sessionId = 'fixture-review-chat'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const backgroundModel = `${route.provider}/${route.model}`
const skill = (name, content = 'Write a short fixture note.') => ({ name, description: 'A fixture note.', content })
const file = (name, content) => ({ name, description: 'A fixture note.', source: 'file', fileName: name + '.md',
  fileBytes: textSkillMd(skill(name, content)).toString('base64') })
const finding = area => ({ area, file: 'SKILL.md', line: 5, severity: 'medium', reason: 'Synthetic reviewer finding.' })
const reply = (...findings) => JSON.stringify({ findings, overflow: false })

async function setup(t, script) {
  const home = mkdtempSync(join(tmpdir(), 'skill-review-e2e-'))
  const root = new Context()
  t.after(async () => {
    try { await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [botId],
    bots: { [botId]: { id: botId, sessionId, name: 'Fixture Bot', createdAt: 1, role: 'Helper',
      model: backgroundModel, appliedModel: backgroundModel } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: { backgroundModel },
  }))

  const reviews = []
  const turns = []
  class FakeModel extends LlmAdapter {
    async listModels(provider) {
      return [await this.resolveModel(provider, route.model)]
    }
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }
    async *stream(request) {
      const { provider, model, messages, tools, system, sessionId, purpose } = request
      let text = 'Fixture turn.'
      if (system?.startsWith('Review the supplied skill')) {
        assert.deepEqual({ provider, model }, route)
        assert.deepEqual(tools, [])
        assert.equal(sessionId, undefined)
        assert.equal(purpose, 'compaction')
        const wire = JSON.parse(JSON.stringify({ system, messages }))
        const frame = wire.messages[0].content[0].text
        const name = /^skill (.+)$/m.exec(frame)[1]
        reviews.push({ name, frame, at: Date.now() })
        text = await script(name, reviews)
      } else {
        turns.push(JSON.stringify(messages))
      }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.llm.registerAdapter([route.provider], new FakeModel())
  const harness = await mountAgentLoopTestHarness(root)
  const routes = new Map()
  root.provide('connection', { fetch: { register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } } })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'fixture-workspace', path }) })
  root.provide('sessionTitle', { rename: async () => {} })
  root.provide('sessionController', {
    resolveAgent: async id => ({ agent: root.agents.get(id) }),
    async prompt({ sessionId, requestId, content }) {
      root.agents.get(sessionId).followup(createUserMessage({ content, source: { kind: 'user', requestId } }))
    },
    async page({ address }) {
      const records = (root.agents.get(address.sessionId)?.session.snapshotEvents() ?? []).map(event => ({ event }))
      return { records, hasMore: false }
    },
  })
  apply(root, { home, github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  const rt = root.get('omniTeam')
  const dispatch = async (body, headers) => routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui',
    { method: 'POST', headers, body }))
  const post = async (endpoint, payload = {}) => (await dispatch(JSON.stringify({ endpoint, payload }))).json()
  const owner = async (endpoint, payload) => {
    const result = await post(endpoint, payload)
    assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result)}`)
    return result.value
  }
  return { rt, home, owner, post, reviews, turns, dispatch, createChat: () => harness.create(sessionId, route, { cwd: home }) }
}

test('A–E: reviewed saves, refusals and retries reach the existing activation and chat paths', { timeout: 15_000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request') })
  const f = await setup(t, (name, calls) => {
    if (name === 'reviewed-notes') return reply(finding('other'))
    if (name === 'model-block') return reply(finding('prompt-injection'))
    if (name === 'retry-notes' && calls.filter(call => call.name === name).length === 1) return 'Synthetic malformed response.'
    return CLEAN_REVIEW
  })
  const agent = await f.createChat()
  async function turn(name) {
    const from = f.turns.length
    assert.equal(await f.owner('send', { sessionId: botId, text: '/' + name }), true)
    await agent.whenIdle()
    await setImmediate()
    const chat = await f.owner('chat', { botId })
    return { messages: f.turns.slice(from).join('\n'), chat: JSON.stringify(chat.items) }
  }

  // A. An approved, activated file skill reaches the real Bot turn once.
  const aBody = 'Explain sudo with marker FLOW-A-BODY.'
  const a = file('reviewed-notes', aBody)
  const aFirst = await f.owner('skill-library-save', a)
  assert.match(aFirst.needsConfirm, /^[a-f0-9]{64}$/)
  assert.deepEqual(aFirst.findings.map(row => row.rule ?? row.area), ['sudo', 'other'])
  assert.deepEqual(await f.owner('skill-library-save', { ...a, confirm: aFirst.needsConfirm }), { saved: true })
  assert.deepEqual(await f.owner('bot-skill-add', { id: botId, name: a.name }), { saved: true })
  assert.ok((await turn(a.name)).messages.includes(aBody))
  assert.equal(f.reviews.filter(call => call.name === a.name).length, 1)

  // B. A mismatched frontmatter name is a safe deterministic block fixture.
  const b = { ...file('other-name'), name: 'gate-block' }
  const blocked = await f.owner('skill-library-save', b)
  assert.equal(blocked.refused, true)
  assert.match(blocked.message, /name in SKILL.md/)
  assert.equal(f.reviews.filter(call => call.name === b.name).length, 0)
  assert.ok(!(await f.owner('skill-library')).skills.some(row => row.name === b.name))

  // C. A failed review never delivers. A fresh attempt can succeed and ask.
  const cBody = 'Explain sudo with marker FLOW-C-BODY.'
  const c = file('retry-notes', cBody)
  assert.equal((await f.owner('skill-library-save', c)).review?.why, 'malformed')
  const cTurn = await turn(c.name)
  assert.match(cTurn.chat, /is not active/)
  assert.ok(!cTurn.messages.includes(cBody))
  const retried = await f.owner('skill-library-save', c)
  assert.match(retried.needsConfirm, /^[a-f0-9]{64}$/)
  assert.equal(f.reviews.filter(call => call.name === c.name).length, 2)

  // D. An injection finding refuses even when given a receipt from a different review.
  const dBody = 'Synthetic model classification fixture FLOW-D-BODY.'
  const d = file('model-block', dBody)
  for (const confirm of [undefined, retried.needsConfirm]) {
    const blocked = await f.owner('skill-library-save', { ...d, confirm })
    assert.equal(blocked.refused, true)
    assert.match(blocked.message, /prompt injection/)
    assert.equal(blocked.needsConfirm, undefined)
    assert.equal(blocked.findings[0].injection, true)
  }
  const dTurn = await turn(d.name)
  assert.match(dTurn.chat, /is not active/)
  assert.ok(!dTurn.messages.includes(dBody))
  assert.equal(f.reviews.filter(call => call.name === d.name).length, 1)

  // E. A clean model response still leaves deterministic findings to confirm.
  const eBody = 'Explain sudo with marker FLOW-E-BODY.'
  const e = skill('typed-review', eBody)
  const eFirst = await f.owner('skill-library-save', e)
  assert.match(eFirst.needsConfirm, /^[a-f0-9]{64}$/)
  assert.deepEqual(eFirst.findings.map(row => row.rule), ['sudo'])
  assert.deepEqual(await f.owner('skill-library-save', { ...e, confirm: eFirst.needsConfirm }), { saved: true })
  await f.owner('bot-skill-add', { id: botId, name: e.name })
  assert.ok((await turn(e.name)).messages.includes(eBody))
  assert.equal(f.reviews.filter(call => call.name === e.name).length, 1)
  assert.deepEqual(await f.owner('skill-library-save', skill('clean-typed')), { saved: true })
  assert.equal(f.reviews.filter(call => call.name === 'clean-typed').length, 1)
})

const host = '127.0.0.1'
async function listen(server) {
  server.listen(0, host)
  await once(server, 'listening')
  return server.address().port
}
const request = (port, headers, options) => new Promise((resolve, reject) => {
  const req = http.request({ hostname: host, port, path: '/api/omni-ui', method: 'POST',
    headers: { ...options.headers, ...headers, 'content-length': Buffer.byteLength(options.body) }, agent: false }, async res => {
    const rows = []
    for await (const row of res) rows.push(row)
    resolve(new Response(Buffer.concat(rows), { status: res.statusCode }))
  })
  req.on('error', reject)
  req.end(options.body)
})

test('a slow Save and held re-accept cross the gate, resume after a lost response and write once', { timeout: 15_000 }, async t => {
  const work = new Map()
  let then = Date.now()
  t.mock.method(Date, 'now', () => then)
  const f = await setup(t, name => work.get(name).promise)
  const origin = 'https://skills-fixture.invalid'
  const dir = join(f.home, 'gate-fixture')
  const sessions = new SessionStore(dir)
  const issued = sessions.issue(origin, principalOf(createOwner(dir)))
  const requests = []
  const upstream = http.createServer(async (req, res) => {
    const rows = []
    for await (const row of req) rows.push(row)
    const body = Buffer.concat(rows).toString()
    const { payload } = JSON.parse(body)
    requests.push(payload)
    const result = await f.dispatch(body, req.headers)
    res.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text())
  })
  const upstreamPort = await listen(upstream)
  const credentials = { port: upstreamPort, authority: `${host}:${upstreamPort}`, cookie: async () => 'fixture=synthetic' }
  const gate = createGate({ origin, sessions, credentials })
  const gatePort = await listen(gate)
  t.after(async () => {
    await gate.closeGate()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  })
  const originalRequest = http.request
  const timeout = []
  t.mock.method(http, 'request', (options, callback) => {
    if (options.port === upstreamPort) timeout.push(options.timeout)
    return originalRequest(options, callback)
  })
  let drop = false
  const headers = { origin, host: new URL(origin).host, cookie: `${COOKIE}=${issued.secret}` }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'api/omni-ui')
    const response = await request(gatePort, headers, options)
    if (drop) { drop = false; throw new Error('Fixture disconnected after the gate forwarded the request') }
    return response
  })
  const actions = teamActions({ call: clientCall, after: value => value })
  const path = join(f.home, 'skill-library', 'library.json')
  const read = () => JSON.parse(readFileSync(path, 'utf8'))
  const stored = { ...skill('legacy-notes'), source: { kind: 'text' },
    check: { version: 2, fingerprint: SKILL_CHECK_HISTORY[2], verdict: 'pass' } }
  stored.hash = skillHash([{ path: 'SKILL.md', bytes: textSkillMd(stored) }])
  mkdirSync(join(f.home, 'skill-library'), { mode: 0o700 })
  writeFileSync(path, JSON.stringify({ version: 1, skills: { [stored.name]: stored }, active: { [botId]: [stored.name] } }), { mode: 0o600 })

  for (const [input, initial] of [[skill('slow-notes'), undefined],
    [{ name: stored.name, edit: true, reviewHash: stored.hash }, stored]]) {
    const pending = Promise.withResolvers()
    work.set(input.name, pending)
    drop = true
    await assert.rejects(actions.saveSkill(input), { code: 'NETWORK' })
    const first = requests.at(-1)
    assert.match(first.operation, /^[a-f0-9]{32}$/)
    assert.deepEqual(read().skills[input.name], initial)
    for (let i = 0; i < 100 && !f.reviews.some(call => call.name === input.name); i++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.equal(f.reviews.find(call => call.name === input.name)?.at, then)
    then += 90_000
    const resumed = actions.saveSkill(input)
    for (let i = 0; i < 100 && requests.at(-1) === first; i++) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(requests.at(-1).operation, first.operation)
    pending.resolve(CLEAN_REVIEW)
    assert.deepEqual(await resumed, { saved: true })
    assert.equal(f.reviews.filter(call => call.name === input.name).length, 1)
    assert.equal(read().skills[input.name].review.status, 'done')
    assert.deepEqual(await clientCall('skill-library-save', { operation: first.operation, poll: true }), { saved: true })
    assert.deepEqual(await clientCall('skill-library-save', first), { saved: true })
    const audit = readFileSync(join(f.home, 'skill-library', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(audit.filter(row => row.target === input.name && row.outcome === 'allowed').length, 1)

    await assert.rejects(f.rt.skillLibrary.endpoint('skill-library-save', { operation: first.operation, poll: true },
      { id: 'other-owner', role: 'owner' }), { code: 'bot/not-found' })
  }
  assert.ok(timeout.length >= 8 && timeout.every(ms => ms === 30_000))
  assert.deepEqual(f.rt.skillLibrary.active(botId).map(row => row.name), [stored.name])
})
