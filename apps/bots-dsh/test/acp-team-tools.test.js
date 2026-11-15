// RFC 0003 delivery 4, the Bot side: a Bot's team tools are what the ACP bridge offers, a
// call raises the Bot's own DSH approval and posts, and on Auto the bridge call is refused by
// auto-review instead of running. The bridge is simulated at its contract boundary (offer,
// approval under the Session's level, then DSH's tool pipeline); the ACP half is proved in
// apps/acp-dsh/test.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyToolExecutor, inject as toolExecutorInject } from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../index.js'
import { install as installStops } from '../src/host/stops.js'
import { install as installWhoRefused } from '../src/host/who-refused.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

// A read-only Session cannot write files, so the bridge hides the file-only mutators. The
// list repeats apps/acp-dsh/src/host/backchannel.js, which owns it for a real bridge.
const MUTATING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1, permission: 'workspace-write' },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, permission: 'workspace-write' },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, log: [], seq: 0, seen: {} } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-acp-tools-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const sessionOf = (id) => {
    if (!agents.has(id)) {
      const session = Session.create(id)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 0 })
      const calls = []
      agents.set(id, {
        session,
        calls,
        followup(message) { calls.push(message) },
        steer() {}, inject() {}, cancel() {}, whenIdle: async () => {}, inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { id: sessionId, ...sessionOf(sessionId) } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, list: () => [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const askApproval = (sessionId, extra = {}, next = () => 'allowed-once') => ctx.listeners.get('approval/request')[0](
    { agent: { session: { id: sessionId } }, toolName: 'post_to_group', reason: 'Writer: post_to_group', ...extra }, next,
  )
  // The offered set the bridge would list for this Bot at `level` (the ACP side filters the
  // Session's preset tools exactly so; the Bot team registers the team tools into it).
  // The team tools sit in each Bot Session's own scope since v0.3.6 (rt.teamTools), not in the global layer;
  // the Session's assembled list, which the bridge reads, holds both.
  const rt = ctx.provided.get('omniTeam')
  const toolOf = name => ctx.registeredTools.get(name) ?? rt.teamTools.find(tool => tool.name === name)
  const offeredAt = (level) => [...ctx.registeredTools.values(), ...rt.teamTools]
    .filter(tool => level !== 'read-only' || !MUTATING_TOOLS.has(tool.name))
    .map(tool => tool.name)
  // One Manual bridge call, in the order the ACP bridge runs it: the offer check, then the
  // Session level's approval, then the Bot tool. Auto is the real tools pipeline below.
  const bridgeCall = async (sessionId, name, args, { level = 'workspace-write', next } = {}) => {
    assert.ok(offeredAt(level).includes(name), `${name} is offered at ${level}`)
    const session = sessionOf(sessionId).session
    const body = async () => {
      const tool = toolOf(name)
      const value = await tool.execute(args, { agent: { id: sessionId, session }, callId: 'bridge-1' })
      return { isError: false, value }
    }
    const outcome = await askApproval(sessionId, {}, next ?? (() => 'allowed-once'))
    if (outcome !== 'allowed-once') return { isError: true, error: { code: String(outcome).toUpperCase() } }
    return body()
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  await call('state', {})
  return { ctx, agents, sessionOf, call, askApproval, offeredAt, toolOf, bridgeCall, stop }
}

// DSH's real tools service with auto-review's own pre-execute listener. The bridge's call is
// exactly `tools.execute`; this mounts the pipeline the bridge reaches, so the decision is the
// one a production Auto Session gets, not a listener called by hand. The assistant block and
// the tool/call row are what the bridge writes on Auto (RFC 0003 delivery 6).
const REVIEW_ALLOW = '{"risk":"low","decision":"allow"}'
const REVIEW_DENY = '{"risk":"high","decision":"deny","reason":"no"}'
const reviewer = text => (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

async function autoReviewPipeline(tool, agent, decision = 'deny') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin({ apply: applyToolExecutor, inject: toolExecutorInject })
  ctx.provide('approval', { overrideOf: () => 'never', effectivePolicy: () => 'ask', request: async () => 'allowed-once' })
  ctx.provide('permissionPresets', { current: () => 'auto', registerAuto: () => () => {} })
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('workingDirectory', { ensure: async () => '/tmp' })
  ctx.provide('llm', { stream: () => reviewer(decision === 'allow' ? REVIEW_ALLOW : REVIEW_DENY) })
  applyAutoReview(ctx)
  const rt = { ctx, chatOwners: new Map([[agent.id, 'ada'], [agent.session.id, 'ada']]), botOf: id => id === 'ada' ? { id, name: 'ada' } : undefined, state: {} }
  installStops(rt)
  installWhoRefused(rt)
  let ran = false
  ctx.tools.register(defineTool({
    name: tool.name,
    description: tool.description,
    parameters: {
      group: { type: 'string', required: true },
      message: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      ran = true
      return tool.execute(args, exec)
    },
  }))
  return {
    ran: () => ran,
    stops: () => rt.stopsView(),
    async execute(args) {
      const id = 'bridge-1'
      const parameters = { type: 'object', properties: { group: { type: 'string' }, message: { type: 'string' } } }
      agent.session.requestHeader = () => ({ config: { provider: 'acp-claude', model: 'opus' }, tools: [{ name: tool.name, description: tool.description, parameters }] })
      agent.session.append('assistant/message', {
        turn: 1,
        step: 0,
        stream: [],
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id, name: tool.name, arguments: JSON.stringify(args) }],
          source: { provider: 'acp-claude', model: 'opus', bridge: true, synthetic: 'acp-bridge' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('tool/call', { turn: 1, step: 0, callId: id, name: tool.name, arguments: JSON.stringify(args) })
      const batch = await ctx.tools.execute({
        calls: [{ id, name: tool.name, arguments: JSON.stringify(args) }],
        agent,
        signal: new AbortController().signal,
      })
      return batch.results[0].result
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

test('a team tool posts to the Bot\'s group through the bridge, and the call carries the approval row', async (t) => {
  const host = await start()
  t.after(host.stop)
  assert.ok(host.offeredAt('workspace-write').includes('post_to_group'))
  let release
  const pending = host.bridgeCall('b', 'post_to_group', { group: 'Ops', message: 'the report is ready' }, {
    next: () => new Promise((resolve) => { release = resolve }),
  })
  await until(async () => (await host.call('state', {})).value.work.approvals.length > 0)
  // The team view lists the call while it waits, under the Bot whose Session asked.
  const { value } = await host.call('state', {})
  const [approval] = value.work.approvals
  // Since v0.3.6 an approval outside a group races DSH's own card: the team's card can answer it too.
  assert.deepEqual([approval.botId, approval.tool, approval.answerable], ['b', 'post_to_group', true])
  release('allowed-once')
  const result = await pending
  assert.equal(result.isError, false)
  assert.match(result.value, /^Posted in "Ops"/)
  // The call reached the group: with no round running, the group Session takes the post as
  // its next message, the same way a user's message arrives there.
  const room = host.agents.get('r1')
  assert.match(JSON.stringify(room?.calls ?? []), /the report is ready/)
})

test('an Auto Bot\'s team tool goes through auto-review: allow runs, deny refuses with AUTO_REVIEW_DENIED', async (t) => {
  const host = await start()
  t.after(host.stop)
  const tool = host.toolOf('post_to_group')
  const allow = await autoReviewPipeline(tool, { id: 'b', session: host.sessionOf('b').session }, 'allow')
  t.after(() => allow.dispose())
  const allowed = await allow.execute({ group: 'Ops', message: 'reviewed post' })
  assert.equal(allowed.isError, false)
  assert.equal(allow.ran(), true)
  assert.deepEqual(allow.stops(), [])
  assert.match(JSON.stringify(host.agents.get('r1')?.calls ?? []), /reviewed post/)

  const denySession = Session.create('b-deny')
  denySession.append('turn/start', { turn: 1 })
  denySession.append('step/start', { turn: 1, step: 0 })
  const deny = await autoReviewPipeline(tool, { id: 'b', session: denySession }, 'deny')
  t.after(() => deny.dispose())
  const refused = await deny.execute({ group: 'Ops', message: 'denied post' })
  assert.equal(refused.isError, true)
  assert.equal(refused.error.info.code, 'AUTO_REVIEW_DENIED')
  assert.deepEqual(refused.content, [{ type: 'text', text: 'Error: Auto review refused tool "post_to_group" and nobody was asked, because approval prompts are off in this conversation; its body was not executed. The reviewer\'s reason: no' }])
  assert.equal(refused.error.message, 'Auto review rejected tool "post_to_group"; its body was not executed')
  assert.deepEqual(refused.error.info, { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: 'no' })
  assert.equal(deny.ran(), false)
  assert.equal(deny.stops().length, 1)
  assert.equal(deny.stops()[0].why, 'review')
  assert.equal(deny.stops()[0].text, refused.error.info.reason)
  assert.equal(JSON.stringify(host.agents.get('r1')?.calls ?? []).includes('denied post'), false)
  assert.deepEqual((await host.call('state', {})).value.work.approvals, [])
})

test('a read-only Bot is not offered a file-writing tool through the bridge', async (t) => {
  const host = await start()
  t.after(host.stop)
  // A profile's own file tools are part of the same offered set; the bridge hides the ones a
  // read-only sandbox cannot run.
  host.ctx.registeredTools.set('write', { name: 'write' })
  host.ctx.registeredTools.set('edit', { name: 'edit' })
  assert.ok(host.offeredAt('workspace-write').includes('write'))
  assert.equal(host.offeredAt('read-only').includes('write'), false)
  assert.equal(host.offeredAt('read-only').includes('edit'), false)
  // The team tool still is: posting a message is not a file write.
  assert.ok(host.offeredAt('read-only').includes('post_to_group'))
})
