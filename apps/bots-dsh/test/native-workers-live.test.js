// The cross-plugin wiring of Claude Code's native subagents (issue 1564): the live answer's
// `work.native` is acp-dsh's `acpAgents.nativeWorkers()` (by DSH Session), mapped onto the Bot
// that owns each Session (host native-workers.js), and a change reaches a poll that already
// holds the previous live key. The unit mapping is in native-workers.test.js; this pins that
// channel.js reads the registered service and puts the result where the sidebar looks.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = {
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Omni', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: { b: 'gb' } } },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start(t, acpAgents) {
  const home = mkdtempSync(join(tmpdir(), 'ds-native-workers-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext({ services: acpAgents === undefined ? {} : { acpAgents } })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async () => ({ agent: undefined }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  return { call }
}

const worker = (id, state, more = {}) => ({ id, title: `Worker ${id}`, state, steps: [{ id: `${id}-1`, title: 'Read a file', tool: 'Read', state }], ...more })

test("the live answer's work.native is acpAgents.nativeWorkers(), per Bot, and follows it", async (t) => {
  let bySession = {
    a: [worker('w1', 'running')],
    gb: [worker('w2', 'failed', { result: 'Stopped', stopped: true })],
    stray: [worker('w3', 'done')],
  }
  const reads = []
  const { call } = await start(t, { nativeWorkers: () => { reads.push(1); return bySession } })
  const first = (await call('state', {})).value
  assert.ok(reads.length > 0, 'the live answer reads the acpAgents service')
  // Omni's own chat, and Writer's group Session in Ops; a Session no Bot owns is left out.
  assert.deepEqual(first.work.native, {
    a: [{ id: 'w1', title: 'Worker w1', state: 'running', steps: [{ id: 'w1-1', title: 'Read a file', tool: 'Read', state: 'running' }] }],
    b: [{ id: 'w2', title: 'Worker w2', state: 'failed', result: 'Stopped', stopped: true, steps: [{ id: 'w2-1', title: 'Read a file', tool: 'Read', state: 'failed' }] }],
  })
  // The worker ends: a poll that holds the last live key gets the new fields, with no event.
  bySession = { a: [worker('w1', 'done', { result: 'All read' })] }
  const next = (await call('state', { since: first.revision, live: first.liveKey })).value
  assert.notEqual(next.liveKey, first.liveKey)
  assert.deepEqual(next.work.native, {
    a: [{ id: 'w1', title: 'Worker w1', state: 'done', result: 'All read', steps: [{ id: 'w1-1', title: 'Read a file', tool: 'Read', state: 'done' }] }],
  })
  // Nothing changed: the poll gets only its key back.
  const same = (await call('state', { since: next.revision, live: next.liveKey })).value
  assert.equal(same.unchanged, true)
  assert.equal(same.work, undefined)
})

test('with no acp-dsh, work.native is empty and the rest of the live answer stands', async (t) => {
  const { call } = await start(t, undefined)
  const answer = (await call('state', {})).value
  assert.deepEqual(answer.work.native, {})
  assert.ok(Array.isArray(answer.work.approvals))
})
