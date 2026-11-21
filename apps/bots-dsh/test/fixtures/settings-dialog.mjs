import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { WINDOW } from './automations-host.mjs'

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
  entryPoints: [new URL('../../src/client/settings.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

export async function until(check, description) {
  const deadline = Date.now() + 5000
  for (;;) {
    const result = check()
    if (result) return result
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

export function renderDialog(t, host, { marker = WINDOW, actions: overrides } = {}) {
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
    const actions = { openSettings, closeSettings() {}, folders: async () => ({}), scheduleCreate: scheduleCall, scheduleDelete: scheduleCall, ...overrides }
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
