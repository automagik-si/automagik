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
const agyOnHint = "Antigravity uses its own tools in all of this Bot's chats: its direct chat, groups, tasks and scheduled runs, with anyone who can talk to it. They run outside Automagik's file sandbox. What asks you first depends on the permission level. Turning this off stops its running sessions at once."
const agyOffHint = "With this off, Antigravity has no tools at all in any of this Bot's chats, so this Bot can only chat. Turning this on applies from the next message in each chat."
const agySuffix = 'Here Antigravity has no tools, so this Bot can only chat.'
const unchecked = 'Native tools off is checked on agy {version}; this version was not checked.'
const hooks = "Antigravity can't start with native tools off while its settings hold a hooks.json file. Remove hooks.json to use it with native tools off."
const plugins = "Antigravity can't start with native tools off while its settings hold plugins."
const fresh = 'Switch account on Antigravity in Settings starts it with empty settings; it also signs it out.'
const firstTurn = 'The check that Antigravity loaded its native-tools-off settings does not cover the first message after Antigravity starts, only the messages after it.'
const firstTurnZh = '关于 Antigravity 是否已加载关闭原生工具设置的检查，不涵盖 Antigravity 启动后的第一条消息，只涵盖之后的消息。'
const firstTurnPt = 'A verificação de que o Antigravity carregou as configurações de ferramentas nativas desligadas não cobre a primeira mensagem depois que o Antigravity inicia, só as mensagens seguintes.'
// The row's lines come from the bundle's own realm: compared as plain arrays.
const notesOf = row => (row.props.notes === undefined ? undefined : [...row.props.notes])
const agy = bot => render({ model: 'acp-antigravity/default', ...bot })

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

test('an omp migration tag shows OFF on Claude, Antigravity has its row, and Hermes stays absent', () => {
  const claude = render({ model: 'acp-claude/default', nativeTools: true, nativeToolsKept: 'acp-omp' })
  assert.equal(claude.props.label, label)
  assert.equal(claude.props.details, true)
  assert.equal(claude.props.on, false)
  // #1564 PR B: Codex has the row too. #1564 Antigravity: Antigravity has its row (locked at Read
  // only); Hermes still has none.
  assert.equal(render({ model: 'acp-hermes/default' }), null)
  const agy = render({ model: 'acp-antigravity/default' })
  assert.equal(agy.props.label, label)
  assert.equal(agy.props.on, false)
  assert.equal(agy.props.hint, agyOffHint)
  const agyReadOnly = render({ model: 'acp-antigravity/default', nativeToolsBlock: 'read-only' })
  assert.equal(agyReadOnly.props.disabled, true)
  assert.equal(agyReadOnly.props.hint, 'Not available at the Read only level. ' + agySuffix)
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

test('Antigravity: ON and OFF copy, the owner update, and no row while acp-dsh does not offer it', () => {
  const off = agy({})
  assert.equal(off.props.on, false)
  assert.equal(off.props.disabled, false)
  assert.equal(off.props.hint, agyOffHint)
  assert.deepEqual(notesOf(off), [firstTurn])
  const on = agy({ appliedModel: 'acp-antigravity/default', model: undefined, nativeTools: true, nativeToolsAgent: 'acp-antigravity' })
  assert.equal(on.props.on, true)
  assert.equal(on.props.hint, agyOnHint)
  updates.length = 0
  on.props.onChange(false)
  assert.deepEqual(updates, [['a', { nativeTools: false }]])
  // An ON saved for another agent reads OFF on Antigravity.
  assert.equal(agy({ nativeTools: true, nativeToolsAgent: 'acp-omp' }).props.on, false)
  assert.equal(agy({ nativeToolsBlock: 'unoffered' }), null)
  assert.equal(agy({ nativeToolsBlock: 'unoffered', nativeTools: true, nativeToolsAgent: 'acp-antigravity' }), null)
  assert.equal(agy({ nativeToolsBlock: 'multiuser' }), null)
})

test('Antigravity: the unchecked-version, first-message, hooks, plugins and Switch account lines', () => {
  const version = unchecked.replace('{version}', '1.5.15')
  // Not ON (OFF or locked): the first-message line, after the version line, before hooks and plugins.
  assert.deepEqual(notesOf(agy({ nativeToolsUnchecked: '1.5.15' })), [version, firstTurn])
  assert.deepEqual(notesOf(agy({ nativeToolsUnchecked: '1.5.15', nativeTools: true, nativeToolsAgent: 'acp-antigravity' })), [version])
  assert.deepEqual(notesOf(agy({ nativeToolsUnchecked: '1.5.15', nativeToolsBlock: 'read-only' })), [version, firstTurn])
  assert.deepEqual(notesOf(agy({ nativeToolsHooks: true })), [firstTurn, hooks])
  assert.deepEqual(notesOf(agy({ nativeToolsPlugins: true })), [firstTurn, plugins])
  assert.deepEqual(notesOf(agy({ nativeToolsHooks: true, nativeToolsPlugins: true, nativeToolsFresh: true })), [firstTurn, hooks, plugins, fresh])
  assert.deepEqual(notesOf(agy({ nativeToolsPlugins: true, nativeToolsFresh: true, nativeToolsBlock: 'restricted' })), [firstTurn, plugins, fresh])
  assert.deepEqual(notesOf(agy({ nativeToolsPlugins: true, nativeToolsFresh: false })), [firstTurn, plugins])
  // ON: no first-message, hooks, plugins or Switch account line.
  assert.equal(agy({ nativeToolsHooks: true, nativeToolsPlugins: true, nativeToolsFresh: true, nativeTools: true, nativeToolsAgent: 'acp-antigravity' }).props.notes, undefined)
  // The Switch account line only follows a hooks or plugins line; never on another agent.
  assert.deepEqual(notesOf(agy({ nativeToolsFresh: true })), [firstTurn])
  assert.equal(render({ model: 'acp-omp/default', nativeToolsUnchecked: '1.5.15', nativeToolsHooks: true, nativeToolsFresh: true }).props.notes, undefined)
})

// #1564 AJ-1 (lead decision (1)): Details says plainly that the log check does not cover the first
// message after agy starts, whenever the row is not ON; never when the row is hidden.
test('Antigravity: the first-message line shows OFF and locked, in English, Chinese and Portuguese, and never ON', () => {
  const locked = { nativeTools: true, nativeToolsAgent: 'acp-antigravity', nativeToolsBlock: 'read-only' }
  const on = { nativeTools: true, nativeToolsAgent: 'acp-antigravity' }
  assert.deepEqual(notesOf(agy({})), [firstTurn])
  assert.deepEqual(notesOf(agy(locked)), [firstTurn])
  assert.equal(agy(on).props.notes, undefined)
  assert.equal(agy({ nativeToolsBlock: 'unoffered' }), null)
  assert.equal(agy({ nativeToolsBlock: 'multiuser' }), null)
  // Never on another agent's row.
  for (const model of ['acp-omp/default', 'acp-claude/default', 'acp-codex/default']) assert.equal(render({ model }).props.notes, undefined)
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  assert.equal(pt[firstTurn], firstTurnPt)
  for (const [dictionary, expected] of [[null, firstTurnZh], [pt, firstTurnPt]]) {
    let zh
    const dispose = installLocale({
      register: (_namespace, _locale, entries) => { zh = entries; return () => {} },
      bind: () => key => (dictionary ?? zh)[key] ?? key,
    })
    try {
      assert.equal(zh[firstTurn], firstTurnZh)
      assert.deepEqual(notesOf(agy({})), [expected])
      assert.deepEqual(notesOf(agy(locked)), [expected])
      assert.equal(agy(on).props.notes, undefined)
    } finally { dispose() }
  }
})

test('Antigravity: both locale services carry its copy, with {version} kept', () => {
  let zh
  const dispose = installLocale({
    register: (_namespace, _locale, dictionary) => { zh = dictionary; return () => {} },
    bind: () => (key, params) => (zh[key] ?? key).replace('{version}', params?.version ?? '{version}'),
  })
  try {
    const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
    for (const [key, chinese, portuguese] of [
      [agyOnHint, 'Antigravity 在此 Bot 的所有对话中使用它自己的工具：单独对话、群组、任务和定时运行，无论是谁在与它对话。这些工具在 Automagik 的文件沙盒之外运行；哪些操作会先询问你取决于权限级别。关闭后会立即停止它正在运行的会话。', 'O Antigravity usa as próprias ferramentas em todos os chats deste Bot: o chat direto, grupos, tarefas e execuções agendadas, com qualquer pessoa que fale com este Bot. Essas ferramentas rodam fora da área restrita de arquivos do Automagik. O nível de permissão determina o que pede sua aprovação antes. Desligar encerra na hora as sessões em andamento.'],
      [agyOffHint, '关闭后，Antigravity 在此 Bot 的所有对话中都没有任何工具，此 Bot 只能聊天。开启后，从每个对话的下一条消息起生效。', 'Com isto desligado, o Antigravity fica sem nenhuma ferramenta em todos os chats deste Bot, e este Bot só pode conversar. Ao ligar, vale a partir da próxima mensagem em cada chat.'],
      [agySuffix, '在这里 Antigravity 没有任何工具，此 Bot 只能聊天。', 'Aqui o Antigravity fica sem ferramentas, e este Bot só pode conversar.'],
      [unchecked, '关闭原生工具已在 agy {version} 上验证；此版本尚未验证。', 'O desligamento das ferramentas nativas foi verificado no agy {version}; esta versão não foi verificada.'],
      [hooks, 'Antigravity 的设置中有 hooks.json 文件时，无法在关闭原生工具的情况下启动。删除 hooks.json 后即可在关闭原生工具时使用。', 'O Antigravity não pode iniciar com as ferramentas nativas desligadas enquanto as configurações do Antigravity tiverem um arquivo hooks.json. Remova o hooks.json para usá-lo com as ferramentas nativas desligadas.'],
      [plugins, 'Antigravity 的设置中有插件时，无法在关闭原生工具的情况下启动。', 'O Antigravity não pode iniciar com as ferramentas nativas desligadas enquanto as configurações do Antigravity tiverem plugins.'],
      [fresh, '在设置中对 Antigravity 使用“切换账号”，会以空白设置重新开始，同时也会退出它的登录。', 'Em Configurações, Trocar de conta no Antigravity o inicia com as configurações vazias; isso também sai da conta do Antigravity.'],
      [firstTurn, firstTurnZh, firstTurnPt],
    ]) {
      assert.equal(zh[key], chinese)
      assert.equal(pt[key], portuguese)
    }
    for (const dictionary of [zh, pt]) assert.ok(dictionary[unchecked].includes('{version}'))
    // The row fills {version} through t() in the installed locale.
    assert.deepEqual(notesOf(agy({ nativeToolsUnchecked: '9.9.9' })), ['关闭原生工具已在 agy 9.9.9 上验证；此版本尚未验证。', firstTurnZh])
    assert.equal(agy({ nativeToolsBlock: 'read-only' }).props.hint, '在“仅可查看”级别下不可用。 在这里 Antigravity 没有任何工具，此 Bot 只能聊天。')
  } finally { dispose() }
})
