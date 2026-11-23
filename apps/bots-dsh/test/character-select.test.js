import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { automagikRoster, currentKey, solverRoster, tileBeyond } from './src/client/character-select.js'\nexport { lookOf } from './src/client/mark.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react', 'react-dom'],
})
const select = { exports: {} }
const react = { createElement: () => null, useEffect: () => {}, useLayoutEffect: () => {}, useMemo: f => f(), useRef: () => ({}), useState: v => [v, () => {}], Fragment: 'f' }
runInNewContext(bundle.outputFiles[0].text, { module: select, exports: select.exports, URLSearchParams, require: name => (name === 'react' ? react : { createPortal: x => x }) })
const { automagikRoster, currentKey, lookOf, solverRoster, tileBeyond } = select.exports

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
