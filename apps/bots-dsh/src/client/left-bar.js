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
import { agentRowSessions } from './task-card.js'
import { ProjectRail } from './left-bar-rail.js'
import { TeamRows, drawBot } from './left-bar-team.js'
import { LEFT_BAR_SKIN } from './left-bar-css.js'

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
export function teamOf({ roster, order, status, marked = {}, current, now = Date.now() }) {
  const main = roster.byId?.[roster.mainBotId]
  const shown = key => key === current
  const unread = (id, key, own) => !shown(key) && (own || marked[id] === true)
  const bot = (item) => {
    const key = `bot:${item.id}`
    if (item.hidden && !shown(key) && !isMainOf(roster, item.id)) return null
    const seen = status.bots.get(item.id) ?? { status: 'idle', unread: false }
    // Channels hang under a Bot through other plugins (renderAfter), not as the bar's rows.
    return { ...item, channels: [], status: seen.status, unread: unread(item.id, key, seen.unread) }
  }
  const agent = (item) => {
    const tasks = item.kind === 'tasks'
    if (tasks && agentRowSessions(item, roster, now).length === 0) return null
    const seen = status.dsh.get(item.id) ?? { status: 'idle', unread: false }
    return { id: item.id, name: tasks ? t('Tasks') : item.name, dsh: tasks ? 'tasks' : 'agent', channels: [], status: seen.status, unread: unread(item.id, `bot:${item.id}`, seen.unread) }
  }
  const bots = [
    ...(main ? [bot(main)] : []),
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

// A DSH bot wears DSH's own mark, the tasks record its icon; a Bot its character.
const renderArt = (bot, size, state) => {
  if (bot.dsh === 'tasks') return h(TasksIcon, { size: Math.round(size * 0.72) })
  if (bot.dsh === 'agent') return h(BotMark, { bot: { id: bot.id }, look: DSH_LOOK, size })
  return drawBot(bot, size, state)
}

// What the "+" says while it makes nothing: a note beside it, closed by a press anywhere else,
// by Escape or by the "+" again.
function SpaceNote({ anchor, onClose }) {
  const ref = useRef(null)
  const [place, setPlace] = useState(null)
  useLayoutEffect(() => {
    const box = anchor.getBoundingClientRect()
    const room = window.innerWidth - box.right - 12
    setPlace(room >= 220 ? { left: box.right + 10, top: box.top } : { left: 12, top: box.bottom + 10 })
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
 * `menu(row, event)` its context menu, and `renderAfter(row)` draws what hangs under a row.
 */
export function LeftBar({ roster, order, marked, useSessions, useSessionStatus, useWork, actions, open, menu, renderAfter, tools, notice, foot, empty, collapse, onKeyDown }) {
  const shownId = useSessions(list => list.ids.find(id => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0) ?? '')
  const current = currentKey(roster, shownId)
  const status = useTeamStatus({ roster, useSessionStatus, useWork })
  const team = teamOf({ roster, order, status, marked, current })
  const currentId = current?.slice(current.indexOf(':') + 1)
  // A row marked unread clears once it is open, as today's rows do.
  useEffect(() => {
    if (currentId && marked?.[currentId] === true) actions.clearUnread(currentId)
  }, [currentId, marked?.[currentId]])
  const [note, setNote] = useState(null)
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
          h('span', { className: 'lb-brand' }, h(Wordmark, { height: 22 })),
          tools,
          h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Search'), title: t('Search'), onClick: () => actions.openPalette() }, h(SearchIcon)),
          h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon))),
        notice,
        team.bots.length === 0 && empty ? empty
          : h(TeamRows, { team, current, skin: LEFT_BAR_SKIN, renderArt, onOpen: open, onMenu: menu, renderAfter, label: t('Bot list') }),
        foot ? h('div', { className: 'lb-foot' }, foot) : null)),
    note ? h(SpaceNote, { anchor: note, onClose: () => setNote(null) }) : null)
}
