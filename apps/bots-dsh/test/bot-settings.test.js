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


test('settings reads only the explicit type and saves type and terminal agent', () => {
  for (const native of [bot, { ...bot, agent: 'codex', model: 'acp-codex/default' }]) {
    assert.equal(settings(native).some(node => node.props?.title === 'Model'), true)
  }
  const updates = []
  const nodes = walk(BotSettingsForm({ bot: { ...bot, type: 'herdr', agent: 'codex', model: 'acp-codex/default' }, roster: { mainBotIds: [], rooms: [], models: [], memory: false }, actions: { updateBot: (id, patch) => updates.push([id, patch]) }, run: value => value }))
  assert.equal(nodes.some(node => node.props?.title === 'Model'), false, 'Herdr settings must have no model row')
  const fields = nodes.find(node => node.type?.name === 'BotTypeFields')
  assert.equal(fields.props.type, 'herdr')
  assert.equal(fields.props.agent, 'codex')
  fields.props.onAgent('claude')
  fields.props.onType('')
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [['b', { agent: 'claude' }], ['b', { type: null }]])
})
