import { createHash, timingSafeEqual } from 'node:crypto'

/** DSH gets the digest, while Electron adds the secret only to its own page's requests. */
export function verifiedWindow(request, env = process.env) {
  const digest = env.AUTOMAGIK_WINDOW_DIGEST
  const secret = request.headers.get('x-automagik-window')
  if (!/^[0-9a-f]{64}$/.test(digest ?? '') || !/^[0-9a-f]{64}$/.test(secret ?? '')) return false
  return timingSafeEqual(createHash('sha256').update(secret, 'ascii').digest(), Buffer.from(digest, 'hex'))
}
