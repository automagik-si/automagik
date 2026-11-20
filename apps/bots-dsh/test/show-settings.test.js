import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { TEAM_LOOKUPS } from '../src/host/approvals.js'
import { SETTINGS_PAGES, SHOWABLE_PAGES, isShowablePage } from '../src/shared/settings-pages.js'
import { parseProposal } from '../src/shared/proposals.js'
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
  const run = name => (args, agentId) => {
    let concluded = false
    const exec = { agent: { id: agentId }, callId: `call-${agentId}`, concludeTurn: () => { concluded = true } }
    return rt.teamTools.find(d => d.name === name).execute(args, exec).then(text => ({ text, concluded }))
  }
  const show = run('show_settings')
  show.propose = run('propose_bot_change')
  show.rt = rt
  return show
}

test('show_settings and propose_bot_change are team tools that need no approval', () => {
  for (const name of ['show_settings', 'propose_bot_change']) {
    assert.ok(TEAM_TOOLS.includes(name), name)
    assert.ok(TEAM_LOOKUPS.has(name), `${name} changes nothing, so the person is not asked about it`)
  }
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

test('show_settings refuses the dialog-only Automations page', async t => {
  const show = start(t)
  const answer = await show({ page: 'automations' }, 'm1')
  assert.match(answer.text, /^No Settings page named "automations"\./)
  assert.equal(answer.concluded, false)
})

// propose_bot_change: a card with each field as it is and as it would be; nothing changes until
// the user presses Apply, so the tool only checks and resolves what the card will save.
test('a proposal is checked, carries only what changes, and changes nothing', async (t) => {
  const show = start(t)
  const before = JSON.stringify(show.rt.botOf('b2'))
  const asked = await show.propose({ role: 'Editor', name: 'Writer', instructions: '  Edit the drafts.  ', note: 'As you asked' }, 'b2')
  assert.equal(asked.concluded, false)
  assert.match(asked.text, /^Proposed for Writer: role, instructions\. The card is on screen; nothing changes until the user presses Apply\.\n/)
  assert.deepEqual(parseProposal(asked.text), { bot: 'b2', note: 'As you asked', change: { role: 'Editor', instructions: 'Edit the drafts.' } })
  assert.equal(JSON.stringify(show.rt.botOf('b2')), before, 'the Bot is unchanged')
})

test('a Main Bot proposes for another Bot; any other Bot only for itself', async (t) => {
  const show = start(t)
  assert.equal(parseProposal((await show.propose({ bot: 'writer', role: 'Editor' }, 'm1')).text)?.bot, 'b2')
  assert.match((await show.propose({ bot: 'Omni', role: 'Boss' }, 'b2')).text, /^Only a Main Bot can propose changes to another Bot/)
  assert.equal((await show.propose({ bot: 'Nobody', role: 'x' }, 'm1')).text, 'No Bot named Nobody.')
})

test('an empty, unchanged or bad proposal is refused, and so are groups and strangers', async (t) => {
  const show = start(t)
  assert.match((await show.propose({}, 'b2')).text, /^Propose at least one change/)
  assert.match((await show.propose({ deny_tools: ['bash'] }, 'b2')).text, /^Propose at least one change/, 'what only the user may set is no proposal')
  assert.equal((await show.propose({ name: 'Writer', role: 'Wr' }, 'b2')).text, 'Nothing to propose: Writer already has these settings.')
  assert.equal((await show.propose({ name: '   ' }, 'b2')).text, 'A name has 1 to 40 characters.')
  assert.match((await show.propose({ role: 'x'.repeat(25) }, 'b2')).text, /^A role label has 24 characters at most\./)
  assert.match((await show.propose({ model: ' ' }, 'b2')).text, /^Name the model to move to/)
  assert.match((await show.propose({ role: 'x', note: 'n'.repeat(201) }, 'b2')).text, /^Keep the note to one short line/)
  assert.match((await show.propose({ role: 'x' }, 'g-b2')).text, /^Proposal cards only work in your own chat/)
  assert.equal((await show.propose({ role: 'x' }, 'stranger')).text, 'Only Bots on the team can use propose_bot_change.')
})
