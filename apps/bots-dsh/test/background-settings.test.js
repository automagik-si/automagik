import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [new URL('../src/client/settings.js', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
const module = { exports: {} }
// createContext and Component: the bundled Deep View widgets make a React context, and a page boundary
// extends React.Component, when their modules load.
const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Fragment: 'Fragment', Component: class {}, createContext: value => ({ Provider: 'Provider', value }), useContext: context => context.value, useState: v => [v, () => {}], useEffect: () => {}, useLayoutEffect: () => {}, useRef: v => ({ current: v }), useCallback: f => f, useMemo: f => f(), useSyncExternalStore: (_s, snap) => snap() }
runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, document: { body: {} }, window: { innerWidth: 1280, innerHeight: 800, matchMedia: () => ({ matches: false, addEventListener() {} }) }, require: name => (name === 'react-dom' ? { createPortal: n => n } : react) })
const { backgroundChoices } = module.exports

test('remote Hermes setup remains reachable when DSH owns the provider settings', () => {
  const tree = module.exports.SettingsDialog({ page: 'hermes-remote', roster: { byId: {}, roomsById: {} }, actions: { closeSettings() {}, openSettings() {}, openHarnessSettings() {} } })
  const nodes = (node) => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const all = nodes(tree)
  const pages = all.filter(node => node.type === 'button' && node.props.className === 'bt-settings-item')
  assert.ok(pages.some(node => node.children.includes('Remote Hermes')))
  assert.ok(!pages.some(node => node.children.includes('Models')))
  assert.ok(all.some(node => node.type?.name === 'HermesRemoteSettings'))
})

test('remote Hermes settings follow coding agents by stable section ID in any language', () => {
  const tree = module.exports.SettingsDialog({ page: 'hermes-remote', roster: { byId: {}, roomsById: {} }, actions: {
    closeSettings() {}, openSettings() {}, pluginSettings: () => [{ id: 'before', label: 'Before' }, { id: 'acp-agents', label: 'Agentes de código' }, { id: 'after', label: 'After' }],
  } })
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children ?? []).flatMap(nodes)]
  const labels = nodes(tree).filter(node => node.type === 'button' && node.props.className === 'bt-settings-item').map(node => node.children.at(-1))
  const agents = labels.indexOf('Agentes de código')
  assert.ok(agents >= 0)
  assert.equal(labels[agents + 1], 'Remote Hermes')
  assert.equal(labels[agents + 2], 'After')
})

// Settings → Background jobs offers only a model that answers beside the chats and can run.
test('the background model choices leave out ACP agents, models without their key, and older Claude', () => {
  const models = [
    { ref: 'acp-codex/default', provider: 'acp-codex' },
    { ref: 'acp-claude/opus', provider: 'acp-claude' },
    { ref: 'deepseek/deepseek-flash', provider: 'deepseek' },
    { ref: 'openai/gpt-5.5', provider: 'openai', needsKey: true },
    { ref: 'anthropic/claude-opus-5-5', provider: 'anthropic' },
    { ref: 'anthropic/claude-opus-4-7', provider: 'anthropic', superseded: true },
  ]
  assert.deepEqual(Array.from(backgroundChoices(models), model => model.ref), ['deepseek/deepseek-flash', 'anthropic/claude-opus-5-5'])
  assert.equal(backgroundChoices(undefined).length, 0)
  // The saved pick stays listed when a newer Claude supersedes it; an agent or a model with no
  // key does not come back by being saved.
  assert.deepEqual(Array.from(backgroundChoices(models, 'anthropic/claude-opus-4-7'), model => model.ref), ['deepseek/deepseek-flash', 'anthropic/claude-opus-5-5', 'anthropic/claude-opus-4-7'])
  assert.deepEqual(Array.from(backgroundChoices(models, 'acp-codex/default'), model => model.ref), ['deepseek/deepseek-flash', 'anthropic/claude-opus-5-5'])
  assert.deepEqual(Array.from(backgroundChoices(models, 'openai/gpt-5.5'), model => model.ref), ['deepseek/deepseek-flash', 'anthropic/claude-opus-5-5'])
})
