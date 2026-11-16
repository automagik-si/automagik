// The rendered face of a seat on this computer, in the main panel (RFC 0022 delivery 1L).
//
// A Team row that is a seat ((i)) opens this: the seat's own transcript, its status, and the
// waiting card when it asks for the owner. Its chat face stays show only: there is no composer
// here and no button answers, sends or interrupts; delivery 2L serves those writes, owner-only,
// and 1L ships without them. The header's Chat / Terminal switch opens the same Code side a Bot
// conversation has (code-side.js), view-only until an explicit click, so the seat's own terminal
// is one press away. Every row comes from what exists (the registry, herdr-core's status, the
// transcript) and nothing here starts, stops or restarts anything.
import { Fragment, createElement as h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { call } from './api.js'
import { CodeBody, closeTerminal, useCodeFace } from './code-side.js'
import { MarkdownText } from './dsh-primitives.js'
import { hostText, t } from './i18n.js'
import { mdLabels } from './btw.js'
import { FaceSwitch } from './left-bar-faces.js'
import { word } from './left-bar-status.js'
import { createSource } from './sources.js'

/** The main slot's key for this panel: a seat is not a Session, so it is a keyed main panel. */
export const SEAT_CHAT_PANEL = 'seat-chat'
/** What the bar polls: the team's seats on this computer, from the host's registry join. */
const LIST_MS = 4000
/** What an open face polls: new rows, the status and the waiting card. */
const READ_MS = 1200

/** The window's own seat-chat id: a reload keeps its watch; nothing about the person is in it. */
export function seatClientId(storage) {
  try {
    const store = storage ?? globalThis.localStorage
    const saved = store?.getItem?.('omni-ui:seat-chat-client')
    if (typeof saved === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(saved)) return saved
    const made = typeof globalThis.crypto?.randomUUID === 'function'
      ? `w-${globalThis.crypto.randomUUID()}`
      : `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    store?.setItem?.('omni-ui:seat-chat-client', made)
    return made
  } catch {
    return `w-${Math.random().toString(36).slice(2, 12)}`
  }
}

/** The seat the panel shows: set by the bar's row, kept while the panel is selected. */
export const seatChatView = createSource({ seat: null })

const AGENTS = { claude: 'Claude Code', codex: 'Codex', omp: 'omp' }
/** The agent's name as the header says it; a decoder-less pane is a terminal. */
export const seatAgentName = agent => AGENTS[agent] ?? t('Terminal')
/** The bar's status of a live herdr-core status, as a seat row and the panel's header say it. */
export function seatWordOf(status) {
  const state = typeof status?.state === 'string' ? status.state : null
  if (state === 'blocked') return 'needs'
  if (state === 'error') return 'error'
  if (state === 'working') return 'working'
  return status === null ? 'off' : 'idle'
}
/** Where the seat runs, as the header says it: this view exists only for this computer. */
export const SEAT_MACHINE = () => t('This computer')

/**
 * The registry Bot behind a seat row. `artId` is the registry Bot's own id (left-bar.js); a row
 * that only has its `seat:` key still names the Bot under the prefix. Null names no Bot.
 */
export function seatBotId(seat) {
  if (typeof seat?.artId === 'string' && seat.artId !== '') return seat.artId
  if (typeof seat?.id !== 'string') return null
  const id = seat.id.startsWith('seat:') ? seat.id.slice('seat:'.length) : seat.id
  return id === '' ? null : id
}

/** Why a seat cannot show its terminal, in words; null when its own pane is live here. */
export const seatTerminalWhy = seat => (seat === null
  ? null
  : typeof seat.terminal === 'string' && seat.terminal !== ''
    ? null
    : t('This seat is not running on this computer, so its terminal cannot open.'))

/** No seats: one frozen empty list, so an empty reply never changes state or re-renders. */
const NO_SEATS = Object.freeze([])

/**
 * The bar's seats, polled: `[{ id, name, project, terminal, agent, chat, status, order }]`.
 *
 * `list` is the shell's own stable action (it asks the host); without it nothing is fetched at
 * all, and nothing is fetched when the bar is not the shown one (`enabled`). Depending on a
 * default made here would make a new function every render, and an empty reply stored as a new
 * array would re-render and ask again: the fixture page that has no seat source must see no call.
 */
export function useSeats(list, enabled = true) {
  const [seats, setSeats] = useState(NO_SEATS)
  useEffect(() => {
    const empty = () => setSeats(now => (now.length === 0 ? now : NO_SEATS))
    if (!enabled || typeof list !== 'function') {
      empty()
      return undefined
    }
    let alive = true
    let timer
    const tick = async () => {
      let next = NO_SEATS
      try {
        const value = await list()
        next = Array.isArray(value?.seats) ? value.seats : NO_SEATS
      } catch {
        // A host that cannot read seats (no Herdr, an old plugin) lists none; the team is unchanged.
        next = NO_SEATS
      }
      if (!alive) return
      if (next.length === 0) empty()
      else setSeats(next)
      timer = setTimeout(tick, LIST_MS)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [list, enabled])
  return seats
}

/** A face with nothing in it; `terminal` is the seat those rows belong to. */
export const EMPTY_FACE = Object.freeze({ terminal: null, rows: [], screen: [], status: null, approval: null, question: null, loading: false, error: null })

/**
 * The next face from one read of the same seat: rows after the cursor are appended, a reset (or a
 * read for another seat) replaces them. Ids are stable, so a re-read never doubles a row.
 */
export function mergeFace(now, value, terminal) {
  const sameSeat = now.terminal === terminal
  const rows = value.reset === true || !sameSeat ? (value.rows ?? []) : [...now.rows, ...(value.rows ?? [])]
  const seen = new Set()
  const unique = rows.filter(row => (seen.has(row.id) ? false : (seen.add(row.id), true)))
  return {
    ...now, terminal, rows: unique, screen: value.screen ?? (sameSeat ? now.screen : []),
    status: value.status ?? null, approval: value.approval ?? null, question: value.question ?? null,
    loading: false, error: null,
  }
}

/** One seat's face: opened once, polled for new rows, closed when the panel goes. */
export function useSeatFace(seat) {
  const [face, setFace] = useState(EMPTY_FACE)
  const terminal = typeof seat?.terminal === 'string' ? seat.terminal : null
  useEffect(() => {
    let alive = true
    let timer
    let cursor = null
    let client = null
    if (terminal === null) {
      setFace(EMPTY_FACE)
      return undefined
    }
    client = seatClientId()
    const read = async () => {
      try {
        const value = await call('seat-chat-read', { client, terminal, after: cursor })
        if (!alive) return
        cursor = (value.rows ?? []).at(-1)?.id ?? cursor
        setFace(now => mergeFace(now, value, terminal))
      } catch (error) {
        if (alive) setFace(now => ({ ...now, loading: false, error: hostText(error?.message ?? '') }))
        return
      }
      if (alive) timer = setTimeout(read, READ_MS)
    }
    const open = async () => {
      // Another seat's face never stands in for this one: its rows, card and status go first.
      setFace(now => (now.terminal === terminal ? { ...now, loading: true, error: null } : { ...EMPTY_FACE, terminal, loading: true }))
      try {
        const value = await call('seat-chat-open', { client, terminal })
        if (!alive) return
        if (value === null) {
          setFace(now => ({ ...now, loading: false, error: t('This seat holds the chat already open in another window.') }))
          return
        }
        cursor = (value.rows ?? []).at(-1)?.id ?? null
        setFace(now => mergeFace(now, value, terminal))
        timer = setTimeout(read, READ_MS)
      } catch (error) {
        if (alive) setFace(now => ({ ...now, loading: false, error: hostText(error?.message ?? '') }))
      }
    }
    open()
    return () => {
      alive = false
      clearTimeout(timer)
      if (client) void call('seat-chat-close', { client, terminal }).catch(() => {})
    }
  }, [terminal])
  return face
}

const toolText = (row) => (typeof row?.summary === 'string' && row.summary.trim() !== '' ? row.summary : '')

/** The waiting card: what asks for the owner, shown, never answered here. */
export function WaitingCard({ approval, question }) {
  if (approval === null && question === null) return null
  const tool = approval?.tool ?? ''
  const line = question?.prompt ?? (approval ? (toolText(approval) || t('A step needs your answer')) : '')
  const options = approval ? (approval.choices ?? []).map(choice => (choice === 'allow' ? t('Allow once') : choice === 'deny' ? t('Deny') : t('Allow always')))
    : (question?.options ?? [])
  return h('section', { className: 'bt-seat-wait', role: 'status', 'data-seat-wait': '' },
    h('div', { className: 'bt-seat-wait-head' }, h('span', { className: 'bt-seat-wait-dot', 'aria-hidden': true }), t('Needs you')),
    tool !== '' || line !== '' ? h('p', { className: 'bt-seat-wait-line' }, tool !== '' ? h('strong', null, tool) : null, tool !== '' && line !== '' ? ' · ' : null, line) : null,
    options.length > 0
      ? h('p', { className: 'bt-seat-wait-options' }, options.map((option, index) => h(Fragment, { key: option },
          index === 0 ? null : h('span', { className: 'bt-seat-wait-sep', 'aria-hidden': true }, ' · '),
          h('span', { className: 'bt-seat-option' }, option))))
      : null,
    h('p', { className: 'bt-seat-wait-note' }, t('Answer in the terminal. This view shows the card and never answers it.')))
}

export function SeatRow({ row }) {
  if (row === null || typeof row !== 'object') return null
  if (row.kind === 'text') {
    const text = typeof row.text === 'string' ? row.text : ''
    if (text === '') return null
    return row.role === 'user'
      ? h('div', { className: 'bt-seat-userrow' }, h('div', { className: 'bt-seat-user' }, text))
      : h('div', { className: 'bt-seat-assistant' }, h(MarkdownText, { text, labels: mdLabels(), variant: 'compact' }))
  }
  if (row.kind === 'tool-call') {
    return h('div', { className: 'bt-seat-tool', 'data-tool': row.tool },
      h('span', { className: 'bt-seat-tool-name' }, row.tool),
      toolText(row) !== '' ? h('span', { className: 'bt-seat-tool-summary' }, toolText(row)) : null)
  }
  if (row.kind === 'tool-result') {
    const output = typeof row.output === 'string' ? row.output.trim() : ''
    if (output === '') return null
    return h('details', { className: 'bt-seat-toolresult' },
      h('summary', null, row.ok === false ? t('Error output') : t('Output')),
      h('pre', { className: 'bt-seat-pre' }, output))
  }
  if (row.kind === 'status') {
    const line = typeof row.msg === 'string' && row.msg !== '' ? row.msg : row.state
    return typeof line === 'string' && line !== '' ? h('p', { className: 'bt-seat-note' }, line) : null
  }
  // Approval and question rows are the waiting card above, never a row of their own.
  return null
}

/** One sentence about where the face's rows come from, so nobody reads the screen as the transcript. */
export const seatSourceNote = seat => (seat?.chat === 'screen'
  ? t('Screen only: this agent has no transcript reader, so these are its last screens.')
  : t('Read from this seat’s own transcript. This view never runs or types into it.'))

/**
 * The main panel a seat row opens. It is root-scoped (a seat has no DSH Session): the bar's
 * store names the seat, this reads its face, and `onBack` returns to the conversation.
 */
export function SeatChatPanel({ onBack }) {
  const seat = useSyncExternalStore(seatChatView.subscribe, seatChatView.getSnapshot).seat
  const face = useSeatFace(seat)
  const botId = seatBotId(seat)
  // The same flip and the same Code body a Bot conversation uses (code-side.js), keyed by the
  // seat's registry Bot id. The seat row keeps the body itself; the conversation slot is not
  // registered underneath it.
  const code = useCodeFace(botId, { seat: true })
  const terminal = code.face === 'terminal'
  const why = seatTerminalWhy(seat)
  const showingTerminal = terminal && why === null
  const scroll = useRef(null)
  const [pinned, setPinned] = useState(true)
  const length = face.rows.length
  useLayoutEffect(() => {
    const node = scroll.current
    if (node && pinned) node.scrollTop = node.scrollHeight
  }, [length, pinned, seat?.terminal])
  // A seat that lost its pane always shows its chat, never a Terminal body it cannot open.
  useEffect(() => { if (why !== null && terminal) closeTerminal() }, [why, terminal])
  // Leaving the seat panel leaves its Terminal too: a later conversation never opens on it.
  useEffect(() => () => { if (showingTerminal) closeTerminal() }, [showingTerminal])
  if (seat === null) {
    return h('div', { className: 'bt-seat' },
      h('div', { className: 'bt-seat-empty' }, t('Choose a seat in the team bar to read its chat.')))
  }
  const status = face.status === null ? seat.status : seatWordOf(face.status)
  const needs = (face.approval !== null || face.question !== null) && status === 'needs'
  const seatLine = [seat.project, seatAgentName(seat.agent), SEAT_MACHINE()].filter(Boolean).join(' · ')
  return h('div', { className: 'bt-seat', 'data-seat': seat.id, 'data-seat-face': showingTerminal ? 'terminal' : 'chat' },
    h('header', { className: 'bt-seat-head' },
      h('button', {
        type: 'button', className: 'bt-seat-back',
        'aria-label': showingTerminal ? t('Back to chat') : t('Back to the team'),
        title: showingTerminal ? t('Back to chat') : t('Back to the team'),
        onClick: () => { if (showingTerminal) closeTerminal(); else onBack?.() },
      }, '←'),
      h('div', { className: 'bt-seat-who' },
        h('div', { className: 'bt-seat-title' }, seat.name),
        h('div', { className: 'bt-seat-sub' }, seatLine)),
      botId === null ? null : h(FaceSwitch, {
        face: showingTerminal ? 'terminal' : 'chat',
        onFace: code.onFace,
        unavailable: why === null ? {} : { terminal: why },
      }),
      h('span', { className: 'bt-seat-status', 'data-status': status, title: word(status), 'aria-label': word(status) },
        h('span', { className: 'bt-seat-status-mark', 'data-status': status, 'aria-hidden': true }),
        word(status))),
    why === null ? null : h('p', { className: 'bt-seat-why', role: 'status' }, why),
    h('div', { className: 'bt-seat-body' },
      showingTerminal
        ? h(CodeBody, { key: botId })
        : h(Fragment, null,
          needs ? h(WaitingCard, { approval: face.approval, question: face.question }) : null,
          face.error !== null
            ? h('div', { className: 'bt-seat-error', role: 'status' }, face.error)
            : null,
          face.loading && face.rows.length === 0
            ? h('p', { className: 'bt-seat-note bt-seat-loading' }, t('Reading the seat…'))
            : null,
          h('div', {
            className: 'bt-seat-scroll', ref: scroll,
            onScroll: (event) => {
              const node = event.currentTarget
              setPinned(node.scrollHeight - node.scrollTop - node.clientHeight < 24)
            },
          },
            face.rows.map(row => h(SeatRow, { key: row.id, row })),
            face.rows.length === 0 && !face.loading && face.error === null
              ? h('p', { className: 'bt-seat-note' }, t('No transcript rows yet. The seat is quiet.'))
              : null),
          !pinned ? h('button', {
            type: 'button', className: 'bt-seat-latest',
            onClick: () => { setPinned(true); const node = scroll.current; if (node) node.scrollTop = node.scrollHeight },
          }, t('Latest')) : null)),
    showingTerminal ? null : h('footer', { className: 'bt-seat-foot' }, seatSourceNote(seat)))
}

export const SEAT_CHAT_CSS = `
.bt-seat{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bt-main);color:var(--bt-ink)}
.bt-seat-empty{margin:auto;max-width:360px;padding:24px;text-align:center;font-size:13px;line-height:20px;color:var(--bt-ink-3)}
.bt-seat-head{flex:none;display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:.5px solid var(--bt-line);background:var(--bt-main)}
.bt-seat-back{flex:none;width:30px;height:30px;border-radius:50%;border:.5px solid var(--bt-line-2);background:var(--bt-card);color:var(--bt-ink-2);font-size:15px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.bt-seat-back:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-seat-who{flex:1;min-width:0}
.bt-seat-title{font:var(--bt-weight-title,600) 15px/21px var(--bt-head-font,var(--bt-font));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-seat-sub{font-size:12px;line-height:17px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-seat-head .lb-face{flex:none}
.bt-seat-why{flex:none;margin:0;padding:8px 20px 0;font-size:12px;line-height:18px;color:var(--bt-ink-3)}
.bt-seat-status{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:17px;color:var(--bt-ink-3);white-space:nowrap}
.bt-seat-status[data-status=needs]{color:var(--st-warn,var(--bt-ink))}
.bt-seat-status[data-status=error]{color:var(--st-bad-strong,var(--bt-danger))}
.bt-seat-status-mark{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.45}
.bt-seat-status-mark[data-status=working]{background:var(--bt-accent);opacity:1}
.bt-seat-status-mark[data-status=needs]{background:var(--st-warn,var(--bt-ink));opacity:1}
.bt-seat-status-mark[data-status=error]{background:var(--bt-danger);opacity:1}
.bt-seat-status-mark[data-status=off]{background:var(--bt-line-2);opacity:1}
.bt-seat-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.bt-seat-wait{flex:none;margin:14px 20px 0;padding:12px 14px;border-radius:16px;border:.5px solid color-mix(in srgb,var(--st-warn,var(--bt-ink)) 45%,var(--bt-line));background:color-mix(in srgb,var(--st-warn,var(--bt-ink)) 8%,var(--bt-card))}
.bt-seat-wait-head{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;line-height:18px}
.bt-seat-wait-dot{width:8px;height:8px;border-radius:50%;background:var(--st-warn,var(--bt-ink))}
.bt-seat-wait-line{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-seat-wait-options{margin:9px 0 0;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bt-seat-option{font-weight:600}
.bt-seat-wait-note{margin:9px 0 0;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-seat-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding:16px 20px 24px}
.bt-seat-userrow{display:flex;justify-content:flex-end}
.bt-seat-user{max-width:78%;padding:8px 13px;border-radius:16px;background:var(--bt-user);color:var(--bt-user-ink);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-seat-assistant{font-size:13px;line-height:20px;color:var(--bt-ink);max-width:88%}
.bt-seat-tool{display:flex;flex-direction:column;gap:2px;padding:8px 11px;border-radius:10px;border:.5px solid var(--bt-line);background:var(--bt-card)}
.bt-seat-tool-name{font-size:12px;line-height:17px;font-weight:600;color:var(--bt-ink-2)}
.bt-seat-tool-summary{font:11px/16px var(--bt-mono,ui-monospace,monospace);color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-seat-toolresult{max-width:88%}
.bt-seat-toolresult>summary{cursor:pointer;font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bt-seat-pre{margin:6px 0 0;padding:9px 11px;border-radius:10px;background:var(--bt-card);border:.5px solid var(--bt-line);font:11px/16px var(--bt-mono,ui-monospace,monospace);color:var(--bt-ink-2);white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}
.bt-seat-note{margin:0;font-size:12px;line-height:18px;color:var(--bt-ink-3)}
.bt-seat-loading{padding:16px 20px 0}
.bt-seat-error{margin:14px 20px 0;padding:9px 12px;border-radius:10px;border:.5px solid var(--bt-line);background:var(--bt-card);color:var(--st-bad-strong,var(--bt-danger));font-size:12px;line-height:18px}
.bt-seat-latest{position:absolute;right:22px;bottom:14px;padding:5px 11px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-glass-bg,var(--bt-card));color:var(--bt-ink-2);font:inherit;font-size:12px;cursor:pointer;box-shadow:var(--bt-glass-shadow,0 2px 8px rgba(0,0,0,.12))}
.bt-seat-foot{flex:none;padding:9px 20px 11px;border-top:.5px solid var(--bt-line);font-size:11px;line-height:16px;color:var(--bt-ink-3)}
@media (max-width:520px){.bt-seat-head{gap:8px;padding:10px 12px}.bt-seat-sub{display:none}}
`
