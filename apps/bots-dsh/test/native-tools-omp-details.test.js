import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: [
    "export { NativeToolsRow } from './src/client/details-drawer.js'",
    "export { installLocale } from './src/client/i18n.js'",
  ].join('\n'), resolveDir: import.meta.dirname + '/..' },
  bundle: true, platform: 'browser',
  format: 'cjs', external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'], write: false,
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  require: () => ({ createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children }) }),
})
const { NativeToolsRow, installLocale } = module.exports
const updates = []
const render = bot => NativeToolsRow({
  bot: { id: 'a', model: 'acp-omp/default', ...bot }, roster: {},
  actions: { updateBot: (id, patch) => { updates.push([id, { ...patch }]) } }, run: () => {},
})
const label = 'Native tools'
const onHint = "omp uses its own tools in all of this Bot's chats: its direct chat, groups, tasks and scheduled runs, with anyone who can talk to it. They run outside Automagik's file sandbox. Turning this off stops its running sessions at once."
const offHint = "With this off, omp has no tools at all in any of this Bot's chats, so this Bot can only chat. Turning this on applies from the next message in each chat."
const suffix = 'Here omp has no tools, so this Bot can only chat.'

test('Details shows omp for current and carried model refs, with exact ON and OFF copy and the owner update', () => {
  const off = render({})
  assert.equal(off.props.label, label)
  assert.equal(off.props.details, true)
  assert.equal(off.props.on, false)
  assert.equal(off.props.hint, offHint)
  const on = render({ model: undefined, appliedModel: 'acp-omp/default', nativeTools: true, nativeToolsKept: 'acp-omp' })
  assert.equal(on.props.on, true)
  assert.equal(on.props.hint, onHint)
  on.props.onChange(false)
  assert.deepEqual(updates, [['a', { nativeTools: false }]])
})

test('a blocked omp switch is disabled and explains chat only', () => {
  const blocked = render({ nativeTools: true, nativeToolsBlock: 'read-only' })
  assert.equal(blocked.props.disabled, true)
  assert.equal(blocked.props.on, false)
  assert.equal(blocked.props.hint, 'Not available at the Read only level. ' + suffix)
  assert.equal(render({ nativeToolsBlock: 'multiuser' }), null)
})

test('an omp migration tag shows OFF on Claude, and other agent rows stay absent', () => {
  const claude = render({ model: 'acp-claude/default', nativeTools: true, nativeToolsKept: 'acp-omp' })
  assert.equal(claude.props.label, label)
  assert.equal(claude.props.details, true)
  assert.equal(claude.props.on, false)
  // #1564 PR B: Codex has the row too; Hermes and Antigravity still have none.
  for (const provider of ['acp-hermes', 'acp-antigravity']) assert.equal(render({ model: provider + '/default' }), null)
  assert.equal(render({ model: 'acp-codex/default' }).props.on, false)
})

test('both locale services carry the shared title and the approved omp descriptions', () => {
  let zh
  const dispose = installLocale({
    register: (_namespace, _locale, dictionary) => { zh = dictionary; return () => {} },
    bind: () => key => zh[key] ?? key,
  })
  try {
    const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
    for (const [key, chinese, portuguese] of [
      [label, '原生工具', 'Tools nativas'],
      [onHint, 'omp 在此 Bot 的所有对话中使用它自己的工具：单独对话、群组、任务和定时运行，无论是谁在与它对话。这些工具在 Automagik 的文件沙盒之外运行。关闭后会立即停止它正在运行的会话。', 'O omp usa as próprias ferramentas em todos os chats deste Bot: o chat direto, grupos, tarefas e execuções agendadas, com qualquer pessoa que fale com este Bot. Essas ferramentas rodam fora da área restrita de arquivos do Automagik. Desligar encerra na hora as sessões em andamento.'],
      [offHint, '关闭后，omp 在此 Bot 的所有对话中都没有任何工具，此 Bot 只能聊天。开启后，从每个对话的下一条消息起生效。', 'Com isto desligado, o omp fica sem nenhuma ferramenta em todos os chats deste Bot, e este Bot só pode conversar. Ao ligar, vale a partir da próxima mensagem em cada chat.'],
      [suffix, '在这里 omp 没有任何工具，此 Bot 只能聊天。', 'Aqui o omp fica sem ferramentas, e este Bot só pode conversar.'],
    ]) {
      assert.equal(zh[key], chinese)
      assert.equal(pt[key], portuguese)
    }
    assert.equal(zh['The tools setting changed; send again.'], '工具设置已更改，请重新发送。')
    assert.equal(pt['The tools setting changed; send again.'], 'A configuração de ferramentas mudou; envie de novo.')
  } finally { dispose() }
})
