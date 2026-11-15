// What the transcript decoders share, ported from Orca (github.com/stablyai/orca at e1dfc022, MIT,
// (c) 2026 Lovecast Inc.; see LICENSE-upstream and UPSTREAM.md). Only the functions the decoders
// call are taken, each from the upstream file named above it, behaviour unchanged except where a
// "Changed:" note says so.

/** @typedef {import('./types.js').NativeChatBlock} NativeChatBlock */
/** @typedef {import('./types.js').NativeChatTextBlock} NativeChatTextBlock */
/** @typedef {import('./types.js').NativeChatToolResultBlock} NativeChatToolResultBlock */
/** @typedef {import('./types.js').NativeChatImageRefBlock} NativeChatImageRefBlock */

// --- src/main/ai-vault/session-scanner-record-value.ts

/** @param {unknown} value @returns {Record<string, unknown> | null} */
export function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null
}

// --- src/main/ai-vault/session-scanner-values.ts

/** @param {unknown} value @returns {number} */
export function timestampMs(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.NaN
  }
  return value > 1_000_000_000_000 ? value : value * 1000
}

/** @param {string} line @returns {Record<string, unknown> | null} */
export function parseJsonObject(line) {
  if (!line.trim()) {
    return null
  }
  try {
    return asRecord(JSON.parse(line))
  } catch {
    return null
  }
}

/** @param {unknown} value @returns {string | null} */
export function extractString(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The `parseTimestamp` each upstream decoder defines privately, shared here.
 * @param {unknown} value @returns {number | null}
 */
export function parseTimestamp(value) {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

// --- src/main/native-chat/transcript-record-blocks.ts

/** @param {unknown} value @returns {string} */
export function toolResultOutput(value) {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    const record = asRecord(value)
    if (record) {
      const text = extractString(record.text) ?? extractString(record.content)
      if (text) {
        return text
      }
    }
    return value === undefined || value === null ? '' : JSON.stringify(value)
  }
  /** @type {string[]} */
  const parts = []
  for (const item of value) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    const record = asRecord(item)
    const text = extractString(record?.text) ?? extractString(record?.content)
    if (text) {
      parts.push(text)
    }
  }
  return parts.join('\n')
}

/** @param {unknown} content @returns {NativeChatBlock[]} */
export function claudeContentBlocks(content) {
  if (typeof content === 'string') {
    const text = content.trim()
    return text ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  /** @type {NativeChatBlock[]} */
  const blocks = []
  for (const item of content) {
    if (typeof item === 'string') {
      if (item.trim()) {
        blocks.push({ type: 'text', text: item })
      }
      continue
    }
    const record = asRecord(item)
    if (!record) {
      continue
    }
    const block = claudeContentBlock(record)
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

/** @param {Record<string, unknown>} record @returns {NativeChatBlock | null} */
function claudeContentBlock(record) {
  switch (record.type) {
    case 'text': {
      const text = extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'thinking': {
      // Reasoning uses text blocks; message role carries its classification.
      const text = extractString(record.thinking) ?? extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'tool_use': {
      const name = extractString(record.name) ?? 'tool'
      const callId = extractString(record.id)
      return { type: 'tool-call', name, input: record.input, ...(callId ? { callId } : {}) }
    }
    case 'tool_result':
      return toolResultBlock(record)
    case 'image':
      return imageRefBlock(record)
    default:
      return null
  }
}

/** @param {Record<string, unknown>} record @returns {NativeChatToolResultBlock} */
function toolResultBlock(record) {
  const callId = extractString(record.tool_use_id)
  return {
    type: 'tool-result',
    output: toolResultOutput(record.content),
    ...(callId ? { callId } : {}),
    ...(record.is_error === true ? { isError: true } : {})
  }
}

/** @param {Record<string, unknown>} record @returns {NativeChatImageRefBlock | null} */
function imageRefBlock(record) {
  const source = asRecord(record.source)
  const url = extractString(source?.url) ?? extractString(record.url)
  const path = extractString(record.path)
  const alt = extractString(record.alt) ?? undefined
  if (!url && !path) {
    return null
  }
  return {
    type: 'image-ref',
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(alt ? { alt } : {})
  }
}

// --- src/shared/claude-pasted-content.ts

/**
 * Claude wraps a whole pasted text block; prose around it is still literal user text.
 * @param {string} text @returns {string}
 */
export function unwrapClaudePastedContent(text) {
  const trimmed = text.trim()
  const open = /^<pasted_content(?: id="([^"<>\r\n]{1,64})")?>\r?\n/.exec(trimmed)
  if (!open) {
    return text
  }
  const close = open[1] ? `</pasted_content id="${open[1]}">` : '</pasted_content>'
  if (!trimmed.endsWith(close)) {
    return text
  }
  const body = trimmed.slice(open[0].length, -close.length)
  // Why: the id is what lets pasted text carry literal tags; only a same-id tag is ambiguous.
  const ambiguous = open[1]
    ? body.includes(close) || body.includes(`<pasted_content id="${open[1]}">`)
    : body.includes('<pasted_content') || body.includes('</pasted_content')
  if (!body.endsWith('\n') || ambiguous) {
    return text
  }
  return body.slice(0, body.endsWith('\r\n') ? -2 : -1)
}

/** @param {NativeChatBlock} block @returns {NativeChatBlock} */
export function unwrapClaudePastedContentBlock(block) {
  if (block.type !== 'text') {
    return block
  }
  const text = unwrapClaudePastedContent(block.text)
  return text === block.text ? block : { ...block, text }
}

// --- src/shared/claude-bash-input.ts

const BASH_INPUT = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/

/**
 * Claude strips ! inside <bash-input>; restore the typed command, returning null for other text.
 * @param {string} text @returns {string | null}
 */
export function claudeBashInputAsTypedCommand(text) {
  const command = BASH_INPUT.exec(text)?.[1]
  return command === undefined || command.includes('<bash-input>') ? null : `!${command}`
}

/** @param {NativeChatBlock} block @returns {NativeChatBlock} */
export function unwrapClaudeBashInputBlock(block) {
  if (block.type !== 'text') {
    return block
  }
  const typed = claudeBashInputAsTypedCommand(block.text)
  return typed === null ? block : { ...block, text: typed }
}

// --- src/main/native-chat/transcript-turn-markers.ts

/** @param {Record<string, unknown>} record @returns {string | undefined} */
export function claudeInterruptedMessageId(record) {
  if (record.type !== 'user') {
    return undefined
  }
  return extractString(record.interruptedMessageId) ?? undefined
}

export const CODEX_EVENT_TURN_STARTED = 'task_started'
export const CODEX_EVENT_TURN_COMPLETE = 'task_complete'
export const CODEX_EVENT_TURN_ABORTED = 'turn_aborted'

// --- src/main/claude/claude-stop-hook-feedback.ts, with what it calls from
// src/shared/agent-session/journal/agent-session-hook-outcome.ts (hookOutcomeRowBody, 'sent-back')
// and src/shared/agent-session/view/structured-agent-session-status-block.ts.
// Changed: the journal row and its status block are folded into one function that returns the
// text block directly. Orca's status block also copies failure, stop and provider-frame facts; a
// Stop hook row never carries them, so the block is the same.

// Claude injects a blocking Stop hook's reason as a meta user turn; exit-2 hooks prefix it with their command.
const STOP_HOOK_FEEDBACK = /^Stop hook feedback:\n/
/** A Stop hook sent the agent back to work, so the reply before this row was an answer. */
export const AGENT_SESSION_HOOK_SENT_BACK_PRESENTATION = 'hook-sent-back'

/**
 * The status block for Claude's injected Stop-hook feedback text, or null for any other text.
 * @param {string} text @returns {NativeChatTextBlock | null}
 */
export function claudeStopHookFeedbackBlock(text) {
  if (!STOP_HOOK_FEEDBACK.test(text)) {
    return null
  }
  const reason = text.replace(STOP_HOOK_FEEDBACK, '').replace(/^\[[^\]\n]+\]: /gm, '')
  const header = 'Stop hook feedback'
  const lines = [reason].map((detail) => detail.trim()).filter((detail) => detail.length > 0)
  return {
    type: 'text',
    text:
      lines.length === 0
        ? `${header}.`
        : lines.length === 1
          ? `${header}: ${lines[0]}`
          : [header, ...lines].join('\n'),
    presentation: AGENT_SESSION_HOOK_SENT_BACK_PRESENTATION,
    tone: 'warning'
  }
}

// --- src/shared/native-chat/transcript/native-chat-image-transcript-markers.ts

// Keep whitespace and path starts disjoint so incomplete markers cannot rescan their suffix.
const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(\S.*?|[^\S\r\n\u2028\u2029])\]\s*$/

/** @param {string} text @returns {string | null} */
export function imageSourcePathFromText(text) {
  return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null
}

// --- src/shared/native-chat/native-chat-notice.ts (the one string the decoders use)

export const NATIVE_CHAT_NOTICE_COPY = Object.freeze({ compaction: 'Context compacted' })

// --- src/shared/image-data-uri.ts
// Changed: Orca also drops a raster image whose header proves it oversized
// (raster-image-base64-preview.ts), to bound its renderer's decode memory. Our clients never
// decode or load an image by themselves (RFC 0015, "Rendering"), so that check is not taken.

/**
 * Share desktop/mobile image data URIs; remove line-wrapped base64 whitespace and reject
 * empty/non-image payloads.
 * @param {string | undefined} mimeType @param {string} base64Content @returns {string | null}
 */
export function buildImageDataUri(mimeType, base64Content) {
  if (!mimeType?.startsWith('image/')) {
    return null
  }
  const cleaned = base64Content.replace(/\s/g, '')
  if (!cleaned) {
    return null
  }
  return `data:${mimeType};base64,${cleaned}`
}
