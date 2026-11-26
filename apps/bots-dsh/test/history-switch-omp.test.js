import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply as applyExecutor, inject as executorInject } from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { apply as applyAcp } from '../../acp-dsh/index.js'
import { AdapterStore } from '../../acp-dsh/src/host/install.js'
import { createRuntime } from '../index.js'
import { textOf } from '../src/host/text.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

const OMP = 'acp-omp'
const OUTGOING = 'deepseek'
const MODEL = 'v4'
const marker = 'marker-2061'
const firstAnswer = 'first-bot-answer-2061'
const otherAnswer = 'other-bot-answer-2061'
const saved = Array.from({ length: 10 }, (_, i) => createHash('sha256').update(`fake-history-vault-${i}`).digest('hex')).join('').slice(0, 600)
const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const containsSavedPiece = text => Array.from({ length: saved.length - 7 }, (_, i) => saved.slice(i, i + 8)).some(piece => text.includes(piece))

test('a fake omp reads only its new chat’s masked history after a real Bot route switch', { timeout: 15_000, skip: process.platform === 'win32' }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'd2c-history-switch-'))
  const tracePath = join(home, 'fake.ndjson')
  const cli = join(home, 'fake-omp')
  const fake = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).href
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(join(home, 'omp.mjs'), [
    `process.env.FAKE_ACP_TRACE = ${JSON.stringify(tracePath)}`,
    "process.env.FAKE_ACP_OMP_DISCOVER = '1'",
    "process.env.FAKE_ACP_MODES = 'default'",
    `await import(${JSON.stringify(fake)})`,
  ].join('\n'))
  writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(home, 'omp.mjs'))} "$@"\n`, { mode: 0o755 })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['first'], workspaceId: 'team', nativeToolsOmpKept: true,
    bots: Object.fromEntries(['first', 'other'].map(id => [id, {
      id, name: id, sessionId: `${id}-part-1`, model: `${OUTGOING}/${MODEL}`,
      appliedModel: `${OUTGOING}/${MODEL}`, createdAt: 1, workDir: home,
    }])),
  }))

  const harness = new Context()
  const services = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } }
  const ctx = fakeContext({ services })
  ctx.registry = new Map()
  let rt
  t.after(async () => { rt?.dispose(); await ctx.dispose(); await harness.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  for (const plugin of [SessionStore, SessionProjectionRegistry, SystemPrompt, ApprovalService, ToolRuntime]) await harness.plugin(plugin)
  await harness.plugin({ apply: applyExecutor, inject: executorInject })
  let scope
  await harness.inject(['tools'], current => { scope = current })
  services.tools = harness.tools
  services.approval = harness.approval
  ctx.tools = harness.tools
  const on = ctx.on
  ctx.on = (event, listener, options) => {
    if (event === 'approval/request' || event === 'tools/execute' || event === 'tools/pre-execute') return harness.on(event, listener, options)
    return on(event, listener, options)
  }

  const agents = new Map()
  ctx.agents = services.agents = { get: id => agents.get(id), list: () => [...agents.values()] }
  ctx.sessions = { get: id => agents.get(id)?.session, list: () => [...agents.values()].map(agent => agent.session), flush: async () => {} }
  ctx.workspaceRegistry = { get: () => ({ id: 'team', path: home }), resolveByPath: async () => ({ id: 'team' }),
    archiveSession: async () => {} }
  ctx.sessionTitle = { rename: async () => {} }

  const addSession = id => {
    assert.equal(agents.has(id), false)
    const session = Session.create(id, undefined, { version: 4, id, cwd: home, isSeeded: false, createdAt: 0 })
    const inbox = { nextTurn: [], nextStep: [],
      prepend(target, message) { assert.equal(target, 'next-turn'); this.nextTurn.unshift(message) },
      append(target, message) { (target === 'next-turn' ? this.nextTurn : this.nextStep).push(message) },
      remove(id) { this.nextTurn = this.nextTurn.filter(message => message.id !== id) },
    }
    const agent = { id, session, status: 'idle', inbox, whenIdle: async () => {},
      runMaintenance: job => job(new AbortController().signal), followup: message => inbox.nextTurn.push(message),
      send: (message, target) => inbox.append(target, message) }
    agent.ctx = createScope(scope, agent).ctx
    agents.set(id, agent)
    return agent
  }
  const ids = []
  ctx.sessionController = {
    page: async ({ address, beforeSeq, throughSeq }) => ({
      records: agents.get(address.sessionId).session.snapshotEvents()
        .filter(event => (beforeSeq === undefined || event.seq < beforeSeq) && (throughSeq === undefined || event.seq <= throughSeq))
        .map(event => ({ event })),
      hasMore: false,
    }),
    create: async ({ sessionId: id = `first-fresh-${ids.length + 1}` }) => {
      ids.push(id)
      const agent = addSession(id)
      await ctx.emitAsync('agent/created', { agent })
      return { sessionId: id }
    },
    resolveAgent: async id => ({ agent: agents.get(id) }),
    selectModel: async ({ sessionId, ...route }) => ({ selected: route, sessionId }),
  }
  const notes = []
  ctx.llm.listProviders = () => [{ id: OUTGOING, name: 'Fake native' }, { id: OMP, name: 'Fake omp' }]
  ctx.llm.listModels = async provider => [{ id: provider === OUTGOING ? MODEL : 'default', name: provider }]
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 100_000 }, defaultMaxTokens: 1_000 })
  ctx.llm.stream = async function* (options) {
    assert.equal(options.provider, OUTGOING)
    notes.push(options)
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'The fake native route has no summary.' } } }
  }
  const dependencies = { store: new AdapterStore({ home: join(home, 'adapters') }), cliHome: join(home, 'cli'),
    find: name => name === 'omp' ? cli : undefined, signedIn: async () => undefined }
  applyAcp(ctx, { claude: false, codex: false, omp: true, dshTools: true }, dependencies)
  const adapter = ctx.adapters.at(-1).adapter

  const first = addSession('first-part-1')
  const other = addSession('other-part-1')
  const seed = (agent, text, answer) => {
    const { session } = agent
    session.append('turn/start', { turn: 1 })
    session.append('user/message', user(text), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: OUTGOING, model: MODEL } }, reason: 'initial' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      source: { kind: 'model', provider: OUTGOING, model: MODEL }, content: [{ type: 'text', text: `${marker} ${answer}` }],
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1, reason: { kind: 'stop' } })
    session.append('turn/end', { turn: 1, reason: { kind: 'stop' } })
  }
  seed(first, `${marker} ${firstAnswer} ${saved}`, firstAnswer)
  seed(other, `${marker} ${otherAnswer}`, otherAnswer)

  rt = createRuntime(ctx, { home, memory: false, browser: false, updateCheck: false })
  ctx.provide('omniTeam', rt)
  await rt.load()
  await ctx.emitAsync('agent/created', { agent: first })
  await ctx.emitAsync('agent/created', { agent: other })
  await rt.secretEndpoint('secret-set', { name: 'HIST', value: saved, scope: ['first'] })
  assert.equal(rt.secretStored('HIST'), true)
  assert.ok((await rt.searchOwnChat('other', marker)).lines.some(line => line.includes(otherAnswer)), 'the other Bot is searchable with the same query')

  assert.equal((await rt.switchRoute('first', `${OMP}/default`)).status, 'switching')
  await until(() => rt.botOf('first').sessionId !== first.id && [...rt.switchJobs()].length === 0)
  const bot = rt.botOf('first')
  assert.deepEqual(ids, [bot.sessionId])
  assert.equal(bot.appliedModel, `${OMP}/default`)
  assert.equal(bot.segments.at(-1).sessionId, first.id)
  assert.equal(bot.segments.at(-1).fallback, 'recent')
  assert.ok(notes.length > 0, 'the outgoing fake native route failed to summarize')
  const fresh = agents.get(bot.sessionId)
  assert.notEqual(fresh.session, first.session)
  const handoffs = fresh.inbox.nextTurn.filter(message => message.source?.handoff === true)
  assert.equal(handoffs.length, 1)
  const [handoff] = handoffs
  const handoffText = textOf(handoff.content)
  assert.match(handoffText, /wrote no summary in time for the switch/)
  assert.match(handoffText, /marker-2061.*first-bot-answer-2061/)
  assert.match(handoffText, /\[secret:HIST\]/)
  assert.equal(containsSavedPiece(handoffText), false)
  assert.doesNotMatch(handoffText, /other-bot-answer-2061/)

  const { session } = fresh
  const messages = [handoff, user(`history-lookup omp ${marker}`)]
  session.append('turn/start', { turn: 1 })
  for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
  assert.ok(harness.tools.get('read_own_chat', fresh), 'the runtime registered its own-chat tool in the fresh agent scope')
  session.append('step/start', { turn: 1, step: 1 })
  const tools = harness.tools.definitions(fresh).map(({ name, description, parameters }) => ({ name, description, parameters }))
  session.append('request/header', { header: { config: { provider: OMP, model: 'default' }, tools }, reason: 'initial' })
  const chunks = await Array.fromAsync(adapter.stream(markAgentLoopRequest({ sessionId: session.id, provider: OMP, model: 'default', messages })))
  const answer = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const prompt = trace.findLast(row => row.event === 'prompt')
  assert.ok(prompt, JSON.stringify(chunks.at(-1)))
  assert.ok(prompt.text.includes(handoffText), 'the fake received the queued handoff over ACP')
  assert.equal(containsSavedPiece(prompt.text), false)
  assert.match(answer, /Your own chat, messages mentioning "marker-2061"/, 'the fake omp must get the registered history tool result')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.doesNotMatch(answer, /other-bot-answer-2061/)
  const launch = trace.find(row => row.event === 'new-session' && row.pid === prompt.pid && row.sessionId === prompt.sessionId)
  assert.deepEqual(launch.servers, ['dsh'])
  assert.ok(trace.find(row => row.event === 'start' && row.pid === prompt.pid)?.args.includes('--no-tools'))
  const mcp = trace.filter(row => row.pid === prompt.pid && row.sessionId === prompt.sessionId)
  assert.match(mcp.find(row => row.event === 'mcp-discover')?.error ?? '', /server\/discover/)
  assert.deepEqual(mcp.find(row => row.event === 'mcp-list')?.tools, ['read_own_chat'])
  const result = mcp.find(row => row.event === 'mcp-history-result').answer
  assert.equal(result.isError, false)
  const returned = textOf(result.content)
  assert.match(returned, /marker-2061.*first-bot-answer-2061.*\[secret:HIST\]/)
  assert.equal(containsSavedPiece(returned), false)
  assert.doesNotMatch(returned, /other-bot-answer-2061/)
  const events = session.snapshotEvents()
  const asks = events.filter(row => row.type === 'approval/asked')
  assert.deepEqual(asks.map(row => row.data.toolName), ['read_own_chat'])
  assert.deepEqual(events.filter(row => row.type === 'approval/decided').map(row => row.data.outcome), ['allowed-once'])
  assert.deepEqual(rt.approvalsView(), [])
  assert.deepEqual(events.filter(row => row.type === 'tool/call').map(row => row.data.name), ['read_own_chat'])
  assert.equal(adapter.live.get(session.id)?.run.alive, true)
  assert.equal(mcp.some(row => row.event === 'close-session'), false)
})
