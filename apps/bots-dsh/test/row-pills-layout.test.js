// A sidebar row shows every capability pill of its Bot in full (#1157). The Main Bot has two
// (Computer or Channels, and Leads the team), and they do not fit on one line of a narrow
// row: the pill line used to be 16px high with its overflow hidden, so the second pill
// wrapped out of sight.
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'

const compiled = await build({ stdin: { contents: "export { SHELL_CSS } from './src/client/styles.js'", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const module = { exports: {} }
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { SHELL_CSS } = module.exports

const rule = selector => SHELL_CSS.match(new RegExp(`(?:^|\\n)${selector.replace(/[.>]/g, '\\$&')}\\{([^}]*)\\}`))?.[1]

test('the pill line of a sidebar row has no fixed height and hides nothing', () => {
  const caps = rule('.bt-row-caps')
  assert.ok(caps, 'the sheet styles .bt-row-caps')
  assert.match(caps, /flex-wrap:wrap/, 'a pill that does not fit goes on to the next line')
  assert.doesNotMatch(caps, /(?:^|;)(?:max-)?height:/, 'the line grows with its pills')
  assert.doesNotMatch(caps, /overflow(?:-[xy])?:\s*(?:hidden|clip)/, 'no pill is cut or hidden')
})

// The row as sidebar.js BotRow draws it for a Main Bot (crowned: a 42px avatar), in a list as
// wide as the sidebar: 280px on a desktop, 240px in the phone's drawer.
const row = `<div class="bt-side" style="width:WIDTHpx"><div class="bt-list">
<button type="button" class="bt-row bt-row-crowned"><span style="flex:none;width:42px;height:42px"></span>
<span class="bt-row-body"><span class="bt-row-name"><span class="bt-row-title">Omni</span></span>
<span class="bt-caps bt-row-caps"><span class="bt-tag bt-cap" data-pill="computer">Computer</span><span class="bt-tag bt-cap" data-pill="leads">Leads the team</span></span>
<span class="bt-row-preview">Yes. CSV export is in.</span></span></button></div></div>`

for (const width of [280, 240, 200]) {
  test(`every pill of a ${width}px wide row is drawn in full`, async (t) => {
    const browser = await browserGuard()
    if (browser.skip) return t.skip(browser.skip)
    const chrome = await browser.chromium.launch({ executablePath: browser.executablePath, headless: true, args: ['--no-sandbox'] })
    t.after(() => chrome.close())
    const page = await chrome.newPage({ viewport: { width: 400, height: 400 } })
    await page.setContent(`<style>${SHELL_CSS}\nhtml,body{margin:0}</style><body>${row.replace('WIDTH', width)}</body>`)
    const seen = await page.evaluate(() => {
      const box = node => node.getBoundingClientRect()
      const line = box(document.querySelector('.bt-row-caps'))
      const button = box(document.querySelector('.bt-row'))
      const preview = box(document.querySelector('.bt-row-preview'))
      return {
        pills: [...document.querySelectorAll('.bt-cap')].map((pill) => {
          const at = box(pill)
          // The point at the pill's middle belongs to the pill: nothing covers or clips it.
          const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)
          return { text: pill.textContent, inLine: at.top >= line.top - 0.5 && at.bottom <= line.bottom + 0.5 && at.left >= line.left - 0.5 && at.right <= line.right + 0.5, whole: pill.scrollWidth <= pill.clientWidth, hit: hit === pill }
        }),
        lineInRow: line.bottom <= button.bottom + 0.5,
        previewBelow: preview.top >= line.bottom - 0.5 && preview.bottom <= button.bottom + 0.5,
      }
    })
    for (const pill of seen.pills) {
      assert.ok(pill.inLine, `${pill.text} is inside the pill line`)
      assert.ok(pill.whole, `${pill.text} is not cut short`)
      assert.ok(pill.hit, `${pill.text} is not clipped or covered`)
    }
    assert.ok(seen.lineInRow, 'the row grows with its pill line')
    assert.ok(seen.previewBelow, 'the preview stays under the pills, inside the row')
  })
}
