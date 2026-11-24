// The Solver's "unreviewed" mark (RFC 0048, delivery 1; #2056's soft guard): which review its
// last delivery had, from what the host saw. Pure, so the host and the client share it. It
// grants and refuses nothing: a mark only tells the person what the host saw, so it may key
// on the cosmetic Solver marker and on the reviewer id the New Solver dialog stores.

// The verdicts a reviewer answers with (REVIEWER_RULES): first, on the reply's first line.
const VERDICT = /^(SHIP|FIX-FIRST|BLOCKED)(?![A-Za-z-])/
// The most verdicts one delivery keeps.
export const VERDICTS_KEPT = 4

/**
 * The verdict a reviewer's reply opens with, or undefined. The first non-empty line, with any
 * leading Markdown (`#`, `>`, `*`, `_`, backticks) and spaces stripped; case-sensitive. Anything
 * else is no verdict, so a reply that only mentions one does not count.
 * @param {unknown} text - the reply as the reviewer sent it.
 * @returns {'SHIP'|'FIX-FIRST'|'BLOCKED'|undefined} the verdict.
 */
export function verdictOf(text) {
  if (typeof text !== 'string') return undefined
  const line = text.split('\n').find(entry => entry.trim() !== '')
  if (line === undefined) return undefined
  return VERDICT.exec(line.replace(/^[\s#>*_`]+/, ''))?.[1]
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
export function deliveryMark(track, review, at) {
  if (review !== 'bot') return { at, review }
  const verdicts = Array.isArray(track?.verdicts) ? track.verdicts : []
  const first = track?.firstWorkAt
  const last = track?.lastWorkAt ?? first
  const plan = typeof first === 'number' ? verdicts.some(entry => entry.at < first) : verdicts.length >= 1
  const result = typeof last === 'number' ? verdicts.some(entry => entry.at > last) : verdicts.length >= 2
  return { at, review, plan, result }
}
