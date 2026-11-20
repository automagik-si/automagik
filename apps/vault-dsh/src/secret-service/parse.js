import { createHash } from 'node:crypto'

export const provider = 'secret-service'
export const root = '/org/freedesktop/secrets'
export const collectionRoot = root + '/collection/'
const collectionPattern = /^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+$/
const itemPattern = /^\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+$/
export const collectionPath = path => typeof path === 'string' && collectionPattern.test(path)
export const itemPath = path => typeof path === 'string' && itemPattern.test(path)
export const collectionOf = path => path.slice(0, path.lastIndexOf('/'))
export const validHandle = handle => typeof handle === 'string' && /^[a-f0-9]{32}$/.test(handle)

export function itemParts(item) {
  if (typeof item !== 'string' || item.length > 512) return
  try {
    const parts = JSON.parse(item)
    if (!Array.isArray(parts) || parts.length !== 3 || JSON.stringify(parts) !== item) return
    const [path, created, attrs] = parts
    if (itemPath(path) && typeof created === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(created)
      && BigInt(created) <= 0xffffffffffffffffn && typeof attrs === 'string' && /^[a-f0-9]{32}$/.test(attrs)) return parts
  } catch {}
}

export function attributeDigest(attributes) {
  const sorted = [...attributes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (sorted.some(([name], index) => index > 0 && sorted[index - 1][0] === name)) return
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32)
}
