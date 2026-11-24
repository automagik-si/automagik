// The Settings > Bot picker's own wiring, not only the menu: a route or ACP-agent crossing
// must be a saved-Bot crossing (saved: true) and must reach switchRoute, never updateBot.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settingsModelPicker } from '../src/client/settings-model-picker.js'

const bot = { id: 'b1', name: 'Ops', model: 'deepseek/flash', appliedModel: 'deepseek/flash' }
const roster = { byId: { b1: bot } }

function picker() {
  const updated = []
  const switched = []
  const actions = {
    updateBot: (id, patch) => { updated.push([id, { ...patch }]); return Promise.resolve() },
    switchRoute: (id, ref, patch) => { switched.push([id, ref, { ...patch }]); return Promise.resolve() },
  }
  const props = settingsModelPicker({ bot, roster, actions, run: promise => promise })
  return { props, updated, switched }
}

test('Settings > Bot is a saved-Bot picker: an idle crossing switches at once', () => {
  const { props } = picker()
  assert.equal(props.saved, true)
  assert.equal(typeof props.onPick, 'function')
})

test('a Settings crossing goes to switchRoute, never updateBot', async () => {
  const { props, updated, switched } = picker()
  await props.onPick('acp-claude/opus', { routeChange: true, effort: 'high' })
  assert.deepEqual(switched, [['b1', 'acp-claude/opus', { effort: 'high' }]])
  assert.deepEqual(updated, [])
})

test('a same-route Settings pick still updates the Bot in place', async () => {
  const { props, updated, switched } = picker()
  await props.onPick('deepseek/pro')
  assert.deepEqual(updated, [['b1', { model: 'deepseek/pro' }]])
  assert.deepEqual(switched, [])
  assert.equal(await props.onPick('deepseek/flash'), undefined)
})

// PLAN-F1-r2 R2.7 (#2061): the level step's Default in Settings clears the Bot's level, idle
// or on the running question's Switch, as the chat menu does.
test('C13a: a Settings crossing picked on a level step\'s Default sends effort null', async () => {
  for (const sending of [undefined, { stopReply: true }]) {
    const { props, updated, switched } = picker()
    await props.onPick('acp-claude/opus', { routeChange: true, level: true }, sending)
    assert.deepEqual(switched, [['b1', 'acp-claude/opus', { effort: null }]], JSON.stringify(sending))
    assert.deepEqual(updated, [])
  }
})
