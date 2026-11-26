import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Delegate from '@deepseek-ai/dsh-tool-subagent'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { offeredTools } from '../../acp-dsh/src/host/backchannel.js'
import { replayBlocks } from '../../acp-dsh/src/host/switch.js'
import { apply, inject } from '../index.js'
import { CLEAN_REVIEW } from './fixtures/skill-review-model.js'

const botA = 'b-aaaaaaaaaa'
const botB = 'b-bbbbbbbbbb'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const ref = `${route.provider}/${route.model}`
const marker = { name: 'task-marker', description: 'Write a short delivery note.', content: 'Reply with MARKER-TASK-77.' }
const manual = { name: 'manual-one', description: 'Write a note when asked.', content: 'Reply with MANUAL-TASK-22.' }
const late = { name: 'late-note', description: 'Write a late note.', content: 'Reply with LATE-NOTE-91.' }
const inactive = { name: 'inactive-note', description: 'Write a private note.', content: 'Reply with PRIVATE-NOTE-71.' }
const catalog = `Your skills (load with load_skill):\n${marker.name}: ${marker.description}`
const instructions = 'Write the task report. Please use the skill manual-one.'
const childPrompt = 'Write the child report. Please use the skill manual-one.'
const activity = agent => agent.session.snapshotEvents().filter(e => e.type === 'plugin:automagik/skill-activity').map(e => e.data.name)
const textOf = row => row?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''
const sentText = request => request.messages.map(textOf).join('\n')
const prompt = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function until(observe, label) {
  for (let i = 0; i < 200; i++) {
    const value = observe()
    if (value) return value
    await delay(15)
  }
  assert.fail(label)
}

async function fixture(t, { program = false } = {}) {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network unavailable in fixture') })
  const home = mkdtempSync(join(tmpdir(), 'skills-worker-'))
  const root = new Context()
  t.after(async () => {
    try { await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [botA, botB],
    bots: Object.fromEntries([botA, botB].map(id => [id, { id, sessionId: id, name: id === botA ? 'Pilot' : 'Scout',
      createdAt: 1, role: 'Helper', model: ref, appliedModel: ref, workDir: home }])),
    rooms: { 'fixture-room': { id: 'fixture-room', name: 'Fixture room', named: true, mode: 'admin',
      admin: botA, members: [botA, botB], sessions: { [botA]: 'fixture-member' }, log: [], seq: 0 } },
    exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} },
    prefs: { backgroundModel: ref },
  }))
  const requests = []
  let nextCall = 0
  const called = new Set()
  class FakeModel extends LlmAdapter {
    async listModels(provider) {
      return [await this.resolveModel(provider, route.model)]
    }

    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }

    async *stream({ sessionId, messages, tools, system }) {
      if (tools.length === 0 && system?.startsWith('Review the supplied skill')) {
        yield { type: 'text-delta', index: 0, text: CLEAN_REVIEW }
      } else {
        requests.push({ sessionId, messages: structuredClone(messages), tools: tools.map(tool => tool.name) })
        const input = messages.findLast(row => row.source?.kind === 'user')
        const user = input?.content?.find(part => part.type === 'text')?.text
        const key = JSON.stringify([sessionId, input?.id])
        const pending = !called.has(key)
        const call = user === 'Delegate task.' && pending ? ['start_task', { title: 'Write the report', instructions }]
          : user === 'Delegate child.' && pending ? ['fixture_delegate', { description: 'Write child report', prompt: childPrompt }]
          : pending && (user === instructions || user?.startsWith('Write the child report.'))
            ? program
              ? ['run_code', { code: 'await tools.load_skill({ name: "task-marker" }); return {}', description: 'Read the checked skill' }]
              : ['load_skill', { name: marker.name }]
            : undefined
        if (call) {
          called.add(key)
          yield { type: 'tool-call-delta', index: 0, id: `worker-${++nextCall}`, name: call[0], argumentsDelta: JSON.stringify(call[1]) }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const loaded = messages.some(row => (row.role === 'tool' || row.source?.kind === 'automagik-skill') &&
          textOf(row) === marker.content)
        yield { type: 'text-delta', index: 0, text: loaded ? 'MARKER-TASK-77' : 'No marker was loaded.' }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  if (program) {
    await root.plugin(LocalFileSystem)
    await root.plugin(LocalSubprocessRuntime)
    root.provide('sandboxPolicy', { defaultMode: 'read-only',
      resolve: ({ session } = {}) => ({ mode: 'read-only', workspaceRoot: home, sessionId: session?.id }) })
    root.provide('sandbox', { confine: async argv => ({ argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }) })
    await root.plugin(NodePtcRuntime)
  }
  await mountAgentLoopTestDependencies(root, { workingDirectory: true, ...(program && { tools: { mode: 'ptc' } }) })
  root.llm.registerAdapter([route.provider], new FakeModel())
  const harness = await mountAgentLoopTestHarness(root)
  await root.plugin(Jsonl, { root: join(home, 'sessions') })
  await root.plugin(SubagentRuntime)
  await root.plugin(Spawn)
  await root.plugin(Fork)
  await root.plugin(Delegate, { provider: 'spawn', toolName: 'fixture_delegate' })
  const routes = new Map()
  root.provide('connection', { fetch: { register: route => {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  } } })
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'worker-workspace', path }) })
  root.provide('sessionTitle', { rename: async () => {} })
  let nextTask = 0
  root.provide('sessionController', {
    create: async ({ sessionId = `fixture-task-${++nextTask}`, cwd = home }) => {
      await harness.create(sessionId, route, { cwd })
      return { sessionId }
    },
    resolveAgent: async id => ({ agent: root.agents.get(id) }),
    selectModel: async ({ provider, model }) => ({ selected: { provider, model } }),
    prompt: async ({ sessionId, requestId, content }) => {
      root.agents.get(sessionId).followup(createUserMessage({ content, source: { kind: 'user', requestId } }))
    },
    async page({ address, throughSeq, beforeSeq, maxMessages }) {
      const events = root.agents.get(address.sessionId)?.session.snapshotEvents() ?? []
      const visible = events.filter(event => (throughSeq === undefined || event.seq <= throughSeq)
        && (beforeSeq === undefined || event.seq < beforeSeq))
      return { records: visible.slice(-maxMessages).map(event => ({ event })), hasMore: visible.length > maxMessages }
    },
  })
  const plugin = { name: 'worker-skills-fixture', inject, apply(ctx) {
    apply(ctx, { home, github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  } }
  let fiber = root.plugin(plugin)
  await fiber
  const team = () => root.get('omniTeam')
  const owner = async (endpoint, payload = {}) => {
    const response = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result)}`)
    return result.value
  }
  for (const skill of [marker, manual]) assert.deepEqual(await owner('skill-library-save', skill), { saved: true })
  await owner('bot-skill-add', { id: botA, name: marker.name, mode: 'automatic' })
  await owner('bot-skill-add', { id: botA, name: manual.name })
  const a = await harness.create(botA, route, { cwd: home })
  const b = await harness.create(botB, route, { cwd: home })
  const task = async (bot, text = 'Delegate task.') => {
    const previous = new Set(Object.keys(team().state.tasks ?? {}))
    bot.followup(prompt(text))
    await bot.whenIdle()
    const id = await until(() => Object.keys(team().state.tasks ?? {}).find(id => !previous.has(id)), 'task allocated')
    const agent = root.agents.get(id)
    await agent.whenIdle()
    await until(() => team().state.tasks[id]?.status !== 'working', 'task settled')
    return agent
  }
  const start = async (agent, from = botA, text = 'Write an ordinary report.', options = {}) => {
    const begin = () => team().startTask({ from, title: 'Fixture report', text, ...options })
    const id = agent === undefined ? await begin() : await team().inToolCall({ agent }, begin)
    const child = root.agents.get(id)
    await child.whenIdle()
    return child
  }
  return { root, get team() { return team() }, home, owner, requests, a, b, task, start,
    create: id => harness.create(id, route, { cwd: home }),
    async reload() { await fiber.dispose(); fiber = root.plugin(plugin); await fiber; await team().load() },
  }
}

test('2083 task dispatch runs the checked skill and reports the final outcome to its own Bot', async t => {
  const f = await fixture(t)
  const a = await f.task(f.a)
  const b = await f.task(f.b)
  const aRequests = f.requests.filter(row => row.sessionId === a.id)
  const bRequests = f.requests.filter(row => row.sessionId === b.id)
  await until(() => JSON.stringify(f.team.state.exchanges).includes(a.id) ||
    f.a.session.deriveMessages().some(row => row.source?.role === 'task-done'), 'task report delivered')
  assert.ok(sentText(aRequests[0]).includes(catalog), 'A task receives the checked catalog')
  assert.ok(aRequests[0].tools.includes('load_skill'), 'A task can call its skill')
  for (const name of ['list_bots', 'message_bot', 'attach_capability', 'list_capabilities']) {
    assert.ok(!aRequests[0].tools.includes(name), name)
  }
  assert.ok(aRequests.some(request => request.messages.some(row => row.role === 'tool' && textOf(row) === marker.content)))
  assert.ok(aRequests.every(request => !sentText(request).includes(manual.content)))
  assert.deepEqual(activity(a), [marker.name])
  assert.deepEqual(activity(f.a), [])
  assert.equal(f.team.state.tasks[a.id].status, 'done')
  assert.equal(f.team.state.tasks[a.id].summary, 'MARKER-TASK-77')
  assert.ok(!sentText(bRequests[0]).includes(marker.description))
  assert.ok(!bRequests[0].tools.includes('load_skill'))
  assert.ok(bRequests.some(request => request.messages.some(row => row.role === 'tool' && row.isError === true)))
  assert.deepEqual(activity(b), [])
  assert.equal(f.team.state.tasks[b.id].status, 'done')
  assert.equal(f.team.state.tasks[b.id].summary, 'No marker was loaded.')
  for (const [opener, task, result] of [[f.a, a, 'MARKER-TASK-77'], [f.b, b, 'No marker was loaded.']]) {
    const report = await until(() => opener.session.deriveMessages().find(row => row.source?.role === 'task-done' &&
      textOf(row).includes(result)), `report for ${task.id}`)
    assert.ok(textOf(report).includes(result))
  }
  const saved = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).tasks[a.id]
  assert.equal(saved.skillsInstructionsId, a.session.deriveMessages().find(row => textOf(row) === instructions)?.id)
  const roster = await f.owner('state')
  assert.ok(!Object.hasOwn(roster.tasks[a.id], 'skills'))
  assert.ok(!Object.hasOwn(roster.tasks[a.id], 'skillsInstructionsId'))
})

test('2083 DSH child dispatch keeps delegated input Bot-authored and returns the skill result to its parent', async t => {
  const f = await fixture(t)
  let child
  f.root.on('subagent/start', info => { child = f.root.agents.get(info.id) })
  const ended = new Promise(resolve => f.root.on('subagent/end', resolve))
  f.a.followup(prompt('Delegate child.'))
  const outcome = await Promise.race([ended, delay(3000).then(() => undefined)])
  assert.ok(outcome, 'DSH child completed')
  const rows = f.requests.filter(row => row.sessionId === outcome.id)
  assert.equal(child.session.header.origin, 'subagent')
  assert.equal(child.session.header.parentSession, f.a.id)
  assert.ok(sentText(rows[0]).includes(catalog), 'actual child receives the checked catalog')
  assert.ok(rows[0].tools.includes('load_skill'))
  assert.ok(sentText(rows[0]).includes('Write the child report.'))
  assert.ok(rows.every(request => !sentText(request).includes(manual.content) &&
    !sentText(request).includes('use the skill manual-one')))
  const raw = child.session.deriveMessages()
  const replay = f.team.skillCalls.project({ sessionId: child.id, messages: raw },
    { catalog: false, session: child.session, historyOnly: true }).messages
  const replayText = JSON.stringify(replayBlocks(replay, { to: 'Fixture ACP agent' }))
  assert.match(replayText, /Write the child report/)
  assert.doesNotMatch(replayText, /use the skill manual-one|MANUAL-TASK-22/)
  assert.deepEqual(activity(child), [marker.name])
  assert.deepEqual(activity(f.a), [])
  assert.ok(child.session.deriveMessages().some(row => row.role === 'assistant' && textOf(row) === 'MARKER-TASK-77'))
  const report = await until(() => f.a.session.deriveMessages().find(row => row.source?.kind === 'subagent-settled' &&
    textOf(row).includes('MARKER-TASK-77')), 'child result reached its parent')
  assert.ok(report)
})

test('2083 verified opener and group member bind a snapshot while attribution cannot', async t => {
  const f = await fixture(t)
  const unrelated = await f.create('fixture-unrelated')
  const unrelatedTask = await f.start(unrelated, botA, instructions)
  assert.equal(f.team.state.tasks[unrelatedTask.id].skillsOwner, undefined)
  assert.equal(f.team.skillCalls.load(unrelatedTask.id, marker.name), undefined)

  const member = await f.create('fixture-member')
  const task = await f.start(member, botA)
  assert.equal(f.team.state.tasks[task.id].skillsOwner, botA)
  assert.equal(f.team.state.tasks[task.id].levelRoomId, 'fixture-room')
  assert.ok(f.team.skillCalls.catalog(task.id).text.includes(catalog))
  const mismatch = await f.start(task, botB)
  assert.equal(f.team.state.tasks[mismatch.id].levelTaskId, task.id)
  assert.equal(f.team.state.tasks[mismatch.id].skillsOwner, undefined)
  assert.equal(f.team.skillCalls.load(mismatch.id, marker.name), undefined)

  const lift = f.a.ctx.tools.restrict({ allow: ['start_task'] })
  const restricted = await f.start(f.a)
  lift()
  const nested = await f.start(restricted)
  assert.equal(f.team.state.tasks[nested.id].skillsOwner, botA)
  assert.equal(f.team.state.tasks[nested.id].levelTaskId, restricted.id)
  assert.equal(f.team.skillCalls.catalog(nested.id).text, '')
  assert.equal(f.team.skillCalls.load(nested.id, marker.name), undefined)

  const empty = await f.start(f.b, botB, instructions)
  assert.deepEqual(f.team.state.tasks[empty.id].skills, [])
  assert.equal(f.team.state.tasks[empty.id].skillsOwner, botB)
  assert.ok(!empty.session.deriveMessages().some(row => textOf(row).includes('is not active')))
  empty.followup(prompt('/manual-one'))
  await empty.whenIdle()
  assert.ok(empty.session.deriveMessages().some(row => textOf(row).includes('The skill manual-one is not active')))
  unrelated.followup(prompt('/manual-one'))
  await unrelated.whenIdle()
  assert.ok(!unrelated.session.deriveMessages().some(row => textOf(row).includes('The skill manual-one is not active')))
})

test('2083 removals, downgrades and edits keep the original snapshot and cannot revive its eligibility', async t => {
  const f = await fixture(t)
  const a = await f.start(f.a)
  const original = structuredClone(f.team.state.tasks[a.id].skills)
  assert.deepEqual(original.map(pin => pin.name), [marker.name, manual.name])
  const assignment = { id: botA, name: marker.name, mode: 'automatic' }
  await f.owner('bot-skill-remove', assignment)
  await f.owner('bot-skill-add', assignment)
  await f.owner('skill-library-save', late)
  await f.owner('bot-skill-add', { id: botA, name: late.name, mode: 'automatic' })
  assert.equal(f.team.skillCalls.load(a.id, marker.name), undefined, 'identical re-add between requests')
  assert.equal(f.team.skillCalls.load(a.id, late.name), undefined)

  const newer = await f.start(f.a)
  assert.equal(f.team.skillCalls.load(newer.id, marker.name)?.text, marker.content)
  assert.equal(f.team.skillCalls.load(newer.id, late.name)?.text, late.content)
  await f.owner('bot-skill-mode', { ...assignment, mode: 'manual' })
  newer.followup(prompt('/task-marker'))
  await newer.whenIdle()
  assert.ok(newer.session.deriveMessages().some(row => textOf(row).includes('The skill task-marker is not active')))
  assert.ok(f.requests.filter(request => request.sessionId === newer.id).every(request => !sentText(request).includes(marker.content)))

  await f.owner('skill-library-save', { ...late, content: 'Reply with a different note.' })
  assert.equal(f.team.skillCalls.load(newer.id, late.name), undefined)
  await f.owner('skill-library-save', late)
  assert.equal(f.team.skillCalls.load(newer.id, late.name), undefined, 'restoring the old hash cannot revive it')
  await f.owner('bot-skill-mode', assignment)
  await f.reload()
  assert.deepEqual(f.team.state.tasks[a.id].skills, original)
  assert.equal(f.team.skillCalls.catalog(a.id).text, '')
  assert.equal(f.team.skillCalls.catalog(newer.id).text, '')
  const latest = await f.start(f.a)
  assert.equal(f.team.skillCalls.load(latest.id, marker.name)?.text, marker.content)
  assert.equal(f.team.skillCalls.load(latest.id, late.name)?.text, late.content)

  await f.owner('skill-library-save', inactive)
  latest.followup(prompt('/inactive-note'))
  await latest.whenIdle()
  assert.ok(latest.session.deriveMessages().some(row => textOf(row).includes('The skill inactive-note is not active')))
  assert.ok(f.requests.every(request => !sentText(request).includes(inactive.content) && !sentText(request).includes(inactive.description)))
  latest.followup(prompt('/manual-one'))
  await latest.whenIdle()
  assert.ok(f.requests.some(request => request.sessionId === latest.id && sentText(request).includes(manual.content)))
})

test('2083 inherited delivery uses the merged review decision and a later authorized reconfirmation', async t => {
  const f = await fixture(t)
  const existing = await f.start(f.a)
  const path = join(f.home, 'skill-library', 'library.json')
  const data = JSON.parse(readFileSync(path, 'utf8'))
  const record = data.skills[marker.name]
  const hash = record.hash
  const reviewed = structuredClone(data)
  delete record.review
  delete record.reviewSeal
  delete data.reviews[hash]
  writeFileSync(path, JSON.stringify(data))
  const pending = await f.owner('skill-library-get', { name: marker.name })
  assert.equal(pending.hash, hash)
  assert.equal(pending.reviewHash, hash)
  assert.match(pending.held, /model has not reviewed this skill/)
  assert.equal(f.team.skillCalls.load(existing.id, marker.name), undefined)
  const held = await f.start(f.a)
  assert.ok(f.team.state.tasks[held.id].skills.every(pin => pin.name !== marker.name))
  assert.deepEqual(await f.owner('skill-library-save', { name: marker.name, reviewHash: hash }), { saved: true })
  assert.equal((await f.owner('skill-library-get', { name: marker.name })).held, undefined)
  assert.equal(f.team.skillCalls.load(existing.id, marker.name), undefined)
  assert.equal(f.team.skillCalls.load(held.id, marker.name), undefined)
  const current = await f.start(f.a)
  assert.equal(f.team.skillCalls.load(current.id, marker.name)?.text, marker.content)
  reviewed.skills[marker.name].content = 'Different bytes with the original hash.'
  writeFileSync(path, JSON.stringify(reviewed))
  assert.equal(f.team.skillCalls.load(current.id, marker.name), undefined)
})

test('2083 a real task fork cannot replay the withdrawn skill through copied receipts', async t => {
  const f = await fixture(t)
  const task = await f.task(f.a)
  assert.deepEqual(activity(task), [marker.name])
  const receipts = task.session.snapshotEvents().filter(event => event.type === 'plugin:automagik/skill-delivery')
  assert.ok(receipts.length)
  await f.owner('bot-skill-remove', { id: botA, name: marker.name })
  const fork = await f.root.subagents.startActivation({ provider: 'fork', parent: task,
    label: 'Read the prior report', prompt: prompt('Read the prior report.').content,
    delivery: 'caller', signal: t.signal })
  const result = await fork.result
  assert.ok(result, 'actual in-process fork reached a terminal outcome')
  const request = f.requests.find(request => request.sessionId === fork.childId)
  assert.ok(request, 'fork reached the provider')
  assert.ok(!sentText(request).includes(marker.content))
  assert.ok(!sentText(request).includes(marker.description))
  assert.ok(!request.tools.includes('load_skill'))
  task.followup(prompt('Read the prior report.'))
  await task.whenIdle()
  assert.ok(sentText(f.requests.findLast(request => request.sessionId === task.id)).includes(marker.content),
    'the original Session retains already delivered history')
  await fork.dispose()
})

test('2083 the task grants one scoped tool after reload and refuses dispatch if its durable write failed', async t => {
  const f = await fixture(t)
  const a = await f.start(f.a)
  const definitions = agent => f.root.tools.definitions(agent).map(def => def.name)
  const teamOnly = agent => definitions(agent).filter(name => f.team.teamTools.some(def => def.name === name))
  assert.deepEqual(teamOnly(a), ['load_skill'])
  f.team.addTeamTool(defineTool({ name: 'fixture_late', description: 'Late Bot-only tool', parameters: {},
    output: { schema: { type: 'object' }, render: () => [] }, execute: () => ({}) }))
  assert.ok(teamOnly(f.a).includes('fixture_late'))
  assert.deepEqual(teamOnly(a), ['load_skill'])
  await f.reload()
  assert.deepEqual(teamOnly(a), ['load_skill'])
  assert.equal(f.team.skillCalls.load(a.id, marker.name)?.text, marker.content)
  const save = f.team.save
  t.mock.method(f.team, 'save', options => {
    if (options?.durable && Object.values(f.team.state.tasks).some(task =>
      task.summary === undefined && task.skillsInstructionsId !== undefined)) throw new Error('fixture durable write failed')
    return save(options)
  })
  const before = f.requests.length
  await assert.rejects(f.start(f.a, botA, instructions), /fixture durable write failed/)
  assert.equal(f.requests.length, before, 'no dispatch after a failed durable write')
})

test('2083 native programmatic admission and the ACP bridge track child profile changes before dispatch', async t => {
  const f = await fixture(t, { program: true })
  const eligible = await f.start(f.a, botA, instructions)
  const rows = f.requests.filter(request => request.sessionId === eligible.id)
  assert.ok(rows[0].tools.includes('run_code'))
  assert.ok(!rows[0].tools.includes('load_skill'))
  assert.ok(sentText(rows[0]).includes(catalog))
  assert.ok(rows.slice(1).some(request => sentText(request).includes(marker.content)))
  assert.deepEqual(activity(eligible), [marker.name])
  assert.deepEqual(offeredTools(f.root, eligible, { skillOnly: true }).map(tool => tool.name), ['load_skill'])

  const lifts = []
  const off = f.root.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.origin === 'subagent' && !lifts.length) {
      lifts.push(agent.ctx.tools.restrict({ allow: ['fixture_delegate'] }))
      assert.deepEqual(offeredTools(f.root, agent, { skillOnly: true }), [])
      assert.equal(f.team.skillCalls.load(agent.id, marker.name), undefined)
    }
    return next()
  })
  try {
    const child = await f.root.subagents.startActivation({ provider: 'spawn', parent: f.a,
      label: 'Run the limited profile', prompt: prompt(childPrompt).content, delivery: 'caller', signal: t.signal })
    const result = await child.result
    assert.ok(result)
    const requests = f.requests.filter(request => request.sessionId === child.childId)
    assert.ok(requests[0].tools.includes('run_code'))
    assert.ok(requests.every(request => !sentText(request).includes(catalog) && !sentText(request).includes(marker.content)))
    assert.ok(requests.some(request => request.messages.some(row => row.role === 'tool' && row.isError)))
    await child.dispose()
  } finally {
    off()
    for (const lift of lifts) lift()
  }
})
