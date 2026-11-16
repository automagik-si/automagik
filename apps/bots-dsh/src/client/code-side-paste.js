// A paste's bytes for the terminal (RFC 0030 delivery 2): a paste must never press Enter.
//
// LF is Enter too (readline's accept-line is bound to Ctrl-J as well as CR), so keeping the
// line break is not enough. The program itself says which rule it takes: when it turned on
// bracketed paste (`ESC[?2004h` on its output), the paste goes inside `ESC[200~ … ESC[201~`
// and the program treats every byte as text; when it has not, the paste carries no CR and no
// LF at all — its line breaks become spaces — and the pane says so in plain words.
//
// Pure: the pane, the browser test and the scratch-pane proof share it.
export const BRACKET_PASTE_ON = '\x1b[?2004h'
export const BRACKET_PASTE_OFF = '\x1b[?2004l'
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

const encoder = () => new TextEncoder()
const bytesOf = (text) => encoder().encode(text)
/** C0 controls other than tab, LF and CR (CR is handled as a line break), DEL, and the C1
 * controls: an ESC inside a paste could close the program's bracketed-paste marker early and
 * run whatever follows, and U+009B is a one-byte CSI some terminals honour. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g

/** Whether the program last turned bracketed paste on or off, given the bytes since. */
export function bracketedState(current, bytes) {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  const on = text.lastIndexOf(BRACKET_PASTE_ON)
  const off = text.lastIndexOf(BRACKET_PASTE_OFF)
  if (on < 0 && off < 0) return current === true
  return on > off
}

/**
 * The bytes one paste sends and the note the pane shows, if any.
 * @param {string} text the clipboard's text, exactly as pasted
 * @param {boolean} bracketed whether the program turned bracketed paste on
 */
export function pasteBytes(text, bracketed) {
  const raw = typeof text === 'string' ? text : ''
  if (raw === '') return { bytes: new Uint8Array(), note: null }
  // A paste can carry an ESC[201~ of its own; inside the markers it would close them early
  // and whatever follows would run. No C0 control but tab, LF and CR survives, whatever the
  // program's bracketed-paste state: the text itself stays, harmless without its ESC.
  const value = raw.replace(CONTROL, '')
  const controls = value !== raw
  const lineBreaks = /[\r\n]/.test(value)
  if (bracketed === true) {
    // Inside the markers every byte is text; CR would still read as a line end, so it
    // becomes LF like the rest.
    return { bytes: bytesOf(`${PASTE_START}${value.replace(/\r\n?/g, '\n')}${PASTE_END}`), note: controls ? 'controls-stripped' : null }
  }
  if (!lineBreaks) return { bytes: bytesOf(value), note: controls ? 'controls-stripped' : null }
  // No bracketed paste: no CR and no LF leaves this side. The text stays one line, and the
  // pane says the line breaks went.
  return { bytes: bytesOf(value.replace(/\r\n|\r|\n/g, ' ')), note: controls ? 'controls-stripped' : 'line-breaks-stripped' }
}
