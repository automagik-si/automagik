// A paste never presses Enter (RFC 0030 delivery 2): no CR and no LF leaves the pane, ever,
// whatever the program's bracketed-paste state; and no C0/C1 control (an ESC could close a
// bracketed paste early and run what follows) survives either.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pasteBytes } from '../src/client/code-side-paste.js'

const textOf = bytes => new TextDecoder().decode(bytes)

test('a multi-line paste leaves as one line: no CR, no LF, ever', () => {
  for (const value of ['echo PASTED\n', 'one\r\ntwo\rthree\nfour', '\n\n', 'echo PASTED\r\nnext']) {
    const { bytes, note } = pasteBytes(value)
    const sent = textOf(bytes)
    assert.doesNotMatch(sent, /[\r\n]/, `a line break reached the terminal for ${JSON.stringify(value)}`)
    assert.ok(note === 'line-breaks-stripped')
  }
  assert.equal(textOf(pasteBytes('one\r\ntwo').bytes), 'one two')
})

test('a pasted end marker cannot close a bracketed paste early: its ESC goes', () => {
  const payload = 'x' + '\u001b[201~' + 'echo BROKE\n'
  const { bytes, note } = pasteBytes(payload)
  const sent = textOf(bytes)
  assert.equal(note, 'controls-stripped')
  assert.doesNotMatch(sent, /[\u001b\r\n]/, 'no ESC, CR or LF leaves the pane')
  assert.match(sent, /x\[201~echo BROKE/, 'the text itself stays, harmless without its ESC')
})

test('one-byte C1 CSIs and DEL are stripped too; tab stays', () => {
  const { bytes, note } = pasteBytes('safe\u009b31mred\u0085end\u007f\tend')
  assert.equal(note, 'controls-stripped')
  assert.doesNotMatch(textOf(bytes), /[\u0080-\u009f\u007f]/)
  assert.match(textOf(bytes), /safe31mredend\tend/)
})

test('a one-line paste carries no note; an empty paste sends nothing', () => {
  assert.deepEqual([...pasteBytes('echo PASTED').bytes], [...new TextEncoder().encode('echo PASTED')])
  assert.equal(pasteBytes('echo PASTED').note, null)
  assert.equal(pasteBytes('').bytes.length, 0)
  assert.equal(pasteBytes('').note, null)
})
