// The permission diagnostics record (permission-diagnostics.js) alone: each recorder fills its
// field, only values this code knows are stored, the record is bounded, a late recorder of a
// replaced agent session changes nothing, and no recorder can throw.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { CUSTOM, DIAGNOSTICS_VERSION, FAILURE_CODES, MAX_MODES, MAX_SESSIONS, MODES, OTHER, PermissionDiagnostics, REVIEW_CODES, ROUTES } from '../src/host/permission-diagnostics.js'

// Built here, so no home path is written in this file (herdr/scripts/privacy-check.mjs).
const HOME = ['', 'home', 'alice'].join('/')
const HOSTILE = [
  // Credential shapes, and secrets no shape names.
  'sk-ant-abcdef1234567890',
  'x_sk-abcdefghijklmnop',
  'ghp_abcdefghijklmnop1234',
  'eyJhbGciOi.eyJzdWIiOi.abcdefgh',
  'Bearer abcdefgh12345678',
  'a3f1c2d4e5b6a7980f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778',
  'A3F1C2D4E5B6A7980F1E2D3C4B5A6978',
  'npm_abcdefghijklmnop',
  'Zx9Kq2Lm8Vt4Rw7Yp3Ns',
  // Names of people and accounts that look like identifiers.
  'alice-private',
  'alice-private-gpt',
  'alice.smith',
  'ALICE_SMITH',
  'alice@example.com',
  // Paths, prompts, file content.
  `${HOME}/project/notes.md`,
  'users/alice/model',
  '~/secret.txt',
  `C:${['', 'Users', 'alice'].join('/')}/key.pem`,
  'Please delete every file in my home folder',
  'const password = "hunter2hunter2"',
]

const tick = () => new Promise(resolve => setImmediate(resolve))

// The adapter's entry for one agent session, and an adapter that holds it as its live one. The
// DSH agent is one per Session and outlives an agent session, as in production.
function world({ bridged = true, backchannel = {}, agent = { disableBuiltInTools: true }, now } = {}) {
  let clock = 1000
  const diagnostics = new PermissionDiagnostics({ now: now ?? (() => clock++) })
  const adapter = { live: new Map(), backchannel, agents: new Map([['acp-claude', {}], ['acp-codex', {}]]) }
  const dshAgents = new Map()
  const begin = (sessionId = 's1', provider = 'acp-claude') => {
    if (!dshAgents.has(sessionId)) dshAgents.set(sessionId, { session: { id: sessionId } })
    const bridge = bridged ? { sessionId, closed: false } : undefined
    const state = { provider, run: { alive: true, modes: undefined }, bridge, calls: new Set(), dshAgent: dshAgents.get(sessionId) }
    adapter.live.set(sessionId, state)
    diagnostics.started(sessionId, adapter, agent, state)
    return state
  }
  return { diagnostics, adapter, begin, agent }
}

const reviewOf = (w, sessionId = 's1') => w.diagnostics.review({ purpose: 'auto-review', sessionId })

test('a new agent session creates the record: the route, the bridge and why', () => {
  const w = world()
  assert.equal(w.diagnostics.read('s1'), undefined)
  w.begin()
  assert.deepEqual(w.diagnostics.read('s1'), {
    version: DIAGNOSTICS_VERSION, agent: 'acp-claude', startedAt: 1000, active: true,
    bridge: { on: true, why: 'agent-default', at: 1000, open: true },
  })
  // A route this plugin does not serve is not named.
  w.begin('s2', 'alice-private')
  assert.equal(w.diagnostics.read('s2').agent, OTHER)
})

test('the bridge fact is the adapter\'s own decision, and its reason always explains it', () => {
  const ctx = { get: () => undefined }
  for (const backchannel of [undefined, {}]) {
    for (const setting of [undefined, true, false]) {
      for (const agent of [{ disableBuiltInTools: true }, {}]) {
        let reads = 0
        const adapter = new AcpAdapter(ctx, new Map(), { dshTools: () => { reads++; return setting }, backchannel })
        // What the adapter does at a session's start: decide, mint a bridge or not, then record.
        const decided = adapter.bridgeOn(agent)
        const readsOfTheDecision = reads
        const state = { provider: 'acp-fake', bridge: decided ? {} : undefined }
        const diagnostics = new PermissionDiagnostics()
        diagnostics.started('s1', adapter, agent, state)
        assert.equal(reads, readsOfTheDecision, 'the recorder reads no setting')
        const { on, why } = diagnostics.read('s1').bridge
        const label = JSON.stringify({ backchannel: backchannel !== undefined, setting, agent })
        assert.equal(on, decided, label)
        const byDefault = agent.bridge !== false
        const expected = backchannel === undefined ? 'no-backchannel'
          : setting !== undefined && setting !== byDefault ? 'setting'
            : 'agent-default'
        assert.equal(why, expected, label)
      }
    }
  }
  // An agent row that declares no bridge, and a decision no reason here explains.
  const adapter = { backchannel: {}, agents: new Map() }
  const why = (agent, bridge) => {
    const diagnostics = new PermissionDiagnostics()
    diagnostics.started('s1', adapter, agent, { provider: 'x', bridge })
    return diagnostics.read('s1').bridge
  }
  assert.deepEqual({ ...why({ bridge: false, disableBuiltInTools: true }, undefined), at: 0 }, { on: false, why: 'agent-no-bridge', at: 0 })
  assert.equal(why({ bridge: false }, {}).why, OTHER)
  const none = new PermissionDiagnostics()
  none.started('s1', { backchannel: undefined }, {}, { provider: 'x', bridge: {} })
  assert.equal(none.read('s1').bridge.why, OTHER)
})

test('a bridge that was revoked, or a session that ended, is not reported as open', () => {
  const w = world()
  const state = w.begin()
  assert.equal(w.diagnostics.read('s1').bridge.open, true)
  state.bridge.closed = true
  assert.equal(w.diagnostics.read('s1').bridge.open, false)
  state.bridge.closed = false
  // The kill switch, or a move to a native model: the adapter no longer holds the session.
  w.adapter.live.delete('s1')
  const read = w.diagnostics.read('s1')
  assert.equal(read.active, false)
  assert.equal(read.bridge.open, false)
  assert.equal(read.bridge.on, true, 'what was decided when it started stays')
  // A process that died.
  w.adapter.live.set('s1', state)
  state.run.alive = false
  assert.equal(w.diagnostics.read('s1').active, false)
})

test('the modes: wanted, offered, chosen, the fall to the strict one, and whether it holds', () => {
  const w = world()
  const state = w.begin()
  w.diagnostics.mode('s1', state, { wanted: ['bypassPermissions', 'default'], offered: ['default', 'plan'], chosen: 'default' })
  // Attempted, not applied yet: the agent is still in a mode of its own (Claude Code's plan).
  state.run.modes = { currentModeId: 'plan' }
  let modes = w.diagnostics.read('s1').modes
  assert.deepEqual(modes, { wanted: ['bypassPermissions', 'default'], offered: ['default', 'plan'], chosen: 'default', fellToStrict: true, at: 1001, current: 'plan', applied: false })
  state.run.modes = { currentModeId: 'acceptEdits' }
  assert.deepEqual([w.diagnostics.read('s1').modes.current, w.diagnostics.read('s1').modes.applied], ['acceptEdits', false])
  // A mode no agent names is not stored, and a known chosen mode still shows the mismatch.
  state.run.modes = { currentModeId: 'alice.smith' }
  assert.deepEqual([w.diagnostics.read('s1').modes.current, w.diagnostics.read('s1').modes.applied], [OTHER, false])
  state.run.modes = { currentModeId: 'default' }
  modes = w.diagnostics.read('s1').modes
  assert.equal(modes.current, 'default')
  assert.equal(modes.applied, true)
  // The most wanted mode was offered: no fall.
  w.diagnostics.mode('s1', state, { wanted: ['auto', 'default'], offered: ['auto', 'default'], chosen: 'auto' })
  assert.equal(w.diagnostics.read('s1').modes.fellToStrict, false)
  // One wanted mode is not a fall.
  w.diagnostics.mode('s1', state, { wanted: ['default'], offered: ['default'], chosen: 'default' })
  assert.equal(w.diagnostics.read('s1').modes.fellToStrict, false)
  // None offered: nothing chosen, nothing applied (the turn fails, as before).
  w.diagnostics.mode('s1', state, { wanted: ['auto', 'default'], offered: [], chosen: undefined })
  modes = w.diagnostics.read('s1').modes
  assert.equal('chosen' in modes, false)
  assert.equal(modes.fellToStrict, false)
  assert.equal(modes.applied, false)
})

test('the static lists: every mode, failure code and route this codebase names, and nothing else', () => {
  // Every mode this plugin asks an agent for is in the list of the agents' own modes.
  for (const spec of Object.values(AGENTS)) {
    for (const level of [{ full: true }, { auto: true }, { sandbox: 'read-only' }, {}]) {
      for (const mode of spec.modeFor(level)) assert.ok(MODES.has(mode), mode)
    }
  }
  assert.deepEqual([...MODES].sort(), ['acceptEdits', 'agent', 'agent-full-access', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan', 'read-only', 'workspace-write'])
  for (const code of ['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'SERVER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'NO_ADAPTER', 'EMPTY_RESPONSE', 'UNSUPPORTED', 'ABORTED', 'MODEL_ACCESS_REQUIRED']) assert.ok(FAILURE_CODES.has(code), code)
  // The agent table's routes, the native-ACP agents (#959) included, and the reviewer's own.
  assert.deepEqual([...ROUTES.keys()].sort(), ['acp-antigravity', 'acp-claude', 'acp-codex', 'acp-hermes', 'acp-omp', 'deepseek-official'])
  assert.deepEqual([...ROUTES.get('deepseek-official')], ['deepseek-flash'])
  assert.deepEqual([...ROUTES.get('acp-claude')], AGENTS['acp-claude'].fallback.map(model => model.id))
  // The module holds no way to ask anything outside itself.
  const diagnostics = new PermissionDiagnostics({ llm: () => { throw new Error('never asked') } })
  assert.deepEqual(Object.keys(diagnostics).sort(), ['max', 'now', 'records'])
})

test('AgentRun.setMode says what it chose before it asks, and a refused switch is not shown as applied', async () => {
  const w = world()
  const state = w.begin()
  const run = new AgentRun({ name: 'probe', cwd: '/', onMode: seen => w.diagnostics.mode('s1', state, seen) })
  let refuse = true
  run.conn = { setSessionMode: async () => { if (refuse) throw new Error('no') } }
  run.gone = new Promise(() => {})
  run.child = {}
  run.modes = { currentModeId: 'auto', availableModes: [{ id: 'default' }, { id: 'auto' }] }
  state.run = run
  await assert.rejects(run.setMode(['bypassPermissions', 'default']), /no/)
  let modes = w.diagnostics.read('s1').modes
  assert.deepEqual([modes.chosen, modes.fellToStrict, modes.current, modes.applied], ['default', true, 'auto', false])
  refuse = false
  await run.setMode(['bypassPermissions', 'default'])
  modes = w.diagnostics.read('s1').modes
  assert.deepEqual([modes.chosen, modes.current, modes.applied], ['default', 'default', true])
  // The agent changed its own mode afterwards: the record follows the run.
  await run.onUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'auto' })
  assert.equal(w.diagnostics.read('s1').modes.applied, false)
  // None offered: the hook still fires, then the turn fails with the same error as before.
  await assert.rejects(run.setMode(['read-only']), /offers none of the modes read-only/)
  assert.equal('chosen' in w.diagnostics.read('s1').modes, false)
  // A hook that throws changes nothing.
  const loud = new AgentRun({ name: 'probe', cwd: '/', onMode: () => { throw new Error('boom') } })
  loud.conn = { setSessionMode: async () => {} }
  loud.gone = new Promise(() => {})
  loud.modes = { currentModeId: 'x', availableModes: [{ id: 'default' }] }
  await loud.setMode(['default'])
  assert.equal(loud.modes.currentModeId, 'default')
})

test('the path of the last call follows the call\'s own updates, and stays as last classified', () => {
  const w = world()
  const state = w.begin()
  const path = (tool) => { w.diagnostics.call('s1', state, tool); return w.diagnostics.read('s1').lastCall.path }
  assert.equal(path({ kind: 'execute' }), 'cli')
  assert.equal(path({ kind: 'other', structuredName: 'mcp__dsh__bash', bridge: true, mcp: true }), 'dsh-bridge')
  assert.equal(path({ structuredName: 'mcp__jira__search', mcp: true }), 'mcp')
  assert.equal(path({ mcp: true }), 'mcp')
  assert.equal(path({ structuredName: 'ToolSearch' }), 'loader')
  assert.equal(path({ structuredName: 'Bash', drift: true }), 'drift')
  assert.deepEqual(w.diagnostics.read('s1').lastCall, { path: 'drift', kind: OTHER, at: w.diagnostics.read('s1').lastCall.at })

  // A call first seen unnamed, named in a later update: the run tells the call's listeners
  // (acp.js changeTool), with nobody reading the record in between.
  const run = new AgentRun({ name: 'probe', cwd: '/' })
  run.seeTool({ toolCallId: 'late', title: 'mcp.dsh.bash', kind: 'weird', status: 'pending' })
  const late = run.tools.get('late')
  assert.equal(path(late), 'cli')
  run.changeTool(late, { kind: 'fetch', _meta: { is_mcp_tool_call: true } })
  // The process dies, or the chat moves to a native model, before anybody reads.
  w.adapter.live.delete('s1')
  const last = w.diagnostics.read('s1').lastCall
  assert.deepEqual([last.path, last.kind], ['mcp', 'fetch'], 'the last classification, not the first guess')

  // An earlier call that changes after a newer one does not take the record back.
  const again = w.begin()
  run.seeTool({ toolCallId: 'first', kind: 'read', status: 'pending' })
  run.seeTool({ toolCallId: 'second', kind: 'edit', status: 'pending' })
  w.diagnostics.call('s1', again, run.tools.get('first'))
  w.diagnostics.call('s1', again, run.tools.get('second'))
  run.changeTool(run.tools.get('first'), { kind: 'fetch', _meta: { is_mcp_tool_call: true } })
  assert.deepEqual([w.diagnostics.read('s1').lastCall.path, w.diagnostics.read('s1').lastCall.kind], ['cli', 'edit'])
})

test('with the bridge off, a call named like the bridge is the person\'s own MCP server', () => {
  const w = world({ bridged: false })
  const state = w.begin()
  w.diagnostics.call('s1', state, { structuredName: 'mcp__dsh__bash', bridge: true, mcp: true })
  const read = w.diagnostics.read('s1')
  assert.deepEqual(read.bridge, { on: false, why: 'setting', at: 1000 })
  assert.equal(read.lastCall.path, 'mcp')
})

test('the reviewer route: only ids this codebase names, and the candidate\'s answer or failure code', () => {
  const w = world()
  w.begin()
  const reviewer = () => w.diagnostics.read('s1').reviewer
  const route = (provider, model) => {
    reviewOf(w)({ provider, model }, { finished: true, failure: undefined })
    // Final at once: nothing is looked up, so nothing arrives later.
    return [reviewer().provider, reviewer().model]
  }
  reviewOf(w)({ provider: 'deepseek-official', model: 'deepseek-flash' }, { finished: true, failure: undefined })
  assert.deepEqual(reviewer(), { provider: 'deepseek-official', model: 'deepseek-flash', ok: true, at: 1001 })
  // A named provider with a model the code does not name: the model is `custom`.
  assert.deepEqual(route('deepseek-official', 'alice-private-gpt'), ['deepseek-official', CUSTOM])
  assert.deepEqual(route('acp-claude', 'opus'), ['acp-claude', 'opus'])
  // A person's own provider or model is never kept by its id, however it is spelled.
  assert.deepEqual(route('alice-private', 'users/alice/model'), [CUSTOM, CUSTOM])
  assert.deepEqual(route('alice-private', 'deepseek-flash'), [CUSTOM, CUSTOM])
  assert.deepEqual(route('openai', 'gpt-5.2'), [CUSTOM, CUSTOM])
  for (const value of ['alice.smith', 'ALICE_SMITH', 'x_sk-abcdefghijklmnop', undefined, 7, {}]) assert.deepEqual(route(value, value), [CUSTOM, CUSTOM])
  // How a candidate ends: its code, never its message.
  reviewOf(w)({ provider: 'openai', model: 'gpt-5.2' }, { finished: false, failure: { message: 'key sk-ant-abcdef1234567890 refused', code: 'INVALID_CREDENTIAL' } })
  assert.deepEqual({ ...reviewer(), at: 0 }, { provider: CUSTOM, model: CUSTOM, ok: false, code: 'INVALID_CREDENTIAL', at: 0 })
  reviewOf(w)({ provider: 'openai', model: 'gpt-mini' }, { finished: false, failure: undefined })
  assert.equal(reviewer().code, 'EMPTY_RESPONSE')
  reviewOf(w)({ provider: 'openai', model: 'gpt-mini' }, { finished: true, failure: { message: 'x' } })
  assert.deepEqual([reviewer().ok, reviewer().code], [false, OTHER])
  for (const code of ['ALICE_SMITH', 'x_sk-abcdefghijklmnop', 'alice.smith']) {
    reviewOf(w)({ provider: 'openai', model: 'gpt-mini' }, { finished: true, failure: { code } })
    assert.equal(reviewer().code, OTHER)
  }
  for (const code of FAILURE_CODES) {
    reviewOf(w)({ provider: 'openai', model: 'gpt-mini' }, { finished: true, failure: { code } })
    assert.equal(reviewer().code, code)
  }
  // A title is not a review, and a Session that ran no agent has no record to fill.
  assert.equal(w.diagnostics.review({ purpose: 'session-title', sessionId: 's1' }), undefined)
  assert.equal(reviewOf(w, 'unknown'), undefined)
  assert.equal(w.diagnostics.read('unknown'), undefined)
})

test('the last AUTO_REVIEW code: from the bridge\'s result and from a call DSH\'s own gate refused', () => {
  const w = world()
  const state = w.begin()
  const record = state.bridge
  state.calls.add('acp_1')
  const mirror = { agent: state.dshAgent, callId: 'acp_1' }
  w.diagnostics.bridgeCall(record, { content: [], isError: false })
  assert.deepEqual(w.diagnostics.read('s1').bridgeCall, { at: 1001 })
  assert.equal(w.diagnostics.read('s1').review, undefined)
  w.diagnostics.bridgeCall(record, { isError: true, error: { name: 'AutoReviewUnavailableError', code: 'AUTO_REVIEW_NO_STEP' } })
  assert.deepEqual(w.diagnostics.read('s1').review, { code: 'AUTO_REVIEW_NO_STEP', at: 1002 })
  // Another refusal is not a review code and leaves the last one.
  w.diagnostics.bridgeCall(record, { isError: true, error: { name: 'ApprovalDeniedError', code: 'REJECTED' } })
  assert.equal(w.diagnostics.read('s1').review.code, 'AUTO_REVIEW_NO_STEP')
  assert.deepEqual(w.diagnostics.read('s1').bridgeCall, { at: 1003 })
  // A mirror call the pipeline refused: `tools/result`, with the code under error.info.
  w.diagnostics.result(mirror, { isError: true, error: { info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: `rm -rf ${HOME}` } } })
  assert.deepEqual(w.diagnostics.read('s1').review, { code: 'AUTO_REVIEW_DENIED', at: 1004 })
  w.diagnostics.result(mirror, { isError: true, error: { code: 'AUTO_REVIEW_FAILED' } })
  assert.equal(w.diagnostics.read('s1').review.code, 'AUTO_REVIEW_FAILED')
  // A result that is no error, another agent's, or a call this agent session did not make.
  w.diagnostics.result(mirror, { isError: false, error: { code: 'AUTO_REVIEW_DENIED' } })
  w.diagnostics.result({ agent: { session: { id: 's1' } }, callId: 'acp_1' }, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  w.diagnostics.result({ agent: state.dshAgent, callId: 'acp_other' }, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  assert.equal(w.diagnostics.read('s1').review.code, 'AUTO_REVIEW_FAILED')
  // Every code this code knows is kept; one it does not know is not stored as it came.
  for (const code of REVIEW_CODES) {
    w.diagnostics.bridgeCall(record, { isError: true, error: { code } })
    assert.equal(w.diagnostics.read('s1').review.code, code)
  }
  for (const code of ['AUTO_REVIEW_ALICE_SMITH', 'AUTO_REVIEW_x_sk-abcdefghijklmnop']) {
    w.diagnostics.bridgeCall(record, { isError: true, error: { code } })
    assert.equal(w.diagnostics.read('s1').review.code, OTHER)
  }
})

test('a recorder that speaks for a replaced agent session changes nothing', async () => {
  const w = world()
  const old = w.begin()
  const oldBridge = old.bridge
  old.calls.add('acp_old')
  w.diagnostics.mode('s1', old, { wanted: ['default'], offered: ['default'], chosen: 'default' })
  const oldTool = { kind: 'read', listeners: new Set() }
  w.diagnostics.call('s1', old, oldTool)
  w.diagnostics.bridgeCall(oldBridge, { isError: true, error: { code: 'AUTO_REVIEW_TIMEOUT' } })
  reviewOf(w)({ provider: 'acp-claude', model: 'opus' }, { finished: true })
  // A review that began under the old agent session and has not finished yet.
  const lateReview = reviewOf(w)
  // A new agent session in the same Session (a restart, another agent): the same DSH agent.
  const fresh = w.begin('s1', 'acp-codex')
  assert.equal(fresh.dshAgent, old.dshAgent, 'the DSH agent outlives an agent session')
  let read = w.diagnostics.read('s1')
  assert.equal(read.agent, 'acp-codex')
  assert.equal(read.modes, undefined)
  assert.equal(read.lastCall, undefined)
  assert.equal(read.bridgeCall, undefined)
  // The review facts carry their own times and stay.
  const kept = { review: read.review, reviewer: read.reviewer }
  assert.equal(kept.review.code, 'AUTO_REVIEW_TIMEOUT')
  assert.deepEqual([kept.reviewer.provider, kept.reviewer.model], ['acp-claude', 'opus'])
  // Late callbacks of the session that was replaced.
  w.diagnostics.mode('s1', old, { wanted: ['auto'], offered: ['auto'], chosen: 'auto' })
  w.diagnostics.call('s1', old, { kind: 'edit' })
  oldTool.mcp = true
  for (const listener of oldTool.listeners) listener()
  w.diagnostics.bridgeCall(oldBridge, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  w.diagnostics.result({ agent: old.dshAgent, callId: 'acp_old' }, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  lateReview({ provider: 'deepseek-official', model: 'deepseek-flash' }, { finished: false, failure: { code: 'ABORTED' } })
  await tick()
  read = w.diagnostics.read('s1')
  assert.equal(read.modes, undefined)
  assert.equal(read.lastCall, undefined)
  assert.equal(read.bridgeCall, undefined)
  assert.deepEqual({ review: read.review, reviewer: read.reviewer }, kept, 'no late result, no fresh time')
  // The replacement's own callbacks do land.
  fresh.calls.add('acp_new')
  w.diagnostics.result({ agent: fresh.dshAgent, callId: 'acp_new' }, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  assert.equal(w.diagnostics.read('s1').review.code, 'AUTO_REVIEW_DENIED')
  // Dropped and opened again: nothing of the Session before, and late callbacks find nothing.
  const pending = reviewOf(w)
  w.diagnostics.drop('s1')
  w.diagnostics.call('s1', fresh, { kind: 'edit' })
  w.diagnostics.bridgeCall(fresh.bridge, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  assert.equal(w.diagnostics.read('s1'), undefined)
  w.begin('s1')
  pending({ provider: 'deepseek-official', model: 'deepseek-flash' }, { finished: true })
  assert.deepEqual(Object.keys(w.diagnostics.read('s1')), ['version', 'agent', 'startedAt', 'active', 'bridge'])
})

test('redaction: no credential, account, path or text reaches the record', async () => {
  for (const value of HOSTILE) {
    const w = world({ now: () => 7 })
    const state = w.begin('s1', value)
    const record = Object.assign(state.bridge, { credential: value, path: value })
    state.calls.add('c1')
    state.run.modes = { currentModeId: value }
    w.diagnostics.mode('s1', state, { wanted: [value, 'default'], offered: [value], chosen: value })
    w.diagnostics.call('s1', state, { id: value, title: value, kind: value, structuredName: value, rawInput: { command: value, file_path: value }, rawOutput: value, content: [{ type: 'text', text: value }], locations: [{ path: value }], output: value })
    w.diagnostics.review({ purpose: 'auto-review', sessionId: 's1', system: value, messages: [{ role: 'user', content: [{ type: 'text', text: value }] }] })({ provider: value, model: value }, { finished: false, failure: { message: value, code: value } })
    w.diagnostics.bridgeCall(record, { content: [{ type: 'text', text: value }], isError: true, error: { name: value, code: `AUTO_REVIEW_${value}`, reason: value } })
    await tick()
    const expected = {
      version: DIAGNOSTICS_VERSION, agent: OTHER, startedAt: 7, active: true,
      bridge: { on: true, why: 'agent-default', at: 7, open: true },
      modes: { wanted: [OTHER, 'default'], offered: [OTHER], chosen: OTHER, fellToStrict: false, at: 7, current: OTHER },
      lastCall: { path: 'cli', kind: OTHER, at: 7 },
      bridgeCall: { at: 7 },
      reviewer: { provider: CUSTOM, model: CUSTOM, ok: false, code: OTHER, at: 7 },
      review: { code: OTHER, at: 7 },
    }
    // Every string in it is a fixed value or `other`.
    assert.deepEqual(w.diagnostics.read('s1'), expected, value)
    w.diagnostics.result({ agent: state.dshAgent, callId: 'c1', name: value, arguments: { text: value } }, { isError: true, content: [{ type: 'text', text: value }], error: { info: { name: value, code: `AUTO_REVIEW_${value}`, reason: value } } })
    // A named provider with the hostile value as its model.
    w.diagnostics.review({ purpose: 'auto-review', sessionId: 's1' })({ provider: 'deepseek-official', model: value }, { finished: true })
    await tick()
    const read = w.diagnostics.read('s1')
    assert.deepEqual(read.reviewer, { provider: 'deepseek-official', model: CUSTOM, ok: true, at: 7 }, value)
    const text = JSON.stringify(read)
    assert.equal(text.includes(value), false, `the record holds ${value}`)
    assert.equal(text.includes(JSON.stringify(value).slice(1, -1)), false, `the record holds ${value}`)
  }
})

test('each input property is read once, and only primitives are stored', () => {
  const w = world()
  const state = w.begin()
  const secret = { secret: 'sk-ant-abcdef1234567890' }
  // A getter that answers a known value first, then a shared object.
  const alternating = (first) => {
    let reads = 0
    return { get: () => (reads++ === 0 ? first : secret), enumerable: true }
  }
  const tool = Object.defineProperties({}, { kind: alternating('read'), structuredName: alternating('ToolSearch'), mcp: alternating(true), drift: alternating(false), bridge: alternating(false) })
  w.diagnostics.call('s1', state, tool)
  const seen = Object.defineProperties({}, { wanted: alternating(['auto', 'default']), offered: alternating(['default']), chosen: alternating('default') })
  w.diagnostics.mode('s1', state, seen)
  const options = Object.defineProperties({}, { purpose: alternating('auto-review'), sessionId: alternating('s1') })
  const chosen = Object.defineProperties({}, { provider: alternating('deepseek-official'), model: alternating('deepseek-flash') })
  const outcome = Object.defineProperties({}, { finished: alternating(false), failure: alternating({ code: 'ABORTED' }) })
  w.diagnostics.review(options)(chosen, outcome)
  const error = Object.defineProperties({}, { code: alternating('AUTO_REVIEW_TIMEOUT') })
  w.diagnostics.bridgeCall(state.bridge, { isError: true, error })
  const read = w.diagnostics.read('s1')
  assert.deepEqual(read.lastCall, { path: 'loader', kind: 'read', at: read.lastCall.at })
  assert.deepEqual([read.modes.wanted, read.modes.offered, read.modes.chosen], [['auto', 'default'], ['default'], 'default'])
  assert.deepEqual([read.reviewer.provider, read.reviewer.model, read.reviewer.code], ['deepseek-official', 'deepseek-flash', 'ABORTED'])
  assert.equal(read.review.code, 'AUTO_REVIEW_TIMEOUT')
  // Nothing in a read is an object the caller handed in, and every leaf is a primitive.
  const leaves = []
  const walk = (value) => {
    if (value !== null && typeof value === 'object') {
      assert.notEqual(value, secret)
      for (const inner of Object.values(value)) walk(inner)
    } else leaves.push(value)
  }
  walk(read)
  assert.ok(leaves.every(leaf => ['string', 'number', 'boolean'].includes(typeof leaf)))
  assert.equal(JSON.stringify(read).includes('sk-ant'), false)
  // A list whose items change between reads keeps only what it was checked as.
  const items = new Proxy(['auto', 'default'], { get: (target, key) => (key === '0' ? secret : Reflect.get(target, key)) })
  w.diagnostics.mode('s1', state, { wanted: items, offered: [], chosen: undefined })
  assert.deepEqual(w.diagnostics.read('s1').modes.wanted, [OTHER, 'default'])
})

test('the record is bounded: a cap on Sessions and lists, and it goes with its Session', () => {
  const w = world()
  for (let i = 0; i <= MAX_SESSIONS; i++) w.begin(`s${i}`)
  assert.equal(w.diagnostics.records.size, MAX_SESSIONS)
  assert.equal(w.diagnostics.read('s0'), undefined, 'the one that started longest ago went')
  assert.notEqual(w.diagnostics.read(`s${MAX_SESSIONS}`), undefined)
  // A Session that starts again is the newest, not the next to go.
  w.begin('s1')
  w.begin('extra')
  assert.notEqual(w.diagnostics.read('s1'), undefined)
  assert.equal(w.diagnostics.read('s2'), undefined)
  // Recorders never create a record.
  w.diagnostics.mode('nobody', undefined, { wanted: ['default'] })
  w.diagnostics.call('nobody', undefined, {})
  w.diagnostics.bridgeCall({ sessionId: 'nobody' }, {})
  w.diagnostics.result({ agent: { session: { id: 'nobody' } } }, { isError: true, error: { code: 'AUTO_REVIEW_DENIED' } })
  assert.equal(reviewOf(w, 'nobody'), undefined)
  assert.equal(w.diagnostics.records.size, MAX_SESSIONS)
  const state = w.begin('s1')
  const many = Array.from({ length: 50 }, () => 'default')
  w.diagnostics.mode('s1', state, { wanted: many, offered: many, chosen: 'default' })
  assert.equal(w.diagnostics.read('s1').modes.wanted.length, MAX_MODES)
  assert.equal(w.diagnostics.read('s1').modes.offered.length, MAX_MODES)
  w.diagnostics.drop('s1')
  assert.equal(w.diagnostics.read('s1'), undefined)
  w.diagnostics.clear()
  assert.equal(w.diagnostics.records.size, 0)
})

test('a read is a copy, nested values included', () => {
  const w = world()
  const state = w.begin()
  w.diagnostics.mode('s1', state, { wanted: ['auto', 'default'], offered: ['default'], chosen: 'default' })
  w.diagnostics.call('s1', state, { kind: 'read' })
  w.diagnostics.bridgeCall(state.bridge, { isError: true, error: { code: 'AUTO_REVIEW_TIMEOUT' } })
  reviewOf(w)({ provider: 'deepseek-official', model: 'deepseek-flash' }, { finished: true })
  const first = w.diagnostics.read('s1')
  const kept = structuredClone(first)
  first.agent = 'changed'
  first.bridge.on = false
  first.modes.wanted.push('bypassPermissions')
  first.modes.offered.length = 0
  first.lastCall.path = 'changed'
  first.reviewer.ok = false
  first.review.code = 'changed'
  first.bridgeCall.at = 0
  assert.deepEqual(w.diagnostics.read('s1'), kept)
  assert.equal(JSON.stringify(kept), JSON.stringify(structuredClone(kept)), 'plain JSON')
})

test('no recorder throws, whatever it is given', () => {
  const bomb = new Proxy({}, { get() { throw new Error('boom') }, has() { throw new Error('boom') }, ownKeys() { throw new Error('boom') } })
  const diagnostics = new PermissionDiagnostics({ llm: () => bomb })
  for (const junk of [undefined, null, 0, '', 'x', [], {}, bomb, Symbol('s')]) {
    assert.doesNotThrow(() => {
      diagnostics.started(junk, junk, junk, junk)
      diagnostics.started('s1', junk, junk, junk)
      diagnostics.mode(junk, junk, junk)
      diagnostics.call(junk, junk, junk)
      diagnostics.review(junk)?.(junk, junk)
      diagnostics.bridgeCall(junk, junk)
      diagnostics.result(junk, junk)
      diagnostics.read(junk)
      diagnostics.drop(junk)
    })
  }
  const state = { provider: 'acp-claude' }
  assert.doesNotThrow(() => diagnostics.started('s1', { agents: new Map([['acp-claude', {}]]), backchannel: {} }, bomb, state))
  // The agent row could not be read: the record is still made, with no bridge fact.
  assert.deepEqual(Object.keys(diagnostics.read('s1')), ['version', 'agent', 'startedAt', 'active'])
  assert.doesNotThrow(() => {
    diagnostics.mode('s1', state, bomb)
    diagnostics.call('s1', state, bomb)
    diagnostics.review({ purpose: 'auto-review', sessionId: 's1' })(bomb, bomb)
    diagnostics.review({ purpose: 'auto-review', sessionId: 's1' })({ provider: 'x', model: 'y' }, { finished: true })
    diagnostics.bridgeCall(bomb, bomb)
    diagnostics.result(bomb, bomb)
  })
  assert.equal(diagnostics.read('s1').active, false)
})

test('version 2 ownMode is bounded and returned as a fresh copy', () => {
  const w = world(); const state = w.begin('own', 'acp-codex')
  w.diagnostics.own('own', state, { answer: 'yes', taken: true })
  const first = w.diagnostics.read('own')
  assert.equal(first.version, 2)
  assert.deepEqual(first.ownMode, { answer: 'yes', taken: true, at: 1001 })
  first.ownMode.taken = false
  assert.equal(w.diagnostics.read('own').ownMode.taken, true)
  w.diagnostics.own('own', state, { answer: 'private text', taken: 1 })
  assert.equal(JSON.stringify(w.diagnostics.read('own')).includes('private text'), false)
  assert.equal(w.diagnostics.read('own').ownMode.taken, false)
})
