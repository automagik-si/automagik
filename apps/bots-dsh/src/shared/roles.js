export const BUILTIN_ROLES = Object.freeze({
  genie: Object.freeze({ id: 'genie', name: 'Genie', kind: 'genie', tools: Object.freeze(['grant_wish']),
    botChildren: Object.freeze(['genie-wishes']), suggestions: Object.freeze(['genie']) }),
})

export const GENIE_ATTACH_REFUSAL = 'Genie can be given to another Bot after the next Genie update.'
export const ROLES_OFF_REASON = 'roles-off'
export const rolesOn = prefs => prefs?.roles !== false

export const RESERVED_ROLE_IDS = Object.freeze(['data'])
export const isWindowsReservedName = name => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
export const isRoleId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,40}$/.test(id)
  && !RESERVED_ROLE_IDS.includes(id) && !isWindowsReservedName(id)
export const isRoleVersion = version => typeof version === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(version)
export const isPackageRoleId = id => isRoleId(id) && !Object.hasOwn(BUILTIN_ROLES, id)
export const ROLE_SOURCE_UNCONFIRMED = "This role's source cannot be confirmed right now."
export const CHOOSE_NONE_FIRST = 'Choose None first.'
export const detachRoleFirst = name => `Detach ${name} first.`

export function attachedRoleIds(bot) {
  if (!Object.hasOwn(bot ?? {}, 'roles') || !Array.isArray(bot.roles)) return []
  return bot.roles.flatMap(entry => typeof entry?.id === 'string' && Object.hasOwn(entry, 'id') ? [entry.id] : [])
}

const ownPackageId = entry => Object.hasOwn(entry ?? {}, 'id') && isPackageRoleId(entry.id)
const singlePackageRole = bot => Object.hasOwn(bot ?? {}, 'roles') && Array.isArray(bot.roles)
  && bot.roles.length === 1 && ownPackageId(bot.roles[0]) ? bot.roles[0] : undefined

export function packageAttachment(bot) {
  const entry = singlePackageRole(bot)
  if (entry && ['version', 'attachedAt', 'grants'].every(key => Object.hasOwn(entry, key))
    && isRoleVersion(entry.version) && typeof entry.attachedAt === 'string' && Array.isArray(entry.grants)) {
    return { id: entry.id, version: entry.version, attachedAt: entry.attachedAt }
  }
}

export const sameRolePin = (a, b) => Boolean(a && b && a.id === b.id && a.version === b.version && a.attachedAt === b.attachedAt)

export const packageRecoveryId = bot => singlePackageRole(bot)?.id

export function attachmentStatus(attachment, records) {
  if (!Object.hasOwn(records ?? {}, attachment.id)) return 'missing'
  const record = records[attachment.id]
  if (record.version !== undefined && record.version !== attachment.version) return 'version-mismatch'
  return record.status
}

// A pin can use catalog declarations only when the installed archive digest matches.
export function packageDeclarations({ id, version }, roster) {
  const details = Object.hasOwn(roster?.roleDetails ?? {}, id) ? roster.roleDetails[id] : undefined
  const { installed, catalog } = details ?? {}
  if (installed?.version !== version || !installed.sha256) return undefined
  if (installed.verified) return installed
  if (catalog?.version !== version || catalog.sha256 !== installed.sha256) return undefined
  const row = roster.roleCatalog?.roles?.find(role => role.id === id && role.version === version)
  if (row) return { ...catalog, name: row.name, capabilities: row.capabilities, fromCatalog: true }
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

export function roleTagOf(bot, prefs, roster, localize = name => name) {
  if (!rolesOn(prefs)) return undefined
  const builtIn = BUILTIN_ROLES[effectiveRoleIds(bot, prefs)[0]]
  if (builtIn) return localize(builtIn.name)
  const pin = packageAttachment(bot)
  if (pin) return packageDeclarations(pin, roster)?.name ?? pin.id
}

export function roleOutletVisible(outlet, id, bot, roster) {
  if (!roster || !rolesOn(roster.prefs)) return true
  const owner = Object.values(BUILTIN_ROLES).find(role => role[outlet].includes(id))
  return owner === undefined || effectiveRoleIds(bot, roster.prefs).includes(owner.id)
}
