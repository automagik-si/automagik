// Claude Code transcript lines to chat messages. Ported from Orca
// (github.com/stablyai/orca at e1dfc022, MIT, (c) 2026 Lovecast Inc.; see LICENSE-upstream and
// UPSTREAM.md): src/main/native-chat/transcript-line-decoders-claude.ts, behaviour unchanged.
// The output is Orca's NativeChatMessage; the engine maps it to RFC 0015's rows.
import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from './types.js'
import {
  asRecord,
  claudeContentBlocks,
  claudeInterruptedMessageId,
  claudeStopHookFeedbackBlock,
  extractString,
  imageSourcePathFromText,
  parseJsonObject,
  parseTimestamp,
  unwrapClaudeBashInputBlock,
  unwrapClaudePastedContentBlock
} from './decode-shared.js'

/** @typedef {import('./types.js').NativeChatBlock} NativeChatBlock */
/** @typedef {import('./types.js').NativeChatMessage} NativeChatMessage */
/** @typedef {import('./types.js').NativeChatEditPatch} NativeChatEditPatch */
/** @typedef {import('./types.js').NativeChatEditPatchHunk} NativeChatEditPatchHunk */

const MAX_EDIT_PATCH_HUNKS = 40
const MAX_EDIT_PATCH_HUNK_LINES = 400

/**
 * Render resolved result hunks; call-side snippet pairs cannot supply real file line numbers.
 * @param {Record<string, unknown>} record @returns {NativeChatEditPatch | null}
 */
function claudeEditPatch(record) {
  const result = asRecord(record.toolUseResult)
  const raw = result?.structuredPatch
  if (!Array.isArray(raw) || raw.length === 0) {
    return null
  }
  /** @type {NativeChatEditPatchHunk[]} */
  const hunks = []
  for (const entry of raw.slice(0, MAX_EDIT_PATCH_HUNKS)) {
    const hunk = asRecord(entry)
    const lines = hunk?.lines
    if (
      typeof hunk?.oldStart !== 'number' ||
      typeof hunk.newStart !== 'number' ||
      !Array.isArray(lines)
    ) {
      continue
    }
    hunks.push({
      oldStart: hunk.oldStart,
      oldLines: typeof hunk.oldLines === 'number' ? hunk.oldLines : 0,
      newStart: hunk.newStart,
      newLines: typeof hunk.newLines === 'number' ? hunk.newLines : 0,
      lines: lines
        .slice(0, MAX_EDIT_PATCH_HUNK_LINES)
        .flatMap((line) => (typeof line === 'string' ? [line] : []))
    })
  }
  if (hunks.length === 0) {
    return null
  }
  const filePath = extractString(result?.filePath)
  return { ...(filePath ? { filePath } : {}), hunks }
}

/** @param {NativeChatBlock[]} blocks @param {NativeChatEditPatch} patch @returns {NativeChatBlock[]} */
function withEditPatch(blocks, patch) {
  let attached = false
  return blocks.map((block) => {
    if (attached || block.type !== 'tool-result') {
      return block
    }
    attached = true
    return { ...block, editPatch: patch }
  })
}

/**
 * @param {string} line        one line of the transcript, without its newline
 * @param {string} fallbackId  the id to use when the record has none (`<file>:<line>`)
 * @returns {NativeChatMessage | null}
 */
export function decodeClaudeTranscriptLine(line, fallbackId) {
  const parsed = parseJsonObject(line)
  if (!parsed) {
    return null
  }
  const record = claudeQueuedPromptAsUserRecord(parsed) ?? parsed
  const role = record.type
  if (role !== 'user' && role !== 'assistant') {
    return null
  }
  const timestamp = parseTimestamp(record.timestamp)
  const recordMessageId = extractString(record.uuid) ?? fallbackId
  // parentUuid pairs local command output with its command row.
  const parentUuid = extractString(record.parentUuid)
  const parent = parentUuid ? { parentId: parentUuid } : {}
  if (claudeInterruptedMessageId(record)) {
    // Render injected interruption text as quiet status rather than a user bubble.
    return {
      id: recordMessageId,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript',
      ...parent
    }
  }
  const message = asRecord(record.message)
  const editPatch = claudeEditPatch(record)
  const contentBlocks = claudeContentBlocks(message?.content)
  const decodedBlocks = editPatch ? withEditPatch(contentBlocks, editPatch) : contentBlocks
  if (decodedBlocks.length === 0) {
    return null
  }
  // Meta user turns may still contain genuine tool output.
  const isInjectedUserTurn =
    role === 'user' &&
    (record.isMeta === true || record.isSynthetic === true || record.isCompactSummary === true)
  const stopHookFeedback = isInjectedUserTurn ? claudeStopHookFeedbackMessage(decodedBlocks) : null
  if (stopHookFeedback) {
    return { id: recordMessageId, timestamp, source: 'transcript', ...stopHookFeedback, ...parent }
  }
  // Keep image-source companions despite isMeta: prompt base64 has no path and cannot render attachments.
  const blocks = isInjectedUserTurn
    ? isImageSourceRecord(decodedBlocks)
      ? decodedBlocks
      : decodedBlocks.filter((block) => block.type === 'tool-result')
    : decodedBlocks
  if (blocks.length === 0) {
    return null
  }
  const messageId = extractString(record.uuid) ?? extractString(message?.id)
  return {
    id: messageId ?? fallbackId,
    role: claudeMessageRole(role, blocks, message?.content),
    // Decode ! command echoes so harness filtering cannot hide them and strand the local echo.
    blocks:
      role === 'user'
        ? blocks.map((block) => unwrapClaudeBashInputBlock(unwrapClaudePastedContentBlock(block)))
        : blocks,
    timestamp,
    source: 'transcript',
    ...parent
  }
}

/**
 * Mid-turn human prompts exist only as queued_command attachments; decode them to reconcile local echoes.
 * @param {Record<string, unknown>} record @returns {Record<string, unknown> | null}
 */
function claudeQueuedPromptAsUserRecord(record) {
  if (record.type !== 'attachment') {
    return null
  }
  const attachment = asRecord(record.attachment)
  if (attachment?.type !== 'queued_command' || attachment.commandMode !== 'prompt') {
    return null
  }
  // Legacy prompt-mode queue entries omit origin and are human-authored.
  const originKind = asRecord(attachment.origin)?.kind
  if (originKind !== undefined && originKind !== 'human') {
    return null
  }
  const prompt = attachment.prompt
  if (typeof prompt !== 'string' && !Array.isArray(prompt)) {
    return null
  }
  return { ...record, type: 'user', message: { role: 'user', content: prompt } }
}

/**
 * @param {NativeChatBlock[]} blocks
 * @returns {{ role: 'system', blocks: NativeChatBlock[] } | null}
 */
function claudeStopHookFeedbackMessage(blocks) {
  const [block] = blocks
  const row =
    blocks.length === 1 && block?.type === 'text' ? claudeStopHookFeedbackBlock(block.text) : null
  return row ? { role: 'system', blocks: [row] } : null
}

/**
 * Mixed prose/markers are injected turns, never image-source companions.
 * @param {NativeChatBlock[]} blocks @returns {boolean}
 */
function isImageSourceRecord(blocks) {
  return (
    blocks.length > 0 &&
    blocks.every((block) => block.type === 'text' && imageSourcePathFromText(block.text) !== null)
  )
}

/**
 * @param {'user' | 'assistant'} role @param {NativeChatBlock[]} blocks @param {unknown} content
 * @returns {NativeChatMessage['role']}
 */
function claudeMessageRole(role, blocks, content) {
  if (role === 'user') {
    const onlyToolResults = blocks.every((block) => block.type === 'tool-result')
    return onlyToolResults && blocks.length > 0 ? 'tool' : 'user'
  }
  return isThinkingOnlyContent(content) ? 'reasoning' : role
}

/**
 * Decoded thinking becomes a text block, so classify from the raw content parts.
 * @param {unknown} content @returns {boolean}
 */
function isThinkingOnlyContent(content) {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => {
      const type = asRecord(part)?.type
      return type === 'thinking' || type === 'redacted_thinking'
    })
  )
}
