import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { until } from './until.js'

const harness = process.env.DSH_HARNESS
const nativeRequire = createRequire(join(harness, 'package.json'))
const { JSDOM } = nativeRequire('jsdom')
const assets = join(harness, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets')
const frontend = readFileSync(join(assets, readdirSync(assets).find(name => /^index-.*\.js$/.test(name))), 'utf8')
const factory = /function (\w+)\(\)\{return\{react:[\s\S]*?\}\}/.exec(frontend)
assert.ok(factory, 'the DSH frontend supplies its React seed factory')
const seeds = await build({
  stdin: { contents: `${frontend.slice(0, factory.index + factory[0].length)}; globalThis.nativeSeeds = ${factory[1]}();`, resolveDir: assets },
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent',
})
const seedDom = new JSDOM('<!doctype html><body></body>')
const { window: seedWindow } = seedDom
const seed = { window: seedWindow, document: seedWindow.document, navigator: seedWindow.navigator,
  MutationObserver: seedWindow.MutationObserver, fetch: async () => { throw new Error('Unexpected frontend fetch') },
  console, setTimeout, clearTimeout, performance, TextEncoder, TextDecoder }
runInNewContext(seeds.outputFiles[0].text, seed)
const { react: React, 'react-dom/client': { createRoot }, 'react-dom': { flushSync } } = seed.nativeSeeds

const bundle = await build({
  stdin: { contents: [
    "export { VoiceMode } from './voice.js'",
    "export { BotSettingsForm } from './bot-settings.js'",
    "export { teamActions } from './team-actions.js'",
    "export { indexRoster } from './sources.js'",
  ].join('\n'), resolveDir: new URL('../src/client/', import.meta.url).pathname },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

function windowFor(t, { voiceURI = 'fixture-voice' } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const { window } = dom
  const { document } = window
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const spoken = []
  let recognition, utterance, hold = false
  window.SpeechRecognition = class {
    start() { recognition = this }
    stop() { if (recognition === this) recognition = undefined; this.onend?.() }
  }
  class SpeechSynthesisUtterance { constructor(text) { this.text = text } }
  window.speechSynthesis = {
    getVoices: () => [{ voiceURI, lang: 'en-US', name: 'Fixture voice' }],
    cancel() { utterance?.onerror?.(); utterance = undefined },
    speak(next) {
      utterance = next
      spoken.push({ text: next.text, voice: next.voice?.voiceURI, rate: next.rate })
      next.onstart?.()
      if (!hold) queueMicrotask(() => { if (utterance === next) { utterance = undefined; next.onend?.() } })
    },
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, require: name => seed.nativeSeeds[name] ?? {},
    window, document, navigator: window.navigator, localStorage: window.localStorage,
    matchMedia: window.matchMedia, getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    Element: window.Element, HTMLElement: window.HTMLElement, MutationObserver: window.MutationObserver,
    URL, AbortController, crypto: globalThis.crypto, SpeechSynthesisUtterance, speechSynthesis: window.speechSynthesis,
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval,
  })
  const root = createRoot(document.getElementById('root'))
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; flushSync(() => root.unmount()) } }
  t.after(() => { unmount(); window.close() })
  return {
    document, window, spoken, unmount, components: module.exports,
    render: (Component, props) => flushSync(() => root.render(React.createElement(Component, props))),
    click(label) {
      const control = [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label
        || node.textContent.trim() === label)
      assert.ok(control, `Missing button ${label}`)
      assert.equal(control.disabled, false, `Disabled button ${label} (${control.closest('label')?.textContent ?? ''})`)
      flushSync(() => control.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    },
    change(label, value) {
      const control = document.querySelector(`select[aria-label="${label}"], input[aria-label="${label}"]`)
      assert.ok(control, `Missing control ${label}`)
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), 'value')
      flushSync(() => {
        descriptor.set.call(control, value)
        control.dispatchEvent(new window.Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      })
    },
    holdUtterance() { hold = true },
    async hear(text) {
      await until(() => recognition !== undefined)
      const result = Object.assign([{ transcript: text }], { isFinal: true })
      flushSync(() => recognition.onresult({ resultIndex: 0, results: [result] }))
    },
  }
}

export async function mountVoiceWindow(t, host, sessionId, options) {
  const page = windowFor(t, options)
  const { VoiceMode, teamActions, indexRoster } = page.components
  const roster = indexRoster(await host.ok('state'))
  const opened = Promise.withResolvers()
  const sent = Promise.withResolvers()
  const offers = []
  const actions = teamActions({ after: result => result, partFor: value => value,
    async call(endpoint, payload, signal) {
      try {
        const value = await host.ok(endpoint, payload, signal)
        if (endpoint === 'voice-pane' && payload.open) opened.resolve(value)
        if (endpoint === 'voice-wait' && value && payload.callId === undefined) offers.push(value)
        if (endpoint === 'send') sent.resolve(value)
        return value
      } catch (error) {
        if (endpoint === 'send') sent.reject(error)
        throw error
      }
    },
  })
  let closing, turnOutline = []
  Object.assign(actions, {
    speech: () => undefined,
    closeVoice: page.unmount,
    closingReply: () => closing,
    watchTurns: () => () => {},
  })
  const render = () => page.render(VoiceMode, {
    sessionId, roster, actions, useSessionStatus: select => select(new Map()),
    useSessions: select => select({ byId: {}, projectionsBySession: { [sessionId]: { values: { turnOutline } } } }),
  })
  render()
  assert.equal(await opened.promise, true)
  return {
    ...page, offers,
    async send(text) { await page.hear(text); await sent.promise },
    closeReply(text) { closing = text; turnOutline = [{ turn: 1 }]; render() },
    async pause() {
      page.click('Pause')
      await until(() => page.document.querySelector('.bt-voice-stage')?.dataset.phase === 'paused')
    },
  }
}

export async function mountRoleSettings(t, host, id) {
  const page = windowFor(t)
  const { BotSettingsForm, teamActions, indexRoster } = page.components
  const call = (endpoint, payload, signal) => host.ok(endpoint, payload, signal)
  const run = promise => Promise.resolve(promise)
  const actions = teamActions({ call, after: value => value })
  // The surrounding Settings dialog supplies these unrelated app callbacks.
  Object.assign(actions, { modelOptions: () => [], availablePermissions: () => [], schedules: async () => [] })
  const refresh = async () => {
    const roster = indexRoster(await call('state'))
    page.render(BotSettingsForm, { bot: roster.byId[id], roster, actions, run })
  }
  await refresh()
  return {
    ...page, refresh, text: () => page.document.getElementById('root').textContent,
    async click(label) { page.click(label) },
  }
}
