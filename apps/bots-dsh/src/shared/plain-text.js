// A message's words without its markdown marks, for the one-line previews of the sidebar
// (#1155): a Bot writes markdown, and a preview that shows the source reads "**CSV export**".
// It reads the marks the way the chat's renderer does and keeps everything else: the text of a
// link or an image, the code of a code span, the words of a heading, a quote or a list item.
// What stands in code or in a bare address is never read as a mark, and a backslash keeps the
// character after it.
//
// It is a reading for a preview, not a renderer: tables keep their bars, HTML keeps its tags,
// and the line breaks stay for the caller to fold.

// Private-use characters hold what must come through untouched.
const HELD = /\uE000(\d+)\uE001/
const HELD_ALL = new RegExp(HELD, 'g')

export function plainText(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return ''
  const held = []
  const hold = (value) => { held.push(value); return `\uE000${held.length - 1}\uE001` }
  let text = markdown.replace(/[\uE000\uE001]/g, '')
  // Code first: a fenced block loses its fence lines, a code span its ticks.
  text = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*((?:\n(?![ \t]*\2)[^\n]*)*)(?:\n[ \t]*\2[`~]*[ \t]*(?=\n|$))?/g, (_all, start, _fence, code) => `${start}${hold(code.slice(1))}`)
  text = text.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_all, _ticks, code) => hold(code.replace(/^ ([\s\S]*) $/, '$1')))
  text = text.replace(/\\([!-/:-@[-`{-~])/g, (_all, mark) => hold(mark))
  // Links and images keep what a reader sees: the label, or the address of a bare link.
  text = text.replace(/!?\[((?:[^\][]|\[[^\][]*\])*)\]\((?:[^()\s]|\([^()\s]*\))*(?:[ \t]+(?:"[^"]*"|'[^']*'))?\)/g, '$1')
  text = text.replace(/!?\[((?:[^\][]|\[[^\][]*\])+)\]\[[^\]]*\]/g, '$1')
  text = text.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/g, (_all, address) => hold(address))
  text = text.replace(/\bhttps?:\/\/[^\s<>)\]]+/g, address => hold(address))
  // Line marks: a rule or the line under a heading, a quote, a heading, a list bullet and a
  // task box. A list's number stays.
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
  text = text.replace(/^[ \t]*={3,}[ \t]*$/gm, '')
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
  text = text.replace(/^[ \t]*#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/gm, '$1')
  text = text.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
  text = text.replace(/^([ \t]*\d+[.)][ \t]+)\[[ xX]\][ \t]+/gm, '$1')
  // Emphasis, strongest first, until none is left: bold inside italics inside a struck line.
  // An underscore inside a word is part of a name (snake_case), as the renderer reads it.
  for (let round = 0; round < 4; round += 1) {
    const before = text
    text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    text = text.replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1')
    text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    text = text.replace(/(?<!\*)\*(?![*\s])([^*\n]*?[^*\s])\*(?!\*)/g, '$1')
    text = text.replace(/(?<![\w_])_(?![_\s])([^_\n]*?[^_\s])_(?![\w_])/g, '$1')
    if (text === before) break
  }
  // What was held may hold an earlier piece itself (an escaped character in an address).
  while (HELD.test(text)) text = text.replace(HELD_ALL, (_all, index) => held[Number(index)])
  return text
}

// A preview is one line, cut by its row: only the start of a long message is read, so a
// long reply costs a row no more than a short one.
export const PREVIEW_SOURCE = 400

/** The one-line preview of a message: its start, without the marks, on one line. */
export function previewText(text) {
  if (typeof text !== 'string') return ''
  return plainText(text.slice(0, PREVIEW_SOURCE)).replace(/\s+/g, ' ').trim()
}
