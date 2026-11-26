import { heldText, stopOfCall, stopLine, whyText } from './stops.js'
import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText, writeClipboard } from './dsh-primitives.js'
import { inkText } from './inks.js'
import { linkMentions, mentionTarget, dayLabel, contentText, stripHeader, isHiddenTurn, isRelayContext, relaysBefore, relayPart, commRunOf, toolName, toolArgs, reminderPrompts, elapsedLabel, clockLabel, messageClock } from './text.js'
import { SmileIcon, ReplyIcon, DotsIcon, CheckIcon, DownloadIcon, CopyIcon, GoalIcon, MemoryIcon, TasksIcon } from './icons.js'
import { goalEventText } from './goal.js'
import { catalogueLookOf, colorOf, toolState, BotMark, RoomAvatar } from './mark.js'
import { CellEmpty } from './cell-empty.js'
import { sendsOnEnter } from './enter-key.js'
import { SettledQuestion, PendingQuestion } from './questions.js'
import { AnsweredReply, ClosedView, WidgetCell } from './widget-cell.js'
import { SecretToolCell } from './secret-card.js'
import { agentPromptOf, ImageCell, isAgentImageCall } from './image-cell.js'
import { ConnectorToolCell, MailToolCell } from './connectors.js'
import { HandoffCall } from './handoff-card.js'
import { AppAccessCall, ComputerCallRow, ComputerHandoffCall } from './computer.js'
import { dateLocale, hostText, t } from './i18n.js'
import { GUARD_GROUP_COPY, GUARD_OFF_NOTICE, guardOffNoticeOf } from '../shared/guard-groups.js'
import { call } from './api.js'
import { failureClause } from './diagnostics.js'
import { turnReasoning, thinkingStep, opensReply, stepActivity } from './turn-reasoning.js'
import { parseReplies, relayRange, stackReplies } from '../shared/group-replies.js'
import { SKILL_NOTICE } from '../host/skill-message.js'
import { SKILL_ACTIVITY, SKILL_ACTIVITY_RECORD, skillActivityOf } from '../shared/skill-activity.js'
import { BRIDGE_ACTIVITY_RECORD, TOOL_ACTIVITY, toolActivityOf, toolEventOf } from '../shared/tool-activity.js'
import { FOLD_AT, FOLD_HUGE, NEVER, stripLongNote, useFold } from './fold.js'
import { noHover, useViewport, viewBottom } from './motion.js'
import { heldCardKey } from './sources.js'
import { BtwCardView } from './btw.js'
import { partIndexOf, withBtwRows } from './btw-model.js'
import { ViaTag } from './user-message.js'
import { layoutOf, thinkingShown } from './themes.js'
import { hasCanvas, splitCanvases } from './canvas-text.js'
import { CanvasSlot } from './canvas-slot.js'
import { TaskCard, endLabel } from './task-card.js'
import { ProposalCall, SettingsCall } from './settings-card.js'
import { agentNameOf } from './model-menu.js'
import { toolCards } from './extend.js'
import { READ_SCOPE_CODE } from '../shared/read-scope.js'

export { clockLabel }

// -------------------------------------------------------------------------
// Chat cells

const mdLabels = () => ({ code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') })

// `lead` (a sender avatar in group chats) sits beside the last bubble, in the same
// row, so it lines up with the bubble whether or not reactions hang below it.
// `fold`: past what a bubble folds (fold.js); `whole`: the last text is only the start
// of its message (see useFold). `time` marks the bubbles' message below them; a caller
// whose own head already shows one (the flat speaker line, the group name row) leaves it unset.
export function Bubbles({ texts, roster, selfId, actions, streaming, sessionId, msgKey, useUi, lead, mentions, fold = FOLD_AT, whole, time }) {
  const onClick = (event) => {
    const target = mentionTarget(event)
    if (target === null) return
    event.preventDefault()
    event.stopPropagation()
    actions.openSession(target)
  }
  const reactions = useUi ? useUi(state => (msgKey ? state.reactions?.[msgKey] ?? null : null)) : null
  return h('div', { className: 'bt-astack', 'data-lead': lead ? '' : undefined, onClickCapture: onClick },
    texts.map((text, index) => {
      const last = index === texts.length - 1
      return h(Bubble, {
        key: index, text, index, roster, selfId, actions, sessionId, msgKey, mentions, fold,
        picked: msgKey ? reactions?.[index] ?? [] : [],
        live: streaming && last,
        lead: lead && last ? lead : null,
        whole: last ? whole : undefined,
      })
    }),
    Number.isFinite(time) ? h('div', { className: 'bt-utime', title: clockLabel(time) }, messageClock(time)) : null)
}

// A folded message's last code block shows only its start. The host's Markdown would
// give that part a copy control holding just the part, so the block is drawn here,
// with a copy bound to the whole block: `code` is its text, or a function that reads
// it when the message is kept as a file.
function FoldCodeCopy({ code, actions }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      if (typeof code === 'function' && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        // Safari needs the clipboard write inside the click, before the file loads.
        const text = Promise.resolve().then(code).then(value => new Blob([value], { type: 'text/plain' }))
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text })])
      } else {
        const text = typeof code === 'function' ? await code() : code
        if (!await writeClipboard(text)) throw new Error('Could not copy the code block')
      }
      setCopied(true); setTimeout(() => setCopied(false), 1000)
    } catch (error) { actions?.reportError?.(error, 'copy') }
  }
  return h('button', { type: 'button', className: 'bt-fold-copy', onClick: copy }, copied ? t('Copied') : t('Copy'))
}

// `body` is the Markdown before the cut block (null when the message opens with it).
// The block is drawn as the host draws a code block, its copy in the same place, so a
// folded message reads the same as before.
const foldArea = (body, code, codeHead, actions) => (code === undefined ? body
  : h('div', { className: 'bt-fold-code' },
    body,
    h('div', { className: 'bt-fold-block' },
      h('div', { className: 'bt-fold-bar' }, h(FoldCodeCopy, { code, actions })),
      h('pre', { className: 'bt-fold-pre' }, h('code', null, codeHead)))))

function Bubble({ text, index, roster, selfId, actions, sessionId, msgKey, mentions, fold, picked, live, lead, whole }) {
  // A reply with a canvas is never folded: a cut would split the canvas from its source.
  const canvas = hasCanvas(text)
  const { shown, folded, control, code, codeHead } = useFold(text, { limit: canvas ? NEVER : fold, whole, live, ownCode: !canvas })
  const key = msgKey ? `${msgKey}:${index}` : undefined
  const markdown = value => h(MarkdownText, { text: linkMentions(value, roster.bots, selfId), streaming: live, labels: mdLabels(), variant: 'compact', fileMentions: mentions })
  const body = canvas || shown === '' ? null : markdown(shown)
  const row = useRef(null)
  // Touch has no hover: a tap on the bubble opens its tools, a tap elsewhere
  // closes them. Interactive targets keep their own meaning.
  const [toolsOpen, setToolsOpen] = useState(false)
  useDismiss(toolsOpen, () => setToolsOpen(false), [row])
  const tapTools = (event) => {
    if (!noHover() || event.target instanceof Element && event.target.closest('a,button,input,textarea,select,pre,code,[role=button],[role=link]')) return
    setToolsOpen(value => !value)
  }
  const tools = live ? null : h(MessageTools, { text: folded ? text : shown, name: roster.byId[selfId]?.name ?? t('Bot'), sessionId, react: key ? emoji => actions.toggleReaction(msgKey, index, emoji) : undefined, actions, open: toolsOpen })
  // Text stays in bubbles; each canvas sits between them at full width, and its buttons
  // ask the Bot in this same chat.
  const lines = canvas
    ? splitCanvases(shown).map((part, at, parts) => (part.kind === 'canvas'
      ? h('div', { key: at, className: 'bt-canvas-line' }, h(CanvasSlot, { program: part.program, complete: part.complete, onAsk: message => message && actions.send(sessionId ?? selfId, message) }))
      : h('div', { key: at, className: 'bt-msg-line' }, at === 0 ? lead : null, h('div', { className: 'bt-bubble' }, markdown(part.text)), at === parts.length - 1 ? tools : null)))
    : null
  const area = foldArea(body, code, codeHead, actions)
  return h('div', { ref: row, className: 'bt-msg', onClick: tapTools },
    lines ?? h('div', { className: 'bt-msg-line' },
      lead,
      h('div', { className: 'bt-bubble', 'data-folded': folded || undefined },
        control ? h('div', { className: 'bt-fold-body' }, area) : area,
        control),
      tools),
    picked.length ? h('div', { className: 'bt-reacts' }, picked.map(emoji => h('button', {
      key: emoji, type: 'button', className: 'bt-react', 'aria-label': t('Remove reaction {emoji}', { emoji }), onClick: () => actions.toggleReaction(msgKey, index, emoji),
    }, emoji))) : null)
}

const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
// Half the reaction strip: six 32px buttons at 2px gaps plus its own padding and
// the 8px margin it keeps from the screen edge.
const STRIP_HALF = (REACTIONS.length * 34 + 10) / 2 + 8

// Closes a popover on a press outside the given elements or on Escape.
function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (refs.some(ref => ref.current?.contains(event.target))) return
      close()
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('touchstart', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('touchstart', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
}

// The hover toolbar beside a reply bubble: Add reaction, Reply, More. `open` is
// the touch fallback: a tap on the bubble toggles it (see Bubble).
function MessageTools({ text, name, sessionId, react, actions, open: tapped }) {
  // The anchor element is kept, not its rect: the visible viewport can move
  // (on-screen keyboard) while the popover is open.
  const [panel, setPanel] = useState(null)
  const [copied, setCopied] = useState(false)
  const tools = useRef(null)
  const pop = useRef(null)
  const tick = useViewport()
  const close = () => setPanel(null)
  useDismiss(panel !== null, close, [tools, pop])
  const open = (kind, event) => { if (panel?.kind === kind) { close(); return } setPanel({ kind, node: event.currentTarget }) }
  const place = useMemo(() => {
    if (!panel) return null
    const rect = panel.node.getBoundingClientRect()
    const below = rect.bottom + 220 < viewBottom()
    return panel.kind === 'react'
      // The strip hangs off its center anchor: clamp the center so the strip
      // itself stays inside the viewport.
      ? { left: Math.min(Math.max(rect.left + rect.width / 2, STRIP_HALF), window.innerWidth - STRIP_HALF), top: rect.top - 6, '--bt-origin': 'bottom center' }
      : { left: Math.min(rect.left, window.innerWidth - 208), ...(below ? { top: rect.bottom + 4 } : { bottom: viewBottom() - rect.top + 4, '--bt-origin': 'bottom left' }) }
  }, [panel, tick])
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1000) })
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: `${name}-message.md` })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const item = (label, Icon, run) => h('button', { key: label, type: 'button', role: 'menuitem', onClick: () => { close(); run() } }, h(Icon), label)
  return h('div', { ref: tools, className: 'bt-tools', 'data-open': panel !== null || tapped || undefined },
    react ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Add reaction'), title: t('Add reaction'), 'aria-expanded': panel?.kind === 'react', onClick: event => open('react', event) }, h(SmileIcon)) : null,
    sessionId ? h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('Reply'), title: t('Reply'), onClick: () => actions.quote(sessionId, text) }, h(ReplyIcon)) : null,
    h('button', { type: 'button', className: 'bt-tool', 'aria-label': t('More message actions'), title: t('More'), 'aria-haspopup': 'menu', 'aria-expanded': panel?.kind === 'more', onClick: event => open('more', event) }, copied ? h(CheckIcon) : h(DotsIcon)),
    panel?.kind === 'react' ? createPortal(h('div', { ref: pop, className: 'bt-react-strip', role: 'menu', 'aria-label': t('Reactions'), style: place },
      REACTIONS.map(emoji => h('button', { key: emoji, type: 'button', role: 'menuitem', 'aria-label': emoji, onClick: () => { close(); react(emoji) } }, emoji))), document.body) : null,
    panel?.kind === 'more' ? createPortal(h('div', { ref: pop, className: 'bt-menu', role: 'menu', 'aria-label': t('Message actions'), style: place },
      item(t('Copy'), CopyIcon, copy), item(t('Download'), DownloadIcon, download)), document.body) : null)
}

// A Turn's settled thinking time, fetched per count of settled steps: while a turn
// runs each new settled step refetches; scrolling back to a loaded turn reuses it.
const thinkingTimes = new Map()
function useThinkingMs({ sessionId, turn, settledSteps, skip }) {
  const key = `${sessionId}:${turn}:${settledSteps}`
  const [ms, setMs] = useState(() => thinkingTimes.get(key))
  useEffect(() => {
    if (skip || thinkingTimes.has(key)) { setMs(thinkingTimes.get(key)); return undefined }
    const control = new AbortController()
    call('thinking', { sessionId, turn }, control.signal)
      .then(value => { thinkingTimes.set(key, value?.ms); setMs(value?.ms) })
      .catch(() => {})
    return () => control.abort()
  }, [key, skip])
  return ms
}

// The row starts closed. Few readers go through a whole chain of thought, so when opened
// it shows the last lines and the box scrolls for the rest. It stays at the end as later
// steps add reasoning, unless the reader has scrolled up. While a step of the turn is
// thinking the row shows immediately and ticks (`at` backs the live clock so it counts
// the settled steps too); settled, it shows the turn's exact thinking time if known.
// A live turn's row moves to the step that reasons now, so whether the reader opened it
// and where they scrolled is kept per turn (`viewKey`), not per row.
const rowViews = new Map()
export function ThinkingRow({ text, live, at, ms, viewKey }) {
  const box = useRef(null)
  const view = useRef(rowViews.get(viewKey))
  const atEnd = useRef(view.current?.atEnd ?? true)
  const [open, setOpen] = useState(view.current?.open ?? false)
  const [fade, setFade] = useState(undefined)
  const remember = patch => { if (viewKey !== undefined) rowViews.set(viewKey, { ...rowViews.get(viewKey), ...patch }) }
  const measure = () => {
    const el = box.current
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 2
    remember({ atEnd: atEnd.current, top: el.scrollTop })
    const above = el.scrollTop > 0
    setFade(above && !atEnd.current ? 'both' : above ? 'top' : !atEnd.current ? 'bottom' : undefined)
  }
  const toggle = event => {
    const next = event.currentTarget.open
    if (next) atEnd.current = true
    remember({ open: next })
    setOpen(next)
  }
  useLayoutEffect(() => {
    if (!open) return
    const el = box.current
    const restore = view.current
    view.current = undefined
    if (atEnd.current) el.scrollTop = el.scrollHeight
    else if (restore?.top !== undefined) el.scrollTop = restore.top
    measure()
  }, [text, open])
  const title = live ? t('Thinking') : t('Thought it through')
  return h('details', { className: 'bt-think', open, onToggle: toggle },
    h('summary', null, title,
      live && at !== undefined ? h(Elapsed, { at, className: 'bt-think-time' }) : null,
      !live && ms !== undefined ? h('span', { className: 'bt-think-time' }, `· ${elapsedLabel(Math.max(1000, ms))}`) : null),
    h('div', { ref: box, className: 'bt-think-text', role: 'region', 'aria-label': title, tabIndex: 0, 'data-fade': fade, onScroll: measure }, text))
}

// The files a finished turn changed or delivered, linked from inline code in its
// reply as in DSH's own chat. DSH resolves them for the step that closes the turn.
function useFileMentions({ node, openFile, fileMentions, useTurnData }) {
  const tail = useTurnData?.('turn-tail')
  const location = node.location
  const turn = location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
  const seq = node.data.finalNode?.seq
  return useMemo(() => {
    if (typeof fileMentions !== 'function' || turn?.status !== 'closed' || seq === undefined) return undefined
    return tail?.closing?.finalNode.seq === seq ? fileMentions({ turn, seq, openFile }) : undefined
  }, [fileMentions, openFile, seq, tail, turn])
}

export function AssistantCell({ node, groupPart, sessionId, openFile, fileMentions, useTurnData, useRoster, useUi, useTurnSteps, useTurnContext, actions }) {
  const roster = useRoster(value => value)
  const data = node.data
  const steps = useTurnSteps(String(data.turn))
  const contexts = useTurnContext(String(data.turn))
  const mentions = useFileMentions({ node, openFile, fileMentions, useTurnData })
  const hidden = Boolean(roster.roomsById[sessionId]) || isHiddenTurn(roster, sessionId, data.turn)
  const texts = groupPart === 'reasoning' ? [] : data.blocks.filter(block => block.kind === 'text' && block.text.trim() !== '').map(block => heldText(block.text))
  const running = data.status === 'running'
  const members = steps.length ? steps : [data]
  const shown = thinkingShown(roster.prefs)
  const reasoning = groupPart === 'response' || !shown ? '' : turnReasoning(steps, data)
  // A live step of the same Turn keeps the row ticking even when it sits on an
  // earlier step's cell.
  const thinking = groupPart === 'response' || !shown ? undefined : thinkingStep(members)
  const ms = useThinkingMs({ sessionId, turn: data.turn, settledSteps: members.filter(step => step.status !== 'running').length, skip: hidden || reasoning === '' })
  // A streaming reply stands in for the activity row.
  useLiveNote(actions, sessionId, `text:${node.key ?? data.seq}`, !hidden && running && texts.length > 0 ? { text: true } : null)
  if (hidden) return h(CellEmpty)
  // A relay spliced mid-turn is a 'context' node, hidden from the chat flow on
  // DSH 0.2; the step that answers it shows the event line where it was read,
  // once, in the step's first cell.
  const relays = relayPart(data, groupPart) ? relaysBefore(contexts, steps, data) : []
  const activity = groupPart === 'response' ? [] : stepActivity(data)
  if (texts.length === 0 && !reasoning && relays.length === 0 && activity.length === 0) return h(CellEmpty)
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  // The flat layout heads a reply with who speaks, once per Turn: in the step that opens
  // it, in that step's reasoning part when the reasoning shows there.
  const speaker = layoutOf(roster.prefs) === 'flat' ? roster.byId[sessionId] : undefined
  const head = speaker !== undefined && opensReply(steps, data, shown)
    && (reasoning !== '' || (texts.length > 0 && !(groupPart === 'response' && shown && turnReasoning(steps, data) !== '')))
  return h(Fragment, null,
    relays.map(relay => {
      const source = relay.source
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      return h(EventLine, {
        key: relay.seq,
        prefix: source.role === 'stopped' ? t('Stopped by') : source.role === 'reply' ? t('Reply from') : t('Message from'),
        bots: [sender],
        roster,
        onOpen: () => { if (sender.id) actions.openExchange(selfId, sender.id) },
        whole: true,
      })
    }),
    head ? h(SpeakerHead, { bot: speaker, time: data.time }) : null,
    activity.length ? h(ActivityRows, { lines: activity }) : null,
    reasoning ? h(ThinkingRow, {
      text: reasoning, live: thinking !== undefined, viewKey: `${sessionId}:${data.turn}`,
      // The live clock counts the settled steps too: backing `at` by the settled
      // time makes one Elapsed show settled + running.
      ...(thinking !== undefined ? { at: typeof thinking.time === 'number' ? thinking.time - (ms ?? 0) : undefined } : { ms }),
    }) : null,
    texts.length ? h(Bubbles, { texts, roster, selfId, actions, streaming: running, sessionId, msgKey: `${sessionId}:${data.turn}:${node.key ?? data.seq ?? ''}`, useUi, mentions, fold: FOLD_HUGE, time: speaker === undefined ? data.time : undefined }) : null)
}

// `code` in an activity line is the command or path the agent works on.
const activityParts = line => line.split('`').map((part, index) => (index % 2 === 1 ? h('code', { key: index }, part) : part))

function ActivityRows({ lines, bot }) {
  return h('div', { className: 'bt-agent-activity' }, lines.map((line, index) => h('div', {
    key: index, className: 'bt-agent-act', title: bot?.name ? `${bot.name} · ${line}` : line,
  }, bot ? h(BotMark, { bot, size: 16, live: false }) : h('span', { className: 'bt-agent-act-mark', 'aria-hidden': true }),
  h('span', { className: 'bt-agent-act-text' }, activityParts(line)))))
}

export const SkillActivityRow = ({ name, bot }) => h(ActivityRows, { lines: [t('Skill: {name}', { name })], bot })

export function ToolActivityRow({ label, name, target, bot }) {
  const line = label === 'plugin' ? t('Plugin: {name}', { name }) : t('Tool: {name}', { name })
  return h(ActivityRows, { lines: [target ? line + ' · `' + target + '`' : line], bot })
}

const TOOL_ACTIVITY_BOUNDARY = 'tool-activity-boundary'

export function registerToolActivity(ctx) {
  const register = definition => ctx.uiConversation?.events?.register?.(definition)
  const boundary = event => ({ id: String(event.seq), role: 'start' })
  const offBoundary = register({
    kind: TOOL_ACTIVITY_BOUNDARY,
    match: { 'turn/start': boundary, 'turn/end': boundary },
    start: (_context, { event }) => ({ turn: event.data.turn }),
    update: context => context.state,
  })
  const callKey = id => JSON.stringify(['call', id])
  const toCall = ({ event, location }, turn) => {
    const { callId, subCallId, parentCallId, name, arguments: args } = event.data
    return { turn, seq: event.seq, location, root: { phase: 'start', callId: subCallId ?? callId, parentCallId,
      name, argsRaw: typeof args === 'string' ? args : JSON.stringify(args), turn, subCalls: [] } }
  }
  const dispatch = event => typeof event.data?.subCallId === 'string'
    ? { id: JSON.stringify(['dispatch', event.data.subCallId]), role: event.type.endsWith('-start') ? 'start' : 'update' }
    : null
  const offRows = register({
    kind: TOOL_ACTIVITY,
    target: 'chat',
    match: {
      [BRIDGE_ACTIVITY_RECORD]: event => toolEventOf(event) ? { id: callKey(event.data.callId), role: 'start' } : null,
      'tool/call': event => typeof event.data?.callId === 'string' ? { id: callKey(event.data.callId), role: 'start' } : null,
      'tool/result': event => {
        const id = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
        return typeof id === 'string' ? { id: callKey(id), role: 'update' } : null
      },
      'tool/ptc-dispatch-start': dispatch,
      'tool/ptc-dispatch': dispatch,
    },
    start: (_context, match, reader) => {
      const { event, location } = match
      const turn = event.data?.turn ?? location.turn?.turn
      if (event.type === BRIDGE_ACTIVITY_RECORD) {
        return { turn: turn ?? reader.previous(TOOL_ACTIVITY_BOUNDARY)?.state.turn,
          seq: event.seq, location, activity: toolEventOf(event) }
      }
      return toCall(match, turn)
    },
    update({ state }, match) {
      const { event, location } = match
      if (event.type === 'tool/call' && state.activity) return toCall(match, event.data.turn ?? location.turn?.turn)
      if (!state.root || state.root.kind === 'tool-result') return state
      const { parentCallId, message, error, meta } = event.data
      if (event.type === 'tool/ptc-dispatch' && parentCallId !== state.root.parentCallId) return state
      if (event.type !== 'tool/result' && event.type !== 'tool/ptc-dispatch') return state
      const { content, isError } = message ?? event.data
      return { ...state, root: { ...state.root, kind: 'tool-result', content, isError, error, meta } }
    },
    buildViewNode({ key, id, start, state, current }) {
      if (!start || !state) return null
      const visible = Number.isSafeInteger(state.turn) && (state.root || state.activity)
      if (!visible && !current.get('chat')) return null
      return { key, id, kind: TOOL_ACTIVITY, target: 'chat', anchorSeq: state.seq,
        location: state.location, groupTree: 'turn', visibility: visible ? 'visible' : 'hidden', data: state }
    },
  })
  return () => { offRows?.(); offBoundary?.() }
}

export function ToolActivityCell({ node, sessionId, useRoster, ...props }) {
  const { turn, activity, root } = node.data
  const hidden = useRoster(roster => Boolean(roster.roomsById[sessionId]) || isHiddenTurn(roster, sessionId, turn))
  if (root) return h(ToolCell, { ...props, node: { ...node, data: { root } }, sessionId, useRoster, activityDispatch: true })
  return hidden || !activity ? h(CellEmpty) : h(ToolActivityRow, activity)
}

export const OrderedToolCell = props => h(ToolCell, { ...props, orderedDispatch: true })

export function registerSkillActivity(ctx) {
  return ctx.uiConversation?.events?.register?.({
    kind: SKILL_ACTIVITY,
    target: 'chat',
    match: { [SKILL_ACTIVITY_RECORD]: event => {
      const activity = skillActivityOf(event)
      return activity && activity.roomId === undefined ? { id: event.data.id, role: 'start' } : null
    } },
    start: (_context, { event }) => skillActivityOf(event),
    update: context => context.state,
    buildViewNode({ key, id, start, state }) {
      if (!start || !state) return null
      const placement = state.turn === undefined ? { location: { kind: 'session' } }
        : { location: start.location, groupTree: 'turn' }
      return { key, id, kind: SKILL_ACTIVITY, target: 'chat', anchorSeq: start.event.seq,
        ...placement, visibility: 'visible', data: state }
    },
  })
}

export function SkillActivityCell({ node, sessionId, useRoster }) {
  const hidden = useRoster(roster => Boolean(roster.roomsById[sessionId]) || isHiddenTurn(roster, sessionId, node.data.turn))
  return hidden ? h(CellEmpty) : h(SkillActivityRow, { name: node.data.name })
}

// Only current owner records carry the identity needed to resolve Solver looks.
const snapshotLook = (bot, roster) => roster.byId[bot.id] === bot ? undefined : catalogueLookOf(bot)

function EventLine({ prefix, bots, roster, joiner = t('and'), onOpen, whole = false }) {
  if (whole && bots.length === 1) {
    const [bot] = bots
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', className: 'bt-event-whole', title: bot.name, onClick: () => onOpen?.(bot) },
        h('span', null, prefix), h(BotMark, { bot, look: snapshotLook(bot, roster), size: 16 }), h('span', { className: 'bt-event-name' }, bot.name)))
  }
  const parts = []
  parts.push(h('span', { key: 'p' }, prefix))
  bots.forEach((bot, index) => {
    if (index > 0) parts.push(h('span', { key: `j${index}` }, joiner))
    parts.push(h('button', { key: bot.id ?? index, type: 'button', onClick: () => onOpen?.(bot) },
      h(BotMark, { bot, look: snapshotLook(bot, roster), size: 16 }), bot.name))
  })
  return h('div', { className: 'bt-event' }, parts)
}

// The flat layout's head over a Bot's reply in its own chat: avatar, name, time.
function SpeakerHead({ bot, time }) {
  return h('div', { className: 'bt-group-name' },
    h('span', { className: 'bt-lead' }, h(BotMark, { bot, size: 22 })), bot.name,
    Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null)
}

const CHAIN_BREAK_SEL = '.bt-group-msg, .bt-umsg, .bt-urow, [data-chat-flow-kind=user], [data-chat-flow-kind=command-input], .bt-q-inline, .bt-event, .bt-time-sep, .bt-new-sep, .bt-part-line, .bt-btw-card, .bt-learn-card'
export function syncGroupChains(flow) {
  const items = [...flow.querySelectorAll(CHAIN_BREAK_SEL)]
  for (let i = 0; i < items.length; i += 1) {
    const curr = items[i]
    if (!curr.classList.contains('bt-group-msg')) continue
    const prev = items[i - 1]
    const next = items[i + 1]
    const botId = curr.dataset.botId
    const chainPrev = Boolean(botId && prev?.classList.contains('bt-group-msg') && prev.dataset.botId === botId)
    const chainNext = Boolean(botId && next?.classList.contains('bt-group-msg') && next.dataset.botId === botId)
    if (chainPrev) curr.dataset.chainPrev = ''; else delete curr.dataset.chainPrev
    if (chainNext) curr.dataset.chainNext = ''; else delete curr.dataset.chainNext
    const turn = curr.closest('[data-chat-group-key]')
    if (turn) {
      if (chainPrev) turn.dataset.btChainPrev = ''; else delete turn.dataset.btChainPrev
      if (chainNext) turn.dataset.btChainNext = ''; else delete turn.dataset.btChainNext
    }
  }
}

const pendingFlows = new WeakSet()
function scheduleGroupChains(flow) {
  if (!flow || pendingFlows.has(flow)) return
  pendingFlows.add(flow)
  queueMicrotask(() => {
    pendingFlows.delete(flow)
    if (flow.isConnected !== false) syncGroupChains(flow)
  })
}

// One Bot message inside a group chat: avatar, name (with its group role), when it ran
// and how long it took, bubble. The flat layout moves the avatar from beside the last
// bubble to the head of the name row, so the text below runs the whole width.
function GroupMessage({ bot, text, texts = [text], room, roster, actions, msgKey, useUi, whole, time, duration }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el?.closest) return undefined
    const flow = el.closest('[data-chat-flow]')
    if (!flow) return undefined
    scheduleGroupChains(flow)
    return () => scheduleGroupChains(flow)
  }, [bot.id])
  const lead = h('button', { type: 'button', className: 'bt-lead', 'aria-label': t("Open {name}'s chat", { name: bot.name }), onClick: () => actions.openSession(bot.id) },
    h(BotMark, { bot, look: snapshotLook(bot, roster), size: 22 }))
  const flat = layoutOf(roster.prefs) === 'flat'
  const took = Number.isFinite(duration) && duration >= 1000 ? elapsedLabel(duration) : undefined
  return h('div', { ref, className: 'bt-group-msg', 'data-bot-id': bot.id },
    h('span', { className: 'bt-group-name', style: flat ? undefined : { color: inkText(colorOf(bot)) } }, flat ? lead : null, bot.name,
      room?.admin === bot.id ? h('span', { className: 'bt-group-role' }, t('Admin')) : null,
      Number.isFinite(time) ? h('span', { className: 'bt-group-time', title: clockLabel(time) }, messageClock(time)) : null,
      took ? h('span', { className: 'bt-group-took', title: t('Ran for {duration}', { duration: took }) }, took) : null),
    h(Bubbles, { texts, roster, selfId: bot.id, actions, sessionId: room?.id, msgKey, useUi, lead: flat ? null : lead, whole }))
}

// A member's messages in a row, as one block under its name (shared with the host's own log).
export { stackReplies }

// A centered event line that names a group chat and opens it.
function GroupEvent({ prefix, room, name, roster, actions }) {
  return h('div', { className: 'bt-event' },
    h('span', null, prefix),
    room ? h('button', { type: 'button', onClick: () => actions.openSession(room.id) }, h(RoomAvatar, { room, roster, size: 16 }), room.name)
      : name ? h('span', null, name) : null)
}

// The results a memory write answers with when it changed the memory, and the
// one that says the entry was there already.
const MEMORY_SAVED = /^(Saved to|Updated in|Removed from) /
const MEMORY_ALREADY = /^Already in /

// The words the memory tools take for a scope.
const MEMORY_TEAM = /^(team|团队|共享)$/i
const MEMORY_OWN = /^(own|me|mine|self|yours?|自己|我)$/i
const MEMORY_GROUP = /^(group|this group|群|本群|群聊)$/i

// Why a memory write changed nothing, in the interface language. The host's own
// words stay in the tool record: they can name the entries that were asked
// about, and the notice does not repeat them.
function memoryFailure(code) {
  if (!code) return undefined
  switch (code) {
    case 'memory/empty': return t('Write something to save')
    case 'memory/no-match': return t('No saved entry matched')
    case 'memory/refused':
    case 'memory/denied': return t('The memory refused this change')
    // A write that broke, and any failure this interface does not know.
    default: return t('The memory could not be changed')
  }
}

// A change remember or forget made, which opens the memory it changed. A
// refusal and a write that failed changed nothing, and say so, with the way
// into the memory panel.
function MemoryEvent({ sessionId, scope, tool, result, failed, code, roster, actions, findBot }) {
  const self = roster.byId[sessionId]
  const room = roster.roomsById[sessionId]
  const named = String(scope ?? '').trim()
  const team = MEMORY_TEAM.test(named)
  const other = team || named === '' ? undefined : findBot(named)
  const target = other && other.id !== self?.id ? other : self
  // The panel that shows the memory: the Bot's own, the group's in a group chat,
  // or none when the scope names a Bot that is not there.
  const panel = team ? self?.id
    : MEMORY_OWN.test(named) ? self?.id
      : MEMORY_GROUP.test(named) ? room?.id
        : named === '' ? (room?.id ?? self?.id)
          : other?.id
  if (!failed && MEMORY_ALREADY.test(result)) {
    // The entry was there already: a quiet line, and the panel shows it.
    return h('div', { className: 'bt-event' },
      panel === undefined ? h('span', null, h(MemoryIcon), t('Already saved')) : h('button', { type: 'button', onClick: () => actions.openMemory(panel) }, h(MemoryIcon), t('Already saved')))
  }
  if (!failed && MEMORY_SAVED.test(result)) {
    if (!target) return h(CellEmpty)
    const label = team ? t('Team memory updated') : target === self ? t('Memory updated') : t("Updated {name}'s memory", { name: target.name })
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', title: result, onClick: () => actions.openMemory(target.id) }, h(MemoryIcon), label))
  }
  // Nothing was saved. The reason is a short line of our own; what the host
  // said stays in the tool record.
  const reason = memoryFailure(code)
  const label = failed
    ? (tool === 'forget' ? t("Couldn't remove from memory") : t("Couldn't save to memory"))
    : t('Memory not changed')
  return h('div', { className: 'bt-event bt-event-error', role: 'status', title: code },
    h('span', null, h(MemoryIcon), label),
    reason ? h('span', null, ` · ${reason}`) : null,
    panel === undefined ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openMemory(panel) }, t('Manage')))
}

// The line where a part begins. `switchedTo`: the agent an agent switch moved the chat to
// there (RFC 0030, Handoff note), named as the model menu names it, in the same span.
export function PartLine({ time, switchedTo, roster }) {
  const switched = typeof switchedTo === 'string' && switchedTo !== '' ? t('Switched to {agent}', { agent: agentNameOf(roster, switchedTo) }) : undefined
  const day = Number.isFinite(time) ? dayLabel(time) : undefined
  return h('div', { className: 'bt-part-line', role: 'separator' },
    switched === undefined && day === undefined ? null : h('span', null, [switched, day].filter(part => part !== undefined).join(' · ')))
}

const scrollParent = (node) => {
  for (let at = node.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at
  }
  return null
}

function EarlierUser({ row, actions }) {
  const { shown, folded, control, code, codeHead } = useFold(row.text ?? '')
  const body = row.text && shown !== '' ? h(MarkdownText, { text: shown, labels: mdLabels(), variant: 'compact' }) : null
  const area = foldArea(body, code, codeHead, actions)
  return h('div', { className: 'bt-urow' }, h('div', { className: 'bt-ububble', 'data-folded': folded || undefined },
    control ? h('div', { className: 'bt-fold-body' }, area) : area,
    control,
    row.images ? h('span', { className: 'bt-uimages' }, row.images === 1 ? t('1 image') : t('{count} images', { count: row.images })) : null),
    row.via ? h('div', { className: 'bt-utime' }, h(ViaTag, { via: row.via }), Number.isFinite(row.time) ? messageClock(row.time) : null) : null)
}

// The earlier parts of a Bot's own chat, above its current part as one conversation.
// Pages load from the host as the user scrolls up; a thin line marks where each
// part begins, the last one where the current part begins.
function EarlierParts({ sessionId, roster, actions }) {
  const [view, setView] = useState({ pages: [], cursor: undefined, loading: true, failed: false, startedAt: null, switchedTo: null })
  const top = useRef(null)
  const busy = useRef(false)
  const generation = useRef(0)
  const restore = useRef(null)
  const load = (cursor) => {
    if (busy.current) return
    const mine = generation.current
    // The host numbers a page by the same part index: cursor.part, or the part
    // before this one. A group's own Session chains `room.ownParts` + `sessionId`.
    const room = roster.roomsById[sessionId]
    const owner = roster.byId[sessionId] ?? (room === undefined ? undefined : { parts: room.ownParts, sessionId: room.sessionId })
    const partIndex = partIndexOf(owner, sessionId, cursor)
    busy.current = true
    setView(current => ({ ...current, loading: true, failed: false }))
    actions.earlier(sessionId, cursor).then((page) => {
      if (mine !== generation.current) return
      busy.current = false
      // The chat's scroller does not anchor content prepended above the viewport,
      // so the page keeps its distance from the end by hand.
      const scroller = top.current && scrollParent(top.current)
      if (scroller) restore.current = { scroller, fromEnd: scroller.scrollHeight - scroller.scrollTop }
      const incoming = Array.isArray(page.items) ? page.items : []
      setView(current => {
        const pages = current.pages.slice()
        const at = pages.findIndex(entry => entry.partIndex === partIndex)
        // The host sends a part's aside cards on every page of that part.
        const btw = Array.isArray(page.btw) ? page.btw : (at >= 0 ? pages[at].btw : [])
        if (at >= 0) pages[at] = { partIndex, items: [...incoming, ...pages[at].items], btw }
        else pages.push({ partIndex, items: incoming, btw })
        pages.sort((a, b) => a.partIndex - b.partIndex)
        return { pages, cursor: page.cursor, loading: false, failed: false, startedAt: page.startedAt ?? current.startedAt, switchedTo: page.switchedTo ?? current.switchedTo }
      })
    }, () => {
      if (mine !== generation.current) return
      busy.current = false
      setView(current => ({ ...current, loading: false, failed: true }))
    })
  }
  const closedEarlier = JSON.stringify((roster.byId[sessionId]?.parts ?? []).map(part => roster.closedCards?.[part] ?? null))
  useEffect(() => {
    generation.current += 1
    busy.current = false
    setView({ pages: [], cursor: undefined, loading: true, failed: false, startedAt: null, switchedTo: null })
    load(undefined)
    return () => { generation.current += 1 }
  }, [sessionId, closedEarlier])
  useLayoutEffect(() => {
    const pending = restore.current
    restore.current = null
    if (pending) pending.scroller.scrollTop = pending.scroller.scrollHeight - pending.fromEnd
  }, [view.pages])
  useEffect(() => {
    const node = top.current
    if (!node || view.loading || view.failed || !view.cursor || typeof IntersectionObserver !== 'function') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) load(view.cursor)
    }, { root: scrollParent(node), rootMargin: '600px 0px 0px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [view.cursor, view.loading, view.failed])
  const removeBtw = cardId => setView(current => ({
    ...current,
    pages: current.pages.map(page => ({ ...page, btw: page.btw.filter(card => card?.id !== cardId) })),
  }))
  const items = []
  const bot = roster.byId[sessionId]
  for (const page of view.pages) {
    items.push(...withBtwRows(page.items, page.btw))
    const notice = guardOffNoticeOf(bot, bot?.parts?.[page.partIndex])
    if (notice !== undefined) items.push({ ...notice, name: bot.name, time: notice.at })
  }
  return h('div', { className: 'bt-earlier', role: 'feed', 'aria-label': t('Earlier messages'), 'aria-busy': view.loading },
    h('div', { ref: top, className: 'bt-earlier-top' },
      view.loading ? h(Shimmer, null, t('Loading earlier messages…'))
        : view.failed ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Couldn’t load earlier messages · Retry'))
          : view.cursor ? h('button', { type: 'button', className: 'bt-soft', onClick: () => load(view.cursor) }, t('Load earlier')) : null),
    h(ChatRows, { items, sessionId, roster, actions, onBtwDelete: removeBtw }),
    h(PartLine, { time: view.startedAt, switchedTo: view.switchedTo, roster }))
}

// A Bot chat's entries as the host lists them (the `earlier` and `chat` endpoints): the
// Bot's messages in a row are one block, and a thin line marks where a part begins.
// `clock` adds the time separators: one above the first entry, and one after each pause.
export function ChatRows({ items, sessionId, roster, actions, useUi, clock = false, onBtwDelete }) {
  const selfId = roster.byId[sessionId]?.id
  const rows = []
  for (const item of items) {
    const last = rows.at(-1)
    if (item.kind === 'bot' && last?.kind === 'bot') {
      last.texts.push(item.text)
      last.end = item.time
    } else rows.push(item.kind === 'bot' ? { kind: 'bot', texts: [item.text], time: item.time, end: item.time } : item)
  }
  let before
  return rows.flatMap((row, index) => {
    // Pages are prepended, so a row keeps its distance from the end.
    const key = rows.length - index
    const shown = chatRow(row, key, { sessionId, selfId, roster, actions, useUi, onBtwDelete })
    // A part's first entry shows its time under the part's line, as a chat's first one does.
    if (row.kind === 'divider') {
      before = undefined
      return [shown]
    }
    const pause = clock && Number.isFinite(row.time) && (before === undefined || row.time - before >= SEPARATOR_GAP_MS)
    if (Number.isFinite(row.end ?? row.time)) before = row.end ?? row.time
    return pause ? [h('div', { key: `${key}:clock`, className: 'bt-time-sep', role: 'separator' }, clockLabel(row.time)), shown] : [shown]
  })
}

// `useUi` gives a block its reactions and its Reply tool.
function chatRow(row, key, { sessionId, selfId, roster, actions, useUi, onBtwDelete }) {
  switch (row.kind) {
    case 'divider': return h(PartLine, { key, time: row.time, switchedTo: row.switchedTo, roster })
    case GUARD_OFF_NOTICE: return h(UpgradeLine, { key: row.id, name: row.name, off: row.kind })
    case 'user': return h(EarlierUser, { key, row, actions })
    case SKILL_NOTICE: return h(SkillNotice, { key, text: row.text })
    case SKILL_ACTIVITY: return h(SkillActivityRow, { key, name: row.name })
    case TOOL_ACTIVITY: return h(ToolActivityRow, { ...row, key })
    case 'answer': return h(AnsweredReply, { key, node: { data: row } })
    // A question or view card closed without an answer on it.
    case 'closed': return row.view === undefined
      ? h('div', { key, className: 'bt-q-inline' }, h(SettledQuestion, { question: row.question, closed: row.closed }))
      : h(ClosedView, { key, title: row.title, view: row.view, closed: row.closed })
    // A display-only view replays from the blueprint the host kept on the call.
    case 'view': return h(WidgetCell, { key, sessionId, callId: row.callId, args: { text: name => name === 'title' ? row.title : undefined, value: name => name === 'view' ? row.view : undefined }, done: true, isError: false, roster, actions })
    case 'bot': {
      const bubbles = h(Bubbles, { key, texts: row.texts, roster, selfId, actions, sessionId: useUi ? sessionId : undefined, msgKey: useUi ? `${sessionId}:${row.time}` : undefined, useUi, fold: FOLD_HUGE })
      const speaker = layoutOf(roster.prefs) === 'flat' ? roster.byId[selfId] : undefined
      return speaker ? h(Fragment, { key }, h(SpeakerHead, { bot: speaker, time: row.time }), bubbles) : bubbles
    }
    case 'btw': return h(BtwCardView, { key, card: row.card, sessionId, actions, onDeleted: onBtwDelete })
    case 'post': {
      // A member's message in a group's earlier part, as the live row shows it.
      const poster = roster.byId[row.botId] ?? { id: row.botId, name: row.name ?? t('a Bot'), color: 'gray' }
      return h(GroupMessage, {
        key, bot: poster, text: row.file ? stripLongNote(row.text) : row.text, texts: row.texts, room: roster.roomsById[sessionId], roster, actions,
        msgKey: `${sessionId}:post:${row.seq ?? row.time}`, time: row.time, duration: row.duration,
        whole: row.file ? { length: row.length, load: () => actions.fileText(row.file) } : undefined,
      })
    }
    case 'relay': {
      // A round notice from a group_relay result on an earlier part, the row the
      // live chat draws for it.
      const reply = row.reply
      const speaker = roster.byId[reply.botId] ?? { id: reply.botId, name: reply.name ?? t('a Bot'), color: reply.color ?? 'gray' }
      return h(RelayEvent, { key, reply, bot: speaker, roster, sessionId, actions })
    }
    case 'event': {
      if (row.role === 'report') return h(GroupEvent, { key, prefix: t('Replies from'), room: roster.roomsById[row.roomId], name: t('a group chat'), roster, actions })
      const other = roster.byId[row.botId] ?? { id: row.botId, name: row.name ?? t('a Bot'), color: 'gray' }
      const prefix = { stopped: t('Stopped by'), reply: t('Reply from') }[row.role] ?? t('Message from')
      return h(EventLine, { key, prefix, bots: [other], roster, onOpen: () => { if (selfId && other.id) actions.openExchange(selfId, other.id) }, whole: true })
    }
    default: return null
  }
}

// The one line a Solver's chat shows where the one-time upgrade turned its review guard on (RFC
// 0048 delivery 1.5, `reviewGuardNotice`): only in the part it was stored for, after the last turn
// that ended at or before it, or above the part's first turn when every turn began after it. A
// part opened later, or an earlier page not loaded yet, shows none.
export function upgradeNoticeOf(roster, sessionId) {
  for (const bot of roster?.bots ?? []) {
    const notice = bot?.reviewGuardNotice
    if (notice === null || typeof notice !== 'object' || typeof notice.at !== 'number' || !Number.isFinite(notice.at)) continue
    if (typeof notice.sessionId === 'string' && notice.sessionId === sessionId) return { at: notice.at, name: bot.name }
  }
  return undefined
}
const noticeKey = (roster, sessionId) => {
  const notice = upgradeNoticeOf(roster, sessionId)
  return notice === undefined ? '' : `${notice.at}\u0000${notice.name}`
}
const noticeOfKey = (key) => {
  if (key === '') return undefined
  const cut = key.indexOf('\u0000')
  return { at: Number(key.slice(0, cut)), name: key.slice(cut + 1) }
}
/** Whether the upgrade line goes right after a turn that ended at `end`, the next one starting at `nextStart`. */
export const noticeAfterTurn = (at, end, nextStart) => typeof end === 'number' && end <= at && (nextStart === undefined || nextStart > at)
/** Whether it goes above a turn: the part's first, begun after it. */
export const noticeBeforeTurn = (at, first, start) => first === true && typeof start === 'number' && start > at
function UpgradeLine({ name, off }) {
  const text = off ? GUARD_GROUP_COPY.off
    : 'The review guard is now on for {name}: its work waits for its reviewer\'s verdict on the plan. You can turn it off in Details.'
  return h('div', { className: 'bt-event', 'data-review-guard-notice': off ?? '' }, t(text, { name }))
}

// A saved OFF belongs to this part even when it has no turns to attach to.
export function GuardOffLine({ sessionId, useRoster }) {
  const bot = useRoster(roster => roster.bots?.find(bot => guardOffNoticeOf(bot, sessionId)))
  const notice = guardOffNoticeOf(bot, sessionId)
  return notice === undefined ? null : h(UpgradeLine, { name: bot.name, off: notice.kind })
}

export function TriggerCell({ node, sessionId, useRoster, useSessions, useTurnClock, useUi, actions }) {
  const roster = useRoster(value => value)
  const data = node.data
  const source = data.source !== null && typeof data.source === 'object' ? data.source : {}
  // Team state (exchanges) is keyed by the Bot id; Session state by the part shown.
  const selfId = roster.byId[sessionId]?.id ?? sessionId
  // A resumed handoff keeps the relayed message's source, but it opens a part, not a run.
  // A deferred request was already shown where the Bot read it mid-turn; the turn
  // that answers it adds no second line.
  const deferred = source.kind === 'bot' && source.deferred === true
  const relayed = isRelayContext(data)
  const turn = node.location?.turn?.turn ?? data.turn
  // Noted before paint so a folded line never flashes in before its run's first line.
  useLayoutEffect(() => {
    if (relayed) actions.noteTurnPeer(sessionId, turn, source.senderSessionId)
  }, [relayed, sessionId, turn, source.senderSessionId])
  const order = useSessions((list) => {
    const outline = list.projectionsBySession?.[sessionId]?.values?.turnOutline ?? list.byId[sessionId]?.projectionValues?.turnOutline
    return Array.isArray(outline) ? outline.map(entry => entry.turn).join(',') : ''
  })
  const peers = useTurnClock((state) => {
    if (!relayed) return ''
    const turns = state[sessionId] ?? {}
    return Object.keys(turns).filter(key => turns[key].peer !== undefined).map(key => `${key}:${turns[key].peer}`).join(',')
  })
  // A conversation opened for the first time since it began starts under the
  // unread divider, with its opening time below it.
  const visit = useUi(state => state.visits?.[sessionId])
  const hiddenTurns = roster.exchangeTurns[sessionId]
  const unreadOpening = useTurnClock((state) => {
    const first = openingTurn(state[sessionId], order, hiddenTurns)
    return first?.turn === turn && unseenSince(visit, first.start) ? clockLabel(first.start) : ''
  })
  const body = triggerBody()
  const notice = noticeOfKey(noticeKey(roster, sessionId))
  const firstTurn = order !== '' && Number(order.split(',')[0]) === turn
  const upgrade = notice !== undefined && noticeBeforeTurn(notice.at, firstTurn, node.location?.turn?.start?.time ?? data.time)
    ? h(UpgradeLine, { name: notice.name }) : null
  const opening = unreadOpening
    ? h(Fragment, null, h('div', { className: 'bt-open-new' }, h(NewDivider), h('div', { className: 'bt-time-sep', role: 'separator' }, unreadOpening)), body)
    : body
  return upgrade === null ? (opening ?? h(CellEmpty)) : h(Fragment, null, upgrade, opening)

  function triggerBody() {
    if (source.kind === 'bot') {
      // A part opens with its handoff package, so the earlier parts go right above it.
      if (source.handoff === true) return h(EarlierParts, { sessionId, roster, actions })
      // Group turns belong to the group chat; the member's own chat stays one-to-one. An agent
      // switch's note turn is the switch's own work: the composer lock already says so.
      if (source.role === 'kickoff' || source.role === 'room' || source.role === 'goal' || source.role === 'handoff-note') return null
      // The secret card itself shows what the user did; the note to the Bot stays out.
      if (source.role === 'secret' || deferred) return null
      // A profile notice is the user's edit landing in the Bot's chat, not a peer
      // message: show it as an event, with no exchange to open.
      if (source.role === 'update') return h('div', { className: 'bt-event' }, t('Profile updated'))
      if (source.role === 'post') {
        // A post logged into a running round already shows there, not again as a trigger.
        if (source.logged !== undefined) return null
        // A member's late failure, its work picked up after a restart, its work the user
        // stopped, or the end of its work shows as an event of the round it opens.
        if (source.failed !== undefined || source.resumed === true || source.stopped === true || source.done === true) return null
        const room = roster.roomsById[sessionId]
        const poster = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
        // A post past what a message holds came as a file, with its start only.
        const file = source.length === undefined ? undefined : (data.content ?? []).find(block => block?.type === 'file')?.attachment
        const text = stripHeader(contentText(data.content))
        // A trigger's data carries no turn; its event seq is the one durable name of this post.
        return h(GroupMessage, {
          bot: poster, text: file ? stripLongNote(text) : text, room, roster, actions, msgKey: `${sessionId}:post:${data.seq ?? node.key}`, useUi, time: data.time,
          whole: file ? { length: source.length, load: () => actions.fileText(file) } : undefined,
        })
      }
      if (source.role === 'report') {
        return h(GroupEvent, { prefix: t('Replies from'), room: roster.roomsById[source.roomId], name: t('a group chat'), roster, actions })
      }
      // A task this Bot started under Tasks came back: the line says how it ended and opens it.
      if (source.role === 'task-done') {
        const title = /^\[Task "(.*)" finished/.exec(contentText(data.content))?.[1] ?? t('a task')
        return h('div', { className: 'bt-event bt-task-done' },
          h(TasksIcon, { size: 15 }), h('span', null, endLabel(roster.tasks?.[source.taskSessionId])),
          source.taskSessionId ? h('button', { type: 'button', className: 'bt-task-link', onClick: () => actions.openSession(source.taskSessionId) }, title) : h('span', null, title))
      }
      // A request carried on keeps its role, but its message line was shown already.
      if (source.role === 'resume' || source.resumed === true) return h('div', { className: 'bt-event' }, t('Picked up its work after a restart'))
      if (source.role === 'retry' || source.retried === true) return h('div', { className: 'bt-event' }, t('Asked to make the tool call it wrote as text'))
      // The repair card's Retry: the user's message is not sent again, nor is the note to the Bot.
      if (source.role === 'continue') return h('div', { className: 'bt-event' }, t('Went on after the failed turn'))
      const run = relayed ? commRunOf(
        order.split(',').filter(Boolean).map(Number),
        Object.fromEntries(peers.split(',').filter(Boolean).map(pair => [Number(pair.slice(0, pair.indexOf(':'))), pair.slice(pair.indexOf(':') + 1)])),
        turn,
        hiddenTurns,
      ) : null
      if (run === 'folded') return null
      const sender = roster.byId[source.senderSessionId] ?? { id: source.senderSessionId, name: source.senderName ?? t('a Bot'), color: 'gray' }
      const count = run?.count ?? (isHiddenTurn(roster, sessionId, turn) ? 2 : 1)
      // Peers may be named by any part of their chat, so they are matched by Bot.
      const bots = [sender]
      for (const peer of (run?.peerIds ?? []).map(id => roster.byId[id]).filter(Boolean)) {
        if (!bots.some(bot => bot.id === peer.id)) bots.push(peer)
      }
      return h(EventLine, {
        prefix: source.role === 'stopped' ? t('Stopped by') : count > 1 ? t('{count} messages with', { count }) : t('Message from'),
        bots,
        roster,
        onOpen: bot => actions.openExchange(selfId, bot.id),
        whole: true,
      })
    }
    if (source.kind === 'schedule') {
      const prompts = reminderPrompts(contentText(data.content))
      return h('div', { className: 'bt-event' }, prompts.length > 0 ? t('Scheduled task: {text}', { text: prompts.join(' · ').slice(0, 80) }) : t('Routine started'))
    }
    if (source.kind === 'user-question-reply' || source.kind === 'goal') return null
    return h('div', { className: 'bt-event' }, contentText(data.content).slice(0, 80) || t('Update'))
  }
}

function NewDivider() {
  return h('div', { className: 'bt-new-sep', role: 'separator', 'aria-label': t('New messages') }, h('span', null, t('New')))
}

export function TurnProcessCell({ node, sessionId, turnProcess, useRoster, useUi, useTurnClock, actions }) {
  const open = turnProcess === undefined || !turnProcess.foldable || turnProcess.open
  useEffect(() => {
    if (!open) turnProcess.setOpen(true)
  }, [open, turnProcess])
  const turn = node?.location?.turn?.turn ?? node?.data?.turn
  const start = node?.location?.turn?.start?.time
  const hidden = useRoster(roster => isHiddenTurn(roster, sessionId, turn))
  // Exchange turns hide their replies but still show their trigger chip, so their start
  // counts for separators too.
  useEffect(() => {
    actions.noteTurnTime(sessionId, turn, 'first', start)
  }, [sessionId, turn, start])
  // The reply to a turn the user saw begin arrived while the user was away.
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    const own = state[sessionId]?.[turn]
    return !hidden && typeof visit?.seen === 'number' && own?.first !== undefined && own.first <= visit.seen
      && own.end !== undefined && own.end > visit.seen && own.end <= visit.entered
  })
  return fresh ? h(NewDivider) : h(CellEmpty)
}

export function Nothing() { return null }

function SkillNotice({ text }) {
  return h('div', { className: 'bt-event', role: 'status' }, hostText(text))
}

export function SkillNoticeCell({ node }) {
  const { source, content } = node.data ?? {}
  return source?.kind === SKILL_NOTICE ? h(SkillNotice, { text: contentText(content) }) : h(CellEmpty)
}

export { CellEmpty }

// A pause longer than this splits the transcript with a time separator.
const SEPARATOR_GAP_MS = 30 * 60 * 1000
function nextTurnOf(turns, turn) {
  let next
  for (const key in turns) {
    const candidate = Number(key)
    if (candidate > turn && turns[key].first !== undefined && (next === undefined || candidate < next)) next = candidate
  }
  return next
}
function nextTurnStart(turns, turn) {
  const next = nextTurnOf(turns, turn)
  return next === undefined ? undefined : turns[next].first
}
// The first turn the transcript shows: the earliest rendered start, with only hidden
// exchange turns before it. `firstTurns` lists the outline's first turns.
export function openingTurn(turns, firstTurns, hiddenTurns) {
  if (!turns || !firstTurns) return null
  const start = nextTurnStart(turns, -Infinity)
  if (start === undefined) return null
  const turn = Number(Object.keys(turns).filter(key => turns[key].first === start)[0])
  const listed = firstTurns.split(',').map(Number)
  const earlier = listed.filter(entry => entry < turn)
  return listed.includes(turn) && earlier.every(entry => hiddenTurns?.includes(entry)) ? { turn, start } : null
}
// Began after the user last left the conversation and before this visit opened it.
export const unseenSince = (visit, time) => typeof visit?.seen === 'number' && time > visit.seen && time <= visit.entered

// An entry in DSH's own turn tail, after what other plugins put there (the cards of
// the files a turn delivered). The tail sits right before the next turn's first row,
// so the separator for a pause between turns renders here.
export function TurnTailCell({ turn: location, sessionId, useRoster, useTurnClock, useUi, actions }) {
  const turn = location.turn
  // A Bot-to-Bot exchange turn shows no reply here, only its fold line (#161).
  const hidden = useRoster(roster => isHiddenTurn(roster, sessionId, turn))
  const exchangeTurns = useRoster(roster => roster.exchangeTurns[sessionId])
  // After a hidden turn, a hidden next turn folds into the same line and shows
  // nothing, so no pause or unread divider stands before it.
  const nextStart = (turns) => {
    const next = nextTurnOf(turns, turn)
    if (next === undefined || (hidden && exchangeTurns?.includes(next))) return undefined
    return turns[next].first
  }
  // DSH builds the tail from the turn's end, so it is there.
  const time = location.end.time
  useEffect(() => { actions.noteTurnTime(sessionId, turn, 'end', time) }, [sessionId, turn, time])
  const label = useTurnClock((state) => {
    const start = nextStart(state[sessionId] ?? {})
    return start !== undefined && start - time >= SEPARATOR_GAP_MS ? clockLabel(start) : ''
  })
  // The unread divider sits before the first turn that began after the last visit;
  // turns that begin while the conversation is open were watched live.
  const visit = useUi(state => state.visits?.[sessionId])
  const fresh = useTurnClock((state) => {
    if (typeof visit?.seen !== 'number' || time > visit.seen) return false
    const start = nextStart(state[sessionId] ?? {})
    return start !== undefined && start > visit.seen && start <= visit.entered
  })
  // Every reply says when it ended, under its last line.
  const ended = hidden ? null : h('time', { className: 'bt-turn-time', dateTime: new Date(time).toISOString() }, new Date(time).toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' }))
  // The review guard's upgrade line, after the last turn that ended before the upgrade.
  const notice = noticeOfKey(useRoster(roster => noticeKey(roster, sessionId)))
  const upgradeHere = useTurnClock((state) => {
    if (notice === undefined) return false
    const turns = state[sessionId] ?? {}
    const next = nextTurnOf(turns, turn)
    return noticeAfterTurn(notice.at, time, next === undefined ? undefined : turns[next].first)
  })
  return h(Fragment, null,
    ended,
    upgradeHere ? h(UpgradeLine, { name: notice.name }) : null,
    label ? h('div', { className: 'bt-time-sep', role: 'separator' }, label) : null,
    fresh ? h(NewDivider) : null)
}

export function Shimmer({ children }) {
  return h('span', { className: 'bt-shimmer' }, children)
}

// The time since `at`, from 1s. It ticks on its own whole seconds, so its parent does
// not render again each second.
export function Elapsed({ at, className }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const time = Date.now()
      setNow(time)
      timer = setTimeout(tick, 1000 - (((time - at) % 1000) + 1000) % 1000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [at])
  return h('span', { className }, `· ${elapsedLabel(Math.max(1000, now - at))}`)
}

// Status phrases. A running tool names what it does; otherwise one
// phrase is drawn from the pool each time the activity changes.
export const PHRASES = {
  thinking: ['Thinking about it', 'Weighing the options', 'Working out a plan', 'Sorting out the details'],
  working: ['On it', 'Busy with it', 'Moving ahead', 'Taking care of it', 'Making headway'],
}
const TOOL_PHRASES = [
  [/^cua(_driver_native__|$)|^computer_/, 'Using the computer'],
  [/web_?search|search_?web/i, 'Searching online'],
  [/fetch|browse|browser|web/i, 'Reading a page'],
  [/shell|bash|pwsh|powershell|exec|command|terminal/i, 'Running shell commands'],
  [/^(read|view|cat)\b|read_/i, 'Opening a file'],
  [/grep|glob|list_dir|^ls$|find|search/i, 'Looking through files'],
  [/write|edit|patch|apply|replace/i, 'Writing changes'],
  [/image|photo|draw/i, 'Working on an image'],
]
const GROUP_PHRASES = { create_group: 'Creating a group', update_group: 'Updating the group', delete_group: 'Deleting the group', post_to_group: 'Posting in the group' }
function toolActivity(name, arg, findBot, self) {
  switch (name) {
    case 'ask_user': return null
    case 'request_secret': return null
    case 'list_secrets': return { label: t('Checking the keys'), state: 'searching' }
    case 'ask_user_question': return { label: t('Waiting for your answer'), state: 'alert' }
    case 'group_relay': return { relay: true, state: 'orbit' }
    case 'message_bot': {
      const target = findBot(arg('to'))
      return { label: target ? t('Asking {name}', { name: target.name }) : t('Asking another Bot'), state: 'sending' }
    }
    case 'stop_bot': {
      const target = findBot(arg('bot'))
      return { label: target ? t('Stopping {name}', { name: target.name }) : t('Stopping another Bot'), state: 'sending' }
    }
    case 'create_bot': return { label: t('Creating {name}', { name: arg('name') ?? t('a Bot') }), state: 'sending' }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot')) ?? (arg('bot') ? undefined : self)
      return { label: t('Updating {name}', { name: target?.name ?? t('a Bot') }), state: 'sending' }
    }
    case 'delete_bot': {
      const target = findBot(arg('bot'))
      return { label: target ? t('Deleting {name}', { name: target.name }) : t('Deleting another Bot'), state: 'sending' }
    }
    case 'list_bots': return { label: t('Checking the team'), state: 'searching' }
    case 'read_group_chat': return { label: t('Reading {name}', { name: arg('group') ?? t('a group chat') }), state: 'searching' }
    case 'read_own_chat': return { label: t('Looking back through the chat'), state: 'searching' }
    case 'remember': return { label: t('Saving to memory'), state: 'working' }
    case 'forget': return { label: t('Updating memory'), state: 'working' }
    case 'recall': return { label: t('Checking memory'), state: 'searching' }
    case 'start_task': return { label: t('Starting a task'), state: 'sending' }
    default:
      // Another Omni plugin's tool says what it does (extend.js).
      if (toolCards.phrase(name)) return toolCards.phrase(name)(arg)
      if (GROUP_PHRASES[name]) return { label: t(GROUP_PHRASES[name]), state: 'sending' }
      const phrase = TOOL_PHRASES.find(([pattern]) => pattern.test(name))?.[1]
      return { label: phrase ? t(phrase) : null, state: toolState(name) }
  }
}

// What a Bot busy elsewhere is doing: what it said in the step it is on, its running
// call's own description, else the kind of tool and what it works on. `doing` is a work
// entry, or just a tool name.
export function workPhrase(doing) {
  const { tool, said, note, target, switching, folder } = typeof doing === 'string' ? { tool: doing } : doing ?? {}
  if (switching) return folder === true ? t('Switching working folder') : t('Moving to a fresh conversation')
  const own = (said || note)?.replace(/[\s.。…]+$/u, '')
  if (own) return own
  if (!tool) return t('Thinking about it')
  const label = toolActivity(tool, () => undefined, () => undefined)?.label ?? t('On it')
  return target ? `${label} · ${target}` : label
}

// Transcript rows report what is in flight to the one activity row at the tail.
function useLiveNote(actions, sessionId, id, entry) {
  const key = entry ? JSON.stringify(entry) : ''
  useEffect(() => {
    if (!key) return undefined
    actions.noteLive(sessionId, id, JSON.parse(key))
    return () => actions.noteLive(sessionId, id, null)
  }, [sessionId, id, key])
}

// One non-message row of a group round: the same event line the live view draws
// for a reply that is not a member's message or the user's own line. `bot` is the
// resolved member the reply names.
function RelayEvent({ reply, bot, roster, sessionId, actions }) {
  if (reply.kind === SKILL_NOTICE) return h(SkillNotice, { text: reply.text })
  if (reply.kind === SKILL_ACTIVITY) return h(SkillActivityRow, { bot, name: reply.skill })
  if (reply.kind === TOOL_ACTIVITY) return h(ToolActivityRow, { ...reply, bot })
  if (reply.kind === 'permission-stop') {
    return h('div', { className: 'bt-event bt-event-error', role: 'status', title: reply.why },
      t('{name} stopped on a permission: {why}', { name: bot.name, why: whyText(reply.why) }))
  }
  if (reply.kind === 'failed') {
    return h('div', { className: 'bt-event bt-event-error', role: 'status', title: [reply.code, reply.status, reply.text].filter(Boolean).join(' · ') },
      t('{name} stopped: {reason}. Switch its model or ask it to go on.', { name: bot.name, reason: failureClause(reply.code, reply.text) }))
  }
  if (reply.kind === 'lookup') {
    return h('div', { className: 'bt-event' },
      reply.text ? t('{name} looked up its own chat for “{text}”', { name: bot.name, text: reply.text }) : t('{name} looked up its own chat', { name: bot.name }))
  }
  if (reply.kind === 'missed') {
    return h('div', { className: 'bt-event' }, t("{name} didn't answer in time", { name: bot.name }))
  }
  // A member's conversation here followed its agent switch (RFC 0030, Handoff note).
  if (reply.kind === 'switched') {
    return h('div', { className: 'bt-event' }, t('{name} switched to {agent}', { name: bot.name, agent: reply.agent }))
  }
  if (reply.kind === 'admin-passed') {
    return h('div', { className: 'bt-event' },
      t('{name} did not answer or call anyone; call a member with @Name', { name: bot.name }))
  }
  // Bots that went back and forth without progress. LEGACY: rounds from when groups
  // paused at a relay limit.
  if (reply.kind === 'paused') {
    return h('div', { className: 'bt-event' }, reply.idle
      ? t('{names} went back and forth {count} times without progress and paused. Write here to go on', { count: reply.count, names: [bot.name, ...(reply.names ?? [])].join(t(' and ')) })
      : t('Paused after {count} Bot relays. Waiting: {names}', { count: reply.count, names: (reply.names ?? []).join(t(' and ')) }))
  }
  if (reply.kind === 'resumed') {
    return h('div', { className: 'bt-event' }, reply.resumedByUpdate
      ? t('{name} was interrupted by an Automagik update and picked its work back up', { name: bot.name })
      : t('{name} was cut off by a restart and picked its work back up', { name: bot.name }))
  }
  if (reply.kind === 'cut') {
    return h('div', { className: 'bt-event' }, t('{name} was cut off by a restart again and stopped', { name: bot.name }))
  }
  if (reply.kind === 'approval' || reply.kind === 'working') {
    return h('div', { className: 'bt-event' },
      h('button', { type: 'button', className: 'bt-event-whole', onClick: () => actions.showDetails(sessionId) },
        h(BotMark, { bot, look: snapshotLook(bot, roster), size: 16 }), h('span', { className: 'bt-event-name' }, t(reply.kind === 'working' ? '{name} started on it' : '{name} paused for your approval', { name: bot.name }))))
  }
  if (reply.kind === 'folder') {
    return h('div', { className: 'bt-event' }, reply.text)
  }
  if (reply.kind === 'stopped') {
    return h('div', { className: 'bt-event' }, t("You stopped {name}'s work", { name: bot.name }))
  }
  if (reply.kind === 'done') {
    return h('div', { className: 'bt-event' }, t('{name} finished its work', { name: bot.name }))
  }
  return null
}

// Rows a later call closed do not change: each is read from the group's book once per page.
const settledRows = new Map()

// A relay result is JSON a model produced, so a reply can be malformed. Skip what is
// not an object and read an absent text as empty: a throw here would abdicate the team
// cell and DSH would draw its own raw tool card in the group screen (#139).
const cleanReplies = value => (Array.isArray(value) ? value : [])
  .filter(reply => reply !== null && typeof reply === 'object')
  .map(reply => (typeof reply.text === 'string' ? reply : { ...reply, text: String(reply.text ?? '') }))

function GroupReplies({ sessionId, callId, done, content, roster, actions, useUi, useWork }) {
  const [live, setLive] = useState({ replies: [], speaking: [] })
  useEffect(() => {
    if (done) return undefined
    let stop = false
    let timer
    let seen = ''
    const tick = async () => {
      const result = await actions.roomProgress(sessionId)
      if (stop) return
      const own = result?.find(item => item.callId === callId)
      const entry = own ?? result?.[0]
      const replies = Array.isArray(entry?.replies) ? entry.replies.filter(reply => own !== undefined || reply?.kind !== SKILL_ACTIVITY) : []
      const key = entry ? JSON.stringify([replies, entry.speaking]) : ''
      if (entry && key !== seen) { seen = key; setLive({ replies, speaking: [entry.speaking ?? []].flat() }) }
      timer = setTimeout(tick, document.hidden ? 5000 : 1000)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [done, sessionId, callId])
  // A settled round names where its rows are in the group's book; one from before
  // the ledger carries them in its result.
  const resultText = done ? contentText(content) : ''
  const range = done ? relayRange(resultText) : undefined
  const roomRevision = roster.roomActivity?.[roster.roomsById[sessionId]?.id]
  const rowsKey = range === undefined ? undefined : `${sessionId}:${range.from}:${range.to ?? ''}:${range.anchor ?? ''}`
  const [read, setRead] = useState(() => ({ key: rowsKey, value: settledRows.get(rowsKey)?.value ?? null }))
  const view = read.key === rowsKey ? read.value : null
  // An open cell that is quiet is read again when the team changes, not on a clock.
  const quietKey = view?.open === true && view.active !== true ? roster.revision : undefined
  useEffect(() => {
    if (rowsKey === undefined) return undefined
    const known = settledRows.get(rowsKey)
    if (known !== undefined && known.revision === roomRevision) { setRead({ key: rowsKey, value: known.value }); return undefined }
    // The newest call's rows grow while the group works: they are read every second then,
    // and once when the group is quiet, until the next call closes them.
    let stop = false
    let timer
    let seen = ''
    const tick = async () => {
      const next = await actions.groupRows(sessionId, range.from, range.to, range.anchor)
      if (stop) return
      if (next !== null && Array.isArray(next?.rows)) {
        if (!next.open) settledRows.set(rowsKey, { revision: roomRevision, value: next })
        const key = JSON.stringify(next)
        if (key !== seen) { seen = key; setRead({ key: rowsKey, value: next }) }
        if (!next.open || next.active !== true) return
      }
      timer = setTimeout(tick, document.hidden ? 5000 : 1000)
    }
    void tick()
    return () => { stop = true; clearTimeout(timer) }
  }, [rowsKey, quietKey, roomRevision])
  let replies = cleanReplies(live.replies)
  let broken = false
  if (range !== undefined) {
    replies = cleanReplies(view?.rows ?? live.replies)
  } else if (done) {
    const parsed = parseReplies(resultText)
    replies = parsed.replies.length ? cleanReplies(parsed.replies) : cleanReplies(live.replies)
    broken = parsed.broken
  }
  // Every member answering in the round is typing; what each is doing comes as text,
  // so the cell redraws only when that changes.
  const pending = range !== undefined ? (view?.open ? view.speaking ?? [] : []) : done ? [] : live.speaking
  const doing = JSON.parse(useWork?.(work => JSON.stringify(pending.map((id) => {
    const tool = work.bots?.[id]?.tool
    return tool ? [tool, workPhrase(work.bots[id])] : []
  }))) ?? '[]')
  if (replies.length === 0 && pending.length === 0) {
    // A pruned tool result left nothing to draw; keep a marker row instead of an
    // empty turn, which reads as a blank gap on a narrow first paint.
    return broken ? h('div', { className: 'bt-group-replies' }, h('div', { className: 'bt-event' }, t('The group replies could not be shown'))) : h(CellEmpty)
  }
  const room = roster.roomsById[sessionId]
  return h('div', { className: 'bt-group-replies' },
    stackReplies(replies).map(({ reply, index, texts, time, duration }) => {
      const bot = roster.byId[reply.botId] ?? { id: reply.botId, name: reply.name, color: reply.color ?? 'gray' }
      if (reply.kind === 'user') {
        return h('div', { key: `user-${index}`, className: 'bt-urow' },
          h('div', { className: 'bt-ububble' }, h(MarkdownText, { text: reply.text, labels: mdLabels(), variant: 'compact' })),
          (reply.via !== undefined || Number.isFinite(time)) ? h('div', { className: 'bt-utime', title: clockLabel(time) }, ...(reply.via !== undefined ? [h(ViaTag, { key: 'via', via: reply.via })] : []), Number.isFinite(time) ? messageClock(time) : null) : null)
      }
      // The group's goal line comes before the other round notices, which RelayEvent draws.
      if (reply.kind === 'goal') {
        return h('div', { key: `goal-${index}`, className: 'bt-event', title: reply.text || undefined },
          h('span', { className: 'bt-event-ico', 'aria-hidden': true }, h(GoalIcon)), goalEventText(reply))
      }
      if (reply.kind !== undefined) {
        const key = reply.kind === TOOL_ACTIVITY ? reply.id : `${reply.botId ?? reply.kind}-${index}`
        return h(RelayEvent, { key, reply, bot, roster, sessionId, actions })
      }
      return h(GroupMessage, { key: `${reply.botId}-${index}`, bot, texts, room, roster, actions, msgKey: callId ? `${sessionId}:${callId}:${index}` : undefined, useUi, time, duration })
    }),
    pending.map((id, at) => {
      const bot = roster.byId[id]
      if (!bot) return null
      const [tool, phrase] = doing[at] ?? []
      return h('div', { key: `pending-${id}`, className: 'bt-activity' },
        h(BotMark, { bot: bot, size: 22, state: tool ? toolState(tool) : 'thinking' }),
        h(Shimmer, null, phrase ? `${bot.name} · ${phrase}…` : t('{name} is typing…', { name: bot.name })))
    }))
}

const isComputerCall = name => name === 'cua' || name?.startsWith('cua_driver_native__') === true
// Calls whose card a dock above the composer carries when the call is not drawn.
const CARDS = new Set(['ask_user', 'request_secret', 'request_connector', 'mail_send', 'show_view', 'browser_handoff', 'computer_handoff'])
// An image an agent makes with its own tool draws as the image card (image-cell.js).
const agentImage = call => isAgentImageCall({ name: toolName(call), image: toolArgs(call).value('image'), done: call.kind === 'tool-result', content: call.kind === 'tool-result' ? contentText(call.content) : '' })

// The root and its sub-calls in dispatch order, each call once.
export function callTree(root) {
  const calls = []
  const seen = new Set()
  const visit = (call) => {
    const id = call.callId ?? call
    if (seen.has(id)) return
    seen.add(id)
    calls.push(call)
    for (const child of call.subCalls ?? []) visit(child)
  }
  visit(root)
  return calls
}

// Tells the docks which card calls the transcript draws, so a card shows in one place.
// A layout effect: an untouched dock drops its copy before the first paint.
function useShownCards(actions, sessionId, callIds) {
  const key = JSON.stringify(callIds)
  useLayoutEffect(() => {
    const ids = JSON.parse(key)
    if (ids.length === 0 || !actions.noteCards) return undefined
    actions.noteCards(sessionId, ids, 1)
    return () => actions.noteCards(sessionId, ids, -1)
  }, [sessionId, key])
}

function renderCall(call, { sessionId, roster, actions, useUi, useWork, useSessionStatus, findBot, heldCards, hooks }) {
  const tool = toolName(call)
  const done = call.kind === 'tool-result'
  const { text: arg, value: argValue } = toolArgs(call)
  const self = roster.byId[sessionId]
  // What the image viewer's field asks goes to this same chat (a Bot's, or a group's room); a
  // window that can only view the team (roster.readOnly) has no field to offer.
  const askHere = !roster.readOnly && typeof actions?.send === 'function' ? text => actions.send(sessionId, text) : undefined
  // A tool another Omni plugin registers draws its own card (extend.js): Omni's calls, canvases.
  const card = toolCards.renderer(tool)
  if (card !== undefined) return card({ call, tool, arg, argValue, done, content: done ? contentText(call.content) : '', sessionId, roster, actions })
  switch (tool) {
    case 'start_task':
    case 'mcp__dsh__start_task': {
      // The task's own card: it works where the user can watch, then says what it found.
      const result = done ? contentText(call.content) : ''
      const started = done && result.startsWith('Started task "') ? /\((session-[^)]+)\) under (?:Tasks|your row)/.exec(result)?.[1] : undefined
      if (done && !started) {
        const text = call.isError ? result.replace(/^Error: /, '') : result
        return h('div', { className: 'bt-event' },
          h('div', null, text.split('\n').map((line, index) => h('div', { key: index }, hostText(line)))))
      }
      return h(TaskCard, {
        sessionId: started, title: arg('title') ?? t('a task'),
        task: started ? roster.tasks?.[started] : undefined,
        onOpen: () => started && actions.openSession(started), useSessionStatus, useWork,
        actions, readOnly: roster.readOnly,
      })
    }
    case 'message_bot': {
      const target = findBot(arg('to')) ?? { name: arg('to') ?? '…', color: 'gray' }
      if (done) {
        // The host marks a call that sent nothing with `sent: false` and its reason:
        // show that reason, never "Messaged", so the user is not told a message left
        // when it did not. A delivery keeps its string result and says "Messaged".
        const refused = call.meta?.sent === false ? call.meta.reason ?? contentText(call.content) : ''
        if (refused !== '') return h('div', { className: 'bt-event bt-event-error', role: 'status' }, refused)
        // The refusal stands without a reason or content: never fall through to "Messaged".
        if (call.isError || call.meta?.sent === false) return h('div', { className: 'bt-event' }, t("Couldn't message {name}", { name: target.name }))
      }
      return h(EventLine, { prefix: t('Messaged'), bots: [target], roster, onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'stop_bot': {
      const target = findBot(arg('bot')) ?? { name: arg('bot') ?? '…', color: 'gray' }
      if (done && call.isError) return h('div', { className: 'bt-event' }, t("Couldn't stop {name}", { name: target.name }))
      return h(EventLine, { prefix: t('Stopped'), bots: [target], roster, onOpen: bot => bot.id && actions.openExchange(self?.id ?? sessionId, bot.id), whole: true })
    }
    case 'create_bot': {
      const created = findBot(arg('name'))
      if (!done || created === undefined) return h(CellEmpty)
      return h(EventLine, { prefix: t('Created'), bots: [created], roster, onOpen: bot => actions.openSession(bot.id) })
    }
    case 'update_bot': {
      const target = findBot(arg('name')) ?? findBot(arg('bot')) ?? (arg('bot') ? undefined : self)
      return done && target ? h(EventLine, { prefix: t('Updated'), bots: [target], roster, onOpen: bot => actions.openSession(bot.id) }) : h(CellEmpty)
    }
    case 'delete_bot': {
      // The Bot is gone from the roster once the call settles, so its name comes from the call,
      // and there is no chat left to open.
      const name = arg('bot') ?? '…'
      if (!done) return h(CellEmpty)
      if (call.isError) return h('div', { className: 'bt-event' }, t("Couldn't delete {name}", { name }))
      return h('div', { className: 'bt-event' }, h('span', null, t('Deleted')), h('span', null, name))
    }
    case 'group_relay':
      return h(GroupReplies, { sessionId, callId: call.callId, done, content: call.content, roster, actions, useUi, useWork })
    case 'create_group':
    case 'update_group':
    case 'delete_group':
    case 'post_to_group': {
      const verbs = {
        create_group: ['Created group', "Couldn't create the group"],
        update_group: ['Updated group', "Couldn't update the group"],
        delete_group: ['Deleted group', "Couldn't delete the group"],
        post_to_group: ['Posted in', "Couldn't post in the group"],
      }[tool]
      if (!done) return h(CellEmpty)
      // Tool results quote the group's name; anything else is a refusal.
      const result = contentText(call.content)
      const named = /^(Created group|Updated|Nothing changed in|Deleted|Posted in) "([^"]+)"/.exec(result)
      if (call.isError || !named) return h('div', { className: 'bt-event', title: result }, t(verbs[1]))
      const name = named[2]
      const room = roster.rooms.find(entry => entry.name === name)
      return h(GroupEvent, { prefix: t(verbs[0]), room: tool === 'delete_group' ? undefined : room, name, roster, actions })
    }
    case 'ask_user': {
      const question = roster.questions?.[sessionId]
      if (!question || (question.callSessionId ?? sessionId) !== sessionId || question.callId !== call.callId) {
        // Dismissed or answered by a message: the card stays here, read-only.
        // Answered on the card: its reply message carries it, so no gap here.
        const closed = roster.closedCards?.[sessionId]?.[call.callId]
        if (closed === undefined) return h(CellEmpty, { className: 'bt-q-gone' })
        const asked = { question: arg('question') ?? '', detail: arg('detail'), options: argValue('options') ?? [], multiSelect: argValue('multiSelect') === true }
        return h('div', { className: 'bt-q-inline' }, h(SettledQuestion, { question: asked, closed }))
      }
      if (heldCards?.[heldCardKey('question', question.id)] > 0) return h(CellEmpty)
      return h(PendingQuestion, { key: JSON.stringify([sessionId, question.id]), sessionId, question, actions, inline: true, enterToSend: sendsOnEnter(roster.prefs) })
    }
    case 'show_view':
      return h(WidgetCell, { sessionId, callId: call.callId, args: { text: arg, value: argValue }, done, isError: call.isError, roster, actions, heldCards })
    case 'show_settings':
      return h(SettingsCall, { args: { text: arg, value: argValue }, done, content: done ? contentText(call.content) : '', isError: call.isError, roster, actions })
    case 'propose_bot_change':
      return h(ProposalCall, { done, content: done ? contentText(call.content) : '', isError: call.isError, roster, actions })
    case 'generate_image':
      // The chat's own Bot paints (image-cell.js painterOf); a group chat has none, so the mark does.
      return h(ImageCell, { bot: self, callId: call.callId, prompt: arg('prompt'), size: arg('size'), done, content: done ? contentText(call.content) : '', isError: call.isError, onAsk: askHere })
    case 'acp_tool':
      return agentImage(call)
        ? h(ImageCell, { bot: self, callId: call.callId, prompt: agentPromptOf(argValue('input')), done, content: done ? contentText(call.content) : '', isError: call.isError, onAsk: askHere })
        : h(CellEmpty)
    case 'request_secret':
      return h(SecretToolCell, { sessionId, callId: call.callId, name: arg('name'), done, content: call.content, roster, actions, heldCards })
    case 'request_connector':
      return h(ConnectorToolCell, { sessionId, callId: call.callId, done, content: call.content, roster, actions, heldCards })
    case 'mail_send':
      return h(MailToolCell, { sessionId, callId: call.callId, done, content: call.content, roster, actions, heldCards })
    case 'browser_handoff':
      return h(HandoffCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks })
    case 'computer_handoff':
      return h(ComputerHandoffCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks })
    case 'ask_user_question': {
      if (!done) return h(CellEmpty)
      let parsed = null
      try { parsed = JSON.parse(contentText(call.content)) } catch { parsed = null }
      const answer = parsed?.answers?.[0]
      const question = argValue('questions')?.[0]
      if (!answer) return h(CellEmpty)
      return h('div', { className: 'bt-q-inline' }, h(SettledQuestion, { question, answer }))
    }
    case 'read_group_chat': {
      if (!done) return h(CellEmpty)
      const room = roster.rooms.find(entry => entry.name === arg('group'))
      return room ? h(GroupEvent, { prefix: t('Read'), room, roster, actions }) : h(CellEmpty)
    }
    case 'remember':
    case 'forget':
      return done ? h(MemoryEvent, { sessionId, scope: arg('scope'), tool, result: contentText(call.content), failed: call.isError === true, code: call.error?.code, roster, actions, findBot }) : h(CellEmpty)
    default:
      if (isComputerCall(tool)) {
        return h(Fragment, null,
          h(ComputerCallRow, { sessionId, call, roster, actions, hooks }),
          h(AppAccessCall, { sessionId, callId: call.callId, roster, actions, heldCards, hooks }))
      }
      return h(CellEmpty)
  }
}

// Solver stops still draw in a hidden turn.
const GUARD_WHYS = new Set(['guard', 'guard-request', 'guard-launch', 'limit'])

export function ToolCell({ node, sessionId, useRoster, useUi, useWork, useSessionStatus, useHeldCards, useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer, actions, orderedDispatch = false, activityDispatch = false }) {
  const roster = useRoster(value => value)
  const heldCards = useHeldCards?.(state => state[sessionId])
  const root = node.data.root
  const turn = node.location?.turn?.turn ?? root.turn
  const hidden = isHiddenTurn(roster, sessionId, turn)
  const findBot = nameOrId => roster.byId[nameOrId] ?? roster.bots.find(bot => bot.name.toLowerCase() === String(nameOrId ?? '').toLowerCase())
  // A plugin that loads after the transcript drew still gets its cards drawn.
  useSyncExternalStore(toolCards.source.subscribe, toolCards.source.getSnapshot)
  const closed = roster.closedCards?.[sessionId]
  const all = callTree(root)
  const closedCard = call => (toolName(call) === 'ask_user' || toolName(call) === 'show_view') && call.callId && closed?.[call.callId] !== undefined
  const stopKeys = useWork ? useWork(work => JSON.stringify(all.flatMap(call => {
    const entry = stopOfCall(work.stops, sessionId, call.callId)
    return entry ? [[call.callId, stopLine(entry), entry.why]] : []
  }))) : '[]'
  const stops = new Map(JSON.parse(stopKeys).map(([id, line, why]) => [id, { line, why }]))
  // A call the review guard refused in a hidden turn draws only its stop line (RFC 0048): the
  // Solver's chat shows why a Bot's request did not run, never the call's own row.
  const guardOnly = call => hidden && GUARD_WHYS.has(stops.get(call.callId)?.why) && !closedCard(call)
  // Hidden Bot-to-Bot turns keep their own calls out of the chat, except a question
  // or view card the user dismissed or answered by message, which settles here.
  const calls = hidden ? all.filter(call => closedCard(call) || guardOnly(call)) : all
  const readRefused = call => call.isError === true && call.error?.code === READ_SCOPE_CODE
  // Committed calls have their own event anchors. The DSH node still carries the running
  // tail phrase, the preparing cards and result-only cards from an incomplete history window.
  const atThisNode = calls.filter(call => !orderedDispatch || call.phase === 'preparing' ||
    (call.kind === 'tool-result' ? call.callTime == null : !Number.isSafeInteger(turn)))
  // The newest call still running names the work, so a program reads as the tool it is in.
  const running = root.kind === 'tool-result' ? undefined : calls.findLast(call => call.kind !== 'tool-result' && !guardOnly(call))
  const note = running && !activityDispatch ? toolActivity(toolName(running), toolArgs(running).text, findBot, roster.byId[sessionId]) : null
  // A running tool shows only as the activity row's phrase.
  useLiveNote(actions, sessionId, `tool:${root.callId ?? node.key}`, note)
  useShownCards(actions, sessionId, atThisNode.filter(call => !guardOnly(call) && (CARDS.has(toolName(call)) || isComputerCall(toolName(call)) || toolCards.asks(toolName(call))) && call.callId).map(call => call.callId))
  if (atThisNode.length === 0) return h(CellEmpty)
  const env = { sessionId, roster, actions, useUi, useWork, useSessionStatus, findBot, heldCards, hooks: { useBrowserHolds, useBrowserTabs, useBrowserPages, useComputer } }
  return h(Fragment, null, atThisNode.map((call, index) => {
    const stop = stops.get(call.callId)
    if (guardOnly(call)) return h('div', { key: call.callId ?? index, className: 'bt-event bt-event-error', role: 'status', title: stop.why }, stop.line)
    if (readRefused(call)) {
      return h('div', { key: call.callId ?? index, className: 'bt-event bt-event-error', role: 'status' },
        call.error.reason ?? contentText(call.content))
    }
    const card = renderCall(call, env)
    const name = toolName(call)
    const fallback = !hidden && !roster.roomsById[sessionId] && call.phase !== 'preparing' &&
      !orderedDispatch && (!card || card.type === CellEmpty) &&
      !CARDS.has(name) && !toolCards.asks(name) && !stop
    const activity = fallback ? toolActivityOf({ name, arguments: call.argsRaw ?? call.call?.argsRaw }) : undefined
    return h(Fragment, { key: call.callId ?? index }, activity ? h(ToolActivityRow, activity) : card ?? h(CellEmpty),
      stop ? h('div', { className: 'bt-event bt-event-error', role: 'status', title: stop.why }, stop.line) : null)
  }))
}
