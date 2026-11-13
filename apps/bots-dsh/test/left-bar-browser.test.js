// The new left bar's parts (left-bar-*.js) in a real browser, on the demo page
// (fixtures/left-bar-browser-app.js): round 1.1's sizes, both skins, both themes, at 1440 and 390;
// every mark named, every picture loaded, nothing cut sideways; a size is a token change; the
// list's edges say when rows lie under them; a press reaches the caller.
// LEFT_BAR_SHOTS=<folder> saves a screenshot of each case, skin, width and theme there.
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
  entryPoints: [join(plugin, 'test/fixtures/left-bar-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text', '.svg': 'dataurl' },
})
const SHOTS = process.env.LEFT_BAR_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true, mode: 0o700 })

const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

async function fixture(t, { width, height } = WIDE) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://automagik.test/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' })
    return route.abort()
  })
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  t.after(() => assert.deepEqual(errors, [], 'the bar throws nothing'))
  return page
}

// Mounts a case and waits for its pictures and fonts.
const mount = async (page, { dark = false, ...options } = {}) => {
  await page.evaluate(({ dark, options }) => { window.setTheme(options.theme ?? 'deepseek', dark); window.mount(options); if (dark) document.body.setAttribute('data-ds-dark-theme', '') }, { dark, options })
  await page.locator('.lb-rail').waitFor()
  // Every Bot's character is baked into its pet before anything is measured or pictured.
  await page.waitForFunction(() => { const art = [...document.querySelectorAll('.lb-row[data-kind=bot] .lb-art')]; return art.every(box => box.querySelector('.bt-pet')) })
  await page.waitForFunction(() => [...document.images].every(image => image.complete) && document.fonts.status === 'loaded')
}

const measure = page => page.evaluate(() => {
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
  const all = selector => [...document.querySelectorAll(selector)]
  const shown = image => getComputedStyle(image).display !== 'none'
  return {
    bar: box(document.querySelector('.lb-bar')),
    rail: box(document.querySelector('.lb-rail')),
    list: box(document.querySelector('.lb-list')),
    radius: getComputedStyle(document.querySelector('.lb-bar')).borderTopLeftRadius,
    tiles: all('.lb-tile').map(box),
    rows: Object.fromEntries(['bot', 'channel', 'chat', 'group'].map(kind => [kind, all(`.lb-row[data-kind=${kind}]`).map(row => box(row).height)])),
    labels: all('.lb-sec').map(label => box(label).height),
    art: all('.lb-row[data-kind=bot] .lb-art').map(art => box(art).width),
    marks: all('[role=img]').map(mark => ({ label: mark.getAttribute('aria-label'), title: mark.getAttribute('title') })),
    broken: [...document.images].filter(image => shown(image) && !(image.naturalWidth > 0)).map(image => image.src.slice(0, 60)),
    // What runs out of its box sideways: the page, or any part of the bar. Three do by design: a
    // name ends in an ellipsis, a tile's status mark stands 4 px off its corner, and a pet's cell
    // is wider than the character's box that the art box holds (its margin is clear).
    sideways: [
      ...(document.documentElement.scrollWidth > innerWidth ? ['the page'] : []),
      ...all('.lb-bar *').filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible' && node.clientWidth > 0 && !node.matches('.lb-name,.lb-tile-badged,.lb-art')).map(node => `${node.tagName.toLowerCase()}.${node.getAttribute('class')} ${node.scrollWidth}>${node.clientWidth}`),
    ],
    // The mark on a tile's corner stays inside the rail.
    pips: all('.lb-pip').every(pip => box(pip).right <= box(document.querySelector('.lb-rail')).right),
    // A pet's cell stays between the row's left edge and its name.
    pets: all('.lb-row[data-kind=bot]').every((row) => { const pet = row.querySelector('.bt-pet'); return !pet || (box(pet).left >= box(row).left && box(pet).right <= box(row.querySelector('.lb-name')).left) }),
    // A name that does not fit ends in an ellipsis; nothing else is cut.
    cut: all('.lb-name').filter(name => name.scrollWidth > name.clientWidth + 1 && getComputedStyle(name).textOverflow !== 'ellipsis').map(name => name.textContent),
  }
})

const shot = async (page, name) => {
  if (!SHOTS) return
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

test('round 1.1 sizes on both skins, both themes and both widths; every mark named', async (t) => {
  for (const size of [WIDE, PHONE]) {
    const page = await fixture(t, size)
    if (!page) return
    for (const skin of ['stage', 'flat']) {
      for (const dark of [true, false]) {
        const label = `${skin} ${size.width} ${dark ? 'dark' : 'light'}`
        await mount(page, { kase: 'team', skin, dark, fill: size === PHONE })
        const at = await measure(page)
        assert.deepEqual(at.broken, [], `${label}: every picture loaded`)
        assert.deepEqual(at.sideways, [], `${label}: nothing runs sideways`)
        assert.equal(at.pips, true, `${label}: a tile's mark stays inside the rail`)
        assert.equal(at.pets, true, `${label}: a pet's cell stays between its row's edge and its name`)
        assert.deepEqual(at.cut, [], `${label}: no name cut without an ellipsis`)
        assert.equal(at.rail.width, 56, `${label}: the rail`)
        assert.ok(at.tiles.every(tile => tile.width === 36 && tile.height === 36), `${label}: tiles of 36`)
        assert.ok(at.rows.bot.every(height => height === 34), `${label}: Bot rows of 34`)
        assert.ok(at.rows.group.every(height => height === 34), `${label}: group rows of 34`)
        assert.ok(at.rows.channel.every(height => height === 26), `${label}: channel rows of 26`)
        assert.ok(at.rows.chat.every(height => height === 25), `${label}: chat rows of 25`)
        assert.ok(at.art.every(width => width === 28), `${label}: art of 28`)
        assert.ok(at.marks.length > 0 && at.marks.every(mark => mark.label && mark.title === mark.label), `${label}: every mark has a name and a title`)
        if (size === WIDE) {
          assert.equal(at.list.width, 264, `${label}: the list`)
          const inset = skin === 'stage' ? 8 : 0
          assert.deepEqual([at.bar.left, at.bar.top, at.bar.height], [inset, inset, size.height - 2 * inset], `${label}: the panel`)
          assert.equal(at.radius, skin === 'stage' ? '26px' : '0px', `${label}: the panel's corners`)
        } else {
          assert.deepEqual([at.bar.left, at.bar.top, at.bar.width, at.radius], [0, 0, size.width, '0px'], `${label}: on a phone the ground fills the screen`)
        }
      }
    }
  }
})

test('every status in one list, on both skins', async (t) => {
  const page = await fixture(t)
  if (!page) return
  for (const skin of ['stage', 'flat']) {
    await mount(page, { kase: 'marks', skin })
    const at = await measure(page)
    assert.deepEqual(at.cut, [])
    const said = await page.evaluate(() => [...document.querySelectorAll('.lb-row[data-kind=bot]')].map(row => [row.querySelector('.lb-name').textContent, row.querySelector('[data-status]')?.getAttribute('data-status') ?? null, row.querySelector('.lb-st')?.textContent ?? null]))
    assert.deepEqual(said.slice(0, 5), [['Working', 'working', null], ['Needs you', 'needs', 'Needs you'], ['Idle', null, null], ['Error', 'error', null], ['Not running', 'off', null]], skin)
    // The long name gives way to its mark and word, which stay whole.
    const long = await page.evaluate(() => { const row = [...document.querySelectorAll('.lb-row[data-kind=bot]')].at(-1); const r = row.getBoundingClientRect(); const s = row.querySelector('.lb-st').getBoundingClientRect(); return { inside: s.right <= r.right, ellipsis: row.querySelector('.lb-name').scrollWidth > row.querySelector('.lb-name').clientWidth } })
    assert.deepEqual(long, { inside: true, ellipsis: true }, `${skin}: a long name ends in an ellipsis before the mark`)
  }
})

test('a size is a token change: taller rows and bigger art, and the art is drawn at its new size', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await mount(page, { kase: 'team', skin: 'stage', tokens: { '--lb-row-h': '38px', '--lb-art': '32px', '--lb-tile': '40px' } })
  const at = await measure(page)
  assert.ok(at.rows.bot.every(height => height === 38))
  assert.ok(at.art.every(width => width === 32))
  assert.ok(at.tiles.every(tile => tile.width === 40))
  // A baked pet's character stands in 150 of its cell's 208 units: that box is the art's box.
  const pets = await page.evaluate(() => [...document.querySelectorAll('.lb-row[data-kind=bot] .lb-art')].map((art) => { const a = art.getBoundingClientRect(); const p = art.querySelector('.bt-pet').getBoundingClientRect(); return { box: p.height * 150 / 208, centre: (p.top + p.height * 121 / 208) - (a.top + a.height / 2), whole: Number.isInteger(p.top) && Number.isInteger(p.height) } }))
  for (const pet of pets) {
    assert.ok(Math.abs(pet.box - 32) <= 1, `the character's box is ${pet.box.toFixed(1)} px in art of 32`)
    assert.ok(Math.abs(pet.centre) <= 1, `the character's box is ${pet.centre.toFixed(1)} px off the art's centre`)
    assert.equal(pet.whole, true, 'the pet stands on whole pixels')
  }
})

test('the list says when rows lie above or below it; a press reaches the caller', async (t) => {
  const page = await fixture(t, { width: 1440, height: 700 })
  if (!page) return
  await mount(page, { kase: 'many', skin: 'stage' })
  const edges = () => page.evaluate(() => { const scroll = document.querySelector('.lb-scroll'); return { above: scroll.hasAttribute('data-above'), more: scroll.hasAttribute('data-more') } })
  assert.deepEqual(await edges(), { above: false, more: true })
  await page.evaluate(() => { const rows = document.querySelector('.lb-rows'); rows.scrollTop = rows.scrollHeight })
  await page.waitForFunction(() => document.querySelector('.lb-scroll').hasAttribute('data-above'))
  assert.deepEqual(await edges(), { above: true, more: false })
  await mount(page, { kase: 'team', skin: 'stage' })
  assert.deepEqual(await edges(), { above: false, more: false }, 'a list that fits has no shaded edge')
  await page.getByRole('button', { name: 'Tess' }).click()
  await page.getByRole('button', { name: 'Genie, Needs you' }).click()
  await page.getByRole('button', { name: 'Add a project' }).click()
  await page.getByRole('button', { name: 'Help desk' }).click()
  assert.deepEqual(await page.evaluate(() => window.opened), ['chat:pip/ch-help/tess', 'project:genie', 'add', 'channel:pip/ch-help'])
})

test('screenshots of every case, skin, width and theme', { skip: !SHOTS && 'set LEFT_BAR_SHOTS to save them' }, async (t) => {
  for (const size of [WIDE, PHONE]) {
    const page = await fixture(t, size)
    if (!page) return
    for (const kase of ['team', 'many', 'empty', 'marks']) {
      for (const skin of ['stage', 'flat']) {
        for (const dark of [true, false]) {
          await mount(page, { kase, skin, dark, fill: size === PHONE })
          await shot(page, `code-${skin}-${kase}-${size.width}-${dark ? 'dark' : 'light'}`)
        }
      }
    }
  }
})
