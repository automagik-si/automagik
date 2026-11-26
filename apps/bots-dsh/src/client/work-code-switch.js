import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'
import { t } from './i18n.js'

// The Code row opens Herdr through the desktop preload. Status refreshes on mount,
// window focus and pointer entry. Only the row or a notice button opens Herdr.

// What main's `note` is about (apps/desktop src/herdr-update.js NOTE_KINDS). An app from before
// `noteKind` sends the note alone: its kind is read from main's own English wording, and a note
// that matches none is shown as Herdr's message.
const NOTE_PATTERNS = [
  ['offline', /^Herdr couldn't check for updates \(no connection\)/],
  ['check-failed', /^Herdr couldn't check for updates /],
  ['update-failed', /^Herdr couldn't update to /],
  ['updated-restart', /^Herdr \S+ is installed; it starts when Herdr restarts$/],
]

/** The kind of an open's note: main's `noteKind`, else read from the note's text; or null. */
export function noteKindOf(result) {
  if (typeof result?.noteKind === 'string' && NOTE_PATTERNS.some(([kind]) => kind === result.noteKind)) return result.noteKind
  if (typeof result?.note !== 'string') return null
  return NOTE_PATTERNS.find(([, pattern]) => pattern.test(result.note))?.[0] ?? null
}

function noteNotice(result) {
  const kind = noteKindOf(result)
  switch (kind) {
    case 'offline': return { kind, label: t('No connection: Herdr opened on the installed version'), title: result.note }
    case 'check-failed': return { kind, label: t("Herdr couldn't check for updates: it opened on the installed version"), title: result.note }
    case 'update-failed': return { kind, label: t("Herdr couldn't update: it opened on the installed version"), title: result.note }
    case 'updated-restart': return { kind, label: t('Herdr {version} is installed: it starts when Herdr restarts', { version: result.version ?? '' }), title: result.note }
    default: return { kind: 'note', label: t('Herdr says: {message}', { message: result.note }) }
  }
}

/** Whether the switch shows for a `status()` answer: only where herdr-app is set up. */
export function showsSwitch(status) {
  return status?.state === 'open' || status?.state === 'closed' || (status?.state === 'error' && Boolean(status.source))
}

/**
 * What an `open()` answer shows: a list of { kind, label, title?, retry?, latest? }. An offer
 * of a newer Herdr is `kind: 'offer'`, answered with yes or no; the rest are notes. A Herdr
 * that opened, in front, on its latest version, shows nothing.
 */
export function codeNotices(result) {
  if (!result || typeof result !== 'object') return [{ kind: 'error', label: t("Herdr didn't open"), retry: true }]
  if (result.ok !== true) {
    switch (result.reason) {
      case 'update': return [{ kind: 'offer', label: t('Herdr {version} is out', { version: result.latest ?? '' }), latest: result.latest }]
      case 'missing': return [{ kind: 'missing', label: t('Herdr is not set up') }]
      case 'unsupported': return [{ kind: 'unsupported', label: t('Herdr has no build for this computer') }]
      default: return [{ kind: 'error', label: t("Herdr didn't open"), title: result.detail || result.message || undefined, retry: true }]
    }
  }
  const notes = []
  // `raised` is false, or null where the OS cannot tell: main says so unless it is true.
  if (result.raised !== true) notes.push({ kind: 'no-focus', label: t('Herdr is open in another window'), title: result.detail || undefined })
  if (typeof result.note === 'string' && result.note !== '') notes.push(noteNotice(result))
  // herdr-app's own message: a `do` it refused, a remote machine that is offline.
  if (typeof result.space?.error === 'string' && result.space.error !== '') notes.push({ kind: 'space', label: t('Herdr says: {message}', { message: result.space.error }) })
  return notes
}

/**
 * The trees share status and the most recent open over one bridge. The click
 * handlers call the bridge in the same turn as the click, while user activation still holds.
 */
export function createCodeSwitch(bridge) {
  let state = NO_STATE
  const listeners = new Set()
  const set = (patch) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  let reading = null
  const refresh = () => {
    reading ??= Promise.resolve()
      .then(() => bridge.status())
      .then(status => set({ status: status ?? null }), () => set({ status: null }))
      .finally(() => { reading = null })
    return reading
  }
  const open = ({ botId, owner, update }) => {
    if (state.busy) return Promise.resolve(state.result)
    set({ busy: true, result: null, target: { botId, owner } })
    const options = typeof update === 'boolean' ? { update } : undefined
    let answer
    try {
      answer = Promise.resolve(typeof bridge.openCodeRow === 'function'
        ? options ? bridge.openCodeRow(botId, options) : bridge.openCodeRow(botId)
        : bridge.open({ botId: null, ...options }))
    } catch (error) {
      answer = Promise.reject(error)
    }
    return answer.then(result => result, error => ({ ok: false, reason: 'error', message: error?.message })).then((result) => {
      // An app that refused the page answers null: that is a failed open too.
      set({ busy: false, result: result ?? { ok: false, reason: 'error' } })
      // Herdr went away since the last read: refresh the status behind the controls.
      if (result?.reason === 'missing' || result?.reason === 'unsupported') void refresh()
      return result
    })
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => state,
    refresh,
    open,
    repeat: update => state.target && open({ ...state.target, update }),
    dismiss() {
      if (state.result !== null) set({ result: null, target: null })
    },
  }
}

// One switch per bridge, shared by every render of the sidebar.
const switches = new WeakMap()
function switchFor(bridge) {
  if (!bridge || typeof bridge.status !== 'function' || typeof bridge.open !== 'function') return null
  if (!switches.has(bridge)) switches.set(bridge, createCodeSwitch(bridge))
  return switches.get(bridge)
}

const NO_STATE = { status: null, busy: false, result: null, target: null }
const noSubscribe = () => () => {}
const noState = () => NO_STATE

function Notice({ notice, onAnswer, onRetry, onDismiss, busy }) {
  if (notice.kind === 'offer') {
    return h('div', { className: 'bt-code-note', role: 'status' },
      h('span', { className: 'bt-code-note-text' }, notice.label),
      h('span', { className: 'bt-code-note-row' },
        h('button', { type: 'button', className: 'bt-code-note-go', disabled: busy, onClick: () => onAnswer(true) }, t('Update and open')),
        h('button', { type: 'button', className: 'bt-code-note-btn', disabled: busy, onClick: () => onAnswer(false) }, t('Open this version')),
        h('button', { type: 'button', className: 'bt-code-note-btn', onClick: onDismiss }, t('Dismiss'))))
  }
  return h('div', { className: `bt-code-note bt-code-note-${notice.kind}`, role: 'status', title: notice.title },
    h('span', { className: 'bt-code-note-text' }, notice.label),
    h('span', { className: 'bt-code-note-row' },
      notice.retry ? h('button', { type: 'button', className: 'bt-code-note-go', disabled: busy, onClick: onRetry }, t('Retry')) : null,
      h('button', { type: 'button', className: 'bt-code-note-btn', onClick: onDismiss }, t('Dismiss'))))
}

function HerdrNotices({ control, result, busy }) {
  const notices = result ? codeNotices(result) : []
  if (!notices.length) return null
  return h('div', { className: 'bt-code-notes', 'data-code-row': '' },
    notices.map(notice => h(Notice, {
      key: notice.kind, notice, busy,
      onAnswer: update => { void control.repeat(update) },
      onRetry: () => { void control.repeat() },
      onDismiss: () => control.dismiss(),
    })))
}

export function useCodeRowHerdr() {
  const [owner] = useState(() => Symbol())
  const control = switchFor(globalThis.omniDesktop?.herdr)
  const snapshot = control?.snapshot ?? noState
  const state = useSyncExternalStore(control?.subscribe ?? noSubscribe, snapshot, snapshot)
  useEffect(() => {
    if (!control) return undefined
    const refresh = () => { void control.refresh() }
    refresh()
    globalThis.addEventListener?.('focus', refresh)
    return () => globalThis.removeEventListener?.('focus', refresh)
  }, [control])
  return {
    visible: () => showsSwitch(state.status),
    busy: state.busy,
    refresh: () => { void control?.refresh() },
    openRow: botId => { void control?.open({ botId, owner }) },
    notices: state.target?.owner === owner
      ? h(HerdrNotices, { control, result: state.result, busy: state.busy })
      : null,
  }
}

export const WORK_CODE_SWITCH_CSS = `
.bt-code-notes{position:absolute;top:calc(100% + 6px);left:0;z-index:30;display:flex;flex-direction:column;gap:6px;width:240px;max-width:72vw}
.bt-code-notes[data-code-row] .bt-code-note-row{flex-wrap:wrap}
.bt-code-note{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);box-shadow:0 6px 20px rgba(0,0,0,.12);font:500 12px/17px var(--bt-font)}
.bt-code-note-text{overflow-wrap:anywhere}
.bt-code-note-row{display:flex;justify-content:flex-end;gap:6px}
.bt-code-note-go,.bt-code-note-btn{height:26px;padding:0 12px;border-radius:999px;font:600 12px/16px var(--bt-font);cursor:pointer}
.bt-code-note-go{border:0;background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-code-note-btn{border:1px solid var(--bt-line);background:none;color:var(--bt-ink)}
.bt-code-note-go:disabled,.bt-code-note-btn:disabled{opacity:.6;cursor:default}
`
