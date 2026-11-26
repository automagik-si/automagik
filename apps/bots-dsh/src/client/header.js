import { createElement as h, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { headerButtons, useEntries } from './extend.js'
import { BotFaceSwitch } from './code-side.js'
import { createPortal } from 'react-dom'
import { currentPart, latestMemoryChange } from './text.js'
import { ArrowUpIcon, CloseIcon, ArrowDownIcon, DotsIcon, GoalIcon, InfoIcon, MemoryIcon } from './icons.js'
import { botState, BotAvatar, RoomAvatar } from './mark.js'
import { useApproval } from './approvals.js'
import { ActivityIndicator } from './activity-row.js'
import { clockLabel, openingTurn, unseenSince } from './cells.js'
import { GoalIsland, goalView } from './goal.js'
import { viewBottom } from './motion.js'
import { t } from './i18n.js'
import { detailsSubject } from './sources.js'
import { useNarrow } from './narrow.js'
import { OWN_TOOLS_SWITCH, SWITCH_FAILED, agentNameOf, modelStateLine } from './model-menu.js'
import { CROSSING_DEADLINE_MS } from '../shared/routes.js'

// -------------------------------------------------------------------------
// Conversation header

// The pill's tail: a → that springs in on hover, flipping to ← while details are open.
const GoArrow = () => h('svg', { width: 14, height: 14, viewBox: '-12 -12 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M-7 0H7M2 -5L7 0L2 5' }))

// How long the pill says "Memory updated" after the change reaches this window.
const MEMORY_NOTICE_MS = 3_200
const noNews = select => select({})

// True while the latest memory change of the Bots in this conversation is news.
function useMemoryNotice(ids, useMemoryNews) {
  const seen = useMemoryNews(map => Math.max(0, ...ids.map(id => map?.[id]?.seen ?? 0)))
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const left = seen + MEMORY_NOTICE_MS - Date.now()
    setShown(seen > 0 && left > 0)
    if (seen === 0 || left <= 0) return undefined
    const timer = setTimeout(() => setShown(false), left)
    return () => clearTimeout(timer)
  }, [seen])
  return shown
}

// The notice the pill stretches to show. Its width is measured, so the pill's spring
// runs between two real widths.
function MemoryNotice({ shown }) {
  const inner = useRef(null)
  const [width, setWidth] = useState(0)
  const label = t('Memory updated')
  useLayoutEffect(() => { if (shown) setWidth(inner.current?.scrollWidth ?? 0) }, [label, shown])
  return h('span', { className: 'bt-pill-mem', 'aria-hidden': true, style: { '--bt-mem-w': `${width}px` } },
    h('span', { className: 'bt-pill-mem-in', ref: inner }, h('span', { className: 'bt-pill-mem-ico' }, h(MemoryIcon)), label))
}

// --- The composer lock while an agent switch runs (RFC 0030, Handoff note, 2026-11-23) ------
// From the host's `switching` (the Bot's model state) until it goes, the composer of a pane that
// shows any part of that Bot's own chat takes no input: `inert` blocks focus, typing, paste,
// Enter, send, the mic and the packs, with no new style. The host holds whatever still lands.
// The lock ends a little after the host's own deadline even with no word from it.
export const LOCK_GRACE_MS = 15_000

// The conversation pane a header node belongs to: the nearest ancestor holding the content of
// this Session, never the whole document, so a split pane on another chat stays usable.
export function paneOf(node, sessionId) {
  for (let at = node?.parentElement; at; at = at.parentElement) {
    const content = [...at.querySelectorAll('[data-conversation-content][data-conversation-session]')]
      .find(item => item.dataset.conversationSession === sessionId)
    if (content !== undefined) return content
  }
  return undefined
}

// Locks the composer cards in `pane`, again whenever DSH draws one anew, and puts `placeholder`
// (when given) on the pane alone. Returns the release.
export function lockComposer(pane, placeholder) {
  const apply = () => {
    for (const card of pane.querySelectorAll('[data-composer-card]')) {
      // React drops a boolean inert; the empty string sets the attribute (browser-pane.js).
      if (card.getAttribute('inert') !== '') card.setAttribute('inert', '')
      if (card.getAttribute('aria-busy') !== 'true') card.setAttribute('aria-busy', 'true')
    }
  }
  apply()
  if (placeholder !== undefined) pane.style.setProperty('--bt-placeholder', JSON.stringify(placeholder))
  const Observer = pane.ownerDocument?.defaultView?.MutationObserver ?? globalThis.MutationObserver
  const observer = typeof Observer === 'function' ? new Observer(apply) : undefined
  observer?.observe(pane, { childList: true, subtree: true })
  return () => {
    observer?.disconnect()
    for (const card of pane.querySelectorAll('[data-composer-card]')) {
      card.removeAttribute('inert')
      card.removeAttribute('aria-busy')
    }
    if (placeholder !== undefined) pane.style.removeProperty('--bt-placeholder')
  }
}

// Whether the shown Session is a part of the Bot's own chat: the current one, or an earlier one
// a pane still shows after the move.
export const ownChatPart = (bot, sessionId) => bot !== undefined && (currentPart(bot) === sessionId || (bot.parts ?? []).includes(sessionId))

// The lock for one header: on while `switching` is on for a part of this Bot's own chat. When it
// goes and the host recorded the switch failing since it began, the failure is said once.
export function useSwitchLock({ bot, roster, sessionId, useWork, actions, updateHold, anchor }) {
  const own = ownChatPart(bot, sessionId)
  const key = useWork?.((work) => {
    const switching = own ? work?.models?.[bot.id]?.switching : undefined
    return typeof switching?.to === 'string' && Number.isFinite(switching.since) ? `${switching.since}\n${switching.to}` : ''
  }) ?? ''
  const [since, to] = key === '' ? [undefined, undefined] : [Number(key.slice(0, key.indexOf('\n'))), key.slice(key.indexOf('\n') + 1)]
  const [expired, setExpired] = useState('')
  const locked = key !== '' && expired !== key
  useEffect(() => {
    if (key === '') return undefined
    const left = since + CROSSING_DEADLINE_MS + LOCK_GRACE_MS - Date.now()
    if (left <= 0) { setExpired(key); return undefined }
    const timer = setTimeout(() => setExpired(key), left)
    return () => clearTimeout(timer)
  }, [key])
  const agent = to === undefined ? '' : agentNameOf(roster, to)
  // The update hold's own words win; they stay on the window as they are.
  const placeholder = locked && !updateHold ? t('Switching to {agent}…', { agent }) : undefined
  useLayoutEffect(() => {
    if (!locked) return undefined
    const pane = paneOf(anchor?.current, sessionId)
    return pane === undefined ? undefined : lockComposer(pane, placeholder)
  }, [locked, sessionId, placeholder])
  const began = useRef(undefined)
  useEffect(() => {
    if (key !== '') { began.current = since; return }
    const from = began.current
    began.current = undefined
    if (from === undefined || bot === undefined) return
    const state = actions?.modelStateOf?.(bot.id)
    const failure = state?.lastFailure
    if ((failure?.code === SWITCH_FAILED || failure?.code === OWN_TOOLS_SWITCH) && failure.at >= from) {
      const line = modelStateLine(state, roster)
      if (line !== undefined) actions.reportError?.(new Error(line), 'switch-route')
    }
  }, [key])
  return locked
}

// Buttons other Omni plugins add to a Bot's chat header (extend.js), such as the automations board.
function HeaderButtons(props) {
  const entries = useEntries(headerButtons)
  return entries.map(entry => h(entry.Component, { key: entry.id, ...props }))
}

export function NativeBotHeader(props) {
  const bot = props.useRoster(value => value.byId?.[props.sessionId])
  return bot?.advanced === true ? h(HeaderPill, { ...props, native: true }) : null
}

export function NativeControlsNote({ sessionId, useRoster, actions }) {
  const bot = useRoster(value => value.byId?.[sessionId])
  if (bot?.advanced !== true) return null
  return h('div', { className: 'bt-native-note' },
    h('p', null, t('Model and permissions are managed in Bot settings.'), ' ',
      h('button', { type: 'button', onClick: () => actions.openSettings('bots', bot.id) }, t('Bot settings'))),
    bot.kind !== 'dsh' ? h('p', null, t('Native compaction is unavailable for Bot conversations. Use Bot Context controls to checkpoint safely.'), ' ',
      h('button', { type: 'button', onClick: () => actions.openSettings('bots', bot.id) }, t('Context controls'))) : null)
}

export function HeaderPill({ sessionId, useRoster, useSessions, useSessionStatus, useSession, useActivity, useMemoryNews, useTurnClock, useUi, useLive, useWork, useStore, useConversationViews, selectView, actions, native = false }) {
  const roster = useRoster(value => value)
  const selectedView = useStore?.(state => state.view)
  const away = useConversationViews?.(views => views.some(view => view.id === selectedView && view.id !== 'chat')) === true
    && typeof selectView === 'function'
  const title = useSessions(list => list.byId[sessionId]?.displayTitle ?? list.byId[sessionId]?.title ?? '')
  const firstTurns = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.slice(0, 8).map(entry => entry.turn).join(',') : ''
  })
  const hiddenTurns = roster.exchangeTurns?.[sessionId]
  const visit = useUi(state => state.visits?.[sessionId])
  // The opening separator has no turn before it, so the transcript column draws it,
  // unless the opening is unread: then the first trigger draws it under the divider.
  const opening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], firstTurns, hiddenTurns)
    return first && !unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  useEffect(() => {
    if (opening) document.body.style.setProperty('--bt-first-sep', JSON.stringify(opening))
    else document.body.style.removeProperty('--bt-first-sep')
    return () => document.body.style.removeProperty('--bt-first-sep')
  }, [opening])
  const running = useSessionStatus(map => map.get(sessionId)?.running === true)
  const owner = roster.byId[sessionId]?.id ?? sessionId
  const doing = useActivity(map => map[owner])
  const bot = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const approval = useApproval(useWork, entry => bot !== undefined && entry.botId === bot.id)
  const goal = room?.goal
  // Goal panels are keyed by the group, never by its current Session: `composeGoal` and
  // `toggleGoal` store `room.id`, and a group's Session moves to a fresh part when its
  // folder changes, so the two differ for every group whose folder was changed.
  const goalCompose = useUi(state => room !== undefined && state.goalCompose === room.id)
  const goalOpen = useUi(state => room !== undefined && state.goalOpen === room.id)
  // The island's live faces: who is at work in this group right now. Non-group
  // chats subscribe to a constant so their header does not redraw on work.
  const roomWorkKey = useWork?.(work => (room ? JSON.stringify(work.rooms?.[sessionId] ?? []) : '')) ?? '[]'
  const roomWork = room ? JSON.parse(roomWorkKey || '[]') : []
  const view = goal ? goalView(goal, { roster, roomWork }) : null
  const goalShown = room !== undefined && !away && goal !== undefined
  // Open only while the panel shows this subject's details, not its browser or side chat.
  // Rename opens a multi-part Bot by its Bot id, the header by the part's Session id.
  const detailsOpen = useUi(state => state.view === 'details' && state.details != null
    && detailsSubject(roster, state.details) === detailsSubject(roster, sessionId))
  const name = bot?.name ?? room?.name ?? ''
  const useNews = useMemoryNews ?? noNews
  const memoryIds = bot ? [bot.id] : room ? [room.id, ...room.members] : []
  const notice = useMemoryNotice(memoryIds, useNews)
  // While the notice shows, the pill opens the memory that changed: a Bot's, or the group's.
  const changed = useNews(map => latestMemoryChange(map, memoryIds))
  // While the web self-update holds new work, a message waits until the update is done (RFC 0041).
  const updateHold = useRoster(value => value.updateHold === true)
  const holdText = t('An update is running. Your message waits until it is done.')
  const anchor = useRef(null)
  useSwitchLock({ bot, roster, sessionId, useWork, actions, updateHold, anchor })
  // The composer placeholder is not localizable per Session, so CSS reads it from here.
  useEffect(() => {
    document.body.style.setProperty('--bt-placeholder', JSON.stringify(updateHold ? holdText
      : name ? t('Message {name}', { name }) : t('Message')))
  }, [name, t('Message'), updateHold, holdText])
  // The unread label under a pending steering bubble reads its text from here.
  useEffect(() => {
    document.body.style.setProperty('--bt-steer-unread', JSON.stringify(t('Not read yet')))
  }, [t('Not read yet')])
  useEffect(() => {
    actions.beginVisit(sessionId)
    return () => actions.endVisit(sessionId)
  }, [sessionId])
  // Group chats have no voice mode, so the composer CSS needs to know the Session kind.
  useEffect(() => {
    if (room) document.body.dataset.btRoom = ''
    else delete document.body.dataset.btRoom
    return () => { delete document.body.dataset.btRoom }
  }, [Boolean(room)])
  const memoryNotice = !away && notice && changed !== null && roster.memory !== false
  const showGoal = room !== undefined && !away && (goal !== undefined || goalCompose)
  // The goal island pads the transcript so its pod does not cover the first message.
  useEffect(() => {
    if (showGoal) document.body.dataset.btGoal = ''
    else delete document.body.dataset.btGoal
    return () => { delete document.body.dataset.btGoal }
  }, [showGoal])
  // The sidebar already names the open chat, so the pill shows only when it says something
  // more: the way back from another view, a memory that just changed, or a group's goal,
  // whose island it heads. The details open from a small button beside the header's other
  // buttons. The pill's arrow reads data-expanded: aria-expanded belongs to the Details
  // button alone, so the memory notice exposes no expanded state to assistive tech.
  const pill = away || memoryNotice || showGoal ? h('button', {
    type: 'button', className: 'bt-pill', 'data-expanded': away ? undefined : detailsOpen, 'data-memory': memoryNotice ? 'updated' : undefined,
    'aria-label': away ? t('Back to chat') : memoryNotice ? t('Memory updated. Open {name}\'s memory', { name: roster.byId[changed]?.name ?? name }) : t('View conversation details'),
    title: away ? name : undefined,
    onClick: () => (away ? selectView('chat') : memoryNotice ? actions.openMemory(changed) : actions.toggleDetails(sessionId)),
  },
    bot ? h(BotAvatar, { bot, size: 24, state: botState(running, doing, roster.questions?.[currentPart(bot)] !== undefined || approval, { installed: bot.installed }), badge: false })
      : room ? h(RoomAvatar, { room, roster, size: 24 }) : null,
    goalShown
      ? h('span', { className: 'bt-pill-swap' },
        h('span', { className: 'bt-pill-goal' }, h('span', { className: 'bt-pill-ico', 'aria-hidden': true }, h(GoalIcon)), h('span', { className: 'bt-pill-title' }, view.title)),
        h('span', { className: 'bt-pill-name' }, name))
      : h('span', { className: 'bt-pill-name' }, away ? t('Back to chat') : bot?.name ?? room?.name ?? (title || t('New chat'))),
    goalShown && view?.number !== undefined ? h('span', { className: 'bt-pill-count' }, `${view.number}/${view.count}`) : null,
    h(MemoryNotice, { shown: memoryNotice }),
    h('span', { className: 'bt-pill-go', 'aria-hidden': true }, h(GoArrow))) : null
  const narrow = useNarrow()
  const headButtons = bot ? h(HeaderButtons, { bot, roster, actions, useWork }) : null
  const liveButtons = actions.hasRightSidebar?.() ? h(Fragment, null,
    h('button', { type: 'button', className: 'bt-head-details', title: t('Live'), 'aria-label': t('Open Live'), onClick: () => actions.openLive() }, t('Live')),
    !native ? h('button', { type: 'button', className: 'bt-head-details', 'data-bt-right-sidebar': '', title: t('Right sidebar'), 'aria-label': t('Toggle right sidebar'), onClick: () => actions.toggleRightSidebar() }, h(GoArrow), h('span', { className: 'bt-head-more-word' }, t('Right sidebar'))) : null) : null
  const details = !away && (bot || room) ? h('button', {
    type: 'button', className: 'bt-head-details', 'aria-label': t('View conversation details'), title: t('Details'),
    'aria-expanded': detailsOpen, 'aria-controls': 'bt-conversation-panel', 'data-details-subject': sessionId,
    // Focus the trigger first (Safari does not on click), so the panel returns focus to it.
    onClick: (event) => { event.currentTarget.focus(); actions.toggleDetails(sessionId) },
  }, h(InfoIcon), h('span', { className: 'bt-head-word' }, t('Details'))) : null
  // A phone has no room for the switch beside every control the Bot's plugins add: there the
  // controls fold into one "More" disclosure, and the switch stays whole.
  const folded = headButtons || liveButtons || details
  const more = narrow && folded ? h('details', { className: 'bt-head-more' },
    h('summary', { className: 'bt-head-details bt-head-more-btn', 'aria-label': t('More'), title: t('More') }, h(DotsIcon)),
    h('div', { className: 'bt-head-more-pop', role: 'group', 'aria-label': t('More'), onClick: event => event.currentTarget.closest('details')?.removeAttribute('open') },
      headButtons, liveButtons, details)) : null
  return h('div', { ref: anchor, className: native ? 'bt-native-head' : 'bt-head' },
    showGoal ? h(GoalIsland, { room, goal, view, open: goalOpen, composing: goalCompose, roomWork, roster, actions, pill }) : pill,
    h('span', { className: 'bt-sr', role: 'status' }, memoryNotice ? t('Memory updated') : ''),
    // A seat can have a Terminal face. A DSH conversation stays in Chat.
    bot && !away && !native ? h(BotFaceSwitch, { bot }) : null,
    narrow ? more : h(Fragment, null, headButtons, liveButtons, details),
    native && bot ? h('button', { type: 'button', className: 'bt-head-details', 'aria-label': t('Bot settings'), title: t('Bot settings'), onClick: () => actions.openSettings('bots', bot.id) }, h(InfoIcon)) : null,
    h(NewMessagePills, { key: sessionId, sessionId, useSessions, useUi, useTurnClock }),
    h(ActivityIndicator, { key: `activity:${sessionId}`, sessionId, useRoster, useSessionStatus, useSession, useLive, useWork, actions }))
}

// New-message pills. "N new messages ↓" takes Back to bottom's place when
// replies land while the user is scrolled up; "N new messages ↑" points at an unread
// divider above the viewport until it has been seen. The shell shows Back to bottom
// only while unpinned, so its presence is the pinned signal.
function useTranscriptView() {
  const [view, setView] = useState(null)
  useEffect(() => {
    let frame = 0
    let watched = null
    const observer = new MutationObserver(() => schedule())
    const measure = () => {
      frame = 0
      const scroller = document.querySelector('[data-conversation-scroll]')
      if (scroller !== watched) {
        observer.disconnect()
        watched = scroller
        if (scroller) observer.observe(scroller, { childList: true, subtree: true })
      }
      if (!scroller) { setView(null); return }
      const box = scroller.getBoundingClientRect()
      const headerBottom = document.querySelector('header[class*="_header"]')?.getBoundingClientRect().bottom ?? box.top + 50
      const sep = scroller.querySelector('.bt-new-sep')
      let divider = null
      if (sep) {
        const at = sep.getBoundingClientRect()
        divider = at.bottom <= headerBottom ? 'above' : at.top >= box.bottom ? 'below' : 'in-view'
      }
      const composer = parseFloat(getComputedStyle(scroller).getPropertyValue('--dsh-composer-height')) || 152
      const next = {
        unpinned: scroller.querySelector('[class*="_toBottomSlot"]>button') !== null,
        divider,
        center: Math.round(box.left + box.width / 2),
        top: Math.round(headerBottom + 8),
        bottom: Math.round(viewBottom() - box.bottom + composer + 8),
      }
      setView(prev => (prev && Object.keys(next).every(key => prev[key] === next[key]) ? prev : next))
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [])
  return view
}

function NewMessagePills({ sessionId, useSessions, useUi, useTurnClock }) {
  const replies = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.reduce((count, entry) => count + (entry.response ? 1 : 0), 0) : 0
  })
  const visit = useUi(state => state.visits?.[sessionId])
  const unread = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number') return 0
    let count = 0
    for (const entry of Object.values(state[sessionId] ?? {})) {
      if (entry.first !== undefined && entry.first > visit.seen && entry.first <= visit.entered) count += 1
    }
    return count
  })
  const view = useTranscriptView()
  const unpinned = view?.unpinned === true
  const [release, setRelease] = useState({ base: null, dismissed: false })
  const [above, setAbove] = useState({ seen: false, dismissed: false })
  useEffect(() => { setRelease({ base: unpinned ? replies : null, dismissed: false }) }, [unpinned])
  useEffect(() => { if (view?.divider === 'in-view') setAbove(state => (state.seen ? state : { ...state, seen: true })) }, [view?.divider])
  const fresh = release.base === null ? 0 : replies - release.base
  const showDown = unpinned && fresh > 0 && !release.dismissed
  const showUp = view?.divider === 'above' && !above.seen && !above.dismissed
  useEffect(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (!scroller) return undefined
    scroller.toggleAttribute('data-bt-news', showDown)
    return () => scroller.removeAttribute('data-bt-news')
  }, [showDown])
  if (!view || (!showDown && !showUp)) return null
  const label = count => (count === 1 ? t('1 new message') : count > 0 ? t('{count} new messages', { count }) : t('New messages'))
  const pill = (direction, count, style, onJump, onDismiss) => h('div', { className: 'bt-news', 'data-direction': direction, style },
    h('button', { type: 'button', className: 'bt-news-jump', onClick: onJump },
      h('span', { className: 'bt-news-ico' }, h(direction === 'up' ? ArrowUpIcon : ArrowDownIcon)), label(count)),
    h('button', {
      type: 'button', className: 'bt-news-x', 'aria-label': t('Dismiss new messages'),
      onClick: (event) => { event.stopPropagation(); onDismiss() },
    }, h(CloseIcon)))
  const toLatest = () => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    const back = scroller?.querySelector('[class*="_toBottomSlot"]>button')
    if (back) back.click()
    else scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
  }
  const toDivider = () => document.querySelector('[data-conversation-scroll] .bt-new-sep')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return createPortal(h(Fragment, null,
    showUp ? pill('up', unread, { left: view.center, top: view.top }, toDivider, () => setAbove(state => ({ ...state, dismissed: true }))) : null,
    showDown ? pill('down', fresh, { left: view.center, bottom: view.bottom }, toLatest, () => setRelease(state => ({ ...state, dismissed: true }))) : null),
  document.body)
}
