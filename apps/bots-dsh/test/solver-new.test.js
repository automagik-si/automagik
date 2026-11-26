// The New Solver dialog (RFC 0048, delivery 1), rendered with a stand-in React: what Create calls
// and in which order, what a failure deletes and says, the native tick, the reviewer list, and
// the palette command that opens it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOLVER_SHAPES } from '../src/client/characters.js'
import { solverPayload } from '../src/client/solver-draft.js'
import { solverInstructions } from '../src/shared/solver-method.js'
import { fixture, serviceStub } from './caller-fixture.js'
import { refusedSolverAgent, serve } from './fixtures/solver-agent-catalog.mjs'
import { NewSolver, CommandPalette, ModelMenu, settingsModelPicker, teamActions, mount, all, text, settle, plain } from './fixtures/solver-dialog.mjs'
import { until } from './until.js'

const CLAUDE = 'acp-claude/default'
const FLASH = 'deepseek/deepseek-v4-flash'
const CODEX = 'acp-codex/gpt-5.6'
const KEPT = 'acp-codex/gpt-5.6-kept'
const OMP = 'acp-omp/default'
const AGY = 'acp-antigravity/default'
const HERMES = 'hermes-remote/attach'
const MODELS = [CLAUDE, FLASH, CODEX, KEPT, OMP, AGY, HERMES].map(ref => ({ ref, name: ref }))
const rosterOf = (extra = {}) => {
  const bots = extra.bots ?? [{ id: 'ann', name: 'Ann', model: CODEX }, { id: 'boss', name: 'Boss', model: FLASH }]
  return {
    bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])), mainBotIds: ['boss'], models: MODELS,
    defaultModel: FLASH, prefs: {}, permissions: null, newBotPermission: null,
    nativeToolsNew: plain({ [CLAUDE]: null, [FLASH]: null, [CODEX]: null, [KEPT]: 'model-kept', [OMP]: null, [AGY]: null, [HERMES]: null }),
    ...extra,
  }
}

// The person's actions, recorded in order. `fail` maps a step to the error it throws:
// reviewer (the first create-bot), solver (the second), native, send; `deleteFails` per id;
// `fresh`: the view teamState answers, or an error it throws.
function fakeActions({ fail = {}, deleteFails = {}, fresh } = {}) {
  const calls = []
  let creates = 0
  const actions = {
    calls,
    closeOverlay: () => calls.push(['closeOverlay']),
    installRole: async id => { calls.push(['installRole', id]); if (fail.install) throw fail.install; return { id, version: '1.0.0' } },
    attachRole: async (id, role) => { calls.push(['attachRole', id, role]); if (fail.attach) throw fail.attach; return [role] },
    createBot: async (payload) => {
      creates += 1
      const step = payload.role === 'Reviewer' ? 'reviewer' : 'solver'
      calls.push(['createBot', plain(payload)])
      if (fail[step]) throw fail[step]
      return { id: step === 'reviewer' ? 'r-new' : 's-new', name: step === 'reviewer' ? `${payload.name} 7` : payload.name, n: creates }
    },
    updateBot: async (id, patch) => { calls.push(['updateBot', id, plain(patch)]); if (fail.native) throw fail.native },
    send: async (id, value) => { calls.push(['send', id, value]); if (fail.send) throw fail.send },
    deleteBot: async (id) => { calls.push(['deleteBot', id]); if (deleteFails[id]) throw deleteFails[id] },
    teamState: async () => {
      calls.push(['teamState'])
      if (fresh instanceof Error || fresh?.code) throw fresh
      return fresh ?? { bots: [] }
    },
    pets: async () => [],
    folderProbe: async () => null,
  }
  return actions
}
const refusal = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })

const dialog = ({ roster = rosterOf(), actions = fakeActions(), brief = 'Compare two libraries', sectionId = 'sec1' } = {}) => {
  const created = []
  const view = mount(NewSolver, { roster, actions, brief, sectionId, canGoBack: true, onBack: () => {}, onCreated: bot => created.push(bot) })
  const tree = () => view.render()
  const find = check => all(tree(), check)
  const ui = {
    view, created, actions, tree,
    go: () => find(node => node.type === 'button' && String(node.props.className).includes('bt-create-go'))[0],
    select: () => find(node => node.type === 'select')[0],
    // The native tick by its label: the Review guard tick (#2056 D1.5) is another checkbox.
    tick: () => find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === 'Native tools')[0],
    guard: () => find(node => node.type === 'input' && node.props.type === 'checkbox' && node.props['aria-label'] === 'Hold work until the reviewer answers the plan')[0],
    modelMenu: id => find(node => node.props?.bot?.id === id && typeof node.props.onPick === 'function')[0],
    folder: () => find(node => node.type?.name === 'FolderMenu')[0],
    alert: () => text(find(node => node.props?.role === 'alert')),
    notes: () => find(node => node.props?.role === 'status').map(text),
    text: () => text(tree()),
    async create() {
      ui.go().props.onClick()
      await settle()
    },
    choose(key) { ui.select().props.onChange({ target: { value: key } }) },
    pickModel(ref) { ui.modelMenu('new-bot').props.onPick(ref) },
    looks() {
      const picker = find(node => node.type?.name === 'CharacterGrid')[0]
      return picker ? picker.type(picker.props) : null
    },
    tickNative(on = true) { ui.tick().props.onChange({ target: { checked: on } }) },
  }
  tree()
  return ui
}
const kinds = calls => calls.map(call => call[0])

test('New Solver shows the twelve character tiles and one row of twelve swatches', () => {
  const tree = dialog().looks()
  const tiles = all(tree, node => node.props.className === 'bt-shape')
  assert.deepEqual(tiles.map(tile => tile.props.key), SOLVER_SHAPES)
  const groups = all(tree, node => node.props.className === 'bt-colors')
  assert.equal(groups.length, 1)
  assert.equal(all(groups[0], node => node.props.className === 'bt-color').length, 12)
})

test('New Solver creates with the picked character and swatch', async () => {
  const ui = dialog()
  const tile = (key) => all(ui.looks(), node => node.props.className === 'bt-shape' && node.props.key === key)[0]
  // Move off Frog if the random start chose it.
  if (tile('frog')?.props['aria-pressed']) tile('puff').props.onClick()
  tile('frog').props.onClick()
  all(ui.looks(), node => node.props.className === 'bt-color' && node.props.key === 'aurora')[0].props.onClick()
  await ui.create()
  const solver = ui.actions.calls.find(([kind, payload]) => kind === 'createBot' && payload.role === 'Solver')[1]
  assert.deepEqual(solver.avatar, { shape: 'frog' })
  assert.equal(solver.color, 'aurora')
})

test('Create makes the reviewer, then the Solver with its real name, then native tools alone, then the brief', async () => {
  const ui = dialog()
  ui.folder().props.onPick('/work/repo')
  assert.equal(ui.folder().props.value, '/work/repo')
  ui.tickNative()
  assert.equal(ui.tick().props.checked, true)
  await ui.create()
  const { calls } = ui.actions
  assert.deepEqual(kinds(calls), ['installRole', 'createBot', 'createBot', 'attachRole', 'updateBot', 'send'])
  const [reviewer, solver] = [calls[1][1], calls[2][1]]
  assert.equal(reviewer.role, 'Reviewer')
  assert.equal(reviewer.name, 'Solver reviewer')
  assert.equal(reviewer.model, FLASH)
  assert.equal(reviewer.workDir, '/work/repo')
  assert.equal(reviewer.sectionId, undefined)
  assert.equal(solver.role, 'Solver')
  assert.equal(solver.model, CLAUDE)
  assert.equal(solver.sectionId, 'sec1')
  assert.equal(solver.workDir, '/work/repo')
  assert.equal(solver.brief, undefined)
  // The name the reviewer's create-bot returned, not the one the dialog asked for.
  assert.ok(solver.instructions.includes('Message "Solver reviewer 7" with message_bot FIRST for every review, plan and result alike (reply_to "me").'))
  assert.ok(solver.instructions.includes('ONLY when your reviewer fails or hangs (message_bot errors, or a reply says it could not answer), and the delivery quotes that failure.'))
  assert.doesNotMatch(solver.instructions, /no reviewer/i)
  assert.deepEqual(calls[4], ['updateBot', 's-new', { nativeTools: true }])
  assert.deepEqual(calls[5], ['send', 's-new', 'Compare two libraries'])
  assert.deepEqual(ui.created.map(bot => bot.id), ['s-new'])
})

// #2056: the host's "unreviewed" mark reads the reviewer's id, which only the dialog knows.
test('the Solver carries its reviewer Bot\'s id: the new reviewer\'s, an existing Bot\'s, none for a fresh session', async () => {
  const made = dialog()
  await made.create()
  assert.equal(made.actions.calls.find(([kind, payload]) => kind === 'createBot' && payload.role === 'Solver')[1].reviewerId, 'r-new')
  const existing = dialog()
  existing.choose('bot:ann')
  await existing.create()
  assert.equal(existing.actions.calls.find(call => call[0] === 'createBot')[1].reviewerId, 'ann')
  const fresh = dialog()
  fresh.choose('fresh')
  await fresh.create()
  const solver = fresh.actions.calls.find(call => call[0] === 'createBot')[1]
  assert.equal(Object.hasOwn(solver, 'reviewerId'), false)
  assert.match(solver.instructions, /There is no reviewer Bot/)
})

test('unticked, the brief goes with the Solver and native tools are not touched', async () => {
  const ui = dialog()
  await ui.create()
  assert.deepEqual(kinds(ui.actions.calls), ['installRole', 'createBot', 'createBot', 'attachRole', 'send'])
  assert.equal(Object.hasOwn(ui.actions.calls[2][1], 'brief'), false)
  assert.deepEqual(ui.actions.calls[4], ['send', 's-new', 'Compare two libraries'])
})

test('a refused native switch deletes the Solver then the reviewer, and says nothing was created', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { native: refusal('Not available at the Read only level.') } }) })
  ui.tickNative()
  await ui.create()
  assert.deepEqual(ui.actions.calls.slice(5), [['deleteBot', 's-new'], ['deleteBot', 'r-new']])
  assert.equal(ui.alert(), 'Native tools could not be turned on, so nothing was created: Not available at the Read only level.')
  assert.deepEqual(ui.created, [])
})

test('a refused Solver deletes only the reviewer this run made', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { solver: refusal('No room') } }) })
  await ui.create()
  assert.deepEqual(ui.actions.calls.filter(call => call[0] === 'deleteBot'), [['deleteBot', 'r-new']])
  assert.equal(ui.alert(), 'Nothing was created: No room')
})

test('(1) an existing Bot as reviewer is never deleted, whichever step fails', async () => {
  for (const fail of [{ solver: refusal('No') }, { native: refusal('No') }]) {
    const ui = dialog({ actions: fakeActions({ fail }) })
    ui.choose('bot:ann')
    assert.equal(ui.select().props.value, 'bot:ann')
    ui.tickNative()
    await ui.create()
    assert.equal(ui.actions.calls.some(call => call[0] === 'deleteBot' && call[1] === 'ann'), false)
    assert.equal(ui.actions.calls.some(call => call[0] === 'createBot' && call[1].role === 'Reviewer'), false)
    const solver = ui.actions.calls.find(call => call[0] === 'createBot')[1]
    // An existing shared reviewer is named too, and asked first.
    assert.ok(solver.instructions.includes('Message "Ann" with message_bot FIRST for every review, plan and result alike (reply_to "me", when "queue").'))
    assert.ok(solver.instructions.includes('ONLY when your reviewer fails or hangs (message_bot errors, or a reply says it could not answer), and the delivery quotes that failure.'))
    assert.doesNotMatch(solver.instructions, /no reviewer/i)
    assert.match(ui.alert(), /nothing was created/i)
  }
})

test('(2) a refused reviewer deletes nothing and says nothing was created', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { reviewer: refusal('No reviewer') } }) })
  await ui.create()
  assert.deepEqual(kinds(ui.actions.calls), ['installRole', 'createBot'])
  assert.equal(ui.alert(), 'Nothing was created: No reviewer')
})

test('(3) a failed rollback delete: a fresh read without the Bot counts it removed; still listed, it is named', async () => {
  const unknown = { code: 'bot/refused', message: 'Unknown Bot' }
  const gone = dialog({ actions: fakeActions({ fail: { native: refusal('No') }, deleteFails: { 's-new': Object.assign(new Error(unknown.message), unknown) }, fresh: { bots: [{ id: 'ann' }] } }) })
  gone.tickNative()
  await gone.create()
  assert.ok(gone.actions.calls.some(call => call[0] === 'teamState'))
  assert.deepEqual(gone.notes(), [])
  assert.equal(gone.alert(), 'Native tools could not be turned on, so nothing was created: No')
  const kept = dialog({ actions: fakeActions({ fail: { native: refusal('No') }, deleteFails: { 's-new': refusal('Busy') }, fresh: { bots: [{ id: 's-new', name: 'Solver' }] } }) })
  kept.tickNative()
  await kept.create()
  assert.deepEqual(kept.notes(), ['Solver could not be removed after the failure. Delete it in its Details.'])
  assert.equal(kept.alert(), 'No')
  const notFound = dialog({ actions: fakeActions({ fail: { native: refusal('No') }, deleteFails: { 's-new': refusal('Gone', 'bot/not-found') } }) })
  notFound.tickNative()
  await notFound.create()
  assert.deepEqual(notFound.notes(), [])
  assert.match(notFound.alert(), /so nothing was created/)
})

test('(4) the fresh read is a real team action: one state read, no pull after it', async () => {
  const recorded = []
  let pulled = 0
  const actions = teamActions({ call: async (...args) => { recorded.push(args); return { bots: [] } }, after: (promise) => { pulled += 1; return promise }, partFor: id => id, roster: { getSnapshot: () => ({}) }, ui: { set() {} } })
  assert.equal(typeof actions.teamState, 'function')
  assert.deepEqual(plain(await actions.teamState()), { bots: [] })
  assert.deepEqual(plain(recorded), [['state', {}]])
  assert.equal(pulled, 0)
})

test('(4) an unknown outcome at the Solver names what may have been made, from a fresh read, and deletes nothing it did not make', async () => {
  const network = Object.assign(new Error('Could not reach DSH. Check that it is still running.'), { code: 'NETWORK' })
  // The dialog's roster is the one from before Create; the fresh read has the new Solver.
  const ui = dialog({ actions: fakeActions({ fail: { solver: network }, fresh: { bots: [{ id: 'ann', name: 'Ann' }, { id: 'boss', name: 'Boss' }, { id: 'r-new', name: 'Solver reviewer 7' }, { id: 'orphan', name: 'Solver' }] } }) })
  await ui.create()
  assert.deepEqual(ui.actions.calls.filter(call => call[0] === 'deleteBot'), [['deleteBot', 'r-new']])
  assert.deepEqual(ui.notes(), ['Solver may have been created. Check the sidebar and delete it in its Details if you do not want it.'])
  assert.equal(ui.alert(), 'Could not reach DSH. Check that it is still running.')
  assert.doesNotMatch(ui.text(), /Nothing was created/)
  // The read fails too: the planned Solver name, never silence.
  const blind = dialog({ actions: fakeActions({ fail: { solver: network }, fresh: Object.assign(new Error('down'), { code: 'NETWORK' }) }) })
  await blind.create()
  assert.deepEqual(blind.notes(), ['Solver may have been created. Check the sidebar and delete it in its Details if you do not want it.'])
  assert.doesNotMatch(blind.text(), /Nothing was created/)
})

test('(4) S2-1: an internal error answer and a failed read still name the planned Solver', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { solver: refusal('Internal error', 'bot/internal') }, fresh: Object.assign(new Error('restarting'), { code: 'HTTP_503' }) }) })
  await ui.create()
  assert.deepEqual(ui.notes(), ['Solver may have been created. Check the sidebar and delete it in its Details if you do not want it.'])
  assert.doesNotMatch(ui.text(), /Nothing was created/)
})

test('(4) S2-2: a changed viewer settles with no unhandled rejection and never says nothing was created', async () => {
  const retired = () => Object.assign(new Error('retired'), { code: 'bot/retired' })
  const actions = fakeActions({ fail: { solver: refusal('Another window', 'bot/viewer-changed') }, deleteFails: { 'r-new': retired() }, fresh: retired() })
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const ui = dialog({ actions })
    await ui.create()
    assert.deepEqual(unhandled, [])
    assert.doesNotMatch(ui.text(), /Nothing was created/)
    assert.equal(ui.go().props.disabled, false)
    assert.ok(ui.notes().includes('Solver may have been created. Check the sidebar and delete it in its Details if you do not want it.'))
  } finally { process.off('unhandledRejection', onUnhandled) }
})

test('a failed brief keeps both Bots and says the request was not sent', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { send: refusal('Busy') } }) })
  ui.tickNative()
  await ui.create()
  assert.equal(ui.actions.calls.some(call => call[0] === 'deleteBot'), false)
  assert.equal(ui.alert(), 'Solver was created, but your request was not sent: Busy')
  assert.equal(text(ui.go()), 'Done')
  ui.go().props.onClick()
  assert.deepEqual(ui.created.map(bot => bot.id), ['s-new'])
})

test('an unknown send outcome says the request may not have been sent', async () => {
  const network = Object.assign(new Error('Network down'), { code: 'NETWORK' })
  const ui = dialog({ actions: fakeActions({ fail: { send: network } }) })
  ui.tickNative()
  await ui.create()
  assert.equal(ui.actions.calls.some(call => call[0] === 'deleteBot'), false)
  assert.equal(ui.alert(), 'Solver was created, but your request may not have been sent: Network down')
  assert.equal(text(ui.go()), 'Done')
})

test('the reviewer model menu has no thinking level: a pick sends no update-bot', () => {
  const ui = dialog()
  const menu = ui.modelMenu('new-reviewer')
  assert.equal(menu.props.withEfforts, false)
  assert.equal(menu.props.onPickEffort, undefined)
  menu.props.onPick(CODEX)
  assert.equal(ui.modelMenu('new-reviewer').props.bot.model, CODEX)
  assert.deepEqual(ui.actions.calls, [])
})

test('the folder menu is the working-folder menu: a picked folder can go back to the team workspace', async () => {
  const ui = dialog()
  assert.ok(ui.folder())
  assert.equal(ui.folder().props.team, undefined)
  ui.folder().props.onPick('/work/repo')
  assert.equal(ui.folder().props.value, '/work/repo')
  ui.folder().props.onPick('')
  assert.equal(ui.folder().props.value, undefined)
  await ui.create()
  const creates = ui.actions.calls.filter(call => call[0] === 'createBot').map(call => call[1])
  assert.deepEqual(creates.map(payload => payload.role), ['Reviewer', 'Solver'])
  for (const payload of creates) assert.equal(Object.hasOwn(payload, 'workDir'), false, payload.role)
})

test('(6) the tick: hidden where Details has no switch, locked where it is locked, omp says it can only chat', () => {
  const ui = dialog()
  assert.ok(ui.tick())
  assert.equal(ui.tick().props.checked, false)
  assert.match(ui.text(), /Off by default\. The Solver also works without them, with its reviewer\./)
  for (const ref of [FLASH]) {
    ui.pickModel(ref)
    assert.equal(ui.tick(), undefined, ref)
  }
  ui.pickModel(AGY)
  assert.ok(ui.tick())
  assert.equal(ui.tick().props.disabled, false)
  assert.equal(ui.tick().props.checked, false)
  assert.match(ui.text(), /With this off, Antigravity has no tools at all in any of this Bot's chats, so this Bot can only chat\./)
  const unoffered = dialog({ roster: rosterOf({ nativeToolsNew: plain({ ...rosterOf().nativeToolsNew, [AGY]: 'unoffered' }) }) })
  unoffered.pickModel(AGY)
  assert.equal(unoffered.tick(), undefined)
  const multi = dialog({ roster: rosterOf({ bots: [], nativeToolsNew: plain({ [CLAUDE]: 'multiuser', [FLASH]: 'multiuser' }) }) })
  assert.equal(multi.tick(), undefined)
  ui.pickModel(KEPT)
  assert.equal(ui.tick().props.disabled, true)
  assert.equal(ui.tick().props.checked, false)
  assert.match(ui.text(), /This model can't turn its native tools off\./)
  assert.doesNotMatch(ui.text(), /Off by default/)
  ui.pickModel(OMP)
  assert.equal(ui.tick().props.disabled, false)
  assert.match(ui.text(), /With this off, omp has no tools at all in any of this Bot's chats, so this Bot can only chat\./)
  assert.doesNotMatch(ui.text(), /Off by default/)
  ui.pickModel(HERMES)
  assert.match(ui.text(), /This model uses its Hermes profile's own instructions\./)
  assert.equal(ui.go().props.disabled, true)
})

test('the Read only default locks the tick with its text; a read-only window cannot create', () => {
  const ro = dialog({ roster: rosterOf({ nativeToolsNew: plain({ [CLAUDE]: 'read-only', [FLASH]: null }) }) })
  assert.equal(ro.tick().props.disabled, true)
  assert.match(ro.text(), /Not available at the Read only level\./)
  ro.tickNative()
  assert.equal(ro.tick().props.checked, false)
  const window = dialog({ roster: rosterOf({ readOnly: 'Another host holds the team' }) })
  assert.equal(window.go().props.disabled, true)
})

test('the reviewer list has no None, and a single model leaves only the fresh session', () => {
  const ui = dialog()
  const options = all(ui.select(), node => node.type === 'option')
  assert.deepEqual(options.map(option => option.props.value), ['new', 'bot:ann', 'fresh'])
  assert.deepEqual(options.map(text), ['New reviewer on another model', 'Ann', 'Fresh session'])
  assert.equal(options.some(option => /none/i.test(text(option))), false)
  const alone = dialog({ roster: rosterOf({ bots: [], models: [{ ref: CLAUDE }] }) })
  assert.deepEqual(all(alone.select(), node => node.type === 'option').map(option => option.props.value), ['fresh'])
  assert.match(alone.text(), /No other model is set up, so reviews run in a fresh session\. Each review runs in a fresh session that sees only your request and the result\. The delivery says so\./)
  // The new reviewer's model menu ignores the Solver's own model.
  ui.modelMenu('new-reviewer').props.onPick(CLAUDE)
  assert.equal(ui.modelMenu('new-reviewer').props.bot.model, FLASH)
  ui.modelMenu('new-reviewer').props.onPick(CODEX)
  assert.equal(ui.modelMenu('new-reviewer').props.bot.model, CODEX)
})

test('the palette lists New Solver and opens its dialog', () => {
  const opened = []
  const actions = { openNewChat: mode => opened.push(mode), closePalette() {}, openSettings() {}, reportError() {} }
  const roster = { bots: [], rooms: [], agents: [], byId: {}, roomsById: {}, exchangeTurns: {} }
  const view = mount(CommandPalette, { start: 'solver', token: 1, roster, actions, useSessions: pick => pick({ byId: {} }) })
  const row = all(view.render(), node => node.props?.['data-flip'] === 'cmd:solver')[0]
  assert.ok(row, 'no New Solver command')
  assert.equal(text(row).includes('New Solver'), true)
  row.props.onClick()
  assert.deepEqual(opened, ['solver'])
})

// #2056 D1.5: the Review guard tick, sent with the Solver's own create-bot, only with a reviewer Bot.
test('the Review guard tick: on by default with a reviewer Bot, absent for a fresh session, sent in the Solver\'s own create', async () => {
  const made = dialog()
  assert.equal(made.guard().props.checked, true)
  assert.match(made.text(), /On by default\. You can turn it off later in Details\./)
  await made.create()
  const solver = made.actions.calls.filter(call => call[0] === 'createBot')[1][1]
  assert.equal(solver.reviewGuard, true)
  assert.equal(solver.reviewerId, 'r-new')
  const existing = dialog()
  existing.choose('bot:ann')
  assert.equal(existing.guard().props.checked, true)
  await existing.create()
  assert.equal(existing.actions.calls.find(call => call[0] === 'createBot')[1].reviewGuard, true)
  const fresh = dialog()
  fresh.choose('fresh')
  assert.equal(fresh.guard(), undefined)
  await fresh.create()
  assert.equal(Object.hasOwn(fresh.actions.calls.find(call => call[0] === 'createBot')[1], 'reviewGuard'), false)
  const unticked = dialog()
  unticked.guard().props.onChange({ target: { checked: false } })
  assert.equal(unticked.guard().props.checked, false)
  await unticked.create()
  assert.equal(Object.hasOwn(unticked.actions.calls.filter(call => call[0] === 'createBot')[1][1], 'reviewGuard'), false)
})

test('the Review guard tick stays on where the guard holds nothing, with the not-held line beside it', () => {
  const ui = dialog()
  ui.pickModel(CODEX)
  ui.tickNative()
  assert.equal(ui.guard().props.checked, true)
  assert.match(ui.text(), /Not held on this agent: its own tools run without asking\. Only the delivery mark shows unreviewed work\./)
  ui.pickModel(KEPT)
  assert.match(ui.text(), /Not held on this agent/)
  ui.pickModel(CLAUDE)
  ui.tickNative()
  assert.match(ui.text(), /Held only for the steps Claude Code asks about\./)
  ui.tickNative(false)
  assert.doesNotMatch(ui.text(), /Held only for the steps|Not held/)
})

test('the New Solver Auto switch defaults off and sends the setting with a fresh reviewer', async () => {
  const ui = dialog()
  const tick = () => all(ui.tree(), node => node.props?.['aria-label'] === 'Auto: work until delivered')[0]
  ui.choose('fresh')
  assert.equal(tick().props.checked, false)
  tick().props.onChange({ target: { checked: true } })
  await ui.create()
  assert.equal(ui.actions.calls.find(([kind, payload]) => kind === 'createBot' && payload.role === 'Solver')[1].solverAuto, true)
})

const K1 = 'If the Solver role is not installed yet, Create installs it first.'
const K4 = 'Roles are turned off for this team, so this Solver uses the written method.'

test('D2 F1 two Create clicks submit one Solver and one brief', async () => {
  const ui = dialog()
  const click = ui.go().props.onClick
  click()
  click()
  await settle()
  assert.equal(ui.actions.calls.filter(([action, payload]) => action === 'createBot' && payload.role === 'Solver').length, 1)
  assert.equal(ui.actions.calls.filter(([action]) => action === 'send').length, 1)
})

test('D2 F2 roles off hides K1, leaves Create available, and shows K4 with Done', async () => {
  assert.ok(dialog().text().includes(K1))
  assert.equal(dialog({ roster: rosterOf({ roles: { solver: { version: '1.0.0' } } }) }).text().includes(K1), false)
  const ui = dialog({ roster: rosterOf({ prefs: { roles: false }, roles: { solver: { version: '1.0.0' } } }) })
  assert.equal(ui.text().includes(K1), false)
  assert.equal(ui.go().props.disabled, false)
  await ui.create()
  assert.deepEqual(ui.notes(), [K4])
  assert.equal(text(ui.go()), 'Done')
  ui.go().props.onClick()
  assert.deepEqual(ui.created.map(bot => bot.id), ['s-new'])
})

test('D2 localized roles-off refusal during install or attach selects K4 by reason', async t => {
  const { call } = await import('../src/client/api.js')
  const { installLocale } = await import('../src/client/i18n.js')
  const message = 'Roles are turned off for this team.'
  const translated = '此团队已关闭角色。'
  const off = installLocale({
    register: () => () => {}, getLocale: () => ({ active: 'zh' }),
    bind: () => key => key === message ? translated : key,
  })
  t.after(off)
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    ok: false, error: { code: 'bot/refused', reason: 'roles-off', message, details: {} },
  }))
  for (const [endpoint, step] of [['role-install', 'install'], ['role-attach', 'attach']]) {
    let error
    await assert.rejects(call(endpoint, { id: 'solver' }), failure => {
      error = failure
      assert.equal(error.message, translated)
      assert.equal(error.reason, 'roles-off')
      return true
    })
    const ui = dialog({ actions: fakeActions({ fail: { [step]: error } }) })
    await ui.create()
    assert.deepEqual(ui.notes(), [K4])
    assert.equal(text(ui.go()), 'Done')
  }
})

test('D2 a role install or attach refusal shows its own status and Done keeps the Solver', async () => {
  const expected = [
    ['install', 'The Solver role could not be installed now, so this Solver uses the written method. The role is attached when it can be installed.'],
    ['attach', 'The Solver role could not be attached now, so this Solver uses the written method. The role is attached when it can be.'],
  ]
  for (const [step, status] of expected) {
    const ui = dialog({ actions: fakeActions({ fail: { [step]: refusal('Unavailable') } }) })
    await ui.create()
    assert.deepEqual(ui.notes(), [status])
    assert.equal(text(ui.go()), 'Done')
    assert.deepEqual(ui.created, [])
    assert.equal(ui.actions.calls.some(([action]) => action === 'deleteBot'), false)
    ui.go().props.onClick()
    assert.deepEqual(ui.created.map(bot => bot.id), ['s-new'])
  }
})

test('New Solver can create on every offered agent and model with an independent reviewer', async () => {
  const opus = 'acp-claude/claude-opus-5-5'
  const alias = 'acp-claude/opus'
  const rawAlias = 'acp-claude/haiku'
  const sonnet = 'acp-claude/sonnet'
  const nativeOpus = 'anthropic/claude-opus-5-5'
  const hermes = 'acp-hermes/vendor/model'
  const rows = [
    { ref: CLAUDE, solverRef: opus },
    { ref: alias, solverRef: opus },
    { ref: opus },
    { ref: rawAlias, solverRef: 'acp-claude/claude-haiku-5-5' },
    { ref: sonnet },
    ...[CODEX, AGY, OMP, FLASH, nativeOpus, hermes].map(ref => ({ ref })),
  ]
  const reviewer = { id: 'reviewer', name: 'Reviewer', model: nativeOpus }
  const roster = rosterOf({ bots: [reviewer], models: rows, prefs: { defaultBotModel: CLAUDE } })
  const rendered = dialog({ roster })
  assert.equal(rendered.modelMenu('new-bot').props.bot.model, CLAUDE)
  const offered = rows.filter(row => row.ref !== alias && row.ref !== AGY).map(row => row.ref)
  assert.deepEqual(rendered.modelMenu('new-bot').props.roster.models.map(row => row.ref), offered)
  rendered.pickModel(opus)
  assert.ok(rendered.modelMenu('new-reviewer').props.roster.models.some(row => row.ref === nativeOpus))
  for (const model of offered) {
    const ui = dialog({ roster })
    ui.pickModel(model)
    if (model !== nativeOpus) ui.choose('bot:reviewer')
    assert.equal(Boolean(ui.go().props.disabled), false, model)
    await ui.create()
    assert.equal(ui.actions.calls.find(([, payload]) => payload?.reviewerId)?.[1].model, model)
  }
})

function openAntigravity(menu) {
  const menuElement = menu.type(menu.props)
  const view = mount(menuElement.type, menuElement.props)
  const trigger = all(view.render(), node => node.type === 'button' && node.props['aria-haspopup'] === 'menu')[0]
  assert.ok(trigger)
  trigger.props.ref.current = { getBoundingClientRect: () => ({ top: 20, bottom: 50, width: 240, right: 260 }) }
  trigger.props.onClick({ detail: 1 })
  view.render() // the layout effect measures the anchor
  const steps = () => {
    const step = all(view.render(), node => node.type?.name === 'ModelSteps')[0]
    assert.ok(step)
    return step.type(step.props)
  }
  const acp = all(steps(), node => node.props.role === 'menuitem' && node.props['data-route'] === 'acp')[0]
  assert.ok(acp)
  acp.props.onClick()
  const agent = all(steps(), node => node.props.role === 'menuitem' && text(node).startsWith('Antigravity'))[0]
  assert.ok(agent)
  agent.props.onClick()
  const models = all(steps(), node => node.props.role === 'menuitemradio')
  assert.ok(models.length > 0, 'the agent row opens its model step')
  return { agent, models }
}

for (const native of [false, true]) {
  test(`T1 and T3 use the real Solver and reviewer menus with Native tools ${native ? 'on' : 'off'}`, () => {
    const lineup = [CLAUDE, CODEX, AGY].map(ref => ({ ref, reasoning: { efforts: [] } }))
    const ui = dialog({ roster: rosterOf({ models: lineup }) })
    ui.tickNative(native)
    assert.equal(ui.tick().props.checked, native)
    const own = ui.modelMenu('new-bot')
    const { agent, models } = openAntigravity(own)
    assert.match(text(agent), /Not available yet/)
    assert.deepEqual(plain(own.props.roster.models.map(row => row.ref)), [CLAUDE, CODEX])
    for (const model of models) {
      assert.equal(model.props['data-unavailable'], '')
      assert.match(text(model), /Not available yet/)
      model.props.onClick()
    }
    assert.equal(ui.modelMenu('new-bot').props.bot.model, CLAUDE)
    const reviewer = openAntigravity(ui.modelMenu('new-reviewer'))
    const pick = reviewer.models.find(row => row.props.title === AGY)
    assert.ok(pick)
    assert.equal(pick.props['data-unavailable'], undefined)
    pick.props.onClick()
    assert.equal(ui.modelMenu('new-reviewer').props.bot.model, AGY)
  })
}

test('T2 an Antigravity team default falls back to Codex', () => {
  const roster = models => rosterOf({ models: models.map(ref => ({ ref })), defaultModel: AGY, prefs: { defaultBotModel: AGY } })
  assert.equal(dialog({ roster: roster([AGY, CODEX]) }).modelMenu('new-bot').props.bot.model, CODEX)
})

test('AN-5 an Antigravity-only catalog leaves Create disabled', () => {
  const only = dialog({ roster: rosterOf({ models: [{ ref: AGY }], defaultModel: AGY }) })
  assert.equal(only.modelMenu('new-bot').props.bot.model, undefined)
  assert.equal(only.go().props.disabled, true)
})

test('T3 the existing pending row expands to unavailable models when an agent has no catalog rows', () => {
  const ui = dialog({ roster: rosterOf({ models: [{ ref: CLAUDE }] }) })
  const { agent, models } = openAntigravity(ui.modelMenu('new-bot'))
  assert.match(text(agent), /Not available yet/)
  assert.ok(models.every(row => row.props['data-unavailable'] === '' && row.props.title === undefined))
})

test('T4 an existing Antigravity reviewer remains a separate eligible choice', async () => {
  const roster = rosterOf({ bots: [{ id: 'reviewer', name: 'Antigravity Reviewer', model: AGY }] })
  const ui = dialog({ roster })
  assert.ok(ui.modelMenu('new-reviewer').props.roster.models.some(row => row.ref === AGY))
  assert.ok(all(ui.select(), node => node.type === 'option').some(row => row.props.value === 'bot:reviewer'))
  ui.choose('bot:reviewer')
  await ui.create()
  assert.deepEqual(ui.actions.calls.filter(([kind]) => kind === 'createBot').map(([, payload]) => [payload.model, payload.reviewerId]), [[CLAUDE, 'reviewer']])
})

test('T5 Claude Code and Codex remain offered and can be saved as Solvers', async () => {
  for (const ref of [CLAUDE, CODEX]) {
    const ui = dialog()
    assert.ok(ui.modelMenu('new-bot').props.roster.models.some(row => row.ref === ref))
    ui.pickModel(ref)
    await ui.create()
    assert.equal(ui.actions.calls.find(([, payload]) => payload?.role === 'Solver')[1].model, ref)
  }
})

for (const chat of [false, true]) {
  test(`Q1 existing Solver ${chat ? 'chat' : 'Settings'} keeps the pending Antigravity row in both Native tools states`, () => {
    const calls = []
    const actions = {
      switchRoute: (...args) => { calls.push(['settings', ...args]); return Promise.resolve() },
      switchRouteInChat: (...args) => { calls.push(['chat', ...args]); return Promise.resolve() },
    }
    const models = [CLAUDE, AGY].map(ref => ({ ref, reasoning: { efforts: [] } }))
    for (const nativeTools of [false, true]) {
      const bot = { id: 'saved', name: 'Saved Solver', role: 'Solver', model: CLAUDE, instructions: solverInstructions(), nativeTools }
      const roster = rosterOf({ bots: [bot], models })
      const run = promise => promise
      const props = chat ? { bot, roster, actions, run, chat } : settingsModelPicker({ bot, roster, actions, run })
      const pending = openAntigravity({ type: ModelMenu, props })
      assert.match(text(pending.agent), /Not available yet/)
      for (const row of pending.models) {
        assert.equal(row.props['data-unavailable'], '')
        row.props.onClick()
      }
    }
    assert.deepEqual(calls, [])
  })
}

test('AN-5 and AN-7 fake E2E saves a supported Solver linked to the Antigravity reviewer picked in the real menu', async t => {
  const f = fixture(t, { service: serviceStub({ multiuser: false }), seed: state => { state.prefs.roles = false } })
  serve(f.ctx, [CLAUDE, AGY, 'deepseek/v4'])
  await f.start()
  const call = async (endpoint, payload) => {
    const result = await f.call(endpoint, payload)
    if (!result.ok) throw refusal(result.error.message, result.error.code)
    return result.value
  }
  const actions = teamActions({ call, after: promise => promise })
  const roster = await actions.teamState()
  const ui = dialog({ roster, actions, brief: '', sectionId: null })
  const own = openAntigravity(ui.modelMenu('new-bot'))
  const reviewer = openAntigravity(ui.modelMenu('new-reviewer'))
  const offered = reviewer.models.find(row => row.props.title === AGY)
  assert.ok(offered, 'the reviewer has a selectable Antigravity model')
  offered.props.onClick()
  await ui.create()
  await until(() => text(ui.go()) !== 'Creating…', { t, label: 'fake host create to finish saving' })
  assert.equal(text(ui.go()), 'Done', ui.alert())
  ui.go().props.onClick()
  assert.equal(ui.created.length, 1)
  const solver = ui.created[0]
  assert.equal(Object.hasOwn(solver, 'waitingRole'), false)
  const before = f.saved().bots
  const saved = before[solver.id]
  assert.equal(saved.model, CLAUDE)
  assert.equal(saved.waitingRole.id, 'solver')
  assert.equal(before[saved.reviewerId].role, 'Reviewer')
  assert.equal(before[saved.reviewerId].model, AGY)
  assert.equal(f.created.length, 2)
  const { payload } = solverPayload({
    name: 'Stale Solver Fixture', look: { shape: 'frog', color: 'blue' }, model: AGY,
  })
  const stale = await f.call('create-bot', payload)
  assert.deepEqual({ hint: own.agent.props['data-unavailable'], stale }, {
    hint: '', stale: refusedSolverAgent,
  })
  assert.equal(f.created.length, 2)
  assert.deepEqual(f.saved().bots, before)
})

test('both New Solver pickers exclude equal identities and Create refuses a stale equal pick', () => {
  const alias = 'acp-claude/opus'
  const pin = 'acp-claude/claude-opus-5-5'
  const dated = 'anthropic/model-20261001'
  const datedLater = 'anthropic/model-20261101'
  const context = dated + '[1m]'
  const rows = [alias, pin, dated, datedLater, context, CODEX].map(ref => ({ ref }))
  for (const [solver, equal] of [[pin, alias], [dated, dated], [dated, context]]) {
    const ui = dialog({ roster: rosterOf({ bots: [{ id: 'reviewer', name: 'Reviewer', model: equal }], models: rows }) })
    ui.pickModel(CODEX)
    ui.choose('new')
    ui.modelMenu('new-reviewer').props.onPick(equal)
    ui.pickModel(solver)
    assert.ok(!ui.modelMenu('new-reviewer').props.roster.models.some(row => row.ref === equal))
    assert.ok(ui.modelMenu('new-reviewer').props.roster.models.some(row => row.ref === datedLater))
    assert.ok(!all(ui.tree(), node => node.type === 'option').some(node => node.props.value === 'bot:reviewer'))
    assert.equal(ui.go().props.disabled, true)
    assert.match(ui.text(), /Choose a different model for the reviewer/)
  }
})
