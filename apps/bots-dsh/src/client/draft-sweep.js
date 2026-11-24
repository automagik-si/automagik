// The composer state DSH keeps per Session in the page's storage
// (`dsh.conversation.<Session id>`, which the desktop copies to its drafts file) outlives
// a deleted Bot or group. The host lists the deleted Sessions (`draftSweep` in the owner's
// view, whichever route deleted them); this page removes their keys and names the ids it
// removed (`drafts-swept`), which takes them off the list.
const draftKey = id => `dsh.conversation.${id}`
const defaultStorage = () => { try { return globalThis.localStorage } catch { return null } }

// Every Session id a full view shows in use: Bots' chats and their parts, groups' own
// Sessions and their members' ones, and the DSH bots' Sessions. Such an id is never swept.
export function liveSessionIds(view) {
  const ids = new Set()
  const add = (id) => { if (typeof id === 'string' && id !== '') ids.add(id) }
  const addAll = (list) => { if (Array.isArray(list)) for (const id of list) add(id) }
  for (const bot of Array.isArray(view?.bots) ? view.bots : []) {
    add(bot?.id)
    add(bot?.sessionId)
    addAll(bot?.parts)
  }
  for (const room of Array.isArray(view?.rooms) ? view.rooms : []) {
    add(room?.id)
    add(room?.sessionId)
    addAll(room?.ownParts)
    addAll(room?.parts)
  }
  for (const agent of Array.isArray(view?.agents) ? view.agents : []) addAll(agent?.sessions)
  return ids
}

// `note` takes each full view's list and the ids it shows live; `run` removes the keys of
// the pending ids, except the Session open in the main view (DSH may write its key again
// while it is mounted), and names the ones whose key is really gone. An id stays pending
// until this page saw its key gone and the host took the name, so a chat that closes
// later is swept then, even when another window cleared the list first. A failed naming
// waits for the next view.
export function createDraftSweep({ storage = defaultStorage(), call, openSession = () => undefined }) {
  const pending = new Set()
  const naming = new Set()
  let waiting = false
  const note = (list, live) => {
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string' && id !== '') pending.add(id)
    if (live !== undefined) for (const id of live) pending.delete(id)
    waiting = false
  }
  const run = async () => {
    if (storage == null || waiting || pending.size === 0) return
    let open
    try { open = openSession() } catch { return }
    const swept = []
    for (const id of pending) {
      if (naming.has(id) || id === open) continue
      try { storage.removeItem(draftKey(id)) } catch { /* storage unavailable */ }
      let gone = false
      try { gone = storage.getItem(draftKey(id)) === null } catch { /* storage unavailable */ }
      if (gone) swept.push(id)
    }
    if (swept.length === 0) return
    for (const id of swept) naming.add(id)
    try {
      await call('drafts-swept', { ids: swept })
      for (const id of swept) pending.delete(id)
    } catch {
      waiting = true
    } finally {
      for (const id of swept) naming.delete(id)
    }
  }
  return { note, run }
}
