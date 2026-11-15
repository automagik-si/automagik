// The pack covers the Bot team whole: `omni-ui` is the only namespace the Bots surface draws
// from, and a key the pack leaves out falls back to English. A new Bot string without its
// translation, or a release that ships far fewer translations than this pack's own baseline,
// fails here rather than in front of a reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { omniKeys } from '../scripts/copy-check.mjs'
import { loadDictionaries } from '../scripts/dictionaries.mjs'

// What the pack translates today: 2632 keys, 2566 translated and 66 left in English on purpose
// (the brand and code-like strings the README lists). A release may not drop far below that.
export const MIN_TRANSLATED = 0.95

test('every omni-ui key the Bot team renders has its pt-BR text', async () => {
  const keys = await omniKeys()
  const pack = loadDictionaries()['omni-ui']
  const missing = [...keys].filter(key => !Object.hasOwn(pack, key)).sort()
  assert.deepEqual(missing, [], 'a Bot string with no pt-BR text stays in English')
})

test('the pack keeps almost every Bot string translated, not only listed', async () => {
  const keys = await omniKeys()
  const pack = loadDictionaries()['omni-ui']
  const translated = [...keys].filter(key => Object.hasOwn(pack, key) && pack[key] !== key).length
  const ratio = translated / keys.size
  assert.ok(ratio >= MIN_TRANSLATED, `only ${(ratio * 100).toFixed(1)}% of ${keys.size} keys are translated (floor ${MIN_TRANSLATED * 100}%)`)
})
