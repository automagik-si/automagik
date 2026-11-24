import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { defaultShape, shapeOf } from '../src/client/characters.js'
import { SOLVER_DESCRIPTION, solverInstructions } from '../src/shared/solver-method.js'

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
  assert.equal(key({ id: 'b', avatar: { shape: 'cactus' } }), `shape:${defaultShape('b')}`)
  assert.equal(key({ id: 'b', color: 'deepseek', avatar: { shape: 'octopus' } }), 'omni')
  assert.equal(key({ id: 'g', kind: 'genie' }), 'pet:builtin:genie-clay')
  const saved = JSON.parse(JSON.stringify({ id: 'g', kind: 'genie', avatar: { pet: automagikRoster()[2].pet } }))
  assert.equal(key(saved), 'pet:builtin:automagik')
  assert.equal(key({ id: 'b', avatar: { pet: { source: 'team', id: 'sayo', version: 2 } } }), 'pet:team:sayo')
  assert.equal(key({ id: 'b', avatar: { image: 'data:image/png;base64,AA==' } }), 'photo')
})

test("only a Solver Bot is offered the Solvers: the marker is the Description plus the dialog's reviewer or method", () => {
  // Copied into this realm's arrays: the roster comes from the bundle's own context.
  assert.deepEqual([...solversFor({ id: 'b', role: SOLVER_DESCRIPTION })], [])
  assert.deepEqual([...solversFor({ role: SOLVER_DESCRIPTION, reviewerId: 'r' })].map(entry => entry.shape), SOLVERS)
  assert.deepEqual([...solversFor({ role: SOLVER_DESCRIPTION, instructions: solverInstructions() })].map(entry => entry.shape), SOLVERS)
  for (const bot of [{}, { role: '' }, { role: 'Researcher' }, { role: 'solver' }, { role: 'Reviewer' }, { role: ' Solver' }, { role: 'Solver helper' }, null, undefined]) {
    assert.deepEqual([...solversFor(bot)], [], JSON.stringify(bot))
  }
  // A Bot that wears a Solver and is not a Solver Bot: no tile of its roster is the worn one.
  const writer = { id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'cactus' } }
  assert.equal(currentKey(writer, lookOf(writer)), `shape:${defaultShape('b')}`)
  assert.ok(![...automagikRoster({ unfold: true }), ...solversFor(writer)].some(entry => entry.key === 'shape:cactus'))
})

// Keep hook state between draws and connect tile focus to the chooser's DOM handlers.
function chooser(bot) {
  const slots = []
  let at = 0
  let layoutEffect
  let mounted = false
  const slot = (make) => { const index = at; at += 1; if (!(index in slots)) slots[index] = make(); return index }
  const stub = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState: (initial) => {
      const index = slot(() => (typeof initial === 'function' ? initial() : initial))
      return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef: current => slots[slot(() => ({ current }))],
    useMemo: make => make(), useEffect() {}, useLayoutEffect: effect => { layoutEffect = effect }, Fragment: 'fragment',
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, URLSearchParams, document: { body: {} }, setTimeout: () => 0,
    CSS: { escape: value => value }, HTMLInputElement: class {}, HTMLSelectElement: class {},
    require: name => (name === 'react' ? stub : { createPortal: node => node }),
  })
  const saved = []
  const used = []
  const never = () => new Promise(() => {})
  const actions = {
    pets: never, avatarLibrary: never, petsBrowse: never,
    updateBot: (id, patch) => { saved.push(JSON.parse(JSON.stringify([id, patch]))); return never() },
    petUse: (...args) => { used.push(JSON.parse(JSON.stringify(args))); return never() },
  }
  const walk = (node, found = []) => {
    if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
    if (node === null || node === undefined || typeof node !== 'object') return found
    found.push(node)
    walk(node.props?.children, found)
    return found
  }
  const draw = (next = bot) => {
    bot = next
    at = 0
    const nodes = walk(module.exports.CharacterSelect({ bot, actions, run: promise => promise, onClose() {}, avatarImage: async () => '' }))
    const renderedTiles = tiles(nodes).map(tile => ({
      dataset: { key: tile.props['data-key'] },
      focus: () => tile.props.onFocus({ currentTarget: { matches: selector => selector === ':focus-visible' } }),
    }))
    nodes.find(node => node.props.className === 'bt-cs-scroll').props.ref.current = {
      querySelectorAll: () => renderedTiles,
      querySelector: selector => renderedTiles.find(tile => selector === `[data-key="${tile.dataset.key}"]`),
    }
    if (!mounted) {
      mounted = true
      layoutEffect()
    }
    return nodes
  }
  const key = (nodes, key, target = {}, modifiers = {}) => nodes[0].props.onKeyDown({ key, target, ...modifiers, preventDefault() {}, stopPropagation() {} })
  return { draw, key, saved, used }
}
const headings = nodes => nodes.filter(node => node.type === 'h3').map(node => node.props.children[0])
const tiles = nodes => nodes.filter(node => node.type === 'button' && node.props.className === 'bt-cs-tile')
const keysOf = nodes => tiles(nodes).map(tile => tile.props['data-key'])
const SOLVER_KEYS = SOLVERS.map(shape => `shape:${shape}`)
const stageName = nodes => nodes.find(node => node.props?.className === 'bt-cs-name').props.children[0]
const solverBot = { id: 'b', name: 'Fixture', role: SOLVER_DESCRIPTION, instructions: solverInstructions(), avatar: { shape: 'frog' }, color: 'red' }
const chooseButton = nodes => nodes.find(node => node.props.className === 'bt-cs-go')
const tileOf = (nodes, shape) => tiles(nodes).find(tile => tile.props['data-key'] === `shape:${shape}`)
const focusTile = (nodes, shape) => tileOf(nodes, shape).props.onFocus({ currentTarget: { matches: selector => selector === ':focus-visible' } })
const ordinaryDefault = shapeOf(defaultShape('b')).label

test('a regular Bot\'s chooser draws no Solvers section and no Solver tile', () => {
  const nodes = chooser({ id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'moon' }, color: 'red' }).draw()
  assert.deepEqual(headings(nodes), ['Automagik', 'codex-pets.net'])
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), [])
  assert.equal(keysOf(nodes).length, 24)
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed']).map(tile => tile.props['data-key']), ['shape:moon'])
  assert.equal(stageName(nodes), 'Moon')
})

test('a Solver Bot\'s chooser draws the Solvers section: the heading, then exactly the twelve in order', () => {
  const nodes = chooser({ ...solverBot, avatar: { shape: 'moon' } }).draw()
  assert.deepEqual(headings(nodes), ['Solvers'])
  const section = nodes.find(node => node.type === 'section' && node.props.children[0]?.type === 'h3' && node.props.children[0].props.children[0] === 'Solvers')
  const [heading, grid] = section.props.children
  assert.equal(heading.props.className, 'bt-cs-label')
  assert.equal(grid.props.className, 'bt-cs-grid')
  assert.deepEqual(grid.props.children.map(tile => tile.props['data-key']), SOLVER_KEYS)
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), SOLVER_KEYS)
  assert.equal(keysOf(nodes).length, 12)
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed']), [])
  assert.equal(stageName(nodes), 'Antenna')
  // It wears one: that tile is the pressed one, and the stage shows it.
  const worn = chooser({ ...solverBot, avatar: { shape: 'cactus' } }).draw()
  assert.deepEqual(tiles(worn).filter(tile => tile.props['aria-pressed']).map(tile => tile.props['data-key']), ['shape:cactus'])
  assert.equal(stageName(worn), 'Cactus')
})

test('a regular Bot that wears a Solver: no tile is pressed, and none of the Solvers is offered', () => {
  const nodes = chooser({ id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'cactus' }, color: 'red' }).draw()
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed'] === true), [])
  assert.deepEqual(headings(nodes), ['Automagik', 'codex-pets.net'])
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), [])
})

test('a regular Bot wearing a Solver character previews its ordinary default and Choose saves only the new color', () => {
  const { draw, saved } = chooser({ id: 'b', name: 'W', role: 'Writer', avatar: { shape: 'cactus' }, color: 'red' })
  let nodes = draw()
  assert.equal(stageName(nodes), ordinaryDefault)
  const colors = () => nodes.filter(node => node.type === 'button' && node.props.className === 'bt-cs-color')
  assert.deepEqual(colors().filter(button => button.props['aria-pressed']).map(button => button.props['aria-label']), ['Red'])
  colors().find(button => button.props['aria-label'] === 'Blue').props.onClick()
  nodes = draw()
  assert.equal(stageName(nodes), ordinaryDefault)
  assert.deepEqual(colors().filter(button => button.props['aria-pressed']).map(button => button.props['aria-label']), ['Blue'])
  // The stored Solver character is absent from the ordinary roster.
  assert.deepEqual(keysOf(nodes).filter(key => SOLVER_KEYS.includes(key)), [])
  assert.deepEqual(saved, [])
  const choose = nodes.find(node => node.type === 'button' && node.props.className === 'bt-cs-go')
  assert.ok(!choose.props.disabled)
  choose.props.onClick()
  assert.deepEqual(saved, [['b', { color: 'blue' }]])
})

test('an Unfold Bot wears no character: while its pet list loads the stage is not given its id\'s shape', () => {
  // The Unfold pet joins the roster only once the pet list answers; here it never does.
  const { draw, saved, used } = chooser({ id: 'u', name: 'U', kind: 'unfold' })
  const nodes = draw()
  assert.equal(stageName(nodes), 'Genie')
  assert.deepEqual(nodes.filter(node => node.type === 'button' && node.props.className === 'bt-cs-color'), [])
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed'] === true), [])
  nodes.find(node => node.type === 'button' && node.props.className === 'bt-cs-go').props.onClick()
  // An untouched Choose keeps the Unfold look.
  assert.deepEqual(saved, [])
  assert.deepEqual(used, [])
  // The same with a shape stored under it.
  const stored = chooser({ id: 'u', name: 'U', kind: 'unfold', avatar: { shape: 'moon' } })
  assert.equal(stageName(stored.draw()), 'Genie')
})

test('the octopus in a color other than Omni\'s stays on stage without a tile', () => {
  const { draw, saved, used } = chooser({ id: 'b', name: 'O', avatar: { shape: 'octopus' }, color: 'red' })
  const nodes = draw()
  assert.equal(stageName(nodes), 'Octopus')
  assert.deepEqual(tiles(nodes).filter(tile => tile.props['aria-pressed'] === true), [])
  assert.ok(!keysOf(nodes).includes('shape:octopus'))
  nodes.find(node => node.type === 'button' && node.props.className === 'bt-cs-go').props.onClick()
  assert.deepEqual(saved, [])
  assert.deepEqual(used, [])
})

test('a Solver wearing a photo gets only Solver tiles and Default look replaces the complete avatar', () => {
  const ui = chooser({ ...solverBot, avatar: { shape: 'moon', image: 'data:image/png;base64,AA==' } })
  const nodes = ui.draw()
  assert.deepEqual(headings(nodes), ['Solvers'])
  assert.deepEqual(keysOf(nodes), SOLVER_KEYS)
  assert.ok(!nodes.some(node => node.type === 'button' && node.props.children.includes('Add photos')))
  nodes.find(node => node.type === 'button' && node.props.children.includes('Default look')).props.onClick()
  assert.deepEqual(ui.saved, [['b', { avatar: { shape: 'antenna' } }]])
})

test('Description Solver by itself gives the ordinary chooser', () => {
  const nodes = chooser({ ...solverBot, instructions: '', avatar: { shape: 'moon' } }).draw()
  assert.deepEqual(headings(nodes), ['Automagik', 'codex-pets.net'])
  assert.ok(keysOf(nodes).every(key => !SOLVER_KEYS.includes(key)))
})

test('a tile choice is discarded when identity changes and does not revive on restoration', () => {
  const ui = chooser(solverBot)
  tileOf(ui.draw(), 'cactus').props.onClick()
  const ordinary = ui.draw({ ...solverBot, instructions: '', reviewerId: undefined })
  assert.equal(stageName(ordinary), ordinaryDefault)
  chooseButton(ordinary).props.onClick()
  chooseButton(ui.draw(solverBot)).props.onClick()
  assert.deepEqual(ui.saved, [])
})

test('mount focus alone saves nothing and an arrow move chooses a character', () => {
  const ui = chooser({ ...solverBot, avatar: { shape: 'cactus' } })
  const nodes = ui.draw()
  chooseButton(nodes).props.onClick()
  assert.deepEqual(ui.saved, [])
  ui.key(nodes, 'ArrowRight')
  chooseButton(ui.draw()).props.onClick()
  assert.deepEqual(ui.saved, [['b', { avatar: { shape: 'bulb' }, color: 'red' }]])
})

test('Shift+Tab over earlier tiles to a swatch recolors without choosing a tile', () => {
  const ui = chooser(solverBot)
  let nodes = ui.draw()
  const buttons = () => nodes.filter(node => node.type === 'button' && !node.props.disabled)
  const from = buttons().findIndex(node => node.props['data-key'] === 'shape:frog')
  const to = buttons().findIndex(node => node.props.className === 'bt-cs-color' && node.props['aria-label'] === 'Blue')
  assert.ok(to >= 0 && from > to)
  // The stage precedes the roster. Walk the browser's backwards focus order.
  for (let index = from; index > to; index -= 1) {
    ui.key(nodes, 'Tab', { dataset: { key: buttons()[index].props['data-key'] } }, { shiftKey: true })
    buttons()[index - 1].props.onFocus?.({ currentTarget: { matches: selector => selector === ':focus-visible' } })
    nodes = ui.draw()
  }
  assert.equal(stageName(nodes), 'Puff')
  buttons()[to].props.onClick()
  chooseButton(ui.draw()).props.onClick()
  assert.deepEqual(ui.saved, [['b', { color: 'blue' }]])
})

test('Enter saves its target tile and Space explicitly chooses one before focus moves', () => {
  const direct = chooser(solverBot)
  direct.key(direct.draw(), 'Enter', { dataset: { key: 'shape:cactus' } })
  assert.deepEqual(direct.saved, [['b', { avatar: { shape: 'cactus' }, color: 'red' }]])
  const staged = chooser(solverBot)
  staged.key(staged.draw(), ' ', { dataset: { key: 'shape:cactus' } })
  focusTile(staged.draw(), 'bulb')
  staged.key(staged.draw(), 'Enter')
  assert.deepEqual(staged.saved, [['b', { avatar: { shape: 'cactus' }, color: 'red' }]])
})

test('the chooser stages the ordinary default and restores the stored character when identity returns', () => {
  const ui = chooser({ ...solverBot, instructions: '' })
  const ordinary = ui.draw()
  assert.equal(stageName(ordinary), ordinaryDefault)
  assert.deepEqual(tiles(ordinary).filter(tile => tile.props['aria-pressed']), [])
  chooseButton(ordinary).props.onClick()
  assert.deepEqual(ui.saved, [])
  const restored = ui.draw(solverBot)
  assert.equal(stageName(restored), 'Frog')
  assert.equal(tileOf(restored, 'frog').props['aria-pressed'], true)
})
