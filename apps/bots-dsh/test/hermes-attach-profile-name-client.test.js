import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { hostText, installLocale } from '../src/client/i18n.js'

const CODE = 'bot/hermes-attach-profile'
const PLAIN = 'This connection’s saved Hermes profile is not served there. Choose a profile again before connecting.'
const named = label => `This connection’s saved Hermes profile “${label}” is not served there. Choose a profile again before connecting.`
const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))

// The real DSH React seed and JSDOM harness used by hermes-settings.test.js.
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
const compiled = await build({
  stdin: { contents: "export { HermesRemoteConnect } from './hermes-remote.js'; export { ModelMenu } from './model-menu.js'; export { installLocale } from './i18n.js'", resolveDir: new URL('../src/client/', import.meta.url).pathname },
  bundle: true, format: 'cjs', platform: 'browser', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// As in host-text.test.js: Chinese comes from register(), Portuguese from the
// actual language pack, and interpolation replaces parameters exactly once.
function locale(active) {
  let zh = {}
  return {
    register: (_namespace, language, words) => { if (language.startsWith('zh')) zh = words; return () => {} },
    bind: () => (key, params) => ((active.startsWith('zh') ? zh : active === 'pt-BR' ? pt : {})[key] ?? key)
      .replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match),
    getLocale: () => ({ active }),
  }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function failedScreen(t, { facts, message = PLAIN, statusReadFails = false, language = 'en', menu = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>'), calls = []
  const keys = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'MutationObserver']
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  keys.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] }))
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const view = { enabled: true, setupVersion: 1, mode: 'ssh', authMode: 'token', address: '', ssh: { host: 'sample-box' }, profile: 'alpha', credentialSet: true, models: [{ id: 'sample:old', name: 'Sample model' }], sessions: [] }
  const module = { exports: {} }
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require: nativeRequire, window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, console, setTimeout, clearTimeout, AbortController, crypto: globalThis.crypto,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    fetch: async (_url, init) => ({ ok: true, json: async () => {
      const request = JSON.parse(init.body)
      calls.push(request)
      if (request.endpoint === 'hermes-remote') return { ok: true, value: view }
      if (request.endpoint === 'hermes-remote-connect') return { ok: false, error: { code: CODE, message } }
      if (request.endpoint === 'hermes-remote-test-status') {
        if (statusReadFails) throw Error('Sample status read failed')
        return { ok: true, value: { stage: 'reach', ...(facts ? { failure: { code: CODE, kind: 'attach-profile', stage: 'connection', ...facts } } : {}) } }
      }
      if (request.endpoint === 'hermes-remote-disconnect') return { ok: true, value: view }
      assert.fail(`Unexpected fixture endpoint: ${request.endpoint}`)
    } }),
  })
  const off = module.exports.installLocale(locale(language))
  const root = createRoot(dom.window.document.getElementById('root'))
  t.after(() => {
    flushSync(() => root.unmount()); off(); dom.window.close()
    keys.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key])
  })
  const props = menu ? {
    bot: { id: 'alpha', name: 'Alpha Bot' },
    roster: { models: [{ ref: 'sample/model', provider: 'sample', name: 'Sample model' }] },
    actions: { refreshModels: async () => {} },
  } : { initialView: view, onConnected: () => assert.fail('a refused connection cannot open a chat'), onClose() {} }
  flushSync(() => root.render(React.createElement(module.exports[menu ? 'ModelMenu' : 'HermesRemoteConnect'], props)))
  if (menu) {
    flushSync(() => dom.window.document.querySelector('.bt-model-trigger').click())
    await waitFor(() => dom.window.document.querySelector('[data-route="hermes-remote"]'), 'Hermes route')
    flushSync(() => dom.window.document.querySelector('[data-route="hermes-remote"]').click())
  }
  await waitFor(() => dom.window.document.querySelector('[data-status=error]'), 'attach refusal screen')
  assert.deepEqual(calls.find(call => call.endpoint === 'hermes-remote-connect').payload, { cached: true })
  assert.deepEqual(calls.find(call => call.endpoint === 'hermes-remote-test-status').payload, { connect: true })
  const details = dom.window.document.querySelector('.bt-hw-details-toggle')
  assert.ok(details)
  assert.equal(details.getAttribute('aria-expanded'), 'false')
  flushSync(() => details.click())
  const text = selector => dom.window.document.querySelector(selector)?.textContent ?? ''
  const rows = Object.fromEntries([...dom.window.document.querySelectorAll('.bt-hw-facts .bt-hw-pair')].map(row => [row.querySelector('span').textContent, row.querySelector('strong').textContent]))
  return { document: dom.window.document, text, rows }
}

function assertNamedScreen(render, label) {
  assert.equal(render.text('.bt-hw-content h2'), 'The saved profile is not served there')
  assert.equal(render.text('.bt-hw-failed h3'), `Hermes on sample-box no longer serves the profile “${label}”`)
  assert.equal(render.text('.bt-hw-details>p'), `This connection saved the Hermes profile “${label}”, which is not served on that machine.`)
  assert.equal(render.text('.bt-hw-error-note'), 'Open the connection setup and choose a profile that Hermes serves there.')
  assert.equal(render.rows['Saved profile'], label)
  assert.equal(render.rows['SSH host'], 'sample-box')
}

test('#1341 setup and model-menu failure screens name the saved profile in title, text and facts', async t => {
  for (const menu of [false, true]) await t.test(menu ? 'model menu' : 'setup wizard', async sub => {
    assertNamedScreen(await failedScreen(sub, { menu, facts: { profile: 'alpha', profileName: 'Alpha Bot' } }), 'Alpha Bot (alpha)')
  })
})

test('#1341 client profile labels preserve ids, Unicode, spaces, quotes and braces literally', async t => {
  for (const [name, facts, label] of [
    ['id only', { profile: 'alpha' }, 'alpha'],
    ['same name and id', { profile: 'alpha', profileName: 'alpha' }, 'alpha'],
    ['space id', { profile: 'Team Alpha', profileName: 'Alpha Bot' }, 'Alpha Bot (Team Alpha)'],
    ['Unicode id', { profile: 'produção', profileName: 'Produção Alpha' }, 'Produção Alpha (produção)'],
    ['quotes and braces', { profile: 'alpha', profileName: 'Alpha "{host}" “{profile}”' }, 'Alpha "{host}" “{profile}” (alpha)'],
    ['one character', { profile: 'a', profileName: 'A' }, 'A (a)'],
    ['100 characters', { profile: 'a'.repeat(100), profileName: 'A'.repeat(100) }, `${'A'.repeat(100)} (${'a'.repeat(100)})`],
  ]) await t.test(name, async sub => { assertNamedScreen(await failedScreen(sub, { facts }), label) })
})

function assertPlainScreen(render) {
  assert.equal(render.text('.bt-hw-content h2'), 'The saved profile is not served there')
  assert.equal(render.text('.bt-hw-failed h3'), 'Choose this Hermes profile again')
  assert.equal(render.text('.bt-hw-details>p'), 'This connection’s saved Hermes profile is not served on that machine.')
  assert.equal(render.text('.bt-hw-error-note'), 'Open the connection setup and choose a profile that Hermes serves there.')
  assert.deepEqual(render.rows, { 'SSH host': 'sample-box' })
  assert.deepEqual([...render.document.querySelectorAll('.bt-hw-foot button')].map(button => button.textContent.replace(/[→←]/g, '').trim()), ['More options', 'Try again'])
}

test('#1341 client rejects invalid profile facts and invalid names by the host acceptance rule', async t => {
  for (const [name, value] of [
    ['control character', 'alpha\x01'], ['DEL', 'alpha\x7f'], ['newline', 'alpha\nbeta'],
    ['slash', 'alpha/beta'], ['backslash', 'alpha\\beta'], ['leading space', ' alpha'],
    ['trailing space', 'alpha '], ['empty', ''], ['too long', 'a'.repeat(101)], ['non-string', 7],
  ]) {
    await t.test(`invalid id: ${name}`, async sub => {
      assertPlainScreen(await failedScreen(sub, { facts: { profile: value, profileName: 'Alpha Bot' } }))
    })
    await t.test(`invalid name: ${name}`, async sub => {
      assertNamedScreen(await failedScreen(sub, { facts: { profile: 'alpha', profileName: value } }), 'alpha')
    })
  }
})

test('#1341 a failed status read retains the named API message including its translation', async t => {
  for (const [language, expected] of [
    ['en', named('Alpha Bot (alpha)')],
    ['zh-CN', '此连接保存的 Hermes 配置“Alpha Bot (alpha)”在该机器上不可用。请重新选择配置后再连接。'],
    ['pt-BR', 'O perfil do Hermes “Alpha Bot (alpha)” salvo nesta conexão não é servido nessa máquina. Escolha um perfil novamente antes de conectar.'],
  ]) await t.test(language, async sub => {
    const render = await failedScreen(sub, { language, message: named('Alpha Bot (alpha)'), statusReadFails: true })
    assert.equal(render.text('.bt-hw-details>p'), expected)
    assert.equal(render.rows[language === 'zh-CN' ? '保存的配置' : language === 'pt-BR' ? 'Perfil salvo' : 'Saved profile'], undefined)
    if (language === 'en') {
      assert.equal(render.text('.bt-hw-failed h3'), 'Choose this Hermes profile again')
      assert.equal(render.text('.bt-hw-error-note'), 'Open the connection setup and choose a profile that Hermes serves there.')
    }
  })
})

test('#1341 no profile and the fixed host message keep the existing failure screen unchanged', async t => {
  for (const [name, options] of [
    ['no failure detail', {}], ['failure without profile', { facts: {} }], ['status read failed', { statusReadFails: true }],
  ]) await t.test(name, async sub => { assertPlainScreen(await failedScreen(sub, options)) })
})

test('#1341 named client title, text and Saved profile row render in Chinese and the pt-BR pack', async t => {
  const label = 'Alpha "{host}" (alpha)'
  for (const [language, title, text, row] of [
    ['zh-CN', `sample-box 上的 Hermes 不再提供配置“${label}”`, `此连接保存了 Hermes 配置“${label}”，但该机器不提供此配置。`, '保存的配置'],
    ['pt-BR', `O Hermes em sample-box não serve mais o perfil “${label}”`, `Esta conexão salvou o perfil do Hermes “${label}”, que não é servido nessa máquina.`, 'Perfil salvo'],
  ]) await t.test(language, async sub => {
    const render = await failedScreen(sub, { language, facts: { profile: 'alpha', profileName: 'Alpha "{host}"' } })
    assert.equal(render.text('.bt-hw-failed h3'), title)
    assert.equal(render.text('.bt-hw-details>p'), text)
    assert.equal(render.rows[row], label)
  })
})

test('#1341 hostText translates named refusals in Chinese and the pt-BR pack without changing the label', () => {
  const labels = ['alpha', 'Alpha Bot (alpha)', 'Produção Alpha (produção)', 'Alpha "{host}" “{profile}” (Team Alpha)']
  for (const label of labels) assert.equal(hostText(named(label)), named(label))
  for (const language of ['zh-CN', 'pt-BR']) {
    const off = installLocale(locale(language))
    try {
      for (const label of labels) assert.equal(hostText(named(label)), language === 'zh-CN'
        ? `此连接保存的 Hermes 配置“${label}”在该机器上不可用。请重新选择配置后再连接。`
        : `O perfil do Hermes “${label}” salvo nesta conexão não é servido nessa máquina. Escolha um perfil novamente antes de conectar.`)
    } finally { off() }
  }
  for (const label of labels) assert.equal(hostText(named(label)), named(label), 'locale cleanup restores English')
})
