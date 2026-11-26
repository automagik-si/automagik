export const RESERVED_COMMANDS_VERSION = 2
export const RESERVED_COMMAND_NAMES = Object.freeze([
  'side', 'btw', 'login', 'model', 'auth', 'setup', 'permission', 'feedback', 'compact',
  'clear', 'resume', 'restart', 'help', 'goal', 'plan', 'export', 'upload',
])

export function reservedCommandOf(value) {
  if (typeof value !== 'string') return undefined
  const name = value.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().replace(/^\/+/, '').trim().toLowerCase()
  return RESERVED_COMMAND_NAMES.includes(name) ? name : undefined
}
