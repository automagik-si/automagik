// The built-in Claude Code connector can offer a versioned model under an alias.
export const CLAUDE_PINS = Object.freeze([
  Object.freeze({ alias: 'sonnet', name: 'Sonnet 5.5', id: 'claude-sonnet-5-5', family: 'Sonnet' }),
  Object.freeze({ alias: 'opus', name: 'Opus 5.5', id: 'claude-opus-5-5', family: 'Opus' }),
  Object.freeze({ alias: 'fable', name: 'Fable 5.2', id: 'claude-fable-5-2', family: 'Fable' }),
  Object.freeze({ alias: 'haiku', name: 'Haiku 5.5', id: 'claude-haiku-5-5', family: 'Haiku' }),
])

export const pinOf = model => CLAUDE_PINS.find(pin => model === pin.alias || model === pin.id)

export function pinWire(rows, pin) {
  const concrete = rows.filter(row => row.value === pin.id)
  const aliases = rows.filter(row => row.value === pin.alias)
  if (concrete.length > 1 || aliases.length > 1) return undefined
  if (concrete.length === 1) return pin.id
  const row = aliases[0]
  if (row?.name !== pin.name || rows.some(other => other !== row && other.name === row.name)) return undefined
  return pin.alias
}

const sonnet = pinOf('sonnet')
export const SONNET_PIN = sonnet.id
export const sonnetWire = rows => pinWire(rows, sonnet)
