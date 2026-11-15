import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { bundleClient } from '../scripts/build-client.mjs'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('client.js is the build of src/client', async () => {
  assert.equal(await bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
})

// dsh runs client.js as a classic script that hands a factory to the module loader; the
// factory's `require` answers only the shell's platform modules.
test('client.js registers a factory that exports apply and inject', () => {
  const registrations = []
  runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registrations.push(registration) } } })
  assert.equal(registrations.length, 2)
  const [{ id, factory, ...rest }, former] = registrations
  assert.equal(id, '@automagik/bots-dsh')
  assert.deepEqual(Object.keys(rest), [])
  // Plugins built before the rename import @automagik/omni-dsh/client: that name hands over
  // this bundle's own module, through DSH's require.
  assert.equal(former.id, '@automagik/omni-dsh')
  const handed = {}
  assert.equal(former.factory(spec => (spec === '@automagik/bots-dsh/client' ? handed : assert.fail(spec))), handed)

  const requested = []
  const platform = {
    'react': { Component: class {}, createElement: () => null, Fragment: Symbol('Fragment'), useState: initial => [initial, () => {}], useEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useRef: current => ({ current }), useId: () => 'id', useSyncExternalStore: (sub, get) => get(), createContext: initial => ({ value: initial, _currentValue: initial, Provider: () => null }), useContext: ctx => ctx.value },
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
  }
  const exports = factory((specifier) => {
    requested.push(specifier)
    if (!(specifier in platform)) throw new Error(`no platform module ${specifier}`)
    return platform[specifier]
  })
  assert.deepEqual([...new Set(requested)].sort(), Object.keys(platform).sort())
  assert.equal(Object.prototype.toString.call(exports), '[object Module]')
  // `omni` is what the Omni channels and canvas plugins build on (their bundles require
  // this one through dsh.client.external).
  assert.deepEqual(Object.keys(exports), ['apply', 'inject', 'omni'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(Object.keys(exports.omni).sort(), ['addStrings', 'badges', 'botChildren', 'botSettings', 'call', 'chatSuggestions', 'dateLocale', 'face', 'headerButtons', 'hostText', 'language', 'nav', 'onShell', 'registerComposerPack', 'setCanvasRenderer', 'sidebarTools', 't', 'toolCards', 'ui'])
  assert.deepEqual(Object.keys(exports.omni.ui).sort(), ['BotMark', 'CHARACTERS', 'MAIN_LOOK', 'OmniMark', 'createSource', 'icons', 'relativeShort'])
  assert.ok(Object.isFrozen(exports.omni))
  assert.equal(exports.omni.face(), null)
  // No `configForms`: the client never writes the user's DSH settings, such as the
  // work-details mode it once held at `verbose`.
  assert.deepEqual(Array.from(exports.inject), ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout'])
})

// Registered while DSH is live, a second registration under the former name is refused by
// DSH (the bundle run again); that refusal must not stop the bundle.
test('client.js survives a refused registration of its former name', () => {
  const ids = []
  const load = (registration) => {
    if (ids.includes(registration.id)) throw new Error(`duplicate factory registration for "${registration.id}"`)
    ids.push(registration.id)
  }
  runInNewContext(committed(), { window: { __ModuleLoader__: { load } } })
  assert.doesNotThrow(() => runInNewContext(committed(), { window: { __ModuleLoader__: { load: registration => registration.id === '@automagik/omni-dsh' ? load(registration) : undefined } } }))
  assert.deepEqual(ids, ['@automagik/bots-dsh', '@automagik/omni-dsh'])
})
