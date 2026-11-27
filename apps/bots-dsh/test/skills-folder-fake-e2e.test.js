import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createGate } from '../../../server/gate.mjs'
import { COOKIE, SessionStore } from '../../../server/gate-store.mjs'
import { apply } from '../index.js'
import { call as clientCall } from '../src/client/api.js'
import { teamActions } from '../src/client/team-actions.js'
import { textSkillMd } from '../src/host/skill-library-rules.js'
import { serviceStub } from './caller-fixture.js'
import { zip } from './fixtures/skill-archives.js'
import { CLEAN_REVIEW } from './fixtures/skill-review-model.js'

const botId = 'b-aaaaaaaaaa'
const sessionId = 'fixture-tree-chat'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const backgroundModel = `${route.provider}/${route.model}`
const reply = (file, severity, area = 'other') => JSON.stringify({
  findings: [{ file, severity, area, line: 1, reason: 'Synthetic reviewer finding.' }], overflow: false,
})
const doc = (name, content = 'Write a fixture note.') => textSkillMd({ name, description: 'A fixture note.', content })
const archive = (members, target) => ({
  preview: true, source: 'archive', fileName: 'fixture.zip', fileBytes: zip(members).toString('base64'),
  ...(target ? { edit: true, name: target } : {}),
})

async function setup(t, script, { gated = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'skill-tree-e2e-'))
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
        const path = / chunk .* path=([^\n]+)\n/.exec(frame)?.[1]
        reviews.push({ name, path, frame })
        text = await script(name, path, reviews)
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
  if (gated) root.provide('automagikCaller', serviceStub())
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

test('#2078 harmless fake-model folder, archive, refusal and replace reach Bot delivery', {
  timeout: 25_000, skip: process.platform !== 'linux',
}, async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected external request') })
  const f = await setup(t, (name, path, calls) => {
    if (name === 'injection-notes' && path === 'references/guide.md') return reply(path, 'low', 'prompt-injection')
    if (name === 'retry-notes' && calls.filter(call => call.name === name).length === 1) return 'Synthetic malformed reply.'
    if (path === 'scripts/run.sh') return reply(path, 'medium')
    if (path === 'scripts/new.sh') return reply(path, 'low')
    return CLEAN_REVIEW
  })
  const agent = await f.createChat()
  const turn = async name => {
    const from = f.turns.length
    assert.equal(await f.owner('send', { sessionId: botId, text: '/' + name }), true)
    await agent.whenIdle()
    await setImmediate()
    const requests = f.turns.slice(from)
    const lastUser = requests.at(-1) && JSON.parse(requests.at(-1)).findLast(message => message.role === 'user')
    return { messages: requests.join('\n'), lastUser: JSON.stringify(lastUser),
      chat: JSON.stringify((await f.owner('chat', { botId })).items) }
  }
  const store = join(f.home, 'skill-library')
  const saved = join(store, 'library.json')
  const path = join(f.home, 'selected-skill')
  const sentinel = join(f.home, 'never-created')
  const script = `#!/bin/bash\ntouch '${sentinel}'\n`
  mkdirSync(path)
  mkdirSync(join(path, 'scripts'))
  mkdirSync(join(path, 'references'))
  writeFileSync(join(path, 'SKILL.md'), doc('folder-notes', 'Write FOLDER-BODY-17.'))
  writeFileSync(join(path, 'scripts', 'run.sh'), script, { mode: 0o755 })
  writeFileSync(join(path, 'references', 'guide.md'), 'REF-BODY-29')
  const first = { preview: true, source: 'folder', path }
  const second = archive([
    { path: 'notes/SKILL.md', data: doc('archive-notes', 'Write ARCHIVE-BODY-18.') },
    { path: 'notes/scripts/run.sh', data: script },
    { path: 'notes/references/guide.md', data: 'REF-BODY-29' },
  ])
  for (const [input, name, marker] of [[first, 'folder-notes', 'FOLDER-BODY-17'], [second, 'archive-notes', 'ARCHIVE-BODY-18']]) {
    const preview = await f.owner('skill-library-save', input)
    const paths = ['SKILL.md', 'references/guide.md', 'scripts/run.sh']
    assert.deepEqual(preview.files.map(row => row.path), paths)
    assert.deepEqual(preview.scripts, [{ path: 'scripts/run.sh', interpreter: 'bash' }])
    assert.deepEqual(preview.references, ['references/guide.md'])
    assert.deepEqual(preview.findings.map(row => row.rule ?? row.area), ['script', 'other'])
    assert.match(preview.needsConfirm, /^[a-f0-9]{64}$/)
    assert.deepEqual(f.reviews.filter(call => call.name === name).map(call => call.path).sort(), paths)
    const beforeSave = f.reviews.length
    assert.deepEqual(await f.owner('skill-library-save', { token: preview.token, name, confirm: preview.needsConfirm }), { saved: true })
    assert.equal(f.reviews.length, beforeSave)
    const row = (await f.owner('skill-library')).skills.find(skill => skill.name === name)
    assert.equal(row.review.status, 'done')
    assert.equal(row.scripts[0].interpreter, 'bash')
    assert.equal(row.files, undefined)
    assert.equal(JSON.parse(readFileSync(saved)).skills[name].files.some(file => 'mode' in file), false)
    assert.equal(statSync(saved).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(store).sort(), ['audit.jsonl', 'library.json'])
    const inactive = await turn(name)
    assert.match(inactive.chat, /is not active/)
    assert.ok(!inactive.messages.includes(marker))
    assert.deepEqual(await f.owner('bot-skill-add', { id: botId, name }), { saved: true })
    const active = await turn(name)
    assert.ok(active.messages.includes(marker))
    assert.doesNotMatch(active.messages, /REF-BODY-29|never-created/)
    assert.equal(existsSync(sentinel), false)
  }

  const refused = await f.owner('skill-library-save', archive([
    { path: 'SKILL.md', data: doc('injection-notes', 'INJECTION-BODY-35') },
    { path: 'references/guide.md', data: 'Harmless classification fixture.' },
  ]))
  assert.equal(refused.refused, true)
  assert.equal(refused.token, undefined)
  assert.match(refused.message, /prompt injection/)
  assert.equal(refused.findings[0].injection, true)
  const inactive = await turn('injection-notes')
  assert.match(inactive.chat, /is not active/)
  assert.ok(!inactive.messages.includes('INJECTION-BODY-35'))

  const retry = archive([{ path: 'SKILL.md', data: doc('retry-notes') }])
  assert.equal((await f.owner('skill-library-save', retry)).refused, true)
  assert.equal(JSON.parse(readFileSync(saved)).skills['retry-notes'], undefined)
  const clean = await f.owner('skill-library-save', retry)
  assert.ok(clean.token)
  assert.equal(clean.needsConfirm, undefined)
  assert.equal(f.reviews.filter(call => call.name === 'retry-notes').length, 2)
  assert.deepEqual(await f.owner('skill-library-save', { token: clean.token }), { saved: true })

  const replaced = await f.owner('skill-library-save', archive([
    { path: 'SKILL.md', data: doc('folder-notes', 'Write REPLACED-BODY-37.') },
    { path: 'references/guide.md', data: 'REF-BODY-NEW-39' },
    { path: 'scripts/new.sh', data: '#!/bin/bash\nprintf "fixture\\n"\n' },
  ], 'folder-notes'))
  assert.deepEqual(replaced.diff.files.changed.map(row => row.path), ['SKILL.md', 'references/guide.md'])
  assert.deepEqual(replaced.diff.files.added.map(row => row.path), ['scripts/new.sh'])
  assert.deepEqual(replaced.diff.findings.gone.filter(row => row.severity).map(row => row.severity), ['medium'])
  assert.deepEqual(replaced.diff.findings.new.filter(row => row.severity).map(row => row.severity), ['low'])
  assert.deepEqual(await f.owner('skill-library-save', { token: replaced.token, confirm: replaced.needsConfirm }), { saved: true })
  const updated = await turn('folder-notes')
  assert.match(updated.lastUser, /REPLACED-BODY-37/)
  assert.doesNotMatch(updated.lastUser, /FOLDER-BODY-17/)
  assert.match(updated.messages, /FOLDER-BODY-17/, 'earlier skill calls stay in conversation history')
  assert.doesNotMatch(updated.messages, /REF-BODY-NEW-39|never-created/)
  assert.equal(existsSync(sentinel), false)
})

function fullSizeArchive() {
  const max = 6 * 1024 * 1024
  const members = [{ path: 'SKILL.md', data: doc('slow-admin-notes') }]
  for (let i = 0; i < 17; i++) members.push({ path: '__MACOSX/meta-' + i })
  for (let i = 1; i <= 5; i++) members[i].data = Buffer.alloc(1024 * 1024 - 64, 65)
  let remaining = max - zip(members).length
  for (const member of members) {
    const size = Math.min(65_535, remaining)
    member.comment = Buffer.alloc(size, 66)
    remaining -= size
  }
  assert.equal(remaining, 0)
  const bytes = zip(members)
  assert.equal(bytes.length, max)
  return bytes
}

test('#2078 gated admin recovers a 6 MiB archive preview beyond the actual 30-second proxy timeout', { timeout: 59_000 }, async t => {
  const delayed = Promise.withResolvers()
  const started = Promise.withResolvers()
  t.after(() => delayed.resolve(CLEAN_REVIEW))
  const f = await setup(t, (name, path) => {
    assert.equal(name, 'slow-admin-notes')
    assert.equal(path, 'SKILL.md')
    started.resolve()
    return delayed.promise
  }, { gated: true })
  const origin = 'https://skills-fixture.invalid'
  const sessions = new SessionStore(f.home, { memory: true, accepts: () => true })
  const issue = subject => sessions.issue(origin, { issuer: origin, workspace: 'fixture', subject, roles: ['admin'] })
  let issued = issue('admin-a')
  let viewer
  let drop = false
  const uploads = []
  const polls = []
  const upstream = http.createServer(async (req, res) => {
    try {
      const rows = []
      for await (const row of req) rows.push(row)
      const body = Buffer.concat(rows).toString()
      const { payload } = JSON.parse(body)
      if (payload?.fileBytes) uploads.push({ length: payload.fileBytes.length, body: Buffer.byteLength(body), operation: payload.operation })
      if (payload?.poll) polls.push(payload.operation)
      const result = await f.dispatch(body, req.headers)
      res.writeHead(result.status, Object.fromEntries(result.headers)).end(await result.text())
    } catch (error) { res.destroy(error) }
  })
  const upstreamPort = await listen(upstream)
  const credentials = { port: upstreamPort, authority: `${host}:${upstreamPort}`, cookie: async () => 'fixture=synthetic' }
  const gate = createGate({ origin, sessions, credentials, multiuser: true, caller: { signOwner: () => 'isolated-fixture' } })
  const gatePort = await listen(gate)
  t.after(async () => {
    await gate.closeGate()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  })
  const original = http.request
  const timeouts = []
  t.mock.method(http, 'request', (options, callback) => {
    if (options.port === upstreamPort) timeouts.push(options.timeout)
    return original(options, callback)
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'api/omni-ui')
    const body = JSON.parse(options.body)
    if (body.endpoint !== 'whoami') body.viewer = viewer
    const response = await request(gatePort, {
      origin, host: new URL(origin).host, cookie: `${COOKIE}=${issued.secret}`,
    }, { ...options, body: JSON.stringify(body) })
    if (drop) { drop = false; throw new Error('Fixture lost the initiating preview response') }
    return response
  })
  const who = await clientCall('whoami')
  assert.equal(who.viewer.role, 'admin')
  viewer = who.viewer.id
  await assert.rejects(clientCall('skill-library-save', { preview: true, source: 'folder', path: '/absent-fixture' }),
    { code: 'bot/refused', message: /Only the owner/ })
  const state = new Map()
  const skillStorage = { getItem: key => state.get(key), setItem: (key, value) => state.set(key, value), removeItem: key => state.delete(key) }
  const actions = () => teamActions({ call: clientCall, after: value => value, skillStorage })
  const fileBytes = fullSizeArchive().toString('base64')
  assert.equal(fileBytes.length, 8_388_608)
  assert.ok(!existsSync(join(f.home, 'skill-library', 'library.json')))
  const before = performance.now()
  drop = true
  await assert.rejects(actions().saveSkill({ preview: true, source: 'archive', fileName: 'max.zip', fileBytes }), { code: 'NETWORK' })
  await started.promise
  const timer = setTimeout(31_000).then(() => delayed.resolve(CLEAN_REVIEW))
  assert.ok(uploads[0].body > fileBytes.length)
  const firstAdmin = { issued, viewer }
  issued = issue('admin-b')
  viewer = (await clientCall('whoami')).viewer.id
  await assert.rejects(clientCall('skill-library-save', { operation: uploads[0].operation, poll: true }), { code: 'bot/not-found' })
  ;({ issued, viewer } = firstAdmin)
  const [recovered] = await actions().resumeSkillSaves()
  await timer
  assert.equal(recovered.status, 'fulfilled', recovered.reason?.message)
  const preview = recovered.value
  assert.equal(preview.preview, true)
  assert.match(preview.token, /^[a-f0-9]{32}$/)
  assert.equal(preview.needsConfirm, undefined)
  assert.ok(performance.now() - before > 30_000)
  assert.ok(polls.length > 2 && polls.every(operation => operation === uploads[0].operation))
  assert.equal(uploads.length, 1)
  assert.deepEqual(new Set(timeouts), new Set([30_000]))
  assert.ok(timeouts.length > 2)
  assert.equal(f.reviews.length, 1)
  assert.equal(JSON.parse(readFileSync(join(f.home, 'skill-library', 'library.json'))).skills[preview.name], undefined)
  assert.deepEqual(await actions().saveSkill({ token: preview.token, name: preview.name }), { saved: true })
  assert.equal(f.reviews.length, 1)
  const row = (await clientCall('skill-library')).skills.find(row => row.name === preview.name)
  assert.equal(row.review.status, 'done')
  t.diagnostic(`Admin gate transferred ${uploads[0].body} JSON bytes (${fileBytes.length} base64), one upload and one review.`)
})
