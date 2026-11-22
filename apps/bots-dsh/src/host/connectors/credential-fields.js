import { CONNECTOR_SECRET_REF } from './catalog.js'

// Parts alternate literal text with complete Secrets references. The forms are
// the spellings of each credential that can appear in output.
export function credentialParts(kind, name, value) {
  if (typeof value !== 'string' || value.length < 8 || !/key|token|secret|password|auth|bearer|cookie/i.test(name)) return []
  const parts = value.split(CONNECTOR_SECRET_REF)
  return parts.map((part, index) => {
    if (index % 2 === 1) return { text: `$DSH_SECRET_${part}`, reference: true }
    const literal = parts.length === 1 ? part : part.trim()
    const normalized = kind === 'headers' ? literal.trim() : literal
    const token = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(normalized)?.[1]
    const candidate = token ?? normalized
    if (/\s/.test(candidate) || !(candidate.length >= 16
      || (candidate.length >= 8 && /\p{L}/u.test(candidate) && /[\p{N}\p{P}\p{S}]/u.test(candidate)))) return { text: part }
    return { text: part, forms: new Set([literal, normalized, token].filter(form => form !== undefined)) }
  })
}

export function* credentialFields(connectors) {
  for (const [id, row] of Object.entries(connectors ?? {})) {
    for (const kind of ['headers', 'env']) {
      const fields = row?.custom?.[kind]
      if (fields === null || typeof fields !== 'object') continue
      for (const [name, value] of Object.entries(fields)) yield { id, kind, fields, name, value }
    }
  }
}
