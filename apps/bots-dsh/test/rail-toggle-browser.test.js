// #1502: the sidebar toggle keeps one spot. In a real browser, with the pinned DSH SidebarRoot
// around the Bot team's sidebar (fixtures/rail-toggle-browser-app.js): the visible toggle has the
// same box with the bar open and folded to the rail, anchored at the card's bottom under every
// footer entry, through the fold and the unfold, with the keyboard too; the drawer, a Windows
// title bar and macOS keep their own controls; and the rail's "This computer" mark, which opens
// nothing, has no hover state. RAIL_TOGGLE_SHOTS=<folder> saves screenshots of both states there.
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
const baseCss = readdirSync(assets).filter(name => name.endsWith('.css')).map(name => readFileSync(join(assets, name), 'utf8')).join('\n')
const seedFactory = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seedFactory, 'pinned DSH supplies the React seed factory')
const seeds = await build({ stdin: { contents: `${frontend.slice(0, seedFactory.index + seedFactory[0].length)}; window.nativeSeeds = ${seedFactory[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const sidebarLib = readFileSync(join(harness, 'dsh-client-ui-sidebar/lib/client.js'), 'utf8')
const layoutLib = readFileSync(join(harness, 'dsh-client-ui-layout/lib/client.js'), 'utf8')
// The layout bundle's CSS module, with its hashed class names: the frame is drawn with them.
const layoutCss = /const css\w*=`([^`]*_frame\{[^`]*)`/.exec(layoutLib)?.[1]
assert.ok(layoutCss, 'pinned DSH layout bundle carries the frame CSS module')
const layoutPrefix = /\.([\w-]+)_frame\{/.exec(layoutCss)[1]
const app = await build({
  entryPoints: [join(plugin, 'test/fixtures/rail-toggle-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text', '.svg': 'dataurl' },
})
const SHOTS = process.env.RAIL_TOGGLE_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true, mode: 0o700 })

const SIZES = [{ width: 1440, height: 900 }, { width: 1360, height: 820 }, { width: 1280, height: 560 }]
const SHORT = { width: 1280, height: 560 }

async function fixture(t, { width = 1440, height = 900, html = {}, theme = 'deepseek', dark = false } = {}) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: html.reducedMotion ? 'reduce' : 'no-preference' })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()) })
  const attrs = [html.windows ? ' data-windows-titlebar' : '', html.darwin ? ' data-platform="darwin"' : '', html.desktop ? ` data-automagik-desktop="${html.desktop}"` : ''].join('')
  await page.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html${attrs}><head><style>html,body{height:100%;margin:0}#frame{display:grid;height:100%}#col{min-width:0;height:100%}[data-slot=sidebar]{height:100%}</style></head><body><div id="frame"><div id="col"><div data-slot="sidebar"></div></div><main id="center"></main></div></body></html>` })
    : route.abort()))
  await page.goto('https://automagik.test/')
  await page.addStyleTag({ content: baseCss })
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(({ sources, prefix }) => { window.layoutPrefix = prefix; window.loadDsh(sources) }, { sources: [sidebarLib], prefix: layoutPrefix })
  await page.addStyleTag({ content: layoutCss })
  await page.evaluate(({ theme, dark }) => window.setTheme(theme, dark), { theme, dark })
  t.after(() => assert.deepEqual(errors, [], 'the sidebar throws nothing'))
  return page
}

// The visible toggles: the Bot team's footer seat, the rail-foot button and DSH's own switch.
const look = page => page.evaluate(() => {
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
  const shown = (node) => {
    if (!node.isConnected) return false
    const r = node.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return false
    for (let at = node; at; at = at.parentElement) {
      const s = getComputedStyle(at)
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
    }
    return true
  }
  const toggles = [...document.querySelectorAll('.bt-foot-toggle, .lb-railcol .bt-side-collapse, [data-sidebar-toggle]')].filter(shown)
  const card = document.querySelector('[data-slot=sidebar]>[class*="_root"]')
  const [one] = toggles
  const center = one ? box(one) : null
  const hit = center ? document.elementFromPoint(center.left + center.width / 2, center.top + center.height / 2) : null
  const icon = one?.querySelector('svg[class*="_panelIcon"], svg')
  const above = [...document.querySelectorAll('[class*="_footArea"] .bt-account, [class*="_footArea"] .fx-extra')].filter(shown).map(box)
  const rail = [...document.querySelectorAll('.lb-tile, .bt-rail .bt-round, .bt-rail .bt-row, [class*="_collapsed"] [class*="_newSession"]')].filter(shown).map(box)
  return {
    count: toggles.length,
    kinds: toggles.map(node => (node.matches('[data-sidebar-toggle]') ? 'shell' : node.matches('.bt-foot-toggle') ? 'foot' : 'railcol')),
    box: center, card: card ? box(card) : null,
    icon: icon ? box(icon) : null,
    hit: hit ? (one.contains(hit) ? 'toggle' : hit.tagName + '.' + hit.className) : null,
    above, rail,
    badge: one ? Boolean([...one.querySelectorAll('.fx-badge')].find(shown)) : false,
    collapsed: Boolean(document.querySelector('[class*="_root"][class*="_collapsed"]')),
    focused: document.activeElement === one,
  }
})

const settle = async (page) => {
  await page.waitForTimeout(450)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
const near = (a, b, label) => {
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(a[key] - b[key]) <= 0.5, `${label}: ${key} ${a[key]} vs ${b[key]}`)
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }

test('the toggle has one box with the bar open and on the rail, at the card\'s bottom, under every footer entry', async (t) => {
  for (const size of SIZES) {
    for (const [theme, dark] of [['deepseek', false], ['deepseek', true], ['clay', false]]) {
      for (const extra of [0, 1, 3]) {
        const page = await fixture(t, { ...size, theme, dark })
        if (!page) return
        const label = `${size.width}x${size.height} ${theme}${dark ? ' dark' : ''} extra ${extra}`
        await page.evaluate(extra => window.mount({ extra }), extra)
        await settle(page)
        const wide = await look(page)
        await shot(page, `${size.width}x${size.height}-${theme}${dark ? '-dark' : ''}-${extra}-wide`)
        await page.evaluate(() => window.setState({ collapsed: true }))
        await settle(page)
        const rail = await look(page)
        await shot(page, `${size.width}x${size.height}-${theme}${dark ? '-dark' : ''}-${extra}-rail`)
        assert.equal(wide.count, 1, `${label} open: one toggle (${wide.kinds})`)
        assert.equal(rail.count, 1, `${label} rail: one toggle (${rail.kinds})`)
        assert.deepEqual([wide.kinds[0], rail.kinds[0]], ['foot', 'shell'], label)
        assert.equal(rail.collapsed, true)
        near(wide.box, rail.box, `${label}: the toggle's box`)
        near(wide.icon, rail.icon, `${label}: the toggle's icon`)
        for (const [state, at] of [['open', wide], ['rail', rail]]) {
          assert.equal(at.hit, 'toggle', `${label} ${state}: a press at its centre reaches it`)
          // Anchored at the card's bottom-left, inside the card.
          assert.ok(at.box.left >= at.card.left && at.box.bottom <= at.card.bottom && at.card.bottom - at.box.bottom <= 16, `${label} ${state}: at the card's bottom (${JSON.stringify(at.box)} in ${JSON.stringify(at.card)})`)
          // Nothing of the footer or the rail under it.
          for (const other of [...at.above, ...at.rail]) {
            const overlaps = other.left < at.box.right && other.right > at.box.left && other.top < at.box.bottom && other.bottom > at.box.top
            assert.equal(overlaps, false, `${label} ${state}: clear of ${JSON.stringify(other)}`)
          }
        }
        // On the rail, the account and every other entry sit above it.
        for (const other of rail.above) assert.ok(other.bottom <= rail.box.top, `${label} rail: footer entry above the toggle`)
        assert.equal(rail.badge, true, `${label} rail: the toggle keeps its badge`)
      }
    }
  }
})

test('the toggle never leaves its spot while the bar folds and unfolds, quickly or not', async (t) => {
  for (const reducedMotion of [false, true]) {
    const page = await fixture(t, { html: { reducedMotion } })
    if (!page) return
    await page.evaluate(() => window.mount({ extra: 1 }))
    await settle(page)
    const spot = (await look(page)).box
    // Each frame of the fold, then an unfold before the rail settles, then a full unfold.
    const frames = async (count) => {
      const out = []
      for (let at = 0; at < count; at += 1) {
        out.push(await look(page))
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
      }
      return out
    }
    const watch = []
    await page.evaluate(() => window.setState({ collapsed: true }))
    watch.push(...await frames(30))
    await page.evaluate(() => window.setState({ collapsed: false }))
    watch.push(...await frames(10))
    await page.evaluate(() => window.setState({ collapsed: true }))
    await page.waitForTimeout(80)
    await page.evaluate(() => window.setState({ collapsed: false }))
    watch.push(...await frames(20))
    for (const [at, frame] of watch.entries()) {
      assert.ok(frame.count <= 1, `frame ${at}${reducedMotion ? ' (reduced motion)' : ''}: ${frame.kinds}`)
      if (frame.count === 1) near(frame.box, spot, `frame ${at}${reducedMotion ? ' (reduced motion)' : ''}`)
    }
  }
})

test('the keyboard folds and unfolds the bar and stays on the toggle', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.mount({ extra: 1 }))
  await settle(page)
  await page.focus('.bt-foot-toggle')
  for (const [key, collapsed] of [['Enter', true], ['Enter', false], [' ', true], [' ', false]]) {
    await page.keyboard.press(key === ' ' ? 'Space' : key)
    await settle(page)
    const at = await look(page)
    assert.equal(at.collapsed, collapsed, `${key}: ${collapsed ? 'folded' : 'open'}`)
    assert.equal(at.focused, true, `${key}: focus on the visible toggle (${at.kinds})`)
  }
  // Tab and Shift+Tab move on from the toggle and back.
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.bt-foot-toggle')), false)
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.matches('.bt-foot-toggle')), true)
})

test('the last Bot of a long list still scrolls fully into view, on the rail and open', async (t) => {
  const page = await fixture(t, SHORT)
  if (!page) return
  await page.evaluate(() => window.mount({ bots: 24, extra: 1 }))
  await settle(page)
  for (const collapsed of [false, true]) {
    await page.evaluate(collapsed => window.setState({ collapsed }), collapsed)
    await settle(page)
    const seen = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.lb-row[data-kind=bot], .bt-rail .bt-row')]
      const last = rows.at(-1)
      last.scrollIntoView({ block: 'end' })
      const toggle = [...document.querySelectorAll('.bt-foot-toggle, [data-sidebar-toggle]')].find(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).display !== 'none')
      const r = last.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { reached: last.contains(hit), clear: r.bottom <= toggle.getBoundingClientRect().top || r.left >= toggle.getBoundingClientRect().right }
    })
    assert.deepEqual(seen, { reached: true, clear: true }, collapsed ? 'rail' : 'open')
  }
})

test('the drawer, a Windows title bar and macOS keep their own controls', async (t) => {
  // The phone drawer: the rail-foot button, where it stood, and no footer seat.
  const drawer = await fixture(t, { width: 700, height: 800 })
  if (!drawer) return
  await drawer.evaluate(() => window.mount({ drawer: true }))
  await settle(drawer)
  const inDrawer = await look(drawer)
  assert.ok(inDrawer.kinds.includes('railcol'), `drawer: ${inDrawer.kinds}`)
  assert.equal(inDrawer.kinds.includes('foot'), false)
  // Windows title bar and macOS: no footer seat; the shell's own switch is left alone.
  for (const html of [{ windows: true }, { darwin: true }]) {
    const page = await fixture(t, { html })
    await page.evaluate(() => window.mount())
    await settle(page)
    const open = await look(page)
    assert.equal(open.kinds.includes('foot'), false, `${Object.keys(html)} open: ${open.kinds}`)
    await page.evaluate(() => window.setState({ collapsed: true }))
    await settle(page)
    const position = await page.evaluate(() => {
      const toggle = document.querySelector('[data-sidebar-toggle]')
      return toggle ? getComputedStyle(toggle).position : null
    })
    assert.notEqual(position, 'absolute', `${Object.keys(html)} rail: the shell's switch is not moved`)
  }
})

test('the "This computer" mark opens nothing and has no hover state; the "+" keeps its own', async (t) => {
  for (const dark of [false, true]) {
    const page = await fixture(t, { dark })
    if (!page) return
    await page.evaluate(() => window.mount())
    await settle(page)
    const read = selector => page.evaluate((selector) => {
      const tile = document.querySelector(selector)
      const face = tile.querySelector('.lb-tile-face')
      const s = getComputedStyle(tile)
      const f = getComputedStyle(face)
      return { background: f.backgroundColor, shadow: f.boxShadow, color: f.color, outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, cursor: s.cursor }
    }, selector)
    const mark = '.lb-rail .lb-tile[data-id=local]'
    await page.mouse.move(700, 400)
    const rest = await read(mark)
    await page.hover(mark)
    const hovered = await read(mark)
    assert.deepEqual(hovered, rest, `${dark ? 'dark' : 'light'}: the mark is the same hovered`)
    assert.notEqual(rest.cursor, 'pointer')
    const add = '.lb-rail .lb-tile-add'
    await page.mouse.move(700, 400)
    const addRest = await read(add)
    await page.hover(add)
    const addHover = await read(add)
    assert.notEqual(addHover.color, addRest.color, 'the "+" still answers the pointer')
    assert.equal(addHover.cursor, 'pointer')
  }
})

test('the 390px drawer keeps Code across a terminal pick, and Team or Back restores the seat', async (t) => {
  const page = await fixture(t, { width: 390, height: 844 })
  if (!page) return
  await page.evaluate(() => window.mountCodeDrawer())
  const seat = page.locator('[data-fixture-seat]')
  const code = page.locator('[data-face=code]')
  const team = page.locator('[data-face=team]')
  const project = page.getByRole('button', { name: 'Fixture project' })
  const machine = page.getByRole('button', { name: 'Local machine' })
  const worker = page.getByRole('button', { name: /Reviewer/ })
  const panel = page.locator('[data-code-panel]')
  await seat.waitFor()
  await code.click()
  await project.waitFor()
  assert.equal(Math.round((await page.locator('#col').boundingBox()).width), 280)
  assert.equal(await seat.isVisible(), true, 'flipping the list keeps the seat chat')
  assert.equal(await code.locator('.lb-count').textContent(), '1')
  await machine.click()
  assert.equal(await machine.getAttribute('aria-expanded'), 'false')
  assert.equal(await project.count(), 0)
  await machine.click()
  await project.click()
  assert.equal(await project.getAttribute('aria-expanded'), 'false')
  assert.equal(await worker.count(), 0)
  assert.equal(await page.evaluate(() => window.toggles), 0, 'folding the tree keeps the drawer open')
  await project.click()
  await worker.click()
  await page.waitForFunction(() => window.toggles === 1 && window.codeTraffic.streams.length === 1)
  await panel.waitFor()
  assert.equal(await seat.count(), 0)
  assert.match(await page.evaluate(() => window.codeTraffic.streams[0]), /worker=t8/)
  assert.deepEqual(await page.evaluate(() => window.codeTraffic.calls.map(call => call.body.endpoint)), ['code-tree'])
  await panel.locator('.xterm-rows').getByText('fixture output').waitFor()
  await panel.locator('.cs-screen').click()
  await panel.locator('[data-code-mode=typing]').waitFor()
  await page.evaluate(() => window.setState({ collapsed: false }))
  await worker.waitFor()
  assert.equal(await code.getAttribute('aria-pressed'), 'true', 'the reopened drawer retains Code')

  await team.click()
  await seat.waitFor()
  await page.waitForFunction(() => window.codeTraffic.closed.length === 1
    && window.codeTraffic.calls.some(call => call.url.endsWith('/release') && call.body.session === 'fixture-typing'))
  assert.equal(await team.getAttribute('aria-pressed'), 'true')
  await code.click()
  await worker.click()
  await page.waitForFunction(() => window.codeTraffic.streams.length === 2)
  await page.evaluate(() => { window.codeTraffic.pauseTake = true })
  await panel.locator('.cs-screen').click()
  await page.waitForFunction(() => typeof window.codeTraffic.finishTake === 'function')
  await panel.getByRole('button', { name: 'Back' }).click()
  await seat.waitFor()
  await page.waitForFunction(() => window.codeTraffic.closed.length === 2)
  await page.evaluate(() => { window.codeTraffic.finishTake() })
  await page.waitForFunction(() => window.codeTraffic.calls.filter(call => call.url.endsWith('/release')).length === 2)
})

test('the Code bar toggles beside panes and clears them on Team and Back', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.mountCodeDrawer({ multi: true }))
  const panel = page.locator('[data-code-panel]')
  const row = name => page.locator('.cs-row', { hasText: name })
  const beside = name => row(name).click({ modifiers: ['Control'] })
  const switchTo = side => page.locator(`[data-face=${side}]`).click()
  await switchTo('code')
  await row('Atlas').click()
  for (const name of ['Reviewer', 'Builder', 'Tester']) await beside(name)
  await page.waitForFunction(() => window.codeTraffic.streams.length === 4)
  assert.equal(await page.locator('.cs-row[aria-current=true]').count(), 4)
  assert.match(await row('Reviewer').getAttribute('title'), /^Reviewer · feature\n(?:Ctrl|⌘)-click to show beside$/)
  await beside('Runner')
  const refusal = panel.locator('.cs-pane-head .cs-paste-note[data-wrap]')
  assert.match(await refusal.textContent(), /Atlas, Atlas · Reviewer, Atlas · Builder, Atlas · Tester/)
  assert.equal(await page.evaluate(() => window.codeTraffic.streams.length), 4)
  await beside('Atlas')
  await panel.locator('.cs-panes[data-count="3"]').waitFor()
  assert.equal(await refusal.count(), 0)

  await row('Builder').click()
  await panel.locator('.cs-panes[data-count="1"]').waitFor()
  await row('Runner').focus()
  await page.keyboard.press('Control+Enter')
  await panel.locator('.cs-panes[data-count="2"]').waitFor()
  await page.evaluate(async () => {
    const [bot] = window.codeTraffic.tree.projects[0].bots
    bot.workers = bot.workers.filter(worker => worker.role !== 'Runner')
    await window.codeTraffic.refresh()
  })
  await panel.locator('.cs-panes[data-count="1"]').waitFor()
  assert.equal(await row('Runner').count(), 0)

  const selection = () => page.evaluate(() => {
    const state = window.codeTraffic.snapshot()
    return [state.barSelected, state.barBeside, state.barRefused]
  })
  await beside('Reviewer')
  await page.waitForFunction(() => document.querySelectorAll('.cs-screen[aria-label="View only · click to type"]').length === 2)
  await switchTo('team')
  await page.locator('[data-fixture-seat]').waitFor()
  assert.deepEqual(await selection(), [null, [], null])
  await page.waitForFunction(() => window.codeTraffic.closed.length === window.codeTraffic.streams.length)

  await switchTo('code')
  await row('Reviewer').click()
  await beside('Tester')
  await page.waitForFunction(() => document.querySelectorAll('.cs-screen[aria-label="View only · click to type"]').length === 2)
  await panel.getByRole('button', { name: 'Back' }).click()
  await page.locator('[data-fixture-seat]').waitFor()
  assert.deepEqual(await selection(), [null, [], null])
  await page.waitForFunction(() => window.codeTraffic.closed.length === window.codeTraffic.streams.length)
})

test('the Code bar keeps one live EventSource from one pane through four', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.mountCodeDrawer({ multi: true }))
  await page.locator('[data-face=code]').click()
  const row = name => page.locator('.cs-row', { hasText: name })
  const readStreams = () => page.evaluate(() => {
    const { streams, closed } = window.codeTraffic
    return { count: streams.length, live: streams.length - closed.length, url: streams.at(-1) }
  })
  await row('Atlas').click()
  await page.locator('.cs-panes[data-count="1"] .cs-screen[aria-label="View only · click to type"]').waitFor()
  assert.equal((await readStreams()).live, 1)
  for (const [index, role] of ['Reviewer', 'Builder', 'Tester'].entries()) {
    const count = index + 2
    await row(role).click({ modifiers: ['Control'] })
    await page.waitForFunction(n => document.querySelectorAll('.cs-screen[aria-label="View only · click to type"]').length === n, count)
    const streams = await readStreams()
    assert.equal(streams.count, count)
    assert.equal(streams.live, 1)
    assert.deepEqual(new URLSearchParams(streams.url.split('?')[1]).getAll('worker'), ['', 't8', 't9', 't10'].slice(0, count))
  }
})
