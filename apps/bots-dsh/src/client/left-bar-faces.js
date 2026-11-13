import { createElement as h } from 'react'
import { t } from './i18n.js'
import { word } from './left-bar-status.js'

// -------------------------------------------------------------------------
// The view's own switch, beside the new left bar (direction C; the owner's answer of
// 2026-11-13: "Yes, Chat / Terminal"). It switches the two faces of the open Bot: its chat, and
// the terminal it runs in. It says Terminal, so the word Code is on the screen once, as the
// bar's other side.
//
// Like the other left-bar-*.js files, nothing imports this yet: the switch that draws today
// (work-code-switch.js) is one of the files the DS Bot 0.3.6 merge rewrites.

export const FACES = Object.freeze(['chat', 'terminal'])
export const faceOr = face => (FACES.includes(face) ? face : 'chat')

// Both words are in the dictionary already; the group's name is owed (left-bar-status.js).
const SAID = { chat: () => t('Chat'), terminal: () => t('Terminal') }
export const faceWord = face => SAID[faceOr(face)]()

const PATHS = {
  chat: ['M4.5 4.5h11A1.5 1.5 0 0 1 17 6v6.5a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 2.8V14h-1A1.5 1.5 0 0 1 3 12.5V6a1.5 1.5 0 0 1 1.5-1.5z'],
  terminal: ['M5 6.5 9 10l-4 3.5', 'M10.5 14H15'],
}
const Glyph = ({ face }) => h('svg', { className: 'lb-face-glyph', viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' },
  ...PATHS[face].map(d => h('path', { key: d, d })))

/**
 * The switch: two parts, each its glyph and its word, the open face pressed. `onFace(face)`
 * hears a press on the other face; a press on the open one changes nothing and is not handed on.
 */
export function FaceSwitch({ face, onFace, label }) {
  const open = faceOr(face)
  return h('div', { className: 'lb-face', role: 'group', 'aria-label': label ?? word('faces') },
    ...FACES.map(name => h('button', {
      key: name, type: 'button', className: 'lb-face-part', 'data-face': name, 'aria-pressed': name === open,
      onClick: onFace && name !== open ? () => onFace(name) : undefined,
    }, h(Glyph, { face: name }), faceWord(name))))
}
