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
  let zh
  const off = installLocale({
    register: (_namespace, _locale, dictionary) => { zh = dictionary; return () => {} },
    bind: () => key => zh[key] ?? key,
  })
  try {
    const row = NativeToolsRow({ bot: { id: 'a', model: 'acp-claude/default', nativeToolsBlock: 'read-only' }, roster: {} })
    assert.equal(row.props.label, 'Claude Code 原生工具')
    assert.equal(row.props.hint, '在“仅可查看”级别下不可用。')
    const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
    for (const key of Object.keys(nativeToolsZh)) {
      assert.equal(zh[key], nativeToolsZh[key])
      assert.ok(pt[key] && pt[key] !== key, key)
    }
    assert.equal(pt[nativeToolsCopy.off], 'O Claude Code usa as ferramentas do Automagik, aprovadas no Automagik. Grupos, tarefas e execuções agendadas sempre usam. Vale a partir da sua próxima mensagem no chat direto deste Bot. Desligar encerra a sessão em andamento.')
  } finally { off() }
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
  assert.equal(render().props.hint, "Claude Code uses Automagik's tools, approved in Automagik. Groups, tasks and scheduled runs always do. Applies from your next message in this Bot's direct chat. Turning it off ends the running session.")
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
