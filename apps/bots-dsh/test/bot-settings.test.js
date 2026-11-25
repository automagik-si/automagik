import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { SOLVER_SHAPES } from '../src/client/characters.js'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/bot-settings.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useCallback: fn => fn,
  useRef: current => ({ current }), useId: () => 'id', Fragment: Symbol('Fragment'),
  // The settings page reads stores (the pets') through this since v0.3.6.
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { BotSettingsForm } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}
function settings(bot, { main = false, rooms = [] } = {}) {
  const roster = { mainBotIds: main ? [bot.id] : [], mainBotId: main ? bot.id : null, rooms, models: [], memory: false }
  return walk(BotSettingsForm({ bot, roster, actions: {}, run: fn => fn }))
}
const bot = { id: 'b', name: 'Writer', role: 'Writer', instructions: '', capabilities: [] }

test('task grants are separate switches and a route grant can always be cleared', () => {
  const pin = { id: 'tasker', version: '1.0.0', attachedAt: '2026-11-24' }
  const calls = []
  const roster = {
    bots: [bot],
    roles: { tasker: { version: pin.version, status: 'ok' } },
    roleRuntime: { [bot.id]: { pin, settings: [], tools: [], capabilities: ['task-start', 'route-policy'] } },
  }
  const switches = grants => {
    const record = { ...bot, reviewGuard: true, roles: [{ ...pin, grants }] }
    const form = walk(BotSettingsForm({ bot: record, roster, actions: { grantRole: (...args) => calls.push(args) }, run: value => value }))
    const card = form.find(node => node.type?.name === 'PackageAttachmentCard')
    const controls = walk(card.type(card.props)).find(node => node.type?.name === 'RoleControls')
    return walk(controls.type(controls.props)).filter(node => node.type?.name === 'SwitchRow').map(node => node.props)
  }
  const [start, route] = switches([])
  assert.equal(start.label, 'Allow starting tasks')
  assert.equal(start.hint, 'Tasks require the review guard to be off.')
  assert.equal(start.disabled, false)
  assert.equal(route.disabled, true)
  assert.equal(switches(['task-start'])[1].disabled, false)
  const enabled = switches(['route-policy'])[1]
  assert.equal(enabled.disabled, false)
  enabled.onChange(false)
  assert.deepEqual(calls.map(([id, , capability, on]) => [id, capability, on]), [[bot.id, 'route-policy', false]])
})

test('the role picker serves team Bots, keeps Description, and follows the current role', () => {
  const record = { id: 'role-fixture', name: 'Bot', role: 'Description' }
  const calls = []
  const actions = {
    attachRole: (...args) => calls.push(['attach', ...args]),
    detachRole: (...args) => calls.push(['detach', ...args]),
  }
  const form = (bot, roster) => walk(BotSettingsForm({ bot, roster, actions, run: result => result }))
  const picker = tree => tree.find(node => node.type?.name === 'Segmented' && node.props.label === 'Role')
  const tagged = tree => tree.some(node => node.props?.className === 'bt-tag' && node.props.children.includes('Genie'))
  const tree = form(record, { bots: [record] })
  assert.equal(tree.find(node => node.type?.name === 'InlineText' && node.props.label === 'Description').props.value, record.role)
  const [none, genie] = picker(tree).props.children
  assert.equal(none.props['aria-pressed'], true)
  assert.equal(genie.props['aria-pressed'], false)
  assert.equal(genie.props.disabled, true)
  assert.equal(genie.props.title, 'Genie can be given to another Bot after the next Genie update.')
  assert.equal(tagged(tree), false)

  const attached = { ...record, kind: 'genie' }
  const attachedTree = form(attached, { byId: { [record.id]: attached } })
  assert.equal(tagged(attachedTree), true)
  assert.equal(picker(attachedTree).props.children[1].props['aria-pressed'], true)
  picker(attachedTree).props.children[0].props.onClick()
  const detached = { ...attached, roles: [] }
  const detachedTree = form(detached, { bots: [detached] })
  assert.equal(tagged(detachedTree), false)
  assert.equal(picker(detachedTree).props.children[0].props['aria-pressed'], true)
  picker(detachedTree).props.children[1].props.onClick()
  assert.deepEqual(calls, [['detach', record.id], ['attach', record.id, 'genie']])
  for (const roster of [undefined, { bots: [] }, { bots: [attached], prefs: { roles: false } }]) {
    const hidden = form(attached, roster)
    assert.equal(picker(hidden), undefined)
    assert.equal(tagged(hidden), false)
  }
})

test('the Private switch is enabled only for a state the host accepts', () => {
  const noFolder = settings(bot).find(node => node.props?.label === 'Private')
  assert.equal(noFolder.props.disabled, true)
  assert.equal(noFolder.props.hint, 'Choose a working folder of its own first.')

  const grouped = settings({ ...bot, workDir: '/work' }, { rooms: [{ id: 'r', members: ['b'] }] }).find(node => node.props?.label === 'Private')
  assert.equal(grouped.props.disabled, true)
  assert.equal(grouped.props.hint, 'Leave its group chats before making it private.')

  const main = settings({ ...bot, workDir: '/work' }, { main: true }).find(node => node.props?.label === 'Private')
  assert.equal(main.props.disabled, true)
  assert.equal(main.props.hint, 'A Main Bot cannot be private.')

  const allowed = settings({ ...bot, workDir: '/work' }).find(node => node.props?.label === 'Private')
  assert.equal(allowed.props.disabled, false)
  assert.equal(allowed.props.on, false)
})

test('a private Bot can always turn privacy off, and cannot become Main or be duplicated', () => {
  const tree = settings({ ...bot, workDir: '/work', private: true })
  const privacy = tree.find(node => node.props?.label === 'Private')
  assert.equal(privacy.props.on, true)
  assert.equal(privacy.props.disabled, false)
  assert.equal(tree.find(node => node.props?.label === 'Main Bot').props.disabled, true)
  assert.equal(tree.some(node => node.props?.onClick && node.props.className === 'bt-set-row bt-bs-row' && JSON.stringify(node).includes('Duplicate')), false)
})

test('the Shell switch shows what shell access reaches and saves the capability', () => {
  const sentence = 'A Bot with shell access can read what the operating-system user can read.'
  const on = settings(bot).find(node => node.props?.label === 'Shell access')
  assert.equal(on.props.on, true)
  assert.equal(on.props.hint, sentence)
  assert.equal(on.props.disabled, undefined)
  const off = settings({ ...bot, shell: false }).find(node => node.props?.label === 'Shell access')
  assert.equal(off.props.on, false)
  assert.equal(off.props.hint, sentence)
  // The card says where the fence lives: the tool grant, not an operating-system sandbox.
  const notes = settings(bot).filter(node => node.props?.className === 'bt-bs-shell-note')
    .map(node => [].concat(node.props.children).join(''))
  assert.ok(notes.includes('The Bot team enforces this at the tool grant: it removes the tools; '
    + 'it does not put a shell in an operating-system sandbox.'))
  // The named limit a person can act on: another Bot or the OS user is not fenced by this.
  assert.ok(notes.includes("This removes this Bot's own shell tools; it does not stop another Bot "
    + 'with a shell, or the operating-system user, from reading files this Bot can read.'))

  const calls = []
  const roster = { mainBotIds: [], mainBotId: null, rooms: [], models: [], memory: false }
  const tree = walk(BotSettingsForm({
    bot,
    roster,
    actions: { updateBot: (id, patch) => { calls.push({ id, patch }); return Promise.resolve() } },
    run: fn => fn,
  }))
  tree.find(node => node.props?.label === 'Shell access').props.onChange(false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'b')
  assert.equal(calls[0].patch.shell, false)
})

test('the package picker uses IDs, refuses a replacement, and preserves rollback Detach', () => {
  const calls = []
  const actions = {
    attachRole: (...args) => calls.push(['attach', ...args]),
    detachRole: (...args) => calls.push(['detach', ...args]),
  }
  const record = { id: 'fixture', name: 'Fixture' }
  const version = '1.0.0'
  const roles = Object.fromEntries(['constructor', 'another-role', 'unconfirmed'].map(id => [id, { id, version, status: 'ok' }]))
  const roleDetails = Object.fromEntries(Object.keys(roles).map(id => [id, { installed: {
    attachable: id !== 'unconfirmed', verified: true, version, sha256: 'a'.repeat(64), name: 'Genie',
    tools: ['fixture_tool'], capabilities: ['audio-out'],
  } }]))
  const myPin = { id: 'constructor', version, attachedAt: '2026-11-20', grants: [] }
  const form = (bot, prefs = {}, bots = [bot]) => walk(BotSettingsForm({ bot, roster: { bots, roles, roleDetails, prefs }, actions, run: value => value }))
  const picker = tree => tree.find(node => node.props?.role === 'group' && node.props['aria-label'] === 'Role')
  const [none, genie, first, second, unconfirmed] = picker(form(record)).props.children
  assert.equal(none.props['aria-pressed'], true)
  assert.equal(genie.props.disabled, true)
  assert.equal(first.props.children[0], second.props.children[0])
  assert.match(unconfirmed.props.title, /source cannot be confirmed/)
  first.props.onClick()
  second.props.onClick()
  unconfirmed.props.onClick()
  const attached = { ...record, kind: 'genie', roles: [myPin] }
  const current = form(attached)
  const buttons = picker(current).props.children
  assert.equal(buttons[1].props['aria-pressed'], false)
  assert.equal(buttons[1].props.title, 'Detach Genie first.')
  assert.equal(buttons[2].props['aria-pressed'], true)
  assert.equal(buttons[3].props.disabled, true)
  assert.equal(buttons[3].props.title, 'Detach Genie first.')
  assert.equal(picker(form({ ...record, kind: 'genie' })).props.children[2].props.title, 'Choose None first.')
  const card = tree => tree.find(node => node.type?.name === 'PackageAttachmentCard')
  const off = form({ ...attached, roles: [{ id: 'constructor' }] }, { roles: false })
  assert.equal(picker(off), undefined)
  assert.equal(off.some(node => node.props?.className === 'bt-tag'), false)
  const rollback = card(off)
  assert.equal(rollback.props.recoveryId, 'constructor')
  assert.equal(rollback.props.pin, undefined)
  walk(rollback.type(rollback.props)).find(node => node.type === 'button' && node.props.children.includes('Detach')).props.onClick()
  const seat = form({ ...attached, id: 'seat:fixture' }, {}, [record])
  assert.equal(picker(seat), undefined)
  assert.equal(card(seat), undefined)
  assert.equal(seat.some(node => node.props?.className === 'bt-tag'), false)
  assert.deepEqual(calls, [['attach', record.id, 'constructor'], ['attach', record.id, 'another-role'], ['detach', record.id]])
})

test('the attached role card keeps the exact pin and the recovery action for every health', () => {
  const pin = { id: 'sample-role', version: '1.0.0', attachedAt: '', grants: [] }
  const attached = { id: 'fixture', name: 'Fixture', roles: [pin] }
  for (const [record, expected] of [
    [undefined, 'Missing'],
    [{ version: pin.version, status: 'broken' }, 'Broken'],
    [{ version: pin.version, status: 'damaged' }, 'Damaged'],
    [{ version: '2.0.0', status: 'ok' }, 'Version mismatch'],
  ]) {
    const roster = { bots: [attached], roles: record ? { [pin.id]: record } : {} }
    const form = BotSettingsForm({ bot: attached, roster, actions: {}, run: value => value })
    const selected = walk(form).find(node => node.props?.['aria-pressed'] && node.props.children.includes(pin.id))
    assert.ok(selected)
    const card = walk(form).find(node => node.type?.name === 'PackageAttachmentCard')
    const rows = walk(card.type(card.props))
    assert.ok(rows.some(node => node.props.label === 'sample-role@1.0.0' && node.props.hint === expected))
    assert.ok(rows.some(node => node.props.hint === 'Detach it from every Bot, uninstall, then install again.'))
    assert.ok(rows.some(node => node.type === 'button' && node.props.children.includes('Detach') && !node.props.disabled))
  }
})

test('settings renders a verified package name literally in its tag', () => {
  const id = 'fixture-role'
  const pin = { id, version: '1.0.0', attachedAt: '', grants: [] }
  const member = { id: 'fixture', name: 'Fixture', roles: [pin] }
  const roster = { bots: [member], roles: { [id]: { id, version: pin.version, status: 'ok' } },
    roleDetails: { [id]: { installed: { version: pin.version, sha256: 'a'.repeat(64),
      verified: true, attachable: true, name: '<Catalog fixture>', tools: [], capabilities: [] } } } }
  const tags = walk(BotSettingsForm({ bot: member, roster, actions: {}, run: value => value }))
    .filter(node => node.props?.className === 'bt-tag')
  assert.deepEqual(tags.map(node => node.props.children[0]), ['<Catalog fixture>'])
})

// #2048 (parity): a refused Antigravity model offers Sign in, which opens its row in this Bot's chat.
test('Bot settings: Sign in for an Antigravity model opens its sign-in row', () => {
  const saved = react.useState
  let given = false
  // The first null state of the form is the model's pending sign-in (bot-settings.js `signIn`).
  react.useState = (initial) => {
    if (initial === null && !given) { given = true; return ['acp-antigravity/default', () => {}] }
    return saved(initial)
  }
  const opened = []
  let tree
  try {
    tree = walk(BotSettingsForm({ bot: { ...bot, model: 'acp-antigravity/default' }, roster: { models: [] }, actions: { openCliLogin: (...args) => opened.push(args) }, run: fn => fn }))
  } finally { react.useState = saved }
  const button = tree.find(node => node.type === 'button' && node.props.children.includes('Sign in'))
  assert.ok(button)
  button.props.onClick()
  assert.deepEqual(opened, [['b', 'acp-antigravity', 'acp-antigravity/default']])
})

test('the new-Bot card\'s character grid offers the 21 characters and no Solver', () => {
  const { CharacterGrid } = module.exports
  const SOLVERS = ['Puff', 'Sprout', 'Cap', 'Bell', 'Cloud', 'Spike', 'Floppy', 'Antenna', 'Cactus', 'Bulb', 'Chick', 'Frog']
  const draw = shape => CharacterGrid({ look: { shape, color: 'red' }, onShape() {}, onColor() {} })
  const tree = draw('moon')
  // The characters, then the colors: no heading and no second group.
  assert.deepEqual(tree.props.children.map(part => part.props.className), ['bt-shapes', 'bt-colors'])
  const rowsOf = grid => grid.props.children[0].props.children.map(row => row.props.children.map(button => button.props.title))
  assert.deepEqual(rowsOf(tree).map(row => row.length), [6, 6, 6, 3])
  const titles = rowsOf(tree).flat()
  assert.equal(titles.length, 21)
  assert.deepEqual(titles.filter(title => SOLVERS.includes(title)), [])
  assert.ok(!walk(tree).some(node => node.props?.children?.includes?.('Solvers')))
  assert.equal(walk(tree).filter(node => node.props?.className === 'bt-shape').length, 21)
  // A stored shape the grid does not list still gets its tile, the 22nd.
  assert.deepEqual(rowsOf(draw('nope')).map(row => row.length), [6, 6, 6, 4])
})

test('an explicit grid list is authoritative and the worn shape stays outside it', () => {
  const shapes = Object.freeze([...SOLVER_SHAPES])
  const grid = module.exports.CharacterGrid({ shapes, look: { shape: 'moon', color: 'red' } })
  const tiles = walk(grid).filter(node => node.props?.className === 'bt-shape')
  assert.deepEqual(tiles.map(tile => tile.props.key), SOLVER_SHAPES)
  assert.deepEqual(shapes, SOLVER_SHAPES)
})
