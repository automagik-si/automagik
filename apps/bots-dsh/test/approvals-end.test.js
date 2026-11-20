import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ApprovalService, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { install as approvals } from '../src/host/approvals.js'
import { install as stops } from '../src/host/stops.js'
import { immediate, until } from './until.js'

const ok = () => true

async function bench(t) {
  const ctx = new Context()
  const requests = []
  t.after(async () => {
    for (const { abort } of requests) abort.abort({ kind: 'user' })
    await Promise.allSettled(requests.map(({ answer }) => answer))
    await ctx.fiber.dispose()
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  const approval = ctx.get('approval')
  const sessions = ctx.get('sessions')

  const ada = { id: 'ada', name: 'ada' }, bea = { id: 'bea', name: 'Bea' }, r1 = { id: 'r1', name: 'Ops' }
  const task = { from: 'ada', status: 'working', title: 'T' }
  let gen = { epoch: 1, term: 1 }
  const rt = {
    ctx, state: { tasks: { t1: task } },
    botOf: id => ({ ada, bea })[id],
    roomOf: id => id === 'r1' ? r1 : undefined,
    chatOwners: new Map([['ada-chat', 'ada'], ['bea-chat', 'bea']]),
    groupOwners: new Map([['gs', { botId: 'ada', roomId: 'r1' }], ['gs2', { botId: 'ada', roomId: 'r1' }]]),
    taskOwners: new Map([['run1', { botId: 'ada' }]]),
    extended: { sessionOwner: id => id === 'hook1' ? { botId: 'ada', label: 'H' } : undefined },
    teamGeneration: () => gen,
    warn: (...args) => t.diagnostic(args.join(' ')),
  }
  stops(rt)
  approvals(rt)
  const downstream = new Map()
  ctx.on('approval/request', request => new Promise(resolve => {
    downstream.set(request.callId, resolve)
    request.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }))

  const settled = []
  rt.onApproval((kind, data) => { if (kind === 'settled') settled.push(data) })
  const rows = () => rt.withdrawnView?.() ?? []
  const parent = (id = 't1', meta) => {
    const session = sessions.create(id, { meta })
    setApprovalPolicy(session, 'ask')
    session.append('turn/start', { turn: 1 })
    return session
  }
  const child = (id = 'child', parentSession = 't1') => parent(id, { origin: 'subagent', parentSession })
  let nextCall = 0
  const held = async (session, signal) => {
    const callId = `call-${++nextCall}`
    const abort = new AbortController()
    const requestSignal = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
    const answer = approval.request({ agent: { session }, toolName: 'bash', reason: 'someone', callId, signal: requestSignal })
    requests.push({ abort, answer })
    answer.catch(() => {})
    let entry
    await until(() => {
      entry = rt.approvalsView().find(item => item.callId === callId)
      return entry?.answerable === true
    }, { ms: 5000, poll: immediate })
    assert.equal(entry.sessionId, session.id)
    return { answer, entry, resolveDownstream: downstream.get(callId) }
  }
  const setEpoch = epoch => { gen = { epoch, term: 1 } }
  return { rt, ada, r1, task, parent, child, held, rows, settled, setEpoch }
}

test('rfc0039 [P] A1 task ask withdrawn by system once', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const session = parent()
  const decided = []
  rt.ctx.on('session/event', (source, event) => {
    if (source === session && event.type === 'approval/decided') decided.push(event.data)
  })
  const { answer, entry } = await held(session)
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 1)
  assert.equal(await answer, 'cancelled')
  assert.deepEqual(settled.map(({ decidedBy, why }) => ({ decidedBy, why })), [{ decidedBy: 'system', why: 'task' }])
  const [row] = rows()
  assert.equal(rows().length, 1)
  const { why, taskId, label, botId, botName, sessionId, tool } = row
  assert.deepEqual({ why, taskId, label, botId, botName, sessionId, tool }, {
    why: 'task', taskId: 't1', label: 'T', botId: 'ada', botName: 'ada', sessionId: 't1', tool: 'bash',
  })
  for (const key of ['reason', 'detail', 'epoch']) assert.equal(Object.hasOwn(row, key), false)
  assert.deepEqual(rt.unansweredView?.(), ['t1'])
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 0)
  assert.throws(() => rt.answerApproval(entry.id, 'allow'), { code: 'bot/stale' })
  assert.equal(decided.length, 1)
})

test('rfc0039 [P] A2 child withdrawn with its task parent', async t => {
  const { rt, task, parent, child, held, rows, settled } = await bench(t)
  parent()
  const { answer, entry } = await held(child())
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 1)
  assert.equal(await answer, 'cancelled')
  assert.deepEqual(rows().map(row => [row.id, row.child, row.ownerSessionId, row.why]), [[entry.id, true, 't1', 'task']])
  assert.deepEqual(settled, [])
})

test('rfc0039 [C] A4 DSH cancel keeps dsh and no row', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const abort = new AbortController()
  const { answer } = await held(parent(), abort.signal)
  abort.abort({ kind: 'user' })
  assert.equal(await answer, 'cancelled')
  assert.deepEqual(settled.map(({ decidedBy, why }) => ({ decidedBy, why })), [{ decidedBy: 'dsh', why: undefined }])
  await rt.endApprovals?.('t1', 'task', { task }, ok)
  assert.deepEqual(rows(), [])
})

test('rfc0039 [C] A5 the person answering first wins', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const { answer, entry } = await held(parent())
  rt.answerApproval(entry.id, 'allow')
  assert.equal(await answer, 'allowed-once')
  await rt.endApprovals?.('t1', 'task', { task }, ok)
  assert.deepEqual(settled.map(({ id, decidedBy, why }) => ({ id, decidedBy, why })), [{ id: entry.id, decidedBy: 'web', why: undefined }])
  assert.deepEqual(rows(), [])
})

test('rfc0039 [C] A6 run and hook asks never withdrawn', async t => {
  const { rt, task, parent, held, rows } = await bench(t)
  const run = await held(parent('run1'))
  const hook = await held(parent('hook1'))
  assert.notEqual(run.entry.id, hook.entry.id)
  await rt.endApprovals?.(['run1', 'hook1'], 'task', { task }, ok)
  assert.deepEqual(rt.approvalsView().map(row => row.id), [run.entry.id, hook.entry.id])
  for (const { entry, answer } of [run, hook]) {
    rt.answerApproval(entry.id, 'allow')
    assert.equal(await answer, 'allowed-once')
  }
  assert.deepEqual(rows(), [])
})

test('rfc0039 [P] A9 rows and unanswered ids are bounded', async t => {
  const { rt, parent, held, rows } = await bench(t)
  let elapsed = 0
  const now = Date.now
  t.mock.method(Date, 'now', () => now() + elapsed)
  const end = async n => {
    const id = `t${n}`
    const task = rt.state.tasks[id] ??= { from: 'ada', status: 'working', title: id }
    const { answer } = await held(parent(id))
    assert.equal(await rt.endApprovals?.(id, 'task', { task }, ok), 1)
    assert.equal(await answer, 'cancelled')
  }
  for (let n = 1; n <= 51; n += 1) await end(n)
  assert.deepEqual(rows().map(row => row.taskId), Array.from({ length: 50 }, (_, i) => `t${i + 2}`))
  elapsed = 6 * 60 * 60 * 1000
  assert.deepEqual(rows(), [])
  for (let n = 52; n <= 501; n += 1) await end(n)
  assert.deepEqual(rt.unansweredView?.(), Array.from({ length: 500 }, (_, i) => `t${i + 2}`))
})

test('rfc0039 [P] A10 epoch scopes asks and rows', async t => {
  const { rt, task, parent, held, rows, setEpoch } = await bench(t)
  const first = await held(parent())
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 1)
  assert.equal(await first.answer, 'cancelled')
  assert.deepEqual(rows().map(row => row.id), [first.entry.id])
  assert.deepEqual(rt.unansweredView?.(), ['t1'])
  const secondTask = rt.state.tasks.t2 = { ...task }
  const second = await held(parent('t2'))
  assert.notEqual(first.entry.id, second.entry.id)
  setEpoch(2)
  assert.deepEqual(rows(), [])
  assert.deepEqual(rt.unansweredView?.(), [])
  assert.equal(await rt.endApprovals?.('t2', 'task', { task: secondTask }, ok), 0)
  assert.deepEqual(rt.approvalsView().map(row => row.id), [second.entry.id])
  rt.answerApproval(second.entry.id, 'allow')
  assert.equal(await second.answer, 'allowed-once')
})

test('rfc0039 [P] A12 ask belongs to its admission task record', async t => {
  const { rt, task, parent, child, held } = await bench(t)
  const own = await held(parent())
  const sub = await held(child())
  assert.notEqual(own.entry.id, sub.entry.id)
  const replacement = rt.state.tasks.t1 = { ...task }
  assert.equal(await rt.endApprovals?.('t1', 'task', { task: replacement }, ok), 0)
  assert.deepEqual(rt.approvalsView().map(row => row.id), [own.entry.id, sub.entry.id])
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 2)
  assert.deepEqual(await Promise.all([own.answer, sub.answer]), ['cancelled', 'cancelled'])
})

test('rfc0039 [P] A13 ask answered during a withdrawal keeps the answer and gets no row', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const session = parent()
  const x = await held(session)
  const y = await held(session)
  assert.notEqual(x.entry.id, y.entry.id)
  rt.onApproval((kind, data) => {
    if (kind === 'settled' && data.id === x.entry.id && data.decidedBy === 'system') rt.answerApproval(y.entry.id, 'allow')
  })
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 1)
  assert.deepEqual(await Promise.all([x.answer, y.answer]), ['cancelled', 'allowed-once'])
  assert.deepEqual(settled.map(({ id, decidedBy, why }) => [id, decidedBy, why]), [
    [x.entry.id, 'system', 'task'], [y.entry.id, 'web', undefined],
  ])
  assert.deepEqual(rows().map(row => row.id), [x.entry.id])
})

test('rfc0039 [P] A14 withdrawal stops when its operation no longer holds', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const session = parent()
  const x = await held(session)
  const y = await held(session)
  assert.notEqual(x.entry.id, y.entry.id)
  let holds = true
  rt.onApproval((kind, data) => {
    if (kind === 'settled' && data.id === x.entry.id) holds = false
  })
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, () => holds), 0)
  assert.equal(await x.answer, 'cancelled')
  assert.deepEqual(settled.map(({ id, decidedBy, why }) => [id, decidedBy, why]), [[x.entry.id, 'system', 'task']])
  assert.deepEqual(rows(), [])
  assert.deepEqual(rt.approvalsView().map(row => row.id), [y.entry.id])
  rt.answerApproval(y.entry.id, 'allow')
  assert.equal(await y.answer, 'allowed-once')
})

test('rfc0039 [C] A15 only a task end withdraws in D3a', async t => {
  const { rt, ada, r1, parent, held, rows } = await bench(t)
  const own = await held(parent('ada-chat'))
  const seat = await held(parent('gs'))
  assert.notEqual(own.entry.id, seat.entry.id)
  await rt.endApprovals?.('ada-chat', 'part', { bot: ada }, ok)
  await rt.endApprovals?.('ada-chat', 'bot', { bot: ada }, ok)
  await rt.endApprovals?.('gs', 'part', { bot: ada, room: r1 }, ok)
  assert.deepEqual(rt.approvalsView().map(row => row.id), [own.entry.id, seat.entry.id])
  assert.deepEqual(rows(), [])
  for (const { entry, answer } of [own, seat]) {
    rt.answerApproval(entry.id, 'allow')
    assert.equal(await answer, 'allowed-once')
  }
})

test('rfc0039 [P] A16 a DSH answer given before the withdrawal keeps its answer', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const session = parent()
  const x = await held(session)
  const y = await held(session)
  assert.notEqual(x.entry.id, y.entry.id)
  rt.onApproval((kind, data) => {
    if (kind === 'settled' && data.id === x.entry.id && data.decidedBy === 'system') y.resolveDownstream('allowed-once')
  })
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 1)
  assert.deepEqual(await Promise.all([x.answer, y.answer]), ['cancelled', 'allowed-once'])
  assert.deepEqual(settled.map(({ id, decidedBy, why }) => [id, decidedBy, why]), [
    [x.entry.id, 'system', 'task'], [y.entry.id, 'dsh', undefined],
  ])
  assert.deepEqual(rows().map(row => row.id), [x.entry.id])
})

test('rfc0039 [P] A17 a DSH answer resolved just before the task end is adopted', async t => {
  const { rt, task, parent, held, rows, settled } = await bench(t)
  const { answer, entry, resolveDownstream } = await held(parent())
  resolveDownstream('allowed-once')
  assert.equal(await rt.endApprovals?.('t1', 'task', { task }, ok), 0)
  assert.equal(await answer, 'allowed-once')
  assert.deepEqual(settled.map(({ id, decidedBy, why }) => [id, decidedBy, why]), [[entry.id, 'dsh', undefined]])
  assert.deepEqual(rows(), [])
})
