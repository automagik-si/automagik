import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { botState, BotAvatar, BotMark } from './src/client/mark.js'\nexport { SHELL_CSS } from './src/client/styles.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
// A test can queue the values the next useState calls return, and read what was set.
const states = []
const sets = []
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useMemo: make => make(),
  useCallback: fn => fn,
  useId: () => 'dv-id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [states.length > 0 ? states.shift() : initial, value => sets.push(value)], useEffect: () => {}, useRef: current => ({ current }), useLayoutEffect: () => {}, Fragment: 'fragment',
}
runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, URLSearchParams, require: name => (name === 'react' ? react : {}) })
const { botState, BotAvatar, BotMark: markOf, SHELL_CSS } = module.exports
// A mark hands over to the mark that draws it (a pet, or the character itself): render through.
const BotMark = (props) => {
  let element = markOf(props)
  while (typeof element?.type === 'function') element = element.type(element.props)
  return element
}

test('a Bot that waits for work it handed on has a mark of its own, behind an approval', () => {
  assert.equal(botState(false, 'waiting', false), 'waiting')
  // A turn of its own runs, and no approval waits: the turn shows, not the wait.
  assert.equal(botState(true, 'waiting', false), 'working')
  assert.equal(botState(true, 'searching', false), 'searching')
  // An approval waits: the Bot is blocked on the user, so it shows the alert even while a
  // turn of it is still marked running.
  assert.equal(botState(true, undefined, true), 'alert')
  assert.equal(botState(true, 'searching', true), 'alert')
  assert.equal(botState(false, 'waiting', true), 'alert')
  assert.equal(botState(false, undefined, false), 'idle')
  // It moves like a Bot coordinating its teammates.
  assert.match(SHELL_CSS, /\.bt-mark:is\(\[data-state=orbit\],\[data-state=waiting\]\) \.bt-b\{animation:bt-sway/)
})

test('a waiting Bot does not wear the working badge, since no turn of it runs', () => {
  const badges = state => BotAvatar({ bot: { id: 'b', name: 'Writer' }, size: 36, state }).children.slice(1).filter(Boolean).map(child => child.props.className)
  assert.deepEqual(badges('waiting'), [])
  assert.deepEqual(badges('working'), ['bt-badge bt-badge-working'])
  // An approval is the one thing the user must act on: it takes the alert badge.
  assert.deepEqual(badges('alert'), ['bt-badge bt-badge-alert'])
})

test('a photo that does not load shows the Bot\'s character instead', () => {
  const photo = 'data:image/png;base64,iVBORw0KGgo='
  const bot = { id: 'b', name: 'Writer', avatar: { shape: 'fox', image: photo } }
  const img = BotMark({ bot }).children[0]
  assert.equal(img.type, 'img')
  sets.length = 0
  img.props.onError()
  assert.deepEqual(sets, [photo])
  // Rendered again with that photo marked broken: the character, not an empty image.
  states.push(null, false, photo)
  const mark = BotMark({ bot })
  assert.equal(mark.children[0].type, 'svg')
  assert.notEqual(mark.props['data-shape'], 'image')
  // A new photo is tried again.
  states.push(false, photo)
  assert.equal(BotMark({ bot: { ...bot, avatar: { ...bot.avatar, image: `${photo}AA` } } }).children[0].type, 'img')
})

// Clay characters (clay-art.js): Omni's own look and a Genie Bot draw as their clay art, and
// their face follows the state the mark already shows.
test('Omni\'s own look draws as clay Omni; a recoloured octopus and a photo stay what was chosen', () => {
  const omni = BotMark({ bot: { id: 'o', name: 'Omni', kind: 'omni', color: 'deepseek', avatar: { shape: 'octopus' } }, state: 'working' })
  assert.equal(omni.props['data-shape'], 'clay-omni')
  assert.equal(omni.props['data-face'], 'focused')
  const [art] = omni.children
  assert.match(art.props.className, /\bbt-b\b/, 'the state motions move the clay art whole')
  assert.equal(art.props.style['--bt-face-at'], 3)
  // The plugin's own mark (MAIN_LOOK) is Omni too.
  assert.equal(BotMark({ look: { shape: 'octopus', color: 'deepseek' } }).props['data-shape'], 'clay-omni')
  assert.equal(BotMark({ bot: { id: 'r', name: 'Red', color: 'red', avatar: { shape: 'octopus' } } }).props['data-shape'], 'octopus')
  const photo = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(BotMark({ bot: { id: 'p', name: 'Omni', kind: 'omni', color: 'deepseek', avatar: { shape: 'octopus', image: photo } } }).props['data-shape'], 'image')
  assert.match(SHELL_CSS, /\.bt-clay-omni\{[^}]*url\("data:image\/webp;base64,/)
})

test('a Genie Bot wears its pet, and its clay face where a mark is too small for one', () => {
  const face = (state, extra = {}) => BotMark({ bot: { id: 'g', name: 'Genie', kind: 'genie', ...extra }, state, size: 24 })
  const faces = Object.fromEntries(['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done'].map(state => [state, face(state).props['data-face']]))
  assert.deepEqual(faces, { idle: 'calm', thinking: 'focused', searching: 'focused', working: 'focused', sending: 'focused', orbit: 'focused', waiting: 'calm', alert: 'curious', done: 'delighted' })
  const mark = face('alert')
  assert.equal(mark.props['data-shape'], 'clay-genie')
  // One cell of the row per face, in its order: calm, pleased, delighted, focused, curious, asleep, sad.
  assert.equal(mark.children[0].props.style['--bt-face-at'], 4)
  // A poke is a greeting (the first state is the baked pet's, none here).
  states.push(null, true)
  assert.equal(face('idle').props['data-face'], 'pleased')
  // Small marks frame its head; a photo still wins.
  assert.equal(face('idle').props['data-frame'], 'head')
  assert.equal(face('idle', { avatar: { image: 'data:image/png;base64,iVBORw0KGgo=' } }).props['data-shape'], 'image')
  // Larger, it is the pet Genie ships with, in the Codex format, playing its state's row.
  const pet = BotMark({ bot: { id: 'g', name: 'Genie', kind: 'genie' }, state: 'alert', size: 36 })
  assert.equal(pet.props['data-shape'], 'pet')
  assert.equal(pet.props['data-state'], 'alert')
  assert.equal(pet.children[0].props.state, 'alert')
  // Its address carries the pet's version: the v1 sheet a browser still holds is not this one.
  assert.equal(pet.children[0].props.pet.sheet, 'api/omni-ui/pet?source=builtin&id=genie-clay&v=2')
  assert.equal(pet.children[0].props.pet.sleep, 'api/omni-ui/pet?source=builtin&id=genie-clay&part=sleep&v=2')
  // Genie is a v2 atlas (eleven rows); a look kept from the v1 atlas before it draws as v2 too.
  assert.equal(pet.children[0].props.pet.version, 2)
  const kept = BotMark({ bot: { id: 'k', name: 'Kept', avatar: { pet: { source: 'builtin', id: 'genie-clay', version: 1 } } }, size: 36 })
  assert.equal(kept.children[0].props.pet.version, 2)
  assert.equal(kept.children[0].props.pet.sheet, 'api/omni-ui/pet?source=builtin&id=genie-clay&v=2')
  assert.equal(kept.children[0].props.pet.sleep, 'api/omni-ui/pet?source=builtin&id=genie-clay&part=sleep&v=2')
  const team = BotMark({ bot: { id: 't', name: 'Team', avatar: { pet: { source: 'team', id: 'genie-clay', version: 1 } } }, size: 36 })
  assert.equal(team.children[0].props.pet.version, 1)
  assert.match(SHELL_CSS, /\.bt-clay-genie\{[^}]*url\("data:image\/webp;base64,/)
})

test('a Bot whose last turn failed looks sad, and one whose reply waits to be read looks it over', () => {
  assert.equal(botState(false, undefined, false, { failed: true }), 'failed')
  assert.equal(botState(false, undefined, false, { unread: true }), 'review')
  // An approval outranks everything, also the turn that waits on it: nothing can go on
  // until the user answers.
  assert.equal(botState(false, undefined, true, { failed: true, unread: true }), 'alert')
  assert.equal(botState(true, 'searching', true, { failed: true, unread: true }), 'alert')
  // Without one, a turn running again outranks a failed turn.
  assert.equal(botState(true, 'searching', false, { failed: true }), 'searching')
  const badges = state => BotAvatar({ bot: { id: 'b', name: 'Writer' }, size: 36, state }).children.slice(1).filter(Boolean).map(child => child.props.className)
  assert.deepEqual(badges('failed'), [])
  assert.deepEqual(badges('review'), [])
})
