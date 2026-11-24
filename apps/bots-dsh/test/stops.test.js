import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ApprovalService, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { install, STOP_WHYS, STOP_KEEP_MS, STOPS_MAX, CALLS_MAX, WHY_EN, stopLineEn } from '../src/host/stops.js'
import { install as extend } from '../src/host/extend.js'

function bench({ policy = 'ask', overrideOf, headers = {} } = {}) {
  const handlers = new Map()
  const failures = []
  let appends = 0
  const session = id => ({ id, header: headers[id], append() { appends += 1; throw new Error('no append') } })
  const rt = {
    ctx: { on: (event, fn) => handlers.set(event, fn), get: () => ({ overrideOf: overrideOf ?? (s => (typeof s === 'object' && s !== null ? policy : undefined)), config: { policy: 'ask' } }), sessions: { get: session } },
    state: { tasks: {} }, chatOwners: new Map([['ada-chat', 'ada']]), groupOwners: new Map(), taskOwners: new Map(), pastOwners: new Map(), roomWaiters: new Map(),
    botOf: id => id === 'ada' ? { id, name: 'ada' } : undefined,
    noteFailure: failure => failures.push(failure),
  }
  install(rt)
  const emit = (id, type, data = {}) => handlers.get('session/event')(session(id), { type, data })
  const pair = (id, callId, outcome, toolName = 'bash') => {
    emit(id, 'approval/asked', { id: 'ask-' + callId, callId, toolName })
    emit(id, 'approval/decided', { id: 'ask-' + callId, outcome })
  }
  const result = (id, callId, args, value, { name = 'bash', code, reason } = {}) => handlers.get('tools/result')(
    { agent: { id, session: session(id) }, callId, name, arguments: args },
    code ? { isError: true, error: { info: { code, reason } } } : { isError: false, value },
  )
  return { rt, emit, pair, result, failures, appends: () => appends }
}

test('a never child stop follows the header to ada and never appends', () => {
  const b = bench({ policy: 'never', headers: { child: { origin: 'subagent', parentSession: 'ada-chat' } } })
  b.emit('ada-chat', 'turn/start', { turn: 1 })
  b.pair('child', 'x', 'rejected')
  const [entry] = b.rt.stopsView()
  assert.equal(entry.botId, 'ada')
  assert.equal(entry.sessionId, 'ada-chat')
  assert.equal(entry.child, true)
  assert.equal(entry.why, 'never')
  assert.deepEqual(entry.calls, [{ sessionId: 'child', callId: 'x' }])
  assert.equal(b.appends(), 0)
  assert.equal(b.rt.stopLineOfTurn('ada-chat', 1), 'A subagent step did not run: ' + WHY_EN.never)
  b.pair('ada-chat', 'y', 'rejected')
  assert.equal(b.rt.stopsView().length, 1)
  assert.equal(b.rt.stopsView()[0].count, 2)
  assert.deepEqual(b.rt.stopsView()[0].calls, [{ sessionId: 'child', callId: 'x' }, { sessionId: 'ada-chat', callId: 'y' }])
})

test('ask outcomes and an unreadable policy never turn a person’s no into a stop', () => {
  for (const overrideOf of [undefined, () => { throw new Error('x') }]) {
    const b = bench({ overrideOf })
    for (const outcome of ['rejected', 'cancelled', 'allowed-once']) b.pair('ada-chat', outcome, outcome)
    assert.deepEqual(b.rt.stopsView(), [])
    b.pair('ada-chat', 'x', 'unavailable')
    assert.equal(b.rt.stopsView()[0].why, 'unavailable')
  }
})

test('ownership resolves seats, tasks, runs, earlier parts, and bounded lineage', () => {
  const { rt } = bench({ headers: { child: { origin: 'subagent', parentSession: 'seat' }, 'task-child': { origin: 'subagent', parentSession: 'task' }, loop: { origin: 'subagent', parentSession: 'loop' } } })
  rt.groupOwners.set('seat', { botId: 'ada', roomId: 'x' })
  rt.state.tasks.task = { from: 'ada', title: 'someone' }
  rt.taskOwners.set('run', { botId: 'ada' })
  rt.taskOwners.set('ask', { botId: 'ada' })
  rt.state.subscriptionRuns = [{ id: 'x', sessionId: 'run', subId: 'x', botId: 'ada', task: true }, { id: 'y', sessionId: 'ask', botId: 'ada', task: true }]
  rt.state.subscriptions = { x: { name: '  someone  ' } }
  rt.pastOwners.set('part', { botId: 'ada', roomId: 'x' })
  assert.deepEqual(rt.teamOwnerOf('child'), { kind: 'group', botId: 'ada', roomId: 'x', sessionId: 'seat', child: true })
  assert.deepEqual(rt.teamOwnerOf('task-child'), { kind: 'task', botId: 'ada', taskId: 'task', label: 'someone', sessionId: 'task', child: true })
  assert.deepEqual(rt.teamOwnerOf('run'), { kind: 'run', botId: 'ada', taskId: 'run', label: 'someone', run: true, sessionId: 'run' })
  assert.equal(rt.teamOwnerOf('ask').label, '')
  rt.state.subscriptionRuns = 'x'
  assert.equal(rt.teamOwnerOf('run').label, '')
  assert.equal(rt.teamOwnerOf('part').kind, 'part')
  assert.equal(rt.teamOwnerOf('x'), undefined)
  assert.equal(rt.teamOwnerOf('loop'), undefined)
  rt.groupOwners.set('ada-chat', { botId: 'someone', roomId: 'x' })
  assert.equal(rt.teamOwnerOf('ada-chat').kind, 'chat', 'a departed Bot does not win')
})

test('merge by owner turn and reason, count calls once, and diagnose only the first', () => {
  const b = bench()
  b.emit('ada-chat', 'turn/start', { turn: 1 })
  for (const callId of ['x', 'x', 'y']) b.rt.noteStop('ada-chat', { why: 'tool', tool: 'bash', callId })
  assert.equal(b.rt.stopsView()[0].count, 2)
  assert.equal(b.failures.length, 1)
  b.emit('ada-chat', 'turn/start', { turn: 2 })
  b.rt.noteStop('ada-chat', { why: 'tool', callId: 'z' })
  assert.equal(b.rt.stopsView().length, 2)
  assert.equal(b.failures.length, 2)
  b.emit('ada-chat', 'turn/start', { turn: 3 })
  for (const why of ['address', 'review']) b.rt.noteStop('ada-chat', { why, callId: why })
  assert.deepEqual(b.rt.stopsView().slice(2).map(e => [e.why, e.count]), [['address', 1], ['review', 1]])
  assert.equal(b.rt.stopLineOfTurn('ada-chat', 3), `A step did not run: ${WHY_EN.address} · A step did not run: ${WHY_EN.review}`)
})

const denied = { sandbox: { denied: true } }
test('sandbox denials wait for turn end; only their own paired escalation clears them', () => {
  for (const variant of ['alone', 'other-command', 'same', 'again', 'no-pair', 'other-tool', 'other-session']) {
    const b = bench()
    b.result('ada-chat', 'x', { command: 'x', workdir: 'x', description: 'someone' }, denied)
    assert.deepEqual(b.rt.stopsView(), [])
    if (variant !== 'alone') {
      const id = variant === 'other-session' ? 'someone' : 'ada-chat'
      if (variant !== 'no-pair') b.pair(id, 'retry', 'allowed-once')
      b.result(id, 'retry', { command: variant === 'other-command' ? 'y' : 'x', workdir: 'x', description: 'x', sandbox_permissions: 'require_escalated' }, variant === 'again' ? denied : {}, { name: variant === 'other-tool' ? 'pwsh' : 'bash' })
    }
    b.emit('ada-chat', 'turn/end')
    assert.equal(b.rt.stopsView().length, variant === 'same' ? 0 : 1, variant)
    if (variant === 'again') assert.equal(b.rt.stopsView()[0].calls[0].callId, 'retry')
  }
})

test('file escalation fingerprints ignore justification and argument order', () => {
  const b = bench()
  b.result('ada-chat', 'x', { path: 'x', changes: { old: 'x', new: 'y' }, description: 'someone' }, undefined, { name: 'edit', code: 'FS_SANDBOX_DENIED' })
  b.pair('ada-chat', 'retry', 'allowed-once', 'edit')
  b.result('ada-chat', 'retry', { changes: { new: 'y', old: 'x' }, path: 'x', sandbox_permissions: 'require_escalated', justification: 'x' }, {}, { name: 'edit' })
  b.emit('ada-chat', 'turn/end')
  assert.deepEqual(b.rt.stopsView(), [])
})

test('review stops are immediate with the reason; file denials wait; plain errors do nothing', () => {
  const b = bench()
  b.result('ada-chat', 'x', {}, undefined, { code: 'AUTO_REVIEW_DENIED', reason: 'someone\nsaid no' })
  assert.equal(b.rt.stopsView()[0].why, 'review')
  assert.equal(b.rt.stopsView()[0].text, 'someone said no')
  b.result('ada-chat', 'y', {}, undefined, { name: 'edit', code: 'FS_SANDBOX_DENIED' })
  b.result('ada-chat', 'z', {}, undefined, { code: 'OTHER' })
  assert.equal(b.rt.stopsView().length, 1)
  b.emit('ada-chat', 'turn/end')
  assert.deepEqual(b.rt.stopsView().map(e => e.why), ['review', 'sandbox'])
})

test('bridge unavailable without a pair is noted, rejected never invents a never stop', () => {
  const b = bench()
  const row = (callId, code) => b.emit('ada-chat', 'tool/result', { error: { name: 'ApprovalDeniedError', code }, message: { toolCallId: callId } })
  row('x', 'UNAVAILABLE')
  assert.equal(b.rt.stopsView()[0].why, 'unavailable')
  b.pair('ada-chat', 'y', 'rejected')
  row('y', 'REJECTED')
  row('lost', 'REJECTED')
  row('y', 'UNAVAILABLE')
  assert.equal(b.rt.stopsView()[0].count, 1)
  assert.equal(b.rt.stopsView().length, 1)
})

test('user messages close their place, a new stop reopens, expiry prunes', () => {
  const b = bench()
  b.rt.noteStop('ada-chat', { why: 'level' })
  b.emit('ada-chat', 'user/message', { source: { kind: 'context' } })
  assert.equal(b.rt.stopsView()[0].open, true)
  b.emit('ada-chat', 'user/message', { source: { kind: 'user' } })
  assert.equal(b.rt.stopsView()[0].open, false)
  b.rt.noteStop('ada-chat', { why: 'level' })
  assert.equal(b.rt.stopsView()[0].open, true)
  b.rt.stopKeepMs = -1
  assert.deepEqual(b.rt.stopsView(), [])
})

test('the person closes a group stop in that group, and a task or run stop there or in its Bot’s chat', () => {
  const b = bench()
  b.rt.groupOwners.set('seat', { botId: 'ada', roomId: 'x' })
  b.rt.state.tasks.t = { from: 'ada', title: 'someone' }
  b.rt.taskOwners.set('run', { botId: 'ada' })
  for (const id of ['ada-chat', 'seat', 't', 'run']) b.rt.noteStop(id, { why: 'tool' })
  const open = () => Object.fromEntries(b.rt.stopsView().map(entry => [entry.sessionId, entry.open]))
  b.emit('t', 'user/message', { source: { kind: 'user' } })
  assert.deepEqual(open(), { 'ada-chat': true, seat: true, t: false, run: true })
  b.emit('x', 'user/message', { source: { kind: 'user' } })
  assert.deepEqual(open(), { 'ada-chat': true, seat: false, t: false, run: true })
  for (const id of ['seat', 't']) b.rt.noteStop(id, { why: 'tool' })
  b.emit('ada-chat', 'user/message', { source: { kind: 'user' } })
  assert.deepEqual(open(), { 'ada-chat': false, seat: true, t: false, run: false })
})

test('unknown reasons and Sessions do nothing; extension owners dispose cleanly', () => {
  const { rt } = bench()
  rt.noteStop('ada-chat', { why: 'x' })
  rt.noteStop('someone', { why: 'rule' })
  assert.deepEqual(rt.stopsView(), [])
  extend(rt)
  rt.hooks.sessionOwner(() => { throw new Error('x') })
  rt.hooks.sessionOwner(() => ({ botId: 'someone' }))
  const off = rt.hooks.sessionOwner(id => id === 'x-thread' ? { botId: 'ada', label: '  someone  ' } : undefined)
  rt.noteStop('x-thread', { why: 'rule' })
  const [entry] = rt.stopsView()
  assert.equal(entry.taskId, 'x-thread')
  assert.equal(entry.label, 'someone')
  assert.equal(entry.run, true)
  off()
  rt.noteStop('x-thread', { why: 'tool' })
  assert.equal(rt.stopsView().length, 1)
})

test('bounded retention, defensive copies, text limits, and reason vocabulary', () => {
  const b = bench()
  assert.equal(STOP_KEEP_MS, 6 * 60 * 60 * 1000)
  assert.deepEqual(Object.keys(WHY_EN), STOP_WHYS)
  for (let i = 0; i < CALLS_MAX + 2; i += 1) b.rt.noteStop('ada-chat', { why: 'tool', callId: String(i), tool: 'x'.repeat(100), text: 'x\n'.repeat(200) })
  const entry = b.rt.stopsView()[0]
  assert.equal(entry.count, CALLS_MAX + 2)
  assert.equal(entry.calls.length, CALLS_MAX)
  assert.equal(entry.tool.length, 64)
  assert.equal(entry.text.length, 200)
  entry.calls[0].callId = 'changed'
  assert.equal(b.rt.stopsView()[0].calls[0].callId, '0')
  b.rt.noteStop('ada-chat', { why: 'tool', callId: String(CALLS_MAX + 1) })
  assert.equal(b.rt.stopsView()[0].count, CALLS_MAX + 2)
  for (let turn = 1; turn <= STOPS_MAX; turn += 1) {
    b.emit('ada-chat', 'turn/start', { turn })
    b.rt.noteStop('ada-chat', { why: 'tool' })
  }
  assert.equal(b.rt.stopsView().length, STOPS_MAX)
  assert.equal(b.rt.stopLineOfTurn('ada-chat', 0), undefined)
  assert.equal(stopLineEn({ why: 'unknown' }), `A step did not run: ${WHY_EN.rule}`)
})

test('DSH’s own approval service: a never ask is one stop under its Bot', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService)
  const rt = {
    ctx, state: { tasks: {} }, chatOwners: new Map([['ada-chat', 'ada']]), groupOwners: new Map(), taskOwners: new Map(), pastOwners: new Map(), roomWaiters: new Map(),
    botOf: id => (id === 'ada' ? { id, name: 'ada' } : undefined), noteFailure: () => {},
  }
  install(rt)
  const session = ctx.get('sessions').create('ada-chat')
  session.append('turn/start', { turn: 1 })
  setApprovalPolicy(session, 'never')
  assert.equal(await ctx.get('approval').request({ agent: { session }, toolName: 'bash', callId: 'x' }), 'rejected')
  assert.deepEqual(rt.stopsView().map(entry => [entry.why, entry.botId, entry.sessionId, entry.tool, entry.count, entry.calls]),
    [['never', 'ada', 'ada-chat', 'bash', 1, [{ sessionId: 'ada-chat', callId: 'x' }]]])
})

// #2056 D1.5: the review guard's stop reasons, and a step refused at its approval question that a
// native subagent asked from the Solver's own chat is drawn as a subagent's.
test('the review guard stops: their lines, and a child stop noted on the parent\'s Session', async () => {
  assert.equal(stopLineEn({ why: 'guard', tool: 'write' }), `write did not run: ${WHY_EN.guard}`)
  assert.equal(stopLineEn({ why: 'guard-request', tool: 'write' }), `write did not run: ${WHY_EN['guard-request']}`)
  assert.equal(stopLineEn({ why: 'guard', child: true }), `A subagent step did not run: ${WHY_EN.guard}`)
  assert.ok(STOP_WHYS.includes('guard') && STOP_WHYS.includes('guard-request'))
  const b = bench()
  b.emit('ada-chat', 'turn/start', { turn: 1 })
  b.rt.noteStop('ada-chat', { why: 'guard', tool: 'Write bom.md', callId: 'n1', text: 'held', child: true })
  const [entry] = b.rt.stopsView()
  assert.equal(entry.why, 'guard')
  assert.equal(entry.child, true)
  assert.equal(b.rt.stopLineOfTurn('ada-chat', 1), `A subagent step did not run: ${WHY_EN.guard}`)
  // Without `child` the same Session's stop names its tool.
  const own = bench()
  own.emit('ada-chat', 'turn/start', { turn: 1 })
  own.rt.noteStop('ada-chat', { why: 'guard-request', tool: 'write', callId: 'n2' })
  assert.equal(own.rt.stopLineOfTurn('ada-chat', 1), `write did not run: ${WHY_EN['guard-request']}`)
})
