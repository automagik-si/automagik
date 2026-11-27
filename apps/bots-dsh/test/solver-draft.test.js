// The New Solver dialog's plain helpers (RFC 0048, delivery 1).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHARACTERS, DEFAULT_COLORS, DEFAULT_SHAPES, SOLVER_SHAPES } from '../src/client/characters.js'
import { createPayload } from '../src/client/bot-draft.js'
import {
  SOLVER_LOOKS, avatarOfLook, createSolver, mayHaveBeenCreated, newBotBlock, reviewerChoices, reviewerName, reviewerPayload,
  reviewMarkText, solverAutoView, solverCandidate, solverLook, solverPayload, solverStartModel, uncertain,
  guardLevelOf, reviewGuardText, reviewGuardView,
} from '../src/client/solver-draft.js'
import { REVIEW_GUARD_COPY, reviewGuardReach } from '../src/shared/review-guard.js'
import { REVIEWER_INSTRUCTIONS } from '../src/shared/solver-method.js'

test('2133 Test 10 Details reports why a visual RESULT was unverified', () => {
  const bot = { role: 'Solver', solverStatus: { unverified: 'images' } }
  const line = () => solverAutoView(bot, {}, 'ask').lines[0]
  assert.equal(line(), 'RESULT review unverified. The result has pictures and the reviewer could not see them.')
  bot.solverStatus.imagesWhy = 'lost'
  assert.match(line(), /answering turn lost the result pictures/)
  bot.solverStatus.imagesWhy = 'missing'
  assert.match(line(), /result pictures were not all carried/)
})

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

test('the character slot holds the twelve Solvers: a new Solver wears one; an empty or unknown slot falls back', () => {
  assert.deepEqual(SOLVER_LOOKS, ['puff', 'sprout', 'cap', 'bell', 'cloud', 'spike', 'floppy', 'antenna', 'cactus', 'bulb', 'chick', 'frog'].map(shape => ({ shape })))
  assert.deepEqual(solverLook({ random: () => 0 }), { shape: 'puff', color: DEFAULT_COLORS[0] })
  // Whatever the draw, a new Solver wears a Solver character in a default color.
  let seed = 7
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  for (let index = 0; index < 50; index += 1) {
    const look = solverLook({ random })
    assert.ok(SOLVER_SHAPES.includes(look.shape), look.shape)
    assert.ok(DEFAULT_COLORS.includes(look.color), look.color)
    assert.equal(look.pet, undefined)
  }
  // With no look to wear, today's random look.
  const plain = solverLook({ looks: [], random: () => 0 })
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
  assert.equal(Object.hasOwn(plain.payload, 'brief'), false)
  assert.equal(plain.sendBrief, 'Compare two libraries')
  assert.equal(plain.payload.role, 'Solver')
  assert.equal(plain.payload.sectionId, 'sec1')
  assert.equal(plain.payload.workDir, '/work')
  // Its own look, never the engine's badge.
  assert.deepEqual(plain.payload.avatar, { shape: 'moon' })
  assert.deepEqual(solverPayload({ name: 'S', look, model: 'local-claude-code/sonnet' }).payload.avatar, { shape: 'moon' })
  // The dialog writes the reviewer's real name: asked first, a fresh session only after its failure.
  assert.ok(plain.payload.instructions.includes('Message "Solver reviewer" with message_bot FIRST for every review, plan and result alike (reply_to "me").'))
  assert.ok(plain.payload.instructions.includes('ONLY when your reviewer fails (message_bot errors, or a reply says it could not answer), and the delivery quotes that failure. A slow reviewer has not failed: wait for it.'))
  assert.doesNotMatch(plain.payload.instructions, /no reviewer/i)
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

// #2056: the reviewer's id goes with the Solver only when it has a reviewer Bot.
test('the Solver payload carries its reviewer Bot\'s id, never for a fresh session', () => {
  const look = { shape: 'moon', color: 'red' }
  assert.equal(solverPayload({ name: 'S', look, model: CLAUDE, reviewer: 'Ada reviewer', dedicated: true, reviewerId: 'r1' }).payload.reviewerId, 'r1')
  for (const extra of [{ reviewer: null, reviewerId: 'r1' }, { reviewer: 'Ada reviewer' }, { reviewer: 'Ada reviewer', reviewerId: '' }]) {
    assert.equal(Object.hasOwn(solverPayload({ name: 'S', look, model: CLAUDE, ...extra }).payload, 'reviewerId'), false, JSON.stringify(extra))
  }
})

// #2056: Details names which review the host saw for a Solver's last delivery.
test('the review mark line: plan missing, result missing, both present, both missing, fresh session, none', () => {
  const roster = { byId: { r1: { id: 'r1', name: 'Ada reviewer' } } }
  const solver = reviewMark => ({ id: 's1', role: 'Solver', reviewerId: 'r1', reviewMark })
  const line = mark => reviewMarkText(solver(mark), roster)
  assert.equal(line({ review: 'bot', plan: false, result: true }), 'Plan unreviewed: Ada reviewer gave no verdict before the work started.')
  assert.equal(line({ review: 'bot', plan: true, result: false }), 'Result unreviewed: Ada reviewer gave no verdict on the finished work.')
  assert.equal(line({ review: 'bot', plan: true, result: true }), 'Plan and result reviewed by Ada reviewer.')
  assert.equal(line({ review: 'bot', plan: false, result: false }), 'Plan and result unreviewed: no verdict from Ada reviewer came in time.')
  // Run 3: delivered while the reviewer still had the work; never blank, never "reviewed".
  const pending = 'Ada reviewer had not answered when this was delivered; the app cannot see a fresh-session review.'
  for (const [plan, result] of [[false, false], [true, false], [false, true], [true, true]]) {
    assert.equal(line({ review: 'bot', plan, result, pending: true }), pending)
  }
  assert.doesNotMatch(pending, /\breviewed\b/i)
  // A Solver with a reviewer Bot never shows the no-reviewer fresh-session line.
  for (const mark of [{ plan: false, result: false }, { plan: true, result: false }, { plan: false, result: true }, { plan: true, result: true }, { plan: false, result: false, pending: true }]) {
    assert.doesNotMatch(line({ review: 'bot', ...mark }), /no reviewer Bot/)
  }
  // SR3-1: with no reviewer Bot the line claims no review: the host cannot see one.
  assert.equal(line({ review: 'fresh' }), 'Review not checked: this Solver has no reviewer Bot, and the app cannot see a fresh-session review.')
  assert.doesNotMatch(line({ review: 'fresh' }), /^Reviewed/)
  assert.equal(line({ review: 'none' }), 'Unreviewed: its reviewer is no longer on the team.')
  // A reviewer renamed or gone since is "its reviewer".
  assert.equal(reviewMarkText(solver({ review: 'bot', plan: true, result: true }), { byId: {} }), 'Plan and result reviewed by its reviewer.')
  // Nothing before a first delivery, and nothing for a Bot the host has no mark for.
  assert.equal(line(undefined), null)
  assert.equal(reviewMarkText({ role: 'Helper' }, roster), null)
  // SR3-8: a mark stays shown after the Bot's description changes (update_bot { role }).
  assert.equal(reviewMarkText({ role: 'Helper', reviewerId: 'r1', reviewMark: { review: 'bot', plan: false, result: true } }, roster),
    'Plan unreviewed: Ada reviewer gave no verdict before the work started.')
})

test('#2131 an unverified delivery says the result was not verified', () => {
  const roster = { byId: { r1: { id: 'r1', name: 'Ada reviewer' } } }
  const bot = { id: 's1', role: 'Solver', reviewerId: 'r1', reviewMark: { review: 'bot', plan: true, result: false } }
  const withOutcome = outcome => ({ ...bot, solverStatus: { outcome } })
  assert.equal(reviewMarkText(withOutcome({ reason: 'checks' }), roster).split('\n')[1],
    'Result not verified, so not marked done: current passing results are missing for agreed checks.')
  const done = { ...withOutcome({ done: true }), reviewMark: { ...bot.reviewMark, result: true, done: true } }
  assert.doesNotMatch(reviewMarkText(done, roster), /not verified/i)
  assert.doesNotMatch(reviewMarkText(withOutcome({ reason: 'review' }), roster), /not verified/i)
})

// #2056 D1.5: the Review guard rides the Solver's own create-bot, only with a reviewer Bot.
test('the Solver payload carries the Review guard only with a reviewer Bot and the tick', () => {
  const look = { shape: 'moon', color: 'red' }
  const base = { name: 'S', look, model: CLAUDE, reviewer: 'Ada reviewer', dedicated: true, reviewerId: 'r1' }
  assert.equal(solverPayload({ ...base, guard: true }).payload.reviewGuard, true)
  assert.equal(Object.hasOwn(solverPayload(base).payload, 'reviewGuard'), false)
  for (const extra of [{ reviewer: null }, { reviewerId: undefined }, { reviewerId: '' }]) {
    assert.equal(Object.hasOwn(solverPayload({ ...base, ...extra, guard: true }).payload, 'reviewGuard'), false, JSON.stringify(extra))
  }
})

test('how far the guard holds on each route (PLAN-D15 §5 and r1.9)', () => {
  const on = agent => ({ nativeTools: true, nativeToolsAgent: agent })
  assert.equal(reviewGuardReach({ model: FLASH }, 'full'), 'hard')
  for (const level of ['ask', 'full', 'auto']) {
    for (const model of [CLAUDE, CODEX, 'acp-omp/default']) assert.equal(reviewGuardReach({ model }, level), 'hard', `${model} off ${level}`)
  }
  assert.equal(reviewGuardReach({ model: CLAUDE, ...on('acp-claude') }, 'ask'), 'asks')
  assert.equal(reviewGuardReach({ model: CLAUDE, ...on('acp-claude') }, 'full'), 'level')
  assert.equal(reviewGuardReach({ model: CLAUDE, ...on('acp-claude') }, 'auto'), 'level')
  // r1.9: at Read only native tools are blocked, so the route is DSH tools.
  assert.equal(reviewGuardReach({ model: CLAUDE, ...on('acp-claude'), nativeToolsBlock: 'read-only' }, 'ask'), 'hard')
  assert.equal(reviewGuardReach({ model: CODEX, ...on('acp-codex') }, 'ask'), 'agent')
  assert.equal(reviewGuardReach({ model: 'acp-omp/default', ...on('acp-omp') }, 'ask'), 'agent')
  assert.equal(reviewGuardReach({ model: CODEX, nativeToolsBlock: 'model-kept' }, 'ask'), 'agent')
  assert.equal(reviewGuardReach({ model: 'acp-antigravity/default' }, 'ask'), 'agent')
  assert.equal(reviewGuardReach({ model: HERMES }, 'ask'), 'agent')
  assert.equal(guardLevelOf('workspace-write:auto', false), 'auto')
  assert.equal(guardLevelOf('danger-full-access', true), 'full')
  assert.equal(guardLevelOf('workspace-write', false), 'ask')
})

test('the Review guard line in Details: per route, gone, no reviewer Bot, waiting since', () => {
  const roster = { byId: { r1: { id: 'r1', name: 'Ada reviewer' } } }
  const bot = extra => ({ id: 's1', name: 'Sol', role: 'Solver', reviewerId: 'r1', model: FLASH, ...extra })
  const hard = "Work waits for Ada reviewer's verdict on the plan: file changes, commands and messages to other Bots are refused until it answers."
  const scope = "Held only in this Bot's own chat and the subagents it starts there. Its scheduled tasks that open a new conversation and its Omni automation runs that open their own conversation are not held."
  assert.equal(reviewGuardText(bot({ reviewGuard: true }), roster, 'ask'), `${hard} ${scope}`)
  assert.equal(reviewGuardText(bot({ reviewGuard: true, model: CLAUDE, nativeTools: true, nativeToolsAgent: 'acp-claude' }), roster, 'ask'), `${REVIEW_GUARD_COPY.asks} ${scope}`)
  assert.equal(REVIEW_GUARD_COPY.asks, 'Held only for the steps Claude Code asks about. Its own allow rules, hooks and saved approvals can let a step run before the guard sees it, and that step may still show as refused.')
  assert.equal(reviewGuardText(bot({ reviewGuard: true, model: CLAUDE, nativeTools: true, nativeToolsAgent: 'acp-claude' }), roster, 'full'), `${REVIEW_GUARD_COPY.asks} ${scope}`)
  assert.equal(reviewGuardText(bot({ reviewGuard: true, model: CODEX, nativeTools: true, nativeToolsAgent: 'acp-codex' }), roster, 'ask'), `Until Ada reviewer answers the plan, Codex runs read-only inside this Bot's folder; then the chosen level applies. ${scope}`)
  const gone = reviewGuardView(bot({ reviewGuard: true }), { byId: {} }, 'ask')
  assert.deepEqual(gone, { on: true, disabled: false, lines: ['Its reviewer is no longer on the team: work stays held until you turn this off.'] })
  for (const solver of [bot({ reviewerId: undefined }), bot({ reviewerId: 'gone' })]) {
    assert.deepEqual(reviewGuardView(solver, roster, 'ask'), { on: false, disabled: true, lines: ['Off: Sol has no reviewer Bot on the team, so there is no verdict to wait for.'] })
  }
  assert.equal(reviewGuardView({ id: 'p', name: 'Plain', role: 'Helper' }, roster, 'ask'), null)
  const off = reviewGuardView(bot({}), roster, 'ask')
  assert.equal(off.on, false)
  assert.equal(off.disabled, false)
  const waiting = reviewGuardView(bot({ reviewGuard: true, reviewGuardWaitingSince: Date.UTC(2026, 10, 24, 12, 5) }), roster, 'ask')
  assert.equal(waiting.lines.length, 3)
  assert.equal(waiting.lines[0], hard)
  assert.match(waiting.lines[1], /^Waiting for Ada reviewer's verdict on the plan since .+\.$/)
  assert.equal(waiting.lines[2], scope)
  assert.equal(reviewGuardView(bot({ reviewGuard: true }), { ...roster, readOnly: true }, 'ask').disabled, true)
})

function solverRun({ prefs, install, attach, read } = {}) {
  const calls = []
  const actions = {
    installRole: async id => {
      calls.push(['installRole', id])
      return install ? install() : { id, version: '1.0.0' }
    },
    createBot: async payload => { calls.push(['createBot', payload.role]); return { id: 's1', name: payload.name } },
    attachRole: async (id, role) => { calls.push(['attachRole', id, role]); return attach ? attach() : [role] },
    teamState: async () => { calls.push(['teamState']); return read?.() },
    deleteBot: async id => { calls.push(['deleteBot', id]) },
    send: async (id, brief) => { calls.push(['send', id, brief]) },
  }
  const result = createSolver({
    actions, prefs, before: new Set(), reviewer: { kind: 'fresh' },
    solverPayloadFor: () => solverPayload({ name: 'Solver', look: { shape: 'moon' }, brief: 'Compare libraries' }),
  })
  return { calls, result }
}

test('D2 E1 roles off skips install and attach even when Solver is installed', async () => {
  const run = solverRun({ prefs: { roles: false } })
  assert.equal((await run.result).roleNote, 'roles-off')
  assert.deepEqual(run.calls, [['createBot', 'Solver'], ['send', 's1', 'Compare libraries']])
})

test('D2 E2 roles on asks the host to verify an existing install before attach', async () => {
  const pin = { id: 'solver', version: '1.0.0', attachedAt: '2026-11-24T00:00:00Z' }
  const run = solverRun({ install: () => ({ id: 'solver', version: pin.version, warnings: [] }) })
  assert.equal((await run.result).roleNote, undefined)
  assert.deepEqual(run.calls, [
    ['installRole', 'solver'], ['createBot', 'Solver'], ['attachRole', 's1', 'solver'], ['send', 's1', 'Compare libraries'],
  ])
})

test('D2 E3 a lost attach reply needs the exact active pin and empty instructions', async () => {
  const pin = { id: 'solver', version: '1.0.0', attachedAt: '2026-11-24T00:00:00Z' }
  const roleRuntime = { s1: { pin } }
  const bot = { id: 's1', role: 'Solver', instructions: '', roles: [{ ...pin, grants: [] }] }
  const lost = () => { throw new Error('Reply lost') }
  for (const [read, roleNote] of [
    [() => ({ bots: [bot], roleRuntime }), undefined],
    [() => ({ bots: [bot] }), 'attach'],
    [() => ({ bots: [{ ...bot, instructions: 'Written method' }], roleRuntime }), 'attach'],
    [() => ({ bots: [bot], roleRuntime: { s1: { pin: { ...pin, attachedAt: 'later' } } } }), 'attach'],
    [() => ({ bots: [bot], roleRuntime: { s1: { pin, acp: true } } }), 'attach'],
    [() => ({ bots: [bot], roleRuntime: { s1: { pin, acp: false, promptWarning: "This model uses its Hermes profile's own instructions." } } }), 'attach'],
    [lost, 'attach'],
  ]) {
    const run = solverRun({ attach: lost, read })
    assert.equal((await run.result).roleNote, roleNote)
    assert.equal(run.calls.filter(([action]) => action === 'teamState').length, 1)
    assert.equal(run.calls.some(([action]) => action === 'deleteBot'), false)
  }
  const pending = solverRun({ attach: () => ({ pending: true }) })
  assert.equal((await pending.result).roleNote, 'attach')
  const failed = solverRun({ install: () => ({ installed: false }) })
  assert.equal((await failed.result).roleNote, 'install')
  assert.equal(failed.calls.some(([action]) => action === 'attachRole' || action === 'deleteBot'), false)
})

test('D2 E4 only a new reviewer is dedicated, and every create carries the written method', () => {
  const base = { name: 'Solver', look: { shape: 'moon' }, reviewer: 'Ada', reviewerId: 'r1' }
  assert.equal(solverPayload({ ...base, dedicated: true }).payload.reviewerMade, true)
  assert.equal(Object.hasOwn(solverPayload(base).payload, 'reviewerMade'), false)
  assert.equal(Object.hasOwn(solverPayload({ ...base, reviewerId: undefined, dedicated: true }).payload, 'reviewerMade'), false)
  assert.equal(solverPayload(base).payload.waitingRole, 'solver')
})

test('D2S a final verification refusal keeps Create on the install fallback', async () => {
  const run = solverRun({ install: () => { throw new Error('The installed role files differ from the signed package.') } })
  assert.equal((await run.result).roleNote, 'install')
  assert.deepEqual(run.calls, [['installRole', 'solver'], ['createBot', 'Solver'], ['send', 's1', 'Compare libraries']])
})
