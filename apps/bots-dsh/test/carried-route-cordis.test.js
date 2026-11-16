// Tester 2, PR 1357 final: models.js inside a REAL cordis plugin context that declares exactly
// bots-dsh's own `inject` list (index.js), with DSH's real JSONL store loaded as its own plugin
// (as DSH's app loads it). Fakes for llm/sessionController; made-up values only.
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
import { inject as BOTS_INJECT } from '../index.js'
import { install as installModels } from '../src/host/models.js'

const SP = typeof Jsonl.apply === 'function' ? Jsonl : Jsonl.default
const ROW = { id: 'attach', name: 'zz-sample-7 (nous)', provider: 'hermes-remote', model: 'zz-sample-7', contextWindow: 200_000 }

async function bench(t, { route, live }) {
  const root = mkdtempSync(join(tmpdir(), 'tester2-cordis-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = new Context()
  await host.plugin(Storage); await host.plugin(StorageJson, { root: join(root, 'storage') }); await host.plugin(StorageDomain, { backend: 'json' }); await host.plugin(SP, { root: join(root, 'sessions') })
  t.after(() => host.fiber.dispose())
  const handle = await host.sessionPersistence.create({ version: 4, id: 'b1', createdAt: 1, isSeeded: false })
  await handle.append([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'request/header', seq: 1, time: 2, data: { header: { config: route } } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'hello' }], role: 'user', id: 'm-0', source: { kind: 'user' } } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'stop' } } },
  ])
  await handle.flush(); await handle.close()
  const selected = []
  const services = {
    llm: { listProviders: () => [{ id: 'hermes-remote', name: 'Remote Hermes' }, { id: 'deepseek', name: 'DeepSeek' }], listModels: async provider => provider === 'hermes-remote' ? [ROW] : [{ id: 'v4' }], resolveModelInfo: async () => ({ context: { contextWindow: 200_000 } }) },
    sessions: { get: id => live?.[id], list: () => [] },
    sessionController: { selectModel: async ({ sessionId, provider, model }) => { selected.push(`${sessionId}:${provider}/${model}`) } },
    tools: {}, systemPrompt: {}, sessionTitle: {}, workspaceRegistry: {}, connection: {},
  }
  for (const name of BOTS_INJECT) { host.provide(name); host.set(name, services[name]) }
  let rt
  await host.plugin({ name: 'bots-dsh-inject-probe', inject: BOTS_INJECT, apply: ctx => {
    rt = { ctx, state: { bots: { b1: { id: 'b1', name: 'Sample Bot', model: 'hermes-remote/attach', appliedModel: 'hermes-remote/attach', previousModel: 'hermes-remote/attach' } } }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
    installModels(rt)
  } })
  assert.ok(rt, 'the probe plugin applied')
  return { rt, selected }
}

test('real cordis + real store: forced apply on an UNLOADED carried chat (stored route nous) in a plugin with bots-dsh inject list', async t => {
  const { rt, selected } = await bench(t, { route: { provider: 'hermes-remote', model: 'nous:openai/zz-sample-7' } })
  let outcome = 'resolved'
  try { await rt.applyModel(rt.state.bots.b1, { force: true }) } catch (error) { outcome = `threw: ${error?.message}` }
  t.diagnostic(`unloaded carried chat: applyModel ${outcome}; selects=${JSON.stringify(selected)}`)
  assert.equal(outcome, 'resolved')
  assert.deepEqual(selected, [])
})

test('real cordis + real store: forced apply on an UNLOADED chat stored on another provider still selects attach', async t => {
  const { rt, selected } = await bench(t, { route: { provider: 'deepseek', model: 'v4' } })
  let outcome = 'resolved'
  try { await rt.applyModel(rt.state.bots.b1, { force: true }) } catch (error) { outcome = `threw: ${error?.message}` }
  t.diagnostic(`unloaded deepseek chat: applyModel ${outcome}; selects=${JSON.stringify(selected)}`)
  assert.equal(outcome, 'resolved')
  assert.deepEqual(selected, ['b1:hermes-remote/attach'])
})

test('real cordis control: a LIVE carried chat never reads the store and keeps its route', async t => {
  const { rt, selected } = await bench(t, { route: { provider: 'hermes-remote', model: 'nous:openai/zz-sample-7' }, live: { b1: { requestHeader: () => ({ config: { provider: 'hermes-remote', model: 'nous:openai/zz-sample-7' } }) } } })
  let outcome = 'resolved'
  try { await rt.applyModel(rt.state.bots.b1, { force: true }) } catch (error) { outcome = `threw: ${error?.message}` }
  t.diagnostic(`live carried chat: applyModel ${outcome}; selects=${JSON.stringify(selected)}`)
  assert.equal(outcome, 'resolved')
  assert.deepEqual(selected, [])
})

test('real cordis, loader topology: the store and the bots-dsh-inject plugin are siblings under one group', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tester2-cordis-group-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = new Context()
  t.after(() => host.fiber.dispose())
  const services = {
    llm: { listProviders: () => [{ id: 'hermes-remote', name: 'Remote Hermes' }], listModels: async () => [ROW], resolveModelInfo: async () => ({ context: { contextWindow: 200_000 } }) },
    sessions: { get: () => undefined, list: () => [] },
    sessionController: { selectModel: async () => {} },
    tools: {}, systemPrompt: {}, sessionTitle: {}, workspaceRegistry: {}, connection: {},
  }
  let rt, store, viaGet
  await host.plugin({ name: 'profile-root-group', apply: async ctx => {
    await ctx.plugin(Storage); await ctx.plugin(StorageJson, { root: join(root, 'storage') }); await ctx.plugin(StorageDomain, { backend: 'json' }); await ctx.plugin(SP, { root: join(root, 'sessions') })
    for (const name of BOTS_INJECT) { ctx.provide(name); ctx.set(name, services[name]) }
    await ctx.plugin({ name: 'dsh-own-consumer', inject: ['sessionPersistence'], apply: c => { store = c.sessionPersistence } })
    await ctx.plugin({ name: 'bots-dsh-inject-probe', inject: BOTS_INJECT, apply: c => {
      viaGet = typeof c.get?.('sessionPersistence')?.open
      rt = { ctx: c, state: { bots: { b1: { id: 'b1', name: 'Sample Bot', model: 'hermes-remote/attach', appliedModel: 'hermes-remote/attach' } } }, chatOf: id => id, groupSessionsOf: () => [], save: async () => {}, warn: () => {} }
      installModels(rt)
    } })
  } })
  assert.ok(store, 'a DSH plugin that injects sessionPersistence gets it')
  assert.ok(rt, 'the probe plugin applied')
  let outcome = 'resolved'
  try { await rt.applyModel(rt.state.bots.b1, { force: true }) } catch (error) { outcome = `threw: ${error?.message}` }
  t.diagnostic(`group topology, unloaded chat: applyModel ${outcome}; ctx.get('sessionPersistence').open in the same plugin: ${viaGet}`)
  assert.equal(outcome, 'resolved')
})
