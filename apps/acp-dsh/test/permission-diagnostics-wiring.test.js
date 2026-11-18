// The permission diagnostics record as the plugin wires it: the real adapter, back-channel and
// fake agent fill it, the `acpAgents` service reads it, it goes with its Session, and a turn is
// the same with and without it.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../index.js'
import { AcpAdapter, aside } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'
import { credentialShapes } from '../src/host/redact.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
// Built here, so no home path is written in this file (herdr/scripts/privacy-check.mjs).
const HOME = ['', 'home', 'alice'].join('/')
const PERSONAL = { provider: 'alice-private', model: 'users/alice/model' }
const TOOLS = [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: {} } }]

// A DSH host as the plugin sees it: one Session, its tools, an approval service that allows.
function wiring() {
  const session = Session.create('s1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const listeners = new Map()
  const listed = []
  const disposers = []
  const provided = {}
  const registered = {}
  const scoped = new Map()
  const agent = { session, status: 'idle', ctx: { tools: { register: (def) => { scoped.set(def.name, def); return () => scoped.delete(def.name) } } } }
  const ctx = {
    llm: {
      registerAdapter: (providers, adapter) => { for (const id of providers) registered[id] = adapter; return () => {} },
      // A person's own provider and model, registered with DSH.
      listProviders: () => { listed.push('providers'); return [{ id: 'acp-fake' }, { id: PERSONAL.provider }] },
      listModels: async (provider) => { listed.push(provider); return provider === PERSONAL.provider ? [{ id: PERSONAL.model }] : [] },
    },
    agents: { get: () => agent, list: () => [agent], turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => TOOLS,
          executable: toolName => TOOLS.find(definition => definition.name === toolName),
          execute: async ({ calls }) => ({ results: [{ callId: calls[0].id, result: { content: [{ type: 'text', text: `ran ${calls[0].name}` }], isError: false } }] }),
        }
      }
      if (name === 'approval') return { effectivePolicy: () => 'ask', request: async () => 'allowed-once' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    on: (name, listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {} },
    effect: (fn) => { disposers.push(fn()) },
    provide: (name, service) => { provided[name] = service },
    logger: { warn: () => {}, info: () => {} },
  }
  const emit = (name, ...args) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
  const close = () => { for (const dispose of disposers) dispose() }
  return { ctx, agent, session, provided, registered, emit, close, scoped, listeners, listed }
}

const said = text => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }]

async function step(adapter, messages) {
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'acp-fake', model: 'default', sessionId: 's1', messages, signal: new AbortController().signal }))) chunks.push(chunk)
  return chunks
}

// A turn's chunks without what is random in them (the mirror call's own id).
const shape = chunks => JSON.stringify(chunks).replace(/acp_[0-9a-f-]{36}/g, 'acp_ID')

test('a bridged turn fills the record, the service reads it, and it goes with its Session', async () => {
  const w = wiring()
  apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false })
  try {
    const read = () => w.provided.acpAgents.permissionDiagnostics('s1')
    assert.equal(read(), undefined, 'no record before an agent ran')
    const before = Date.now()
    const chunks = await step(w.registered['acp-fake'], said('bridge bash'))
    assert.match(JSON.stringify(chunks), /The bridge said: ran bash/)
    const record = read()
    assert.equal(record.version, 2)
    assert.equal(record.agent, 'acp-fake')
    assert.equal(record.active, true)
    assert.deepEqual({ on: record.bridge.on, why: record.bridge.why, open: record.bridge.open }, { on: true, why: 'agent-default', open: true })
    assert.deepEqual({ path: record.lastCall.path, kind: record.lastCall.kind }, { path: 'dsh-bridge', kind: 'other' })
    assert.ok(record.bridgeCall.at >= before, 'the call reached DSH over the bridge')
    assert.equal(record.modes, undefined, 'the fake agent has no permission modes')
    assert.equal(record.review, undefined)
    // Nothing of the bridge's credential, its URL or the Session's folder is in it.
    const live = w.registered['acp-fake'].live.get('s1')
    const text = JSON.stringify(record)
    assert.equal(text.includes(live.bridge.credential), false)
    assert.equal(/127\.0\.0\.1|http|\/tmp|home/.test(text), false)

    // A mirror call of this agent session that DSH's own gate refused: its code, from
    // `tools/result`.
    live.calls.add('c1')
    w.emit('tools/result', { name: TOOL_NAME, callId: 'c1', agent: w.agent }, { isError: true, error: { message: 'Auto review rejected', info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED', reason: `it deletes ${HOME}` } } })
    assert.equal(read().review.code, 'AUTO_REVIEW_DENIED')
    assert.equal(JSON.stringify(read()).includes('alice'), false)
    // Another Session's agent says nothing here.
    w.emit('tools/result', { name: 'bash', callId: 'c2', agent: { session: { id: 's1' } } }, { isError: true, error: { info: { code: 'AUTO_REVIEW_FAILED' } } })
    assert.equal(read().review.code, 'AUTO_REVIEW_DENIED')

    // The Session is gone: so is the record.
    w.emit('agent/disposed', { agent: { session: { id: 'another' } } })
    assert.notEqual(read(), undefined)
    w.emit('agent/disposed', { agent: w.agent })
    assert.equal(read(), undefined)
    assert.doesNotThrow(() => w.emit('agent/disposed'))
    assert.doesNotThrow(() => w.emit('tools/result'))
  } finally {
    w.close()
  }
})

test('the kill switch ends the agent session, and the record no longer says the bridge is open', async () => {
  const w = wiring()
  let on
  apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: { get: () => on } })
  try {
    const read = () => w.provided.acpAgents.permissionDiagnostics('s1')
    await step(w.registered['acp-fake'], said('bridge bash'))
    assert.deepEqual([read().active, read().bridge.on, read().bridge.open], [true, true, true])
    on = false
    w.emit('loader/volatile-update')
    assert.deepEqual([read().active, read().bridge.on, read().bridge.open], [false, true, false])
    // The next turn starts a fresh agent session without the bridge: the record says why.
    const chunks = await step(w.registered['acp-fake'], said('hi'))
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
    const record = read()
    assert.equal(record.active, true)
    assert.deepEqual({ on: record.bridge.on, why: record.bridge.why }, { on: false, why: 'setting' })
    assert.equal('open' in record.bridge, false)
    // The agent's own tool, shown as a mirror card: the CLI's own path.
    assert.deepEqual({ path: record.lastCall.path, kind: record.lastCall.kind }, { path: 'cli', kind: 'execute' })
    assert.equal(record.bridgeCall, undefined)
  } finally {
    w.close()
  }
  assert.equal(w.provided.acpAgents.permissionDiagnostics('s1'), undefined, 'cleared when the plugin stops')
})

test('a turn is the same with and without the recorder', async () => {
  const run = async (strip) => {
    const w = wiring()
    apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false })
    const adapter = w.registered['acp-fake']
    if (strip) {
      adapter.diagnostics = undefined
      adapter.backchannel.diagnostics = undefined
    }
    try {
      const bridged = await step(adapter, said('bridge-permit bash'))
      const events = w.session.snapshotEvents().map(event => event.type)
      return { bridged: shape(bridged), events }
    } finally {
      w.close()
    }
  }
  const mirror = async (strip) => {
    const w = wiring()
    apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: false })
    if (strip) w.registered['acp-fake'].diagnostics = undefined
    try {
      return shape(await step(w.registered['acp-fake'], said('hi')))
    } finally {
      w.close()
    }
  }
  assert.deepEqual(await run(false), await run(true))
  assert.equal(await mirror(false), await mirror(true))
})

// The adapter alone, for the cases the plugin's own settings cannot produce.
function bare({ dshTools = () => false, spec = {}, diagnostics } = {}) {
  const w = wiring()
  const agentSpec = {
    name: 'Fake agent',
    catalog: { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE] }),
    ...spec,
  }
  const backchannel = new Backchannel({ ctx: w.ctx })
  const adapter = new AcpAdapter(w.ctx, new Map([['acp-fake', agentSpec]]), { dshTools, backchannel })
  if (diagnostics !== undefined) adapter.diagnostics = backchannel.diagnostics = diagnostics
  return { ...w, adapter, backchannel, close: () => { adapter.dispose(); backchannel.dispose() } }
}

test('a setting that throws when read fails the turn as before: the recorder adds no failure of its own', async () => {
  const run = async (diagnostics) => {
    // The setting answers false, except that its second read throws: the read of the bridge
    // decision. A recorder that read the setting itself would take that throw and let the real
    // decision read a third time and succeed.
    let reads = 0
    const h = bare({ dshTools: () => { if (++reads === 2) throw new Error('the setting is broken'); return false }, diagnostics })
    try {
      return shape(await step(h.adapter, said('hi')))
    } finally {
      h.close()
    }
  }
  const diagnostics = new PermissionDiagnostics()
  const without = await run(undefined)
  assert.match(without, /Fake agent did not start: the setting is broken/)
  assert.equal(await run(diagnostics), without)
  // The agent session never started, so there is no record of one.
  assert.equal(diagnostics.read('s1'), undefined)
})

test('the recorder reads the dshTools setting no more often than the adapter alone', async () => {
  const run = async (diagnostics) => {
    let reads = 0
    const h = bare({ dshTools: () => { reads++; return false }, diagnostics })
    try {
      const chunks = shape(await step(h.adapter, said('hi')))
      if (diagnostics !== undefined) {
        const read = diagnostics.read('s1')
        // The setting is false and the agent's own default is on (#1544), so the decision is the
      // person's, not the agent's default.
      assert.deepEqual({ on: read.bridge.on, why: read.bridge.why }, { on: false, why: 'setting' })
      }
      return { chunks, reads }
    } finally {
      h.close()
    }
  }
  assert.deepEqual(await run(new PermissionDiagnostics()), await run(undefined))
})

test('a strict mode the agent does not offer fails the turn as before, and the record says what was wanted', async () => {
  const run = async (diagnostics) => {
    const h = bare({ spec: { modeFor: () => ['bypassPermissions', 'default'] }, diagnostics })
    try {
      return shape(await step(h.adapter, said('hi')))
    } finally {
      h.close()
    }
  }
  const diagnostics = new PermissionDiagnostics()
  const without = await run(undefined)
  assert.match(without, /would not take DSH's permission level: it offers none of the modes bypassPermissions, default/)
  assert.equal(await run(diagnostics), without)
  const { modes } = diagnostics.read('s1')
  assert.deepEqual({ wanted: modes.wanted, offered: modes.offered, chosen: modes.chosen, fellToStrict: modes.fellToStrict }, { wanted: ['bypassPermissions', 'default'], offered: [], chosen: undefined, fellToStrict: false })
})

test('an Auto review routed beside the chat records each candidate, and answers the same', async () => {
  const text = '{"risk":"low","decision":"allow"}'
  const answer = () => (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const refused = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'no key sk-ant-abcdef1234567890', code: 'MISSING_CREDENTIAL' } } }
  })()
  const route = async (diagnostics, seen) => {
    const ctx = {
      llm: { stream: (options) => { seen?.push(diagnostics?.read('s1')?.reviewer); return options.provider === 'team' ? refused() : answer() } },
      get: name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'team', model: 'team-model' }) } : undefined),
    }
    const listen = aside(new Map([['acp-fake', {}]]), ctx, undefined, credentialShapes, diagnostics)
    const chunks = []
    const request = { provider: 'acp-fake', model: 'default', sessionId: 's1', purpose: 'auto-review', system: 'policy', messages: said(`rm -rf ${HOME}`) }
    for await (const chunk of listen(request, () => { throw new Error('the agent must not see a review') })) chunks.push(chunk)
    return chunks
  }
  const diagnostics = new PermissionDiagnostics()
  const adapter = { live: new Map(), backchannel: {}, agents: new Map([['acp-fake', {}]]) }
  diagnostics.started('s1', adapter, { disableBuiltInTools: true }, { provider: 'acp-fake', bridge: {} })
  const seen = []
  const chunks = await route(diagnostics, seen)
  assert.deepEqual(chunks, await route(undefined))
  // The first candidate failed with its code (seen when the second was asked); the second answered.
  assert.deepEqual({ ...seen[1], at: 0 }, { provider: 'custom', model: 'custom', ok: false, code: 'MISSING_CREDENTIAL', at: 0 })
  assert.equal(seen[0], undefined, 'nothing is recorded before a candidate ends')
  const { reviewer } = diagnostics.read('s1')
  assert.deepEqual({ ...reviewer, at: 0 }, { provider: 'deepseek-official', model: 'deepseek-flash', ok: true, at: 0 })
  assert.equal(/alice|sk-ant|policy/.test(JSON.stringify(diagnostics.read('s1'))), false)
  // A title on the same route is not a review.
  const title = aside(new Map([['acp-fake', {}]]), { llm: { stream: answer }, get: () => undefined }, undefined, credentialShapes, diagnostics)
  const titled = []
  for await (const chunk of title({ provider: 'acp-fake', model: 'default', sessionId: 's1', purpose: 'session-title', messages: [] }, () => {})) titled.push(chunk)
  assert.equal(titled.at(-1).type, 'finish')
  assert.deepEqual(diagnostics.read('s1').reviewer, reviewer)
})

test('the plugin itself hands the recorder to its review route, and a person\'s own route reads custom', async () => {
  const review = async () => {
    const w = wiring()
    apply(w.ctx, { fakeAgent: FAKE, claude: false, codex: false })
    try {
      const adapter = w.registered['acp-fake']
      await step(adapter, said('bridge bash'))
      const read = () => w.provided.acpAgents.permissionDiagnostics('s1')
      assert.equal(read().reviewer, undefined)
      // The first `llm/stream` listener the plugin registered is its side-request route.
      const [route] = w.listeners.get('llm/stream')
      // DSH's llm service as that listener sees it: the review goes to the team's default
      // model, a provider and model of the person's own that DSH lists.
      const streamed = []
      w.ctx.llm.stream = (options) => {
        streamed.push(`${options.provider} ${options.model}`)
        return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
      }
      const get = w.ctx.get
      w.ctx.get = name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ ...PERSONAL }) } : get(name))
      w.listed.length = 0
      const request = { provider: 'acp-fake', model: 'default', sessionId: 's1', purpose: 'auto-review', system: 'policy', messages: said('review this') }
      const chunks = []
      for await (const chunk of route(request, () => { throw new Error('the agent must not see a review') })) chunks.push(chunk)
      await new Promise(resolve => setImmediate(resolve))
      return { chunks, streamed, listed: [...w.listed], reviewer: read().reviewer }
    } finally {
      w.close()
    }
  }
  const { reviewer, ...seen } = await review()
  assert.deepEqual(seen.chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  assert.deepEqual(seen.streamed, [`${PERSONAL.provider} ${PERSONAL.model}`])
  assert.deepEqual({ ...reviewer, at: 0 }, { provider: 'custom', model: 'custom', ok: true, at: 0 })
  assert.equal(/alice/.test(JSON.stringify(reviewer)), false)
  // The recorder asks DSH nothing: the only reads of its lists are the review route's own, one
  // of the providers and one of the models of the single route that is not an agent.
  assert.deepEqual(seen.listed, ['providers', PERSONAL.provider])
})

test('the back-channel answers a bridge call the same, and tells the recorder its result', async () => {
  const post = async (h, record, body) => {
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
  const run = async (diagnostics) => {
    const h = bare({ diagnostics })
    try {
      await h.backchannel.listen()
      const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
      const state = { provider: 'acp-fake', bridge: record, dshAgent: h.agent }
      diagnostics?.started('s1', h.adapter, {}, state)
      const refused = await post(h, record, { op: 'call', name: 'not-a-tool', arguments: { text: 'sk-ant-abcdef1234567890' } })
      const ran = await post(h, record, { op: 'call', name: 'bash', arguments: {}, callId: 'fixed' })
      const listed = await post(h, record, { op: 'list' })
      return { refused, ran, listed, state }
    } finally {
      h.close()
    }
  }
  const diagnostics = new PermissionDiagnostics()
  const calls = []
  const bridgeCall = diagnostics.bridgeCall.bind(diagnostics)
  diagnostics.bridgeCall = (record, result) => { calls.push({ sessionId: record.sessionId, isError: result?.isError }); bridgeCall(record, result) }
  const { state: _with, ...withRecorder } = await run(diagnostics)
  const { state: _without, ...without } = await run(undefined)
  assert.deepEqual(withRecorder, without)
  assert.equal(withRecorder.refused.status, 200)
  assert.equal(withRecorder.ran.body.isError, false)
  // Only calls are told, never a list.
  assert.deepEqual(calls, [{ sessionId: 's1', isError: true }, { sessionId: 's1', isError: false }])
  assert.equal(typeof diagnostics.read('s1').bridgeCall.at, 'number')
  assert.equal(JSON.stringify(diagnostics.read('s1')).includes('sk-ant'), false)
})
