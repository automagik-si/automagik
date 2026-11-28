import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { classify, COUNTED, DecisionProviderError } from './classify.js'
import { capState, estimateTokens } from './egress.js'
import { createLedger } from './decision-history.js'
import { PURPOSES } from './purposes.js'
import { abortable, Breaker, gateOf, retrying } from './resilience.js'
import { inRange, isId, validatePurposeSettings, validateRequest } from './validate.js'

const MODEL = /^[a-z0-9_@./:+-]+$/i
const PROTOCOLS = new Set(['system-one', 'openai-decisions', 'llm-structured'])
const SETTINGS_FIELDS = ['providerId', 'model', 'providerConfig', 'purposes']
const NO_KEY = Object.freeze({ configured: false, writable: false })
const object = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const validModel = value => typeof value === 'string' && MODEL.test(value)
const valueOf = (dict, key) => Object.hasOwn(dict, key) ? dict[key] : undefined
const configKeys = info => (info?.config ?? []).filter(field => field.secret === false)
  .map(field => `${info.id}.${field.key}`)

function copyQuestion({ id, kind, instructions, options, levels, criteria }) {
  const question = { id, kind, instructions }
  if (kind === 'choice' || kind === 'multi-select') {
    question.options = options.map(({ id, description }) => ({ id, description }))
  }
  if (kind === 'score') question.levels = [...levels]
  if (kind === 'yes-no' && criteria) question.criteria = { yes: criteria.yes, no: criteria.no }
  return question
}

function expand(questions) {
  const ids = new Set(questions.map(({ id }) => id))
  const expanded = new Map()
  const wire = questions.flatMap(question => {
    if (question.kind !== 'multi-select') return [question]
    const parts = question.options.map(({ id: option, description }, i) => {
      let id = `${question.id}__${i}`
      while (ids.has(id)) id += '_'
      ids.add(id)
      return { id, option, instructions: `${question.instructions}\nMember: ${description || option}` }
    })
    expanded.set(question.id, parts)
    return parts.map(({ id, instructions }) => ({ id, kind: 'yes-no', instructions }))
  })
  return { wire, expanded }
}

function validateAnswer(question, answer, [min, max]) {
  const invalid = () => { throw new DecisionProviderError('invalid-response') }
  const { id, kind } = question
  if (answer?.kind !== kind) invalid()
  if (kind === 'yes-no') {
    if (!inRange(answer.p, min - 1e-6, max + 1e-6) || !inRange(answer.p, 0, 1)) invalid()
    return { id, kind, p: answer.p }
  }
  const keys = kind === 'choice' ? question.options.map(option => option.id)
    : question.levels.map((_, i) => String(i))
  const { probabilities, confidence, score, choice } = answer
  if (!object(probabilities) || Object.keys(probabilities).length !== keys.length) invalid()
  let sum = 0
  const entries = keys.map(key => {
    const p = valueOf(probabilities, key)
    if (!inRange(p, 0, 1)) invalid()
    sum += p
    return [key, p]
  })
  if (Math.abs(sum - 1) > 0.02 + Number.EPSILON * keys.length) invalid()
  if (confidence !== undefined && !inRange(confidence, 0, 1)) invalid()
  if (kind === 'choice' ? !keys.includes(choice) : !Number.isInteger(score) || !keys.includes(String(score))) invalid()
  return { id, kind, ...(kind === 'choice' ? { choice } : { score }),
    probabilities: Object.fromEntries(entries), ...(confidence !== undefined && { confidence }) }
}

function normalize(set, questions, wire, expanded, info, key) {
  if (!validModel(set?.answeredModel) || (key && set.answeredModel.includes(key))
    || !Array.isArray(set.answers) || set.answers.length !== wire.length) {
    throw new DecisionProviderError('invalid-response')
  }
  const byId = new Map()
  for (const answer of set.answers) byId.set(answer?.id, answer)
  const validated = new Map(wire.map(question => [question.id,
    validateAnswer(question, byId.get(question.id), info.yesNoRange)]))
  const answers = questions.map(({ id, kind }) => kind === 'multi-select'
    ? { id, kind, p: Object.fromEntries(expanded.get(id).map(part => [part.option, validated.get(part.id).p])) }
    : validated.get(id))
  const usage = Object.fromEntries(['inputTokens', 'outputTokens'].flatMap(name => {
    const count = set.usage?.[name]
    return Number.isSafeInteger(count) && count >= 0 ? [[name, count]] : []
  }))
  return {
    answeredModel: set.answeredModel, answers, calibrated: info.calibrated === true,
    ...(set.truncation === 'possible' && info.stateTruncation === 'silent' && { truncation: 'possible' }),
    ...(Object.keys(usage).length > 0 && { usage }),
  }
}

function track(registration, fn) {
  const pending = Promise.resolve().then(fn)
  registration.pending.add(pending)
  const done = () => { registration.pending.delete(pending) }
  pending.then(done, done)
  return pending
}

export default class Decisions extends Service {
  static Config = z.object({
    providerId: z.string().default('').volatile(),
    model: z.string().default('').volatile(),
    providerConfig: z.dict(z.string()).default({}).volatile(),
    purposes: z.dict(z.object({
      tau: z.number().min(0.01).max(0.99), k: z.natural().min(1).max(64),
      tau0: z.number().min(0).max(0.99), deadlineMs: z.natural().min(500).max(30_000),
      sure: z.number().min(0.01).max(1),
    })).default({}).volatile(),
    maxConcurrent: z.natural().min(1).default(8),
    breaker: z.object({ failures: z.natural().min(1).default(5), cooldownMs: z.natural().min(1000).default(30_000) }),
    // The ledger and its evaluation window share the RFC's fixed retention policy.
    ledger: z.object({ dir: z.string().default(''), retentionDays: z.const(90).default(90) }),
  })

  providers = new Map()
  purposes = new Map(PURPOSES.map(spec => [spec.id, spec]))
  listeners = new Set()
  lifetime = new AbortController()
  configuring = Promise.resolve()

  constructor(ctx, config) {
    super(ctx, 'decisions')
    this.owner = ctx
    this.config = config
    this.entryId = ctx.fiber.entry?.options.id
    const home = process.env.AUTOMAGIK_HOME?.trim() || join(homedir(), '.automagik')
    this.ledgerOptions = { home: resolve(home.replace(/^~(?=$|[/\\])/, homedir())), dir: config.ledger.dir || undefined }
    try { this.openLedger() } catch (error) { this.ledgerError = error }

    ctx.on('loader/volatile-update', () => this.changed())
    ctx.on('credentials/reference-updated', ref => this.credentialsChanged(ref))
    ctx.on('internal/service', name => {
      if (name === 'credentials') this.credentialsChanged()
    })
    // The Decisions page owns provider selection and acknowledgment of its data terms.
    ctx.inject(['settings'], scope => {
      scope.effect(() => scope.settings.configure?.({ auto: false }, ctx.fiber))
    })
    ctx.effect(() => async () => {
      this.lifetime.abort(new DecisionProviderError('cancelled'))
      await Promise.all([...this.providers.values()].map(reg => this.remove(reg)))
      this.listeners.clear()
      this.ledger?.close()
    })
  }

  openLedger() {
    this.ledger ??= createLedger(this.ledgerOptions.home, {
      dir: this.ledgerOptions.dir,
      // A purpose can be withdrawn while its already validated request is pending.
      purposes: { [Symbol.iterator]: () => (this.ledgerPurposes ?? this.purposes.values())[Symbol.iterator]() },
    })
    return this.ledger
  }

  register(provider) {
    this.lifetime.signal.throwIfAborted()
    const info = structuredClone(provider.info)
    if (!isId(info.id) || !PROTOCOLS.has(info.protocol) || typeof provider.evaluate !== 'function') {
      throw new TypeError('Invalid decision provider')
    }
    if (this.providers.has(info.id)) throw new Error(`Decision provider already registered: ${info.id}`)
    const reg = {
      provider, info, lifetime: new AbortController(), pending: new Set(),
      gate: gateOf(this.config.maxConcurrent), breaker: new Breaker(this.config.breaker), keyVersion: 0,
    }
    this.providers.set(info.id, reg)
    this.refreshKey(reg)
    this.changed()
    return () => this.remove(reg)
  }

  remove(reg) {
    if (reg.removal) return reg.removal
    reg.removal = Promise.resolve().then(async () => {
      await Promise.allSettled(reg.pending)
      this.providers.delete(reg.info.id)
    })
    reg.lifetime.abort(new DecisionProviderError('provider-gone'))
    this.changed()
    return reg.removal
  }

  registerPurpose(spec) {
    this.lifetime.signal.throwIfAborted()
    if (this.purposes.has(spec.id)) throw new Error(`Decision purpose already registered: ${spec.id}`)
    const registered = structuredClone(spec)
    validatePurposeSettings(registered.defaults, {})
    this.purposes.set(registered.id, registered)
    this.changed()
    return () => {
      if (this.purposes.get(registered.id) !== registered) return
      this.purposes.delete(registered.id)
      this.changed()
    }
  }

  activeProviders() {
    return [...this.providers.values()].filter(reg => !reg.lifetime.signal.aborted)
  }

  provider(id) {
    const reg = this.providers.get(id)
    return reg?.lifetime.signal.aborted ? undefined : reg
  }

  listProviders() {
    return this.activeProviders().map(({ info }) => structuredClone(info))
  }

  changed() {
    for (const notify of this.listeners) notify()
  }

  credentialsChanged(ref) {
    for (const reg of this.activeProviders()) {
      if (ref === undefined || reg.info.credential?.ref === ref) this.refreshKey(reg)
    }
    this.changed()
  }

  async refreshKey(reg) {
    const ref = reg.info.credential?.ref
    if (!ref) return
    const version = ++reg.keyVersion
    reg.key = undefined
    reg.keyRejected = false
    let description
    try { description = await this.owner.get('credentials')?.describe(ref) } catch { /* Unavailable metadata. */ }
    if (reg.keyVersion !== version || reg.lifetime.signal.aborted) return
    if (description) {
      const { configured, writable, source, masked } = description
      reg.key = { configured: configured === true, writable: writable === true,
        ...(typeof source === 'string' && { source }), ...(typeof masked === 'string' && { masked }) }
    }
    this.changed()
  }

  selection() {
    return { providerId: this.config.providerId.get() || null, model: this.config.model.get() || null }
  }

  settings(purpose) {
    const spec = this.purposes.get(purpose)
    if (!spec) throw new TypeError('Unknown decision purpose')
    const stored = valueOf(this.config.purposes.get(), purpose) ?? {}
    try {
      return validatePurposeSettings(spec.defaults, stored)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      // An externally edited profile can pass the field schema but violate tau0 <= tau.
      return { ...spec.defaults }
    }
  }

  snapshot() {
    const selection = this.selection()
    const reg = this.provider(selection.providerId)
    let notReady
    if (!selection.providerId) notReady = 'no-provider'
    else if (!reg) notReady = 'provider-gone'
    else if (!validModel(selection.model)) notReady = 'no-model'
    else if (reg.keyRejected) notReady = 'auth'
    else if (reg.info.credential && !reg.key?.configured) notReady = 'no-key'
    return {
      providers: this.activeProviders().map(reg => ({
        ...structuredClone(reg.info),
        key: reg.info.credential ? { ...(reg.key ?? NO_KEY), ...(reg.keyRejected && { rejected: true }) } : null,
        health: { ...reg.breaker.snapshot(), ...(reg.last && { last: reg.last }) },
      })),
      selection,
      purposes: [...this.purposes.values()].map(spec => ({ ...structuredClone(spec), settings: this.settings(spec.id) })),
      ready: !notReady, ...(notReady && { notReady }),
    }
  }

  async *follow(caller) {
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    let wake, timer
    const notify = () => wake.resolve()
    signal.addEventListener('abort', notify, { once: true })
    this.listeners.add(notify)
    try {
      while (!signal.aborted) {
        wake = Promise.withResolvers()
        const snapshot = this.snapshot()
        const until = Math.min(...snapshot.providers.map(({ health }) => health.openUntil ?? Infinity))
        if (Number.isFinite(until)) {
          timer = setTimeout(notify, Math.min(2 ** 31 - 1, Math.max(0, until - Date.now()))).unref()
        }
        yield snapshot
        await wake.promise
        clearTimeout(timer)
      }
    } finally {
      clearTimeout(timer)
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  configure(patch) {
    const update = this.configuring.then(() => this.saveSelection(patch))
    this.configuring = update.catch(() => {})
    return update
  }

  async saveSelection(patch) {
    this.lifetime.signal.throwIfAborted()
    if (!object(patch) || Object.keys(patch).some(key => !SETTINGS_FIELDS.includes(key))) {
      throw new TypeError('Invalid decision selection patch')
    }
    const current = this.selection()
    const selection = { ...current, ...patch }
    const reg = this.provider(selection.providerId)
    if (Object.hasOwn(patch, 'providerId') && selection.providerId !== null && !reg) {
      throw new TypeError('Unknown decision provider')
    }
    if (selection.model !== null && !validModel(selection.model)) throw new TypeError('Invalid decision model')
    const fields = {}
    for (const name of ['providerId', 'model']) {
      if (Object.hasOwn(patch, name)) fields[name] = patch[name] ?? ''
    }
    if (Object.hasOwn(patch, 'providerConfig')) {
      const allowed = new Set(this.activeProviders().flatMap(({ info }) => configKeys(info)))
      if (!object(patch.providerConfig) || Object.entries(patch.providerConfig)
        .some(([key, value]) => !allowed.has(key) || typeof value !== 'string')) {
        throw new TypeError('Invalid decision provider config')
      }
      fields.providerConfig = patch.providerConfig
    }
    const purposePatch = Object.hasOwn(patch, 'purposes') ? patch.purposes : {}
    if (!object(purposePatch) || Object.keys(purposePatch).some(id => !this.purposes.has(id))) {
      throw new TypeError('Unknown decision purpose')
    }
    if (Object.values(purposePatch).some(value => !object(value))) throw new TypeError('Invalid decision purpose settings')
    const stored = this.config.purposes.get()
    const updates = []
    for (const [id, spec] of this.purposes) {
      if (Object.hasOwn(purposePatch, id)) {
        const effective = { ...valueOf(stored, id), ...purposePatch[id] }
        updates.push([id, validatePurposeSettings(spec.defaults, effective, reg?.info)])
      } else {
        validatePurposeSettings(spec.defaults, this.settings(id), reg?.info)
      }
    }
    if (Object.hasOwn(patch, 'purposes')) fields.purposes = Object.fromEntries(updates)
    const settings = this.owner.get('settings')
    if (!settings || !this.entryId) throw new Error('Decisions configuration requires a settings service and profile entry')
    await settings.update(this.entryId, fields)
  }

  async decide(request) {
    return this.runDecision(request, this.selection())
  }

  async test(selection, signal) {
    const request = {
      purpose: 'settings-test', rubricVersion: 'settings-test/1',
      state: 'Can someone check why the build failed?',
      questions: [{ id: 'action', kind: 'yes-no', instructions: 'Is this a request for someone to act?' }],
      deadlineMs: this.settings('settings-test').deadlineMs, signal,
    }
    const current = this.selection()
    return this.runDecision(request, {
      providerId: selection?.providerId === undefined ? current.providerId : selection.providerId,
      model: selection?.model === undefined ? current.model : selection.model,
    })
  }

  async runDecision(request, selection) {
    const start = Date.now()
    const purposes = [...this.purposes.values()]
    validateRequest(request, purposes)
    const decisionId = randomUUID()
    const { providerId, model } = selection
    const reg = this.provider(providerId)
    const questions = request.questions.map(copyQuestion)
    const ledgerRequest = {
      purpose: request.purpose, rubricVersion: request.rubricVersion, deadlineMs: request.deadlineMs,
      questions, state: structuredClone(capState(request.state).state),
      ...(request.subject && { subject: { book: request.subject.book, ref: request.subject.ref } }),
    }
    const { wire, expanded } = expand(questions)
    let attempts = 0
    let exposeModel = validModel(model)
    const settle = (result) => {
      const outcome = { decisionId, latencyMs: Math.max(0, Date.now() - start), attempts, ...result }
      if (providerId && isId(providerId)) outcome.providerId = providerId
      if (exposeModel) outcome.model = model
      this.ledgerPurposes = purposes
      try {
        this.openLedger().appendDecision(ledgerRequest, outcome, { wireQuestions: wire, protocol: reg?.info.protocol })
      } catch {
        // Preserve the outcome. Later admission checks need the missing history row.
        console.warn(`[decisions] Could not record decision ${decisionId} in local history.`)
      } finally {
        this.ledgerPurposes = undefined
      }
      return outcome
    }
    const unavailable = (reason) => ({ status: 'unavailable', reason })
    if (this.lifetime.signal.aborted) return { decisionId, latencyMs: 0, attempts, ...unavailable('cancelled') }
    if (request.signal?.aborted) return settle(unavailable('cancelled'))
    if (!providerId) return settle(unavailable('no-provider'))
    if (!reg) return settle(unavailable('provider-gone'))
    if (!model) return settle(unavailable('no-model'))
    if (!validModel(model)) return settle(unavailable('invalid-request'))

    const deadlineAt = start + request.deadlineMs
    const deadline = new AbortController()
    const timeout = new DecisionProviderError('timeout')
    const timer = setTimeout(() => deadline.abort(timeout), Math.max(0, deadlineAt - Date.now()))
    const signal = AbortSignal.any([this.lifetime.signal, reg.lifetime.signal, deadline.signal,
      ...(request.signal ? [request.signal] : [])])
    const call = {
      model, state: ledgerRequest.state, questions: wire,
      config: Object.fromEntries(configKeys(reg.info).flatMap(key => {
        const value = valueOf(this.config.providerConfig.get(), key)
        return value === undefined ? [] : [[key, value]]
      })),
    }
    return track(reg, async () => {
      const { info, breaker } = reg
      let epoch, keyVersion
      try {
        signal.throwIfAborted()
        if (Date.now() >= deadlineAt) throw timeout
        const ref = info.credential?.ref
        let key
        if (ref) {
          keyVersion = reg.keyVersion
          const credentials = this.owner.get('credentials')
          if (credentials) {
            const resolving = track(reg, () => {
              signal.throwIfAborted()
              return credentials.resolve(ref)
            })
            key = (await abortable(resolving, signal))?.value
          }
          if (!key) return settle(unavailable('no-key'))
          if (reg.keyVersion !== keyVersion) return settle(unavailable('no-key'))
          if (reg.keyRejected) return settle(unavailable('auth'))
          if (model.includes(key)) {
            exposeModel = false
            return settle(unavailable('invalid-request'))
          }
          if (Object.values(call.config).some(value => value.includes(key))) return settle(unavailable('invalid-request'))
        }
        const { limits } = info
        const size = limits.contextTokens === undefined ? 0 : estimateTokens(call)
        if (wire.length > limits.maxQuestions || questions.some(q =>
          (q.kind === 'choice' && q.options.length > limits.maxOptions)
          || (q.kind === 'score' && q.levels.length > limits.maxLevels))
          || (info.stateTruncation === 'rejects' && size > limits.contextTokens)) {
          return settle(unavailable('too-large'))
        }
        if (Date.now() >= deadlineAt) throw timeout
        if (breaker.snapshot().breaker === 'open') return settle(unavailable('breaker-open'))
        const result = await reg.gate.run(deadlineAt, () => {
          signal.throwIfAborted()
          if (!breaker.allows()) throw new DecisionProviderError('breaker-open')
          epoch = breaker.epoch
          return track(reg, async () => {
            const set = await retrying(reg, call, key, signal, deadlineAt, () => {
              if (ref && reg.keyVersion !== keyVersion) throw new DecisionProviderError('no-key')
              if (reg.keyRejected) throw new DecisionProviderError('auth')
              attempts++
            })
            return normalize(set, questions, wire, expanded, info, key)
          })
        }, signal, timeout)
        signal.throwIfAborted()
        if (Date.now() >= deadlineAt) throw timeout
        breaker.success(epoch)
        reg.last = undefined
        return settle({ status: 'ok', protocol: info.protocol, ...result })
      } catch (error) {
        const failure = classify(error, signal, request.signal)
        const { reason } = failure
        if (epoch !== undefined) {
          if (COUNTED.has(reason)) breaker.failure(failure.retryAfterMs, epoch)
          else breaker.neutral(epoch)
          if (reason === 'auth' && info.credential && reg.keyVersion === keyVersion) reg.keyRejected = true
          reg.last = reason
        }
        return settle({ status: 'unavailable', ...failure })
      } finally {
        clearTimeout(timer)
        if (epoch !== undefined) this.changed()
      }
    })
  }

  async recordExposure(decisionId, key) {
    return this.openLedger().recordExposure(decisionId, key)
  }

  async label(decisionId, label) {
    return this.openLedger().label(decisionId, label)
  }

  async judgments(decisionId) {
    if (!this.ledger) throw this.ledgerError
    return this.ledger.judgments(decisionId)
  }

  async evaluation(purpose, { sinceMs } = {}) {
    return this.openLedger().evaluation(purpose, { sinceMs, tau: this.settings(purpose).tau })
  }
}
