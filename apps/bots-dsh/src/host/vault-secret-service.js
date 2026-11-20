export const GNOME_PROVIDER_ID = 'secret-service'
export const gnomeLinuxOnly = 'Secret Service is available only on Linux.'
export const gnomeNotInCloud = 'Secret Service is unavailable in Automagik Cloud.'
export const gnomeUnsupportedOwner = 'Only GNOME Keyring is supported in this version.'
export const gnomeItemChanged = 'This Secret Service item changed or is missing. Map it again.'
export const gnomeItemLocked = 'The GNOME Keyring collection or item is locked.'
export const gnomeBusUnavailable = 'The GNOME Keyring session bus or service is unavailable.'

export const secretServiceHandle = handle => typeof handle === 'string' && /^[a-f0-9]{32}$/.test(handle)
export const secretServiceCreated = created => typeof created === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(created)
  && BigInt(created) <= 0xffffffffffffffffn

export function secretServiceItem(item) {
  if (typeof item !== 'string' || item.length > 512) return
  try {
    const parts = JSON.parse(item)
    if (!Array.isArray(parts) || parts.length !== 3 || JSON.stringify(parts) !== item) return
    const [path, created, digest] = parts
    if (typeof path === 'string' && /^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/.test(path)
      && secretServiceCreated(created) && typeof digest === 'string' && /^[a-f0-9]{32}$/.test(digest)) return parts
  } catch {}
}

export function secretServiceRows(rows) {
  const result = []
  for (const row of rows.slice(0, 200)) {
    if (typeof row?.collection !== 'string') continue
    const { handle, name, collection, field, locked, created } = row
    if (locked === true) result.push({ collection, locked })
    else if (secretServiceHandle(handle) && typeof name === 'string' && field === 'secret') {
      result.push({ handle, name, collection, field, ...(secretServiceCreated(created) ? { created } : {}) })
    }
  }
  return result
}

export function secretServiceMessage(code, fallback) {
  switch (code) {
    case 'platform': return gnomeLinuxOnly
    case 'cloud': return gnomeNotInCloud
    case 'unsupported': return gnomeUnsupportedOwner
    case 'revoked': return gnomeItemChanged
    case 'locked': return gnomeItemLocked
    case 'unavailable': return gnomeBusUnavailable
    default: return fallback
  }
}
