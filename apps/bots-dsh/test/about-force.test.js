import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { AboutPage } from './about.js'; export { useDesktopVersions } from './desktop-update.js'", resolveDir: fileURLToPath(new URL('../src/client/', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
function fixture({ bridge = {}, force, versions = { app: '3.22.0', plugins: [], updates: true } } = {}) {
  const states = [{ phase: 'idle', force }, versions], refs = [], effects = []
  let cursor = 0, refCursor = 0
  const sandbox = { module: { exports: {} }, document: undefined, window: undefined, Date, Math, JSON, Intl, setTimeout, clearTimeout, URL,
    omniDesktop: { updates: bridge },
    require(name) {
      if (name === 'react') return {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState(initial) { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], next => { states[index] = next }] },
        useEffect: (fn, deps) => effects.push({ fn, deps }),
        useRef(initial) { const index = refCursor++; return refs[index] ??= { current: initial } },
        useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore() {},
        Fragment: 'fragment', forwardRef: fn => fn, memo: fn => fn, createContext: () => ({}), useContext() {},
      }
      if (name === 'react-dom') return { createPortal: node => node }
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
      throw Error(name)
    },
  }
  sandbox.exports = sandbox.module.exports
  sandbox.globalThis = sandbox
  runInNewContext(bundle.outputFiles[0].text, sandbox)
  const draw = () => {
    cursor = 0; refCursor = 0; effects.length = 0
    const tree = sandbox.module.exports.AboutPage({ useUpdate: () => ({}),
      actions: { repoStars: async () => null }, run: async () => true, Section: 'section', Row: 'row' })
    const rows = []
    const walk = node => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      if (node.type === 'row') rows.push(node)
      walk(node.children)
    }
    walk(tree)
    return rows
  }
  return { draw, states, effects, sandbox, versions: () => { cursor = 0; effects.length = 0; return sandbox.module.exports.useDesktopVersions(states[1]) } }
}
const row = (h, label = 'Force update') => h.draw().find(node => node.props.label === label)
const buttons = node => node.children.filter(child => child?.type === 'button')
const label = node => node.children.join('')
const tick = () => new Promise(resolve => setImmediate(resolve))

test('Force requires its own bridge method and enabled updates; open is never its fallback', () => {
  assert.equal(row(fixture({ bridge: { open() {} } })), undefined)
  assert.equal(row(fixture({ bridge: { force() {} }, versions: { updates: false } })), undefined)
  const h = fixture({ bridge: { force() {} } })
  const rows = h.draw()
  assert.equal(rows.at(-1).props.label, 'Report a problem')
  assert.equal(row(h).props.hint, 'Stops running conversations and sign-ins, installs every available update and restarts.')
})

test('one inline confirmation, Cancel, then Stop and update invokes force only once', async () => {
  let called = 0
  const h = fixture({ bridge: { force: async () => { called++ }, open: () => assert.fail('open') } })
  buttons(row(h))[0].props.onClick()
  const confirm = row(h)
  assert.equal(confirm.props.hint, 'Running conversations, tasks and Bot sign-ins stop now. Bots that were signing in ask you to sign in again.')
  assert.deepEqual(buttons(confirm).map(label), ['Stop and update', 'Cancel'])
  buttons(confirm)[1].props.onClick()
  assert.equal(label(buttons(row(h))[0]), 'Force update')
  buttons(row(h))[0].props.onClick()
  const stop = buttons(row(h))[0]
  stop.props.onClick(); stop.props.onClick()
  assert.equal(buttons(row(h))[0].props.disabled, true)
  await tick()
  assert.equal(called, 1)
})

test('each force phase disables the action and each final code has its sentence', () => {
  for (const [phase, text] of [
    ['stopping', 'Stopping conversations…'], ['checking', 'Checking for updates…'],
    ['downloading', 'Downloading the Automagik update…'], ['installing', 'Installing…'], ['restarting', 'Restarting…'],
  ]) {
    const node = row(fixture({ bridge: { force() {} }, force: { phase } }))
    assert.equal(node.props.hint, text)
    assert.equal(buttons(node)[0].props.disabled, true)
  }
  for (const [code, text] of [
    ['up-to-date', 'Everything is up to date.'], ['updated', 'Updated.'],
    ['plugins-rolled-back', 'The plugins did not start, so the previous ones are back.'],
    ['app-download-failed', 'The Automagik update could not be downloaded. Try again.'],
    ['app-manual', "This copy updates through your system's package manager."],
    ['restart-failed', 'The restart did not finish. Try again.'],
  ]) {
    const node = row(fixture({ bridge: { force() {} }, force: { phase: code.endsWith('failed') ? 'failed' : 'done', code } }))
    assert.equal(node.props.hint, text)
    assert.equal(buttons(node)[0].props.disabled, false)
  }
})

test('plugin decisions explain the block without guessing whether a new app is published', () => {
  const params = { version: '3.23.1', line: '3.23', base: '3.23.0', app: '3.22.0' }
  for (const [code, latest, text] of [
    ['app-line', true, 'Plugins 3.23.1 need Automagik 3.23; this app is 3.22.0. Update Automagik first.'],
    ['app-line', false, 'Plugins 3.23.1 need Automagik 3.23; this app is 3.22.0. Update Automagik first.'],
    ['app-minimum', false, 'Plugins 3.23.1 need Automagik 3.23.0 or newer; this app is 3.22.0.'],
    ['trial-failed', false, 'Plugins 3.23.1 did not start here before, so the current ones are kept.'],
    ['dsh-range', false, 'Plugins 3.23.1 need a different DeepSeek Harness version.'],
    ['older-sequence', false, 'The published plugin update was not accepted.'],
    ['invalid-lane', false, 'The published plugin update was not accepted.'],
    ['check-failed', false, 'Plugin updates could not be checked. Try again.'],
  ]) assert.equal(row(fixture({ versions: { reason: { code, params }, appUpdate: { latest } } }), 'Plugin updates').props.hint, text)
  assert.equal(row(fixture({ versions: { reason: { code: 'up-to-date' } } }), 'Plugin updates'), undefined)
})

test('plugin versions show newer available versions, including prereleases, without replacing installed ones', () => {
  for (const [current, latest, available] of [['3.22.0', '3.23.0', true], ['3.23.0', '3.22.0', false], ['3.23.0', '3.23.0', false], ['3.23.0-rc.2', '3.23.0-rc.10', true], ['3.23.0-rc.2', '3.23.0', true]]) {
    const versions = { plugins: [{ name: '@automagik/bots-dsh', version: current }], latest: { '@automagik/bots-dsh': latest } }
    assert.equal(row(fixture({ versions }), 'Bot team').props.hint, `Version ${current}${available ? ` · ${latest} available` : ''}`)
  }
})

test('versions refresh on presentation changes and ignore late answers from the previous effect', async () => {
  const requests = []
  const h = fixture({ bridge: { versions: () => new Promise(resolve => requests.push(resolve)) } })
  h.versions()
  const first = h.effects[0]
  const off = first.fn()
  h.states[1] = { phase: 'done' }
  h.versions()
  const next = h.effects[0]
  assert.notEqual(first.deps[1], next.deps[1])
  off()
  next.fn()
  requests[1]({ app: '3.23.0' })
  await tick()
  requests[0]({ app: '3.22.0' })
  await tick()
  assert.equal(h.states[0].app, '3.23.0')
})

test('failed Force outcomes retain the lane explanation, even before versions refresh', () => {
  const params = { version: '3.23.1', line: '3.23', base: '3.23.0', app: '3.22.0' }
  for (const [code, text] of [
    ['check-failed', 'Plugin updates could not be checked. Try again.'],
    ['not-checked', 'Plugin updates could not be checked. Try again.'],
    ['app-line', 'Plugins 3.23.1 need Automagik 3.23; this app is 3.22.0. Update Automagik first.'],
    ['app-minimum', 'Plugins 3.23.1 need Automagik 3.23.0 or newer; this app is 3.22.0.'],
    ['trial-failed', 'Plugins 3.23.1 did not start here before, so the current ones are kept.'],
    ['dsh-range', 'Plugins 3.23.1 need a different DeepSeek Harness version.'],
    ['older-sequence', 'The published plugin update was not accepted.'],
    ['invalid-lane', 'The published plugin update was not accepted.'],
  ]) {
    const force = { phase: 'failed', code, params }
    const h = fixture({ bridge: { force() {} }, force })
    assert.equal(row(h).props.hint, text)
    assert.equal(buttons(row(h))[0].props.disabled, false)
    const withVersions = fixture({ bridge: { force() {} }, force,
      versions: { reason: { code, params }, appUpdate: { latest: true } } })
    assert.equal(row(withVersions).props.hint, row(withVersions, 'Plugin updates').props.hint)
    assert.doesNotMatch(row(withVersions).props.hint, /[Ee]verything.*up to date|no .*build.*published/)
  }
})

test('app-line explanations use actual versions regardless of the bounded app-check result', () => {
  for (const params of [
    { version: '3.23.1', line: '3.23', app: '3.22.0' },
    { version: '4.7.3', line: '4.7', app: '4.6.2' },
  ]) {
    for (const latest of [true, false, undefined]) {
      const h = fixture({ versions: { reason: { code: 'app-line', params }, appUpdate: { latest } } })
      assert.equal(row(h, 'Plugin updates').props.hint,
        `Plugins ${params.version} need Automagik ${params.line}; this app is ${params.app}. Update Automagik first.`)
    }
  }
})

test('an app download failure makes no claim about whether plugins updated', () => {
  for (const code of ['check-failed', 'app-line', 'up-to-date']) {
    const h = fixture({ bridge: { force() {} }, force: { phase: 'done', code: 'app-download-failed' },
      versions: { reason: { code, params: { version: '3.23.1', line: '3.23', app: '3.22.0' } } } })
    assert.equal(row(h).props.hint, 'The Automagik update could not be downloaded. Try again.')
    assert.doesNotMatch(row(h).props.hint, /up to date|plugins were updated/)
  }
})
