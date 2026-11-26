import assert from 'node:assert/strict'
import { test } from 'node:test'
import { characterMarkup, defaultShape, MASK_ID } from '../src/client/characters.js'
import { browser, bundle, load, nodes } from './viewer-fixture.js'

const code = await bundle("export { VoiceMode, watchReply } from './src/client/voice.js'")
const { VoiceMode, watchReply } = load(code, browser().globals)

test('a reply published synchronously during subscribe is spoken once', () => {
  const consumed = []
  // DSH's target publishes on subscribe, before watch() returns the disposer.
  const watch = (listener) => { listener(); return () => {} }
  const off = watchReply(() => 'the answer', watch, text => consumed.push(text))
  assert.deepEqual(consumed, ['the answer'])
  off()
})

test('watchReply waits for the reply, speaks it once, then stops', () => {
  const consumed = []
  const calls = []
  let text
  const listeners = new Set()
  const off = watchReply(
    () => text,
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    (value) => { calls.push('consume'); consumed.push(value) })
  assert.deepEqual(consumed, [])
  text = 'first'
  for (const listener of listeners) listener()
  assert.deepEqual(consumed, ['first'])
  assert.equal(listeners.size, 0)
  // A later publish must not speak the same reply again.
  text = 'again'
  assert.deepEqual(consumed, ['first'])
  assert.equal(calls.length, 1)
  off()
})

test('the voice overlay draws the Solver character and the ordinary default in the stored color', () => {
  for (const reviewerId of ['r', undefined]) {
    const bot = { id: 'b', name: 'Fixture', role: 'Solver', reviewerId, avatar: { shape: 'frog' }, color: 'aurora' }
    const tree = VoiceMode({
      sessionId: bot.id, roster: { byId: { b: bot }, roomsById: {} },
      actions: { speech: () => null },
      useSessions: select => select({ byId: {} }),
      useSessionStatus: select => select(new Map()),
    })
    const orb = nodes(tree).find(node => node.props.className === 'bt-voice-orb')
    const mark = orb.props.children.find(node => node?.type?.name === 'BotMark')
    const drawn = mark.type(mark.props)
    const face = drawn.type(drawn.props)
    const shape = reviewerId ? 'frog' : defaultShape(bot.id)
    assert.equal(face.props['data-shape'], shape)
    assert.equal(face.props.children[0].props.dangerouslySetInnerHTML.__html.replace(/bt-mark-\d+/g, MASK_ID), characterMarkup(shape, bot.color))
  }
})
