import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { TEAM_LOOKUPS } from '../src/host/approvals.js'
import { SETTINGS_PAGES, SHOWABLE_PAGES, isShowablePage } from '../src/shared/settings-pages.js'
import { fakeContext } from './fake-ctx.js'

// show_settings opens a Settings page as a card in a Bot's own chat. It changes nothing, so
// the host only checks what the card will open and says nothing has changed yet.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Omni', role: 'Main', lab: 'deepseek', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Wr', lab: 'kimi', instructions: '', createdAt: 2 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Team', named: true, members: ['m1', 'b2'], admin: 'm1', mode: 'everyone', notice: '', sessions: { b2: 'g-b2' }, log: [] },
    r2: { id: 'r2', name: 'Twin', named: true, members: ['m1'], admin: 'm1', mode: 'everyone', notice: '', sessions: {}, log: [] },
    r3: { id: 'r3', name: 'Twin', named: true, members: ['m1'], admin: 'm1', mode: 'everyone', notice: '', sessions: {}, log: [] },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-show-settings-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services: { shellEnv: { register: () => () => {} } } })
  ctx.sessionController = { resolveAgent: async () => ({ agent: { session: {}, followup() {} } }) }
  ctx.sessions = { flush: async () => {} }
  ctx.workspaceRegistry = { archiveSession: async () => {} }
  ctx.llm.stream = () => (async function* () {})()
  ctx.connection.fetch.register = () => () => {}
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  return (args, agentId) => {
    let concluded = false
    const exec = { agent: { id: agentId }, callId: `call-${agentId}`, concludeTurn: () => { concluded = true } }
    return rt.teamTools.find(d => d.name === 'show_settings').execute(args, exec).then(text => ({ text, concluded }))
  }
}

test('show_settings is a team tool that needs no approval', () => {
  assert.ok(TEAM_TOOLS.includes('show_settings'))
  assert.ok(TEAM_LOOKUPS.has('show_settings'), 'it changes nothing, so the person is not asked about it')
})

test('every page the Settings dialog lists can be shown, and only those or a plugin page', () => {
  for (const [id] of SETTINGS_PAGES) assert.ok(isShowablePage(id), id)
  assert.ok(isShowablePage('hermes-remote'))
  assert.ok(isShowablePage('plugin:acp-agents'))
  for (const bad of ['', 'plugin:', 'plugin:../x', 'Bots', 'dsh', undefined, 7]) assert.equal(isShowablePage(bad), false, String(bad))
  assert.equal(new Set(SHOWABLE_PAGES).size, SHOWABLE_PAGES.length)
})

test('a Bot shows a page in its own chat without ending its turn', async (t) => {
  const show = start(t)
  const shown = await show({ page: 'computer', note: 'Pick a level for Writer' }, 'b2')
  assert.match(shown.text, /^Showing Settings → computer in the chat\. The user changes it there; nothing has changed yet\.$/)
  assert.equal(shown.concluded, false)
})

test('a Bot or a group named on its page is checked and named back', async (t) => {
  const show = start(t)
  assert.match((await show({ page: 'bots', bot: 'writer' }, 'm1')).text, /^Showing Settings → bots \(Writer\)/)
  assert.match((await show({ page: 'usage', bot: 'Omni' }, 'b2')).text, /^Showing Settings → usage \(Omni\)/)
  assert.match((await show({ page: 'groups', group: 'Team' }, 'm1')).text, /^Showing Settings → groups \(Team\)/)
  assert.equal((await show({ page: 'bots', bot: 'Nobody' }, 'm1')).text, 'No Bot named Nobody.')
  assert.equal((await show({ page: 'groups', group: 'Nowhere' }, 'm1')).text, 'No group chat named Nowhere.')
  assert.match((await show({ page: 'groups', group: 'Twin' }, 'm1')).text, /More than one group chat is named Twin/)
  assert.equal((await show({ page: 'computer', bot: 'Writer' }, 'm1')).text, 'Name a Bot only with page bots, schedules or usage.')
  assert.equal((await show({ page: 'bots', group: 'Team' }, 'm1')).text, 'Name a group only with page groups.')
})

test('an unknown page, a long note, a group Session and a stranger are refused', async (t) => {
  const show = start(t)
  assert.match((await show({ page: 'everything' }, 'm1')).text, /^No Settings page named "everything"\. Pick one of general, models, bots/)
  assert.match((await show({ page: 'general', note: 'x'.repeat(201) }, 'm1')).text, /^Keep the note to one short line/)
  assert.match((await show({ page: 'general' }, 'g-b2')).text, /^Settings cards only work in your own chat/)
  assert.equal((await show({ page: 'general' }, 'stranger')).text, 'Only Bots on the team can use show_settings.')
})
