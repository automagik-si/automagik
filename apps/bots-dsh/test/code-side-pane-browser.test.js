// The typing pane's resume rule in a real browser with the real xterm (RFC 0030 delivery 2):
// nothing typed before typing is confirmed is sent. A waking Enter only retakes; keys during
// the retake are dropped; a paste in the ended state only retakes; after confirmation the next
// key reaches the input route. Every name and terminal here is made up.
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
  entryPoints: [join(plugin, 'test/fixtures/code-side-pane-browser-app.js')],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text', '.svg': 'dataurl' },
})

const calls = page => page.evaluate(() => window.__calls.filter(call => call.url.includes('/code/')))
const note = page => page.locator('.cs-paste-note').textContent().catch(() => '')

test('a waking key or paste only retakes; nothing typed before confirmation is sent', async (t) => {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://automagik.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' })
    return route.abort()
  })
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(() => window.mountPane())
  await page.locator('.cs-screen').click()
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')

  // Make the next batch answer 409 (the lease ended) without a second key event: paste.
  const endTyping = async () => {
    await page.evaluate(() => { window.__inputStatus = 409; window.__calls.length = 0 })
    await page.evaluate(() => {
      const target = document.querySelector('.cs-screen')
      const data = new DataTransfer()
      data.setData('text/plain', 'x')
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'ended')
    assert.match(await note(page), /Typing paused after 60 s idle/)
  }
  // A waking Enter only retakes; it is not sent, before or after the confirmation.
  await endTyping()
  await page.evaluate(() => { window.__calls.length = 0 })
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')
  let recorded = await calls(page)
  assert.equal(recorded.filter(call => call.url.includes('/take')).length, 1, 'the waking Enter retakes once')
  assert.equal(recorded.filter(call => call.url.includes('/input')).length, 0, 'the waking Enter is never sent')
  assert.match(await note(page), /Typing is back: type again/)

  // After the confirmation, the next key goes through normally.
  await page.evaluate(() => { window.__inputStatus = 204; window.__calls.length = 0 })
  await page.keyboard.type('a')
  await page.waitForFunction(() => window.__calls.some(call => call.url.includes('/input')))
  recorded = await calls(page)
  const input = recorded.find(call => call.url.includes('/input'))
  assert.equal(Buffer.from(input.body.data, 'base64').toString('utf8'), 'a')

  // Keys typed during the retake are dropped: they are not sent after it either.
  await endTyping()
  await page.evaluate(() => { window.__calls.length = 0; window.__takeDelay = 300 })
  await page.keyboard.press('c')
  await page.keyboard.press('d')
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')
  recorded = await calls(page)
  assert.equal(recorded.filter(call => call.url.includes('/input')).length, 0, 'keys during the retake are never sent')
  assert.match(await note(page), /Typing is back: type again/)

  // A paste in the ended state only retakes; its text is not sent.
  await page.evaluate(() => { window.__takeDelay = 0 })
  await endTyping()
  await page.evaluate(() => {
    window.__calls.length = 0
    const target = document.querySelector('.cs-screen')
    const data = new DataTransfer()
    data.setData('text/plain', 'echo PASTED\n')
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('.cs-screen')?.dataset.codeMode === 'typing')
  recorded = await calls(page)
  assert.equal(recorded.filter(call => call.url.includes('/take')).length, 1, 'the paste retakes')
  assert.equal(recorded.filter(call => call.url.includes('/input')).length, 0, 'the paste is never sent')
  assert.match(await note(page), /Typing is back: type again/)

  assert.deepEqual(errors, [], 'the pane throws nothing')
})
