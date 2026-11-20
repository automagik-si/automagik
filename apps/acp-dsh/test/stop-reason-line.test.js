import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'
import { AcpAdapter, NOTICE_KIND } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const SESSION = 's1'
const NATIVE = 'acp-omp'
const OWN = 'acp-fake'
const unixOnly = { skip: process.platform === 'win32' ? 'the fake CLI uses a POSIX shebang' : false }
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

function fakeCli(dir, name, env) {
  const path = join(dir, name)
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`).join('\n')
  writeFileSync(path, `#!/bin/sh\n${exports}\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function nativeHost(t, stopReason) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-stop-line-'))
  const disposers = []
  t.after(() => {
    for (const dispose of disposers) dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const cli = fakeCli(dir, 'omp', { FAKE_ACP_MODES: 'default', FAKE_ACP_REVIEW_STOP: stopReason })
  const appended = []
  const agent = {
    session: { id: SESSION, header: { cwd: dir }, append: (type, data) => { appended.push({ type, data }) } },
    ctx: { tools: { register: () => () => {} } },
  }
  let adapter
  const ctx = {
    llm: { registerAdapter: (_providers, value) => { adapter = value } },
    agents: { get: id => (id === SESSION ? agent : undefined), list: () => [agent] },
    effect: fn => { disposers.push(fn()) },
  }
  apply(ctx, { claude: false, codex: false, omp: true }, {
    store: {},
    find: name => (name === 'omp' ? cli : undefined),
    signedIn: async () => undefined,
    catalogHome: join(dir, 'catalog'),
  })
  return { adapter, appended }
}

const said = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function step(adapter, provider, messages) {
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model: 'default', sessionId: SESSION, messages }))) chunks.push(chunk)
  return chunks
}

const blocksIn = chunks => chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
const textBlocks = chunks => blocksIn(chunks).filter(block => block.type === 'text').map(block => block.text)
const deltas = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)
const stopNotices = events => events.filter(e => e.type === 'user/message' && e.data.source?.kind === NOTICE_KIND && e.data.source?.stop !== undefined)
const finish = kind => ({ type: 'finish', reason: { kind } })

const REFUSAL = '[omp (ACP) declined to go on with this request. Ask again in a new message.]'
const LIMIT = '[omp (ACP) stopped at its limit of requests for one turn. Reply to let it go on.]'

for (const [reason, line] of [['refusal', REFUSAL], ['max_turn_requests', LIMIT]]) {
  test(`${reason} says why in the reply and finishes with stop`, unixOnly, async t => {
    const { adapter, appended } = nativeHost(t, reason)
    const chunks = await step(adapter, NATIVE, [said('reviewer denies 0')])
    assert.deepEqual(chunks.at(-1), finish('stop'))
    assert.deepEqual(deltas(chunks), [line])
    assert.deepEqual(textBlocks(chunks), [line])
    assert.deepEqual(stopNotices(appended), [])
  })
}

test('a refusal after text has a block of its own in the same step', unixOnly, async t => {
  const { adapter } = nativeHost(t, 'refusal')
  const chunks = await step(adapter, NATIVE, [said('reviewer denies 0 then text')])
  assert.deepEqual(chunks.at(-1), finish('stop'))
  assert.deepEqual(textBlocks(chunks), ['Continuing.', REFUSAL])
})

test("an ordinary end_turn only shows the agent's text", unixOnly, async t => {
  const { adapter } = nativeHost(t, 'refusal')
  const chunks = await step(adapter, NATIVE, [said('plain')])
  assert.deepEqual(chunks.at(-1), finish('stop'))
  assert.deepEqual(textBlocks(chunks), ['Fake agent, turn 1: you said "plain".'])
})

// An own-mode turn with a real Session and the mirror running through DSH's tool pipeline.
async function ownHost(t, stopReason, name = 'Fake agent') {
  const dir = mkdtempSync(join(tmpdir(), 'acp-own-stop-line-'))
  const ctx = new Context()
  const session = Session.create(SESSION, undefined, { version: 4, id: SESSION, createdAt: 0, isSeeded: false, cwd: dir })
  const agent = { session, status: 'idle' }
  const spec = {
    name,
    modeFor: AGENTS['acp-codex'].modeFor,
    ownMode: 'agent',
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_MODES: 'workspace-write,agent', FAKE_ACP_REVIEW_STOP: stopReason } }),
  }
  const adapter = new AcpAdapter(ctx, new Map([[OWN, spec]]), { ownMode: () => () => true })
  let scope
  t.after(async () => {
    adapter.dispose()
    await scope?.dispose()
    await ctx.root.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  ctx.provide('systemPrompt', { tools() {}, section() {} })
  ctx.provide('approval', { effectivePolicy: () => 'ask' })
  ctx.provide('permissionPresets', { current: () => 'workspace-write' })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  ctx.provide('agents', { get: id => (id === SESSION ? agent : undefined), list: () => [agent], turnBoundaryOf: () => ({ lastTurn: 1 }) })
  await ctx.plugin(ToolsService)
  await ctx.plugin(native)
  await ctx.plugin({ name: 'test-agents', inject: ['tools'], apply(child) { scope = createScope(child, agent) } })
  agent.ctx = scope.ctx
  adapter.registerMirror(agent)
  const modelSelection = { provider: OWN, model: 'default' }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const { name: toolName, description, parameters } = adapter.tool
  session.append('request/header', { header: { config: modelSelection, tools: [{ name: toolName, description, parameters }] } })
  const run = async block => {
    session.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [block], source: modelSelection }),
    }, { surfaceOp: 'append' })
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal })
    try {
      const { id, name, arguments: args } = block
      const batch = await ctx.tools.execute({ calls: [{ id, name, arguments: args }], agent, signal, log: { turn: 1, step: 1 }, toolSet, maxParallelToolCalls: 1 })
      return { role: 'tool', toolCallId: block.id, source: { kind: 'tool', callId: block.id }, content: batch.results[0].result.content }
    } finally {
      toolSet.dispose()
    }
  }
  return { adapter, session, run }
}

test('a reviewer stop keeps its notice when the agent also hits its turn limit', { timeout: 15_000 }, async t => {
  const { adapter, session, run } = await ownHost(t, 'max_turn_requests')
  const messages = [said('reviewer denies 1')]
  const first = await step(adapter, OWN, messages)
  assert.deepEqual(first.at(-1), finish('tool-calls'))
  assert.deepEqual(textBlocks(first), [])
  const [call] = blocksIn(first)
  assert.equal(call.type, 'tool-call')
  messages.push({ role: 'assistant', source: { kind: 'model', provider: OWN, model: 'default' }, content: [call] }, await run(call))

  const last = await step(adapter, OWN, messages)
  assert.deepEqual(last.at(-1), finish('stop'))
  assert.deepEqual(textBlocks(last), ['[Fake agent stopped at its limit of requests for one turn. Reply to let it go on.]'])
  assert.deepEqual(stopNotices(session.snapshotEvents()).map(e => e.data.source.stop), ['refusals'])
})

const HOME = homedir()
test('the stop line masks the home folder in both the delta and the block', { skip: HOME === parse(HOME).root }, async t => {
  const { adapter } = await ownHost(t, 'refusal', `Fake agent (${HOME})`)
  const chunks = await step(adapter, OWN, [said('reviewer denies 0')])
  const line = '[Fake agent (~) declined to go on with this request. Ask again in a new message.]'
  assert.deepEqual(chunks.at(-1), finish('stop'))
  assert.deepEqual(deltas(chunks), [line])
  assert.deepEqual(textBlocks(chunks), [line])
})
