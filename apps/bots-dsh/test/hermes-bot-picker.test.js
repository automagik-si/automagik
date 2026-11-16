// The Hermes bot picker in the real client: every detected bot by name with what it is, its
// own model as a secondary line, and a stopped bot shown with how to start it — never a
// Connect that would start or borrow another serve. The host here is a fake; nothing leaves
// the page.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'

const require = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = require('jsdom')
const assets = join(process.env.DSH_HARNESS, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const seed = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(seed)
const seeds = await build({ stdin: { contents: `${frontend.slice(0, seed.index + seed[0].length)}; globalThis.nativeSeeds = ${seed[1]}();`, resolveDir: assets }, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent' })
const seedDom = new JSDOM('<!doctype html><body></body>')
const seedContext = { window: seedDom.window, document: seedDom.window.document, navigator: seedDom.window.navigator, MutationObserver: seedDom.window.MutationObserver, console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder }
runInNewContext(seeds.outputFiles[0].text, seedContext)
const nativeRequire = name => seedContext.nativeSeeds[name] ?? require(name)
const React = nativeRequire('react'), { createRoot } = nativeRequire('react-dom/client'), { flushSync } = nativeRequire('react-dom')
const compiled = await build({ entryPoints: [new URL('../src/client/hermes-remote.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'browser', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })

const cloneHome = '/Users/someone/.local/share/clone/hermes'
const cloneLock = `${cloneHome}/.local/state/hermes/gateway-locks`
const primaryHome = '/Users/someone/.hermes'
const bots = [
  { home: cloneHome, id: 'default', name: 'Luna', model: 'anthropic/claude-sonnet', provider: 'anthropic', running: true, recordDir: cloneLock, port: 9301, start: `HERMES_HOME=${cloneHome} hermes serve` },
  { home: primaryHome, id: 'default', name: 'Atlas', model: 'openai/gpt-5.1', provider: 'openai', running: false, recordDir: '', port: 0, start: 'hermes serve' },
]

async function mount(t, { detection = { bots } } = {}) {
  const dom = new JSDOM('<div id="root"></div>')
  const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver']
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }))
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const calls = []
  const endpoints = {
    'hermes-remote': () => ({ enabled: false, mode: 'ssh', profile: '', profiles: [], models: [], sessions: [], minimum: '0.22.5' }),
    'hermes-remote-ssh-hosts': () => ({ aliases: [{ alias: 'sample-box', hostname: 'sample-box', user: 'clone', port: '' }], knownHosts: [] }),
    'hermes-remote-detect': payload => { calls.push({ endpoint: 'hermes-remote-detect', payload }); return typeof detection === 'function' ? detection(payload) : detection },
    'hermes-remote-test': payload => { calls.push({ endpoint: 'hermes-remote-test', payload }); return { testId: 'test-1', profiles: [{ id: 'default', name: 'Luna', model: 'anthropic/claude-sonnet', provider: 'anthropic', running: true }], defaultProfile: 'default' } },
    'hermes-remote-save': () => ({ enabled: true, mode: 'ssh', profile: 'default', profileName: 'Luna', models: [{ id: 'attach', name: 'anthropic/claude-sonnet (anthropic)' }], attached: true, sessions: [] }),
  }
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire, window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    console, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body)
      try {
        const value = await endpoints[request.endpoint](request.payload)
        return { ok: true, json: async () => ({ ok: true, value }) }
      } catch (error) {
        return { ok: true, json: async () => ({ ok: false, error: { code: error.code, message: 'Sample refusal.' } }) }
      }
    },
  })
  const opened = []
  const root = createRoot(dom.window.document.getElementById('root'))
  t.after(() => {
    flushSync(() => root.unmount()); dom.window.close()
    keys.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  flushSync(() => root.render(React.createElement(module.exports.HermesRemoteConnect, { onConnected: view => opened.push(view), onClose() {} })))
  const deadline = Date.now() + 5000
  while (!dom.window.document.querySelector('[data-step=host]:not([data-status=loading])')) {
    assert.ok(Date.now() < deadline, 'the wizard opens on the computer list')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { document: dom.window.document, calls, opened }
}

const fill = async (document, label, value) => {
  const input = [...document.querySelectorAll('input')].find(node => node.getAttribute('aria-label') === label)
  assert.ok(input, label)
  flushSync(() => {
    Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
    input.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }))
  })
}
const click = async (document, label) => {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent.replace(/[→←+−]/g, '').trim() === label || node.getAttribute('aria-label') === label)
  assert.ok(button, label)
  flushSync(() => button.click())
}

test('the picker shows every bot by name with what it is, its model second, and the serve state', async t => {
  const { document } = await mount(t)
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < deadline, 'the bot picker opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(document.querySelector('.bt-hw-content h2').textContent, 'Pick the bot')
  assert.match(document.querySelector('.bt-hw-lead').textContent, /These are the Hermes bots on sample-box\. Pick the one to chat with\./)
  const rows = [...document.querySelectorAll('.bt-hw-bot')]
  assert.deepEqual(rows.map(row => row.querySelector('strong').textContent), ['Luna', 'Atlas'])
  // Each bot says what it is, its own model second, and its state as a word beside the dot.
  for (const row of rows) {
    assert.ok(row.querySelector('.bt-hw-bot-state').textContent.trim())
    assert.ok(['Running', 'Not running'].includes(row.querySelector('.bt-hw-bot-state').textContent.trim()))
  }
  assert.match(rows[0].textContent, /Model: anthropic\/claude-sonnet/)
  assert.doesNotMatch(rows[0].textContent, /claude-sonnet \(anthropic\)/, 'the provider is not repeated when the model names it')
  assert.equal(rows[0].querySelector('.bt-hw-bot-state').textContent, 'Running')
  assert.equal(rows[1].querySelector('.bt-hw-bot-state').textContent, 'Not running')
  // A stopped bot is shown with how to start it; it is never hidden and never started here.
  assert.match(rows[1].textContent, /Start it with “hermes serve” on sample-box in a terminal\. Automagik never starts or restarts Hermes\./)
  assert.equal(rows[0].querySelector('.bt-hw-bot-start'), null, 'the running bot has no start line')
  assert.ok(rows[1].querySelector('.bt-hw-bot-start'), 'the stopped bot says how to start it')
})

test('the model is shown, not chosen; a stopped bot cannot be used and nothing tests before the pick', async t => {
  const { document, calls, opened } = await mount(t)
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < deadline, 'the bot picker opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(calls.map(call => call.endpoint), ['hermes-remote-detect'], 'detection reads; no connection test runs before the pick')
  const buttons = [...document.querySelectorAll('.bt-hw-foot button')]
  const use = buttons.find(button => button.textContent.includes('Use this bot'))
  assert.ok(use)
  // The first running bot is selected; the stopped one is selectable but has no way to connect.
  const row = running => document.querySelector(`.bt-hw-bot[data-running="${running}"]`)
  assert.equal(row(true).getAttribute('aria-checked'), 'true')
  flushSync(() => row(false).click())
  assert.equal(use.disabled, true)
  assert.deepEqual(calls.map(call => call.endpoint), ['hermes-remote-detect'])
  flushSync(() => row(true).click())
  assert.equal(use.disabled, false)
  await click(document, 'Use this bot')
  const tested = await (async () => {
    const until = Date.now() + 5000
    while (!calls.some(call => call.endpoint === 'hermes-remote-test')) {
      assert.ok(Date.now() < until, 'the picked bot is tested')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return calls.find(call => call.endpoint === 'hermes-remote-test')
  })()
  assert.equal(tested.payload.profile, 'default')
  assert.equal(tested.payload.ssh.hermesHome, cloneHome)
  assert.equal(tested.payload.ssh.recordDir, cloneLock)
  const until = Date.now() + 5000
  while (!opened.length) {
    assert.ok(Date.now() < until, 'the picked bot opens its chat')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(opened[0].profile, 'default')
})

test('a stopped bot is shown with how to start it, and its row cannot be used', async t => {
  const { document, calls, opened } = await mount(t)
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < deadline, 'the bot picker opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const stopped = document.querySelector('.bt-hw-bot[data-running=false]')
  assert.ok(stopped, 'a stopped bot is never hidden')
  assert.match(stopped.textContent, /Not running/)
  assert.match(stopped.textContent, /Start it with “hermes serve” on sample-box in a terminal\. Automagik never starts or restarts Hermes\./)
  flushSync(() => stopped.click())
  const use = [...document.querySelectorAll('.bt-hw-foot button')].find(button => button.textContent.includes('Use this bot'))
  assert.equal(use.disabled, true, 'a stopped bot cannot be used, so nothing connects or starts')
  assert.deepEqual(calls.map(call => call.endpoint), ['hermes-remote-detect'], 'picking a stopped bot tests and starts nothing')
  assert.deepEqual(opened, [])
})

test('no running bot offers Add another Hermes and remembers the folder', async t => {
  const folder = '/srv/alt-hermes'
  const { document, calls, opened } = await mount(t, {
    detection: payload => payload.extraHomes?.includes(folder)
      ? { bots: [{ home: folder, id: 'default', name: 'Aster', model: 'acme/aurora', provider: 'acme', running: true, recordDir: `${folder}/gateway-locks`, port: 9400, start: 'hermes serve' }] }
      : { bots: [] },
  })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=error]')) {
    assert.ok(Date.now() < deadline, 'the no-bots screen opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.match(document.body.textContent, /No Hermes bots found on sample-box/)
  await click(document, 'Add another Hermes')
  assert.equal(document.querySelector('.bt-hw-content h2').textContent, 'Add another Hermes')
  assert.match(document.body.textContent, /gateway-locks folder beside it/)
  await fill(document, 'Hermes folder on sample-box', folder)
  await click(document, 'Add and find bots')
  const until = Date.now() + 5000
  while (!calls.some(call => call.endpoint === 'hermes-remote-test')) {
    assert.ok(Date.now() < until, 'the added folder’s bot is found and used')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const detect = calls.filter(call => call.endpoint === 'hermes-remote-detect').at(-1)
  assert.deepEqual(detect.payload.extraHomes, [folder], 'the picked folder is scanned once')
  const tested = calls.find(call => call.endpoint === 'hermes-remote-test')
  assert.deepEqual(tested.payload.extraHomes, [folder], 'the folder is remembered for the connection')
  while (!opened.length) {
    assert.ok(Date.now() < until, 'the added bot opens its chat')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
})

test('a pointed folder with no Hermes says so in plain words', async t => {
  const { document } = await mount(t, { detection: { bots: [] } })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=error]')) {
    assert.ok(Date.now() < deadline, 'the no-bots screen opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await click(document, 'Add another Hermes')
  await fill(document, 'Hermes folder on sample-box', '/srv/empty-hermes')
  await click(document, 'Add and find bots')
  while (document.querySelector('.bt-hw-content h2').textContent !== 'No Hermes found in /srv/empty-hermes') {
    assert.ok(Date.now() < deadline, 'the pointed folder is tried')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(document.querySelectorAll('.bt-hw-failed h3').length, 0, 'only the folder line, no duplicate title')
  await click(document, 'Details')
  assert.match(document.body.textContent, /The folder on sample-box holds no Hermes settings or server record\./)
  assert.match(document.body.textContent, /Point at the folder that holds Hermes, or choose another computer\./)
  assert.ok([...document.querySelectorAll('.bt-hw-foot button')].some(button => button.textContent.includes('Add another Hermes')))
})

test('a pointed folder with a stopped Hermes shows the start-it line and cannot be picked', async t => {
  const folder = '/srv/stopped-hermes'
  const { document, calls } = await mount(t, {
    detection: payload => payload.extraHomes?.includes(folder)
      ? { bots: [{ home: folder, id: 'default', name: 'Ember', model: 'acme/ember', provider: 'acme', running: false, recordDir: '', port: 0, start: 'hermes serve' }] }
      : { bots: [] },
  })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=error]')) {
    assert.ok(Date.now() < deadline, 'the no-bots screen opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await click(document, 'Add another Hermes')
  await fill(document, 'Hermes folder on sample-box', folder)
  await click(document, 'Add and find bots')
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < deadline, 'the stopped bot opens the picker')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const row = document.querySelector('.bt-hw-bot')
  assert.equal(row.querySelector('strong').textContent, 'Ember')
  assert.match(row.textContent, /Not running/)
  assert.match(row.textContent, /Start it with “hermes serve” on sample-box in a terminal\. Automagik never starts or restarts Hermes\./)
  const use = [...document.querySelectorAll('.bt-hw-foot button')].find(button => button.textContent.includes('Use this bot'))
  assert.equal(use.disabled, true, 'a stopped bot cannot be picked')
  assert.ok(!calls.some(call => call.endpoint === 'hermes-remote-test'), 'nothing tests a stopped bot')
})

test('a bot in a shared serve-record folder says plainly why it cannot be picked', async t => {
  const bot = { home: '/srv/shared-hermes', id: 'default', name: 'Juniper', model: 'acme/juniper', provider: 'acme', running: false, recordDir: '', port: 0, blocked: 'shared-beside', start: 'hermes serve' }
  const { document, calls } = await mount(t, { detection: { bots: [bot] } })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < deadline, 'the bot picker opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const row = document.querySelector('.bt-hw-bot')
  assert.match(row.textContent, /Another folder beside this Hermes looks like a Hermes home\. Give this Hermes a folder of its own: move it, or move the other folder, then add that folder with Add another Hermes\./)
  assert.match(row.textContent, /move it, or move the other folder/, 'the advice names moving, not only adding')
  const use = [...document.querySelectorAll('.bt-hw-foot button')].find(button => button.textContent.includes('Use this bot'))
  assert.equal(use.disabled, true)
  assert.ok(!calls.some(call => call.endpoint === 'hermes-remote-test'), 'nothing tests or starts it')
})

test('no bot at all is said plainly, with the fix, not an empty list', async t => {
  const { document } = await mount(t, { detection: { bots: [] } })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const deadline = Date.now() + 5000
  while (!document.querySelector('[data-step=error]')) {
    assert.ok(Date.now() < deadline, 'the no-bots screen opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.match(document.body.textContent, /No Hermes bots found on sample-box/)
  assert.match(document.body.textContent, /Install Hermes there, add another Hermes folder, or choose another computer\./)
})

test('a gateway-only bot shows its detected serve command and stays unusable beside a plain stopped bot', async t => {
  const command = 'HERMES_HOME=/srv/x hermes serve'
  const { document, calls, opened } = await mount(t, { detection: { bots: [
    { home: '/srv/x', id: 'default', name: 'Atlas', model: 'sample/model', provider: '', running: false, gateway: true, start: command },
    { home: '/srv/oak', id: 'default', name: 'Oak', model: '', provider: '', running: false, start: 'hermes serve' },
  ] } })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const until = Date.now() + 5000
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < until, 'the gateway-only bot picker opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const rows = [...document.querySelectorAll('.bt-hw-bot')]
  assert.deepEqual(rows.map(row => row.querySelector('strong').textContent), ['Atlas', 'Oak'])
  const [gateway, stopped] = rows
  assert.equal(gateway.querySelector('.bt-hw-bot-state').textContent, 'Gateway running')
  assert.equal(gateway.querySelector('.bt-hw-bot-state').classList.contains('bt-hw-bot-ok'), false)
  assert.equal(gateway.querySelector('.bt-hw-bot-start').textContent,
    `Its gateway is running, but no “hermes serve” is. Start it with “${command}” on sample-box in a terminal; the gateway can keep running. Automagik never starts, stops or restarts Hermes.`)
  assert.equal(stopped.querySelector('.bt-hw-bot-state').textContent, 'Not running')
  assert.equal(stopped.querySelector('.bt-hw-bot-start').textContent,
    'Start it with “hermes serve” on sample-box in a terminal. Automagik never starts or restarts Hermes.')
  const use = [...document.querySelectorAll('.bt-hw-foot button')].find(button => button.textContent.includes('Use this bot'))
  assert.ok(use)
  assert.equal(use.disabled, true)
  for (const row of rows) {
    flushSync(() => row.click())
    assert.equal(use.disabled, true, 'selecting either stopped serve cannot enable attachment')
    flushSync(() => use.click())
  }
  assert.deepEqual(calls.map(call => call.endpoint), ['hermes-remote-detect'])
  assert.deepEqual(opened, [])
})

test('the picker drops non-boolean gateway flags rather than showing a gateway diagnosis', async t => {
  const { document, calls } = await mount(t, { detection: { bots: [
    { home: '/srv/atlas', id: 'default', name: 'Atlas', running: false, gateway: 'yes', start: 'hermes serve' },
    { home: '/srv/oak', id: 'default', name: 'Oak', running: false, gateway: 1, start: 'hermes serve' },
  ] } })
  await click(document, 'Use SSH host sample-box')
  await click(document, 'Connect')
  const until = Date.now() + 5000
  while (!document.querySelector('[data-step=bots]')) {
    assert.ok(Date.now() < until, 'the stopped bot picker opens')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual([...document.querySelectorAll('.bt-hw-bot-state')].map(node => node.textContent), ['Not running', 'Not running'])
  assert.doesNotMatch(document.body.textContent, /Gateway running|Its gateway is running/)
  assert.deepEqual(calls.map(call => call.endpoint), ['hermes-remote-detect'])
})
