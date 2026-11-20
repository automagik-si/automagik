export const BUILTIN_ROLES = Object.freeze({
  genie: Object.freeze({ id: 'genie', name: 'Genie', kind: 'genie', tools: Object.freeze(['grant_wish']),
    botChildren: Object.freeze(['genie-wishes']), suggestions: Object.freeze(['genie']) }),
})

export const GENIE_ATTACH_REFUSAL = 'Genie can be given to another Bot after the next Genie update.'
export const rolesOn = prefs => prefs?.roles !== false

export const RESERVED_ROLE_IDS = Object.freeze(['data'])
export const isWindowsReservedName = name => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
export const isRoleId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(id)
  && !RESERVED_ROLE_IDS.includes(id) && !isWindowsReservedName(id)
export const isRoleVersion = version => typeof version === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)

export function attachedRoleIds(bot) {
  if (!Object.hasOwn(bot ?? {}, 'roles') || !Array.isArray(bot.roles)) return []
  return bot.roles.flatMap(entry => typeof entry?.id === 'string' && Object.hasOwn(entry, 'id') ? [entry.id] : [])
}

const isAttachment = entry => typeof entry?.id === 'string' && Object.hasOwn(BUILTIN_ROLES, entry.id)
  && typeof entry.version === 'string' && entry.version.length > 0
  && typeof entry.attachedAt === 'string' && Array.isArray(entry.grants)

export const storedRoles = (bot) => {
  if (!Object.hasOwn(bot ?? {}, 'roles')) return undefined
  const entry = Array.isArray(bot.roles) ? bot.roles.find(isAttachment) : undefined
  return entry === undefined ? [] : [entry]
}

// A Bot with no own record still takes its built-in role from its kind.
export function effectiveRoleIds(bot, prefs) {
  const stored = rolesOn(prefs) ? storedRoles(bot) : undefined
  return stored?.map(entry => entry.id) ?? (bot?.kind === 'genie' ? ['genie'] : [])
}

export const genieDetached = (bot, prefs) => bot?.kind === 'genie' && rolesOn(prefs)
  && !effectiveRoleIds(bot, prefs).includes('genie')

export const roleTagOf = (bot, prefs) => rolesOn(prefs) ? BUILTIN_ROLES[effectiveRoleIds(bot, prefs)[0]]?.name : undefined

export function roleOutletVisible(outlet, id, bot, roster) {
  if (!roster || !rolesOn(roster.prefs)) return true
  const owner = Object.values(BUILTIN_ROLES).find(role => role[outlet].includes(id))
  return owner === undefined || effectiveRoleIds(bot, roster.prefs).includes(owner.id)
}
