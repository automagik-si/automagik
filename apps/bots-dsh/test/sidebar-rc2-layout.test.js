// The published rc.2 sidebar CSS and nesting, with Automagik's own styles layered on it.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'
import { nativeCss } from './native-css.js'

const harness = createRequire(new URL('../dev/harness/package.json', import.meta.url))
const sheets = nativeCss(readFileSync(harness.resolve('@deepseek-ai/dsh-client-ui-sidebar/client'), 'utf8'))
const native = sheets.find(css => css.includes('_scrollRegion{') && css.includes('_regionArea{'))
assert.ok(native, 'the real rc.2 sidebar sheet must be present')
const prefix = native.match(/\.([\w-]+)_scrollRegion\{/)[1]
const compiled = await build({ stdin: { contents: "export { SHELL_CSS } from './src/client/styles.js'; export { SIDEBAR_CSS } from './src/client/sidebar.js'", resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const module = { exports: {} }
// The bundled modules make a React context, extend React.Component and draw icons as they load.
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: () => ({ createContext: value => ({ value }), Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) }) })
const { SHELL_CSS, SIDEBAR_CSS } = module.exports

for (const width of [1440, 390]) for (const dark of [false, true]) {
  test(`rc.2 sidebar keeps controls fixed and the collapsed rail centred at ${width}, ${dark ? 'dark' : 'light'}`, async t => {
    const browser = await browserGuard()
    if (browser.skip) return t.skip(browser.skip)
    const chrome = await browser.chromium.launch({ executablePath: browser.executablePath, headless: true, args: ['--no-sandbox'] })
    t.after(() => chrome.close())
    const page = await chrome.newPage({ viewport: { width, height: 800 } })
    await page.setContent(`<style>${native}\n${SHELL_CSS}\n${SIDEBAR_CSS}\nhtml,body{margin:0;height:100%}.frame{width:280px;height:100%}.bt-row{flex-shrink:0;min-height:44px}.bt-side-top{min-height:40px}</style><body ${dark ? 'data-ds-dark-theme' : ''}><div class="frame"><aside class="${prefix}_root"><div class="${prefix}_scrollRegion"><div class="${prefix}_scrollArea"><nav class="${prefix}_panelList"></nav><div class="${prefix}_regionArea"><div class="bt-side"><div class="bt-side-top"><button>Search</button></div><div class="bt-list">${Array.from({ length: 40 }, (_, index) => `<button class="bt-row">Bot ${index + 1}</button>`).join('')}</div></div></div></div></div><div class="${prefix}_footArea">Account</div></aside></div></body>`)
    const fixed = await page.locator('.bt-side-top').boundingBox()
    const scrolled = await page.evaluate(() => {
      const list = document.querySelector('.bt-list')
      list.scrollTop = list.scrollHeight
      return { top: list.scrollTop, height: list.clientHeight, content: list.scrollHeight, outer: document.querySelector('[class*="_scrollArea"]').scrollTop }
    })
    assert.ok(scrolled.top > 0 && scrolled.height < scrolled.content, 'the Bot list must own its scroll')
    assert.equal(scrolled.outer, 0, 'the native grid does not scroll away the controls')
    assert.deepEqual(await page.locator('.bt-side-top').boundingBox(), fixed)
    await page.evaluate(prefix => {
      document.querySelector('.frame').style.width = '56px'
      document.querySelector('aside').classList.add(`${prefix}_collapsed`)
      document.querySelector('.bt-side').classList.add('bt-rail')
    }, prefix)
    const region = page.locator(`[class*="_regionArea"]`)
    const centered = await region.evaluate(node => ({ display: getComputedStyle(node).display, justify: getComputedStyle(node).justifyContent }))
    assert.deepEqual(centered, { display: 'flex', justify: 'center' }, 'the nested collapsed region keeps the centring rule')
  })
}
