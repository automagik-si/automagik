// What the Code side's pane store says for one Bot, pure and without the DOM: the chat
// header's Chat / Terminal switch turns on exactly when the tree has a pane, and a stale
// selection never reaches an attach.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { botRowOf, codeHasPane, paneFor, statusKey, stillThere } from '../src/client/code-side-model.js'

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
