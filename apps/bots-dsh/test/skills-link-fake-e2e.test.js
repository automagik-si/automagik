import assert from 'node:assert/strict'
import dns from 'node:dns'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { apply } from '../index.js'
import { directLink, fakeOpen, fakeRequest, folderLink, folderRoutes, publicResolver, response,
  revisionA, revisionB, skillMd } from './fixtures/skill-link-fixtures.js'
import { CLEAN_REVIEW } from './fixtures/skill-review-model.js'

const botId = 'b-aaaaaaaaaa'
const sessionId = 'fixture-link-chat'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const backgroundModel = route.provider + '/' + route.model
const name = 'link-notes'
const folderName = 'link-folder'
const script = ['scripts/run.sh', '#!/bin/sh\nprintf "synthetic preview only\\n"\n']
const finding = (area = 'other') => JSON.stringify({
  findings: [{ file: 'SKILL.md', severity: 'low', area, line: 1, reason: 'Synthetic reviewer finding.' }], overflow: false,
})
const texts = row => row.content?.filter(part => part.type === 'text').map(part => part.text) ?? []
const bodyLocations = (messages, marker) =>
  messages.flatMap(row => texts(row).flatMap(text => text.includes(marker) ? [{ id: row.id, text }] : []))

async function mount(t, initial, reviewer, native) {
  const selected = native?.route ?? route
  const modelRef = selected.provider + '/' + selected.model
  const home = mkdtempSync(join(os.tmpdir(), 'skills-link-e2e-'))
  const root = new Context()
  t.after(async () => {
    try { await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true }) }
  })
  const path = join(home, 'skill-library', 'library.json')
  if (initial) initial(home, path)
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [botId],
    bots: { [botId]: { id: botId, sessionId, name: 'Fixture Bot', createdAt: 1, role: 'Helper',
      model: modelRef, appliedModel: modelRef } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: { backgroundModel: modelRef },
  }))
  const requests = []
  const reviews = []
  class FakeModel extends LlmAdapter {
    async listModels(provider) {
      return [await this.resolveModel(provider, route.model)]
    }
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }
    async *stream(request) {
      const { system, tools, messages } = request
      let text = 'Fixture turn.'
      if (system?.startsWith('Review the supplied skill')) {
        assert.deepEqual(tools, [])
        assert.equal(request.sessionId, undefined)
        const frame = messages[0].content[0].text
        reviews.push(/ chunk .* path=([^\n]+)\n/.exec(frame)?.[1])
        text = reviewer()
      } else {
        assert.equal(request.sessionId, sessionId)
        assert.ok(!tools.some(tool => /(?:^|_)fetch(?:$|_)/.test(tool.name)), 'Bot tools cannot fetch links')
        requests.push(JSON.parse(JSON.stringify(messages)))
      }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.llm.registerAdapter([selected.provider], native?.adapter ?? new FakeModel())
  const harness = await mountAgentLoopTestHarness(root)
  const routes = new Map()
  root.provide('connection', { fetch: { register: entry => { routes.set(entry.path, entry); return () => routes.delete(entry.path) } } })
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
  const owner = async (endpoint, payload = {}) => {
    const res = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    const data = await res.json()
    assert.equal(data.ok, true, `${endpoint}: ${JSON.stringify(data)}`)
    return data.value
  }
  let serial = 0
  const operation = async body => {
    const operation = (++serial).toString(16).padStart(32, '0')
    let value = await owner('skill-library-save', { ...body, operation })
    for (let attempt = 0; value.pending && attempt < 200; attempt++) {
      await setTimeout(5)
      value = await owner('skill-library-save', { operation, poll: true })
    }
    assert.notEqual(value.pending, true)
    return value
  }
  let agent
  const send = async () => {
    agent ??= await harness.create(sessionId, selected, { cwd: home })
    assert.equal(await owner('send', { sessionId: botId, text: '/' + name }), true)
    await agent.whenIdle()
    await setImmediate()
  }
  const turn = async marker => {
    const from = requests.length
    const prior = new Set(requests.flatMap(messages => messages.map(row => row.id)))
    await send()
    const fresh = requests.slice(from)
    if (!marker) {
      assert.match(JSON.stringify((await owner('chat', { botId })).items), /is not active/)
      assert.ok(fresh.every(messages => bodyLocations(messages, 'LINK-BODY-').length === 0))
      return
    }
    assert.equal(fresh.length, 1)
    const messages = fresh[0]
    const person = messages.findLast(row => row.source?.kind === 'user')
    assert.ok(person?.id && !prior.has(person.id), 'the person row is new')
    const body = bodyLocations(messages, marker).filter(row => !prior.has(row.id))
    assert.equal(body.length, 1, 'the expected delivery is in a new model row')
    assert.equal(body[0].id, person.id)
  }
  return { path, owner, operation, requests, reviews, rt, send, turn }
}

const nativeUrl = 'http://127.0.0.1:2079'
const nativeRoute = { provider: 'deepseek-official', model: 'fixture-model' }

function nativeResponse(text) {
  const events = [
    { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: nativeRoute.model,
      content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}

test('#2079 fake link preview and manual Check reach Cancel, Apply and delivery', { timeout: 20_000 }, async t => {
  const nativeRequests = []
  let simulatingNative = false
  t.mock.method(globalThis, 'fetch', (url, { body } = {}) => {
    assert.ok(simulatingNative, 'Unexpected fetch outside the native fixture')
    assert.equal(url, nativeUrl + '/v1/messages')
    const request = JSON.parse(body)
    nativeRequests.push(request)
    return nativeResponse(JSON.stringify(request.system).includes('Review the supplied skill') ? CLEAN_REVIEW : 'Fixture turn.')
  })
  t.mock.method(dns.promises, 'lookup', async (name, options) => {
    assert.ok(['automagik-si.example', 'api.github.com', 'raw.githubusercontent.com'].includes(name))
    assert.deepEqual(options, { all: true, family: 4 })
    return publicResolver()
  })
  t.mock.method(os, 'networkInterfaces', () => ({}))
  let upstream = skillMd('LINK-BODY-1')
  let folder = folderRoutes(revisionA, [['SKILL.md', skillMd('FOLDER-BODY-1', folderName)], script])
  let answer = CLEAN_REVIEW
  const fetched = []
  t.mock.method(https, 'request', fakeRequest(url => {
    const routes = new Map(folder.routes)
    routes.set(directLink, () => response(upstream))
    return fakeOpen(routes, fetched)(url)
  }))
  const f = await mount(t, undefined, () => answer)
  const snapshot = () => JSON.parse(readFileSync(f.path))
  const observed = () => [fetched.length, f.reviews.length]
  const save = async (body, expected = { saved: true }) => {
    const before = observed()
    assert.deepEqual(await f.operation(body), expected)
    assert.deepEqual(observed(), before, 'claims repeat neither fetch nor review')
  }
  const check = name => f.operation({ update: 'check', name })
  const apply = ({ token, needsConfirm }, name) => save({ update: 'apply', name, token, ...(needsConfirm ? { confirm: needsConfirm } : {}) })
  const turn = async marker => {
    const before = observed()
    await f.turn(marker)
    assert.deepEqual(observed(), before, 'Bot turns fetch and review nothing')
  }

  const raw = await f.operation({ preview: true, source: 'link', url: directLink })
  assert.match(raw.token, /^[a-f0-9]{32}$/)
  assert.equal(raw.needsConfirm, undefined)
  assert.match(raw.source.revision, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(observed(), [1, 1])
  await save({ token: raw.token, name })
  assert.deepEqual(snapshot().skills[name].source, raw.source)

  const imported = snapshot().skills[name]
  const connection = resolveAdapterOptions({ baseURL: nativeUrl, models: [{ id: nativeRoute.model, name: nativeRoute.model }] })
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveAuth: async () => ({ headers: {} }),
    discoverModels: async provider => [await adapter.resolveModel(provider, nativeRoute.model)],
    resolveUserId: () => 'fixture', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  simulatingNative = true
  const native = await mount(t, (home, path) => {
    mkdirSync(join(home, 'skill-library'), { mode: 0o700 })
    writeFileSync(path, JSON.stringify({ version: 1, skills: { [name]: imported }, active: {} }), { mode: 0o600 })
  }, undefined, { route: nativeRoute, adapter })
  const foreign = await native.owner('skill-library-get', { name })
  assert.match(foreign.held, /has not reviewed/)
  assert.equal(foreign.reviewHash, imported.hash)
  assert.deepEqual(await native.operation({ name, edit: true, reviewHash: foreign.reviewHash }), { saved: true })
  const local = await native.owner('skill-library-get', { name })
  assert.equal(local.held, undefined)
  assert.deepEqual(local.source, raw.source)
  assert.equal(nativeRequests.length, 1)
  assert.match(JSON.stringify(nativeRequests[0]), /Review the supplied skill/)
  assert.deepEqual(await native.owner('bot-skill-add', { id: botId, name }), { saved: true })
  await native.send()
  assert.equal(nativeRequests.length, 2)
  assert.match(JSON.stringify(nativeRequests[1].messages), /LINK-BODY-1/)
  assert.deepEqual(observed(), [1, 1], 'native re-accept and delivery never reach the skill URL')
  simulatingNative = false

  const fromFolder = await f.operation({ preview: true, source: 'link', url: folderLink })
  assert.equal(fromFolder.source.ref, 'refs/heads/main')
  assert.equal(fromFolder.source.revision, revisionA)
  assert.match(fromFolder.needsConfirm, /^[a-f0-9]{64}$/)
  assert.deepEqual(fromFolder.findings.map(row => row.rule), ['script'])
  assert.deepEqual(f.reviews.slice(1).sort(), ['SKILL.md', 'scripts/run.sh'])
  await save({ token: fromFolder.token, name: folderName, confirm: fromFolder.needsConfirm })
  await turn()
  assert.deepEqual(await f.owner('bot-skill-add', { id: botId, name }), { saved: true })
  const initial = snapshot()
  await turn('LINK-BODY-1')

  upstream = skillMd('LINK-BODY-2 at https://api.changed.example/')
  answer = finding()
  const counts = observed()
  const changed = await check(name)
  assert.deepEqual(observed(), [counts[0] + 1, counts[1] + 1])
  assert.deepEqual(changed.diff.files.changed.map(row => row.path), ['SKILL.md'])
  assert.match(changed.diff.files.changed[0].afterText, /LINK-BODY-2/)
  assert.deepEqual(changed.findings.map(row => row.rule ?? row.area), ['endpoint', 'endpoint', 'other'])
  assert.deepEqual(changed.diff.findings.new, changed.findings)
  assert.equal(changed.endpoints.new[0].host, 'api.changed.example')
  assert.deepEqual(changed.usedBy, [{ id: botId, name: 'Fixture Bot', mode: 'manual' }])
  assert.match(changed.needsConfirm, /^[a-f0-9]{64}$/)
  // Cancel sends nothing. Check may have retained its verified review.
  await turn('LINK-BODY-1')
  assert.ok(f.requests.every(messages => bodyLocations(messages, 'LINK-BODY-2').length === 0))
  assert.deepEqual(snapshot().skills, initial.skills)
  assert.deepEqual(snapshot().active, initial.active)

  const calls = observed()
  const repeated = await check(name)
  assert.deepEqual(observed(), [calls[0] + 1, calls[1]])
  assert.equal(repeated.needsConfirm, changed.needsConfirm)
  await apply(repeated, name)
  await turn('LINK-BODY-2')
  assert.equal(snapshot().skills[name].source.revision, repeated.source.revision)
  assert.notEqual(snapshot().skills[name].source.revision, raw.source.revision)
  assert.match(snapshot().skills[name].acceptanceSeal, /^[a-f0-9]{64}$/)
  assert.deepEqual(snapshot().active, initial.active)

  upstream = skillMd('LINK-BODY-3')
  answer = finding('prompt-injection')
  const blocked = await check(name)
  assert.equal(blocked.refused, true)
  assert.match(blocked.message, /prompt injection/)
  assert.equal(blocked.token, undefined)
  assert.deepEqual(blocked.findings.map(row => row.injection), [true])
  await turn('LINK-BODY-2')

  f.rt.state.prefs.backgroundModel = 'fixture-native/unavailable'
  await f.rt.save()
  upstream = skillMd('LINK-BODY-4')
  const unavailableBefore = observed()
  const unavailable = await check(name)
  assert.equal(unavailable.refused, true)
  assert.match(unavailable.message, /no background model/)
  assert.equal(unavailable.token, undefined)
  assert.deepEqual(observed(), [unavailableBefore[0] + 1, unavailableBefore[1]])

  f.rt.state.prefs.backgroundModel = backgroundModel
  await f.rt.save()
  answer = CLEAN_REVIEW
  folder = folderRoutes(revisionB, [['SKILL.md', skillMd('FOLDER-BODY-2', folderName)], script])
  const folderChanged = await check(folderName)
  assert.equal(folderChanged.source.revision, revisionB)
  assert.match(folderChanged.needsConfirm, /^[a-f0-9]{64}$/)
  await apply(folderChanged, folderName)
  const after = readFileSync(f.path, 'utf8')
  assert.equal(snapshot().skills[folderName].source.revision, revisionB)
  const beforeEqual = observed()
  assert.equal((await check(folderName)).upToDate, true)
  assert.equal(f.reviews.length, beforeEqual[1])
  assert.equal(readFileSync(f.path, 'utf8'), after)
})
