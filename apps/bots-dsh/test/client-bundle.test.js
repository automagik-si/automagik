import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as bundler from '../scripts/build-client.mjs'

const committed = () => readFileSync(new URL('../client.js', import.meta.url), 'utf8')

test('client.js is the build of src/client', async () => {
  assert.equal(await bundler.bundleClient(), committed(), 'client.js is stale: run `npm run build` and commit it')
})

test('gated sharing surfaces load from the gated chunk instead of the desktop bundle', async () => {
  const main = committed()
  assert.equal(/function (?:MemberRoot|OwnerPeopleCard)\(/.test(main), false, 'the desktop bundle contains a gated surface')
  const chunk = readFileSync(new URL('../client.gated.js', import.meta.url), 'utf8')
  assert.match(chunk, /function MemberRoot\(/)
  assert.match(chunk, /function OwnerPeopleCard\(/)
  assert.equal(chunk, await bundler.bundleGated())
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
  assert.deepEqual(Object.keys(exports.omni).sort(), [
    'addStrings', 'badges', 'botChannels', 'botChildren', 'botSettings', 'call', 'chatSuggestions',
    'dateLocale', 'face', 'genui', 'headerButtons', 'hostText', 'language', 'nav',
    'officialInstall', 'onShell', 'registerComposerPack', 'roles', 'setCanvasRenderer', 'sidebarTools',
    't', 'toolCards', 'ui',
  ])
  assert.deepEqual(Object.keys(exports.omni.ui).sort(), ['BotMark', 'CHARACTERS', 'MAIN_LOOK', 'OmniMark', 'createSource', 'icons', 'relativeShort'])
  // The shared gen-UI kit (#1326) is a plugin's to draw with: the rows, the person card,
  // the slice reader and the endpoint it reads.
  assert.deepEqual(Object.keys(exports.omni.genui).sort(), ['BackfillCard', 'CANCEL_BACKFILL', 'CoverageRow', 'PersonCard', 'ProgressRow', 'ProgressRows', 'READING_NOTE', 'START_BACKFILL', 'backfillView', 'cancelBackfill', 'loadReadingNote', 'model', 'revisionOf', 'rows', 'startBackfill'])
  assert.equal(exports.omni.genui.READING_NOTE, 'omni-reading-note')
  assert.equal(exports.omni.genui.START_BACKFILL, 'start_backfill')
  assert.equal(exports.omni.genui.CANCEL_BACKFILL, 'cancel_backfill')
  for (const name of ['BackfillCard', 'CoverageRow', 'PersonCard', 'ProgressRow', 'ProgressRows', 'backfillView', 'cancelBackfill', 'loadReadingNote', 'revisionOf', 'rows', 'startBackfill']) {
    assert.equal(typeof exports.omni.genui[name], 'function', name)
  }
  assert.deepEqual(Object.keys(exports.omni.genui.model).sort(), ['backfillDay', 'backfillRange', 'backfillSummaryText', 'backfillView', 'canCancel', 'countText', 'coverageLine', 'coverageOf', 'parseReadingNote', 'percentOf', 'personView', 'proposalView', 'rowView', 'runView', 'shortDate', 'spanOf', 'stateId', 'stateWord'])
  assert.ok(Object.isFrozen(exports.omni))
  assert.equal(exports.omni.face(), null)
  const { roles, toolCards } = exports.omni
  assert.deepEqual(Object.keys(roles).sort(), ['all', 'hasRole', 'of', 'register'])
  const pin = { id: 'guide', version: '1.0.0', attachedAt: 'fixture', source: 'registry' }
  const bot = { id: 'bot', roles: [{ ...pin, grants: [] }] }
  const roster = { byId: { bot, part: bot }, prefs: { roles: false }, roleRuntimeByRole: { bot: { guide: { pin } } } }
  const fixture = { id: 'guide', name: 'Guide', toolCards: ['guide_tool'] }
  const off = roles.register(fixture)
  assert.throws(() => roles.register(fixture), /duplicate/)
  fixture.toolCards.push('changed')
  assert.deepEqual(Array.from(roles.of('guide').toolCards), ['guide_tool'])
  assert.equal(roles.all()[0], roles.of('guide'))
  assert.equal(roles.hasRole(roster, 'part', 'guide'), true)
  assert.equal(roles.hasRole(roster, 'other', 'guide'), false)
  const offCard = toolCards.register('guide_tool', () => 'Guide card', { asks: true })
  const paint = (sessionId, roster) => toolCards.renderer('guide_tool')({ tool: 'guide_tool', sessionId, roster })
  assert.equal(paint('part', roster), 'Guide card')
  assert.equal(paint('other', roster), null)
  const disposed = { ...roster, roleRuntimeByRole: { bot: { guide: { pin, status: 'missing' } } } }
  assert.equal(roles.hasRole(disposed, 'bot', 'guide'), false)
  assert.equal(paint('bot', disposed), null)
  const beforeDispose = toolCards.source.getSnapshot()
  off()
  assert.notEqual(toolCards.source.getSnapshot(), beforeDispose)
  assert.equal(roles.of('guide'), undefined)
  assert.equal(paint('other', roster), 'Guide card', 'the separately registered renderer still serves the existing outlet')
  const removeReplacement = roles.register(fixture)
  off()
  assert.equal(roles.all().length, 1, 'an earlier disposer cannot remove a replacement')
  removeReplacement()
  offCard()
  assert.equal(toolCards.renderer('guide_tool'), undefined)
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

test('the browser bundles contain no node specifiers', () => {
  for (const name of ['client.js', 'client.gated.js', 'client.pane.js']) {
    const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /["'\x60]node:[a-z]/, name)
  }
})

test('client.js carries each Solver look refusal once', () => {
  const source = committed()
  for (const message of [
    'Only a Solver wears the Solver characters. Choose another character.',
    'A Solver wears one of the Solver characters. Choose one of those characters.',
    'Only the person can make a Bot a Solver.',
    'That look is not valid. Choose another character.',
  ]) assert.equal(source.split(message).length - 1, 1, message)
})
