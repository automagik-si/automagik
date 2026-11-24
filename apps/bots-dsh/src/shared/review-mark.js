// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard): which review its
// last delivery had, from what the host saw. Pure, so the host and the client share it. It
// grants and refuses nothing: a mark only tells the person what the host saw, so it may key
// on the cosmetic Solver marker and on the reviewer id the New Solver dialog stores.

// The verdicts a reviewer answers with (REVIEWER_RULES), as whole words, case as written (F9):
// at the start of a line, right after "Verdict:", or ending a line right after a sentence's end
// (a Codex reviewer's progress sentence and its verdict arrive run together on one line:
// "I'll read the note and check it.FIX-FIRST"). Never inside a word or mid-sentence.
const WORD = '(SHIP|FIX-FIRST|BLOCKED)(?![A-Za-z0-9-])'
const AT_START = new RegExp(`^${WORD}`)
const AFTER_LABEL = new RegExp(`(?:^|[^A-Za-z])(?:Verdict|verdict|VERDICT)[*_\`]*\\s*:\\s*[*_\`]*\\s*${WORD}`)
const ENDS_LINE = new RegExp(`[.!?\u2026]["'\u201d\u2019)\\]]*\\s*[*_\`]*${WORD}[*_\`]*[\\s.!]*$`)
// The most verdicts one delivery keeps.
export const VERDICTS_KEPT = 4

/**
 * The reviewer's verdict in a reply, or undefined: the last line that holds one (WORD's three
 * places), each line read with any leading Markdown (`#`, `>`, `*`, `_`, backticks) and spaces
 * stripped; case-sensitive. A verdict word inside a word or mid-sentence is no verdict.
 * @param {unknown} text - the reply as the reviewer sent it.
 * @returns {'SHIP'|'FIX-FIRST'|'BLOCKED'|undefined} the verdict.
 */
export function verdictOf(text) {
  if (typeof text !== 'string') return undefined
  let verdict
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s#>*_`]+/, '')
    const found = AT_START.exec(line) ?? AFTER_LABEL.exec(line) ?? ENDS_LINE.exec(line)
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
 * counts for the plan and a second one for the result.
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
  const plan = typeof first === 'number' ? verdicts.some(entry => entry.at < first) : verdicts.length >= 1
  const result = typeof last === 'number' ? verdicts.some(entry => entry.at > last) : verdicts.length >= 2
  return { at, review, plan, result }
}
