export const STATE_ACTIVATIONS = 'stateActivations'
export const ACTIVATION_COMPARE = 'AUTOMAGIK_SUPERVISOR_ACTIVATION_COMPARE'

export const protectedStateFormat = format => format === 4 || format === 5

export function activationIds(value, { required = false } = {}) {
  if (!Array.isArray(value) || value.length < Number(required) || value.length > 256) return null
  const ids = new Set()
  for (const id of value) {
    // The grammar accepts ASCII only, so string length is the byte length of every accepted ID.
    if (typeof id !== 'string' || id.length < 1 || id.length > 64
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) return null
    ids.add(id)
  }
  return [...ids].sort()
}
