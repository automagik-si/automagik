import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { until } from './until.js'

// A team already through the Claude Code -> pi-ai move (store.js), with Bots the ACP move can
// and cannot take: still on the model it was moved to; changed by the person since; and one
// the route does not list.
const seed = (bots = {}) => ({
  version: 1,
  mainBotIds: ['m1'],
  revision: 2,
  whaleStored: true,
  octopusStored: true,
  genieClayStored: true,
  claudeCodeMoved: true,
  bots: {
    m1: {
      id: 'm1', sessionId: 'm1', name: 'Omni', role: 'Boss', instructions: '', createdAt: 1,
      model: 'anthropic/claude-opus-5-5', claudeCodeModel: 'claude-code/opus', appliedModel: 'anthropic/claude-opus-5-5', appliedEffort: 'high', effort: 'high',
    },
    w2: {
      id: 'w2', sessionId: 'w2', name: 'Writer', role: 'Write', instructions: '', createdAt: 2,
      model: 'anthropic/claude-sonnet-4-5', claudeCodeModel: 'claude-code-work/claude-sonnet-4-5-20250929[1m]',
    },
    d3: {
      id: 'd3', sessionId: 'd3', name: 'Coder', role: 'Code', instructions: '', createdAt: 3,
      model: 'deepseek/deepseek-v4-flash', claudeCodeModel: 'claude-code/opus',
    },
    ...bots,
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
})

// What the ACP plugin says when its bridge and probes are usable, and the route lists Claude's
// aliases as Claude Code's own catalog does.
const readyAcp = (models = ['default', 'opus', 'sonnet', 'haiku']) => ({
  bridge: () => ({ on: true, probesPass: true }),
  refresh: async () => undefined,
  status: async () => ({ agents: [{
    id: 'acp-claude',
    connector: { state: 'ready' },
    model: { id: 'default', listed: true },
    signedIn: true,
  }] }),
  models,
})

async function start(team, {
  acp = readyAcp(), providers = ['anthropic', 'deepseek', 'acp-claude'],
  acpModels = undefined, extraModels = {}, services = {}, resolveModelInfo = undefined,
  onRuntime = undefined,
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-acp-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team))
  const ctx = fakeContext({ services: { ...(acp ? { acpAgents: acp } : {}), ...services } })
  const workspaces = new Map()
  const selected = []
  const catalog = {
    anthropic: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-4-5' }],
    deepseek: [{ id: 'deepseek-v4-flash' }],
    'acp-claude': (acpModels ?? acp.models ?? []).map(id => ({ id })),
    ...extraModels,
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => providers.map(id => ({ id, name: id })),
      listModels: async provider => catalog[provider] ?? [],
      resolveModelInfo: resolveModelInfo ?? (async provider => (provider === 'acp-claude'
        ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
        : {})),
      listConfigurableProviders: () => [],
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => {
        const workspace = { id: `w${workspaces.size + 1}`, path }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {}, cancel() {} } }),
      selectModel: async request => { selected.push(request) },
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {}, list: () => [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  // The runtime is on `omniTeam` once every module installed; a test may wrap its calls
  // before the start pass's first await.
  onRuntime?.(ctx.provided.get('omniTeam'))
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  const saved = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const teamNow = async () => Object.fromEntries((await call('state', {})).value.bots.map(bot => [bot.id, bot]))
  // The move runs after the team loads and the ACP route answers, not synchronously. It saves
  // before it applies, so wait for the target's applied record too: otherwise a test can read
  // the seed's previous record in the window between the save and the apply.
  const moved = async () => {
    await until(() => {
      const state = saved()
      return state.claudeAcpMoved === true || state.bots.m1.model !== team.bots.m1.model
    }, { label: 'the ACP move ran' })
    await until(() => saved().bots.m1.appliedModel === 'acp-claude/opus', {
      label: 'the ACP move applied its target',
    })
  }
  return { home, ctx, call, stop, saved, teamNow, selected, moved }
}

test('a Bot still on the pi-ai model it was moved to goes to acp-claude once, keeping its Session', async (t) => {
  const host = await start(seed())
  t.after(host.stop)
  await host.moved()
  // The model is recorded on the Session after the save that moved the Bot.
  await until(() => host.saved().bots.m1.appliedModel === 'acp-claude/opus' && host.saved().bots.w2.appliedModel === 'acp-claude/sonnet', { label: 'the ACP models were applied' })
  const state = host.saved()
  assert.equal(state.claudeAcpMoved, true)
  // The route lists Claude's aliases, not pi-ai's exact ids: the family stands in.
  assert.equal(state.bots.m1.model, 'acp-claude/opus')
  assert.equal(state.bots.w2.model, 'acp-claude/sonnet')
  assert.equal(state.bots.m1.claudeCodeModel, 'claude-code/opus')
  assert.equal(state.bots.m1.appliedModel, 'acp-claude/opus')
  assert.equal(state.bots.m1.appliedEffort, 'high')
  // The move records what the Bot ran on before, thinking level included, for the rollback.
  assert.deepEqual(state.bots.m1.acpMoved, {
    from: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
    target: 'acp-claude/opus',
  })
  assert.deepEqual(state.bots.w2.acpMoved, {
    from: { model: 'anthropic/claude-sonnet-4-5' },
    target: 'acp-claude/sonnet',
  })
  // The effort reached the Session's selection, not only the Bot's record.
  const applied = host.selected.find(request =>
    request.sessionId === 'm1' && request.provider === 'acp-claude')
  assert.equal(applied.reasoningEffort, 'high')
  assert.deepEqual([state.bots.m1.sessionId, state.bots.w2.sessionId], ['m1', 'w2'])
})

test('the move keeps the previous applied record until the target is applied', async (t) => {
  // The target's apply rewrites `appliedModel`/`appliedEffort` in the same pass, so the saved
  // file cannot show a delete-before-apply window: the row snapshots the Bot at the apply call.
  // A move that drops the pair first leaves the Session record empty instead, and this fails.
  const snapshots = []
  const host = await start(seed(), {
    onRuntime: (rt) => {
      const applyModel = rt.applyModel
      rt.applyModel = async (bot, options) => {
        if (bot.acpMoved !== undefined) {
          snapshots.push({
            id: bot.id,
            model: bot.model,
            target: bot.acpMoved.target,
            appliedModel: bot.appliedModel,
            appliedEffort: bot.appliedEffort,
          })
        }
        return applyModel(bot, options)
      }
    },
  })
  t.after(host.stop)
  await host.moved()
  await until(() => host.saved().bots.m1.appliedModel === 'acp-claude/opus', {
    label: 'the target model was applied',
  })
  const first = snapshots.find(snapshot => snapshot.id === 'm1')
  assert.ok(first, 'the move applied m1 through applyModel')
  assert.equal(first.model, first.target)
  // At that call the Bot still carries the pair the reverse restores, not undefined.
  assert.equal(first.appliedModel, 'anthropic/claude-opus-5-5')
  assert.equal(first.appliedEffort, 'high')
  // And the apply leaves the target's own record, so a later pass sees it is applied.
  assert.equal(host.saved().bots.m1.appliedModel, 'acp-claude/opus')
  assert.equal(host.saved().bots.m1.appliedEffort, 'high')
})

test('the move applies the Bot\'s level once the agent catalog can express it', async (t) => {
  let probed = false
  const resolveModelInfo = async provider => (provider === 'acp-claude' && probed
    ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
    : {})
  const host = await start(seed(), { resolveModelInfo })
  t.after(host.stop)
  await host.moved()
  // The route answered the model but not its levels yet: the model moved, the level waits.
  await until(() => host.saved().bots.m1.appliedModel === 'acp-claude/opus', {
    label: 'the model moved',
  })
  assert.equal(host.saved().bots.m1.appliedEffort, undefined)
  probed = true
  host.ctx.emit('llm/adapters-updated')
  await until(() => host.saved().bots.m1.appliedEffort === 'high', {
    label: 'the level reached the agent once its catalog answered',
  })
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
})

test('the move runs once per team: a model the person picks afterwards is never moved again', async (t) => {
  const host = await start(seed())
  t.after(host.stop)
  await host.moved()
  assert.equal((await host.call('update-bot', { id: 'm1', model: 'deepseek/deepseek-v4-flash' })).ok, true)
  await until(() => host.saved().bots.m1.model === 'deepseek/deepseek-v4-flash')
  // A later catalog (another start reads the same file) sees the flag and leaves the Bot be.
  const again = await start(host.saved(), { acp: readyAcp() })
  t.after(again.stop)
  await again.call('state', {})
  await until(() => again.saved().bots.m1.model === 'deepseek/deepseek-v4-flash')
  assert.equal(again.saved().bots.m1.model, 'deepseek/deepseek-v4-flash')
  assert.equal(again.saved().claudeAcpMoved, true)
})

test('turning dshTools off restores a moved Bot\'s model and thinking level', async (t) => {
  let on = true
  const acp = { ...readyAcp(), bridge: () => ({ on, probesPass: true }) }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
  on = false
  host.ctx.emit('loader/volatile-update')
  await until(() => host.saved().bots.m1.appliedModel === 'anthropic/claude-opus-5-5', {
    label: 'the Bot moved back to its pi-ai model',
  })
  const state = host.saved()
  assert.equal(state.bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.m1.effort, 'high')
  assert.equal(state.bots.m1.acpMoved, undefined)
  assert.equal(state.claudeAcpMoved, undefined)
  // The Bot without a level of its own comes back without one.
  assert.equal(state.bots.w2.model, 'anthropic/claude-sonnet-4-5')
  assert.equal(state.bots.w2.effort, undefined)
  assert.equal(state.bots.w2.acpMoved, undefined)
})

test('a live dshTools flip moves the Bots back, and on again forward', async (t) => {
  let on = true
  const acp = { ...readyAcp(), bridge: () => ({ on, probesPass: true }) }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
  // DSH delivers loader/volatile-update only to the plugin whose config changed, so the Bot
  // team can never see acp-dsh's flip there. acp-dsh announces it on the plugin context; the
  // team reverses on that event, live, with no restart.
  on = false
  host.ctx.emit('acp-dsh/dsh-tools-changed', { on: false })
  await until(() => host.saved().bots.m1.appliedModel === 'anthropic/claude-opus-5-5', {
    label: 'the live flip moved the Bot back', ms: 1500,
  })
  let state = host.saved()
  assert.equal(state.bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.m1.effort, 'high')
  assert.equal(state.bots.m1.acpMoved, undefined)
  assert.equal(state.claudeAcpMoved, undefined)
  // The other direction: on again, the team moves once more, as at the next start.
  on = true
  host.ctx.emit('acp-dsh/dsh-tools-changed', { on: true })
  await until(() => host.saved().bots.m1.model === 'acp-claude/opus', {
    label: 'the live flip moved the Bot on again', ms: 1500,
  })
  state = host.saved()
  assert.equal(state.claudeAcpMoved, true)
  assert.deepEqual(state.bots.m1.acpMoved, {
    from: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
    target: 'acp-claude/opus',
  })
})

test('a level the agent cannot express stays on the Bot, and no level is sent', async (t) => {
  const base = seed()
  const host = await start(seed({
    m1: { ...base.bots.m1, effort: 'minimal', appliedEffort: 'minimal' },
  }), {
    resolveModelInfo: async provider => (provider === 'acp-claude'
      ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
      : {}),
  })
  t.after(host.stop)
  await host.moved()
  // The save that moves the Bot comes before the Session selection: wait for the apply, or a
  // loaded runner may read the seed's appliedEffort from before it.
  await until(() => host.saved().bots.m1.appliedModel === 'acp-claude/opus', {
    label: 'the target model was applied',
  })
  const state = host.saved()
  assert.equal(state.bots.m1.model, 'acp-claude/opus')
  // The Bot keeps the level it asked for; the agent runs on its own, and the record keeps
  // the level the reverse reads.
  assert.equal(state.bots.m1.effort, 'minimal')
  assert.equal(state.bots.m1.appliedEffort, undefined)
  assert.deepEqual(state.bots.m1.acpMoved.from, {
    model: 'anthropic/claude-opus-5-5', effort: 'minimal',
  })
  const applied = host.selected.find(request =>
    request.sessionId === 'm1' && request.provider === 'acp-claude')
  assert.equal(applied.reasoningEffort, undefined)
})

test('picking another route by hand carries the Bot\'s level both ways', async (t) => {
  const levels = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
  const host = await start(seed(), {
    providers: ['anthropic', 'deepseek', 'acp-claude', 'acp-codex'],
    extraModels: { 'acp-codex': [{ id: 'default' }] },
    resolveModelInfo: async provider => (['anthropic', 'acp-claude', 'acp-codex'].includes(provider)
      ? { reasoning: levels }
      : {}),
  })
  t.after(host.stop)
  await host.moved()
  await until(() => host.saved().bots.m1.appliedModel === 'acp-claude/opus', {
    label: 'the target model was applied on the move',
  })
  const request = provider => host.selected.filter(entry =>
    entry.sessionId === 'm1' && entry.provider === provider).at(-1)
  // The move kept the level on the way in.
  assert.equal(request('acp-claude').reasoningEffort, 'high')
  // The person moves the Bot back to its old route: the level crosses with the model.
  assert.equal((await host.call('update-bot', {
    id: 'm1', model: 'anthropic/claude-opus-5-5',
  })).ok, true)
  await until(() => host.saved().bots.m1.appliedModel === 'anthropic/claude-opus-5-5', {
    label: 'the Bot moved back by hand',
  })
  assert.equal(request('anthropic').reasoningEffort, 'high')
  // The move record is dropped on the next pass: the person's model stays theirs, never
  // pulled back onto the agent by the one-time move.
  host.ctx.emit('llm/adapters-updated')
  await until(() => host.saved().bots.m1.acpMoved === undefined, {
    label: 'the stale move record was dropped',
  })
  assert.equal(host.saved().bots.m1.model, 'anthropic/claude-opus-5-5')
  // Onto Codex, where it offers the same level: the level crosses there too.
  assert.equal((await host.call('update-bot', { id: 'm1', model: 'acp-codex/default' })).ok, true)
  await until(() => host.saved().bots.m1.appliedModel === 'acp-codex/default', {
    label: 'the Bot moved to Codex by hand',
  })
  assert.equal(request('acp-codex').reasoningEffort, 'high')
})

test('a Bot the person changed since the move stays as they set it', async (t) => {
  let on = true
  const acp = { ...readyAcp(), bridge: () => ({ on, probesPass: true }) }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  const changed = await host.call('update-bot', { id: 'm1', model: 'deepseek/deepseek-v4-flash' })
  assert.equal(changed.ok, true)
  await until(() => host.saved().bots.m1.model === 'deepseek/deepseek-v4-flash')
  on = false
  host.ctx.emit('loader/volatile-update')
  await until(() => host.saved().claudeAcpMoved === undefined, { label: 'the rollback ran' })
  const state = host.saved()
  // The person's pick is not overwritten, and the record that could overwrite it is gone.
  assert.equal(state.bots.m1.model, 'deepseek/deepseek-v4-flash')
  assert.equal(state.bots.m1.acpMoved, undefined)
  assert.equal(state.bots.w2.model, 'anthropic/claude-sonnet-4-5')
})

test('a moved Bot whose person picked another level stays on the route', async (t) => {
  let on = true
  const acp = { ...readyAcp(), bridge: () => ({ on, probesPass: true }) }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  const picked = await host.call('update-bot', { id: 'm1', effort: 'low' })
  assert.equal(picked.ok, true)
  await until(() => host.saved().bots.m1.appliedEffort === 'low')
  // A catalog pass does not drop the record: the same state must behave the same way.
  host.ctx.emit('llm/adapters-updated')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(host.saved().bots.m1.acpMoved.target, 'acp-claude/opus')
  on = false
  host.ctx.emit('loader/volatile-update')
  await until(() => host.saved().claudeAcpMoved === undefined, { label: 'the rollback ran' })
  const state = host.saved()
  // The person's own effort pick is not overwritten by a move back.
  assert.equal(state.bots.m1.model, 'acp-claude/opus')
  assert.equal(state.bots.m1.effort, 'low')
  assert.equal(state.bots.m1.acpMoved, undefined)
})

test('a moved Bot comes back when the ACP route disappears', async (t) => {
  let route = true
  const ready = {
    id: 'acp-claude',
    connector: { state: 'ready' },
    model: { id: 'default', listed: true },
    signedIn: true,
  }
  const acp = {
    ...readyAcp(),
    status: async () => ({ agents: route ? [ready] : [] }),
  }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
  route = false
  host.ctx.emit('loader/volatile-update')
  await until(() => host.saved().bots.m1.model === 'anthropic/claude-opus-5-5', {
    label: 'the route disappeared and the Bot moved back',
  })
  const state = host.saved()
  assert.equal(state.bots.m1.effort, 'high')
  assert.equal(state.bots.m1.acpMoved, undefined)
  assert.equal(state.claudeAcpMoved, undefined)
})

test('a moved team reverses at the next start with the ACP plugin absent', async (t) => {
  const base = seed()
  const moved = {
    ...base,
    claudeAcpMoved: true,
    bots: {
      ...base.bots,
      m1: {
        ...base.bots.m1,
        model: 'acp-claude/opus',
        appliedModel: 'acp-claude/opus',
        acpMoved: {
          from: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
          target: 'acp-claude/opus',
        },
      },
      w2: {
        ...base.bots.w2,
        model: 'acp-claude/sonnet',
        appliedModel: 'acp-claude/sonnet',
        effort: 'low',
        acpMoved: {
          from: { model: 'anthropic/claude-sonnet-4-5', effort: 'high' },
          target: 'acp-claude/sonnet',
        },
      },
      d3: {
        ...base.bots.d3,
        model: 'deepseek/deepseek-v4-flash',
        appliedModel: 'deepseek/deepseek-v4-flash',
        acpMoved: {
          from: { model: 'anthropic/claude-opus-5-5', effort: 'high' },
          target: 'acp-claude/opus',
        },
      },
    },
  }
  // No `acpAgents` and no enabled loader entry: nothing announces the off flip, and no plugin
  // is still loading. The start pass sees the route gone and reverses from the records alone.
  const host = await start(moved, {
    acp: false,
    resolveModelInfo: async provider => (['anthropic', 'deepseek'].includes(provider)
      ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }
      : {}),
  })
  t.after(host.stop)
  await until(() => {
    const state = host.saved()
    return state.bots.m1.appliedModel === 'anthropic/claude-opus-5-5'
      && state.bots.w2.appliedEffort === 'low'
  }, { label: 'the start migrate reversed the moves' })
  const state = host.saved()
  // The Bot nobody touched gets exactly the recorded model and level back.
  assert.equal(state.bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.m1.effort, 'high')
  assert.equal(state.bots.m1.appliedEffort, 'high')
  assert.equal(state.bots.m1.acpMoved, undefined)
  // A person's level pick is kept; the dead route still gives the model back.
  assert.equal(state.bots.w2.model, 'anthropic/claude-sonnet-4-5')
  assert.equal(state.bots.w2.effort, 'low')
  assert.equal(state.bots.w2.appliedEffort, 'low')
  assert.equal(state.bots.w2.acpMoved, undefined)
  // A person's model pick wins outright: the Bot stays where they put it.
  assert.equal(state.bots.d3.model, 'deepseek/deepseek-v4-flash')
  assert.equal(state.bots.d3.acpMoved, undefined)
  assert.equal(state.claudeAcpMoved, undefined)
})

test('a missed live announcement still reverses at the next start', async (t) => {
  const first = await start(seed())
  t.after(first.stop)
  await first.moved()
  assert.equal(first.saved().bots.m1.model, 'acp-claude/opus')
  const moved = first.saved()
  // The first host must close for the second to write the same team; no live event reaches it,
  // as when acp-dsh's announcement listener threw.
  await first.stop()
  // The next start with the bridge off reads the route as off and reverses from the record.
  const off = { ...readyAcp(), bridge: () => ({ on: false, probesPass: true }) }
  const host = await start(moved, { acp: off })
  t.after(host.stop)
  await until(() => host.saved().bots.m1.appliedModel === 'anthropic/claude-opus-5-5', {
    label: 'the next start reversed the move',
  })
  const state = host.saved()
  assert.equal(state.bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.m1.effort, 'high')
  assert.equal(state.bots.m1.acpMoved, undefined)
  assert.equal(state.claudeAcpMoved, undefined)
  assert.equal(state.bots.w2.model, 'anthropic/claude-sonnet-4-5')
})

test('an effort pick still leaves a dead ACP route for the previous model', async (t) => {
  let route = true
  const ready = {
    id: 'acp-claude',
    connector: { state: 'ready' },
    model: { id: 'default', listed: true },
    signedIn: true,
  }
  const acp = {
    ...readyAcp(),
    status: async () => ({ agents: route ? [ready] : [] }),
  }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  const picked = await host.call('update-bot', { id: 'm1', effort: 'low' })
  assert.equal(picked.ok, true)
  await until(() => host.saved().bots.m1.appliedEffort === 'low')
  route = false
  host.ctx.emit('loader/volatile-update')
  await until(() => host.saved().bots.m1.appliedModel === 'anthropic/claude-opus-5-5', {
    label: 'the dead route let the Bot go',
  })
  const state = host.saved()
  // The person's level stays theirs; only the dead model is replaced.
  assert.equal(state.bots.m1.effort, 'low')
  assert.equal(state.bots.m1.acpMoved, undefined)
})

test('a plugin that is still loading is not a route that disappeared', async (t) => {
  const base = seed()
  const moved = {
    ...base,
    claudeAcpMoved: true,
    bots: {
      ...base.bots,
      m1: {
        ...base.bots.m1, model: 'acp-claude/opus', appliedModel: 'acp-claude/opus',
        claudeCodeModel: 'claude-code/default',
      },
    },
  }
  const loader = {
    entries: () => [{ options: { name: '@automagik/acp-dsh' }, disabled: false }],
  }
  const host = await start(moved, { acp: false, services: { loader } })
  t.after(host.stop)
  await host.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 100))
  const state = host.saved()
  assert.equal(state.bots.m1.model, 'acp-claude/opus')
  assert.equal(state.claudeAcpMoved, true)
  // The recovered record is on disk, not rebuilt from mutable state each pass.
  assert.equal(state.bots.m1.acpMoved.from.model, 'anthropic/claude-opus-5-5')
})

test('a team moved before the record existed rolls back to its pi-ai model', async (t) => {
  const base = seed()
  const moved = {
    ...base,
    claudeAcpMoved: true,
    bots: {
      ...base.bots,
      m1: {
        ...base.bots.m1, model: 'acp-claude/opus', appliedModel: 'acp-claude/opus',
        claudeCodeModel: 'claude-code/default',
      },
    },
  }
  const host = await start(moved, { acp: false })
  t.after(host.stop)
  await until(() => host.saved().bots.m1.model === 'anthropic/claude-opus-5-5', {
    label: 'the legacy move rolled back',
  })
  const state = host.saved()
  // `claude-code/default` names no family on its own; the pi-ai model it became did.
  assert.equal(state.bots.m1.effort, 'high')
  assert.equal(state.bots.m1.acpMoved, undefined)
  assert.equal(state.claudeAcpMoved, undefined)
})

test('a Bot the person moved off its pi-ai Claude model is left alone', async (t) => {
  const host = await start(seed())
  t.after(host.stop)
  await host.moved()
  const state = host.saved()
  assert.equal(state.bots.d3.model, 'deepseek/deepseek-v4-flash')
  assert.equal(state.bots.d3.claudeCodeModel, 'claude-code/opus')
})

test('a Bot whose model the route does not list is left alone, and the team is not marked done', async (t) => {
  // Only `default`: neither opus nor the exact pi-ai id is served by the route yet.
  const host = await start(seed(), { acp: readyAcp(['default']) })
  t.after(host.stop)
  await host.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 100))
  const state = host.saved()
  assert.equal(state.bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.w2.model, 'anthropic/claude-sonnet-4-5')
  // Not marked: an adapter installed later may list them, and that catalog moves them then.
  assert.equal(state.claudeAcpMoved, undefined)
})

test('a Bot moved from Claude Code\'s default model takes Opus on the route', async (t) => {
  const def = {
    id: 'def', sessionId: 'def', name: 'Default', role: 'Boss', instructions: '', createdAt: 4,
    model: 'anthropic/claude-opus-5-5', claudeCodeModel: 'claude-code/default',
  }
  const host = await start(seed({ def }))
  t.after(host.stop)
  await host.moved()
  await until(() => host.saved().bots.def.appliedModel === 'acp-claude/opus', { label: 'the default Bot moved' })
  assert.equal(host.saved().bots.def.model, 'acp-claude/opus')
})

test('an event that lands while the route is being read runs one more pass', async (t) => {
  let release
  let calls = 0
  const acp = {
    ...readyAcp(),
    status: () => {
      calls += 1
      if (calls === 1) {
        return new Promise((resolve) => {
          release = () => resolve({ agents: [{ id: 'acp-claude', connector: { state: 'installing' }, model: { listed: false } }] })
        })
      }
      return Promise.resolve({ agents: [{
        id: 'acp-claude',
        connector: { state: 'ready' },
        model: { listed: true },
        signedIn: true,
      }] })
    },
  }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await until(() => calls === 1, { label: 'the first route read started' })
  // The adapter lands while the first pass waits on the route.
  host.ctx.emit('llm/adapters-updated')
  release()
  await until(() => host.saved().claudeAcpMoved === true, { label: 'the queued pass moved the team' })
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
  // The first pass saw `installing` and left; the queued pass made the second read.
  assert.equal(calls, 2)
})

test('the sign-in is asked once when the status has no answer yet', async (t) => {
  let refreshes = 0
  let calls = 0
  const acp = {
    ...readyAcp(),
    refresh: async () => { refreshes += 1 },
    status: async () => {
      calls += 1
      return { agents: [{
        id: 'acp-claude',
        connector: { state: 'ready' },
        model: { listed: true },
        ...(calls === 1 ? {} : { signedIn: true }),
      }] }
    },
  }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  assert.equal(refreshes, 1)
  assert.equal(calls, 2)
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
})

test('a known signed-in route is not asked again', async (t) => {
  let refreshes = 0
  const acp = { ...readyAcp(), refresh: async () => { refreshes += 1 } }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.moved()
  assert.equal(refreshes, 0)
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
})

test('dshTools off is the 2026-11-03 behaviour: no Bot moves', async (t) => {
  const off = { ...readyAcp(), bridge: () => ({ on: false, probesPass: true }) }
  const host = await start(seed(), { acp: off })
  t.after(host.stop)
  await host.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 100))
  const state = host.saved()
  assert.equal(state.bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(state.bots.w2.model, 'anthropic/claude-sonnet-4-5')
  assert.equal(state.claudeAcpMoved, undefined)
})

test('an installed but signed-out Claude moves nothing', async (t) => {
  // The route is ready and listed, but its CLI says it is not signed in. The Bots stay on the
  // pi-ai model they are on, and the team is not marked done, so signing in can still move them.
  let refreshes = 0
  const signedOut = {
    ...readyAcp(),
    refresh: async () => { refreshes += 1 },
    status: async () => ({ agents: [{
      id: 'acp-claude',
      connector: { state: 'ready' },
      model: { listed: true },
      signedIn: false,
    }] }),
  }
  const host = await start(seed(), { acp: signedOut })
  t.after(host.stop)
  await host.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(refreshes > 0, 'the CLI was asked again on this pass')
  assert.equal(host.saved().bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.equal(host.saved().claudeAcpMoved, undefined)
})

test('signing in later still moves the team: a signed-out pass marks nothing', async (t) => {
  let signedIn = false
  let refreshes = 0
  const acp = {
    ...readyAcp(),
    refresh: async () => { refreshes += 1 },
    status: async () => ({ agents: [{
      id: 'acp-claude', connector: { state: 'ready' }, model: { listed: true }, signedIn,
    }] }),
  }
  const host = await start(seed(), { acp })
  t.after(host.stop)
  await host.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(host.saved().claudeAcpMoved, undefined)
  assert.equal(host.saved().bots.m1.model, 'anthropic/claude-opus-5-5')
  assert.ok(refreshes > 0, 'the signed-out pass asked the CLI')
  signedIn = true
  host.ctx.emit('llm/adapters-updated')
  await until(() => host.saved().claudeAcpMoved === true, { label: 'the team moved after sign-in' })
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
})

test('a status read that fails after the sign-in ask is waiting', async (t) => {
  // The team is already moved; a flaky second read during a signed-out pass must not restore it.
  const first = await start(seed(), { acp: readyAcp() })
  t.after(first.stop)
  await first.moved()
  assert.equal(first.saved().bots.m1.model, 'acp-claude/opus')
  let calls = 0
  const ready = {
    id: 'acp-claude',
    connector: { state: 'ready' },
    model: { id: 'default', listed: true },
  }
  const flaky = {
    ...readyAcp(),
    status: async () => {
      calls += 1
      if (calls === 1) return { agents: [{ ...ready, signedIn: false }] }
      throw new Error('the CLI did not answer')
    },
  }
  const host = await start(first.saved(), { acp: flaky })
  t.after(host.stop)
  await host.call('state', {})
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(calls > 1, 'the sign-in ask ran and its re-read failed')
  assert.equal(host.saved().bots.m1.model, 'acp-claude/opus')
  assert.equal(host.saved().claudeAcpMoved, true)
  assert.equal(host.saved().bots.m1.acpMoved?.target, 'acp-claude/opus')
})

test('a bridge whose probes do not pass, or an adapter that is not installed, moves nothing', async (t) => {
  for (const acp of [
    { ...readyAcp(), bridge: () => ({ on: true, probesPass: false }) },
    { ...readyAcp(), status: async () => ({ agents: [{ id: 'acp-claude', connector: { state: 'installing' }, model: { listed: false } }] }) },
  ]) {
    const host = await start(seed(), { acp })
    t.after(host.stop)
    await host.call('state', {})
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(host.saved().bots.m1.model, 'anthropic/claude-opus-5-5')
    assert.equal(host.saved().claudeAcpMoved, undefined)
  }
})

test('a direct update-bot route crossing takes the new-conversation path', async (t) => {
  const switched = []
  const host = await start(seed(), {
    onRuntime: (rt) => {
      rt.resolveAgent = async () => ({ whenIdle: async () => {}, session: { id: 'm1' } })
      rt.switchRoute = async (id, model, effort) => {
        switched.push([id, model, effort])
        rt.botOf(id).model = model
        return { status: 'switching' }
      }
    },
  })
  t.after(host.stop)
  await host.moved()
  const res = await host.call('update-bot', { id: 'm1', model: 'deepseek/deepseek-v4-flash' })
  assert.equal(res.ok, true)
  assert.deepEqual(switched, [['m1', 'deepseek/deepseek-v4-flash', undefined]])
})

test('the switch-route endpoint passes the level chosen with the crossing', async (t) => {
  const switched = []
  const host = await start(seed(), {
    onRuntime: (rt) => { rt.switchRoute = async (...args) => { switched.push(args); return { status: 'switching' } } },
  })
  t.after(host.stop)
  const res = await host.call('switch-route', { id: 'm1', model: 'deepseek/deepseek-v4-flash', effort: 'high' })
  assert.equal(res.ok, true)
  assert.deepEqual(switched, [['m1', 'deepseek/deepseek-v4-flash', 'high']])
})
