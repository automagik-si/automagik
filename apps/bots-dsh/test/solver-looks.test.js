import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botLookOf } from '../src/client/bot-look.js'
import { SOLVER_SHAPES } from '../src/client/characters.js'
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
