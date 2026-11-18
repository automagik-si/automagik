// The Code side at app start (RFC 0030 delivery 1): installing the flip registers no body and
// fetches nothing. The renderer is one package-local chunk, asked for by name once, and only
// when the Terminal face's body first renders.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { build } from 'esbuild'
import { PANE_CHUNK, loadPane } from '../src/client/code-side-lazy.js'

// The DSH module loader accepts only these package-local chunk names (client-modules).
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useEffect: () => {},
  useState: initial => [initial, () => {}],
}

/** The flip module as the page gets it, with the platform react stood in for. */
const flipModule = async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/code-side.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    external: ['react'],
  })
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : (() => { throw new Error(`no platform module ${name}`) })()), console, URL, URLSearchParams, setTimeout, clearTimeout, TextEncoder, TextDecoder }
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  return { exports: module.exports, sandbox }
}

test('the renderer chunk has a name the DSH module loader accepts', () => {
  assert.match(PANE_CHUNK.slice(2), CLIENT_CHUNK)
})

test('the renderer is fetched once by name', async () => {
  const previous = globalThis.__dshChunk
  const asked = []
  globalThis.__dshChunk = async (name) => {
    asked.push(name)
    return { CodeBody: () => null }
  }
  try {
    const first = await loadPane()
    const second = await loadPane()
    assert.equal(first, second, 'a loaded chunk is kept, not fetched per render')
    assert.deepEqual(asked, [PANE_CHUNK], 'one request, under the chunk file name')
  } finally {
    if (previous === undefined) delete globalThis.__dshChunk
    else globalThis.__dshChunk = previous
  }
})

test('installing the flip while the face is Chat registers no body and fetches no chunk', async () => {
  const { exports, sandbox } = await flipModule()
  let asked = 0
  sandbox.__dshChunk = () => { asked += 1; throw new Error('the renderer must not load here') }
  const injected = []
  const ctx = { sessions: {}, slots: { inject: (...args) => { injected.push(args); return () => {} } } }
  const off = exports.installCodeSide(ctx)
  try {
    assert.deepEqual(injected, [], 'no conversation body is registered until Terminal is pressed')
    assert.equal(asked, 0, 'the renderer chunk is never asked for at app start')
  } finally {
    off()
  }
})

test('a seat Terminal draws its own body; only a conversation takes the slot body', async () => {
  const { exports } = await flipModule()
  const injected = []
  const ctx = { sessions: {}, slots: { inject: (...args) => { injected.push(args); return () => {} } } }
  const off = exports.installCodeSide(ctx)
  const BOT = 'b-aaaaaaaaaa'
  try {
    await exports.openTerminal(BOT, { seat: true })
    assert.equal(exports.codeStore.snapshot().face, 'terminal')
    assert.equal(exports.codeStore.snapshot().seat, true)
    assert.equal(exports.codeStore.snapshot().botId, BOT)
    assert.deepEqual(injected, [], 'a seat panel renders the body itself, not the conversation slot')
    assert.equal(exports.useCodeFace(BOT, { seat: true }).face, 'terminal')
    assert.equal(exports.useCodeFace(BOT, { seat: false }).face, 'chat', 'a conversation never wears the seat face')
    await exports.openTerminal(BOT)
    assert.equal(injected.length, 1, 'a conversation Terminal still registers the conversation body')
    exports.closeTerminal()
    assert.equal(exports.codeStore.snapshot().face, 'chat')
    assert.equal(injected.length, 1, 'closing leaves the registration to its own unsubscribe')
  } finally {
    off()
    exports.codeStore.reset()
  }
})

test('the main bundle stays free of xterm and of the pane module', () => {
  const main = readFileSync(new URL('../src/client/code-side.js', import.meta.url), 'utf8')
  assert.doesNotMatch(main, /@xterm/, 'xterm.js is in the chunk, not in client.js')
  assert.doesNotMatch(main, /from '\.\/code-side-pane\.js'/, 'the pane is fetched, never imported by the main bundle')
  const pane = readFileSync(new URL('../src/client/code-side-pane.js', import.meta.url), 'utf8')
  assert.match(pane, /@xterm\/xterm/, 'the chunk is where the renderer and xterm live')
})
