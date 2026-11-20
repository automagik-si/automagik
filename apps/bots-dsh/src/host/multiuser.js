export function multiuserMode(env = process.env) {
  const value = env.AUTOMAGIK_MULTIUSER
  return value !== undefined && value !== '' && value !== '0'
}

export function callerOf(ctx) {
  const service = ctx?.get?.('automagikCaller')
  return service?.version === 1 ? service.current() : undefined
}
