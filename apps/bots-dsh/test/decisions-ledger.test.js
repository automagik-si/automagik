import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalDigest, capState, estimateTokens } from '../src/decisions/egress.js'
import { createLedger } from '../src/decisions/ledger.js'
import { PURPOSES } from '../src/decisions/purposes.js'
import { validatePurposeSettings, validateRequest } from '../src/decisions/validate.js'

const purpose = 'group-routing'
const day = 86_400_000
const today = Date.UTC(2026, 10, 28)
const options = (...ids) => ids.map(id => ({ id }))
const request = (ids = ['a', 'b'], overrides) => ({
  purpose, rubricVersion: 'group-routing/1', state: 'private group message',
  questions: [{ id: 'concerns', kind: 'multi-select', instructions: 'private rubric', options: options(...ids) }],
  deadlineMs: 2500, subject: { book: 'group-room', ref: '42' }, ...overrides,
})
const outcome = (decisionId, p, overrides) => ({
  decisionId, status: 'ok', providerId: 'provider', protocol: 'system-one',
  model: 'alias', answeredModel: 'actual', latencyMs: 50, attempts: 1, calibrated: true,
  answers: [{ id: 'concerns', kind: 'multi-select', p }], ...overrides,
})
const key = option => ({ questionId: 'concerns', option })
const judge = (option, value) => ({ ...key(option), value, source: 'user', strength: 'hard' })
const bot = (option, value) => ({ ...key(option), value, source: value ? 'answered' : 'passed', strength: 'soft' })
const overturn = option => ({ ...judge(option, true), source: 'overturn' })

function fixture(t, start = today) {
  const home = mkdtempSync(join(tmpdir(), 'decisions-ledger-'))
  const dir = join(home, 'decisions', 'ledger')
  let at = start
  const now = () => at
  let ledger = createLedger(home, { now })
  t.after(() => { ledger.close(); rmSync(home, { recursive: true, force: true }) })
  const files = () => readdirSync(dir).sort()
  const bytes = () => files().map(file => readFileSync(join(dir, file), 'utf8')).join('')
  return {
    get ledger() { return ledger },
    reopen() { ledger.close(); ledger = createLedger(home, { now }) },
    setTime(value) { at = value },
    dir, files, bytes,
    records: () => bytes().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  }
}

test('request bounds and registered purpose kinds are checked before appending', t => {
  const f = fixture(t)
  const req = request()
  const { questions: [q] } = req
  const append = patch => f.ledger.appendDecision({ ...req, ...patch }, outcome('d', { a: 0.5 }))
  for (const patch of [
    { purpose: 'unknown' }, { rubricVersion: 'settings-test/1' }, { rubricVersion: 'group-routing/0' },
    { state: 1 }, { state: { p: NaN } }, { state: [undefined] }, { state: new Date() },
    { deadlineMs: 49 }, { deadlineMs: 50.5 }, { deadlineMs: 30_001 }, { signal: {} },
    { questions: [] }, { questions: [q, q] }, { questions: [{ ...q, id: 'bad id' }] },
    { questions: [{ ...q, options: [] }] }, { questions: [{ ...q, options: options('a', 'a') }] },
    { questions: [{ ...q, options: options(...Array.from({ length: 65 }, (_, i) => `o${i}`)) }] },
    { questions: [{ ...q, kind: 'yes-no' }] },
  ]) assert.throws(() => append(patch), TypeError)
  const cycle = {}
  cycle.self = cycle
  assert.throws(() => append({ state: cycle }), TypeError)
  assert.deepEqual(f.files(), [])
  append({ deadlineMs: 50, questions: [{ ...q, options: options('a') }] })
  append({ deadlineMs: 30_000, questions: [{ ...q, options: options(...Array.from({ length: 64 }, (_, i) => i ? `o${i}` : 'a')) }] })
  assert.equal(f.records().length, 2)

  const registered = [{ id: 'approval-triage', kinds: ['score', 'choice'] }]
  for (const [kind, field, min, max] of [['choice', 'options', 2, 255], ['score', 'levels', 2, 10]]) {
    for (const n of [min - 1, min, max, max + 1]) {
      const ids = Array.from({ length: n }, (_, i) => `v${i}`)
      const candidate = request([], { purpose: 'approval-triage', rubricVersion: 'approval-triage/1',
        questions: [{ id: 'approval', kind, instructions: 'score', [field]: kind === 'choice' ? options(...ids) : ids }] })
      const validate = () => validateRequest(candidate, registered)
      if (n < min || n > max) assert.throws(validate, TypeError)
      else assert.doesNotThrow(validate)
    }
  }
  const yesNo = { id: 'yes', kind: 'yes-no', instructions: 'test', criteria: { yes: 'yes', no: 'no' } }
  const synthetic = request([], { purpose: 'settings-test', rubricVersion: 'settings-test/1', questions: [yesNo] })
  assert.doesNotThrow(() => validateRequest(synthetic))
  assert.throws(() => validateRequest({ ...synthetic, questions: [{ ...yesNo, criteria: { yes: 'yes' } }] }), TypeError)
})

test('both built-in purpose defaults and effective partial settings bounds', () => {
  assert.deepEqual(PURPOSES, [
    { id: purpose, label: 'Group routing', kinds: ['multi-select'], defaults: { tau: 0.5, k: 3, tau0: 0.2, deadlineMs: 2500, sure: 0.8 } },
    { id: 'settings-test', label: 'Settings test', kinds: ['yes-no'], defaults: { tau: 0.5, k: 1, tau0: 0.2, deadlineMs: 5000, sure: 0.8 } },
  ])
  for (const { defaults } of PURPOSES) {
    for (const patch of [
      { tau: 0 }, { tau: 1 }, { tau: NaN }, { tau0: -0.1 }, { tau0: 0.6 }, { tau: 0.19 },
      { sure: 0 }, { sure: 1.01 }, { sure: Infinity }, { k: 0 }, { k: 65 }, { k: 1.5 },
      { deadlineMs: 499 }, { deadlineMs: 30_001 }, { deadlineMs: 501.5 }, { extra: 1 },
    ]) assert.throws(() => validatePurposeSettings(defaults, patch), TypeError)
    const minima = { tau: 0.01, tau0: 0, sure: 0.01, k: 1, deadlineMs: 500 }
    const maxima = { tau: 0.99, tau0: 0.99, sure: 1, k: 64, deadlineMs: 30_000 }
    assert.deepEqual(validatePurposeSettings(defaults, minima), minima)
    assert.deepEqual(validatePurposeSettings(defaults, maxima), maxima)
    assert.throws(() => validatePurposeSettings(maxima, { tau: 0.8 }), TypeError)
    assert.throws(() => validatePurposeSettings(defaults, { tau: 0.3 }, { yesNoRange: [0.4, 0.6] }), TypeError)
    assert.throws(() => validatePurposeSettings(defaults, { tau: 0.7 }, { yesNoRange: [0.4, 0.6] }), TypeError)
  }
})

test('egress cap preserves valid structured state and digest canonicalizes objects only', () => {
  assert.deepEqual(capState('x'.repeat(16_001)), { state: 'x'.repeat(16_000), chars: 16_000 })
  assert.equal(capState('x'.repeat(15_999) + '🌍').chars, 15_999)
  const small = [1, { next: 'line\n' }]
  assert.deepEqual(capState(small), { state: small, chars: JSON.stringify(small).length })
  for (const input of [{ nested: ['"\n'.repeat(9000)] }, ['"\n'.repeat(9000)]]) {
    const capped = capState(input)
    assert.equal(capped.chars, JSON.stringify(capped.state).length)
    assert.ok(capped.chars > 15_990 && capped.chars <= 16_000)
    assert.equal(Array.isArray(capped.state), Array.isArray(input))
  }
  assert.equal(canonicalDigest({ a: [2, { x: 0, y: 1 }], b: 1 }), canonicalDigest({ b: 1, a: [2, { y: 1, x: 0 }] }))
  assert.notEqual(canonicalDigest([1, 2]), canonicalDigest([2, 1]))
  const call = { model: 'm', state: 'abc', questions: [], config: {} }
  assert.equal(estimateTokens(call), Math.ceil(JSON.stringify(call).length / 3.5))
})

test('ledger projects allowed metadata and appends identical requests separately', t => {
  const f = fixture(t)
  const req = request(['a'], { state: 'private-input'.repeat(1600), key: 'synthetic-key',
    subject: { book: 'group-room', ref: '42', body: 'private-subject' } })
  for (const id of ['first', 'second']) {
    const result = outcome(id, { a: 0.3 }, { cached: true, body: 'private-body', usage: { inputTokens: 17, raw: 'private-usage' } })
    result.answers[0].instructions = 'private-answer'
    f.ledger.appendDecision(req, result)
  }
  f.ledger.appendDecision(req, { decisionId: 'failed', status: 'unavailable', reason: 'no-provider',
    latencyMs: 0, attempts: 0, body: 'private-error', retryAfterMs: 999 })
  const [first, second, failure] = f.records()
  assert.deepEqual(first, { v: 1, kind: 'decision', id: 'first', at: today, purpose, rubricVersion: 'group-routing/1',
    providerId: 'provider', protocol: 'system-one', model: 'alias', answeredModel: 'actual',
    status: 'ok', latencyMs: 50, attempts: 1, calibrated: true, questionIds: ['concerns'],
    answers: [{ id: 'concerns', kind: 'multi-select', p: { a: 0.3 } }],
    stateDigest: canonicalDigest({ p: 'provider', m: 'alias', v: req.rubricVersion, s: req.state.slice(0, 16_000), q: req.questions }),
    stateChars: 16_000, usage: { inputTokens: 17 }, subject: { book: 'group-room', ref: '42' } })
  assert.deepEqual(second, { ...first, id: 'second' })
  assert.equal(failure.reason, 'no-provider')
  assert.deepEqual(failure.answers, [])
  assert.doesNotMatch(f.bytes(), /private-|synthetic-key|cached|retryAfterMs/)
  assert.deepEqual(f.ledger.evaluation(purpose), {
    purpose, total: 3, ok: 2, unavailable: { 'no-provider': 1 }, latency: { p50: 50, p95: 50 },
    cohorts: [{ providerId: 'provider', answeredModel: 'actual', rubricVersion: 'group-routing/1',
      scoredDecisions: 2, scoredOptions: 2, bins: [],
      human: { decisions: 0, positive: 0, negative: 0, belowTau: { positive: 0, negative: 0 }, atOrAboveTau: { positive: 0, negative: 0 } },
      behavior: { decisions: 0, exposedDecisions: 0, exposedOptions: 0, answered: 0, passed: 0 },
      sufficiency: { currentTau: 0.5, positiveBelow: 0, negativeBelow: 0, positiveAtOrAbove: 0, negativeAtOrAbove: 0, distinctJudgedDecisions: 0 } }],
  })
})

test('confirmed exposure and latest hard labels have independent denominators and histories', t => {
  const f = fixture(t)
  const { ledger } = f
  const stats = () => ledger.evaluation(purpose).cohorts[0]
  ledger.appendDecision(request(['a', 'b', 'c', 'd']), outcome('a', { a: 0.2, b: 0.7, c: 0.9 }))
  ledger.appendDecision(request(), outcome('empty', {}, { answers: [] }))
  ledger.appendDecision(request(), outcome('untouched', { a: 0.6, b: 0.2 }))
  const judgments = (...values) => ['a', 'b', 'c'].map((option, i) => ({ ...key(option), value: values[i] }))
  assert.deepEqual(ledger.judgments('a'), judgments(null, null, null))
  assert.equal(ledger.label('a', bot('a', true)), false)
  assert.equal(ledger.recordExposure('a', key('d')), false)
  assert.equal(ledger.recordExposure('empty', key('a')), false)
  assert.equal(ledger.label('a', judge('d', false)), false)
  assert.equal(ledger.label('missing', judge('a', false)), false)
  assert.throws(() => ledger.label('a', { ...overturn('a'), value: false }), TypeError)
  assert.throws(() => ledger.label('a', { ...bot('a', false), value: true }), TypeError)
  for (const option of ['a', 'a', 'b']) assert.equal(ledger.recordExposure('a', key(option)), true)
  assert.equal(ledger.recordExposure('untouched', key('a')), true)
  ledger.label('a', bot('a', false))
  ledger.label('a', bot('a', true))
  ledger.label('a', bot('b', false))
  assert.deepEqual(ledger.judgments('a'), judgments(null, null, null))
  const behavior = { decisions: 1, exposedDecisions: 2, exposedOptions: 3, answered: 1, passed: 1 }
  assert.deepEqual(stats().behavior, behavior)
  assert.equal(stats().scoredDecisions, 2)
  assert.equal(stats().scoredOptions, 5)
  assert.equal(stats().human.decisions, 0)
  assert.deepEqual(stats().bins, [])
  assert.equal(stats().brier, undefined)

  ledger.label('a', judge('a', false))
  ledger.label('a', judge('c', false))
  assert.deepEqual([stats().human.positive, stats().human.negative, stats().human.decisions], [0, 2, 1])
  assert.equal(stats().brier, undefined)
  ledger.label('a', overturn('b'))
  const check = (counts, positives, brier) => {
    const value = stats()
    assert.deepEqual([value.human.positive, value.human.negative, value.human.decisions], counts)
    assert.deepEqual(value.bins.filter(bin => bin.n), [2, 7, 9].map((i, index) =>
      ({ from: i / 10, to: (i + 1) / 10, n: 1, positives: positives[index] })))
    assert.ok(Math.abs(value.brier - brier) < 1e-12)
    assert.deepEqual(value.behavior, behavior)
    assert.equal(value.suggestion, undefined)
  }
  check([1, 2, 1], [0, 1, 0], (0.04 + 0.09 + 0.81) / 3)

  f.setTime(today + 1000)
  ledger.label('a', overturn('a'))
  assert.deepEqual(ledger.judgments('a'), judgments(true, true, false))
  check([2, 1, 1], [1, 1, 0], (0.64 + 0.09 + 0.81) / 3)
  ledger.label('a', overturn('c'))
  assert.equal(ledger.label('a', bot('c', true)), false)
  assert.deepEqual([stats().human.positive, stats().human.negative], [3, 0])
  assert.deepEqual(stats().bins, [])
  assert.equal(stats().brier, undefined)

  f.setTime(today + 500)
  ledger.label('a', judge('b', false))
  f.setTime(today + 1000)
  assert.deepEqual(ledger.judgments('a'), judgments(true, false, true))
  check([2, 1, 1], [1, 0, 1], (0.64 + 0.49 + 0.01) / 3)
  assert.equal(f.records().filter(row => row.strength === 'hard').length, 6)
  f.reopen()
  assert.equal(f.ledger.evaluation(purpose).cohorts[0].human.negative, 1)
})

test('write admission appends one record on success and leaves the ledger unchanged on refusal', t => {
  const f = fixture(t, today - 91 * day)
  const { ledger } = f
  ledger.appendDecision(request(), outcome('expired', { a: 0.2 }))
  f.setTime(today)
  ledger.appendDecision(request(), outcome('scored', { a: 0.2 }))
  ledger.appendDecision(request(), outcome('unavailable', {}, { status: 'unavailable', reason: 'no-provider' }))
  assert.deepEqual(ledger.judgments('unavailable'), [])
  assert.equal(ledger.judgments('missing'), undefined)
  assert.equal(ledger.judgments('expired'), undefined)
  const before = f.bytes()
  for (const [id, option] of [['missing', 'a'], ['expired', 'a'], ['unavailable', 'a'], ['scored', 'b']]) {
    assert.equal(ledger.recordExposure(id, key(option)), false)
    assert.equal(ledger.label(id, judge(option, false)), false)
  }
  assert.equal(ledger.label('scored', bot('a', true)), false)
  assert.throws(() => ledger.label('scored', { ...overturn('a'), value: false }), TypeError)
  assert.equal(f.bytes(), before)

  const records = f.records()
  assert.equal(ledger.recordExposure('scored', key('a')), true)
  const meta = { v: 1, at: today, decisionId: 'scored' }
  records.push({ ...meta, kind: 'exposed', ...key('a') })
  assert.deepEqual(f.records(), records)
  for (const label of [bot('a', true), judge('a', false)]) {
    assert.equal(ledger.label('scored', label), true)
    records.push({ ...meta, kind: 'label', ...label })
    assert.deepEqual(f.records(), records)
  }
})

test('admitted writes propagate append I/O errors', t => {
  const f = fixture(t)
  f.ledger.appendDecision(request(), outcome('scored', { a: 0.2 }))
  f.setTime(Date.UTC(2026, 11, 1))
  mkdirSync(join(f.dir, '2026-12.jsonl'))
  assert.throws(() => f.ledger.recordExposure('scored', key('a')), { code: 'EISDIR' })
  assert.throws(() => f.ledger.label('scored', judge('a', false)), { code: 'EISDIR' })
})

const sides = [0.2, 0.1, 0.5, 0.8]
function addSamples(ledger, counts, distinct, identity = {}) {
  const samples = counts.flatMap((n, i) => Array.from({ length: n }, () => ({
    p: sides[i], value: i % 2 === 0,
  })))
  for (let i = 0; i < distinct; i++) {
    const id = `${identity.prefix ?? 'd'}-${i}`
    const labels = samples.filter((_, index) => index % distinct === i)
    const ids = labels.map((_, j) => `o${j}`)
    ledger.appendDecision(request(ids, identity.request), outcome(id, Object.fromEntries(labels.map(({ p }, j) => [ids[j], p])), identity.outcome))
    labels.forEach(({ value }, j) => assert.equal(ledger.label(id, judge(ids[j], value)), true))
  }
}

test('suggestion requires each count, both signs on each side and distinct decisions at current tau', async t => {
  for (const [name, counts, distinct, eligible] of [
    ['at all lower bounds', [5, 5, 15, 15], 30, true],
    ['19 positives', [5, 5, 14, 15], 30, false], ['19 negatives', [5, 5, 15, 14], 30, false],
    ['29 distinct', [5, 5, 15, 15], 29, false],
    ['4 positives below', [4, 5, 16, 15], 30, false], ['4 negatives below', [5, 4, 15, 16], 30, false],
    ['5 of both above', [15, 15, 5, 5], 30, true],
    ['4 positives above', [16, 15, 4, 5], 30, false], ['4 negatives above', [15, 16, 5, 4], 30, false],
  ]) await t.test(name, sub => {
    const { ledger } = fixture(sub)
    addSamples(ledger, counts, distinct)
    const [value] = ledger.evaluation(purpose, { tau: 0.5 }).cohorts
    const [positiveBelow, negativeBelow, positiveAtOrAbove, negativeAtOrAbove] = counts
    assert.deepEqual(value.sufficiency, { currentTau: 0.5, positiveBelow, negativeBelow,
      positiveAtOrAbove, negativeAtOrAbove, distinctJudgedDecisions: distinct })
    assert.equal(value.scoredDecisions, distinct)
    assert.equal(value.scoredOptions, counts.reduce((a, b) => a + b, 0))
    assert.equal(value.human.positive, positiveBelow + positiveAtOrAbove)
    assert.equal(value.human.negative, negativeBelow + negativeAtOrAbove)
    assert.deepEqual(value.suggestion, eligible ? { tau: 0.2, f1: 40 / (60 - negativeBelow), n: 40 } : undefined)
    assert.equal(ledger.evaluation(purpose, { tau: 0.50001 }).cohorts[0].suggestion, undefined)
  })
})

test('cohorts never pool and evaluation windows narrow the exact 90-day retention cutoff', t => {
  const f = fixture(t, today - 140 * day)
  const { ledger } = f
  ledger.appendDecision(request(), outcome('prune', { a: 0.1 }))
  f.setTime(today - 90 * day - 1)
  ledger.appendDecision(request(), outcome('one-ms-expired', { a: 0.1 }))
  ledger.label('one-ms-expired', judge('a', false))
  f.setTime(today - 90 * day)
  addSamples(ledger, [5, 5, 15, 15], 30, { prefix: 'edge' })
  f.setTime(today)
  const snapshot = () => f.files().map(file => [file, readFileSync(join(f.dir, file))])
  assert.deepEqual(f.files(), ['2026-07.jsonl', '2026-08.jsonl'])
  const before = snapshot()
  assert.equal(ledger.judgments('prune'), undefined)
  assert.equal(ledger.judgments('one-ms-expired'), undefined)
  assert.ok(ledger.judgments('edge-0').length > 0)
  assert.deepEqual(snapshot(), before)
  const original = ledger.evaluation(purpose)
  assert.deepEqual(f.files(), ['2026-08.jsonl'])
  assert.equal(original.total, 30)
  assert.equal(original.cohorts[0].suggestion.n, 40)
  assert.deepEqual(ledger.evaluation(purpose, { sinceMs: today - 90 * day + 1 }).cohorts, [])
  assert.equal(ledger.evaluation(purpose, { sinceMs: today - 120 * day }).total, 30)
  assert.equal(ledger.recordExposure('one-ms-expired', key('a')), false)

  for (const identity of [
    { prefix: 'base' }, { prefix: 'provider', outcome: { providerId: 'different' } },
    { prefix: 'model', outcome: { answeredModel: 'different' } },
    { prefix: 'rubric', request: { rubricVersion: 'group-routing/2' } },
  ]) addSamples(ledger, [3, 3, 7, 7], 15, identity)
  ledger.appendDecision(request([], { purpose: 'settings-test', rubricVersion: 'settings-test/1',
    questions: [{ id: 'test', kind: 'yes-no', instructions: 'synthetic' }] }),
  outcome('test', {}, { answers: [{ id: 'test', kind: 'yes-no', p: 0.8 }] }))
  assert.deepEqual(ledger.judgments('test'), [{ questionId: 'test', value: null }])
  const narrowed = ledger.evaluation(purpose, { sinceMs: today })
  assert.equal(narrowed.total, 60)
  assert.deepEqual(narrowed.cohorts.map(c => [c.providerId, c.answeredModel, c.rubricVersion]), [
    ['provider', 'actual', 'group-routing/1'], ['different', 'actual', 'group-routing/1'],
    ['provider', 'different', 'group-routing/1'], ['provider', 'actual', 'group-routing/2'],
  ])
  for (const c of narrowed.cohorts) {
    assert.deepEqual([c.human.positive, c.human.negative, c.human.decisions], [10, 10, 15])
    assert.equal(c.suggestion, undefined)
  }
  assert.equal(ledger.evaluation('settings-test').total, 1)
  f.setTime(today + 4 * day)
  f.reopen()
  assert.deepEqual(f.files(), ['2026-11.jsonl'])
})

test('a partial tail survives restart without consuming the next decision', t => {
  const f = fixture(t)
  f.ledger.appendDecision(request(), outcome('before', { a: 0.6 }))
  appendFileSync(join(f.dir, f.files()[0]), '{"v":1,')
  const before = f.bytes()
  f.reopen()
  f.ledger.appendDecision(request(), outcome('after', { a: 0.6 }))
  assert.ok(f.bytes().startsWith(before + '\n'))
  assert.equal(f.ledger.evaluation(purpose).total, 2)
  assert.equal(f.ledger.label('after', judge('a', true)), true)
})
