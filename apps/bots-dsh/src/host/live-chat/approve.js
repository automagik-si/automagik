// Approval rows and their answers (RFC 0015, "Input", approvals). Ours. Text on a screen can be
// anyone's (a tool's output can print a fake dialog), so a row gets buttons only when all hold:
//   1. herdr-core reports blocked with kind permission;
//   2. the dialog is read from the very bottom of the screen (dialog.js), for an agent with a
//      reader and a key map (Claude; Codex and omp asked for nothing when recorded);
//   3. the transcript has exactly one open tool call with the dialog's tool, and when that call's
//      input names a command, it is the dialog's command; the status message's tool, when it
//      names one, is the dialog's tool too.
// The row shows that call's input from the transcript, never the screen's text. Allow-always is
// never offered (no fixed key for it). The engine never answers on its own.
//
// What an answer guarantees: just before the key, the status, the screen and the open calls are
// read again, and nothing is pressed if the question changed. What it cannot: herdr-core types the
// key only after ~3 s of quiet, and terminal.keys has no `if`, so the dialog can change in that
// gap (someone answering in the terminal or the Automagik window at the same moment, so the key
// lands on the next dialog). The engine allows one answer at a time and one per call (engine.js),
// and reports 'uncertain' when herdr-core says the key went in at another status or turn.
import { approvalKeys } from './answer.js'
import { readDialog, statusTool } from './dialog.js'
import { preview, toolSummary, INPUT_PREVIEW } from './rows.js'

/** How long after a press herdr-core may take to type it (its ~3 s quiet rule) and the dialog to go. */
export const VERIFY_MS = 5000
const realTimers = { setTimeout, clearTimeout }
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

/** The command a call's input names, if any (Claude's `command`, Codex's arguments JSON). */
function commandOf(input) {
  let v = input
  if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return null } }
  const c = v && typeof v === 'object' ? v.command ?? v.cmd : null
  if (Array.isArray(c)) return norm(c.filter((x) => typeof x === 'string').join(' '))
  return typeof c === 'string' ? norm(c) : null
}

/**
 * Where an approval stands, from facts read now.
 * @param {{ agent: string | null, status: { state: string, kind: string | null, msg: string, turn: number },
 *   screen: string, openCalls: { id: string, tool: string, input: unknown }[] }} facts
 * @returns {null | { tool: string, call: { id: string, input: unknown } | null, choices: string[], why: string | null }}
 *   null when no approval is open (not blocked with kind permission)
 */
export function approvalState({ agent, status, screen, openCalls }) {
  if (status?.state !== 'blocked' || status.kind !== 'permission') return null
  const named = statusTool(status.msg)
  const none = (why) => ({ tool: named ?? '', call: null, choices: [], why })
  const keys = approvalKeys(agent)
  const dialog = keys ? readDialog(agent, screen) : null
  if (!dialog) return none('answer-in-terminal')
  if (named && named !== dialog.tool) return none('tool-mismatch')
  const calls = openCalls.filter((c) => c.tool === dialog.tool)
  if (calls.length !== 1) return { ...none(calls.length ? 'several-open-calls' : 'no-open-call'), tool: dialog.tool }
  const call = calls[0]
  const command = commandOf(call.input)
  if (command !== null && command !== norm(dialog.command)) return { ...none('command-mismatch'), tool: dialog.tool }
  return { tool: dialog.tool, call: { id: call.id, input: call.input }, choices: ['allow', 'deny'], why: null }
}

/**
 * The approval row for a state (approvalState), for both clients. Its id names the open call, so
 * an answer to it cannot land on a later question.
 */
export function approvalRow(state, { turn, segment = 0 }) {
  const call = state.call
  return {
    id: call ? `approval:${call.id}` : `approval:none:${turn}`,
    segment, turn, at: null, source: 'status', kind: 'approval',
    tool: state.tool,
    summary: call ? toolSummary(state.tool, call.input) : '',
    input: call ? preview(call.input, INPUT_PREVIEW) : '',
    call: call?.id ?? null,
    choices: state.choices,
    open: true,
    ...(state.why ? { why: state.why } : {})
  }
}

/**
 * Answer an approval row the person tapped. `read()` gives the facts fresh (terminal.get,
 * terminal.read, the transcript's open calls). Keys are pressed only when the row still matches.
 * @param {{ hc: any, address: string, rowId: string, choice: string, read(): Promise<any>,
 *   timers?: typeof realTimers, verifyMs?: number, note?: object }} a
 *   note: filled for the bridge's log line: typed (herdr-core's status and turn when the key went
 *   in) and final (the last status read: state, kind, turn)
 * @returns {Promise<{ ok: true, pressed: 'done' | 'uncertain', sent: true } | { ok: false, reason: string, sent?: true }>}
 *   sent: terminal.keys was called, whatever came back (a timeout may still have typed the key)
 */
export async function answerApproval({ hc, address, rowId, choice, read, timers = realTimers, verifyMs = VERIFY_MS, note = {} }) {
  let facts
  try { facts = await read() } catch { return { ok: false, reason: 'unavailable' } }
  note.final = { state: facts.status?.state, kind: facts.status?.kind, turn: facts.status?.turn }
  const state = approvalState(facts)
  if (!state) return { ok: false, reason: 'closed' }
  if (!state.call || approvalRow(state, { turn: 0 }).id !== rowId) return { ok: false, reason: 'changed' }
  if (!state.choices.includes(choice)) return { ok: false, reason: 'choice' }
  const keys = approvalKeys(facts.agent)?.[choice]
  if (!keys) return { ok: false, reason: 'choice' }
  let typed
  try {
    typed = await hc.call('terminal.keys', { terminal: address, keys, caller: null })
  } catch (e) { return { ok: false, reason: e?.kind ?? 'unavailable', sent: true } }
  note.typed = { status: typed?.status, turn: typed?.turn }
  // herdr-core says when the key went in: not at that dialog's status and turn, it may have
  // answered something else.
  if ((typeof typed?.status === 'string' && typed.status !== 'blocked') ||
      (typeof typed?.turn === 'number' && typeof facts.status?.turn === 'number' && typed.turn !== facts.status.turn)) {
    return { ok: true, pressed: 'uncertain', sent: true }
  }
  // herdr-core types the key after its quiet rule: see the dialog go, or say it is not known yet.
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
