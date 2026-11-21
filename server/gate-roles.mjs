const ROLES = new Set(['owner', 'admin', 'member', 'guest'])
export const CALLER_HTTP = new Set(['POST /api/omni-ui', 'GET /api/omni-ui/feed'])
export const CALLER_UPGRADE = 'GET /api/remote.mux'
export const CLEAR_SITE_DATA = '"cache", "storage"'
const VIEWER_FEED = /^GET \/api\/omni-ui\/feed\?viewer=[\w-]{1,64}\.(?:owner|admin|member|guest)$/

export function effectiveRole(roles) {
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > ROLES.size ||
      new Set(roles).size !== roles.length || !Array.from(roles).every(role => ROLES.has(role))) return
  if (roles.includes('owner') || roles.includes('admin')) return 'owner'
  return roles.includes('member') ? 'member' : 'guest'
}

export function ownerFamily(family, multiuser) {
  const roles = family.principal.roles
  if (multiuser) return effectiveRole(roles) === 'owner'
  return roles.some(role => role === 'owner' || role === 'admin')
}

export function callerTarget({ role, method, raw, upgrade, origin }) {
  const refused = { allow: false, status: 403 }
  if (role !== 'member' && role !== 'guest') return refused
  const pair = method + ' ' + raw
  if (upgrade) return pair === CALLER_UPGRADE ? { allow: true } : refused
  if (CALLER_HTTP.has(pair) || VIEWER_FEED.test(pair)) return { allow: true }
  try {
    const { pathname } = new URL(raw, origin)
    const decoded = decodeURIComponent(raw.split('?', 1)[0].toLowerCase()).toLowerCase()
    if (/^\/api(?:\/|$)/.test(pathname) || /^\/api(?:[/?]|$)/.test(decoded)) return refused
  } catch {
    return refused
  }
  return { allow: true }
}
