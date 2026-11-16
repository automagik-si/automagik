// The sidebar's tools (extend.js sidebarTools) in a real browser, with the welcome's power
// shortcut in them (apps/welcome-dsh/src/client/power-shortcut.js): where the button sits in the
// top row and the rail, that the row still fits, that the card stays in the window, and how it
// takes and gives back focus, over the Stage, Clay and a plain theme, light and dark. React is the
// pinned DSH's own; the welcome host is a fake in the page. POWER_SHORTCUT_SHOTS=<folder> saves
// screenshots there.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  entryPoints: [join(plugin, 'test/fixtures/power-shortcut-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives', '@automagik/bots-dsh/client'], loader: { '.css': 'text' },
  // The welcome's install terminal (terminal.js) loads xterm, a welcome-only dependency that
  // this package's CI job does not install. The shortcut never draws the terminal: stub it.
  plugins: [{
    name: 'no-xterm',
    setup(b) {
      b.onResolve({ filter: /^@xterm\/xterm(\/.*)?$/ }, args => ({ path: args.path, namespace: 'no-xterm' }))
      b.onLoad({ filter: /.*/, namespace: 'no-xterm' }, args => ({ contents: args.path.endsWith('.css') ? '' : 'export class Terminal {}', loader: args.path.endsWith('.css') ? 'text' : 'js' }))
    },
  }],
})
const SHOTS = process.env.POWER_SHORTCUT_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

async function fixture(t, { width = 1440, height = 820, theme = 'deepseek', dark = false, desktop = null, herdr = false } = {}) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error' && !/a broken tool|The above error occurred|Failed to load resource/.test(message.text())) errors.push(message.text()) })
  await page.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bt-main)}#bench{padding:12px 0 0 12px;background:var(--bt-sidebar);height:100%}</style><div id="bench"><div id="root"></div></div><button id="after">After</button>' })
    : route.abort()))
  await page.goto('https://automagik.test/')
  if (desktop) await page.evaluate(platform => document.documentElement.setAttribute('data-automagik-desktop', platform), desktop)
  if (herdr) await page.evaluate(() => { window.omniDesktop = { herdr: { status: async () => ({ state: 'closed' }), open: async () => ({}) } } })
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(({ theme, dark }) => window.setTheme(theme, dark), { theme, dark })
  t.after(() => assert.deepEqual(errors, [], 'the sidebar and the shortcut throw nothing'))
  return page
}

const power = page => page.locator('button.bt-power')
const card = page => page.locator('.bt-power-pop')
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const rowFits = page => page.evaluate(() => window.rowCheck())
const inView = page => card(page).evaluate((node) => {
  const r = node.getBoundingClientRect()
  return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
})
async function shot(page, name) {
  if (!SHOTS) return
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  // The card's own markup beside it, to preview in a running app.
  const markup = await page.evaluate(() => document.querySelector('.bt-power-pop')?.innerHTML ?? null)
  if (markup) writeFileSync(join(SHOTS, `${name}.card.html`), markup)
}
// The Omni Bot as the welcome makes it (companion.js OMNI_BOT): the octopus, in DeepSeek blue.
const linkedOmni = page => page.evaluate(() => window.setRoster({ bots: [{ id: 'omni', name: 'Omni', kind: 'omni', createdAt: 1, color: 'deepseek', avatar: { shape: 'octopus' } }], omniLinked: true }))

for (const theme of ['deepseek', 'clay', 'mono']) {
  for (const dark of [false, true]) {
    test(`the power button sits between the update cloud and Search, and its card fits (${theme}, ${dark ? 'dark' : 'light'})`, async (t) => {
      const page = await fixture(t, { theme, dark })
      if (!page) return
      await linkedOmni(page)
      // DSH's widest sidebar (420px) less the stage card's margins and DSH's own padding.
      await page.evaluate(() => { window.setUpdate({ available: true, latest: '9.9.9', current: '1.0.0' }); window.mount({ width: 380 }) })
      await power(page).waitFor()
      const labels = await page.evaluate(() => [...document.querySelector('.lb-head').children].map(node => node.getAttribute('aria-label') ?? node.className))
      const at = labels.indexOf('Omni on, Genie off')
      assert.deepEqual(labels.slice(at - 1, at + 2), ['Omni 9.9.9 is available', 'Omni on, Genie off', 'Search'])
      assert.equal(await power(page).getAttribute('aria-label'), 'Omni on, Genie off')
      const fits = await rowFits(page)
      assert.ok(fits.fits, `the top row overflows: ${fits.out}`)
      // The button wears the row's own look: the same box as Search.
      const sizes = await page.evaluate(() => {
        const box = node => { const style = getComputedStyle(node); return [style.width, style.height, style.borderRadius, style.backgroundColor] }
        return { power: box(document.querySelector('.bt-power')), search: box(document.querySelector('.lb-head [aria-label="Search"]')) }
      })
      assert.deepEqual(sizes.power, sizes.search)
      await power(page).click()
      await card(page).waitFor()
      await frame(page)
      assert.equal(await inView(page), true)
      // The card is the update card's: same width, radius, shadow and colours.
      const look = await card(page).evaluate((node) => {
        const style = getComputedStyle(node)
        return { classes: node.className, width: style.width, radius: style.borderRadius, background: style.backgroundColor, animation: style.animationName }
      })
      assert.equal(look.classes, 'bt-update-pop bt-power-pop')
      assert.equal(look.width, '280px')
      assert.equal(look.animation, 'none', 'reduced motion: the card does not spring')
      const rows = await card(page).locator('[data-power]').evaluateAll(nodes => nodes.map(node => [node.dataset.power, node.dataset.state, node.querySelector('.bt-update-go')?.textContent ?? null]))
      assert.deepEqual(rows, [['omni', 'on', 'Power Omni off'], ['genie', 'off', 'Power Genie on']])
      // Each row leads with its product's mark, the Bot team's own, beside its name and status.
      const marks = await card(page).locator('[data-power]').evaluateAll(nodes => nodes.map((node) => {
        const mark = node.querySelector('.bt-power-who > .bt-mark')
        const name = node.querySelector('.bt-power-who .bt-update-title')
        const box = mark.getBoundingClientRect()
        return [mark.dataset.shape, Math.round(box.width), Math.round(box.height), box.right <= name.getBoundingClientRect().left]
      }))
      assert.deepEqual(marks, [['clay-omni', 28, 28, true], ['clay-genie', 28, 28, true]])
      await shot(page, `wide-${theme}-${dark ? 'dark' : 'light'}`)
    })
  }
}

// DSH's sidebar runs from 264px to 420px (280 by default); the card around it and DSH's padding
// take 40px. Every button in the row is flex, so a full row narrows all of them alike rather than
// overflow: the sweep records, per width, what the row looks like without and with the shortcut.
const SIDEBARS = [264, 280, 300, 320, 360, 420]
async function sweep(page, label) {
  const table = []
  for (const width of SIDEBARS) {
    const row = {}
    for (const tool of [false, true]) {
      await page.evaluate(([width, tool]) => window.mount({ width: width - 40, tool }), [width, tool])
      await (tool ? power(page) : page.locator('.lb-head [aria-label="Search"]')).waitFor()
      await frame(page)
      row[tool ? 'with' : 'without'] = await page.evaluate(() => window.rowCheck())
      if (width === 280) await shot(page, `header-${label}-280-${tool ? 'with' : 'without'}`)
    }
    // The shortcut is one of the row: never narrower than the buttons beside it.
    if (row.with.fits === false) {
      const widths = await page.evaluate(() => [...document.querySelectorAll('.lb-head .bt-round')].map(node => Math.round(node.getBoundingClientRect().width)))
      assert.ok(Math.min(...widths) >= Math.min(...widths.filter((_, i) => i !== 1)) - 2, `${widths}`)
    }
    table.push(`${width}px: without ${row.without.fits ? 'fits' : row.without.out.join('; ')} | with ${row.with.fits ? 'fits' : row.with.out.join('; ')}`)
  }
  return table
}

test('the top row with the shortcut, across DSH\'s sidebar widths, on the web and on the macOS desktop', async (t) => {
  for (const [label, options] of [['web', {}], ['darwin', { desktop: 'darwin', herdr: true }]]) {
    const page = await fixture(t, { width: 1440, ...options })
    if (!page) return
    if (options.herdr) await page.evaluate(() => window.mount({ width: 380 })).then(() => page.locator('.bt-code-switch').waitFor())
    const table = await sweep(page, label)
    for (const line of table) t.diagnostic(`${label}: ${line}`)
    // Where the row had room, it still has.
    const roomy = label === 'web' ? 1 : 0
    assert.ok(table.slice(-1 - roomy).every(line => line.includes('with fits')), table.join('\n'))
  }
})

test('at a 420px window, on the macOS desktop with the Work/Code switch and the update cloud, the card stays in the window', async (t) => {
  const page = await fixture(t, { width: 420, height: 760, desktop: 'darwin', herdr: true })
  if (!page) return
  await page.evaluate(() => { window.setUpdate({ available: true, latest: '9.9.9', current: '1.0.0' }); window.mount({ width: 380 }) })
  await page.locator('.bt-code-switch').waitFor()
  await power(page).waitFor()
  const fits = await rowFits(page)
  assert.ok(fits.fits, `the top row overflows: ${fits.out}`)
  await power(page).click()
  await card(page).waitFor()
  await frame(page)
  assert.equal(await inView(page), true)
  await shot(page, 'narrow-420-darwin')
})

test('in the collapsed rail the button sits under the update cloud, and its card stays in the window', async (t) => {
  const page = await fixture(t, { width: 420, height: 760, dark: true })
  if (!page) return
  await page.evaluate(() => { window.setUpdate({ available: true, latest: '9.9.9', current: '1.0.0' }); window.mount({ wide: false }) })
  await power(page).waitFor()
  const labels = await page.evaluate(() => [...document.querySelector('.bt-rail').children].map(node => node.getAttribute('aria-label')).filter(Boolean))
  assert.deepEqual(labels.slice(0, 3), ['Omni 9.9.9 is available', 'Omni off, Genie off', 'New…'])
  await power(page).click()
  await card(page).waitFor()
  await frame(page)
  assert.equal(await inView(page), true)
  await shot(page, 'rail-stage-dark')
})

test('the card is a dialog the keyboard can open, leave and come back from', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.mount({ width: 300 }))
  const button = power(page)
  assert.equal(await button.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(await button.getAttribute('aria-expanded'), 'false')
  assert.equal(await button.getAttribute('aria-controls'), null)
  await button.focus()
  await page.keyboard.press('Enter')
  await card(page).waitFor()
  await frame(page)
  assert.equal(await button.getAttribute('aria-expanded'), 'true')
  const id = await card(page).getAttribute('id')
  assert.equal(await button.getAttribute('aria-controls'), id)
  assert.equal(await card(page).getAttribute('role'), 'dialog')
  assert.equal(await card(page).getAttribute('aria-label'), 'Omni and Genie')
  assert.equal(await card(page).locator('[role=status][aria-live=polite]').count(), 2)
  // The first thing to do has the focus; a letter typed there starts no search.
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Power Omni on')
  await page.keyboard.press('k')
  assert.deepEqual(await page.evaluate(() => window.actionsCalled.filter(([name]) => name === 'openPalette')), [])
  // Escape closes it and gives the button the focus back.
  await page.keyboard.press('Escape')
  await card(page).waitFor({ state: 'detached' })
  assert.equal(await button.getAttribute('aria-expanded'), 'false')
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('bt-power')), true)
  // Tab past the last control closes it and moves on to Search.
  await page.keyboard.press('Enter')
  await card(page).waitFor()
  await frame(page)
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab')
  await card(page).waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Search')
  // A click outside closes it too.
  await button.click()
  await card(page).waitFor()
  await page.mouse.click(400, 600)
  await card(page).waitFor({ state: 'detached' })
})

test('powering on runs in the store: the button shows it working, the card follows, and it outlives the card', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => {
    // Genie installs, and takes its time.
    window.answers['genie-plugin'] = { ready: false, canInstall: true, install: null }
    window.answers['genie-plugin-install'] = { ready: false, canInstall: true, install: { phase: 'installing', log: '' } }
    window.mount({ width: 300 })
  })
  await power(page).click()
  await card(page).waitFor()
  await card(page).getByRole('button', { name: 'Power Genie on' }).click()
  await page.locator('[data-power=genie][data-state=working]').waitFor()
  await frame(page)
  // Its action went away: the focus is on the card, not lost.
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.bt-power-pop') !== null), true)
  assert.equal(await page.locator('[data-power=genie] .bt-thread-spin').count(), 1)
  await shot(page, 'working-stage-light')
  await page.keyboard.press('Escape')
  await card(page).waitFor({ state: 'detached' })
  await page.locator('button.bt-power .bt-thread-spin').waitFor()
  assert.match(await power(page).getAttribute('aria-label'), /Genie working/)
  // Still running with the card closed: the host's answer moves it on.
  await page.evaluate(() => { window.answers['genie-plugin'] = { ready: true, bot: { id: 'genie', name: 'Genie' }, canInstall: true, install: { phase: 'done' } } })
  await page.locator('button.bt-power svg').waitFor()
  assert.match(await power(page).getAttribute('aria-label'), /Genie on/)
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.endpoint === 'genie-plugin-install').length), 1)
  // A failure: the cloud's dot on the button, the message and Try again in the card.
  await page.evaluate(() => window.setPower('omni', 'failed', { message: 'git was not found' }))
  await page.locator('button.bt-power .bt-update-dot').waitFor()
  await power(page).click()
  await card(page).waitFor()
  assert.equal(await card(page).locator('[data-power=omni] [role=alert]').textContent(), 'git was not found')
  assert.equal(await card(page).locator('[data-power=omni] .bt-update-go').textContent(), 'Try again')
  await shot(page, 'failed-stage-light')
})

test('choosing where Omni lives opens the team step on purpose; Open team setup too', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => { window.mount({ width: 300 }); window.setPower('omni', 'found', { omnis: [] }) })
  await power(page).click()
  await card(page).getByRole('button', { name: 'Choose where Omni lives' }).click()
  await card(page).waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.actionsCalled.filter(([name]) => name === 'openHarnessOnboarding')), [['openHarnessOnboarding', 'omni-team']])
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('automagik.welcome.team-intent')).power), 'omni')
  await power(page).click()
  await card(page).getByRole('button', { name: 'Open team setup' }).click()
  assert.equal(await page.evaluate(() => window.actionsCalled.filter(([name]) => name === 'openHarnessOnboarding').length), 2)
})

test('without the shell\'s onboarding opener, neither Open team setup nor Choose where Omni lives shows', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => { window.mount({ width: 300, onboarding: false }); window.setPower('omni', 'found', { omnis: [] }) })
  await power(page).click()
  await card(page).waitFor()
  await frame(page)
  assert.equal(await card(page).getByRole('button', { name: 'Open team setup' }).count(), 0)
  assert.equal(await card(page).getByRole('button', { name: 'Choose where Omni lives' }).count(), 0)
})

test('an install the host is running is picked up after a reload: its place, the spinner, then On, with no second install', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => {
    // A fresh window (the store knows nothing) while the host's Genie job is at its second step.
    window.answers['genie-plugin'] = { ready: false, canInstall: true, plugin: { installed: false }, install: { phase: 'installing', steps: ['git', 'team', 'genie'], current: 'team', done: ['git'], log: '' } }
    window.mount({ width: 300 })
  })
  // Before the card opens, the button already shows it working.
  await page.locator('button.bt-power .bt-thread-spin').waitFor()
  assert.match(await power(page).getAttribute('aria-label'), /Genie working/)
  await power(page).click()
  await card(page).waitFor()
  await page.waitForFunction(() => document.querySelector('[data-power=genie] [role=status]')?.textContent === 'Installing Genie · 2 of 3 · Bot team')
  assert.equal(await rowOf(page, 'genie').locator('.bt-thread-spin').count(), 1)
  await shot(page, 'v3-genie-resumed-installing-light')
  // The host finishes: the poll brings the row to On.
  await page.evaluate(() => { window.answers['genie-plugin'] = { ready: true, bot: { id: 'genie', name: 'Genie' }, canInstall: true, plugin: { installed: true }, install: { phase: 'done' } } })
  await page.waitForFunction(() => document.querySelector('[data-power=genie] [role=status]')?.textContent === 'On · Ready for a wish')
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.endpoint.endsWith('-install')).length), 0)
})

test('Unfold shows only in its own instance, read-only', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => {
    window.answers.state = { host: 'unfold', preload: 'unfold' }
    window.setRoster({ bots: [{ id: 'unfold', name: 'Unfold', kind: 'unfold', createdAt: 1 }] })
    window.mount({ width: 300 })
  })
  await power(page).click()
  await page.locator('[data-power=unfold]').waitFor()
  assert.deepEqual(await card(page).locator('[data-power]').evaluateAll(nodes => nodes.map(node => node.dataset.power)), ['unfold', 'omni', 'genie'])
  assert.equal(await card(page).locator('[data-power=unfold] button').count(), 0)
  assert.equal(await card(page).getAttribute('aria-label'), 'Omni, Genie and Unfold')
})

test('the bar asks for seats only with a source, only while shown, and once', async (t) => {
  const page = await fixture(t)
  if (!page) return
  const seatCalls = () => page.evaluate(() => window.calls.filter(call => call.endpoint === 'seat-chat-list').length)
  // The page's zero-host-call contract: with no seat source the bar asks for none, and a
  // rerender does not start asking.
  await page.evaluate(() => window.mount({ width: 300 }))
  await page.waitForTimeout(700)
  await page.evaluate(() => window.setRoster({ bots: [{ id: 'pip', name: 'Pip', createdAt: 1 }] }))
  await page.waitForTimeout(400)
  assert.equal(await seatCalls(), 0, 'without the shell action, nothing is asked')
  // With the shell's source: one ask on mount; a rerender must not ask again (the poll is 4 s).
  await page.evaluate(() => window.mount({ width: 300, seatList: true }))
  await page.waitForTimeout(700)
  assert.equal(await seatCalls(), 1, 'one ask when the bar opens')
  await page.evaluate(() => window.setRoster({ bots: [{ id: 'pip', name: 'Pip', createdAt: 1 }, { id: 'otto', name: 'Otto', createdAt: 2 }] }))
  await page.waitForTimeout(400)
  assert.equal(await seatCalls(), 1, 'a rerender does not re-ask')
  // The rail is not the bar's Team list: no seats are asked for there.
  await page.evaluate(() => window.mount({ width: 300, wide: false, seatList: true }))
  await page.waitForTimeout(700)
  assert.equal(await seatCalls(), 1, 'seats load only where the bar shows them')
})

test('a tool that throws is left out, and the row stays', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.mount({ width: 300, throwing: true }))
  await power(page).waitFor()
  assert.equal(await page.locator('.lb-head [aria-label="Search"]').count(), 1)
  assert.equal(await page.locator('.lb-head [aria-label="New…"]').count(), 1)
})


// The Linux desktop app's sidebar: no brand, no Work/Code switch, a 236px top row.
const linuxApp = (t, dark = false) => fixture(t, { width: 1280, height: 760, desktop: 'linux', dark })
const rowOf = (page, kind) => card(page).locator(`[data-power=${kind}]`)

test('a powered-on product powers off from its row, as its box in the team step does', async (t) => {
  const page = await linuxApp(t)
  if (!page) return
  await linkedOmni(page)
  await page.evaluate(() => window.mount({ width: 236 }))
  await power(page).click()
  await card(page).waitFor()
  await frame(page)
  const off = rowOf(page, 'omni').getByRole('button', { name: 'Power Omni off' })
  assert.equal(await off.getAttribute('aria-pressed'), 'true')
  assert.equal(await rowOf(page, 'omni').locator('[role=status]').textContent(), 'On · Connected')
  // The first control is its power-off: no Open beside it (the Bot sits in the sidebar already).
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Power Omni off')
  assert.equal(await rowOf(page, 'omni').locator('button').count(), 1)
  await shot(page, 'v2-omni-on-genie-off-light')
  const before = await page.evaluate(() => window.calls.length)
  await off.click()
  await page.locator('[data-power=omni][data-state=off]').waitFor()
  assert.equal(await rowOf(page, 'omni').locator('[role=status]').textContent(), 'Powered off · not on your team')
  const on = rowOf(page, 'omni').getByRole('button', { name: 'Power Omni on' })
  assert.equal(await on.getAttribute('aria-pressed'), 'false')
  // Nothing was asked of the host: no unlink, no Bot removed.
  assert.deepEqual(await page.evaluate(n => window.calls.slice(n).map(call => call.endpoint), before), [])
  assert.match(await power(page).getAttribute('aria-label'), /^Omni off/)
  // While it wakes or looks it can still be powered off; Genie once on the team stays, and says so.
  await page.evaluate(() => window.setPower('omni', 'looking'))
  await rowOf(page, 'omni').getByRole('button', { name: 'Power Omni off' }).waitFor()
  await shot(page, 'v2-omni-powering-off-light')
  await page.evaluate(() => window.setRoster({ bots: [{ id: 'genie', name: 'Genie', kind: 'genie', createdAt: 1 }] }))
  const held = rowOf(page, 'genie').getByRole('button', { name: 'Power Genie off' })
  assert.equal(await held.isDisabled(), true)
  assert.equal(await rowOf(page, 'genie').locator('.bt-update-text').nth(1).textContent(), 'Genie stays on once it joins your team.')
})

test('a product not installed offers Install with what it does, then its steps, then On or the reason', async (t) => {
  const page = await linuxApp(t)
  if (!page) return
  await linkedOmni(page)
  await page.evaluate(() => {
    window.answers['genie-plugin'] = { ready: false, canInstall: true, install: null, plugin: { installed: false } }
    window.answers['genie-plugin-install'] = { ready: false, canInstall: true, plugin: { installed: false }, install: { phase: 'installing', steps: ['git', 'team', 'genie'], current: 'git', done: [], log: '' } }
    window.mount({ width: 236 })
  })
  await power(page).click()
  await card(page).waitFor()
  const install = rowOf(page, 'genie').getByRole('button', { name: 'Install Genie' })
  await install.waitFor()
  assert.equal(await rowOf(page, 'genie').locator('[role=status]').textContent(), 'Not installed')
  assert.equal(await rowOf(page, 'genie').locator('.bt-update-text').nth(1).textContent(), 'Adds the Genie plugin to this DSH. Genie then joins your team.')
  assert.equal(await install.getAttribute('aria-pressed'), null)
  await shot(page, 'v2-genie-not-installed-light')
  await install.click()
  // Its place in the install, step by step, as the host's job moves on.
  await page.evaluate(() => { window.answers['genie-plugin'] = { ...window.answers['genie-plugin-install'], install: { phase: 'installing', steps: ['git', 'team', 'genie'], current: 'team', done: ['git'], log: '' } } })
  const status = rowOf(page, 'genie').locator('[role=status]')
  await page.waitForFunction(() => document.querySelector('[data-power=genie] [role=status]')?.textContent === 'Installing Genie · 2 of 3 · Bot team')
  assert.equal(await rowOf(page, 'genie').locator('.bt-thread-spin').count(), 1)
  assert.equal(await rowOf(page, 'genie').locator('.bt-update-text').nth(1).textContent(), 'You can close this. The install keeps going.')
  await shot(page, 'v2-genie-installing-light')
  // Closed, it keeps going; reopened, it is where the host is.
  await page.keyboard.press('Escape')
  await card(page).waitFor({ state: 'detached' })
  await page.evaluate(() => { window.answers['genie-plugin'] = { ready: false, canInstall: true, plugin: { installed: false }, install: { phase: 'failed', error: 'git was not found. Install git, then try again.', steps: ['git', 'team', 'genie'], current: 'git', done: [] } } })
  await page.locator('button.bt-power .bt-update-dot').waitFor()
  await power(page).click()
  await card(page).waitFor()
  assert.equal(await status.textContent(), 'Could not install Genie')
  assert.equal(await rowOf(page, 'genie').locator('[role=alert]').textContent(), 'git was not found. Install git, then try again.')
  assert.equal(await rowOf(page, 'genie').locator('.bt-update-go').textContent(), 'Try again')
  await shot(page, 'v2-genie-install-error-light')
  // Try again: this time it ends on the team.
  await page.evaluate(() => {
    window.answers['genie-plugin-install'] = { ready: false, canInstall: true, plugin: { installed: true }, install: { phase: 'installing', steps: ['git', 'team', 'genie'], current: 'genie', done: ['git', 'team'] } }
    // The first read still says failed (so it installs again); the next, that Genie is on the team.
    const failed = window.answers['genie-plugin']
    const ready = { ready: true, bot: { id: 'genie', name: 'Genie' }, canInstall: true, plugin: { installed: true }, install: { phase: 'done' } }
    let reads = 0
    Object.defineProperty(window.answers, 'genie-plugin', { configurable: true, enumerable: true, get: () => (reads++ === 0 ? failed : ready) })
  })
  await rowOf(page, 'genie').getByRole('button', { name: 'Try again' }).click()
  await page.waitForFunction(() => document.querySelector('[data-power=genie] [role=status]')?.textContent === 'On · Ready for a wish')
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.endpoint === 'genie-plugin-install').length), 2)
})

// The owner's review set, in the Linux app's sidebar, in Automagik's stage theme, light and dark.
for (const dark of [false, true]) {
  test(`the card's states in the Linux app's sidebar, stage theme (${dark ? 'dark' : 'light'})`, async (t) => {
    const page = await linuxApp(t, dark)
    if (!page) return
    const mode = dark ? 'dark' : 'light'
    const open = async () => {
      if (await card(page).count() === 0) await power(page).click()
      await card(page).waitFor()
      await frame(page)
    }
    await linkedOmni(page)
    await page.evaluate(() => {
      window.answers['genie-plugin'] = { ready: false, canInstall: true, install: null, plugin: { installed: false } }
      window.mount({ width: 236 })
    })
    assert.equal(await page.locator('.bt-brand').isVisible(), false)
    await open()
    await rowOf(page, 'genie').getByRole('button', { name: 'Install Genie' }).waitFor()
    await shot(page, `stage-${mode}-1-omni-on-genie-not-installed`)
    await page.evaluate(() => window.setPower('omni', 'looking'))
    await shot(page, `stage-${mode}-2-omni-looking-power-off-offered`)
    await page.evaluate(() => window.setPower('omni', 'asleep', { removed: true }))
    await shot(page, `stage-${mode}-3-omni-powered-off`)
    await page.evaluate(() => {
      window.setPower('omni', 'linked', null)
      window.setPower('genie', 'installing', { genie: { install: { phase: 'installing', steps: ['git', 'team', 'genie'], current: 'team', done: ['git'] } } })
    })
    await page.waitForFunction(() => document.querySelector('[data-power=genie] [role=status]')?.textContent === 'Installing Genie · 2 of 3 · Bot team')
    await shot(page, `stage-${mode}-4-genie-installing-2-of-3`)
    await page.evaluate(() => window.setPower('genie', 'failed', { message: 'git was not found. Install git, then try again.' }))
    await rowOf(page, 'genie').locator('[role=alert]').waitFor()
    await shot(page, `stage-${mode}-5-genie-install-error`)
    await page.evaluate(() => { window.setRoster({ bots: [{ id: 'omni', name: 'Omni', kind: 'omni', createdAt: 1, color: 'deepseek', avatar: { shape: 'octopus' } }, { id: 'genie', name: 'Genie', kind: 'genie', createdAt: 2 }], omniLinked: true }); window.setPower('genie', 'ready', { bot: { id: 'genie' } }) })
    await page.locator('[data-power=genie][data-state=on]').waitFor()
    await shot(page, `stage-${mode}-6-both-on`)
  })
}
