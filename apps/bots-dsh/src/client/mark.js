import { createElement as h, useEffect, useRef, useState } from 'react'
import { fnv1a, shapeId, shapeOf, MASK_ID, nextMarkSerial, characterMarkup } from './characters.js'
import { botLookOf as lookOf } from './bot-look.js'
import { reducedMotion } from './motion.js'
import { t } from './i18n.js'
import { clayArtOf, faceAt, faceOf } from './clay-art.js'
import { PetSprite, useDrowsy } from './pet.js'
import { bakedPet, canBake } from './pet-bake.js'
import { GENIE_AURORA, genieTint } from './genie-tint.js'

export { colorOf } from './characters.js'
export { lookOf }
export { catalogueLookOf } from './bot-look.js'

// -------------------------------------------------------------------------
// Bot mark: the Bot's character (or its uploaded photo), looked up by lookOf.

// Mascot states: what the Bot is doing picks the
// motion. Uploaded images only bob or hop, since they have no parts to move. `waiting`:
// no turn runs, but work it handed on has not come back yet.
// Past the turn itself: `failed`, its last turn failed (until the next one starts);
// `review`, a reply waits to be read; `sleeping`, nobody has touched the window a while.
// A pending approval (`alert`) outranks a running turn: the Bot cannot go on until the
// user answers, whatever its last tool was doing.
const STATES = ['idle', 'thinking', 'searching', 'working', 'sending', 'orbit', 'waiting', 'alert', 'done', 'failed', 'review', 'sleeping']
const WORK = ['thinking', 'searching', 'working', 'sending', 'orbit']
export const botState = (running, activity, alert, { failed = false, unread = false } = {}) => (alert ? 'alert'
  : running ? (WORK.includes(activity) ? activity : 'working') : failed ? 'failed' : activity === 'waiting' ? 'waiting' : unread ? 'review' : 'idle')
export const toolState = name => (/^(message_bot|stop_bot|create_bot|update_bot|delete_bot|create_group|update_group|delete_group|post_to_group)$/.test(name) ? 'sending'
  : /search|fetch|browse|read|grep|glob|list|recall/i.test(name) ? 'searching' : 'working')

// Eyes follow the pointer on large marks.
function useGaze(ref, enabled) {
  useEffect(() => {
    if (!enabled || reducedMotion()) return undefined
    let frame = 0
    let point = null
    const place = () => {
      frame = 0
      const node = ref.current
      if (!node || !point) return
      const box = node.getBoundingClientRect()
      const clamp = value => Math.max(-1, Math.min(1, value))
      node.style.setProperty('--bt-gx', clamp((point.x - box.left - box.width / 2) / 160).toFixed(2))
      node.style.setProperty('--bt-gy', clamp((point.y - box.top - box.height / 2) / 160).toFixed(2))
    }
    const onMove = (event) => {
      if (document.body?.dataset.btMotion === 'quiet') return
      point = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(place)
    }
    const onLeave = () => { point = null; ref.current?.style.setProperty('--bt-gx', '0'); ref.current?.style.setProperty('--bt-gy', '0') }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [enabled])
}

// A mark moves for its state. `live` marks (sidebar, header, details) also answer the
// pointer, and at the lively motion level blink and fidget at rest (each Bot its own
// fidget and moment); transcript marks stay still so a long chat does not run dozens
// of animations.
const FIDGETS = ['hop', 'sway', 'stretch', 'look']

// Pets (pet.js) in the Codex format: a pet the team installed or ships, served by the host
// (pets.js), or a character baked into one (pet-bake.js) for the marks that move.
// Genie is the approved full-body figure (dev/art/genie-approved-v5): a v2 atlas under the id
// teams already keep.
export const GENIE_PET = Object.freeze({ source: 'builtin', id: 'genie-clay', version: 2, sleep: true })
export const UNFOLD_PET = Object.freeze({ source: 'builtin', id: 'unfold', version: 2, sleep: true })
// The pet's version is part of its address (`v`; the route does not read it). The host lets
// the browser keep a sheet for an hour, and the app comes back on the same origin after an
// update: without it, a new atlas under an id teams keep (Genie's v2 over its v1) would be
// drawn with its new rows from the old sheet still in the cache.
const petUrl = (pet, part) => `api/omni-ui/pet?${new URLSearchParams({ source: pet.source, id: pet.id, ...(part ? { part } : {}), ...(pet.version ? { v: pet.version } : {}) })}`
// Genie's version and sleep strip are the shipped ones, never a kept look's: a v2 atlas read
// as the v1 it replaced would draw the wrong cells.
const shipped = pet => (pet.source === GENIE_PET.source && pet.id === GENIE_PET.id ? GENIE_PET : pet)
export const servedPet = (pet) => {
  const worn = shipped(pet)
  return { sheet: petUrl(worn), sleep: worn.sleep ? petUrl(worn, 'sleep') : undefined, version: worn.version }
}
/** The pet a mark wears: its own, Genie's or Unfold's, or (moving marks only) its character baked; else null. */
export function petOf(bot, look, { live, size }) {
  if (look.image) return null
  if (look.pet) return { served: look.pet }
  if (bot?.kind === 'genie' && size > 28) return { served: GENIE_PET }
  if (bot?.kind === 'unfold' && size > 28) return { served: UNFOLD_PET }
  if (!live || size <= 20) return null
  const art = clayArtOf(bot, look)
  if (art === 'genie' || art === 'unfold') return null
  return { bake: art === 'omni' ? { clay: 'omni' } : { shape: shapeId(look.shape), color: look.color } }
}
export function useBaked(wanted) {
  const key = wanted ? `${wanted.clay ?? ''}|${wanted.shape ?? ''}|${wanted.color ?? ''}` : ''
  const [baked, setBaked] = useState(null)
  useEffect(() => {
    if (!wanted || !canBake()) { setBaked(null); return undefined }
    let live = true
    bakedPet(wanted).then((pet) => { if (live) setBaked({ key, pet }) }, () => { if (live) setBaked(null) })
    return () => { live = false }
  }, [key])
  return baked?.key === key ? baked.pet : null
}

export function BotMark(props) {
  const look = props.look ?? lookOf(props.bot)
  const size = props.size ?? 36
  const wants = petOf(props.bot, look, { live: props.live === true, size })
  const baked = useBaked(wants?.bake)
  const pet = wants?.served ? servedPet(wants.served) : baked
  // A Genie wears its own color: its art turned from violet (genie-tint.js).
  const tint = props.bot?.kind === 'genie' && !look.image && !look.pet ? genieTint(props.bot.color) : undefined
  return pet ? h(PetMark, { ...props, look, size, pet, tint }) : h(DrawnMark, { ...props, look, size, tint })
}

// A mark that wears a pet: the pet plays the Bot's state; a poke waves, then it goes back.
function PetMark({ size, state = 'idle', live = false, gaze = false, pokeable = false, label, pet, tint }) {
  const [poked, setPoked] = useState(false)
  const drowsy = useDrowsy(live)
  const shown = poked ? 'poked' : drowsy && state === 'idle' ? 'sleeping' : STATES.includes(state) ? state : 'idle'
  return h('span', {
    className: 'bt-mark',
    'data-shape': 'pet',
    'data-state': shown,
    'data-live': live ? '' : undefined,
    'data-tint': tint === GENIE_AURORA ? GENIE_AURORA : undefined,
    style: { width: size, height: size, ...(tint && tint !== GENIE_AURORA ? { filter: tint } : {}) },
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    onClick: pokeable ? () => setPoked(true) : undefined,
  }, h(PetSprite, { pet, size, state: shown, live, gaze, onOnce: () => setPoked(false) }))
}

function DrawnMark({ bot, look, size = 36, state = 'idle', live = false, gaze = false, pokeable = false, label, tint }) {
  const ref = useRef(null)
  const maskId = useRef('')
  if (maskId.current === '') maskId.current = `bt-mark-${nextMarkSerial()}`
  const [poked, setPoked] = useState(false)
  // A photo that does not load shows the character instead; a new photo is tried again.
  const [broken, setBroken] = useState('')
  const image = look.image && look.image !== broken ? look.image : undefined
  useGaze(ref, gaze)
  const common = {
    ref,
    className: poked ? 'bt-mark bt-mark-poke' : 'bt-mark',
    'data-shape': image ? 'image' : shapeId(look.shape),
    'data-state': STATES.includes(state) ? state : 'idle',
    'data-live': live ? '' : undefined,
    'data-fidget': live ? FIDGETS[fnv1a(`${bot?.id ?? ''}:fidget`) % FIDGETS.length] : undefined,
    'data-gaze': gaze ? '' : undefined,
    'data-poke': pokeable ? '' : undefined,
    style: { width: size, height: size, ...(live ? { '--bt-delay': `${-(fnv1a(String(bot?.id ?? '')) % 5000) / 1000}s`, '--bt-fidget-delay': `${-(fnv1a(`${bot?.id ?? ''}:when`) % 9000) / 1000}s` } : {}) },
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    onClick: pokeable ? () => setPoked(true) : undefined,
    onAnimationEnd: poked ? (event) => { if (/^bt-poke/.test(event.animationName)) setPoked(false) } : undefined,
  }
  if (image) return h('span', common, h('img', { className: 'bt-mark-img', src: image, alt: '', draggable: false, onError: () => setBroken(image) }))
  // A clay character is one picture: the body motions of its state move it whole (.bt-b),
  // and its face follows the state. Genie is always the whole figure; the head alone is retired.
  // data-frame stays only as a marker for small marks and has no style.
  const art = clayArtOf(bot, look)
  if (art) {
    const face = faceOf(common['data-state'], poked)
    return h('span', { ...common, 'data-shape': `clay-${art}`, 'data-face': face, 'data-frame': art === 'genie' && size <= 28 ? 'head' : undefined },
      h('span', { className: `bt-b bt-clay bt-clay-${art}`, 'data-tint': tint === GENIE_AURORA ? GENIE_AURORA : undefined, style: { '--bt-face-at': faceAt(face), ...(tint && tint !== GENIE_AURORA ? { filter: tint } : {}) } }))
  }
  const box = shapeOf(look.shape).size
  return h('span', common, h('svg', { viewBox: `0 0 ${box} ${box}`, dangerouslySetInnerHTML: { __html: characterMarkup(look.shape, look.color).replaceAll(MASK_ID, maskId.current) } }))
}

function StarIcon({ size = 8 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 10 10', 'aria-hidden': true },
    h('path', { d: 'M5 .6l1.3 2.8 3 .3-2.3 2 .7 3L5 7.2 2.3 8.7l.7-3L.7 3.7l3-.3z', fill: '#fff' }))
}
// The small star in a disc that marks a group admin, beside a name.
export function AdminStar() {
  return h('span', { className: 'bt-admin-star', role: 'img', 'aria-label': t('Admin') }, h(StarIcon, { size: 7 }))
}
// A Main Bot wears a large solid star; a group admin wears the small star in a disc.
function MainStar() {
  return h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true },
    h('path', { d: 'M10 2.4l2.29 5.04 5.51.63-4.09 3.74 1.11 5.42L10 14.5l-4.82 2.73 1.11-5.42L2.2 8.07l5.51-.63z' }))
}

// Marks settle with a short squash when a run finishes.
function useSettled(state) {
  const prev = useRef(state)
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const was = prev.current
    prev.current = state
    // A run that ends settles into rest, or into a reply waiting to be read.
    if (state !== 'idle' && state !== 'review') { setSettled(false); return undefined }
    if (!WORK.includes(was) && was !== 'waiting') return undefined
    setSettled(true)
    const timer = setTimeout(() => setSettled(false), 1800)
    return () => clearTimeout(timer)
  }, [state])
  return settled
}

// The crown the team's first Main Bot wears in the sidebar, in clay gold.
function Crown() {
  return h('span', { className: 'bt-crown', 'aria-hidden': true },
    h('svg', { viewBox: '0 0 44 30' },
      h('path', { className: 'bt-crown-body', d: 'M4 26 L2 8 L13 16 L22 2 L31 16 L42 8 L40 26 Z' }),
      h('rect', { className: 'bt-crown-band', x: 4, y: 23, width: 36, height: 5, rx: 2.5 }),
      h('circle', { className: 'bt-crown-gem', cx: 22, cy: 17, r: 3 }),
      h('circle', { className: 'bt-crown-gem2', cx: 12, cy: 20, r: 2.2 }),
      h('circle', { className: 'bt-crown-gem2', cx: 32, cy: 20, r: 2.2 }),
      h('path', { className: 'bt-crown-shine', d: 'M8 11 L13 15' })))
}

// `crown`: the team's first Main Bot, which wears the crown in place of the Main Bot star.
export function BotAvatar({ bot, size, state = 'idle', count, main, admin, crown = false, badge = true, live = true, gaze = false, pokeable = false }) {
  const settled = useSettled(state)
  if (bot === undefined) return h(BotMark, { size })
  const badgeKind = !badge ? null : state === 'alert' ? 'alert' : WORK.includes(state) ? 'working' : admin ? 'admin' : main && !crown ? 'main' : null
  return h('span', { className: 'bt-mark', style: { width: size, height: size, '--bt-size': `${size}px` } },
    h(BotMark, { bot, size, state: settled ? 'done' : state, live, gaze, pokeable }),
    crown ? h(Crown) : null,
    badgeKind === 'working' ? h('span', { className: 'bt-badge bt-badge-working', 'aria-label': t('Working'), role: 'img' }) : null,
    badgeKind === 'alert' ? h('span', { className: 'bt-badge bt-badge-alert', 'aria-label': count > 0 ? (count === 1 ? t('1 approval waiting') : t('{count} approvals waiting', { count })) : t('Waiting for your answer'), role: 'img' }, count > 0 ? (count > 9 ? '9+' : String(count)) : '?') : null,
    badgeKind === 'admin' ? h('span', { className: 'bt-badge bt-badge-admin', 'aria-label': t('Admin'), role: 'img' }, h(StarIcon)) : null,
    badgeKind === 'main' ? h('span', { className: 'bt-badge bt-badge-main', 'aria-label': t('Main Bot'), role: 'img' }, h(MainStar)) : null)
}

// A group avatar seats its members' characters in the frame: two on a
// diagonal, three in a triangle, four in a grid, and past four three plus a "+N" seat.
function clusterSeats(count, frame) {
  if (count === 1) return [[0, 0, frame]]
  if (count === 2) return [[0, 0, frame * 2 / 3], [frame / 3, frame / 3, frame * 2 / 3]]
  if (count === 3) {
    const size = frame * 5 / 9
    const rest = frame - size
    return [[rest / 2, 0, size], [0, rest, size], [rest, rest, size]]
  }
  const half = frame / 2
  return [[0, 0, half], [half, 0, half], [0, half, half], [half, half, half]]
}

export function RoomAvatar({ room, roster, size = 36 }) {
  const members = room.members.map(id => roster.byId[id]).filter(Boolean)
  // A group with one Bot left shows the user beside it.
  const people = members.length === 1 ? [members[0], null] : members
  const seat = (bot, seatSize, key) => (bot
    ? h(BotMark, { key, bot, size: seatSize })
    : h('span', { key, className: 'bt-cluster-you', style: { width: seatSize * 0.92, height: seatSize * 0.92, margin: seatSize * 0.04 } }))
  if (people.length === 0) return h(BotMark, { size })
  // Inline sizes have no room for a cluster, so the members line up instead.
  if (size <= 20 && people.length > 1) {
    return h('span', { className: 'bt-stack', style: { '--bt-stack-size': `${size}px` } },
      people.slice(0, 3).map((bot, index) => seat(bot, size, bot?.id ?? `you-${index}`)),
      people.length > 3 ? h('span', { className: 'bt-stack-more' }, `+${people.length - 3}`) : null)
  }
  const seats = clusterSeats(Math.min(people.length, 4), size)
  const overflow = people.length > 4 ? people.length - 3 : 0
  // A later seat cuts a gap of frame/14 into each seat it overlaps.
  const gap = size / 14
  const rings = seats.map(([x, y, s]) => ({ cx: x + s / 2, cy: y + s / 2, r: s * 0.48 + gap }))
  return h('span', { className: 'bt-cluster', style: { width: size, height: size } },
    seats.map(([x, y, s], index) => {
      const holes = rings.slice(index + 1)
        .filter(ring => Math.hypot(ring.cx - x - s / 2, ring.cy - y - s / 2) < ring.r + s * 0.46)
        .map(ring => `radial-gradient(circle at ${ring.cx - x}px ${ring.cy - y}px,transparent ${ring.r}px,#000 ${ring.r + 0.5}px)`)
      const style = { left: x, top: y, width: s, height: s }
      if (holes.length > 0) Object.assign(style, { WebkitMaskImage: holes.join(','), maskImage: holes.join(','), WebkitMaskComposite: 'source-in', maskComposite: 'intersect' })
      if (overflow > 0 && index === 3) {
        return h('span', { key: 'more', className: 'bt-cluster-more', style: { ...style, width: s * 0.92, height: s * 0.92, margin: s * 0.04, fontSize: Math.max(8, Math.round(s * 0.36)) } }, `+${overflow}`)
      }
      const bot = people[index]
      return h('span', { key: bot?.id ?? 'you', style }, seat(bot, s))
    }))
}
