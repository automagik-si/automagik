// The Code side's flip (RFC 0030 delivery 1): the state the view's Chat / Terminal switch and
// the conversation body share, and the lazy seam to the renderer.
//
// Nothing of the renderer loads at app start: this module carries only the switch's state, the
// tree read (on a press) and the registration that swaps the body while Terminal is chosen.
// The pane, the tree's rows, xterm.js and their stylesheets live in `client.pane.js`, a
// package-local client chunk the DSH module loader fetches the first time the body renders
// (`loadPane` below). Opening Chat alone fetches neither the chunk nor the team tree.
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { FaceSwitch } from './left-bar-faces.js'
import { botRowOf, codeHasPane, paneFor, statusKey, stillThere } from './code-side-model.js'
import { PANE_CHUNK, loadPane } from './code-side-lazy.js'

const NO_STATE = { face: 'chat', botId: null, tree: null, loading: false, error: null, selected: null, loadedAt: 0 }

// One store for the window, as the rest of the team's client uses.
const listeners = new Set()
let state = NO_STATE
const set = (patch) => {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
const snapshot = () => state
const storeSubscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }

/** How long a tree read stands before Terminal is pressed again. */
export const TREE_FRESH_MS = 20_000
let reading = null

/** Re-read the team tree; one read at a time. Resolves the store's tree (or null). */
export async function loadTree({ fresh = false } = {}) {
  if (!fresh && state.tree && Date.now() - state.loadedAt < TREE_FRESH_MS) return state.tree
  if (reading) return reading
  set({ loading: true, error: null })
  reading = Promise.resolve()
    .then(() => call('code-tree'))
    .then((tree) => {
      set({ tree: tree ?? null, loading: false, error: null, loadedAt: Date.now(), selected: stillThere(state.selected, tree) })
      return tree
    }, (error) => {
      set({ loading: false, error: error?.code ?? 'unavailable', tree: null, loadedAt: Date.now() })
      return null
    })
    .finally(() => { reading = null })
  return reading
}

/** Flip the view to the open Bot's terminal; the tree is read now, not before. */
export async function openTerminal(botId) {
  set({ face: 'terminal', botId, selected: state.selected?.botId === botId ? state.selected : null })
  const tree = await loadTree({ fresh: true })
  if (!tree || state.botId !== botId || state.face !== 'terminal') return
  const pane = paneFor(tree, botId)
  if (pane) set({ selected: pane })
}

/** Flip the view back to the chat; the terminal stream closes with the pane. */
export function closeTerminal() {
  set({ face: 'chat', botId: null, selected: null })
}

/** Choose one tree row's pane (or clear it), without leaving the Code face. */
export function selectPane(selected) { set({ selected }) }

/** The flip's state for one Bot, as the chat header's Chat / Terminal switch takes it. */
export function useCodeFace(botId) {
  const current = useSyncExternalStore(storeSubscribe, snapshot, snapshot)
  return {
    face: current.face === 'terminal' && current.botId === botId ? 'terminal' : 'chat',
    // Whether a Bot has a pane is the renderer's own answer, read when Terminal is pressed:
    // the switch never fetches the tree or the chunk on its own.
    onFace: (face) => { if (face === 'terminal') void openTerminal(botId); else closeTerminal() },
  }
}

/** The open Bot's switch, wired to the flip: the view's entry to Code mode. */
export function BotFaceSwitch({ bot }) {
  const code = useCodeFace(bot?.id)
  return h(FaceSwitch, { face: code.face, onFace: code.onFace })
}

/** The body registered for the conversation while the face is terminal; it loads the chunk once. */
function CodeBody() {
  const [pane, setPane] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    loadPane().then((module) => { if (live) setPane(module) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])
  if (pane) return h(pane.CodeBody, { code: codeApi })
  return failed ? h('div', { className: 'cs-host' }, h('p', { className: 'cs-empty' }, t('The Code side could not load here.'))) : null
}

/** The Session the window shows: the one the shell keeps as its main view. */
export function mainViewId(sessions) {
  const list = sessions?.list?.getSnapshot?.()
  return Object.values(list?.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null
}

/** The store surface the chunk's body takes, so the chunk never imports a second store copy. */
const codeApi = { subscribe: storeSubscribe, snapshot, loadTree, selectPane }

/**
 * Install the flip on a running team: the body's shadow while the face is terminal, and the
 * view watch that takes it down when the window moves to any other view.
 */
export function installCodeSide(ctx) {
  let off = null
  let openedFor = null
  let listOff = null
  const watchView = () => {
    if (listOff) { listOff(); listOff = null }
    openedFor = mainViewId(ctx.sessions)
    listOff = ctx.sessions?.list?.subscribe?.(() => {
      if (state.face !== 'terminal' || openedFor === null) return
      if (mainViewId(ctx.sessions) !== openedFor) closeTerminal()
    }) ?? null
  }
  const sync = () => {
    const wanted = state.face === 'terminal'
    if (wanted && !off) {
      watchView()
      off = ctx.slots.inject('conversation.session', () => ctx.slots.register({ name: 'conversation.session', priority: -100 }, CodeBody))
    } else if (!wanted && off) {
      off()
      off = null
      listOff?.()
      listOff = null
      openedFor = null
    }
  }
  const unsubscribe = storeSubscribe(sync)
  sync()
  return () => {
    unsubscribe()
    listOff?.()
    listOff = null
    off?.()
    off = null
    if (state.face === 'terminal') set({ face: 'chat', botId: null, selected: null })
  }
}

/** The flip's store, for the plugin and its tests. */
export const codeStore = { subscribe: storeSubscribe, snapshot, loadTree, openTerminal, closeTerminal, selectPane, reset: () => set({ ...NO_STATE }) }
export { codeHasPane, botRowOf, paneFor, statusKey, stillThere, PANE_CHUNK, loadPane }
