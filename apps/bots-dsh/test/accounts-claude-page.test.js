import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const harness = process.env.DSH_HARNESS
const { JSDOM } = createRequire(join(harness, 'package.json'))('jsdom')
const assets = join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed, 'use the React seed that DSH supplies in the app')
const seeds = await build({
  stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})
const compiled = await build({
  entryPoints: [new URL('../src/client/settings.js', import.meta.url).pathname],
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const READ = 'accounts-claude'
const USE = 'accounts-claude-use'
const token = 'a'.repeat(32)
const rows = [
  { id: 'default', label: 'default', state: 'eligible', email: 'a@example.test', selected: true, effective: true, use: false },
  { id: '2', label: 'slot', state: 'eligible', email: 'b@example.test', use: true },
  { id: '3', label: 'slot', state: 'eligible', email: 'c@example.test', use: true },
  { id: '4', label: 'slot', state: 'not-signed-in', email: null, use: false },
  { id: '5', label: 'slot', state: 'override', email: null, use: false },
  { id: '6', label: 'slot', state: 'bad-folder', email: null, use: false },
  { id: '7', label: 'slot', state: 'ambiguous', email: 'a@example.test', use: false },
  { id: '8', label: 'slot', state: 'timeout', email: null, use: false },
  { id: '9', label: 'slot', state: 'failed', email: null, use: false },
]
const noOffers = rows.map(row => ({ ...row, use: false }))
const ok = value => ({ ok: true, value })

function renderDialog(t, answer, { hasModels = false } = {}) {
  const { window } = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true, url: 'http://localhost' })
  const { document } = window
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  const sandbox = {
    window, document, navigator: window.navigator, MutationObserver: window.MutationObserver, console,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), AbortController, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder,
  }
  runInNewContext(seeds.outputFiles[0].text, sandbox)
  const native = sandbox.nativeSeeds
  const { createElement: h, useState } = native.react
  const { createRoot } = native['react-dom/client']
  const { flushSync } = native['react-dom']
  const calls = []
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, {
    ...sandbox, module, exports: module.exports, require: name => native[name],
    fetch: async (url, init) => {
      assert.equal(url, 'api/omni-ui')
      const { endpoint, payload } = JSON.parse(init.body)
      // The page's Codex part (5c) reads on its own; these tests follow the Claude part's calls.
      if (endpoint === 'accounts-codex') return Response.json(ok({ codex: { folder: '~/.codex', file: 'absent', account: null, lastRefresh: null }, proxy: 'unknown' }))
      calls.push({ endpoint, payload })
      return Response.json(await answer(endpoint, calls.length))
    },
  })
  const { SettingsDialog } = module.exports
  const roster = { bots: [], byId: {}, rooms: [], roomsById: {}, prefs: {} }
  function Dialog() {
    const [page, openSettings] = useState('general')
    const actions = { openSettings, closeSettings() {}, folders: async () => ({}), ...(hasModels ? { providers() {} } : {}) }
    return h(SettingsDialog, { page, roster, actions })
  }
  const root = createRoot(document.querySelector('#root'))
  flushSync(() => root.render(h(Dialog)))
  t.after(() => { flushSync(() => root.unmount()); window.close() })
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  const click = label => {
    const node = button(label)
    assert.ok(node, label)
    assert.equal(node.disabled, false)
    flushSync(() => node.click())
  }
  const find = text => [...document.querySelectorAll('.bt-settings-page .bt-set-hint')].find(node => node.textContent === text)
  const until = async check => {
    const deadline = Date.now() + 10_000
    while (!check()) {
      assert.ok(Date.now() < deadline, document.querySelector('.bt-settings-page')?.textContent)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  return { document, button, click, calls, find, until, actions: () => [...document.querySelectorAll('.bt-settings-page button')] }
}

test('Settings puts Accounts after Models or General and keeps Automations next to Scheduled tasks', async t => {
  for (const hasModels of [false, true]) await t.test(`Models ${hasModels ? 'listed' : 'hidden'}`, sub => {
    const page = renderDialog(sub, () => ok({ reason: 'desktop-only' }), { hasModels })
    assert.equal(Boolean(page.button('Models')), hasModels)
    assert.equal(page.button(hasModels ? 'Models' : 'General').nextElementSibling, page.button('Accounts'))
    assert.equal(page.button('Scheduled tasks').nextElementSibling, page.button('Automations'))
    assert.deepEqual(page.calls, [])
  })
})

test('the page shows slot details and disables every Use button through the switch and re-read', async t => {
  const written = Promise.withResolvers()
  const refreshed = Promise.withResolvers()
  const page = renderDialog(t, (endpoint, index) => {
    if (endpoint === USE) return written.promise
    return index === 1 ? ok({ rows, token }) : refreshed.promise
  })
  page.click('Accounts')
  assert.equal(page.document.querySelector('h2').textContent, 'Accounts')
  assert.ok(page.find('Loading…'))
  await page.until(() => page.button('Use Login 2'))
  assert.equal(page.document.querySelector('h3').textContent, 'Claude Code')
  const text = page.document.querySelector('.bt-settings-page').textContent
  for (const detail of [
    'Choose which Claude Code login new launches use, for bots that run from this Herdr home. Running bots keep their login until they restart.',
    'Default login', 'Login 2', 'a@example.test', 'b@example.test', 'Used by new launches',
    'Not signed in', 'An environment variable overrides this login', 'Its folder cannot be used',
    'Two logins share this email', 'Did not answer in time', 'Could not be read',
  ]) assert.ok(text.includes(detail), detail)
  assert.equal(page.find('Used by new launches').closest('.bt-set-row').textContent.includes('Default login'), true)
  assert.deepEqual(page.actions().map(node => node.getAttribute('aria-label')), ['Use Login 2', 'Use Login 3'])
  page.click('Use Login 2')
  assert.equal(page.actions().every(node => node.disabled), true)
  assert.deepEqual(page.calls[1], { endpoint: USE, payload: { id: '2', token } })
  written.resolve(ok({ switched: true }))
  await page.until(() => page.find('Claude Code login switched.'))
  assert.deepEqual(page.calls.map(call => call.endpoint), [READ, USE, READ])
  assert.equal(page.actions().every(node => node.disabled), true)
  refreshed.resolve(ok({ rows: noOffers.map(row => ({ ...row, effective: row.id === '2' })) }))
  await page.until(() => page.find('Used by new launches')?.closest('.bt-set-row').textContent.startsWith('Login 2'))
  assert.deepEqual(page.actions(), [])
})

test('fallback and own-launcher hints keep the rows visible and hide unavailable actions', async t => {
  for (const launcher of [false, true]) await t.test(launcher ? 'own launcher' : 'fallback', async sub => {
    const page = renderDialog(sub, () => ok({ rows: noOffers, fallback: !launcher, launcher }))
    page.click('Accounts')
    const line = launcher ? 'Claude Code starts through your own launcher here, so this page cannot tell which login it uses.'
      : 'The selected login cannot be used. Fix it in the Herdr Accounts panel.'
    await page.until(() => page.find(line))
    assert.equal(Boolean(page.find('Used by new launches')), !launcher)
    assert.deepEqual(page.actions(), [])
  })
})

test('read refusals show only fixed, translated hints and leave no Use button', async t => {
  for (const [reason, line, flags] of [
    ['not-installed', 'am or the Herdr pack is not installed on this computer.'],
    ['old-cli', 'Update am or the Herdr pack to switch logins here.', { why: 'old-cli', rows: noOffers }],
    ['panel-old', 'The Herdr Accounts panel is on and older than this page. Update the Herdr pack, or switch the panel off, to switch here.', { why: 'panel-old', rows: noOffers }],
    ['panel-unknown', 'Could not tell which version of the Herdr Accounts panel is installed.', { why: 'panel-unknown', rows: noOffers }],
    ['home-mismatch', 'This app and the command line use different Herdr homes, so switching is off here.', { why: 'home-mismatch', rows: noOffers }],
    ['unreadable', 'Could not read the Claude Code logins.'],
    ['chosen-home', 'This installation uses a separate agent home. Manage its logins in the Herdr Accounts panel.'],
    ['unavailable', 'Accounts are not available on Windows yet.'],
    ['read-only', 'This host can only read accounts.', { readOnly: true, rows: noOffers }],
    ['cli-error', 'am could not do this.'], ['cli-timeout', 'am took too long to reply.'], ['cli-protocol', 'am returned an unexpected reply.'],
  ]) await t.test(reason, async sub => {
    const page = renderDialog(sub, () => ok(flags ?? { reason }))
    page.click('Accounts')
    await page.until(() => page.find(line))
    assert.deepEqual(page.actions(), [])
  })
})

test('a desktop-only read leaves the desktop message to the Codex part and shows no Claude rows', async t => {
  const page = renderDialog(t, () => ok({ reason: 'desktop-only' }))
  page.click('Accounts')
  const text = () => page.document.querySelector('.bt-settings-page').textContent
  await page.until(() => page.calls.length === 1 && !text().includes('Loading…'))
  assert.deepEqual([...page.document.querySelectorAll('.bt-settings-page h3')].map(node => node.textContent), ['Codex'])
  assert.equal(page.find('Open Settings in the Automagik app on this computer to see accounts.'), undefined)
  assert.deepEqual(page.actions(), [])
})

test('every switch result triggers a re-read, and a read-only admission error ignores its message', async t => {
  for (const [reason, line] of [
    ['conflict', 'The logins changed since this page read them. Read again.'],
    ['busy', 'Another change to the logins is in progress. Read again.'],
    ['unknown', 'Could not confirm the switch. Read again before trying again.'],
    ['changed', 'This login choice has changed or expired. Read again.'],
    ['failed', 'Could not switch the Claude Code login.'],
    ['read-only', 'This host can only read accounts.'],
  ]) await t.test(reason, async sub => {
    const page = renderDialog(sub, (_endpoint, index) => {
      if (index === 1) return ok({ rows, token })
      if (index === 3) return ok({ rows: noOffers, readOnly: reason === 'read-only' })
      return reason === 'read-only' ? { ok: false, error: { code: 'bot/read-only', message: 'private-path-canary' } } : ok({ reason })
    })
    page.click('Accounts')
    await page.until(() => page.button('Use Login 2'))
    page.click('Use Login 2')
    await page.until(() => page.find(line) && page.actions().length === 0)
    assert.deepEqual(page.calls.map(call => call.endpoint), [READ, USE, READ])
    assert.doesNotMatch(page.document.body.textContent, /private-path-canary/)
  })
})

// ---- Add and Remove login (RFC 0030 delivery 5b; Decisions (2026-11-21), 1) ----

const ADD = 'accounts-claude-add'
const REMOVE = 'accounts-claude-remove'
const editToken = 'e'.repeat(32)
const editRows = [
  { id: 'default', label: 'default', state: 'eligible', email: 'a@example.test', selected: true, effective: true, use: false },
  { id: '2', label: 'slot', state: 'eligible', email: 'b@example.test', use: false, remove: true },
  { id: '3', label: 'slot', state: 'not-signed-in', email: null, use: false, remove: true },
]
const add = { id: '4', folder: '~/.claude-4', signIn: 'CLAUDE_CONFIG_DIR="$HOME/.claude-4" claude auth login' }
const editView = (extra = {}) => ok({ rows: editRows, add, editToken, ...extra })

test('Add shows the next slot, its folder and the sign-in command, then adds it and reads again', async t => {
  const added = Promise.withResolvers()
  const page = renderDialog(t, (endpoint, index) => {
    if (endpoint === ADD) return added.promise
    return index === 1 ? editView() : ok({ rows: [...editRows, { id: '4', label: 'slot', state: 'eligible', email: 'd@example.test', use: false, remove: true }], editToken })
  })
  page.click('Accounts')
  await page.until(() => page.button('Add Login 4'))
  const row = page.button('Add Login 4').closest('.bt-set-row')
  assert.ok(row.textContent.includes('Make the folder ~/.claude-4 (link settings.json and CLAUDE.md from ~/.claude into it to share them), sign in there from a terminal with this command, then press Add.'))
  assert.equal(row.querySelector('code').textContent, add.signIn)
  assert.deepEqual(page.actions().map(node => node.getAttribute('aria-label') ?? node.textContent),
    ['Remove Login 2', 'Remove Login 3', 'Add Login 4', 'Read again'])
  page.click('Add Login 4')
  assert.equal(page.actions().every(node => node.disabled), true)
  assert.deepEqual(page.calls[1], { endpoint: ADD, payload: { id: '4', token: editToken } })
  added.resolve(ok({ added: true }))
  await page.until(() => page.find('Login 4 added. Use it to start new Claude launches there.'))
  await page.until(() => page.button('Remove Login 4'))
  assert.deepEqual(page.calls.map(call => call.endpoint), [READ, ADD, READ])
})

test('Remove asks once more, Keep or a lapse of five seconds drops the question, and Remove sends the edit', async t => {
  const page = renderDialog(t, (endpoint, index) => endpoint === REMOVE ? ok({ removed: true }) : index === 1 ? editView() : editView({ rows: editRows.slice(0, 2) }))
  page.click('Accounts')
  await page.until(() => page.button('Remove Login 3'))
  page.click('Remove Login 3')
  const question = 'Remove Login 3 from this list? Its folder stays.'
  assert.ok(page.find(question))
  page.click('Keep')
  assert.equal(page.find(question), undefined)
  assert.equal(page.calls.length, 1)
  page.click('Remove Login 3')
  await page.until(() => !page.find(question))
  assert.equal(page.calls.length, 1)
  page.click('Remove Login 3')
  page.click('Remove Login 3 now')
  await page.until(() => page.find('Login 3 removed. Its folder stays; delete it by hand if you want.'))
  assert.deepEqual(page.calls[1], { endpoint: REMOVE, payload: { id: '3', token: editToken } })
  await page.until(() => !page.button('Remove Login 3'))
  assert.deepEqual(page.calls.map(call => call.endpoint), [READ, REMOVE, READ])
})

test('every edit refusal shows a fixed text, the signed-in one with its logout command, and reads again', async t => {
  for (const [answer, line] of [
    [{ reason: 'no-folder' }, 'That folder does not exist yet. Make it first, then sign in there.'],
    [{ reason: 'not-signed-in' }, 'Claude Code is not signed in there yet. Sign in with the command, then press Add.'],
    [{ reason: 'moved' }, 'Claude Code settings move this login to another folder, so this page will not change it.'],
    [{ reason: 'probe-failed' }, 'Could not tell whether Claude Code is signed in there. Try again.'],
    [{ reason: 'no-claude' }, 'Claude Code is not found where launches look for it.'],
    [{ reason: 'bad-folder' }, 'That folder cannot be used: it must be a folder of its own, not a link. Make it again, then sign in there.'],
    [{ reason: 'in-use' }, 'New launches use this login. Switch to another login first.'],
    [{ reason: 'running' }, 'A terminal still runs on this login. Restart or stop it first.'],
    [{ reason: 'running-unknown' }, 'A terminal runs on a login folder this page cannot match. Restart or stop it first.'],
    [{ reason: 'panes-unknown' }, 'Could not check the running terminals, so nothing was removed.'],
    [{ reason: 'unknown' }, 'Could not confirm the change. Read again before trying again.'],
    [{ reason: 'failed' }, 'Could not change the Claude Code logins.'],
    [{ reason: 'private-text' }, 'Could not change the Claude Code logins.'],
    [{ reason: 'conflict' }, 'The logins changed since this page read them. Read again.'],
    [{ reason: 'changed' }, 'This login choice has changed or expired. Read again.'],
    [{ reason: 'signed-in', signOut: `CLAUDE_CONFIG_DIR="$HOME"/'.claude-3' claude auth logout`, key: 'k3' }, 'Login 3 is still signed in. Sign it out in a terminal with this command, then remove it again.'],
  ]) await t.test(answer.reason, async sub => {
    // The read after a signed-in refusal names the same login, still signed in.
    const signedIn = editRows.map(row => row.id === '3' ? { ...row, state: 'eligible', email: 'c@example.test', key: 'k3' } : row)
    const page = renderDialog(sub, (endpoint, index) => endpoint === REMOVE ? ok(answer) : index === 1 ? editView() : editView({ rows: signedIn }))
    page.click('Accounts')
    await page.until(() => page.button('Remove Login 3'))
    page.click('Remove Login 3')
    page.click('Remove Login 3 now')
    await page.until(() => page.find(line) && page.calls.length === 3)
    const code = [...page.document.querySelectorAll('.bt-settings-page code')].map(node => node.textContent)
    assert.equal(code.includes(answer.signOut), answer.reason === 'signed-in')
    assert.doesNotMatch(page.document.body.textContent, /private-text/)
  })
})

test('Read again reads once; a read without an edit offer hides Add and Remove and keeps Read again for a retry', async t => {
  const page = renderDialog(t, (_endpoint, index) => index === 1 ? editView() : index === 2 ? ok({ rows: editRows, add }) : ok({ reason: 'cli-error' }))
  page.click('Accounts')
  await page.until(() => page.button('Read again'))
  page.click('Read again')
  await page.until(() => page.calls.length === 2 && !page.button('Add Login 4') && !page.button('Read again').disabled)
  assert.deepEqual(page.actions().map(node => node.textContent), ['Read again'])
  page.click('Read again')
  await page.until(() => page.find('am could not do this.') && !page.button('Read again').disabled)
  assert.deepEqual(page.calls.map(call => call.endpoint), [READ, READ, READ])
})

test('am alone with no Herdr home says why no login can be added', async t => {
  const page = renderDialog(t, () => ok({ rows: editRows.map(row => ({ ...row, remove: false })), editWhy: 'no-home' }))
  page.click('Accounts')
  await page.until(() => page.find('The Herdr home folder does not exist yet, so no login can be added here.'))
  assert.deepEqual(page.actions(), [])
})

test('the logout command shows only while the read after the refusal still names that same login', async t => {
  const signOut = `CLAUDE_CONFIG_DIR="$HOME"/'.claude-3' claude auth logout`
  const page = renderDialog(t, (endpoint, index) => endpoint === REMOVE ? ok({ reason: 'signed-in', signOut, key: 'k3' })
    : index === 1 ? editView() : editView({ rows: editRows.map(row => row.id === '3' ? { ...row, state: 'eligible', key: 'k9' } : row) }))
  page.click('Accounts')
  await page.until(() => page.button('Remove Login 3'))
  page.click('Remove Login 3')
  page.click('Remove Login 3 now')
  await page.until(() => page.calls.length === 3 && page.find('This login choice has changed or expired. Read again.'))
  assert.equal([...page.document.querySelectorAll('.bt-settings-page code')].some(node => node.textContent === signOut), false)
})
