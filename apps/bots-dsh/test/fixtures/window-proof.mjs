// A proof of the desktop's own window, as the shared /api/omni-ui route makes one for a request
// that carries the window secret (desktop-window.js). Tests that call a window-only endpoint
// directly pass this; a plain `true` is refused.
import { createHash, randomBytes } from 'node:crypto'
import { windowProof } from '../../src/host/desktop-window.js'

export function aWindowProof() {
  const secret = randomBytes(32).toString('hex')
  const was = process.env.AUTOMAGIK_WINDOW_DIGEST
  process.env.AUTOMAGIK_WINDOW_DIGEST = createHash('sha256').update(secret, 'ascii').digest('hex')
  let proof
  try {
    proof = windowProof(new Request('http://localhost/api/omni-ui', { headers: { 'x-automagik-window': secret } }))
  } finally {
    if (was === undefined) delete process.env.AUTOMAGIK_WINDOW_DIGEST
    else process.env.AUTOMAGIK_WINDOW_DIGEST = was
  }
  if (proof === false) throw new Error('fixture: the window proof was not made')
  return proof
}
