import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { install as installModels } from '../src/host/models.js'
import { install as installModelState } from '../src/host/model-state.js'
import { RemoteChatAdapter } from '../src/host/remote-chat-adapter.js'

// THE RULE: a chat already on a Remote Hermes route never takes the in-place model switch
// to the attach row, whatever came before. The decision reads the chat's ACTUAL route: the
// live Session's request header, or, for an unloaded chat, the last request/header in its
// stored log. Every blocking row runs on DSH's real JSONL Session store: a real turn is
// written, the store is closed, a fresh store is opened, the chat is unloaded, and the
// apply is forced. A test's own header is never the source.
const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default
const ATTACH = 'hermes-remote/attach'
const OLD = 'hermes-remote/nous:openai/gpt-6-astra'
const ADDRESS = 'hermes-remote/sample:model-a'
const DEEPSEEK = { provider: 'deepseek', model: 'saved' }
const CARRIED = { provider: 'hermes-remote', model: 'nous:openai/gpt-6-astra' }
const ROW = Object.freeze({ id: 'attach', name: 'gpt-6-astra (openai-codex)', provider: 'hermes-remote', model: 'gpt-6-astra', providerId: 'openai-codex', contextWindow: 200_000 })
const MESSAGES = Object.freeze(Array.from({ length: 400 }, (_, index) => Object.freeze({ role: 'user', id: `m-${index}`, content: `message ${index}` })))

async function realStore(root) {
  const host = new Context()
  await host.plugin(Storage)
  await host.plugin(StorageJson, { root: join(root, 'storage') })
  await host.plugin(StorageDomain, { backend: 'json' })
  await host.plugin(SessionPersistence, { root: join(root, 'sessions') })
  return host
}

// A real turn: start, its request header, the person's messages, and its end. The shape is
// the v4 format the JSONL store validates, so a reopen reads it exactly as the app does.
function turnEvents({ turn = 1, route = CARRIED, messages = 400, end = { kind: 'stop' }, base = 0, time = 1 } = {}) {
  const events = [{ type: 'turn/start', seq: base, time, data: { turn } }]
  let seq = base + 1, at = time + 1
  if (route !== undefined) {
    events.push({ type: 'request/header', seq, time: at, data: { header: { config: route } } })
    seq += 1; at += 1
  }
  for (let index = 0; index < messages; index += 1) {
    events.push({
      type: 'user/message', seq, time: at, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: `message ${index}` }], role: 'user', id: `m-${index}`, source: { kind: 'user' } },
    })
    seq += 1; at += 1
  }
  events.push({ type: 'turn/end', seq, time: at, data: { turn, reason: end } })
  return events
}

async function writeSession(host, id, events) {
  const handle = await host.sessionPersistence.create({ version: 4, id, createdAt: 1, isSeeded: false })
  await handle.append(events)
  await handle.flush()
  await handle.close()
}

// A team-made store that existed before the attach: written, closed, and reopened fresh.
// `sessions` maps a Session id to its list of turns ({ route, messages, end }).
async function storedTeam(t, sessions) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-carried-rule-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let host = await realStore(root)
  for (const [id, turns] of Object.entries(sessions)) {
    let base = 0, time = 1
    const events = []
    for (const [index, turn] of turns.entries()) {
      const written = turnEvents({ turn: index + 1, base, time, ...turn })
      events.push(...written)
      base = written.at(-1).seq + 1; time = written.at(-1).time + 1
    }
    await writeSession(host, id, events)
  }
  await host.fiber.dispose()
  host = await realStore(root)
  t.after(() => host.fiber.dispose())
  return host
}

function runtime(host, { bots, groups = {}, chats = {} }) {
  const listeners = new Map()
  const selected = []
  const ctx = {
    sessionPersistence: host.sessionPersistence,
    sessions: { get: () => undefined, list: () => [] },
    on(name, listener) { listeners.set(name, listener); return () => {} },
    get: () => undefined,
    llm: {
      listProviders: () => [{ id: 'hermes-remote', name: 'Remote Hermes' }, { id: 'deepseek', name: 'DeepSeek' }],
      listModels: async provider => provider === 'hermes-remote' ? [ROW] : [{ id: 'saved' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 200_000 }, defaultMaxTokens: 8000 }),
    },
    sessionController: { selectModel: async ({ sessionId, provider, model }) => { selected.push(`${sessionId}:${provider}/${model}`) } },
  }
  const rt = {
    ctx, state: { bots }, chatOf: id => chats[id] ?? id, groupSessionsOf: id => groups[id] ?? [],
    chatOwners: new Map(Object.keys(bots).map(id => [id, id])),
    botOf: id => bots[id], awaitingFirstAnswer: () => false, save: async () => {}, warn() {},
  }
  installModels(rt)
  installModelState(rt)
  const event = (sessionId, type, data) => listeners.get('session/event')?.({ id: sessionId }, { type, data, time: 1 })
  const answer = (sessionId) => event(sessionId, 'assistant/message', { message: { source: CARRIED } })
  const failed = (sessionId) => event(sessionId, 'turn/end', { reason: { kind: 'error', error: { code: 'REMOTE_HERMES', message: 'Remote Hermes reported a turn failure.' } } })
  const accepted = (sessionId, config = CARRIED) => {
    const agent = { id: sessionId, session: { requestHeader: () => ({ config }), deriveMessages: () => MESSAGES } }
    return RemoteChatAdapter.ownTurn(Object.freeze({ provider: config.provider, model: config.model, sessionId, messages: MESSAGES }), agent)
  }
  return { rt, selected, answer, failed, accepted }
}

const carries = (overrides = {}) => ({ id: 'b1', name: 'Sample Bot', model: ATTACH, appliedModel: ATTACH, previousModel: OLD, ...overrides })

function assertConfirmed(rt, bot) {
  const view = rt.modelStateView()[bot.id]
  assert.equal(view.answered, true, 'the row ends in an answer')
  assert.equal(view.pending, false, 'the pick confirms')
  assert.equal(view.lastAnswer.ref, ATTACH, 'the answer counts for the attach pick')
  assert.equal(bot.model, ATTACH, 'F1: the Bot stays on the attach row')
  assert.equal(bot.previousModel, ATTACH, 'F1: the answer names the running row')
}

const ROWS = [
  {
    name: 'Chat 1: first turn after the update',
    sessions: { b1: [{ route: CARRIED }] },
    async run({ rt, selected, accepted }) {
      const bot = rt.state.bots.b1
      await rt.applyModel(bot)
      assert.deepEqual(selected, [])
      assert.equal(accepted('b1'), true, 'the 400-message turn is the Session own turn')
    },
  },
  {
    name: 'Chat 2: second turn',
    sessions: { b1: [{ route: CARRIED }] },
    async run({ rt, selected }) {
      const bot = rt.state.bots.b1
      await rt.applyModel(bot)
      await rt.applyModel(bot)
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Chat 3: unload/reload',
    sessions: { b1: [{ route: CARRIED }] },
    bot: { previousModel: ATTACH },
    async run({ rt, selected, answer }) {
      const bot = rt.state.bots.b1
      answer('b1')
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Chat 4 / Tester 2: app restart then a forced apply before the chat opens',
    sessions: { b1: [{ route: CARRIED }] },
    bot: { previousModel: ATTACH },
    async run({ rt, selected }) {
      const bot = rt.state.bots.b1
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Chat 5: a pick of another Bot',
    sessions: { b1: [{ route: CARRIED }] },
    async run({ rt, selected }) {
      rt.state.bots.b2 = { id: 'b2', name: 'Other', model: 'deepseek/saved' }
      await rt.applyModel(rt.state.bots.b1)
      await rt.applyModel(rt.state.bots.b2, { force: true })
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected.filter(entry => entry.startsWith('b1:')), [])
    },
  },
  {
    name: 'Chat 6: after a failed turn',
    sessions: { b1: [{ route: CARRIED }] },
    async run({ rt, selected, failed }) {
      const bot = rt.state.bots.b1
      failed('b1')
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 1: earlier part and back',
    sessions: { 'part-0': [{ route: CARRIED }], b1: [{ route: CARRIED }] },
    chats: { b1: 'part-0' },
    async run({ rt, selected, answer }) {
      rt.chatOwners.set('part-0', 'b1')
      const bot = rt.state.bots.b1
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, [])
      answer('part-0')
      rt.chatOf = id => id
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 3: effort-only change on attach',
    sessions: { b1: [{ route: CARRIED }] },
    bot: { effort: 'high', appliedEffort: 'low' },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1)
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 4: group room with an unloaded Session',
    sessions: { b1: [{ route: CARRIED }], room: [{ route: CARRIED }] },
    groups: { b1: ['room'] },
    bot: { previousModel: ATTACH },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 5: refused restore and another Bot on the same serve',
    sessions: { b1: [{ route: CARRIED }], b2: [{ route: CARRIED }] },
    bots: { b2: { id: 'b2', name: 'Second', model: ATTACH, appliedModel: ATTACH, previousModel: OLD } },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      await rt.applyModel(rt.state.bots.b2, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 6: part roll-over, the new part takes the attach row',
    sessions: { b1: [{ route: CARRIED }] },
    chats: { b1: 'part-2' },
    async run({ rt, selected, accepted }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected, ['part-2:hermes-remote/attach'])
      assert.equal(accepted('part-2', { provider: 'hermes-remote', model: 'attach' }), true)
    },
  },
  {
    name: 'Tester 7: stopped answer, then unload and a forced apply',
    sessions: { b1: [{ route: CARRIED, end: { kind: 'aborted' }, messages: 2 }, { route: undefined, end: { kind: 'aborted' }, messages: 0 }] },
    bot: { previousModel: ATTACH },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 8: detach and re-attach',
    sessions: { b1: [{ route: CARRIED }] },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Tester 9: two carried Bots on the same attach serve',
    sessions: { b1: [{ route: CARRIED }], b2: [{ route: CARRIED }] },
    bots: { b2: { id: 'b2', name: 'Second', model: ATTACH, appliedModel: ATTACH, previousModel: OLD } },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      await rt.applyModel(rt.state.bots.b2, { force: true })
      assert.deepEqual(selected, [])
    },
  },
  {
    name: 'Control: another provider still takes the attach row',
    sessions: { b1: [{ route: DEEPSEEK }] },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected, ['b1:hermes-remote/attach'])
    },
  },
  {
    name: 'Control: moving the Bot off Hermes and back is a real switch by design',
    sessions: { b1: [{ route: DEEPSEEK }] },
    async run({ rt, selected }) {
      const bot = rt.state.bots.b1
      bot.model = 'deepseek/saved'
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, ['b1:deepseek/saved'])
      selected.length = 0
      bot.model = ATTACH
      await rt.applyModel(bot, { force: true })
      assert.deepEqual(selected, ['b1:hermes-remote/attach'])
    },
  },
  {
    name: 'Control n5: a Hermes request first and another provider last still takes attach',
    sessions: { b1: [{ route: CARRIED, messages: 2 }, { route: DEEPSEEK, messages: 1 }] },
    async run({ rt, selected }) {
      await rt.applyModel(rt.state.bots.b1, { force: true })
      assert.deepEqual(selected, ['b1:hermes-remote/attach'], 'the LAST stored request decides, not the first')
    },
  },
]

test('a new part that picked another provider then picked attach back takes attach', async t => {
  // The old part is a real attached Hermes chat and has answered on the attach row. The
  // person picks another provider, starts a new part, then picks Remote Hermes back before
  // typing. The new part is live with another provider's selection but no request yet: the
  // pick must be applied, not skipped by any last-answer fallback from the old part.
  const host = await storedTeam(t, { b1: [{ route: CARRIED }] })
  const bot = carries({ previousModel: ATTACH })
  const bench = runtime(host, { bots: { b1: bot }, chats: { b1: 'part-2' } })
  bench.rt.chatOwners.set('part-2', 'b1')
  bench.answer('b1')
  bench.rt.ctx.sessions = {
    get: id => (id === 'part-2' ? { requestHeader: () => undefined } : undefined),
    list: () => [],
  }
  await bench.rt.applyModel(bot, { force: true })
  assert.deepEqual(bench.selected, ['part-2:hermes-remote/attach'])
  // The new part's first request is the attach row, and the guard accepts it.
  assert.equal(bench.accepted('part-2', { provider: 'hermes-remote', model: 'attach' }), true)
})

for (const row of ROWS) {
  test(row.name, async t => {
    const host = await storedTeam(t, row.sessions)
    const bots = { b1: carries(row.bot) }
    Object.assign(bots, row.bots ?? {})
    const bench = runtime(host, { bots, groups: row.groups, chats: row.chats })
    await row.run(bench)
    if (!row.name.startsWith('Control') && row.name !== 'Tester 6: part roll-over, the new part takes the attach row') {
      bench.answer('b1')
      assertConfirmed(bench.rt, bench.rt.state.bots.b1)
    }
  })
}
