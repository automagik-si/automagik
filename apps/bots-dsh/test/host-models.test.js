// A Bot whose model menu its plugin owns (rt.hooks.botModels, host-models.js): the menu comes
// from the plugin only, only the person picks, and the team never selects a DSH model for it.
// Without a registration the team answers exactly as before.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { cleanMenu } from '../src/host/host-models.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const home = mkdtempSync(join(tmpdir(), 'omni-host-models-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['m1'], revision: 1,
    bots: {
      m1: { id: 'm1', name: 'Omni', role: 'Orchestrator', instructions: '', createdAt: 1 },
      u1: { id: 'u1', name: 'Unfold', role: 'Unfold, inside DSH', instructions: '', createdAt: 2, kind: 'unfold', model: 'luna/gpt-5.6', appliedModel: 'luna/gpt-5.6' },
    },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const ctx = fakeContext()
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt: ctx.provided.get('omniTeam'), call, stop }
}

const MENU = {
  entries: [
    { id: 'granite', label: 'Granite 4.1 3B', group: 'Unfold', privacy: { kind: 'local', device: 'Mac' }, answering: true },
    { id: 'deepseek', label: 'DeepSeek V4.1 Flash', group: 'Unfold', current: true, privacy: { kind: 'direct', provider: 'DeepSeek', memories: true }, levels: [{ id: 'auto', name: 'Auto' }, { id: 'off', name: 'Off' }] },
  ],
  level: 'auto',
  status: { kind: 'after-reply' },
}

function fakeSource(menu = MENU) {
  const picks = []
  let refreshed = 0
  return {
    picks,
    refreshed: () => refreshed,
    snapshot: () => menu,
    async pick(bot, pick) { picks.push([bot.id, pick]) },
    async refresh() { refreshed += 1 },
  }
}

// The state answer without its live clock fields, which change between two reads.
const stable = (value) => {
  const { activity: _activity, work: _work, liveKey: _liveKey, ...rest } = value
  return JSON.stringify(rest)
}

test('without a registration the state answer is the same bytes, and a registration that goes leaves none', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  // The first read starts the chat index, which then gives each row its last time and preview: the answer
  // compared is the one after that has settled.
  await call('state')
  await new Promise(resolve => setTimeout(resolve, 20))
  const before = (await call('state')).value
  assert.equal('hostModels' in before, false)
  // A registration for a kind no Bot has adds nothing either.
  const offOther = rt.hooks.botModels('genie', fakeSource())
  assert.equal(stable((await call('state')).value), stable(before))
  offOther()
  const off = rt.hooks.botModels('unfold', fakeSource())
  assert.ok('hostModels' in (await call('state')).value)
  off()
  assert.equal(stable((await call('state')).value), stable(before))
  assert.equal((await call('state', { since: before.revision, models: before.modelsKey })).value.hostModels, undefined)
})

test('the state carries the plugin\'s menu for its Bots, and opening a menu reads it again', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  const source = fakeSource()
  t.after(rt.hooks.botModels('unfold', source))
  const state = (await call('state')).value
  assert.deepEqual(Object.keys(state.hostModels), ['u1'])
  assert.deepEqual(state.hostModels.u1, cleanMenu(MENU))
  assert.equal(state.hostModels.u1.entries[1].current, true)
  // An unchanged answer carries it too: it is live, not part of the revision.
  assert.deepEqual((await call('state', { since: state.revision, models: state.modelsKey })).value.hostModels.u1, cleanMenu(MENU))
  await call('models')
  assert.equal(source.refreshed(), 1)
})

test('the person\'s pick goes to the plugin; a Bot\'s is refused; no DSH model is selected', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  const source = fakeSource()
  t.after(rt.hooks.botModels('unfold', source))
  assert.equal((await call('update-bot', { id: 'u1', model: 'granite' })).ok, true)
  assert.equal((await call('update-bot', { id: 'u1', effort: 'off' })).ok, true)
  assert.equal((await call('update-bot', { id: 'u1', model: 'openai/gpt', ack: true })).ok, true)
  assert.deepEqual(source.picks, [['u1', { id: 'granite' }], ['u1', { effort: 'off' }], ['u1', { id: 'openai/gpt', ack: true }]])
  // The saved DSH model is left as it was: the pick is the plugin's.
  assert.equal(rt.botOf('u1').model, 'luna/gpt-5.6')
  await assert.rejects(rt.updateBot('u1', { model: 'granite' }, 'm1'), /Only the user picks the model Unfold answers with/)
  await assert.rejects(rt.updateBot('u1', { name: 'Other', effort: 'off' }, 'm1'), /Only the user/)
  assert.equal(rt.botOf('u1').name, 'Unfold')
  assert.equal(source.picks.length, 3)
  // The fake context has no session controller: a selection would throw.
  assert.equal(await rt.desiredModel(rt.botOf('u1')), undefined)
  assert.equal(await rt.applyModel(rt.botOf('u1'), { force: true }), undefined)
})

test('a plugin\'s failed pick reaches the person as the refusal', async (t) => {
  const { rt, call, stop } = start()
  t.after(stop)
  t.after(rt.hooks.botModels('unfold', { snapshot: () => MENU, pick: async () => { throw new Error('That model is not offered right now') } }))
  const answer = await call('update-bot', { id: 'u1', model: 'granite' })
  assert.equal(answer.ok, false)
  assert.match(answer.error.message, /not offered/)
})

test('a kind is served by one plugin, and a source needs snapshot and pick', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  const off = rt.hooks.botModels('unfold', fakeSource())
  assert.throws(() => rt.hooks.botModels('unfold', fakeSource()), /already served/)
  assert.throws(() => rt.hooks.botModels('other', { snapshot: () => MENU }), /snapshot\(\) and pick\(\)/)
  assert.throws(() => rt.hooks.botModels('', fakeSource()), /Bot kind/)
  off()
  rt.hooks.botModels('unfold', fakeSource())()
})

test('the menu the browser gets keeps the documented fields only', () => {
  assert.deepEqual(cleanMenu(undefined), { entries: [], loading: true })
  assert.deepEqual(cleanMenu({
    entries: [
      { id: ' a ', label: 'A', secret: 'x', current: 'yes', levels: [{ id: 'low' }, { name: 'no id' }], privacy: { kind: 'elsewhere' } },
      { label: 'no id' },
      { id: 'b', privacy: { kind: 'relay', provider: 'ChatGPT', via: 'Unfold Automagik', memories: 'no', token: 't' }, confirm: true, answering: true },
    ],
    level: 7,
    status: { kind: 'later', answering: 'Granite' },
    error: '',
    key: 'k',
  }), {
    entries: [
      { id: 'a', label: 'A', levels: [{ id: 'low', name: 'low' }] },
      { id: 'b', label: 'b', privacy: { kind: 'relay', provider: 'ChatGPT', via: 'Unfold Automagik' }, confirm: true, answering: true },
    ],
  })
})

test('list_bots names what a host-owned Bot answers with, never its saved DSH model', async (t) => {
  const { rt, stop } = start()
  t.after(stop)
  t.after(rt.hooks.botModels('unfold', fakeSource()))
  await rt.load()
  const listBots = rt.ctx.registeredTools.get('list_bots')
  const text = await listBots.execute({}, { agent: { id: 'm1' } })
  const line = text.split('\n').find(row => row.startsWith('- Unfold'))
  assert.match(line, /answers with Granite 4\.1 3B/)
  assert.doesNotMatch(text, /luna|gpt-5\.6/)
  assert.equal(rt.hostAnsweringOf(rt.botOf('u1')), 'Granite 4.1 3B')
  assert.equal(rt.hostAnsweringOf(rt.botOf('m1')), undefined)
})
