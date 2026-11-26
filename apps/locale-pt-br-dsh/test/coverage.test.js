// The pack covers the Bot team whole: `omni-ui` is the only namespace the Bots surface draws
// from, and a key the pack leaves out falls back to English. A new Bot string without its
// translation, or a release that ships far fewer translations than this pack's own baseline,
// fails here rather than in front of a reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { omniKeys } from '../scripts/copy-check.mjs'
import { loadDictionaries } from '../scripts/dictionaries.mjs'
import { MACHINE_MESSAGES as machine } from '../../bots-dsh/src/shared/machine-reservations.js'

// What the pack translates today: 2647 keys, 2581 translated and 66 left in English on purpose
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

test('the reservation card has pt-BR text and keeps its project and vendor placeholders', async () => {
  const keys = await omniKeys()
  const pack = loadDictionaries()['omni-ui']
  for (const key of [
    'Personal plan',
    'Workspace plan: covers every ChatGPT workspace of this email',
    'Shared with other instances (default).',
    'Reserve for a project',
    'Reserved for {label}. This holds in this installation only for now; other installations are not checked yet.',
    'Also reserved here: {label} (another {vendor} account).',
    'Reserved here: {label}.',
    'Reserved by another installation: {label}.',
    'Rename',
    'Make shared',
    'Project name',
    'Continue',
    'Cancel',
    "The record keeps no email: only keyed digests. Anyone who can read this team's files and the key could test a guessed email.",
    machine.absent, machine.unreadable, machine['not-set-up'], machine.unsupported,
    machine.mine, machine.other, machine.refused, machine['no-organisation'],
    machine['unknown-plan'], machine['unreadable-file'], machine.owner, machine.privacy,
  ]) {
    assert.ok(keys.has(key), key)
    assert.ok(pack[key]?.trim(), key)
    assert.notEqual(pack[key], key)
    const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort()
    assert.deepEqual(placeholders(pack[key]), placeholders(key), key)
  }
})

test('the PT-BR pack includes all four Solver look refusals', async () => {
  const keys = await omniKeys()
  const pack = loadDictionaries()['omni-ui']
  for (const [key, text] of [
    ['Only a Solver wears the Solver characters. Choose another character.', 'Só um Solver usa os personagens Solver. Escolha outro personagem.'],
    ['A Solver wears one of the Solver characters. Choose one of those characters.', 'Um Solver usa um dos personagens Solver. Escolha um desses personagens.'],
    ['Only the person can make a Bot a Solver.', 'Só a pessoa pode tornar um Bot um Solver.'],
    ['That look is not valid. Choose another character.', 'Esse visual não é válido. Escolha outro personagem.'],
  ]) {
    assert.ok(keys.has(key), key)
    assert.equal(pack[key], text)
  }
})
