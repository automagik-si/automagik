import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { contents: "export { personWrote, suggestionsFor, MAX_SUGGESTIONS } from './src/client/suggestions.js'", resolveDir: dirname(dirname(fileURLToPath(import.meta.url))) },
  bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent', external: ['react'],
})
const mod = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { module: mod, exports: mod.exports, require: () => ({ createElement: () => null, useEffect: () => {}, useState: v => [v, () => {}], useSyncExternalStore: () => [] }) })
const { personWrote, suggestionsFor, MAX_SUGGESTIONS } = mod.exports

test('a chat is empty until the person writes: greetings, setup and other Bots do not count', () => {
  assert.equal(personWrote(undefined), false)
  assert.equal(personWrote([{ turn: 1, prompt: '[Bot team setup] Say hi', response: 'Hi, I\'m Coder.' }]), false)
  assert.equal(personWrote([{ turn: 1, prompt: '[Message from Omni] Please check' }]), false)
  assert.equal(personWrote([{ turn: 2, prompt: 'Answer Omni' }], [2]), false)
  assert.equal(personWrote([{ turn: 1, prompt: '[Bot team setup] Say hi' }, { turn: 2, prompt: 'Make me a plan' }]), true)
})

test('a plugin\'s suggestions for its Bots come first, the team\'s fill in, three at most', () => {
  const genie = { id: 'genie', order: -10, when: ({ bot }) => bot.kind === 'genie', items: () => [{ id: 'wish', label: 'Grant a wish', text: 'I wish ' }] }
  const broken = { id: 'broken', items: () => { throw new Error('boom') } }
  const forGenie = suggestionsFor([genie, broken], { bot: { kind: 'genie' }, images: true })
  assert.deepEqual([...forGenie.map(item => item.key)], ['genie:wish', 'team:image', 'team:search'])
  assert.equal(forGenie.length, MAX_SUGGESTIONS)
  // Another Bot gets the team's own; drawing only where something draws images.
  assert.deepEqual([...suggestionsFor([genie], { bot: { kind: undefined }, images: false }).map(item => item.key)], ['team:search', 'team:remind'])
})

test('detaching Genie skips its suggestions before the provider runs', () => {
  let called = 0
  const entries = [
    { id: 'genie', when: () => { called += 1; return true }, items: () => [{ id: 'wish', label: 'Wish', text: 'I wish ' }] },
    { id: 'other', items: () => [{ id: 'help', label: 'Help', text: 'Help with ' }] },
  ]
  const keys = (bot, roster) => [...suggestionsFor(entries, { bot, roster }).map(item => item.key)]
  const detached = { kind: 'genie', roles: [] }
  assert.deepEqual(keys(detached, {}), ['other:help', 'team:search', 'team:remind'])
  assert.equal(called, 0)
  assert.deepEqual(keys({}, {}), ['other:help', 'team:search', 'team:remind'])
  assert.equal(called, 0)
  assert.deepEqual(keys({ kind: 'genie' }, {}), ['genie:wish', 'other:help', 'team:search'])
  assert.deepEqual(keys(detached, { prefs: { roles: false } }), ['genie:wish', 'other:help', 'team:search'])
  assert.deepEqual(keys(detached, undefined), ['genie:wish', 'other:help', 'team:search'])
})
