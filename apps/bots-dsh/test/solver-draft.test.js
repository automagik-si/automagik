// The New Solver dialog's plain helpers (RFC 0048, delivery 1).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHARACTERS, DEFAULT_COLORS, DEFAULT_SHAPES } from '../src/client/characters.js'
import { createPayload } from '../src/client/bot-draft.js'
import {
  SOLVER_LOOKS, avatarOfLook, mayHaveBeenCreated, newBotBlock, reviewerChoices, reviewerName, reviewerPayload,
  solverCandidate, solverLook, solverPayload, solverStartModel, uncertain,
} from '../src/client/solver-draft.js'
import { REVIEWER_INSTRUCTIONS } from '../src/shared/solver-method.js'

const CLAUDE = 'acp-claude/default'
const CODEX = 'acp-codex/gpt-5.6'
const FLASH = 'deepseek/deepseek-v4-flash'
const HERMES = 'hermes-remote/attach'
const models = [
  { ref: FLASH, name: 'Flash' },
  { ref: CODEX, name: 'Codex' },
  { ref: CLAUDE, name: 'Claude Code' },
  { ref: HERMES, name: 'Hermes' },
  { ref: 'acp-omp/default', name: 'omp', needsSignIn: true },
]
const roster = (extra = {}) => ({ models, bots: [], mainBotIds: [], defaultModel: FLASH, prefs: {}, ...extra })

test('the Solver starts on Claude Code when it is set up, else on the form\'s model, never a Hermes remote route', () => {
  assert.equal(solverStartModel(roster()), CLAUDE)
  assert.equal(solverStartModel(roster({ models: models.filter(model => model.ref !== CLAUDE) })), FLASH)
  assert.equal(solverStartModel(roster({ models: [{ ref: HERMES }, { ref: FLASH }], defaultModel: HERMES })), FLASH)
  assert.equal(solverStartModel(roster({ models: [{ ref: CLAUDE, needsSignIn: true }, { ref: FLASH }] })), FLASH)
})

test('reviewer choices: a new reviewer on another agent, Bots that may review, and a fresh session last', () => {
  const bots = [
    { id: 'main', name: 'Main', model: CODEX },
    { id: 'omni', name: 'Omni Bot', model: CODEX, kind: 'omni' },
    { id: 'herm', name: 'Herm', model: HERMES },
    { id: 'off', name: 'Off', model: 'acp-omp/default' },
    { id: 'same', name: 'Same', model: CLAUDE },
    { id: 'zed', name: 'Zed', model: FLASH },
    { id: 'ann', name: 'Ann', appliedModel: CODEX },
    { id: 'nomodel', name: 'Nobody' },
  ]
  const choices = reviewerChoices(roster({ bots, mainBotIds: ['main'] }), CLAUDE)
  assert.deepEqual(choices.map(choice => choice.key), ['new', 'bot:ann', 'bot:zed', 'fresh'])
  assert.equal(choices[0].model, FLASH)
  assert.notEqual(choices[0].model, CLAUDE)
  assert.equal(choices[1].name, 'Ann')
  // Never a Main Bot, a Bot of any kind, a Hermes remote Bot, a Bot on a model not set up, or
  // one on the Solver's own model.
  for (const id of ['main', 'omni', 'herm', 'off', 'same', 'nomodel']) assert.equal(choices.some(choice => choice.botId === id), false, id)
  assert.equal(choices.some(choice => /none/i.test(choice.key)), false)
  // A Codex Solver: the new reviewer goes to another agent; Bots on another agent come first.
  const codex = reviewerChoices(roster({ bots: [{ id: 'c2', name: 'Alpha', model: CLAUDE }, { id: 'f', name: 'Beta', model: FLASH }] }), CODEX)
  assert.equal(codex[0].model, FLASH)
  assert.equal(codex.at(-1).kind, 'fresh')
  // One model set up: only the fresh session.
  assert.deepEqual(reviewerChoices(roster({ models: [{ ref: CLAUDE }, { ref: HERMES }] }), CLAUDE).map(choice => choice.kind), ['fresh'])
  // The new reviewer never runs on a Hermes remote route.
  assert.deepEqual(reviewerChoices(roster({ models: [{ ref: CLAUDE }, { ref: HERMES }, { ref: FLASH }] }), CLAUDE)[0], { key: 'new', kind: 'new', model: FLASH })
})

test('the host map decides the new Bot\'s block: null is none, a missing ref fails closed', () => {
  const map = JSON.parse(JSON.stringify({ [CLAUDE]: null, [CODEX]: 'model-kept' }))
  assert.equal(newBotBlock({ nativeToolsNew: map }, CLAUDE), undefined)
  assert.equal(newBotBlock({ nativeToolsNew: map }, CODEX), 'model-kept')
  assert.equal(newBotBlock({ nativeToolsNew: map }, FLASH), 'level-unknown')
  assert.equal(newBotBlock({}, CLAUDE), 'level-unknown')
  assert.equal(newBotBlock({ nativeToolsNew: null }, CLAUDE), 'level-unknown')
  assert.deepEqual(solverCandidate({ nativeToolsNew: map }, CLAUDE, false), { model: CLAUDE })
  assert.deepEqual(solverCandidate({ nativeToolsNew: map }, CLAUDE, true), { model: CLAUDE, nativeTools: true, nativeToolsAgent: 'acp-claude' })
  assert.deepEqual(solverCandidate({ nativeToolsNew: map }, CODEX, false), { model: CODEX, nativeToolsBlock: 'model-kept' })
})

test('the character slot: empty wears today\'s random look, unknown entries fall back, known ones are worn', () => {
  assert.deepEqual(SOLVER_LOOKS, [])
  const plain = solverLook({ random: () => 0 })
  assert.deepEqual(plain, { shape: DEFAULT_SHAPES[0], color: DEFAULT_COLORS[0] })
  assert.deepEqual(solverLook({ looks: [{ shape: 'no-such-shape' }, null, 7, { pet: { source: 'builtin', id: 'gone', version: 1 } }], random: () => 0 }), plain)
  const known = Object.keys(CHARACTERS)[3]
  assert.deepEqual(solverLook({ looks: [{ shape: known }], random: () => 0 }), { shape: known, color: DEFAULT_COLORS[0] })
  const pet = { source: 'builtin', id: 'wisp', version: 2 }
  const pets = [{ source: 'builtin', id: 'wisp', version: 2 }, { source: 'team', id: 'tabby', version: 1 }]
  assert.deepEqual(solverLook({ looks: [{ pet }], pets, random: () => 0 }), { color: DEFAULT_COLORS[0], pet })
  // A pet is matched by its source and id: a team pet with that id is not the builtin one.
  assert.deepEqual(solverLook({ looks: [{ pet: { source: 'builtin', id: 'tabby', version: 1 } }], pets, random: () => 0 }), plain)
  assert.deepEqual(solverLook({ looks: [{ pet }], random: () => 0 }), plain)
  assert.deepEqual(avatarOfLook({ color: 'red', pet }), { pet })
  assert.deepEqual(avatarOfLook({ shape: 'moon', color: 'red' }), { shape: 'moon' })
})

test('createPayload passes a given avatar through and is unchanged without one', () => {
  const look = { shape: 'moon', color: 'red' }
  const pet = { pet: { source: 'builtin', id: 'wisp', version: 2 } }
  const local = 'local-claude-code/sonnet'
  assert.deepEqual(createPayload({ name: 'S', look, model: local, ownLook: true, avatar: pet }).avatar, pet)
  assert.deepEqual(createPayload({ name: 'S', look, model: local, avatar: pet }).avatar, pet)
  assert.deepEqual(createPayload({ name: 'S', look, model: FLASH }), { name: 'S', color: 'red', avatar: { shape: 'moon' }, model: FLASH })
  // Without one, a local agent's Bot still starts with its engine's badge, as before.
  assert.equal(typeof createPayload({ name: 'S', look, model: local }).avatar.image, 'string')
  assert.deepEqual(createPayload({ name: 'S', look, model: local, ownLook: true }).avatar, { shape: 'moon' })
})

test('the Solver and reviewer payloads', () => {
  const look = { shape: 'moon', color: 'red' }
  const plain = solverPayload({ name: 'Solver', look, model: CLAUDE, brief: 'Compare two libraries', reviewer: 'Solver reviewer', dedicated: true, sectionId: 'sec1', workDir: '/work' })
  assert.equal(plain.payload.brief, 'Compare two libraries')
  assert.equal(plain.sendBrief, undefined)
  assert.equal(plain.payload.role, 'Solver')
  assert.equal(plain.payload.sectionId, 'sec1')
  assert.equal(plain.payload.workDir, '/work')
  // Its own look, never the engine's badge.
  assert.deepEqual(plain.payload.avatar, { shape: 'moon' })
  assert.deepEqual(solverPayload({ name: 'S', look, model: 'local-claude-code/sonnet' }).payload.avatar, { shape: 'moon' })
  assert.match(plain.payload.instructions, /message_bot to "Solver reviewer" \(reply_to "me"\)\./)
  const native = solverPayload({ name: 'Solver', look, model: CLAUDE, brief: 'Compare two libraries', native: true })
  assert.equal(native.payload.brief, undefined)
  assert.equal(native.sendBrief, 'Compare two libraries')
  assert.match(native.payload.instructions, /There is no reviewer Bot/)
  assert.equal(solverPayload({ name: 'S', look, model: FLASH }).payload.workDir, undefined)
  const reviewer = reviewerPayload({ name: 'Solver reviewer', look, model: FLASH, workDir: '/work' })
  assert.equal(reviewer.instructions, REVIEWER_INSTRUCTIONS)
  assert.equal(reviewer.role, 'Reviewer')
  assert.equal(reviewer.model, FLASH)
  assert.equal(reviewer.workDir, '/work')
  assert.equal(reviewer.brief, undefined)
})

test('the reviewer name leaves room for a suffix within 40 characters', () => {
  const long = 'L'.repeat(40)
  const base = reviewerName({ bots: [] }, long)
  assert.equal(base.length, 36)
  const next = reviewerName({ bots: [{ name: base }] }, long)
  assert.equal(next, `${base} 2`)
  assert.ok(next.length <= 40)
  assert.equal(reviewerName({ bots: [] }, 'Ada'), 'Ada reviewer')
})

test('what counts as an unknown outcome, and what may have been made', () => {
  for (const code of ['NETWORK', 'HTTP_502', 'bot/internal', 'bot/error', 'bot/retired', 'bot/viewer-changed', undefined]) {
    assert.equal(uncertain({ code }), true, String(code))
  }
  for (const code of ['bot/refused', 'bot/not-found', 'bot/invalid', 'bot/read-only', 'bot/sign-in-required']) {
    assert.equal(uncertain({ code }), false, code)
  }
  const before = new Set(['a', 'b'])
  const fresh = { bots: [{ id: 'a', name: 'A' }, { id: 'n1', name: 'Solver' }, { id: 'r1', name: 'Solver reviewer' }, { id: 'b', name: 'B' }] }
  assert.deepEqual(mayHaveBeenCreated(before, fresh, ['r1']), ['Solver'])
  // By id, never by name: a Bot named like the plan that was there before is not listed.
  assert.deepEqual(mayHaveBeenCreated(new Set(['x']), { bots: [{ id: 'x', name: 'Solver' }] }), [])
})
