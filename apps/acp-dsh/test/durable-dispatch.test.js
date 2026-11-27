// No dispatch before durable (continuity.js writeSent) on DSH's real session store: the real
// agent loop, the real JSONL persistence and SessionStore.flush, over a route that CAN take its
// session back (the stdio fake agent, which resumes). The fake agent reads the chat's session
// files itself when the prompt arrives (FAKE_ACP_DISK_PROBE), so "on disk first" is what the
// peer saw, not what the host believes. A host with no persistence, or whose flush fails, sends
// no prompt at all.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { AcpAdapter } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { NATIVE_RECORD, latestNative } from '../src/host/continuity.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const ROUTE = 'acp-fake'
const SESSION = 'chat'

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-durable-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const trace = join(root, 'fake.ndjson')
  const events = () => (existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
  return { root, trace, sessions: join(root, 'sessions'), of: kind => events().filter(event => event.event === kind) }
}

/**
 * A DSH host on the session files under `w.sessions` (none: `persist: false`), serving a route
 * whose launches are qualified to take their session back (`continuity`), as index.js gives a
 * route whose exact tuple acp-qualify recorded. `flush` wraps the store's own SessionStore.flush.
 */
async function host(t, w, { persist = true, flush } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  if (persist) await ctx.plugin(Jsonl, { root: w.sessions, compression: 'none' })
  ctx.provide('approval', { effectivePolicy: () => 'ask', request: async () => 'allowed-once' })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  const catalog = { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} }
  const spec = {
    name: 'Fake agent', catalog, installed: () => true, disableBuiltInTools: true, continuity: { methods: ['resume'] },
    spawn: () => ({
      command: process.execPath, args: [FAKE], version: '1.0.0', key: `${FAKE} fake-cli 1.0.0`,
      env: {
        FAKE_ACP_TRACE: w.trace, FAKE_ACP_STATE: join(w.root, 'native-state.json'), FAKE_ACP_RESUME: '1', FAKE_ACP_DISK_PROBE: w.sessions,
        AUTOMAGIK_BOT_CLI_HOME: join(w.root, 'cli-home'), AUTOMAGIK_BOT_CLI_GENERATION: 'g1', AUTOMAGIK_BOT_CLI_VERSION: '',
      },
    }),
  }
  const logs = []
  await ctx.plugin({
    name: 'acp-dsh-durable-under-test',
    inject: ['llm', 'agents', 'sessions'],
    apply: (scoped) => {
      if (flush !== undefined) {
        const own = scoped.sessions.flush.bind(scoped.sessions)
        scoped.sessions.flush = session => flush(own, session)
      }
      const logged = new Proxy(scoped, { get: (target, key) => (key === 'logger' ? { warn: line => logs.push(line), info: line => logs.push(line) } : Reflect.get(target, key)) })
      const backchannel = new Backchannel({ ctx: scoped })
      const adapter = new AcpAdapter(logged, new Map([[ROUTE, spec]]), { dshTools: () => undefined, backchannel, redactor: text => text, accountBinding: () => 'account-a' })
      adapter.warn = line => logs.push(line)
      const off = scoped.llm.registerAdapter([ROUTE], adapter)
      scoped.effect(() => () => { off?.(); adapter.dispose(); backchannel.dispose() })
    },
  })
  await mountAgentLoopTestHarness(ctx)
  return { ctx, logs }
}

async function say(agent, words) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: words }] }))
  for (let i = 0; i < 100 && agent.status !== 'running' && agent.inbox.nextTurn.length > 0; i += 1) await delay(10)
  await agent.whenIdle()
}

const said = session => session.deriveMessages().filter(message => message.role === 'assistant')
  .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('')).join('\n')

test('the sent record is in the JSONL file before the agent gets the prompt, and a restart takes the session back', { timeout: 60_000 }, async (t) => {
  const w = world(t)
  const first = await host(t, w)
  const { agent } = await first.ctx.agentLoop.createAgent(first.ctx, { sessionId: SESSION, agentOptions: { provider: ROUTE, model: 'default' }, meta: { cwd: w.root } })
  await say(agent, 'native-remember m-77')
  const sent = latestNative(agent.session, ROUTE)
  assert.equal(sent?.state, 'idle', 'the prompt ended: its record is idle again')
  const [prompt] = w.of('prompt')
  assert.ok(prompt, first.logs.join('\n'))
  const nativeSessionId = w.of('new-session')[0].sessionId
  // What the agent found on disk as the prompt reached it: this prompt's own 'sent' record.
  assert.deepEqual(prompt.sentOnDisk.at(-1), { nativeSessionId, ordinal: 1, run: sent.run })
  await first.ctx.fiber.dispose()

  // The restart: a new host reads the chat back from the same JSONL file and resumes.
  const second = await host(t, w)
  const { agent: back } = await second.ctx.agentLoop.resume(second.ctx, { resumeSessionId: SESSION, agentOptions: { provider: ROUTE, model: 'default' } })
  assert.ok(back.session.snapshotEvents().some(event => event.type === NATIVE_RECORD && event.data.state === 'sent' && event.data.ordinal === 1), 'the sent record was read back')
  await say(back, 'native-recall')
  assert.match(said(back.session), /I remember: m-77/, second.logs.join('\n'))
  assert.equal(w.of('new-session').length, 1, 'no new native session after the restart')
  assert.deepEqual(w.of('resume-session').map(event => event.sessionId), [nativeSessionId])
  assert.equal(w.of('prompt').at(-1).text, 'native-recall', 'nothing replayed to the session that holds the chat')
})

for (const [cause, options, logged] of [
  ['no persistence is registered (flush resolves false)', { persist: false }, 'no persistence listener'],
  ['the store fails to save it', { flush: async (own, session) => { await own(session); throw new Error('disk full') } }, 'disk full'],
  ['the store answers nothing', { flush: async () => undefined }, 'no persistence listener'],
]) {
  test(`no prompt goes out when ${cause}`, { timeout: 60_000 }, async (t) => {
    const w = world(t)
    const h = await host(t, w, options)
    const { agent } = await h.ctx.agentLoop.createAgent(h.ctx, { sessionId: SESSION, agentOptions: { provider: ROUTE, model: 'default' }, meta: { cwd: w.root } })
    await say(agent, 'native-remember never-sent')
    assert.equal(w.of('prompt').length, 0, 'the agent got no prompt')
    assert.ok(w.of('new-session').length >= 1, 'the route did start: this is the dispatch refused, not a failed launch')
    assert.notEqual(latestNative(agent.session, ROUTE)?.state, 'sent', 'no sent record is left as the chat\'s truth')
    assert.ok(h.logs.some(line => line.includes(logged)), h.logs.join('\n'))
  })
}
