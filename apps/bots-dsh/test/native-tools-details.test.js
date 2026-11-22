import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: ['src/client/details-drawer.js'], bundle: true, platform: 'browser',
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false,
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: () => ({ createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children }) }),
})

test('Details uses a Claude-only switch with the Read only reason and the normal update action', () => {
  const row = module.exports.NativeToolsRow
  assert.equal(typeof row, 'function')
  const updates = []
  const roster = {}
  const bot = { id: 'a', model: 'acp-claude/default' }
  const actions = { updateBot: (id, patch) => { updates.push([id, { ...patch }]) } }
  const render = (patch = {}) => row({ bot: { ...bot, ...patch }, roster, actions, run: () => {} })
  assert.equal(render({ model: 'acp-codex/default' }), null)
  assert.equal(render({ nativeToolsBlock: 'multiuser' }), null)
  assert.equal(render().props.on, false)
  assert.match(render().props.hint, /applies from the next conversation/)
  assert.equal(render({ nativeTools: true }).props.on, true)
  assert.match(render({ nativeTools: true }).props.hint, /outside Automagik/)
  const blocked = render({ nativeTools: true, nativeToolsBlock: 'read-only' })
  assert.equal(blocked.props.disabled, true)
  assert.equal(blocked.props.on, false)
  assert.equal(blocked.props.hint, 'Not available at the Read only level.')
  render().props.onChange(true)
  assert.deepEqual(updates, [['a', { nativeTools: true }]])
  assert.equal(render().props.on, false)
})
