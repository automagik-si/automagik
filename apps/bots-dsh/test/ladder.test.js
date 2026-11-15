import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../index.js'
import { install, askText, questionText, hardNever, stopNever, stopPerson, KEEP_WORKING } from '../src/host/ladder.js'
import { refusalCounter } from '../src/host/auto-judge.js'
import { TEAM_LOOKUPS } from '../src/host/approvals.js'
import { REMOTE_TOOL, remoteApproval } from '../src/host/remote-chat-adapter.js'
import { fakeContext } from './fake-ctx.js'

const allow = { kind: 'allow' }
const denied = { value: { sandbox: { denied: true } } }
function world({ policy = 'ask', full = false, auto = false, answer = 'allowed-once', ctx = fakeContext() } = {}) {
  const requests = []; const stops = []
  ctx.provide('approval', { effectivePolicy: () => policy, request: async request => { requests.push(request); return answer } })
  ctx.provide('permissionPresets', {})
  const bot = { id: 'ada', name: 'ada' }
  const rt = { ctx, state: { tasks: {} }, chatOwners: new Map([['ada', 'ada']]), groupOwners: new Map(),
    botOfSession: () => bot, botOf: () => bot, sessionWide: () => full, autoCounts: () => auto,
    noteStop: (...args) => stops.push(args), warn: (...args) => assert.fail(String(args)) }
  install(rt)
  let serial = 0
  const exec = (patch = {}) => ({ name: 'bash', arguments: { command: 'ls' }, agent: { session: { id: 'ada' } }, callId: `x${++serial}`, ...patch })
  const pre = (call, decision = allow) => ctx.listeners.get('tools/pre-execute')[0](call, () => decision)
  const post = (call = exec(), result = denied, decision = allow) => ctx.listeners.get('tools/post-execute')[0](call, result, () => decision)
  const event = (type, data, session = { id: 'ada' }) => ctx.listeners.get('session/event')[0](session, { type, data })
  return { rt, ctx, exec, pre, post, event, requests, stops }
}

test('D1 Workspace asks before a recursive delete', async () => {
  const w = world()
  assert.deepEqual(await w.pre(w.exec({ arguments: { command: 'rm -rf build' } })), { kind: 'ask', reason: askText('bash: rm -rf build') })
})
test('D read-only team lookups do not ask about hard-step text in their arguments', async () => {
  const w = world()
  for (const tool of TEAM_LOOKUPS) {
    for (const name of [tool, `mcp__dsh__${tool}`]) {
      assert.equal(await w.pre(w.exec({ name, arguments: { query: 'rm -rf x' } })), allow, name)
    }
  }
  assert.deepEqual([w.requests, w.stops], [[], []])
})
test('D2 Full access leaves a hard step alone', async () => {
  const w = world({ full: true, policy: 'never' })
  assert.equal(await w.pre(w.exec({ arguments: { command: 'rm -rf x' } })), allow)
  assert.deepEqual([w.requests, w.stops], [[], []])
})
test('D2b a Remote Hermes mirror card is left alone at every level, and only what Hermes asks is asked', async () => {
  // The step runs on the other computer under Hermes's rules: a question here could not stop it.
  const hard = { id: 'tool-a', title: 'terminal', input: { command: 'rm -rf build' } }
  for (const [level, options] of [['asking', {}], ['never-ask', { policy: 'never' }], ['Full access', { policy: 'never', full: true }]]) {
    const w = world(options)
    assert.equal(await w.pre(w.exec({ name: REMOTE_TOOL, arguments: hard })), allow, level)
    assert.deepEqual([w.requests, w.stops], [[], []], level)
  }
  const w = world()
  // The same step in a tool of this computer is still asked about.
  assert.equal((await w.pre(w.exec({ name: 'terminal', arguments: hard.input }))).kind, 'ask')
  // Hermes's own question reaches the person in its own words, and the answer goes back.
  assert.equal(await remoteApproval(w.ctx, { session: { id: 'ada' } }, { request_id: 'approval-1', description: 'Delete the folder build' }), 'once')
  assert.deepEqual(w.requests.map(request => [request.toolName, request.callId, request.reason]), [[REMOTE_TOOL, 'approval-1', 'Remote Hermes: Delete the folder build']])
})
test('D3 an inner deny cannot become an overridable ask', async () => {
  const w = world(); const deny = { kind: 'deny', reason: 'x' }
  assert.equal(await w.pre(w.exec({ arguments: { command: 'rm -rf x' } }), deny), deny)
})
test('D4 a child under never refuses the hard step and notes why', async () => {
  const w = world({ policy: 'never' })
  const call = w.exec({ agent: { session: { id: 'x', header: { origin: 'subagent', parentSession: 'ada' } } }, arguments: { command: 'rm -rf x' } })
  assert.deepEqual(await w.pre(call), { kind: 'deny', reason: hardNever('bash: rm -rf x') })
  assert.equal(w.stops.length, 1)
  assert.equal(w.stops[0][1].why, 'never')
  assert.equal(w.requests.length, 0)
})
test('D5 the bridge person approval prevents a second hard ask', async () => {
  const w = world(); const call = w.exec({ arguments: { command: 'rm -rf x' } })
  w.event('approval/asked', { id: 'x', callId: call.callId, toolName: 'bash' })
  w.event('approval/decided', { id: 'x', outcome: 'allowed-once' })
  assert.equal(await w.pre(call), allow)
})
test('D6 the fourth refusal asks to continue without changing the refused result', async () => {
  const w = world()
  for (let i = 0; i < 3; i++) await w.post()
  assert.equal(w.requests.length, 0)
  const call = w.exec()
  assert.equal(await w.post(call), allow)
  assert.equal(w.requests.length, 1)
  assert.equal(w.requests[0].toolName, KEEP_WORKING)
  assert.equal(w.requests[0].callId, call.callId)
  assert.equal(w.requests[0].reason, questionText('ada', 4, 'bash'))
  for (let i = 0; i < 3; i++) await w.post()
  assert.equal(w.requests.length, 1)
})
test('D7 the person stops the turn until turn end', async () => {
  const w = world({ answer: 'rejected' })
  for (let i = 0; i < 3; i++) await w.post()
  assert.deepEqual(await w.post(), { kind: 'block', feedback: [{ type: 'text', text: stopPerson(4) }] })
  const pre = w.ctx.listeners.get('tools/pre-execute')[0]
  assert.deepEqual(await pre(w.exec(), () => assert.fail('stopped call reached next')), { kind: 'deny', reason: stopPerson(4) })
  assert.equal(w.stops.length, 0)
  w.event('turn/end')
  assert.equal(await w.pre(w.exec()), allow)
})
test('D8 ten separated refusals ask on the eleventh', async () => {
  const w = world()
  for (let i = 0; i < 10; i++) { await w.post(); await w.post(w.exec(), {}) }
  assert.equal(w.requests.length, 0)
  await w.post()
  assert.equal(w.requests[0].reason, questionText('ada', 11, 'bash'))
})
test('D9 never stops at the fourth refusal without asking', async () => {
  const w = world({ policy: 'never' })
  for (let i = 0; i < 3; i++) await w.post()
  assert.deepEqual(await w.post(), { kind: 'block', feedback: [{ type: 'text', text: stopNever(4) }] })
  assert.equal(w.stops[0][1].why, 'never')
  assert.equal(w.requests.length, 0)
})
test('D10 Auto keeps its counts while hard steps still ask', async () => {
  const w = world({ auto: true })
  for (let i = 0; i < 5; i++) await w.post()
  assert.equal(w.requests.length, 0)
  assert.equal((await w.pre(w.exec({ arguments: { command: 'rm -rf x' } }))).kind, 'ask')
})
test('D11 a keep-working question about a lookup reaches the person', async t => {
  const home = mkdtempSync(join(tmpdir(), 'ladder-'))
  const ctx = fakeContext()
  apply(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const hooks = [...ctx.listeners.get('approval/request')].reverse()
  const request = { agent: { session: { id: 'ada' } }, toolName: KEEP_WORKING, callId: 'x', reason: questionText('ada', 4, 'list_bots') }
  const step = i => () => i < hooks.length ? hooks[i](request, step(i + 1)) : 'person'
  assert.equal(await step(0)(), 'person')
})
test('D12 the real pipeline asks before a hard body and rejection never runs it', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  t.after(() => ctx.fiber.dispose())
  const w = world({ ctx, answer: 'rejected' })
  let ran = false
  ctx.tools.register(defineTool({ name: 'bash', description: 'x', parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { ran = true; return 'x' } }))
  const agent = { session: { id: 'ada' } }
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal })
  t.after(() => toolSet.dispose())
  const batch = await ctx.tools.execute({ calls: [{ id: 'x', name: 'bash', arguments: { command: 'rm -rf x' } }], agent, signal, toolSet })
  assert.equal(ran, false)
  assert.equal(batch.results[0].result.isError, true)
  assert.equal(w.requests[0].reason, askText('bash: rm -rf x'))
})
test('D13 refusalCounter resets the row independently from the total', () => {
  const counter = refusalCounter()
  for (let i = 0; i < 3; i++) counter.refused('ada')
  assert.equal(counter.tripped('ada'), true)
  counter.allowed('ada')
  assert.equal(counter.tripped('ada'), false)
  for (let i = 0; i < 7; i++) { counter.refused('ada'); counter.allowed('ada') }
  assert.equal(counter.total('ada'), 10)
  assert.equal(counter.tripped('ada'), true)
  counter.reset('ada')
  assert.equal(counter.total('ada'), 0)
  assert.equal(counter.tripped('ada'), false)
})


test('Read only refuses Office outputs; only Full access may read user terminals', async () => {
  const w = world()
  w.ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only' }) })
  for (const tool of ['office_convert', 'office_recalculate', 'office_render']) for (const name of [tool, `mcp__dsh__${tool}`]) {
    const result = await w.pre(w.exec({ name, arguments: { input: 'document.xlsx' } }))
    assert.equal(result.kind, 'deny', name)
    assert.match(result.reason, /Read only/)
  }
  for (const mode of ['read-only', 'workspace-write']) {
    w.ctx.provide('sandboxPolicy', { resolve: () => ({ mode }) })
    for (const tool of ['user_terminal_list', 'user_terminal_read']) for (const name of [tool, `mcp__dsh__${tool}`]) {
      const result = await w.pre(w.exec({ name, arguments: {} }))
      assert.equal(result.kind, 'deny', `${mode}: ${name}`)
      assert.match(result.reason, /Only Full access/)
    }
  }
  assert.equal(w.requests.length, 0, 'a read-only refusal never asks for an override')
  w.ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  for (const name of ['office_convert', 'office_recalculate', 'office_render']) assert.equal(await w.pre(w.exec({ name, arguments: { input: 'document.xlsx' } })), allow, name)
  w.rt.sessionWide = () => true
  for (const name of ['user_terminal_list', 'user_terminal_read']) assert.equal(await w.pre(w.exec({ name, arguments: {} })), allow, name)
})

import * as extensions1092 from '../src/host/extend.js'
for (const full of [false, true]) test(`#1092 the new hard categories ${full ? 'pass at Full access' : 'ask at Workspace'}`, async () => {
  const w = world({ full })
  w.rt.sessionFolder = session => { assert.equal(session.id, 'ada'); return '/w/repo' }
  for (const command of ['cat .env', 'sendmail a@b', 'git push origin main', 'rm ../x']) {
    const result = await w.pre(w.exec({ arguments: { command } }))
    assert.deepEqual(result, full ? allow : { kind: 'ask', reason: askText(`bash: ${command}`) })
  }
  extensions1092.install(w.rt)
  w.rt.stepHooks.sendsOutside(({ tool }) => tool === 'team_send')
  assert.deepEqual(await w.pre(w.exec({ name: 'team_send', arguments: {} })), full ? allow : { kind: 'ask', reason: askText('team_send') })
})
test('#1092 a missing folder does not hide an absolute delete', async () => {
  const w = world()
  w.rt.sessionFolder = () => { throw new Error('missing folder') }
  assert.deepEqual(await w.pre(w.exec({ arguments: { command: 'rm /tmp/x' } })), { kind: 'ask', reason: askText('bash: rm /tmp/x') })
})
