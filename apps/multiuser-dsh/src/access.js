const ROLES = new Set(['owner', 'admin', 'member', 'guest'])
const MODES = new Set(['owners', 'allowlist', 'workspace'])

export function effectiveRole(roles) {
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > ROLES.size ||
      new Set(roles).size !== roles.length || !Array.from(roles).every(role => ROLES.has(role)) ||
      roles.includes('owner') || roles.includes('admin')) return undefined
  if (roles.includes('member')) return 'member'
  if (roles.includes('guest')) return 'guest'
}

export function roleOf(principal) {
  if (principal?.kind === 'owner') return 'owner'
  if (principal?.kind === 'automagik') return effectiveRole(principal.person?.roles)
}

const validString = value => typeof value === 'string' && value.length >= 1 && value.length <= 512

function factPeople(people, main) {
  if (!MODES.has(people?.mode) || !Array.isArray(people.allow) || people.allow.length > 100 ||
      !Array.from(people.allow).every(person => validString(person?.issuer) && validString(person?.subject))) {
    return { mode: 'owners', allow: [] }
  }
  return {
    mode: main && people.mode === 'workspace' ? 'allowlist' : people.mode,
    allow: people.allow.map(({ issuer, subject }) => ({ issuer, subject })),
  }
}

export function checkFacts(iterable) {
  const facts = new Map()
  const ids = new Set()
  let count = 0
  for (const fact of iterable) {
    if (++count > 4096) throw new Error('policy-failed')
    const id = fact?.id
    if (!validString(id)) continue
    if (ids.has(id)) {
      facts.delete(id)
      continue
    }
    ids.add(id)
    if (typeof fact.main === 'boolean') facts.set(id, factPeople(fact.people, fact.main))
  }
  return facts
}

export function visibleBotIds(principal, provider, warn) {
  const visible = new Set()
  const role = roleOf(principal)
  if ((role === 'member' || role === 'guest') && provider &&
      validString(principal.person.issuer) && validString(principal.person.subject)) {
    try {
      const { issuer, subject } = principal.person
      for (const [id, { mode, allow }] of checkFacts(provider.bots())) {
        if ((mode === 'workspace' && role === 'member') ||
            (mode !== 'owners' && allow.some(person => person.issuer === issuer && person.subject === subject))) {
          visible.add(id)
        }
      }
    } catch {
      visible.clear()
      warn?.(provider)
    }
  }
  return Object.freeze(visible)
}
