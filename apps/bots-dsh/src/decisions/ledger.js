import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalDigest, capState } from './egress.js'
import { PURPOSES } from './purposes.js'
import { inRange, isId, validateRequest } from './validate.js'

const DAY = 86_400_000
const RETENTION = 90 * DAY
const MONTH_FILE = /^\d{4}-(0[1-9]|1[0-2])\.jsonl$/
const monthOf = at => new Date(at).toISOString().slice(0, 7)
const probability = n => inRange(n, 0, 1)
const natural = n => Number.isSafeInteger(n) && n >= 0
const modelId = value => typeof value === 'string' && /^[a-z0-9_@./:+-]+$/i.test(value) ? value : ''
const reasons = new Set([
  'no-provider', 'provider-gone', 'no-model', 'no-key', 'auth', 'quota',
  'timeout', 'rate-limited', 'overloaded', 'server', 'unreachable', 'invalid-request',
  'too-large', 'refused', 'invalid-response', 'breaker-open', 'busy', 'cancelled',
])
const protocols = new Set(['system-one', 'openai-decisions', 'llm-structured'])
const scoreKey = ({ questionId, option }) => JSON.stringify([questionId, option])
const cohortKey = ({ providerId, answeredModel, rubricVersion }) => JSON.stringify([providerId, answeredModel, rubricVersion])

function labelStrength({ source, value, strength }) {
  if (typeof value !== 'boolean') return
  if (strength === 'hard' && (source === 'user' || (source === 'overturn' && value))) return 'hard'
  if (strength === 'soft' && (source === (value ? 'answered' : 'passed'))) return 'soft'
}

function ledgerAnswers(questions, answers) {
  const byId = new Map(questions.map(question => [question.id, question]))
  return answers.map(answer => {
    const { id, kind } = answer
    const question = byId.get(id)
    if (!question || kind !== question.kind) throw new TypeError('Invalid ledger answer')
    byId.delete(id)
    if (kind === 'yes-no') {
      if (!probability(answer.p)) throw new TypeError('Invalid ledger probability')
      return { id, kind, p: answer.p }
    }
    const keys = kind === 'score' ? question.levels.map((_, i) => String(i)) : question.options.map(option => option.id)
    const source = kind === 'multi-select' ? answer.p : answer.probabilities
    const entries = Object.entries(source ?? {})
    if (entries.some(([key, value]) => !keys.includes(key) || !probability(value))) {
      throw new TypeError('Invalid ledger probabilities')
    }
    const probabilities = Object.fromEntries(entries)
    if (kind === 'multi-select') return { id, kind, p: probabilities }
    const score = kind === 'score'
    const selected = score && natural(answer.score) ? String(answer.score) : answer.choice
    if ((score && !natural(answer.score)) || !keys.includes(selected)) {
      throw new TypeError('Invalid ledger selection')
    }
    const selection = score ? { score: answer.score } : { choice: answer.choice }
    const confidence = probability(answer.confidence) ? { confidence: answer.confidence } : {}
    return { id, kind, ...selection, probabilities, ...confidence }
  })
}

function scoresFor(record) {
  const scores = new Map()
  for (const { id, kind, p, probabilities } of record.answers) {
    if (kind === 'yes-no') {
      if (probability(p)) scores.set(scoreKey({ questionId: id }), p)
    } else {
      for (const [option, score] of Object.entries(probabilities ?? p ?? {})) {
        if (probability(score)) scores.set(scoreKey({ questionId: id, option }), score)
      }
    }
  }
  return scores
}

function cohortStats(decisions, tau) {
  const { providerId, answeredModel, rubricVersion } = decisions[0].record
  const count = () => ({ positive: 0, negative: 0 })
  const human = { decisions: 0, ...count(), belowTau: count(), atOrAboveTau: count() }
  const behavior = { decisions: 0, exposedDecisions: 0, exposedOptions: 0, answered: 0, passed: 0 }
  const samples = []
  let scoredOptions = 0
  let scoredDecisions = 0
  for (const { scores, hard, soft, exposed } of decisions) {
    scoredOptions += scores.size
    scoredDecisions += Number(scores.size > 0)
    human.decisions += Number(hard.size > 0)
    behavior.decisions += Number(soft.size > 0)
    behavior.exposedDecisions += Number(exposed.size > 0)
    behavior.exposedOptions += exposed.size
    for (const [key, value] of hard) {
      const score = scores.get(key)
      const sign = value ? 'positive' : 'negative'
      human[sign]++
      human[score < tau ? 'belowTau' : 'atOrAboveTau'][sign]++
      samples.push({ score, value })
    }
    for (const value of soft.values()) behavior[value ? 'answered' : 'passed']++
  }

  const sufficiency = {
    currentTau: tau,
    positiveBelow: human.belowTau.positive, negativeBelow: human.belowTau.negative,
    positiveAtOrAbove: human.atOrAboveTau.positive, negativeAtOrAbove: human.atOrAboveTau.negative,
    distinctJudgedDecisions: human.decisions,
  }
  const result = { providerId, answeredModel, rubricVersion, scoredDecisions, scoredOptions, human, behavior, bins: [], sufficiency }
  if (human.positive === 0 || human.negative === 0) return result

  result.bins = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, n: 0, positives: 0 }))
  let squaredError = 0
  for (const { score, value } of samples) {
    const bin = result.bins[Math.min(9, Math.floor(score * 10))]
    bin.n++
    bin.positives += Number(value)
    squaredError += (score - Number(value)) ** 2
  }
  result.brier = squaredError / samples.length
  if (human.positive >= 20 && human.negative >= 20 && human.decisions >= 30
    && Object.values(human.belowTau).every(n => n >= 5)
    && Object.values(human.atOrAboveTau).every(n => n >= 5)) {
    result.suggestion = suggest(samples, human.positive, tau)
  }
  return result
}

function suggest(samples, positive, currentTau) {
  const thresholds = [...new Set([0.01, 0.99, currentTau, ...samples.map(({ score }) => score)])]
    .filter(tau => inRange(tau, 0.01, 0.99)).sort((a, b) => b - a)
  samples.sort((a, b) => b.score - a.score)
  let seen = 0
  let truePositives = 0
  let best
  for (const tau of thresholds) {
    while (seen < samples.length && samples[seen].score >= tau) {
      truePositives += Number(samples[seen++].value)
    }
    const f1 = 2 * truePositives / (positive + seen)
    if (!best || f1 > best.f1 || (f1 === best.f1 && Math.abs(tau - currentTau) < Math.abs(best.tau - currentTau))) {
      best = { tau, f1, n: samples.length }
    }
  }
  return best
}

export function createLedger(home, { now = Date.now, purposes, dir = join(home, 'decisions', 'ledger') } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const monthlyFiles = () => readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && MONTH_FILE.test(entry.name)).map(entry => entry.name).sort()

  let prunedOn
  function prune(at) {
    const day = Math.floor(at / DAY)
    if (prunedOn === day) return
    // Keep the boundary month and apply the exact cutoff when reading its records.
    const keepFrom = monthOf(at - RETENTION)
    for (const file of monthlyFiles()) {
      if (file.slice(0, 7) < keepFrom) rmSync(join(dir, file), { force: true })
    }
    prunedOn = day
  }

  prune(now())
  const timer = setInterval(() => {
    try { prune(now()) } catch { /* The next ledger operation retries a failed prune. */ }
  }, DAY).unref()

  function append(at, fields) {
    prune(at)
    appendFileSync(join(dir, `${monthOf(at)}.jsonl`), JSON.stringify({ v: 1, at, ...fields }) + '\n', { mode: 0o600 })
  }

  function read(at, sinceMs) {
    prune(at)
    const from = Math.max(at - RETENTION, sinceMs ?? -Infinity)
    const decisions = new Map()
    for (const file of monthlyFiles()) {
      if (file.slice(0, 7) < monthOf(from)) continue
      let contents
      try { contents = readFileSync(join(dir, file), 'utf8') } catch (error) {
        if (error.code === 'ENOENT') continue
        throw error
      }
      for (const line of contents.split('\n')) {
        if (!line) continue
        let record
        try { record = JSON.parse(line) } catch { continue }
        if (record?.v !== 1 || !inRange(record.at, from, at)) continue
        if (record.kind === 'decision') {
          if (!Array.isArray(record.answers) || !inRange(record.latencyMs, 0, Infinity)
            || (record.status !== 'ok' && (record.status !== 'unavailable' || !reasons.has(record.reason)))) continue
          if (!decisions.has(record.id)) decisions.set(record.id, {
            record, scores: record.status === 'ok' ? scoresFor(record) : new Map(),
            hard: new Map(), soft: new Map(), exposed: new Set(),
          })
          continue
        }
        const entry = decisions.get(record.decisionId)
        const key = scoreKey(record)
        if (!entry?.scores.has(key)) continue
        if (record.kind === 'exposed' && typeof record.option === 'string') entry.exposed.add(key)
        if (record.kind === 'label') {
          const strength = labelStrength(record)
          if (strength === 'hard') entry.hard.set(key, record.value)
          if (strength === 'soft' && entry.exposed.has(key)) entry.soft.set(key, record.value)
        }
      }
    }
    return decisions
  }

  return {
    close: () => clearInterval(timer),
    appendDecision(request, outcome, { wireQuestions = request.questions, providerId, model, protocol } = {}) {
      validateRequest(request, purposes)
      const { decisionId, status, latencyMs, attempts } = outcome
      if (!isId(decisionId) || !inRange(latencyMs, 0, Infinity) || !natural(attempts)
        || (status !== 'ok' && (status !== 'unavailable' || !reasons.has(outcome.reason)))) {
        throw new TypeError('Invalid ledger outcome')
      }
      const { purpose, rubricVersion, subject, questions } = request
      const { state, chars: stateChars } = capState(request.state)
      const selectedProvider = outcome.providerId ?? providerId
      providerId = isId(selectedProvider) ? selectedProvider : ''
      model = modelId(outcome.model ?? model)
      protocol = outcome.protocol ?? protocol
      const answeredModel = status === 'ok' ? modelId(outcome.answeredModel ?? model) : ''
      if (status === 'ok' && (!providerId || !model || !answeredModel || !protocols.has(protocol))) {
        throw new TypeError('Invalid ledger provider metadata')
      }
      const record = {
        kind: 'decision', id: decisionId, purpose, rubricVersion, providerId, model, answeredModel,
        status, latencyMs, attempts, calibrated: status === 'ok' && outcome.calibrated === true,
        questionIds: questions.map(question => question.id),
        answers: status === 'ok' ? ledgerAnswers(questions, outcome.answers) : [],
        stateDigest: canonicalDigest({ p: providerId, m: model, v: rubricVersion, s: state, q: wireQuestions }),
        stateChars,
      }
      if (protocols.has(protocol)) record.protocol = protocol
      if (subject) record.subject = { book: subject.book, ref: subject.ref }
      if (status === 'unavailable') {
        record.reason = outcome.reason
        if (natural(outcome.httpStatus) && inRange(outcome.httpStatus, 100, 599)) record.httpStatus = outcome.httpStatus
      } else {
        if (outcome.truncation === 'possible') record.truncation = 'possible'
        const { inputTokens, outputTokens } = outcome.usage ?? {}
        if (natural(inputTokens) || natural(outputTokens)) record.usage = {
          inputTokens: natural(inputTokens) ? inputTokens : undefined,
          outputTokens: natural(outputTokens) ? outputTokens : undefined,
        }
      }
      append(now(), record)
    },
    recordExposure(decisionId, { questionId, option }) {
      const at = now()
      const entry = read(at).get(decisionId)
      const key = scoreKey({ questionId, option })
      if (typeof option !== 'string' || !entry?.scores.has(key)) return false
      append(at, { kind: 'exposed', decisionId, questionId, option })
      return true
    },
    label(decisionId, { questionId, option, source, strength, value }) {
      if (!labelStrength({ source, strength, value })) throw new TypeError('Invalid decision label')
      const at = now()
      const entry = read(at).get(decisionId)
      const key = scoreKey({ questionId, option })
      if (!entry?.scores.has(key) || (strength === 'soft' && !entry.exposed.has(key))) return false
      append(at, { kind: 'label', decisionId, questionId, option, source, strength, value })
      return true
    },
    evaluation(purpose, { sinceMs, tau } = {}) {
      tau ??= (purposes ?? PURPOSES).find(spec => spec.id === purpose)?.defaults.tau
      if (!inRange(tau, 0.01, 0.99) || (sinceMs !== undefined && !Number.isFinite(sinceMs))) {
        throw new TypeError('Invalid decision evaluation window or tau')
      }
      const latencies = []
      const unavailable = {}
      const cohorts = new Map()
      let ok = 0
      for (const entry of read(now(), sinceMs).values()) {
        const { record } = entry
        if (record.purpose !== purpose) continue
        latencies.push(record.latencyMs)
        if (record.status !== 'ok') {
          unavailable[record.reason] = (unavailable[record.reason] ?? 0) + 1
          continue
        }
        ok++
        const key = cohortKey(record)
        if (!cohorts.has(key)) cohorts.set(key, [])
        cohorts.get(key).push(entry)
      }
      latencies.sort((a, b) => a - b)
      const percentile = p => latencies[Math.ceil(latencies.length * p) - 1] ?? 0
      return { purpose, total: latencies.length, ok, unavailable, latency: { p50: percentile(0.5), p95: percentile(0.95) },
        cohorts: [...cohorts.values()].map(decisions => cohortStats(decisions, tau)) }
    },
  }
}
