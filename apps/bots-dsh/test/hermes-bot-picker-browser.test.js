// The Hermes bot picker in a real browser, in the Automagik theme: the two bots by name with
// what each is, the model as a secondary line, running and not running as a word beside a dot,
// and the stopped bot's start command. HERMES_PICKER_SHOTS=<folder> saves the screenshots there.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
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
  entryPoints: [join(plugin, 'test/fixtures/hermes-picker-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text' },
})
const SHOTS = process.env.HERMES_PICKER_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

async function page(t, { width = 760, height = 980, dark = false } = {}) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const view = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  view.setDefaultTimeout(6000)
  const errors = []
  view.on('pageerror', error => errors.push(error.message))
  view.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()) })
  await view.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{background:var(--bt-main);color:var(--bt-ink);font:400 15px/22px var(--bt-font)}</style><div id="root"></div>' })
    : route.abort()))
  await view.goto('https://automagik.test/')
  await view.addScriptTag({ content: seeds.outputFiles[0].text })
  await view.addScriptTag({ content: 'window.require=name=>name===\'@deepseek-ai/dsh-client-ui-primitives\'?{MarkdownText:()=>null}:window.nativeSeeds[name];' })
  await view.addScriptTag({ content: app.outputFiles[0].text })
  await view.evaluate(dark => window.mount({ dark }), dark)
  await view.locator('.bt-hw-host-choice').first().waitFor()
  await view.evaluate(() => window.pickHost())
  await view.locator('.bt-hw-foot button', { hasText: 'Connect' }).click()
  await view.locator('[data-step=bots]').waitFor()
  t.after(() => assert.deepEqual(errors, [], 'the page throws nothing'))
  return view
}

test('the picker draws every bot by name with its model second and its state as a word', async t => {
  const view = await page(t)
  if (!view) return
  const rows = view.locator('.bt-hw-bot')
  assert.equal(await rows.count(), 2)
  assert.deepEqual(await rows.locator('strong').allTextContents(), ['Luna', 'Atlas'])
  assert.deepEqual(await rows.locator('.bt-hw-bot-state').allTextContents(), ['Running', 'Not running'])
  assert.equal(await view.locator('.bt-hw-content h2').textContent(), 'Pick the bot')
  const running = await rows.nth(0).innerText()
  assert.match(running, /Model: anthropic\/claude-sonnet/)
  assert.doesNotMatch(running, /claude-sonnet \(anthropic\)/, 'the provider is not repeated when the model names it')
  assert.doesNotMatch(running, /Start it with/)
  const stopped = await rows.nth(1).innerText()
  assert.match(stopped, /Start it with “hermes serve” on sample-mac in a terminal\. Automagik never starts or restarts Hermes\./)
  // The narrowest wizard width: nothing scrolls sideways and both rows stay inside the list.
  const fits = await view.evaluate(() => {
    const list = document.querySelector('.bt-hw-bots').getBoundingClientRect()
    return {
      page: document.documentElement.scrollWidth <= window.innerWidth,
      rows: [...document.querySelectorAll('.bt-hw-bot')].every(node => {
        const box = node.getBoundingClientRect()
        return box.left >= list.left - 0.5 && box.right <= list.right + 0.5
      }),
    }
  })
  assert.deepEqual(fits, { page: true, rows: true })
  // The theme is the real one: cream page, ink words, a hairline list.
  const inks = await view.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    name: getComputedStyle(document.querySelector('.bt-hw-bot strong')).color,
    border: getComputedStyle(document.querySelector('.bt-hw-bots')).borderTopWidth,
  }))
  assert.notEqual(inks.page, 'rgba(0, 0, 0, 0)')
  assert.notEqual(inks.name, inks.page)
  assert.equal(inks.border, '1px')
  if (SHOTS) {
    await view.waitForTimeout(300)
    await view.screenshot({ path: join(SHOTS, 'hermes-bot-picker-light.png') })
    await view.evaluate(() => window.mount({ dark: true }))
    await view.locator('.bt-hw-host-choice').first().waitFor()
    await view.evaluate(() => window.pickHost())
    await view.locator('.bt-hw-foot button', { hasText: 'Connect' }).click()
    await view.locator('[data-step=bots]').waitFor()
    await view.waitForTimeout(300)
    await view.screenshot({ path: join(SHOTS, 'hermes-bot-picker-dark.png') })
  }
})

test('the picker never tests or starts anything before the person picks a bot', async t => {
  const view = await page(t)
  if (!view) return
  assert.deepEqual((await view.evaluate(() => window.calls)).sort(), ['hermes-remote', 'hermes-remote-detect', 'hermes-remote-ssh-hosts'].sort())
  const use = view.locator('.bt-hw-foot button', { hasText: 'Use this bot' })
  assert.equal(await use.isDisabled(), false, 'the running bot is picked already')
  await view.locator('.bt-hw-bot[data-running=false]').click()
  assert.equal(await use.isDisabled(), true, 'a stopped bot cannot be used')
  assert.deepEqual((await view.evaluate(() => window.calls)).sort(), ['hermes-remote', 'hermes-remote-detect', 'hermes-remote-ssh-hosts'].sort())
})
