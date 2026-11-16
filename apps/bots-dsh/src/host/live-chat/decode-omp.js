// omp session lines to chat messages. Ported from Orca (github.com/stablyai/orca at e1dfc022,
// MIT, (c) 2026 Lovecast Inc.; see LICENSE-upstream and UPSTREAM.md):
// src/main/native-chat/transcript-line-decoders-omp.ts, behaviour unchanged (its image data URIs
// come from decode-shared.js's buildImageDataUri, which notes its one change).
// The output is Orca's NativeChatMessage; the engine maps it to RFC 0015's rows.

// OMP history is a tree, but this stateless decoder renders file order, including abandoned branches.
// Correct branch selection requires state across records.

import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from './types.js'
import {
  asRecord,
  buildImageDataUri,
  extractString,
  parseJsonObject,
  parseTimestamp,
  toolResultOutput
} from './decode-shared.js'

/** @typedef {import('./types.js').NativeChatBlock} NativeChatBlock */
/** @typedef {import('./types.js').NativeChatMessage} NativeChatMessage */
/** @typedef {import('./types.js').AgentSessionTokenUsage} AgentSessionTokenUsage */

/**
 * @param {string} line        one line of the session file, without its newline
 * @param {string} fallbackId  the id to use when the record has none (`<file>:<line>`)
 * @returns {NativeChatMessage | null}
 */
export function decodeOmpTranscriptLine(line, fallbackId) {
  const record = parseJsonObject(line)
  if (
    !record ||
    (record.type !== 'message' && record.type !== 'custom_message' && record.type !== 'compaction')
  ) {
    return null
  }
  const id = extractString(record.id) ?? fallbackId
  const timestamp = parseTimestamp(record.timestamp)

  if (record.type === 'compaction') {
    // Compaction invalidates earlier context measurements.
    return {
      id,
      role: 'system',
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
      timestamp,
      source: 'transcript'
    }
  }

  if (record.type === 'custom_message') {
    // Match OMP visibility: undisplayed custom messages are hidden extension state.
    const customBlocks = record.display === true ? ompContentBlocks(record.content) : []
    return customBlocks.length === 0
      ? null
      : { id, role: 'system', blocks: customBlocks, timestamp, source: 'transcript' }
  }

  const message = asRecord(record.message)
  if (!message) {
    return null
  }
  const role = extractString(message.role)

  if (role === 'toolResult') {
    return {
      id,
      role: 'tool',
      blocks: [
        {
          type: 'tool-result',
          output: toolResultOutput(message.content),
          ...(message.isError === true ? { isError: true } : {})
        }
      ],
      timestamp,
      source: 'transcript'
    }
  }

  if (role === 'bashExecution' || role === 'pythonExecution') {
    // Execution cells have no content array; render invocation/output as a collapsible tool turn.
    return {
      id,
      role: 'tool',
      blocks: ompExecutionBlocks(role, message),
      timestamp,
      source: 'transcript'
    }
  }

  if (role === 'fileMention') {
    // Render mentioned paths only; embedded auto-read file contents would bury the conversation.
    const paths = ompFileMentionPaths(message.files)
    return paths.length === 0
      ? null
      : {
          id,
          role: 'system',
          blocks: [{ type: 'text', text: paths.map((path) => `@${path}`).join('\n') }],
          timestamp,
          source: 'transcript'
        }
  }

  // Pre-v3 custom/hookMessage rows use the same display gate as current custom_message rows.
  if ((role === 'custom' || role === 'hookMessage') && message.display !== true) {
    return null
  }
  const blocks = ompContentBlocks(message.content)
  if (blocks.length === 0) {
    // Empty aborted messages still need interruption status; preserve any partial content otherwise.
    return role === 'assistant' && message.stopReason === 'aborted'
      ? {
          id,
          role: 'system',
          blocks: [{ type: 'text', text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT }],
          timestamp,
          source: 'transcript'
        }
      : null
  }
  if (role === 'assistant') {
    return {
      id,
      role: 'assistant',
      blocks,
      timestamp,
      source: 'transcript',
      ...ompServing(message)
    }
  }
  return { id, role: role === 'user' ? 'user' : 'system', blocks, timestamp, source: 'transcript' }
}

/**
 * @param {Record<string, unknown>} message
 * @returns {{ model?: string, provider?: string, usage?: AgentSessionTokenUsage }}
 */
function ompServing(message) {
  const model = extractString(message.model)
  const provider = extractString(message.provider)
  // Match OMP's context gauge, which excludes failed/aborted reply accounting.
  const usage =
    message.stopReason === 'aborted' || message.stopReason === 'error'
      ? null
      : ompTokenUsage(message.usage)
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(usage ? { usage } : {})
  }
}

/** @param {unknown} value @returns {AgentSessionTokenUsage | null} */
function ompTokenUsage(value) {
  const usage = asRecord(value)
  if (!usage) {
    return null
  }
  return {
    inputTokens: tokenCount(usage.input),
    cacheCreationInputTokens: tokenCount(usage.cacheWrite),
    cacheReadInputTokens: tokenCount(usage.cacheRead),
    outputTokens: tokenCount(usage.output)
  }
}

/** @param {unknown} value @returns {number} */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * @param {'bashExecution' | 'pythonExecution'} role @param {Record<string, unknown>} message
 * @returns {NativeChatBlock[]}
 */
function ompExecutionBlocks(role, message) {
  const isBash = role === 'bashExecution'
  // Preserve whitespace meaningful in source/output; extractString trims it.
  const source = isBash ? message.command : message.code
  const output = message.output
  // JSON omits undefined exitCode on cancellation; cancelled must distinguish it from success.
  const failed =
    message.cancelled === true || (typeof message.exitCode === 'number' && message.exitCode !== 0)
  return [
    {
      type: 'tool-call',
      name: isBash ? 'bash' : 'python',
      input: typeof source === 'string' ? source : ''
    },
    {
      type: 'tool-result',
      output: typeof output === 'string' ? output : '',
      ...(failed ? { isError: true } : {})
    }
  ]
}

/** @param {unknown} files @returns {string[]} */
function ompFileMentionPaths(files) {
  if (!Array.isArray(files)) {
    return []
  }
  /** @type {string[]} */
  const paths = []
  for (const file of files) {
    const path = extractString(asRecord(file)?.path)
    if (path) {
      paths.push(path)
    }
  }
  return paths
}

/** @param {unknown} content @returns {NativeChatBlock[]} */
function ompContentBlocks(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) {
    return []
  }
  /** @type {NativeChatBlock[]} */
  const blocks = []
  for (const item of content) {
    const block = ompContentBlock(asRecord(item))
    if (block) {
      blocks.push(block)
    }
  }
  return blocks
}

/** @param {Record<string, unknown> | null} record @returns {NativeChatBlock | null} */
function ompContentBlock(record) {
  if (!record) {
    return null
  }
  switch (record.type) {
    case 'text': {
      const text = extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'thinking': {
      const text = extractString(record.thinking) ?? extractString(record.text)
      return text ? { type: 'text', text } : null
    }
    case 'toolCall': {
      const name = extractString(record.name) ?? 'tool'
      return { type: 'tool-call', name, input: record.arguments }
    }
    case 'image': {
      const data = extractString(record.data)
      const url =
        data && !data.startsWith('blob:')
          ? buildImageDataUri(extractString(record.mimeType) ?? undefined, data)
          : null
      return url ? { type: 'image-ref', url } : null
    }
    default:
      return null
  }
}
