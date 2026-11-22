// Reading a terminal's screen as chat turns (RFC 0015, "Screen fallback"), for when there is no
// transcript yet or it lags. Ported from Orca (github.com/stablyai/orca at e1dfc022, MIT, (c) 2026
// Lovecast Inc.; see LICENSE-upstream and UPSTREAM.md):
// src/renderer/src/components/native-chat/native-chat-scrape-fallback.ts, behaviour unchanged.
// screenMessages is ours: herdr-core's terminal.read result in, Orca's scrape out.
// Screen rows are marked "from the screen", replaced as the screen changes and never kept.
// Reading the input row (a half-typed draft) and dialogs is delivery 3b.

/** @typedef {import('./types.js').NativeChatMessage} NativeChatMessage */

const ESC = String.fromCharCode(27)
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g')

/** @param {string} value @returns {string} */
function stripUnsupportedControlCharacters(value) {
  let result = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    // Drop C0 control chars except tab (9) and newline (10); keep DEL (127) out.
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue
    }
    result += char
  }
  return result
}

/** @param {string} value @returns {string} */
export function stripScrollbackAnsi(value) {
  return stripUnsupportedControlCharacters(
    value
      .replace(OSC_SEQUENCE_PATTERN, '')
      .replace(ANSI_ESCAPE_PATTERN, '')
      .replace(SINGLE_ESCAPE_PATTERN, '')
  )
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

// Without per-agent parsing, leading shell/prompt markers are only a best-effort user-role heuristic.
const USER_PROMPT_MARKERS = ['$', '%', '>', '#', '❯', '➜', '»']

/** @param {string} segment @returns {boolean} */
function looksLikeUserPrompt(segment) {
  const firstLine = segment.split('\n', 1)[0]?.trimStart() ?? ''
  if (firstLine.length === 0) {
    return false
  }
  const firstChar = firstLine[0]
  return USER_PROMPT_MARKERS.includes(firstChar)
}

/**
 * Split blank-line-separated scrollback into approximate turns; use index ids and null
 * timestamps without a reliable clock.
 * @param {string} rawScrollback @returns {NativeChatMessage[]}
 */
export function scrapeScrollbackToMessages(rawScrollback) {
  const cleaned = stripScrollbackAnsi(rawScrollback)
  if (cleaned.trim().length === 0) {
    return []
  }

  const segments = cleaned
    .split(/\n[ \t]*\n+/)
    .map((segment) => segment.replace(/\s+$/g, '').replace(/^\n+/, ''))
    .filter((segment) => segment.trim().length > 0)

  return segments.map((segment, index) => ({
    id: `scrape-${index}`,
    role: looksLikeUserPrompt(segment) ? 'user' : 'assistant',
    blocks: [{ type: 'text', text: segment }],
    timestamp: null,
    source: 'scrape'
  }))
}

/**
 * The turns a terminal's screen shows, from herdr-core's terminal.read result. Ours.
 * @param {{ text?: unknown } | null | undefined} read
 * @returns {NativeChatMessage[]}
 */
export function screenMessages(read) {
  return typeof read?.text === 'string' ? scrapeScrollbackToMessages(read.text) : []
}
