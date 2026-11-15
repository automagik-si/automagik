import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Automagik logo in the app is the approved set's own files (final-triskle-seam): the
// three-colour triskle, the lowercase wordmark and the lockup, with Automagik's violet sparkle.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const BRAND = join(PLUGIN, 'src', 'client', 'art', 'brand')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// Each file's sha256 in the final set. A new set replaces the file and this line together.
const APPROVED = {
  'triskle-three-colours.svg': 'bc9fd54124f5d3cfdd0461c5ab6ac6860254c14bfdedf46a11cc5ca433e01a72',
  'triskle-three-colours-64.svg': '160520a72892587e1463d375bfbb7965469139e63c6ead7809db917788920c43',
  'triskle-three-colours-32.svg': '3ce36573385e5c18116e894b77b2aea39594a2763cfd911c553265d7b09abbf9',
  'triskle-three-colours-16.svg': 'db2ac0e038c88e6179656fdda343fa8befdfafb807b9968d5984efc70b251683',
  'automagik-lockup-three-colours-ink-header.svg': '4d0f87696e31e5f889e2e60d98c7814d515a85f2f60918f4bd999f298338af2f',
  'automagik-lockup-three-colours-cream-header.svg': 'e8dd0d21e42d7b2722386738972d46432f083895fb2bf00a990ee7588d3561f7',
  'automagik-wordmark-ink.svg': '862047b28e1086337552118196572b8dff69eee255a64b8e12e987c59e1bfa7e',
  'automagik-wordmark-cream.svg': 'a61a32f40807e6a72536de7dc44a88aaa524079499171206388cab04b81a2ea1',
}
const file = name => readFileSync(join(BRAND, name))
const dataUrl = name => `data:image/svg+xml;base64,${file(name).toString('base64')}`

const bundle = await build({
  stdin: { contents: "export * from './src/client/logo.js'\nexport { markArt, WORDMARK_ART, LOCKUP_ART, WORDMARK_RATIO, LOCKUP_RATIO } from './src/client/clay-art.js'\nexport { STAGE_CSS } from './src/client/stage.js'\nexport { SIDEBAR_CSS, BrandMark, BrandName } from './src/client/sidebar.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/*'],
})

// The page as the logo reads it: body's dark attribute, the observers watching it, the head's
// icon links. React's useSyncExternalStore answers the snapshot and keeps what it was given.
function page({ dark = false, links = [] } = {}) {
  const attributes = new Set(dark ? ['data-ds-dark-theme'] : [])
  const observers = []
  const stores = []
  const body = { hasAttribute: name => attributes.has(name) }
  class MutationObserver {
    constructor(changed) { this.changed = changed; observers.push(this) }
    observe(target, options) { this.target = target; this.options = options }
    disconnect() { this.disconnected = true }
  }
  const link = (start = {}) => {
    const held = new Map(Object.entries(start))
    return { held, getAttribute: name => held.get(name) ?? null, setAttribute: (name, value) => held.set(name, value), removeAttribute: name => held.delete(name), remove() { this.removed = true } }
  }
  const head = { appended: [], append(node) { this.appended.push(node) } }
  const icons = links.map(link)
  const document = {
    body, head,
    querySelectorAll: (selector) => { assert.equal(selector, 'link[rel~="icon"]'); return icons },
    createElement: (tag) => { assert.equal(tag, 'link'); return link() },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useSyncExternalStore: (subscribe, snapshot, server) => { stores.push({ subscribe, snapshot, server }); return snapshot() },
    useState: initial => [initial, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }), useMemo: make => make(), useCallback: fn => fn, Fragment: 'fragment',
    // The bundled Deep View widgets make a React context when their module loads.
    createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
  }
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, document, MutationObserver, URLSearchParams, require: name => (name === 'react' ? react : {}) })
  const setDark = (on) => {
    if (on) attributes.add('data-ds-dark-theme'); else attributes.delete('data-ds-dark-theme')
    for (const each of observers) if (!each.disconnected) each.changed()
  }
  const draw = (element) => {
    while (typeof element?.type === 'function') element = element.type(element.props)
    return element
  }
  return { ...module.exports, body, head, icons, observers, stores, setDark, draw }
}

test('every logo file is the approved set\'s, byte for byte', () => {
  assert.deepEqual(readdirSync(BRAND).filter(name => name !== 'SOURCE.json').sort(), Object.keys(APPROVED).sort(), 'art/brand holds the approved files and nothing else')
  for (const [name, hash] of Object.entries(APPROVED)) assert.equal(sha256(file(name)), hash, `${name} is not the final set's file`)
  // The record beside them says the same, and where in the set each came from.
  const source = JSON.parse(readFileSync(join(BRAND, 'SOURCE.json'), 'utf8'))
  assert.equal(source.set, 'final-triskle-seam')
  assert.deepEqual(Object.keys(source.files).sort(), Object.keys(APPROVED).sort())
  for (const [name, entry] of Object.entries(source.files)) {
    assert.equal(entry.sha256, APPROVED[name], `SOURCE.json: ${name}`)
    assert.equal(entry.bytes, file(name).length, `SOURCE.json: ${name}`)
    assert.match(entry.from, name.startsWith('triskle-') ? /^svg\/triskle-three-colours(-\d+)?\.svg$/ : /^lockups\/svg\/automagik-/)
    assert.ok(entry.from.endsWith(`/${name}`), `${name} keeps its name in the set`)
  }
})

test('the logo is Automagik\'s: three colours, and the violet sparkle', () => {
  // Genie's and Omni's sparkle colours are not decided, so none of their files is here.
  for (const name of Object.keys(APPROVED)) assert.match(name, /^(triskle-three-colours|automagik-)/)
  for (const letters of ['ink', 'cream']) {
    const wordmark = file(`automagik-wordmark-${letters}.svg`).toString('utf8')
    assert.match(wordmark, /fill="#b586e7"/, `${letters}: the sparkle is violet`)
    assert.match(wordmark, /viewBox="-22 -186 1333 264"/)
    assert.match(file(`automagik-lockup-three-colours-${letters}-header.svg`).toString('utf8'), /viewBox="0 -186 1632\.34 264"/)
  }
  assert.notEqual(sha256(file('automagik-wordmark-ink.svg')), sha256(file('automagik-wordmark-cream.svg')))
})

test('a mark takes the drawing made for the size it is shown at', () => {
  const { markArt, OmniMark, draw } = page()
  const drawings = { 16: 'triskle-three-colours-16.svg', 32: 'triskle-three-colours-32.svg', 64: 'triskle-three-colours-64.svg', large: 'triskle-three-colours.svg' }
  const expected = [[1, 16], [12, 16], [16, 16], [20, 16], [22, 16], [23, 16], [24, 32], [29, 32], [32, 32], [47, 32], [48, 64], [64, 64], [99, 64], [100, 'large'], [126, 'large'], [512, 'large']]
  for (const [size, drawing] of expected) assert.equal(markArt(size), dataUrl(drawings[drawing]), `a ${size}px mark takes the ${drawing} drawing`)
  // The four drawings are four files: none stands in for another.
  assert.equal(new Set(Object.values(drawings).map(dataUrl)).size, 4)
  const mark = draw({ type: OmniMark, props: { size: 22 } })
  assert.equal(mark.type, 'img')
  assert.equal(mark.props.src, dataUrl(drawings[16]))
  assert.deepEqual([mark.props.width, mark.props.height], [22, 22], 'the mark is square')
  assert.equal(mark.props.className, 'omni-logo omni-mark')
  assert.equal(draw({ type: OmniMark, props: {} }).props.src, dataUrl(drawings[16]), 'the default mark is 16px')
})

test('the letters are ink on a light ground and cream on a dark one', () => {
  for (const [dark, letters] of [[false, 'ink'], [true, 'cream']]) {
    const { Lockup, Wordmark, draw } = page({ dark })
    const lockup = draw({ type: Lockup, props: { height: 21 } })
    assert.equal(lockup.props.src, dataUrl(`automagik-lockup-three-colours-${letters}-header.svg`), `${letters} lockup`)
    assert.deepEqual([lockup.props.width, lockup.props.height], [130, 21], 'the lockup keeps its frame, 1632.34 by 264')
    assert.equal(lockup.props.alt, 'Automagik')
    const wordmark = draw({ type: Wordmark, props: { height: 25 } })
    assert.equal(wordmark.props.src, dataUrl(`automagik-wordmark-${letters}.svg`), `${letters} wordmark`)
    assert.deepEqual([wordmark.props.width, wordmark.props.height], [126, 25], 'the wordmark keeps its frame, 1333 by 264')
    assert.equal(wordmark.props.alt, 'Automagik')
  }
})

test('the letters follow the Appearance setting while the page is open', () => {
  const view = page({ dark: false })
  view.draw({ type: view.Lockup, props: {} })
  const [store] = view.stores
  assert.equal(store.snapshot(), false)
  assert.equal(store.server(), false, 'with no page the letters are ink')
  let changes = 0
  const stop = store.subscribe(() => { changes += 1 })
  const [watch] = view.observers
  assert.equal(watch.target, view.body)
  // (The options come from the bundle's own realm: compared as written.)
  assert.equal(JSON.stringify(watch.options), JSON.stringify({ attributes: true, attributeFilter: ['data-ds-dark-theme'] }))
  view.setDark(true)
  assert.equal(changes, 1, 'a theme change is told')
  assert.equal(store.snapshot(), true)
  assert.equal(view.draw({ type: view.Lockup, props: {} }).props.src, dataUrl('automagik-lockup-three-colours-cream-header.svg'))
  assert.equal(view.draw({ type: view.Wordmark, props: {} }).props.src, dataUrl('automagik-wordmark-cream.svg'))
  view.setDark(false)
  assert.equal(changes, 2)
  assert.equal(view.draw({ type: view.Lockup, props: {} }).props.src, dataUrl('automagik-lockup-three-colours-ink-header.svg'))
  stop()
  assert.equal(watch.disconnected, true, 'the watch ends with the component')
  view.setDark(true)
  assert.equal(changes, 2)
})

test('the sidebar draws the lockup to fit its top row, and the brand slots in the lockup\'s proportions', () => {
  const { BrandMark, BrandName, SIDEBAR_CSS, STAGE_CSS, draw } = page()
  const mark = draw({ type: BrandMark, props: {} })
  assert.equal(mark.props.className, 'bt-brand-mark')
  const drawnMark = draw(mark.children[0])
  assert.equal(drawnMark.props.width, 24)
  assert.equal(drawnMark.props.src, dataUrl('triskle-three-colours-32.svg'))
  const name = draw({ type: BrandName, props: {} })
  // Beside a 24px mark the wordmark is 25px tall: the mark's square is 257.7 of the lockup's 264.
  assert.equal(draw(name.children[0]).props.height, 25)
  // The top row holds up to five buttons beside the lockup (test/power-shortcut-browser.test.js
  // measures it). At 21px the lockup is 130px wide: with its padding (6 + 4) it takes 140px,
  // no more than the picture it replaces did (141px), so the row fits wherever it did.
  const source = readFileSync(join(PLUGIN, 'src', 'client', 'sidebar.js'), 'utf8')
  assert.match(source, /h\('span', \{ className: 'bt-brand' \}, h\(Lockup, \{ height: 21 \}\)\)/)
  assert.match(SIDEBAR_CSS, /\.bt-side-top \.bt-brand\{cursor:default;padding-left:6px;padding-right:4px\}/)
  // The approved drawing is shown as it is: no shadow of the app's own under it.
  assert.doesNotMatch(STAGE_CSS, /omni-lockup/)
})

test('the browser tab wears the mark drawn for a tab, and DSH\'s icon comes back', () => {
  const view = page({ links: [{ rel: 'icon', href: '/dsh-light.png', type: 'image/png' }, { rel: 'icon', href: '/dsh-dark.png' }] })
  assert.equal(view.FAVICON.href, dataUrl('triskle-three-colours-32.svg'), 'the set\'s favicon.svg is its 32px drawing')
  assert.equal(view.FAVICON.type, 'image/svg+xml')
  const restore = view.installFavicon()
  for (const link of view.icons) {
    assert.equal(link.getAttribute('href'), view.FAVICON.href)
    assert.equal(link.getAttribute('type'), 'image/svg+xml')
  }
  restore()
  assert.deepEqual(view.icons.map(link => [link.getAttribute('href'), link.getAttribute('type')]), [['/dsh-light.png', 'image/png'], ['/dsh-dark.png', null]])
  // A page with no icon gets one, and loses it again.
  const bare = page()
  const remove = bare.installFavicon()
  assert.equal(bare.head.appended.length, 1)
  assert.equal(bare.head.appended[0].rel, 'icon')
  assert.equal(bare.head.appended[0].href, bare.FAVICON.href)
  assert.equal(bare.head.appended[0].type, 'image/svg+xml')
  remove()
  assert.equal(bare.head.appended[0].removed, true)
})
