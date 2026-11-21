export function multiuserMode(env = process.env) {
  const value = env.AUTOMAGIK_MULTIUSER
  return value !== undefined && value !== '' && value !== '0'
}

export function callerOf(ctx) {
  const service = ctx?.get?.('automagikCaller')
  return service?.version === 1 || service?.version === 2 ? service.current() : undefined
}

export function callerService(ctx) {
  const service = ctx?.get?.('automagikCaller')
  return service?.version === 2 && service.multiuser === true ? service : undefined
}

export const hasCallerLock = rt => rt.holdsLock() === true && rt.readOnly() === undefined

export function matchesFeedViewer(request, viewer) {
  return viewer !== undefined && new URL(request.url).search === `?viewer=${viewer.id}.${viewer.role}`
}
