import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { OmniMark, Wordmark } from './logo.js'
import { currentPart } from './text.js'
import { PlusIcon, SearchIcon, TasksIcon } from './icons.js'
import { BotMark } from './mark.js'
import { DSH_LOOK } from './characters.js'
import { t } from './i18n.js'
import { openStops } from './stops.js'
import { isMainOf } from './sources.js'
import { botChannels, botChannelSource, useEntries } from './extend.js'
import { agentRowSessions } from './task-card.js'
import { ProjectRail } from './left-bar-rail.js'
import { TeamRows, drawBot } from './left-bar-team.js'
import { LEFT_BAR_SKIN } from './left-bar-css.js'
import { mock1540On } from './self-update-flag.js'

// A channel's glyph in its kind's shape, in one colour: colour in the bar only ever means a
// status, so the glyph says what kind of channel a row is. Anything unknown wears a chat bubble.
const CHANNEL_GLYPHS = {
  whatsapp: () => [
    h('path', { key: 'bubble', d: 'M12 3.8a8.2 8.2 0 0 0-7 12.5L3.8 20.2l4-1.1A8.2 8.2 0 1 0 12 3.8z' }),
    h('path', { key: 'phone', d: 'M9.3 8.4c-.3 0-.6.1-.8.4-.3.5-.5 1.1-.2 1.9.5 1.7 2.1 3.2 3.8 3.8.8.2 1.5.1 1.9-.2.3-.2.4-.5.4-.8l-.1-.4-1.4-.7-.8.9c-.9-.4-1.7-1.1-2.1-2l.9-.8-.7-1.5z' }),
  ],
  telegram: () => [
    h('path', { key: 'plane', d: 'M20.5 4.5 3.5 11.2l5.2 1.9 2 6.1 3-3.3 4.4 3.3z' }),
    h('path', { key: 'fold', d: 'M8.7 13.1 16.8 8' }),
  ],
  slack: () => [h('path', { key: 'hash', d: 'M9 4.5 7.5 19.5M16.5 4.5 15 19.5M4.5 9h15M3.5 15h15' })],
  discord: () => [
    h('path', { key: 'face', d: 'M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16V8A1.5 1.5 0 0 1 5 6.5z' }),
    h('path', { key: 'eyes', d: 'M9.5 10.5v1.5M14.5 10.5v1.5' }),
    h('path', { key: 'smile', d: 'M9.5 14.5c1.5 1 3.5 1 5 0' }),
  ],
  chat: () => [h('path', { key: 'bubble', d: 'M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8.5A1.5 1.5 0 0 1 19 17h-9l-4.5 3.5V17H5A1.5 1.5 0 0 1 3.5 15.5V7A1.5 1.5 0 0 1 5 5.5z' })],
}

/** A channel's glyph: its kind's shape, the chat bubble for any other kind. */
export function channelGlyph(channel) {
  const kind = String(channel?.kind ?? '')
  const shape = kind.startsWith('whatsapp') ? 'whatsapp' : Object.hasOwn(CHANNEL_GLYPHS, kind) ? kind : 'chat'
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, CHANNEL_GLYPHS[shape]())
}

// -------------------------------------------------------------------------
// The new left bar in the Bot team's sidebar (RFC 0022 (i), direction C on the themed ground):
// the rail of spaces, "This computer" first and then the "+", beside the Team list with one
// line per row and one status mark. Search, New, the update button and the account menu stay
// (the account menu is the shell's footer, under the list).
//
// Read, never run: every row comes from what the team already has (the roster, the Sessions'
// status, the work the host reports), and a press only opens what today's rows open. The "+"
// makes nothing yet: creating or joining a space comes with Automagik Cloud, and the "+" says
// so in a note. The Code side, sign-in and Cloud's own tiles are not part of this bar yet.

/** The one tile the rail has today: this computer, the local team. */
export const LOCAL_SPACE = 'local'

const pack = value => JSON.stringify(value)

// One status per Bot, as left-bar-status.js names them: what asks for the person first, then
// what failed, then what runs. Each source is picked as text, so the bar redraws only when a
// status changes.
export function botStatus({ question, pending, approval, failed, running, away }) {
  if (question || pending || approval) return 'needs'
  if (failed) return 'error'
  if (running || away) return 'working'
  return 'idle'
}

// The bar is narrow in the phone's drawer (DSH keeps it at 280): a status keeps its mark there,
// with its word in the tooltip and the accessible name, so the name on the row keeps the room.
const NARROW = 620
const NO_WORDS = Object.freeze([])
function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
    const read = () => setNarrow(window.innerWidth < NARROW)
    read()
    window.addEventListener('resize', read)
    return () => window.removeEventListener('resize', read)
  }, [])
  return narrow
}

function useTeamStatus({ roster, useSessionStatus, useWork }) {
  const parts = roster.bots.map(bot => [bot.id, currentPart(bot)])
  const agents = (roster.agents ?? []).map(agent => [agent.id, agent.sessions ?? []])
  const rooms = roster.rooms.map(room => [room.id, room.sessionId ?? room.id])
  const sessions = JSON.parse(useSessionStatus(map => pack({
    bots: parts.map(([id, part]) => {
      const status = map.get(part)
      return [id, status?.running === true, status?.pendingInteraction !== undefined, status?.completionUnread === true]
    }),
    agents: agents.map(([id, ids]) => [id, ids.some(sid => map.get(sid)?.running === true), ids.some(sid => map.get(sid)?.completionUnread === true)]),
    rooms: rooms.map(([id, sid]) => [id, map.get(sid)?.completionUnread === true]),
  })))
  // A group chat: an approval asked in it, or members at work in it.
  const roomWork = JSON.parse(useWork ? useWork(value => pack(rooms.map(([id]) => [
    id, (value.approvals ?? []).some(entry => entry.roomId === id), (value.rooms?.[id] ?? []).some(entry => entry.botId !== undefined),
  ]))) : '[]')
  const work = JSON.parse(useWork ? useWork(value => pack(parts.map(([id]) => [
    id,
    (value.approvals ?? []).some(entry => entry.botId === id) || openStops(value).some(entry => entry.botId === id),
    value.failed?.[id] !== undefined,
    Object.values(value.rooms ?? {}).some(entries => entries.some(entry => entry.botId === id)),
  ]))) : '[]')
  const byWork = new Map(work.map(([id, approval, failed, away]) => [id, { approval, failed, away }]))
  const bots = new Map(sessions.bots.map(([id, running, pending, unread]) => {
    const part = parts.find(([bot]) => bot === id)?.[1]
    const { approval = false, failed = false, away = false } = byWork.get(id) ?? {}
    return [id, { status: botStatus({ question: roster.questions?.[part] !== undefined, pending, approval, failed, running, away: away && !running }), unread }]
  }))
  const dsh = new Map(sessions.agents.map(([id, running, unread]) => [id, { status: running ? 'working' : 'idle', unread }]))
  const asked = new Map(roomWork.map(([id, approval, working]) => [id, approval ? 'needs' : working ? 'working' : 'idle']))
  const groups = new Map(sessions.rooms.map(([id, unread]) => [id, { status: asked.get(id) ?? 'idle', unread }]))
  return { bots, dsh, groups }
}

// The Session in the main view, as the key of the row that opens it.
function currentKey(roster, shownId) {
  if (!shownId) return undefined
  const bot = roster.bots.find(candidate => currentPart(candidate) === shownId || candidate.id === shownId)
  if (bot) return `bot:${bot.id}`
  const room = roster.rooms.find(candidate => (candidate.sessionId ?? candidate.id) === shownId || candidate.id === shownId)
  if (room) return `group:${room.id}`
  const agent = (roster.agents ?? []).find(candidate => (candidate.sessions ?? []).includes(shownId))
  return agent ? `bot:${agent.id}` : undefined
}

/**
 * The team as the Team rows read it (left-bar-team.js): the Main Bot first, then the Bots and
 * the DSH bots in today's order, then the group chats. `order` is the sidebar's own order of
 * everything but the Main Bot ({ kind: 'bot' | 'room' | 'agent', item }).
 */
export function teamOf({ roster, order, status, marked = {}, current, now = Date.now(), seats = [] }) {
  const main = roster.byId?.[roster.mainBotId]
  const shown = key => key === current
  const unread = (id, key, own) => !shown(key) && (own || marked[id] === true)
  const bot = (item) => {
    const key = `bot:${item.id}`
    if (item.hidden && !shown(key) && !isMainOf(roster, item.id)) return null
    const seen = status.bots.get(item.id) ?? { status: 'idle', unread: false }
    // A Bot's channels come from the one plugin that serves it (extend.js's botChannels): with
    // a source the bar draws them under its row, and while there is none the team's own
    // botChildren rows stay exactly as today. Never both.
    return { ...item, channels: item.channels ?? [], channelSource: botChannelSource(item), status: seen.status, unread: unread(item.id, key, seen.unread) }
  }
  const agent = (item) => {
    const tasks = item.kind === 'tasks'
    if (tasks && agentRowSessions(item, roster, now).length === 0) return null
    const seen = status.dsh.get(item.id) ?? { status: 'idle', unread: false }
    return { id: item.id, name: tasks ? t('Tasks') : item.name, dsh: tasks ? 'tasks' : 'agent', channels: [], status: seen.status, unread: unread(item.id, `bot:${item.id}`, seen.unread) }
  }
  // The seats on this computer are Team rows too (RFC 0022 (i)): each orchestrator as a chat.
  // They sit under the Main Bot, before the DSH Bots, and no row starts or stops anything.
  // `artId` is the registry Bot's own id, so the seat wears the same character and colour a
  // Bot row would (the row's id keeps the `seat:` prefix so a seat and a DSH Bot never collide).
  const seating = seats.map(seat => ({
    id: `seat:${seat.id}`, seat: true, artId: seat.id, name: seat.name, project: seat.project,
    terminal: seat.terminal, agent: seat.agent, chat: seat.chat, status: seat.status,
    channels: [], unread: false,
  }))
  const bots = [
    ...(main ? [bot(main)] : []),
    ...seating,
    ...order.filter(entry => entry.kind === 'bot').map(entry => bot(entry.item)),
    ...order.filter(entry => entry.kind === 'agent').map(entry => agent(entry.item)),
  ].filter(Boolean)
  const groups = order.filter(entry => entry.kind === 'room' && (!entry.item.hidden || shown(`group:${entry.item.id}`)))
    .map((entry) => {
      const seen = status.groups?.get(entry.item.id) ?? { status: 'idle', unread: false }
      return { id: entry.item.id, name: entry.item.name, members: entry.item.members ?? [], status: seen.status, unread: unread(entry.item.id, `group:${entry.item.id}`, seen.unread) }
    })
  return { frontId: main?.id, bots, groups }
}

// A seat with no registry Bot behind it has no character of its own: a plain pane glyph.
function SeatGlyph({ size }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { color: 'inherit', opacity: 0.62 } },
    h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
    h('path', { d: 'M7.5 9.5l3 2.7-3 2.7M13 15h3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
}

// A DSH bot wears DSH's own mark, the tasks record its icon; a Bot its character. A seat is a
// humanized Bot: it wears the registry Bot's own character and colour; the pane glyph is only
// for a seat with no Bot behind it.
export const renderArt = (bot, size, state) => {
  if (bot.seat) return bot.artId ? drawBot({ id: bot.artId, name: bot.name }, size, state) : h(SeatGlyph, { size: Math.round(size * 0.8) })
  if (bot.dsh === 'tasks') return h(TasksIcon, { size: Math.round(size * 0.72) })
  if (bot.dsh === 'agent') return h(BotMark, { bot: { id: bot.id }, look: DSH_LOOK, size })
  return drawBot(bot, size, state)
}

// What the "+" says while it makes nothing: a note under it, closed by a press anywhere else,
// by Escape or by the "+" again.
function SpaceNote({ anchor, onClose }) {
  const ref = useRef(null)
  const [place, setPlace] = useState(null)
  useLayoutEffect(() => {
    // Under the "+", from its left edge: the rows beside the rail, the open one among them, stay
    // in sight.
    const box = anchor.getBoundingClientRect()
    setPlace({ left: Math.max(8, box.left), top: box.bottom + 8 })
  }, [anchor])
  useEffect(() => {
    const away = (event) => {
      if (ref.current?.contains(event.target) || anchor.contains(event.target)) return
      onClose()
    }
    const key = (event) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [anchor, onClose])
  return createPortal(h('div', { ref, className: 'lb-note', role: 'status', style: place ?? { visibility: 'hidden' } },
    t('Creating or joining a space comes with Automagik Cloud. Nothing is made from here yet.')), document.body)
}

/**
 * The bar. `order` and the stores are the sidebar's (sidebar.js TeamSidebar); `tools` are the
 * head's other buttons (the update button, other plugins' tools); `notice` is a line above
 * the list (a read-only team, the Main Bot being set up); `foot` sits under the list (the Work
 * and Code switch, where the app has Herdr). `open(row)` opens a row as today's rows do,
 * `menu(row, event)` its context menu, `renderAfter(row)` draws what hangs under a row and
 * `renderEnd(row)` what other plugins add at the end of a Bot's row.
 *
 * The owner's new top row (Search and New, every other tool at the foot) is the approved
 * self-update mock's layout, so it sits behind the mock's own flag (`?mock-1540`, #1546): without
 * it the bar draws exactly what dev draws, with the wordmark and the tools up top.
 */
export function LeftBar({ roster, order, marked, seats = [], useSessions, useSessionStatus, useWork, actions, open, menu, renderAfter, renderEnd, tools, notice, foot, empty, collapse, onKeyDown }) {
  // Read at render time, so the flag turns the new layout on and off in a running page.
  const mock = mock1540On()
  const shownId = useSessions(list => list.ids.find(id => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0) ?? '')
  const current = currentKey(roster, shownId)
  const status = useTeamStatus({ roster, useSessionStatus, useWork })
  const team = teamOf({ roster, order, status, marked, current, seats })
  const currentId = current?.slice(current.indexOf(':') + 1)
  // A row marked unread clears once it is open, as today's rows do.
  useEffect(() => {
    if (currentId && marked?.[currentId] === true) actions.clearUnread(currentId)
  }, [currentId, marked?.[currentId]])
  const narrow = useNarrow()
  const [note, setNote] = useState(null)
  // Sources may load after the bar is up (a plugin's shell installer); draw their rows then.
  useEntries(botChannels)
  // A channel is unfolded by default once its chats are known; a person's fold is kept here. A
  // person unfolding one asks its Bot's chats to load, as opening the Bot's Session does.
  const [folded, setFolded] = useState(() => new Set())
  const [wanted, setWanted] = useState(() => new Set())
  const loads = id => current === `bot:${id}` || wanted.has(id)
  const fold = (row, next) => {
    const key = `${row.botId}/${row.id}`
    setFolded((before) => {
      const after = new Set(before)
      if (next) after.add(key)
      else after.delete(key)
      return after
    })
    if (!next) setWanted(before => (before.has(row.botId) ? before : new Set(before).add(row.botId)))
  }
  // A channel folds and unfolds here; every other row opens as today.
  const press = row => (row.kind === 'channel' ? fold(row, !row.folded) : open(row))
  const spaces = [{ id: LOCAL_SPACE, name: t('This computer'), icon: h(OmniMark, { size: 26 }) }]
  return h('div', { className: 'bt-side lb-host', onKeyDown },
    h('div', { className: 'lb-bar', 'data-lb-host': '', 'data-lb-skin': LEFT_BAR_SKIN },
      // The rail's column: the spaces, and at its foot the button that folds the bar (where the
      // shell shows no toggle of its own, as on the web: sidebar.js's rules decide).
      h('div', { className: 'lb-railcol' },
        h(ProjectRail, {
          projects: spaces, currentId: LOCAL_SPACE, addLabel: t('Create or join a space'), addExpanded: note !== null,
          onAdd: event => setNote(now => (now ? null : event.currentTarget)),
        }),
        collapse ?? null),
      h('div', { className: 'lb-list' },
        h('div', { className: 'lb-head' },
          // Without the flag: the wordmark and the tools, exactly where dev draws them. With it:
          // Search and New only, and the tools move to the foot below.
          mock ? null : h('span', { className: 'lb-brand' }, h(Wordmark, { height: 22 })),
          mock ? null : tools,
          h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Search'), title: t('Search'), onClick: () => actions.openPalette() }, h(SearchIcon)),
          h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon))),
        notice,
        team.bots.length === 0 && empty ? empty
          : h(TeamRows, { team, current, skin: LEFT_BAR_SKIN, renderArt, renderGlyph: channelGlyph, onOpen: press, onMenu: menu, renderAfter, renderEnd, folded, loads, worded: narrow ? NO_WORDS : undefined, label: t('Bot list') }),
        mock
          ? h('div', { className: 'lb-foot' }, tools, foot ?? null)
          : foot ? h('div', { className: 'lb-foot' }, foot) : null)),
    note ? h(SpaceNote, { anchor: note, onClose: () => setNote(null) }) : null)
}
