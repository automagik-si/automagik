// Every caller Peer the carrier holds: one per admitted HTTP request and one per carried socket.
// live() reads only this table, which changes synchronously; a Peer's own signal aborts only
// after cordis runs its effect cleanups, a few microtasks later.
export function createPeerRegistry({ epoch = () => 0 } = {}) {
  const entries = new Map()
  const pending = new Set()
  return {
    // `epoch` is the policy epoch the caller was admitted under; it defaults to the current one.
    add(peer, { principal, session, kind, close, epoch: admitted = epoch() }) {
      if (kind !== 'http' && kind !== 'socket') throw new Error('multiuser-dsh: invalid Peer kind')
      entries.set(peer, { peer, principal, session, kind, close, epoch: admitted, revoked: false })
    },
    remove(peer) {
      entries.delete(peer)
    },
    live(peer) {
      const entry = entries.get(peer)
      return entry !== undefined && !entry.revoked && entry.epoch === epoch()
    },
    get epoch() {
      return epoch()
    },
    closeSockets(code, reason) {
      for (const entry of Array.from(entries.values())) {
        if (entry.kind === 'socket') entry.close(code, reason)
      }
    },
    trackPending(cancel) {
      pending.add(cancel)
      return () => pending.delete(cancel)
    },
    // Mark every entry revoked first, so no check that runs while the closes unwind passes.
    revokeAll(reason) {
      const all = [...entries.values()]
      for (const entry of all) entry.revoked = true
      for (const cancel of pending) cancel()
      for (const entry of all) {
        try { entry.close(1011, reason) } catch {}
        entry.peer.dispose().catch(() => {})
      }
    },
    get size() {
      return entries.size
    },
  }
}
