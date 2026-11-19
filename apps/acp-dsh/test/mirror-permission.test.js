// A mirrored ACP call through DSH's real tool pipeline: its ToolsService and native executor,
// the real Auto review plugin and its gate, and this adapter's mirror registered in the agent's
// own scope, as `registerMirror` does it. Calling the mirror's execute() directly would miss
// the refusals before its body and the review that already answered for a call. The agent's
// question must receive that refusal or that single-use answer, bound to the reviewed call.
//
// The harness keeps to what DSH does. The pipeline writes the `tool/call` row itself (the batch
// is run with `log`), the mirror is admitted by a step's resolved tool set, and the permission
// service reads Auto only while Auto review's `registerAuto` is live.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { callArguments, TOOL_NAME } from '../src/host/tool.js'

const PROVIDER = 'acp-fake'
const ALLOW = '{"risk":"low","decision":"allow"}'
const DENY = '{"risk":"high","decision":"deny","reason":"no"}'
const OPTIONS = [
  { kind: 'allow_once', optionId: 'yes', name: 'Allow' },
  { kind: 'reject_once', optionId: 'no', name: 'Reject' },
]
const ALLOW_ALWAYS = { kind: 'allow_always', optionId: 'always', name: 'Always' }
const REJECT_ALWAYS = { kind: 'reject_always', optionId: 'never', name: 'Never' }
const LASTING_OPTIONS = [ALLOW_ALWAYS, OPTIONS[1]]
const LASTING_REASON = 'Test ACP offered to allow Read README.md only from now on ("Always"), not just once, so Automagik did not approve it.'
const CANCELLED = { outcome: { outcome: 'cancelled' } }
const picked = optionId => ({ outcome: { outcome: 'selected', optionId } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (ready) => { for (let i = 0; i < 200 && !ready(); i++) await tick() }
// An answer that must be there by now: a question nobody answers fails its test, never hangs it.
const soon = promise => Promise.race([promise, until(() => false).then(() => 'still waiting')])

/**
 * One DSH host: the real pipeline and Auto review, fakes for the services around them.
 * `preset` is the level a new chat starts on, `decision` what the reviewer's model answers,
 * `override` the Session's approval override (`never` is a delegated child), `answer` what the
 * person answers a dialog (a function may hold it open), `autoReview: false` leaves the Auto
 * integration out.
 */
async function world(t, { preset = 'auto', decision = ALLOW, override = 'ask', answer = 'allowed-once', autoReview = true } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  const asked = []
  const reviews = []
  const levels = new Map()
  // As dsh-permission-presets: a Session reads Auto only while an Auto integration is
  // registered. Without one the same knobs (ask, no sandbox) match no preset.
  let autoLive = false
  const levelOf = (session) => {
    const level = levels.get(session) ?? preset
    return level === 'auto' && !autoLive ? 'custom' : level
  }
  ctx.provide('approval', {
    effectivePolicy: session => (override === 'never' || levelOf(session) === 'danger-full-access' ? 'never' : 'ask'),
    overrideOf: () => override,
    request: async (request) => {
      asked.push(request)
      if (override === 'never') return 'rejected'
      return typeof answer === 'function' ? answer(request) : answer
    },
  })
  ctx.provide('permissionPresets', {
    current: levelOf,
    set: (session, level) => { levels.set(session, level) },
    registerAuto: () => {
      autoLive = true
      return () => { autoLive = false }
    },
  })
  ctx.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: levelOf(session) === 'workspace-write' ? 'workspace-write' : 'danger-full-access' }) })
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  ctx.provide('llm', { stream: options => (async function* () {
    reviews.push(options)
    const text = typeof decision === 'function' ? await decision(options) : decision
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() })
  if (autoReview) applyAutoReview(ctx)
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, { name: 'Test ACP' }]]))
  // Agent scopes are minted by a plugin that uses the tools service, as DSH's agents are.
  let agents
  await ctx.plugin({ name: 'test-agents', inject: ['tools'], apply(child) { agents = child } })
  t.after(() => adapter.dispose())

  /**
   * One chat on the agent: a DSH Session with its agent scope and the mirror in it, a live
   * agent run, and the agent's tool calls of one model step, each with its DSH call id.
   * `question: false` leaves a call's permission question for the test to send; `known: false`
   * is a call id the adapter did not create; `argumentsId` is another tool id in its arguments.
   */
  const chat = (id, calls = [{}]) => {
    const session = Session.create(id)
    const agent = { session, status: 'idle' }
    const scope = createScope(agents, agent)
    t.after(() => scope.dispose())
    agent.ctx = scope.ctx
    adapter.registerMirror(agent)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    const { name, description, parameters } = adapter.tool
    session.append('request/header', {
      header: { config: { provider: PROVIDER, model: 'default' }, tools: [{ name, description, parameters }] },
    })
    const run = new AgentRun({ name: 'Test ACP', cwd: process.cwd() })
    run.prompting = new Promise(() => {})
    // Every refusal the adapter hands this run from a `tools/result`.
    const refusals = []
    const refuse = run.refuse
    run.refuse = (...args) => { refusals.push(args); return refuse.apply(run, args) }
    const live = { provider: PROVIDER, run, name: 'Test ACP', calls: new Set(), toolIds: new Map(), open: true }
    adapter.live.set(session.id, live)
    const made = calls.map(({ callId = 'acp-call', remote = 'remote-call', path = 'README.md', title = `Read ${path}`, kind = 'read', question = true, known = true, argumentsId }, index) => {
      const tool = run.seeTool({ toolCallId: remote, title, kind, status: 'pending', rawInput: { path } })
      // As the adapter's stream does at the agent's tool call.
      if (known) {
        live.calls.add(callId)
        live.toolIds.set(callId, tool.id)
      }
      const one = { tool, callId, answers: [], block: { id: callId, name: TOOL_NAME, arguments: JSON.stringify({ ...callArguments(tool), ...(argumentsId ? { id: argumentsId } : {}) }) } }
      // The agent's question for the call; it closes the call once it has its answer.
      one.ask = (options = OPTIONS, toolCall = {}) => run.onPermission({ toolCall: { toolCallId: tool.id, ...toolCall }, options }).then((value) => {
        one.answers.push(value)
        return value
      })
      one.close = value => run.changeTool(tool, { status: value.outcome.optionId === 'yes' ? 'completed' : 'failed' })
      if (question) one.permission = one.ask().then((value) => { one.close(value); return value })
      one.index = index
      return one
    })
    session.append('assistant/message', {
      turn: 1, step: 0, stream: [],
      message: createAssistantMessage({ content: made.map(one => ({ type: 'tool-call', ...one.block })), source: { provider: PROVIDER, model: 'default' } }),
    }, { surfaceOp: 'append' })
    // `only` runs some of the step's calls, `blocks` other tool-call blocks, and `provider` is
    // the model the step's tools were admitted for.
    const execute = async ({ signal = new AbortController().signal, only = made, blocks = only.map(one => one.block), provider = PROVIDER } = {}) => {
      // The step's admission, as the agent loop resolves it before the model answers.
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider, model: 'default' }, signal: new AbortController().signal })
      try {
        const batch = await ctx.tools.execute({ calls: blocks, agent, signal, log: { turn: 1, step: 0 }, toolSet, maxParallelToolCalls: 1 })
        return batch.results.map(entry => entry.result)
      } finally {
        toolSet.dispose()
      }
    }
    const rows = type => session.snapshotEvents().filter(event => event.type === type)
    return { session, agent, run, live, calls: made, call: made[0], execute, refusals, rows, setLevel: level => levels.set(session, level) }
  }
  return { ctx, adapter, asked, reviews, chat }
}

// What DSH hands `tools/result` for a chat's call that was refused before its body.
const refusedExec = (c, one = c.call) => ({ name: TOOL_NAME, callId: one.callId, agent: c.agent, signal: new AbortController().signal, arguments: JSON.parse(one.block.arguments) })

// A gate of another plugin on `tools/pre-execute`, denying the DSH call ids it is given.
const denyGate = (ctx, callIds, reason = 'not here') => ctx.on('tools/pre-execute', (exec, next) => (callIds.includes(exec.callId) ? { kind: 'deny', reason } : next()))

// --- the harness itself ------------------------------------------------------------------

test('the harness runs the mirror from the agent scope, on a row the pipeline wrote', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1')
  assert.equal(c.rows('tool/call').length, 0, 'the test writes no tool/call row')
  assert.equal(w.ctx.tools.get(TOOL_NAME), undefined, 'the mirror is not a global tool')
  assert.equal(w.ctx.tools.get(TOOL_NAME, c.agent), w.adapter.tool, 'the agent scope holds the mirror')
  const [result] = await c.execute()
  assert.equal(result.isError, false)
  assert.equal(c.rows('tool/call').length, 1, 'the pipeline wrote the tool/call row')
  assert.equal(c.rows('tool/call')[0].data.callId, 'acp-call')
  assert.equal(c.rows('tool/result').length, 1)
})

test('the harness reads Auto only while the Auto integration is registered', async (t) => {
  // Auto's knobs with no reviewer: the gate reviews nothing, and the body asks as for custom.
  const w = await world(t, { autoReview: false })
  const c = w.chat('s1')
  assert.equal(w.ctx.permissionPresets.current(c.session), 'custom')
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.reviews.length, 0)
  assert.equal(w.asked.length, 1)
  assert.deepEqual(c.refusals, [])
})

// --- P03: the three cases of the investigation's appendix ---------------------------------

for (const [name, options, code] of [
  ['review denial', { decision: DENY, override: 'never' }, 'AUTO_REVIEW_DENIED'],
  ['review failure', { decision: 'invalid' }, 'AUTO_REVIEW_FAILED'],
  ['user rejection', { decision: DENY, answer: 'rejected' }, undefined],
]) {
  test(`an Auto ${name} answers the pending ACP permission even though the mirror body never ran`, async (t) => {
    const w = await world(t, options)
    const c = w.chat('s1')
    const [result] = await c.execute()
    assert.equal(result.isError, true)
    if (code) assert.equal(result.error.info.code, code)
    await tick()
    assert.equal(c.call.answers[0]?.outcome.optionId, 'no', 'the ACP agent must receive the refusal instead of waiting forever')
    assert.equal(c.call.answers.length, 1)
    assert.equal(w.reviews.length, 1)
    assert.equal(c.call.tool.permission, undefined, 'no question is left pending')
  })
}

// --- P01 and P02, fixed here --------------------------------------------------------------

test('Auto: a call its reviewer allowed is answered allow_once with no approval request', async (t) => {
  const w = await world(t)
  const c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.reviews.length, 1)
  assert.equal(w.asked.length, 0)
  assert.deepEqual(c.refusals, [])
  assert.equal(c.call.answers.length, 1)
})

test('Auto child (auto + never): a step its reviewer allowed runs', async (t) => {
  const w = await world(t, { override: 'never' })
  const c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.reviews.length, 1)
  assert.equal(w.asked.length, 0)
  assert.deepEqual(c.refusals, [], 'the body answered; the listener did not')
  assert.equal(c.call.answers.length, 1)
})

test("Auto deny under 'ask': the person is asked exactly once, by the pipeline", async (t) => {
  const w = await world(t, { decision: DENY })
  const c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.reviews.length, 1)
  assert.equal(w.asked.length, 1)
  assert.match(w.asked[0].reason, /^Auto review denied tool "acp_tool"/)
  assert.deepEqual(c.refusals, [])
})

// custom is Auto's knobs (ask, no sandbox) with no reviewer: the record's policy and sandbox
// still match it, so only the Auto identity check tells it apart.
for (const level of ['workspace-write', 'custom']) {
  test(`Auto: a level changed to ${level} between the gate and the body asks as today`, async (t) => {
    const w = await world(t)
    const c = w.chat('s1')
    w.ctx.on('tools/execute', (exec, next) => { c.setLevel(level); return next() })
    assert.equal((await c.execute())[0].isError, false)
    assert.deepEqual(await soon(c.call.permission), picked('yes'))
    assert.equal(w.reviews.length, 1)
    assert.equal(w.asked.length, 1)
    assert.equal(w.asked[0].toolName, TOOL_NAME)
  })
}

test('Auto: a call not reviewed at the gate (custom) asks, even when Auto is back by its question', async (t) => {
  const w = await world(t)
  const c = w.chat('s1')
  c.setLevel('custom')
  w.ctx.on('tools/execute', (exec, next) => { c.setLevel('auto'); return next() })
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.reviews.length, 0)
  assert.equal(w.asked.length, 1)
})

test('Auto: a level changed during the review asks as today', async (t) => {
  let c
  const w = await world(t, { decision: () => { c.setLevel('workspace-write'); return ALLOW } })
  c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.asked.length, 1)
})

// The record's gate is not prepended: it runs after Auto review's prepended gate, so it reads
// the level the review left, never the one before it.
test('Auto: a level changed during the review asks, even when Auto is back by the body', async (t) => {
  let c
  const w = await world(t, { decision: () => { c.setLevel('workspace-write'); return ALLOW } })
  c = w.chat('s1')
  w.ctx.on('tools/execute', (exec, next) => { c.setLevel('auto'); return next() })
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.reviews.length, 1)
  assert.equal(w.asked.length, 1)
})

// Each row DSH writes for a level change ends the review, even one that names the level the
// Session already has. The fakes read their own map, so only the row scan can stop it.
for (const [type, data] of [['permission/preset', { preset: 'auto' }], ['sandbox/mode', { mode: 'danger-full-access' }], ['approval/policy', { policy: 'ask' }]]) {
  test(`Auto: a ${type} row written after the call's own row asks, even when it names the same level`, async (t) => {
    let c
    const w = await world(t, { decision: () => { c.session.append(type, data); return ALLOW } })
    c = w.chat('s1')
    assert.equal((await c.execute())[0].isError, false)
    assert.deepEqual(await soon(c.call.permission), picked('yes'))
    assert.equal(w.asked.length, 1)
  })
}

test('Auto: the allow answers one request; a second one for the same call asks', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  const first = c.call.ask()
  const running = c.execute()
  assert.deepEqual(await soon(first), picked('yes'))
  assert.equal(w.asked.length, 0)
  const second = c.call.ask()
  assert.deepEqual(await soon(second), picked('yes'))
  assert.equal(w.asked.length, 1)
  c.call.close(await second)
  assert.equal((await running)[0].isError, false)
  assert.equal(c.call.answers.length, 2)
})

test('Auto: a call changed after its review (new input in the question) asks', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  const changed = c.call.ask(OPTIONS, { rawInput: { path: 'elsewhere.txt' } })
  const running = c.execute()
  assert.deepEqual(await soon(changed), picked('yes'))
  assert.equal(w.asked.length, 1)
  c.call.close(await changed)
  assert.equal((await running)[0].isError, false)
})

// Each field callArguments compares (input, diffs, locations): the question changes it, a later
// update changes it back, and the person is still asked about what the question showed.
for (const [what, question, back] of [
  ['its input', { rawInput: { path: 'elsewhere.txt' } }, { rawInput: { path: 'README.md' } }],
  ['a diff', { content: [{ type: 'diff', path: 'README.md', oldText: 'a', newText: 'b' }] }, { content: [] }],
  ['a location', { locations: [{ path: 'elsewhere.txt' }] }, { locations: [] }],
]) {
  test(`Auto: a question about a changed call (${what}) asks, even when a later update changes the call back`, async (t) => {
    const w = await world(t)
    const c = w.chat('s1', [{ question: false }])
    const changed = c.call.ask(OPTIONS, question)
    c.run.changeTool(c.call.tool, back)
    const running = c.execute()
    assert.deepEqual(await soon(changed), picked('yes'))
    assert.equal(w.asked.length, 1)
    c.call.close(await changed)
    assert.equal((await running)[0].isError, false)
  })
}

test('Auto: a call the agent changed after its question asks', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  const asking = c.call.ask()
  c.run.changeTool(c.call.tool, { rawInput: { path: 'elsewhere.txt' } })
  const running = c.execute()
  assert.deepEqual(await soon(asking), picked('yes'))
  assert.equal(w.asked.length, 1)
  c.call.close(await asking)
  assert.equal((await running)[0].isError, false)
})

test('Auto: arguments replaced after the review never stand in for the reviewed call', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  let changed
  w.ctx.on('tools/execute', (exec, next) => {
    exec.arguments = { ...exec.arguments, input: { path: 'elsewhere.txt' } }
    changed = c.call.ask(OPTIONS, { rawInput: { path: 'elsewhere.txt' } })
    return next()
  })
  const running = c.execute()
  await until(() => changed !== undefined)
  assert.deepEqual(await soon(changed), picked('yes'))
  assert.equal(w.asked.length, 1)
  c.call.close(await changed)
  assert.equal((await running)[0].isError, false)
})

test('Auto: arguments that name another tool never carry the allow to it', async (t) => {
  const w = await world(t)
  // Same title and input: only the adapter's own call-to-tool map tells them apart.
  const c = w.chat('s1', [
    { callId: 'acp-a', remote: 'remote-a', path: 'same.txt', argumentsId: 'remote-b' },
    { callId: 'acp-b', remote: 'remote-b', path: 'same.txt' },
  ])
  const [a, b] = c.calls
  assert.equal((await c.execute({ only: [a] }))[0].isError, false)
  assert.deepEqual(await soon(b.permission), picked('yes'))
  assert.equal(w.asked.length, 1, "the other call's question went to the person")
})

test('Auto: an agent that offers no allow_once is refused, never asked, and never sent allow_always', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  const asked = c.call.ask(LASTING_OPTIONS)
  const running = c.execute()
  assert.deepEqual(await soon(asked), picked('no'))
  assert.equal(w.asked.length, 0)
  c.call.close(await asked)
  const [result] = await running
  assert.equal(result.isError, false)
  assert.equal(result.meta.status, 'failed')
  assert.deepEqual(result.content, [{ type: 'text', text: LASTING_REASON }])
})

test("Auto: the person's approval of an escalation still leaves a lasting-only question refused", async (t) => {
  const w = await world(t, { decision: DENY })
  const c = w.chat('s1', [{ question: false }])
  const asked = c.call.ask(LASTING_OPTIONS)
  const running = c.execute()
  assert.deepEqual(await soon(asked), picked('no'))
  c.call.close(await asked)
  const [result] = await running
  assert.equal(w.reviews.length, 1)
  assert.equal(w.asked.length, 1)
  assert.match(w.asked[0].reason, /^Auto review denied tool "acp_tool"/)
  assert.equal(result.meta.status, 'failed')
  assert.deepEqual(result.content, [{ type: 'text', text: LASTING_REASON }])
})

test('Auto: a denial before the body can still use the agent\'s reject_always', async (t) => {
  const w = await world(t, { override: 'never', decision: DENY })
  const c = w.chat('s1', [{ question: false }])
  const asked = c.call.ask([ALLOW_ALWAYS, REJECT_ALWAYS])
  const [result] = await c.execute()
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'AUTO_REVIEW_DENIED')
  assert.deepEqual(await soon(asked), picked('never'))
  assert.deepEqual(c.refusals, [['remote-call', false]])
  assert.equal(c.call.tool.lastingReason, undefined)
  assert.doesNotMatch(JSON.stringify(result.content), /offered to allow/)
})

test('Auto: a question the record check cannot read (a null location) is asked as today', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  const asking = c.call.ask(OPTIONS, { locations: [null] })
  const running = c.execute()
  assert.deepEqual(await soon(asking), picked('yes'))
  assert.equal(w.asked.length, 1)
  c.call.close(await asking)
  assert.equal((await running)[0].isError, false)
})

test('Auto: two calls, the reviewer allows one and denies the other (never): no allow crosses', async (t) => {
  const w = await world(t, { override: 'never', decision: options => (JSON.stringify(options.messages.at(-1)).includes('b.txt') ? DENY : ALLOW) })
  const c = w.chat('s1', [
    { callId: 'acp-a', remote: 'remote-a', path: 'a.txt' },
    { callId: 'acp-b', remote: 'remote-b', path: 'b.txt' },
  ])
  const [a, b] = c.calls
  const results = await c.execute()
  assert.equal(results[0].isError, false)
  assert.equal(results[1].isError, true)
  assert.equal(results[1].error.info.code, 'AUTO_REVIEW_DENIED')
  assert.deepEqual(await soon(a.permission), picked('yes'))
  assert.deepEqual(await soon(b.permission), picked('no'))
  assert.equal(w.asked.length, 0)
  assert.equal(w.reviews.length, 2)
})

test('Manual: a call another gate asked about is still asked by the body, as today', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  w.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    return exec.name === TOOL_NAME && decision.kind === 'allow' ? { kind: 'ask', reason: 'check' } : decision
  })
  const c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(c.call.permission), picked('yes'))
  assert.equal(w.asked.length, 2)
})

// --- the levels that are not Auto behave as today -----------------------------------------

for (const [preset, asks] of [['workspace-write', 1], ['danger-full-access', 0], ['custom', 1]]) {
  test(`${preset} keeps its own ACP approval behavior`, async (t) => {
    const w = await world(t, { preset })
    const c = w.chat('s1')
    assert.equal((await c.execute())[0].isError, false)
    assert.deepEqual(await soon(c.call.permission), picked('yes'))
    assert.equal(w.asked.length, asks)
    assert.equal(w.reviews.length, 0)
    assert.deepEqual(c.refusals, [], 'the listener answers nothing when the body ran')
    assert.equal(c.call.answers.length, 1)
    assert.equal(c.call.tool.refused, undefined)
  })
}

for (const preset of ['workspace-write', 'custom']) {
  test(`${preset}: the person's no in the mirror's own dialog is the one answer`, async (t) => {
    const w = await world(t, { preset, answer: 'rejected' })
    const c = w.chat('s1')
    await c.execute()
    assert.deepEqual(await soon(c.call.permission), picked('no'))
    assert.equal(w.asked.length, 1)
    assert.equal(w.reviews.length, 0)
    assert.deepEqual(c.refusals, [])
    assert.equal(c.call.answers.length, 1)
  })
}

test('Full access is not asked and not refused when a question comes late, as today', async (t) => {
  const w = await world(t, { preset: 'danger-full-access' })
  const c = w.chat('s1', [{ question: false }])
  const running = c.execute()
  await tick()
  const late = c.call.ask()
  assert.deepEqual(await soon(late), picked('yes'))
  c.call.close(await soon(late))
  assert.equal((await running)[0].isError, false)
  assert.equal(w.asked.length, 0)
  assert.deepEqual(c.refusals, [])
})

for (const [preset, level] of [['workspace-write', 'Manual'], ['danger-full-access', 'Full access']]) {
  test(`${level}: a lasting-only question is refused without a dialog`, async (t) => {
    const w = await world(t, { preset })
    const c = w.chat('s1', [{ question: false }])
    const asked = c.call.ask(LASTING_OPTIONS)
    const running = c.execute()
    assert.deepEqual(await soon(asked), picked('no'))
    c.call.close(await asked)
    const [result] = await running
    assert.equal(w.asked.length, 0)
    assert.equal(result.meta.status, 'failed')
    assert.deepEqual(result.content, [{ type: 'text', text: LASTING_REASON }])
  })
}

test('Manual: a lasting-only question with only reject_always is cancelled', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1', [{ question: false }])
  const asked = c.call.ask([ALLOW_ALWAYS, REJECT_ALWAYS])
  const running = c.execute()
  assert.deepEqual(await soon(asked), CANCELLED)
  c.call.close(await asked)
  const [result] = await running
  assert.equal(w.asked.length, 0)
  assert.equal(result.meta.text, LASTING_REASON)
})

test('Manual: a reject-only question still goes to the person', async (t) => {
  const w = await world(t, { preset: 'workspace-write', answer: 'rejected' })
  const c = w.chat('s1', [{ question: false }])
  const asked = c.call.ask([REJECT_ALWAYS])
  const running = c.execute()
  assert.deepEqual(await soon(asked), picked('never'))
  c.call.close(await asked)
  const [result] = await running
  assert.equal(w.asked.length, 1)
  assert.equal(w.asked[0].mirrorCall.allowOnce, false)
  assert.equal(result.meta.text, '')
})

test('a lasting-only image question uses its refusal reason as the image failure text', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1', [{ title: 'Image generation', kind: 'other', question: false }])
  const asked = c.call.ask([{ ...ALLOW_ALWAYS, optionId: 'first-always', name: 'Always\n  allow' }, ...LASTING_OPTIONS])
  const running = c.execute()
  assert.deepEqual(await soon(asked), picked('no'))
  c.call.close(await asked)
  const [result] = await running
  assert.equal(w.asked.length, 0)
  assert.equal(result.meta.status, 'failed')
  assert.deepEqual(result.content, [{ type: 'text', text: 'Test ACP offered to allow Image generation only from now on ("Always allow"), not just once, so Automagik did not approve it.' }])
})

// A native Agent card waits while its child asks. The child has no DSH call id yet.
async function waitingParent(w) {
  const c = w.chat('s1', [
    { title: 'Look around', kind: 'other', question: false },
    { callId: 'acp-child', remote: 'remote-child', question: false, known: false },
  ])
  c.live.native = true
  const [parent, child] = c.calls
  const running = c.execute({ only: [parent] })
  await until(() => c.run.askListeners.size > 0)
  assert.equal(c.run.askListeners.size, 1)
  return { c, parent, child, running }
}

test('Manual: a waiting parent refuses a nested question that only offers allow_always', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const { c, parent, child, running } = await waitingParent(w)
  const asked = child.ask([{ kind: 'allow_always', optionId: 'always' }])
  assert.deepEqual(await soon(asked), CANCELLED)
  child.close(await asked)
  parent.close(picked('yes'))
  const [parentResult] = await running
  const [childResult] = await c.execute({ only: [child] })
  assert.equal(w.asked.length, 0)
  assert.equal(parentResult.meta.text, '')
  assert.equal(childResult.meta.status, 'failed')
  assert.equal(childResult.meta.text, 'Test ACP offered to allow Read README.md only from now on, not just once, so Automagik did not approve it.')
})

test('Auto: a lasting-only question spends the review, so a second one-shot question is asked', async (t) => {
  const w = await world(t)
  const c = w.chat('s1', [{ question: false }])
  const first = c.call.ask(LASTING_OPTIONS)
  const running = c.execute()
  assert.deepEqual(await soon(first), picked('no'))
  assert.equal(w.asked.length, 0)
  const second = c.call.ask()
  assert.deepEqual(await soon(second), picked('yes'))
  assert.equal(w.asked.length, 1, 'the review answered only the first question')
  assert.equal(w.asked[0].mirrorCall.allowOnce, true)
  c.run.changeTool(c.call.tool, { rawOutput: 'Read complete.' })
  c.call.close(await second)
  const [result] = await running
  assert.equal(w.reviews.length, 1)
  assert.equal(result.meta.status, 'completed')
  assert.deepEqual(result.content, [{ type: 'text', text: 'Read complete.' }], 'the lasting-only reason is gone')
})

// --- other refusals before the body --------------------------------------------------------

test("another plugin's pre-execute gate refuses the call: the ACP question is rejected", async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-call'])
  const c = w.chat('s1')
  const [result] = await c.execute()
  assert.equal(result.isError, true)
  assert.deepEqual(await soon(c.call.permission), picked('no'))
  assert.equal(w.asked.length, 0)
  assert.equal(w.reviews.length, 0)
  assert.deepEqual(c.refusals, [['remote-call', false]])
})

test('a tool guard refuses the call: the ACP question is rejected', async (t) => {
  const w = await world(t, { preset: 'danger-full-access' })
  w.ctx.tools.guard(exec => (exec.name === TOOL_NAME ? 'guarded' : undefined))
  const c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, true)
  assert.deepEqual(await soon(c.call.permission), picked('no'), 'Full access does not turn a refused call into an allowed one')
  assert.equal(w.asked.length, 0)
})

test('a tools/execute wrapper that throws before the body: the ACP question is rejected', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  w.ctx.on('tools/execute', () => { throw new Error('this tool is not for this bot') })
  const c = w.chat('s1')
  assert.equal((await c.execute())[0].isError, true)
  assert.deepEqual(await soon(c.call.permission), picked('no'))
  assert.equal(w.asked.length, 0)
})

test('an agent that offers no reject option is answered cancelled, never an allow', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-call'])
  const c = w.chat('s1', [{ question: false }])
  const only = c.call.ask([{ kind: 'allow_once', optionId: 'yes', name: 'Allow' }, { kind: 'allow_always', optionId: 'always', name: 'Always' }])
  await c.execute()
  assert.deepEqual(await soon(only), CANCELLED)
  assert.deepEqual(await soon(c.call.ask([{ kind: 'allow_always', optionId: 'always', name: 'Always' }])), CANCELLED, 'and so is a late one')
})

test('an agent that offers only reject_always gets that option', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-call'])
  const c = w.chat('s1', [{ question: false }])
  const asked = c.call.ask([{ kind: 'allow_once', optionId: 'yes', name: 'Allow' }, { kind: 'reject_always', optionId: 'never', name: 'Never' }])
  await c.execute()
  assert.deepEqual(await soon(asked), picked('never'))
})

// --- a question that comes after the refusal ------------------------------------------------

test('an ACP question that arrives after the refusal is rejected at once', async (t) => {
  const w = await world(t, { decision: DENY, override: 'never' })
  const c = w.chat('s1', [{ question: false }])
  const [result] = await c.execute()
  assert.equal(result.error.info.code, 'AUTO_REVIEW_DENIED')
  assert.deepEqual(c.refusals, [['remote-call', false]])
  assert.equal(c.call.tool.refused, 'rejected')
  assert.deepEqual(await soon(c.call.ask()), picked('no'))
  assert.deepEqual(await soon(c.call.ask()), picked('no'), 'and every later one for the same call')
  assert.equal(c.call.tool.permission, undefined)
  assert.equal(w.asked.length, 0, 'no dialog is raised for a call DSH already refused')
  assert.equal(w.reviews.length, 1)
})

test('a late question after a gate refusal under Manual is rejected at once too', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-call'])
  const c = w.chat('s1', [{ question: false }])
  await c.execute()
  assert.deepEqual(await soon(c.call.ask()), picked('no'))
  assert.equal(w.asked.length, 0)
})

// --- Stop -----------------------------------------------------------------------------------

test('a call stopped before its body, at a gate, answers the ACP question cancelled, not rejected', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const stop = new AbortController()
  // The Stop lands while another plugin's gate holds the call, which then lets it through.
  w.ctx.on('tools/pre-execute', async (exec, next) => {
    stop.abort()
    return next()
  })
  const c = w.chat('s1')
  const [result] = await c.execute({ signal: stop.signal })
  assert.equal(result.isError, true)
  assert.deepEqual(await soon(c.call.permission), CANCELLED)
  assert.deepEqual(c.refusals, [['remote-call', true]])
  assert.equal(c.call.tool.refused, 'cancelled')
  assert.equal(w.asked.length, 0)
  assert.deepEqual(await soon(c.call.ask()), CANCELLED, 'a question after the Stop is cancelled as well')
})

test("a batch stopped before it starts keeps today's path: the turn's end withdraws the question", async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1')
  const stop = new AbortController()
  stop.abort()
  const [result] = await c.execute({ signal: stop.signal })
  assert.equal(result.isError, true)
  await tick()
  assert.equal(c.call.answers.length, 0, 'nothing here answers it; the cancel path below does, as before')
  c.run.endPrompt({ type: 'end', stopReason: 'cancelled' })
  assert.deepEqual(await soon(c.call.permission), CANCELLED)
  assert.equal(c.call.answers.length, 1)
  assert.equal(w.asked.length, 0)
})

test('a Stop during the Auto review answers the ACP question cancelled', async (t) => {
  const stop = new AbortController()
  let reviewing
  const started = new Promise((resolve) => { reviewing = resolve })
  const w = await world(t, {
    decision: options => new Promise((_, fail) => {
      reviewing()
      options.signal?.addEventListener('abort', () => fail(new Error('stopped')), { once: true })
    }),
  })
  const c = w.chat('s1')
  const running = c.execute({ signal: stop.signal })
  await started
  assert.equal(c.call.answers.length, 0)
  stop.abort()
  const [result] = await running
  assert.equal(result.isError, true)
  assert.deepEqual(await soon(c.call.permission), CANCELLED)
  assert.equal(w.asked.length, 0)
})

test("a Stop during the pipeline's own dialog answers the ACP question cancelled", async (t) => {
  const stop = new AbortController()
  const w = await world(t, {
    decision: DENY,
    answer: request => new Promise((resolve) => { request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true }) }),
  })
  const c = w.chat('s1')
  const running = c.execute({ signal: stop.signal })
  await until(() => w.asked.length === 1)
  assert.equal(c.call.answers.length, 0)
  stop.abort()
  assert.equal((await running)[0].isError, true)
  assert.deepEqual(await soon(c.call.permission), CANCELLED)
  assert.equal(w.asked.length, 1)
})

test('a Stop while the body waits in its dialog is answered by the body, once', async (t) => {
  const stop = new AbortController()
  const w = await world(t, {
    preset: 'workspace-write',
    answer: request => new Promise((resolve) => { request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true }) }),
  })
  const c = w.chat('s1')
  const running = c.execute({ signal: stop.signal })
  await until(() => w.asked.length === 1)
  stop.abort()
  await running
  assert.deepEqual(await soon(c.call.permission), CANCELLED)
  assert.deepEqual(c.refusals, [], 'the body ran, so the listener stays out')
  assert.equal(c.call.answers.length, 1)
})

// --- the right question, and only once -------------------------------------------------------

test('two calls in one Session: only the refused one is answered by the refusal', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-a'])
  const c = w.chat('s1', [
    { callId: 'acp-a', remote: 'remote-a', path: 'a.txt' },
    { callId: 'acp-b', remote: 'remote-b', path: 'b.txt' },
  ])
  const [a, b] = c.calls
  const results = await c.execute()
  assert.equal(results[0].isError, true)
  assert.equal(results[1].isError, false)
  assert.deepEqual(await soon(a.permission), picked('no'))
  assert.deepEqual(await soon(b.permission), picked('yes'), "the other call keeps its own dialog and the person's answer")
  assert.deepEqual(c.refusals, [['remote-a', false]])
  assert.equal(w.asked.length, 1)
  assert.equal(w.asked[0].callId, 'acp-b')
  assert.equal(a.answers.length, 1)
  assert.equal(b.answers.length, 1)
  assert.equal(b.tool.refused, undefined)
})

test('two calls in one Session: a refusal of the second leaves the first, already answered, alone', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-b'])
  const c = w.chat('s1', [
    { callId: 'acp-a', remote: 'remote-a', path: 'a.txt' },
    { callId: 'acp-b', remote: 'remote-b', path: 'b.txt' },
  ])
  const [a, b] = c.calls
  await c.execute()
  assert.deepEqual(await soon(a.permission), picked('yes'))
  assert.deepEqual(await soon(b.permission), picked('no'))
  assert.deepEqual(c.refusals, [['remote-b', false]])
  assert.equal(a.answers.length, 1)
  assert.equal(a.tool.refused, undefined)
})

test("a refusal in one Session leaves another Session's pending question untouched", async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  // The same DSH call id and the same agent tool id in both: only the Session tells them apart.
  const one = w.chat('s1')
  const two = w.chat('s2')
  const gate = w.ctx.on('tools/pre-execute', (exec, next) => (exec.agent === one.agent ? { kind: 'deny', reason: 'not here' } : next()))
  assert.equal((await one.execute())[0].isError, true)
  assert.deepEqual(await soon(one.call.permission), picked('no'))
  await tick()
  assert.equal(two.call.answers.length, 0, "the other Session's question is still pending")
  assert.notEqual(two.call.tool.permission, undefined)
  assert.equal(two.call.tool.refused, undefined)
  assert.deepEqual(two.refusals, [])
  // And it is then answered by its own call, as ever.
  gate()
  assert.equal((await two.execute())[0].isError, false)
  assert.deepEqual(await soon(two.call.permission), picked('yes'))
  assert.equal(w.asked.length, 1)
  assert.equal(w.asked[0].agent, two.agent)
  assert.deepEqual(one.refusals, [['remote-call', false]])
})

test('two Sessions at the same time: neither answers the other', async (t) => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  const w = await world(t, { preset: 'workspace-write', answer: () => held.then(() => 'allowed-once') })
  const one = w.chat('s1')
  const two = w.chat('s2')
  w.ctx.on('tools/pre-execute', (exec, next) => (exec.agent === one.agent ? { kind: 'deny', reason: 'not here' } : next()))
  const second = two.execute()
  await until(() => w.asked.length === 1)
  // The second Session's body is in its dialog when the first Session's call is refused.
  assert.equal((await one.execute())[0].isError, true)
  assert.deepEqual(await soon(one.call.permission), picked('no'))
  assert.equal(two.call.answers.length, 0)
  release()
  assert.equal((await soon(second))[0].isError, false)
  assert.deepEqual(await soon(two.call.permission), picked('yes'))
  assert.deepEqual(two.refusals, [])
  assert.equal(two.call.answers.length, 1)
})

test('a result for a call id the adapter did not create answers nothing', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['not-mine'])
  // Its arguments name a tool of this run with a pending question: the arguments are not trusted.
  const c = w.chat('s1', [{ callId: 'not-mine', known: false }])
  assert.equal((await c.execute())[0].isError, true)
  await tick()
  assert.equal(c.call.answers.length, 0)
  assert.notEqual(c.call.tool.permission, undefined)
  assert.equal(c.call.tool.refused, undefined)
  assert.deepEqual(c.refusals, [])
})

test('a refused result of another tool, or of a Session with no live agent, answers nothing', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1')
  w.ctx.tools.register({
    name: 'other_tool',
    description: 'Another tool',
    parameters: { id: { type: 'string' } },
    output: { schema: {}, render: () => [{ type: 'text', text: 'ran' }] },
    async execute() { return {} },
  })
  denyGate(w.ctx, ['acp-call'])
  const signal = new AbortController().signal
  // Another tool under the mirror's own call id and tool id.
  const other = await w.ctx.tools.execute({ calls: [{ id: 'acp-call', name: 'other_tool', arguments: JSON.stringify({ id: 'remote-call' }) }], agent: c.agent, signal })
  assert.equal(other.results[0].result.isError, true)
  await tick()
  assert.equal(c.call.answers.length, 0)
  assert.deepEqual(c.refusals, [])
  // The mirror's result for a Session the adapter no longer runs.
  w.adapter.live.delete(c.session.id)
  assert.equal((await c.execute())[0].isError, true)
  await tick()
  assert.equal(c.call.answers.length, 0)
  assert.deepEqual(c.refusals, [])
})

test('the refusal listener never throws into the pipeline', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-call'])
  const c = w.chat('s1')
  let thrown = 0
  c.run.refuse = () => { thrown++; throw new Error('boom') }
  const [result] = await c.execute()
  assert.equal(result.isError, true)
  assert.match(result.error.message, /not here/)
  assert.equal(thrown, 1, 'the listener reached the run, and its throw stayed there')
  // DSH would only log a failing observer, so the listener is also called as DSH calls it.
  assert.doesNotThrow(() => w.adapter.refusedFirst(refusedExec(c)))
  assert.equal(thrown, 2)
  assert.doesNotThrow(() => w.adapter.refusedFirst(undefined))
})

test('a disposed adapter stops listening', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-call'])
  const c = w.chat('s1')
  const calls = []
  const gates = []
  w.adapter.refusedFirst = exec => calls.push(exec)
  w.adapter.reviewedGate = (exec, next) => { gates.push(exec); return next() }
  w.adapter.dispose()
  assert.equal((await c.execute())[0].isError, true)
  await tick()
  assert.deepEqual(calls, [], 'dispose() took the tools/result listener off')
  assert.deepEqual(gates, [], 'dispose() took the tools/pre-execute listener off')
})

// --- more than one question for one call ------------------------------------------------------

test('a second question withdraws the first when the first was not asked yet', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1', [{ question: false }])
  const first = c.call.ask()
  const second = c.call.ask()
  assert.deepEqual(await soon(first), CANCELLED)
  assert.equal(c.call.answers.length, 1, 'the second is still waiting')
  second.then(c.call.close)
  assert.equal((await c.execute())[0].isError, false)
  assert.deepEqual(await soon(second), picked('yes'))
  assert.equal(w.asked.length, 1, 'one dialog, for the question that stands')
  assert.equal(c.call.answers.length, 2)
})

test('a second question while the first is in its dialog: the dialog answers the first, then the second is asked', async (t) => {
  const releases = []
  const w = await world(t, { preset: 'workspace-write', answer: () => new Promise((resolve) => { releases.push(resolve) }) })
  const c = w.chat('s1', [{ question: false }])
  const first = c.call.ask()
  const running = c.execute()
  await until(() => releases.length === 1)
  const second = c.call.ask()
  await tick()
  assert.equal(c.call.answers.length, 0, 'the first is not cancelled: its dialog is still open')
  releases[0]('allowed-once')
  assert.deepEqual(await soon(first), picked('yes'))
  await until(() => releases.length === 2)
  assert.equal(c.call.answers.length, 1)
  releases[1]('rejected')
  assert.deepEqual(await soon(second), picked('no'))
  c.call.close(await soon(second))
  await running
  assert.equal(w.asked.length, 2, 'no dialog is left open, and none is answered into the void')
  assert.deepEqual(c.refusals, [])
})

// --- review round: the guards one by one, and the adapter's own stream -------------------------

test("a refusal in the second Session leaves the first Session's pending question untouched", async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  // As above, with the refused Session registered second: a lookup that took the first live
  // record holding this call id would answer the wrong Session.
  const one = w.chat('s1')
  const two = w.chat('s2')
  w.ctx.on('tools/pre-execute', (exec, next) => (exec.agent === two.agent ? { kind: 'deny', reason: 'not here' } : next()))
  assert.equal((await two.execute())[0].isError, true)
  assert.deepEqual(await soon(two.call.permission), picked('no'))
  await tick()
  assert.deepEqual(two.refusals, [['remote-call', false]])
  assert.deepEqual(one.refusals, [])
  assert.equal(one.call.answers.length, 0, "the first Session's question is still pending")
  assert.notEqual(one.call.tool.permission, undefined)
  assert.equal(one.call.tool.refused, undefined)
  assert.equal(w.asked.length, 0)
  assert.equal(w.reviews.length, 0)
})

test("the refused tool is the one the adapter mapped to the call, never the one its arguments name", async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['acp-a'])
  // The adapter made acp-a for remote-a; the call's arguments name remote-b, another call of
  // this run with a question of its own pending.
  const c = w.chat('s1', [
    { callId: 'acp-a', remote: 'remote-a', path: 'a.txt', argumentsId: 'remote-b' },
    { callId: 'acp-b', remote: 'remote-b', path: 'b.txt' },
  ])
  const [a, b] = c.calls
  assert.equal(JSON.parse(a.block.arguments).id, 'remote-b')
  const [result] = await c.execute({ only: [a] })
  assert.equal(result.isError, true)
  assert.deepEqual(await soon(a.permission), picked('no'))
  await tick()
  assert.deepEqual(c.refusals, [['remote-a', false]])
  assert.equal(b.answers.length, 0, 'the tool the arguments name keeps its question')
  assert.notEqual(b.tool.permission, undefined)
  assert.equal(b.tool.refused, undefined)
  assert.equal(w.asked.length, 0)
})

test('a mapped tool id alone answers nothing: the call id must be one the adapter made', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  denyGate(w.ctx, ['not-mine'])
  const c = w.chat('s1', [{ callId: 'not-mine', known: false }])
  // The map names the tool, and the Session's own set of call ids does not hold the id.
  c.live.toolIds.set('not-mine', 'remote-call')
  assert.equal((await c.execute())[0].isError, true)
  await tick()
  assert.deepEqual(c.refusals, [])
  assert.equal(c.call.answers.length, 0)
  assert.notEqual(c.call.tool.permission, undefined)
  assert.equal(c.call.tool.refused, undefined)
})

test('a nested call (one with a parent) answers nothing', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1')
  w.adapter.refusedFirst({ ...refusedExec(c), parent: { callId: 'outer' } })
  assert.deepEqual(c.refusals, [])
  assert.equal(c.call.answers.length, 0)
  assert.equal(c.call.tool.refused, undefined)
  // The same result at the top level is this Session's refused call.
  w.adapter.refusedFirst(refusedExec(c))
  assert.deepEqual(c.refusals, [['remote-call', false]])
  assert.deepEqual(await soon(c.call.permission), picked('no'))
})

test('the mirror is not admitted for the step (UNKNOWN_TOOL): the ACP question is rejected', async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  const c = w.chat('s1')
  // The step's tools were resolved for a model that is not this adapter's agent.
  const [result] = await c.execute({ provider: 'another-provider' })
  assert.equal(result.isError, true)
  assert.equal(result.error.info.code, 'UNKNOWN_TOOL')
  assert.deepEqual(await soon(c.call.permission), picked('no'))
  assert.deepEqual(c.refusals, [['remote-call', false]])
  assert.equal(w.asked.length, 0)
  assert.equal(w.reviews.length, 0)
})

// DSH's pipeline has no time limit of its own: one can only come from a `tools/execute` wrapper,
// which either throws (the wrapper test above) or aborts the call's signal, as here.
test("a wrapper's time limit that ends the call before its body answers the ACP question cancelled", async (t) => {
  const w = await world(t, { preset: 'workspace-write' })
  w.ctx.on('tools/execute', (exec, next) => {
    exec.signal = AbortSignal.abort(new Error('timed out'))
    return next()
  })
  const c = w.chat('s1')
  const [result] = await c.execute()
  assert.equal(result.isError, true)
  assert.deepEqual(await soon(c.call.permission), CANCELLED)
  assert.deepEqual(c.refusals, [['remote-call', true]])
  assert.equal(w.asked.length, 0)
  assert.equal(c.call.answers.length, 1)
})

for (const [name, prepare] of [
  ['its stream', () => {}],
  ['its stream, on a live record made without the map', (live) => { delete live.toolIds }],
]) {
  test(`the adapter maps a call it makes in ${name} to the agent's tool id, and a refusal reaches it`, async (t) => {
    const w = await world(t, { preset: 'workspace-write' })
    // The agent's tool call is waiting in the run's queue: no DSH call id was made for it yet.
    const c = w.chat('s1', [{ known: false }])
    w.ctx.provide('agents', { get: id => (id === c.session.id ? c.agent : undefined), list: () => [] })
    prepare(c.live)
    // The step after an earlier call's result, as the agent loop asks for it.
    c.live.calls.add('acp-earlier')
    const chunks = []
    const messages = [{ role: 'tool', toolCallId: 'acp-earlier', content: [{ type: 'text', text: 'done' }] }]
    for await (const chunk of w.adapter.stream({ provider: PROVIDER, model: 'default', sessionId: c.session.id, messages, signal: new AbortController().signal })) chunks.push(chunk)
    const block = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block
    assert.equal(block?.name, TOOL_NAME)
    assert.match(block.id, /^acp_/)
    assert.equal(c.live.calls instanceof Set, true, 'live.calls stays a Set')
    assert.equal(c.live.calls.has(block.id), true)
    assert.equal(c.live.toolIds.get(block.id), 'remote-call')
    assert.equal(c.live.toolIds.size, 1)
    denyGate(w.ctx, [block.id])
    const [result] = await c.execute({ blocks: [{ id: block.id, name: block.name, arguments: block.arguments }] })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /not here/)
    assert.deepEqual(await soon(c.call.permission), picked('no'))
    assert.deepEqual(c.refusals, [['remote-call', false]])
    assert.equal(w.asked.length, 0)
  })
}
