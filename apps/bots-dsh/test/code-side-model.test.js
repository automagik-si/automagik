// What the Code side's pane store says for one Bot, pure and without the DOM: the chat
// header's Chat / Terminal switch turns on exactly when the tree has a pane, and a stale
// selection never reaches an attach.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botRowOf, codeHasPane, MAX_PANES, paneFor, prunePanes, statusKey, stillThere, togglePane, validGrid } from '../src/client/code-side-model.js'

const TREE = {
  v: 1,
  machine: { name: 'test-machine', core: 'core-test' },
  projects: [
    {
      folder: '/srv/atlas',
      name: 'atlas',
      bots: [
        { id: 'b-aaaaaaaaaa', name: 'Atlas', main: true, status: 'idle', terminal: { id: 't7', cols: 118, rows: 34 }, workers: [{ terminal: 't9', role: 'reviewer', status: 'needs-you' }] },
        { id: 'b-bbbbbbbbbb', name: 'Workerless', main: false, status: 'not-running', terminal: null, workers: [] },
        { id: 'b-cccccccccc', name: 'Only worker', main: false, status: 'not-running', terminal: null, workers: [{ terminal: 't8', role: 'dev', status: 'working' }] },
      ],
    },
  ],
}

test('a Bot with a seat or a worker turns the Terminal face on; a Bot without one does not', () => {
  assert.equal(codeHasPane(TREE, 'b-aaaaaaaaaa'), true)
  assert.equal(codeHasPane(TREE, 'b-cccccccccc'), true)
  assert.equal(codeHasPane(TREE, 'b-bbbbbbbbbb'), false)
  assert.equal(codeHasPane(TREE, 'b-dddddddddd'), false)
  assert.equal(codeHasPane(null, 'b-aaaaaaaaaa'), false)
})

test('the face opens the seat first, else its first worker, and never an arbitrary terminal', () => {
  assert.deepEqual(paneFor(TREE, 'b-aaaaaaaaaa'), { botId: 'b-aaaaaaaaaa', worker: null })
  assert.deepEqual(paneFor(TREE, 'b-cccccccccc'), { botId: 'b-cccccccccc', worker: 't8' })
  assert.equal(paneFor(TREE, 'b-bbbbbbbbbb'), null)
  assert.equal(paneFor(TREE, 'b-dddddddddd'), null)
  assert.equal(botRowOf(TREE, 'b-aaaaaaaaaa').name, 'Atlas')
  assert.equal(botRowOf(TREE, 'nobody'), null)
})

test('a selection survives a refresh only while its pane is still in the tree', () => {
  assert.deepEqual(stillThere({ botId: 'b-aaaaaaaaaa', worker: null }, TREE), { botId: 'b-aaaaaaaaaa', worker: null })
  assert.deepEqual(stillThere({ botId: 'b-aaaaaaaaaa', worker: 't9' }, TREE), { botId: 'b-aaaaaaaaaa', worker: 't9' })
  assert.equal(stillThere({ botId: 'b-cccccccccc', worker: null }, TREE), null, 'a worker-only Bot has no seat to keep selected')
  assert.equal(stillThere({ botId: 'b-aaaaaaaaaa', worker: 't8' }, TREE), null, 'another Bot worker is not this selection')
  assert.equal(stillThere({ botId: 'b-bbbbbbbbbb', worker: null }, TREE), null)
  assert.equal(stillThere(null, TREE), null)
  assert.equal(stillThere({ botId: 'b-aaaaaaaaaa', worker: null }, null), null)
})

test('the words the host sends map to their keys; an unknown word reads idle, never a fifth mark', () => {
  assert.equal(statusKey('working'), 'working')
  assert.equal(statusKey('needs-you'), 'needs-you')
  assert.equal(statusKey('idle'), 'idle')
  assert.equal(statusKey('not-running'), 'not-running')
  assert.equal(statusKey('done'), 'idle')
  assert.equal(statusKey(undefined), 'idle')
})

test('beside picks toggle rows and terminal aliases, and refuse a fifth live pane by name', () => {
  const tree = structuredClone(TREE)
  const [atlas, , workerOnly] = tree.projects[0].bots
  atlas.workers.push({ terminal: 't7' }, { terminal: 't10', agent: 'builder' }, { terminal: 't11' })
  const seat = { botId: atlas.id, worker: null }
  const reviewer = { botId: atlas.id, worker: 't9' }
  const alias = { botId: atlas.id, worker: 't7' }
  const builder = { botId: atlas.id, worker: 't10' }
  const worker = { botId: workerOnly.id, worker: 't8' }
  const fifth = { botId: atlas.id, worker: 't11' }

  const { list } = togglePane([seat], reviewer, tree)
  assert.deepEqual(list, [seat, reviewer])
  assert.deepEqual(togglePane(list, reviewer, tree), { list: [seat] })
  assert.deepEqual(togglePane(list, alias, tree), { list: [reviewer] })
  const full = [seat, reviewer, builder, worker]
  assert.equal(full.length, MAX_PANES)
  assert.deepEqual(togglePane(full, fifth, tree), { list: full, refused: ['Atlas', 'Atlas · reviewer', 'Atlas · builder', 'Only worker · dev'] })
  assert.deepEqual(togglePane(full, { botId: 'b-bbbbbbbbbb', worker: null }, tree), { list: full })
  assert.deepEqual(prunePanes([seat, alias, reviewer, null, fifth], TREE), [seat, reviewer])
  assert.deepEqual(prunePanes([alias, seat, reviewer], tree), [alias, reviewer])
})

test('terminal grids have integer dimensions and bounded sides and cell count', () => {
  for (const grid of [{ cols: 2, rows: 1 }, { cols: 1000, rows: 250 }, { cols: 250, rows: 1000 }]) {
    assert.equal(validGrid(grid), true)
  }
  for (const grid of [null, {}, { cols: 1, rows: 1 }, { cols: 1001, rows: 1 }, { cols: 2, rows: 1001 },
    { cols: 1000, rows: 251 }, { cols: '80', rows: 24 }, { cols: 80, rows: 24.5 }, { cols: 80, rows: 0 }]) {
    assert.equal(validGrid(grid), false)
  }
})
