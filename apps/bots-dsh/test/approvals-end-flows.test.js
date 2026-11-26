import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

async function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-approval-end-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'], bots: { a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1 } },
    tasks: { t1: { title: 'Fix', from: 'a', status: 'working', at: 1 } },
    rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }))
  const ctx = fakeContext()
  const requests = []
  t.after(async () => {
    for (const { abort } of requests) abort.abort({ kind: 'user' })
    await Promise.allSettled(requests.map(({ answer }) => answer))
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const agents = new Map()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined },
    sessionController: { resolveAgent: async id => {
      if (!agents.has(id)) agents.set(id, { ...ctx.scopeAgent(id), followup() {}, steer() {} })
      return { agent: agents.get(id) }
    } },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const held = (id, callId, extra) => {
    const abort = new AbortController()
    const signal = extra?.signal === undefined ? abort.signal : AbortSignal.any([extra.signal, abort.signal])
    const request = { agent: { session: { id } }, toolName: 'bash', reason: 'escalate sandbox', callId, ...extra, signal }
    const answer = ctx.listeners.get('approval/request')[0](request, () => new Promise(resolve => {
      if (request.signal.aborted) resolve('cancelled')
      else request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
    }))
    requests.push({ abort, answer })
    const entry = rt.approvalsView().find(item => item.callId === callId)
    assert.equal(entry?.sessionId, id)
    assert.equal(entry.answerable, true)
    return { answer, entry }
  }
  const settled = []
  rt.onApproval((kind, data) => { if (kind === 'settled') settled.push(data) })
  await rt.teamTools.find(tool => tool.name === 'list_bots').execute({}, { agent: { id: 'a' } })
  assert.equal(rt.holdsLock(), true)
  return { home, rt, emit, call, held, settled }
}

const reports = settled => settled.map(({ id, decidedBy, why }) => [id, decidedBy, why])
const liveIds = rt => rt.approvalsView().map(entry => entry.id)

async function drainWithdrawals() {
  // Give the task end time to start a batch and the batch time to yield before settling an ask.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('rfc0039 [P] B1 task end withdraws pending asks', async t => {
  const { rt, emit, call, held, settled } = await start(t)
  const own = held('t1', 'own')
  const child = held('k', 'k1', { agent: { session: { id: 'k', header: { origin: 'subagent', parentSession: 't1' } } } })
  assert.notEqual(own.entry.id, child.entry.id)
  emit('t1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => (rt.withdrawnView?.() ?? []).length === 2, { ms: 5000 })
  assert.deepEqual(await Promise.all([own.answer, child.answer]), ['cancelled', 'cancelled'])
  assert.deepEqual(reports(settled), [[own.entry.id, 'system', 'task']])
  const { value } = await call('state')
  assert.equal(value.tasks.t1.status, 'done')
  assert.deepEqual(value.work.unanswered, ['t1'])
  assert.deepEqual(value.work.withdrawn.map(row => [row.id, row.why, row.taskId, row.child, row.ownerSessionId]), [
    [own.entry.id, 'task', 't1', undefined, undefined],
    [child.entry.id, 'task', 't1', true, 't1'],
  ])
  assert.deepEqual(value.work.approvals, [])
  for (const ask of [own, child]) {
    assert.equal((await call('approval-answer', { id: ask.entry.id, choice: 'allow' })).error.code, 'bot/stale')
  }
})

test('rfc0039 [C] B2a DSH abort first keeps dsh', async t => {
  const { rt, emit, call, held, settled } = await start(t)
  const abort = new AbortController()
  const { answer, entry } = held('t1', 'own', { signal: abort.signal })
  const chat = held('a', 'chat')
  abort.abort({ kind: 'user' })
  emit('t1', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  await rt.save()
  await drainWithdrawals()
  assert.deepEqual(liveIds(rt), [chat.entry.id])
  assert.deepEqual(rt.withdrawnView?.() ?? [], [])
  assert.equal(await answer, 'cancelled')
  assert.deepEqual(reports(settled), [[entry.id, 'dsh', undefined]])
  const { value } = await call('state')
  assert.equal(value.tasks.t1.status, 'stopped')
  assert.deepEqual(value.work.unanswered ?? [], [])
  assert.deepEqual(value.work.withdrawn ?? [], [])
  rt.answerApproval(chat.entry.id, 'allow')
  assert.equal(await chat.answer, 'allowed-once')
})

test('rfc0039 [C] B2b disposed turn end withdraws nothing', async t => {
  const { rt, emit, held } = await start(t)
  const { answer, entry } = held('t1', 'own')
  emit('t1', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  await rt.save()
  await drainWithdrawals()
  assert.equal(rt.state.tasks.t1.status, 'working')
  assert.deepEqual(liveIds(rt), [entry.id])
  assert.deepEqual(rt.withdrawnView?.() ?? [], [])
  rt.answerApproval(entry.id, 'allow')
  assert.equal(await answer, 'allowed-once')
})

test('rfc0039 [C] B2c task end after lock loss withdraws nothing', async t => {
  const { home, rt, emit, held } = await start(t)
  const { answer, entry } = held('t1', 'own')
  writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'new-owner' }))
  emit('t1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await rt.save()
  await drainWithdrawals()
  assert.equal(rt.state.tasks.t1.status, 'done')
  assert.deepEqual(liveIds(rt), [entry.id])
  assert.deepEqual(rt.withdrawnView?.() ?? [], [])
  rt.answerApproval(entry.id, 'allow')
  assert.equal(await answer, 'allowed-once')
})

test('rfc0039 [C] B2d task end with a failed save withdraws nothing', async t => {
  const { home, rt, emit, held } = await start(t)
  const { answer, entry } = held('t1', 'own')
  const warnings = []
  const original = rt.warn
  t.mock.method(rt, 'warn', (...args) => { warnings.push(args); original(...args) })
  mkdirSync(join(home, `state.json.${process.pid}.tmp`))
  emit('t1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await until(() => warnings.some(([message]) => message === 'ds-bot: saving a task failed: %s'), { ms: 5000 })
  await drainWithdrawals()
  assert.equal(rt.state.tasks.t1.status, 'done')
  assert.deepEqual(liveIds(rt), [entry.id])
  assert.deepEqual(rt.withdrawnView?.() ?? [], [])
  rt.answerApproval(entry.id, 'allow')
  assert.equal(await answer, 'allowed-once')
})
