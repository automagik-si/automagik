// Question rows and their answers (RFC 0015, "Input", questions and pickers). Ours. A question
// row gets options to tap only when all hold, as an approval's buttons do (approve.js):
//   1. herdr-core reports blocked with kind question;
//   2. the agent's question dialog is a selector answered with key steps
//      (shouldStepNativeChatAskAnswer) and its keys were probed: Claude Code only (2.1.319, below).
//      Codex and OpenCode step too, but their keys were never recorded, so they get "Answer in the
//      terminal" rather than a guess; omp's questions cannot be answered by keys at all;
//   3. the transcript has exactly one open AskUserQuestion call, asking exactly one question with
//      2 to 8 options (Claude Code asks 2 to 4; one digit must reach "Type something", N+1).
// The row shows that call's question and option labels from the transcript, never the screen's.
//
// Keys, as probed on Claude Code 2.1.319, every key its own send:
//   single-select  the option's digit alone (no Enter: the digit answers);
//   free text      digit N+1 ("Type something"), then the text and Enter (terminal.send, forced:
//                  the program is blocked on purpose; herdr-core pastes, then presses Enter);
//   multi-select   each chosen digit (toggles), then Right (to Submit), then Enter.
// Free text is offered on a single-select only: a multi-select's free text was not probed.
//
// What an answer guarantees: before each step, the status, the open calls and the screen are read
// again (one call, same turn, still blocked with kind question, and the question's text and every
// option label in the bottom rows), and nothing more is pressed at a mismatch. The screen check
// is text present, not a recorded layout (no question screen was recorded), and the last Enter of
// a multi-select checks status and call only: after Right the screen shows Submit, not the
// options. Between steps, herdr-core's report of where the key went in must still be blocked at
// the same turn. As with approvals, herdr-core types after its quiet rule and keys have no `if`.
import { NATIVE_CHAT_SUBMIT_DELAY_MS, resolveNativeChatTranscriptAgent, shouldStepNativeChatAskAnswer } from './answer.js'
import { bottomRows } from './dialog.js'
import { cleanChatText } from './paste.js'
import { MAX_SEND_BYTES } from './input.js'
import { VERIFY_MS } from './approve.js'

export const QUESTION_TOOL = 'AskUserQuestion'
/** The choice that types free text (with the answer's `text`). */
export const OTHER = 'other'
/** One digit must reach every option and "Type something" (N+1). */
const MAX_OPTIONS = 8
const realTimers = { setTimeout, clearTimeout }
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

/** Agents whose question keys were probed (above). */
function keyedAgent(agent) {
  return shouldStepNativeChatAskAnswer(agent) && resolveNativeChatTranscriptAgent(agent) === 'claude'
}

/** The one question an AskUserQuestion input asks, or null when it is not exactly one readable one. */
function oneQuestion(input) {
  let v = input
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return null } }
  const qs = v && typeof v === 'object' ? v.questions : null
  if (!Array.isArray(qs) || qs.length !== 1) return null
  const q = qs[0]
  if (!q || typeof q.question !== 'string' || !norm(q.question) || !Array.isArray(q.options)) return null
  const options = q.options.map((o) => (typeof o === 'string' ? o : o?.label))
  if (options.length < 2 || options.length > MAX_OPTIONS || !options.every((o) => typeof o === 'string' && norm(o))) return null
  return { prompt: q.question, options, multi: q.multiSelect === true }
}

/**
 * Where a question stands, from facts read now (approve.js's facts).
 * @returns {null | { call: { id: string } | null, prompt: string, options: string[], multi: boolean, why: string | null }}
 *   null when no question is open (not blocked, or blocked on an approval)
 */
export function questionState({ agent, status, openCalls }) {
  if (status?.state !== 'blocked' || status.kind === 'permission') return null
  const none = (why) => ({ call: null, prompt: status.msg ?? '', options: [], multi: false, why })
  if (status.kind !== 'question' || !keyedAgent(agent)) return none('answer-in-terminal')
  const calls = (openCalls ?? []).filter((c) => c.tool === QUESTION_TOOL)
  if (calls.length !== 1) return none(calls.length ? 'several-open-calls' : 'no-open-call')
  const q = oneQuestion(calls[0].input)
  if (!q) return none('answer-in-terminal')
  return { call: { id: calls[0].id }, ...q, why: null }
}

/** The question row for a state, for both clients. Its id names the open call, as an approval's does. */
export function questionRow(state, { turn, segment = 0 }) {
  const answerable = !!state.call && !state.why
  return {
    id: state.call ? `question:${state.call.id}` : `question:${turn}`,
    segment, turn, at: null, source: 'status', kind: 'question',
    prompt: state.prompt, options: answerable ? state.options : [], multi: answerable && state.multi,
    answerable, call: state.call?.id ?? null, open: true,
    ...(state.why ? { why: state.why } : {})
  }
}

/** The question and every option label are drawn in the bottom rows (text present: see above). */
export function questionShown(screen, state) {
  const shown = norm(bottomRows(screen).join(' '))
  return [state.prompt, ...state.options].every((t) => shown.includes(norm(t)))
}

/**
 * The steps that answer `choice` (a 1-based digit, digits joined by "," on a multi-select, or
 * OTHER with `text`), or null for a choice the row does not allow.
 * @returns {null | { keys?: string[], text?: string, screen: boolean }[]}
 */
export function questionSteps(state, choice, text) {
  const n = state.options.length
  const digit = (d) => /^[1-9]$/.test(d) && Number(d) <= n
  if (choice === OTHER) {
    if (state.multi || typeof text !== 'string') return null
    // One line, as typed: a newline would submit early, a control character is never typed.
    if (/[\r\n]/.test(text)) return null
    const cleaned = cleanChatText(text)
    const clean = cleaned.ok ? cleaned.text.trim() : ''
    // Nothing cleaned away: what is typed is what the person wrote.
    if (!clean || clean !== text.trim() || Buffer.byteLength(clean, 'utf8') > MAX_SEND_BYTES) return null
    return [{ keys: [String(n + 1)], screen: true }, { text: clean, screen: true }]
  }
  if (typeof choice !== 'string') return null
  if (!state.multi) return digit(choice) ? [{ keys: [choice], screen: true }] : null
  const picked = choice.split(',')
  if (!picked.length || !picked.every(digit) || new Set(picked).size !== picked.length) return null
  return [...picked.map((d) => ({ keys: [d], screen: true })), { keys: ['right'], screen: true }, { keys: ['enter'], screen: false }]
}

/**
 * Answer a question row the person tapped: each step only while the same question is open.
 * @param {{ hc: any, address: string, rowId: string, choice: string, text?: string, read(): Promise<any>,
 *   timers?: typeof realTimers, stepMs?: number, verifyMs?: number, note?: object }} a
 *   note: filled for the bridge's log line, as answerApproval's (typed, final)
 * @returns {Promise<{ ok: true, pressed: 'done' | 'uncertain', sent: true } | { ok: false, reason: string, sent?: true }>}
 *   reason 'stopped': some keys went in, then the question moved on; finish in the terminal
 */
export async function answerQuestion({ hc, address, rowId, choice, text, read, timers = realTimers, stepMs = NATIVE_CHAT_SUBMIT_DELAY_MS, verifyMs = VERIFY_MS, note = {} }) {
  let facts
  try { facts = await read() } catch { return { ok: false, reason: 'unavailable' } }
  note.final = { state: facts.status?.state, kind: facts.status?.kind, turn: facts.status?.turn }
  const first = questionState(facts)
  if (!first) return { ok: false, reason: 'closed' }
  if (!first.call || first.why || questionRow(first, { turn: 0 }).id !== rowId) return { ok: false, reason: 'changed' }
  const steps = questionSteps(first, choice, text)
  if (!steps) return { ok: false, reason: 'choice' }
  const turn = facts.status.turn
  let typed = null
  for (const [i, step] of steps.entries()) {
    const sent = i > 0
    const stop = (reason) => (sent ? { ok: false, reason: 'stopped', sent: true } : { ok: false, reason })
    if (sent) {
      await new Promise((r) => timers.setTimeout(r, stepMs))
      try { facts = await read() } catch { return stop('unavailable') }
      note.final = { state: facts.status?.state, kind: facts.status?.kind, turn: facts.status?.turn }
      const now = questionState(facts)
      if (!now?.call || now.why || now.call.id !== first.call.id || facts.status.turn !== turn) return stop('changed')
      // herdr-core's report of the last step: it went in at this question's status and turn.
      if ((typeof typed?.status === 'string' && typed.status !== 'blocked') || (typeof typed?.turn === 'number' && typed.turn !== turn)) return stop('changed')
    }
    if (step.screen && !questionShown(facts.screen, first)) return stop('changed')
    try {
      typed = step.text !== undefined
        ? await hc.call('terminal.send', { terminal: address, text: step.text, force: true, caller: null })
        : await hc.call('terminal.keys', { terminal: address, keys: step.keys, caller: null })
    } catch (e) { return { ok: false, reason: e?.kind ?? 'unavailable', sent: true } }
    note.typed = { status: typed?.status, turn: typed?.turn }
  }
  if ((typeof typed?.status === 'string' && typed.status !== 'blocked') || (typeof typed?.turn === 'number' && typeof turn === 'number' && typed.turn !== turn)) {
    return { ok: true, pressed: 'uncertain', sent: true }
  }
  // As an approval: see the question go, or say it is not known yet.
  const deadline = Date.now() + verifyMs
  for (;;) {
    let t
    try { t = await hc.call('terminal.get', { terminal: address }) } catch { break }
    note.final = { state: t?.status?.state, kind: t?.status?.kind, turn: t?.turn }
    if (t?.status?.state !== 'blocked') return { ok: true, pressed: 'done', sent: true }
    if (Date.now() >= deadline) break
    await new Promise((r) => timers.setTimeout(r, 250))
  }
  return { ok: true, pressed: 'uncertain', sent: true }
}
