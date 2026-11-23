import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { automagikRoster, currentKey } from './src/client/character-select.js'\nexport { lookOf } from './src/client/mark.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react', 'react-dom'],
})
const select = { exports: {} }
const react = { createElement: () => null, useEffect: () => {}, useLayoutEffect: () => {}, useMemo: f => f(), useRef: () => ({}), useState: v => [v, () => {}], Fragment: 'f' }
runInNewContext(bundle.outputFiles[0].text, { module: select, exports: select.exports, URLSearchParams, require: name => (name === 'react' ? react : { createPortal: x => x }) })
const { automagikRoster, currentKey, lookOf } = select.exports

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

test('the twelve Solvers close the roster as one block, after the characters that were there', () => {
  // Copied into this realm's arrays: the roster comes from the bundle's own context.
  const shapes = [...automagikRoster()].filter(entry => entry.kind === 'shape')
  assert.equal(shapes.length, 32)
  assert.deepEqual(shapes.slice(0, 3).map(entry => entry.shape), ['whale', 'star', 'moon'])
  assert.equal(shapes[19].shape, 'gem')
  assert.deepEqual(shapes.slice(20).map(entry => entry.shape), ['puff', 'sprout', 'cap', 'bell', 'cloud', 'spike', 'floppy', 'antenna', 'cactus', 'bulb', 'chick', 'frog'])
  assert.deepEqual(shapes.slice(20).map(entry => entry.name), ['Puff', 'Sprout', 'Cap', 'Bell', 'Cloud', 'Spike', 'Floppy', 'Antenna', 'Cactus', 'Bulb', 'Chick', 'Frog'])
  assert.ok(shapes.slice(20).every(entry => entry.key === `shape:${entry.shape}` && entry.line === 'Automagik character'))
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
