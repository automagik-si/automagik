import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { botLookOf } from '../src/client/bot-look.js'
import { fnv1a as characterHash, SOLVER_SHAPES } from '../src/client/characters.js'
import { isSolverLooks, solverDefaultShape } from '../src/client/solver-looks.js'
import { solverInstructions } from '../src/shared/solver-method.js'

test('Solver looks require the description and reviewer or method on an ordinary Bot', () => {
  const method = solverInstructions()
  const cases = [
    [{ role: 'Solver' }, false],
    [{ role: 'Solver', kind: 'dsh', reviewerId: 'r' }, false],
    [{ role: 'Solver', kind: null, reviewerId: 'r' }, false],
    [{ role: 'Writer', instructions: method }, false],
    [{ role: 'Solver', reviewerId: 'r' }, true],
    [{ role: 'Solver', instructions: method }, true],
    [{ role: 'Solver', instructions: solverInstructions({ reviewer: 'R' }) }, true],
  ]
  for (const [bot, expected] of cases) assert.equal(isSolverLooks(bot), expected)
})

test('the Solver default is stable and belongs to the twelve', () => {
  assert.equal(solverDefaultShape('b'), 'antenna')
  for (let index = 0; index < 500; index += 1) {
    const id = `b-${index}`
    const shape = solverDefaultShape(id)
    assert.ok(SOLVER_SHAPES.includes(shape))
    assert.equal(solverDefaultShape(id), shape)
  }
})

test('losing Solver identity changes only the drawn shape and restoring it brings back the stored shape', () => {
  const bot = { id: 'b-aaaaaaaaaa', role: 'Writer', avatar: { shape: 'frog' }, color: 'red' }
  const before = structuredClone(bot)
  assert.deepEqual(botLookOf(bot), { shape: 'peanut', color: 'red', image: undefined, pet: undefined })
  assert.deepEqual(bot, before)
  assert.equal(botLookOf({ ...bot, role: 'Solver', reviewerId: 'r' }).shape, 'frog')
  assert.equal(botLookOf({ ...bot, kind: 'dsh' }).shape, 'whale')
  const image = 'data:image/png;base64,AA=='
  assert.equal(botLookOf({ ...bot, avatar: { ...bot.avatar, image } }).image, image)
})

test('the shared shapes, hash and default agree with delivery 1', async () => {
  const { SOLVER_LOOK_SHAPES, fnv1a, solverDefaultShape: sharedDefault } = await import('../src/shared/solver-looks.js')
  assert.deepEqual(SOLVER_LOOK_SHAPES, SOLVER_SHAPES)
  for (let index = 0; index < 500; index += 1) {
    const id = `id-${index}`
    assert.equal(fnv1a(id), characterHash(id))
  }
  const defaults = {
    'id-0': 'bell', 'id-1': 'sprout', 'id-2': 'antenna', 'id-3': 'chick',
    'id-5': 'bulb', 'id-6': 'cap', 'id-13': 'puff', 'id-14': 'frog',
    'id-19': 'spike', 'id-27': 'cloud', 'id-28': 'floppy', 'id-61': 'cactus',
  }
  for (const [id, shape] of Object.entries(defaults)) assert.equal(sharedDefault(id), shape, id)
})

test('the shared look module has only the dependency-free Solver method import', () => {
  const source = name => readFileSync(new URL(`../src/shared/${name}.js`, import.meta.url), 'utf8')
  const looks = source('solver-looks')
  assert.equal([...looks.matchAll(/\bimport\b/g)].length, 1)
  assert.match(looks, /^import \{ SOLVER_DESCRIPTION, solverInstructions \} from '\.\/solver-method\.js'$/m)
  assert.doesNotMatch(source('solver-method'), /(?:^|\s)import\s/m)
})

test('displaying a carried Solver shape removes only the ordinary Bot shape', async () => {
  const { displayAvatar } = await import('../src/shared/solver-looks.js')
  const image = 'data:image/png;base64,AA=='
  const solver = { role: 'Solver', reviewerId: 'reviewer' }
  for (const [bot, expected] of [
    [{ avatar: { shape: 'frog', image } }, { image }],
    [{ avatar: { shape: 'frog' } }, undefined],
    [{ ...solver, avatar: { shape: 'frog' } }, { shape: 'frog' }],
    [{ ...solver, kind: 'dsh', avatar: { shape: 'frog' } }, undefined],
  ]) {
    const before = structuredClone(bot)
    assert.deepEqual(displayAvatar(bot), expected)
    assert.deepEqual(bot, before)
    if (expected?.shape === undefined && expected !== undefined) assert.notEqual(displayAvatar(bot), bot.avatar)
  }
})

test('the avatar rule checks the whole Solver look and allows an unchanged ordinary carry', async () => {
  const { SOLVER_ONLY, SOLVER_WEARS, avatarProblem } = await import('../src/shared/solver-looks.js')
  const solver = { role: 'Solver', reviewerId: 'reviewer' }
  const frog = { shape: 'frog' }
  const image = 'data:image/png;base64,AA=='
  const pet = { source: 'team', id: 'fixture', version: 1 }
  for (const [identity, avatar, stored, problem] of [
    [solver, frog, undefined, undefined],
    [solver, { ...frog, image }, undefined, SOLVER_WEARS],
    [solver, { ...frog, pet }, undefined, SOLVER_WEARS],
    [solver, { shape: 'star' }, undefined, SOLVER_WEARS],
    [solver, undefined, undefined, SOLVER_WEARS],
    [{}, frog, undefined, SOLVER_ONLY],
    [{}, { ...frog, image }, frog, undefined],
    [{}, { shape: 'cactus' }, frog, SOLVER_ONLY],
    [{}, { pet }, undefined, undefined],
  ]) {
    assert.equal(avatarProblem(identity, avatar, stored), problem)
  }
})
