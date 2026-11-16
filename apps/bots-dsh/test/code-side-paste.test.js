// A paste never presses Enter (RFC 0030 delivery 2): bracketed paste when the program asked
// for it, and no CR or LF at all when it did not. Pure over the pane's rule.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BRACKET_PASTE_OFF, BRACKET_PASTE_ON, PASTE_END, PASTE_START, bracketedState, pasteBytes } from '../src/client/code-side-paste.js'

const textOf = bytes => new TextDecoder().decode(bytes)

test('with bracketed paste on, the paste goes inside the program markers and keeps its lines', () => {
  const { bytes, note } = pasteBytes('echo PASTED\nsecond line\n', true)
  assert.equal(note, null)
  assert.equal(textOf(bytes), `${PASTE_START}echo PASTED\nsecond line\n${PASTE_END}`)
  assert.equal(textOf(bytes).startsWith(PASTE_START), true)
  assert.equal(textOf(bytes).endsWith(PASTE_END), true)
})

test('without bracketed paste, no CR and no LF leaves the pane, whatever the clipboard holds', () => {
  for (const value of ['echo PASTED\n', 'one\r\ntwo\rthree\nfour', '\n\n']) {
    const { bytes, note } = pasteBytes(value, false)
    const sent = textOf(bytes)
    assert.doesNotMatch(sent, /[\r\n]/, `a line break reached the terminal for ${JSON.stringify(value)}`)
    assert.equal(note, 'line-breaks-stripped')
  }
  assert.equal(textOf(pasteBytes('one\r\ntwo', false).bytes), 'one two')
})

test('a one-line paste carries no note; an empty paste sends nothing', () => {
  assert.deepEqual([...pasteBytes('echo PASTED', false).bytes], [...new TextEncoder().encode('echo PASTED')])
  assert.equal(pasteBytes('echo PASTED', false).note, null)
  assert.equal(pasteBytes('', false).bytes.length, 0)
  assert.equal(pasteBytes('', true).bytes.length, 0)
})

test('a paste carrying the end marker cannot close the bracket early', () => {
  const payload = 'x' + '\u001b[201~' + 'echo BROKE\n'
  const { bytes, note } = pasteBytes(payload, true)
  const sent = textOf(bytes)
  assert.equal(note, 'controls-stripped')
  assert.equal(sent.startsWith(PASTE_START), true)
  assert.equal(sent.endsWith(PASTE_END), true)
  const inner = sent.slice(PASTE_START.length, sent.length - PASTE_END.length)
  assert.doesNotMatch(inner, /\u001b/, 'no ESC is left inside the bracketed paste')
  assert.equal(inner.indexOf(PASTE_END), -1, 'the end marker cannot appear inside the paste')
  assert.match(inner, /echo BROKE/, 'the text itself stays, harmless without its ESC')
})

test('without bracketed paste the same paste also loses its ESC and its line break', () => {
  const { bytes, note } = pasteBytes('x' + '\u001b[201~' + 'echo BROKE\n', false)
  const sent = textOf(bytes)
  assert.doesNotMatch(sent, /[\r\n\u001b]/, 'no CR, LF or ESC leaves the pane')
  assert.equal(note, 'controls-stripped')
})

test('a one-byte C1 CSI is stripped like an ESC, in both paste modes', () => {
  const payload = 'safe' + '\u009b' + '31mred' + '\u0085' + 'end'
  for (const bracketed of [true, false]) {
    const { bytes, note } = pasteBytes(payload, bracketed)
    const sent = textOf(bytes)
    assert.equal(note, 'controls-stripped')
    assert.doesNotMatch(sent, /[\u0080-\u009f]/, 'no C1 control leaves the pane')
    assert.match(sent, /safe31mredend/, 'the text itself stays')
  }
})

test('the bracketed state follows the last marker the program wrote', () => {
  assert.equal(bracketedState(false, `prompt$ ${BRACKET_PASTE_ON}`), true)
  assert.equal(bracketedState(true, `prompt$ ${BRACKET_PASTE_OFF}`), false)
  assert.equal(bracketedState(true, 'plain output'), true)
  assert.equal(bracketedState(false, 'plain output'), false)
  assert.equal(bracketedState(false, `${BRACKET_PASTE_ON} out ${BRACKET_PASTE_OFF} more`), false)
  assert.equal(bracketedState(true, `${BRACKET_PASTE_OFF} out ${BRACKET_PASTE_ON} more`), true)
})
