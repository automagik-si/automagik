import { createHash, timingSafeEqual } from 'node:crypto'

/** DSH gets the digest, while Electron adds the secret only to its own page's requests. */
export function verifiedWindow(request, env = process.env) {
  const digest = env.AUTOMAGIK_WINDOW_DIGEST
  const secret = request.headers.get('x-automagik-window')
  if (!/^[0-9a-f]{64}$/.test(digest ?? '') || !/^[0-9a-f]{64}$/.test(secret ?? '')) return false
  return timingSafeEqual(createHash('sha256').update(secret, 'ascii').digest(), Buffer.from(digest, 'hex'))
}

// What the shared /api/omni-ui route hands a window-only endpoint for a request from the desktop's
// own window. A plain `true` could be passed by anyone holding the endpoint: the team runtime is a
// service other plugins read (`omniTeam`, index.js), and its endpoint table hands out each
// endpoint's function (extend.js `endpointOf`). Only this module makes a proof, once per verified
// request; the route revokes it when the request ends, and hands it only to endpoints the team
// registered as window-only (extend.js `windowEndpoint`), never to another plugin's endpoint.
const proofs = new WeakSet()
export function windowProof(request, env = process.env) {
  if (!verifiedWindow(request, env)) return false
  const proof = Object.freeze({})
  proofs.add(proof)
  return proof
}
export const revokeWindowProof = (proof) => { if (typeof proof === 'object' && proof !== null) proofs.delete(proof) }
export const fromWindow = proof => typeof proof === 'object' && proof !== null && proofs.has(proof)
