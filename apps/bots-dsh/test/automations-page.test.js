import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { automationFixture, automationHost, WINDOW } from './fixtures/automations-host.mjs'

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
  entryPoints: [new URL('../src/client/settings.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

async function until(check, description) {
  const deadline = Date.now() + 5000
  for (;;) {
    const result = check()
    if (result) return result
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function renderDialog(t, host, { marker = WINDOW } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true, url: 'http://localhost' })
  const { window } = dom
  const { document } = window
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  window.confirm = () => assert.fail('removal uses the in-page confirmation')
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
      calls.push(endpoint)
      return host.request(endpoint, payload, { marker })
    },
  })
  const scheduleCall = () => assert.fail('Automations must never call DSH schedules')
  const roster = { bots: [], byId: {}, rooms: [], roomsById: {}, prefs: {} }
  const { SettingsDialog } = module.exports
  function Dialog() {
    const [page, openSettings] = useState('general')
    const actions = { openSettings, closeSettings() {}, folders: async () => ({}), scheduleCreate: scheduleCall, scheduleDelete: scheduleCall }
    return h(SettingsDialog, { page, roster, actions })
  }
  const root = createRoot(document.querySelector('#root'))
  flushSync(() => root.render(h(Dialog)))
  t.after(() => { flushSync(() => root.unmount()); window.close() })
  const button = label => [...document.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  const click = label => {
    const target = button(label)
    assert.ok(target, label)
    assert.equal(target.disabled, false)
    flushSync(() => target.click())
  }
  const fill = (name, value) => {
    const label = [...document.querySelectorAll('form label')].find(node => node.querySelector('.bt-bs-label')?.textContent === name)
    assert.ok(label, name)
    const field = label.querySelector('input,textarea,select')
    const { set } = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')
    flushSync(() => {
      set.call(field, value)
      field.dispatchEvent(new window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  const text = () => document.querySelector('.bt-settings-page').textContent
  return { document, button, click, fill, text, calls }
}

test('Settings opens Automations beside Scheduled tasks and previews, saves and removes through the real scheduler endpoints', async t => {
  const f = automationFixture(t, {
    paused: true, scheduler: 0,
    control: { checkPut: true },
    automations: [
      { name: 'Team review', cron: '0 9 * * 1-5', repo: '/example/folder', template: 'sample-template', workflow: 'private workflow text',
        next: '2099-06-01T09:00:00Z', last: { status: 'done', at: '2099-05-31T09:00:00Z', error: 'private error text' } },
      { name: '-no-remove', command: { argv: ['private command text'] }, disabled: true },
    ],
    invalid: [{ name: 'Broken entry', line: 5, message: 'private diagnostic text' }],
  })
  const page = renderDialog(t, automationHost(t, f))
  assert.equal(page.button('Scheduled tasks').nextElementSibling, page.button('Automations'))
  page.click('Automations')
  assert.equal(page.document.querySelector('h2').textContent, 'Automations')
  assert.match(page.text(), /Loading…/)
  await until(() => page.button('Add automation'), 'the list')
  for (const text of ['Agent runs on a schedule', 'The scheduler is paused.', 'The scheduler is stopped.', 'Team review', '0 9 * * 1-5', 'Next:', '/example/folder',
    'Template: sample-template', 'Workflow', 'Last run: Done', 'Command', 'Disabled', 'Invalid entries', 'Broken entry', 'line 5']) assert.ok(page.text().includes(text), text)
  assert.doesNotMatch(page.text(), /private .* text/)
  assert.equal(page.button('Remove -no-remove'), undefined)

  page.click('Add automation')
  assert.match(page.text(), /Uses the agent's own configured permissions\./)
  page.fill('Name', 'Local summary')
  page.fill('Folder', f.root)
  page.fill('Agent', 'codex')
  page.fill('Runs in', 'root')
  page.fill('Prompt', 'Summarize changes in this folder.')
  const before = f.bytes()
  page.click('Preview')
  await until(() => page.text().includes('Next runs:'), 'the preview')
  assert.deepEqual(f.bytes(), before)
  assert.deepEqual(page.calls, ['automations-list', 'automations-put'])
  page.click('Save')
  await until(() => page.button('Remove Local summary'), 'the re-read after Save')
  const saved = f.read().automations.find(row => row.name === 'Local summary')
  assert.deepEqual([saved.agent, saved.workspace, saved.timeout_minutes, saved.agent_args], ['codex', 'root', 60, []])

  page.click('Remove Local summary')
  assert.ok(page.button('Confirm removing Local summary'))
  assert.notEqual(f.read().automations.find(row => row.name === 'Local summary'), undefined)
  assert.equal(page.calls.includes('automations-remove'), false)
  page.click('Confirm removing Local summary')
  await until(() => !page.text().includes('Local summary'), 'the re-read after removal')
  assert.equal(f.read().automations.find(row => row.name === 'Local summary'), undefined)
  assert.deepEqual(page.calls, ['automations-list', 'automations-put', 'automations-put', 'automations-list', 'automations-remove', 'automations-list'])
})

test('a changed entry refreshes the page and needs a new confirmation', async t => {
  const name = 'Morning review'
  const f = automationFixture(t, { automations: [{ name, cron: '0 9 * * *', prompt: 'First draft' }] })
  const page = renderDialog(t, automationHost(t, f))
  page.click('Automations')
  await until(() => page.button('Remove Morning review'), 'the first revision')
  page.click('Remove Morning review')
  f.write({ ...f.read(), automations: [{ name, cron: '0 5 * * *', prompt: 'Revised draft' }] })
  page.click('Confirm removing Morning review')
  await until(() => page.text().includes('This automation changed.'), 'the changed-entry message')
  assert.match(page.text(), /0 5 \* \* \*/)
  assert.equal(page.button('Confirm removing Morning review'), undefined)
  assert.equal(f.calls().some(call => call.argv[0] === 'rm'), false)
  page.click('Remove Morning review')
  page.click('Confirm removing Morning review')
  await until(() => page.text().includes('No automations yet.'), 'the empty list')
  assert.deepEqual(f.read().automations, [])
})

test('an entry removed outside the page reports gone and refreshes the list', async t => {
  const name = 'Morning review'
  const f = automationFixture(t, { automations: [{ name, cron: '0 9 * * *', prompt: 'First draft' }] })
  const page = renderDialog(t, automationHost(t, f))
  page.click('Automations')
  await until(() => page.button(`Remove ${name}`), 'the listed entry')
  page.click(`Remove ${name}`)
  f.write({ ...f.read(), automations: [] })
  page.click(`Confirm removing ${name}`)
  await until(() => page.text().includes('This automation is already gone.'), 'the gone message')
  assert.match(page.text(), /No automations yet\./)
  assert.equal(page.button(`Confirm removing ${name}`), undefined)
  assert.equal(f.calls().some(call => call.argv[0] === 'rm'), false)
})

test('workflow, command and invalid entries can be removed from the page', async t => {
  const names = ['Workflow task', 'Command task', 'Invalid task']
  const f = automationFixture(t, {
    automations: [{ name: names[0], workflow: 'private workflow' }, { name: names[1], command: { argv: ['false'] } }],
    invalid: [{ name: names[2], line: 12, message: 'private diagnostic' }],
  })
  const page = renderDialog(t, automationHost(t, f))
  page.click('Automations')
  await until(() => page.button(`Remove ${names[2]}`), 'all listed entry kinds')
  for (const name of names) {
    page.click(`Remove ${name}`)
    page.click(`Confirm removing ${name}`)
    await until(() => !page.text().includes(name), `the refreshed list after removing ${name}`)
  }
  assert.deepEqual(f.read().automations, [])
  assert.deepEqual(f.read().invalid, [])
  assert.deepEqual(f.calls().filter(call => call.argv[0] === 'rm').map(call => call.argv[1]), names)
})

test('preview and save show the fixed problem and leave the form available', async t => {
  const f = automationFixture(t, { control: { put: { problem: 'test-only diagnostic text' } } })
  const page = renderDialog(t, automationHost(t, f))
  page.click('Automations')
  await until(() => page.button('Add automation'), 'the empty list')
  page.click('Add automation')
  page.fill('Name', 'Sample')
  page.fill('Folder', f.root)
  page.fill('Runs in', 'root')
  page.fill('Prompt', 'Review the latest changes.')
  for (const action of ['Preview', 'Save']) {
    page.click(action)
    await until(() => page.text().includes('The scheduler refused this automation.'), 'a fixed scheduler problem')
    assert.doesNotMatch(page.text(), /test-only diagnostic text/)
    assert.deepEqual(f.read().automations, [])
  }
  assert.deepEqual(page.calls, ['automations-list', 'automations-put', 'automations-put', 'automations-list'])
})

for (const [kind, message] of [
  ['desktop-only', 'Automations show in the Automagik desktop app.'],
  ['not-installed', "The scheduler is not installed on this computer. The Herdr pack's installer sets it up."],
]) {
  test(`the dialog shows the ${kind} state without mutation controls`, async t => {
    const f = automationFixture(t)
    if (kind === 'not-installed') f.env.HERDR_AUTOMATIONS = ''
    const page = renderDialog(t, automationHost(t, f), { marker: kind === 'desktop-only' ? null : WINDOW })
    page.click('Automations')
    await until(() => page.text().includes(message), kind)
    assert.equal(page.button('Add automation'), undefined)
    assert.deepEqual(f.calls(), [])
  })
}
