// #1502: the sidebar toggle has one seat in each state. In a real browser, with the pinned DSH
// SidebarRoot around the Bot team's sidebar (fixtures/rail-toggle-browser-app.js): the visible
// toggle is centred under the tiles with the bar open and centred in the rail's card when folded,
// at one height, anchored at the card's bottom under every footer entry; it stays on its seat
// through the fold and the unfold, with the keyboard too; the rail's Account is centred in the
// card; the drawer, a Windows title bar and macOS keep their own controls; and the rail's "This
// computer" mark, which opens nothing, has no hover state. RAIL_TOGGLE_SHOTS=<folder> saves
// screenshots of both states there.
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
  // DSH's switch draws its rail mark before the panel icon, so the glyph is picked by kind.
  const icon = !one ? null : one.matches('[data-sidebar-toggle]') ? one.querySelector('svg[class*="_panelIcon"]') : one.querySelector('svg')
  const all = selector => [...document.querySelectorAll(selector)].filter(shown).map(box)
  const settings = document.querySelector('[class*="_footArea"]>[class*="_settingsArea"]')
  const above = [...document.querySelectorAll('[class*="_footArea"] .bt-account, [class*="_footArea"] .fx-extra')].filter(shown).map(box)
  const rail = [...document.querySelectorAll('.lb-tile, .bt-rail .bt-round, .bt-rail .bt-row, [class*="_collapsed"] [class*="_newSession"]')].filter(shown).map(box)
  return {
    count: toggles.length,
    kinds: toggles.map(node => (node.matches('[data-sidebar-toggle]') ? 'shell' : node.matches('.bt-foot-toggle') ? 'foot' : 'railcol')),
    box: center, card: card ? box(card) : null,
    icon: icon ? box(icon) : null,
    hit: hit ? (one.contains(hit) ? 'toggle' : hit.tagName + '.' + hit.className) : null,
    above, rail,
    tiles: all('.lb-tile'), column: all('.lb-railcol'), rows: all('.bt-rail .bt-row'),
    accounts: all('[class*="_footArea"] .bt-account'), triggers: all('[class*="_footArea"] .fx-trigger'),
    settingsShown: settings ? getComputedStyle(settings).display !== 'none' : null,
    view: { width: innerWidth, height: innerHeight },
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
const middle = box => box.left + box.width / 2
const close = (a, b, label) => assert.ok(Math.abs(a - b) <= 0.5, `${label}: ${a} vs ${b}`)
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }) }
// A loop of many cases closes each case's browser as it ends: left open until the test ends, they
// add up past a capped run's memory limit (scripts/capped-run).
const done = page => page.context().browser().close()

test('the toggle is centred under the tiles when open and in the card on the rail, at one height, under every footer entry', async (t) => {
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
        // Open: centred in the rail column, under every tile, 10px inside the card.
        assert.ok(wide.tiles.length > 0 && wide.column.length === 1, `${label} open: the rail column and its tiles are drawn`)
        for (const tile of wide.tiles) close(middle(wide.box), middle(tile), `${label} open: the toggle's centre under a tile`)
        close(middle(wide.box), middle(wide.column[0]), `${label} open: the toggle's centre in the rail column`)
        close(wide.box.left - wide.card.left, 10, `${label} open: the toggle's offset in the card`)
        // Rail: the card sits 4px inside the 56px column on every side, and the toggle is centred in it.
        close(rail.card.left, 4, `${label} rail: the card's left`)
        close(rail.card.width, 48, `${label} rail: the card's width`)
        close(rail.card.top, 4, `${label} rail: the card's top`)
        close(rail.card.bottom, rail.view.height - 4, `${label} rail: the card's bottom`)
        close(middle(rail.box), middle(rail.card), `${label} rail: the toggle's centre in the card`)
        close(rail.box.left - rail.card.left, 6, `${label} rail: the toggle's offset in the card`)
        assert.ok(rail.rows.length > 0, `${label} rail: the Bot rows are drawn`)
        for (const row of rail.rows) close(middle(rail.box), middle(row), `${label} rail: the toggle's centre under a Bot row`)
        // One height and one size across the fold.
        for (const key of ['top', 'width', 'height']) close(wide.box[key], rail.box[key], `${label}: the toggle's ${key} across the fold`)
        for (const [state, at] of [['open', wide], ['rail', rail]]) {
          // The glyph is 20px and centred in the 36px control.
          assert.ok(at.icon, `${label} ${state}: the toggle draws its glyph`)
          close(at.icon.width, 20, `${label} ${state}: the glyph's width`)
          close(at.icon.height, 20, `${label} ${state}: the glyph's height`)
          close(middle(at.icon), middle(at.box), `${label} ${state}: the glyph's centre`)
          close(at.icon.top + at.icon.height / 2, at.box.top + at.box.height / 2, `${label} ${state}: the glyph's middle`)
          close(at.box.width, 36, `${label} ${state}: the control's width`)
          close(at.box.height, 36, `${label} ${state}: the control's height`)
          assert.equal(at.hit, 'toggle', `${label} ${state}: a press at its centre reaches it`)
          // Anchored at the card's bottom, inside the card.
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
        await done(page)
      }
    }
  }
})

test('the toggle never leaves its seat while the bar folds and unfolds, quickly or not', async (t) => {
  for (const reducedMotion of [false, true]) {
    const page = await fixture(t, { html: { reducedMotion } })
    if (!page) return
    // AppFrame animates the sidebar track for 300ms while SidebarRoot puts the rail in at 150ms:
    // replayed here, so a toggle placed against the still-folding card's width would slide.
    await page.addStyleTag({ content: '#frame{transition:grid-template-columns .3s ease-in-out}' })
    await page.evaluate(() => window.mount({ extra: 1 }))
    await settle(page)
    const open = (await look(page)).box
    await page.evaluate(() => window.setState({ collapsed: true }))
    await settle(page)
    const folded = (await look(page)).box
    await page.evaluate(() => window.setState({ collapsed: false }))
    await settle(page)
    const seats = { foot: open, shell: folded }
    close(open.top, folded.top, 'the two seats share one height')
    close(open.left - folded.left, 8, 'the open seat is 8px right of the rail seat')
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
      if (frame.count === 1) near(frame.box, seats[frame.kinds[0]], `frame ${at}${reducedMotion ? ' (reduced motion)' : ''}: the ${frame.kinds[0]} toggle on its seat`)
    }
    // The watch did see the rail's toggle while the card was still wider than the settled rail.
    assert.ok(watch.some(frame => frame.count === 1 && frame.kinds[0] === 'shell' && frame.card.width > 60), `the track was still folding under the rail's toggle${reducedMotion ? ' (reduced motion)' : ''}`)
  }
})

test('the rail centres the Account in the card, in the settings seat and in the footer seat', async (t) => {
  // The settings seat is the app's; the footer seat stands in when no plugin holds that seat, with
  // the shell's own settings trigger beside it or with nothing there.
  const SEATS = [['settings seat', { seated: true }], ['footer seat, empty settings seat', {}], ['footer seat, shell trigger', { trigger: true }]]
  for (const extra of [0, 1]) {
    const bottoms = {}
    for (const [seat, options] of SEATS) {
      const page = await fixture(t)
      if (!page) return
      const label = `${seat}, extra ${extra}`
      await page.evaluate(options => window.mount(options), { ...options, extra, collapsed: true })
      await settle(page)
      const at = await look(page)
      await shot(page, `account-${seat.replace(/[^a-z]+/g, '-')}-${extra}`)
      assert.equal(at.collapsed, true, label)
      assert.equal(at.accounts.length, 1, `${label}: one Account`)
      assert.equal(at.triggers.length, options.trigger ? 1 : 0, `${label}: the shell trigger`)
      const items = [...at.accounts, ...at.triggers]
      for (const item of items) {
        close(middle(item), middle(at.card), `${label}: a footer control's centre in the card`)
        assert.ok(item.left >= at.card.left && item.right <= at.card.right, `${label}: inside the card (${JSON.stringify(item)} in ${JSON.stringify(at.card)})`)
        assert.ok(item.bottom <= at.box.top, `${label}: above the toggle`)
      }
      for (const entry of at.above) close(middle(entry), middle(at.card), `${label}: a footer entry's centre in the card`)
      // The Account and the shell trigger stack; neither covers the other.
      const [account, trigger] = items
      if (trigger) assert.ok(account.bottom <= trigger.top || trigger.bottom <= account.top, `${label}: the Account and the trigger do not overlap`)
      if (seat === 'footer seat, empty settings seat') assert.equal(at.settingsShown, false, `${label}: the empty settings seat takes no row`)
      bottoms[seat] = account.bottom
      await done(page)
    }
    // An empty settings seat adds no row gap: the footer Account stands where the seated one does.
    close(bottoms['footer seat, empty settings seat'], bottoms['settings seat'], `extra ${extra}: the footer Account's bottom`)
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
    const own = await page.evaluate(() => {
      const toggle = document.querySelector('[data-sidebar-toggle]')
      const icon = toggle?.querySelector('svg[class*="_panelIcon"]')
      return { position: toggle ? getComputedStyle(toggle).position : null, drawn: icon ? icon.getBoundingClientRect().width : null, given: icon ? Number(icon.getAttribute('width')) : null }
    })
    assert.notEqual(own.position, 'absolute', `${Object.keys(html)} rail: the shell's switch is not moved`)
    assert.ok(own.given > 0 && own.given !== 20, `${Object.keys(html)} rail: DSH gives its glyph a size (${own.given})`)
    assert.equal(own.drawn, own.given, `${Object.keys(html)} rail: the shell's glyph keeps DSH's size`)
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

test('the 390px drawer keeps Code across a terminal pick and Back restores the seat', async (t) => {
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
  assert.equal(await panel.count(), 1, 'flipping to Team keeps the open Code panel (P5)')
  // At 390px the drawer is DSH's overlay: while it is open it covers Back (as it covers any panel),
  // so a person closes it first; with it closed, Back is what the pointer reaches.
  const atBack = () => page.evaluate(() => {
    const back = document.querySelector('[data-code-panel] .bt-seat-back')
    const r = back.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit === back ? 'back' : document.querySelector('#col').contains(hit) ? 'drawer' : 'other'
  })
  assert.equal(await atBack(), 'drawer', 'the open drawer covers the panel')
  await page.evaluate(() => window.setState({ collapsed: true }))
  assert.equal(await atBack(), 'back', 'with the drawer closed, Back is reachable')
  await panel.getByRole('button', { name: 'Back' }).click()
  await seat.waitFor()
  await page.waitForFunction(() => window.codeTraffic.closed.length === 1
    && window.codeTraffic.calls.some(call => call.url.endsWith('/release') && call.body.session === 'fixture-typing'))
  assert.equal(await team.getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => window.setState({ collapsed: false }))
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

test('the Code bar toggles beside panes and clears them on Back', async (t) => {
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
  await panel.getByRole('button', { name: 'Back' }).click()
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
