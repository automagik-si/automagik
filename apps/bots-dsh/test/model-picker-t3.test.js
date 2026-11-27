// The composer picker's pure logic: the parts ported from T3 Code (model-picker-t3.js, its
// modelPickerKeys tests ported with it) and the tabs, rows and levels model-menu.js builds on them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { adjacentModelPickerProvider, matchesModelSearch, modelJumpIndex, modelJumpLabel, modelPickerModelKey, parseModelPickerModelKey } from '../src/client/model-picker-t3.js'

const bundle = await build({
  stdin: { contents: "export * from './src/client/model-menu.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, document: { body: {} }, window: { innerWidth: 1280, innerHeight: 800 },
  require: name => ({
    react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Fragment: 'Fragment', useState: initial => [initial, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: current => ({ current }), useSyncExternalStore: (_s, snapshot) => snapshot() },
    'react-dom': { createPortal: node => node },
    '@deepseek-ai/dsh-client-ui-primitives': {},
  })[name],
})
// The bundle runs in its own realm: its arrays and objects come back as plain ones to compare.
const plain = fn => (...args) => JSON.parse(JSON.stringify(fn(...args)) ?? 'null')
const pickerTabs = plain(module.exports.pickerTabs)
const pickerRows = plain(module.exports.pickerRows)
const levelRows = plain(module.exports.levelRows)
const { tabOfRef } = module.exports

test('T3 model keys: a provider named like a section stays distinct, and any slug round-trips', () => {
  const key = modelPickerModelKey('legacy-models', 'codex')
  assert.deepEqual(parseModelPickerModelKey(key), { instanceId: 'legacy-models', slug: 'codex' })
  assert.deepEqual(parseModelPickerModelKey(modelPickerModelKey('custom', 'model:\udfff')), { instanceId: 'custom', slug: 'model:\udfff' })
  assert.deepEqual(parseModelPickerModelKey(modelPickerModelKey('acp-codex', 'acp-codex/gpt:5')), { instanceId: 'acp-codex', slug: 'acp-codex/gpt:5' })
  for (const bad of ['legacy-models:codex', 'model:x:abc', 'model:9:short', undefined]) assert.equal(parseModelPickerModelKey(bad), null)
})

test('the rail moves through favorites and the pickable tabs, wrapping, and skips disabled ones', () => {
  const tabs = [{ id: 'native' }, { id: 'acp-codex' }, { id: 'herdr', disabled: true }]
  assert.equal(adjacentModelPickerProvider({ tabs, selected: 'favorites', direction: 1 }), 'native')
  assert.equal(adjacentModelPickerProvider({ tabs, selected: 'acp-codex', direction: 1 }), 'favorites')
  assert.equal(adjacentModelPickerProvider({ tabs, selected: 'favorites', direction: -1 }), 'acp-codex')
  assert.equal(adjacentModelPickerProvider({ tabs, selected: 'herdr', direction: 1 }), 'favorites')
  assert.equal(adjacentModelPickerProvider({ tabs, selected: 'herdr', direction: -1 }), 'acp-codex')
})

test('⌘1…⌘9 on a Mac, Ctrl+1…9 elsewhere; nothing with another modifier or past nine', () => {
  const key = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
  assert.equal(modelJumpIndex(key('1', { metaKey: true }), true), 0)
  assert.equal(modelJumpIndex(key('9', { metaKey: true }), true), 8)
  assert.equal(modelJumpIndex(key('1', { ctrlKey: true }), true), -1)
  assert.equal(modelJumpIndex(key('2', { ctrlKey: true }), false), 1)
  assert.equal(modelJumpIndex(key('2', { metaKey: true }), false), -1)
  assert.equal(modelJumpIndex(key('0', { metaKey: true }), true), -1)
  assert.equal(modelJumpIndex(key('3', { metaKey: true, shiftKey: true }), true), -1)
  assert.equal(modelJumpIndex(key('3'), true), -1)
  assert.equal(modelJumpLabel(0, true), '⌘1')
  assert.equal(modelJumpLabel(8, false), 'Ctrl+9')
  assert.equal(modelJumpLabel(9, true), null)
})

test('search matches every word in the name, ref or provider, ignoring case', () => {
  assert.equal(matchesModelSearch('', ['x']), true)
  assert.equal(matchesModelSearch('opus claude', ['Claude Opus', 'acp-claude/opus']), true)
  assert.equal(matchesModelSearch('OPUS sonnet', ['Claude Opus']), false)
})

const MODELS = [
  { ref: 'deepseek/flash', provider: 'deepseek', providerName: 'DeepSeek', name: 'DeepSeek Flash' },
  { ref: 'local/flash', provider: 'local', providerName: 'Ollama', name: 'Local Flash' },
  { ref: 'acp-codex/gpt', provider: 'acp-codex', providerName: 'Codex', name: 'GPT' },
  { ref: 'acp-claude/opus', provider: 'acp-claude', providerName: 'Claude Code', name: 'Claude Opus' },
]

test('tabs: one per route the Bot may use and per ACP agent, disabled ones last, the Bot\'s model only on its own tab', () => {
  const tabs = pickerTabs({ id: 'b' }, { models: MODELS }, 'acp-codex/gpt')
  assert.deepEqual(tabs.map(tab => [tab.id, tab.disabled === true]), [
    ['native', false], ['acp-claude', false], ['acp-codex', false], ['hermes-remote', false],
    ['acp-hermes', true], ['acp-antigravity', true], ['acp-omp', true], ['herdr', true],
  ])
  assert.equal(tabOfRef(tabs, 'acp-codex/gpt'), 'acp-codex')
  assert.equal(tabs[0].models.some(model => model.missing), false, 'an ACP model is never listed as a missing Native one')
  // A Native model no longer served stays listed on Native, marked missing.
  assert.equal(pickerTabs({ id: 'b' }, { models: MODELS }, 'deepseek/gone')[0].models[0].missing, true)
  // A route the Bot's kind hides is no tab (RFC 0030 Q13).
  const hidden = pickerTabs({ id: 'b', kind: 'k' }, { models: MODELS, routePolicy: { k: ['acp'] } }, undefined)
  assert.equal(hidden.some(tab => tab.route !== 'acp'), false)
})

test('rows: one tab\'s models with provider headings, every pickable tab while searching, favorites on the star', () => {
  const tabs = pickerTabs({ id: 'b' }, { models: MODELS }, 'acp-codex/gpt')
  const names = rows => rows.map(row => row.heading ? `# ${row.heading}` : row.model.ref)
  assert.deepEqual(names(pickerRows({ tabs, tab: 'native', query: '', favorites: [] })), ['# DeepSeek', 'deepseek/flash', '# Ollama', 'local/flash'])
  assert.deepEqual(names(pickerRows({ tabs, tab: 'acp-codex', query: '', favorites: [] })), ['acp-codex/gpt'])
  assert.deepEqual(names(pickerRows({ tabs, tab: 'acp-codex', query: 'flash', favorites: [] })), ['# DeepSeek', 'deepseek/flash', '# Ollama', 'local/flash'])
  assert.deepEqual(names(pickerRows({ tabs, tab: 'favorites', query: '', favorites: ['acp-claude/opus', 'gone/model'] })), ['# Claude Code', 'acp-claude/opus'])
  assert.deepEqual(names(pickerRows({ tabs, tab: 'favorites', query: '', favorites: [] })), [])
})

test('levels: the model\'s default is marked and clears the Bot\'s level; with no default named, a Default row leads', () => {
  const reasoning = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
  assert.deepEqual(levelRows(reasoning), [
    { label: 'Low', isDefault: true, id: 'low' },
    { effort: 'high', label: 'High', id: 'high' },
  ])
  assert.deepEqual(levelRows({ efforts: reasoning.efforts }).map(row => [row.effort, row.label, row.isDefault === true]), [[undefined, 'Default', true], ['low', 'Low', false], ['high', 'High', false]])
  assert.deepEqual(levelRows({ efforts: [] }), [])
  assert.deepEqual(levelRows(null), [])
})
