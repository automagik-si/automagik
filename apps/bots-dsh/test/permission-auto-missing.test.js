// Auto availability explanations use only the roster and never choose a level.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'

const plugin = fileURLToPath(new URL('..', import.meta.url))
const { outputFiles } = await build({
  stdin: { contents: [
    "export { autoMissingText, AutoMissingNote } from './src/client/permission-picker.js'",
    "export { ComposerPermission } from './src/client/composer.js'",
    "export { PermissionChoiceDock, reopenPermissionChoice } from './src/client/permission-card.js'",
    "export { SettingsDialog } from './src/client/settings.js'",
    "export { CreateBot } from './src/client/create-bot.js'",
  ].join('\n'), resolveDir: plugin },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// A small stateful React, as permission-picker.test.js uses: cells live across renders.
function load() {
  const cells = []
  const prev = []
  let hook = 0
  let effects = []
  const changed = (deps, before) => deps === undefined || before === undefined || deps.length !== before.length || deps.some((dep, i) => !Object.is(dep, before[i]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const i = hook++
      if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
      return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }]
    },
    useRef(initial) { const i = hook++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
    useEffect(fn, deps) { effects.push({ i: hook++, fn, deps }) },
    useLayoutEffect(fn, deps) { effects.push({ i: hook++, fn, deps }) },
    useMemo: make => make(),
    useCallback: f => f,
    useId: () => 'id',
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    Fragment: Symbol('Fragment'),
  }
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => { store.set(key, String(value)) }, removeItem: key => store.delete(key) }
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, window: { localStorage, innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {} }, localStorage,
    document: { body: {}, addEventListener() {}, removeEventListener() {} },
    URL, URLSearchParams, setTimeout, clearTimeout, navigator: {}, Date, Promise, Intl, console,
    require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: child => child } : {}),
  })
  // One component kept across renders: its own hooks only, children expanded without hooks.
  const render = (component, props) => {
    hook = 0
    effects = []
    const tree = component(props)
    for (const { i, fn, deps } of effects) if (changed(deps, prev[i])) { prev[i] = deps; fn() }
    return tree
  }
  return { ...module.exports, render }
}

// Every node of a tree, components expanded (only ones that use no hook of their own).
function nodes(tree, out = []) {
  if (Array.isArray(tree)) { for (const item of tree) nodes(item, out); return out }
  if (tree === null || tree === undefined || typeof tree !== 'object') { if (typeof tree === 'string' || typeof tree === 'number') out.push(String(tree)); return out }
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props), out)
  out.push(tree)
  return nodes(tree.props?.children, out)
}
const textOf = tree => nodes(tree).filter(node => typeof node === 'string').join(' ')
const buttons = tree => nodes(tree).filter(node => node?.type === 'button')
const labelOf = button => textOf(button.props.children)

const S1 = "Auto is not a choice here: it is turned on for one Bot at a time, in its chat or Details, when its model offers it."
const S2 = "After the Bot is created, Auto can be turned on in its chat or Details, when its model offers it."
const S3 = "Auto does not count in group chats. A member on Auto works here as Workspace, or at the group's shared level when one is set."
const R1 = "This Bot runs on its plugin's own engine, so Auto is not offered."
const R2 = "Auto needs a model chosen for this Bot."
const R3 = "Auto is not offered on Remote Hermes."
const R4 = "Auto is not offered for this Bot's model."
const R5 = "Auto is offered once this Bot's chat runs on the model saved for it."
const R6 = "On this model, Auto needs a background model, and no connected model can be one. Connect a model with an API key to turn it on."
const R7 = "Auto is not available for this Bot right now."
const REASONS = [R1, R2, R3, R4, R5, R6, R7]

const CATALOG = { options: [
  { value: 'read-only', name: 'Read only' },
  { value: 'workspace-write', name: 'Workspace' },
  { value: 'danger-full-access', name: 'Full access' },
], defaultPreset: 'read-only' }
const BOT = { id: 'b1', name: 'Ada', sessionId: 's1', model: 'acp-codex/x', appliedModel: 'acp-codex/x', permission: 'workspace-write' }

// Settings and creation are inspected without expanding unrelated components and their hooks.
function shallowNodes(tree, out = []) {
  if (Array.isArray(tree)) { for (const item of tree) shallowNodes(item, out); return out }
  if (tree === null || tree === undefined) return out
  out.push(tree)
  if (typeof tree === 'object') shallowNodes(tree.props?.children, out)
  return out
}
const shallowText = tree => shallowNodes(tree).filter(node => typeof node === 'string').join(' ')

test('missing Auto reasons follow the roster, with offered, saved and view-only cases silent', () => {
  const { autoMissingText, AutoMissingNote } = load()
  const cases = [
    ['no Bot', undefined, {}, undefined],
    ['offered', { ...BOT, autoOffered: true }, {}, undefined],
    ['saved', { ...BOT, permissionAuto: 'acp-codex' }, {}, undefined],
    ['view-only', BOT, { readOnly: true }, undefined],
    ['gone level', { ...BOT, permissionNotOffered: true }, {}, undefined],
    ['engine', BOT, { hostModels: { [BOT.id]: {} } }, R1],
    ['no model', { ...BOT, model: undefined }, {}, R2],
    ['empty model', { ...BOT, model: '' }, {}, R2],
    ['Remote Hermes', { ...BOT, model: 'hermes-remote/p:m', appliedModel: undefined }, {}, R3],
    ['mixed Remote Hermes', { ...BOT, model: 'hermes-remote/p:m' }, {}, R3],
    ['unsupported agent', { ...BOT, model: 'acp-gemini/x' }, {}, R4],
    ['retired route', { ...BOT, model: 'claude-code/opus' }, {}, R4],
    ['not applied', { ...BOT, model: 'deepseek/v3', appliedModel: undefined }, {}, R5],
    ['different agent', { ...BOT, appliedModel: 'acp-claude/y' }, {}, R5],
    ...['acp-hermes', 'acp-antigravity', 'acp-omp'].flatMap(agent => [
      [agent + ' without background', { ...BOT, model: agent + '/x', appliedModel: agent + '/x' }, { backgroundModel: null }, R6],
      [agent + ' with background', { ...BOT, model: agent + '/x', appliedModel: agent + '/x' }, { backgroundModel: 'deepseek/v3' }, R7],
    ]),
    ...['acp-codex/x', 'acp-claude/x', 'deepseek/v3', 'grok/x'].map(model => [
      model, { ...BOT, model, appliedModel: model }, {}, R7,
    ]),
    ['offered with tool deny list', { ...BOT, autoOffered: true, denyTools: ['bash'] }, {}, undefined],
  ]
  for (const [name, bot, extra, expected] of cases) {
    const roster = { permissions: CATALOG, ...extra }
    assert.equal(autoMissingText(bot, roster), expected, name)
    const note = AutoMissingNote({ bot, roster })
    if (expected === undefined) assert.equal(note, null, name)
    else {
      assert.equal(note.props.className, 'bt-note', name)
      assert.equal(textOf(note), expected, name)
    }
  }
})

for (const offered of [false, true]) {
  const bot = { ...BOT, autoOffered: offered, ...(offered ? { autoJudge: { by: 'codex' } } : {}) }
  const check = tree => {
    const rows = buttons(tree).filter(button => button.props['data-permission'] === 'workspace-write:auto')
    assert.equal(rows.length, offered ? 1 : 0)
    const text = textOf(tree)
    assert.deepEqual(REASONS.filter(reason => text.includes(reason)), offered ? [] : [R7])
  }
  const propsOf = calls => ({
    sessionId: bot.sessionId,
    useRoster: pick => pick({ byId: { [bot.sessionId]: bot }, permissions: CATALOG, ready: true }),
    actions: new Proxy({}, { get: (_target, name) => (...args) => { calls.push([name, args]); return Promise.resolve({}) } }),
  })
  test('composer menu explains Auto only when not offered: offered=' + offered, () => {
    const { ComposerPermission, render } = load()
    const calls = []
    const props = propsOf(calls)
    let tree = render(ComposerPermission, props)
    const chip = buttons(tree).find(button => button.props.className === 'bt-perm-chip')
    chip.props.ref.current = { getBoundingClientRect: () => ({ width: 160, right: 800, top: 600, bottom: 640 }) }
    chip.props.onClick()
    for (let i = 0; i < 3; i++) tree = render(ComposerPermission, props)
    const menu = nodes(tree).find(node => node?.props?.role === 'menu' && node.props['aria-label'] === 'Permissions')
    assert.ok(menu)
    check(menu)
    assert.deepEqual(calls, [])
  })
  test('chat card explains Auto only when not offered and sends nothing: offered=' + offered, () => {
    const { PermissionChoiceDock, reopenPermissionChoice, render } = load()
    const calls = []
    reopenPermissionChoice(bot.id)
    const dock = PermissionChoiceDock(propsOf(calls))
    const card = dock.props.children.find(child => typeof child?.type === 'function')
    assert.ok(card)
    check(render(card.type, card.props))
    assert.deepEqual(calls, [])
  })
}

for (const empty of [false, true]) {
  test('Settings explains the default without an Auto choice: empty catalog=' + empty, () => {
    const { SettingsDialog } = load()
    const roster = { bots: [], byId: {}, roomsById: {}, prefs: {}, permissions: empty ? { options: [] } : CATALOG }
    const dialog = SettingsDialog({ page: 'bots', roster, actions: {} })
    const page = shallowNodes(dialog).find(node => node?.type?.name === 'BotsPage')
    assert.ok(page)
    const section = shallowNodes(page.type(page.props)).find(node => node?.type?.name === 'PermissionsSection')
    assert.ok(section)
    const tree = section.type(section.props)
    if (empty) { assert.equal(tree, null); return }
    assert.ok(shallowText(tree).includes(S1))
    const picker = shallowNodes(tree).find(node => node?.type?.name === 'PermissionPicker')
    assert.ok(picker)
    const choice = picker.type(picker.props)
    assert.deepEqual(shallowNodes(choice).filter(node => node?.type === 'button').map(labelOf), ['Read only', 'Workspace', 'Full access'])
  })
  test('Create Bot explains Auto after the starting level: missing level=' + empty, () => {
    const { CreateBot, render } = load()
    const roster = { bots: [], models: [], prefs: {}, ...(empty ? {} : { permissions: CATALOG }) }
    const tree = render(CreateBot, { roster, actions: {}, onBack() {}, onCreated() {} })
    const text = shallowText(tree)
    const start = 'New Bots start at Read only.'
    assert.equal(text.includes(start), !empty)
    assert.equal(text.includes(S2), !empty)
    if (!empty) assert.ok(text.indexOf(start) < text.indexOf(S2))
  })
}

test('all ten literal lines have exact Chinese and pt-BR translations with matching placeholders', () => {
  const source = ['permission-picker.js', 'details-drawer.js', 'group-settings.js', 'settings.js', 'create-bot.js']
    .map(file => readFileSync(new URL('../src/client/' + file, import.meta.url), 'utf8')).join('\n')
  const ptBR = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8'))
  const translations = [
    [S1, '这里不能选择自动模式：只能在某个 Bot 的对话或详情中为该 Bot 单独开启，且需其模型支持。', 'O Automático não é uma opção aqui: é ativado para um Bot de cada vez, na conversa ou em Detalhes desse Bot, quando o modelo do Bot o oferece.'],
    [S2, '创建 Bot 后，如果其模型支持，可以在它的对话或详情中开启自动模式。', 'Depois que o Bot for criado, o Automático pode ser ativado na conversa ou em Detalhes desse Bot, quando o modelo do Bot oferece essa opção.'],
    [S3, '自动模式在群聊中不生效。使用自动模式的成员在这里按“工作区内修改”运行；如果群聊设置了统一级别，则按该级别运行。', 'O Automático não vale em chats em grupo. Aqui, um membro em Automático funciona como Área de trabalho, ou no nível compartilhado do grupo, quando houver um.'],
    [R1, '此 Bot 运行在其插件自带的引擎上，因此不提供自动模式。', 'Este Bot roda no mecanismo do próprio plugin, então o Automático não é oferecido.'],
    [R2, '自动模式需要先为此 Bot 选择模型。', 'O Automático precisa de um modelo escolhido para este Bot.'],
    [R3, '远程 Hermes 不提供自动模式。', 'O Automático não é oferecido no Hermes remoto.'],
    [R4, '此 Bot 的模型不提供自动模式。', 'O Automático não é oferecido para o modelo deste Bot.'],
    [R5, '当此 Bot 的对话在为它保存的模型上运行后，才会提供自动模式。', 'O Automático passa a ser oferecido quando a conversa deste Bot rodar no modelo salvo para o Bot.'],
    [R6, '在此模型上，自动模式需要后台模型，但目前没有可用作后台模型的已连接模型。连接一个使用 API 密钥的模型即可开启。', 'Neste modelo, o Automático precisa de um modelo de segundo plano, e nenhum modelo conectado pode ser usado. Conecte um modelo com chave de API para ativá-lo.'],
    [R7, '此 Bot 目前无法使用自动模式。', 'O Automático não está disponível para este Bot agora.'],
  ]
  assert.deepEqual(translations.map(([key]) => key), [S1, S2, S3, ...REASONS])
  const holes = text => (text.match(/\{\w+\}/g) ?? []).sort().join(',')
  for (const [key, zh, pt] of translations) {
    const literal = key.includes("'") ? JSON.stringify(key) : "'" + key + "'"
    assert.ok(source.includes('t(' + literal + ')'), 'English literal: ' + key)
    for (const [language, table, expected] of [['Chinese', DICTIONARY.zh, zh], ['pt-BR', ptBR, pt]]) {
      assert.equal(table[key], expected, language + ' exact text: ' + key)
      assert.doesNotMatch(table[key], /[`|]/, language + ' has no markup debris: ' + key)
      assert.equal(typeof table[key], 'string', language + ': ' + key)
      assert.notEqual(table[key], key, language + ' translates: ' + key)
      assert.equal(holes(table[key]), holes(key), language + ' keeps placeholders: ' + key)
    }
  }
})
