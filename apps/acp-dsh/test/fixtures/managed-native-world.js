import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from '../../src/host/adapter.js'
import { AGENTS } from '../../src/host/agents.js'
import { Backchannel } from '../../src/host/backchannel.js'

export const CLAUDE = 'acp-claude'
export const CODEX = 'acp-codex'
export const person = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

export function nativeWorld(t, { identity, hidden, managed = true, env } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-managed-native-'))
  const path = join(dir, 'trace.ndjson')
  const agents = new Map()
  const executed = []
  const tools = ['bash', 'read', 'list_bots'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
  const services = {
    tools: {
      definitions: () => tools,
      executable: name => tools.find(tool => tool.name === name),
      execute: async ({ calls: [call] }) => {
        executed.push(call.name)
        return { results: [{ callId: call.id, result: { content: [{ type: 'text', text: `ran ${call.name}` }] } }] }
      },
    },
    approval: { effectivePolicy: () => 'ask', request: async () => 'allowed-once' },
    sandboxPolicy: { defaultMode: 'workspace-write', resolve: ({ session }) => ({
      mode: session?.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write',
    }) },
    agentPresets: { presetForSession: () => 'standard' },
  }
  const ctx = {
    agents: { get: id => agents.get(id), turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: name => services[name],
    logger: { warn() {}, info() {} },
  }
  const catalog = { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} }
  const cli = provider => ({
    name: provider,
    catalog,
    installed: () => true,
    spawn: () => ({
      command: process.execPath,
      args: [join(import.meta.dirname, '../../dev/fake-agent.mjs')],
      env: { FAKE_ACP_TRACE: path, FAKE_ACP_SYSTEM_PROMPT: '1', FAKE_ACP_MODES: 'default,bypassPermissions', ...env },
    }),
  })
  const { hardAsk, disableBuiltInTools, modeFor } = AGENTS[CLAUDE]
  const claude = { ...cli(CLAUDE), hardAsk, disableBuiltInTools, modeFor }
  const codex = cli(CODEX)
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([[CLAUDE, claude], [CODEX, codex]]), {
    botIdentity: identity, teamManaged: () => managed, nativeTools: () => hidden, dshTools: () => undefined, backchannel,
  })
  t.after(() => {
    adapter.dispose()
    backchannel.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const events = event => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
    .filter(row => row.event === event)
  function chat(id) {
    const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false, cwd: dir })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const agent = { session, ctx: { tools: { register: () => () => {} } } }
    agents.set(id, agent)
    const history = []
    async function turn(message, provider = CLAUDE) {
      history.push(typeof message === 'string' ? person(`plain: ${message}`) : message)
      for (let step = 0; step < 4; step++) {
        const chunks = []
        for await (const chunk of adapter.stream(markAgentLoopRequest({ provider, model: 'default', sessionId: id, messages: [...history] }))) chunks.push(chunk)
        const content = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
        history.push({ role: 'assistant', source: { kind: 'model', provider, model: 'default' }, content })
        const calls = content.filter(block => block.type === 'tool-call')
        if (calls.length === 0) return chunks
        for (const call of calls) {
          const result = await adapter.tool.execute(JSON.parse(call.arguments), { agent, callId: call.id, signal: new AbortController().signal })
          history.push({ role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: [{ type: 'text', text: result.text }] })
        }
      }
      assert.fail('the fake agent did not finish its turn')
    }
    return { session, history, turn }
  }
  function assertToolset(index, expected) {
    const row = events('new-session')[index]
    assert.equal(row?.meta?.disableBuiltInTools, !expected)
    const list = events('mcp-list')[index]
    assert.ok(list?.tools.includes('list_bots'))
    assert.equal(list.tools.includes('bash'), !expected)
    assert.equal(list.tools.includes('read'), !expected)
  }
  return { adapter, backchannel, claude, services, chat, events, assertToolset, executed }
}
