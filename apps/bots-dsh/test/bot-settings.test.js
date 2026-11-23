import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
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
const { BotSettingsForm, CharacterGrid } = module.exports

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

test('the character grid shows the Solvers as their own group, under a heading, starting a row', () => {
  const picked = []
  const tree = CharacterGrid({ look: { shape: 'cap', color: 'red' }, onShape: id => picked.push(id), onColor() {} })
  const parts = tree.props.children
  // The characters, the heading in the card's own group-label class, the Solvers, the colors.
  assert.deepEqual(parts.map(part => part.props.className), ['bt-shapes', 'bt-create-step', 'bt-shapes', 'bt-colors'])
  const rowsOf = group => group.props.children.map(row => row.props.children.map(button => button.props.title))
  const [first, heading, solvers] = parts
  assert.deepEqual(rowsOf(first).map(row => row.length), [6, 6, 6, 3])
  assert.deepEqual(rowsOf(first).flat().slice(0, 3), ['Whale', 'Octopus', 'Star'])
  assert.equal(rowsOf(first).flat().at(-1), 'Gem')
  assert.deepEqual(heading.props.children, ['Solvers'])
  assert.equal(solvers.props['aria-label'], 'Solvers')
  // Two full rows of six, in the catalogue's order: no Solver starts mid-row.
  assert.deepEqual(rowsOf(solvers), [['Puff', 'Sprout', 'Cap', 'Bell', 'Cloud', 'Spike'], ['Floppy', 'Antenna', 'Cactus', 'Bulb', 'Chick', 'Frog']])
  // The worn Solver is pressed in its own group and is not repeated among the others.
  const buttons = walk(tree).filter(node => node.props?.className === 'bt-shape')
  assert.equal(buttons.length, 33)
  assert.deepEqual(buttons.filter(button => button.props['aria-pressed']).map(button => button.props.title), ['Cap'])
  buttons.find(button => button.props.title === 'Frog').props.onClick()
  buttons.find(button => button.props.title === 'Gem').props.onClick()
  assert.deepEqual(picked, ['frog', 'gem'])
  // A stored shape the catalogue does not know still gets its tile, among the first group.
  const odd = CharacterGrid({ look: { shape: 'nope', color: 'red' }, onShape() {}, onColor() {} })
  assert.deepEqual(rowsOf(odd.props.children[0]).map(row => row.length), [6, 6, 6, 4])
  assert.deepEqual(rowsOf(odd.props.children[2]).map(row => row.length), [6, 6])
})
