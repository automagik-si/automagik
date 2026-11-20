import { createElement as h, useEffect, useMemo, useSyncExternalStore } from 'react'
import { t } from './i18n.js'

// -------------------------------------------------------------------------
// The Work / Code switch (RFC 0013, delivery 5), in the sidebar's top row beside the macOS
// traffic lights. Work is this window; Code brings the real herdr-app window forward on the
// space for the shown Bot's folder. The app hands the bridge over in its preload
// (`omniDesktop.herdr`: status, open); in a browser, or an app without it, nothing shows, and
// before the one install (delivery 7) nothing shows either where herdr-app is not set up.
//
// The page only ever sends a Bot id (and, to an offer of a newer Herdr, the person's yes or
// no), and only from a click on Code or on the offer's buttons: never on render, on focus or
// on hover, and there is no keyboard shortcut (D27). Herdr's state is read on mount, when the
// window gains focus and when the pointer enters the switch; there is no timer. Main does
// everything else (apps/desktop src/main.js `automagik-herdr-open`) and answers with what
// happened; each answer shows here with its label (the RFC's Failure modes).

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
 * The switch's state over one bridge: { status, busy, result, front }. `open(request)` is the
 * only way to `bridge.open()`, and the component calls it from click handlers alone; it calls
 * the bridge in the same turn as the click, so the click's user activation still holds.
 */
export function createCodeSwitch(bridge, { focused = () => true } = {}) {
  let state = { status: null, busy: false, result: null, front: focused() }
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
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => state,
    refresh,
    setFront(front) {
      if (front !== state.front) set({ front })
    },
    open(request) {
      if (state.busy) return Promise.resolve(state.result)
      set({ busy: true, result: null })
      let answer
      try {
        answer = Promise.resolve(bridge.open(request))
      } catch (error) {
        answer = Promise.reject(error)
      }
      return answer.then(result => result, error => ({ ok: false, reason: 'error', message: error?.message })).then((result) => {
        // An app that refused the page answers null: that is a failed open too.
        set({ busy: false, result: result ?? { ok: false, reason: 'error' } })
        // Herdr went away since the last read: the switch hides once status says so.
        if (result?.reason === 'missing' || result?.reason === 'unsupported') void refresh()
        return result
      })
    },
    dismiss() {
      if (state.result !== null) set({ result: null })
    },
  }
}

// One switch per bridge, shared by every render of the sidebar.
const switches = new WeakMap()
function switchFor(bridge) {
  if (!bridge || typeof bridge.status !== 'function' || typeof bridge.open !== 'function') return null
  if (!switches.has(bridge)) switches.set(bridge, createCodeSwitch(bridge, { focused: () => globalThis.document?.hasFocus?.() ?? true }))
  return switches.get(bridge)
}

/** The Bot the main view shows: its own chat or a part of it, or a task it started; else null. */
export function shownBotId(roster, sessionId) {
  if (!sessionId) return null
  const bot = roster?.byId?.[sessionId]
  if (bot) return bot.id
  const from = roster?.tasks?.[sessionId]?.from
  return typeof from === 'string' && roster?.byId?.[from] ? from : null
}

const mainViewId = list => Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? ''
const NO_STATE = { status: null, busy: false, result: null, front: true }
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

export function WorkCodeSwitch({ roster, useSessions }) {
  const bridge = globalThis.omniDesktop?.herdr
  const control = useMemo(() => switchFor(bridge), [bridge])
  const state = useSyncExternalStore(control?.subscribe ?? noSubscribe, control?.snapshot ?? noState)
  const sessionId = useSessions(mainViewId)
  useEffect(() => {
    if (!control) return undefined
    void control.refresh()
    const onFocus = () => { control.setFront(true); void control.refresh() }
    const onBlur = () => control.setFront(false)
    globalThis.addEventListener?.('focus', onFocus)
    globalThis.addEventListener?.('blur', onBlur)
    return () => {
      globalThis.removeEventListener?.('focus', onFocus)
      globalThis.removeEventListener?.('blur', onBlur)
    }
  }, [control])
  if (!control || !showsSwitch(state.status)) return null
  const botId = shownBotId(roster, sessionId)
  const code = () => { void control.open({ botId }) }
  const answer = (update) => { void control.open({ botId, update }) }
  const notices = state.result ? codeNotices(state.result) : []
  return h('div', { className: 'bt-code-switch-wrap' },
    h('div', { className: 'bt-code-switch', role: 'group', 'aria-label': t('Open Herdr'), onPointerEnter: () => { void control.refresh() } },
      h('button', {
        type: 'button',
        className: 'bt-code-seg',
        'aria-current': state.front ? undefined : 'true',
        'aria-busy': state.busy || undefined,
        disabled: state.busy,
        title: state.busy ? t('Opening Herdr…') : botId ? t('Code: open this Bot’s folder in Herdr') : t('Code: open Herdr'),
        onClick: code,
      }, t('Code'))),
    notices.length > 0
      ? h('div', { className: 'bt-code-notes' }, notices.map(notice => h(Notice, { key: notice.kind, notice, busy: state.busy, onAnswer: answer, onRetry: code, onDismiss: () => control.dismiss() })))
      : null)
}

export const WORK_CODE_SWITCH_CSS = `
.bt-side-top .bt-code-switch-wrap{position:relative;margin-right:auto;min-width:0}
.bt-code-switch{display:inline-flex;align-items:center;max-width:100%;padding:2px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-main)}
.bt-code-seg{display:inline-flex;align-items:center;min-width:0;height:24px;padding:0 9px;border:0;border-radius:999px;background:none;color:var(--bt-ink-2);font:600 12px/16px var(--bt-font);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.bt-code-seg[aria-current=true]{background:var(--bt-card);color:var(--bt-ink);box-shadow:0 0 0 1px var(--bt-line)}
span.bt-code-seg{cursor:default}
button.bt-code-seg:hover:not(:disabled):not([aria-current=true]){color:var(--bt-ink)}
.bt-code-seg:disabled{cursor:default}
.bt-code-seg[aria-busy]{animation:bt-code-pulse 1.2s ease-in-out infinite}
.bt-code-notes{position:absolute;top:calc(100% + 6px);left:0;z-index:30;display:flex;flex-direction:column;gap:6px;width:240px;max-width:72vw}
.bt-code-note{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);color:var(--bt-ink);box-shadow:0 6px 20px rgba(0,0,0,.12);font:500 12px/17px var(--bt-font)}
.bt-code-note-text{overflow-wrap:anywhere}
.bt-code-note-row{display:flex;justify-content:flex-end;gap:6px}
.bt-code-note-go,.bt-code-note-btn{height:26px;padding:0 12px;border-radius:999px;font:600 12px/16px var(--bt-font);cursor:pointer}
.bt-code-note-go{border:0;background:var(--bt-accent);color:var(--bt-accent-ink)}
.bt-code-note-btn{border:1px solid var(--bt-line);background:none;color:var(--bt-ink)}
.bt-code-note-go:disabled,.bt-code-note-btn:disabled{opacity:.6;cursor:default}
@keyframes bt-code-pulse{50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){.bt-code-seg[aria-busy]{animation:none}}
`
