import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { AGY_OFF_CHECKED, AGY_OFF_SETTINGS } from '../../acp-dsh/src/host/agy-off.js'
import { AGY_OFF_ARGS, agyWorld, ownerMessage, unixOnly } from '../../acp-dsh/test/fixtures/agy-world.js'
import { install, skillTool } from '../src/host/skill-library-call.js'
import { SKILL_NOTICE } from '../src/host/skill-message.js'
import { historyEntry } from '../src/host/parts.js'

const remedy = 'Skills cannot be loaded in Antigravity with native tools off on this version'
const automatic = { name: 'marker', description: 'Adds the file marker', content: 'CHECKED-ACP-BODY', hash: 'fixture-revision', mode: 'automatic' }
const manual = { name: 'mint-notes', content: 'CHECKED-MANUAL-BODY', hash: 'mint', mode: 'manual' }
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

function world(t, version) {
  const h = agyWorld(t, { registry: 'lazy', version })
  const handlers = new Map()
  const sessions = new Map()
  const rt = {
    ctx: {
      on: (name, handler) => handlers.set(name, handler),
      get: name => name === 'sessions' ? sessions : undefined,
      llm: { stream: request => request },
    },
    load: async () => {}, selfOf: id => id, botOf: id => ({ id }),
    skillLibrary: { active: () => [automatic, manual] },
  }
  install(rt)
  h.services.omniTeam = rt
  h.service.botIdentity(id => ({ name: id }))
  const tool = skillTool(rt)
  let executions = 0
  h.services.tools = {
    definitions: () => [tool, { name: 'other_fixture_tool' }],
    async execute() { executions++; throw new Error('no tool runs in this probe') },
  }
  return { h, rt, handlers, sessions, executions: () => executions }
}

test('Antigravity OFF keeps chatting when the session MCP registry is unproven', { ...unixOnly, timeout: 30_000 }, async t => {
  const { h, rt, handlers, sessions, executions } = world(t, AGY_OFF_CHECKED)
  const chat = h.chat('eligible')
  sessions.set(chat.session.id, chat.session)
  const person = ownerMessage('plain registry warmup')
  chat.session.append('user/message', person, { surfaceOp: 'append' })
  const chunks = await chat.turn(person)
  const { args, pid, prompt } = h.conversation('registry warmup')
  const child = h.events().filter(event => event.pid === pid)
  const registry = child.find(event => event.event === 'registry')
  assert.doesNotMatch(textOf(chunks), /not found in registry/,
    JSON.stringify({ reply: textOf(chunks), registry, mcp: child.find(event => event.event === 'mcp-list') }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.match(textOf(chunks), /you said "plain registry warmup"/)
  assert.deepEqual(args, AGY_OFF_ARGS)
  assert.equal(prompt, 'plain registry warmup')
  assert.deepEqual(registry.wanted, [])
  assert.deepEqual(registry.registry, [])
  const launch = child.find(event => event.event === 'new-session')
  assert.deepEqual(launch.servers, [])
  assert.equal(launch.meta?.antigravity?.eagerMcpServers, undefined)
  assert.notEqual(launch.meta?.disableBuiltInTools, false)
  assert.equal(child.some(event => event.event === 'mcp-list'), false)
  assert.equal(h.adapter.live.get(chat.session.id).bridge, undefined)
  const gemini = join(h.home(), '.gemini')
  const profile = readFileSync(join(gemini, 'config', 'agents', 'automagik-native-off.md'), 'utf8')
  assert.match(profile, /^tools: \[\]$/m)
  assert.match(profile, /^excludeDefaultComponents: true$/m)
  assert.match(profile, /^commandExecutionPolicy: "off"$/m)
  assert.equal(readFileSync(join(gemini, 'antigravity-cli', 'automagik-native-off', 'settings.json'), 'utf8'), AGY_OFF_SETTINGS)
  assert.equal(existsSync(join(gemini, 'config', 'agents', 'automagik-native-off-skills.md')), false)

  const notices = () => chat.session.deriveMessages().filter(row => row.source?.kind === SKILL_NOTICE)
  assert.deepEqual(notices().map(row => row.content[0].text), [remedy])
  const events = chat.session.snapshotEvents()
  assert.equal(chat.session.surface.nodes.map(seq => chat.session.eventAt(seq))
    .filter(event => event.data?.source?.kind === SKILL_NOTICE).length, 1)
  assert.deepEqual(events.map(event => historyEntry(event, false)).filter(Boolean).map(row => row.text), ['plain registry warmup'])
  const history = { sessionId: chat.session.id, messages: chat.session.deriveMessages() }
  assert.deepEqual(rt.skillCalls.project(history, { catalog: false, historyOnly: true }).messages, [person])
  const typed = ({ source, content }) => ownerMessage(JSON.stringify({ kind: 'user-message', source, content }))
  const review = { ...history, provider: 'fixture-reviewer', purpose: 'auto-review',
    messages: [createSystemMessage('ENVIRONMENT\n{}'), typed(person), ...notices().map(typed)] }
  assert.deepEqual(handlers.get('llm/stream')(review, () => review).messages, review.messages.slice(0, 2))

  const again = await chat.turn('plain registry reuse', notices())
  assert.equal(again.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.conversation('registry reuse'), { pid, args, prompt: 'plain registry reuse' })
  h.service.endSession(chat.session.id)
  await chat.turn('plain registry renewal')
  const replay = h.events('prompt').at(-1).text
  assert.doesNotMatch(replay, /cannot be loaded|load_skill|Adds the file marker|CHECKED-ACP-BODY/)
  assert.equal(notices().length, 1)
  assert.equal(executions(), 0)
  assert.deepEqual(h.approvals, [])
})

test('a checked explicit manual call still reaches plain Antigravity OFF', { ...unixOnly, timeout: 15_000 }, async t => {
  const { h, handlers } = world(t)
  const chat = h.chat('eligible')
  const message = ownerMessage('Use the skill mint-notes. plain manual fixture')
  const { messages: [checked] } = await handlers.get('agent/pre-step')({
    agent: { id: chat.session.id, session: chat.session }, messages: [message], signal: new AbortController().signal,
  }, () => ({ kind: 'enter', messages: [message] }))
  assert.equal(checked.source.automagikSkillParts.length, 1)
  chat.session.append('user/message', checked, { surfaceOp: 'append' })
  const chunks = await chat.turn(checked)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  const { args, prompt } = h.conversation('manual fixture')
  assert.deepEqual(args, AGY_OFF_ARGS)
  assert.equal(prompt, 'Use the skill mint-notes. plain manual fixture\nCHECKED-MANUAL-BODY')
})
