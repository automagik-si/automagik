// The Code side's flip (RFC 0030 delivery 1): the seat's Chat / Terminal face, the bar's
// independent Team / Code list, and the lazy seam to the renderer.
//
// Nothing of the renderer loads at app start: this module carries only the switch's state, the
// tree read (on a press) and the registration that swaps the body while Terminal is chosen.
// The pane, the tree's rows, xterm.js and their stylesheets live in `client.pane.js`, a
// package-local client chunk the DSH module loader fetches after the tree read permits the
// pane (`loadPane` below). Opening Chat alone fetches neither the chunk nor the team tree.
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { FaceSwitch, TwoPartSwitch } from './left-bar-faces.js'
import { botRowOf, codeHasPane, paneFor, prunePanes, statusKey, stillThere, togglePane } from './code-side-model.js'
import { PANE_CHUNK, loadPane } from './code-side-lazy.js'

export const CODE_PANEL = 'automagik-code'

const NO_STATE = {
  side: 'team', face: 'chat', botId: null, seat: false, tree: null, loading: false, error: null, loadedAt: 0,
  selected: null, beside: [], refused: null, barSelected: null, barBeside: [], barRefused: null,
}

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

const panesOf = (selected, beside) => [selected, ...beside].filter(Boolean)
const seatPanes = (list, refused = null) => ({ selected: list[0] ?? null, beside: list.slice(1), refused })
const barPanes = (list, refused = null) => ({ barSelected: list[0] ?? null, barBeside: list.slice(1), barRefused: refused })
const prune = (tree) => {
  const seat = prunePanes(panesOf(state.selected, state.beside), tree)
  const bar = prunePanes(panesOf(state.barSelected, state.barBeside), tree)
  return {
    ...seatPanes(seat, seat.length === 1 + state.beside.length ? state.refused : null),
    ...barPanes(bar, bar.length === 1 + state.barBeside.length ? state.barRefused : null),
  }
}

/** Re-read the team tree; one read at a time. Resolves the store's tree (or null). */
export async function loadTree({ fresh = false } = {}) {
  if (!fresh && state.tree && Date.now() - state.loadedAt < TREE_FRESH_MS) return state.tree
  if (reading) return reading
  set({ loading: true, error: null })
  reading = Promise.resolve()
    .then(() => call('code-tree'))
    .then((tree) => {
      set({ tree: tree ?? null, loading: false, error: null, loadedAt: Date.now(), ...prune(tree) })
      return tree
    }, (error) => {
      set({ loading: false, error: error?.code ?? 'unavailable', tree: null, loadedAt: Date.now(), ...prune(null) })
      return null
    })
    .finally(() => { reading = null })
  return reading
}

/**
 * Flip the view to the open Bot's terminal; the tree is read now, not before.
 *
 * `seat` says the face belongs to a seat panel, not a conversation header. It is the same store
 * and the same pane: the seat renders the Code body itself, so the conversation body is not
 * registered underneath it.
 */
export async function openTerminal(botId, { seat = false } = {}) {
  set({ face: 'terminal', botId, seat, ...(state.selected?.botId === botId ? {} : seatPanes([])) })
  const tree = await loadTree({ fresh: true })
  if (!tree || state.botId !== botId || state.face !== 'terminal' || state.seat !== seat) return
  const pane = paneFor(tree, botId)
  if (pane) selectPane(pane)
}

/** Flip the view back to the chat; the terminal stream closes with the pane. */
export function closeTerminal() {
  set({ face: 'chat', botId: null, seat: false, ...seatPanes([]) })
}

/** Choose one tree row's pane (or clear it), without leaving the Code face. */
export function selectPane(selected, { beside = false } = {}) {
  if (!beside) { set(seatPanes([selected])); return }
  const previous = panesOf(state.selected, state.beside)
  const { list, refused } = togglePane(previous, selected, state.tree)
  if (list !== previous || refused) set(seatPanes(list, refused))
}

/** The flip's state for one Bot, as the chat header's or the seat's Chat / Terminal switch takes it. */
export function useCodeFace(botId, { seat = false } = {}) {
  const current = useSyncExternalStore(storeSubscribe, snapshot, snapshot)
  return {
    face: current.face === 'terminal' && current.botId === botId && current.seat === seat ? 'terminal' : 'chat',
    // Whether a Bot has a pane is the renderer's own answer, read when Terminal is pressed:
    // the switch never fetches the tree or the chunk on its own.
    onFace: (face) => { if (face === 'terminal') void openTerminal(botId, { seat }); else closeTerminal() },
  }
}

/** The open Bot's switch, wired to the flip: the view's entry to Code mode. */
export function BotFaceSwitch({ bot }) {
  const code = useCodeFace(bot?.id, { seat: true })
  return bot?.seat === true ? h(FaceSwitch, { face: code.face, onFace: code.onFace }) : null
}

export function useCodeSide() {
  return useSyncExternalStore(storeSubscribe, snapshot, snapshot)
}

export function setCodeSide(side) {
  set({ side, ...(side === 'team' ? barPanes([]) : {}) })
  if (side === 'code') void loadTree({ fresh: true })
}

export function CodeSideSwitch({ current, onSelect }) {
  const needs = (current.tree?.projects ?? []).reduce((count, project) => count + project.bots.reduce(
    (sum, bot) => sum + Number(bot.status === 'needs-you') + bot.workers.filter(worker => worker.status === 'needs-you').length, 0,
  ), 0)
  const badge = needs > 0 ? h('span', { className: 'lb-count', title: t('Needs you') }, needs > 99 ? '99+' : String(needs)) : null
  return h(TwoPartSwitch, {
    current: current.side, onSelect, label: t('Team or Code'),
    parts: [{ name: 'team', content: [t('Team')] }, { name: 'code', content: [t('Code'), badge] }],
  })
}

/** A root panel overlays the retained Session or seat panel, with its own terminal selection. */
export function codePanelNavigation(layout) {
  let previous = null
  const active = () => layout.panelInfo.getSnapshot().activePanelId
  return {
    open(selected, { beside = false } = {}) {
      let next = barPanes([selected])
      if (beside) {
        const previous = panesOf(state.barSelected, state.barBeside)
        const { list, refused } = togglePane(previous, selected, state.tree)
        if (list === previous && !refused) return
        next = barPanes(list, refused)
      }
      if (active() !== CODE_PANEL) {
        previous = active()
        layout.selectPanel(CODE_PANEL)
      }
      set(next)
    },
    close() {
      if (active() === CODE_PANEL) {
        try { layout.selectPanel(previous) } catch { layout.selectPanel(null) }
      }
      set(barPanes([]))
    },
  }
}


/**
 * The body of the Terminal face, for a conversation (registered below) and for a seat's panel
 * (rendered by seat-chat.js): it loads the chunk once and draws the pane the flip selected.
 */
export function CodeBody() {
  const current = useCodeSide()
  return h(CodeRenderer, { current, render: pane => h(pane.CodeBody, { code: codeApi }) })
}

export function CodeBarList({ current, onSelect }) {
  return h(CodeRenderer, {
    current, showLoading: true,
    render: pane => h(pane.CodeTree, { current: { ...current, selected: current.barSelected, beside: current.barBeside }, onSelect, sidebar: true }),
  })
}

export function CodeMainPanel({ onBack }) {
  const current = useCodeSide()
  return h('div', { className: 'bt-seat', 'data-code-panel': '' },
    h('header', { className: 'bt-seat-head' },
      h('button', { type: 'button', className: 'bt-seat-back', 'aria-label': t('Back'), title: t('Back'), onClick: onBack }, '←')),
    h('div', { className: 'bt-seat-body' },
      h(CodeRenderer, { current, render: pane => h('section', { className: 'cs-host' },
        h(pane.CodeTerminal, { tree: current.tree, selected: current.barSelected, beside: current.barBeside, refused: current.barRefused, loading: current.loading })) })))
}

function CodeRenderer({ current, render, showLoading }) {
  const desktopOnly = current.tree?.reason === 'desktop-only'
  const shouldLoadPane = current.loadedAt !== 0 && !desktopOnly
  const [pane, setPane] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!shouldLoadPane) return
    let live = true
    loadPane().then((module) => { if (live) setPane(module) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [shouldLoadPane])
  if (desktopOnly) return h('div', { className: 'cs-host' }, h('p', { className: 'cs-empty' }, t('Terminals show in the Automagik desktop app.')))
  if (shouldLoadPane && pane) return render(pane)
  if (failed) return h('div', { className: 'cs-host' }, h('p', { className: 'cs-empty' }, t('The Code side could not load here.')))
  return showLoading ? h('p', { className: 'bt-hint', role: 'status' }, t('Reading this computer’s team…')) : null
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
    // A seat panel draws the body itself; only a conversation takes the slot body.
    const wanted = state.face === 'terminal' && !state.seat
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
    if (state.face === 'terminal') closeTerminal()
  }
}

/** The flip's store, for the plugin and its tests. */
export const codeStore = { subscribe: storeSubscribe, snapshot, loadTree, openTerminal, closeTerminal, selectPane, reset: () => set({ ...NO_STATE }) }
export { codeHasPane, botRowOf, paneFor, statusKey, stillThere, PANE_CHUNK, loadPane }
