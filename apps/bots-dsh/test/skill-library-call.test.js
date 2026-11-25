import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { crossed } from '../../acp-dsh/src/host/switch.js'
import { install, requestedSkills, skillTool } from '../src/host/skill-library-call.js'
import { SKILL_NOTICE } from '../src/host/skill-message.js'

const route = { provider: 'deepseek-fixture', model: 'fixture-model' }
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const doc = (name, content) => ({ name, content, description: 'Description for ' + name, hash: name, mode: 'automatic' })
const x = doc('marker', 'CHECKED-BODY')
const privateSkill = doc('private-skill', 'PRIVATE-BODY')
const testRows = requests => requests.flatMap(request => request.messages)
const text = rows => rows.flatMap(row => row.content?.map(part => part.text) ?? []).join('\n')

async function fixture(t, { program } = {}) {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  if (program) {
    await root.plugin(LocalFileSystem)
    await root.plugin(LocalSubprocessRuntime)
    root.provide('sandboxPolicy', { defaultMode: 'read-only',
      resolve: ({ session } = {}) => ({ mode: 'read-only', workspaceRoot: process.cwd(), sessionId: session?.id }) })
    root.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) })
    await root.plugin(NodePtcRuntime)
  }
  await mountAgentLoopTestDependencies(root, { workingDirectory: true, ...(program ? { tools: { mode: 'ptc' } } : {}) })
  const requests = []
  let autoload = false
  let call = 0
  let afterProgram
  class Adapter extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }
    async *stream(options) {
      requests.push(options)
      if (autoload) {
        autoload = false
        yield { type: 'tool-call-delta', index: 0, id: `fixture-${++call}`, name: program ? 'run_code' : 'load_skill',
          argumentsDelta: program ? JSON.stringify({ code: program, description: 'Load the checked skill' }) : '{"name":"marker"}' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: 'fixture reply' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  root.llm.registerAdapter([route.provider], new Adapter())
  await mountAgentLoopTestHarness(root)
  if (program) {
    root.on('tools/result', exec => {
      if (exec.name === 'run_code') afterProgram?.()
    })
  }
  const active = new Map([['a', [x]]])
  const owners = new Map([['a', 'a'], ['b', 'b'], ['group-a', 'a'], ['group-b', 'b'], ['task-a', 'a']])
  const bots = new Map([['a', { id: 'a' }], ['b', { id: 'b' }]])
  const roomNotices = []
  const rt = {
    ctx: root, load: async () => {}, botOf: id => bots.get(id), selfOf: id => owners.get(id),
    skillLibrary: { active: id => active.get(id) ?? [] },
    roomSkillNotice: (...args) => roomNotices.push(args),
  }
  root.tools.register(skillTool(rt))
  install(rt)
  const run = async (id, message, load = false) => {
    const agent = root.get('agents')?.get(id) ?? await root.agentLoop.create(id, route)
    autoload = load
    const before = requests.length
    agent.followup(message)
    await agent.whenIdle()
    assert.ok(requests.length > before, 'a real DSH request was sent: ' + JSON.stringify(agent.session.snapshotEvents()))
    return { agent, sent: requests.slice(before) }
  }
  return { root, rt, active, roomNotices, requests, run, afterProgram: hook => { afterProgram = hook } }
}

test('native request includes only the current catalog and checked calls, while refusals are private', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const four = ['second', 'third', 'fourth'].map(name => doc(name, name.toUpperCase()))
  f.active.set('a', [x, ...four])
  const { sent, agent } = await f.run('a', user('/marker /second /third /fourth use the skill private-skill'))
  const rows = testRows(sent)
  const catalog = rows.find(row => row.role === 'system' && text([row]).includes(x.description))
  assert.ok(catalog)
  assert.equal(catalog.content.at(-1).text.trim(), [x, ...four].map(item => `${item.name}: ${item.description}`).join('\n'))
  const row = rows.find(row => row.source.kind === 'user')
  assert.deepEqual(row.content.slice(1).map(part => part.text), [x, ...four].map(skill => skill.content))
  assert.doesNotMatch(text(rows), /PRIVATE-BODY|Description for private|not active|Details|The person called/)
  assert.ok(agent.session.snapshotEvents().some(event => event.data?.source?.kind === SKILL_NOTICE))
})

test('Skills row 6: programmatic loads keep checked bodies outside program values', { timeout: 15_000 }, async t => {
  const f = await fixture(t, { program: 'return await tools.load_skill({ name: "marker" })' })
  const permitted = await f.run('a', user('Load the skill through the program'), true)
  const rows = permitted.sent.at(-1).messages
  assert.match(text(rows), /CHECKED-BODY/, 'the checked body reaches the model')
  assert.doesNotMatch(text(rows.filter(row => row.role === 'tool')), /CHECKED-BODY|automagikSkill|botId/)
  f.afterProgram(() => f.active.set('a', [{ ...x, mode: 'manual' }]))
  const revoked = await f.run('a', user('Load again and demote before dispatch'), true)
  const fresh = revoked.sent.at(-1).messages
  assert.equal(fresh.flatMap(row => row.content ?? []).filter(part => part.text?.includes(x.content)).length, 1,
    'only the previously delivered occurrence remains')
})

test('Skills row 7: ACP crossing redaction composes with a fresh native catalog', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const { sent } = await f.run('a', user('original request'))
  let attempts = 0
  f.root.on('llm/stream', (_options, next) => {
    assert.ok(++attempts <= 10, 'the projection waterfall must terminate')
    return next()
  }, { prepend: true })
  f.root.on('llm/stream', crossed(new Map(), f.root, value => value.replaceAll('secret-fixture', '[masked]')))
  const { sessionId, signal, tools } = sent[0]
  const request = markAgentLoopRequest({ ...route, sessionId, signal, tools, messages: [
    { role: 'assistant', id: 'earlier-acp', source: { kind: 'model', provider: 'acp-claude', model: 'fixture' },
      content: [{ type: 'text', text: 'secret-fixture' }] },
    user('continue with native'),
  ] })
  const chunks = []
  const before = f.requests.length
  for await (const chunk of f.root.llm.stream(request)) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'text-delta', index: 0, text: 'fixture reply' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.ok(attempts <= 3, 'each projection ran at most once before dispatch')
  assert.equal(f.requests.length, before + 1, 'the native provider dispatched once')
  const input = text(f.requests.at(-1).messages)
  assert.match(input, /\[masked\]/)
  assert.match(input, /marker: Description for marker/)
  assert.doesNotMatch(input, /secret-fixture/)
})

test('native autonomous load returns only the checked body and Remove preserves the earlier turns', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await f.run('a', user('/marker'))
  const loaded = await f.run('a', user('Choose a skill on your own'), true)
  assert.ok(testRows(loaded.sent).some(row => row.role === 'tool' && row.content[0].text === x.content))
  f.active.delete('a')
  const next = await f.run('a', user('/marker again'), true)
  const rows = next.sent.at(-1).messages
  assert.doesNotMatch(text(rows.filter(row => row.role === 'system')), /Description for marker/)
  assert.deepEqual(rows.filter(row => row.source.kind === 'user').at(-1).content.map(part => part.text), ['/marker again'])
  assert.ok(rows.some(row => row.role === 'user' && row.content.some(part => part.text === x.content)), 'earlier person use stayed')
  const tools = rows.filter(row => row.role === 'tool')
  assert.equal(tools[0].content[0].text, x.content, 'earlier autonomous use stayed')
  assert.doesNotMatch(text(tools.slice(1)), /CHECKED-BODY|Details/)
  assert.equal(f.rt.skillCalls.load('b', x.name), undefined)
  assert.equal(f.rt.skillCalls.load('subagent', x.name), undefined)
  assert.equal(f.rt.skillCalls.load('task-a', x.name), undefined)
})

test('a group member receives only its own skills and a relay without a Bot receives none', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const input = user('/marker')
  const group = () => createUserMessage({ content: input.content, source: {
    kind: 'bot', role: 'room', roomId: 'r', skillRequests: requestedSkills(input.content),
  } })
  const a = await f.run('group-a', group())
  const b = await f.run('group-b', group())
  const relay = await f.run('relay', input)
  assert.match(text(testRows(a.sent)), /CHECKED-BODY/)
  assert.doesNotMatch(text(testRows(b.sent)), /CHECKED-BODY|Description for marker|Details/)
  assert.doesNotMatch(text(testRows(relay.sent)), /CHECKED-BODY|Description for marker|Details/)
  assert.deepEqual(f.roomNotices.map(([room, bot]) => [room, bot]), [['r', 'b']])
})

test('an existing slash command and a DSH skill keep their route and never double-load', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.root.provide('skills', { get: async name => name === x.name ? { name } : undefined })
  const { sent } = await f.run('a', user('/help /marker'))
  assert.doesNotMatch(text(testRows(sent)), /CHECKED-BODY|not active|Details/)
  assert.deepEqual(requestedSkills(user('/help use the skill private-skill').content), [{ name: privateSkill.name, slash: false }])
})

test('side requests and transcript tools do not carry generated Skills blocks into another model call', async t => {
  const f = await fixture(t)
  const { agent, sent } = await f.run('a', user('/marker'))
  const request = sent[0]
  const side = f.rt.skillCalls.project({ ...request, purpose: 'compaction' })
  assert.doesNotMatch(text(side.messages), /Description for marker|CHECKED-BODY|Details/)
  const { historyEntry } = await import('../src/host/parts.js')
  const archived = agent.session.snapshotEvents().find(event => event.data?.source?.kind === 'user')
  assert.equal(historyEntry(archived, false).text, '/marker')
})

test('group text without a person request carries no skill body', async t => {
  const f = await fixture(t)
  const message = createUserMessage({ content: [{ type: 'text', text: 'Scheduled: /marker' }],
    source: { kind: 'bot', role: 'room', roomId: 'r' } })
  const { sent } = await f.run('group-a', message)
  assert.doesNotMatch(text(testRows(sent)), /CHECKED-BODY|not active/)
})

test('call-only skills stay absent until explicitly called and never load autonomously', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.active.set('a', [{ ...x, mode: 'manual' }])
  const autonomous = await f.run('a', user('Choose a skill on your own'), true)
  assert.doesNotMatch(text(testRows(autonomous.sent)), /Description for marker|CHECKED-BODY|Details/)
  assert.equal(f.rt.skillCalls.load('a', x.name), undefined)
  const person = await f.run('a', user('use the skill marker'))
  assert.match(text(testRows(person.sent)), /CHECKED-BODY/)
  assert.doesNotMatch(text(testRows(person.sent)), /Description for marker/)
  f.active.set('a', [x])
  const promoted = await f.run('a', user('Choose a skill on your own'), true)
  assert.match(text(testRows(promoted.sent).filter(row => row.role === 'system')), /Description for marker/)
  assert.ok(testRows(promoted.sent).filter(row => row.role === 'tool').some(row => row.content[0]?.text === x.content))
  f.active.set('a', [{ ...x, mode: 'manual' }])
  const demoted = await f.run('a', user('Choose a skill on your own'), true)
  const latest = demoted.sent.at(-1).messages
  assert.doesNotMatch(text(latest.filter(row => row.role === 'system')), /Description for marker/)
  assert.deepEqual(latest.filter(row => row.role === 'tool').at(-1).content, [])
  assert.ok(latest.some(row => row.role === 'tool' && row.content[0]?.text === x.content))
})
