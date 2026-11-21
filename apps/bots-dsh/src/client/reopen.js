// The chat on screen, kept across a restart of DSH alone. The Automagik desktop app restarts DSH
// without closing the window to put plugin updates in (apps/desktop src/auto-apply.js), and the
// page loads again on the same origin. The open chat is not in DSH's URL, and a cold start lands
// on the Main Bot, so this tab keeps the chat it shows in sessionStorage (this tab and origin
// only), and the app asks for it back by setting REOPEN just before it restarts DSH. A reload
// nobody asked for, or a new window, lands where it always did. Drafts need nothing here: DSH
// keeps them in localStorage, per origin.

export const OPEN_CHAT = 'omni-ui:open-chat'
export const REOPEN = 'omni-ui:reopen'
const UPDATE_REOPEN = 'omni-ui:update-reopen'

const storageOf = () => { try { return globalThis.sessionStorage ?? null } catch { return null } }

/** Note the chat on screen (a Session id), or forget it. */
export function rememberOpen(id, storage = storageOf()) {
  try {
    if (storage?.getItem(UPDATE_REOPEN) === '1' && storage.getItem(REOPEN) === '1') return
    if (typeof id === 'string' && id !== '') storage?.setItem(OPEN_CHAT, id)
    else storage?.removeItem(OPEN_CHAT)
  } catch {}
}

// Also set the shared marker so a page restored to an older client can reopen the chat.
export function armUpdateReopen(id, storage = storageOf()) {
  try {
    if (typeof id !== 'string' || id === '' || storage?.getItem(REOPEN) === '1') return
    rememberOpen(id, storage)
    storage?.setItem(UPDATE_REOPEN, '1')
    storage?.setItem(REOPEN, '1')
  } catch {}
}

export function endUpdateReopen(restore, storage = storageOf()) {
  try {
    if (storage?.getItem(UPDATE_REOPEN) !== '1') return null
    const id = takeReopen(storage)
    return restore ? id : null
  } catch { return null }
}

/** The chat to reopen, once, when the app asked for it; else null. */
export function takeReopen(storage = storageOf()) {
  try {
    storage?.removeItem(UPDATE_REOPEN)
    if (storage?.getItem(REOPEN) !== '1') return null
    storage.removeItem(REOPEN)
    const id = storage.getItem(OPEN_CHAT)
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

const isTeamChat = (snapshot, id) => snapshot.byId?.[id] !== undefined || snapshot.roomsById?.[id] !== undefined
  || snapshot.tasks?.[id] !== undefined

// On entering Bot mode, an outside Session gives way to the Main Bot.
export function ensureBotHome({ roster, mainView, openSession }) {
  const home = snapshot => {
    const main = mainView()
    if (snapshot.mainBotId && main !== undefined && !isTeamChat(snapshot, main)) openSession(snapshot.mainBotId)
  }
  const snapshot = roster.getSnapshot()
  if (snapshot.ready) home(snapshot)
  else {
    const off = roster.subscribe(() => {
      const ready = roster.getSnapshot()
      if (!ready.ready) return
      off()
      home(ready)
    })
  }
}

export function watchChatReopen({ roster, sessions, mainView, isAgentSession, openSession, storage = storageOf() }) {
  let pending = null
  const note = () => { if (pending === null) rememberOpen(mainView(), storage) }
  const reopen = () => {
    const snapshot = roster.getSnapshot()
    if (pending === null || !snapshot.ready) return
    const id = pending
    pending = null
    if (isAgentSession(id) || isTeamChat(snapshot, id)) {
      if (mainView() !== id) openSession(id)
    }
    note()
  }
  const setPending = id => { pending = id; reopen() }
  const offList = sessions.subscribe(note)
  const offRoster = roster.subscribe(reopen)
  setPending(takeReopen(storage))
  note()
  return {
    setPending,
    getPending: () => pending,
    dispose() { offList(); offRoster() },
  }
}
