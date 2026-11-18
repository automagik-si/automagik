// The bridge→DSH leg and its probes (RFC 0003, amendment, deliveries 4 and 6): the credential
// binds a request to its Session and is revoked with it; a missing or foreign one is refused; a
// credential alone cannot approve; every DSH tool call enters DSH's approval service before it
// runs, and auto-review refuses an out-of-band bridge call it cannot review; and the offered set
// is the preset's, filtered by the Session's level.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyAutoReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { KNOWN_SESSION_EVENT_TYPES, Session, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { aside } from '../src/host/adapter.js'
import { Backchannel, offeredTools, positionOf, recordDrift, signatureOf } from '../src/host/backchannel.js'
import { SYNTHETIC_KIND } from '../src/host/names.js'
import { credentialShapes } from '../src/host/redact.js'
import { TOOL_NAME } from '../src/host/tool.js'

const TOOLS = [
  { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
]

function host({ sandbox = 'workspace-write', policy = 'ask', policyThrows = false, answer = 'allowed-once', tools = TOOLS, preset = 'standard', level, definitions = tools, turn = 3, fail, content, attachments } = {}) {
  const session = Session.create('s1')
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  // Auto review reads the tool schema from the request header; Manual and Full ignore it.
  session.append('request/header', { header: { config: { provider: 'acp-fake', model: 'default' }, tools: definitions }, reason: 'initial' })
  const agent = { session }
  const asked = []
  const executed = []
  const position = { turn }
  const ctx = {
    agents: { turnBoundaryOf: () => ({ lastTurn: position.turn }) },
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => definitions,
          executable: toolName => definitions.find(definition => definition.name === toolName),
          execute: async ({ calls }) => {
            executed.push({ name: calls[0].name, arguments: calls[0].arguments })
            if (fail !== undefined) throw fail
            const blocks = typeof content === 'function' ? content(calls[0]) : content
            return { results: [{ callId: calls[0].id, result: { content: blocks ?? [{ type: 'text', text: `ran ${calls[0].name}` }], isError: false } }] }
          },
        }
      }
      if (name === 'approval') {
        return {
          // DSH reads the policy of the exact Session asked about; any other object reads the default.
          effectivePolicy: (s) => { if (policyThrows) throw new Error('x'); return s === session ? policy : 'ask' },
          request: async (request) => {
            asked.push(request)
            // The real service rejects every ask deterministically under `never`.
            if (policy === 'never') return 'rejected'
            return typeof answer === 'function' ? answer(request) : answer
          },
        }
      }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: sandbox }) }
      if (name === 'permissionPresets') return level === undefined ? undefined : { current: () => level }
      if (name === 'attachments') return attachments
      if (name === 'agentPresets') return { presetForSession: () => preset }
      return undefined
    },
  }
  const backchannel = new Backchannel({ ctx })
  return { ctx, agent, session, asked, executed, backchannel, position }
}

async function serve() {
  const host_ = host()
  const bc = host_.backchannel
  await bc.listen()
  const record = bc.mint({ sessionId: 's1', agent: host_.agent, name: 'Fake agent' })
  // As after `session/new` in a real turn: the bridge may announce from now on.
  bc.announce(record)
  const post = async (op, body = {}, credential = record.credential, url = bc.urlFor(record)) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(credential === null ? {} : { authorization: `Bearer ${credential}` }) },
      body: JSON.stringify({ op, ...body }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { ...host_, bc, record, post }
}

// The finished Session through the same v4 loader a desktop reload runs. A bridge call that
// wrote no assistant advertisement used to fail here with `tool/call ... has no advertised tool
// lifecycle` (#842).
const assertLoadable = session => restoreReleasedV4Artifact({
  header: { version: 4, id: session.id, createdAt: 0, isSeeded: false, delegationDepth: 0 },
  events: session.snapshotEvents(),
  inheritedEventCount: 0,
}, KNOWN_SESSION_EVENT_TYPES)

// Auto review's real pre-execute listener, over the same Session the bridge writes to. The fake
// tools.execute mirrors the pipeline's prepare stage: it runs the listener before the body and
// turns a non-allow decision into an error result. The reviewer stream is the test's model.
const ALLOW = '{"risk":"low","decision":"allow"}'
const DENY = '{"risk":"high","decision":"deny","reason":"no"}'

const reviewer = (text, signal) => (async function* () {
  if (signal?.aborted) throw new Error('aborted')
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
})()

const hanging = signal => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  }),
})

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

test('a request without a credential, with another Session\'s, or after revocation is refused', async () => {
  const h = await serve()
  try {
    assert.equal((await h.post('list', {}, null)).status, 401)
    assert.equal((await h.post('list', {}, '')).status, 401)
    // Another Session's credential, minted for a different Session in the same plugin instance.
    // One Session's credential is refused on another Session's channel, even while it is live.
    const foreign = h.bc.mint({ sessionId: 's2', agent: h.agent, name: 'Other' })
    assert.equal((await h.post('list', {}, foreign.credential)).status, 401)
    assert.equal((await h.post('list', {}, h.record.credential, h.bc.urlFor(foreign))).status, 401)
    // A signature-identical but unknown value is refused too.
    assert.equal((await h.post('list', {}, 'f'.repeat(64))).status, 401)
    assert.equal((await h.post('list')).status, 200)
    h.bc.revoke(h.record)
    assert.equal((await h.post('list')).status, 401)
    assert.equal((await h.post('call', { name: 'bash' })).status, 401)
  } finally {
    h.bc.dispose()
  }
})

test('the bridge lists the preset\'s tools, never the mirror, and hides file writers in read-only', async () => {
  const h = await serve()
  try {
    const listed = await h.post('list')
    assert.deepEqual(listed.body.tools.map(tool => tool.name), ['bash', 'write', 'read'])
    const readOnly = host({ sandbox: 'read-only', definitions: [...TOOLS, { name: TOOL_NAME, description: 'mirror', parameters: { type: 'object' } }] })
    assert.deepEqual(offeredTools(readOnly.ctx, readOnly.agent).map(tool => tool.name), ['bash', 'read'])
    // A conditional tool has no call outside a model step, so it is not offered either.
    const conditional = { ...TOOLS[0], name: 'web_search' }
    const withCondition = host()
    withCondition.ctx.get('tools').executable = name => (name === 'web_search' ? undefined : TOOLS.find(tool => tool.name === name))
    withCondition.ctx.get('tools').definitions = () => [...TOOLS, conditional]
    assert.deepEqual(offeredTools(withCondition.ctx, withCondition.agent).map(tool => tool.name), ['bash', 'write', 'read'])
  } finally {
    h.bc.dispose()
  }
})

test('read-only ACP hides Office outputs and user-terminal observations', () => {
  const names = ['office_convert', 'office_recalculate', 'office_render', 'user_terminal_list', 'user_terminal_read']
  const definitions = names.map(name => ({ name, description: name, parameters: { type: 'object' } }))
  const readonly = host({ sandbox: 'read-only', definitions })
  assert.deepEqual(offeredTools(readonly.ctx, readonly.agent).map(tool => tool.name), [])
  const writable = host({ sandbox: 'workspace-write', definitions })
  assert.deepEqual(offeredTools(writable.ctx, writable.agent).map(tool => tool.name), names)
})

test('a DSH tool call asks DSH before it runs, then writes the call and its result rows', async () => {
  const h = await serve()
  try {
    const answer = await h.post('call', { name: 'bash', arguments: { command: 'echo hi' }, callId: 'bridge-1' })
    assert.equal(answer.body.isError, false)
    assert.deepEqual(answer.body.content, [{ type: 'text', text: 'ran bash' }])
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].toolName, 'bash')
    assert.equal(h.asked[0].callId, 'bridge-1')
    assert.equal(h.asked[0].agent, h.agent)
    assert.match(h.asked[0].reason, /Fake agent: bash/)
    assert.deepEqual(h.executed, [{ name: 'bash', arguments: '{"command":"echo hi"}' }])
    const events = h.session.snapshotEvents()
    const call = events.find(event => event.type === 'tool/call')
    assert.deepEqual({ turn: call.data.turn, step: call.data.step, callId: call.data.callId, name: call.data.name }, { turn: 3, step: 1, callId: 'bridge-1', name: 'bash' })
    const result = events.find(event => event.type === 'tool/result')
    assert.equal(result.data.message.role, 'tool')
    assert.equal(result.data.message.toolCallId, 'bridge-1')
    assert.equal(result.surfaceOp, 'append')
    assert.deepEqual(result.sourceEventSeqs, [call.seq])
    // The order the person sees: the call row, then the question, then the result.
    assert.ok(call.seq < result.seq)
  } finally {
    h.bc.dispose()
  }
})

test('an image tool result reaches the model as ACP image content, never as empty text', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
  const read = []
  const shot = { name: 'browser_screenshot', description: 'Take a screenshot', parameters: { type: 'object', properties: {} } }
  const h = host({
    tools: [...TOOLS, shot],
    turn: 1,
    content: [{ type: 'text', text: 'Screenshot of https://example.com/.' }, { type: 'image', attachment: ref }],
    attachments: {
      readImage: async (attachment) => {
        read.push(attachment)
        return { ref: attachment, data: Buffer.from(png, 'base64') }
      },
    },
  })
  try {
    await h.backchannel.listen()
    const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
    h.backchannel.announce(record)
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'browser_screenshot', arguments: {}, callId: 'shot-1' }),
    })
    const body = await response.json()
    assert.equal(body.isError, false)
    // The model sees the screenshot as ACP's image content, beside the text line it already had.
    assert.deepEqual(body.content, [
      { type: 'text', text: 'Screenshot of https://example.com/.' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ])
    assert.deepEqual(read, [ref])
    // DSH's own row keeps the durable attachment: the bytes are not duplicated into the log.
    const result = h.session.snapshotEvents().find(event => event.type === 'tool/result')
    assert.deepEqual(result.data.message.content, [
      { type: 'text', text: 'Screenshot of https://example.com/.' },
      { type: 'image', attachment: ref },
    ])
    assert.doesNotMatch(JSON.stringify(result.data), new RegExp(png.slice(0, 24)))
    assert.doesNotThrow(() => assertLoadable(h.session))
  } finally {
    h.backchannel.dispose()
  }
})

test('an inline image block passes through once, not encoded again', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const shot = { name: 'browser_screenshot', description: 'Take a screenshot', parameters: { type: 'object', properties: {} } }
  const h = host({
    tools: [...TOOLS, shot],
    content: [{ type: 'image', data: png, mediaType: 'image/png' }],
  })
  try {
    await h.backchannel.listen()
    const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
    h.backchannel.announce(record)
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'browser_screenshot', arguments: {} }),
    })
    const body = await response.json()
    assert.deepEqual(body.content, [{ type: 'image', data: png, mimeType: 'image/png' }])
  } finally {
    h.backchannel.dispose()
  }
})

// A browser_screenshot tool answering with `content`, as the agent's MCP call receives it.
async function screenshotResult(content) {
  const shot = { name: 'browser_screenshot', description: 'Take a screenshot', parameters: { type: 'object', properties: {} } }
  const h = host({ tools: [...TOOLS, shot], content })
  try {
    await h.backchannel.listen()
    const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
    h.backchannel.announce(record)
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'browser_screenshot', arguments: {} }),
    })
    return await response.json()
  } finally {
    h.backchannel.dispose()
  }
}

test('an inline image over 5 MiB becomes a text placeholder, never image content', async () => {
  // One byte over the cap. The bridge sizes base64 from its length, so this payload is never decoded.
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')
  const body = await screenshotResult([{ type: 'image', data: oversized, mediaType: 'image/png' }])
  assert.deepEqual(body.content, [{ type: 'text', text: '[image unavailable: image/png; larger than 5 MiB]' }])
})

test('a non-image inline block becomes a text placeholder, never image content', async () => {
  const pdf = Buffer.from('%PDF-1.7\n').toString('base64')
  const body = await screenshotResult([{ type: 'image', data: pdf, mediaType: 'application/pdf' }])
  assert.deepEqual(body.content, [{ type: 'text', text: '[image unavailable: application/pdf; not a supported image type]' }])
})

test('a small png and a small jpeg inline image pass through byte for byte', async () => {
  // A 1x1 png and a 1x1 jpeg, each base64 of the bytes the tool answered with.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const jpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=='
  for (const [data, mimeType] of [[png, 'image/png'], [jpeg, 'image/jpeg']]) {
    const body = await screenshotResult([{ type: 'image', data, mediaType: mimeType }])
    assert.deepEqual(body.content, [{ type: 'image', data, mimeType }])
  }
})

test('text and resource results keep their single text block', async () => {
  const h = host({
    content: [
      { type: 'text', text: 'first line' },
      { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'resource text' } },
    ],
  })
  try {
    await h.backchannel.listen()
    const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
    h.backchannel.announce(record)
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: {} }),
    })
    const body = await response.json()
    assert.deepEqual(body.content, [{ type: 'text', text: 'first line\nresource text' }])
  } finally {
    h.backchannel.dispose()
  }
})

test('a refusal or an unavailable approval never runs the tool, and the agent gets an error', async () => {
  for (const [options, text, code] of [
    [{ policy: 'never', sandbox: 'read-only' }, 'Nobody was asked about bash: approval prompts are off in this conversation, so DSH refused it.', 'REJECTED'],
    [{ answer: 'rejected' }, 'The person rejected bash.', 'REJECTED'],
    [{ answer: 'unavailable' }, 'DSH could not approve bash: nobody could answer its approval request.', 'UNAVAILABLE'],
    [{ answer: 'cancelled' }, 'DSH could not approve bash.', 'CANCELLED'],
    [{ answer: 'rejected', policyThrows: true }, 'The person rejected bash.', 'REJECTED'],
  ]) {
    const run = host(options)
    try {
      await run.backchannel.listen()
      const record = run.backchannel.mint({ sessionId: 's1', agent: run.agent, name: 'someone' })
      const response = await fetch(run.backchannel.urlFor(record), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
        body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId: 'c1' }),
      })
      const body = await response.json()
      assert.equal(body.isError, true)
      assert.deepEqual(body.content, [{ type: 'text', text }])
      assert.deepEqual(body.error, { name: 'ApprovalDeniedError', code })
      assert.equal(run.asked.length, 1)
      assert.equal(run.executed.length, 0)
      const result = run.session.snapshotEvents().find(event => event.type === 'tool/result')
      assert.equal(result.data.message.isError, true)
      assert.deepEqual(result.data.message.content, [{ type: 'text', text }])
      assert.deepEqual(result.data.error, { name: 'ApprovalDeniedError', code })
    } finally { run.backchannel.dispose() }
  }
})

test('each level gates a bridge call as DSH gates its own tools: Manual asks, Full does not', async () => {
  const runAt = async ({ sandbox, policy, answer = 'allowed-once' }) => {
    const run = host({ sandbox, policy, answer })
    await run.backchannel.listen()
    const record = run.backchannel.mint({ sessionId: 's1', agent: run.agent, name: 'Fake agent' })
    run.backchannel.announce(record)
    const response = await fetch(run.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId: 'level-1' }),
    })
    const body = await response.json()
    const events = run.session.snapshotEvents()
    run.backchannel.dispose()
    return { asked: run.asked, executed: run.executed, body, status: response.status, events }
  }
  const oneCard = ({ events }) => {
    assert.equal(events.filter(event => event.type === 'tool/call').length, 1, 'one card start')
    assert.equal(events.filter(event => event.type === 'tool/result').length, 1, 'one card result')
  }
  // Manual: one DSH dialog, and the agent's answer (allow-once) lets it run.
  const manual = await runAt({ sandbox: 'workspace-write', policy: 'ask' })
  assert.equal(manual.status, 200)
  assert.equal(manual.asked.length, 1)
  assert.equal(manual.body.isError, false)
  assert.deepEqual(manual.executed.map(entry => entry.name), ['bash'])
  oneCard(manual)
  // Auto is not exercised here: this fixture's tools.execute is a recorder, so it cannot show
  // DSH's gate. The real Auto stack (auto-review, the tools pipeline, the real Backchannel) is
  // the next test.
  // Full access: never asks, as DSH's own tools do not there.
  const full = await runAt({ sandbox: 'danger-full-access', policy: 'never' })
  assert.equal(full.asked.length, 0)
  assert.equal(full.body.isError, false)
  assert.deepEqual(full.executed.map(entry => entry.name), ['bash'])
  oneCard(full)
})

test('a bridged tool call advertises its lifecycle, so a Manual or Full session loads after a second turn', async () => {
  for (const [label, level] of [
    ['Manual', { sandbox: 'workspace-write', policy: 'ask' }],
    ['Full', { sandbox: 'danger-full-access', policy: 'never' }],
  ]) {
    const h = host({ ...level, turn: 1 })
    await h.backchannel.listen()
    const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
    h.backchannel.announce(record)
    const call = async (callId) => {
      const response = await fetch(h.backchannel.urlFor(record), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
        body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId }),
      })
      const body = await response.json()
      assert.equal(body.isError, false, `${label}: ${callId} ran`)
    }
    try {
      await call('bridge-first')
      // The first turn closes and the Session goes on; the second bridge call is in turn 2.
      h.session.append('step/end', { turn: 1, step: 1 })
      h.session.append('turn/end', { turn: 1, reason: 'stop' })
      h.session.append('turn/start', { turn: 2 })
      h.session.append('step/start', { turn: 2, step: 1 })
      h.position.turn = 2
      await call('bridge-second')
      h.session.append('step/end', { turn: 2, step: 1 })
      h.session.append('turn/end', { turn: 2, reason: 'stop' })

      const events = h.session.snapshotEvents()
      const calls = events.filter(event => event.type === 'tool/call')
      assert.equal(calls.length, 2, `${label}: two cards`)
      for (const call of calls) {
        const advertisement = events.find(event => event.type === 'assistant/message'
          && event.data.message.content.some(block => block.type === 'tool-call' && block.id === call.data.callId))
        assert.ok(advertisement, `${label}: ${call.data.callId} is advertised`)
        assert.equal(advertisement.data.message.source.synthetic, SYNTHETIC_KIND)
        assert.equal(advertisement.data.message.source.bridge, true)
        assert.equal(h.session.surface.nodes.includes(advertisement.seq), false, `${label}: the advertisement left the surface`)
      }
      assert.equal(events.filter(event => event.type === 'developer/message').length, 2, `${label}: each advertisement is replaced`)
      assert.doesNotThrow(() => assertLoadable(h.session), `${label}: the finished session loads`)
    } finally {
      h.backchannel.dispose()
    }
  }
})

test('a bridge call whose advertisement cannot be written never runs or leaves a card row', async () => {
  const h = host()
  const append = h.session.append.bind(h.session)
  h.session.append = (type, data, options) => {
    if (type === 'assistant/message') throw new Error('advertisement failed')
    return append(type, data, options)
  }
  await h.backchannel.listen()
  const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
  h.backchannel.announce(record)
  try {
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId: 'bridge-no-ad' }),
    })
    const body = await response.json()
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'BRIDGE_RECORD_FAILED')
    assert.equal(h.executed.length, 0, 'the body did not run')
    const events = h.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0, 'no card row')
    assert.equal(events.filter(event => event.type === 'tool/result').length, 0, 'no result row')
  } finally {
    h.backchannel.dispose()
  }
})

test('a bridge call with no open step is refused, not written into a closed step', async () => {
  const h = host()
  h.session.append('step/end', { turn: 3, step: 1 })
  await h.backchannel.listen()
  const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
  h.backchannel.announce(record)
  try {
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId: 'bridge-no-step' }),
    })
    const body = await response.json()
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'BRIDGE_NO_STEP')
    assert.equal(h.executed.length, 0, 'the body did not run')
    assert.equal(h.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0, 'no card row')
  } finally {
    h.backchannel.dispose()
  }
})

// --- a turn the agent opened itself -----------------------------------------------------------
// A native background task finishes after its DSH turn ended and wakes Claude Code on its own.
// There is no open DSH step, and none can be opened out of band: the agent loop's own turn
// numbering is private. Manual and Full still run the extra, without a card; Auto refuses,
// because Auto review reads a call from its step.

const agentOpened = (h, turn = 3) => {
  h.session.append('step/end', { turn, step: 1 })
  h.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const outsideStepCall = async (h, callId) => {
  await h.backchannel.listen()
  const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
  h.backchannel.announce(record)
  const response = await fetch(h.backchannel.urlFor(record), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
    body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId }),
  })
  return { record, body: await response.json() }
}

test('a bridge call in a turn the agent opened itself runs at Manual without step rows', async () => {
  const h = host({ turn: 1 })
  agentOpened(h, 1)
  try {
    const { body } = await outsideStepCall(h, 'bridge-own-turn')
    assert.equal(body.isError, false, 'the extra ran')
    assert.deepEqual(h.executed.map(entry => entry.name), ['bash'])
    assert.equal(h.asked.length, 1, 'Manual still asks the person once')
    const events = h.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0, 'no card row outside a step')
    assert.equal(events.filter(event => event.type === 'tool/result').length, 0, 'no result row outside a step')
    const record = events.find(event => event.type === 'plugin:acp-dsh/bridge-outside-step')
    assert.ok(record, 'the call is recorded against the Session without a step')
    assert.deepEqual(record.data, { callId: 'bridge-own-turn', name: 'bash', outcome: 'ran' })
    assert.doesNotThrow(() => assertLoadable(h.session), 'the finished Session still loads')
  } finally {
    h.backchannel.dispose()
  }
})

test('a bridge call in a turn the agent opened itself is refused clearly at Auto', async () => {
  const h = host({ level: 'auto', turn: 1 })
  agentOpened(h, 1)
  try {
    const { body } = await outsideStepCall(h, 'bridge-own-turn-auto')
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'BRIDGE_OUTSIDE_STEP')
    const text = body.content.map(block => block.text ?? '').join('\n')
    assert.match(text, /Claude Code opened this turn itself/)
    assert.match(text, /send a message/)
    assert.doesNotMatch(text, /no open step/)
    assert.equal(h.executed.length, 0, 'the extra did not run unreviewed')
    assert.equal(h.asked.length, 0, 'and the person was not asked in its place')
    assert.equal(h.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0)
    const record = h.session.snapshotEvents().find(event => event.type === 'plugin:acp-dsh/bridge-outside-step')
    assert.equal(record.data.outcome, 'refused')
  } finally {
    h.backchannel.dispose()
  }
})

// --- Auto review of a bridge call ---------------------------------------------------------
// The real @deepseek-ai/dsh-experimental-auto-review listener reads the Session the bridge
// writes to. A bridge call appends one synthetic assistant block, the tool/call row, and enters
// tools.execute; the fake pipeline runs the listener before the body, as DSH does.

const autoCall = async (h, { callId = 'auto-1', name = 'bash', args = { command: 'echo hi' } } = {}) => {
  await h.backchannel.listen()
  const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
  h.backchannel.announce(record)
  const response = await fetch(h.backchannel.urlFor(record), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
    body: JSON.stringify({ op: 'call', name, arguments: args, callId }),
  })
  return { record, status: response.status, body: await response.json() }
}

test('Auto review sees a bridge call: allow runs, deny blocks with AUTO_REVIEW_DENIED, one card each', async () => {
  for (const [label, decision, code] of [['allow', ALLOW, undefined], ['deny', DENY, 'AUTO_REVIEW_DENIED']]) {
    const h = reviewHost({ decisions: [decision] })
    try {
      const { body, status } = await autoCall(h)
      assert.equal(status, 200, label)
      const events = h.session.snapshotEvents()
      const calls = events.filter(event => event.type === 'tool/call')
      const results = events.filter(event => event.type === 'tool/result')
      assert.equal(calls.length, 1, `${label}: one card start`)
      assert.equal(results.length, 1, `${label}: one card result`)
      const synthetic = events.find(event => event.type === 'assistant/message')
      assert.equal(synthetic.data.message.source.synthetic, SYNTHETIC_KIND)
      assert.deepEqual(synthetic.data.message.content.map(block => block.type), ['tool-call'])
      // The reviewer read it; provider history did not: the surface replaced it and the card
      // still comes only from tool/call + tool/result.
      assert.equal(h.session.surface.nodes.includes(synthetic.seq), false, `${label}: not on the surface`)
      assert.equal(events.filter(event => event.type === 'developer/message').length, 1, `${label}: one replacement`)
      if (code === undefined) {
        assert.equal(body.isError, false)
        assert.deepEqual(h.executed.map(entry => entry.name), ['bash'])
      } else {
        assert.equal(body.isError, true)
        assert.equal(body.error.code, code)
        assert.equal(h.executed.length, 0, `${label}: the body did not run`)
      }
      assert.equal(h.asked.length, 0, `${label}: no extra dialog on Auto`)
    } finally {
      h.backchannel.dispose()
    }
  }
})

test('Auto review refuses a bridge call with a named code when its inputs are missing', async () => {
  const cases = [
    ['no open step', (h) => h.session.append('step/end', { turn: 1, step: 0 }), 'AUTO_REVIEW_NO_STEP'],
    ['no route', undefined, 'AUTO_REVIEW_NO_ROUTE', { route: false }],
    ['no unique schema', undefined, 'AUTO_REVIEW_NO_SCHEMA', { headerTools: [...TOOLS, TOOLS[0]] }],
  ]
  for (const [label, change, code, options = {}] of cases) {
    const h = reviewHost(options)
    change?.(h)
    try {
      const { body } = await autoCall(h)
      assert.equal(body.isError, true, label)
      assert.equal(body.error.code, code, label)
      assert.equal(h.executed.length, 0, `${label}: the body did not run`)
      assert.equal(h.session.snapshotEvents().filter(event => event.type === 'tool/call').length, 0, `${label}: no card row`)
    } finally {
      h.backchannel.dispose()
    }
  }
})

test('Auto review refuses when the call row cannot be written', async () => {
  const h = reviewHost({ decisions: [ALLOW], failCallRow: true })
  try {
    const { body } = await autoCall(h)
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'AUTO_REVIEW_FAILED')
    assert.equal(h.executed.length, 0)
    const events = h.session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
    // The advertisement stays in the log, so it is answered with DSH's not-started repair row:
    // a step that ended with it unanswered would not load (#957).
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.deepEqual(results[0].data.error, { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' })
    const synthetic = events.find(event => event.type === 'assistant/message')
    assert.equal(h.session.surface.nodes.includes(synthetic.seq), false, 'the synthetic block is closed')
  } finally {
    h.backchannel.dispose()
  }
})

test('Auto review fails closed when the reviewer is unavailable or times out', async () => {
  const unavailable = reviewHost({ decisions: [() => { throw new Error('reviewer offline') }] })
  try {
    const { body } = await autoCall(unavailable)
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'AUTO_REVIEW_FAILED')
    assert.equal(unavailable.executed.length, 0)
  } finally {
    unavailable.backchannel.dispose()
  }
  const slow = reviewHost({ decisions: [signal => hanging(signal)], reviewTimeoutMs: 40 })
  try {
    const { body } = await autoCall(slow)
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'AUTO_REVIEW_TIMEOUT')
    assert.equal(slow.executed.length, 0)
  } finally {
    slow.backchannel.dispose()
  }
})

test('a level change while Auto approval is pending blocks dispatch', async () => {
  const h = reviewHost({ decisions: [DENY], override: 'ask', holdApproval: true })
  try {
    const pending = autoCall(h)
    await h.approvalStarted
    h.flipLevel()
    h.releaseApproval()
    const { body } = await pending
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'AUTO_REVIEW_LEVEL_CHANGED')
    assert.equal(h.executed.length, 0)
  } finally {
    h.backchannel.dispose()
  }
})

test('the review timeout still applies while Auto approval is pending', async () => {
  const h = reviewHost({ decisions: [DENY], override: 'ask', holdApproval: true, reviewTimeoutMs: 20 })
  try {
    const pending = autoCall(h)
    await h.approvalStarted
    await new Promise(resolve => setTimeout(resolve, 50))
    h.releaseApproval()
    const { body } = await pending
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'AUTO_REVIEW_TIMEOUT')
    assert.equal(h.executed.length, 0)
  } finally {
    h.backchannel.dispose()
  }
})

test('Auto review\'s timeout covers the review, not an allowed body', async () => {
  const h = reviewHost({ decisions: [ALLOW], reviewTimeoutMs: 20, holdBody: true })
  try {
    const pending = autoCall(h)
    await h.bodyStarted
    await new Promise(resolve => setTimeout(resolve, 50))
    h.releaseBody()
    const { body } = await pending
    assert.equal(body.isError, false, 'the body completed after the review deadline')
    assert.equal(h.executed.length, 1)
  } finally {
    h.backchannel.dispose()
  }
})

test('a level change after dispatch does not rewrite the allowed result', async () => {
  const h = reviewHost({ decisions: [ALLOW], holdBody: true })
  try {
    const pending = autoCall(h)
    await h.bodyStarted
    h.flipLevel()
    h.releaseBody()
    const { body } = await pending
    assert.equal(body.isError, false, 'the already-dispatched body keeps its result')
    assert.equal(h.executed.length, 1)
  } finally {
    h.backchannel.dispose()
  }
})

test('Auto review fails closed when the candidate credential is revoked mid-review', async () => {
  const h = reviewHost({ decisions: [signal => hanging(signal)] })
  try {
    const started = h.nextReview()
    const pending = autoCall(h)
    await started
    const record = h.backchannel.records.values().next().value
    h.backchannel.revoke(record)
    const { status, body } = await pending
    assert.equal(status, 401)
    assert.equal(body.error, 'refused')
    assert.equal(h.executed.length, 0)
    const result = h.session.snapshotEvents().find(event => event.type === 'tool/result')
    assert.equal(result.data.error.code, 'BRIDGE_REVOKED')
  } finally {
    h.backchannel.dispose()
  }
})

test('Auto review fails closed when the level stops being Auto during the review', async () => {
  const h = reviewHost({ decisions: [signal => hanging(signal)] })
  try {
    const started = h.nextReview()
    const pending = autoCall(h)
    await started
    h.flipLevel()
    const { body } = await pending
    assert.equal(body.isError, true)
    assert.equal(body.error.code, 'AUTO_REVIEW_LEVEL_CHANGED')
    assert.equal(h.executed.length, 0)
  } finally {
    h.backchannel.dispose()
  }
})

test('Auto review redacts the arguments it shows the reviewer', async () => {
  const h = reviewHost({ decisions: [ALLOW], route: true })
  try {
    const { body } = await autoCall(h, { args: { command: 'echo sk-abcdef123456 npm_abcdefghijklmnopqrstuvwxyz' } })
    assert.equal(body.isError, false)
    assert.equal(h.streams.length, 1)
    assert.equal(h.streams[0].provider, 'deepseek-official')
    const review = JSON.stringify(h.streams[0].messages)
    assert.doesNotMatch(review, /sk-abcdef123456|npm_abcdefghijklmnopqrstuvwxyz/)
    assert.match(review, /sk-\[hidden\]/)
    assert.match(review, /npm_\[hidden\]/)
  } finally {
    h.backchannel.dispose()
  }
})

test('Auto review sees a bridge call over the real stack and allows it', async () => {
  // The real stack: DSH's cordis context, its ToolsService and native executor (the pipeline
  // that fires `tools/pre-execute`), the real auto-review plugin, and this Backchannel. The
  // bridge adds the one assistant block the reviewer reads, so the review resolves the call.
  const { Context } = await import('@deepseek-ai/cordis')
  const { ToolsService } = await import('@deepseek-ai/dsh-tools')
  const native = await import('@deepseek-ai/dsh-tool-executor-native')
  const autoReview = await import('@deepseek-ai/dsh-experimental-auto-review')
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  const executed = []
  const schema = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
  ctx.tools.register({
    ...schema,
    output: { schema: {}, render: () => [{ type: 'text', text: 'ran bash' }] },
    async execute(args) {
      executed.push(args)
      return {}
    },
  })
  const asked = []
  const reviews = []
  let reviewerCalls = 0
  ctx.provide('approval', { effectivePolicy: () => 'ask', overrideOf: () => 'ask', request: async (request) => { asked.push(request); return 'allowed-once' } })
  // Auto's preset, as dsh-permission-presets reports it for the Session.
  ctx.provide('permissionPresets', { current: () => 'auto', set() {}, registerAuto() {} })
  // The reviewer's model: any call here is a review that ran, and its input is the evidence.
  ctx.provide('llm', { stream: (options) => { reviewerCalls++; reviews.push(options); return reviewer(ALLOW, options.signal) } })
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
  ctx.provide('agentPresets', { presetForSession: () => 'standard' })
  ctx.provide('agents', { turnBoundaryOf: () => ({ lastTurn: 3 }) })
  autoReview.apply(ctx)
  const dispatch = ctx.tools.execute.bind(ctx.tools)
  let executeCalls = 0
  ctx.tools.execute = (input) => {
    executeCalls++
    return dispatch(input)
  }
  const session = Session.create('s1')
  session.append('turn/start', { turn: 3 })
  session.append('step/start', { turn: 3, step: 1 })
  session.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4' }, tools: [schema] } })
  const agent = { session }
  const backchannel = new Backchannel({ ctx })
  await backchannel.listen()
  const record = backchannel.mint({ sessionId: 's1', agent, name: 'Fake agent' })
  try {
    const response = await fetch(backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: { command: 'echo hi' }, callId: 'auto-1' }),
    })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.isError, false)
    assert.equal(reviewerCalls, 1, 'auto-review reached its reviewer')
    const reviewText = reviews[0].messages.map(message => message.content.map(block => block.text).join('\n')).join('\n')
    assert.match(reviewText, /"name": "bash"/)
    assert.match(reviewText, /\\"command\\":\\"echo hi\\"/)
    assert.equal(asked.length, 0, 'the bridge raises no dialog on Auto')
    assert.equal(executeCalls, 1, 'the bridge called tools.execute once')
    assert.deepEqual(executed, [{ command: 'echo hi' }], 'the tool body ran after the review')
    const events = session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/call').length, 1)
    assert.equal(events.filter(event => event.type === 'tool/result').length, 1)
    const synthetic = events.find(event => event.type === 'assistant/message')
    assert.equal(session.surface.nodes.includes(synthetic.seq), false)
  } finally {
    backchannel.dispose()
    await ctx.root.fiber.dispose()
  }
})

test('full access runs a DSH tool call with no dialog, as it does DSH\'s own tools', async () => {
  const run = host({ sandbox: 'danger-full-access', policy: 'never' })
  await run.backchannel.listen()
  const record = run.backchannel.mint({ sessionId: 's1', agent: run.agent, name: 'Fake agent' })
  const response = await fetch(run.backchannel.urlFor(record), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
    body: JSON.stringify({ op: 'call', name: 'bash', arguments: {} }),
  })
  const body = await response.json()
  assert.equal(body.isError, false)
  assert.equal(run.asked.length, 0)
  assert.equal(run.executed.length, 1)
  run.backchannel.dispose()
})

test('a changed preset or level is a new signature, a new generation, and a waiting bridge is woken', async () => {
  const h = await serve()
  try {
    let preset = 'standard'
    let mode = 'workspace-write'
    const original = h.ctx.get
    h.ctx.get = (name) => {
      if (name === 'agentPresets') return { presetForSession: () => preset }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode }) }
      return original(name)
    }
    const before = h.record.generation
    // No change: the signature is stable.
    assert.equal(h.bc.refresh(h.record), false)
    const waiting = h.post('wait', { generation: h.record.generation, timeoutMs: 5_000 })
    // A level change reaches the bridge as a new list.
    mode = 'read-only'
    assert.equal(h.bc.refresh(h.record), true)
    const woken = await waiting
    assert.ok(woken.body.generation > before)
    assert.ok((await h.post('list')).body.generation > before)
    // The preset is part of the same fingerprint: creator mode's cordis preset is a change too.
    preset = 'cordis'
    assert.equal(h.bc.refresh(h.record), true)
    assert.equal(signatureOf(h.ctx, h.agent), h.record.signature)
  } finally {
    h.bc.dispose()
  }
})

test('a revoked bridge wakes its long poll and ends its calls', async () => {
  const h = await serve()
  const waiting = h.post('wait', { generation: h.record.generation, timeoutMs: 10_000 })
  // Wait until the poll is parked, so the revocation is what answers it.
  const deadline = Date.now() + 2_000
  while (h.record.waiters.size === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(h.record.waiters.size, 1)
  h.bc.revoke(h.record)
  const answer = await waiting
  assert.equal(answer.body.closed, true)
  assert.equal(h.bc.records.size, 0)
  h.bc.dispose()
})

test('a credential revoked while its approval is pending never runs the tool and the caller is refused', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const run = host({ answer: () => gate })
  await run.backchannel.listen()
  const record = run.backchannel.mint({ sessionId: 's1', agent: run.agent, name: 'Fake agent' })
  run.backchannel.announce(record)
  const pending = fetch(run.backchannel.urlFor(record), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
    body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId: 'race-1' }),
  })
  // Revoke while the ask is parked, then let it resolve allowed-once: the late grant loses.
  const deadline = Date.now() + 2_000
  while (run.asked.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(run.asked.length, 1, 'the approval was pending')
  run.backchannel.revoke(record)
  release('allowed-once')
  const response = await pending
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'refused' })
  assert.equal(run.executed.length, 0, 'the tool body never ran after revocation')
  // The call row was written before the ask; it is closed as an error, never left unanswered.
  const rows = run.session.snapshotEvents()
  assert.equal(rows.filter(event => event.type === 'tool/call').length, 1)
  const result = rows.find(event => event.type === 'tool/result')
  assert.ok(result, 'the revoked call has a result row')
  assert.equal(result.data.message.isError, true)
  assert.match(result.data.message.content[0].text, /revoked before bash ran/)
  run.backchannel.dispose()
})

test('drift is a plugin record that replay can carry: plugin:acp-dsh/toolset-drift', () => {
  const session = Session.create('s1')
  assert.equal(recordDrift(session, { name: 'Bash', title: 'Bash: ls', provider: 'acp-claude' }), true)
  const record = pluginRecordOf(session.snapshotEvents().at(-1))
  assert.equal(record.type, 'plugin:acp-dsh/toolset-drift')
  assert.deepEqual(record.data, { name: 'Bash', title: 'Bash: ls', provider: 'acp-claude' })
})

test('the turn position for the bridge\'s rows comes from the log the Session already committed', () => {
  const h = host()
  assert.deepEqual(positionOf(h.ctx, h.session), { turn: 3, step: 1 })
})

test('a tool that throws an Error with no code settles a JSON result row, and the session loads', async () => {
  const h = host({ sandbox: 'danger-full-access', policy: 'never', turn: 1, fail: new Error('boom') })
  await h.backchannel.listen()
  const record = h.backchannel.mint({ sessionId: 's1', agent: h.agent, name: 'Fake agent' })
  h.backchannel.announce(record)
  try {
    const response = await fetch(h.backchannel.urlFor(record), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${record.credential}` },
      body: JSON.stringify({ op: 'call', name: 'bash', arguments: {}, callId: 'bridge-throws' }),
    })
    const body = await response.json()
    assert.equal(body.isError, true)
    assert.deepEqual(body.error, { name: 'Error' })
    assert.equal(h.executed.length, 1)
    h.session.append('step/end', { turn: 1, step: 1 })
    h.session.append('turn/end', { turn: 1, reason: 'stop' })

    const results = h.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1, 'the throwing call has its result row')
    assert.equal(results[0].data.message.toolCallId, 'bridge-throws')
    assert.equal(results[0].data.message.isError, true)
    assert.match(JSON.stringify(results[0].data.message.content), /Error: boom/)
    assert.deepEqual(results[0].data.error, { name: 'Error' }, 'no undefined code key')
    assert.doesNotThrow(() => assertLoadable(h.session), 'the finished session loads')
  } finally {
    h.backchannel.dispose()
  }
})
