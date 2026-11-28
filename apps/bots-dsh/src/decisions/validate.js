import { PURPOSES } from './purposes.js'

export const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max
export const isId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:-]*$/i.test(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const integer = (value, min, max) => Number.isInteger(value) && inRange(value, min, max)
const count = (value, min, max) => Array.isArray(value) && inRange(value.length, min, max)
const plainObject = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function check(condition, field) {
  if (!condition) throw new TypeError(`Invalid decision ${field}`)
}

function json(value, ancestors = new Set()) {
  if (value === null || ['boolean', 'string'].includes(typeof value) || Number.isFinite(value)) return true
  if ((!Array.isArray(value) && !plainObject(value)) || ancestors.has(value)) return false
  ancestors.add(value)
  let valid = true
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!json(item, ancestors)) { valid = false; break }
    }
  } else {
    valid = Object.values(value).every(item => json(item, ancestors))
  }
  ancestors.delete(value)
  return valid
}

function validateQuestion(question, kinds, ids) {
  check(plainObject(question) && isId(question.id) && !ids.has(question.id), 'question id')
  ids.add(question.id)
  check(kinds.includes(question.kind) && text(question.instructions), 'question')
  if (question.kind === 'yes-no' && question.criteria !== undefined) {
    check(plainObject(question.criteria) && text(question.criteria.yes) && text(question.criteria.no), 'yes-no criteria')
  }
  if (question.kind === 'score') {
    check(count(question.levels, 2, 10) && Array.from(question.levels).every(text), 'score levels')
  }
  if (question.kind === 'choice' || question.kind === 'multi-select') {
    const choice = question.kind === 'choice'
    check(count(question.options, choice ? 2 : 1, choice ? 255 : 64), 'options')
    const options = new Set()
    for (const option of question.options) {
      check(plainObject(option) && isId(option.id) && !options.has(option.id), 'option id')
      check(option.description === undefined || typeof option.description === 'string', 'option description')
      options.add(option.id)
    }
  }
}

export function validateRequest(request, purposes = PURPOSES) {
  check(plainObject(request), 'request')
  const purpose = [...purposes].find(spec => spec.id === request.purpose)
  check(purpose, 'purpose')
  const prefix = `${request.purpose}/`
  check(typeof request.rubricVersion === 'string' && request.rubricVersion.startsWith(prefix)
    && /^[1-9][0-9]*$/.test(request.rubricVersion.slice(prefix.length)), 'rubric version')
  check((typeof request.state === 'string' || Array.isArray(request.state) || plainObject(request.state))
    && json(request.state), 'state')
  check(integer(request.deadlineMs, 50, 30_000), 'deadline')
  check(request.signal === undefined || request.signal instanceof AbortSignal, 'signal')
  if (request.subject !== undefined) {
    check(plainObject(request.subject) && isId(request.subject.book) && isId(request.subject.ref), 'subject')
  }
  // Provider limits apply to the expanded batch, after this transport check.
  check(Array.isArray(request.questions) && request.questions.length > 0, 'question count')
  const ids = new Set()
  for (const question of request.questions) validateQuestion(question, purpose.kinds, ids)
}

export function validatePurposeSettings(current, patch, provider) {
  check(plainObject(patch) && Object.keys(patch).every(key => Object.hasOwn(current, key)), 'settings patch')
  const settings = { ...current, ...patch }
  const [providerMin, providerMax] = provider?.yesNoRange ?? [0, 1]
  check(inRange(settings.tau, Math.max(0.01, providerMin), Math.min(0.99, providerMax)), 'tau')
  check(inRange(settings.tau0, 0, settings.tau), 'tau0')
  check(inRange(settings.sure, 0.01, 1), 'sure')
  check(integer(settings.k, 1, 64), 'k')
  check(integer(settings.deadlineMs, 500, 30_000), 'settings deadline')
  return settings
}
