import assert from 'node:assert/strict'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import Decisions, { DecisionProviderError } from '../decisions.js'
import { PURPOSES } from '../src/decisions/purposes.js'
import { answer, fakeProvider, KEY, model, mount, REF, routing } from './fixtures/decisions/fake-provider.js'

const credential = { ref: REF, header: 'bearer' }
const keyA = { questionId: 'concerns', option: 'a' }
const hard = { ...keyA, source: 'user', strength: 'hard', value: false }
const soft = { ...keyA, source: 'answered', strength: 'soft', value: true }
const DAY = 86_400_000

test('selects exactly one provider with no default, fallback or deduplication', async t => {
  const { decisions, rows } = await mount(t)
  let fails = true
  const chosen = fakeProvider({ evaluate(call) {
    if (fails) throw new DecisionProviderError('refused', { cause: new Error(KEY) })
    return answer(call)
  } })
  const other = fakeProvider({ id: 'other' })
  decisions.register(chosen.provider)
  decisions.register(other.provider)
  assert.throws(() => decisions.register(chosen.provider), /already registered/)
  assert.deepEqual(decisions.listProviders().map(({ id }) => id), ['fake', 'other'])
  assert.equal((await decisions.decide(routing())).reason, 'no-provider')
  assert.equal(chosen.calls.length, 0)
  await decisions.configure({ providerId: 'fake' })
  assert.equal((await decisions.decide(routing())).reason, 'no-model')
  await decisions.configure({ model })
  const failure = await decisions.decide(routing())
  assert.equal(failure.reason, 'refused')
  assert.equal(failure.attempts, 1)
  assert.equal(JSON.stringify(failure).includes(KEY), false)
  fails = false
  const request = routing()
  const results = await Promise.all([decisions.decide(request), decisions.decide(request)])
  for (const outcome of results) {
    assert.equal(outcome.status, 'ok')
    assert.equal(outcome.attempts, 1)
    assert.deepEqual(outcome.answers, [{ id: 'concerns', kind: 'multi-select', p: { a: 0.8, b: 0.8 } }])
    assert.equal(Object.hasOwn(outcome, 'cached'), false)
  }
  assert.notEqual(results[0].decisionId, results[1].decisionId)
  assert.equal(chosen.calls.length, 3)
  assert.equal(other.calls.length, 0)
  assert.equal(JSON.stringify(rows()).includes(KEY), false)
  assert.equal(rows().some(row => Object.hasOwn(row, 'cached')), false)
})

test('synchronous snapshots and follow expose only current credential metadata', async t => {
  let value
  let describes = 0
  let resolves = 0
  const initial = Promise.withResolvers()
  const credentials = {
    describe(ref) {
      assert.equal(ref, REF)
      if (++describes === 1) return initial.promise
      return Promise.resolve({ configured: !!value, writable: true, source: 'fixture', masked: '••••', value })
    },
    async resolve(ref) {
      assert.equal(ref, REF)
      resolves++
      return value ? { value } : undefined
    },
  }
  const { decisions, root } = await mount(t, { providerId: 'fake', model })
  const fake = fakeProvider({ info: { credential } })
  decisions.register(fake.provider)
  const observer = new AbortController()
  const feed = decisions.follow(observer.signal)
  assert.equal((await feed.next()).value.notReady, 'no-key')
  assert.equal(resolves, 0)
  assert.equal((await decisions.decide(routing())).reason, 'no-key')
  assert.equal(fake.calls.length, 0)
  const unmount = root.provide('credentials', credentials)
  await setImmediate()
  assert.equal(describes, 1)
  value = KEY
  root.emit('credentials/reference-updated', REF)
  await setImmediate()
  const ready = (await feed.next()).value
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.providers[0].key, { configured: true, writable: true, source: 'fixture', masked: '••••' })
  assert.equal(JSON.stringify(ready).includes(KEY), false)
  assert.equal((await decisions.decide(routing())).status, 'ok')
  assert.equal(fake.calls[0].key, KEY)
  assert.equal(Object.hasOwn(fake.calls[0].call, 'key'), false)
  value = undefined
  root.emit('credentials/reference-updated', REF)
  await setImmediate()
  initial.resolve({ configured: true, writable: true, source: 'stale' })
  await setImmediate()
  assert.equal((await feed.next()).value.notReady, 'no-key')
  assert.equal(decisions.snapshot().providers[0].key.source, 'fixture')
  await unmount()
  assert.equal(decisions.snapshot().providers[0].key.configured, false)
  const pending = feed.next()
  observer.abort()
  assert.equal((await pending).done, true)
})

test('effective Settings updates go through the real volatile Loader entry and remain bounded', async t => {
  const { decisions, writes, presentations } = await mount(t)
  const chosen = fakeProvider({ info: { yesNoRange: [0.2, 0.9], config: [{ key: 'account', label: 'Account', secret: false }] } })
  const other = fakeProvider({ id: 'other', info: { config: [{ key: 'account', label: 'Account', secret: false }] } })
  decisions.register(chosen.provider)
  decisions.register(other.provider)
  assert.deepEqual(presentations.get('decisions'), { auto: false })
  assert.throws(() => Decisions.Config({ ledger: { retentionDays: 89 } }))
  assert.deepEqual(decisions.settings('group-routing'), PURPOSES[0].defaults)
  const controller = new AbortController()
  const snapshots = decisions.follow(controller.signal)
  t.after(() => controller.abort())
  assert.equal((await snapshots.next()).value.notReady, 'no-provider')
  await decisions.configure({
    providerId: 'fake', model, providerConfig: { 'fake.account': 'public-id', 'other.account': 'other-id' },
    purposes: { 'group-routing': { tau: 0.65, k: 2 } },
  })
  const settings = { ...PURPOSES[0].defaults, tau: 0.65, k: 2 }
  assert.deepEqual(writes, [{ id: 'decisions', patch: { providerId: 'fake', model,
    providerConfig: { 'fake.account': 'public-id', 'other.account': 'other-id' }, purposes: { 'group-routing': settings } } }])
  assert.equal((await snapshots.next()).value.ready, true)
  assert.deepEqual(decisions.settings('group-routing'), settings)
  for (const patch of [
    { tau: NaN }, { tau: 0.95 }, { tau: 0.15 }, { tau0: 0.7 }, { sure: 1.01 }, { k: 2.5 },
    { deadlineMs: 499 }, { deadlineMs: 30_001 }, { deadlineMs: 500.5 }, { unknown: true }, null,
  ]) await assert.rejects(decisions.configure({ purposes: { 'group-routing': patch } }), TypeError)
  await assert.rejects(decisions.configure({ providerConfig: { 'fake.key': KEY } }), TypeError)
  await assert.rejects(decisions.configure({ providerId: 'unregistered' }), TypeError)
  assert.equal(writes.length, 1)
  const [first, second] = await Promise.allSettled([
    decisions.configure({ purposes: { 'group-routing': { tau0: 0.6 } } }),
    decisions.configure({ purposes: { 'group-routing': { tau: 0.55 } } }),
  ])
  assert.equal(first.status, 'fulfilled')
  assert.equal(second.status, 'rejected')
  assert.equal(decisions.settings('group-routing').tau0, 0.6)
  assert.equal((await decisions.decide(routing())).status, 'ok')
  assert.deepEqual(chosen.calls[0].call.config, { 'fake.account': 'public-id' })
  await decisions.configure({ providerId: null, model: null })
  assert.deepEqual(decisions.snapshot().selection, { providerId: null, model: null })
  await snapshots.return()
})

test('a purpose with inconsistent stored thresholds remains readable and repairable', async t => {
  const { id, defaults } = PURPOSES[0]
  const stored = { ...defaults, tau: 0.55, tau0: 0.9, k: 7, deadlineMs: 4200 }
  const { decisions, writes } = await mount(t, { purposes: { [id]: stored } })
  const feed = decisions.follow(new AbortController().signal)
  const view = snapshot => snapshot.purposes.find(purpose => purpose.id === id).settings
  assert.deepEqual(decisions.settings(id), defaults)
  assert.deepEqual(view(decisions.snapshot()), defaults)
  assert.deepEqual(view((await feed.next()).value), defaults)
  assert.equal(writes.length, 0)
  await decisions.configure({ model })
  assert.deepEqual(writes[0].patch, { model })
  await assert.rejects(decisions.configure({ purposes: { [id]: { tau0: 0.6 } } }), TypeError)
  await assert.rejects(decisions.configure({ purposes: { [id]: { k: 4 } } }), TypeError)
  assert.equal(writes.length, 1)
  await decisions.configure({ purposes: { [id]: { tau0: 0.35 } } })
  const repaired = { ...stored, tau0: 0.35 }
  assert.deepEqual(writes[1].patch, { purposes: { [id]: repaired } })
  assert.deepEqual(view((await feed.next()).value), repaired)
  await feed.return()
})

test('bounds and normalizes outgoing state, questions and answered metadata', async t => {
  const { decisions, rows } = await mount(t, { providerId: 'fake', model })
  const chosen = fakeProvider({ info: { limits: { maxQuestions: 2, maxOptions: 2, maxLevels: 2 } }, evaluate(call) {
    const set = answer(call)
    return { ...set, answers: set.answers.reverse().map(result => ({ ...result, private: KEY })),
      usage: { inputTokens: 12, outputTokens: -1, secret: KEY }, raw: KEY }
  } })
  decisions.register(chosen.provider)
  await assert.rejects(decisions.decide(routing({ deadlineMs: 49 })), TypeError)
  assert.deepEqual(rows(), [])
  const request = routing({ state: { text: '🟩\n'.repeat(9000) }, subject: { book: 'book', ref: '25', raw: KEY } })
  request.questions[0].raw = KEY
  const result = await decisions.decide(request)
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.usage, { inputTokens: 12 })
  const [call] = chosen.calls.map(entry => entry.call)
  assert.ok(JSON.stringify(call.state).length <= 16_000)
  assert.deepEqual(Object.keys(call), ['model', 'state', 'questions', 'config'])
  assert.deepEqual(call.questions.map(({ id, kind, instructions }) => [id, kind, instructions]), [
    ['concerns__0', 'yes-no', 'Who needs to act?\nMember: Build maintainer'],
    ['concerns__1', 'yes-no', 'Who needs to act?\nMember: Docs maintainer'],
  ])
  const [row] = rows()
  assert.match(row.stateDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(row.stateChars, JSON.stringify(call.state).length)
  assert.deepEqual(row.subject, { book: 'book', ref: '25' })
  assert.equal(JSON.stringify([result, call, row]).includes(KEY), false)
  request.questions[0].options.push({ id: 'c' })
  assert.equal((await decisions.decide(request)).reason, 'too-large')
  assert.equal(chosen.calls.length, 1)
})

test('registered purposes, choice and score normalization, and malformed answers', async t => {
  const { decisions, rows } = await mount(t, { providerId: 'fake', model, breaker: { failures: 9 } })
  const spec = { ...PURPOSES[0], id: 'approval-triage', kinds: ['multi-select', 'yes-no', 'choice', 'score'] }
  const unregister = decisions.registerPurpose(spec)
  assert.throws(() => decisions.registerPurpose(spec), /already registered/)
  const request = { purpose: spec.id, rubricVersion: 'approval-triage/1', deadlineMs: 1000, state: 'fixture',
    questions: [
      ...routing().questions,
      { id: 'concerns__0', kind: 'yes-no', instructions: 'Act?' },
      { id: 'priority', kind: 'choice', instructions: 'Which?', options: [{ id: 'soon' }, { id: 'later' }] },
      { id: 'score', kind: 'score', instructions: 'How likely?', levels: ['little', 'much'] },
    ] }
  let change = list => list
  decisions.register(fakeProvider({ info: { yesNoRange: [0.01, 0.99] }, evaluate(call) {
    assert.equal(new Set(call.questions.map(q => q.id)).size, 5)
    const answers = call.questions.map(({ id, kind }) => {
      if (kind === 'yes-no') return { id, kind, p: 0.99 }
      if (kind === 'choice') return { id, kind, choice: 'soon', probabilities: { soon: 0.6, later: 0.4 }, confidence: 0.7 }
      return { id, kind, score: 1, probabilities: { 0: 0.1, 1: 0.9 } }
    })
    return { answeredModel: model, answers: change(answers) }
  } }).provider)
  const outcome = await decisions.decide(request)
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.answers[2].confidence, 0.7)
  assert.equal(outcome.answers[3].score, 1)
  for (const mutate of [
    list => list.slice(1), list => [...list, list[0]], list => [list[1], ...list.slice(1)],
    list => [{ ...list[0], p: 1 }, ...list.slice(1)],
    list => [{ ...list[0], kind: 'choice' }, ...list.slice(1)],
    list => list.map(x => x.kind === 'choice' ? { ...x, probabilities: { soon: 0.55, later: 0.4 } } : x),
    list => list.map(x => x.kind === 'choice' ? { ...x, choice: 'never' } : x),
  ]) {
    change = mutate
    assert.equal((await decisions.decide(request)).reason, 'invalid-response')
  }
  assert.equal(rows().length, 8)
  unregister()
  await assert.rejects(decisions.decide(request), TypeError)
})

test('Settings test uses fixed canned text and evaluation uses the current purpose threshold', async t => {
  const { decisions, rows } = await mount(t, { providerId: 'fake', model })
  let p = 0.4
  const chosen = fakeProvider({ evaluate: call => answer(call, p) })
  const other = fakeProvider({ id: 'other' })
  decisions.register(chosen.provider)
  decisions.register(other.provider)
  const demo = await decisions.test({ providerId: 'other', model: 'other/test', state: 'owner state' })
  assert.equal(demo.status, 'ok')
  assert.deepEqual(other.calls[0].call, { model: 'other/test', state: 'Can someone check why the build failed?',
    questions: [{ id: 'action', kind: 'yes-no', instructions: 'Is this a request for someone to act?' }], config: {} })
  assert.equal(rows()[0].purpose, 'settings-test')
  assert.equal((await decisions.evaluation('group-routing')).total, 0)
  for (let i = 0; i < 40; i++) {
    p = i < 20 ? 0.4 : 0.8
    const result = await decisions.decide(routing())
    assert.equal(await decisions.label(result.decisionId, { ...hard, value: i % 2 === 0 }), true)
  }
  const [qualified] = (await decisions.evaluation('group-routing')).cohorts
  assert.equal(qualified.human.positive + qualified.human.negative, 40)
  assert.equal(qualified.scoredOptions, 80)
  assert.equal(qualified.bins.reduce((total, bin) => total + bin.n, 0), 40)
  assert.ok(qualified.brier > 0)
  assert.ok(qualified.suggestion)
  await decisions.configure({ purposes: { 'group-routing': { tau: 0.85 } } })
  const [unqualified] = (await decisions.evaluation('group-routing')).cohorts
  assert.equal(unqualified.sufficiency.currentTau, 0.85)
  assert.equal(unqualified.suggestion, undefined)
  assert.equal((await decisions.evaluation('group-routing', { sinceMs: Date.now() + DAY })).total, 0)
})

test('admission preserves append, refusal and errors; judgment reads never prune or call providers', async t => {
  const clock = t.mock.method(Date, 'now', () => Date.UTC(2026, 0, 1))
  const { decisions, dir, files, rows } = await mount(t, { providerId: 'fake', model })
  const old = await decisions.decide(routing())
  assert.deepEqual(await decisions.judgments(old.decisionId), [])
  const fake = fakeProvider()
  decisions.register(fake.provider)
  clock.mock.mockImplementation(() => Date.UTC(2026, 5, 1))
  const expiredBytes = files()
  assert.equal(await decisions.judgments(old.decisionId), undefined)
  assert.deepEqual(files(), expiredBytes)
  assert.equal(fake.calls.length, 0)
  assert.equal(await decisions.label(old.decisionId, hard), false)
  assert.deepEqual(files(), {})

  const ok = await decisions.decide(routing())
  const unavailable = await decisions.test({ providerId: 'missing' })
  const demo = await decisions.test()
  assert.deepEqual(await decisions.judgments(ok.decisionId), [
    { ...keyA, value: null }, { ...keyA, option: 'b', value: null },
  ])
  assert.deepEqual(await decisions.judgments(unavailable.decisionId), [])
  assert.deepEqual(await decisions.judgments(demo.decisionId), [{ questionId: 'action', value: null }])
  assert.equal(await decisions.judgments('missing'), undefined)
  const before = rows().length
  assert.equal(await decisions.label(ok.decisionId, soft), false)
  for (const id of ['missing', old.decisionId, unavailable.decisionId]) {
    assert.equal(await decisions.recordExposure(id, keyA), false)
    assert.equal(await decisions.label(id, hard), false)
  }
  assert.equal(await decisions.label(ok.decisionId, { ...hard, option: 'unknown' }), false)
  assert.equal(await decisions.recordExposure(ok.decisionId, { ...keyA, option: 'unknown' }), false)
  await assert.rejects(decisions.label(ok.decisionId, { ...soft, value: false }), TypeError)
  assert.equal(rows().length, before)
  assert.equal(await decisions.recordExposure(ok.decisionId, keyA), true)
  assert.equal(rows().length, before + 1)
  assert.equal(await decisions.label(ok.decisionId, soft), true)
  assert.equal(rows().length, before + 2)
  assert.equal(await decisions.label(ok.decisionId, { ...hard, source: 'overturn', value: true }), true)
  assert.equal((await decisions.judgments(ok.decisionId))[0].value, true)
  assert.equal(await decisions.label(ok.decisionId, hard), true)
  const labeled = files()
  assert.deepEqual(await decisions.judgments(ok.decisionId), [
    { ...keyA, value: false }, { ...keyA, option: 'b', value: null },
  ])
  assert.deepEqual(files(), labeled)
  assert.equal(fake.calls.length, 2)
  const [cohort] = (await decisions.evaluation('group-routing', { sinceMs: 0 })).cohorts
  assert.equal(cohort.behavior.exposedOptions, 1)
  assert.equal(cohort.behavior.answered, 1)
  assert.equal(cohort.human.negative, 1)

  const moved = join(dir, '..', dir.split('/').at(-1) + '-moved')
  renameSync(dir, moved)
  writeFileSync(dir, '')
  const warn = t.mock.method(console, 'warn', () => {})
  let lostId
  try {
    for (const operation of [
      () => decisions.recordExposure(ok.decisionId, keyA), () => decisions.label(ok.decisionId, hard),
      () => decisions.judgments(ok.decisionId), () => decisions.evaluation('group-routing'),
    ]) await assert.rejects(operation, { code: 'ENOTDIR' })
    const lost = await decisions.decide(routing())
    assert.equal(lost.status, 'ok')
    lostId = lost.decisionId
    assert.deepEqual(warn.mock.calls.map(call => call.arguments),
      [[`[decisions] Could not record decision ${lostId} in local history.`]])
  } finally {
    rmSync(dir)
    renameSync(moved, dir)
  }
  assert.equal(await decisions.judgments(lostId), undefined)
  assert.equal(await decisions.recordExposure(lostId, keyA), false)
  const recovered = await decisions.decide(routing())
  assert.ok(rows().some(row => row.id === recovered.decisionId))
  assert.equal(warn.mock.callCount(), 1)
})
