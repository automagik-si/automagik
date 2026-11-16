// Codex rollout lines to chat messages. Ported from Orca (github.com/stablyai/orca at e1dfc022,
// MIT, (c) 2026 Lovecast Inc.; see LICENSE-upstream and UPSTREAM.md):
// src/main/native-chat/transcript-line-decoders-codex.ts, behaviour unchanged.
// The output is Orca's NativeChatMessage; the engine maps it to RFC 0015's rows.
import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from './types.js'
import {
  asRecord,
  claudeContentBlocks,
  CODEX_EVENT_TURN_ABORTED,
  extractString,
  NATIVE_CHAT_NOTICE_COPY,
  parseJsonObject,
  parseTimestamp,
  toolResultOutput
} from './decode-shared.js'

/** @typedef {import('./types.js').NativeChatBlock} NativeChatBlock */
/** @typedef {import('./types.js').NativeChatMessage} NativeChatMessage */

/**
 * Paginated completed items own visible messages; response tools retain their legacy format.
 * @param {Record<string, unknown> | null} record @param {boolean} paginated @returns {boolean}
 */
export function isCodexVisibleHistoryRecord(record, paginated) {
  const payload = asRecord(record?.payload)
  return (
    !paginated ||
    !(
      (record?.type === 'response_item' &&
        (payload?.type === 'message' || payload?.type === 'reasoning')) ||
      (record?.type === 'event_msg' &&
        (payload?.type === 'user_message' || payload?.type === 'agent_message'))
    )
  )
}

/**
 * @param {string} line        one line of the rollout, without its newline
 * @param {string} fallbackId  the id to use when the record has none (`<file>:<line>`)
 * @param {{ historyImport: true }} [options]
 * @returns {NativeChatMessage | null}
 */
export function decodeCodexTranscriptLine(line, fallbackId, options) {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const payload = asRecord(record.payload)
  if (!payload) {
    const id = extractString(record.id) ?? fallbackId
    return codexUnwrappedResponseItem(record, id, parseTimestamp(record.timestamp))
  }
  const timestamp = parseTimestamp(record.timestamp)
  const baseId = extractString(payload.id) ?? fallbackId

  if (record.type === 'response_item') {
    return codexResponseItem(payload, baseId, timestamp)
  }
  if (record.type === 'event_msg') {
    return codexEventMessage(payload, baseId, timestamp, options?.historyImport === true)
  }
  return null
}

/**
 * @param {Record<string, unknown>} record @param {string} id @param {number | null} timestamp
 * @returns {NativeChatMessage | null}
 */
function codexUnwrappedResponseItem(record, id, timestamp) {
  if (record.type !== 'message') {
    return codexResponseItem(record, id, timestamp)
  }
  const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null
  const decodedBlocks = codexTurnItemBlocks(record.content)
  const blocks =
    role === 'user' ? decodedBlocks.filter((block) => !isSkillContext(block)) : decodedBlocks
  return role && blocks.length > 0 ? { id, role, blocks, timestamp, source: 'transcript' } : null
}

/**
 * @param {Record<string, unknown>} payload @param {string} id @param {number | null} timestamp
 * @returns {NativeChatMessage | null}
 */
function codexResponseItem(payload, id, timestamp) {
  if (payload.type === 'message') {
    const role =
      payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
    if (!role) {
      return null
    }
    const decodedBlocks = claudeContentBlocks(payload.content)
    const blocks =
      role === 'user' ? decodedBlocks.filter((block) => !isSkillContext(block)) : decodedBlocks
    if (blocks.length === 0) {
      return null
    }
    return { id, role, blocks, timestamp, source: 'transcript' }
  }
  if (payload.type === 'reasoning') {
    const text = extractString(payload.text) ?? codexSummaryText(payload.summary)
    if (!text) {
      return null
    }
    return {
      id,
      role: 'reasoning',
      blocks: [{ type: 'text', text }],
      timestamp,
      source: 'transcript'
    }
  }
  if (
    payload.type === 'function_call' ||
    payload.type === 'local_shell_call' ||
    payload.type === 'custom_tool_call'
  ) {
    const name = extractString(payload.name) ?? 'tool'
    const callId = extractString(payload.call_id)
    return {
      id,
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name, input: codexCallInput(payload), ...(callId ? { callId } : {}) }
      ],
      timestamp,
      source: 'transcript'
    }
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    return {
      id,
      role: 'tool',
      blocks: [codexToolResult(payload.output, extractString(payload.call_id))],
      timestamp,
      source: 'transcript'
    }
  }
  return null
}

/**
 * Explicit skill expansions are model context, not the user's recorded prompt.
 * @param {NativeChatBlock} block @returns {boolean}
 */
function isSkillContext(block) {
  return block.type === 'text' && block.text.trimStart().slice(0, 7).toLowerCase() === '<skill>'
}

/**
 * @param {Record<string, unknown>} payload @param {string} id @param {number | null} timestamp
 * @param {boolean} historyImport @returns {NativeChatMessage | null}
 */
function codexEventMessage(payload, id, timestamp, historyImport) {
  if (payload.type === CODEX_EVENT_TURN_ABORTED) {
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
      timestamp,
      source: 'transcript'
    }
  }
  // Legacy rollouts persist this event; paginated rollouts persist a ContextCompaction item instead.
  if (payload.type === 'context_compacted') {
    return codexCompactionMarker(id, timestamp)
  }
  if (payload.type === 'item_completed') {
    return codexCompletedTurnItem(payload, id, timestamp, historyImport)
  }
  if (payload.type === 'user_message') {
    const text = extractString(payload.message)
    return text
      ? { id, role: 'user', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }
  if (payload.type === 'agent_message') {
    const text = extractString(payload.message)
    return text
      ? { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp, source: 'transcript' }
      : null
  }
  return null
}

/**
 * @param {Record<string, unknown>} payload @param {string} fallbackId
 * @param {number | null} timestamp @param {boolean} historyImport
 * @returns {NativeChatMessage | null}
 */
function codexCompletedTurnItem(payload, fallbackId, timestamp, historyImport) {
  const item = asRecord(payload.item)
  if (!item) {
    return null
  }
  const id = extractString(item.id) ?? fallbackId
  if (historyImport && item.type === 'Reasoning') {
    return codexResponseItem(
      {
        type: 'reasoning',
        text: codexSummaryText(item.summary_text) ?? codexSummaryText(item.raw_content)
      },
      id,
      timestamp
    )
  }
  if (item.type === 'ContextCompaction') {
    return codexCompactionMarker(id, timestamp)
  }
  const blocks = codexTurnItemBlocks(item.content)
  if (blocks.length === 0) {
    return null
  }
  if (item.type === 'UserMessage' || item.type === 'user_message') {
    return { id, role: 'user', blocks, timestamp, source: 'transcript' }
  }
  if (item.type === 'AgentMessage' || item.type === 'agent_message') {
    return { id, role: 'assistant', blocks, timestamp, source: 'transcript' }
  }
  return null
}

/** @param {string} id @param {number | null} timestamp @returns {NativeChatMessage} */
function codexCompactionMarker(id, timestamp) {
  return {
    id,
    role: 'system',
    blocks: [
      { type: 'text', text: NATIVE_CHAT_NOTICE_COPY.compaction, presentation: 'compaction' }
    ],
    timestamp,
    source: 'transcript'
  }
}

/** @param {unknown} content @returns {NativeChatBlock[]} */
function codexTurnItemBlocks(content) {
  if (!Array.isArray(content)) {
    return []
  }
  /** @type {NativeChatBlock[]} */
  const blocks = []
  for (const value of content) {
    const item = asRecord(value)
    if (!item) {
      continue
    }
    if (
      item.type === 'text' ||
      item.type === 'Text' ||
      item.type === 'input_text' ||
      item.type === 'output_text'
    ) {
      const text = extractString(item.text)
      if (text) {
        blocks.push({ type: 'text', text })
      }
      continue
    }
    if (item.type === 'image' || item.type === 'Image' || item.type === 'input_image') {
      const url = extractString(item.image_url) ?? extractString(item.url)
      if (url) {
        blocks.push({ type: 'image-ref', url })
      }
      continue
    }
    if (item.type === 'local_image' || item.type === 'LocalImage') {
      const path = extractString(item.path)
      if (path) {
        blocks.push({ type: 'image-ref', path })
      }
    }
  }
  return blocks
}

/**
 * Preserve raw argument shape for all consumers; callers needing structure decode it themselves.
 * @param {Record<string, unknown>} payload @returns {unknown}
 */
function codexCallInput(payload) {
  if (payload.arguments !== undefined) {
    return payload.arguments
  }
  return payload.input ?? payload.action ?? null
}

/** @param {unknown} output @param {string | null} callId @returns {NativeChatBlock} */
function codexToolResult(output, callId) {
  const record = asRecord(output)
  const isError = record?.success === false || record?.is_error === true
  return {
    type: 'tool-result',
    output: toolResultOutput(record?.content ?? record?.output ?? output),
    ...(callId ? { callId } : {}),
    ...(isError ? { isError: true } : {})
  }
}

/** @param {unknown} summary @returns {string | null} */
function codexSummaryText(summary) {
  if (!Array.isArray(summary)) {
    return null
  }
  /** @type {string[]} */
  const parts = []
  for (const item of summary) {
    const text = extractString(asRecord(item)?.text) ?? extractString(item)
    if (text) {
      parts.push(text)
    }
  }
  return parts.length ? parts.join('\n') : null
}
