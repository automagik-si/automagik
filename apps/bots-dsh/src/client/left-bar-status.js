import { createElement as h } from 'react'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The new left bar (RFC 0022 (i), direction C "Foot line"): what a row says about its Bot,
// chat or project, as one mark at the row's right. Each status has its own shape as well as
// its colour, and each mark sits beside a name, so colour never carries a status alone
// (docs/brand, "Colour"). Only "needs you" keeps its word: it is the one that asks for the
// owner. The others say their word as a hover title and as the mark's accessible name.
//
// Nothing imports the left-bar-*.js files yet: the bar that draws today is being rewritten by
// the DS Bot 0.3.6 merge, and the switch to these goes in on top of it.

// `off` is a Bot that is not running: an idle mark, on a row drawn grey.
export const STATUSES = Object.freeze(['working', 'needs', 'idle', 'error', 'off'])
export const statusOr = status => (STATUSES.includes(status) ? status : 'idle')

// The bar's words. Three are in the dictionary already. The other five reach t() through a
// name, not as literals, because the dictionary (i18n.js) is one of the files the merge
// rewrites: their entries go in with the switch, and until then every language reads the
// English (test/left-bar-status.test.js lists what is owed).
const SAID = { working: () => t('Working'), needs: () => t('Needs you'), error: () => t('Error') }
export const OWED_WORDS = Object.freeze({
  idle: 'Idle',
  off: 'Not running',
  team: 'Team',
  projects: 'Projects',
  add: 'Add a project',
})
export const word = name => (SAID[name] ? SAID[name]() : t(OWED_WORDS[name]))

// The statuses that show their word, and the ones a row does not draw at all.
export const WORDED = Object.freeze(['needs'])
export const QUIET = Object.freeze(['idle'])

// One status for several (a folded channel's chats): what asks for the owner first, then
// what failed, then what runs.
const FIRST = ['needs', 'error', 'working']
export const worstStatus = statuses => FIRST.find(status => statuses.includes(status)) ?? 'idle'

// The mascot states of mark.js (botState), as the bar's statuses.
const OF_STATE = Object.freeze({
  alert: 'needs', failed: 'error',
  thinking: 'working', searching: 'working', working: 'working', sending: 'working', orbit: 'working', waiting: 'working',
})
export const statusOfState = state => OF_STATE[state] ?? 'idle'
// And back, for the art beside the mark: the Bot's character plays its status.
const STATE_OF = Object.freeze({ working: 'working', needs: 'alert', error: 'failed' })
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
}

/** One status mark. Alone, it carries its word as a title and a name; `named: false` is the mark beside its own word. */
export function StatusMark({ status, named = true }) {
  const kind = statusOr(status)
  const says = word(kind)
  return h('span', {
    className: `lb-mark lb-mark-${kind}`,
    'data-status': kind,
    ...(named ? { role: 'img', 'aria-label': says, title: says } : { 'aria-hidden': true }),
  }, h('svg', { viewBox: '0 0 12 12', 'aria-hidden': true, focusable: 'false' }, ...SHAPES[kind]()))
}

/** A row's status: nothing for a quiet one, the mark and its word for a worded one, else the mark. */
export function Status({ status, worded = WORDED, quiet = QUIET }) {
  const kind = statusOr(status)
  if (quiet.includes(kind)) return null
  if (!worded.includes(kind)) return h(StatusMark, { status: kind })
  return h('span', { className: `lb-st lb-st-${kind}`, 'data-status': kind }, h(StatusMark, { status: kind, named: false }), word(kind))
}
