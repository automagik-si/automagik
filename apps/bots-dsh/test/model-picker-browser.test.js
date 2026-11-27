// The composer's model picker in a real browser (T3's layout, model-menu.js DockedPicker), in
// the Automagik theme, driven with real keys and clicks: the provider rail, the search and its
// ⌘/Ctrl+1…9 jumps, the reasoning column, the Standard / Fast footer, reopening, a model with no
// Fast, and the phone width. MODEL_PICKER_SHOTS=<folder> saves the screenshots there.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'
import { browserGuard } from './browser-guard.js'

const plugin = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = join(process.env.DSH_HARNESS ?? '', 'node_modules/@deepseek-ai')
const SHOTS = process.env.MODEL_PICKER_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

let bundles
async function bundled() {
  if (bundles) return bundles
  const assets = join(harness, 'dsh-web-frontend/dist/assets')
  const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
  const seedFactory = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
  assert.ok(seedFactory, 'pinned DSH supplies the React seed factory')
  const seeds = await build({ stdin: { contents: `${frontend.slice(0, seedFactory.index + seedFactory[0].length)}; window.nativeSeeds = ${seedFactory[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
  const app = await build({
    entryPoints: [join(plugin, 'test/fixtures/model-picker-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text' },
  })
  bundles = { seeds: seeds.outputFiles[0].text, app: app.outputFiles[0].text }
  return bundles
}

async function page(t, { width = 1280, height = 820, mount = {} } = {}) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const { seeds, app } = await bundled()
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const view = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  view.setDefaultTimeout(6000)
  const errors = []
  view.on('pageerror', error => errors.push(error.message))
  view.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()) })
  await view.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--bt-main);color:var(--bt-ink);font:400 15px/22px var(--bt-font)}</style><div id="root"></div>' })
    : route.abort()))
  await view.goto('https://automagik.test/')
  await view.addScriptTag({ content: seeds })
  await view.addScriptTag({ content: 'window.require=name=>name===\'@deepseek-ai/dsh-client-ui-primitives\'?{MarkdownText:()=>null}:window.nativeSeeds[name];' })
  await view.addScriptTag({ content: app })
  await view.evaluate(options => window.mount(options), mount)
  t.after(() => assert.deepEqual(errors, [], 'the page throws nothing'))
  return view
}

const trigger = view => view.locator('.bt-model-bar-trigger')
const picker = view => view.locator('.bt-model-menu[data-docked]')
const calls = view => view.evaluate(() => window.calls.filter(call => call[0] !== 'speed'))
const settle = view => view.waitForTimeout(80)
async function open(view) {
  await trigger(view).click()
  await picker(view).waitFor()
  await settle(view)
}
const shot = async (view, name) => { if (SHOTS) { await view.waitForTimeout(250); await view.screenshot({ path: join(SHOTS, name) }) } }
const fits = view => view.evaluate(() => {
  const menu = document.querySelector('.bt-model-menu').getBoundingClientRect()
  return { page: document.documentElement.scrollWidth <= window.innerWidth, menu: menu.left >= 0 && menu.right <= window.innerWidth && menu.top >= 0 }
})

test('the picker opens on the search box with the provider rail, the list, the levels and the speed footer', async t => {
  const view = await page(t)
  if (!view) return
  await open(view)
  assert.equal(await view.evaluate(() => document.activeElement?.getAttribute('placeholder')), 'Search models...')
  // The rail: favorites first, then each provider the Bot may use; the current one is pressed.
  const tabs = view.locator('[data-model-picker-provider]')
  assert.equal(await tabs.first().getAttribute('data-model-picker-provider'), 'favorites')
  assert.equal(await view.locator('[data-model-picker-provider][aria-pressed=true]').getAttribute('data-model-picker-provider'), 'acp-codex')
  assert.equal(await view.locator('[data-model-picker-provider=herdr]').isDisabled(), true, 'Herdr waits for #1007')
  // The list: Codex's models, the current one ticked, ⌘1… on each.
  const rows = view.locator('[role=option]')
  assert.deepEqual(await rows.locator('.bt-mp-row-name').allTextContents(), ['GPT-6.2-Sol', 'GPT-6.2-Astra', 'GPT-6.1 Terra', 'GPT-6-Luna'])
  assert.equal(await rows.nth(1).getAttribute('aria-selected'), 'true')
  assert.match(await rows.nth(0).locator('.bt-mp-kbd').textContent(), /^(⌘|Ctrl\+)1$/)
  // The levels: the model's, its default marked, the Bot's level checked.
  assert.equal(await view.locator('.bt-mp-effort-model').textContent(), 'GPT-6.2-Astra')
  assert.deepEqual(await view.locator('.bt-mp-level-name').allTextContents(), ['Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'])
  assert.equal(await view.locator('.bt-mp-level[aria-checked=true]').textContent(), 'High')
  assert.equal(await view.locator('.bt-mp-level').first().locator('.bt-mp-level-default').textContent(), 'Default')
  // The footer: Standard | Fast, neither checked while the Bot has not chosen.
  assert.deepEqual(await view.locator('.bt-mp-segment').allTextContents(), ['Standard', 'Fast'])
  assert.equal(await view.locator('.bt-mp-segment[aria-checked=true]').count(), 0)
  assert.deepEqual(await fits(view), { page: true, menu: true })
  const box = await picker(view).boundingBox()
  assert.equal(Math.round(box.width), 600)
  await shot(view, 'model-picker-desktop-light.png')
})

test('Fast applies to the Bot on its model, shows on the trigger, survives a reopen, and clears back to unset', async t => {
  const view = await page(t)
  if (!view) return
  await open(view)
  await view.locator('.bt-mp-segment[data-speed=fast]').click()
  await settle(view)
  assert.deepEqual(await calls(view), [['updateBot', { speed: 'fast' }]])
  assert.deepEqual(await view.evaluate(() => window.bot().speed), { model: 'acp-codex/gpt-6.2-astra', value: 'fast' })
  assert.equal(await view.locator('.bt-mp-segment[aria-checked=true]').textContent(), 'Fast')
  assert.equal(await picker(view).isVisible(), true, 'the picker stays open, as T3\'s does')
  await shot(view, 'model-picker-fast-light.png')
  await view.keyboard.press('Escape')
  await picker(view).waitFor({ state: 'detached' })
  assert.equal(await trigger(view).locator('[data-fast]').count(), 1, 'the trigger carries the bolt')
  assert.match(await trigger(view).getAttribute('aria-label'), /, Fast$/)
  await open(view)
  assert.equal(await view.locator('.bt-mp-segment[aria-checked=true]').textContent(), 'Fast', 'a reopen shows the saved speed')
  // Standard is an explicit choice; the checked segment again clears it (null), back to unset.
  await view.locator('.bt-mp-segment[data-speed=standard]').click()
  await settle(view)
  assert.equal(await trigger(view).locator('[data-fast]').count(), 0)
  await view.locator('.bt-mp-segment[data-speed=standard]').click()
  await settle(view)
  assert.deepEqual((await calls(view)).slice(1), [['updateBot', { speed: 'standard' }], ['updateBot', { speed: null }]])
  assert.equal(await view.evaluate(() => window.bot().speed), undefined)
  assert.equal(await view.locator('.bt-mp-segment[aria-checked=true]').count(), 0)
})

test('a model with no Fast has no footer and no bolt; a Fast saved for another model never shows', async t => {
  const view = await page(t, { mount: { speed: { model: 'acp-codex/gpt-6.2-astra', value: 'fast' } } })
  if (!view) return
  assert.equal(await trigger(view).locator('[data-fast]').count(), 1)
  await open(view)
  // Luna offers no Fast: picking it applies the model at once, the footer goes, the bolt too.
  await view.locator('[role=option]', { hasText: 'GPT-6-Luna' }).click()
  await settle(view)
  assert.deepEqual(await calls(view), [['chooseModelInChat', 'acp-codex/gpt-6-luna', {}]])
  assert.equal(await view.evaluate(() => window.bot().speed), undefined, 'the host drops a speed saved for the old model')
  assert.equal(await view.locator('.bt-mp-foot').count(), 0)
  assert.equal(await view.locator('.bt-mp-effort-model').textContent(), 'GPT-6-Luna')
  assert.equal(await view.evaluate(() => document.activeElement?.dataset.effortLevel), 'Low', 'focus goes to the new model\'s levels')
  await shot(view, 'model-picker-no-fast-light.png')
  await view.keyboard.press('Escape')
  await picker(view).waitFor({ state: 'detached' })
  assert.equal(await trigger(view).locator('[data-fast]').count(), 0)
  // A speed the roster still holds for a different model shows nowhere.
  await view.evaluate(() => window.mount({ model: 'acp-codex/gpt-6.2-sol', speed: { model: 'acp-codex/gpt-6.2-astra', value: 'fast' } }))
  assert.equal(await trigger(view).locator('[data-fast]').count(), 0)
  await open(view)
  assert.equal(await view.locator('.bt-mp-segment[aria-checked=true]').count(), 0)
})

test('keys: search filters every provider, arrows and Enter pick, ⌘/Ctrl+digit jumps, the rail moves with Up and Down', async t => {
  const view = await page(t)
  if (!view) return
  const mac = await view.evaluate(() => /Mac/.test(navigator.platform))
  await open(view)
  await view.keyboard.type('opus')
  assert.deepEqual(await view.locator('[role=option] .bt-mp-row-name').allTextContents(), ['Claude Opus'])
  assert.equal(await view.locator('.bt-mp-heading').textContent(), 'Claude Code')
  await view.locator('[data-model-picker-search]').fill('')
  // A new search highlights the first row (T3's autoHighlight); two Downs reach Terra, Enter
  // picks it and focus moves to its levels.
  assert.equal(await view.locator('[role=option][data-highlighted] .bt-mp-row-name').textContent(), 'GPT-6.2-Sol')
  await view.keyboard.press('ArrowDown')
  await view.keyboard.press('ArrowDown')
  assert.equal(await view.locator('[role=option][data-highlighted] .bt-mp-row-name').textContent(), 'GPT-6.1 Terra')
  await view.keyboard.press('Enter')
  await settle(view)
  assert.deepEqual(await calls(view), [['chooseModelInChat', 'acp-codex/gpt-6.1-terra', {}]])
  // The Bot's High carries over: Terra serves it, so it is the checked level that takes focus.
  assert.equal(await view.evaluate(() => document.activeElement?.dataset.effortLevel), 'High')
  // Up and a typed letter in the column; Enter on a level applies it to the Bot.
  await view.keyboard.press('ArrowUp')
  assert.equal(await view.evaluate(() => document.activeElement?.dataset.effortLevel), 'Medium')
  await view.keyboard.press('l')
  assert.equal(await view.evaluate(() => document.activeElement?.dataset.effortLevel), 'Low')
  await view.keyboard.press('Enter')
  await settle(view)
  assert.deepEqual((await calls(view)).at(-1), ['updateBot', { effort: 'low' }])
  assert.equal(await view.locator('.bt-mp-level[aria-checked=true]').textContent(), 'Low')
  // Left goes back to the search, then to the rail; Down moves to the next provider.
  await view.keyboard.press('ArrowLeft')
  assert.equal(await view.evaluate(() => document.activeElement?.hasAttribute('data-model-picker-search')), true)
  await view.keyboard.press('ArrowLeft')
  assert.equal(await view.evaluate(() => document.activeElement?.dataset.modelPickerProvider), 'acp-codex')
  await view.keyboard.press('ArrowDown')
  await settle(view)
  // Hermes, Antigravity and omp over ACP are not served yet, and Herdr waits: they sit last
  // and Down skips them, back round to the favorites.
  assert.equal(await view.locator('[data-model-picker-provider][aria-pressed=true]').getAttribute('data-model-picker-provider'), 'hermes-remote')
  assert.deepEqual(await view.locator('[data-model-picker-provider]').evaluateAll(tabs => tabs.map(tab => tab.dataset.modelPickerProvider)),
    ['favorites', 'native', 'acp-claude', 'acp-codex', 'hermes-remote', 'acp-hermes', 'acp-antigravity', 'acp-omp', 'herdr'])
  await view.keyboard.press('ArrowDown')
  await settle(view)
  assert.equal(await view.locator('[data-model-picker-provider][aria-pressed=true]').getAttribute('data-model-picker-provider'), 'favorites')
  await view.keyboard.press('ArrowUp')
  await view.keyboard.press('ArrowUp')
  await view.keyboard.press('ArrowUp')
  await settle(view)
  assert.equal(await view.locator('[data-model-picker-provider][aria-pressed=true]').getAttribute('data-model-picker-provider'), 'acp-claude')
  // ⌘2 (Ctrl+2 off a Mac) picks Claude's second model: a crossing, so it switches and closes.
  await view.keyboard.press('ArrowRight')
  await view.keyboard.press(mac ? 'Meta+2' : 'Control+2')
  await picker(view).waitFor({ state: 'detached' })
  assert.deepEqual((await calls(view)).at(-1), ['switchRouteInChat', 'acp-claude/sonnet', {}])
})

test('a crossing while a reply runs asks inside the picker: Cancel goes back to it, Switch stops the reply', async t => {
  const view = await page(t, { mount: { running: true } })
  if (!view) return
  assert.equal(await trigger(view).getAttribute('aria-haspopup'), 'dialog')
  await open(view)
  await view.locator('[data-model-picker-provider=acp-claude]').click()
  await view.locator('[role=option]', { hasText: 'Claude Opus' }).click()
  const confirm = view.locator('.bt-mp-confirm .bt-model-confirm')
  await confirm.waitFor()
  assert.match(await confirm.innerText(), /This stops the current reply and continues on/)
  assert.deepEqual(await calls(view), [], 'nothing changes before the person answers')
  // The question fits inside the picker: neither its buttons nor its text are cut off.
  const clipped = await view.evaluate(() => {
    const menu = document.querySelector('.bt-model-menu').getBoundingClientRect()
    return [...document.querySelectorAll('.bt-mp-confirm button, .bt-mp-confirm div')].some((node) => {
      const box = node.getBoundingClientRect()
      return box.bottom > menu.bottom + 0.5 || box.right > menu.right + 0.5 || box.left < menu.left - 0.5
    })
  })
  assert.equal(clipped, false)
  await shot(view, 'model-picker-crossing-light.png')
  await view.locator('.bt-model-confirm-cancel').click()
  await view.locator('[data-model-picker-search]').waitFor()
  assert.equal(await view.evaluate(() => document.activeElement?.hasAttribute('data-model-picker-search')), true)
  await view.locator('[data-model-picker-provider=acp-claude]').click()
  await view.locator('[role=option]', { hasText: 'Claude Opus' }).click()
  await view.locator('.bt-model-confirm-go').click()
  await picker(view).waitFor({ state: 'detached' })
  assert.deepEqual(await calls(view), [['switchRouteInChat', 'acp-claude/opus', {}, { stopReply: true }]])
})

test('keyboard users can scroll to and favorite a model without selecting it', async t => {
  const view = await page(t)
  if (!view) return
  await open(view)
  await view.addStyleTag({ content: '.bt-mp-list{max-height:48px!important}' })
  const list = view.getByRole('listbox')
  const active = list.locator('[data-highlighted]')
  await view.keyboard.press('ArrowDown')
  await view.keyboard.press('ArrowDown')
  const visible = await active.evaluate(row => {
    const box = row.getBoundingClientRect()
    const list = row.closest('[role=listbox]').getBoundingClientRect()
    return box.top >= list.top - 1 && box.bottom <= list.bottom + 1
  })
  assert.ok(visible)
  await view.keyboard.press('Tab')
  assert.equal(await active.locator('.bt-mp-star').evaluate(star => star === document.activeElement), true)
  for (const pressed of ['true', 'false']) {
    await view.keyboard.press('Space')
    assert.equal(await active.locator('.bt-mp-star').getAttribute('aria-pressed'), pressed)
  }
  assert.deepEqual(await calls(view), [])
})

test('an open picker follows a host model change after a local pick applies', async t => {
  const view = await page(t)
  if (!view) return
  await open(view)
  await view.getByRole('option', { name: /GPT-6.2-Sol/ }).click()
  await view.waitForFunction(() => window.bot().model === 'acp-codex/gpt-6.2-sol')
  await view.evaluate(() => window.updateFromHost({ model: 'acp-codex/gpt-6.1-terra' }))
  await view.waitForSelector('[data-model-ref="acp-codex/gpt-6.1-terra"][data-shown]')
  assert.equal(await view.locator('.bt-mp-speed').count(), 0)
  await view.locator('[data-effort-level="Low"]').click()
  assert.deepEqual((await calls(view)).at(-1), ['updateBot', { effort: 'low' }])
})

test('favorites: the star keeps a model on the first tab, in this browser', async t => {
  const view = await page(t)
  if (!view) return
  await open(view)
  const row = view.locator('[role=option]', { hasText: 'GPT-6.2-Sol' })
  await row.hover()
  await row.locator('.bt-mp-star').click()
  assert.deepEqual(await view.evaluate(() => JSON.parse(localStorage.getItem('bt-model-favorites'))), ['acp-codex/gpt-6.2-sol'])
  assert.deepEqual(await calls(view), [], 'a star picks nothing')
  await view.locator('[data-model-picker-provider=favorites]').click()
  assert.deepEqual(await view.locator('[role=option] .bt-mp-row-name').allTextContents(), ['GPT-6.2-Sol'])
  await view.keyboard.press('Escape')
  await picker(view).waitFor({ state: 'detached' })
  await open(view)
  assert.equal(await view.locator('[data-model-picker-provider][aria-pressed=true]').getAttribute('data-model-picker-provider'), 'acp-codex', 'a reopen starts on the current model\'s provider')
})

for (const dark of [false, true]) {
  test(`phone width (${dark ? 'dark' : 'light'}): the levels go under the list and nothing scrolls sideways`, async t => {
    const view = await page(t, { width: 390, height: 844, mount: { dark, speed: { model: 'acp-codex/gpt-6.2-astra', value: 'fast' } } })
    if (!view) return
    await open(view)
    assert.deepEqual(await fits(view), { page: true, menu: true })
    const [list, column] = await Promise.all([view.locator('.bt-mp-picker').boundingBox(), view.locator('.bt-mp-effort').boundingBox()])
    assert.ok(column.y >= list.y + list.height - 1, 'the column sits under the list')
    assert.equal(await view.locator('.bt-mp-segment[aria-checked=true]').textContent(), 'Fast')
    await shot(view, `model-picker-phone-${dark ? 'dark' : 'light'}.png`)
    if (dark) {
      await view.setViewportSize({ width: 1280, height: 820 })
      await view.keyboard.press('Escape')
      await picker(view).waitFor({ state: 'detached' })
      await open(view)
      await shot(view, 'model-picker-desktop-dark.png')
    }
  })
}
