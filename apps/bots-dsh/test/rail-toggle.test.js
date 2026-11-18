// #1502: a project tile that opens nothing is drawn still (no hover, no pointer), and the
// footer's toggle seat (sidebar.js RailToggle) is there only while the bar is open.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, hasClass, parts, render } from './left-bar-load.js'

const { ProjectRail } = parts
const PROJECTS = [{ id: 'local', name: 'This computer', icon: 'triskle.svg' }, { id: 'away', name: 'Away' }]
const tiles = tree => findAll(tree, node => node.type === 'button' && node.props['data-id'] !== undefined)

test('a tile with no opening is still; with one it is not', () => {
  const still = tiles(render(ProjectRail({ projects: PROJECTS, currentId: 'local' })))
  assert.equal(still.length, 2)
  for (const tile of still) {
    assert.ok(hasClass('lb-tile-still')(tile), `${tile.props['data-id']} is still`)
    assert.equal(tile.props.onClick, undefined)
    // Still a labelled button, the open one with its ring.
    assert.equal(tile.props.type, 'button')
    assert.ok(tile.props['aria-label'])
  }
  assert.equal(still[0].props['aria-current'], 'true')
  const opened = []
  const live = tiles(render(ProjectRail({ projects: PROJECTS, currentId: 'local', onOpen: project => opened.push(project.id) })))
  for (const tile of live) assert.equal(hasClass('lb-tile-still')(tile), false, `${tile.props['data-id']} opens`)
  live[1].props.onClick()
  assert.deepEqual(opened, ['away'])
})
