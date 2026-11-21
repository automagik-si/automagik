import { STATUS_CODES } from 'node:http'
import { admitCaller } from './carrier.js'

// The adapter's private upgrade for a caller's /api/remote.mux. The gate signs `GET
// /api/remote.mux` and forwards only that exact path; nothing else is carried here.
export const MUX_PATH = '/_automagik/caller/api/remote.mux'
export const SOCKET_LIMITS = Object.freeze({ maxSocketsPerPerson: 4, maxSockets: 64 })

const personKey = principal => JSON.stringify([principal.instance, principal.person.issuer, principal.person.subject])

function refuse(socket, status) {
  const destroy = () => socket.destroy()
  const timer = setTimeout(destroy, 1000).unref()
  socket.once('close', () => clearTimeout(timer))
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, destroy)
}

/**
 * @param options.admission - admitCaller's options, shared with the HTTP carrier (one nonce store).
 * @param options.connection - DSH's connection service, which makes the caller's Peer.
 * @param options.mux - the activation's mux (createMux).
 */
export function createMuxCarrier({ admission, connection, registry, ready, mux, limits = SOCKET_LIMITS }) {
  const people = new Map()
  let total = 0
  return (req, socket, head) => {
    socket.on('error', () => { socket.destroy() })
    if (req.url !== MUX_PATH) return refuse(socket, 400)
    const binding = ready()
    if (!binding) return refuse(socket, 503)
    if (req.method !== 'GET' || req.headers['transfer-encoding'] !== undefined ||
        Number(req.headers['content-length']) > 0) return refuse(socket, 400)
    const admitted = admitCaller(req, admission)
    if (admitted.status) return refuse(socket, admitted.status)
    const { principal, session } = admitted
    // The caps count every socket from admission on, before the handshake.
    const key = personKey(principal)
    const held = people.get(key) ?? 0
    if (held >= limits.maxSocketsPerPerson) return refuse(socket, 429)
    if (total >= limits.maxSockets) return refuse(socket, 503)
    people.set(key, held + 1)
    total++
    let peer
    let released = false
    // One idempotent release owns the slot, the registry entry and the Peer.
    const release = () => {
      if (released) return
      released = true
      total--
      const left = people.get(key) - 1
      if (left > 0) people.set(key, left)
      else people.delete(key)
      if (peer !== undefined) {
        registry.remove(peer)
        peer.dispose().catch(() => {})
      }
    }
    try {
      peer = connection.createPeer({ principal, interactions: 'answer' })
      const control = { close: () => socket.destroy() }
      registry.add(peer, { principal, session, kind: 'socket', close: (code, reason) => control.close(code, reason) })
      if (ready() !== binding || !registry.live(peer)) {
        release()
        return refuse(socket, 503)
      }
      mux.handleUpgrade(req, socket, head, { peer, principal, session, control, binding }).then(release, release)
    } catch {
      release()
      socket.destroy()
    }
  }
}
