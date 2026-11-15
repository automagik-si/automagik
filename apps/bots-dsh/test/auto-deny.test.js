import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as auto from '../src/host/auto.js'
import * as judge from '../src/host/auto-judge.js'
import * as deny from '../src/host/tool-deny.js'
import { markOf } from '../src/shared/permission-levels.js'
import { fakeContext } from './fake-ctx.js'

function world(ctx, model = 'deepseek/v4') {
  const bot = { id: 'ada', name: 'Ada', model, appliedModel: model, permission: 'workspace-write', permissionAuto: markOf(model), denyTools: ['bash'] }
  const session = { id: 'ada', requestHeader: () => ({ config: { provider: model.split('/')[0], model: model.split('/').slice(1).join('/') } }) }
  ctx.provide('permissionPresets', { current: () => 'workspace-write', resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }) })
  ctx.provide('acpAgents', { ownModeOf: () => ({ answerer: true }) })
  const rt = { ctx, state: { bots: { ada: bot } }, chatOwners: new Map([['ada', 'ada']]), botOf: id => id === bot.id ? bot : undefined,
    selfOf: id => id === session.id ? bot.id : undefined, holdsLock: () => true, teamLoaded: () => true, levelHeld: () => false, cachedBackground: () => 'deepseek/v4' }
  auto.install(rt)
  return { rt, bot, session }
}
for (const model of ['acp-codex/default', 'acp-claude/default', 'acp-hermes/default', 'deepseek/v4']) test(`#1092 deny lists coexist with ${model}`, async t => {
  const ctx = fakeContext(); t.after(() => ctx.dispose())
  const { rt, bot, session } = world(ctx, model)
  assert.equal(rt.autoOffer(bot).offered, true)
  assert.equal(rt.autoWhy(bot, { sessionId: session.id, session, route: model, view: true }), undefined)
  rt.sweepAuto()
  assert.equal(bot.permissionAuto, markOf(model))
})
test('#1092 the native executor refuses a denied tool even when Auto allows', async t => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  t.after(() => ctx.fiber.dispose())
  const { rt, bot, session } = world(ctx)
  let ran = false; let judged = 0
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) })
  ctx.provide('llm', {
    resolveModelInfo: async () => ({}),
    async* stream() { judged++; yield { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"needed"}' }; yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  deny.install(rt)
  judge.install(rt)
  ctx.tools.register(defineTool({ name: 'bash', description: 'x', parameters: { command: { type: 'string', required: true }, sandbox_permissions: { type: 'string' }, justification: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { ran = true; return 'ran' } }))
  const agent = { session }; const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal })
  t.after(() => toolSet.dispose())
  const batch = await ctx.tools.execute({ calls: [{ id: 'x', name: 'bash', arguments: { command: 'ls', sandbox_permissions: 'danger-full-access', justification: 'needed' } }], agent, signal, toolSet })
  assert.equal(bot.permissionAuto, 'api:deepseek/v4')
  assert.equal(rt.autoCounts(session), true)
  assert.equal(ran, false)
  assert.equal(judged, 1)
  assert.equal(batch.results[0].result.isError, true)
  assert.match(JSON.stringify(batch.results[0].result), /Ada does not have the bash tool/)
})
