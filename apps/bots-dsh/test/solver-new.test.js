// The New Solver dialog (RFC 0048, delivery 1), rendered with a stand-in React: what Create calls
// and in which order, what a failure deletes and says, the native tick, the reviewer list, and
// the palette command that opens it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: [
    "export { NewSolver } from './src/client/solver-new.js'",
    "export { CommandPalette } from './src/client/palette.js'",
    "export { teamActions } from './src/client/team-actions.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/..' },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
let current
const slot = (make) => {
  const index = current.index++
  return current.slots[index] ??= make()
}
const effect = (make, deps) => {
  const cell = slot(() => ({}))
  if (!cell.deps || deps === undefined || deps.some((value, index) => value !== cell.deps[index])) {
    current.effects.push(() => { cell.stop?.(); cell.stop = make(); cell.deps = deps })
  }
}
const react = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  createContext: () => ({}),
  useState: (initial) => {
    const cell = slot(() => ({ value: typeof initial === 'function' ? initial() : initial }))
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
  },
  useRef: initial => slot(() => ({ current: initial })),
  useEffect: effect, useLayoutEffect: effect,
  useMemo: make => make(),
  useCallback: fn => fn,
  useContext: () => undefined,
  useSyncExternalStore: (_subscribe, get) => get(),
}
const module = { exports: {} }
const timers = []
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { FishLogo: 'fish', MarkdownText: () => null, writeClipboard: () => {} }
    throw new Error(`no platform module ${name}`)
  },
  window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { querySelector: () => null, documentElement: { addEventListener() {}, removeEventListener() {} }, addEventListener() {}, removeEventListener() {} },
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, performance: { now: () => 0 },
  setTimeout: (fn) => { timers.push(fn); return timers.length }, clearTimeout() {},
})
const { NewSolver, CommandPalette, teamActions } = module.exports

const mount = (Component, props) => {
  const instance = {
    slots: [], effects: [], props,
    render(next = instance.props) {
      instance.props = next
      instance.index = 0
      current = instance
      const out = Component(next)
      current = undefined
      for (const run of instance.effects.splice(0)) run()
      return out
    },
  }
  return instance
}
const all = (node, check) => {
  if (Array.isArray(node)) return node.flatMap(child => all(child, check))
  if (!node || typeof node !== 'object') return []
  return [...(check(node) ? [node] : []), ...all(node.props?.children, check)]
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object') return String(node ?? '')
  return text(node.props?.children)
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const settle = async () => { for (let index = 0; index < 20; index += 1) await tick() }
const plain = value => JSON.parse(JSON.stringify(value))

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
    tick: () => find(node => node.type === 'input' && node.props.type === 'checkbox')[0],
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
    tickNative(on = true) { ui.tick().props.onChange({ target: { checked: on } }) },
  }
  tree()
  return ui
}
const kinds = calls => calls.map(call => call[0])

test('Create makes the reviewer, then the Solver with its real name, then native tools alone, then the brief', async () => {
  const ui = dialog()
  ui.folder().props.onPick('/work/repo')
  assert.equal(ui.folder().props.value, '/work/repo')
  ui.tickNative()
  assert.equal(ui.tick().props.checked, true)
  await ui.create()
  const { calls } = ui.actions
  assert.deepEqual(kinds(calls), ['createBot', 'createBot', 'updateBot', 'send'])
  const [reviewer, solver] = [calls[0][1], calls[1][1]]
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
  assert.match(solver.instructions, /message_bot to "Solver reviewer 7" \(reply_to "me"\)\./)
  assert.deepEqual(calls[2], ['updateBot', 's-new', { nativeTools: true }])
  assert.deepEqual(calls[3], ['send', 's-new', 'Compare two libraries'])
  assert.deepEqual(ui.created.map(bot => bot.id), ['s-new'])
})

test('unticked, the brief goes with the Solver and native tools are not touched', async () => {
  const ui = dialog()
  await ui.create()
  assert.deepEqual(kinds(ui.actions.calls), ['createBot', 'createBot'])
  assert.equal(ui.actions.calls[1][1].brief, 'Compare two libraries')
})

test('a refused native switch deletes the Solver then the reviewer, and says nothing was created', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { native: refusal('Not available at the Read only level.') } }) })
  ui.tickNative()
  await ui.create()
  assert.deepEqual(ui.actions.calls.slice(3), [['deleteBot', 's-new'], ['deleteBot', 'r-new']])
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
    assert.match(solver.instructions, /message_bot to "Ann" \(reply_to "me", when "queue"\)/)
    assert.match(ui.alert(), /nothing was created/i)
  }
})

test('(2) a refused reviewer deletes nothing and says nothing was created', async () => {
  const ui = dialog({ actions: fakeActions({ fail: { reviewer: refusal('No reviewer') } }) })
  await ui.create()
  assert.deepEqual(kinds(ui.actions.calls), ['createBot'])
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
  for (const ref of [FLASH, AGY]) {
    ui.pickModel(ref)
    assert.equal(ui.tick(), undefined, ref)
  }
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
