// The view's switch beside the new left bar (left-bar-faces.js): the open Bot's two faces, Chat
// and Terminal, each with its glyph and its word, the open one pressed. The word Code is not on
// it: Code is the bar's other side (the owner's answer of 2026-11-13).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, parts, render, textOf } from './left-bar-load.js'

const { FACES, FaceSwitch, LEFT_BAR_CSS, LEFT_BAR_TOKENS, faceOr, faceWord, installLocale } = parts

const draw = props => render(FaceSwitch(props ?? {}))
const buttons = tree => findAll(tree, node => node.type === 'button')

test('the switch is a named group of two parts: Chat, then Terminal', () => {
  const tree = draw({ face: 'chat' })
  assert.equal(tree.props.role, 'group')
  assert.equal(tree.props['aria-label'], 'This Bot as')
  assert.equal(draw({ label: 'Juno as' }).props['aria-label'], 'Juno as')
  assert.deepEqual([...FACES], ['chat', 'terminal'])
  const both = buttons(tree)
  assert.deepEqual(both.map(part => [part.props['data-face'], textOf(part)]), [['chat', 'Chat'], ['terminal', 'Terminal']])
  for (const part of both) {
    assert.equal(part.props.type, 'button')
    const glyphs = findAll(part, node => node.type === 'svg')
    assert.equal(glyphs.length, 1, 'each word has its glyph')
    assert.equal(glyphs[0].props['aria-hidden'], true, 'the glyph is not read: the word is')
  }
  assert.doesNotMatch(textOf(tree), /code/i, 'Code is the bar\'s other side, not a face')
})

test('the open face is pressed; an unknown face is the chat', () => {
  assert.deepEqual(buttons(draw({ face: 'chat' })).map(part => part.props['aria-pressed']), [true, false])
  assert.deepEqual(buttons(draw({ face: 'terminal' })).map(part => part.props['aria-pressed']), [false, true])
  assert.deepEqual(buttons(draw({ face: 'code' })).map(part => part.props['aria-pressed']), [true, false])
  assert.deepEqual(buttons(draw()).map(part => part.props['aria-pressed']), [true, false])
  assert.equal(faceOr('terminal'), 'terminal')
  assert.equal(faceOr(undefined), 'chat')
})

test('a press hands over the other face; the open one, and a switch with no listener, hand over nothing', () => {
  const heard = []
  const [chat, terminal] = buttons(draw({ face: 'chat', onFace: face => heard.push(face) }))
  assert.equal(chat.props.onClick, undefined, 'the open face is already open')
  terminal.props.onClick()
  const [back] = buttons(draw({ face: 'terminal', onFace: face => heard.push(face) }))
  back.props.onClick()
  assert.deepEqual(heard, ['terminal', 'chat'])
  assert.deepEqual(buttons(draw({ face: 'chat' })).map(part => part.props.onClick), [undefined, undefined])
})

test('both words come from the dictionary', () => {
  const dicts = new Map()
  const off = installLocale({
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => key => dicts.get(`${ns}:zh`)?.[key] ?? key,
    getLocale: () => ({ active: 'zh' }),
  })
  try {
    assert.equal(faceWord('chat'), '聊天')
    assert.equal(faceWord('terminal'), '终端')
    assert.deepEqual(buttons(draw({ face: 'chat' })).map(textOf), ['聊天', '终端'])
  } finally {
    off()
  }
})

test('the switch is sized by tokens, and its open face is told by more than colour', () => {
  assert.equal(LEFT_BAR_TOKENS['--lb-face-h'], '32px')
  assert.equal(LEFT_BAR_TOKENS['--lb-face-glyph'], '15px')
  assert.match(LEFT_BAR_CSS, /\.lb-face\{[^}]*height:var\(--lb-face-h\)[^}]*border-radius:var\(--lb-face-r\)/)
  // The open face is a raised part on the track: a ground and a line under it, not a colour of text alone.
  assert.match(LEFT_BAR_CSS, /\.lb-face-part\[aria-pressed=true\]\{background:var\(--st-paper,var\(--bt-card\)\);[^}]*box-shadow:/)
  assert.match(LEFT_BAR_CSS, /\.lb-face-part:focus-visible\{outline:3px solid/)
})
