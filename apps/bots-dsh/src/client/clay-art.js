import {
  automagikLockupThreeColoursCreamHeader, automagikLockupThreeColoursInkHeader, automagikWordmarkCream, automagikWordmarkInk,
  genieExpressions, genieLampCream, genieLampInk, lamp, omniExpressions, omniMarkCream32, omniMarkInk32,
  triskleThreeColours, triskleThreeColours16, triskleThreeColours32, triskleThreeColours64, unfoldExpressions,
} from './art/inline.js'

// -------------------------------------------------------------------------
// Clay characters: Omni and Genie as the Automagik clay universe draws them, in place of the
// vector characters (characters.js) where the team shows them. Each is one row of seven
// faces: Omni's from the owner's clay kit (dev/art/clay-kit.py), in 192x192 cells; Genie's
// are seven frames of the approved full-body figure's atlas (dev/art/genie-approved-v5), in
// 192x208 cells; Unfold's row is made from its pet's stills (dev/art/unfold-expressions.sh),
// in 192x208 cells. CLAY_OMNI false puts the vector octopus back everywhere.
export const CLAY_OMNI = true
export const GENIE_ATLAS = genieExpressions
export const OMNI_ATLAS = omniExpressions
export const UNFOLD_ATLAS = unfoldExpressions
export const LAMP = lamp
// Each product's own mark alone, from the brand's logo set (art/brand): the flat lamp for
// Genie and the tentacle vortex for Omni, one colour, ink on a light ground and cream on a
// dark one. Omni takes the drawing made for about 32px; the lamp has one drawing. Neither is
// Automagik's triskle and neither is the clay pet (docs/brand, rules 1, 3 and 9).
export const PRODUCT_MARK_ART = Object.freeze({
  omni: Object.freeze({ ink: omniMarkInk32, cream: omniMarkCream32 }),
  genie: Object.freeze({ ink: genieLampInk, cream: genieLampCream }),
})
// The Automagik logo is the approved set's own files (art/brand, byte for byte; SOURCE.json
// beside them names each one's place in the set and its SHA-256).
// The mark is the triskle in its three colours, always. Its seam line is drawn to stay about a
// pixel wide, so there is a drawing per size and a mark takes the one made for the size it is
// shown at (CSS px), never a larger one scaled down: up to 23, up to 47, up to 99, and the
// large drawing from 100 up.
const MARK_DRAWINGS = Object.freeze([[23, triskleThreeColours16], [47, triskleThreeColours32], [99, triskleThreeColours64]])
export const markArt = size => (MARK_DRAWINGS.find(([upTo]) => size <= upTo) ?? [0, triskleThreeColours])[1]
// The mark's frame is square (all four drawings share it); the three arms fill its width and
// 222/257.7 of its height, from 17.9/257.7 below its top.
// The lowercase wordmark, its i dotted with Automagik's violet sparkle: ink letters for a light
// ground, cream for a dark one. Its frame is as tall as the lockup's.
export const WORDMARK_ART = Object.freeze({ ink: automagikWordmarkInk, cream: automagikWordmarkCream })
export const WORDMARK_RATIO = 1333 / 264
// The lockup, the mark beside the wordmark: the drawing made for headers (under about 56 px
// high), again with ink or cream letters.
export const LOCKUP_ART = Object.freeze({ ink: automagikLockupThreeColoursInkHeader, cream: automagikLockupThreeColoursCreamHeader })
export const LOCKUP_RATIO = 1632.34 / 264
export const FACES = Object.freeze(['calm', 'pleased', 'delighted', 'focused', 'curious', 'asleep', 'sad'])

// A mark's state (mark.js STATES: what the Bot is doing, from its Session and its work) as a
// face, the same for Omni and Genie. Work of every kind concentrates; `alert` (a question or
// an approval waits for the person) looks up, expectant; `waiting` (work it handed on has not
// come back) stays calm, the mark's sway says it waits; `done` (the settle after a run) is
// delighted. A poke is a greeting. Failure is sad and powered off is asleep: the team's marks
// have neither state, the welcome's Omni card has both.
const FACE_OF_STATE = Object.freeze({
  idle: 'calm',
  thinking: 'focused',
  searching: 'focused',
  working: 'focused',
  sending: 'focused',
  orbit: 'focused',
  waiting: 'calm',
  alert: 'curious',
  done: 'delighted',
  failed: 'sad',
  asleep: 'asleep',
})
export const faceOf = (state, poked = false) => (poked ? 'pleased' : FACE_OF_STATE[state] ?? 'calm')
export const faceAt = face => Math.max(0, FACES.indexOf(face))

/**
 * Which clay character draws a Bot, or null for its own look. A photo always wins. Genie is
 * the Bot of kind `genie` (a team member its own plugin adds), Unfold the Bot of kind `unfold`;
 * Omni is Omni's own look, the
 * octopus in Omni's colour (MAIN_LOOK, and the Omni Bot the welcome adds), so an octopus
 * someone recoloured stays the vector one they chose.
 */
export function clayArtOf(bot, look) {
  if (look?.image) return null
  if (bot?.kind === 'genie') return 'genie'
  if (bot?.kind === 'unfold') return 'unfold'
  if (CLAY_OMNI && look?.shape === 'octopus' && look?.color === 'deepseek') return 'omni'
  return null
}
