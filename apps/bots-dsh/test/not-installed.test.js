// A Bot of a crew kind (omni, genie, unfold) is run by its own plugin, so it is live only
// while that plugin is installed in this DSH. Without it the saved Bot is not an idle Bot:
// the team says it is not installed, why, and a Main Bot cannot send it work.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { KIND_PLUGINS } from '../src/host/installed.js'
import { BOT_KINDS } from '../src/host/roster.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Orchestrator', instructions: 'Lead the team.', createdAt: 1 },
    genie: { id: 'genie', name: 'Genie', kind: 'genie', instructions: 'Grants wishes.', createdAt: 2 },
    omni: { id: 'omni', name: 'Omni Channels', kind: 'omni', instructions: 'Keeps the channels.', createdAt: 3 },
    writer: { id: 'writer', name: 'Writer', instructions: 'Writes.', createdAt: 4 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  views: {},
  prefs: {},
  revision: 0,
}

const GENIE = '@automagik/genie-dsh'
const OMNI = '@automagik/omni-channels-dsh'

function start({ bundles = [], home: givenHome } = {}) {
  const home = givenHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-not-installed-'))
  if (givenHome === undefined) writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const pluginManager = { listBundles: async () => bundles }
  const ctx = fakeContext({ services: { pluginManager } })
  Object.assign(ctx, {
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
  })
  // The client channel's POST route, so a test can read the same view the sidebar draws.
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  const listBots = async (agent = 'chief') => ctx.registeredTools.get('list_bots').execute({}, { agent: { id: agent } })
  const message = (args, agent = 'chief') => ctx.registeredTools.get('message_bot').execute(args, { agent: { id: agent } })
  const spaceBots = async () => (await rt.spaceReads.read('space-bots', {}, async () => ({ ok: false }))).items
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  return {
    rt,
    listBots,
    message,
    spaceBots,
    call,
    bundles,
    home,
    dispose: async () => { await ctx.dispose() },
    stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) },
  }
}

// The `now:` line right under one Bot in list_bots.
function nowLine(output, name) {
  const lines = output.split('\n')
  const at = lines.findIndex(line => line.startsWith(`- ${name}`))
  assert.notEqual(at, -1, `${name} is in the list`)
  assert.match(lines[at + 1] ?? '', /^ {2}now: /, `${name} has a now line`)
  return lines[at + 1].slice('  now: '.length)
}

test('a Bot whose plugin is missing is not idle, in list_bots and in the space reads', async (t) => {
  const { listBots, spaceBots, stop } = start({ bundles: [] })
  t.after(stop)
  const output = await listBots()
  assert.equal(nowLine(output, 'Genie'), `not installed (the ${GENIE} plugin is missing from this DSH)`)
  assert.equal(nowLine(output, 'Omni Channels'), `not installed (the ${OMNI} plugin is missing from this DSH)`)
  // A Bot with no crew kind is a plain DSH Bot and keeps its idle line.
  assert.equal(nowLine(output, 'Writer'), 'idle')
  const rows = await spaceBots()
  const genie = rows.find(row => row.id === 'genie')
  assert.equal(genie.status, 'not-installed')
  assert.equal(genie.reason, `the ${GENIE} plugin is missing from this DSH`)
  assert.equal(rows.find(row => row.id === 'writer').status, 'idle')
})

test('a crew Bot whose plugin is missing carries that in the client view', async (t) => {
  const { call, stop } = start({ bundles: [] })
  t.after(stop)
  const view = (await call('state', {})).value
  const genie = view.bots.find(row => row.id === 'genie')
  assert.equal(genie.installed, false)
  assert.equal(genie.reason, `the ${GENIE} plugin is missing from this DSH`)
  // A plain DSH Bot is not run by a crew plugin and stays installed.
  assert.equal(view.bots.find(row => row.id === 'writer').installed, true)
})

// The client applies a full view unless it is the one it already drew (index.js pull): a new
// revision or a new modelsKey. installationKey() rides in modelsKey, so a changed installation
// is a new view even when the team's revision and the models did not move.
const applies = (value, known) => value.unchanged !== true && !(value.revision === known.revision && value.modelsKey === known.modelsKey)

test('a plugin installed after a window polled is a new view that window applies', async (t) => {
  const { bundles, call, rt, stop } = start({ bundles: [] })
  t.after(stop)
  const before = (await call('state', {})).value
  assert.equal(before.bots.find(bot => bot.id === 'genie').installed, false)
  bundles.push({ name: GENIE, availability: 'profile', enabled: true }, { name: OMNI, availability: 'profile', enabled: true })
  await rt.refreshInstallation({ force: true })
  const after = (await call('state', { since: before.revision, models: before.modelsKey })).value
  assert.equal(applies(after, before), true, 'the client applies the new roster')
  assert.notEqual(after.modelsKey, before.modelsKey)
  assert.equal(after.bots.find(bot => bot.id === 'genie').installed, true)
  assert.equal(after.bots.find(bot => bot.id === 'genie').reason, undefined)
})

test('one installation change reaches every open window, not only the first poll', async (t) => {
  const { bundles, call, rt, stop } = start({ bundles: [] })
  t.after(stop)
  const windowA = (await call('state', {})).value
  const windowB = (await call('state', { since: windowA.revision, models: windowA.modelsKey })).value
  assert.equal(windowB.unchanged, true, 'both windows start on the same answer')
  bundles.push({ name: GENIE, availability: 'profile', enabled: true }, { name: OMNI, availability: 'profile', enabled: true })
  await rt.refreshInstallation({ force: true })
  // Each window polls with the modelsKey it knows, as the client does. An unchanged answer
  // carries no modelsKey, so the roster keeps the one from the last full view: windowA's.
  const a = (await call('state', { since: windowA.revision, models: windowA.modelsKey })).value
  const b = (await call('state', { since: windowB.revision, models: windowA.modelsKey })).value
  for (const [name, view] of [['A', a], ['B', b]]) {
    assert.equal(applies(view, windowA), true, `window ${name} applies the change`)
    assert.notEqual(view.modelsKey, windowA.modelsKey, `window ${name} sees a new modelsKey`)
    assert.equal(view.bots.find(bot => bot.id === 'genie').installed, true)
  }
})

test('a window open before a host restart applies an installation change the new host reports', async (t) => {
  const first = start({ bundles: [] })
  const before = (await first.call('state', {})).value
  await first.dispose()
  const second = start({ bundles: [{ name: GENIE, availability: 'profile', enabled: true }, { name: OMNI, availability: 'profile', enabled: true }], home: first.home })
  t.after(async () => { await second.stop() })
  const after = (await second.call('state', { since: before.revision, models: before.modelsKey })).value
  assert.equal(applies(after, before), true, 'the restarted host catches the window up')
  assert.notEqual(after.modelsKey, before.modelsKey)
  assert.equal(after.bots.find(bot => bot.id === 'genie').installed, true)
  // The same installation after another restart is not a new view: only a real change is.
  await second.dispose()
  const third = start({ bundles: second.bundles, home: second.home })
  t.after(async () => { await third.stop() })
  const steady = (await third.call('state', { since: after.revision, models: after.modelsKey })).value
  assert.equal(steady.unchanged, true)
})

test('a crew Bot of a plugin that is installed and on still reports as before', async (t) => {
  const { listBots, spaceBots, stop } = start({
    bundles: [
      { name: GENIE, availability: 'profile', enabled: true },
      { name: OMNI, availability: 'profile', enabled: true },
    ],
  })
  t.after(stop)
  const output = await listBots()
  assert.equal(nowLine(output, 'Genie'), 'idle')
  assert.equal(nowLine(output, 'Omni Channels'), 'idle')
  assert.equal((await spaceBots()).find(row => row.id === 'genie').status, 'idle')
})

test('a crew plugin that is switched off says so', async (t) => {
  const { listBots, stop } = start({ bundles: [{ name: GENIE, availability: 'profile', enabled: false }] })
  t.after(stop)
  assert.equal(nowLine(await listBots(), 'Genie'), `not installed (the ${GENIE} plugin is switched off in this DSH)`)
})

test('a crew plugin DSH could not load is not installed either', async (t) => {
  const { listBots, stop } = start({ bundles: [{ name: GENIE, availability: 'profile', enabled: true, error: { code: 'incompatible-version' } }] })
  t.after(stop)
  assert.equal(nowLine(await listBots(), 'Genie'), `not installed (the ${GENIE} plugin did not load in this DSH (incompatible-version))`)
})

test('a Main Bot cannot send work to a Bot that is not installed', async (t) => {
  const { message, stop } = start({ bundles: [] })
  t.after(stop)
  const result = await message({ to: 'Genie', message: 'Build the thing.' })
  // Since #1447 a refusal is the host's object, so the chat tells it from a delivery.
  assert.equal(typeof result, 'object')
  assert.equal(result.sent, false)
  assert.equal(result.text,
    `Not sent: Genie is not installed in this DSH (the ${GENIE} plugin is missing from this DSH). Ask the user to install it before giving it work.`)
  assert.equal(result.reason, result.text)
})

test('without a plugin manager the team answers as it always did', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-not-installed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  apply(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const output = await ctx.registeredTools.get('list_bots').execute({}, { agent: { id: 'chief' } })
  assert.equal(nowLine(output, 'Genie'), 'idle')
})

test('every crew kind names the plugin that runs it', () => {
  assert.deepEqual(Object.keys(KIND_PLUGINS).sort(), [...BOT_KINDS].sort())
})
