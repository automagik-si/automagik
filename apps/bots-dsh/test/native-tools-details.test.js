import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { nativeToolsCopy, nativeToolsZh } from '../src/client/native-tools-copy.js'

const { outputFiles } = await build({
  stdin: { contents: [
    "export { NativeToolsRow } from './src/client/details-drawer.js'",
    "export { installLocale } from './src/client/i18n.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/..' },
  bundle: true, platform: 'browser',
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false,
})

test('Details registers its translated copy through the normal locale service', () => {
  const { installLocale, NativeToolsRow } = module.exports
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  const props = { bot: { id: 'a', model: 'acp-claude/default', nativeToolsBlock: 'read-only' }, roster: {} }
  let active = 'zh'
  let zh
  const off = installLocale({
    register: (_namespace, _locale, dictionary) => { zh = dictionary; return () => {} },
    bind: () => key => (active === 'zh' ? zh : pt)[key] ?? key,
  })
  try {
    const row = NativeToolsRow(props)
    assert.equal(row.props.label, '原生工具')
    assert.equal(row.props.hint, '在“仅可查看”级别下不可用。')
    for (const key of Object.keys(nativeToolsZh)) {
      assert.equal(zh[key], nativeToolsZh[key])
      assert.ok(pt[key] && pt[key] !== key, key)
    }
    assert.equal(pt[nativeToolsCopy.off], 'O Claude Code usa as ferramentas do Automagik, aprovadas no Automagik, em todos os chats deste Bot. Ao ligar, vale a partir da próxima mensagem em cada chat.')
    active = 'pt'
    assert.equal(NativeToolsRow(props).props.label, 'Tools nativas')
  } finally { off() }
  assert.equal(NativeToolsRow(props).props.label, 'Native tools')
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
  // #1564 PR B: a Codex Bot now has the row, with Codex's own hint.
  assert.equal(render({ model: 'acp-codex/default' }).props.hint, "Codex uses Automagik's tools, approved in Automagik, in all of this Bot's chats. Turning this on applies from the next message in each chat.")
  assert.equal(render({ nativeToolsBlock: 'multiuser' }), null)
  assert.equal(render().props.on, false)
  assert.equal(render().props.hint, "Claude Code uses Automagik's tools, approved in Automagik, in all of this Bot's chats. Turning this on applies from the next message in each chat.")
  assert.equal(render({ nativeTools: true }).props.on, true)
  assert.match(render({ nativeTools: true }).props.hint, /outside Automagik/)
  const blocked = render({ nativeTools: true, nativeToolsBlock: 'read-only' })
  assert.equal(blocked.props.disabled, true)
  assert.equal(blocked.props.on, false)
  assert.equal(blocked.props.hint, 'Not available at the Read only level.')
  render().props.onChange(true)
  assert.deepEqual(updates, [['a', { nativeTools: true }]])
  assert.equal(render().props.on, false)
  render({ nativeTools: true }).props.onChange(false)
  assert.deepEqual(updates, [['a', { nativeTools: true }], ['a', { nativeTools: false }]])
  const readOnly = row({ bot: { ...bot, nativeTools: true }, roster: { readOnly: true } })
  assert.equal(readOnly.props.disabled, true)
  assert.equal(readOnly.props.on, true)
})
