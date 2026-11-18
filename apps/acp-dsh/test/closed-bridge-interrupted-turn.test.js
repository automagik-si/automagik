// Two ends of an agent's session the adapter did not notice (#969, lifecycle review 6 and 8).
//
// - A turn that is not continued while the agent is still on its prompt. DSH can start a step
//   whose last message is a tool result that is not this agent's (the app restarted in the
//   middle, another result came last). The adapter then says the agent "was interrupted" and
//   ends the step, but the agent's prompt went on, unseen, until the person's next message.
//   It is now asked to stop then and there, and ended if it will not.
// - A bridge that closed. When the bridge process ends it says so and its credential is
//   revoked; the agent on that session has lost DSH's tools for good. The next turn used to go
//   on with it, without them. It now ends that session and starts a new one.
//
// The real adapter and Backchannel, and the fake agent over stdio, as adapter.test.js.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { TOOL_NAME } from '../src/host/tool.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const traceEvents = path => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')

// Wait for a condition, looked at until it holds, for at most 20 s (another process is on the
// way, so no count of event-loop turns would do).
async function until(check, what) {
  const deadline = Date.now() + 20_000
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(check(), what)
}

// The adapter's clock, moved by the row: the time a cancel gets passes when the row says so.
function clock() {
  let now = 0
  let made = 0
  const waiting = new Map()
  return {
    setTimeout(fn, ms) { const timer = { id: ++made, at: now + ms, fn, unref: () => timer }; waiting.set(timer.id, timer); return timer },
    clearTimeout(timer) { if (timer !== undefined) waiting.delete(timer.id) },
    tick(ms) {
      now += ms
      for (const timer of [...waiting.values()].filter(entry => entry.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)) if (waiting.delete(timer.id)) timer.fn()
    },
  }
}
const CANCEL_WAIT_MS = 5000

// One Session on the fake agent. `bridge`: DSH's tools over the bridge (else the mirror tool).
function host(t, { bridge = false, env = {}, hostStopping = () => false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-969-'))
  const trace = join(dir, 'trace.ndjson')
  const session = Session.create('s1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const definitions = [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: {} } }]
  const executed = []
  const warned = []
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (name) => {
      if (name === 'tools') {
        return {
          definitions: () => [...definitions, { name: TOOL_NAME, description: 'mirror', parameters: { type: 'object' } }],
          executable: toolName => definitions.find(definition => definition.name === toolName),
          execute: async ({ calls }) => {
            executed.push(calls[0].name)
            return { results: [{ callId: calls[0].id, result: { content: [{ type: 'text', text: `ran ${calls[0].name}` }], isError: false } }] }
          },
        }
      }
      if (name === 'approval') return { effectivePolicy: () => 'ask', request: async () => 'allowed-once' }
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (name === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    logger: { warn: message => warned.push(message), info: () => {} },
  }
  const spec = {
    name: 'Fake agent',
    catalog: { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_TRACE: trace, ...env } }),
  }
  const timers = clock()
  const backchannel = new Backchannel({ ctx })
  const adapter = new AcpAdapter(ctx, new Map([['acp-fake', spec]]), { dshTools: () => bridge, backchannel, cancelWaitMs: CANCEL_WAIT_MS, timers, hostStopping })
  let closed = false
  const close = () => { if (closed) return; closed = true; try { adapter.dispose() } finally { backchannel.dispose() } }
  t.after(() => { close(); rmSync(dir, { recursive: true, force: true }) })
  // One step, read to its end; a step that has not ended after 30 s fails the row and ends the
  // agent, so a regression is a failure and never a hung file.
  const step = async (messages) => {
    const chunks = []
    let giveUp
    const late = new Promise((_, fail) => { giveUp = setTimeout(() => { close(); fail(new Error('the step did not end within 30 s')) }, 30_000) })
    const reading = (async () => {
      for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'acp-fake', model: 'default', sessionId: 's1', messages }))) chunks.push(chunk)
      return chunks
    })()
    try { return await Promise.race([reading, late]) } finally { clearTimeout(giveUp) }
  }
  return { adapter, backchannel, executed, warned, step, tick: ms => timers.tick(ms), live: () => adapter.live.get('s1'), events: () => traceEvents(trace) }
}

const said = text => ({ role: 'assistant', source: { kind: 'model', provider: 'acp-fake', model: 'default' }, content: [{ type: 'text', text }] })
// A tool result that is not the answer to one of the agent's own calls.
const strangerResult = { role: 'tool', toolCallId: 'someone-elses-call', toolName: 'bash', content: [{ type: 'text', text: 'ran' }], isError: false }
const INTERRUPTED = /Fake agent was interrupted before it finished, so it is not answering this turn any more\./

test('#969: a turn that is not continued asks the agent to stop, and ends it when it does not', async (t) => {
  const h = host(t)
  // A step that ends on the agent's own tool call: its prompt is open, waiting on its question.
  const first = await h.step([user('run something')])
  assert.equal(first.at(-1).reason.kind, 'tool-calls')
  const call = first.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block
  const live = h.live()
  assert.equal(live.run.busy, true)
  const chunks = await h.step([user('run something'), { role: 'assistant', source: { kind: 'model', provider: 'acp-fake', model: 'default' }, content: [call] }, strangerResult])
  assert.match(textIn(chunks), INTERRUPTED)
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // The agent was told, once. This one cannot stop: it waits on a question nobody will answer.
  await until(() => h.events().some(event => event.event === 'cancel'), 'the agent was asked to stop')
  assert.equal(h.events().filter(event => event.event === 'cancel').length, 1)
  // Not before the time a cancel gets is over; then its session is ended.
  h.tick(CANCEL_WAIT_MS - 1)
  assert.equal(h.live(), live)
  assert.equal(live.run.alive, true)
  h.tick(1)
  assert.equal(h.live(), undefined)
  assert.equal(live.run.alive, false)
  assert.ok(h.warned.some(line => /did not stop its answer within/.test(line)))
  // Nothing of that run is left asking.
  assert.deepEqual([...live.run.tools.values()].filter(tool => tool.permission !== undefined), [])
})

test('#969: a turn that is not continued with no agent on a prompt asks nothing', async (t) => {
  const h = host(t)
  // A whole turn first, so a session exists and is idle.
  assert.equal((await h.step([user('plain words')])).at(-1).reason.kind, 'stop')
  assert.equal(h.live().run.busy, false)
  const chunks = await h.step([user('plain words'), said('x'), strangerResult])
  assert.match(textIn(chunks), INTERRUPTED)
  h.tick(CANCEL_WAIT_MS * 2)
  assert.equal(h.events().filter(event => event.event === 'cancel').length, 0)
  assert.ok(h.live() !== undefined, 'the idle session stays')
  // With no session at all (the app restarted in the middle), the same words and nothing else.
  const fresh = host(t)
  const alone = await fresh.step([user('x'), strangerResult])
  assert.match(textIn(alone), INTERRUPTED)
  assert.equal(fresh.events().length, 0, 'no agent was started')
})

test('#969: a turn that finds its bridge closed starts a new session, with DSH\'s tools and the chat so far', async (t) => {
  const h = host(t, { bridge: true })
  const opening = 'The word to remember is walnut. bridge bash'
  const first = await h.step([user(opening)])
  assert.equal(first.at(-1).reason.kind, 'stop')
  assert.deepEqual(h.executed, ['bash'])
  const before = h.live()
  // The bridge process ended and said so: its credential is revoked (the `bye` of bridge.js).
  h.backchannel.revoke(before.bridge)
  assert.equal(before.bridge.closed, true)
  const second = await h.step([user(opening), said('done'), user('bridge bash')])
  assert.equal(second.at(-1).reason.kind, 'stop', JSON.stringify(second.at(-1)))
  // A new agent process and session (each process numbers its sessions from one), with a
  // bridge of its own that listed its tools, and the tool ran through it.
  assert.equal(h.events().filter(event => event.event === 'start').length, 2, 'a new agent process')
  assert.equal(h.events().filter(event => event.event === 'new-session').length, 2)
  const after = h.live()
  assert.notEqual(after, before)
  assert.equal(after.bridge.closed, false)
  assert.notEqual(after.bridge, before.bridge)
  assert.equal(before.run.alive, false, 'the session that lost its bridge is over')
  assert.equal(h.events().filter(event => event.event === 'mcp-list' && event.server === 'dsh').length, 2, "the new session's bridge listed")
  assert.deepEqual(h.executed, ['bash', 'bash'])
  assert.match(textIn(second), /The bridge said: ran bash/)
  // The chat came with it: what the new session was sent holds the turn before it.
  const prompts = h.events().filter(event => event.event === 'prompt')
  assert.equal(prompts.length, 2)
  assert.match(prompts[1].text, /walnut/, 'the earlier turn was replayed to the new session')
  assert.equal(h.warned.filter(line => /lost its dsh bridge/i.test(line)).length, 1)
})

test('#969: a bridge that is open leaves the session as it is', async (t) => {
  const h = host(t, { bridge: true })
  await h.step([user('bridge bash')])
  const before = h.live()
  const second = await h.step([user('bridge bash'), said('done'), user('bridge bash')])
  assert.equal(second.at(-1).reason.kind, 'stop')
  assert.equal(h.live(), before, 'the same session')
  assert.equal(h.events().filter(event => event.event === 'new-session').length, 1)
  const prompts = h.events().filter(event => event.event === 'prompt')
  assert.doesNotMatch(prompts[1].text, /Fake agent, turn|done/, 'nothing is replayed to a session that has the chat')
  assert.deepEqual(h.warned.filter(line => /lost its/.test(line)), [])
})

// #1575: a prompt the host stopped from outside the app (its process got SIGTERM with the
// host) ends as an interruption, not as the person's Stop. bots-dsh reads the code by name to
// resume the task instead of marking it failed, so the exact code is the contract.
test('#1575: a prompt cancelled from outside the app ends as interrupted, not as a Stop', async (t) => {
  // The host's SIGTERM reached the agent as it stopped: the app did not ask for this cancel.
  const h = host(t, { hostStopping: () => true })
  const reading = h.step([user('hang')])
  await until(() => h.live()?.run?.prompting !== undefined, 'the prompt to be in flight')
  // The agent is asked to cancel on the wire, as a CLI that took its host's SIGTERM does; the
  // adapter did not ask for this cancel.
  await h.live().run.conn.cancel({ sessionId: h.live().run.sessionId })
  const chunks = await reading
  assert.deepEqual(chunks.at(-1).reason, {
    kind: 'error',
    failure: {
      message: 'Fake agent was interrupted before it finished.',
      code: 'AGENT_INTERRUPTED',
    },
  })
})
