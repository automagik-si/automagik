// The chat's types. Two parts:
//
// 1. Orca's, ported (github.com/stablyai/orca at e1dfc022, MIT, (c) 2026 Lovecast Inc.; see
//    LICENSE-upstream and UPSTREAM.md) from src/shared/native-chat/native-chat-types.ts and
//    src/shared/agent-status-types.ts, only the parts the decoders produce: what a transcript line
//    decodes to (NativeChatMessage and its blocks), the turn lifecycle, the session status and the
//    sources. Fields Orca's structured sessions and renderer add are left out.
// 2. Ours: RFC 0015's row model ("The row model"), which the engine (delivery 3) builds from
//    decoded messages, herdr-core's status and the screen, and which both clients render.

// ---------------------------------------------------------------- 1. Orca's

export const NATIVE_CHAT_SOURCES = Object.freeze(/** @type {const} */ (['transcript', 'hook', 'scrape']))
/** @typedef {'transcript' | 'hook' | 'scrape'} NativeChatSource */

/** Higher source authority wins deduplication of the same turn. */
export const NATIVE_CHAT_SOURCE_PRIORITY = Object.freeze({ transcript: 3, hook: 2, scrape: 1 })

export const NATIVE_CHAT_ROLES = Object.freeze(
  /** @type {const} */ (['user', 'assistant', 'tool', 'reasoning', 'system'])
)
/** @typedef {'user' | 'assistant' | 'tool' | 'reasoning' | 'system'} NativeChatRole */

/**
 * @typedef {object} NativeChatTextBlock
 * @property {'text'} type
 * @property {string} text
 * @property {string} [presentation]  display hint ('compaction', 'hook-sent-back'); readers narrow the values they know
 * @property {string} [tone]          'warning' on hook rows
 */

/**
 * Tool arguments remain unknown because provider shapes differ; renderers preview the serialized payload.
 * @typedef {object} NativeChatToolCallBlock
 * @property {'tool-call'} type
 * @property {string} name
 * @property {unknown} input
 * @property {string} [callId]  provider-supplied identity within this item stream; absent on legacy transcripts
 */

/**
 * One resolved hunk from a provider's edit result, carrying true file ranges.
 * @typedef {object} NativeChatEditPatchHunk
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {string[]} lines  signed unified rows, as the provider emitted them
 */

/**
 * @typedef {object} NativeChatEditPatch
 * @property {string} [filePath]
 * @property {NativeChatEditPatchHunk[]} hunks
 */

/**
 * The result returned to the agent for a prior tool call.
 * @typedef {object} NativeChatToolResultBlock
 * @property {'tool-result'} type
 * @property {string} output
 * @property {boolean} [isError]
 * @property {string} [callId]  the call this result answers, when known; otherwise pairing is positional
 * @property {NativeChatEditPatch} [editPatch]
 */

/**
 * Local path or remote URL, exactly one populated; optional alt text.
 * @typedef {object} NativeChatImageRefBlock
 * @property {'image-ref'} type
 * @property {string} [path]
 * @property {string} [url]
 * @property {string} [alt]
 */

/** @typedef {NativeChatTextBlock | NativeChatToolCallBlock | NativeChatToolResultBlock | NativeChatImageRefBlock} NativeChatBlock */

/**
 * The API's accounting on one assistant response (agent-session-context-usage.ts). No prices.
 * @typedef {object} AgentSessionTokenUsage
 * @property {number} inputTokens
 * @property {number} cacheCreationInputTokens
 * @property {number} cacheReadInputTokens
 * @property {number} outputTokens
 */

/**
 * @typedef {object} NativeChatMessage
 * @property {string} id                 stable dedup/list identity across re-reads and appends
 * @property {NativeChatRole} role
 * @property {NativeChatBlock[]} blocks
 * @property {number | null} timestamp   epoch ms; null when unavailable
 * @property {NativeChatSource} source
 * @property {string} [model]            model id that produced an assistant response
 * @property {string} [provider]         the agent's provider that served `model`
 * @property {AgentSessionTokenUsage} [usage]
 * @property {string} [parentId]         provider conversation-tree predecessor id
 */

export const NATIVE_CHAT_TURN_LIFECYCLE_STATES = Object.freeze(
  /** @type {const} */ (['working', 'completed', 'interrupted'])
)

export const NATIVE_CHAT_INTERRUPTED_STATUS_TEXT = 'Conversation interrupted'

/**
 * Replay-safe provider completion/interruption evidence recovered from transcripts.
 * @typedef {object} NativeChatTurnLifecycle
 * @property {'working' | 'completed' | 'interrupted'} state
 * @property {string} turnId           stable provider id when available, otherwise the record position
 * @property {number | null} timestamp
 */

export const NATIVE_CHAT_SESSION_STATUSES = Object.freeze(
  /** @type {const} */ (['loading', 'ready', 'working', 'empty', 'error'])
)
/** @typedef {'loading' | 'ready' | 'working' | 'empty' | 'error'} NativeChatSessionStatus */

/** Orca's agent status states (agent-status-types.ts); herdr-core's are STATUS_STATES below. */
export const AGENT_STATUS_STATES = Object.freeze(
  /** @type {const} */ (['working', 'blocked', 'waiting', 'done'])
)
/** Custom nonempty agent names are accepted. @typedef {string} AgentType */

/** @param {NativeChatBlock} block @returns {block is NativeChatTextBlock} */
export const isTextBlock = (block) => block.type === 'text'
/** @param {NativeChatBlock} block @returns {block is NativeChatToolCallBlock} */
export const isToolCallBlock = (block) => block.type === 'tool-call'
/** @param {NativeChatBlock} block @returns {block is NativeChatToolResultBlock} */
export const isToolResultBlock = (block) => block.type === 'tool-result'
/** @param {NativeChatBlock} block @returns {block is NativeChatImageRefBlock} */
export const isImageRefBlock = (block) => block.type === 'image-ref'

/**
 * Provider-authored interruption rows abandon in-flight tool calls without results.
 * @param {NativeChatMessage} message @returns {boolean}
 */
export function isInterruptedStatusMessage(message) {
  return (
    message.role === 'system' &&
    message.blocks.some(
      (block) => block.type === 'text' && block.text === NATIVE_CHAT_INTERRUPTED_STATUS_TEXT
    )
  )
}

// ---------------------------------------------------------------- 2. Ours (RFC 0015)

/**
 * Where a row came from, and its rank: within one turn a higher source replaces a lower one of
 * the same kind (RFC 0015, "Ranking and dedupe"). Orca's middle source is its hook server; ours is
 * herdr-core's status.
 */
export const ROW_SOURCE_RANK = Object.freeze({ transcript: 3, status: 2, screen: 1 })
/** @typedef {'transcript' | 'status' | 'screen'} RowSource */

export const ROW_KINDS = Object.freeze(
  /** @type {const} */ (['text', 'tool-call', 'tool-result', 'approval', 'question', 'status', 'tokens'])
)

/** herdr-core's `status.state`, and `status.kind` while blocked. */
export const STATUS_STATES = Object.freeze(/** @type {const} */ (['idle', 'working', 'done', 'blocked', 'error']))
export const BLOCKED_KINDS = Object.freeze(/** @type {const} */ (['permission', 'question', 'auth']))

/** Approval choices; `allow-always` only where the agent's key map has it at a fixed key. */
export const APPROVAL_CHOICES = Object.freeze(/** @type {const} */ (['allow', 'allow-always', 'deny']))

/**
 * Every row. `id` is stable: the transcript's own id, else `<file>:<line>`.
 * @typedef {object} RowBase
 * @property {string} id
 * @property {number} turn
 * @property {number | null} at       epoch ms
 * @property {RowSource} source
 */

/**
 * @typedef {RowBase & { kind: 'text', role: 'user' | 'assistant', text: string }} TextRow  text is markdown
 * @typedef {RowBase & { kind: 'tool-call', tool: string, summary: string, input: string }} ToolCallRow  input is a short preview
 * @typedef {RowBase & { kind: 'tool-result', call: string, ok: boolean, output: string }} ToolResultRow  call is the tool-call row's id
 * @typedef {RowBase & { kind: 'approval', tool: string, summary: string, choices: Array<'allow' | 'allow-always' | 'deny'>, open: boolean }} ApprovalRow
 * @typedef {RowBase & { kind: 'question', prompt: string, options: string[], multi: boolean, answerable: boolean,
 *   call?: string | null, open?: boolean, why?: string }} QuestionRow  options: labels, option 1 first (question.js)
 * @typedef {RowBase & { kind: 'status', state: string, msg: string }} StatusRow
 * @typedef {RowBase & { kind: 'tokens', input: number, output: number, cache: number, context?: number }} TokensRow
 * @typedef {TextRow | ToolCallRow | ToolResultRow | ApprovalRow | QuestionRow | StatusRow | TokensRow} Row
 */
