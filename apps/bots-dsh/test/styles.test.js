import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom and the real client module system come from the harness, as the dsh packages do.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')

// The style helpers and the CSS they ship, bundled once with a minimal React for
// motion.js; they run in each test's jsdom document through the vm context.
const { outputFiles } = await build({
  stdin: {
    contents: "export { installStyles, installCompiledStyles } from './src/client/styles.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}

const tick = () => new Promise(resolve => setImmediate(resolve))
// Omni's style tags in a document, all of them or those of one group.
const tagged = (document, tag) => [...document.head.querySelectorAll('style')]
  .filter(style => style.dataset.dshBot !== undefined && (tag === undefined || style.dataset.dshBot === tag))

// The client-modules bundle registers itself through the page's __ModuleLoader__
// facade when it loads; capture that registration once to reach its exports.
const clientModules = await (async () => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  let registration
  const previousWindow = globalThis.window
  globalThis.window = window
  window.__ModuleLoader__ = { load: (record) => { registration = record } }
  try {
    await import('@deepseek-ai/dsh-client-modules/client')
  } finally {
    globalThis.window = previousWindow
  }
  return registration.factory((spec) => { throw new Error(`no seed module ${spec}`) })
})()
const { createClientModuleSystem, parseBootManifest } = clientModules

// A fresh jsdom document, the bundled style helpers bound to it, and a real
// ClientModuleSystem that materializes the pretend modules named in `rows`.
const bench = (rows) => {
  const { window } = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    document: window.document,
    MutationObserver: window.MutationObserver,
    HTMLLinkElement: window.HTMLLinkElement,
    setTimeout, clearTimeout,
    require: name => (name === 'react' ? react : {}),
  })
  // The client module system reads the page's globals when it claims and removes.
  const previousGlobals = { window: globalThis.window, document: globalThis.document }
  const inside = (fn) => {
    globalThis.window = window
    globalThis.document = window.document
    try { return fn() } finally { globalThis.window = previousGlobals.window; globalThis.document = previousGlobals.document }
  }
  const boot = (rev) => ({
    rev,
    entries: rows.map(id => ({ id, url: `/modules/${id}.js?rev=${rev}`, rev })),
    batches: rows.length ? [{ phase: 'application', url: `/boot.js?rev=${rev}`, rev, entries: [...rows] }] : [],
  })
  // A bench with no modules never builds the system; the helpers stay undefined.
  const system = rows.length === 0 ? undefined : inside(() => {
    window.__ModuleLoader__ = { mode: 'queue', pendingQueue: [], load() {} }
    return createClientModuleSystem(window.__ModuleLoader__, { id: 'shell', exports: {} }, {
      boot: boot('r1'),
      staticModules: {},
    })
  })
  const materialize = id => inside(() => system.materialize(id))
  const update = (rev, managed = new Map()) => inside(() => system.updateManifest(parseBootManifest(boot(rev)), managed))
  const register = (id, factory) => inside(() => window.__ModuleLoader__.load({ id, factory }))
  return { window, module, materialize, register, update }
}

// #228: our style tags carry the client module id, so another module's materialization
// cannot claim them and its teardown cannot delete them.
test('every Omni style is owned by the ds-bot client module', async () => {
  const { window, module, register, materialize, update } = bench(['other'])
  const { installStyles, installCompiledStyles } = module.exports
  const { document } = window
  register('other', () => ({}))

  const plain = installStyles('a{color:red}', 'mentions')
  installCompiledStyles('.b{position:fixed}', 'shell')
  const [compiled] = tagged(document, 'shell')
  const stray = document.createElement('style')
  stray.textContent = 'stray{}'
  document.head.appendChild(stray)
  for (const style of [plain, compiled]) {
    assert.equal(style.dataset.dshBot !== undefined, true)
    assert.equal(style.dataset.plugin, 'ds-bot')
    assert.equal(style.matches('style:not([data-plugin])'), false)
  }

  // Another module materializing claims untagged styles (DSH 0.2.0-rc.2 does; other
  // versions may not); ours keep their owner either way.
  materialize('other')
  const claimed = stray.dataset.plugin === 'other'
  assert.equal(plain.dataset.plugin, 'ds-bot')
  assert.equal(compiled.dataset.plugin, 'ds-bot')

  // A newer revision of that module replaces it: what it claimed goes, ours stay.
  update('r2')
  await tick()
  if (claimed) assert.equal(stray.isConnected, false)
  assert.equal(plain.isConnected, true)
  assert.equal(compiled.isConnected, true)
})

test('a compiled style removed from outside comes back, until its cleanup runs', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
  const [style] = tagged(document, 'shell')
  assert.ok(style.isConnected)

  style.remove()
  await tick()
  assert.equal(style.isConnected, true, 'the observer puts a removed node back')

  dispose()
  await tick()
  assert.equal(style.isConnected, false)
  // Later page changes cannot resurrect it.
  const late = document.createElement('style')
  document.head.appendChild(late)
  await tick()
  assert.equal(style.isConnected, false)
})

test('mounting and unmounting compiled styles twice leaves no extra nodes', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  for (let round = 0; round < 2; round += 1) {
    const dispose = installCompiledStyles('.b{position:fixed}', 'shell')
    await tick()
    dispose()
  }
  await tick()
  assert.equal(tagged(document).length, 0)
})

test('the chat-room rule is installed through installStyles, so it is owned too', () => {
  const pane = readFileSync(new URL('../src/client/frame-watch.js', import.meta.url), 'utf8')
  assert.match(pane, /installStyles\(.*'chat-room'/)
  assert.equal(pane.includes("dataset.dshBot = 'chat-room'"), false)
})

// A shell stylesheet as the page has them: hashed CSS-module classes, one inside @media.
const shellSheet = (document, css) => {
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  return style.sheet
}
// Counts how often a sheet's rules are read, which is what a class-name scan does first.
const countReads = (sheet) => {
  const rules = sheet.cssRules
  const reads = { count: 0 }
  Object.defineProperty(sheet, 'cssRules', { get: () => { reads.count += 1; return rules } })
  return reads
}
const compiledText = (document, tag) => tagged(document, tag)[0].textContent

test('compiled styles name the shell classes their fragments match, and unmatched ones keep the fragment', () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  shellSheet(document, '._bubble_12mhf_1{color:red} .hem6sG_footArea{margin:0} @media (min-width:1px){._bubble_12mhf_2 .x{color:blue}}')
  installCompiledStyles('[class*="_bubble"]{padding:1px} [class*="_footArea"] b{gap:0} [class*="_absent"]{top:0}', 'shell')
  installCompiledStyles('[class*="_footArea"]{left:0}', 'sidebar')
  assert.equal(compiledText(document, 'shell'),
    ':is(._bubble_12mhf_1,._bubble_12mhf_2){padding:1px} :is(.hem6sG_footArea) b{gap:0} [class*="_absent"]{top:0}')
  assert.equal(compiledText(document, 'sidebar'), ':is(.hem6sG_footArea){left:0}')
})

test('every compiled style shares one scan of each shell sheet, and a later sheet is read once too', async () => {
  const { window, module } = bench([])
  const { installCompiledStyles } = module.exports
  const { document } = window
  const first = countReads(shellSheet(document, '._bubble_12mhf_1{color:red}'))
  const disposers = ['shell', 'sidebar', 'models', 'usage'].map(tag => installCompiledStyles('[class*="_bubble"]{padding:1px} [class*="_late"]{top:0}', tag))
  assert.equal(first.count, 1, 'four installers, one walk of the sheet')
  for (const tag of ['shell', 'sidebar', 'models', 'usage']) assert.equal(compiledText(document, tag), ':is(._bubble_12mhf_1){padding:1px} [class*="_late"]{top:0}')

  // A lazily loaded shell feature adds its sheet: every installer recompiles with it, past the
  // 120 ms debounce, and that sheet too is walked once, the first one not again.
  const late = shellSheet(document, '._late_9zz_3{top:1px}')
  const lateReads = countReads(late)
  await new Promise(resolve => setTimeout(resolve, 200))
  for (const tag of ['shell', 'sidebar', 'models', 'usage']) assert.equal(compiledText(document, tag), ':is(._bubble_12mhf_1){padding:1px} :is(._late_9zz_3){top:0}')
  assert.equal(lateReads.count, 1)
  assert.equal(first.count, 1)
  for (const dispose of disposers) dispose()
})

test('message tools anchor to the bottom of a long reply in both layouts', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /\.bt-tools\{position:absolute;bottom:0;/)
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-tools\{bottom:-14px;/)
  assert.doesNotMatch(css, /\.bt-tools\{position:absolute;top:50%;/)
})

test('the tools toolbar keeps its own stacking context for the hover bridge', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  // Without a stacking context on .bt-tools, the ::after bridge's z-index:-1
  // sinks behind the full-width .bt-astack and the toolbar flickers when the
  // pointer crosses the gap.
  assert.match(css, /\.bt-tools\{position:absolute;bottom:0;z-index:0;/)
  assert.match(css, /\.bt-tools::after\{[^}]*z-index:-1/)
})

test('the flat toolbar does not cover reactions below the message', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(css, /body\[data-bt-layout=flat\] \.bt-msg:has\(>\.bt-reacts\) \.bt-tools\{bottom:0\}/)
})
