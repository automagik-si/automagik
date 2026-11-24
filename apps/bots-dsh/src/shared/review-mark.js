// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard): which review its
// last delivery had, from what the host saw. Pure, so the host and the client share it. It
// grants and refuses nothing: a mark only tells the person what the host saw, so it may key
// on the cosmetic Solver marker and on the reviewer id the New Solver dialog stores.

// The verdicts a reviewer answers with (REVIEWER_RULES), as whole words, case as written (F9):
// at the start of a line, right after "Verdict:", ending a line right after a sentence's end
// (a Codex reviewer's progress sentence and its verdict arrive run together on one line:
// "I'll read the note and check it.FIX-FIRST"), or glued to a sentence's end before a spaced
// dash ("I'll read the note.SHIP — it has two lines", GLUED_DASH). Never inside a word or
// mid-sentence, never asked ("SHIP? no."), never as one of a list of options ("SHIP, FIX-FIRST
// or BLOCKED.", SR5-2).
const ANY = '(?:SHIP|FIX-FIRST|BLOCKED)'
export const MD = '[*_\\`]*'
export const WORD = `(SHIP|FIX-FIRST|BLOCKED)(?![A-Za-z0-9-]|${MD}\\s*\\?|${MD}\\s*[,;/|]\\s*${MD}${ANY}|${MD}\\s+(?:or|and|nor|vs\\.?|versus)\\s+${MD}${ANY}|${MD}\\s*[-–—(]\\s*(?:or\\s+)?${MD}${ANY})`
const AT_START = new RegExp(`^${WORD}`)
const AFTER_LABEL = new RegExp(`(?:^|[^A-Za-z])(?:Verdict|verdict|VERDICT)[*_\`]*\\s*:\\s*[*_\`]*\\s*${WORD}`)
const ENDS_LINE = new RegExp(`[.!?\u2026]["'\u201d\u2019)\\]]*\\s*[*_\`]*${WORD}[*_\`]*[\\s.!]*$`)
// The most verdicts one delivery keeps.
export const VERDICTS_KEPT = 4

// A line that opens or closes a fenced code block (three backticks or three tildes), and a list
// item (a bullet or a number): a verdict word in a fenced block or opening a list item is quoted
// text or one of a list of options, never the reviewer's verdict (SR5-2).
export const FENCE = /^[\s>]*(?:```|~~~)/
export const LIST_ITEM = /^[\s>]*(?:[*+-]|\d+[.)])\s+/

// A verdict glued to the end of a line's first sentence (#2056: a Codex reviewer's progress
// sentence and its final answer arrive as one text, "I'll read the note.SHIP — it has two lines").
// LEAD is the sentence before it: no leading quote, and no colon, backtick, double or typographic
// quote, guillemet, corner bracket, `>`, zero-width character, word joiner or line break before
// its end (copied byte for byte from the adversarial review; some of its characters are
// invisible). Mid-line apostrophes, parentheses and HTML entities are read (accepted). An
// indented code line (four columns, a tab counting to the next) is never read this way.
export const LEAD = `^(?!['‘])[^:\`"“”«»„>‘‚‹›「」『』＂〝〞″​-‍⁠\r  ]*?[.!?…]["'”’]*`
export const INDENTED = /^(?: {0,3}\t| {4})/
const GLUED_DASH = new RegExp(`${LEAD}${MD}${WORD}${MD}\\s+[-\u2013\u2014]\\s+\\S`)
// The glued verdict with a spaced dash and text after it, on a line not indented as code; only
// `#`, `*`, `_` and spaces are stripped first, so a quoted line keeps its `>`.
const gluedDash = raw => (INDENTED.test(raw) ? null : GLUED_DASH.exec(raw.replace(/^[\s#*_]+/, '')))

/**
 * The reviewer's verdict in a reply, or undefined: the last line that holds one (WORD's four
 * places), each line read with any leading Markdown (`#`, `>`, `*`, `_`, backticks) and spaces
 * stripped; case-sensitive. A verdict word inside a word or mid-sentence is no verdict, nor is
 * one in a fenced code block; a list item counts only after "Verdict:".
 * @param {unknown} text - the reply as the reviewer sent it.
 * @returns {'SHIP'|'FIX-FIRST'|'BLOCKED'|undefined} the verdict.
 */
export function verdictOf(text) {
  if (typeof text !== 'string') return undefined
  let verdict
  let fenced = false
  for (const raw of text.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      // "```SHIP```" on one line opens and closes its block.
      if (raw.split(/```|~~~/).length % 2 === 0) fenced = !fenced
      continue
    }
    if (fenced) continue
    const line = raw.replace(/^[\s#>*_`]+/, '')
    const found = LIST_ITEM.test(raw)
      ? AFTER_LABEL.exec(line)
      : AT_START.exec(line) ?? AFTER_LABEL.exec(line) ?? ENDS_LINE.exec(line) ?? gluedDash(raw)
    if (found) verdict = found[1]
  }
  return verdict
}

/**
 * The mark of a delivery. `review`: 'bot' when the Solver's reviewer Bot is on the team, 'fresh'
 * when it has none (its reviews run in a fresh session the host cannot see), 'none' when its
 * reviewer is gone. For a reviewer Bot: the plan was reviewed when a verdict came before the
 * first work call, the result when one came after the last. With no work call seen (a route
 * whose calls the host never sees, or a delivery that changed nothing), the first verdict
 * counts for the plan and a second one for the result. With only notes writes seen, the plan
 * was reviewed when a verdict came before the last one.
 * @param {{ firstWorkAt?: number, lastWorkAt?: number, verdicts?: {verdict: string, at: number}[] }} track
 * @param {'bot'|'fresh'|'none'} review
 * @param {number} at - when the delivery ended.
 */
export function deliveryMark(track, review, at, { pending = false } = {}) {
  if (review !== 'bot') return { at, review }
  // Delivered while its reviewer still had the work (the person asked first, SR3-3 (b)).
  if (pending) return { ...deliveryMark(track, review, at), pending: true }
  const verdicts = Array.isArray(track?.verdicts) ? track.verdicts : []
  const first = track?.firstWorkAt
  const last = track?.lastWorkAt ?? first
  const planBefore = first ?? last
  const plan = typeof planBefore === 'number' ? verdicts.some(entry => entry.at < planBefore) : verdicts.length >= 1
  const result = typeof last === 'number' ? verdicts.some(entry => entry.at > last) : verdicts.length >= 2
  return { at, review, plan, result }
}
