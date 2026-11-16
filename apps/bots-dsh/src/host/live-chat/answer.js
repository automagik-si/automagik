// How an approval, a question and an interrupt are answered with keys (RFC 0015, "Input").
// Ported from Orca (github.com/stablyai/orca at e1dfc022, MIT, (c) 2026 Lovecast Inc.; see
// LICENSE-upstream and UPSTREAM.md), behaviour unchanged:
//   src/shared/native-chat/native-chat-agent-support.ts (which agents can be answered how),
//   src/shared/native-chat/input/native-chat-approval-envelope.ts (the approval envelope),
//   src/shared/native-chat/input/native-chat-answer-stepping.ts (paced question steps).
// approvalKeys and the herdr-core key names at the end are ours.

// --- src/shared/native-chat/native-chat-agent-support.ts

/** @typedef {'claude' | 'codex' | 'grok' | 'omp' | 'opencode'} NativeChatTranscriptAgent */

/** @param {string | null | undefined} agent @returns {NativeChatTranscriptAgent | null} */
export function resolveNativeChatTranscriptAgent(agent) {
  // OpenClaude writes Claude transcripts but retains distinct launch/UI identity.
  if (agent === 'claude' || agent === 'openclaude') {
    return 'claude'
  }
  if (agent === 'opencode' || agent === 'opencode2' || agent === 'zcode') {
    return 'opencode'
  }
  if (agent === 'codex' || agent === 'grok' || agent === 'omp') {
    return agent
  }
  return null
}

/** Selector TUIs require key steps rather than pasted option labels. @param {string | null | undefined} agent */
export function shouldStepNativeChatAskAnswer(agent) {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return transcriptAgent === 'claude' || transcriptAgent === 'codex' || transcriptAgent === 'opencode'
}

/** OMP's configurable keys and existing checkbox state cannot be replaced through PTY input. @param {string | null | undefined} agent */
export function nativeChatAskRequiresTerminal(agent) {
  return resolveNativeChatTranscriptAgent(agent) === 'omp'
}

/**
 * OpenCode confirms an interrupt with a second Escape; Claude Code and Codex read Esc-Esc at an
 * idle prompt as rewind.
 * @param {string | null | undefined} agent
 */
export function nativeChatStopSendsSecondEscape(agent) {
  return resolveNativeChatTranscriptAgent(agent) === 'opencode'
}

/** @param {string | null | undefined} agent */
export function nativeChatApprovalAcceptKey(agent) {
  return resolveNativeChatTranscriptAgent(agent) === 'opencode' ? '\r' : '1'
}

// --- src/shared/native-chat/input/native-chat-approval-envelope.ts

const ESCAPE = String.fromCharCode(27)

/**
 * The facts in a status row's `{ approval: { tool, summary } }` envelope; callers own labels.
 * @typedef {{ tool: string, summary?: string, allowSend: string, denySend: string }} NativeChatApprovalEnvelope
 */

/**
 * Read the approval envelope published on PermissionRequest (delivery 8's hook).
 * @param {string | undefined | null} interactivePrompt @param {string} [agent]
 * @returns {NativeChatApprovalEnvelope | null}
 */
export function parseNativeChatApprovalEnvelope(interactivePrompt, agent) {
  if (!interactivePrompt) {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || !('approval' in parsed)) {
    return null
  }
  const approval = parsed.approval
  if (typeof approval !== 'object' || approval === null || !('tool' in approval)) {
    return null
  }
  const tool = approval.tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  const summary = 'summary' in approval ? approval.summary : undefined
  return {
    tool,
    ...(typeof summary === 'string' && summary.length > 0 ? { summary } : {}),
    allowSend: nativeChatApprovalAcceptKey(agent),
    denySend: ESCAPE
  }
}

// --- src/shared/native-chat/input/native-chat-answer-stepping.ts

export const NATIVE_CHAT_SUBMIT_DELAY_MS = 500
// Allow 500ms for the next question to render on slow machines or SSH before writing its body.
export const NATIVE_CHAT_ADVANCE_BUFFER_MS = 500
export const NATIVE_CHAT_QUESTION_STEP_MS = NATIVE_CHAT_SUBMIT_DELAY_MS + NATIVE_CHAT_ADVANCE_BUFFER_MS

/** @param {number} index @returns {{ bodyAt: number, enterAt: number }} */
export function nativeChatQuestionOffsets(index) {
  const bodyAt = index * NATIVE_CHAT_QUESTION_STEP_MS
  return { bodyAt, enterAt: bodyAt + NATIVE_CHAT_SUBMIT_DELAY_MS }
}

/**
 * Schedule one body and one Enter per question; callers own the actual transport.
 * @param {readonly string[]} lines @param {(line: string) => void} writeBody @param {() => void} writeEnter
 * @param {{ setTimeout: typeof setTimeout }} [timers]
 */
export function scheduleNativeChatAnswer(lines, writeBody, writeEnter, timers = globalThis) {
  const handles = []
  lines.forEach((line, index) => {
    const { bodyAt, enterAt } = nativeChatQuestionOffsets(index)
    handles.push(timers.setTimeout(() => writeBody(line), bodyAt))
    handles.push(timers.setTimeout(writeEnter, enterAt))
  })
  return handles
}

// --- ours: the same keys as herdr-core terminal.keys names

/** Orca's TUI answer bytes as herdr-core key names. */
const KEY_NAMES = { '1': '1', '\r': 'enter', [ESCAPE]: 'esc' }

/**
 * The keys that answer an agent's approval dialog, or null for an agent with no known map
 * (its dialog gets "Answer in the terminal"). No allow-always: Orca's map has no fixed key for
 * it, and a number read from the screen is never pressed (RFC 0015).
 * @param {string | null | undefined} agent
 * @returns {{ allow: string[], deny: string[] } | null}
 */
export function approvalKeys(agent) {
  if (!resolveNativeChatTranscriptAgent(agent)) return null
  return { allow: [KEY_NAMES[nativeChatApprovalAcceptKey(agent)]], deny: [KEY_NAMES[ESCAPE]] }
}
