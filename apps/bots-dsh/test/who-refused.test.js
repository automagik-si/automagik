import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ApprovalService, setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { approveEscalation } from '@deepseek-ai/dsh-sandbox'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyToolExecutor, inject as toolExecutorInject } from '@deepseek-ai/dsh-tool-executor-native'
import { install as installStops } from '../src/host/stops.js'
import { approvalPolicyOf, childRefusalNote, install, rewordRefusal } from '../src/host/who-refused.js'

async function pipeline(t, { policy = 'never', answer, owned = true, escalation = false } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  for (const plugin of [SessionStore, SessionProjectionRegistry, ApprovalService, SystemPrompt, ToolRuntime]) await ctx.plugin(plugin)
  await ctx.plugin({ apply: applyToolExecutor, inject: toolExecutorInject })
  const rt = { ctx, state: {}, chatOwners: new Map([['ada-chat', 'ada']]), botOf: id => id === 'ada' ? { id } : undefined }
  installStops(rt)
  install(rt)
  const session = ctx.get('sessions').create(owned ? 'ada-chat' : 'someone')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  setApprovalPolicy(session, policy)
  if (answer) ctx.on('approval/request', () => answer)
  let ran = false
  ctx.tools.register(defineTool({
    name: 'x', description: 'x', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      if (escalation) await approveEscalation({ requestedMode: 'workspace-write', effectiveMode: 'read-only', justification: 'x', subject: 'command' },
        { approver: ctx.get('approval'), agent: exec.agent, callId: exec.callId, toolName: 'x' })
      ran = true
      return 'x'
    },
  }))
  if (!escalation) ctx.on('tools/pre-execute', () => ({ kind: 'ask' }))
  const batch = await ctx.tools.execute({ calls: [{ id: 'c1', name: 'x', arguments: '{}' }], agent: { id: session.id, session }, signal: new AbortController().signal })
  assert.equal(ran, false)
  return batch.results[0].result
}

const blocks = text => [{ type: 'text', text }]
const r1 = 'Error: tool "x" did not run, and nobody was asked: approval prompts are off in this conversation (a subagent, or Full access).'
test('the real approval and tool stack distinguishes never, a person, unavailable, and non-team Sessions', async t => {
  for (const [options, text, message] of [
    [{}, r1, 'the user rejected tool "x"'],
    [{ policy: 'ask', answer: 'rejected' }, 'Error: the user rejected tool "x"', 'the user rejected tool "x"'],
    [{ policy: 'ask' }, 'Error: tool "x" needed the person\'s approval, but nobody could answer here, so it did not run.', 'tool "x" requires approval, but no approval channel is available'],
    [{ owned: false }, 'Error: the user rejected tool "x"', 'the user rejected tool "x"'],
  ]) {
    const result = await pipeline(t, options)
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, blocks(text))
    assert.equal(result.error.message, message)
  }
})

test('the real sandbox escalation preserves a person’s no and rewords unasked refusals', async t => {
  const rejected = 'the user rejected escalating this command to "workspace-write"; it stays denied, so stop and explain instead of working around it'
  for (const [options, text, message] of [
    [{}, 'Error: escalating this command to "workspace-write" was refused, and nobody was asked: approval prompts are off in this conversation (a subagent, or Full access). It stays denied, so stop and explain instead of working around it.', rejected],
    [{ policy: 'ask', answer: 'rejected' }, `Error: ${rejected}`, rejected],
    [{ policy: 'ask' }, 'Error: escalating to "workspace-write" needed the person\'s approval, but nobody could answer here, so the call did not run.', 'sandbox escalation to "workspace-write" requires approval, but no approval channel is available'],
  ]) {
    const result = await pipeline(t, { ...options, escalation: true })
    assert.equal(result.isError, true)
    assert.deepEqual(result.content, blocks(text))
    assert.equal(result.error.message, message)
  }
})

test('rewrites require the exact single error block and the recorded outcome and policy', () => {
  const exec = { name: 'x' }
  const content = blocks('Error: the user rejected tool "x"')
  const never = { outcome: 'rejected', policy: 'never' }
  assert.equal(rewordRefusal(exec, { isError: false }, content, never), undefined)
  assert.equal(rewordRefusal(exec, { isError: true }, [...content, ...content], never), undefined)
  assert.equal(rewordRefusal({ name: 'someone' }, { isError: true }, content, never), undefined)
  for (const decided of [undefined, { outcome: 'rejected' }, { outcome: 'rejected', policy: 'ask' }, { outcome: 'allowed-once', policy: 'never' }, { outcome: 'cancelled', policy: 'never' }]) {
    assert.equal(rewordRefusal(exec, { isError: true }, content, decided), undefined)
  }
  assert.equal(rewordRefusal(exec, { isError: true }, blocks(content[0].text + ' '), never), undefined)
  const review = reason => rewordRefusal(exec, { isError: true, error: { info: { code: 'AUTO_REVIEW_DENIED', reason } } }, blocks('Error: Auto review rejected tool "x"; its body was not executed'))
  const r5 = 'Error: Auto review refused tool "x" and nobody was asked, because approval prompts are off in this conversation; its body was not executed.'
  assert.deepEqual(review(), blocks(r5))
  const reason = 'x\n '.repeat(300)
  const rewritten = review(reason)[0].text
  assert.equal(rewritten, r5 + " The reviewer's reason: " + reason.replace(/\s+/g, ' ').trim().slice(0, 500))
  assert.equal(rewritten.split(" The reviewer's reason: ")[1].length, 500)
  assert.equal(rewritten.includes('\n'), false)
})

test('approval policy reads only ask or never and contains lookup failures', () => {
  assert.equal(approvalPolicyOf({ overrideOf: () => 'never', config: { policy: 'ask' } }, {}), 'never')
  assert.equal(approvalPolicyOf({ config: { policy: 'ask' } }, {}), 'ask')
  for (const service of [undefined, {}, { config: { policy: 'x' } }, { overrideOf() { throw new Error('x') } }]) assert.equal(approvalPolicyOf(service, {}), undefined)
})

function bench({ parentPolicy = 'ask', childPolicy = 'never' } = {}) {
  const handlers = new Map()
  let appends = 0
  const header = id => id.startsWith('child') ? { origin: 'subagent', parentSession: 'ada-chat' } : id === 'x' ? { origin: 'subagent', parentSession: 'someone' } : undefined
  const session = id => ({ id, header: header(id), append() { appends += 1; throw new Error('no append') } })
  const rt = {
    ctx: { on: (event, fn) => handlers.set(event, fn), get: () => ({ overrideOf: s => (header(s.id) ? childPolicy : parentPolicy) }), sessions: { get: session } },
    state: {}, chatOwners: new Map([['ada-chat', 'ada']]), botOf: id => id === 'ada' ? { id } : undefined,
    save() { throw new Error('no save') },
  }
  installStops(rt)
  install(rt)
  const emit = (id, type, data = {}) => handlers.get('session/event')(session(id), { type, data })
  const pair = (id, callId, outcome = 'rejected', toolName = 'bash') => {
    emit(id, 'approval/asked', { id: 'ask-' + callId, callId, toolName })
    emit(id, 'approval/decided', { id: 'ask-' + callId, outcome })
  }
  const result = (code, { callId = 'c1', name = 'x', reason = 'no' } = {}) => handlers.get('tools/result')(
    { agent: { id: 'child', session: session('child') }, callId, name, arguments: {} }, { isError: true, error: { info: { code, reason } } },
  )
  const step = (decision, kind = 'subagent-settled', id = 'child', parent = 'ada-chat') => handlers.get('agent/pre-step')({
    agent: { session: session(parent) }, messages: [id].flat().map(sender => createUserMessage({ content: blocks('x'), source: { kind, senderSessionId: sender } })),
  }, async () => decision)
  return { rt, handlers, emit, pair, result, step, appends: () => appends }
}
const enter = () => ({ kind: 'enter', messages: [createUserMessage({ content: blocks('x') })] })
const askTail = 'If a step is still needed, you can do it yourself in this conversation, where approval prompts are on and its own permission level applies.'
const neverTail = 'Approval prompts are off in this conversation too, so a step that needs approval is refused here as well: say in your reply which steps did not run.'
const noteText = decision => decision.messages.at(-1).content[0].text

test('a child’s unasked refusal reaches its Bot once, through a settlement notice only', async () => {
  const b = bench()
  b.pair('child', 'c1')
  const decision = enter()
  const out = await b.step(decision)
  assert.equal(out.messages.length, decision.messages.length + 1)
  assert.equal(out.messages[0], decision.messages[0])
  assert.deepEqual(out.messages[1].source, { kind: 'permission-refusals', form: 'notice', summary: 'Subagent child: 1 step(s) refused without asking anyone' })
  assert.equal(noteText(out), `Subagent child was refused a step without anyone being asked: bash (approval prompts are off there). ${askTail}`)
  assert.equal(await b.step(decision), decision)
  assert.equal(b.appends(), 0)
})

test('parent policy changes only the tail; a reject or unrelated relay consumes nothing', async () => {
  for (const [parentPolicy, tail] of [['never', neverTail], ['x', 'Say in your reply which steps did not run.']]) {
    const b = bench({ parentPolicy })
    b.pair('child', 'c1')
    const decision = enter()
    const reject = { kind: 'reject' }
    assert.equal(await b.step(reject), reject)
    assert.equal(await b.step(decision, 'agent-message'), decision)
    assert.equal(await b.step(decision, 'subagent-settled', 'someone'), decision)
    assert.equal(noteText(await b.step(decision)), `Subagent child was refused a step without anyone being asked: bash (approval prompts are off there). ${tail}`)
  }
  const b = bench({ childPolicy: 'ask' })
  b.pair('child', 'c1')
  const decision = enter()
  assert.equal(await b.step(decision), decision)
})

test('only a team Bot’s subagent records unasked refusals', async () => {
  const b = bench({ parentPolicy: 'never' })
  b.pair('x', 'c1')
  b.pair('ada-chat', 'c2')
  const decision = enter()
  assert.equal(await b.step(decision, 'subagent-settled', 'x', 'someone'), decision)
  assert.equal(b.rt.takeUnasked('x'), undefined)
  assert.equal(b.rt.takeUnasked('ada-chat'), undefined)
  // Control: the same never refusal in a team Bot's subagent is recorded.
  b.pair('child', 'c3')
  assert.equal(b.rt.takeUnasked('child').items.length, 1)
})

test('every child settled before one parent step gets its own note, in order', async () => {
  const b = bench()
  b.pair('child-1', 'c1')
  b.pair('child-2', 'c1')
  const decision = enter()
  const out = await b.step(decision, 'subagent-settled', ['child-1', 'child-2'])
  assert.equal(out.messages.length, decision.messages.length + 2)
  assert.equal(out.messages[0], decision.messages[0])
  assert.deepEqual(out.messages.slice(1).map(message => message.content[0].text),
    ['child-1', 'child-2'].map(id => `Subagent ${id} was refused a step without anyone being asked: bash (approval prompts are off there). ${askTail}`))
  assert.equal(b.rt.takeUnasked('child-1'), undefined)
  assert.equal(b.rt.takeUnasked('child-2'), undefined)
})

test('child lists and deduplication are bounded, with oldest call ids evicted', async () => {
  for (const [count, expected] of [[22, 22], [201, 202]]) {
    const b = bench()
    for (let i = 0; i < count; i += 1) b.pair('child', String(i))
    if (count === 201) { b.pair('child', '200'); b.pair('child', '0') }
    const text = noteText(await b.step(enter()))
    assert.match(text, new RegExp(`was refused ${expected} steps`))
    assert.equal(text.split('bash (approval prompts are off there)').length - 1, 20)
    assert.ok(text.includes(`; and ${expected - 20} more. `))
  }
  const b = bench()
  for (let i = 0; i < 201; i += 1) b.pair('child-' + i, 'c1')
  assert.equal(b.rt.takeUnasked('child-0'), undefined)
  assert.equal(b.rt.takeUnasked('child-1').items.length, 1)
  const decided = b.rt.decidedOf('child-200', 'c1')
  decided.policy = 'ask'
  assert.equal(b.rt.decidedOf('child-200', 'c1').policy, 'never')
  assert.equal(b.rt.decidedOf('someone', 'x'), undefined)
})

test('review reasons, pending sandbox stops, and unpaired bridge rows reach the parent', async () => {
  const review = bench()
  review.result('AUTO_REVIEW_DENIED')
  assert.ok(noteText(await review.step(enter())).includes('x (Auto review refused it: no)'))
  const failed = bench()
  failed.result('AUTO_REVIEW_FAILED')
  assert.equal(failed.rt.takeUnasked('child'), undefined)
  for (const childPolicy of ['never', 'ask']) {
    const b = bench({ childPolicy })
    b.result('FS_SANDBOX_DENIED', { name: 'bash' })
    assert.equal(b.rt.takeUnasked('child'), undefined)
    b.emit('child', 'turn/end')
    const decision = enter()
    const out = await b.step(decision)
    if (childPolicy === 'ask') assert.equal(out, decision)
    else assert.ok(noteText(out).includes('bash (the sandbox blocked it and it could not ask to widen it)'))
  }
  for (const paired of [false, true]) {
    const b = bench()
    if (paired) b.pair('child', 'c1', 'unavailable', 'x')
    b.emit('child', 'tool/result', { error: { name: 'ApprovalDeniedError', code: 'UNAVAILABLE' }, message: { toolCallId: 'c1' } })
    const text = noteText(await b.step(enter()))
    assert.equal(text, `Subagent child was refused a step without anyone being asked: ${paired ? 'x' : 'a tool call'} (nobody could answer its approval request). ${askTail}`)
  }
  const bounded = bench()
  bounded.result('AUTO_REVIEW_DENIED', { name: 'x'.repeat(100), reason: 'x\n'.repeat(200) })
  const record = bounded.rt.takeUnasked('child')
  assert.equal(record.items[0].tool.length, 64)
  assert.equal(record.items[0].reason.length, 200)
  assert.equal(record.items[0].reason.includes('\n'), false)
  assert.equal(bounded.rt.takeUnasked('child'), undefined)
  assert.ok(childRefusalNote('child', record).content[0].text.endsWith('Say in your reply which steps did not run.'))
})

test('listeners preserve decisions, error metadata, and downstream throws', async () => {
  const b = bench({ parentPolicy: 'never' })
  b.pair('ada-chat', 'c1')
  const exec = { agent: { id: 'ada-chat' }, name: 'x', callId: 'c1' }
  const result = { isError: true, content: blocks('Error: the user rejected tool "x"'), error: { message: 'x', info: { code: 'x' } } }
  const hook = b.handlers.get('tools/post-execute')
  assert.deepEqual(await hook(exec, result, async () => ({ kind: 'accept' })), { kind: 'accept', content: blocks(r1) })
  for (const decision of [{ kind: 'block' }, { kind: 'accept', value: undefined }, { kind: 'accept', content: blocks('x') }]) assert.equal(await hook(exec, result, async () => decision), decision)
  const decision = { kind: 'accept' }
  b.rt.decidedOf = () => { throw new Error('x') }
  assert.equal(await hook(exec, result, async () => decision), decision)
  await assert.rejects(hook(exec, result, async () => { throw new Error('x') }), /x/)
  await assert.rejects(b.handlers.get('agent/pre-step')({}, async () => { throw new Error('x') }), /x/)
})

// #2056 D1.5 (H6-8): a subagent step the review guard held reaches its parent with the guard's
// reason, and the tail never tells the parent to run that step itself.
test('a guard-held child step tells the parent to wait for its reviewer, never to do it itself', async () => {
  const guardTail = 'Send the plan to your reviewer with message_bot and wait for its verdict; until then work steps are refused here too.'
  for (const why of ['guard', 'guard-request']) {
    const b = bench({ parentPolicy: 'ask' })
    b.rt.noteStop('child', { why, tool: 'write', callId: 'g1', text: 'held' }, { session: { id: 'child', header: { origin: 'subagent', parentSession: 'ada-chat' } } })
    const text = noteText(await b.step(enter()))
    assert.equal(text, `Subagent child was refused a step without anyone being asked: write (the review guard holds work until the reviewer answers the plan). ${guardTail}`)
    assert.doesNotMatch(text, /do it yourself/)
  }
  // A mixed note (guard + sandbox) at ask keeps the guard tail.
  const mixed = childRefusalNote('child', { items: [{ tool: 'write', why: 'guard' }, { tool: 'bash', why: 'sandbox' }], more: 0 }, 'ask').content[0].text
  assert.match(mixed, /bash \(the sandbox blocked it and it could not ask to widen it\)/)
  assert.ok(mixed.endsWith(guardTail))
  assert.doesNotMatch(mixed, /do it yourself/)
})
