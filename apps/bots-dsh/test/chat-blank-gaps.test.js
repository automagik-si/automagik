import { nativeCss } from './native-css.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'

// A chat's history showed blank bands where turns drew nothing: DSH spaces every child of
// the chat flow, and a turn's process seat whose cells all returned nothing kept that
// space, one band per hidden turn. Cells now leave an empty mark (cell-empty.js) and the
// seat or row whose slots hold only marks takes no room.
// Requires the dev/harness install: DSH's own chat flow and seat CSS, and the React it ships.
const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const requireHarness = createRequire(new URL('../dev/harness/package.json', import.meta.url))
const sheets = nativeCss(readFileSync(requireHarness.resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8'))
const sheet = (name, check) => {
  const css = sheets.find(check)
  assert.ok(css, `supported DSH ${name} CSS must be present`)
  return css
}
const flowCss = sheet('ChatView', css => /_flowItem\{/.test(css) && /_column\{/.test(css))
const seatCss = sheet('ChatGroupSeat', css => /_content>\*/.test(css) && /_title\{/.test(css))
const flow = flowCss.match(/\.([\w-]+)_flowItem\{/)[1]
const seat = seatCss.match(/\.([\w-]+)_content>\*/)[1]

const bundleOf = async (contents, { resolveDir = plugin, ...extra } = {}) => (await build({
  stdin: { contents, resolveDir }, bundle: true, write: false, logLevel: 'silent', platform: 'browser', ...extra,
})).outputFiles[0].text
const styles = { exports: {} }
runInNewContext(await bundleOf("export { CONVERSATION_CSS } from './src/client/styles.js'", {
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
}), { module: styles, exports: styles.exports, require: () => ({}) })
const botCss = styles.exports.CONVERSATION_CSS

// DSH ships React as module-loader seeds; the page gets only that published seed prefix,
// never the application bootstrap.
const assets = join(dirname(requireHarness.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'the harness supplies its React seed factory')
const seedsJs = await bundleOf(`${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, { format: 'iife', resolveDir: assets })
// The real CellEmpty, drawn by that React into the fixture's slots.
const cellsJs = await bundleOf(`
  import { createElement as h, Fragment } from 'react'
  import { createRoot } from 'react-dom/client'
  import { flushSync } from 'react-dom'
  import { CellEmpty } from './src/client/cell-empty.js'
  const roots = new Map()
  // What a cell draws into its slot: 'mark' (nothing), 'gone' (a settled card's mark),
  // 'event' (a visible line), 'mixed' (a mark beside a visible line).
  const DRAW = {
    mark: () => h(CellEmpty),
    gone: () => h(CellEmpty, { className: 'bt-q-gone' }),
    event: () => h('div', { className: 'bt-event' }, 'Messaged Writer'),
    mixed: () => h(Fragment, null, h(CellEmpty), h('div', { className: 'bt-event' }, 'Messaged Writer')),
  }
  window.draw = (id, kind) => {
    const slot = document.getElementById(id)
    if (!roots.has(id)) roots.set(id, createRoot(slot))
    flushSync(() => roots.get(id).render(DRAW[kind]()))
  }
`, {
  format: 'iife',
  plugins: [{ name: 'seeds', setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/client)?$/ }, args => ({ path: args.path, namespace: 'seed' }))
    build.onLoad({ filter: /.*/, namespace: 'seed' }, args => ({ contents: `module.exports = globalThis.nativeSeeds[${JSON.stringify(args.path)}]`, loader: 'js' }))
  } }],
})

// DSH's nesting: the flow's display:contents slot outlet, one flowItem per node, and one
// process seat per turn whose members sit in the seat's own content.
const slot = (id, inner = '') => `<div data-slot="conversation.chat.node" id="${id}" style="display:contents">${inner}</div>`
const item = (id, kind, inner, attrs = '') => `<div class="${flow}_flowItem" data-chat-flow-kind="${kind}" ${attrs}>${slot(id, inner)}</div>`
const seatOf = (index, members) => `<div class="${seat}_root" id="seat-${index}" data-chat-group-key="g${index}" data-step-process>
  <div><button type="button" class="${seat}_title">Used tools</button></div>
  <div class="${seat}_body ${seat}_expandedBody" data-step-process-body><div class="${seat}_content" data-step-process-content data-chat-flow="">
    ${Array.from({ length: members }, (_, member) => item(`cell-${index}-${member}`, 'tool-call', '', 'data-turn-process-member')).join('')}
  </div></div>
</div>`
const fixture = ({ advanced = false, seats = 0, rows = 0 } = {}) => `${advanced ? '<body data-bt-advanced>' : '<body>'}<style>
  *{box-sizing:border-box}html,body{margin:0;font:14px/24px Arial}
  ${flowCss}\n${seatCss}\n${botCss}
</style><div class="${flow}_column"><div data-slot="conversation.chat.flow" style="display:contents">
  ${item('ask', 'user', '<div id="asked" class="bt-urow"><div class="bt-ububble">Hello</div></div>')}
  ${Array.from({ length: seats }, (_, index) => seatOf(index, 2)).join('')}
  ${Array.from({ length: rows }, (_, index) => item(`row-${index}`, 'tool-call', '')).join('')}
  ${item('reply', 'assistant-step', '<div id="answer">Reply</div>', 'data-chat-group-part="response"')}
</div></div>`

async function open(page, options) {
  await page.setContent(fixture(options))
  await page.addScriptTag({ content: seedsJs })
  await page.addScriptTag({ content: cellsJs })
}
const draw = (page, id, kind) => page.evaluate(([slotId, what]) => window.draw(slotId, what), [id, kind])
// The band between the user's message and the reply, and each seat's box, after the
// mark's observer has run.
const measure = page => page.evaluate(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const box = node => node.getBoundingClientRect()
  return {
    band: box(document.getElementById('answer')).top - box(document.getElementById('asked')).bottom,
    seats: [...document.querySelectorAll('[data-step-process]')].map(node => ({ display: getComputedStyle(node).display, height: box(node).height })),
    rows: [...document.querySelectorAll('[id^=row-]')].map(node => getComputedStyle(node.parentElement).display),
    emptied: document.querySelectorAll('[data-bt-emptied]').length,
  }
})

test('turns that draw nothing leave no blank band between the messages around them', async (t) => {
  // CI must run the browser half: the shared guard fails there, never skips.
  const guard = await browserGuard()
  if (guard.skip) return t.skip(guard.skip)
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const evidence = process.env.GAPS_EVIDENCE_DIR
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 720 }]) {
    await t.test(`hidden turns at ${viewport.width}px`, async () => {
      await page.setViewportSize(viewport)
      await open(page)
      const plain = await measure(page)
      assert.ok(plain.band > 0, 'the reply sits below the message')

      // Six turns whose two calls each draw nothing: the band stays what it was.
      await open(page, { seats: 6 })
      for (let index = 0; index < 6; index++) for (const member of [0, 1]) await draw(page, `cell-${index}-${member}`, 'mark')
      const hidden = await measure(page)
      t.diagnostic(`${viewport.width}px: band ${plain.band}px plain, ${hidden.band}px over six empty turns`)
      if (evidence) await page.screenshot({ path: `${evidence}/empty-turns-${viewport.width}.png` })
      assert.equal(hidden.emptied, 12, 'every emptied cell marks its slot')
      assert.deepEqual(hidden.seats.map(each => each.display), Array(6).fill('none'), 'an emptied seat takes no room')
      assert.equal(hidden.band, plain.band, 'no blank band per hidden turn')

      // A call that settles into a visible line brings its seat back, and only that one.
      await draw(page, 'cell-2-1', 'mixed')
      const one = await measure(page)
      assert.deepEqual(one.seats.map(each => each.display === 'none'), [true, true, false, true, true, true])
      assert.ok(one.seats[2].height > 0, 'the seat with a visible line shows it')
      assert.ok(one.band > plain.band)
      // And the line leaving empties the seat again.
      await draw(page, 'cell-2-1', 'mark')
      assert.equal((await measure(page)).band, plain.band)

      // A row of its own (no seat) that holds only a settled card's mark takes no room.
      await open(page, { rows: 3 })
      for (let index = 0; index < 3; index++) await draw(page, `row-${index}`, index === 1 ? 'gone' : 'mark')
      const rows = await measure(page)
      assert.deepEqual(rows.rows, ['none', 'none', 'none'])
      assert.equal(rows.band, plain.band, 'no blank band per emptied row')
    })
  }

  await t.test('a seat another renderer fills, or one in Advanced, is never taken for empty', async () => {
    await page.setViewportSize({ width: 1440, height: 900 })
    // One cell of the seat is not this plugin's: plain text, with no element child.
    await open(page, { seats: 1 })
    await draw(page, 'cell-0-0', 'mark')
    await page.evaluate(() => { document.getElementById('cell-0-1').textContent = 'Ran a command' })
    const mixed = await measure(page)
    assert.equal(mixed.seats[0].display, 'block')
    assert.ok(mixed.seats[0].height > 0)
    // Advanced keeps DSH's own seat and its header, whatever its cells draw.
    await open(page, { advanced: true, seats: 1 })
    for (const member of [0, 1]) await draw(page, `cell-0-${member}`, 'mark')
    const advanced = await measure(page)
    assert.equal(advanced.seats[0].display, 'block')
    assert.ok(advanced.seats[0].height > 0, 'the seat header stays in Advanced')
  })
})
