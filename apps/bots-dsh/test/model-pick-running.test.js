import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const saved = 'deepseek/saved'
const picked = 'deepseek/picked'
const fallback = 'deepseek/fallback'
const routeModel = 'acp-claude/default'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function start(t, runningModel = saved) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-model-pick-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1,
    bots: { m1: {
      id: 'm1', sessionId: 'part-current', name: 'Test Bot', role: 'Orchestrator',
      instructions: '', createdAt: 1, model: saved, appliedModel: saved, effort: 'low',
    } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const agents = new Map()
  const ctx = fakeContext({ services: { agents } })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { route = options; return register(options) }
  apply(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    const answer = await response.json()
    assert.equal(answer.ok, true, JSON.stringify(answer.error))
    return answer.value
  }
  const rt = ctx.provided.get('omniTeam')
  let selection
  const select = (ref, effort = 'low') => {
    const [provider, model] = ref.split('/')
    selection = { provider, model, reasoningEffort: effort }
  }
  select(runningModel)
  const agent = {
    id: 'part-current', session: { id: 'part-current', deriveMessages: () => [] },
    model: { current: () => selection },
  }
  agents.set(agent.id, agent)
  rt.resolveModel = async ref => ref
  rt.resolveEffort = async (_ref, effort) => effort
  rt.resolveAgent = async id => agents.get(id)
  return { call, rt, ctx, select }
}

const botOf = view => view.bots.find(bot => bot.id === 'm1')
const poll = (call, view) => call('state', { since: view.revision, models: view.modelsKey })
const noRunning = bot => {
  assert.equal(Object.hasOwn(bot, 'runningModel'), false)
  assert.equal(Object.hasOwn(bot, 'runningEffort'), false)
}

// Hold the apply after the record changes and before the Session takes the choice.
function holdApply(t, rt, select, { refuse = false } = {}) {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  rt.applyModel = async (bot, options) => {
    assert.equal(options.force, true)
    const { model, effort } = bot
    entered.resolve()
    await release.promise
    if (refuse) throw new Error('selection refused')
    select(model, effort)
    bot.appliedModel = model
    bot.appliedEffort = effort
  }
  return { entered: entered.promise, release: release.resolve }
}

test('update-bot hides the old live selection until the picked model is taken', async t => {
  const { call, rt, select } = start(t)
  const before = await call('state')
  assert.equal(botOf(before).runningModel, saved)
  assert.equal(botOf(before).runningEffort, 'low')
  const held = holdApply(t, rt, select)
  const update = call('update-bot', { id: 'm1', model: picked, effort: 'high' })
  await held.entered
  const during = await poll(call, before)
  assert.equal(botOf(during).model, picked)
  assert.equal(botOf(during).effort, 'high')
  noRunning(botOf(during))
  assert.equal(rt.pickingModel('m1'), true)
  held.release()
  await update
  assert.equal(rt.pickingModel('m1'), false)
  const after = await poll(call, during)
  assert.equal(botOf(after).model, picked)
  assert.equal(botOf(after).runningModel, picked)
  assert.equal(botOf(after).runningEffort, 'high')
  select(fallback, 'medium')
  const switched = await poll(call, after)
  assert.equal(botOf(switched).model, picked)
  assert.equal(botOf(switched).runningModel, fallback)
  assert.equal(botOf(switched).runningEffort, 'medium')
})

test('a refused pick restores the saved model and the earlier live fallback', async t => {
  const { call, rt, select } = start(t, fallback)
  const before = await call('state')
  assert.equal(botOf(before).runningModel, fallback)
  assert.equal(botOf(before).runningEffort, 'low')
  const held = holdApply(t, rt, select, { refuse: true })
  const update = rt.updateBot('m1', { model: picked, effort: 'high' })
  const refused = assert.rejects(update, /could not switch/)
  await held.entered
  const during = await poll(call, before)
  assert.equal(botOf(during).model, picked)
  noRunning(botOf(during))
  assert.equal(rt.pickingModel('m1'), true)
  held.release()
  await refused
  assert.equal(rt.pickingModel('m1'), false)
  const after = await poll(call, during)
  assert.equal(botOf(after).model, botOf(before).model)
  assert.equal(botOf(after).effort, botOf(before).effort)
  assert.equal(botOf(after).runningModel, botOf(before).runningModel)
  assert.equal(botOf(after).runningEffort, botOf(before).runningEffort)
})

test('overlapping update-bot picks hide running fields until both settle', async t => {
  const { call, rt, select } = start(t)
  const before = await call('state')
  const first = holdApply(t, rt, select)
  const updateB = call('update-bot', { id: 'm1', model: picked, effort: 'high' })
  await first.entered
  const second = holdApply(t, rt, select)
  const last = 'deepseek/last'
  const updateC = call('update-bot', { id: 'm1', model: last, effort: 'medium' })
  await second.entered
  const both = await poll(call, before)
  assert.equal(botOf(both).model, last)
  noRunning(botOf(both))
  assert.equal(rt.pickingModel('m1'), true)
  first.release()
  await updateB
  const one = await call('state')
  assert.equal(botOf(one).model, last)
  noRunning(botOf(one))
  assert.equal(rt.pickingModel('m1'), true)
  second.release()
  await updateC
  assert.equal(rt.pickingModel('m1'), false)
  const after = await poll(call, one)
  assert.equal(botOf(after).model, last)
  assert.equal(botOf(after).runningModel, last)
  assert.equal(botOf(after).runningEffort, 'medium')
})

test('undoing an accepted pick hides running fields until the old model is taken', async t => {
  const { call, rt, ctx, select } = start(t)
  const before = await call('state')
  const restoring = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let applies = 0
  rt.applyModel = async bot => {
    if (++applies === 2) {
      restoring.resolve()
      await release.promise
    }
    select(bot.model, bot.effort)
    bot.appliedModel = bot.model
    bot.appliedEffort = bot.effort
  }
  ctx.sessionTitle = { rename: async () => { throw new Error('title refused') } }
  const update = rt.updateBot('m1', { model: picked, effort: 'high', name: 'ada' })
  const refused = assert.rejects(update, /title refused/)
  await restoring.promise
  const during = await poll(call, before)
  assert.equal(botOf(during).model, saved)
  noRunning(botOf(during))
  assert.equal(rt.pickingModel('m1'), true)
  release.resolve()
  await refused
  assert.equal(applies, 2)
  assert.equal(rt.pickingModel('m1'), false)
  const after = await poll(call, during)
  assert.equal(botOf(after).model, saved)
  assert.equal(botOf(after).runningModel, saved)
  assert.equal(botOf(after).runningEffort, 'low')
})

test('a route handoff hides the old selection while switchingChat is true', async t => {
  const { call, rt, select } = start(t)
  const before = await call('state')
  // Stand in for the handoff job while its old part writes the note.
  let switching = true
  rt.switchingChat = id => id === 'm1' && switching
  rt.botOf('m1').model = routeModel
  assert.equal(rt.switchingChat('m1'), true)
  const during = await poll(call, before)
  assert.equal(botOf(during).model, routeModel)
  noRunning(botOf(during))
  assert.equal(rt.pickingModel('m1'), false)
  switching = false
  select(routeModel, 'high')
  const after = await poll(call, during)
  assert.equal(botOf(after).model, routeModel)
  assert.equal(botOf(after).runningModel, routeModel)
  assert.equal(botOf(after).runningEffort, 'high')
})

for (const refuse of [false, true]) {
  test(`an empty-chat route pick hides running fields on ${refuse ? 'refusal' : 'success'}`,
    async t => {
      const { call, rt, select } = start(t)
      const before = await call('state')
      const held = holdApply(t, rt, select, { refuse })
      const update = rt.switchRoute('m1', routeModel, 'high')
      const outcome = refuse ? assert.rejects(update, /selection refused/) : update
      await held.entered
      const during = await poll(call, before)
      assert.equal(botOf(during).model, routeModel)
      assert.equal(botOf(during).effort, 'high')
      noRunning(botOf(during))
      assert.equal(rt.pickingModel('m1'), true)
      assert.equal(rt.switchingChat('m1'), false)
      held.release()
      const result = await outcome
      if (!refuse) assert.equal(result.status, 'switched')
      assert.equal(rt.pickingModel('m1'), false)
      const after = await poll(call, during)
      assert.equal(botOf(after).model, refuse ? saved : routeModel)
      assert.equal(botOf(after).runningModel, botOf(after).model)
      assert.equal(botOf(after).runningEffort, refuse ? 'low' : 'high')
    })
}

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-switch.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// Keep hook slots across polls and settle synchronous effects before returning the row.
function noticeHarness() {
  const slots = []
  let cursor = 0
  let dirty = false
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    require: name => {
      if (name === 'react') return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        Fragment: 'Fragment', useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useRef: initial => slots[cursor++] ??= { current: initial },
        useState: initial => {
          const slot = slots[cursor++] ??= { value: initial }
          return [slot.value, update => {
            slot.value = typeof update === 'function' ? update(slot.value) : update
            dirty = true
          }]
        },
        useEffect: (effect, deps) => {
          const index = cursor++
          const previous = slots[index]
          if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
            slots[index] = deps
            effect()
          }
        },
        useMemo: fn => fn(), useCallback: fn => fn,
      }
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw new Error(`Unexpected platform module ${name}`)
    },
  })
  return (model, runningModel) => {
    const roster = {
      byId: { 'part-current': {
        id: 'm1', sessionId: 'part-current', name: 'Test Bot', model,
        ...(runningModel === undefined ? {} : { runningModel }),
      } },
      models: [],
    }
    let dock
    do {
      cursor = 0
      dirty = false
      dock = module.exports.ModelSwitchNotice({
        sessionId: 'part-current', useRoster: pick => pick(roster),
      })
    } while (dirty)
    return dock
  }
}

const rowOf = dock => dock.children[1]
const saidOf = dock => dock.children[0].children[0]

test('the notice stays silent through a pick and announces a later real fallback', () => {
  const render = noticeHarness()
  for (const [model, running] of [[saved, saved], [picked, undefined], [picked, picked]]) {
    const dock = render(model, running)
    assert.equal(rowOf(dock), null)
    assert.equal(dock.children[0].props.role, 'status')
    assert.equal(saidOf(dock), '')
  }
  // The first actual mismatch still starts at one pulse after all three readings.
  const switched = render(picked, fallback)
  assert.equal(rowOf(switched).props.key, 1)
  assert.equal(rowOf(switched).props['data-fresh'], '')
  assert.equal(saidOf(switched), 'This chat is running on fallback instead of picked.')
})

test('a refused pick keeps the fallback row key without a new status or pulse', () => {
  const render = noticeHarness()
  render(saved, saved)
  const first = render(saved, fallback)
  assert.equal(saidOf(first), 'This chat is running on fallback instead of saved.')
  rowOf(first).props.onAnimationEnd()
  const shown = render(saved, fallback)
  assert.equal(rowOf(shown).props['data-fresh'], undefined)
  const during = render(picked, undefined)
  assert.equal(rowOf(during), null)
  assert.equal(saidOf(during), saidOf(shown))
  const after = render(saved, fallback)
  assert.equal(rowOf(after).props.key, rowOf(shown).props.key)
  assert.equal(rowOf(after).props['data-fresh'], undefined)
  assert.equal(saidOf(after), saidOf(shown))
})
