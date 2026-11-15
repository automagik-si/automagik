// Where a group's goal island sits in Automagik's header band. The band is right-aligned (Details on
// the right), so the island is placed by rule: on the chat column's centre where the band has room,
// in the row beside Details where it does not; level with Details; one surface, with no theme look
// of a header button on its inner parts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { allThemes, themeCss } from '../src/client/themes.js'
import { browserGuard } from './browser-guard.js'

const source = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
const goal = source('goal.js')

test('the island centres on the chat column in a wide band and stays in the row in a narrow one', () => {
  // The band, not the window, is measured: the left column and an open panel both narrow it.
  assert.ok(goal.includes('header[class*="_header"] .bt-head{container:bt-head/inline-size}'))
  assert.ok(goal.includes('@container bt-head (min-width:820px){.bt-island{position:absolute;top:var(--bt-island-top,0px);left:0;right:0;margin-inline:auto}}'))
  // Out of the container rule the island is a flex item of the band, at the row's start.
  const own = /\n\.bt-island\{([^}]*)\}/.exec(goal)[1]
  assert.match(own, /position:relative/)
  assert.match(own, /align-self:flex-start/)
  // Open, a centred island of 560 px ends before Details in a band of 820 px with the theme's 24 px edge.
  assert.match(goal, /\.bt-island\[data-open\]\{width:min\(560px,calc\(100% - 48px\)\)/)
  assert.ok((820 + 560) / 2 < 820 - 24 - 95, 'an open island reaches Details at the narrowest centred band')
})

test('the island takes its radius and its level from the theme, and the Automagik theme sets both', () => {
  const own = /\n\.bt-island\{([^}]*)\}/.exec(goal)[1]
  assert.match(own, /border-radius:var\(--bt-island-radius,20px\)/)
  assert.match(own, /margin-top:var\(--bt-island-lift,0px\)/)
  // The Automagik theme pads the band by 18 px and centres Details 3 px above the row's start.
  assert.ok(source('stage.js').includes('html body .bt-head{min-height:64px;padding:18px 24px 12px;--bt-island-top:18px;--bt-island-lift:-3px;--bt-island-radius:12px}'))
})

test('a theme\'s header button look stops at the island\'s edge', () => {
  assert.ok(goal.includes('html body .bt-island :is(.bt-pill,.bt-goal-bar,.bt-goal-step){border:0;border-radius:0;background:none;box-shadow:none}'))
  assert.ok(goal.includes('html body .bt-island :is(.bt-pill,.bt-goal-bar,.bt-goal-step):is(:hover,:active):not(:disabled){box-shadow:none;transform:none}'))
  // Both themes dress every button in the band; the island's rule is the more specific one.
  for (const sheet of ['stage.js', 'clay.js']) assert.ok(source(sheet).includes('html body :is(.bt-soft,.bt-q-btn,.bt-pill,.bt-model-chip,.bt-head button){'), sheet)
})

// A long goal title in a narrow band (a 390 px window): the title ends in an ellipsis before
// the stage counter. A start-aligned grid cell is as wide as its text asks, so without the
// column and cell limits the title ran over the counter.
test('the swap area holds a long goal title to its own width', () => {
  assert.ok(goal.includes('.bt-pill-swap{flex:1 1 auto;min-width:0;display:grid;grid-template-columns:minmax(0,1fr);justify-items:start;text-align:left}'))
  assert.ok(goal.includes('.bt-pill-swap>*{grid-area:1/1;min-width:0;max-width:100%;'))
})

// The same, measured: its own test, so the measure fails by itself when the rule is gone.
test('a long goal title stops before the stage counter', async (t) => {
  // CI must run the browser half (#323, #364): the shared guard fails there, never skips.
  const guard = await browserGuard()
  if (guard.skip) return t.skip(guard.skip)
  const { outputFiles } = await build({
    stdin: { contents: "export { GOAL_CSS } from './src/client/goal.js'\nexport { SHELL_CSS, CONVERSATION_CSS } from './src/client/styles.js'", resolveDir: new URL('..', import.meta.url).pathname },
    bundle: true, format: 'cjs', platform: 'browser', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
  const { GOAL_CSS, SHELL_CSS, CONVERSATION_CSS } = module.exports
  const LONG = 'Ship the spring guide with every chapter checked twice'
  const fixture = (theme, title) => `<!doctype html><html data-bt-conversation><head><style>
    *{box-sizing:border-box}html,body{margin:0;font:14px/20px Arial}
    ${SHELL_CSS}\n${CONVERSATION_CSS}\n${GOAL_CSS}\n${themeCss(theme)}
  </style></head><body><header class="x_header"><div class="bt-head">
    <div class="bt-island"><button type="button" class="bt-pill">
      <span style="flex:none;width:24px;height:24px"></span>
      <span class="bt-pill-swap"><span class="bt-pill-goal"><span class="bt-pill-ico"></span><span class="bt-pill-title">${title}</span></span><span class="bt-pill-name">${title}</span></span>
      <span class="bt-pill-count">2/3</span>
    </button></div>
    <button type="button" class="bt-head-details" title="Details" aria-label="View conversation details" aria-expanded="false">Details</button>
  </div></header></body></html>`
  const measure = () => {
    const box = selector => document.querySelector(selector).getBoundingClientRect()
    const title = document.querySelector('.bt-pill-title')
    return {
      title: box('.bt-pill-title').right, name: box('.bt-pill-name').right, count: box('.bt-pill-count').left,
      countEnd: box('.bt-pill-count').right, pillEnd: box('.bt-pill').right, cut: title.scrollWidth > title.clientWidth,
    }
  }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.setViewportSize({ width: 390, height: 600 })
  for (const [id, theme] of Object.entries(allThemes())) {
    await page.setContent(fixture(theme, LONG))
    const long = await page.evaluate(measure)
    assert.ok(long.title <= long.count + 0.5, `${id}: the title ends at ${long.title}, the counter starts at ${long.count}`)
    assert.ok(long.name <= long.count + 0.5, `${id}: the group name ends at ${long.name}, the counter starts at ${long.count}`)
    assert.ok(long.cut, `${id}: the long title is cut with an ellipsis`)
    assert.ok(long.countEnd <= long.pillEnd + 0.5, `${id}: the counter stays inside the pill`)
    // A short title is left whole.
    await page.setContent(fixture(theme, 'Ship it'))
    assert.equal((await page.evaluate(measure)).cut, false, `${id}: a short title is not cut`)
  }
})
