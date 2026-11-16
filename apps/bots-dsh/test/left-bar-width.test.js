// The new left bar's column width (left-bar-width.js): DSH opens its sidebar column at 280 and
// keeps no width, so the bar moves DSH's own drag handle to 336 (a 320 panel 8 px in) whenever the open, wide column
// stands at 280, and to the width the person dragged to once they did. Pinned against the
// harness's DSH: the day DSH changes its width or its handle, these fail, and the bar then leaves
// the column as DSH draws it.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { BAR_WIDTH, DSH_WIDTH, WIDTH_KEY, installBarWidth, keptWidth, widthMove } from '../src/client/left-bar-width.js'

const harness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harness('jsdom')

test('only an open, wide column at DSH\'s own width moves, to the kept width else the bar\'s', () => {
  const at = { width: 280, kept: null, drawer: false, collapsed: false, dragging: false }
  assert.equal(widthMove(at), BAR_WIDTH - DSH_WIDTH)
  assert.equal(widthMove({ ...at, width: 279.6 }), 56, 'a column a fraction off is still DSH\'s')
  assert.equal(widthMove({ ...at, kept: 360 }), 80, 'the person\'s own width wins over the bar\'s')
  assert.equal(widthMove({ ...at, kept: 280 }), 0, 'a person who chose 280 keeps 280')
  for (const other of [{ width: 320 }, { width: 300 }, { width: 0 }, { drawer: true }, { collapsed: true }, { dragging: true }]) {
    assert.equal(widthMove({ ...at, ...other }), 0, JSON.stringify(other))
  }
})

test('a kept width is read only when DSH would take it', () => {
  const store = value => ({ getItem: key => (key === WIDTH_KEY ? value : null) })
  assert.equal(keptWidth(store('360')), 360)
  assert.equal(keptWidth(store('263')), null)
  assert.equal(keptWidth(store('421')), null)
  assert.equal(keptWidth(store('wide')), null)
  assert.equal(keptWidth(store(null)), null)
  assert.equal(keptWidth({ getItem() { throw new Error('blocked') } }), null)
  assert.equal(keptWidth(undefined), null)
})

// The shell's frame as DSH draws it (AppFrame.tsx), with the column's width set by hand: jsdom
// lays nothing out.
function shell({ width = 280, handle = true, attrs = '', stuck = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div class="x_frame" ${attrs}><div class="x_sidebarCol"></div>${handle ? '<div class="x_handle" data-side="sidebar"></div>' : ''}<div class="x_handle" data-side="rightbar"></div></div></body>`, { pretendToBeVisual: true })
  const doc = dom.window.document
  doc.querySelector('.x_sidebarCol').getBoundingClientRect = () => ({ width, left: 0 })
  const presses = []
  for (const node of doc.querySelectorAll('.x_handle')) {
    node.getBoundingClientRect = () => ({ left: width, width: 8 })
    for (const type of ['pointerdown', 'pointerup']) node.addEventListener(type, event => presses.push([node.dataset.side, type, event.clientX, event.button]))
  }
  // A handle that flips DSH's drag state on press and release but leaves the column where it
  // was: the wake its flip causes must not become another press.
  if (stuck) for (const node of doc.querySelectorAll('.x_handle[data-side="sidebar"]')) {
    const frame = doc.querySelector('.x_frame')
    node.addEventListener('pointerdown', () => frame.setAttribute('data-dragging', ''))
    node.addEventListener('pointerup', () => frame.removeAttribute('data-dragging'))
  }
  return { dom, doc, presses }
}
const settle = dom => new Promise(done => dom.window.requestAnimationFrame(() => setTimeout(done, 0)))
const memory = (kept) => {
  const values = new Map(kept ? [[WIDTH_KEY, String(kept)]] : [])
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('the bar presses DSH\'s sidebar handle once and lets go 56 px further', async () => {
  const { dom, doc, presses } = shell()
  const off = installBarWidth({ doc, storage: memory() })
  await settle(dom)
  off()
  assert.deepEqual(presses, [['sidebar', 'pointerdown', 284, 0], ['sidebar', 'pointerup', 340, 0]])
})

test('a handle that ignores its release is pressed once, not every frame', async () => {
  // DSH's own handle flips its drag state on press and release. A later 0.2.x may stop sizing
  // the column on release; without a bound, every flip wakes the bar and it presses again, a
  // press per frame forever (60 presses in 60 frames at bc50d0134).
  const { dom, doc, presses } = shell({ stuck: true })
  const off = installBarWidth({ doc, storage: memory() })
  for (let i = 0; i < 60; i += 1) await settle(dom)
  off()
  const sidebar = presses.filter(([side]) => side === 'sidebar')
  assert.equal(sidebar.filter(([, type]) => type === 'pointerdown').length, 1, 'one press')
  assert.equal(sidebar.length, 2, 'one press pair, then quiet')
})

test('a kept width is restored instead of the bar\'s', async () => {
  const { dom, doc, presses } = shell()
  const off = installBarWidth({ doc, storage: memory(360) })
  await settle(dom)
  off()
  assert.deepEqual(presses.map(([, type, x]) => [type, x]), [['pointerdown', 284], ['pointerup', 364]])
})

test('nothing moves off DSH\'s width, in a drawer, folded, or with no handle; nothing breaks', async () => {
  for (const options of [{ width: 300 }, { attrs: 'data-sidebar-drawer' }, { attrs: 'data-sidebar-collapsed' }, { handle: false }]) {
    const { dom, doc, presses } = shell(options)
    const off = installBarWidth({ doc, storage: memory() })
    await settle(dom)
    off()
    assert.deepEqual(presses, [], JSON.stringify(options))
  }
})

test('a page that cannot drive the handle is left alone, and installing never throws', () => {
  const { dom, doc, presses } = shell()
  for (const name of ['requestAnimationFrame', 'PointerEvent', 'MutationObserver']) {
    const kept = dom.window[name]
    dom.window[name] = undefined
    assert.doesNotThrow(() => installBarWidth({ doc, storage: memory() })(), name)
    dom.window[name] = kept
  }
  assert.doesNotThrow(() => installBarWidth({ doc: undefined })())
  assert.deepEqual(presses, [])
})

test('pinned: DSH opens the column at 280, bounds a drag to 264..420, and sets it from its handle', () => {
  const root = dirname(harness.resolve('@deepseek-ai/dsh-client-ui-layout/package.json'))
  const source = file => readFileSync(join(root, 'src/client', file), 'utf8')
  const columns = source('columns.ts')
  assert.match(columns, /export const SIDEBAR_DEFAULT = 280\b/)
  assert.match(columns, /export const SIDEBAR_MIN = 264\b/)
  assert.match(columns, /export const SIDEBAR_MAX = 420\b/)
  const stores = source('stores.ts')
  assert.match(stores, /sidebar: SIDEBAR_DEFAULT,/, 'every start seeds DSH\'s width; none is kept')
  assert.match(stores, /d\.layoutInfo\.sidebar = d\.layoutInfo\.sidebar === 0 \? SIDEBAR_DEFAULT : 0/, 'a reopen goes back to it')
  const frame = source('AppFrame.tsx')
  assert.match(frame, /if \(e\.button !== 0 \|\| capture\.current !== null\) return/)
  assert.match(frame, /callbacks\.current\.onDrag\(e\.clientX - origin\.current\)/, 'a release sets the column by how far it moved')
  assert.match(frame, /data-side=\{props\.side\}/)
  assert.match(frame, /<DragHandle side="sidebar" left=\{cols\.sidebar\}/)
  assert.match(frame, /actions\.setSidebar\(sidebarBase\.current \+ dx\)/)
})
