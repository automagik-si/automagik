// #2026 on the client: the model menu does not offer a model that runs its own tools to a Bot
// that denies acp_tool (and says why), the Denied tools editor does not add acp_tool while the
// Bot runs on one, and Details names what to change for a Bot already in that pair. The host
// marks those models and Bots `ownTools`; the client only reads the mark.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  OWN_TOOLS_CREATE_TEXT, OWN_TOOLS_DENY_TEXT, OWN_TOOLS_MENU_HINT, OWN_TOOLS_MODEL_TEXT, OWN_TOOLS_NOTICE,
} from '../src/shared/own-tools.js'

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export { ModelMenu, ModelSteps } from './src/client/model-menu.js'",
      "export { BotSettingsForm, InlineText } from './src/client/bot-settings.js'",
      "export { DetailsDrawer } from './src/client/details-drawer.js'",
      "export { hostText, installLocale } from './src/client/i18n.js'",
    ].join('\n'),
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
// `menuOpen`: a state that starts empty starts as an open menu's place, so a menu draws its rows.
let menuOpen = false
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial === null && menuOpen ? { left: 0, top: 0, width: 240 }
    : typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {}, useLayoutEffect() {}, useMemo: make => make(), useRef: current => ({ current }),
  useId: () => 'id', useCallback: fn => fn,
  createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value,
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, URL, URLSearchParams, setTimeout, clearTimeout, console,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node }
    : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : {}),
  window: { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false }) },
  document: { body: { dataset: {} }, activeElement: null },
  matchMedia: () => ({ matches: false }),
})
const { ModelMenu, ModelSteps, BotSettingsForm, DetailsDrawer, hostText, installLocale } = module.exports

const find = (node, match, found = []) => {
  if (Array.isArray(node)) { node.forEach(child => find(child, match, found)); return found }
  if (!node || typeof node !== 'object') return found
  if (match(node)) found.push(node)
  find(node.props?.children, match, found)
  return found
}
const textOf = node => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('')
  : node?.props ? textOf(node.props.children) : '')

const KEPT = 'acp-codex/gpt-5.5'
const SOL = 'acp-codex/gpt-6.1-sol'
const AGY = 'acp-antigravity/default'
const models = [
  { ref: KEPT, provider: 'acp-codex', providerName: 'Codex', name: 'GPT-5.5', ownTools: true },
  { ref: SOL, provider: 'acp-codex', providerName: 'Codex', name: 'GPT-6.1 Sol' },
  { ref: AGY, provider: 'acp-antigravity', providerName: 'Antigravity', name: 'Antigravity', ownTools: true },
]
const roster = { models, bots: [], byId: {}, prefs: {} }

// The rows of one step of the menu, by model ref (or agent provider).
const step = (bot, view) => ModelSteps({
  roster, bot, view, current: bot.model ?? bot.appliedModel, go: () => {}, onModel: () => {}, onLevel: () => {},
})
const rowOf = (tree, label) => find(tree, node => node.type === 'button'
  && find(node, child => child.props?.className === 'bt-menu-label' && textOf(child) === label).length > 0)[0]
const hint = row => textOf(find(row, node => node.props?.className === 'bt-menu-hint')[0])

test('the model menu greys a model that runs its own tools for a Bot that denies acp_tool, and says why', () => {
  const denying = { id: 'a', name: 'A', model: SOL, denyTools: ['acp_tool'] }
  const codex = step(denying, { step: 'models', route: 'acp', provider: 'acp-codex' })
  const kept = rowOf(codex, 'GPT-5.5')
  assert.equal(kept.props['data-unavailable'], '')
  assert.equal(hint(kept), OWN_TOOLS_MENU_HINT)
  assert.equal(kept.props.title, OWN_TOOLS_MODEL_TEXT)
  assert.equal(kept.props['aria-label'], `GPT-5.5 · ${OWN_TOOLS_MENU_HINT}`)
  const sol = rowOf(codex, 'GPT-6.1 Sol')
  assert.equal(sol.props['data-unavailable'], undefined)
  assert.equal(sol.props['aria-checked'], true)

  // Antigravity's agent row says why too, and still opens its model step.
  const agents = step(denying, { step: 'agents', route: 'acp' })
  const agy = rowOf(agents, 'Antigravity')
  assert.equal(agy.props['data-unavailable'], '')
  assert.equal(hint(agy), OWN_TOOLS_MENU_HINT)
  assert.equal(rowOf(agents, 'Codex').props['data-unavailable'], undefined)

  // Without acp_tool denied the same rows are ordinary.
  const open = { id: 'b', name: 'B', model: SOL, denyTools: ['bash'] }
  const plain = rowOf(step(open, { step: 'models', route: 'acp', provider: 'acp-codex' }), 'GPT-5.5')
  assert.equal(plain.props['data-unavailable'], undefined)
  assert.equal(plain.props.title, KEPT)
  assert.equal(rowOf(step(open, { step: 'agents', route: 'acp' }), 'Antigravity').props['data-unavailable'], undefined)

  // A Bot already on such a model keeps it shown and ticked.
  const already = { id: 'c', name: 'C', model: KEPT, denyTools: ['acp_tool'] }
  const current = rowOf(step(already, { step: 'models', route: 'acp', provider: 'acp-codex' }), 'GPT-5.5')
  assert.equal(current.props['data-unavailable'], undefined)
  assert.equal(current.props['aria-checked'], true)
  const appliedOnly = { id: 'd', name: 'D', appliedModel: KEPT, denyTools: ['acp_tool'] }
  assert.equal(rowOf(step(appliedOnly, { step: 'models', route: 'acp', provider: 'acp-codex' }), 'GPT-5.5')
    .props['data-unavailable'], undefined)
})

test('a refused row sends nothing, not even a sign-in, while another model still picks', () => {
  const calls = []
  const actions = {
    updateBot: (id, patch) => { calls.push(['updateBot', id, patch.model]); return Promise.resolve() },
    openCliLogin: (...args) => { calls.push(['openCliLogin', ...args]) },
  }
  const bot = { id: 'a', name: 'A', model: SOL, denyTools: ['acp_tool'] }
  menuOpen = true
  try {
    const menu = ModelMenu({ bot, roster, actions, run: promise => promise, chat: true, withEfforts: false })
    const drawn = menu.type(menu.props)
    const steps = find(drawn, node => node.type === ModelSteps)[0]
    assert.ok(steps, 'the open menu draws its steps')
    steps.props.onModel({ ...models[0], needsSignIn: true }, 'acp')
    steps.props.onModel(models[0], 'acp')
    steps.props.onModel(models[2], 'acp')
    assert.deepEqual(calls, [])
    steps.props.onModel({ ...models[1], ref: 'acp-codex/gpt-5.6-luna', name: 'Luna' }, 'acp')
    assert.deepEqual(calls, [['updateBot', 'a', 'acp-codex/gpt-5.6-luna']])
  } finally {
    menuOpen = false
  }
})

// The Denied tools field of the settings form, and its save.
function denyField(bot) {
  const updates = []
  const runs = []
  const actions = {
    updateBot: (id, patch) => { updates.push(patch.denyTools); return Promise.resolve({}) },
    refreshModels: () => Promise.resolve(),
  }
  const run = (promise) => {
    const settled = Promise.resolve(promise).then(() => undefined, error => error.message)
    runs.push(settled)
    return settled
  }
  const tree = BotSettingsForm({ bot, roster: { mainBotId: 'm', mainBotIds: ['m'], memory: false }, actions, run })
  const field = find(tree, node => node.props?.label === 'Denied tools' && typeof node.props?.onSave === 'function')[0]
  assert.ok(field, 'the Denied tools field is drawn')
  return { save: text => field.props.onSave(text), updates, runs }
}

test('the Denied tools editor does not add acp_tool while the Bot runs on a model that runs its own tools', async () => {
  const fresh = denyField({ id: 'a', name: 'A', model: KEPT, ownTools: true, instructions: '' })
  assert.equal(await fresh.save('acp_tool'), OWN_TOOLS_DENY_TEXT)
  assert.deepEqual(fresh.updates, [], 'no update-bot is sent')
  await fresh.save('bash')
  assert.deepEqual(fresh.updates.map(list => [...list]), [['bash']])

  // Already in the pair: keeping or removing acp_tool saves.
  const already = denyField({ id: 'b', name: 'B', model: KEPT, ownTools: true, denyTools: ['acp_tool', 'bash'], instructions: '' })
  await already.save('acp_tool')
  await already.save('acp_tool, write')
  await already.save('')
  assert.deepEqual(already.updates.map(list => list === null ? null : [...list]), [['acp_tool'], ['acp_tool', 'write'], null])

  // A Bot on a model that does not run its own tools adds it.
  const plain = denyField({ id: 'c', name: 'C', model: SOL, instructions: '' })
  await plain.save('acp_tool')
  assert.deepEqual(plain.updates.map(list => [...list]), [['acp_tool']])
})

const hook = value => select => select(value)
const drawer = bot => DetailsDrawer({
  sessionId: bot.id,
  roster: { bots: [bot], rooms: [], agents: [], byId: { [bot.id]: bot }, roomsById: {}, agentOf: {}, models,
    mainBotId: 'm', mainBotIds: ['m'], exchangeTurns: {}, questions: {}, ready: true, memory: false },
  actions: {},
  useSessions: hook({ byId: {} }), useSessionStatus: hook(new Map()), useActivity: hook({}),
  useWork: hook({ bots: {}, approvals: [] }), useBrowserTabs: hook({}), useBrowserPages: hook({}),
})
const noticeOf = tree => find(tree, node => node.props?.['data-own-tools'] !== undefined)

test('Details names what to change for a Bot already denying acp_tool on such a model', () => {
  const notice = noticeOf(drawer({ id: 'a', name: 'A', sessionId: 'a', model: KEPT, ownTools: true, denyTools: ['acp_tool'] }))
  assert.equal(notice.length, 1)
  assert.equal(notice[0].props.className, 'bt-note')
  assert.equal(textOf(notice[0]), OWN_TOOLS_NOTICE)
  // Not for a Bot outside the pair.
  assert.equal(noticeOf(drawer({ id: 'b', name: 'B', sessionId: 'b', model: KEPT, ownTools: true, denyTools: ['bash'] })).length, 0)
  assert.equal(noticeOf(drawer({ id: 'c', name: 'C', sessionId: 'c', model: SOL, denyTools: ['acp_tool'] })).length, 0)
})

// #1564 Antigravity: with its switch, denied tools lock it OFF, so nothing runs and Details drops
// the notice; an acp-dsh that does not offer the switch (`unoffered`) still runs agy's tools.
test('Details drops the own-tools notice for an Antigravity Bot with its switch, and keeps it while unoffered', () => {
  const agy = { id: 'g', name: 'G', sessionId: 'g', model: AGY, ownTools: true, denyTools: ['acp_tool'], nativeToolsBlock: 'restricted' }
  assert.equal(noticeOf(drawer(agy)).length, 0)
  const unoffered = noticeOf(drawer({ ...agy, nativeToolsBlock: 'unoffered' }))
  assert.equal(unoffered.length, 1)
  assert.equal(textOf(unoffered[0]), OWN_TOOLS_NOTICE)
})

test('every own-tools text reads in Chinese and in Brazilian Portuguese, host refusals included', () => {
  const texts = [OWN_TOOLS_MODEL_TEXT, OWN_TOOLS_MENU_HINT, OWN_TOOLS_DENY_TEXT, OWN_TOOLS_NOTICE, OWN_TOOLS_CREATE_TEXT]
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  let zh
  let active = 'zh'
  const off = installLocale({
    register: (_namespace, _locale, dictionary) => { zh = dictionary; return () => {} },
    bind: () => key => (active === 'zh' ? zh : pt)[key] ?? key,
    language: () => active,
  })
  try {
    for (const text of texts) {
      assert.ok(zh[text] && zh[text] !== text, `zh: ${text}`)
      assert.ok(pt[text] && pt[text] !== text, `pt-BR: ${text}`)
      // A refusal from the host (a proposal card's Apply, a menu pick) is worded whole.
      assert.equal(hostText(text), zh[text])
    }
    const notice = noticeOf(drawer({ id: 'a', name: 'A', sessionId: 'a', model: KEPT, ownTools: true, denyTools: ['acp_tool'] }))
    assert.equal(textOf(notice[0]), zh[OWN_TOOLS_NOTICE])
    const kept = rowOf(step({ id: 'b', name: 'B', model: SOL, denyTools: ['acp_tool'] }, { step: 'models', route: 'acp', provider: 'acp-codex' }), 'GPT-5.5')
    assert.equal(hint(kept), zh[OWN_TOOLS_MENU_HINT])
    active = 'pt'
    for (const text of texts) assert.equal(hostText(text), pt[text])
  } finally { off() }
})

// A proposal card's Apply (propose_bot_change) saves through update-bot like the form does: a
// host refusal comes back through api.js, worded in the person's language, and the card draws
// it in its error line. Its own bundle and stand-in React keep what the card sets.
test('a proposal card whose Apply is refused shows the own-tools refusal in its error line', async () => {
  const { outputFiles: [card] } = await build({
    stdin: {
      contents: [
        "export { ProposalCard } from './src/client/settings-card.js'",
        "export { call } from './src/client/api.js'",
        "export { installLocale } from './src/client/i18n.js'",
      ].join('\n'),
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  // useState hands out the values queued in `states`, and records every value set, by the
  // order of its useState call in a draw (the card's state first, then its error).
  let states = []
  let slot = 0
  const sets = []
  const stateful = {
    ...react,
    useState: (initial) => {
      const index = slot++
      return [states.length > 0 ? states.shift() : initial, (value) => { sets.push([index, value]) }]
    },
  }
  const draw = (values) => {
    states = values
    slot = 0
    return ProposalCard(props)
  }
  const requests = []
  const fetch = async (_route, options) => {
    requests.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ ok: false, error: { code: 'bot/refused', message: OWN_TOOLS_MODEL_TEXT } }) }
  }
  const loaded = { exports: {} }
  runInNewContext(card.text, {
    module: loaded, exports: loaded.exports, URL, URLSearchParams, setTimeout, clearTimeout, console, fetch, Promise,
    require: name => (name === 'react' ? stateful : name === 'react-dom' ? { createPortal: node => node }
      : name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : {}),
    window: { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false }) },
    document: { body: { dataset: {} }, activeElement: null },
    matchMedia: () => ({ matches: false }),
  })
  const { ProposalCard, call, installLocale: install } = loaded.exports
  const pt = JSON.parse(readFileSync(new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url)))
  const bot = { id: 'b', name: 'B', model: SOL, denyTools: ['acp_tool'] }
  const props = {
    proposal: { bot: 'b', change: { model: KEPT } },
    roster: { ...roster, bots: [bot], byId: { b: bot } },
    actions: { updateBot: (id, patch) => call('update-bot', { id, ...patch }) },
  }
  const off = install({
    register: () => () => {},
    bind: () => key => pt[key] ?? key,
    language: () => 'pt-BR',
  })
  try {
    const [apply] = find(draw(['open', '']), node => node.type === 'button' && node.props.className === 'bt-q-submit')
    await apply.props.onClick()
    assert.deepEqual(requests.map(request => [request.endpoint, request.payload]), [['update-bot', { id: 'b', model: KEPT }]])
    const last = index => sets.findLast(([at]) => at === index)?.[1]
    assert.equal(last(0), 'open')
    const message = last(1)
    assert.equal(message, pt[OWN_TOOLS_MODEL_TEXT])
    // Drawn again with what Apply set: the card is open, and its error line says why.
    const errors = find(draw([last(0), message]), node => node.props?.className === 'bt-error bt-propcard-error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].props.role, 'alert')
    assert.equal(textOf(errors[0]), pt[OWN_TOOLS_MODEL_TEXT])
  } finally { off() }
})
