import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { SOLVER_DESCRIPTION } from '../src/shared/solver-method.js'

const bundle = await build({
  stdin: { contents: "export * from './src/client/character-select.js'\nexport { lookOf } from './src/client/mark.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react', 'react-dom'],
})
const select = { exports: {} }
const react = { createElement: () => null, useEffect: () => {}, useLayoutEffect: () => {}, useMemo: f => f(), useRef: () => ({}), useState: v => [v, () => {}], Fragment: 'f' }
runInNewContext(bundle.outputFiles[0].text, { module: select, exports: select.exports, URLSearchParams, require: name => (name === 'react' ? react : { createPortal: x => x }) })
const { automagikRoster, currentKey, lookOf, solverRoster, solversFor, tileBeyond } = select.exports

test('Automagik\'s own come first: Genie, Omni, the logo pet, Wisp, then every character but the octopus Omni wears', () => {
  const roster = automagikRoster()
  assert.deepEqual([...roster.slice(0, 2).map(entry => entry.key)], ['pet:builtin:genie-clay', 'omni'])
  assert.equal(roster[2].key, 'pet:builtin:automagik')
  assert.equal(roster[2].name, 'Automagik')
  assert.equal(roster[2].kind, 'pet')
  assert.deepEqual(JSON.parse(JSON.stringify(roster[2].pet)), { source: 'builtin', id: 'automagik', name: 'Automagik', version: 2, sleep: true })
  assert.equal(new Set(roster.map(entry => entry.key)).size, roster.length)
  assert.ok(!roster.some(entry => entry.key === 'pet:builtin:unfold'))
  assert.equal(roster[3].key, 'pet:builtin:wisp')
  assert.ok(roster.slice(4).every(entry => entry.kind === 'shape'))
  assert.ok(!roster.some(entry => entry.key === 'shape:octopus'))
  assert.equal(roster.find(entry => entry.key === 'shape:gumdrop').name, 'Gumdrop')
})

const SOLVERS = ['puff', 'sprout', 'cap', 'bell', 'cloud', 'spike', 'floppy', 'antenna', 'cactus', 'bulb', 'chick', 'frog']

test('the Solvers have a section of their own: the twelve in order, none left in the Automagik section', () => {
  // Copied into this realm's arrays: the rosters come from the bundle's own context.
  const ours = [...automagikRoster()].filter(entry => entry.kind === 'shape')
  assert.equal(ours.length, 20)
  assert.deepEqual(ours.slice(0, 3).map(entry => entry.shape), ['whale', 'star', 'moon'])
  assert.equal(ours.at(-1).shape, 'gem')
  assert.ok(!ours.some(entry => SOLVERS.includes(entry.shape)))
  const solvers = [...solverRoster()]
  assert.deepEqual(solvers.map(entry => entry.shape), SOLVERS)
  assert.deepEqual(solvers.map(entry => entry.name), ['Puff', 'Sprout', 'Cap', 'Bell', 'Cloud', 'Spike', 'Floppy', 'Antenna', 'Cactus', 'Bulb', 'Chick', 'Frog'])
  assert.ok(solvers.every(entry => entry.kind === 'shape' && entry.key === `shape:${entry.shape}` && entry.line === 'Automagik character'))
  // One key per tile over both sections: the cursor and the worn mark find one tile.
  const keys = [...automagikRoster({ unfold: true }), ...solvers].map(entry => entry.key)
  assert.equal(new Set(keys).size, keys.length)
})

// The roster as the chooser lays it out: sections of tiles in rows of `columns`, each section
// starting a row under its heading.
function layout(sections, columns) {
  const boxes = []
  let top = 0
  for (const count of sections) {
    top += 26
    for (let index = 0; index < count; index += 1) boxes.push({ top: top + Math.floor(index / columns) * 96, left: (index % columns) * 96 })
    top += Math.ceil(count / columns) * 96 + 20
  }
  return boxes
}

test('Arrow Down and Up cross the section break by column, a short last row included', () => {
  // Automagik's 24 tiles then the twelve Solvers, seven to a row: Automagik's last row holds three.
  const boxes = layout([24, 12], 7)
  const down = at => tileBeyond(boxes, at, 1)
  const up = at => tileBeyond(boxes, at, -1)
  // Inside a section: one row down, same column.
  assert.equal(down(0), 7)
  assert.equal(up(7), 0)
  // Above the short row: the nearest tile of that row, not a tile of the next section.
  assert.equal(down(14), 21)
  assert.equal(down(15), 22)
  assert.equal(down(16), 23)
  assert.equal(down(19), 23)
  // From the short row into the Solvers: their first row, same column.
  assert.equal(down(21), 24)
  assert.equal(down(23), 26)
  // And back: the Solvers' first row goes up to the short row; a column past it takes its last tile.
  assert.equal(up(24), 21)
  assert.equal(up(26), 23)
  assert.equal(up(30), 23)
  // The Solvers' own rows: seven, then five.
  assert.equal(down(24), 31)
  assert.equal(down(30), 35)
  assert.equal(up(35), 28)
  // No row beyond: the cursor stays.
  assert.equal(up(3), -1)
  assert.equal(down(33), -1)
  assert.equal(tileBeyond(boxes, -1, 1), -1)
  // Six to a row, Automagik's 24 fill their rows: the Solvers start right under them.
  const even = layout([24, 12], 6)
  assert.equal(tileBeyond(even, 20, 1), 26)
  assert.equal(tileBeyond(even, 26, -1), 20)
})

test('the cursor starts on what the Bot wears now', () => {
  const key = bot => currentKey(bot, lookOf(bot))
  assert.equal(key({ id: 'b', avatar: { shape: 'star' } }), 'shape:star')
  assert.equal(key({ id: 'b', avatar: { shape: 'cactus' } }), 'shape:cactus')
  assert.equal(key({ id: 'b', color: 'deepseek', avatar: { shape: 'octopus' } }), 'omni')
  assert.equal(key({ id: 'g', kind: 'genie' }), 'pet:builtin:genie-clay')
  const saved = JSON.parse(JSON.stringify({ id: 'g', kind: 'genie', avatar: { pet: automagikRoster()[2].pet } }))
  assert.equal(key(saved), 'pet:builtin:automagik')
  assert.equal(key({ id: 'b', avatar: { pet: { source: 'team', id: 'sayo', version: 2 } } }), 'pet:team:sayo')
  assert.equal(key({ id: 'b', avatar: { image: 'data:image/png;base64,AA==' } }), 'photo')
})

test('only a Solver Bot is offered the Solvers: the marker is the description, exactly', () => {
  // Copied into this realm's arrays: the roster comes from the bundle's own context.
  assert.deepEqual([...solversFor({ id: 'b', role: SOLVER_DESCRIPTION })].map(entry => entry.shape), SOLVERS)
  for (const bot of [{}, { role: '' }, { role: 'Researcher' }, { role: 'solver' }, { role: 'Reviewer' }, { role: ' Solver' }, { role: 'Solver helper' }, null, undefined]) {
    assert.deepEqual([...solversFor(bot)], [], JSON.stringify(bot))
  }
  // A Bot that wears a Solver and is not a Solver Bot: no tile of its roster is the worn one.
  const writer = { id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'cactus' } }
  assert.equal(currentKey(writer, lookOf(writer)), 'shape:cactus')
  assert.ok(![...automagikRoster({ unfold: true }), ...solversFor(writer)].some(entry => entry.key === 'shape:cactus'))
})

// The chooser itself, drawn by a React that keeps state between draws and only builds the tree
// (effects never run; a component inside it is left as a node). `draw()` gives every node.
function chooser(bot) {
  const slots = []
  let at = 0
  const slot = (make) => { const index = at; at += 1; if (!(index in slots)) slots[index] = make(); return index }
  const stub = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState: (initial) => {
      const index = slot(() => (typeof initial === 'function' ? initial() : initial))
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef: current => slots[slot(() => ({ current }))],
    useMemo: make => make(), useEffect() {}, useLayoutEffect() {}, Fragment: 'fragment',
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, URLSearchParams, document: { body: {} }, setTimeout: () => 0, require: name => (name === 'react' ? stub : { createPortal: node => node }) })
  const saved = []
  const never = () => new Promise(() => {})
  const actions = { pets: never, avatarLibrary: never, petsBrowse: never, updateBot: (id, patch) => { saved.push(JSON.parse(JSON.stringify([id, patch]))); return never() } }
  const walk = (node, found = []) => {
    if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
    if (node === null || node === undefined || typeof node !== 'object') return found
    found.push(node)
    walk(node.props?.children, found)
    return found
  }
  const draw = () => { at = 0; return walk(module.exports.CharacterSelect({ bot, actions, run: promise => promise, onClose() {}, avatarImage: async () => '' })) }
  return { draw, saved }
}
const headings = nodes => nodes.filter(node => node.type === 'h3').map(node => node.props.children[0])
const tiles = nodes => nodes.filter(node => node.type === 'button' && node.props.className === 'bt-cs-tile')
const keysOf = nodes => tiles(nodes).map(tile => tile.props['data-key'])
const SOLVER_KEYS = SOLVERS.map(shape => `shape:${shape}`)
const stageName = nodes => nodes.find(node => node.props?.className === 'bt-cs-name').props.children[0]

test('a regular Bot\'s chooser draws no Solvers section and no Solver tile', () => {
  const nodes = chooser({ id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'moon' }, color: 'red' }).draw()
  assert.deepEqual(headings(nodes), ['Automagik', 'codex-pets.net'])
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), [])
  assert.equal(keysOf(nodes).length, 24)
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed']).map(tile => tile.props['data-key']), ['shape:moon'])
  assert.equal(stageName(nodes), 'Moon')
})

test('a Solver Bot\'s chooser draws the Solvers section: the heading, then exactly the twelve in order', () => {
  const nodes = chooser({ id: 'b', name: 'S', role: SOLVER_DESCRIPTION, avatar: { shape: 'moon' }, color: 'red' }).draw()
  assert.deepEqual(headings(nodes), ['Automagik', 'Solvers', 'codex-pets.net'])
  const section = nodes.find(node => node.type === 'section' && node.props.children[0]?.type === 'h3' && node.props.children[0].props.children[0] === 'Solvers')
  const [heading, grid] = section.props.children
  assert.equal(heading.props.className, 'bt-cs-label')
  assert.equal(grid.props.className, 'bt-cs-grid')
  assert.deepEqual(grid.props.children.map(tile => tile.props['data-key']), SOLVER_KEYS)
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), SOLVER_KEYS)
  assert.equal(keysOf(nodes).length, 36)
  // It wears one: that tile is the pressed one, and the stage shows it.
  const worn = chooser({ id: 'b', name: 'S', role: SOLVER_DESCRIPTION, avatar: { shape: 'cactus' }, color: 'red' }).draw()
  assert.deepEqual(tiles(worn).filter(tile => tile.props['aria-pressed']).map(tile => tile.props['data-key']), ['shape:cactus'])
  assert.equal(stageName(worn), 'Cactus')
})

test('a regular Bot that wears a Solver: no tile is pressed, and none of the Solvers is offered', () => {
  const nodes = chooser({ id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'cactus' }, color: 'red' }).draw()
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed'] === true), [])
  assert.deepEqual(headings(nodes), ['Automagik', 'codex-pets.net'])
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), [])
})

test('a regular Bot that wears a Solver opens on it, and Choose keeps the shape in the newly picked color', () => {
  const { draw, saved } = chooser({ id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'cactus' }, color: 'red' })
  let nodes = draw()
  // The stage shows the worn Solver, not the roster's first entry; its colors are offered.
  assert.equal(stageName(nodes), 'Cactus')
  const colors = () => nodes.filter(node => node.type === 'button' && node.props.className === 'bt-cs-color')
  assert.deepEqual(colors().filter(button => button.props['aria-pressed']).map(button => button.props['aria-label']), ['Red'])
  colors().find(button => button.props['aria-label'] === 'Blue').props.onClick()
  nodes = draw()
  assert.equal(stageName(nodes), 'Cactus')
  assert.deepEqual(colors().filter(button => button.props['aria-pressed']).map(button => button.props['aria-label']), ['Blue'])
  // Still no Solver to pick: the worn one is on the stage only.
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), [])
  assert.deepEqual(saved, [])
  const choose = nodes.find(node => node.type === 'button' && node.props.className === 'bt-cs-go')
  assert.ok(!choose.props.disabled)
  choose.props.onClick()
  // Same shape, new color: the look is kept, the color change is saved.
  assert.deepEqual(saved, [['b', { avatar: { shape: 'cactus' }, color: 'blue' }]])
})
