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

function start({ bundles = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-not-installed-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
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
  assert.equal(await message({ to: 'Genie', message: 'Build the thing.' }),
    `Not sent: Genie is not installed in this DSH (the ${GENIE} plugin is missing from this DSH). Ask the user to install it before giving it work.`)
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
