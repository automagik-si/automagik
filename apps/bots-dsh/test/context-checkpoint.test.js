import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { install } from '../src/host/parts.js'
import { install as installModelState } from '../src/host/model-state.js'
import { install as installFallback } from '../src/host/fallback.js'
import { fakeContext } from './fake-ctx.js'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { Session } from '@deepseek-ai/dsh-session'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'

const text = value => ({ role: 'user', content: [{ type: 'text', text: value }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function bench({ meter = true, loaded = true, native = false } = {}) {
  const calls = { compact: 0, flush: 0, renewed: 0, resolved: 0, saved: 0, streams: [] }
  let tokens = 10000
  const session = { id: 's1', seq: 3, requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 1000 } }), deriveMessages: () => [text('hello'), { role: 'assistant', content: [{ type: 'text', text: 'world' }] }], toolHistory: () => [] }
  const agent = { id: 's1', session, status: 'idle', inbox: { nextStep: [], nextTurn: [], prepend(_where, message) { this.nextTurn.unshift(message) }, remove(id) { this.nextTurn = this.nextTurn.filter(message => message.id !== id) } }, send(message) { this.inbox.nextTurn.push(message) } }
  const compaction = { summarize() {}, async compactIfNeeded() {}, async compactRegion() {}, async compactNow(target, signal) { calls.compact++; await calls.hold?.promise; signal.throwIfAborted(); if (calls.failure) throw calls.failure; tokens = 100; return calls.result === undefined ? {} : calls.result } }
  const ctx = fakeContext({ services: { compaction, ...(meter ? { tokenMeter: { measure: () => ({ totalTokens: tokens }) } } : {}) } })
  ctx.sessions = { list: () => loaded ? [session] : [], flush: async () => { calls.flush++ } }
  ctx.llm = { resolveModelInfo: async () => ({ context: { contextWindow: 100000 } }), stream: options => { calls.streams.push(options); return (async function* () { yield { type: 'text-delta', index: 0, text: 'A summary' }; yield { type: 'finish', reason: { kind: 'stop' } } })() } }
  const bot = { id: 'b1', name: 'Bot', createdAt: 1, sessionId: 's1', ...(native ? { kind: 'dsh' } : {}) }
  const rt = { ctx, config: {}, state: { switching: {}, bots: { b1: bot } }, botOf: id => rt.state.bots[id], roomOf: () => undefined, chatOf: id => rt.state.bots[id]?.sessionId, selfOf: id => id === 's1' ? 'b1' : undefined, chatOwners: new Map([['s1', 'b1']]), groupOwners: new Map(), pastOwners: new Map(), isBotSession: id => id === 's1', readOnly: () => calls.readOnly, load: async () => {}, save: async () => { calls.saved++ }, warn() {}, renewMemory: () => { calls.renewed++ }, resolveAgent: async () => { calls.resolved++; return agent }, tagUsage: (messages, tag) => Object.assign(messages, { tag }) }
  install(rt)
  if (loaded) ctx.emit('agent/created', { agent })
  const preStep = ctx.listeners.get('agent/pre-step')[0]
  return { rt, ctx, agent, bot, calls, compaction, preStep, stop: () => ctx.dispose() }
}

// Real installed compaction transaction + real Session surface/event projection.
// Only the agent admission boundary, persistence sink and LLM are test doubles.
function backendBench({ priorNote } = {}) {
  const b = bench()
  const session = new Session('s1')
  session.append('request/header', { reason: 'initial', header: { config: { provider: 'p', model: 'm', maxTokens: 1000 } } })
  const messages = priorNote === undefined
    ? ['first '.repeat(200), 'second '.repeat(200), 'latest input']
    : [priorNote, 'Work still in progress. '.repeat(100), 'latest input']
  for (const [index, value] of messages.entries()) {
    const source = priorNote !== undefined && index === 0 ? { kind: 'ds-bot', handoff: true } : { kind: 'user' }
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: value }], source }), { surfaceOp: 'append' })
  }
  b.agent.session = session
  b.ctx.sessions.list = () => [session]
  const meter = { measure: target => ({ totalTokens: target.surface.nodes.length * 10000, nodes: target.surface.nodes.map(seq => ({ seq, tokens: 10000, heuristicTokens: 10000 })) }), estimateMessage: () => 100 }
  const get = b.ctx.get
  b.ctx.get = name => name === 'tokenMeter' ? meter : get(name)
  b.ctx.tokenMeter = meter
  b.compaction.ctx = b.ctx
  b.compaction.regionDependencies = () => ({ meter, summarize: (...args) => b.compaction.summarize(...args), recover: () => false })
  b.compaction[Symbol.for('ds-bot/compaction')].compactNow = BasicCompactionEngine.prototype.compactNow
  b.agent.runMaintenance = job => {
    assert.equal(b.calls.maintenance, undefined, 'must not nest maintenance')
    const controller = new AbortController()
    b.calls.maintenance = controller
    return Promise.resolve().then(() => job(controller.signal)).finally(() => { delete b.calls.maintenance })
  }
  const flush = b.ctx.sessions.flush
  b.ctx.sessions.flush = async target => { await flush(target); b.calls.persisted = target.snapshotEvents() }
  b.rt.eventsBackwards = async function* () { yield* [...session.snapshotEvents()].reverse() }
  return { ...b, session }
}

// Expose the installed private loop class only in this test's module instance.
// Its real admission/wake methods run unchanged; no installed files are edited.
async function loopPrototype() {
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'context-test:agent-loop') {
        const result = next('@deepseek-ai/dsh-agent-loop', context)
        return { ...result, url: `${result.url}?context-maintenance-test` }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      const result = next(url, context)
      return url.endsWith('?context-maintenance-test') ? { ...result, source: `${result.source}\nexport { ReactLoopAgent as ContextTestLoop }` } : result
    },
  })
  try { return (await import('context-test:agent-loop')).ContextTestLoop.prototype } finally { hook.deregister() }
}

for (const mode of ['explicit', 'explicit-failure', 'automatic']) test(`${mode} authority is revoked before a real maintenance wake finishes delayed assembly`, { timeout: 5000 }, async t => {
  const b = backendBench(); t.after(b.stop)
  Object.setPrototypeOf(b.agent, await loopPrototype())
  delete b.agent.status; delete b.agent.runMaintenance; delete b.agent.send
  b.agent.phase = { kind: 'idle', lastTurn: 0 }
  b.agent.lifetimeSignal = new AbortController().signal
  b.agent.dispatch = { emit: (name, payload) => b.ctx.emit(name, { agent: b.agent, ...payload }) }
  b.agent.loopCtx = { agents: { withInitiator: (_agent, fn) => fn() } }
  Object.defineProperty(b.agent.inbox, 'hasPending', { get() { return this.nextTurn.length + this.nextStep.length > 0 } })
  b.agent.inbox.splice = function (target, _start, _delete, messages) { this[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(...messages) }
  const assembly = deferred(), releaseAssembly = deferred(), driverDone = deferred()
  const original = b.compaction[Symbol.for('ds-bot/compaction')]
  b.calls.nativePressure = 0
  original.compactIfNeeded = async () => { b.calls.nativePressure++; return null }
  b.compaction.overflowRetries = new WeakMap(); b.compaction.overflowAgents = new WeakMap()
  BasicCompactionEngine.prototype._registerAutomaticCompaction.call(b.compaction)
  const nativePreStep = b.ctx.listeners.get('agent/pre-step').at(-1)
  b.agent.kick = async () => {
    assembly.resolve()
    try {
      await releaseAssembly.promise
      const payload = { agent: b.agent, signal: new AbortController().signal, messages: [], step: 1 }
      await b.preStep(payload, () => nativePreStep(payload, () => ({ kind: 'continue' })))
      assert.equal(b.calls.nativePressure, 0, 'native pressure compaction must not inherit expired Bot authority')
      await assert.rejects(b.compaction.compactNow(b.agent, payload.signal), /makes room on its own/)
      driverDone.resolve()
    } catch (error) { driverDone.resolve(error) }
  }
  const measure = b.ctx.tokenMeter.measure
  b.ctx.tokenMeter.measure = session => ({ ...measure(session), totalTokens: session.snapshotEvents().some(event => event.type === 'compaction/summary') ? 100 : 30000 })
  b.ctx.llm.stream = options => (async function* () {
    if (options.messages.tag.kind !== 'steward') b.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'arrived during maintenance' }], source: { kind: 'user' } }))
    if (mode === 'explicit-failure') throw new Error('The checkpoint summary failed')
    yield { type: 'text-delta', index: 0, text: options.messages.tag.kind === 'steward' ? '{"action":"compact"}' : 'A summary' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  let checkpoint
  if (mode !== 'automatic') checkpoint = b.rt.checkpointBot('b1', { sessionId: 's1' })
  else { b.bot.contextCheckRatio = .05; b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' }) }
  await assembly.promise
  if (mode === 'explicit-failure') await assert.rejects(checkpoint, /could not produce a smaller summary/)
  else if (checkpoint) await checkpoint
  else await new Promise(setImmediate)
  assert.equal((await b.rt.contextStatus('b1')).markers.checking, false)
  releaseAssembly.resolve()
  assert.equal(await driverDone.promise, undefined)
  await b.agent.activityDone
})

test('revocable Bot guard still leaves plain DSH and child compaction native', async t => {
  const b = bench({ native: true }); t.after(b.stop)
  const signal = new AbortController().signal
  await b.compaction.compactNow(b.agent, signal)
  await b.compaction.compactNow({ id: 'child', session: { id: 'child' } }, signal)
  assert.equal(b.calls.compact, 2)
})

test('status readOnly is a boolean and matches the checkpoint refusal', async t => {
  const b = bench(); t.after(b.stop)
  assert.equal((await b.rt.contextStatus('b1')).readOnly, false)
  b.calls.readOnly = 'Another process owns this team'
  const status = await b.rt.contextStatus('b1')
  assert.equal(status.readOnly, true)
  assert.equal(status.checkpointReason, 'bot/read-only')
  assert.equal(status.canCheckpoint, false)
})

test('status is read-only, measured or estimated, and never reopens a Session', async t => {
  for (const meter of [true, false]) {
    const b = bench({ meter }); t.after(b.stop)
    const status = await b.rt.contextStatus('b1')
    assert.equal(status.sessionId, 's1')
    // A legacy meter's finite total has no provider-usage provenance.
    assert.equal(status.usage.source, 'estimated')
    if (meter) assert.equal(status.usage.tokens, 10000)
    assert.equal(status.counts.messages, 2)
    assert.equal(status.counts.parts, 1)
    assert.equal(status.lines.check, 79200)
    assert.equal(status.canCheckpoint, true)
    assert.deepEqual([b.calls.resolved, b.calls.compact, b.calls.saved, b.calls.streams.length], [0, 0, 0, 0])
  }
  const b = bench({ loaded: false }); t.after(b.stop)
  const status = await b.rt.contextStatus('b1')
  assert.equal(status.usage.source, 'unavailable')
  assert.equal(status.canCheckpoint, false)
  assert.equal(b.calls.resolved, 0)
})

test('native token-meter provenance distinguishes provider usage from heuristic and repriced totals without changing numbers', async t => {
  const usage = { inputTokens: 80, outputTokens: 20 }
  const anchor = tokens => ({ kind: 'usage', tokens, usage: tokens === 0 ? { inputTokens: 0, outputTokens: 0 } : usage })
  // These are the pinned TokenMeasurement baseline union and signed surface delta,
  // not an assumption that a native service's number is necessarily measured.
  const cases = [
    ['none', { totalTokens: 0, baseline: { kind: 'none', tokens: 0 }, surfaceDeltaTokens: 0 }, 'estimated'],
    ['heuristic', { totalTokens: 100, baseline: { kind: 'estimated', tokens: 100 }, surfaceDeltaTokens: 0 }, 'estimated'],
    ['provider anchor', { totalTokens: 100, baseline: anchor(100), surfaceDeltaTokens: 0 }, 'measured'],
    ['provider zero', { totalTokens: 0, baseline: anchor(0), surfaceDeltaTokens: 0 }, 'measured'],
    ['positive repricing', { totalTokens: 110, baseline: anchor(100), surfaceDeltaTokens: 10 }, 'estimated'],
    ['negative repricing', { totalTokens: 90, baseline: anchor(100), surfaceDeltaTokens: -10 }, 'estimated'],
    ['legacy', { totalTokens: 100 }, 'estimated'],
    ['missing anchor', { totalTokens: 100, surfaceDeltaTokens: 0 }, 'estimated'],
    ['unknown anchor', { totalTokens: 100, baseline: { kind: 'other', tokens: 100 }, surfaceDeltaTokens: 0 }, 'estimated'],
    ['negative anchor', { totalTokens: 0, baseline: anchor(-1), surfaceDeltaTokens: 0 }, 'estimated'],
    ['infinite anchor', { totalTokens: 100, baseline: anchor(Infinity), surfaceDeltaTokens: 0 }, 'estimated'],
    ['NaN anchor', { totalTokens: 100, baseline: anchor(NaN), surfaceDeltaTokens: 0 }, 'estimated'],
    ['string anchor', { totalTokens: 100, baseline: anchor('100'), surfaceDeltaTokens: 0 }, 'estimated'],
    ['mismatched anchor', { totalTokens: 100, baseline: anchor(99), surfaceDeltaTokens: 0 }, 'estimated'],
    ['missing delta', { totalTokens: 100, baseline: anchor(100) }, 'estimated'],
    ['NaN delta', { totalTokens: 100, baseline: anchor(100), surfaceDeltaTokens: NaN }, 'estimated'],
    ['infinite delta', { totalTokens: 100, baseline: anchor(100), surfaceDeltaTokens: Infinity }, 'estimated'],
    ['null anchor', { totalTokens: 100, baseline: null, surfaceDeltaTokens: 0 }, 'estimated'],
  ]
  const b = bench(); t.after(b.stop)
  const get = b.ctx.get
  for (const [label, metadata, source] of cases) {
    const measurement = { logRevision: 3, surfaceTokens: 100, nodes: [], ...metadata }
    b.ctx.get = name => name === 'tokenMeter' ? { measure: () => measurement } : get(name)
    const status = await b.rt.contextStatus('b1')
    assert.deepEqual(status.usage, { tokens: metadata.totalTokens, source }, label)
    assert.deepEqual(status.lines, { window: 100000, usable: 99000, check: 79200, hard: 94050 }, `${label}: thresholds unchanged`)
  }
  assert.deepEqual([b.calls.resolved, b.calls.compact, b.calls.saved, b.calls.streams.length], [0, 0, 0, 0])
})

test('invalid/missing measurements fall back, unrouted history has no invented lines, and stale reads refuse', async t => {
  const b = bench(); t.after(b.stop)
  const get = b.ctx.get
  b.ctx.get = name => name === 'tokenMeter' ? { measure: () => ({ totalTokens: Infinity }) } : get(name)
  assert.equal((await b.rt.contextStatus('b1')).usage.source, 'estimated')
  b.agent.session.requestHeader = () => undefined
  const status = await b.rt.contextStatus('b1')
  assert.equal(status.lines, null)
  assert.equal(status.canCheckpoint, false)
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/refused' })
  b.agent.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } })
  const entered = deferred(), release = deferred()
  b.ctx.llm.resolveModelInfo = async () => { entered.resolve(); await release.promise; return {} }
  const pending = b.rt.contextStatus('b1')
  await entered.promise
  b.bot.sessionId = 's2'; release.resolve()
  await assert.rejects(pending, { code: 'bot/stale' })
  assert.deepEqual([b.calls.saved, b.calls.compact, b.calls.resolved], [0, 0, 0])
})

test('checkpoint is same-session maintenance, persisted, and native compaction stays guarded', async t => {
  const b = bench(); t.after(b.stop)
  await assert.rejects(b.compaction.compactNow(b.agent), /makes room on its own/)
  const done = await b.rt.checkpointBot('b1', { sessionId: 's1' })
  assert.equal(done.status, 'checkpointed')
  assert.equal(done.sessionId, 's1')
  assert.equal(b.bot.sessionId, 's1')
  assert.deepEqual([b.calls.compact, b.calls.flush, b.calls.renewed], [1, 1, 1])
  await assert.rejects(b.compaction.compactNow(b.agent), /makes room on its own/)
})

test('checkpoint rejects invalid, stale, deleted, read-only, busy and native targets', async t => {
  const b = bench(); t.after(b.stop)
  await assert.rejects(b.rt.checkpointBot('b1', {}), { code: 'bot/invalid' })
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 'old' }), { code: 'bot/stale' })
  await assert.rejects(b.rt.checkpointBot('gone', { sessionId: 's1' }), { code: 'bot/not-found' })
  b.calls.readOnly = 'another host'
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/read-only' })
  assert.equal((await b.rt.contextStatus('b1')).canCheckpoint, false)
  delete b.calls.readOnly
  b.agent.status = 'running'
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/busy' })
  b.agent.status = 'idle'; b.agent.inbox.nextTurn.push(text('queued'))
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/busy' })
  const n = bench({ native: true }); t.after(n.stop)
  await assert.rejects(n.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/refused' })
  assert.equal(b.calls.compact, 0)
})

test('reservation rejects duplicate/fresh operations and preserves arriving input at pre-step', async t => {
  const b = bench(); t.after(b.stop)
  b.calls.hold = deferred()
  const pending = b.rt.checkpointBot('b1', { sessionId: 's1' })
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/busy' })
  await assert.rejects(b.rt.startFresh('b1'), { code: 'bot/refused' })
  await assert.rejects(b.compaction.compactNow(b.agent), /makes room on its own/)
  await assert.rejects(b.compaction.compactRegion(0, 1, b.agent), /makes room on its own/)
  const message = { id: 'arrived', ...text('new input'), source: { kind: 'user' } }
  assert.deepEqual(await b.preStep({ agent: b.agent, messages: [message], step: 1 }, () => { throw new Error('must not run') }), { kind: 'reject' })
  b.calls.hold.resolve()
  await pending
  assert.deepEqual(b.agent.inbox.nextTurn.map(message => message.id), ['arrived'])
  assert.equal((await b.rt.contextStatus('b1')).markers.condensing, false)
})

test('real backend persists a checkpoint marker pair and restores the same Session surface', async t => {
  const b = backendBench(); t.after(b.stop)
  b.bot.contextCheckRatio = .6; b.bot.contextRecentTokens = 1
  const result = await b.rt.checkpointBot('b1', { sessionId: 's1' })
  assert.equal(result.context.counts.checkpoints, 1)
  assert.equal(result.context.policy.checkRatio, .6)
  assert.equal(result.context.lines.hard, 94050)
  assert.equal(result.context.lines.check, 59400)
  const events = b.calls.persisted
  assert.equal(events.filter(event => event.type === 'compaction/start').length, 1)
  assert.equal(events.filter(event => event.type === 'compaction/end').length, 1)
  assert.equal(events.filter(event => event.type === 'compaction/summary').length, 1)
  assert.equal(b.calls.streams[0].messages.tag.kind, 'checkpoint')
  assert.equal(b.calls.streams[0].purpose, 'compaction')
  assert.equal(b.calls.streams[0].sessionId, 's1')
  const restored = new Session('s1', events, b.session.header)
  assert.deepEqual(restored.deriveMessages(), b.session.deriveMessages())
  // The tiny per-Bot carry budget retains only the newest incoming message,
  // rather than using the plugin's 16k default.
  const summary = events.find(event => event.type === 'compaction/summary').data.summary[0].text
  assert.match(summary, /latest input/)
  assert.doesNotMatch(summary, /first first|second second/)
})

test('real backend durability failure is not reported as a successful checkpoint', async t => {
  const b = backendBench(); t.after(b.stop)
  b.ctx.sessions.flush = async () => { throw new Error('durability failed') }
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), /durability checkpoint failed/)
  assert.equal(b.calls.renewed, 0)
  assert.equal(b.bot.sessionId, 's1')
  assert.equal((await b.rt.contextStatus('b1')).markers.condensing, false)
})

test('real backend refuses its own busy maintenance boundary without writing a checkpoint', async t => {
  const b = backendBench(); t.after(b.stop)
  b.agent.runMaintenance = () => { throw new Error('already has active maintenance') }
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/busy' })
  assert.equal(b.session.snapshotEvents().some(event => event.type === 'compaction/start'), false)
})

test('real maintenance cancellation closes markers without committing a summary or switching', async t => {
  const b = backendBench(); t.after(b.stop)
  b.ctx.llm.stream = () => (async function* () {
    b.calls.maintenance.abort({ kind: 'user' })
    yield { type: 'text-delta', index: 0, text: 'must not commit' }
  })()
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code: 'bot/cancelled' })
  const events = b.session.snapshotEvents()
  assert.equal(events.filter(event => event.type === 'compaction/start').length, 1)
  assert.equal(events.filter(event => event.type === 'compaction/end').length, 1)
  assert.equal(events.some(event => event.type === 'compaction/summary'), false)
  assert.equal(b.bot.sessionId, 's1')
  assert.equal((await b.rt.contextStatus('b1')).canCheckpoint, true)
})

test('read-only/deleted/stale races during real summarization do not commit a checkpoint', async t => {
  for (const [code, mutate] of [
    ['bot/read-only', b => { b.calls.readOnly = 'lock lost' }],
    ['bot/not-found', b => { delete b.rt.state.bots.b1 }],
    ['bot/stale', b => { b.bot.sessionId = 's2' }],
  ]) {
    const b = backendBench(); t.after(b.stop)
    b.ctx.llm.stream = () => (async function* () {
      mutate(b)
      yield { type: 'text-delta', index: 0, text: 'must not commit' }
    })()
    await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), { code })
    assert.equal(b.session.snapshotEvents().some(event => event.type === 'compaction/summary'), false)
    assert.equal(b.calls.renewed, 0)
  }
})

test('automatic checks honor per-Bot soft policy and label steward/handoff overhead at actual calls', async t => {
  const b = bench(); t.after(b.stop)
  b.rt.eventsBackwards = async function* () {}
  b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
  await new Promise(setImmediate)
  assert.equal(b.calls.streams.length, 0, 'below plugin default check line')
  b.bot.contextCheckRatio = .05
  b.agent.whenIdle = async () => {}
  b.agent.runMaintenance = fn => fn(new AbortController().signal)
  const finished = deferred()
  b.rt.save = async () => { if (++b.calls.saved === 2) finished.resolve() }
  b.ctx.llm.stream = options => {
    b.calls.streams.push(options)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: options.messages.tag.kind === 'steward' ? '{"action":"switch"}' : 'invalid note: no headings' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
  await finished.promise
  assert.deepEqual(b.calls.streams.map(options => options.messages.tag.kind), ['steward', 'handoff', 'handoff'])
  assert.ok(b.calls.streams.every(options => options.sessionId === 's1' && options.purpose === 'compaction'))
  assert.equal(b.bot.sessionId, 's1', 'a failed soft handoff keeps the original conversation')
})

test('plugin disposal cancels a real in-flight checkpoint without committing its summary', async t => {
  const b = backendBench(); t.after(b.stop)
  const entered = deferred(), release = deferred()
  b.ctx.llm.stream = () => (async function* () {
    entered.resolve()
    await release.promise
    yield { type: 'text-delta', index: 0, text: 'must not commit' }
  })()
  const pending = b.rt.checkpointBot('b1', { sessionId: 's1' })
  await entered.promise
  await b.ctx.dispose()
  release.resolve()
  await assert.rejects(pending, { code: 'bot/cancelled' })
  assert.equal(b.session.snapshotEvents().some(event => event.type === 'compaction/summary'), false)
})

test('failure/cancellation release reservation without switching or claiming success', async t => {
  for (const code of ['cancelled', 'failed']) {
    const b = bench(); t.after(b.stop)
    b.calls.failure = Object.assign(new Error('backend failure'), { code })
    await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }))
    assert.equal(b.bot.sessionId, 's1')
    assert.equal(b.calls.flush, 0)
    assert.equal((await b.rt.contextStatus('b1')).markers.condensing, false)
    delete b.calls.failure
    await b.rt.checkpointBot('b1', { sessionId: 's1' })
  }
})

// A chat on an agent over ACP cannot take a request beside its turn: the steward's call and
// the part's note go to the team's background model, without the agent's effort or limit.
test('a chat on an ACP agent asks the steward and writes its note on the background model', async t => {
  const b = bench(); t.after(b.stop)
  b.rt.eventsBackwards = async function* () {}
  b.agent.session.requestHeader = () => ({ config: { provider: 'acp-codex', model: 'default', reasoningEffort: 'high', maxTokens: 1000 } })
  b.rt.answersAside = ref => !String(ref).startsWith('acp-')
  b.rt.backgroundModel = async () => 'deepseek/flash'
  b.bot.contextCheckRatio = .05
  b.agent.whenIdle = async () => {}
  b.agent.runMaintenance = fn => fn(new AbortController().signal)
  const finished = deferred()
  b.rt.save = async () => { if (++b.calls.saved === 2) finished.resolve() }
  b.ctx.llm.stream = options => {
    b.calls.streams.push(options)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: options.messages.tag.kind === 'steward' ? '{"action":"switch"}' : 'invalid note: no headings' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
  b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
  await finished.promise
  assert.deepEqual(b.calls.streams.map(options => options.messages.tag.kind), ['steward', 'handoff', 'handoff'])
  assert.deepEqual(b.calls.streams.map(options => `${options.provider}/${options.model}`), ['deepseek/flash', 'deepseek/flash', 'deepseek/flash'])
  assert.ok(b.calls.streams.every(options => options.reasoningEffort === undefined))
})

// The same for a checkpoint: on an ACP agent's chat it is written on the background model,
// without the agent's effort or output limit, and still committed to the chat's own Session.
test('a checkpoint of a chat on an ACP agent is written on the background model', async t => {
  const b = backendBench(); t.after(b.stop)
  b.session.requestHeader = () => ({ config: { provider: 'acp-codex', model: 'default', reasoningEffort: 'high', maxTokens: 1000 } })
  b.rt.answersAside = ref => !String(ref).startsWith('acp-')
  b.rt.backgroundModel = async () => 'deepseek/flash'
  const result = await b.rt.checkpointBot('b1', { sessionId: 's1' })
  assert.equal(result.context.counts.checkpoints, 1)
  const [call] = b.calls.streams
  assert.deepEqual([call.messages.tag.kind, `${call.provider}/${call.model}`, call.reasoningEffort, call.maxTokens, call.sessionId], ['checkpoint', 'deepseek/flash', undefined, undefined, 's1'])
  assert.equal(b.calls.persisted.filter(event => event.type === 'compaction/summary').length, 1)
})

// ---------------------------------------------------------------------------------------
// Switch reproduction (plano-cli-bots-automagik-v3, E0): a Bot moving between an agent over
// ACP and an API model, through DSH's own pieces from the pinned harness — cordis, dsh-llm's
// runtime (resolveModelInfo, prepareCall), the compaction-basic engine with its automatic
// listeners, dsh-session, and the agent loop's own prepareRequest. The Bot's parts.js is
// installed for real on a plugin context. The doubles are the providers (an API route that
// declares its window, an agent route that declares none and turns down side requests, as
// acp-dsh does), the token meter, and the Bot runtime around parts.js.
//
// Each case asserts what the plan wants. The ones still marked todo name the step that makes
// them hold; until then they fail as the plan's diagnosis says.
// ---------------------------------------------------------------------------------------

const SWITCH_FAILED = 'MODEL_SWITCH_COMPACTION_FAILED'
const quietLogger = { warn() {}, info() {}, error() {}, debug() {} }

class ApiRoute extends LlmAdapter {
  constructor(windows, calls) {
    super()
    this.windows = windows
    this.calls = calls
  }

  resolveModel(provider, model) {
    const window = this.windows[model]
    return Promise.resolve({ provider, id: model, name: model, ...(window === undefined ? {} : { context: { contextWindow: window } }) })
  }

  async *stream(options) {
    this.calls.push(options)
    const kind = options.messages?.tag?.kind
    yield { type: 'text-delta', index: 0, text: kind === 'steward' ? '{"action":"switch"}' : 'A summary of the earlier messages.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// An agent over ACP: no window, and no request beside its own turn (acp-dsh turns those down).
class AgentRoute extends LlmAdapter {
  constructor(calls) {
    super()
    this.calls = calls
  }

  async *stream(options) {
    this.calls.push(options)
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'An agent answers only in its own chat', code: 'INVALID_REQUEST' } } }
  }
}

let switchLoop
async function switchLoopPrototype() {
  switchLoop ??= await loopPrototype()
  return switchLoop
}

function perNodeMeter(perNode) {
  return {
    measure: session => ({ totalTokens: session.surface.nodes.length * perNode, nodes: session.surface.nodes.map(seq => ({ seq, tokens: perNode, heuristicTokens: perNode })) }),
    estimateMessage: () => 100,
  }
}

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

async function switchBench({ perNode, routed = ['acp-codex', 'default'], reopened = false, background, explicit = false, model = 'api/small', fallback = false }) {
  const calls = { api: [], agent: [], created: [], archived: [], selected: [], followups: [], warnings: [], agentSelected: [] }
  const ctx = new Context()
  ctx.provide('logger', quietLogger)
  const meter = perNodeMeter(perNode)
  ctx.provide('tokenMeter', meter)
  ctx.provide('sessions', { flush: async () => {}, list: () => [] })
  ctx.provide('workspaceRegistry', { archiveSession: async (id) => { calls.archived.push(id) } })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['api'], new ApiRoute({ big: 1_000_000, small: 100_000 }, calls.api))
  ctx.llm.registerAdapter(['acp-codex'], new AgentRoute(calls.agent))
  await ctx.plugin(BasicCompactionEngine, {})

  let session = new Session('s1')
  session.append('request/header', { reason: 'initial', header: { config: { provider: routed[0], model: routed[1] } } })
  for (const text of ['first request', 'second request', 'latest request']) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  if (reopened) session = Session.create('s1', session.snapshotEvents())
  const messagesBefore = session.deriveMessages().length
  // Every user message the record holds: a checkpoint condenses the surface, a switch moves
  // on, and neither deletes one.
  const recorded = () => session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'user').length
  const recordedBefore = recorded()

  const bot = { id: 'b1', name: 'Bot', createdAt: 1, sessionId: 's1', model }
  const state = { switching: {}, bots: { b1: bot }, questions: {}, views: {}, prefs: explicit && background ? { backgroundModel: background } : {} }
  const sessions = new Map([['s1', session]])
  const agents = new Map()
  const makeAgent = (id, target, logged) => {
    const agent = {
      id, session: target, options: {}, requestHeaderLogged: logged, status: 'idle',
      // The Agent's own route choice (fallback.js records the fallback here).
      model: { current: () => undefined, select: (selection) => { calls.agentSelected.push([id, `${selection.provider}/${selection.model}`]) } },
      loopCtx: { llm: ctx.llm },
      inbox: { nextStep: [], nextTurn: [], prepend(_where, message) { this.nextTurn.unshift(message) }, remove(messageId) { this.nextTurn = this.nextTurn.filter(message => message.id !== messageId) } },
      followup(message) { calls.followups.push({ id, message }); this.inbox.nextTurn.push(message); calls.onFollowup?.(id, message) },
      inject(message) { this.inbox.nextStep.push(message) },
      send(message) { this.inbox.nextTurn.push(message) },
      whenIdle: async () => {},
      runMaintenance: run => run(new AbortController().signal),
    }
    agent.dispatch = agentEvents(ctx, agent)
    agents.set(id, agent)
    return agent
  }
  const agent = makeAgent('s1', session, !reopened)
  const selfOf = id => Object.values(state.bots).find(entry => entry.sessionId === id)?.id
  const rt = {
    config: {}, state,
    botOf: id => state.bots[id], roomOf: () => undefined, chatOf: id => state.bots[id]?.sessionId, selfOf,
    chatOwners: { get: selfOf }, groupOwners: new Map(), pastOwners: new Map(),
    isBotSession: id => selfOf(id) !== undefined,
    readOnly: () => undefined, load: async () => {}, save: async () => {},
    warn: (...args) => { calls.warnings.push(args.map(String).join(' ')) },
    renewMemory() {}, tagUsage: (messages, tag) => Object.assign(messages, { tag }), ownRequest: () => false,
    eventsBackwards: async function* (id) { yield* [...(sessions.get(id)?.snapshotEvents() ?? [])].reverse() },
    answersAside: ref => !String(ref).startsWith('acp-'),
    backgroundModel: async () => background,
    liveOf: () => ({}), workDirOf: () => undefined, isFolder: async () => false, teamFolder: () => undefined, ensureWorkspace: async () => {},
    desiredModel: async target => target.model, desiredEffort: async () => undefined,
    selectSessionModel: async (id, selection) => { calls.selected.push([id, `${selection.provider}/${selection.model}`]) },
    applyModel: async (target) => { const [provider, ...rest] = String(target.model).split('/'); await rt.selectSessionModel(target.sessionId, { provider, model: rest.join('/') }); return target.model },
    modelAccess: async () => ({ ready: true }),
    defaultModel: async () => 'deepseek/flash',
    createSession: async (name) => {
      const id = `fresh${calls.created.length + 1}`
      calls.created.push(name)
      const fresh = new Session(id)
      sessions.set(id, fresh)
      makeAgent(id, fresh, false)
      return id
    },
    resolveAgent: async id => agents.get(id),
    applyPermission: async () => {}, applyToolDeny: async () => {}, ensureCapabilities: async () => {}, moveSchedules: async () => {},
  }
  const parts = ctx.plugin({
    name: 'bots-parts-under-test',
    inject: ['llm', 'sessions', 'workspaceRegistry', 'tokenMeter'],
    // parts.js, then the module that owns a failed switch's turn/end (model-state.js), in the
    // plugin's order.
    // `fallback`: the real fallback.js between them, as index.js installs it.
    apply: (scoped) => { rt.ctx = scoped; install(rt); if (fallback) installFallback(rt); installModelState(rt) },
  })
  await parts
  await agent.dispatch.serial('agent/created', {})
  // Automatic compaction runs inside a turn, as a real step does.
  session.append('turn/start', { turn: 1 })
  const proto = await switchLoopPrototype()
  // One step onto `provider/model`: the Bot's pre-step, then the loop's request preparation
  // (where compaction-basic's switch guard runs).
  async function step(provider, model, messages = []) {
    const signal = new AbortController().signal
    const decision = await agent.dispatch.waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal, modelSelection: { provider, model } }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    if (decision.kind === 'reject') return { decision }
    try {
      return { decision, config: (await proto.prepareRequest.call(agent, 1, 1, { provider, model }, signal)).config }
    } catch (error) {
      return { decision, error }
    }
  }
  const streams = () => [...calls.api, ...calls.agent]
    // The fresh part's first turn, as the loop records it: its own request header, then either
  // the agent's answer or a turn that ended in error. The turn takes what waits in the
  // part's inbox into its record first, as the loop does.
  function firstTurn(id, { answer }) {
    const target = sessions.get(id)
    const [provider, model] = String(bot.model).split('/')
    const owner = agents.get(id)
    const taken = [...owner.inbox.nextStep.splice(0), ...owner.inbox.nextTurn.splice(0)]
    const events = [
      target.append('turn/start', { turn: 1 }),
      ...taken.map(message => target.append('user/message', message, { surfaceOp: 'append' })),
      target.append('request/header', { reason: 'initial', header: { config: { provider, model } } }),
      ...(answer
        ? [target.append('assistant/message', { turn: 1, message: { role: 'assistant', source: { provider, model }, content: [{ type: 'text', text: 'Here is the answer.' }] } }, { surfaceOp: 'append' }),
            target.append('turn/end', { turn: 1, reason: { kind: 'stop' } })]
        : [target.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'INVALID_REQUEST', message: 'The first call failed' } } })]),
    ]
    for (const event of events) ctx.emit('session/event', target, event)
  }
  return { ctx, rt, bot, state, session, sessions, agents, agent, calls, step, streams, firstTurn, messagesBefore, recorded, recordedBefore, stop: () => parts.dispose() }
}

const notSwitchFailure = (outcome) => {
  assert.notEqual(outcome.error?.code, SWITCH_FAILED, `the switch failed in DSH's guard: ${outcome.error?.message}`)
  assert.equal(outcome.error, undefined)
}

test('guard: the Bot team wraps the engine\'s entry points but never compactPressure (acp-dsh owns it)', async (t) => {
  const b = await switchBench({ perNode: 10 })
  t.after(b.stop)
  const engine = b.ctx.get('compaction')[Symbol.for('cordis.original')]
  assert.equal(typeof engine[Symbol.for('ds-bot/compaction')]?.summarize, 'function', 'adopted by the Bot team')
  assert.equal(Object.hasOwn(engine, 'compactPressure'), false)
})

test('control: a Bot on an agent switching to an API model below its threshold passes', async (t) => {
  const b = await switchBench({ perNode: 10 })
  t.after(b.stop)
  assert.equal((await b.ctx.llm.resolveModelInfo('api', 'small')).context.contextWindow, 100_000)
  assert.equal((await b.ctx.llm.resolveModelInfo('acp-codex', 'default')).context, undefined)
  const outcome = await b.step('api', 'small')
  notSwitchFailure(outcome)
  assert.equal(outcome.config.provider, 'api')
  assert.deepEqual(b.streams(), [])
})

test('case 3: Bot agent -> API above the threshold, explicit background model: checkpoint on it, then the switch passes', async (t) => {
  // 100k window, 65,536 headroom: threshold 34,464; 3 nodes of 15k are over it, and the
  // checkpoint (a summary node and the latest one) brings it to 30k, under it.
  const b = await switchBench({ perNode: 15_000, background: 'api/big', explicit: true })
  t.after(b.stop)
  const outcome = await b.step('api', 'small')
  notSwitchFailure(outcome)
  assert.equal(outcome.decision.kind, 'enter', 'the step goes on in the same part')
  assert.equal(outcome.config.provider, 'api')
  assert.deepEqual(b.streams().map(call => [call.messages.tag?.kind, `${call.provider}/${call.model}`]), [['checkpoint', 'api/big']], 'one checkpoint, charged to the explicit background model only')
  assert.deepEqual(b.calls.agent, [], 'nothing asked of the agent')
  assert.equal(b.calls.created.length, 0, 'no fresh part')
  assert.ok(b.session.surface.nodes.length * 15_000 < 34_464, 'below the destination threshold after the checkpoint')
  assert.equal(b.recorded(), b.recordedBefore, 'no message deleted from the record')
})

test('case 3, explicit background model too small for the part: a fresh part, no paid call', async (t) => {
  // 3 x 400k = 1.2M: over the 1M window of the background model itself.
  const b = await switchBench({ perNode: 400_000, background: 'api/big', explicit: true })
  t.after(b.stop)
  const outcome = await b.step('api', 'small')
  assert.equal(outcome.decision.kind, 'reject', 'the step stops for the move')
  await until(() => b.calls.created.length > 0, 1000)
  assert.equal(b.calls.created.length, 1, 'a fresh part')
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream')
  assert.equal(b.recorded(), b.recordedBefore)
})

test('case 3b: the surface fits the window but is over thresholdTokens, no explicit background: a fresh part, no paid call', async (t) => {
  // 3 x 20k = 60k: inside the 100k window, over its 34,464 threshold. The automatic background
  // pick (pickDefault) does not authorise a paid call.
  const b = await switchBench({ perNode: 20_000, background: 'api/big' })
  t.after(b.stop)
  const outcome = await b.step('api', 'small')
  notSwitchFailure(outcome)
  assert.equal(outcome.decision.kind, 'reject', 'the step stops for the move')
  await until(() => b.calls.created.length > 0, 1000)
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream: no model is charged')
  assert.equal(b.calls.created.length, 1, 'a fresh part')
  assert.deepEqual(b.calls.selected, [['fresh1', 'api/small']], 'the fresh part runs on the destination')
  assert.equal(b.bot.sessionId, 'fresh1')
  assert.equal(b.bot.segments.at(-1).fallback, 'recent')
  assert.equal(b.bot.segments.at(-1).target, 'api/small')
  assert.deepEqual(b.calls.archived, [], 'the old part waits for the fresh part\'s first answer')
  assert.equal(b.recorded(), b.recordedBefore, 'no message deleted from the record')
})

test('case 4: a failed switch does not leave the new model pending in a loop', async (t) => {
  // The Bot was on its agent (confirmed) and the person picked an API model that declares no
  // window: DSH's guard still refuses that one.
  const b = await switchBench({ perNode: 20_000, model: 'api/unknown' })
  t.after(b.stop)
  b.bot.previousModel = 'acp-codex/default'
  const first = await b.step('api', 'unknown')
  assert.equal(first.error?.code, SWITCH_FAILED, 'the reproduction: the guard refuses')
  // The loop records the failed turn as it does: turn/end with the guard's failure.
  b.ctx.emit('session/event', b.session, b.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: SWITCH_FAILED, message: first.error.message } } }))
  await until(() => b.calls.selected.length > 0, 500)
  assert.equal(b.bot.model, 'acp-codex/default', 'bot.model went back to previousModel')
  assert.deepEqual(b.calls.selected, [['s1', 'acp-codex/default']], 'the Session selection went back too, once')
  // No loop: nothing is woken or run again, and the next step runs on the model kept.
  assert.deepEqual(b.calls.followups, [], 'nothing runs again on its own')
  assert.deepEqual(b.streams(), [])
  const again = await b.step('acp-codex', 'default')
  notSwitchFailure(again)
  const view = b.rt.modelStateView().b1
  assert.equal(view.selected, 'acp-codex/default')
  assert.equal(view.pending, false)
  assert.equal(view.lastFailure.code, SWITCH_FAILED)
  assert.equal(view.lastFailure.ref, 'api/unknown')
  assert.equal(view.lastFailure.kept, 'acp-codex/default')
  assert.equal(view.answered, false, 'answered only from a matching assistant message')
  // A second failure of the same kind with nothing pending changes nothing.
  b.ctx.emit('session/event', b.session, b.session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: SWITCH_FAILED } } }))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(b.calls.selected.length, 1)
})

test('case 4, the other failures: a provider error keeps the pick (the fallback answers it), and an answer confirms it', async (t) => {
  const b = await switchBench({ perNode: 20_000, model: 'api/small' })
  t.after(b.stop)
  b.bot.previousModel = 'acp-codex/default'
  b.ctx.emit('session/event', b.session, b.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'NETWORK', message: 'reset' } } }))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(b.bot.model, 'api/small', 'not a switch failure: the pick stays')
  assert.deepEqual(b.calls.selected, [])
  assert.equal(b.rt.modelStateView().b1.lastFailure.code, 'NETWORK')
  // A request header proves a call started, not an answer.
  b.ctx.emit('session/event', b.session, b.session.append('request/header', { reason: 'initial', header: { config: { provider: 'api', model: 'small' } } }))
  assert.equal(b.rt.modelStateView().b1.requestStarted.ref, 'api/small')
  assert.equal(b.rt.modelStateView().b1.answered, false)
  assert.equal(b.bot.previousModel, 'acp-codex/default', 'a started request confirms nothing')
  // An answer from another route does not confirm the pick either.
  b.ctx.emit('session/event', b.session, b.session.append('assistant/message', { turn: 2, message: { role: 'assistant', source: { provider: 'deepseek', model: 'flash' }, content: [{ type: 'text', text: 'from the fallback' }] } }, { surfaceOp: 'append' }))
  assert.equal(b.bot.previousModel, 'acp-codex/default')
  assert.equal(b.rt.modelStateView().b1.answered, false)
  // The pick's own first answer does.
  b.ctx.emit('session/event', b.session, b.session.append('assistant/message', { turn: 3, message: { role: 'assistant', source: { provider: 'api', model: 'small' }, content: [{ type: 'text', text: 'hello' }] } }, { surfaceOp: 'append' }))
  assert.equal(b.bot.previousModel, 'api/small', 'replaced after the first matching answer')
  assert.equal(b.rt.modelStateView().b1.answered, true)
  assert.equal(b.rt.modelStateView().b1.lastFailure, undefined, 'the answer clears the failure')
  assert.equal(b.rt.modelStateView().b1.pending, false)
})

test('case 8b, a model switch: the fresh part\'s failed first call puts the Bot back on its previous model too', async (t) => {
  // A Bot on its agent, switched to an API model with history over the destination window: a
  // fresh part without a note on api/small. Its first call fails.
  const b = await switchBench({ perNode: 60_000, reopened: true, model: 'api/small' })
  t.after(b.stop)
  b.bot.previousModel = 'acp-codex/default'
  await b.step('api', 'small')
  await until(() => b.calls.followups.some(entry => entry.id === 'fresh1'), 1000)
  b.firstTurn('fresh1', { answer: false })
  await until(() => b.bot.sessionId === 's1' && b.calls.archived.length > 0, 1000)
  assert.equal(b.bot.model, 'acp-codex/default', 'bot.model went back to previousModel')
  assert.deepEqual(b.calls.selected.at(-1), ['s1', 'acp-codex/default'], 'the old part runs on the model it ran on')
  assert.equal(b.rt.modelStateView().b1.lastFailure.kept, 'acp-codex/default')
  assert.deepEqual(b.calls.archived, ['fresh1'])
})

// F9: a transient failure of the fresh part's first call that the fallback model answers
// (fallback.js armed its turn) does not take the switch back; the fallback's answer settles it,
// and only a fallback turn that fails too goes back.
test('case 8c: a fresh part\'s first call that the fallback answers keeps the switch; a failed fallback goes back', async () => {
  for (const fallbackAnswers of [true, false]) {
    const b = await switchBench({ perNode: 60_000, reopened: true, model: 'api/small' })
    b.bot.previousModel = 'acp-codex/default'
    const armed = new Set()
    b.rt.fallbackArmed = id => armed.has(id)
    await b.step('api', 'small')
    await until(() => b.calls.followups.some(entry => entry.id === 'fresh1'), 1000)
    armed.add('fresh1')
    b.firstTurn('fresh1', { answer: false })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(b.bot.sessionId, 'fresh1', 'the fallback answers this one: the switch stays')
    assert.equal(b.bot.model, 'api/small')
    assert.deepEqual(b.calls.archived, [])
    const fresh = b.sessions.get('fresh1')
    const events = [
      fresh.append('turn/start', { turn: 2 }),
      fresh.append('request/header', { reason: 'initial', header: { config: { provider: 'deepseek', model: 'flash' } } }),
      ...(fallbackAnswers
        ? [fresh.append('assistant/message', { turn: 2, message: { role: 'assistant', source: { provider: 'deepseek', model: 'flash' }, content: [{ type: 'text', text: 'From the fallback.' }] } }, { surfaceOp: 'append' }),
            fresh.append('turn/end', { turn: 2, reason: { kind: 'stop' } })]
        : [fresh.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'SERVER', message: 'down too' } } })]),
    ]
    armed.delete('fresh1')
    for (const event of events) b.ctx.emit('session/event', fresh, event)
    if (fallbackAnswers) {
      await until(() => b.calls.archived.length > 0, 1000)
      assert.deepEqual(b.calls.archived, ['s1'], 'the part works: the earlier part is archived')
      assert.equal(b.bot.sessionId, 'fresh1')
      assert.equal(b.bot.model, 'api/small', 'the pick stays')
    } else {
      await until(() => b.bot.sessionId === 's1' && b.calls.archived.length > 0, 1000)
      assert.deepEqual(b.calls.archived, ['fresh1'], 'the fallback failed too: back to the earlier part')
      assert.equal(b.bot.model, 'acp-codex/default')
    }
    await b.stop()
  }
})

test('case 8d: a switch failure code goes back at once even when the fallback is armed', async (t) => {
  const b = await switchBench({ perNode: 60_000, reopened: true, model: 'api/small' })
  t.after(b.stop)
  b.bot.previousModel = 'acp-codex/default'
  b.rt.fallbackArmed = () => true
  await b.step('api', 'small')
  await until(() => b.calls.followups.some(entry => entry.id === 'fresh1'), 1000)
  const fresh = b.sessions.get('fresh1')
  for (const event of [
    fresh.append('turn/start', { turn: 1 }),
    fresh.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Provider is not configured: api' } } }),
  ]) b.ctx.emit('session/event', fresh, event)
  await until(() => b.bot.sessionId === 's1' && b.calls.archived.length > 0, 1000)
  assert.equal(b.bot.model, 'acp-codex/default')
})

// A pi-ai route whose provider has no credential fails every turn the same way: a switch onto
// it goes back to the model that answered before, as a switch failure does.
test('case 4c: "Provider is not configured" on a pending switch keeps the previous working model', async (t) => {
  const b = await switchBench({ perNode: 20_000, model: 'openai-codex/gpt-5.6-sol' })
  t.after(b.stop)
  b.bot.previousModel = 'deepseek/flash'
  b.ctx.emit('session/event', b.session, b.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Provider is not configured: openai-codex' } } }))
  await until(() => b.calls.selected.length > 0, 500)
  assert.equal(b.bot.model, 'deepseek/flash')
  assert.deepEqual(b.calls.selected, [['s1', 'deepseek/flash']])
  assert.equal(b.rt.modelStateView().b1.lastFailure.kept, 'deepseek/flash')
  // Any other pi-ai failure keeps the pick: the fallback answers it.
  const other = await switchBench({ perNode: 20_000, model: 'openai-codex/gpt-5.6-sol' })
  t.after(other.stop)
  other.bot.previousModel = 'deepseek/flash'
  other.ctx.emit('session/event', other.session, other.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Some other failure' } } }))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(other.bot.model, 'openai-codex/gpt-5.6-sol')
  assert.deepEqual(other.calls.selected, [])
})

// F3: a model that never answered is never one to go back to.
// The real fallback.js with model-state.js and parts.js: a switch that cannot run goes back, and
// nothing runs again on its own, so no fallback turn is woken on top of it.
const notConfigured = provider => ({ code: 'PI_AI_ERROR', message: `Provider is not configured: ${provider}` })
const requestError = (agent, failure) => agent.dispatch.waterfall('agent/request-error', { turn: 1, step: 1, failure, signal: { aborted: false } }, () => Promise.resolve(undefined))
const notices = calls => calls.followups.filter(entry => entry.message?.source?.kind === 'model-selection')

test('case 4d: a pending switch that is not configured goes back without waking a fallback turn', async (t) => {
  const b = await switchBench({ perNode: 20_000, model: 'openai-codex/gpt-5.6-sol', fallback: true })
  t.after(b.stop)
  b.bot.previousModel = 'deepseek/flash'
  assert.equal(await requestError(b.agent, notConfigured('openai-codex')), undefined)
  b.ctx.emit('session/event', b.session, b.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: notConfigured('openai-codex') } }))
  await until(() => b.calls.selected.length > 0, 500)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(b.bot.model, 'deepseek/flash', 'back on the model that answered')
  assert.deepEqual(b.calls.agentSelected, [], 'no fallback route recorded')
  assert.deepEqual(notices(b.calls), [], 'no fallback notice, so no turn runs on its own')
  assert.equal(b.rt.fallbackArmed('s1'), false)
  // Control: the same failure on a confirmed model falls back as before, with its notice.
  const kept = await switchBench({ perNode: 20_000, model: 'openai-codex/gpt-5.6-sol', fallback: true })
  t.after(kept.stop)
  kept.bot.previousModel = 'openai-codex/gpt-5.6-sol'
  await requestError(kept.agent, notConfigured('openai-codex'))
  await until(() => notices(kept.calls).length > 0, 500)
  assert.deepEqual(kept.calls.agentSelected, [['s1', 'deepseek/flash']])
  assert.equal(notices(kept.calls).length, 1)
})

test('case 8e: a fresh part whose provider is not configured goes back without waking a fallback turn', async (t) => {
  const b = await switchBench({ perNode: 60_000, reopened: true, model: 'api/small', fallback: true })
  t.after(b.stop)
  b.bot.previousModel = 'acp-codex/default'
  await b.step('api', 'small')
  await until(() => b.calls.followups.some(entry => entry.id === 'fresh1'), 1000)
  const fresh = b.sessions.get('fresh1')
  for (const event of [
    fresh.append('turn/start', { turn: 1 }),
    fresh.append('request/header', { reason: 'initial', header: { config: { provider: 'api', model: 'small' } } }),
  ]) b.ctx.emit('session/event', fresh, event)
  assert.equal(await requestError(b.agents.get('fresh1'), notConfigured('api')), undefined)
  assert.equal(b.rt.fallbackArmed('fresh1'), false, 'nothing armed for the part that goes back')
  b.ctx.emit('session/event', fresh, fresh.append('turn/end', { turn: 1, reason: { kind: 'error', error: notConfigured('api') } }))
  await until(() => b.bot.sessionId === 's1' && b.calls.archived.length > 0, 1000)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(b.bot.model, 'acp-codex/default')
  assert.deepEqual(b.calls.archived, ['fresh1'])
  assert.deepEqual(b.calls.agentSelected, [], 'no fallback route recorded')
  assert.deepEqual(notices(b.calls), [], 'no fallback notice in the part taken back or the old one')
})

test('previousModel is recorded only from a model that answered', async (t) => {
  const b = await switchBench({ perNode: 20_000, model: 'acp-codex/default' })
  t.after(b.stop)
  assert.equal(b.bot.previousModel, undefined)
  // The Bot's model only started a call (and failed): a change records nothing to go back to.
  b.ctx.emit('session/event', b.session, b.session.append('request/header', { reason: 'initial', header: { config: { provider: 'acp-codex', model: 'default' } } }))
  b.rt.noteModelChoice(b.bot, 'api/small')
  assert.equal(b.bot.previousModel, undefined, 'a model that never answered is not recorded')
  // Once it answered, it is the one to go back to; the answer alone records it (persisted).
  b.ctx.emit('session/event', b.session, b.session.append('assistant/message', { turn: 1, message: { role: 'assistant', source: { provider: 'acp-codex', model: 'default' }, content: [{ type: 'text', text: 'hi' }] } }, { surfaceOp: 'append' }))
  assert.equal(b.bot.previousModel, 'acp-codex/default')
  b.rt.noteModelChoice(b.bot, 'api/small')
  b.bot.model = 'api/small'
  assert.equal(b.bot.previousModel, 'acp-codex/default')
  // A second change before the first answered keeps the model that answered.
  b.rt.noteModelChoice(b.bot, 'api/big')
  assert.equal(b.bot.previousModel, 'acp-codex/default')
})

test('case 6: history already over the destination window, reopened, -> API: a fresh part without a model call', async (t) => {
  // 3 x 60k = 180k: over the 100k window itself.
  const b = await switchBench({ perNode: 60_000, reopened: true })
  t.after(b.stop)
  const outcome = await b.step('api', 'small')
  notSwitchFailure(outcome)
  await until(() => b.calls.created.length > 0, 1000)
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream')
  assert.equal(b.calls.created.length, 1)
  assert.deepEqual(b.calls.selected, [['fresh1', 'api/small']], 'the fresh part runs on the destination')
  assert.equal(b.session.deriveMessages().length, b.messagesBefore, 'no message removed from the old part')
  assert.equal(b.recorded(), b.recordedBefore, 'no message deleted from the record')
})

test('case 7: a CLI-only Bot reaching the hard line moves on without any model call or repeated error', async (t) => {
  // No window: the 500k default, hard line 475k. 3 x 170k = 510k.
  const b = await switchBench({ perNode: 170_000 })
  t.after(b.stop)
  const outcome = await b.step('acp-codex', 'default')
  assert.equal(outcome.decision.kind, 'reject', 'the step stops for the move')
  await until(() => b.calls.created.length > 0 || b.calls.warnings.some(line => /did not move on/.test(line)))
  assert.equal(b.calls.created.length, 1, 'a fresh part')
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream (no steward, no note)')
  assert.deepEqual(b.calls.warnings.filter(line => /steward failed|handoff note/.test(line)), [], 'no repeated failure warnings')
  assert.equal(b.calls.warnings.filter(line => /no model answers beside it/.test(line)).length, 1, 'one diagnostic for the Session')
  assert.equal(b.bot.segments.at(-1).fallback, 'recent')
  assert.equal(b.recorded(), b.recordedBefore, 'no message deleted from the record')
})

test('case 7, below the hard line: a CLI-only Bot past its check line skips the steward and stays, noted once', async (t) => {
  // 3 x 140k = 420k: past the 400k check line of the 500k default, below the 475k hard line.
  const b = await switchBench({ perNode: 140_000 })
  t.after(b.stop)
  for (let round = 0; round < 3; round += 1) {
    b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream')
  assert.equal(b.calls.created.length, 0, 'no fresh part below the hard line')
  assert.equal(b.calls.warnings.filter(line => /no model answers beside it/.test(line)).length, 1, 'one diagnostic for the Session')
  await assert.rejects(b.rt.checkpointBot('b1', { sessionId: 's1' }), 'no checkpoint without a model that answers aside')
  assert.deepEqual(b.streams(), [])
})

test('case 8: the fresh part\'s handoff carries the recent messages that fit the destination, with a pointer to the rest', async (t) => {
  const b = await switchBench({ perNode: 60_000, reopened: true })
  t.after(b.stop)
  await b.step('api', 'small')
  await until(() => b.calls.followups.length > 0, 1000)
  const handoff = b.calls.followups.find(entry => entry.id === 'fresh1')?.message
  assert.ok(handoff, 'the fresh part opens with a handoff')
  const text = handoff.content.map(block => block.text).join('\n')
  assert.match(text, /latest request/)
  assert.match(text, /read_own_chat/)
  assert.match(text, /No note, on purpose: the conversation moved to api\/small/)
  assert.match(text, /model changed to api\/small/)
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream')
  assert.equal(b.recorded(), b.recordedBefore, 'no message deleted from the record')
})

test('case 8, a long part: the handoff carries only the latest messages that fit under the destination threshold', async (t) => {
  const b = await switchBench({ perNode: 60_000, reopened: true })
  t.after(b.stop)
  // A small destination policy: threshold 34,464, so a quarter is 8,616 tokens of messages.
  for (let index = 0; index < 40; index += 1) b.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `message ${index} ${'word '.repeat(800)}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await b.step('api', 'small')
  await until(() => b.calls.followups.length > 0, 1000)
  const text = b.calls.followups.find(entry => entry.id === 'fresh1').message.content.map(block => block.text).join('\n')
  const latest = text.slice(text.indexOf('## Latest messages'))
  assert.match(latest, /message 39 /)
  assert.doesNotMatch(latest, /message 0 /, 'older messages stay behind, readable through read_own_chat')
  assert.ok(Math.ceil(latest.length / 4) < 34_464 / 2, 'well inside the destination threshold')
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream')
})

test('case 8b: the fresh part\'s first call fails: the Bot goes back to the old part, which is never archived', async (t) => {
  // The CLI-only hard-line path is the one that reaches a fresh part today.
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  // The message that triggered the step is carried into the fresh part, and its first turn
  // takes it into its own record before the call fails.
  const asked = createUserMessage({ content: [{ type: 'text', text: 'please go on with the report' }], source: { kind: 'user', exchangeId: 'x-asked' } })
  await b.step('acp-codex', 'default', [asked])
  await until(() => b.calls.created.length > 0)
  assert.equal(b.calls.created.length, 1, 'a fresh part')
  assert.deepEqual(b.calls.archived, [], 'not archived before the fresh part\'s first answer')
  await until(() => b.calls.followups.some(entry => entry.id === 'fresh1' && entry.message.source?.exchangeId === 'x-asked'), 1000)
  b.firstTurn('fresh1', { answer: false })
  await until(() => b.bot.sessionId === 's1', 1000)
  assert.equal(b.bot.sessionId, 's1', 'the Bot is back on the old part')
  assert.deepEqual(b.calls.selected.at(-1), ['s1', 'acp-codex/default'], 'the Session selection is back on the old part')
  assert.deepEqual(b.bot.segments, [], 'the old part is current again, not an earlier one')
  await until(() => b.calls.archived.length > 0, 300)
  assert.ok(!b.calls.archived.includes('s1'), 'the old part stays resumable')
  assert.deepEqual(b.calls.archived, ['fresh1'], 'the unused fresh part is archived, its record kept')
  const waiting = [...b.agent.inbox.nextStep, ...b.agent.inbox.nextTurn]
  assert.deepEqual(waiting.map(message => message.content.map(block => block.text).join('')), ['please go on with the report'], 'the triggering message is back in the old part, once, and the handoff stays behind')
  assert.equal(waiting[0].source.exchangeId, 'x-asked')
  assert.deepEqual(b.streams(), [], 'zero ctx.llm.stream')
})

test('case 8b, a first call that fails at once, during the handoff itself, still sends the Bot back', async (t) => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  // The fresh part's first turn ends in error synchronously, as the handoff is followed up.
  b.calls.onFollowup = (id, message) => {
    if (id !== 'fresh1' || message.source?.handoff !== true) return
    b.calls.onFollowup = undefined
    b.firstTurn('fresh1', { answer: false })
  }
  const asked = createUserMessage({ content: [{ type: 'text', text: 'one more thing' }], source: { kind: 'user', exchangeId: 'x-fast' } })
  await b.step('acp-codex', 'default', [asked])
  await until(() => b.calls.archived.length > 0, 1000)
  assert.equal(b.bot.sessionId, 's1', 'the Bot is back on the old part')
  assert.deepEqual(b.bot.segments, [])
  assert.deepEqual(b.calls.archived, ['fresh1'], 'the old part is not archived; the fresh one is')
  const waiting = [...b.agent.inbox.nextStep, ...b.agent.inbox.nextTurn]
  assert.deepEqual(waiting.map(message => message.source?.exchangeId), ['x-fast'], 'the carried message, forwarded after the failure, is taken back too')
  assert.deepEqual(b.streams(), [])
})

test('case 8b\', a first answer that comes at once, during the handoff itself, archives the old part', async (t) => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  b.calls.onFollowup = (id, message) => {
    if (id !== 'fresh1' || message.source?.handoff !== true) return
    b.calls.onFollowup = undefined
    b.firstTurn('fresh1', { answer: true })
  }
  await b.step('acp-codex', 'default')
  await until(() => b.calls.archived.length > 0, 1000)
  assert.deepEqual(b.calls.archived, ['s1'])
  assert.equal(b.bot.sessionId, 'fresh1')
  assert.equal(b.bot.segments.at(-1).archivePending, undefined, 'the pending mark is cleared')
})

test('case 8b, the handoff acknowledgment is not the fresh part\'s answer', async (t) => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  await b.step('acp-codex', 'default')
  await until(() => b.calls.created.length > 0)
  // The bare handoff turn is answered by Omni itself, on the fresh part's route.
  const ack = b.ctx.llm.stream({ provider: 'acp-codex', model: 'default', sessionId: 'fresh1', messages: [b.calls.followups.find(entry => entry.id === 'fresh1').message] })
  for await (const chunk of ack) assert.ok(chunk)
  const fresh = b.sessions.get('fresh1')
  b.ctx.emit('session/event', fresh, fresh.append('assistant/message', { turn: 1, message: { role: 'assistant', source: { provider: 'acp-codex', model: 'default' }, content: [{ type: 'text', text: 'Noted.' }] } }, { surfaceOp: 'append' }))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(b.calls.archived, [], 'not archived on the acknowledgment')
  b.firstTurn('fresh1', { answer: true })
  await until(() => b.calls.archived.length > 0, 1000)
  assert.deepEqual(b.calls.archived, ['s1'])
  assert.deepEqual(b.calls.agent, [], 'the acknowledgment called no model')
})

test('case 8b, another model picked before the first answer: that answer settles the switch, and a later failure never goes back', async (t) => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  await b.step('acp-codex', 'default')
  await until(() => b.calls.created.length > 0)
  assert.equal(b.bot.sessionId, 'fresh1')
  // The person picks another model before the fresh part answered on the one it opened on.
  b.bot.model = 'acp-claude/default'
  const fresh = b.sessions.get('fresh1')
  const asked = createUserMessage({ content: [{ type: 'text', text: 'already answered question' }], source: { kind: 'user' } })
  for (const event of [
    fresh.append('turn/start', { turn: 1 }),
    fresh.append('user/message', asked, { surfaceOp: 'append' }),
    fresh.append('assistant/message', { turn: 1, message: { role: 'assistant', source: { provider: 'acp-claude', model: 'default' }, content: [{ type: 'text', text: 'Answered on the new model.' }] } }, { surfaceOp: 'append' }),
    fresh.append('turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]) b.ctx.emit('session/event', fresh, event)
  await until(() => b.calls.archived.length > 0, 1000)
  assert.deepEqual(b.calls.archived, ['s1'], 'the answer on the new model settles the switch')
  // Much later, a turn of the fresh part fails.
  for (const event of [
    fresh.append('turn/start', { turn: 2 }),
    fresh.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'NETWORK', message: 'reset' } } }),
  ]) b.ctx.emit('session/event', fresh, event)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(b.bot.sessionId, 'fresh1', 'the Bot stays on the part that answered')
  assert.deepEqual(b.calls.archived, ['s1'], 'the answered part is not archived')
  assert.deepEqual([...b.agent.inbox.nextStep, ...b.agent.inbox.nextTurn], [], 'nothing answered is queued again in the outgrown part')
})

test('case 8b, the acknowledgment turn ending does not count as the fresh part\'s answer', async (t) => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  await b.step('acp-codex', 'default')
  await until(() => b.calls.created.length > 0)
  const ack = b.ctx.llm.stream({ provider: 'acp-codex', model: 'default', sessionId: 'fresh1', messages: [b.calls.followups.find(entry => entry.id === 'fresh1').message] })
  for await (const chunk of ack) assert.ok(chunk)
  const fresh = b.sessions.get('fresh1')
  for (const event of [
    fresh.append('turn/start', { turn: 1 }),
    fresh.append('assistant/message', { turn: 1, message: { role: 'assistant', source: { provider: 'acp-codex', model: 'default' }, content: [{ type: 'text', text: 'Noted.' }] } }, { surfaceOp: 'append' }),
    fresh.append('turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]) b.ctx.emit('session/event', fresh, event)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(b.calls.archived, [], 'not settled by the acknowledgment turn')
  b.firstTurn('fresh1', { answer: false })
  await until(() => b.bot.sessionId === 's1', 1000)
  assert.equal(b.bot.sessionId, 's1', 'the first real turn failing still goes back')
})

test('case 8b\': the old part is archived once the fresh part answers', async (t) => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  await b.step('acp-codex', 'default')
  await until(() => b.calls.created.length > 0)
  assert.equal(b.calls.created.length, 1, 'a fresh part')
  assert.equal(b.bot.sessionId, 'fresh1')
  assert.deepEqual(b.calls.archived, [], 'not archived before the fresh part\'s first answer')
  b.firstTurn('fresh1', { answer: true })
  await until(() => b.calls.archived.length > 0, 1000)
  assert.deepEqual(b.calls.archived, ['s1'], 'archived after the fresh part\'s first matching answer')
  assert.equal(b.bot.sessionId, 'fresh1')
  assert.equal(b.bot.segments.at(-1).archivePending, undefined, 'the pending mark is cleared')
})


test('an rc.2 retry keeps its next-turn boundary and rpcId through a failed part switch', async t => {
  const b = await switchBench({ perNode: 170_000, model: 'acp-codex/default' })
  t.after(b.stop)
  const retry = createUserMessage({ content: [], source: { kind: 'retry', rpcId: 'retry-switch-probe' } })
  await b.step('acp-codex', 'default', [retry])
  await until(() => b.calls.followups.some(entry => entry.id === 'fresh1' && entry.message.source?.rpcId === 'retry-switch-probe'), 1000)
  const fresh = b.agents.get('fresh1')
  assert.equal(fresh.inbox.nextTurn.filter(message => message.source?.rpcId === 'retry-switch-probe').length, 1)
  assert.equal(fresh.inbox.nextStep.filter(message => message.source?.rpcId === 'retry-switch-probe').length, 0)
  b.firstTurn('fresh1', { answer: false })
  await until(() => b.bot.sessionId === 's1' && b.calls.archived.length > 0, 1000)
  const waiting = b.agent.inbox.nextTurn.filter(message => message.source?.rpcId === 'retry-switch-probe')
  assert.equal(waiting.length, 1)
  assert.deepEqual(waiting[0].content, [])
  assert.deepEqual(waiting[0].source, { kind: 'retry', rpcId: 'retry-switch-probe' })
  assert.equal(b.agent.inbox.nextStep.filter(message => message.source?.rpcId === 'retry-switch-probe').length, 0)
  assert.deepEqual(b.calls.archived, ['fresh1'])
  assert.deepEqual(b.streams(), [])
})

test('checkpoint retries a transient stream failure before persisting its complete summary', async t => {
  const b = backendBench(); t.after(b.stop)
  let attempts = 0
  const stream = b.ctx.llm.stream
  b.ctx.llm.providerRetryPolicy = () => ({ mode: 'normal', maxRetries: 1, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 })
  b.ctx.llm.stream = async function* (options) {
    if (++attempts === 1) {
      yield { type: 'text-delta', index: 0, text: 'broken partial' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'temporary failure' } } }
    } else yield* stream(options)
  }
  await b.rt.checkpointBot('b1', { sessionId: 's1' })
  assert.equal(attempts, 2)
  const summary = b.calls.persisted.find(event => event.type === 'compaction/summary').data.summary[0].text
  assert.match(summary, /A summary/)
  assert.doesNotMatch(summary, /broken partial/)
})

test('the context steward retries a transient failure before choosing compaction', async t => {
  const b = backendBench(); t.after(b.stop)
  b.bot.contextCheckRatio = .1
  let attempts = 0
  const stream = b.ctx.llm.stream
  b.ctx.llm.providerRetryPolicy = () => ({ mode: 'normal', maxRetries: 1, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 })
  b.ctx.llm.stream = async function* (options) {
    if (options.system === undefined) return yield* stream(options)
    if (++attempts === 1) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'temporary failure' } } }
    } else {
      yield { type: 'text-delta', index: 0, text: '{"action":"compact","reason":"work remains"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
  await until(() => b.calls.persisted?.some(event => event.type === 'compaction/summary'), 2000)
  assert.equal(attempts, 2)
})

// A carried note can make a replacement handoff too large while an in-place
// checkpoint can still shrink it. Switch feasibility must not suppress compaction.
for (const trigger of ['idle', 'pre-step']) {
  test(`${trigger} compacts a large carried note before checking whether another handoff fits`, async t => {
    const priorNote = 'Prior decisions and unfinished work. '.repeat(880)
    const b = backendBench({ priorNote }); t.after(b.stop)
    b.bot.segments = [{ sessionId: 'old', number: 1, note: priorNote, noteFrom: 1, endedAt: 1 }]
    const size = message => Math.ceil(message.content.filter(block => block.type === 'text').map(block => block.text).join('').length / 4)
    b.ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 10000 } })
    b.ctx.tokenMeter.estimateMessage = size
    b.ctx.tokenMeter.measure = target => {
      const nodes = target.surface.nodes.map(seq => {
        const event = target.eventAt(seq)
        const tokens = size(event.data.message ?? event.data)
        return { seq, tokens, heuristicTokens: tokens }
      })
      return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0), nodes }
    }
    b.ctx.llm.stream = async function* (options) {
      b.calls.streams.push(options)
      yield { type: 'text-delta', index: 0, text: options.messages.tag?.kind === 'steward' ? '{"action":"compact"}' : 'A summary of the prior decisions.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const before = b.ctx.tokenMeter.measure(b.session).totalTokens
    assert.equal(before, 8743)
    assert.ok(before < 9000 && before > 8550, 'current input fits the usable window but crosses the hard line')
    if (trigger === 'idle') {
      b.ctx.emit('agent/status', { agent: b.agent, status: 'idle' })
      await until(() => b.calls.persisted?.some(event => event.type === 'compaction/summary'), 2000)
    } else {
      // The step path uses the backend's overflow entry point inside an active turn.
      const original = b.compaction[Symbol.for('ds-bot/compaction')]
      original.compactIfNeeded = BasicCompactionEngine.prototype.compactIfNeeded
      original.compactRegion = BasicCompactionEngine.prototype.compactRegion
      b.session.append('turn/start', { turn: 1 })
      const decision = await b.preStep({ agent: b.agent, messages: [], step: 1, signal: new AbortController().signal }, async () => 'next')
      assert.equal(decision, 'next')
      // Turn-owned compaction is persisted by the turn, rather than an idle flush.
      b.calls.persisted = b.session.snapshotEvents()
    }
    assert.ok(b.calls.persisted?.some(event => event.type === 'compaction/summary'), 'automatic compaction must run before the switch-size guard')
    assert.deepEqual(b.calls.streams.map(options => options.messages.tag.kind), ['steward', 'checkpoint'])
    assert.equal(b.ctx.tokenMeter.measure(b.session).totalTokens, 755)
    assert.equal(b.bot.sessionId, 's1', 'compaction keeps the current part')
    assert.deepEqual([...b.rt.switchJobs()], [])
  })
}
