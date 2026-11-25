// The Solver's review guard (RFC 0048, delivery 1.5; #2056's hard guard): the verdict that opens
// a guarded Solver's work, and how far the guard holds on the route a Bot runs on. Pure, so the
// host and the client share it. The guard keys on the person's own `reviewGuard` field and on the
// reviewer id the New Solver dialog stores, never on the cosmetic Solver marker.
import { FENCE, INDENTED, LEAD, LIST_ITEM, MD, WORD, stageVerdictOf } from './review-mark.js'
import { effectiveMarkOf, nativeToolsOn } from './native-tools.js'

// The verdict at the start of the reply's first line, or after a "Verdict:" label that starts a
// line, or (iii) glued to the first line's sentence. Nothing else: no verdict ending a later
// sentence, no last-wins, no list item (H5-4).
const AT_START = new RegExp(`^${WORD}`)
const LABEL = new RegExp(`^(?:Verdict|verdict|VERDICT)[*_\`]*\\s*:\\s*[*_\`]*\\s*${WORD}`)
// (iii) A verdict glued to the end of the first line's sentence (review-mark.js LEAD): the line
// ends there, or a spaced dash and text follow.
const GLUED = new RegExp(`${LEAD}${MD}${WORD}${MD}(?:\\s*[.!]*$|\\s+[-\u2013\u2014]\\s+\\S)`)

/**
 * The verdict that opens a guarded Solver's work, or undefined. An explicit stage on the
 * first line requires a matching designated stage. Otherwise the reply is cut at the
 * line that hands a third Bot's answers back to the reviewer (handoffs.js); lines in fenced blocks
 * are never read; the first non-empty line counts unless it is quoted (`>`); else the first line
 * that starts with a "Verdict:" label; else a verdict glued to the end of the first line's
 * sentence (`… evidence.SHIP` or `….SHIP — …`), unless that line is quoted, a list item or
 * indented code, so a reviewer first line such as `Not yet.SHIP` counts as SHIP. A lead-in line
 * before the verdict gives none: work stays held (a false block only).
 * @param {unknown} text - the reviewer's reply.
 * @param {unknown} reviewerName - the reviewer's name, for the handed-back line.
 * @param {'plan'|'result'} [stage] - the stage of the current host-bound exchange.
 * @param {string} [firstLine] - the original first line when the host formats the reply for delivery.
 * @returns {'SHIP'|'FIX-FIRST'|'BLOCKED'|undefined} the verdict.
 */
export function guardVerdictOf(text, reviewerName, stage, firstLine) {
  if (typeof text !== 'string') return undefined
  let lines = text.split(/\r?\n/)
  const explicit = stageVerdictOf(firstLine ?? lines[0])
  if (explicit) return explicit.stage === stage ? explicit.verdict : undefined
  if (typeof reviewerName === 'string' && reviewerName !== '') {
    const cut = lines.indexOf(`[Handed back to ${reviewerName} for this work]`)
    if (cut >= 0) lines = lines.slice(0, cut)
  }
  let fenced = false
  let first = true
  for (const raw of lines) {
    if (FENCE.test(raw)) {
      if (raw.split(/```|~~~/).length % 2 === 0) fenced = !fenced
      first = false
      continue
    }
    if (fenced) continue
    const line = raw.replace(/^[\s#*_`]+/, '')
    if (first && line !== '') {
      first = false
      if (!line.startsWith('>')) {
        const found = AT_START.exec(line)
        if (found) return found[1]
      }
    }
    const label = LABEL.exec(line)
    if (label) return label[1]
  }
  return gluedFirstLine(lines)
}

// (iii): the first non-empty line, as rule (i) finds it, read with GLUED; only `#`, `*`, `_` and
// spaces are stripped, so a backtick or a quote before the sentence keeps it unread.
function gluedFirstLine(lines) {
  for (const raw of lines) {
    if (FENCE.test(raw)) return undefined
    const line = raw.replace(/^[\s#*_`]+/, '')
    if (line === '') continue
    if (line.startsWith('>') || LIST_ITEM.test(raw) || INDENTED.test(raw)) return undefined
    return GLUED.exec(raw.replace(/^[\s#*_]+/, ''))?.[1]
  }
  return undefined
}

// Person-facing lines (English keys; the client translates them, i18n.js and the pt-BR locale).
export const REVIEW_GUARD_COPY = Object.freeze({
  label: 'Review guard',
  tick: 'Hold work until the reviewer answers the plan',
  tickNote: 'On by default. You can turn it off later in Details.',
  hard: "Work waits for {reviewer}'s verdict on the plan: file changes, commands and messages to other Bots are refused until it answers.",
  asks: 'Held only for the steps Claude Code asks about. Its own allow rules, hooks and saved approvals can let a step run before the guard sees it, and that step may still show as refused.',
  level: 'Not held at this level: nothing asks before acting. Only the delivery mark shows unreviewed work.',
  agent: 'Not held on this agent: its own tools run without asking. Only the delivery mark shows unreviewed work.',
  scope: "Held only in this Bot's own chat and the subagents it starts there. Its scheduled tasks that open a new conversation and its Omni automation runs that open their own conversation are not held.",
  gone: 'Its reviewer is no longer on the team: work stays held until you turn this off.',
  noReviewer: 'Off: {name} has no reviewer Bot on the team, so there is no verdict to wait for.',
  stop: "the review guard waits for the reviewer's verdict on the plan; you can turn it off in Details",
  upgrade: "The review guard is now on for {name}: its work waits for its reviewer's verdict on the plan. You can turn it off in Details.",
  card: 'The review guard is on: change the model in Settings, not here.',
  waiting: "Waiting for {reviewer}'s verdict on the plan since {time}.",
  stopRequest: "the review guard waits for the reviewer's verdict on a new plan, because another Bot sent a new request; you can turn it off in Details",
})

/**
 * How far the review guard holds on a Bot's route (PLAN-D15 §5): 'hard' when its calls are DSH
 * tools (a DSH model, or an ACP agent with native tools off); 'asks' on Claude Code's own tools at
 * a level that asks first; 'level' on Claude Code's own tools at Full access or Auto, where nothing
 * asks; 'agent' where the agent's own tools never ask (Codex, omp, a Codex model that keeps them,
 * Antigravity, Hermes).
 * @param {object} bot - the Bot as the view has it (`nativeToolsBlock` included).
 * @param {'full'|'auto'|'ask'} level - the Bot's level: Full access, Auto, or one that asks.
 * @returns {'hard'|'asks'|'level'|'agent'} the reach.
 */
export function reviewGuardReach(bot, level) {
  const remote = ref => typeof ref === 'string' && ref.startsWith('hermes-remote/')
  if (remote(bot?.model) || remote(bot?.appliedModel)) return 'agent'
  const mark = effectiveMarkOf(bot)
  if (mark === 'acp-antigravity' || mark === 'acp-hermes') return 'agent'
  if (bot?.nativeToolsBlock === 'model-kept') return 'agent'
  if (bot?.nativeToolsBlock !== undefined || !nativeToolsOn(bot)) return 'hard'
  if (mark === 'acp-claude') return level === 'full' || level === 'auto' ? 'level' : 'asks'
  return 'agent'
}
