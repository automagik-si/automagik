import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { inject as BOTS_INJECT } from '../index.js'
import { install as installModels } from '../src/host/models.js'

const SessionPersistence = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default
const ATTACH = 'hermes-remote/attach'
const CARRIED = { provider: 'hermes-remote', model: 'sample-carried-model' }
const DEEPSEEK = { provider: 'deepseek', model: 'sample-model' }
const ROW = { id: 'attach', name: 'Sample model', provider: 'hermes-remote', model: 'sample-model', contextWindow: 200_000 }

async function realStore(root) {
  const host = new Context()
  await host.plugin(Storage)
  await host.plugin(StorageJson, { root: join(root, 'storage') })
  await host.plugin(StorageDomain, { backend: 'json' })
  // Plaintext is a real supported encoding and lets the fixture damage an event row.
  await host.plugin(SessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  return host
}

function turnEvents(route) {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'request/header', seq: 1, time: 2, data: { header: { config: route } } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'sample message' }], role: 'user', id: 'm-0', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'stop' } } },
  ]
}

async function writeSession(host, id, route) {
  const handle = await host.get('sessionPersistence').create({ version: 4, id, createdAt: 1, isSeeded: false })
  try {
    await handle.append(turnEvents(route))
    await handle.flush()
  } finally {
    await handle.close()
  }
}

function logFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? logFiles(path) : entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  })
}

function damageSession(root, id) {
  // Discover the actual file by its stored Session header, without assuming the layout.
  const matches = logFiles(root).filter(path => JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).id === id)
  assert.equal(matches.length, 1, `one stored log for ${id}`)
  const lines = readFileSync(matches[0], 'utf8').split('\n')
  assert.equal(lines.at(-1), '', 'the log ends with a committed newline')
  const index = lines.findIndex(line => line && JSON.parse(line).type === 'request/header')
  assert.ok(index > 0, 'damage an event, preserving the Session header')
  assert.ok(lines.slice(index + 1).some(line => line && JSON.parse(line).type === 'turn/end'), 'the damaged event belongs to a completed turn')
  lines[index] = '{damaged committed event'
  writeFileSync(matches[0], lines.join('\n'))
}

async function storedTeam(t, routes, damaged = []) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-carried-followups-'))
  let host
  t.after(async () => {
    try { await host?.fiber.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  host = await realStore(root)
  for (const [id, route] of Object.entries(routes)) await writeSession(host, id, route)
  await host.fiber.dispose()
  for (const id of damaged) damageSession(join(root, 'sessions'), id)
  host = await realStore(root)
  for (const id of damaged) {
    // Prove that this is an existing, corrupt log rather than a missing/fresh Session.
    await assert.rejects(async () => {
      let handle
      try {
        handle = await host.get('sessionPersistence').open(id, 'read')
        await handle.read()
      } finally {
        await handle?.close()
      }
    }, error => error?.name === 'SessionPersistenceCorruptionError' && /committed event/.test(error.message))
  }
  return host
}

async function runtime(host, { model = ATTACH, groups = [] } = {}) {
  const selected = []
  const bot = { id: 'b1', name: 'Sample Bot', model, appliedModel: model }
  const services = {
    sessions: { get: () => undefined, list: () => [] },
    llm: {
      listProviders: () => [{ id: 'hermes-remote', name: 'Remote Hermes' }, { id: 'deepseek', name: 'DeepSeek' }],
      listModels: async provider => provider === 'hermes-remote' ? [ROW] : [{ id: 'sample-model' }],
      resolveModelInfo: async () => ({ context: { contextWindow: 200_000 }, defaultMaxTokens: 8000 }),
    },
    sessionController: { selectModel: async ({ sessionId, provider, model }) => { selected.push(`${sessionId}:${provider}/${model}`) } },
    tools: {}, systemPrompt: {}, sessionTitle: {}, workspaceRegistry: {}, connection: {},
  }
  for (const name of BOTS_INJECT) { host.provide(name); host.set(name, services[name]) }
  let rt
  // The real store and this consumer are sibling plugins. Use the production inject list;
  // sessionPersistence must remain accessible through ctx.get without an added injection.
  await host.plugin({
    name: 'bots-dsh-carried-followups-probe', inject: BOTS_INJECT,
    apply: ctx => {
      rt = { ctx, state: { bots: { b1: bot } }, chatOf: id => id, groupSessionsOf: () => groups, save: async () => {}, warn() {} }
      installModels(rt)
    },
  })
  assert.ok(rt, 'the probe plugin applied')
  return { rt, bot, selected }
}

function countOpens(t, rt) {
  const store = rt.ctx.get('sessionPersistence')
  const original = store.open
  const opened = []
  store.open = function (...args) {
    opened.push(args[0])
    return original.apply(this, args)
  }
  t.after(() => { store.open = original })
  return opened
}

test('1: forced attach resolves without selecting an unloaded chat with a damaged committed log', async t => {
  const host = await storedTeam(t, { b1: CARRIED }, ['b1'])
  const { rt, bot, selected } = await runtime(host)
  const opened = countOpens(t, rt)
  await assert.doesNotReject(() => rt.applyModel(bot, { force: true }))
  assert.deepEqual(opened, ['b1'])
  assert.deepEqual(selected, [])
})

test('2: forced attach skips a damaged group log and selects the readable DeepSeek own chat', async t => {
  const host = await storedTeam(t, { b1: DEEPSEEK, 'group-1': CARRIED }, ['group-1'])
  const { rt, bot, selected } = await runtime(host, { groups: ['group-1'] })
  const opened = countOpens(t, rt)
  await assert.doesNotReject(() => rt.applyModel(bot, { force: true }))
  assert.deepEqual(opened, ['b1', 'group-1'])
  assert.deepEqual(selected, ['b1:hermes-remote/attach'])
})

test('3: a missing log takes attach as a fresh part and is not memoised', async t => {
  const host = await storedTeam(t, {})
  const { rt, bot, selected } = await runtime(host)
  const opened = countOpens(t, rt)
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(selected, ['b1:hermes-remote/attach'])
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1', 'b1'])
  assert.deepEqual(selected, ['b1:hermes-remote/attach', 'b1:hermes-remote/attach'])
})

test('4a: a readable DeepSeek log selects attach', async t => {
  const host = await storedTeam(t, { b1: DEEPSEEK })
  const { rt, bot, selected } = await runtime(host)
  const opened = countOpens(t, rt)
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1'])
  assert.deepEqual(selected, ['b1:hermes-remote/attach'])
})

test('4b: a non-attach ref selects DeepSeek for own and group chats without opening any log', async t => {
  const host = await storedTeam(t, { b1: CARRIED, 'group-1': CARRIED })
  const { rt, bot, selected } = await runtime(host, { model: 'deepseek/sample-model', groups: ['group-1'] })
  const opened = countOpens(t, rt)
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, [])
  assert.deepEqual(selected, ['b1:deepseek/sample-model', 'group-1:deepseek/sample-model'])
})

test('5a: forced applies reuse the stored Hermes route until a live request header changes it', async t => {
  const host = await storedTeam(t, { b1: CARRIED })
  const { rt, bot, selected } = await runtime(host)
  const opened = countOpens(t, rt)
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1'])
  assert.deepEqual(selected, [])
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1'])
  assert.deepEqual(selected, [])
  host.emit('session/event', { id: 'b1' }, { type: 'request/header', time: 5, data: { header: { config: DEEPSEEK } } })
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1'], 'the live header updates the memo without reopening the log')
  assert.deepEqual(selected, ['b1:hermes-remote/attach'])
})

test('5b: concurrent forced applies share one in-flight stored-route read and never select', async t => {
  const host = await storedTeam(t, { b1: CARRIED })
  const { rt, bot, selected } = await runtime(host)
  const opened = countOpens(t, rt)
  await Promise.all([rt.applyModel(bot, { force: true }), rt.applyModel(bot, { force: true })])
  assert.deepEqual(opened, ['b1'])
  assert.deepEqual(selected, [])
})

test('5c: a damaged log is retried on every forced apply and never selects attach', async t => {
  const host = await storedTeam(t, { b1: CARRIED }, ['b1'])
  const { rt, bot, selected } = await runtime(host)
  const opened = countOpens(t, rt)
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1'])
  assert.deepEqual(selected, [])
  await rt.applyModel(bot, { force: true })
  assert.deepEqual(opened, ['b1', 'b1'])
  assert.deepEqual(selected, [])
})

test('6: a non-forced apply skips an already applied group selection before opening its log', async t => {
  const host = await storedTeam(t, { b1: DEEPSEEK, 'group-1': DEEPSEEK })
  const { rt, bot, selected } = await runtime(host, { groups: ['group-1'] })
  const opened = countOpens(t, rt)
  // Seed the real selection bookkeeping without warming the stored-route memo. Selecting
  // a model precedes its next request/header, so its stored header can still be DeepSeek.
  await rt.selectSessionModel('group-1', { provider: 'hermes-remote', model: 'attach' })
  assert.deepEqual(selected, ['group-1:hermes-remote/attach'])
  assert.deepEqual(opened, [])
  selected.length = 0
  await rt.applyModel(bot)
  assert.deepEqual(opened, [], 'neither the unchanged own chat nor the already applied group needs a route read')
  assert.deepEqual(selected, [])
})
