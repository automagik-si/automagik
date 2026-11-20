export const guid = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const isText = value => typeof value === 'string' && value.length > 0

// Count all fields with the same name, including types we don't expose.
export function itemFields(item) {
  const fields = new Map([
    ['login.username', item.login?.username],
    ['login.password', item.login?.password],
    ['notes', item.notes],
  ])
  const seen = new Set()
  for (const field of Array.isArray(item.fields) ? item.fields : []) {
    if (!isText(field?.name)) continue
    const selector = `field:${field.name}`
    if (seen.has(selector)) fields.delete(selector)
    else if (selector.length <= 512 && (field.type === 0 || field.type === 1)) fields.set(selector, field.value)
    seen.add(selector)
  }
  for (const [selector, value] of fields) if (!isText(value)) fields.delete(selector)
  return fields
}
