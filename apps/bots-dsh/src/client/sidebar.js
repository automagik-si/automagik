import { openStops } from './stops.js'
import { Component, createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Lockup, OmniMark, Wordmark } from './logo.js'
import { isMainOf } from './sources.js'
import { currentPart, previewOf, relativeShort } from './text.js'
import { PlusIcon, SearchIcon, SidebarIcon, GaugeIcon, PlugIcon, GearIcon, PinMarkIcon, ConnectorIcon, SwitchIcon, CloudDownloadIcon, TasksIcon, SignOutIcon } from './icons.js'
import { botState, BotAvatar, BotMark, RoomAvatar } from './mark.js'
import { DSH_LOOK } from './characters.js'
import { reducedMotion } from './activity-row.js'
import { Shimmer, workPhrase } from './cells.js'
import { springEasing, SPRING_SHAPE, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { showsDshRow } from './dsh-offer.js'
import { badges, botChildren, nav, sidebarTools, useEntries } from './extend.js'
import { agentRowSessions, approvalFor, endLabel, runningTasksOf, taskState, waitsForUser } from './task-card.js'
import { approvalCount, approvalDetail, useApproval } from './approvals.js'
import { WorkCodeSwitch } from './work-code-switch.js'
import { BotPills, pillLabels } from './capability-pills.js'

// -------------------------------------------------------------------------
// Sidebar

// Manual "Mark as Unread" lasts until the conversation is opened again.
function useMarkedUnread(id, active, marked, actions) {
  useEffect(() => {
    if (active && marked) actions.clearUnread(id)
  }, [active, marked])
}

const PinMark = () => h('span', { className: 'bt-pin', 'aria-hidden': true }, h(PinMarkIcon))

// Work running in group Sessions, as "botId|tool" keys so a row redraws only when it
// changes: the groups one Bot works in, or the members at work in one group.
// Picked as text, so a row redraws only when what it shows changes.
const useGroupWork = (useWork, pick) => (useWork ? useWork(work => JSON.stringify(pick(work.rooms ?? {}))) : '[]')
const workKeys = text => JSON.parse(text)
const doingOf = ({ tool, said, note, target, switching }) => ({ tool, said, note, target, switching })
const workLine = (lead, doing, more) => h(Shimmer, null, `${lead} · ${workPhrase(doing)}…${more > 0 ? ` +${more}` : ''}`)
// The row already names the Bot; its own-chat preview is just what it is doing.
const doingLine = doing => h(Shimmer, null, `${workPhrase(doing)}…`)
// The Bots and groups a Bot waits for (handoffs.js), by the names they have now.
const waitingFor = (roster, waits) => {
  const names = [...(waits?.bots ?? []).map(id => roster.byId[id]?.name), ...(waits?.rooms ?? []).map(id => roster.roomsById[id]?.name)].filter(Boolean)
  return names.length === 0 ? '' : t('Waiting for {names}', { names: names.join(t(' and ')) })
}

const waitingLabel = count => count === 1
  ? `${t('Waiting for your approval')} · ${t('1 approval waiting')}`
  : count > 0 ? t('{count} approvals waiting', { count }) : t('Waiting for your approval')

function BotRow({ bot, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useActivity, useWork, wide, marked }) {
  const id = bot.id
  const part = currentPart(bot)
  const preview = useSessions(list => previewOf(list, part, roster.exchangeTurns[part]))
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const active = useSessionRetainInfo(part, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(part)?.completionUnread === true || map.get(part)?.pendingInteraction !== undefined) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const main = isMainOf(roster, id)
  // The team's first Main Bot is pinned first and wears the crown, with its role beside its name.
  const crowned = roster.mainBotId === id
  const approval = useApproval(useWork, entry => entry.botId === id)
  const waitingCount = useWork ? useWork(work => approvalCount(work, e => e.botId === id)) : 0
  // A task this Bot started waits on the user: the row says so from the top level, even
  // while the Bot itself runs and would otherwise only preview its own turn.
  const blockedTask = useWork ? useWork(work => (work.approvals ?? []).some(entry => entry.taskId !== undefined && entry.botId === id)) : false
  const blockedLine = blockedTask ? t('A task needs your approval') : ''
  const stopped = useWork ? useWork(work => openStops(work).some(entry => entry.botId === id)) : false
  const stoppedLine = stopped ? t('A step stopped on a permission') : ''
  const alert = roster.questions?.[part] !== undefined || approval
  const doing = useActivity(map => map[id])
  // Work in a group runs in a Session of its own, so the Bot's chat stays idle meanwhile.
  const groups = workKeys(useGroupWork(useWork, rooms => Object.entries(rooms).flatMap(([roomId, entries]) => entries.filter(entry => entry.botId === id).map(entry => ({ id: roomId, ...doingOf(entry) })))))
  const away = !running && groups.length > 0
  const failed = useWork ? useWork(work => work.failed?.[id] !== undefined) : false
  const replied = useSessionStatus(map => map.get(part)?.completionUnread === true) && !active
  const state = botState(running || away, doing, alert, { failed, unread: replied })
  // A Bot running in its own chat previews what it is doing, like a group's row.
  const runningLine = running && doing ? doingLine(doing) : null
  const awayLine = away ? workLine(roster.roomsById[groups[0].id]?.name ?? t('a group chat'), groups[0], groups.length - 1) : null
  const waits = workKeys(useWork ? useWork(work => JSON.stringify(work.waiting?.[id] ?? null)) : 'null')
  const waitsFor = state === 'waiting' ? waitingFor(roster, waits) : ''
  // Tasks it started that still run hang under the row (BotThreads); the row says how many.
  const threads = runningTasksOf(roster, id).length
  const threadsLine = threads === 0 ? '' : threads === 1 ? t('Working on 1 thing') : t('Working on {n} things', { n: threads })
  if (bot.hidden && !active && !main) return null
  const onContextMenu = (event) => {
    event.preventDefault()
    actions.openMenu({ kind: 'bot', id, x: event.clientX, y: event.clientY })
  }
  const pinned = bot.pinned === true && !crowned
  const role = crowned ? bot.role : ''
  const label = [bot.name, role, main ? t('Main Bot') : '', ...pillLabels(roster, bot), pinned ? t('Pinned') : '', running || away ? t('Working') : '', waitsFor, stoppedLine, approval ? waitingLabel(waitingCount) : alert ? t('Waiting for your answer') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  return h('button', {
    type: 'button', className: crowned ? 'bt-row bt-row-crowned' : 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-bot-id': id, title: wide ? undefined : bot.name, onClick: () => actions.openSession(id), onContextMenu,
  },
  h(BotAvatar, { bot, size: crowned && wide ? 42 : 36, state, count: waitingCount, main, crown: crowned }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, bot.name), role ? h('span', { className: 'bt-role' }, role) : null, pinned ? h(PinMark) : null),
    // What to ask this Bot for, on a line of its own: the name line has no room for it.
    h(BotPills, { roster, bot, className: 'bt-row-caps' }),
    blockedLine || stoppedLine ? h('span', { className: 'bt-row-preview bt-row-preview-ask' }, blockedLine || stoppedLine)
      : runningLine ? h('span', { className: 'bt-row-preview' }, runningLine)
        : awayLine ? h('span', { className: 'bt-row-preview' }, awayLine)
          : waitsFor ? h('span', { className: 'bt-row-preview' }, waitsFor)
            : threadsLine ? h('span', { className: 'bt-row-preview' }, threadsLine)
              : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  // Badges other Omni plugins add (extend.js): Omni's row counts the automation runs waiting for you.
  wide ? h(RowBadges, { bot, roster, useWork }) : null,
  wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null)
}

// What other Omni plugins add at the end of a Bot's row (extend.js).
function RowBadges(props) {
  const entries = useEntries(badges)
  return entries.map(entry => h(entry.Component, { key: entry.id, ...props }))
}

// What other Omni plugins hang under a Bot's row (extend.js), in the wide sidebar only.
// They get the rows' own props: the session, status, activity and work stores, and the
// actions that fold the sidebar below 1024 px when a row opens.
function BotChildren({ wide, ...props }) {
  const entries = useEntries(botChildren)
  if (!wide || entries.length === 0) return null
  return entries.map(entry => h(entry.Component, { key: entry.id, ...props, wide }))
}

// A short age for a thread: now, 4m, 2h, 3d.
export function threadAge(ms, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return t('now')
  if (minutes < 60) return t('{n}m', { n: minutes })
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? t('{n}h', { n: hours }) : t('{n}d', { n: Math.floor(hours / 24) })
}

// Ticks once a minute while `on`, for the threads' ages.
function useMinute(on) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return undefined
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

// Past this many, a Bot's threads fold into a count.
export const THREADS_SHOWN = 3

// The tasks a Bot started (start_task, agents.js) while they run, as threads under its row
// in the wide sidebar: a spinner while one works, an amber dot while it waits for the user
// (its Session holds DSH's approval or question card, or an approval the host noted for
// it), with its title and age. Waiting ones
// come first; past THREADS_SHOWN the rest fold into a count. A thread opens its task.
function BotThreads({ bot, roster, actions, useSessions, useSessionStatus, useWork, wide }) {
  const tasks = runningTasksOf(roster, bot.id)
  const ids = tasks.map(task => task.sessionId)
  const askedKey = useSessionStatus(map => ids.filter(id => waitsForUser(map, id)).join(','))
  const approvalKey = useWork ? useWork(work => ids.filter(id => approvalFor(work, id)).join(',')) : ''
  const approvals = useWork ? useWork(work => work.approvals) : undefined
  const waitingKey = `${askedKey},${approvalKey}`
  const shownId = useSessions(list => ids.find(id => (list.byId[id]?.retainedBy?.mainView ?? 0) > 0) ?? '')
  const [open, setOpen] = useState(false)
  const now = useMinute(wide && tasks.length > 0)
  if (!wide || tasks.length === 0) return null
  const waiting = new Set(waitingKey.split(',').filter(Boolean))
  const sorted = [...tasks].sort((a, b) => Number(waiting.has(b.sessionId)) - Number(waiting.has(a.sessionId)))
  const shown = open || sorted.length <= THREADS_SHOWN + 1 ? sorted : sorted.slice(0, THREADS_SHOWN)
  const more = sorted.length - shown.length
  return h('div', { className: 'bt-threads', role: 'group', 'aria-label': t('Tasks {name} started', { name: bot.name }) },
    shown.map((task) => {
      const state = taskState(task, waiting.has(task.sessionId))
      const asks = state === 'waiting' ? (approvals ?? []).filter(entry => entry.taskId === task.sessionId) : []
      const detail = asks.length === 1 ? approvalDetail(asks[0]) : ''
      const label = [task.title, state === 'waiting' ? t('Waiting for you') : t('Working'), detail].filter(Boolean).join(', ')
      return h('button', {
        key: task.sessionId, type: 'button', className: 'bt-thread', 'data-state': state, 'aria-label': label, title: detail ? `${task.title} · ${detail}` : task.title,
        'aria-current': shownId === task.sessionId ? 'page' : undefined,
        onClick: () => actions.openSession(task.sessionId),
      },
      h('span', { className: state === 'waiting' ? 'bt-thread-wait' : 'bt-thread-spin', 'aria-hidden': true }),
      h('span', { className: 'bt-thread-title' }, task.title),
      h('span', { className: 'bt-thread-age', 'aria-hidden': true }, threadAge(task.at ?? now, now)))
    }),
    more > 0 ? h('button', { type: 'button', className: 'bt-thread bt-thread-more', onClick: () => setOpen(true) }, t('+{n} more', { n: more })) : null)
}

function RoomRow({ room, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useWork, wide, marked }) {
  const id = room.id
  const fallback = useSessions(list => previewOf(list, id))
  const preview = room.preview?.replace(/\s+/g, ' ').trim() || fallback
  const active = useSessionRetainInfo(id, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(id)?.completionUnread === true) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const approval = useApproval(useWork, entry => entry.roomId === id)
  const waitingCount = useWork ? useWork(work => approvalCount(work, entry => entry.roomId === id)) : 0
  const members = workKeys(useGroupWork(useWork, rooms => (rooms[id] ?? []).map(entry => ({ id: entry.botId, ...doingOf(entry) }))))
  const first = roster.byId[members[0]?.id]
  const workingLine = first ? workLine(first.name, members[0], members.length - 1) : null
  if (room.hidden && !active) return null
  const pinned = room.pinned === true
  const label = [room.name, pinned ? t('Pinned') : '', members.length > 0 ? t('Working') : '', approval ? waitingLabel(waitingCount) : ''].filter(Boolean).join(', ')
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-room-id': id, onClick: () => actions.openSession(id),
    onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'room', id, x: event.clientX, y: event.clientY }) },
  },
  h(RoomAvatar, { room, roster, size: 36 }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, room.name), waitingCount > 0 ? h('span', { className: 'bt-tag' }, String(waitingCount)) : null, pinned ? h(PinMark) : null),
    workingLine ? h('span', { className: 'bt-row-preview' }, workingLine) : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && approval && !active ? h('span', { className: 'bt-unread bt-unread-wait', 'aria-hidden': true })
    : wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null)
}

// One expanded DSH bot Session row: title, relative stamp, rename field, and a
// context menu for rename/archive.
function AgentSessionRow({ session, agent, actions, renaming, index }) {
  const input = useRef(null)
  useLayoutEffect(() => {
    if (!renaming) return
    input.current?.focus()
    input.current?.select()
  }, [renaming])
  if (renaming) {
    const commit = (keep) => {
      const value = input.current?.value ?? ''
      if (!keep || value.trim() === '' || value.trim() === session.title) { actions.endAgentRename(); return }
      // The editor closes only after the rename landed; a failure keeps it open.
      void (async () => {
        try {
          await actions.renameAgentSession(agent.id, session.id, value)
          actions.endAgentRename()
        } catch (error) {
          actions.reportError(error, 'agent-rename')
        }
      })()
    }
    return h('div', { className: 'bt-agent-sub-row bt-agent-edit', style: { '--i': index } },
      h('input', {
        ref: input, defaultValue: session.title, 'aria-label': t('Rename'),
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') commit(true)
          else if (event.key === 'Escape') commit(false)
        },
        onBlur: () => commit(true),
      }))
  }
  return h('button', {
    type: 'button', className: 'bt-agent-sub-row', 'aria-current': session.active ? 'page' : undefined, style: { '--i': index },
    onClick: () => actions.openAgentSession(session.id),
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      actions.openMenu({ kind: 'agent-session', id: session.id, agentId: agent.id, x: event.clientX, y: event.clientY })
    },
  },
  h('span', { className: 'bt-agent-sub-title' }, session.title),
  h('span', { className: 'bt-agent-sub-time' }, [session.ended, session.at > 0 ? relativeShort(session.at) : ''].filter(Boolean).join(' · ')))
}

// A DSH bot's row: its plain dsh Sessions, under the Bots with a terminal mark. The tasks
// record has a row only while it keeps a Session no other list shows (agentRowSessions);
// the minute's tick moves a task here as the Live rail lets go of it.
function AgentRow({ agent, roster, actions, useSessions, useSessionStatus, useUi, wide, marked }) {
  const tasks = agent.kind === 'tasks'
  const own = agentRowSessions(agent, roster, useMinute(tasks))
  const name = tasks ? t('Tasks') : agent.name
  const info = useSessions(list => JSON.stringify(own.map((id) => {
    const row = list.byId[id]
    return {
      id,
      // A blank Session's title is the workspace folder name; show the label instead.
      title: row?.blank === true ? '' : (row?.displayTitle ?? row?.title ?? ''),
      at: row?.updatedAt ?? 0,
      running: row?.running === true,
      active: (row?.retainedBy?.mainView ?? 0) > 0,
    }
  }).sort((a, b) => b.at - a.at)))
  const statusInfo = useSessionStatus(map => JSON.stringify(own.map(id => ({
    id, running: map.get(id)?.running === true, unread: map.get(id)?.completionUnread === true,
  }))))
  const statuses = Object.fromEntries(JSON.parse(statusInfo).map(entry => [entry.id, entry]))
  const sessions = JSON.parse(info).map((session) => {
    // A task's record says what its Session cannot: its title, and how it ended.
    const task = tasks ? roster.tasks?.[session.id] : undefined
    return {
      ...session,
      running: statuses[session.id]?.running ?? session.running,
      unread: statuses[session.id]?.unread ?? false,
      title: session.title === '' ? task?.title ?? t('New session') : session.title,
      ended: task === undefined || task.status === 'working' ? undefined : endLabel({ status: task.status }),
    }
  })
  const renaming = useUi(value => value.renameAgent)
  const active = sessions.some(session => session.active)
  const running = sessions.some(session => session.running)
  const unread = sessions.some(session => session.unread) || (marked && !active)
  useMarkedUnread(agent.id, active, marked, actions)
  if (tasks && own.length === 0) return null
  const preview = sessions[0]?.title ?? t('New session')
  const label = [name, running ? t('Working') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  const open = active && wide
  // Only a DSH bot makes new Sessions; tasks come from the Bots.
  const first = tasks ? 0 : 1
  return h('div', { className: 'bt-agent' },
    h('button', {
      type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-agent-id': agent.id, title: wide ? undefined : name, onClick: () => actions.openAgent(agent.id),
      onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'agent', id: agent.id, x: event.clientX, y: event.clientY }) },
    },
    h('span', { className: `bt-agent-ava${running ? ' bt-run' : ''}` }, tasks ? h(TasksIcon, { size: 20 }) : h(BotMark, { bot: { id: agent.id }, look: DSH_LOOK, size: 26 })),
    wide ? h('span', { className: 'bt-row-body' },
      h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, name), agent.pinned ? h(PinMark) : null),
      preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
    wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true }) : null),
    h('div', { className: 'bt-agent-sub', 'data-open': open || undefined },
      h('div', { className: 'bt-agent-sub-in' },
        tasks ? null : h('button', { type: 'button', className: 'bt-agent-sub-row bt-agent-new', style: { '--i': 0 }, onClick: () => { void actions.newAgentSession(agent.id).catch(error => actions.reportError(error, 'agent-session')) } },
          h(PlusIcon), h('span', { className: 'bt-agent-sub-title' }, t('New session'))),
        sessions.map((session, index) => h(AgentSessionRow, {
          key: session.id, session, agent, actions, index: index + first,
          renaming: renaming === session.id,
        })))))
}

// List rows glide to new places on a spring.
const GLIDE = springEasing(1000, 63)

function useListGlide(listRef, layout, key) {
  const tops = useRef({ layout, map: new Map() })
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const next = new Map()
    const still = reducedMotion() || tops.current.layout !== layout
    for (const row of list.querySelectorAll('[data-bot-id],[data-room-id],[data-agent-id]')) {
      const id = row.dataset.botId ?? row.dataset.roomId ?? row.dataset.agentId
      // offsetTop ignores transforms, so a glide in flight does not skew the next one.
      const top = row.offsetTop
      next.set(id, top)
      const before = tops.current.map.get(id)
      if (!still && before !== undefined && Math.abs(before - top) > 0.5) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], GLIDE)
      }
    }
    tops.current = { layout, map: next }
  }, [layout, key])
}

export function TeamSidebar(props) {
  const { wide, expandSidebar, useRoster, useUi, useSessions, actions } = props
  const listRef = useRef(null)
  const closing = useRef(false)
  useLayoutEffect(() => { closing.current = false })
  const roster = useRoster(value => value)
  const markedUnread = useUi(value => value.unread)
  props.useRegistry(value => value)
  const updated = useSessions(list => {
    const stamps = {}
    for (const id of list.ids) stamps[id] = list.byId[id]?.updatedAt ?? 0
    return JSON.stringify(stamps)
  })
  const order = useMemo(() => {
    const stamps = JSON.parse(updated)
    const entries = [
      ...roster.bots.filter(bot => bot.id !== roster.mainBotId).map(bot => ({ kind: 'bot', item: bot, at: stamps[currentPart(bot)] ?? bot.createdAt })),
      ...roster.rooms.map(room => ({ kind: 'room', item: room, at: stamps[room.id] ?? room.createdAt })),
      // The Agent sorts by its most recent Session, falling back to when it was added.
      ...(roster.agents ?? []).map(agent => ({ kind: 'agent', item: agent, at: Math.max(0, ...agent.sessions.map(id => stamps[id] ?? 0)) || agent.createdAt })),
    ]
    // The team members other plugins brought (the Omni Bot) sit right under the Main Bot;
    // the DSH bots, outside the Bot layer, stay at the bottom, under every Bot and group.
    const rank = entry => (entry.kind === 'agent' ? 2 : entry.kind === 'bot' && entry.item.kind !== undefined ? 0 : 1)
    return entries.sort((a, b) => rank(a) - rank(b) || Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || b.at - a.at)
  }, [roster, updated])
  const main = roster.byId[roster.mainBotId]
  useListGlide(listRef, wide, order.map(entry => entry.item.id).join(','))
  useLandOnMainBot(roster, useSessions, actions)
  // The shell keeps wide content during its collapse fade. Normalize through its
  // public expansion action before toggling; coalesce synchronous activations
  // until React commits the result.
  const navigate = (open, id) => {
    const result = open(id)
    if (wide && window.innerWidth < 1024 && !closing.current) {
      closing.current = true
      expandSidebar?.()
      actions.toggleSidebar()
    }
    return result
  }
  const rowActions = {
    ...actions,
    openSession: id => navigate(actions.openSession, id),
    openAgent: id => navigate(actions.openAgent, id),
    openAgentSession: id => navigate(actions.openAgentSession, id),
    newAgentSession: id => navigate(actions.newAgentSession, id),
  }
  const rowProps = { roster, actions: rowActions, useSessions, useUi, useSessionStatus: props.useSessionStatus, useSessionRetainInfo: props.useSessionRetainInfo, useActivity: props.useActivity, useWork: props.useWork, wide }
  // Typing while the sidebar has focus starts a search.
  const typeToSearch = (event) => {
    if (event.defaultPrevented || event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]')) return
    event.preventDefault()
    actions.openPalette(event.key)
  }
  const toolProps = { wide, roster, actions: rowActions, useRoster }
  return h('div', { className: wide ? 'bt-side' : 'bt-side bt-rail', onKeyDown: typeToSearch },
    wide ? h('div', { className: 'bt-side-top' },
      h('span', { className: 'bt-brand' }, h(Lockup, { height: 21 })),
      h(WorkCodeSwitch, { roster, useSessions }),
      h(UpdateButton, { useUpdate: props.useUpdate, actions }),
      h(SidebarTools, toolProps),
      h('button', { type: 'button', className: 'bt-round', 'aria-label': t('Search'), title: t('Search'), onClick: () => actions.openPalette() }, h(SearchIcon)),
      h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon)),
      h('button', { type: 'button', className: 'bt-round bt-side-collapse', 'aria-label': t('Collapse sidebar'), title: t('Collapse sidebar'), onClick: () => actions.toggleSidebar() }, h(SidebarIcon)))
      : h(Fragment, null,
          h(UpdateButton, { useUpdate: props.useUpdate, actions }),
          h(SidebarTools, toolProps),
          h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon))),
    wide && roster.readOnly ? h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly)) : null,
    h('div', { ref: listRef, className: 'bt-list', role: 'region', 'aria-label': t('Bot list') },
      // The first Main Bot is a row like the others, pinned first (the tile's styles stay
      // in styles.js, vendored from DS Bot, unused).
      main ? h(Fragment, { key: main.id },
        h(BotRow, { ...rowProps, bot: main, marked: markedUnread[main.id] === true }),
        h(BotThreads, { ...rowProps, bot: main }),
        h(BotChildren, { ...rowProps, bot: main })) : roster.ready ? null : h('div', { className: 'bt-hint' }, t('Setting up your Main Bot…')),
      order.map(entry => (entry.kind === 'bot'
        ? h(Fragment, { key: entry.item.id },
            h(BotRow, { ...rowProps, bot: entry.item, marked: markedUnread[entry.item.id] === true }),
            h(BotThreads, { ...rowProps, bot: entry.item }),
            h(BotChildren, { ...rowProps, bot: entry.item }))
        : entry.kind === 'room'
          ? h(RoomRow, { key: entry.item.id, ...rowProps, room: entry.item, marked: markedUnread[entry.item.id] === true })
          : h(AgentRow, { key: entry.item.id, ...rowProps, agent: entry.item, marked: markedUnread[entry.item.id] === true })))))
}

// Other plugins' buttons in the top row and the rail (extend.js sidebarTools). Each is drawn on
// its own: one that throws draws nothing, and the row around it stays.
let ToolBoundary = null
const toolBoundary = () => (ToolBoundary ??= class SidebarTool extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error) { console.warn('[ds-bot] sidebar tool', this.props.entry.id, error) }

  render() { return this.state.failed ? null : h(this.props.entry.Component, this.props.tool) }
})

function SidebarTools(props) {
  const entries = useEntries(sidebarTools)
  return entries.map(entry => h(toolBoundary(), { key: entry.id, entry, tool: props }))
}

// The update button at the sidebar's top right: a cloud while a newer Omni —
// or a newer verified DSH — is available, then the install's progress and
// result. Its card has one row each for the bot and DSH, with their versions,
// the release notes link, and each row's own button.
function UpdateButton({ useUpdate, actions }) {
  const update = useUpdate(value => value)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const [error, setError] = useState('')
  const [dshError, setDshError] = useState('')
  const button = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-update-pop') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const phase = update?.phase ?? 'idle'
  const dsh = update?.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  const dshRow = showsDshRow(dsh, update?.app)
  // Hooks first: an update that turns visible after the sidebar mounted would
  // otherwise add hooks on a later render and crash the slot.
  const tick = useViewport()
  useLayoutEffect(() => {
    if (!open) return
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.bottom + 6 })
  }, [open, tick])
  if (!update?.available && !dshRow && phase === 'idle' && dshPhase === 'idle') return null
  const cloudPhase = phase === 'installing' || dshPhase === 'installing' ? 'installing' : phase !== 'idle' ? phase : dshPhase
  const toggle = () => setOpen(value => !value)
  const start = () => {
    setError('')
    void actions.installUpdate().catch(failure => setError(hostText(failure?.message ?? String(failure))))
  }
  const startDsh = () => {
    setDshError('')
    void actions.installDshUpdate().catch(failure => setDshError(hostText(failure?.message ?? String(failure))))
  }
  const label = phase === 'installing' ? t('Updating Omni…')
    : dshPhase === 'installing' ? t('Updating DSH…')
      : phase === 'installed' ? t('Omni {version} is installed. Restart DSH to use it.', { version: update.installed ?? update.latest })
        : phase === 'updated' ? t('Omni {version} is installed.', { version: update.installed ?? update.latest })
        : dshPhase === 'installed' ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
          : update?.available ? t('Omni {version} is available', { version: update.latest })
            : t('DSH {version} is available', { version: dsh?.verified })
  const message = error || (phase === 'failed' ? update.error : '')
  const dshMessage = dshError || (dshPhase === 'failed' ? dsh?.error : '')
  const dshText = dshPhase === 'installed'
    ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
    : dsh?.available === false && dsh?.blockedBy
      ? t('Update Omni {version} first.', { version: dsh.blockedBy })
      : t('You have {version}.', { version: dsh?.current })
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-round bt-update', 'data-phase': cloudPhase, 'aria-label': label, title: label,
      'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle,
    }, h(CloudDownloadIcon, { done: phase === 'installed' || phase === 'updated' }), phase === 'failed' || dshPhase === 'failed' ? h('span', { className: 'bt-update-dot', 'aria-hidden': true }) : null),
    open && box ? createPortal(h('div', { className: 'bt-update-pop', role: 'dialog', 'aria-label': update?.available || phase !== 'idle' ? t('Omni update') : t('DSH update'), style: box },
      update?.available || phase !== 'idle' ? h(Fragment, null,
        h('div', { className: 'bt-update-title' }, phase === 'installed' || phase === 'updated' ? t('Update installed') : t('Omni {version}', { version: update.latest })),
        h('div', { className: 'bt-update-text' }, phase === 'installed'
          ? t('Restart DSH to start using Omni {version}.', { version: update.installed ?? update.latest })
          : phase === 'updated' ? t('Omni {version} is installed.', { version: update.installed ?? update.latest })
            : t('You have {version}.', { version: update.current })),
        message ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: message })) : null,
        h('div', { className: 'bt-update-actions' },
          update.notesUrl ? h('a', { className: 'bt-update-notes', href: update.notesUrl, target: '_blank', rel: 'noopener noreferrer' }, t("What's new")) : null,
          phase === 'installed' || phase === 'updated' ? null : h('button', {
            type: 'button', className: 'bt-update-go', disabled: phase === 'installing', onClick: start,
          }, phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update')))) : null,
      dshRow ? h('div', { className: 'bt-update-dsh' },
        h('div', { className: 'bt-update-title' }, t('DSH {version}', { version: dsh.verified })),
        h('div', { className: 'bt-update-text' }, dshText),
        dshMessage ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: dshMessage })) : null,
        h('div', { className: 'bt-update-actions' },
          dsh.kind === 'app' ? (dsh.available
            ? h('button', { type: 'button', className: 'bt-update-go', onClick: () => void actions.openAppUpdates(dsh.verified).catch(() => {}) }, t('Open updates'))
            : null)
            : !dsh.available && dshPhase === 'idle' ? null
              : dshPhase === 'installed' ? null
                : h('button', {
                  type: 'button', className: 'bt-update-go', disabled: dshPhase === 'installing', onClick: startDsh,
                }, dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update')))) : null), document.body) : null)
}

// Where the channels went: a team linked to an Omni whose DSH lacks the Omni channels
// plugin (the host's channelsMoved) is pointed at the plugin market, in the footer seat the
// channels had.
export function ChannelsMoved({ wide, actions, useRoster }) {
  const moved = useRoster(value => value.channelsMoved === true)
  if (!wide || !moved) return null
  const label = t('Channels moved to the Omni channels plugin. Install it from the market.')
  return h('span', { className: 'bt-connect-wrap' }, h('button', { type: 'button', className: 'bt-connect bt-connect-foot bt-channels-moved', title: label, 'aria-label': label, onClick: () => actions.selectPanel('plugins') },
    h(PlugIcon), t('Get the channels plugin')))
}

// Account seat of the Settings trigger: the visible label stays for assistive tech only.
export function YouAvatar() {
  return h('span', { className: 'bt-you-wrap' },
    h('span', { className: 'bt-you', 'aria-hidden': true }, h(OmniMark, { size: 22 })),
    h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, t('Settings')))
}

let openShellSettings = null
let openShellOnboarding = null
let shellShortcuts = null

export function holdShellShortcuts(shortcuts) {
  shellShortcuts = shortcuts
  return () => { if (shellShortcuts === shortcuts) shellShortcuts = null }
}

// DeepSeek Harness hands its settings opener only to the settings.launcher seat. When
// the Desktop's account menu holds that seat, its first item (Settings) is the way in;
// the Desktop on Windows and macOS takes shortcuts natively, so a synthetic key press
// reaches the shell only where the page delivers them (the Web, Linux).
export function openHarnessSettings() {
  // A frame first, so a Bot dialog that closes on this click leaves the modal stack.
  requestAnimationFrame(() => {
    if (openShellSettings) { openShellSettings(); return }
    const desktop = document.querySelector('button[aria-haspopup="menu"][data-signed-out]')
    if (desktop) openThroughMenu(desktop)
    else pressSettingsShortcut()
  })
}

// Opens one of the shell's own onboarding editors, such as the DeepSeek API key form.
export function openHarnessOnboarding(id) {
  requestAnimationFrame(() => {
    if (openShellOnboarding) openShellOnboarding(id)
    else openHarnessSettings()
  })
}

function openThroughMenu(trigger) {
  const before = new Set(document.querySelectorAll('[role="menu"]'))
  trigger.click()
  let frames = 0
  const look = () => {
    const menu = [...document.querySelectorAll('[role="menu"]')].find(node => !before.has(node))
    const item = menu?.querySelector('button[role="menuitem"]')
    if (item) item.click()
    else if (++frames < 30) requestAnimationFrame(look)
    else pressSettingsShortcut()
  }
  requestAnimationFrame(look)
}

function pressSettingsShortcut() {
  const binding = shellShortcuts?.catalog.getSnapshot().find(row => row.id === 'settings.open')?.binding
  if (!binding) return
  const held = new Set(binding.modifiers)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    code: binding.code, key: binding.code === 'Comma' ? ',' : '', bubbles: true, cancelable: true,
    ctrlKey: held.has('control'), altKey: held.has('alt'), shiftKey: held.has('shift'), metaKey: held.has('meta'),
  }))
}

const NO_SUBSCRIBE = () => () => {}
const NO_SNAPSHOT = () => null

// The footer avatar opens an account menu above itself, with Bot settings as one
// entry. Shell panels hidden from the Bot sidebar (plugins, automation) live here too.
// `seat` is the shell's settings.launcher seat: at priority -10 the whale wins it
// over a shell account plugin's own launcher (the Desktop's "··· More"), which comes
// back in Agent mode; FooterAccount stands in while no seat exists at all.
export function AccountLauncher({ seat = true, settingsOpen, openSettings, openOnboarding, actions }) {
  const [open, setOpen] = useState(false)
  const navRows = useEntries(nav)
  useLayoutEffect(() => {
    if (!seat) return undefined
    actions.seatAccount(true)
    return () => actions.seatAccount(false)
  }, [seat])
  const [box, setBox] = useState(null)
  const button = useRef(null)
  useEffect(() => { if (settingsOpen) setOpen(false) }, [settingsOpen])
  // The settings dialog links back to the shell's own settings (models, providers).
  useEffect(() => {
    if (!openSettings) return undefined
    openShellSettings = openSettings
    return () => { if (openShellSettings === openSettings) openShellSettings = null }
  }, [openSettings])
  useEffect(() => {
    if (!openOnboarding) return undefined
    openShellOnboarding = openOnboarding
    return () => { if (openShellOnboarding === openOnboarding) openShellOnboarding = null }
  }, [openOnboarding])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-account-menu') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // The shell's account plugin lends its sign-out operation; the item shows only
  // when the plugin's entry is there and its account snapshot says signed in. The
  // entry can arrive after this mounts, so its operations follow the entry.
  const signIn = actions.signInEntry?.() ?? null
  const ops = useMemo(() => signIn?.inject?.() ?? {}, [signIn])
  const accountSource = ops.hooks?.account
  const account = useSyncExternalStore(accountSource?.subscribe ?? NO_SUBSCRIBE, accountSource ? () => accountSource.getSnapshot() : NO_SNAPSHOT)
  const signedIn = signIn !== null && typeof ops.signOut === 'function' && account?.view?.status === 'credential-stored'
  const accountT = actions.accountT?.() ?? (key => key)
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const askSignOut = async () => {
    setSignOutError('')
    let state = 'none'
    try {
      if (await ops.hasRunningAccountTasks?.()) state = 'running'
    } catch { state = 'unknown' }
    setConfirm(state)
  }
  const cancelSignOut = () => { setConfirm(null); setSignOutError('') }
  const runSignOut = async () => {
    setBusy(true)
    setSignOutError('')
    try {
      await ops.signOut()
      setConfirm(null)
      setOpen(false)
    } catch (error) {
      setSignOutError(String(error?.message ?? error))
    } finally {
      setBusy(false)
    }
  }
  const tick = useViewport()
  const anchor = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: rect.left, bottom: viewBottom() - rect.top + 5 })
  }
  useLayoutEffect(() => { if (open) anchor() }, [open, tick])
  const toggle = () => { if (!open) anchor(); setOpen(value => !value) }
  // Closing the menu drops a half-finished sign-out confirm with it.
  useEffect(() => {
    if (open) return
    setConfirm(null)
    setSignOutError('')
    setBusy(false)
  }, [open])
  const groups = [
    [
      [t('Usage'), GaugeIcon, () => actions.openSettings('usage')],
      [t('Plugins'), PlugIcon, () => actions.selectPanel('plugins')],
      [t('Connectors'), ConnectorIcon, () => actions.openConnectors()],
      // Rows other Omni plugins add (extend.js), such as Automations.
      ...navRows.map(row => [row.label(), row.icon, () => row.run(actions)]),
      [t('Bot settings'), GearIcon, () => actions.openSettings('general')],
    ],
    [
      [t('Switch to classic Agent mode'), SwitchIcon, () => actions.setSurface('agent')],
    ],
  ]
  if (signedIn) groups.push([[accountT('signOut'), SignOutIcon, askSignOut, undefined, true]])
  return h(Fragment, null,
    h('button', { ref: button, type: 'button', className: 'bt-account', 'aria-label': t('Account'), 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: toggle },
      h('span', { className: 'bt-you', 'aria-hidden': true }, h(OmniMark, { size: 22 }))),
    open && box ? createPortal(h('div', { className: 'bt-menu bt-menu-up bt-account-menu', role: 'menu', 'aria-label': t('Account'), style: box },
      confirm !== null ? h('div', { className: 'bt-confirm', role: 'alertdialog', 'aria-label': accountT('signOut') },
        h('p', { className: 'bt-confirm-text' }, accountT(confirm === 'running' ? 'signOutRunningDescription' : confirm === 'unknown' ? 'signOutUnknownDescription' : 'signOutDescription')),
        signOutError !== '' ? h('p', { className: 'bt-confirm-error', role: 'alert' }, signOutError) : null,
        h('div', { className: 'bt-confirm-row' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: cancelSignOut }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-confirm-go', disabled: busy, onClick: () => { void runSignOut() } }, accountT('signOut'))))
        : groups.map((group, index) => h(Fragment, { key: index },
          index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
          group.map(([label, Icon, run, hint, stay]) => h('button', {
            key: label, type: 'button', role: 'menuitem',
            onClick: () => { if (stay !== true) setOpen(false); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
          }, h(Icon), h('span', { className: 'bt-menu-label' }, label), hint ? h('span', { className: 'bt-menu-hint' }, hint) : null))))), document.body) : null)
}

// Opens the Main Bot whenever the main view holds no Bot conversation, the way
// The view always lands on a Bot rather than an empty New Session page.
// When a Bot's chat moves on to a fresh part, the shell clears the view of the part
// it archived; the chat then goes on in the Bot's current part instead.
/**
 * Whether a main view that holds no Bot stays put: a group, a DSH Agent Session (blank or
 * not), a Session with a turn, or a Session opened on purpose through `actions.openSession`.
 * A plugin's Session can be blank until its first turn (an Omni chat thread), and a click
 * that opens it must not bounce back to the Main Bot.
 */
export function staysInView(id, blank, roster, actions) {
  if (id === '') return false
  return Boolean(roster.roomsById[id]) || actions.ownershipPending?.(id) === true || (actions.isAgentSession?.(id) ?? roster.agentOf[id] !== undefined) || !blank || actions.openedOnPurpose?.(id) === true
}

function useLandOnMainBot(roster, useSessions, actions) {
  const mainView = useSessions((list) => {
    const row = Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)
    return row ? `${row.id}|${row.blank ? 1 : 0}` : ''
  })
  const lastBot = useRef(null)
  useEffect(() => {
    if (!roster.ready || !roster.mainBotId) return undefined
    const [id, blank] = mainView.split('|')
    const bot = id === '' ? undefined : roster.byId[id]
    if (bot !== undefined) {
      lastBot.current = { botId: bot.id, sessionId: id }
      if (currentPart(bot) !== id && actions.ownershipPending?.(id) !== true) actions.landOn(bot.id, undefined, id)
      return undefined
    }
    if (staysInView(id, blank === '1', roster, actions)) {
      lastBot.current = null
      return undefined
    }
    const last = lastBot.current
    const timer = setTimeout(() => {
      if (!staysInView(id, blank === '1', roster, actions)) void actions.landOn(roster.mainBotId, last, id || null)
    }, last ? 0 : 400)
    return () => clearTimeout(timer)
  }, [mainView, roster])
}

export function FooterAccount(props) {
  const seated = props.useUi(value => value.accountSeated === true)
  if (seated) return null
  return h('span', { className: 'bt-foot-account' }, h(AccountLauncher, { ...props, seat: false }))
}

// The only entry registered in every mode: in Agent mode the whole Bot surface is
// withdrawn, and this button in the shell's own footer is the way back. It carries the
// app's mark, so the name beside it is the app's, Automagik (#1160): Omni is one of its Bots.
export function BotReturn({ wide, useSurface, actions }) {
  const mode = useSurface(value => value.mode)
  if (mode !== 'agent') return null
  return h('button', { type: 'button', className: 'bt-return', 'aria-label': t('Back to Automagik'), title: t('Back to Automagik'), onClick: () => actions.setSurface('bot') },
    h(OmniMark, { size: 20 }),
    wide ? h('span', { className: 'bt-return-name' }, t('Automagik')) : null)
}

// Agent mode has none of the shell-group styles, so the return button carries its own.
export const RETURN_CSS = `
.bt-return{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:0 14px;border:0;border-radius:999px;background:none;color:inherit;font:inherit;font-size:14px;line-height:20px;cursor:pointer;transition:background-color .12s ease}
.bt-return:hover{background:rgba(127,127,127,.14)}
.bt-return:active{transform:scale(.96)}
.bt-return .bt-mark{display:inline-flex;flex:none;line-height:0}
.bt-return .bt-mark svg{width:100%;height:100%;overflow:visible}
/* Shell styles carry --bt-ink-deepseek and Agent mode withdraws them; pin it here. */
.bt-return .bt-mark{--bt-ink-deepseek:#4D6BFE}
.bt-return-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

export function BrandMark({ size = 24 }) {
  return h('span', { className: 'bt-brand-mark' }, h(OmniMark, { size }))
}
export function BrandName() {
  return h('span', { className: 'bt-brand-name' }, h(Wordmark, { height: 25 }))
}

// With the whale holding the settings seat, the Bot row is just the account menu;
// FooterAccount only shows when the seat went to no one. The shell's footer classes
// are CSS-module names, so they match on their stems.
export const SIDEBAR_CSS = `
.bt-confirm{width:260px;max-width:72vw;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}
.bt-confirm-text{margin:0;font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-confirm-error{margin:0;font-size:12px;line-height:17px;color:var(--st-bad-strong,var(--bt-danger));overflow-wrap:anywhere}
.bt-confirm-row{display:flex;justify-content:flex-end;gap:8px}
.bt-menu .bt-confirm button{width:auto;min-height:0}
.bt-confirm-go{height:28px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease}
.bt-confirm-go:hover:not(:disabled){opacity:.9}
.bt-confirm-go:disabled{opacity:.6;cursor:default}
.bt-side-top .bt-brand{cursor:default;padding-left:6px;padding-right:4px}
.bt-side-top .bt-brand:hover{background:none}
.bt-brand .bt-mark{flex:none}
/* In the app the window's title bar carries the brand (or the system's, on macOS): the
   sidebar's top row is its buttons alone. */
html[data-automagik-desktop] .bt-side-top .bt-brand{display:none}
/* macOS: dsh's page fills the window, and the traffic lights sit at the start of this row
   (apps/desktop frame.js TRAFFIC_LIGHTS), which also moves the window. */
html[data-automagik-desktop=darwin]:not([data-automagik-fullscreen]) .bt-side-top{padding-left:64px}
html[data-automagik-desktop=darwin] .bt-side-top{-webkit-app-region:drag}
/* The row is the window's title bar: empty space moves the window, while every control in it
   takes clicks. The list is the shell bar's, so a control a builder adds here is covered
   without another rule; the brand is hidden in the app but kept sane. */
html[data-automagik-desktop=darwin] .bt-side-top :is(.bt-brand,.bt-code-switch,a,button,input,label,select,summary,textarea,[contenteditable],[role=button],[role=checkbox],[role=link],[role=menu],[role=menubar],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=radio],[role=slider],[role=switch],[role=tab],[aria-haspopup],[tabindex],[data-menu]){-webkit-app-region:no-drag}
html[data-automagik-desktop=darwin] header[class*="_header"]{-webkit-app-region:drag}
html[data-automagik-desktop=darwin] header[class*="_header"] :is(a,button,input,label,select,summary,textarea,[contenteditable],[role=button],[role=checkbox],[role=link],[role=menu],[role=menubar],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=radio],[role=slider],[role=switch],[role=tab],[aria-haspopup],[tabindex],[data-menu]){-webkit-app-region:no-drag}
/* The fixed details panel overlaps that header but is not its descendant. Native drag
   regions ignore DOM z-index/pointer-events: subtract the panel so its top actions click. */
html[data-automagik-desktop=darwin] .bt-panel{-webkit-app-region:no-drag}
/* The collapsed sidebar is a 56px rail, and DSH's card around it left its content 12px: the
   marks were cut. It keeps a 6px margin and no side padding, everything centred in it. */
[class*="_root"][class*="_collapsed"]{margin:6px!important;padding-left:0!important;padding-right:0!important}
[class*="_collapsed"]>[class*="_logoRow"],[class*="_collapsed"] [class*="_regionArea"]{width:100%;display:flex;justify-content:center}
[class*="_collapsed"]>[class*="_footArea"]{width:100%;justify-items:center;padding-left:0!important;padding-right:0!important}
/* rc.2 nests the Bot list in a scrolling grid. Bound its row so only bt-list
   scrolls; the search and sidebar buttons stay above it. Native sessions keep their grid. */
[class*="_scrollArea"]:has(.bt-side){grid-template-rows:8px max-content 2px minmax(0,1fr);overflow-y:hidden}
.bt-rail{width:100%}
/* Keep the shell's native sidebar icon visible at rest and on hover. A separate
   pseudo-element would appear beside the native icon when DSH reveals it on hover. */
[class*="_collapsed"] [data-sidebar-toggle] [class*="_railMark"]{display:none}
[class*="_collapsed"] [data-sidebar-toggle] [class*="_panelIcon"]{display:inline!important}
/* macOS, collapsed: the rail starts below the traffic lights, and the chat's header leaves
   them room where they reach past the rail. */
html[data-automagik-desktop=darwin]:not([data-automagik-fullscreen]) [class*="_root"][class*="_collapsed"]{padding-top:52px!important}
html[data-automagik-desktop=darwin]:not([data-automagik-fullscreen]) [class*="_frame"]:has([class*="_root"][class*="_collapsed"]) header[class*="_header"]>[class*="_headerLeading"]{margin-left:28px}
.bt-pin{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-row-crowned{margin-top:8px}
/* A Bot's running tasks, as threads under its row. */
.bt-threads{display:flex;flex-direction:column;gap:2px;margin:0 0 4px 26px;padding-left:10px;border-left:2px solid var(--bt-line-2)}
.bt-thread{display:flex;align-items:center;gap:8px;width:100%;min-height:28px;padding:4px 8px;border:0;border-radius:10px;background:none;color:var(--bt-ink);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer;box-sizing:border-box;transition:background-color .12s ease}
.bt-thread:hover,.bt-thread[aria-current=page]{background:var(--bt-hover)}
.bt-thread:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-thread[data-state=waiting] .bt-thread-title{font-weight:600}
.bt-thread-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-thread-age{flex:none;font-size:11px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-thread-spin{flex:none;width:12px;height:12px;box-sizing:border-box;border-radius:50%;corner-shape:round;border:2px solid color-mix(in srgb,var(--bt-accent) 25%,transparent);border-top-color:var(--bt-accent);animation:bt-thread-spin .9s linear infinite}
.bt-thread-wait{flex:none;width:12px;height:12px;border-radius:50%;corner-shape:round;background:var(--bt-gold);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-gold) 22%,transparent)}
.bt-thread-more{color:var(--bt-ink-2);padding-left:28px}
@keyframes bt-thread-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.bt-thread-spin{animation-duration:3s}}
body[data-bt-motion=quiet] .bt-thread-spin{animation-duration:3s}
/* The first Main Bot's crown (mark.js) and its role chip, in clay gold. */
.bt-crown{position:absolute;left:50%;top:calc(var(--bt-size,36px) * -.27);width:calc(var(--bt-size,36px) * .52);height:calc(var(--bt-size,36px) * .36);transform:translateX(-50%) rotate(-8deg);filter:drop-shadow(0 1.5px 0 var(--bt-gold-edge)) drop-shadow(0 3px 3px color-mix(in srgb,var(--bt-gold-edge) 30%,transparent));pointer-events:none;z-index:1;line-height:0}
.bt-crown-body{fill:var(--bt-gold);stroke:var(--bt-gold-edge);stroke-width:2;stroke-linejoin:round}
.bt-crown-band{fill:var(--bt-gold-band)}
.bt-crown-gem{fill:var(--bt-gem)}
.bt-crown-gem2{fill:var(--bt-gem-2)}
.bt-crown-shine{stroke:var(--bt-gold-shine);stroke-width:2;stroke-linecap:round;opacity:.8}
.bt-role{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 7px;border-radius:8px;background:var(--bt-role-bg);box-shadow:inset 0 1px var(--bt-role-shine),0 1px 0 var(--bt-role-edge);color:var(--bt-role-ink);font-size:10px;line-height:16px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.bt-rail .bt-row{position:relative}
.bt-rail .bt-pin{position:absolute;top:3px;left:calc(50% + 12px)}
.bt-side .bt-read-only{margin:4px 8px 6px;padding:8px 10px;border-radius:10px;background:var(--bt-hover);font-size:12px;line-height:1.45;text-align:left}
[class*="_footArea"]:has(.bt-foot-account){grid-template-columns:auto minmax(0,1fr) auto;column-gap:6px}
[class*="_footArea"]>[class*="_footerActions"]>div>.bt-foot-account{grid-column:1;order:1;display:inline-flex}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_footerActions"]>div>.bt-connect-wrap{grid-column:2}
.bt-channels-moved{gap:8px;justify-content:flex-start;padding:0 12px}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"]{grid-column:3}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"] button[class*="_trigger"] [class*="_label"]{display:none!important}


/* The update cloud springs in when a newer Omni shows up; its arrow drops in a
   loop while the install runs. */
.bt-round.bt-update{position:relative;color:var(--bt-accent,#4D6BFE);animation:bt-update-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-round.bt-update svg{width:17px;height:17px}
.bt-round.bt-update[data-phase=installed]{color:var(--bt-ink-2)}
@keyframes bt-update-in{from{opacity:0;transform:scale(.6);filter:blur(4px)}}
.bt-update[data-phase=installing] .bt-cloud-arrow{animation:bt-cloud-drop 1.1s cubic-bezier(.45,0,.55,1) infinite}
@keyframes bt-cloud-drop{0%{transform:translateY(-3px);opacity:0}35%{opacity:1}70%{transform:translateY(1px);opacity:1}100%{transform:translateY(2px);opacity:0}}
.bt-update-dot{position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:#E5484D;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-update-pop{position:fixed;z-index:60;width:280px;padding:14px 14px 12px;border-radius:14px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);color:var(--bt-ink);box-sizing:border-box;transform-origin:top left;font-family:var(--bt-font);animation:bt-update-pop ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-update-pop{from{opacity:0;transform:scale(.96);filter:blur(4px)}}
.bt-update-title{font-size:14px;line-height:20px;font-weight:600}
.bt-update-text{margin-top:2px;font-size:12.5px;line-height:18px;color:var(--bt-ink-2)}
.bt-update-error{margin-top:8px;font-size:12px;line-height:17px;color:var(--st-bad-strong,var(--bt-danger));overflow-wrap:anywhere;max-height:90px;overflow:auto}
.bt-update-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px}
.bt-update-notes{margin-right:auto;font-size:12.5px;color:var(--bt-ink-2);text-decoration:none}
.bt-update-notes:hover{color:var(--bt-ink);text-decoration:underline}
.bt-update-go{height:30px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent,#4D6BFE);color:var(--bt-accent-ink,#fff);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease,transform .12s ease}
.bt-update-go:hover:not(:disabled){opacity:.9}
.bt-update-go:active:not(:disabled){transform:scale(.96)}
.bt-update-go:disabled{opacity:.6;cursor:default}
.bt-update-dsh:not(:first-child){margin-top:12px;padding-top:12px;border-top:.5px solid var(--bt-line-2)}
@media (prefers-reduced-motion:reduce){.bt-round.bt-update,.bt-update-pop,.bt-update .bt-cloud-arrow{animation:none}}
/* A sidebar tool (extend.js sidebarTools) wears these same pieces: .bt-round with the cloud's
   .bt-update-dot, a card of .bt-update-* rows, and .bt-update-notes as a button. */
.bt-side-tool{position:relative}
.bt-update-pop button.bt-update-notes{padding:0;border:0;background:none;font-family:inherit;cursor:pointer}
/* A card row may lead with its product's mark (BotMark), beside its name and status. */
.bt-power-who{display:flex;align-items:center;gap:10px}
.bt-power-who>.bt-mark{flex:none}
.bt-power-what{min-width:0}

/* A DSH bot's row and its expanding Session list. It wears DSH's own whale, the mark a
   Bot with no look of its own wears too. */
.bt-agent-ava{flex:none;width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink)}
.bt-agent-ava.bt-run{animation:bt-agent-pulse 1.4s ease-in-out infinite}
.bt-agent-ava svg{width:18px;height:18px}
.bt-agent-ava .bt-mark svg{width:100%;height:100%}
.bt-dsh-ava{width:72px;height:72px}
.bt-dsh-ava svg{width:32px;height:32px}
.bt-dsh-ava .bt-mark svg{width:100%;height:100%}
@keyframes bt-agent-pulse{0%,100%{opacity:1}50%{opacity:.55}}
.bt-agent-sub{display:grid;grid-template-rows:0fr;transition:grid-template-rows ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-agent-sub[data-open]{grid-template-rows:1fr}
.bt-agent-sub-in{overflow:hidden;min-height:0;margin-left:44px}
.bt-agent-sub-row{display:flex;align-items:center;gap:8px;width:100%;padding:5px 10px 5px 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.bt-agent-sub-row:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-agent-sub-row[aria-current=page]{background:var(--bt-hover);color:var(--bt-ink);font-weight:500}
.bt-agent-sub-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-agent-sub-time{flex:none;font-size:11px;color:var(--bt-ink-3)}
.bt-agent-new{color:var(--bt-ink-3)}
.bt-agent-new svg{width:14px;height:14px;flex:none}
.bt-agent-edit{padding:3px 10px 3px 4px}
.bt-agent-edit input{width:100%;border:0;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;line-height:20px;padding:2px 8px;outline:none;box-shadow:inset 0 0 0 .5px var(--bt-line-2)}
.bt-agent-sub[data-open] .bt-agent-sub-row{animation:bt-agent-row-in .24s ease both;animation-delay:calc(var(--i, 0)*30ms)}
@keyframes bt-agent-row-in{from{opacity:0;filter:blur(4px)}to{opacity:1;filter:blur(0)}}
@media (prefers-reduced-motion:reduce){.bt-agent-sub{transition:none}.bt-agent-sub .bt-agent-sub-row{animation:none}}
`
