// The world continuity.test.js and plan-usage.test.js run in: the real adapter and bridge over
// the stdio fake agent, which keeps native context in a state file across processes.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from '../../src/host/adapter.js'
import { Backchannel } from '../../src/host/backchannel.js'
import { writeReceipt } from '../../scripts/acp-receipts.mjs'

const SDK = JSON.parse(readFileSync(new URL('../../node_modules/@agentclientprotocol/sdk/package.json', import.meta.url), 'utf8')).version
/** A synthetic receipt for the fake agent's route (acp-receipts.mjs), when ACP_RECEIPT_DIR is set. */
export const synthetic = phases => writeReceipt(process.env.ACP_RECEIPT_DIR, { route: 'acp-fake', scenario: 'synthetic-replay', sdk: SDK, platform: `${process.platform}-${process.arch}`, node: process.version, phases })

export const FAKE = join(import.meta.dirname, '..', '..', 'dev', 'fake-agent.mjs')
export const ROUTE = 'acp-fake'

// DSH gives every message an id (createMessage); a restart's rows keep it.
export const user = text => ({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
export const answer = text => ({ role: 'assistant', source: { kind: 'model', provider: ROUTE, model: 'm' }, content: [{ type: 'text', text }] })

// A Bot's own CLI home at a generation, and a connector build: what a real launch names
// (agents.js launchOf, cli-homes.js environment). Without them a start binds nothing.
export function fixture({ dir, env = {}, route = { methods: ['resume', 'load'] }, account = () => 'account-a', startMs, flush, home = () => ({ AUTOMAGIK_BOT_CLI_HOME: join(dir, 'cli-home'), AUTOMAGIK_BOT_CLI_GENERATION: 'g1', AUTOMAGIK_BOT_CLI_VERSION: '' }), connector = () => ({ version: '1.0.0', key: `${FAKE} fake-cli 1.0.0` }) }) {
  const trace = join(dir, 'fake.ndjson')
  const state = join(dir, 'native-state.json')
  const session = Session.create('s1', undefined, { version: 4, id: 's1', createdAt: 0, isSeeded: false, cwd: dir })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const tools = { names: ['bash', 'write'] }
  const counts = { approvals: 0, executed: 0 }
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (key) => {
      if (key === 'tools') {
        const definitions = () => tools.names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }))
        return {
          definitions, executable: n => definitions().find(d => d.name === n),
          execute: async ({ calls }) => {
            counts.executed += 1
            return { results: calls.map(call => ({ id: call.id, result: { content: [{ type: 'text', text: `ran ${call.name}` }] } })) }
          },
        }
      }
      if (key === 'approval') return { effectivePolicy: () => 'ask', request: async () => { counts.approvals += 1; return 'allowed-once' } }
      if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (key === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    logger: { warn: line => logs.push(`warn: ${line}`), info: line => logs.push(line) },
    // DSH's session store, when a test gives it a durability checkpoint (`flush`).
    ...(flush === undefined ? {} : { sessions: { get: id => (id === 's1' ? session : undefined), flush: target => flush(target) } }),
  }
  const logs = []
  const catalog = { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} }
  const spec = {
    name: 'Fake agent', catalog, installed: () => true, disableBuiltInTools: true,
    spawn: () => ({ command: process.execPath, args: [FAKE], ...connector(), env: { FAKE_ACP_TRACE: trace, FAKE_ACP_STATE: state, ...home(), ...env } }),
    ...(route === null ? {} : { continuity: route }),
    ...(startMs === undefined ? {} : { startMs }),
  }
  const backchannel = new Backchannel({ ctx })
  const make = () => new AcpAdapter(ctx, new Map([[ROUTE, spec]]), { dshTools: () => undefined, backchannel, redactor: text => text, accountBinding: () => account() })
  const h = { adapter: make(), spec, session, backchannel, trace, state, tools, counts, logs, messages: [] }
  h.restart = () => { h.adapter.dispose(); h.adapter = make() }
  h.close = () => { h.adapter.dispose(); backchannel.dispose() }
  return h
}

export async function turn(h, text) {
  h.messages.push(user(text))
  const chunks = []
  for await (const chunk of h.adapter.stream(markAgentLoopRequest({ provider: ROUTE, model: 'default', sessionId: 's1', messages: h.messages }))) chunks.push(chunk)
  const said = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  h.messages.push(answer(said))
  return { chunks, said, finish: chunks.at(-1) }
}

/**
 * One request as DSH's loop makes it after `rows` (the person's messages) with no answer written
 * after them, the way an interrupted turn leaves the chat: the next request carries them again.
 */
export async function send(h, ...texts) {
  h.messages.push(...texts.map(user))
  const chunks = []
  for await (const chunk of h.adapter.stream(markAgentLoopRequest({ provider: ROUTE, model: 'default', sessionId: 's1', messages: h.messages }))) chunks.push(chunk)
  return { chunks, said: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), finish: chunks.at(-1) }
}

export const events = path => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
export const of = (h, kind) => events(h.trace).filter(event => event.event === kind)

export async function withFixture(name, options, body) {
  const dir = mkdtempSync(join(tmpdir(), `acp-continuity-${name}-`))
  const h = fixture({ dir, ...options })
  try { await body(h) } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

