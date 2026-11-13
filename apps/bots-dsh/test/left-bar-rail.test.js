// The new left bar's project rail (left-bar-rail.js): one tile per project with its mark or its
// first letter, a ring on the open one, the "needs you" mark on a closed project's corner, and
// the "+" at the end.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, hasClass, parts, render } from './left-bar-load.js'

const { ProjectRail, projectBadge, projectLetter } = parts

const PROJECTS = [
  { id: 'am', name: 'Automagik', icon: 'triskle.svg', status: 'working' },
  { id: 'genie', name: 'Genie', icon: { light: 'lamp-ink.svg', dark: 'lamp-cream.svg' }, iconSize: 30, status: 'needs' },
  { id: 'omni', name: 'Omni', icon: { light: 'vortex-ink.svg' }, status: 'needs' },
  { id: 'harbor', name: '  harbor' },
]
const draw = props => render(ProjectRail({ projects: PROJECTS, currentId: 'am', ...props }))
const tiles = tree => findAll(tree, node => node.type === 'button')

test('the rail is a named nav of one tile per project, then the plus', () => {
  const tree = draw()
  assert.equal(tree.type, 'nav')
  assert.equal(tree.props['aria-label'], 'Projects')
  assert.equal(draw({ label: 'Instances' }).props['aria-label'], 'Instances')
  const all = tiles(tree)
  assert.deepEqual(all.map(tile => tile.props['data-id']), ['am', 'genie', 'omni', 'harbor', undefined])
  const add = all.at(-1)
  assert.ok(hasClass('lb-tile-add')(add))
  assert.equal(add.props['aria-label'], 'Add a project')
  assert.equal(add.props.title, 'Add a project')
  for (const tile of all) assert.equal(tile.props.type, 'button')
})

test('a tile wears its mark, its paired marks, or its first letter', () => {
  const [am, genie, omni, harbor] = tiles(draw())
  assert.deepEqual(findAll(am, node => node.type === 'img').map(img => [img.props.src, img.props.alt]), [['triskle.svg', '']])
  const lamps = findAll(genie, node => node.type === 'img')
  assert.deepEqual(lamps.map(img => [img.props.src, img.props.className]), [['lamp-ink.svg', 'lb-on-light'], ['lamp-cream.svg', 'lb-on-dark']], 'ink on a light ground, cream on a dark one')
  assert.deepEqual(lamps[0].props.style, { width: 30, height: 30 }, 'a mark drawn wider than the tile box keeps its own size')
  assert.equal(am.children[0].children[0].props.style, undefined)
  // A pair with one half missing is no picture: the tile wears the letter.
  assert.ok(hasClass('lb-tile-letter')(omni))
  assert.equal(omni.children[0].children[0], 'O')
  assert.ok(hasClass('lb-tile-letter')(harbor))
  assert.equal(harbor.children[0].children[0], 'H', 'the first letter, after the spaces, in capitals')
  assert.equal(projectLetter(''), '?')
  assert.equal(projectLetter(undefined), '?')
  assert.equal(projectLetter('ñandu'), 'Ñ')
})

test('the open project wears the ring; a closed one that needs you wears the mark', () => {
  const [am, genie, omni, harbor] = tiles(draw())
  assert.equal(am.props['aria-current'], 'true')
  assert.equal(genie.props['aria-current'], undefined)
  assert.ok(hasClass('lb-tile-badged')(genie))
  assert.equal(genie.props['aria-label'], 'Genie, Needs you', 'the badge is in the tile\'s name')
  assert.equal(genie.props.title, 'Genie')
  const [pip] = findAll(genie, hasClass('lb-pip'))
  const [mark] = findAll(pip, node => node.props?.['data-status'] === 'needs')
  assert.equal(mark.props['aria-hidden'], true, 'the mark is not read twice')
  assert.ok(hasClass('lb-tile-badged')(omni))
  assert.equal(findAll(am, hasClass('lb-pip')).length, 0, 'working is not a badge')
  assert.equal(findAll(harbor, hasClass('lb-pip')).length, 0)
  // The open project's list says it already.
  const genieOpen = tiles(draw({ currentId: 'genie' }))[1]
  assert.equal(findAll(genieOpen, hasClass('lb-pip')).length, 0)
  assert.equal(genieOpen.props['aria-label'], 'Genie')
  assert.equal(projectBadge({ id: 'x', status: 'needs' }, 'y'), 'needs')
  assert.equal(projectBadge({ id: 'x', status: 'needs' }, 'x'), null)
  assert.equal(projectBadge({ id: 'x', status: 'error' }, 'y'), null)
})

test('a press on a tile hands over its project; the plus calls onAdd', () => {
  const opened = []
  const tree = draw({ onOpen: project => opened.push(project.id), onAdd: () => opened.push('+') })
  const all = tiles(tree)
  all[2].props.onClick()
  all.at(-1).props.onClick()
  assert.deepEqual(opened, ['omni', '+'])
  assert.equal(tiles(draw())[0].props.onClick, undefined)
  assert.deepEqual(tiles(render(ProjectRail({}))).length, 1, 'no projects: the plus alone')
})
