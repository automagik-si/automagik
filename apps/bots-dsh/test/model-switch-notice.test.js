import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/model-switch.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'Fragment', useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      useState: initial => [initial, () => {}], useRef: initial => ({ current: initial }),
      useEffect: () => {}, useMemo: fn => fn(), useCallback: fn => fn,
    }
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { ModelSwitchNotice, modelSwitchOf } = module.exports
const bot = {
  id: 'bot-1', sessionId: 'part-2', name: 'Test Bot',
  model: 'deepseek-official/deepseek-v4', runningModel: 'deepseek-official/deepseek-flash',
}
const models = [
  { ref: bot.model, name: 'DeepSeek V4' },
  { ref: bot.runningModel, name: 'DeepSeek Flash' },
]
const rosterOf = (patch = {}, extra = {}) => {
  const current = { ...bot, ...patch }
  return { byId: { 'part-1': current, 'part-2': current }, models, ...extra }
}
const render = (roster = rosterOf(), sessionId = 'part-2') => ModelSwitchNotice({ sessionId, useRoster: pick => pick(roster) })?.children[1] ?? null
const textOf = row => row.children[0].children[0]

test('current-part mismatch renders both display names', () => {
  const row = render()
  assert.equal(row.type, 'div')
  assert.equal(row.props.className, 'bt-native-note bt-model-switch')
  assert.equal(textOf(row), 'This chat is running on DeepSeek Flash instead of DeepSeek V4.')
  assert.equal(modelSwitchOf(rosterOf(), 'part-2').key, `${bot.id}|${bot.runningModel}|${bot.model}`)
})

test('equal models render nothing', () => {
  assert.equal(render(rosterOf({ runningModel: bot.model })), null)
})

test('absent or non-string running model renders nothing', () => {
  for (const runningModel of [undefined, null, 42]) assert.equal(render(rosterOf({ runningModel })), null)
})

test('missing saved model renders nothing', () => {
  assert.equal(render(rosterOf({ model: undefined })), null)
})

test('an earlier part renders nothing', () => {
  assert.equal(render(rosterOf(), 'part-1'), null)
})

test('a plugin-owned model renders nothing, including an empty host model entry', () => {
  for (const entry of [{ entries: [] }, null]) {
    assert.equal(render(rosterOf({}, { hostModels: { [bot.id]: entry } })), null)
  }
})

test('an effort-only difference renders nothing', () => {
  assert.equal(render(rosterOf({ runningModel: bot.model, effort: 'high', runningEffort: 'low' })), null)
})

test('a group chat without a Bot renders nothing', () => {
  assert.equal(render(rosterOf(), 'group-chat'), null)
})

test('appliedModel supplies the saved model when no model is selected', () => {
  assert.equal(textOf(render(rosterOf({ model: undefined, appliedModel: bot.model }))),
    'This chat is running on DeepSeek Flash instead of DeepSeek V4.')
  assert.equal(render(rosterOf({ model: undefined, appliedModel: bot.runningModel })), null)
})

test('unknown models use the selector short name and known models keep their catalog names', () => {
  assert.equal(textOf(render(rosterOf({}, { models: [] }))),
    `This chat is running on deepseek-flash instead of deepseek-v4.`)
  assert.equal(textOf(render(rosterOf({}, { models: [models[0]] }))),
    `This chat is running on deepseek-flash instead of DeepSeek V4.`)
  assert.equal(textOf(render(rosterOf({}, { models: [models[1]] }))),
    `This chat is running on DeepSeek Flash instead of deepseek-v4.`)
})

test('the chat keeps a polite live region whether or not the models differ', () => {
  for (const patch of [{}, { runningModel: bot.model }]) {
    const region = ModelSwitchNotice({ sessionId: 'part-2', useRoster: pick => pick(rosterOf(patch)) }).children[0]
    assert.equal(region.props.role, 'status')
    assert.equal(region.props['aria-live'], 'polite')
    assert.equal(region.props.className, 'bt-sr')
  }
  assert.equal(ModelSwitchNotice({ sessionId: 'part-1', useRoster: pick => pick(rosterOf()) }), null)
})

test('two models of one name each carry their connection', () => {
  const same = [{ ref: bot.model, name: 'DeepSeek Flash', via: undefined }, { ref: bot.runningModel, name: 'DeepSeek Flash' }]
  const local = { ...bot, model: 'local/flash' }
  const roster = { byId: { 'part-2': local }, models: [{ ref: 'local/flash', name: 'DeepSeek Flash' }, same[1]] }
  const line = textOf(render(roster))
  assert.notEqual(line, 'This chat is running on DeepSeek Flash instead of DeepSeek Flash.')
  assert.match(line, /^This chat is running on DeepSeek Flash \(.+\) instead of DeepSeek Flash \(.+\)\.$/)
})
