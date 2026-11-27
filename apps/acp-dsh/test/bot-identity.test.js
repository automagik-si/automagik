import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply } from '../index.js'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter, freshSessionNotice } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import {
  createIdentityReaders, IDENTITY_PROVIDERS, identityText, ROLE_PROMPT_MAX, rolePromptOf,
} from '../src/host/identity.js'
import { MODEL_ACCESS_REQUIRED } from '../src/host/names.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'

const FAKE = join(import.meta.dirname, 'fixtures', 'identity-agent.mjs')
const identity = { name: 'Ada', role: 'Reviewer', instructions: 'Check files.' }
// #1544: the browser-to-person rule every owned acp-claude/acp-codex identity ends with.
const browserRule = '\n\nFor a Bot Browser request, use the browser tools this conversation offers. '
  + 'Never launch Chrome or another browser from a command. '
  + 'When sign-in, payment or verification needs the person, use the offered browser handoff '
  + '(`browser_handoff` when available) and stop until they answer. '
  + 'If you cannot open the page here, ask the Bot named `browse` only when `message_bot` is offered '
  + 'and that Bot is on the team. Say when the request was sent, then report the browser outcome '
  + 'when its reply arrives. If the route is unavailable or a call fails, say why.'
const text = "# Your identity\nYou are Ada, a Bot on the user's team."
  + ' Your role: Reviewer.\n\nCheck files.' + browserRule
const append = value => ({ mode: 'append', content: [{ type: 'text', text: value }] })
const content = value => [{ type: 'text', text: value }]
const sentinel = 'ROLE-SENTINEL-7f3a'
const claude = AGENTS['acp-claude'].name
const partOf = (body = sentinel, id = 'voice-mouth') =>
  `<role-prompt id="${id}">\n${body}\n</role-prompt>`
const part = partOf()
const withPart = rolePrompt =>
  text.slice(0, -browserRule.length) + `\n\n${rolePrompt}` + browserRule
const roleProfile = () => new Map([['ada', { ...identity, rolePrompt: part }]])
const history = [
  { role: 'user', source: { kind: 'user' }, content: content('Earlier request') },
  { role: 'assistant', source: { kind: 'model' }, content: content('Earlier answer') },
]

function fixture(t, capability = true, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-identity-'))
  const trace = join(dir, 'trace.jsonl')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const spec = {
    command: process.execPath, args: [FAKE], cwd: dir, name: 'Identity peer',
    env: {
      ...process.env, HOME: dir, USERPROFILE: dir,
      IDENTITY_TRACE: trace, IDENTITY_CAPABILITY: capability ? '1' : '0', ...env,
    },
    startMs: 5000, requestMs: 5000,
  }
  const rows = method => (existsSync(trace) ? readFileSync(trace, 'utf8') : '').trim().split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => row.method === method).map(row => row.params)
  return { dir, spec, rows }
}

function host(t, {
  provider = 'acp-claude', capability = true, profiles, dshTools = () => false, access,
  spawn = spec => spec, botIdentity, env, cancelWaitMs,
} = {}) {
  const f = fixture(t, capability, env)
  const bots = profiles ?? new Map([['ada', { ...identity }]])
  const appended = []
  const sessions = new Map(['ada', 'someone', 'unowned'].map(id => [id, {
    session: { id, header: { cwd: f.dir }, append: (type, data, options) => {
      appended.push({ id, type, data, options })
      return { seq: appended.length }
    } },
    status: 'idle', ctx: { tools: { register: () => () => {} } },
  }]))
  const warnings = []
  const reads = []
  const policyReads = []
  const ctx = {
    agents: { get: id => sessions.get(id), list: () => [...sessions.values()] },
    on: () => () => {},
    logger: { warn: message => warnings.push(message), info: message => warnings.push(message) },
    get: name => {
      if (name === 'approval') return { effectivePolicy: () => 'ask' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'read-only' }) }
      return undefined
    },
  }
  const adapter = new AcpAdapter(ctx, new Map([[provider, {
    ...AGENTS[provider], spawn: AGENTS[provider].nativeSwitch === 'args' ? () => spawn(f.spec) : async () => spawn(f.spec),
  }]]), {
    dshTools, access, cancelWaitMs,
    botIdentity: id => { reads.push(id); return botIdentity ? botIdentity(id) : bots.get(id) },
    policyState: id => { policyReads.push(id); return { ok: true, identity: bots.get(id) } },
    solverIdentity: id => bots.get(id),
  })
  const diagnostics = adapter.diagnostics = new PermissionDiagnostics()
  t.after(() => adapter.dispose())
  let n = 0
  const turn = (id = 'ada') => {
    adapter.noteEvent(sessions.get(id).session, { type: 'turn/start', data: { turn: ++n } })
  }
  const stream = async (id = 'ada', message = 'Hello', before = [], signal) => {
    const messages = [...before, { role: 'user', content: content(message) }]
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      provider, model: 'default', sessionId: id, messages, signal,
    }))) chunks.push(chunk)
    return chunks
  }
  const step = async (id = 'ada', message = 'Hello', before = []) => {
    const chunks = await stream(id, message, before)
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks.at(-1)))
    return adapter.live.get(id).run
  }
  const stepAborted = async (id, waitForPromptRow) => {
    const controller = new AbortController()
    const pending = stream(id, 'Stop this request', history, controller.signal)
    try {
      const deadline = Date.now() + 3000
      while (!waitForPromptRow()) {
        assert.ok(Date.now() < deadline, 'the peer received the prompt before Stop')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    } finally {
      controller.abort()
      await pending
    }
    assert.equal((await pending).at(-1)?.reason?.kind, 'aborted')
    await adapter.live.get(id)?.run.prompting
  }
  return { ...f, adapter, appended, bots, diagnostics, reads, policyReads, warnings, step, stream, turn,
    stepAborted }
}

for (const provider of ['acp-claude', 'acp-codex']) {
  test(`${provider} session/new receives append identity without the tools bridge`, async t => {
    const h = host(t, { provider })
    await h.step('ada', 'Hello', [{ role: 'system', content: 'Native team rules and tools.' }])
    assert.deepEqual(h.rows('new')[0].systemPrompt, append(text))
    assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
    assert.deepEqual(h.reads, ['ada'])
    assert.ok(h.policyReads.length > 0 && h.policyReads.every(id => id === 'ada'))
    assert.ok(h.warnings.some(line => line.endsWith('Bot identity: systemPrompt')))
    assert.ok(h.warnings.every(line => !line.includes('Check files.') && !line.includes('Bot Browser')))
    if (AGENTS[provider].hardAsk) {
      assert.deepEqual(h.rows('new')[0]._meta, AGENTS[provider].hardAsk())
    }
  })
  test(`${provider} receives the role after instructions and before the browser rule`, async t => {
    const h = host(t, { provider, profiles: roleProfile() })
    await h.step()
    assert.deepEqual(h.rows('new')[0].systemPrompt, append(withPart(part)))
    assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
  })
}

test('no identity sends no system prompt or preamble', async t => {
  for (const capability of [true, false]) {
    const h = host(t, { capability })
    await h.step('unowned')
    assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
    assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
    assert.ok(h.warnings.some(line => line.endsWith('Bot identity: none')))
  }
})

test('unsupported capability sends one preamble before replay and user content', async t => {
  const h = fixture(t, false)
  const deliveries = []
  const run = new AgentRun({
    ...h.spec, botIdentity: () => text, onIdentity: value => deliveries.push(value),
  })
  t.after(() => run.dispose())
  await run.start()
  const first = [...content('Replay'), ...content('Hello')]
  await run.prompt(first)
  await run.prompt(content('Again'))
  await run.fork({ cwd: h.dir, mcpServers: [] })
  await run.prompt(content('After fork'))
  assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
  assert.equal(Object.hasOwn(h.rows('fork')[0], 'systemPrompt'), false)
  assert.deepEqual(h.rows('prompt').map(row => row.prompt), [
    [...content(text), ...first], content('Again'), content('After fork'),
  ])
  assert.deepEqual(first, [...content('Replay'), ...content('Hello')])
  assert.deepEqual(deliveries, ['preamble'])
})

test('append preserves existing session metadata and tool-refresh fork identity', async t => {
  const h = fixture(t)
  let current = text
  const meta = { disableBuiltInTools: true, custom: { enabled: true } }
  const run = new AgentRun({
    ...h.spec, refresh: AGENTS['acp-codex'].refresh, sessionMeta: meta,
    botIdentity: () => current,
  })
  t.after(() => run.dispose())
  await run.start()
  await run.prompt(content('Hello'))
  current = 'Edited instructions.'
  await run.fork({ cwd: h.dir, mcpServers: [] })
  await run.prompt(content('After fork'))
  assert.deepEqual(h.rows('new')[0]._meta, meta)
  assert.deepEqual(h.rows('fork')[0].systemPrompt, append(text))
  assert.deepEqual(h.rows('prompt').map(row => row.prompt), [
    content('Hello'), content('After fork'),
  ])
})

test('running session keeps its identity and a fresh session reads edited text', async t => {
  const h = host(t)
  const run = await h.step()
  h.bots.get('ada').instructions = 'Read the diff.'
  assert.equal(await h.step('ada', '[Your instructions changed] Read the diff.'), run)
  assert.deepEqual(h.reads, ['ada', 'ada'])
  assert.equal(h.rows('new').length, 1)
  h.adapter.endSession('ada')
  await h.step()
  assert.deepEqual(h.reads, ['ada', 'ada', 'ada'])
  const edited = text.replace('Check files.', 'Read the diff.')
  assert.deepEqual(h.rows('new')[1].systemPrompt, append(edited))
})

test('omp receives the Solver limits supplement once without the role snapshot', async t => {
  const limits = partOf('SOLVER-LIMITS-SENTINEL', 'solver')
  const h = host(t, { provider: 'acp-omp', profiles: new Map([
    ['ada', { ...identity, rolePrompt: part, solverLimitsPrompt: limits }],
  ]) })
  await h.step('ada')
  const [opened] = h.rows('new')
  assert.deepEqual(opened.systemPrompt, append(limits))
  assert.ok(!JSON.stringify(h.rows('prompt')).includes('SOLVER-LIMITS-SENTINEL'))
})

for (const provider of ['acp-hermes', 'acp-antigravity']) {
  test(`LA-5 ${provider} receives written Solver rules once`, async t => {
    const limits = partOf('WRITTEN-SOLVER-LIMITS', 'solver')
    const h = host(t, { provider, profiles: new Map([['ada', { ...identity, solverLimitsPrompt: limits }]]) })
    await h.step('ada')
    assert.deepEqual(h.rows('new')[0].systemPrompt, append(limits), provider)
    assert.ok(!JSON.stringify(h.rows('prompt')).includes('WRITTEN-SOLVER-LIMITS'), provider)
  })
}

test("another Bot's identity and native tool policy never cross", async t => {
  const h = host(t, { profiles: new Map([
    ['ada', { ...identity, system: 'Native policy', capabilities: ['bash'], main: true }],
    ['someone', { name: 'Someone', instructions: 'Write notes.' }],
  ]) })
  await h.step('ada')
  await h.step('someone')
  assert.deepEqual(h.rows('new').map(row => row.systemPrompt), [
    append(text),
    append("# Your identity\nYou are Someone, a Bot on the user's team.\n\nWrite notes." + browserRule),
  ])
})

test('Hermes receives no identity through this channel', async t => {
  const h = host(t, { provider: 'acp-hermes', profiles: roleProfile() })
  await h.step()
  assert.deepEqual(h.reads, [])
  assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
  assert.deepEqual(h.rows('prompt')[0].prompt, content('Hello'))
})


test('identity registrations are scoped, dispose independently and refuse competing owners', t => {
  let adapter
  let service
  const disposers = []
  const warnings = []
  const ctx = {
    llm: { registerAdapter: (_ids, value) => { adapter = value; return () => {} } },
    agents: { get: () => undefined, list: () => [] },
    get: () => undefined,
    on: () => () => {},
    effect: execute => disposers.push(execute()),
    provide: (name, value) => { if (name === 'acpAgents') service = value },
    logger: { warn: message => warnings.push(message), info: message => warnings.push(message) },
  }
  apply(ctx, { fakeAgent: FAKE, claude: false, codex: false, dshTools: false }, {
    store: {}, find: () => undefined,
  })
  t.after(() => { for (const dispose of disposers) dispose?.() })
  assert.deepEqual(service.rolePromptProviders, ['acp-claude', 'acp-codex'])
  assert.equal(service.rolePromptProviders, IDENTITY_PROVIDERS)
  assert.equal(Object.isFrozen(service.rolePromptProviders), true)
  assert.throws(() => service.rolePromptProviders.push('acp-hermes'), TypeError)
  const offAda = service.botIdentity(id => id === 'ada' ? identity : undefined)
  const other = { name: 'Someone', instructions: 'Write notes.' }
  const offOther = service.botIdentity(id => id === 'someone' ? other : undefined)
  assert.equal(adapter.botIdentity('ada'), identity)
  assert.equal(adapter.botIdentity('someone'), other)
  assert.equal(adapter.botIdentity('unowned'), undefined)
  const offConflict = service.botIdentity(id => id === 'ada' ? other : undefined)
  assert.equal(adapter.botIdentity('ada'), undefined)
  assert.ok(warnings.some(line => line.includes('competing Bot identities')))
  offConflict()
  assert.equal(adapter.botIdentity('ada'), identity)
  offAda()
  assert.equal(adapter.botIdentity('ada'), undefined)
  assert.equal(adapter.botIdentity('someone'), other)
  offOther()
  assert.equal(adapter.botIdentity('someone'), undefined)
  service.botIdentity(undefined)()
})

test('the role preamble is sent once and does not repeat after a fork', async t => {
  const h = fixture(t, false)
  const run = new AgentRun({ ...h.spec, botIdentity: () => identityText(identity, part) })
  t.after(() => run.dispose())
  await run.start()
  await run.prompt(content('First'))
  await run.fork({ cwd: h.dir, mcpServers: [] })
  await run.prompt(content('After fork'))
  assert.equal(Object.hasOwn(h.rows('fork')[0], 'systemPrompt'), false)
  assert.deepEqual(h.rows('prompt').map(row => row.prompt), [
    [...content(withPart(part)), ...content('First')], content('After fork'),
  ])
})

test('identity validation bounds the role bytes and accepts the native body as opaque', async t => {
  const prefix = '<role-prompt id="voice-mouth">\n'
  const suffix = '\n</role-prompt>'
  const size = ROLE_PROMPT_MAX + 1 - Buffer.byteLength(prefix + suffix + sentinel)
  const tooBig = partOf(sentinel + 'é'.repeat(Math.floor(size / 2)) + 'x'.repeat(size % 2))
  assert.equal(Buffer.byteLength(tooBig), ROLE_PROMPT_MAX + 1)
  const invalid = [
    [42, 'type'], [{}, 'type'], [tooBig, 'size'],
    [part.slice(prefix.length), 'shape'], [part.slice(0, -suffix.length), 'shape'],
    [partOf(sentinel, 'Bad_Id'), 'shape'],
  ]
  for (const [index, [rolePrompt, refused]] of invalid.entries()) {
    await t.test(`refusal ${index + 1} (${refused})`, async t => {
      const profiles = new Map([['ada', { ...identity, rolePrompt }]])
      const h = host(t, { profiles })
      await h.step()
      await h.step()
      assert.deepEqual(rolePromptOf(profiles.get('ada')), { digest: '', refused })
      assert.deepEqual(h.rows('new').map(row => row.systemPrompt), [append(text)])
      assert.equal(h.warnings.filter(line => line.includes('Bot role prompt refused')).length, 1)
      assert.ok(h.warnings.some(line => line.endsWith(`Bot role prompt refused (${refused})`)))
      assert.ok(h.warnings.every(line => !line.includes(sentinel)))
    })
  }
  const long = partOf('é'.repeat(8192), 'a'.repeat(41))
  assert.ok(Buffer.byteLength(long) < ROLE_PROMPT_MAX)
  const accepted = [
    long, partOf('before\u2028after'), partOf('literal </role-prompt>'), partOf(' \t '),
  ]
  const h = host(t, { profiles: roleProfile() })
  for (const rolePrompt of accepted) {
    h.bots.get('ada').rolePrompt = rolePrompt
    await h.step()
  }
  assert.deepEqual(
    h.rows('new').map(row => row.systemPrompt), accepted.map(p => append(withPart(p))))
  assert.ok(h.warnings.every(line => !line.includes('Bot role prompt refused')))
  assert.deepEqual(rolePromptOf({ name: ' ', rolePrompt: part }), { digest: '' })
  assert.deepEqual(rolePromptOf(identity), { digest: '' })
})

test('role changes replay answered chat and instruction edits keep the run', async t => {
  const h = host(t, { dshTools: () => undefined })
  await h.step('ada', 'Earlier request')
  h.bots.get('ada').rolePrompt = part
  const attached = await h.step('ada', 'Next request', history)
  assert.equal(h.rows('new').length, 2)
  assert.deepEqual(h.rows('new')[1].systemPrompt, append(withPart(part)))
  const replay = h.rows('prompt')[1].prompt.map(block => block.text).join('\n')
  assert.ok(replay.startsWith(`The chat so far, before this new ${claude} session:`))
  assert.match(replay, /User: Earlier request/)
  assert.match(replay, /Assistant: Earlier answer/)
  assert.equal(await h.step('ada', 'Same role', history), attached)
  assert.equal(h.rows('new').length, 2)
  delete h.bots.get('ada').rolePrompt
  const detached = await h.step('ada', 'Detached', history)
  assert.equal(h.rows('new').length, 3)
  assert.deepEqual(h.rows('new')[2].systemPrompt, append(text))
  h.bots.get('ada').instructions = 'Edited instructions.'
  assert.equal(await h.step('ada', 'Same role, new instructions', history), detached)
  assert.equal(h.rows('new').length, 3)
  assert.equal(h.warnings.filter(line => line.includes('role prompt changed')).length, 2)
})

test('the kill switch shows a new-session notice and sends only the current message', async t => {
  const h = host(t)
  await h.step()
  h.bots.get('ada').rolePrompt = part
  await h.step('ada', 'Only this request', history)
  assert.equal(h.rows('new').length, 2)
  assert.deepEqual(h.rows('prompt')[1].prompt, content('Only this request'))
  const { id: _id, ...notice } = freshSessionNotice(claude)
  const rows = h.appended.map(({ data: { id: _id, ...data }, ...row }) => ({ ...row, data }))
  assert.deepEqual(rows, [{
    id: 'ada', type: 'user/message', data: notice,
    options: { surfaceOp: 'append' },
  }])
})

for (const failure of ['throw', 'dispose', 'conflict']) {
  test(`a ${failure} in the identity registry rebuilds once until it recovers`, async t => {
    const warnings = []
    const registry = createIdentityReaders(message => warnings.push(message))
    const h = host(t, { botIdentity: registry.read })
    let throwing = false
    const reader = () => {
      if (throwing) throw new Error(sentinel)
      return { ...identity, rolePrompt: part }
    }
    const dispose = registry.register(reader)
    await h.step()
    if (failure === 'throw') throwing = true
    if (failure === 'dispose') dispose()
    const unconflict = failure === 'conflict'
      ? registry.register(() => ({ name: 'Competing Bot' })) : undefined
    await h.step()
    assert.equal(h.rows('new').length, 2)
    assert.equal(Object.hasOwn(h.rows('new')[1], 'systemPrompt'), false)
    await h.step()
    assert.equal(h.rows('new').length, 2)
    throwing = false
    if (failure === 'dispose') registry.register(reader)
    unconflict?.()
    await h.step()
    assert.deepEqual(h.rows('new').map(row => row.systemPrompt), [
      append(withPart(part)), undefined, append(withPart(part)),
    ])
    if (failure !== 'dispose') {
      assert.ok(warnings.some(line => line.includes('no identity is sent')))
      assert.ok(warnings.every(line => !line.includes(sentinel)))
    }
  })
}

test('a failing reader does not replace a role-free agent session', async t => {
  const registry = createIdentityReaders(() => {})
  registry.register(() => { throw new Error('Reader failed') })
  const h = host(t, { botIdentity: registry.read })
  for (let i = 0; i < 3; i++) await h.step()
  assert.equal(h.rows('new').length, 1)
  assert.equal(Object.hasOwn(h.rows('new')[0], 'systemPrompt'), false)
})

for (const failure of ['access', 'spawn']) {
  test(`a failed ${failure} check leaves the revoked role's agent session ended`, async t => {
    let fail = false
    const h = host(t, {
      profiles: roleProfile(),
      access: () => fail && failure === 'access' ? 'Account is unconfirmed' : undefined,
      spawn: spec => {
        if (fail && failure === 'spawn') throw new Error('Fake spawn failed')
        return spec
      },
    })
    const old = await h.step()
    const current = partOf('Updated role text')
    h.bots.get('ada').rolePrompt = current
    fail = true
    const reason = (await h.stream()).at(-1).reason
    assert.equal(reason.kind, 'error')
    if (failure === 'access') assert.equal(reason.failure.code, MODEL_ACCESS_REQUIRED)
    else assert.match(reason.failure.message, /Fake spawn failed/)
    assert.equal(h.adapter.live.has('ada'), false)
    assert.equal(old.alive, false)
    assert.equal(h.rows('new').length, 1)
    fail = false
    await h.step()
    assert.equal(h.rows('new').length, 2)
    assert.deepEqual(h.rows('new')[1].systemPrompt, append(withPart(current)))
  })
}

for (const capability of [true, false]) {
  test(`role text stays out of ACP state and sinks (systemPrompt=${capability})`, async t => {
    const h = host(t, { capability, profiles: roleProfile() })
    const run = await h.step('ada', 'Hello', history)
    const { run: _run, ...state } = h.adapter.live.get('ada')
    assert.match(state.roleDigest, /^[a-f0-9]{64}$/)
    assert.equal(run.spec.botIdentity, undefined)
    if (!capability) assert.equal(run.identityPreamble, undefined)
    const diagnostics = h.diagnostics.read('ada')
    assert.ok(diagnostics)
    for (const sink of [h.warnings, state, diagnostics, h.appended]) {
      assert.ok(!JSON.stringify(sink).includes(sentinel))
    }
    const wire = capability ? h.rows('new')[0].systemPrompt : h.rows('prompt')[0].prompt
    assert.ok(JSON.stringify(wire).includes(sentinel))
  })
}

test('a peer echo reaches the turn error without entering ACP logs or diagnostics', async t => {
  const h = host(t, {
    profiles: roleProfile(), env: { IDENTITY_REJECT_FIRST: '1', IDENTITY_ECHO: '1' },
  })
  const reason = (await h.stream('ada', 'Hello', history)).at(-1).reason
  assert.equal(reason.kind, 'error')
  assert.ok(reason.failure.message.includes(sentinel))
  for (const line of h.warnings) assert.ok(!line.includes(sentinel), line)
  assert.ok(!JSON.stringify(h.diagnostics.read('ada')).includes(sentinel))
  assert.ok(!JSON.stringify(h.appended).includes(sentinel))
})

for (const [mode, env] of [
  ['rejected', { IDENTITY_REJECT_FIRST: '1' }],
  ['rejected after an update', { IDENTITY_REJECT_FIRST: '1', IDENTITY_UPDATE_FIRST: '1' }],
  ['cancelled', { IDENTITY_HOLD_FIRST: '1' }],
]) {
  test(`a ${mode} role preamble retires the session before the next prompt`, async t => {
    const h = host(t, {
      capability: false, profiles: roleProfile(), dshTools: () => undefined, env,
      cancelWaitMs: 2000,
    })
    h.turn()
    if (mode === 'cancelled') {
      await h.stepAborted('ada', () => h.rows('prompt').length === 1)
    } else {
      assert.equal((await h.stream('ada', 'First', history)).at(-1).reason.kind, 'error')
    }
    const old = h.adapter.live.get('ada').run
    delete h.spec.env.IDENTITY_REJECT_FIRST
    delete h.spec.env.IDENTITY_HOLD_FIRST
    h.turn()
    const replacement = await h.step('ada', 'Second', history)
    assert.notEqual(replacement, old)
    assert.equal(h.rows('new').length, 2)
    const prompt = h.rows('prompt')[1].prompt
    assert.deepEqual(prompt[0], content(withPart(part))[0])
    assert.ok(prompt[1].text.startsWith(`The chat so far, before this new ${claude} session:`))
    assert.equal(h.warnings.filter(line => line.includes('role prompt not confirmed')).length, 1)
  })
}

for (const [mode, capability, profiles, reject] of [
  ['delivered role preamble', false, roleProfile(), false],
  ['rejected systemPrompt route', true, roleProfile(), true],
  ['rejected role-free preamble', false, undefined, true],
]) {
  test(`a ${mode} keeps the agent session`, async t => {
    const h = host(t, {
      capability, profiles, env: { IDENTITY_REJECT_FIRST: reject ? '1' : '0' },
    })
    h.turn()
    assert.equal((await h.stream()).at(-1).reason.kind, reject ? 'error' : 'stop')
    const old = h.adapter.live.get('ada').run
    h.turn()
    assert.equal(await h.step('ada', 'Second'), old)
    assert.equal(h.rows('new').length, 1)
    assert.deepEqual(h.rows('prompt')[1].prompt, content('Second'))
    assert.ok(h.warnings.every(line => !line.includes('role prompt not confirmed')))
  })
}

for (const held of [false, true]) {
  test(`an identity failure keeps the ${held ? 'cancelled' : 'idle'} turn's role until next turn`,
    async t => {
      let throwing = false
      const h = host(t, {
        botIdentity: () => {
          if (throwing) throw new Error('Reader failed')
          return { ...identity, rolePrompt: part }
        },
        env: { IDENTITY_HOLD_FIRST: held ? '1' : '0' }, cancelWaitMs: 2000,
      })
      h.turn()
      if (held) await h.stepAborted('ada', () => h.rows('prompt').length === 1)
      else await h.step()
      const old = h.adapter.live.get('ada').run
      h.turn('someone')
      throwing = true
      assert.equal(await h.step('ada', 'Same turn'), old)
      if (held) assert.equal(h.rows('cancel').length, 1)
      assert.equal(h.rows('new').length, 1)
      assert.equal(h.rows('prompt')[1].sessionId, h.rows('prompt')[0].sessionId)
      assert.ok(h.warnings.every(line => !line.includes('role prompt changed')))
      delete h.spec.env.IDENTITY_HOLD_FIRST
      h.turn()
      await h.step('ada', 'Next turn')
      assert.equal(h.rows('new').length, 2)
      assert.equal(Object.hasOwn(h.rows('new')[1], 'systemPrompt'), false)
      h.turn()
      await h.step('ada', 'Reader still failed')
      assert.equal(h.rows('new').length, 2)
    })
}
