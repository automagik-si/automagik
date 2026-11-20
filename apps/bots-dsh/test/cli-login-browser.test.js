// The sign-in row in a Bot's chat (plan v3, 2.3 and 4.1) over the pinned DSH: its conversation,
// composer, Lexical editor, draft persistence and transcript are real; the host's cli-login-*
// endpoints are a fake in the page. No CLI, network or model is involved.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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
// Expose shipped internals in the fixture string only; no installed file changes.
const nativeBundle = (name, exports) => {
  const text = readFileSync(join(harness, name, 'lib/client.js'), 'utf8')
  assert.match(text, /return module\.exports;?(?=\s*\}\s*\}\);)/)
  return text.replace(/return module\.exports;?(?=\s*\}\s*\}\);)/, `${exports}; return module.exports;`)
}
const scripts = [
  nativeBundle('dsh-client-ui-renderer', 'exports.fixtureCreateRenderer = createSlotRenderer'),
  nativeBundle('dsh-client-ui-conversation', 'exports.fixture = { SessionInputShell, InputBar, ConversationContent, DefaultConversationViews, createConversationStore, createComposerFileIntake, rootClass: ConversationRoot_module_css_default.root }'),
  nativeBundle('dsh-client-ui-chat', 'exports.fixture = { ChatView, TurnErrorNodeView }'),
]
const app = await build({ entryPoints: [join(plugin, 'test/fixtures/cli-login-browser-app.js')], bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })

async function fixture(t, { width = 1440, height = 820, dark = false } = {}) {
  const guard = await browserGuard()
  if (guard.skip) { t.skip(guard.skip); return null }
  const browser = await guard.chromium.launch({ executablePath: guard.executablePath, headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.route('**/*', route => (route.request().url() === 'https://automagik.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><style>*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{background:var(--bt-main)}</style><div id="root"></div>' })
    : route.abort()))
  await page.goto('https://automagik.test/')
  if (dark) await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
  await page.addScriptTag({ content: seeds.outputFiles[0].text })
  await page.addScriptTag({ content: `window.modules={};window.require=name=>modules[name]??nativeSeeds[name];
    window.__ModuleLoader__={load({id,factory}){modules[id]=factory(Object.assign(name=>name==='@deepseek-ai/cordis'
      ? {...nativeSeeds[name],Service:class{constructor(ctx,key){this.ctx=ctx;ctx[key]=this}}}
      : modules[name]??nativeSeeds[name],{asset:()=>''}));}};` })
  for (const content of [...scripts, app.outputFiles[0].text]) await page.addScriptTag({ content })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  t.after(() => assert.deepEqual(errors, [], 'the pinned DSH and the row throw nothing'))
  return page
}

const A = { id: 'alpha', name: 'Alpha', model: 'deepseek-official/deepseek-flash' }
const B = { id: 'beta', name: 'Beta', model: 'deepseek-official/deepseek-flash' }
const row = (page, id = 'alpha') => page.locator(`[data-cli-login-seat="${id}"] [data-cli-login]`)

test('account settings distinguish terminal and Bot identities and confirm switch/sign-out',
  async t => {
    const page = await fixture(t)
    if (!page) return
    await page.evaluate(() => window.showAccounts())
    await page.getByText('Bots: bot@example.test', { exact: true }).waitFor()
    await page.getByText('Terminal: terminal@example.test', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Switch account', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.accountCalls), [])
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.accountCalls), [])
    await page.getByRole('button', { name: 'Switch account', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.accountCalls), ['switch', 'open'])
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByText('Bots: Sign in again in the app to resume Bots', {
      exact: true,
    }).waitFor()
    await page.getByText('Terminal: terminal@example.test', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.accountCalls),
      ['switch', 'open', 'signout'])
  })
test('account settings name this installation and say the Bot sign-in may be shared', async t => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.showAccounts())
  await page.getByText('This installation: desktop', { exact: true }).waitFor()
  await page.getByText('Other Automagik installations on this computer may use this same Bot sign-in. A change here changes it for all of them.', {
    exact: true,
  }).waitFor()
})
test('a busy account change keeps the host sentence instead of one generic line', async t => {
  const page = await fixture(t)
  if (!page) return
  const busy = 'Another Automagik session on this computer is using the Bot account. Close it, then press Sign in again.'
  await page.evaluate(message => window.showAccounts('bot/refused', message), busy)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  assert.equal(await page.getByRole('alert').innerText(), busy)
})
test('blocked account recovery shows the reset action and no private process diagnostic',
  async t => {
    const page = await fixture(t)
    if (!page) return
    await page.evaluate(() => window.showAccounts('bot/account-recovery'))
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    const text = await page.getByRole('alert').innerText()
    assert.match(text, /Reset Bot sign-in to start fresh/)
    assert.doesNotMatch(text, /private-process-diagnostic/)
    assert.deepEqual(await page.evaluate(() => window.accountCalls), [])
    await page.getByRole('button', { name: 'Reset Bot sign-in', exact: true }).waitFor()
  })

for (const evidence of ['pending', 'damaged']) {
  test(`cold settings offer an explicit reset for ${evidence}`, async t => {
    const page = await fixture(t)
    if (!page) return
    await page.evaluate(evidence => window.showRecoveryAccounts(evidence), evidence)
    await page.getByRole('button', { name: 'Reset Bot sign-in', exact: true }).waitFor()
    await page.getByText('Bots: healthy@example.test', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.accountCalls), [], 'cold load never resets')
    assert.equal(await page.evaluate(() => window.accountReads), 1)
    assert.match(await page.getByRole('alert').innerText(), /Reset Bot sign-in to start fresh/)
    await page.getByRole('button', { name: 'Reset Bot sign-in', exact: true }).click()
    await page.getByText('This stops running Bot work for this account. Continue?', {
      exact: true,
    }).waitFor()
    await page.getByText('This signs Codex out for Bots. Sign in again in the app.', {
      exact: true,
    }).waitFor()
    await page.getByText('Bot models and history stay.', { exact: true }).waitFor()
    await page.getByText('Bot CLI user settings start empty.', { exact: true }).waitFor()
    await page.getByText('Previous Bot sign-in files stay separate and are never reused.', {
      exact: true,
    }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.accountCalls), [])
    await page.getByRole('button', { name: 'Reset Bot sign-in', exact: true }).click()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.accountCalls), ['reset', 'open'])
    await page.getByText('Bots: healthy@example.test', { exact: true }).waitFor()
    assert.equal(await page.getByText('Terminal: terminal@example.test', {
      exact: true,
    }).count(), 2)
    assert.equal(await page.getByRole('button', {
      name: 'Reset Bot sign-in', exact: true,
    }).count(), 0)
  })
}

const field = page => page.locator('[data-cli-login-field] input')
const editorOf = (page, id = 'alpha') => page.locator(`[data-conversation-session="${id}"] [data-composer-input]`)
const calls = (page, endpoint) => page.evaluate(endpoint => window.calls.filter(call => call.endpoint === endpoint), endpoint)
const loginNodes = page => page.evaluate(() => document.querySelectorAll('[data-cli-login-seat],[data-cli-login],[data-cli-login-anchor],[data-cli-login-field]').length)
const CODE = state => `authcode-XYZ#${state}`
async function seed(page, bots = [A], options) {
  await page.evaluate(({ bots, options }) => window.setBots(bots, options), { bots, options })
  await editorOf(page, options?.shown ?? bots[0].id).waitFor()
}
async function typeDraft(page, text, id = 'alpha') {
  await editorOf(page, id).click()
  await page.keyboard.type(text, { delay: 15 })
}
async function claudeStep(page, id = 'alpha') {
  await page.evaluate(id => window.openLogin(id, 'acp-claude'), id)
  await row(page, id).getByRole('button', { name: 'Sign in', exact: true }).click()
  await field(page).waitFor()
}
const boxes = page => page.evaluate(() => {
  const box = node => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
  const shown = document.querySelector('[data-conversation-content]:not([hidden] *)')
  return { card: box(shown.querySelector('[data-composer-card]')), selector: box(shown.querySelector('[data-fixture-selector]')), seat: box(shown.querySelector('[data-composer-seat]')) }
})
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

test('the row shows only after an explicit entry, never on mounting a Bot chat', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page, [A, B])
  await frame(page)
  assert.equal(await loginNodes(page), 0)
  // Settings' path (updateBot) only refuses; only the chat's path opens a row, in that chat.
  assert.equal(await page.evaluate(() => window.updateBot('alpha', 'acp-claude/default')), 'bot/sign-in-required')
  await frame(page)
  assert.equal(await loginNodes(page), 0)
  assert.equal((await calls(page, 'cli-login-start')).length, 0)
  assert.deepEqual(await page.evaluate(() => window.rows()), {})
})

test('mounting: with history, in a blank chat, under another View and with two chats in the DOM', async (t) => {
  const page = await fixture(t, { height: 520 })
  if (!page) return
  await seed(page, [A, B])
  await page.evaluate(() => window.setFlow('alpha', { rows: 12 }))
  // Scrolled up: the explicit entry brings the row into view once.
  await page.evaluate(() => { document.querySelector('[data-conversation-session="alpha"] [data-conversation-scroll]').scrollTop = 0 })
  await page.evaluate(() => window.openLogin('alpha', 'acp-codex'))
  await row(page).waitFor()
  await frame(page)
  assert.equal(await row(page).evaluate(node => { const r = node.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 }), true, 'the row was brought into view')
  const seat = page.locator('[data-cli-login-seat="alpha"]')
  assert.equal(await seat.evaluate(node => node.parentElement.hasAttribute('data-chat-flow') && node.nextElementSibling?.hasAttribute('data-text-interaction-surface')), true)
  assert.equal(await seat.evaluate(node => node.closest('[data-chat-running]') === null), true)
  // Nothing scrolls after that: scrolling away stays where the person put it.
  await page.evaluate(() => { document.querySelector('[data-conversation-session="alpha"] [data-conversation-scroll]').scrollTop = 0 })
  await page.evaluate(() => window.setFlow('alpha', { rows: 13 }))
  await frame(page)
  assert.equal(await page.evaluate(() => document.querySelector('[data-conversation-session="alpha"] [data-conversation-scroll]').scrollTop), 0)

  // Another View on top: not mounted; the attempt lives on.
  await page.evaluate(() => window.setView('alpha', 'files'))
  await page.locator('[data-native-files]').waitFor()
  await seat.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => window.rows().alpha?.stage), 'offer')
  await page.evaluate(() => window.setView('alpha', 'chat'))
  await seat.waitFor()

  // Two chats in the DOM, both with a row: only the shown one draws it.
  await page.evaluate(() => window.openLogin('beta', 'acp-codex'))
  await page.evaluate(() => window.selectSession('alpha'))
  await frame(page)
  assert.equal(await page.locator('[data-cli-login-seat]').count(), 1)
  assert.equal(await page.locator('[data-conversation-session="alpha"] [data-cli-login-seat="alpha"]').count(), 1)

  // A blank chat (the hero): in its scroller, before the composer seat.
  await page.evaluate(() => window.setBots([{ id: 'gamma', name: 'Gamma' }], { blank: true }))
  await page.evaluate(() => window.openLogin('gamma', 'acp-claude'))
  const hero = page.locator('[data-cli-login-seat="gamma"]')
  await hero.waitFor()
  assert.equal(await page.locator('[data-conversation-session="gamma"] [data-chat-flow]').count(), 0, 'the native blank chat really has no flow')
  assert.equal(await hero.evaluate(node => node.parentElement.hasAttribute('data-conversation-scroll') && node.nextElementSibling?.hasAttribute('data-composer-seat')), true)
  await page.evaluate(() => window.setBlank('gamma', false))
  await page.locator('[data-chat-flow] [data-cli-login-seat="gamma"]').waitFor()
  assert.equal(await page.locator('[data-cli-login-seat="gamma"]').count(), 1)
  assert.equal((await calls(page, 'cli-login-cancel')).length, 0)
})

test('a turn that starts and ends during Claude\'s code step keeps the field value and focus', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page)
  await claudeStep(page)
  await field(page).click()
  await page.keyboard.type('partial-code', { delay: 5 })
  const seatBefore = await page.locator('[data-cli-login-seat="alpha"]').evaluate((node) => { window.seatNode = node; return true })
  assert.ok(seatBefore)
  await page.evaluate(() => window.setFlow('alpha', { running: true, rows: 4 }))
  await page.locator('[data-chat-running]').waitFor()
  await page.evaluate(() => window.setFlow('alpha', { running: false, rows: 5, error: true }))
  await page.locator('[data-chat-running]').waitFor({ state: 'detached' })
  assert.equal(await field(page).inputValue(), 'partial-code')
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-cli-login-field]') !== null), true)
  assert.equal(await page.evaluate(() => document.querySelector('[data-cli-login-seat="alpha"]') === window.seatNode), true, 'one seat, never remounted')
  // The native turn error row of DSH shows in a Bot chat (2.2's place for switch failures).
  const error = await page.locator('[data-turn-error-host]').boundingBox()
  assert.ok(error && error.height > 0)
})

test('during: composer and model cell unchanged and usable; the native editor takes no edit in Claude\'s step', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page)
  await typeDraft(page, 'keep this draft')
  const before = await boxes(page)
  const stored = await page.evaluate(() => localStorage.getItem('dsh.conversation.alpha'))
  assert.match(stored, /keep this draft/, 'the real draft persistence is live')
  await claudeStep(page)
  assert.deepEqual(await boxes(page), before, 'composer, seat and model cell keep their size')
  await page.locator('[data-conversation-session="alpha"] [data-fixture-selector]').click()
  assert.equal(await page.evaluate(() => window.selectorClicks), 1, 'the model cell stays usable')
  assert.match(await row(page).innerText(), /The message field comes back as soon as you send the code or cancel/)
  const editor = editorOf(page)
  await editor.click()
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-cli-login-field]') !== null), true, 'a click on the editor lands in the code field')
  await editor.evaluate(node => node.focus())
  await page.keyboard.type('xyz')
  for (const key of ['Backspace', 'Delete', 'Enter', 'Control+z', 'Control+y', 'Control+Shift+z']) await page.keyboard.press(key)
  await editor.dispatchEvent('paste', {})
  await editor.dispatchEvent('drop', {})
  await editor.evaluate((node) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true }))
    for (const inputType of ['insertText', 'insertCompositionText', 'insertFromPaste', 'deleteContentBackward', 'historyUndo', 'historyRedo']) {
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: 'q' }))
    }
  })
  assert.equal(await editor.innerText(), 'keep this draft', 'the draft is intact and nothing was added')
  assert.equal(await page.evaluate(() => localStorage.getItem('dsh.conversation.alpha')), stored)
  assert.equal(await field(page).inputValue(), '', 'nothing moved into the code field')

  // A secret the Bot asked for comes first: the field is disabled until it is done.
  await page.evaluate(() => window.setSecret('alpha', true))
  await page.getByText('Finish the secret requested first.').waitFor()
  assert.equal(await field(page).isDisabled(), true)
  await page.evaluate(() => window.setSecret('alpha', false))
  assert.equal(await field(page).isDisabled(), false)

  // No event of the code field reaches a listener on the document.
  await field(page).click()
  await page.keyboard.type('abc')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Control+c')
  await field(page).dispatchEvent('drop', {})
  assert.deepEqual(await page.evaluate(() => window.documentEvents), [])
  await page.keyboard.press('Escape')
  // The step ends (cancel): the editor works again and the draft is the person's own.
  await row(page).getByRole('button', { name: 'Cancel sign-in' }).click()
  await row(page).getByRole('button', { name: 'Yes, cancel' }).click()
  await row(page).waitFor({ state: 'detached' })
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' more', { delay: 15 })
  assert.equal(await editor.innerText(), 'keep this draft more')
  assert.equal(await loginNodes(page), 0)
})

test('sentinel: the Claude code never reaches a draft, storage, a send or the transcript', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page)
  const state = await page.evaluate(() => window.STATE)
  const code = CODE(state)
  await claudeStep(page)
  // Every way into the field: typing, paste, and a wrong code first.
  await field(page).click()
  await page.keyboard.type('wrong#code')
  await page.keyboard.press('Enter')
  await row(page).getByRole('alert').filter({ hasText: 'Paste the complete code' }).waitFor()
  assert.equal(await field(page).inputValue(), '', 'a sent value never stays in the field')
  await page.evaluate(code => navigator.clipboard.writeText(code), code)
  await field(page).click()
  await page.keyboard.press('Control+v')
  await row(page).getByRole('button', { name: 'Send', exact: true }).click()
  await row(page).filter({ hasText: 'Done: signed in to Claude Code.' }).waitFor()
  assert.equal((await calls(page, 'cli-login-answer')).at(-1).payload.value, code, 'the code goes only to the answer endpoint')

  // After the step: paste and drop of the code in the editor, with spaces, line breaks and words around.
  const editor = editorOf(page)
  for (const variant of [code, `${code}\n`, `  ${code}  `, `here it is: ${code} thanks`, code.replace('#', '# ').replace('State', 'St ate')]) {
    await editor.click()
    await page.evaluate(text => navigator.clipboard.writeText(text), variant)
    await page.keyboard.press('Control+v')
    await editor.evaluate((node, text) => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
      node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', dataTransfer: data }))
    }, variant)
  }
  assert.doesNotMatch(await editor.innerText(), /authcode|Sentinel/)
  // The row went by itself; the guard stays for the page's life.
  await row(page).waitFor({ state: 'detached', timeout: 5000 })
  await editor.click()
  await page.evaluate(text => navigator.clipboard.writeText(text), code)
  await page.keyboard.press('Control+v')
  assert.doesNotMatch(await editor.innerText(), /authcode|Sentinel/)
  // An ordinary paste and send still go through the normal send.
  await page.evaluate(() => navigator.clipboard.writeText('an ordinary message'))
  await page.keyboard.press('Control+v')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.sends.length === 1)
  assert.deepEqual(await page.evaluate(() => window.sends), [{ id: 'alpha', text: 'an ordinary message' }])
  assert.ok(await page.evaluate(() => window.refusedNotices) > 0, 'each refusal tells the person')
  const everything = await page.evaluate(() => window.everything() + document.querySelector('[data-conversation-session="alpha"]').innerText)
  assert.equal(everything.includes('authcode-XYZ'), false)
  assert.equal(everything.includes(`#${state}`), false)
})

test('sentinel: Enter, the send button and undo after a clean-up are refused; after a cancel too', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page)
  const state = await page.evaluate(() => window.STATE)
  await claudeStep(page)
  // A draft that holds the state when the step ends is cleared (setDraft('')).
  await page.evaluate(code => window.forceDraft('alpha', `note ${code}`), CODE(state))
  await row(page).getByRole('button', { name: 'Cancel sign-in' }).click()
  await row(page).getByRole('button', { name: 'Yes, cancel' }).click()
  await row(page).waitFor({ state: 'detached' })
  const editor = editorOf(page)
  await page.waitForFunction(() => document.querySelector('[data-conversation-session="alpha"] [data-composer-input]').innerText.trim() === '')
  // Paste after a cancel is refused.
  await editor.click()
  await page.evaluate(text => navigator.clipboard.writeText(text), CODE(state))
  await page.keyboard.press('Control+v')
  assert.equal((await editor.innerText()).trim(), '')
  // A draft that carries the state some other way: Enter and the send button refuse it.
  await page.evaluate(code => window.forceDraft('alpha', code), `see ${CODE(state)}`)
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.locator('[data-conversation-session="alpha"] [data-composer-card] button[aria-busy]').click()
  await page.waitForTimeout(150)
  assert.deepEqual(await page.evaluate(() => window.sends), [])
  // Undo after the end-of-step clean-up brings nothing sendable back.
  await page.evaluate(() => window.forceDraft('alpha', ''))
  await editor.click()
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(state => window.sends.some(send => send.text.includes(state)), state), false)
})

test('remote attempt: reload restores it in the Bot that opened it; another Bot joins only explicitly; nothing cancels', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page, [A, B])
  await page.evaluate(() => window.openLogin('alpha', 'acp-codex'))
  await row(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await row(page).getByText('ABCD-1234').waitFor()
  const attemptId = await page.evaluate(() => window.host.attempts['acp-codex'].attemptId)
  // A reload (a new page's state): the row comes back in Alpha by itself.
  await page.evaluate(() => { window.newPage(); window.setBots([{ id: 'alpha', name: 'Alpha', model: 'deepseek-official/deepseek-flash' }, { id: 'beta', name: 'Beta', model: 'deepseek-official/deepseek-flash' }], { shown: 'beta' }) })
  await frame(page)
  assert.equal(await loginNodes(page), 0, 'Beta, which did not open it, shows nothing')
  await page.evaluate(() => window.selectSession('alpha'))
  await row(page).getByText('ABCD-1234').waitFor()
  // Beta joins by an explicit entry: the same attempt, no new one.
  await page.evaluate(() => window.openLogin('beta', 'acp-codex'))
  await row(page, 'beta').getByText('ABCD-1234').waitFor()
  assert.equal(await page.evaluate(() => window.host.attempts['acp-codex'].attemptId), attemptId)
  // Claude next to Codex in Alpha: one agent per row, both attempts alive.
  await page.evaluate(() => window.openLogin('alpha', 'acp-claude'))
  await row(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await field(page).waitFor()
  assert.equal(await page.evaluate(() => window.host.attempts['acp-codex'].status), 'waiting')
  assert.equal(await page.locator('[data-cli-login-seat="alpha"] [data-cli-login]').count(), 1)
  // The cancel asks first, naming where it was opened.
  await page.evaluate(() => window.selectSession('beta'))
  await row(page, 'beta').getByRole('button', { name: 'Cancel sign-in' }).click()
  await row(page, 'beta').getByText('Cancel the Codex sign-in opened in Alpha?').waitFor()
  await row(page, 'beta').getByRole('button', { name: 'Keep it' }).click()
  assert.equal((await calls(page, 'cli-login-cancel')).length, 0, 'reading, reloading and joining never cancel')
})

test('a view that comes back after the attempt ended: signed in shows success, a restart says so', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page, [A, B])
  await page.evaluate(() => window.openLogin('alpha', 'acp-codex'))
  await row(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await row(page).getByText('ABCD-1234').waitFor()
  // Authorized on another device; the attempt is gone (60 s retention passed).
  await page.evaluate(() => { window.host.signedIn['acp-codex'] = true; window.host.restarted = true })
  await row(page).filter({ hasText: 'Done: signed in to Codex.' }).waitFor()
  await row(page).waitFor({ state: 'detached', timeout: 5000 })
  assert.equal(await loginNodes(page), 0)
  // A restart while waiting, not signed in, before the expiry.
  await page.evaluate(() => { window.host.restarted = false; delete window.host.attempts['acp-claude'] })
  await page.evaluate(() => window.openLogin('alpha', 'acp-claude'))
  await row(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await field(page).waitFor()
  await page.evaluate(() => { window.host.restarted = true })
  await row(page).getByText('The sign-in was interrupted by a restart. Get a new link.').waitFor()
  await row(page).getByRole('button', { name: 'Close' }).click()
  assert.equal(await loginNodes(page), 0)
})

test('success without interaction: the row leaves by itself and the next message goes the normal way', async (t) => {
  const page = await fixture(t)
  if (!page) return
  // One conversation in the DOM: the fixture binds every composer to the shown one's shell.
  await seed(page)
  const history = await page.locator('[data-conversation-session="alpha"] [data-native-message]').allInnerTexts()
  const before = await boxes(page)
  await page.evaluate(() => window.openLogin('alpha', 'acp-codex'))
  await row(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await row(page).getByText('ABCD-1234').waitFor()
  await page.evaluate(() => window.finishSignIn('acp-codex'))
  await row(page).filter({ hasText: 'Done: signed in to Codex.' }).waitFor()
  await page.waitForTimeout(3300)
  assert.equal(await loginNodes(page), 0, 'no sign-in element or text is left')
  assert.doesNotMatch(await page.locator('[data-conversation-session="alpha"]').innerText(), /sign/i)
  assert.deepEqual(await boxes(page), before)
  assert.equal(await page.locator('[data-conversation-session="alpha"] [data-fixture-selector]').isVisible(), true)
  await typeDraft(page, 'hello again')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.sends.length === 1)
  assert.deepEqual(await page.evaluate(() => window.sends), [{ id: 'alpha', text: 'hello again' }])
  assert.deepEqual(await page.locator('[data-conversation-session="alpha"] [data-native-message]').allInnerTexts(), history)
  await page.evaluate(() => window.setBots([{ id: 'alpha', name: 'Alpha', model: 'deepseek-official/deepseek-flash' }, { id: 'beta', name: 'Beta', model: 'deepseek-official/deepseek-flash' }], { shown: 'beta' }))
  await frame(page)
  assert.equal(await loginNodes(page), 0, 'nothing in Bot B')
  assert.deepEqual(await page.evaluate(() => window.rows()), {})
})

test('the model chosen in the chat: applied to that Bot once signed in; a refusal shows and leaves after ~8 s', async (t) => {
  const page = await fixture(t)
  if (!page) return
  await seed(page, [A, B])
  assert.equal(await page.evaluate(() => window.chooseInChat('alpha', 'acp-claude/default')), 'ok', 'a signed-out agent opens the row instead of failing')
  await row(page).getByText('To use Claude Code in this Bot, sign in to your account.').waitFor()
  assert.equal(await page.evaluate(() => window.botModel('alpha')), 'deepseek-official/deepseek-flash', 'the Bot keeps its model meanwhile')
  await row(page).getByRole('button', { name: 'Sign in', exact: true }).click()
  await field(page).waitFor()
  assert.equal((await calls(page, 'cli-login-start'))[0].payload.model, 'acp-claude/default')
  // Beta joins without choosing: it registers nothing.
  await page.evaluate(() => window.openLogin('beta', 'acp-claude'))
  await page.waitForFunction(() => window.calls.filter(call => call.endpoint === 'cli-login-current' && call.payload.botId === 'beta').length > 0)
  assert.equal((await calls(page, 'cli-login-start')).filter(call => call.payload.botId === 'beta').length, 0)
  await page.evaluate(() => window.selectSession('alpha'))
  await page.evaluate(() => window.finishSignIn('acp-claude'))
  await row(page).filter({ hasText: 'Done: signed in to Claude Code.' }).waitFor()
  assert.equal(await page.evaluate(() => window.botModel('alpha')), 'acp-claude/default')
  assert.equal(await page.evaluate(() => window.botModel('beta')), 'deepseek-official/deepseek-flash')

  // The host could not apply it: the row says so, then leaves by itself.
  await page.evaluate(() => { window.host.applyFails = true; window.host.signedIn['acp-codex'] = false })
  assert.equal(await page.evaluate(() => window.chooseInChat('beta', 'acp-codex/default')), 'ok')
  await page.evaluate(() => window.selectSession('beta'))
  await row(page, 'beta').getByRole('button', { name: 'Sign in', exact: true }).click()
  await row(page, 'beta').getByText('ABCD-1234').waitFor()
  await page.evaluate(() => window.finishSignIn('acp-codex'))
  await row(page, 'beta').filter({ hasText: /Signed in, but Codex could not be used/ }).waitFor()
  assert.match(await row(page, 'beta').innerText(), /This Bot stays on DeepSeek Flash/)
  await page.waitForTimeout(3500)
  assert.equal(await row(page, 'beta').count(), 1, 'still shown after the success delay')
  await row(page, 'beta').waitFor({ state: 'detached', timeout: 7000 })
  assert.equal(await loginNodes(page), 0)
})

for (const [width, dark] of [[1440, false], [1440, true], [420, false], [420, true]]) {
  test(`visual: ${width}px ${dark ? 'dark' : 'light'}: a long link wraps, the composer keeps its size, nothing is left after`, async (t) => {
    const page = await fixture(t, { width, dark })
    if (!page) return
    await seed(page)
    const before = await boxes(page)
    await claudeStep(page)
    await frame(page)
    const geometry = await page.evaluate(() => {
      const r = document.querySelector('[data-cli-login]').getBoundingClientRect()
      const buttons = [...document.querySelectorAll('[data-cli-login] button')].map(node => node.getBoundingClientRect())
      const card = getComputedStyle(document.querySelector('.bt-cli-row'))
      return { width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, row: { left: r.left, right: r.right },
        buttons: buttons.every(b => b.right <= r.right + 0.5 && b.width > 0), ink: card.color, background: card.backgroundColor }
    })
    assert.ok(geometry.scroll <= geometry.width + 1, 'no horizontal page scroll')
    assert.ok(geometry.row.left >= 0 && geometry.row.right <= geometry.width, 'the row stays in the column')
    assert.ok(geometry.buttons, 'every button fits in the row')
    assert.notEqual(geometry.ink, geometry.background)
    assert.deepEqual(await boxes(page), before, 'composer, seat and model cell keep their size')
    await row(page).getByRole('button', { name: 'Cancel sign-in' }).click()
    await row(page).getByRole('button', { name: 'Yes, cancel' }).click()
    await row(page).waitFor({ state: 'detached' })
    assert.deepEqual(await boxes(page), before)
    assert.equal(await loginNodes(page), 0)
  })
}

test('the consent-mode account card reserves, renames and makes shared through the real client actions', async t => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.showReservationAccounts())
  await page.getByText('Bots: owner@example.test', { exact: true }).waitFor()
  await page.getByText('Workspace plan: covers every ChatGPT workspace of this email', { exact: true }).waitFor()
  await page.getByText('Shared with other instances (default).', { exact: true }).waitFor()
  for (const name of ['Switch account', 'Sign out', 'Reset Bot sign-in']) {
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0)
  }
  const reserve = page.getByRole('button', { name: 'Reserve for a project', exact: true })
  const project = page.getByRole('textbox', { name: 'Project name', exact: true })
  const next = page.getByRole('button', { name: 'Continue', exact: true })
  await reserve.click()
  await project.fill('My project')
  await page.getByText(/Anyone who can read this team's files and the key could test a guessed email/).waitFor()
  await next.click()
  await page.getByText('Reserved for My project. This holds in this installation only for now; other installations are not checked yet.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  assert.equal(await project.inputValue(), 'My project')
  await project.fill('Renamed project')
  await project.press('Enter')
  await page.getByText('Reserved for Renamed project. This holds in this installation only for now; other installations are not checked yet.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Make shared', exact: true }).click()
  await page.getByText('Shared with other instances (default).', { exact: true }).waitFor()
  assert.equal(await project.count(), 0)

  const [created, renamed] = (await calls(page, 'cli-login-reserve')).map(call => call.payload)
  assert.deepEqual(created, { offerId: created.offerId, label: 'My project' })
  assert.deepEqual(renamed, { offerId: renamed.offerId, label: 'Renamed project', claimId: renamed.claimId, rev: renamed.rev })
  assert.notEqual(renamed.offerId, created.offerId)
  const [released] = (await calls(page, 'cli-login-release')).map(call => call.payload)
  assert.deepEqual(released, { claimId: renamed.claimId, rev: released.rev })
  assert.notEqual(released.rev, renamed.rev)
  for (const action of ['switch', 'signout', 'reset']) assert.deepEqual(await calls(page, `cli-login-${action}`), [])
})

test('the isolated account card disables Reserve with a reason and closes a replaced offer form', async t => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.showReservationAccounts({ isolated: true, instance: '' }))
  const codex = page.locator('.bt-set-row').filter({ has: page.getByText('Codex', { exact: true }) })
  const reserve = codex.getByRole('button', { name: 'Reserve for a project', exact: true })
  const label = codex.getByRole('textbox', { name: 'Project name', exact: true })
  await codex.getByText('This installation has no instance id; reservations are off.', { exact: true }).waitFor()
  assert.equal(await reserve.isDisabled(), true)
  for (const [state, message] of [
    ['unknown', 'The sign-in could not be read; reservations wait.'],
    ['recovery', 'Recover the Bot sign-in before reserving this account.'],
    ['unsupported', 'This version cannot read the account evidence needed for reservations.'],
    ['signed-out', 'Sign in to reserve this account.'],
    ['ambiguous', 'This Codex plan is not known to this version.'],
    ['unread', 'The account could not be read for reservations. Try again.'],
    ['changed', 'This reservation changed. Look again.'],
  ]) {
    await page.evaluate(state => window.refreshReservations({ instance: 'test-instance', state }), state)
    await codex.getByText(message, { exact: true }).waitFor()
    assert.equal(await reserve.isDisabled(), true, state)
  }
  await page.evaluate(() => window.refreshReservations({ state: 'complete' }))
  await reserve.click()
  await label.fill('Do not send')
  await page.evaluate(() => window.refreshReservations({ exact: 'c'.repeat(43) }))
  await label.waitFor({ state: 'detached' })
  assert.deepEqual(await calls(page, 'cli-login-reserve'), [])
  await reserve.click()
  assert.equal(await label.inputValue(), '')
  await codex.getByRole('button', { name: 'Cancel', exact: true }).click()
  await label.waitFor({ state: 'detached' })
})

test('the machine account card renames and releases by handle and shows the OS owner', async t => {
  const page = await fixture(t)
  if (!page) return
  const machineId = 'fixture-machine-handle'
  await page.evaluate(machineId => window.showReservationAccounts({ isolated: true, machine: {
    state: 'mine', claims: [{ machineId, label: 'Machine project', owner: 'alice', current: true }],
  } }), machineId)
  await page.getByText('Reserved for Machine project on this machine.', { exact: true }).waitFor()
  await page.getByText('File owner: alice', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const label = page.getByRole('textbox', { name: 'Project name', exact: true })
  assert.equal(await label.inputValue(), 'Machine project')
  await label.fill('Machine rename')
  await label.press('Enter')
  await page.getByText('Reserved for Machine rename on this machine.', { exact: true }).waitFor()
  const [{ payload }] = await calls(page, 'cli-login-reserve')
  assert.deepEqual(payload, { offerId: payload.offerId, label: 'Machine rename', machineId })
  await page.getByRole('button', { name: 'Make shared', exact: true }).click()
  await page.getByText('Shared with other instances (default).', { exact: true }).waitFor()
  const released = await calls(page, 'cli-login-release')
  assert.deepEqual(released.map(call => call.payload), [{ machineId }])
})

test('the machine card shows the sign-out reason and missing folder notice', async t => {
  const page = await fixture(t)
  if (!page) return
  await page.evaluate(() => window.showReservationAccounts({ isolated: true, machine: {
    state: 'refused', label: 'Other project', owner: 'bob', signedOut: true, claims: [],
  } }))
  const codex = page.locator('.bt-set-row')
    .filter({ has: page.getByText('Codex', { exact: true }) })
  const message = 'Reserved for Other project on another instance. Sign in with another '
    + 'account, or ask its owner to make it shared.'
  await codex.getByText(message, { exact: true }).waitFor()
  await codex.getByText('File owner: bob', { exact: true }).waitFor()
  await codex.getByText('Bots: Sign in again in the app to resume Bots', { exact: true }).waitFor()
  const reserve = codex.getByRole('button', { name: 'Reserve for a project', exact: true })
  assert.equal(await reserve.count(), 0)
  await page.evaluate(() => window.refreshReservations({
    machine: { state: 'notice', notice: 'absent', claims: [] },
  }))
  const notice = 'Reservations are not checked across instances here: '
    + 'this machine has no reservations folder.'
  await codex.getByText(notice, { exact: true }).waitFor()
})
