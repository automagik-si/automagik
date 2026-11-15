// The explained permission choice in a real browser: the card in a Bot's chat at the app's
// 720 px minimum window, the Details panel at its 320 px width and covering that 720 px window, and the Settings picker, in the
// light and the dark theme, with the three levels of the common install and with Auto review
// as a fourth. Every explanation is on the page at once, nothing runs off its box, Full access
// is in the danger ink, and only a press saves. React is the pinned DSH's; the host is a fake.
// PERMISSION_CHOICE_SHOTS=<folder> saves screenshots there.
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
  entryPoints: [join(plugin, 'test/fixtures/permission-choice-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], loader: { '.css': 'text' },
})
const SHOTS = process.env.PERMISSION_CHOICE_SHOTS
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = async (page, name) => {
  if (!SHOTS) return
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const THREE = ['read-only', 'workspace-write', 'danger-full-access']
const FOUR = ['read-only', 'workspace-write', 'auto', 'danger-full-access']
const SETS = [['3', THREE], ['4', FOUR]]
const THEMES = [['light', false], ['dark', true]]

async function fixture(t, { width = 720, height = 900, dark = false } = {}) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()) })
  await page.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{background:var(--bt-main)}</style><div id="root"></div>' })
    : route.abort()))
  await page.goto('https://automagik.test/')
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: 'window.require=name=>name===\'@deepseek-ai/dsh-client-ui-primitives\'?{MarkdownText:()=>null}:window.nativeSeeds[name];' })
  await page.addScriptTag({ content: app.outputFiles[0].text })
  await page.evaluate(dark => window.setTheme('deepseek', dark), dark)
  t.after(() => assert.deepEqual(errors, [], 'the page throws nothing'))
  return page
}

async function mountPanel(page, options = {}) {
  await page.evaluate(options => window.mount({ view: 'panel', ...options }), options)
  await page.locator('.bt-panel').waitFor()
  await page.locator('.bt-panel').evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))))
}

// What the rows inside `scope` look like: each row's level, whether its explanation is drawn
// and inside the row, whether the row is inside `scope`, and the inks.
const measure = (page, scope) => page.evaluate((scope) => {
  const box = document.querySelector(scope)
  const outer = box.getBoundingClientRect()
  const inside = (inner, frame) => inner.left >= frame.left - 0.5 && inner.right <= frame.right + 0.5 && inner.top >= frame.top - 0.5 && inner.bottom <= frame.bottom + 0.5
  const ink = node => getComputedStyle(node).color
  // The danger ink: red text reads the theme's strong shade where it has one (dark), the token elsewhere.
  const probe = document.createElement('span')
  probe.style.color = 'var(--st-bad-strong,var(--bt-danger))'
  box.append(probe)
  const danger = ink(probe)
  probe.remove()
  return {
    width: outer.width,
    // A list bleeds 8px into its box's side padding by design; what must not happen is a
    // sideways scroll of the page or of the scrolling box around it.
    overflows: document.documentElement.scrollWidth > window.innerWidth || [box, ...document.querySelectorAll('.bt-drawer-body')].some(node => getComputedStyle(node).overflowX !== 'visible' && node.scrollWidth > node.clientWidth + 1),
    danger,
    rows: [...box.querySelectorAll('.bt-q-opt')].map((row) => {
      const frame = row.getBoundingClientRect()
      const label = row.querySelector('.bt-q-label')
      const text = row.querySelector('.bt-q-desc')
      const words = text.getBoundingClientRect()
      return {
        level: row.dataset.permission, pressed: row.getAttribute('aria-pressed'), disabled: row.disabled,
        text: text.textContent, drawn: words.width > 40 && words.height >= 15, textInside: inside(words, frame) && text.scrollWidth <= text.clientWidth + 1,
        rowInside: frame.left >= outer.left - 8.5 && frame.right <= outer.right + 8.5, labelInk: ink(label), textInk: ink(text),
        visible: frame.bottom <= window.innerHeight && frame.top >= 0,
      }
    }),
  }
}, scope)

function checkRows(seen, levels, current, { explanationInk = true } = {}) {
  assert.deepEqual(seen.rows.map(row => row.level), levels, 'the catalog\'s levels, in its order')
  assert.equal(seen.overflows, false, 'nothing scrolls sideways')
  for (const row of seen.rows) {
    assert.ok(row.drawn, `${row.level} shows its explanation`)
    assert.ok(row.textInside, `${row.level}: the explanation stays inside its row`)
    assert.ok(row.rowInside, `${row.level}: the row stays inside its box`)
    assert.equal(row.pressed, String(row.level === current), `${row.level}: marked only when current`)
    const danger = row.level === 'danger-full-access'
    assert.equal(row.labelInk === seen.danger, danger, `${row.level}: name ink`)
    if (explanationInk) assert.equal(row.textInk === seen.danger, danger, `${row.level}: explanation ink`)
  }
}

const popupFits = page => page.locator('.bt-permission-menu').evaluate((node) => {
  const rect = node.getBoundingClientRect()
  return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight
    && node.scrollWidth <= node.clientWidth + 1
})

const closedUsesNormalInk = section => section.evaluate((node) => {
  const probe = document.createElement('span')
  probe.style.color = 'var(--st-bad-strong,var(--bt-danger))'
  node.append(probe)
  const danger = getComputedStyle(probe).color
  probe.remove()
  return ['.bt-model-name', '.bt-note'].every(selector => getComputedStyle(node.querySelector(selector)).color !== danger)
})

const answersFit = popup => popup.locator('.bt-perm-confirm').evaluate((node) => {
  const menu = node.closest('.bt-permission-menu')
  const frame = menu.getBoundingClientRect()
  const buttons = [...node.querySelectorAll('button')]
  return buttons.length === 2 && buttons.every((button) => {
    const rect = button.getBoundingClientRect()
    return rect.left >= frame.left + menu.clientLeft && rect.right <= frame.left + menu.clientLeft + menu.clientWidth
      && rect.top >= frame.top + menu.clientTop && rect.bottom <= frame.top + menu.clientTop + menu.clientHeight
  })
})

for (const [count, levels] of SETS) {
  test(`Details brings both answers into view in a 700 px high window with ${count} levels`, async (t) => {
    const page = await fixture(t, { height: 700 })
    if (!page) return
    await mountPanel(page, { levels, permission: 'read-only' })
    await page.locator('.bt-drawer-permission .bt-model-trigger').click()
    const popup = page.locator('.bt-permission-menu')
    for (const value of levels.includes('auto') ? ['danger-full-access', 'auto'] : ['danger-full-access']) {
      await popup.locator(`.bt-q-opt[data-permission="${value}"]`).click()
      await popup.locator('.bt-perm-confirm').waitFor()
      assert.ok(await answersFit(popup), `${value}: both answers are visible without test-driven scrolling`)
      assert.ok(await popupFits(page))
      await popup.getByRole('button', { name: 'Cancel' }).click()
    }
    assert.deepEqual(await page.evaluate(() => window.saves), [])
  })
}

test('Details above its trigger never answers Full access on the second press of a double click', async (t) => {
  const page = await fixture(t, { height: 600 })
  if (!page) return
  await mountPanel(page, { permission: 'read-only' })
  const trigger = page.locator('.bt-drawer-permission .bt-model-trigger')
  await trigger.click()
  const popup = page.locator('.bt-permission-menu')
  await popup.waitFor()
  // Wait for the popup's entry animation before comparing the two edges.
  await page.waitForTimeout(150)
  assert.ok(await popup.evaluate((node) => node.getBoundingClientRect().bottom < document.querySelector('.bt-drawer-permission .bt-model-trigger').getBoundingClientRect().top), 'the popup really opened above the trigger')
  const row = popup.locator('.bt-q-opt[data-permission="danger-full-access"]')
  const question = popup.locator('.bt-perm-confirm')
  const answer = question.getByRole('button', { name: 'Give full access', exact: true })
  await row.click()
  await question.waitFor()
  const answerBox = await answer.boundingBox()
  assert.ok(answerBox, 'the Full access answer has a box')
  await question.getByRole('button', { name: 'Cancel', exact: true }).click()
  await question.waitFor({ state: 'detached' })
  const rowBox = await row.boundingBox()
  assert.ok(rowBox, 'the Full access row has a box')
  const left = Math.max(rowBox.x, answerBox.x)
  const right = Math.min(rowBox.x + rowBox.width, answerBox.x + answerBox.width)
  const top = Math.max(rowBox.y, answerBox.y)
  const bottom = Math.min(rowBox.y + rowBox.height, answerBox.y + answerBox.height)
  assert.ok(right > left && bottom - top >= 4, 'the viewport no longer makes the dangerous case: the row and Give full access must overlap by at least 4 px vertically')
  // The first press opens the question; its answer then occupies the same point.
  await page.mouse.dblclick((left + right) / 2, (top + bottom) / 2)
  assert.deepEqual(await page.evaluate(() => window.saves), [])
  await question.waitFor()
  assert.equal(await answer.isVisible(), true)
  await answer.click()
  assert.deepEqual(await page.evaluate(() => window.saves), [{ id: 'omni', patch: { permission: 'danger-full-access' } }])
  await popup.waitFor({ state: 'detached' })
})

test('Details above its trigger cancels the question on a double click at the Full access row centre', async (t) => {
  const page = await fixture(t, { height: 600 })
  if (!page) return
  await mountPanel(page, { permission: 'read-only' })
  await page.locator('.bt-drawer-permission .bt-model-trigger').click()
  const popup = page.locator('.bt-permission-menu')
  await popup.waitFor()
  await page.waitForTimeout(150)
  await popup.locator('.bt-q-opt[data-permission="danger-full-access"]').dblclick()
  await popup.locator('.bt-perm-confirm').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.saves), [])
  assert.equal(await popup.isVisible(), true)
})

test('Details permission popup fits wholly inside a 360 px window', async (t) => {
  const page = await fixture(t, { width: 360 })
  if (!page) return
  await mountPanel(page, { permission: 'read-only' })
  await page.locator('.bt-drawer-permission .bt-model-trigger').click()
  await page.locator('.bt-permission-menu').waitFor()
  assert.ok(await popupFits(page))
})

for (const [count, levels] of SETS) {
  for (const [theme, dark] of THEMES) {
    test(`the card at the 720 px window, ${count} levels, ${theme}`, async (t) => {
      const page = await fixture(t, { dark })
      if (!page) return
      await page.evaluate(levels => window.mount({ view: 'card', levels }), levels)
      await page.locator('form.bt-q').waitFor()
      const seen = await measure(page, 'form.bt-q')
      checkRows(seen, levels, 'read-only')
      assert.ok(seen.rows.every(row => row.visible), 'every level is on screen at once')
      assert.ok(seen.width <= 720 - 32, 'the card keeps the chat\'s side room')
      await shot(page, `card-${count}-${theme}`)

      // Marking Full access saves nothing; Save asks once more; only the answer saves.
      await page.locator('.bt-q-opt[data-permission="danger-full-access"]').click()
      await page.getByRole('button', { name: 'Save' }).click()
      assert.deepEqual(await page.evaluate(() => window.saves), [])
      await page.getByText('Give FazoL full access?').waitFor()
      const warning = await page.evaluate(() => {
        const form = document.querySelector('form.bt-q')
        const probe = document.createElement('span')
        probe.style.color = 'var(--st-bad-strong,var(--bt-danger))'
        form.append(probe)
        const danger = getComputedStyle(probe).color
        probe.remove()
        return { ink: getComputedStyle(form.querySelector('.bt-q-detail .bt-danger')).color, danger, fits: form.scrollWidth <= form.clientWidth + 1 }
      })
      assert.equal(warning.ink, warning.danger, 'the warning is in the danger ink')
      assert.ok(warning.fits)
      await shot(page, `card-confirm-${count}-${theme}`)
      await page.getByRole('button', { name: 'Give full access' }).dblclick()
      assert.deepEqual(await page.evaluate(() => window.saves), [{ id: 'omni', patch: { permission: 'danger-full-access' } }], 'one save for the answer')
      await page.locator('form.bt-q').waitFor({ state: 'detached' })
    })

    // Beside the chat the panel is 320 px wide; at the 720 px minimum window it covers the chat.
    for (const [width, panelWidth] of [[1280, 320], [720, 720]]) test(`the Details panel ${panelWidth} px wide in a ${width} px window, ${count} levels, ${theme}`, async (t) => {
      const page = await fixture(t, { dark, width })
      if (!page) return
      await mountPanel(page, { levels, permission: 'workspace-write' })
      const section = page.locator('.bt-drawer-permission')
      const trigger = section.locator('.bt-model-trigger')
      await trigger.waitFor()
      assert.equal(await page.evaluate(() => Math.round(document.querySelector('.bt-panel').getBoundingClientRect().width)), panelWidth)
      assert.equal(await section.locator('.bt-seg, .bt-q-opt').count(), 0, 'the select is closed')
      assert.equal(await trigger.textContent(), 'Workspace')
      assert.ok(await closedUsesNormalInk(section), 'closed Workspace name and note avoid danger ink')
      assert.equal(await section.locator('.bt-note').first().textContent(), 'Changes files inside its folder and a temporary folder without asking. For other files it asks you first. It can still run commands and use the network and its other tools.')
      assert.ok(await section.evaluate((node) => {
        const frame = node.getBoundingClientRect()
        return [...node.querySelectorAll('.bt-model-trigger, .bt-note')].every((part) => {
          const rect = part.getBoundingClientRect()
          return rect.left >= frame.left && rect.right <= frame.right && part.scrollWidth <= part.clientWidth + 1
        })
      }), 'the closed trigger and its explanation fit the section')
      assert.deepEqual(await page.evaluate(() => window.saves), [])
      await shot(page, `details-${panelWidth}-${count}-${theme}`)
      await trigger.click()
      const popup = page.locator('.bt-permission-menu')
      await popup.waitFor()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
      const seen = await measure(page, '.bt-permission-menu')
      checkRows(seen, levels, 'workspace-write', { explanationInk: false })
      // This is the popup's look on dev, in the composer too: only the name carries danger ink.
      assert.equal(seen.rows.find(row => row.level === 'danger-full-access').textInk, seen.rows[0].textInk, 'Full access uses the same explanation ink as the first row')
      assert.ok(await popupFits(page), 'the popup fits wholly inside the window')
      assert.ok(seen.rows.every(row => row.visible), 'every explained row is on screen')
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.permission), 'workspace-write')
      await shot(page, `details-open-${panelWidth}-${count}-${theme}`)

      await popup.locator('.bt-q-opt[data-permission="danger-full-access"]').click()
      assert.deepEqual(await page.evaluate(() => window.saves), [], 'Full access asks first')
      const confirm = popup.locator('.bt-perm-confirm')
      await confirm.waitFor()
      const after = await measure(page, '.bt-permission-menu')
      assert.equal(after.overflows, false)
      assert.ok(await popupFits(page), 'the popup with its question fits wholly inside the window')
      assert.ok(await confirm.evaluate((node) => {
        const frame = node.closest('.bt-permission-menu').getBoundingClientRect()
        return [node, ...node.querySelectorAll('*')].every((part) => {
          const rect = part.getBoundingClientRect()
          return rect.left >= frame.left && rect.right <= frame.right && rect.top >= frame.top && rect.bottom <= frame.bottom
            && part.scrollWidth <= part.clientWidth + 1
        })
      }), 'the whole question and its buttons fit inside the popup')
      assert.notEqual(await page.evaluate(() => document.activeElement?.textContent), 'Give full access')
      await shot(page, `details-confirm-${panelWidth}-${count}-${theme}`)
      await confirm.getByRole('button', { name: 'Cancel' }).click()
      await popup.locator('.bt-q-opt[data-permission="read-only"]').click()
      assert.deepEqual(await page.evaluate(() => window.saves), [{ id: 'omni', patch: { permission: 'read-only' } }])
      await popup.waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate(node => document.activeElement === node), true)
      assert.equal(await trigger.textContent(), 'Read only')
      assert.ok(await closedUsesNormalInk(section), 'closed Read only name and note avoid danger ink')
      await trigger.click()
      await popup.locator('.bt-q-opt[data-permission="danger-full-access"]').click()
      await popup.getByRole('button', { name: 'Give full access' }).click()
      await popup.waitFor({ state: 'detached' })
      assert.equal(await trigger.textContent(), 'Full access')
      assert.ok(await section.evaluate((node) => {
        const name = node.querySelector('.bt-model-name.bt-danger')
        const text = node.querySelector('.bt-note > .bt-danger')
        const probe = document.createElement('span')
        probe.style.color = 'var(--st-bad-strong,var(--bt-danger))'
        node.append(probe)
        const danger = getComputedStyle(probe).color
        probe.remove()
        return name && text && getComputedStyle(name).color === danger && getComputedStyle(text).color === danger
      }), 'the closed Full access name and explanation use danger ink')
    })
  }
}

test('the keyboard and a double click on Save never give Full access', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.mount({ view: 'card' }))
  const saves = () => page.evaluate(() => window.saves)
  await page.locator('.bt-q-opt[data-permission="danger-full-access"]').click()
  await page.getByRole('button', { name: 'Save' }).dblclick()
  await page.getByText('Give FazoL full access?').waitFor()
  assert.deepEqual(await saves(), [], 'the second press of the double click lands on the question and is not an answer')
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.getByRole('button', { name: 'Save' }).focus()
  await page.keyboard.press('Enter')
  await page.getByText('Give FazoL full access?').waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel', 'focus is on Cancel')
  assert.deepEqual(await saves(), [])
  // Enter held down or pressed again reaches Cancel, never the button that gives the access.
  for (const key of ['Enter', 'Enter', ' ', 'Enter', 'y', 'd']) await page.keyboard.press(key)
  assert.deepEqual(await saves(), [])
  await page.locator('form.bt-q').waitFor()
  assert.equal(await page.locator('form.bt-q .bt-q-opt[aria-pressed="true"]').getAttribute('data-permission'), 'danger-full-access', 'the row is still only marked')

  // Letters with focus on the page never mark or save a level.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  for (const key of ['a', 'b', 'c', 'd', '1', '3']) await page.keyboard.press(key)
  assert.equal(await page.locator('form.bt-q .bt-q-opt[aria-pressed="true"]').getAttribute('data-permission'), 'danger-full-access')
  assert.deepEqual(await saves(), [])
})

test('Details opens the card again in the chat', async (t) => {
  const page = await fixture(t, { width: 1280 })
  if (!page) return
  await mountPanel(page, { permission: 'workspace-write' })
  await page.locator('.bt-drawer-permission .bt-model-trigger').waitFor()
  assert.equal(await page.locator('form.bt-q').count(), 0, 'a Bot with a level shows no card on its own')
  await page.getByRole('button', { name: 'Choose in the chat' }).click()
  await page.locator('form.bt-q').waitFor()
  assert.equal(await page.locator('form.bt-q .bt-q-opt[aria-pressed="true"]').getAttribute('data-permission'), 'workspace-write')
  await shot(page, 'details-and-card-1280-light')
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.locator('form.bt-q').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.saves), [])
})

test('a window that can only view the team: no card, and no live row in Details', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await mountPanel(page, { readOnly: 'This window can only view the team' })
  const trigger = page.locator('.bt-drawer-permission .bt-model-trigger')
  await trigger.waitFor()
  assert.equal(await page.locator('form.bt-q').count(), 0)
  assert.equal(await page.locator('.bt-drawer-permission button:enabled').count(), 1)
  assert.equal(await trigger.isEnabled(), true)
  await trigger.click()
  const popup = page.locator('.bt-permission-menu')
  const seen = await measure(page, '.bt-permission-menu')
  checkRows(seen, THREE, 'read-only', { explanationInk: false })
  // This is the popup's look on dev, in the composer too: only the name carries danger ink.
  assert.equal(seen.rows.find(row => row.level === 'danger-full-access').textInk, seen.rows[0].textInk, 'Full access uses the same explanation ink as the first row')
  assert.ok(seen.rows.length === 3 && seen.rows.every(row => row.disabled && row.drawn))
  assert.equal(await popup.evaluate(node => document.activeElement === node && node.tabIndex === -1), true)
  assert.equal(await popup.locator('button:not([disabled])').count(), 0)
  await popup.locator('.bt-q-opt[data-permission="danger-full-access"]').click({ force: true })
  assert.equal(await popup.locator('.bt-perm-confirm').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.saves), [])
  await shot(page, 'details-view-only-light')
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'detached' })
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true)
})

for (const [view, scope] of [['settings', '.bt-drawer-permission'], ['group', '.bt-gs-perm']]) {
  for (const [theme, dark] of THEMES) {
    test(`${view} keeps the segmented picker and explains every level under it, ${theme}`, async (t) => {
      const page = await fixture(t, { dark })
      if (!page) return
      await page.evaluate(view => window.mount({ view, levels: ['read-only', 'workspace-write', 'auto', 'danger-full-access'] }), view)
      const box = page.locator(scope)
      await box.waitFor()
      assert.equal(await box.locator('.bt-seg button').count(), 4)
      const lines = await box.locator('.bt-perm-about .bt-note').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, fits: node.scrollWidth <= node.clientWidth + 1, tall: node.getBoundingClientRect().height >= 15 })))
      assert.deepEqual(lines.map(line => line.text.split(':')[0]), ['Read only', 'Workspace', 'Auto review', 'Full access'])
      assert.ok(lines.every(line => line.fits && line.tall && line.text.length > 60), 'each level has its sentence, inside the box')
      const placed = await box.evaluate((node) => {
        const frame = node.getBoundingClientRect()
        const dialog = document.querySelector('.bt-settings-main').getBoundingClientRect()
        return [...node.querySelectorAll('.bt-seg, .bt-perm-about .bt-note')].every((part) => {
          const rect = part.getBoundingClientRect()
          return rect.left >= Math.max(frame.left, dialog.left) - 0.5 && rect.right <= Math.min(frame.right, dialog.right) + 0.5 && rect.width >= 200
        })
      })
      assert.ok(placed, 'the picker and every line sit inside the card, at a readable width')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
      await box.scrollIntoViewIfNeeded()
      await shot(page, `${view}-${theme}`)
      await box.getByRole('button', { name: 'Full access' }).click()
      assert.deepEqual(await page.evaluate(() => window.saves), [], 'Full access asks first here too')
      await box.locator('.bt-perm-confirm').waitFor()
      const asked = await box.locator('.bt-perm-confirm').evaluate((node) => {
        const dialog = document.querySelector('.bt-settings-main').getBoundingClientRect()
        return [node, ...node.children].every((part) => { const rect = part.getBoundingClientRect(); return rect.left >= dialog.left && rect.right <= dialog.right })
      })
      assert.ok(asked, 'the question and its buttons stay inside the page')
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.bt-settings-scroll')].some(node => node.scrollWidth > node.clientWidth + 1)), false, 'the page does not scroll sideways')
      await box.locator('.bt-perm-confirm').scrollIntoViewIfNeeded()
      await shot(page, `${view}-confirm-${theme}`)
    })
  }
}
