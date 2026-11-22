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
import { isRetired } from './viewer.js'
import { t } from './i18n.js'
import { FaceSwitch, TwoPartSwitch } from './left-bar-faces.js'
import { botRowOf, codeHasPane, paneFor, prunePanes, seatPaneFor, statusKey, stillThere, togglePane } from './code-side-model.js'
import { PANE_CHUNK, loadPane } from './code-side-lazy.js'
import { useCodeRowHerdr } from './work-code-switch.js'

export const CODE_PANEL = 'automagik-code'

const NO_STATE = {
  side: 'team', face: 'chat', botId: null, seat: false, tree: null, loading: false, error: null, loadedAt: 0,
  selected: null, beside: [], refused: null, barSelected: null, barBeside: [], barRefused: null,
  start: null,
  seatOrigin: null, seatTerminal: null,
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

/**
 * Re-read the team tree; one read at a time. Resolves the store's tree (or null). `after` is a
 * read after a change: it waits for a read already in flight, then always makes its own.
 */
export async function loadTree({ fresh = false, after = false } = {}) {
  if (!fresh && !after && state.tree && Date.now() - state.loadedAt < TREE_FRESH_MS) return state.tree
  // A reset store forgets reads started before it: their answers land nowhere.
  const generation = storeGeneration
  if (after) {
    while (reading) await reading
    if (generation !== storeGeneration) return null
  } else if (reading) return reading
  const landing = patch => { if (generation === storeGeneration) set(patch) }
  landing({ loading: true, error: null })
  const read = Promise.resolve()
    .then(() => call('code-tree'))
    .then((tree) => {
      landing({ tree: tree ?? null, loading: false, error: null, loadedAt: Date.now(), ...prune(tree) })
      return tree ?? null
    }, (error) => {
      landing({ loading: false, error: error?.code ?? 'unavailable', tree: null, loadedAt: Date.now(), ...prune(null) })
      return null
    })
    .finally(() => { if (reading === read) reading = null })
  reading = read
  return read
}

/** How often, and how long, a start whose result is not known yet re-reads the tree. */
export const START_POLL_MS = 3_000
export const START_POLL_FOR_MS = 120_000
// Outcomes after which nothing changed on the computer, so the tree is not read again.
const UNCHANGED = new Set(['desktop-only', 'invalid', 'busy', 'read-only'])
let startRun = 0
let storeGeneration = 0
const startRow = (tree, botId) => {
  for (const project of tree?.projects ?? []) {
    const bot = project.bots.find(row => row.id === botId)
    if (bot) return bot
  }
  return null
}
// Started means seen: a read that answered and shows that Bot live, in the project it was started
// for, on the core that was asked.
const seenLive = (tree, { id, folder, launch, core }) => {
  if (!tree?.machine || tree.reason || (core && tree.machine.core !== core)) return false
  const project = (tree.projects ?? []).find(group => group.bots.some(bot => bot.id === id))
  if (!project || (folder && project.folder !== folder)) return false
  const row = startRow(tree, id)
  // The live seat must be the one started for this project, not the same id's seat elsewhere.
  if (folder && row?.seatProject !== (launch ?? folder)) return false
  return ['working', 'needs-you', 'idle'].includes(row?.status)
}
const pauseFor = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * New › Start an existing Bot: ask the host to start one not-running Bot of this computer, then
 * read the tree again. A start whose result is not known yet (`pending`, or a reply lost after
 * the request went out) re-reads the tree until the Bot shows up running, or the time is up.
 */
export async function startBot({ id, name, folder = null, launch = null, core = null }) {
  // One start at a time, its reconciliation included: a second click waits for the first to settle.
  if (state.start?.busy) return state.start.outcome
  const run = ++startRun
  const generation = storeGeneration
  const stopped = () => run !== startRun || generation !== storeGeneration || isRetired()
  const current = patch => { if (!stopped()) set({ start: { ...state.start, ...patch } }) }
  set({ start: { botId: id, name, outcome: null, busy: true } })
  let outcome
  try {
    outcome = (await call('code-start', { botId: id }))?.outcome ?? 'unknown'
  } catch (error) {
    outcome = error?.code === 'bot/read-only' ? 'read-only' : 'unknown'
  }
  const waiting = outcome === 'pending' || outcome === 'unknown'
  current({ outcome, busy: waiting })
  if (UNCHANGED.has(outcome) || stopped()) return outcome
  let tree = await loadTree({ after: true })
  if (!waiting) return outcome
  // Until the Bot is seen live, or the time is up; a missing row or a failed read keeps waiting.
  const until = Date.now() + START_POLL_FOR_MS
  try {
    while (!stopped()) {
      if (seenLive(tree, { id, folder, launch, core })) {
        current({ outcome: 'started' })
        return 'started'
      }
      if (Date.now() >= until) return outcome
      await pauseFor(START_POLL_MS)
      if (stopped()) return outcome
      tree = await loadTree({ after: true })
    }
    return outcome
  } finally {
    current({ busy: false })
  }
}

/**
 * Flip the view to the open Bot's terminal; the tree is read now, not before.
 *
 * `seat` says the face belongs to a seat panel, not a conversation header. It is the same store
 * and the same pane: the seat renders the Code body itself, so the conversation body is not
 * registered underneath it.
 */
export async function openTerminal(botId, { seat = false, terminal = null } = {}) {
  set({ face: 'terminal', botId, seat, seatTerminal: terminal, ...seatPanes([]) })
  const tree = await loadTree({ fresh: true })
  if (!tree || state.botId !== botId || state.face !== 'terminal' || state.seat !== seat || state.seatTerminal !== terminal) return
  const pane = seat ? seatPaneFor(tree, botId, terminal) : paneFor(tree, botId)
  if (pane) selectPane(pane)
}

/** Flip the view back to the chat; the terminal stream closes with the pane. */
export function closeTerminal() {
  set({ face: 'chat', botId: null, seat: false, seatTerminal: null, ...seatPanes([]) })
}

/** Choose one tree row's pane (or clear it), without leaving the Code face. */
export function selectPane(selected, { beside = false } = {}) {
  if (!beside) { set(seatPanes([selected])); return }
  const previous = panesOf(state.selected, state.beside)
  const { list, refused } = togglePane(previous, selected, state.tree)
  if (list !== previous || refused) set(seatPanes(list, refused))
}

/** The flip's state for one Bot, as the chat header's or the seat's Chat / Terminal switch takes it. */
export function useCodeFace(botId, { seat = false, terminal = null } = {}) {
  const current = useSyncExternalStore(storeSubscribe, snapshot, snapshot)
  return {
    face: current.face === 'terminal' && current.botId === botId && current.seat === seat ? 'terminal' : 'chat',
    seatOrigin: current.seatOrigin,
    terminalMissing: seat && !current.loading && !seatPaneFor(current.tree, botId, terminal),
    // Whether a Bot has a pane is the renderer's own answer, read when Terminal is pressed:
    // the switch never fetches the tree or the chunk on its own.
    onFace: (face) => { if (face === 'terminal') void openTerminal(botId, { seat, terminal }); else closeTerminal() },
  }
}

/** The open Bot's switch, wired to the flip: the view's entry to Code mode. */
export function BotFaceSwitch({ bot }) {
  const code = useCodeFace(bot?.id, { seat: true, terminal: bot?.terminal })
  return bot?.seat === true ? h(FaceSwitch, { face: code.face, onFace: code.onFace }) : null
}

export function useCodeSide() {
  return useSyncExternalStore(storeSubscribe, snapshot, snapshot)
}

export function setCodeSide(side) {
  set({ side })
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
export function codePanelNavigation(layout, { seatPanel, seatKey, restoreSeat } = {}) {
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
        const panel = active()
        previous = { panel, seat: panel === seatPanel ? seatKey?.() : null }
        layout.selectPanel(CODE_PANEL)
      }
      set({ ...next, seatOrigin: null })
    },
    reshow(botId) {
      const origin = state.seatOrigin
      if (origin?.botId !== botId) return
      set({ ...barPanes(origin.panes), seatOrigin: null })
      layout.selectPanel(CODE_PANEL)
    },
    close() {
      if (active() === CODE_PANEL) {
        try {
          const panel = previous?.panel ?? null
          layout.selectPanel(panel === seatPanel && !restoreSeat?.(previous?.seat) ? null : panel)
        } catch { layout.selectPanel(null) }
      }
      set(barPanes([]))
    },
  }
}

export function clearSeatOrigin() {
  if (state.seatOrigin) set({ seatOrigin: null })
}

/**
 * The body of the Terminal face, for a conversation (registered below) and for a seat's panel
 * (rendered by seat-chat.js): it loads the chunk once and draws the pane the flip selected.
 */
export function CodeBody() {
  const current = useCodeSide()
  return h(CodeRenderer, { current, render: pane => h(CodeTreeHerdr, {
    render: herdr => h(pane.CodeBody, { code: { ...codeApi, herdr, ...startControls(current) } }),
  }) })
}

// New › Start an existing Bot's two components (code-start-menu.js), handed in by the team's
// client when it installs the Code side, so this module stays free of the menus it draws with.
let startUi = null

/** New › Start an existing Bot, as two elements the chunk places: the control and its line. */
function startControls(current, statusClass) {
  if (!startUi) return {}
  return {
    newControl: h(startUi.Menu, { current, startBot }),
    newStatus: h(startUi.Status, { current, ...(statusClass ? { className: statusClass } : {}) }),
  }
}

export function CodeBarList({ current, onSelect }) {
  return h(CodeRenderer, {
    current, showLoading: true,
    render: pane => h(CodeTreeHerdr, {
      render: herdr => h(pane.CodeTree, {
        current: { ...current, selected: current.barSelected, beside: current.barBeside }, onSelect, sidebar: true, herdr,
        ...startControls(current, 'cs-empty'),
      }),
    }),
  })
}

function CodeTreeHerdr({ render }) {
  return render(useCodeRowHerdr())
}

export function CodeMainPanel({ onBack, openSeat, useSeatRoster = () => ({ seats: [] }) }) {
  const current = useCodeSide()
  const { seats } = useSeatRoster()
  const seatForPane = (botId, terminal) => seats.find(seat => seat.id === botId && seat.machine == null && seat.terminal === terminal)
  const openSeatFace = (botId, terminal) => {
    const seat = seatForPane(botId, terminal)
    if (!seat || !openSeat) return
    set({ seatOrigin: { botId, panes: panesOf(state.barSelected, state.barBeside) } })
    openSeat(seat, { fromCode: true })
  }
  return h('div', { className: 'bt-seat', 'data-code-panel': '' },
    h('header', { className: 'bt-seat-head' },
      h('button', { type: 'button', className: 'bt-seat-back', 'aria-label': t('Back'), title: t('Back'), onClick: onBack }, '←')),
    h('div', { className: 'bt-seat-body' },
      h(CodeRenderer, { current, render: pane => h('section', { className: 'cs-host' },
        h(pane.CodeTerminal, {
          tree: current.tree, selected: current.barSelected, beside: current.barBeside, refused: current.barRefused,
          loading: current.loading, code: { ...codeApi, seatForPane, openSeatFace, FaceSwitch },
        })) })))
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
export function installCodeSide(ctx, { start = null } = {}) {
  startUi = start
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
    if (startUi === start) startUi = null
    // A start still reconciling belongs to this surface: it ends with it.
    startRun += 1
    storeGeneration += 1
    if (state.start?.busy) set({ start: { ...state.start, busy: false } })
    unsubscribe()
    listOff?.()
    listOff = null
    off?.()
    off = null
    if (state.face === 'terminal') closeTerminal()
  }
}

/** The flip's store, for the plugin and its tests. */
export const codeStore = {
  subscribe: storeSubscribe, snapshot, loadTree, openTerminal, closeTerminal, selectPane, startBot,
  reset: () => { startRun += 1; storeGeneration += 1; reading = null; set({ ...NO_STATE }) },
}
export { codeHasPane, botRowOf, paneFor, statusKey, stillThere, PANE_CHUNK, loadPane }
