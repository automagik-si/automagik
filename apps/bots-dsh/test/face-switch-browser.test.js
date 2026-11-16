// A REAL mouse click on the header's Chat / Terminal switch (RFC 0030 delivery 1's flip): the
// switch sits inside .bt-head, which lets pointer events through to the shell, so a click must
// still land on the switch's own parts at 1440 and 390. Playwright's mouse click is a real
// pointer; el.click() would bypass hit testing and hide this bug.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = join(process.env.DSH_HARNESS, 'node_modules/@deepseek-ai')
const assets = join(harness, 'dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seedFactory = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seedFactory, 'pinned DSH supplies the React seed factory')
const seeds = await build({ stdin: { contents: `${frontend.slice(0, seedFactory.index + seedFactory[0].length)}; window.nativeSeeds = ${seedFactory[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const app = await build({
  entryPoints: [join(plugin, 'test/fixtures/face-switch-browser-app.js')],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text', '.svg': 'dataurl' },
})

const openSwitch = async (page) => {
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://automagik.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' })
    return route.abort()
  })
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(() => window.mountSwitch())
  await page.locator('.lb-face-part[data-face="terminal"]').waitFor()
}

test('a real mouse click on Terminal reaches the switch at 1440 and 390', async (t) => {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const errors = []
  for (const { width, height } of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
    page.setDefaultTimeout(6000)
    page.on('pageerror', error => errors.push(error.message))
    await openSwitch(page)
    const box = await page.locator('.lb-face-part[data-face="terminal"]').boundingBox()
    assert.ok(box && box.width > 0 && box.height > 0, `the Terminal part has a box at ${width}`)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const picked = await page.evaluate(() => window.__picked)
    assert.equal(picked, 'terminal', `a real click on Terminal reaches the switch at ${width}`)
    await page.close()
  }
  assert.deepEqual(errors, [], 'the switch throws nothing')
})
