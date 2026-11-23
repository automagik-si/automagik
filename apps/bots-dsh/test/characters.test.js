import assert from 'node:assert/strict'
import test from 'node:test'
import { CHARACTERS, DEFAULT_SHAPES, FALLBACK_SHAPE, PICKER_SHAPES, SOLVER_SHAPES, bakeMarkup, characterMarkup, defaultShape, hasShape, lookOf, maskOf, shapeOf } from '../src/client/characters.js'

// The ids are saved with Bots, so the table only ever grows at its end.
const FIRST = ['whale', 'octopus', 'star', 'moon', 'wave', 'squircle', 'zed', 'hex', 'gumdrop', 'peanut', 'saucer', 'bunny', 'kitty', 'beacon', 'plus', 'magnet', 'acorn', 'pebbles', 'cushion', 'ring', 'gem']
const SOLVERS = ['puff', 'sprout', 'cap', 'bell', 'cloud', 'spike', 'floppy', 'antenna', 'cactus', 'bulb', 'chick', 'frog']

// Every character must draw. A table entry missing a layer or its eyes once crashed the whole
// team surface (the Main Bot's mark), and no other test renders a character.
test('every character draws its markup and mask without a missing layer', () => {
  for (const shape of Object.keys(CHARACTERS)) {
    const markup = characterMarkup(shape, 'deepseek')
    assert.equal(typeof markup, 'string', shape)
    assert.ok(!markup.includes('undefined'), `${shape} markup has an undefined value`)
    const mask = maskOf(shape)
    assert.ok(!mask.includes('undefined'), `${shape} mask has an undefined value`)
  }
})

test('the catalogue is the first 21 characters, then the twelve Solvers as one block', () => {
  assert.deepEqual(Object.keys(CHARACTERS), [...FIRST, ...SOLVERS])
  assert.deepEqual(PICKER_SHAPES, [...FIRST, ...SOLVERS])
  assert.deepEqual(SOLVERS.map(id => shapeOf(id).label), ['Puff', 'Sprout', 'Cap', 'Bell', 'Cloud', 'Spike', 'Floppy', 'Antenna', 'Cactus', 'Bulb', 'Chick', 'Frog'])
  for (const id of SOLVERS) assert.ok(hasShape(id), id)
  // The list the choosers' "Solvers" section is built from: the table's last twelve.
  assert.deepEqual(SOLVER_SHAPES, SOLVERS)
})

test('a Solver is a table entry like any other: body, shade, light and two eyes, in the catalogue\'s fixed tones', () => {
  for (const id of SOLVERS) {
    const character = CHARACTERS[id]
    assert.deepEqual(Object.keys(character).filter(key => key !== 'paints'), ['label', 'body', 'shade', 'light', 'eyes'], id)
    for (const layer of ['body', 'shade', 'light']) assert.match(character[layer], /^M[\d. \-lMz]+z$/, `${id} ${layer}`)
    assert.equal(character.eyes.length, 2, id)
    for (const eye of character.eyes) assert.ok(eye.length === 5 && eye.every(Number.isFinite), id)
    // A decal is black or white at an opacity: no new color.
    for (const [d, fill, opacity] of character.paints ?? []) {
      assert.match(d, /^M/, id)
      assert.ok(['#000', '#fff'].includes(fill), `${id} paints ${fill}`)
      assert.ok(opacity > 0 && opacity < 1, id)
    }
  }
  assert.deepEqual(SOLVERS.filter(id => CHARACTERS[id].paints), ['cap', 'bulb', 'chick'])
})

test('a Solver draws as a mark and bakes into a pet through the same code as the others', () => {
  for (const id of SOLVERS) {
    const markup = characterMarkup(id, 'red')
    assert.ok(markup.includes(CHARACTERS[id].body), id)
    assert.ok(maskOf(id).startsWith('url("data:image/svg+xml,'), id)
    const parts = bakeMarkup(id, 'red')
    assert.equal(parts.box, 100, id)
    assert.deepEqual(Object.keys(parts.faces), Object.keys(bakeMarkup('gumdrop', 'red').faces), id)
    for (const svg of [parts.body, ...Object.values(parts.faces)]) assert.ok(svg.startsWith('<svg ') && !svg.includes('undefined') && !svg.includes('NaN'), id)
  }
})

test('no existing Bot changes its look: the id defaults and the fallback never name a Solver', () => {
  assert.deepEqual(DEFAULT_SHAPES, ['star', 'moon', 'gumdrop', 'peanut', 'bunny', 'kitty', 'acorn'])
  assert.equal(FALLBACK_SHAPE, 'gumdrop')
  // Pinned: the looks these ids had before the Solvers came.
  assert.deepEqual(['b-aaaaaaaaaa', 'b-k3m7q2zt5x', 'b-77777777ab'].map(defaultShape), ['peanut', 'star', 'moon'])
  for (let index = 0; index < 500; index += 1) assert.ok(!SOLVERS.includes(defaultShape(`bot-${index}`)))
  // A chosen Solver is kept as stored; an unknown shape still falls back to the id's own.
  assert.equal(lookOf({ id: 'b-aaaaaaaaaa', avatar: { shape: 'frog' } }).shape, 'frog')
  assert.equal(lookOf({ id: 'b-aaaaaaaaaa', avatar: { shape: 'nope' } }).shape, 'peanut')
})
