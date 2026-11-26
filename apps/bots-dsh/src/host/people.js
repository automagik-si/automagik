import { refusal } from './refusal.js'

const MODES = new Set(['owners', 'allowlist', 'workspace'])
const ROLES = new Set(['member', 'guest'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validIdentity = value => typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/\p{Cc}/u.test(value)
const invalid = message => refusal(message, { code: 'bot/invalid' })
export const ownersOnly = () => ({ mode: 'owners', allow: [] })
export const personKey = ({ issuer, subject }) => JSON.stringify([issuer, subject])

function checkedList(allow) {
  if (!Array.isArray(allow) || allow.length > 100) throw invalid('Name at most 100 people')
  const keys = new Set()
  return Array.from(allow, entry => {
    if (!object(entry) || Object.keys(entry).length !== 3 ||
        !['issuer', 'subject', 'role'].every(key => Object.hasOwn(entry, key)) ||
        !validIdentity(entry.issuer) || !validIdentity(entry.subject) || !ROLES.has(entry.role)) {
      throw invalid('Each person needs a valid issuer, subject and role')
    }
    const key = personKey(entry)
    if (keys.has(key)) throw invalid('Name each person only once')
    keys.add(key)
    return { issuer: entry.issuer, subject: entry.subject, role: entry.role }
  })
}

export function peopleOf(bot, { main = false } = {}) {
  const value = bot?.people
  if (!object(value) || !Object.hasOwn(value, 'mode') || !Object.hasOwn(value, 'allow') ||
      Object.keys(value).length !== 2 || !MODES.has(value.mode)) return ownersOnly()
  try {
    return { mode: main && value.mode === 'workspace' ? 'allowlist' : value.mode, allow: checkedList(value.allow) }
  } catch {
    return ownersOnly()
  }
}

function seenRole(roles) {
  if (!Array.isArray(roles) || !Array.from(roles).every(role => typeof role === 'string') ||
      roles.includes('owner') || roles.includes('admin')) return undefined
  return roles.includes('member') ? 'member' : roles.includes('guest') ? 'guest' : undefined
}

export function cleanPeople(input, { main = false, current = ownersOnly(), seen = [], narrow = false } = {}) {
  if (!object(input)) throw invalid('Sharing settings must be an object')
  for (const key of Object.keys(input)) {
    if (key !== 'mode' && key !== 'allow') throw invalid('Unknown sharing field ' + key)
  }
  if (!Object.hasOwn(input, 'mode') || !MODES.has(input.mode)) throw invalid('Unknown sharing mode')
  if (main && input.mode === 'workspace') throw refusal('A Main Bot is shared only with people you name')
  const allow = checkedList(Object.hasOwn(input, 'allow') ? input.allow : [])
  if (narrow) {
    const kept = allow.filter(entry => current.allow.some(person => person.role === entry.role && personKey(person) === personKey(entry)))
    return { mode: input.mode, allow: kept }
  }
  const existing = new Set(current.allow.map(personKey))
  const admitted = new Map(seen.map(person => [personKey(person), seenRole(person.roles)]))
  for (const entry of allow) {
    const key = personKey(entry)
    if (!existing.has(key) && admitted.get(key) !== entry.role) {
      throw refusal(entry.issuer + ' ' + entry.subject + ' has not signed in since the last restart, or not as a ' + entry.role)
    }
  }
  return { mode: input.mode, allow }
}
