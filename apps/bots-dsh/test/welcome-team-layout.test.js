// The welcome's real TeamStep in a browser, with its shipped styles and a fake welcome host.
// At 320px the grid has 236px left: its cards and Continue must stay on screen (#1165), asleep
// and on the team, in both themes. React is the pinned DSH's own.
// WELCOME_TEAM_SHOTS=<folder> saves screenshots there.
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
const entry = readdirSync(assets).find(name => /^index-.*\.js$/.test(name))
const frontend = readFileSync(join(assets, entry), 'utf8')
const seedFactory = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seedFactory, 'pinned DSH supplies the React seed factory')
const seeds = await build({
  stdin: {
    contents: frontend.slice(0, seedFactory.index + seedFactory[0].length)
      + `; window.nativeSeeds = ${seedFactory[1]}();`,
    resolveDir: assets,
  },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})
const app = await build({
  entryPoints: [join(plugin, 'test/fixtures/welcome-team-browser-app.js')],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: [
    'react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', '@automagik/bots-dsh/client',
  ],
  loader: { '.css': 'text' },
  // These phases never draw the install terminal; xterm belongs to the welcome's CI job.
  plugins: [{
    name: 'no-xterm',
    setup(b) {
      b.onResolve({ filter: /^@xterm\/xterm(\/.*)?$/ }, args => ({
        path: args.path, namespace: 'no-xterm',
      }))
      b.onLoad({ filter: /.*/, namespace: 'no-xterm' }, args => ({
        contents: args.path.endsWith('.css') ? '' : 'export class Terminal {}',
        loader: args.path.endsWith('.css') ? 'text' : 'js',
      }))
    },
  }],
})
const SHOTS = process.env.WELCOME_TEAM_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

async function fixture(t, { width, dark, joined, unfold = false }) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({
    executablePath: guard.executablePath, headless: true,
  })
  t.after(() => browser.close())
  const page = await browser.newPage({
    viewport: { width, height: 900 }, reducedMotion: 'reduce',
  })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
      errors.push(message.text())
    }
  })
  t.after(() => assert.deepEqual(errors, [], 'the welcome team step throws nothing'))
  await page.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({
      contentType: 'text/html', body: '<!doctype html><div id="root"></div>',
    })
    : route.abort()))
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(({ dark, joined, unfold }) => {
    window.setPower('omni', joined ? 'linked' : 'asleep')
    window.setPower('genie', joined ? 'ready' : 'asleep')
    // Opened for Unfold, its card leads, already powered (team.js teamOrder).
    if (unfold) window.setPower('unfold', 'ready')
    window.mount({ dark, preload: unfold ? 'unfold' : null })
  }, { dark, joined, unfold })
  await page.locator('.oai-actions button').waitFor()
  await page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  }))
  return page
}

for (const width of [320, 390, 1440]) {
  for (const dark of [false, true]) {
    for (const [joined, unfold] of [[false, false], [true, false], [true, true]]) {
      const mode = dark ? 'dark' : 'light'
      const state = unfold ? 'with Unfold' : joined ? 'joined' : 'asleep'
      test(`the welcome team fits at ${width}px (${mode}, ${state})`, async (t) => {
        const page = await fixture(t, { width, dark, joined, unfold })
        if (!page) return
        assert.equal(await page.locator('.oai-card').count(), 1)
        assert.equal(await page.locator('.oai-select').count(), 1)
        assert.equal(await page.locator('.oai-fighter').count(), unfold ? 3 : 2)
        // Each card's machine (its box and power button) is drawn and measured below.
        assert.equal(await page.locator('.oai-fighter .oai-box').count(), unfold ? 3 : 2)
        if (unfold) {
          const first = page.locator('.oai-fighter').first()
          assert.match(await first.getAttribute('class'), /\boai-unfold\b/)
          assert.equal(await first.locator('.oai-on-team').count(), 1)
        }
        for (const kind of ['omni', 'genie']) {
          const card = page.locator(`.oai-fighter.oai-${kind}`)
          const phase = joined ? (kind === 'omni' ? 'linked' : 'ready') : 'asleep'
          assert.equal(await card.getAttribute('data-phase'), phase)
          const label = card.locator('.oai-on-team')
          assert.equal(await label.count(), joined ? 1 : 0)
          if (joined) {
            assert.equal(await label.isVisible(), true)
            assert.equal(await label.textContent(), 'On your team')
          }
        }
        const remove = page.locator('.oai-remove')
        assert.equal(await remove.count(), joined ? 1 : 0)
        if (joined) {
          assert.equal(await remove.isVisible(), true)
          assert.equal(await remove.textContent(), 'Remove')
        }
        const button = page.locator('.oai-actions button')
        assert.equal(await button.count(), 1)
        assert.equal(await button.isVisible(), true)
        assert.match(await button.textContent(), /^Continue with /)
        const layout = await page.evaluate(() => {
          const overlay = document.querySelector('.oai-overlay')
          const selectors = [
            '.oai-card', '.oai-select', '.oai-fighter', '.oai-box', '.oai-power',
            '.oai-on-team', '.oai-remove', '.oai-actions button',
          ]
          const boxes = [...document.querySelectorAll(selectors.join(','))]
            .filter(node => node.checkVisibility())
            .map((node) => {
              const { left, right, width } = node.getBoundingClientRect()
              return { name: node.className, left, right, width }
            })
          return {
            scroll: overlay.scrollWidth, client: overlay.clientWidth,
            viewport: innerWidth, boxes,
          }
        })
        assert.ok(layout.scroll <= layout.client + 1, JSON.stringify(layout))
        for (const box of layout.boxes) {
          assert.ok(box.width > 0 && box.left >= 0 && box.right <= layout.viewport + 1,
            `${box.name} lies outside the viewport: ${JSON.stringify(box)}`)
        }
        if (SHOTS) {
          const name = `${width}-${mode}-${state.replace(' ', '-')}.png`
          await page.screenshot({ path: join(SHOTS, name) })
        }
      })
    }
  }
}
