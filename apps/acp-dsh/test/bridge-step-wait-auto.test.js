// #969 item 7 on Auto and on a Session another copy of this module guards: a bridge call that
// arrives between two steps of a turn still running waits for the next step, is reviewed there,
// and runs; past the bound it is refused as before. The Auto host below is backchannel.test.js's
// own (copied, not changed). Every id and text is synthetic.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { Session } from '@deepseek-ai/dsh-session'
import { aside } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { credentialShapes } from '../src/host/redact.js'

const TOOLS = [
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
]


// Auto review's real pre-execute listener, over the same Session the bridge writes to. The fake
// tools.execute mirrors the pipeline's prepare stage: it runs the listener before the body and
// turns a non-allow decision into an error result. The reviewer stream is the test's model.
const ALLOW = '{"risk":"low","decision":"allow"}'

const reviewer = (text, signal) => (async function* () {
  if (signal?.aborted) throw new Error('aborted')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

const abortedResult = callId => ({
  results: [{ callId, result: { content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }], isError: true, error: { message: 'tool call aborted before dispatch', info: { name: 'AbortError', code: 'TOOL_ABORTED_BEFORE_DISPATCH' } } } }],
})

const failedResult = (callId, decision) => ({
  results: [{
    callId,
    result: {
      content: [{ type: 'text', text: `Error: ${decision.reason}` }],
      isError: true,
      error: { message: decision.reason, ...(decision.info === undefined ? {} : { info: decision.info }) },
    },
  }],
})

function reviewHost({ sandbox = 'danger-full-access', policy = 'ask', preset = 'auto', override = 'never', answer = 'allowed-once', tools = TOOLS, headerTools = tools, route = true, decisions = [], reviewTimeoutMs = 5000, holdBody = false, holdApproval = false, failCallRow = false } = {}) {
  const session = Session.create('s1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  if (route) {
    session.append('request/header', {
      header: { config: { provider: 'acp-fake', model: 'default' }, ...(headerTools.length > 0 ? { tools: headerTools } : {}) },
      reason: 'initial',
    })
  }
  if (failCallRow) {
    const append = session.append.bind(session)
    session.append = (type, data, options) => {
      if (type === 'tool/call') throw new Error('call row failed')
      return append(type, data, options)
    }
  }
  const agent = { session }
  const asked = []
  const executed = []
  const streams = []
  const levelListeners = new Set()
  const preExecute = []
  const dispatchListeners = []
  let level = preset
  let mode = sandbox
  let resolveStarted
  let started = new Promise(resolve => { resolveStarted = resolve })
  const restart = () => { started = new Promise(resolve => { resolveStarted = resolve }) }
  let resolveBody
  let releaseBody
  let bodyGate
  let bodyStarted
  const resetBody = () => {
    bodyGate = new Promise(resolve => { releaseBody = resolve })
    bodyStarted = new Promise(resolve => { resolveBody = resolve })
  }
  resetBody()
  let resolveApprovalStarted
  let approvalStarted = new Promise(resolve => { resolveApprovalStarted = resolve })
  let releaseApproval
  let approvalGate
  const resetApproval = () => {
    approvalGate = new Promise(resolve => { releaseApproval = resolve })
    approvalStarted = new Promise(resolve => { resolveApprovalStarted = resolve })
  }
  resetApproval()
  const permissionPresets = {
    current: () => level,
    registerAuto: () => () => {},
  }
  const ctx = {
    approval: {
      effectivePolicy: () => policy,
      overrideOf: () => override,
      request: async (request) => {
        asked.push(request)
        if (holdApproval) {
          resolveApprovalStarted()
          await approvalGate
        }
        return typeof answer === 'function' ? answer(request) : answer
      },
    },
    permissionPresets,
    workingDirectory: { ensure: async () => '/tmp' },
    logger: { warn: () => {} },
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => tools,
          executable: toolName => tools.find(definition => definition.name === toolName),
          execute: async ({ calls, agent: callAgent, signal }) => {
            const call = calls[0]
            if (signal?.aborted) return abortedResult(call.id)
            const exec = { callId: call.id, rootCallId: call.id, name: call.name, arguments: JSON.parse(call.arguments || '{}'), agent: callAgent, signal }
            const gate = async (index) => (index >= preExecute.length ? { kind: 'allow' } : preExecute[index].listener(exec, () => gate(index + 1)))
            let decision = await gate(0)
            if (decision.kind === 'ask') {
              const outcome = await ctx.approval.request({ agent: callAgent, toolName: call.name, callId: call.id })
              if (signal?.aborted) return abortedResult(call.id)
              decision = outcome === 'allowed-once'
                ? { kind: 'allow' }
                : { kind: 'deny', reason: `approval ${outcome}`, info: { name: 'ApprovalDeniedError', code: String(outcome).toUpperCase() } }
            }
            if (decision.kind !== 'allow') return failedResult(call.id, decision)
            const body = async () => {
              executed.push({ name: call.name, arguments: call.arguments })
              if (holdBody) {
                resolveBody()
                await bodyGate
              }
              return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: `ran ${call.name}` }], isError: false } }] }
            }
            const dispatch = async (index) => (index >= dispatchListeners.length ? body() : dispatchListeners[index].listener(exec, () => dispatch(index + 1)))
            return dispatch(0)
          },
        }
      }
      if (name === 'approval') return ctx.approval
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      if (name === 'permissionPresets') return permissionPresets
      return undefined
    },
    on: (name, listener, options) => {
      if (name === 'tools/pre-execute' || name === 'tools/execute') {
        const entries = name === 'tools/pre-execute' ? preExecute : dispatchListeners
        const entry = { listener }
        if (options?.prepend) entries.unshift(entry)
        else entries.push(entry)
        return () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
      }
      if (name === 'session/event') { levelListeners.add(listener); return () => levelListeners.delete(listener) }
      return () => {}
    },
    effect: (fn) => {
      const iterator = fn()
      let next = iterator.next()
      while (!next.done) next = iterator.next(next.value)
      return next.value
    },
  }
  const baseStream = (options) => {
    streams.push(options)
    resolveStarted()
    const decision = decisions.shift()
    return typeof decision === 'function' ? decision(options.signal) : reviewer(decision ?? ALLOW, options.signal)
  }
  ctx.llm = { stream: baseStream }
  if (route) {
    const routed = aside(
      new Map([['acp-fake', {}]]),
      { llm: { stream: baseStream }, get: () => undefined },
      () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
      credentialShapes,
    )
    ctx.llm = { stream: options => routed(options, () => baseStream(options)) }
  }
  applyAutoReview(ctx)
  const backchannel = new Backchannel({ ctx, reviewTimeoutMs })
  const flipLevel = () => {
    level = 'manual'
    mode = 'workspace-write'
    for (const listener of levelListeners) listener(session, { type: 'permission/preset', data: { preset: 'manual' } })
  }
  const nextReview = () => { restart(); return started }
  return { ctx, agent, session, asked, executed, streams, backchannel, flipLevel, nextReview, bodyStarted, releaseBody, approvalStarted, releaseApproval }
}
import { guardSession } from '../src/host/write-guard.js'

const settle = async (count = 5) => { for (let i = 0; i < count; i += 1) await new Promise(resolve => setImmediate(resolve)) }

test('#969 Auto: a call between steps waits, is reviewed in the next step and runs there', async () => {
  const h = reviewHost({ decisions: [ALLOW] })
  try {
    h.session.append('step/end', { turn: 1, step: 0 })
    const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent', promptRunning: () => true })
    const pending = h.backchannel.call(record, { name: 'bash', arguments: { command: 'echo hi' }, callId: 'auto-between' })
    await settle()
    assert.equal(h.streams.length, 0, 'nothing is reviewed before the step opens')
    assert.equal(h.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0, 'no row while it waits')
    h.session.append('step/start', { turn: 1, step: 1 })
    const body = await pending
    assert.equal(body.isError, false, JSON.stringify(body))
    assert.equal(h.streams.length, 1, 'reviewed once')
    assert.equal(h.executed.length, 1, 'the body ran')
    const calls = h.session.snapshotEvents().filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => [event.data.turn, event.data.step]), [[1, 1]])
  } finally {
    h.backchannel.dispose()
  }
})

test('#969 Auto: past the bound a call between steps is still AUTO_REVIEW_NO_STEP, with no review', async () => {
  const h = reviewHost({ decisions: [ALLOW] })
  const backchannel = new Backchannel({ ctx: h.ctx, stepWaitMs: 30 })
  try {
    h.session.append('step/end', { turn: 1, step: 0 })
    const record = backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent', promptRunning: () => true })
    const body = await backchannel.call(record, { name: 'bash', arguments: {}, callId: 'auto-bound' })
    assert.equal(body.error?.code, 'AUTO_REVIEW_NO_STEP')
    assert.equal(h.streams.length, 0)
    assert.equal(h.executed.length, 0)
  } finally {
    backchannel.dispose()
    h.backchannel.dispose()
  }
})

test('#969: a guard left by an older copy of this module (no listeners) is polled, not a 500', async () => {
  const session = Session.create('older-guard')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'acp-probe', model: 'probe-model' }, tools: TOOLS }, reason: 'initial' })
  session.append('step/end', { turn: 1, step: 1 })
  // The older module's guard, still held for a call in flight: it has no listeners and never
  // notifies anyone.
  const older = guardSession(session)
  const guard = session[Symbol.for('@automagik/acp-dsh/write-guard')]
  delete guard.listeners
  guard.notify = () => {}
  const ctx = {
    get: name => name === 'tools'
      ? { definitions: () => TOOLS, executable: n => TOOLS.find(t => t.name === n), execute: async ({ calls }) => ({ results: [{ callId: calls[0].id, result: { content: [{ type: 'text', text: 'ran' }], isError: false } }] }) }
      : name === 'approval' ? { effectivePolicy: () => 'never' }
      : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'danger-full-access' }) }
      : name === 'agentPresets' ? { presetForSession: () => 'standard' }
      : undefined,
  }
  const backchannel = new Backchannel({ ctx, stepWaitMs: 2_000 })
  try {
    const record = backchannel.mint({ sessionId: 'older-guard', agent: { session }, name: 'probe', promptRunning: () => true })
    const pending = backchannel.call(record, { name: 'bash', arguments: {}, callId: 'older-1' })
    await settle()
    session.append('step/start', { turn: 1, step: 2 })
    const started = Date.now()
    const body = await pending
    assert.equal(body.isError, false, JSON.stringify(body))
    assert.ok(Date.now() - started < 1_000, 'woken by the poll, not by the bound')
    const calls = session.snapshotEvents().filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => [event.data.turn, event.data.step]), [[1, 2]])
  } finally {
    backchannel.dispose()
    older.release()
  }
})
