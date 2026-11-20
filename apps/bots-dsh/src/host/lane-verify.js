import { createPublicKey, verify } from 'node:crypto'

/** The signed lane, verified over the original bytes. Only keyId is used before verification. */
export function verifyLane(bytes, signature, keys) {
  let original
  let lane
  try {
    original = Buffer.from(bytes)
    lane = JSON.parse(original.toString('utf8'))
  } catch {
    throw new Error('lane: lane.json is not JSON')
  }
  const key = keys.find(entry => entry.keyId === lane?.keyId)
  if (!key) throw new Error(`lane: no key ${lane?.keyId}`)
  let publicKey
  try { publicKey = createPublicKey(key.publicKey) } catch { throw new Error('lane: invalid signing public key') }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('lane: signing key must be Ed25519')
  let verified = false
  try { verified = verify(null, original, publicKey, Buffer.from(signature.trim(), 'base64')) } catch {}
  if (!verified) throw new Error('lane: the signature does not match')
  if (lane.schemaVersion !== 1) throw new Error(`lane: schema ${lane.schemaVersion}`)
  return lane
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function compareVersions(a, b) {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return Number.NaN
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return Math.sign(d)
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0
  const p = x[4].split('.')
  const q = y[4].split('.')
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue
    const pn = /^\d+$/.test(p[i])
    const qn = /^\d+$/.test(q[i])
    if (pn && qn) return Math.sign(Number(p[i]) - Number(q[i]))
    if (pn !== qn) return pn ? -1 : 1
    return p[i] < q[i] ? -1 : 1
  }
  return Math.sign(p.length - q.length)
}

/** Whether version meets every space-separated comparator in range. */
export function satisfies(version, range) {
  const parts = String(range ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return false
  return parts.every((part) => {
    const match = /^(>=|<=|>|<|=)?v?(.+)$/.exec(part)
    if (!match) return false
    const order = compareVersions(version, match[2])
    if (Number.isNaN(order)) return false
    return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[match[1] ?? '=']
  })
}
