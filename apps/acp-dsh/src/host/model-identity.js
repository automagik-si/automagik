// The built-in Claude Code connector's versioned Sonnet row has a separate wire value.
export const SONNET_PIN = 'claude-sonnet-5-5'
const SONNET_ALIAS = 'sonnet'

export function sonnetWire(rows) {
  const concrete = rows.filter(row => row.value === SONNET_PIN)
  const aliases = rows.filter(row => row.value === SONNET_ALIAS)
  if (concrete.length > 1 || aliases.length > 1) return undefined
  if (concrete.length === 1) return SONNET_PIN
  const row = aliases[0]
  if (row?.name !== 'Sonnet 5.5' || rows.some(other => other !== row && other.name === row.name)) return undefined
  return SONNET_ALIAS
}
