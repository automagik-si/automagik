// What a chat message becomes before it reaches the terminal (RFC 0015, "Input").
//
// cleanChatText is ours: the cleaning rule t2x5 set in RFC 0014's review. buildNativeChatPasteBytes
// and the rest are ported from Orca (github.com/stablyai/orca at e1dfc022, MIT, (c) 2026 Lovecast
// Inc.; see LICENSE-upstream and UPSTREAM.md): src/shared/native-chat/input/native-chat-paste-bytes.ts
// with what it calls from src/shared/terminal-bracketed-paste-text.ts and src/shared/terminal-input.ts,
// behaviour unchanged. Orca's image-path paste is not taken (image paste is not in RFC 0015).

const ESC = '\u001b'

// ---------------------------------------------------------------- ours: the cleaner

// Escape sequences, 7-bit and 8-bit: CSI (ESC [ or 0x9b) with its parameters; OSC, DCS, SOS, PM
// and APC strings up to their terminator (BEL or ST); any other ESC-introduced sequence. A
// string's body cannot hold ESC, BEL or another string opener, so each scan stops at the next
// one: linear time, where a lazy `[\s\S]*?` rescanned to the end for every unterminated opener.
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g
const STRING = /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d\u009e\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)/g
const OTHER = /\u001b[ -/]*[0-~]/g
// Every C0 control but tab and newline, DEL, and C1. Runs last, so stray ESCs and unterminated
// sequence starts go too.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/**
 * Clean a message the person wrote in a chat before it is typed into a terminal. Text can be lost,
 * never let through: an OSC/DCS string goes whole only when its terminator follows, else just its
 * opener goes and the rest is kept as text; a stray ESC
 * takes the next character with it when that character can end a sequence; a lone CR is dropped. `ESC[200~` and
 * `ESC[201~` go first, then every other escape sequence, every C0 control but newline and tab, DEL
 * and C1 controls; CRLF becomes LF. Empty (or only whitespace) after cleaning is refused.
 * @param {unknown} text
 * @returns {{ ok: true, text: string } | { ok: false, reason: 'empty' | 'not-text' }}
 */
export function cleanChatText(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'not-text' }
  const cleaned = text
    .replaceAll(`${ESC}[200~`, '')
    .replaceAll(`${ESC}[201~`, '')
    .replace(STRING, '')
    .replace(CSI, '')
    .replace(OTHER, '')
    .replace(/\r\n/g, '\n')
    .replace(CONTROLS, '')
  return cleaned.trim() === '' ? { ok: false, reason: 'empty' } : { ok: true, text: cleaned }
}

// ---------------------------------------------------------------- Orca's: framing

// --- src/shared/terminal-bracketed-paste-text.ts

export const BRACKETED_PASTE_START = `${ESC}[200~`
export const BRACKETED_PASTE_END = `${ESC}[201~`
// Agents can keep only the last read of unframed input longer than this (orca#13332).
export const UNFRAMED_AGENT_INPUT_MAX_BYTES = 1024

/**
 * Replace embedded ESC with printable ␛ (U+241B) so pasted framing bytes cannot close the frame
 * and execute its tail.
 * @param {string} text @returns {string}
 */
export function sanitizeBracketedPasteText(text) {
  let escapeIndex = text.indexOf(ESC)
  if (escapeIndex === -1) {
    return text
  }
  let sanitized = ''
  let start = 0
  while (escapeIndex !== -1) {
    sanitized += `${text.slice(start, escapeIndex)}␛`
    start = escapeIndex + ESC.length
    escapeIndex = text.indexOf(ESC, start)
  }
  return sanitized + text.slice(start)
}

/**
 * xterm's native paste path converts every clipboard newline to CR; direct frames match it.
 * @param {string} text @returns {string}
 */
export function normalizeTerminalPasteLineEndings(text) {
  return text.replace(/\r?\n/g, '\r')
}

/** @param {string} text @returns {string} */
export function wrapTerminalBracketedPasteText(text) {
  const normalizedText = normalizeTerminalPasteLineEndings(text)
  return `${BRACKETED_PASTE_START}${sanitizeBracketedPasteText(normalizedText)}${BRACKETED_PASTE_END}`
}

// --- src/shared/terminal-input.ts (getTerminalInputByteLength)
// Changed: Orca measures with its clipboard helper; Buffer.byteLength gives the same UTF-8 count
// (a lone surrogate counts as the 3 bytes of U+FFFD in both).

/** @param {string} text @returns {number} */
export function getTerminalInputByteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

// --- src/shared/native-chat/input/native-chat-paste-bytes.ts

// PTY Enter is carriage return, not newline.
const SUBMIT = '\r'

/**
 * Any CR/LF, including a trailing newline, needs bracketed-paste framing.
 * @param {string} text @returns {boolean}
 */
export function isMultilineDraft(text) {
  return /[\r\n]/.test(text)
}

/** Write Enter separately from the framed body; see buildNativeChatPasteBytes. */
export const NATIVE_CHAT_SUBMIT = SUBMIT

/**
 * Build sanitized body bytes, bracket-framed for multiline or long input, without submit. Agent
 * TUIs treat CR in the same PTY write as pasted body, leaving text unsent: write NATIVE_CHAT_SUBMIT
 * separately after a short delay (500 ms in Orca's answer stepping).
 * @param {string} text @returns {string}
 */
export function buildNativeChatPasteBytes(text) {
  // Sanitize unframed text too so pasted scrollback cannot inject terminal escapes.
  const sanitized = sanitizeBracketedPasteText(text)
  if (
    isMultilineDraft(text) ||
    getTerminalInputByteLength(sanitized) > UNFRAMED_AGENT_INPUT_MAX_BYTES
  ) {
    return wrapTerminalBracketedPasteText(text)
  }
  return sanitized
}
