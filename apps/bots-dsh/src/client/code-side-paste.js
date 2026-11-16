// A paste's bytes for the terminal (RFC 0030 delivery 2): a paste never presses Enter,
// whatever the program's bracketed-paste state.
//
// LF is Enter too (readline's accept-line is bound to Ctrl-J as well as CR), and the pane
// cannot trust that it saw the program's bracketed-paste marker (a program may have set it
// before the pane attached, and markers can be missed). So no paste ever carries CR or LF:
// the line breaks become spaces, and the pane says so in plain words. A paste that carries
// its own ESC could also close a bracketed paste early and run what follows, so no C0 or C1
// control but tab survives either.
//
// Pure: the pane and the scratch-pane proof share it.
const encoder = () => new TextEncoder()
const bytesOf = (text) => encoder().encode(text)
/** C0 controls other than tab, LF and CR (they are handled as line breaks), DEL, and C1. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g

/** The bytes one paste sends and the note the pane shows, if any. */
export function pasteBytes(text) {
  const raw = typeof text === 'string' ? text : ''
  if (raw === '') return { bytes: new Uint8Array(), note: null }
  const value = raw.replace(CONTROL, '')
  const controls = value !== raw
  const lineBreaks = /[\r\n]/.test(value)
  if (!lineBreaks) return { bytes: bytesOf(value), note: controls ? 'controls-stripped' : null }
  // No CR and no LF leave this side, ever: the text stays one line.
  return { bytes: bytesOf(value.replace(/\r\n|\r|\n/g, ' ')), note: controls ? 'controls-stripped' : 'line-breaks-stripped' }
}
