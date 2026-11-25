import { createElement as h } from 'react'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The new left bar (RFC 0022 (i), direction C "Foot line"): what a row says about its Bot,
// chat or project, as one mark at the row's right. Each status has its own shape as well as
// its colour, and each mark sits beside a name, so colour never carries a status alone
// (docs/brand, "Colour"). Only "needs you" keeps its word: it is the one that asks for the
// owner. The others say their word as a hover title and as the mark's accessible name.
//
// The Bot team's sidebar draws these (left-bar.js, through sidebar.js's TeamSidebar).

// `off` is a Bot that is not running: an idle mark, on a row drawn grey.
export const STATUSES = Object.freeze(['working', 'needs', 'idle', 'error', 'off', 'not-installed'])
export const statusOr = status => (STATUSES.includes(status) ? status : 'idle')

// The bar's words, all in the dictionary (i18n.js). `projects` names the rail, a tile per space;
// `add` its "+"; `faces` names the view's Chat and Terminal switch (left-bar-faces.js).
const SAID = {
  working: () => t('Working'),
  needs: () => t('Needs you'),
  error: () => t('Error'),
  idle: () => t('Idle'),
  off: () => t('Not running'),
  'not-installed': () => t('Not installed'),
  team: () => t('Team'),
  projects: () => t('Spaces'),
  add: () => t('Create or join a space'),
  faces: () => t('This Bot as'),
}
export const WORDS = Object.freeze(Object.keys(SAID))
export const word = name => SAID[name]()

// The statuses that show their word, and the ones a row does not draw at all. `off` says its
// word because the hollow ring alone would read as another kind of idle; one set serves Bots
// and seats alike. `not-installed` says its word too: it is why the Bot cannot answer.
export const WORDED = Object.freeze(['needs', 'off', 'not-installed'])
export const QUIET = Object.freeze(['idle'])

// One status for several (a folded channel's chats): what asks for the owner first, then
// what failed, then what cannot run, then what runs.
const FIRST = ['needs', 'error', 'not-installed', 'working']
export const worstStatus = statuses => FIRST.find(status => statuses.includes(status)) ?? 'idle'

// The mascot states of mark.js (botState), as the bar's statuses.
const OF_STATE = Object.freeze({
  alert: 'needs', failed: 'error', 'not-installed': 'not-installed',
  thinking: 'working', searching: 'working', working: 'working', sending: 'working', orbit: 'working', waiting: 'working',
})
export const statusOfState = state => OF_STATE[state] ?? 'idle'
// And back, for the art beside the mark: the Bot's character plays its status.
const STATE_OF = Object.freeze({ working: 'working', needs: 'alert', error: 'failed', 'not-installed': 'not-installed' })
export const stateOfStatus = status => STATE_OF[status] ?? 'idle'

// Each mark in a 12 by 12 box. Working: a turning ring. Needs you: a disc with "!". Error: a
// rounded square with a cross. Idle: a hollow ring.
const ring = () => [h('circle', { key: 'ring', cx: 6, cy: 6, r: 3.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 })]
const SHAPES = {
  working: () => [
    h('circle', { key: 'track', cx: 6, cy: 6, r: 4.5, fill: 'none', stroke: 'currentColor', strokeOpacity: 0.3, strokeWidth: 2 }),
    h('path', { key: 'arc', className: 'lb-mark-arc', d: 'M6 1.5a4.5 4.5 0 0 1 0 9', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
  ],
  needs: () => [
    h('circle', { key: 'disc', cx: 6, cy: 6, r: 6, fill: 'currentColor' }),
    h('path', { key: 'glyph', className: 'lb-mark-glyph', d: 'M6 3.4v2.6M6 9h.01', fill: 'none', strokeWidth: 2, strokeLinecap: 'round' }),
  ],
  error: () => [
    h('rect', { key: 'tile', x: 0.5, y: 0.5, width: 11, height: 11, rx: 3.4, fill: 'currentColor' }),
    h('path', { key: 'glyph', className: 'lb-mark-glyph', d: 'M4 4l4 4M8 4l-4 4', fill: 'none', strokeWidth: 1.7, strokeLinecap: 'round' }),
  ],
  idle: ring,
  off: ring,
  'not-installed': () => [
    h('circle', { key: 'ring', cx: 6, cy: 6, r: 4.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeDasharray: '2 2.2' }),
    h('path', { key: 'slash', d: 'M3.2 8.8l5.6-5.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  ],
}

/** One status mark. Alone, it carries its word as a title and a name; `named: false` is the mark beside its own word. */
export function StatusMark({ status, named = true, detail = '' }) {
  const kind = statusOr(status)
  const says = detail === '' ? word(kind) : `${word(kind)} · ${detail}`
  return h('span', {
    className: `lb-mark lb-mark-${kind}`,
    'data-status': kind,
    ...(named ? { role: 'img', 'aria-label': says, title: says } : { 'aria-hidden': true }),
  }, h('svg', { viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false' }, ...SHAPES[kind]()))
}

/** A row's status: nothing for a quiet one, the mark and its word for a worded one, else the mark. */
export function Status({ status, worded = WORDED, quiet = QUIET, detail = '' }) {
  const kind = statusOr(status)
  if (quiet.includes(kind)) return null
  const says = detail === '' ? word(kind) : `${word(kind)} · ${detail}`
  if (!worded.includes(kind)) return h(StatusMark, { status: kind, detail })
  return h('span', { className: `lb-st lb-st-${kind}`, 'data-status': kind, title: says }, h(StatusMark, { status: kind, named: false }), word(kind))
}
