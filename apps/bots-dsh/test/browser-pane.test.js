import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rectsOverlap } from '../src/client/browser-overlap.js'
import { characterMarkup, defaultShape, MASK_ID } from '../src/client/characters.js'
import { browser, bundle, load, nodes } from './viewer-fixture.js'

test('overlay coverage requires positive rectangle intersection', () => {
  const panel = { left: 10, top: 20, right: 110, bottom: 120, width: 100, height: 100 }
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 150, bottom: 160, width: 100, height: 100 }), true)
  assert.equal(rectsOverlap(panel, { left: 110, top: 20, right: 150, bottom: 60, width: 40, height: 40 }), false)
  assert.equal(rectsOverlap(panel, { left: 200, top: 200, right: 250, bottom: 250, width: 50, height: 50 }), false)
  assert.equal(rectsOverlap(panel, { left: 50, top: 60, right: 50, bottom: 90, width: 0, height: 30 }), false)
})

const code = await bundle("export { BotPanel } from './src/client/browser-pane.js'")

test('the browser tab strip and empty view draw the owner character and stored color', () => {
  const { BotPanel } = load(code, browser().globals)
  for (const reviewerId of ['r', undefined]) {
    const bot = { id: 'b', name: 'Fixture', role: 'Solver', reviewerId, avatar: { shape: 'frog' }, color: 'aurora' }
    const tree = BotPanel({
      pane: { id: bot.id, view: 'browser' }, room: 1000,
      roster: { browser: true, byId: { b: bot } }, actions: { browserShow() {} },
      useBrowserTabs: select => select({ b: { ids: ['tab'], active: 'tab' } }),
      useBrowserPages: select => select({}),
    })
    const [strip, view] = ['PanelStrip', 'BrowserView'].map(name => nodes(tree).find(node => node.type?.name === name))
    const shape = reviewerId ? 'frog' : defaultShape(bot.id)
    for (const [surface, className] of [[strip, 'bt-ptab bt-ptab-bot'], [view, 'bt-browser-empty']]) {
      const subject = nodes(surface.type(surface.props)).find(node => node.props.className === className)
      const mark = subject.props.children.find(node => node?.type?.name === 'BotMark')
      const drawn = mark.type(mark.props)
      const face = drawn.type(drawn.props)
      assert.equal(face.props['data-shape'], shape)
      assert.equal(face.props.children[0].props.dangerouslySetInnerHTML.__html.replace(/bt-mark-\d+/g, MASK_ID), characterMarkup(shape, bot.color))
    }
  }
})
