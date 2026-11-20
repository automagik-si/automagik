import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, SERVICE } from '../index.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Backchannel } from '../src/host/backchannel.js'
import { PermissionDiagnostics } from '../src/host/permission-diagnostics.js'

const PROVIDER = 'acp-claude'
const CLAUDE = AGENTS[PROVIDER]
const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const WRITE = 'workspace-write'

test('only Codex has an own mode in the Claude and Codex rows', () => {
  assert.equal(CLAUDE.ownMode, undefined)
  assert.equal(AGENTS['acp-codex'].ownMode, 'agent')
})

test('ACP registers both routes and reports an own mode only for Codex', t => {
  const routes = new Set()
  const services = new Map()
  const ctx = {
    llm: {
      registerAdapter(providers) {
        for (const provider of providers) routes.add(provider)
        return () => routes.clear()
      },
    },
    get: name => services.get(name),
    provide: (name, value) => services.set(name, value),
    effect: setup => t.after(setup()),
  }
  const clis = { claude: '/fake/claude', codex: '/fake/codex' }
  apply(ctx, { claude: true, codex: true }, {
    store: { binOf: () => '/fake/adapter', dispose() {} },
    find: name => clis[name],
    signedIn: async () => true,
  })
  assert.ok(routes.has(PROVIDER))
  assert.ok(routes.has('acp-codex'))
  const service = services.get(SERVICE)
  assert.equal(service.ownModeOf(PROVIDER), undefined)
  assert.equal(service.ownModeOf('acp-codex').mode, 'agent')
})

for (const bridge of [false, true]) test(`Claude starts a Workspace prompt in default with the bridge ${bridge ? 'on' : 'off'}`, { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-claude-withheld-'))
  const trace = join(dir, 'trace.jsonl')
  const session = Session.create('chat', undefined, { version: 4, id: 'chat', createdAt: 0, isSeeded: false, cwd: dir })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const services = {
    tools: { definitions: () => [] },
    // Workspace as DSH reads it: the stock `ask` policy, so the own-mode branch is reached.
    approval: { effectivePolicy: () => 'ask', request: async () => 'denied' },
    permissionPresets: { current: () => WRITE },
    sandboxPolicy: { resolve: () => ({ mode: WRITE }) },
    agentPresets: { presetForSession: () => 'standard' },
  }
  const ctx = { agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) }, get: name => services[name] }
  const { name, modeFor, ownMode, hardAsk, disableBuiltInTools, imageInput, drift, refresh } = CLAUDE
  const spec = {
    name, modeFor, ownMode, hardAsk, disableBuiltInTools, imageInput, drift, refresh,
    catalog: { model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_TRACE: trace, FAKE_ACP_MODES: 'auto,default,bypassPermissions' } }),
  }
  let asks = 0
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([[PROVIDER, spec]]), {
    dshTools: () => bridge, backchannel, ownMode: () => () => { asks++; return true },
  })
  adapter.diagnostics = new PermissionDiagnostics()
  t.after(() => {
    adapter.dispose()
    backchannel.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const controller = new AbortController()
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hang' }] }]
  let sawPrompt = false
  let finish
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: PROVIDER, model: 'default', sessionId: session.id, messages, signal: controller.signal }))) {
    if (chunk.type === 'finish') finish = chunk.reason
    if (chunk.type !== 'text-delta' || sawPrompt) continue
    sawPrompt = true
    assert.equal(adapter.live.get(session.id).run.busy, true)
    assert.equal(adapter.ownModeIn(session.id), false)
    const record = adapter.diagnostics.read(session.id)
    assert.equal(record.bridge.on, bridge)
    assert.equal(record.ownMode, undefined)
    controller.abort()
  }
  const rows = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  assert.ok(sawPrompt, JSON.stringify({ finish, rows }))
  assert.deepEqual(rows.find(row => row.event === 'new-session').servers, bridge ? ['dsh'] : [])
  assert.deepEqual(rows.filter(row => ['set-mode', 'prompt'].includes(row.event)).map(row => [row.event, row.modeId]), [
    ['set-mode', 'default'], ['prompt', undefined],
  ])
  assert.equal(asks, 0)
})
