// The Bot browser in DSH's own right sidebar: a tab beside the conversation that shows the
// browser the Bot owning the Session is driving, and lets the person drive it first — open a
// URL, click, type, scroll — then give it back to the Bot. Every action of theirs holds the
// browser, so the Bot's own browser tools wait until it is given back, while the Bot's
// browser session and its page stay open in between.
//
// This is the Web half: the page arrives as a JPEG frame polled from the host, so it needs
// no Electron webview. The host side is `browser-state`/`browser-control` (channel.js) over
// `rt.browserControl` (browser-plugins.js), mounted by the Bot's own browser plugin.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { GlobeIcon } from './browser-pane.js'
import { t } from './i18n.js'
import { currentPart } from './text.js'

// The tab body and its title register under this id; `kind` is what the header button and
// the guide entry open.
export const BOT_BROWSER_ID = '@automagik/bots-dsh/browser'
export const BOT_BROWSER_KIND = 'botbrowser'
// One JPEG a second: enough to feel live without moving the Bot's page more than the person
// could follow, and the host screenshots only while this tab is mounted.
const FRAME_MS = 1000
// A trackpad sends a burst of wheel events; one scroll action per 150ms is what the page can
// take without stalling.
const WHEEL_MS = 150

// The Bot a Session belongs to: a Bot's own chat (any part of it indexes its Bot), or a DSH
// bot, whose Session the roster indexes through the agent that owns it.
const botOfSession = (roster, sessionId) => {
  if (!roster || sessionId === undefined || sessionId === null || sessionId === '') return undefined
  const bot = roster.byId?.[sessionId]
  if (bot !== undefined) return bot
  const agentId = roster.agentOf?.[sessionId]
  if (agentId !== undefined && roster.agentsById?.[agentId] !== undefined) return roster.agentsById[agentId]
  return [...(roster.bots ?? []), ...(roster.agents ?? [])]
    .find(entry => entry && (entry.id === sessionId || currentPart(entry) === sessionId))
}

// The host keys a Bot's browser by its Bot id, but a Session is worth asking with too: the
// identities are tried in this order, the Bot's own first.
const candidatesFor = (roster, sessionId) => {
  const bot = botOfSession(roster, sessionId)
  const ids = []
  if (bot?.id) ids.push(bot.id)
  if (roster?.agentOf?.[sessionId] !== undefined) ids.push(roster.agentOf[sessionId])
  if (sessionId !== undefined && sessionId !== null && sessionId !== '') ids.push(sessionId)
  return [...new Set(ids.filter(id => typeof id === 'string' && id !== ''))]
}

// An identity the host does not know is the next candidate's turn; anything else is the
// answer about this page, and asking again would only repeat it.
const readState = async (candidates) => {
  for (const botId of candidates) {
    try {
      return { status: 'ok', botId, state: await call('browser-state', { botId }) }
    } catch (error) {
      if (error?.code === 'bot/not-found') continue
      if (error?.code === 'bot/browser-off') return { status: 'off' }
      return { status: 'error', message: String(error?.message ?? error) }
    }
  }
  return { status: 'no-page' }
}

const readFrame = async (candidates) => {
  for (const botId of candidates) {
    try {
      const frame = await call('browser-frame', { botId })
      return frame?.data ? { status: 'frame', botId, frame } : { status: 'no-page' }
    } catch (error) {
      if (error?.code === 'bot/not-found') continue
      if (error?.code === 'bot/browser-off') return { status: 'off' }
      return { status: 'error', message: String(error?.message ?? error) }
    }
  }
  return { status: 'no-page' }
}

// The action succeeded (or no identity would take it); the caller re-reads the hold from the
// host's next poll either way.
const control = async (candidates, action, args) => {
  for (const botId of candidates) {
    try {
      await call('browser-control', { botId, action, args: args ?? {} })
      return botId
    } catch (error) {
      if (error?.code !== 'bot/not-found') return undefined
    }
  }
  return undefined
}

const giveBack = async (candidates, outcome) => {
  for (const botId of candidates) {
    try {
      await call('browser-give-back', { botId, ...(outcome === undefined ? {} : { outcome }) })
      return true
    } catch (error) {
      if (error?.code !== 'bot/not-found') return false
    }
  }
  return false
}

const buttonStyle = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, padding: 0, border: 0, borderRadius: 8,
  background: 'none', color: 'var(--dsw-alias-label-secondary, inherit)', cursor: 'pointer', flex: 'none',
}

const inputStyle = {
  flex: 1, minWidth: 0, height: 28, padding: '0 10px', boxSizing: 'border-box',
  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, outline: 'none',
  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12.5,
}

const wideButtonStyle = { ...buttonStyle, width: 'auto', padding: '0 10px', fontSize: 12.5, fontWeight: 600 }

const ChevronIcon = ({ dir = 'left' }) => h('svg', {
  viewBox: '0 0 20 20', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: dir === 'left' ? 'M12.5 4.5L7 10l5.5 5.5' : 'M7.5 4.5L13 10l-5.5 5.5' }))

const ReloadIcon = () => h('svg', {
  viewBox: '0 0 20 20', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9' }), h('path', { d: 'M15.5 3.5v3.5H12' }))

const ToolbarButton = ({ label, onClick, children }) => h('button', {
  type: 'button', title: label, 'aria-label': label, onClick, style: buttonStyle,
}, children)

// The page body: the Bot's page as a live frame, the person's own controls over it, and the
// hand-back that lets the Bot act again.
export function BotBrowserBody({ sessionId, hooks }) {
  const [state, setState] = useState({ status: 'loading' })
  const [address, setAddress] = useState('')
  const [typing, setTyping] = useState('')
  const [held, setHeld] = useState(false)
  const [page, setPage] = useState({ url: '', title: '' })
  const botRef = useRef({ id: undefined, name: undefined })
  const frameRef = useRef({ width: 0, height: 0 })
  const wheelAt = useRef(0)
  // The person is editing the address field: the poll must not overwrite it.
  const editing = useRef(false)
  // The hold this view last saw: who holds the browser (the Bot's handoff, or the person).
  const hold = useRef(null)
  const rosterRef = useRef(hooks?.roster)
  useEffect(() => { rosterRef.current = hooks?.roster }, [hooks])

  const candidates = () => candidatesFor(rosterRef.current?.getSnapshot?.(), sessionId)

  useEffect(() => {
    let alive = true
    let timer
    const tick = async () => {
      const roster = rosterRef.current?.getSnapshot?.()
      const ids = candidatesFor(roster, sessionId)
      if (!alive) return
      const bot = botOfSession(roster, sessionId)
      if (ids.length === 0) {
        hold.current = null
        setHeld(false)
        setState({ status: 'no-bot' })
        timer = setTimeout(tick, FRAME_MS)
        return
      }
      const reply = await readState(ids)
      if (!alive) return
      if (reply.status !== 'ok') {
        hold.current = null
        setHeld(false)
        setState(reply)
        // Chrome stays up on "no page": it is where the person opens the very first page.
        if (reply.status === 'no-page') botRef.current = { id: ids[0], name: bot?.name || botRef.current.name }
        timer = setTimeout(tick, FRAME_MS)
        return
      }
      botRef.current = { id: reply.botId, name: bot?.name || botRef.current.name }
      hold.current = reply.state.hold ?? null
      setHeld(hold.current !== null)
      setPage({ url: reply.state.url || '', title: reply.state.title || '' })
      if (!editing.current) setAddress(reply.state.url || '')
      const frameReply = await readFrame([reply.botId, ...ids.filter(id => id !== reply.botId)])
      if (!alive) return
      if (frameReply.status === 'frame') {
        frameRef.current = { width: frameReply.frame.width || 0, height: frameReply.frame.height || 0 }
        setState({ status: 'frame', frame: frameReply.frame })
      } else {
        setState({ status: 'no-page' })
      }
      timer = setTimeout(tick, FRAME_MS)
    }
    void tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [sessionId])

  const act = async (action, args) => {
    const done = await control(candidates(), action, args)
    if (done === undefined) return false
    botRef.current = { ...botRef.current, id: done }
    // The host holds the browser for the person on every action; show it before the poll does.
    hold.current = { by: 'user' }
    setHeld(true)
    return true
  }

  // The frame is scaled to the column, the page is not: the click goes to the page's own
  // viewport pixels, which is what the frame reports.
  const interact = async (event) => {
    const img = event.currentTarget
    const rect = img.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const viewport = frameRef.current
    const x = (event.clientX - rect.left) * ((viewport.width || rect.width) / rect.width)
    const y = (event.clientY - rect.top) * ((viewport.height || rect.height) / rect.height)
    await act('click', { x: Math.round(x), y: Math.round(y) })
  }

  const scroll = (event) => {
    event.preventDefault()
    const now = Date.now()
    if (now - wheelAt.current < WHEEL_MS) return
    wheelAt.current = now
    void act('wheel', { dy: event.deltaY })
  }

  const navigate = async () => {
    const target = address.trim()
    if (target === '') return
    // A bare address is a web address; anything else keeps the scheme the person typed.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`
    editing.current = false
    await act('navigate', { url })
  }

  const sendKeys = async () => {
    if (typing === '') return
    if (await act('type', { text: typing })) setTyping('')
  }

  const handBack = async () => {
    // A Bot's own handoff card needs its outcome; the person's own takeover simply returns.
    const outcome = hold.current?.by === 'bot' ? 'returned' : undefined
    if (await giveBack(candidates(), outcome)) {
      hold.current = null
      setHeld(false)
    }
  }

  const botName = botRef.current.name
  if (state.status === 'frame' || state.status === 'no-page') {
    const frame = state.status === 'frame' ? state.frame : undefined
    return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-base)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', flex: 'none', borderBottom: '.5px solid var(--dsw-alias-border-l1)' } },
        h(ToolbarButton, { label: t('Back'), onClick: () => void act('back') }, h(ChevronIcon, { dir: 'left' })),
        h(ToolbarButton, { label: t('Forward'), onClick: () => void act('forward') }, h(ChevronIcon, { dir: 'right' })),
        h(ToolbarButton, { label: t('Reload'), onClick: () => void act('reload') }, h(ReloadIcon)),
        h('input', {
          value: address,
          'aria-label': t('Address'),
          spellCheck: false,
          onChange: (event) => { editing.current = true; setAddress(event.target.value) },
          onFocus: () => { editing.current = true },
          onBlur: () => { editing.current = false; setAddress(page.url) },
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); void navigate() }
            if (event.key === 'Escape') { editing.current = false; setAddress(page.url) }
          },
          style: inputStyle,
        }),
        h('button', { type: 'button', onClick: () => void navigate(), style: wideButtonStyle }, t('Go'))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 11.5, borderBottom: '.5px solid var(--dsw-alias-border-l1)' } },
        h('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', flex: 'none', background: held ? 'var(--dsw-alias-state-warn-primary, var(--bt-star))' : 'var(--dsw-alias-state-success-primary, var(--bt-green))' } }),
        h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)', maxWidth: '30%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, botName || t('This Bot')),
        h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          held ? t('You are in control — the Bot waits.') : t('The Bot is driving.')),
        held
          ? h('button', { type: 'button', onClick: () => void handBack(), style: { ...wideButtonStyle, fontSize: 11.5, padding: '0 9px' } }, t('Give to Bot'))
          : null),
      h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', placeItems: 'start center' } },
        frame
          ? h('img', {
              src: `data:${frame.mime || 'image/jpeg'};base64,${frame.data}`,
              alt: page.title || page.url || t('The Bot’s browser'),
              draggable: false,
              onClick: (event) => void interact(event),
              onWheel: scroll,
              style: { display: 'block', width: '100%', height: 'auto', cursor: 'pointer' },
            })
          : h('div', { style: { padding: '28px 20px', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)', textAlign: 'center' } },
              h('strong', { style: { display: 'block', marginBottom: 4, color: 'var(--dsw-alias-label-primary)' } }, t('No page open yet — type an address')),
              t('Type an address above to open a page in this Bot’s browser, or wait for the Bot to browse.'))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', flex: 'none', borderTop: '.5px solid var(--dsw-alias-border-l1)' } },
        h('input', {
          value: typing,
          placeholder: t('Type into the page'),
          'aria-label': t('Type into the page'),
          onChange: (event) => setTyping(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void sendKeys() } },
          style: inputStyle,
        }),
        h('button', { type: 'button', onClick: () => void sendKeys(), style: wideButtonStyle }, t('Send'))))
  }

  const note = state.status === 'no-bot'
    ? [t('No Bot browser here yet'), t('The Bot team has not listed this Session’s Bot yet. Ask the Bot to open a page and this view follows it.')]
    : state.status === 'off'
      ? [t('Bot browsers are off'), t('This host has the Bot browser turned off.')]
      : state.status === 'error'
        ? [t('Could not read the page'), state.message]
        : [t('Connecting to the Bot’s browser…'), t('The first frame arrives in a moment.')]
  return h('div', { style: { padding: '22px 18px', fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' } },
    h('strong', { style: { display: 'block', marginBottom: 4, fontSize: 13.5, color: 'var(--dsw-alias-label-primary)' } }, note[0]),
    h('span', null, note[1]))
}

const BotBrowserButton = ({ open }) => h('button', {
  type: 'button', onClick: open, title: t('Bot browser'), 'aria-label': t('Bot browser'),
  style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, padding: 0, border: 0, borderRadius: 8, background: 'none', color: 'var(--dsw-alias-label-secondary, inherit)', cursor: 'pointer' },
}, h(GlobeIcon, { size: 16 }))

// Registers the tab type, its body and the Session-header globe. Returns the disposer the
// shell's installer effect holds; the tab type's own cleanup is needed too, since a tab of
// this kind would otherwise outlive the type that draws it.
export function installBotBrowserTab({ tabs, slots, sidebar, face, Body }) {
  const releaseType = tabs.register({
    id: BOT_BROWSER_ID,
    kind: BOT_BROWSER_KIND,
    title: () => t('Browser'),
    guide: [{
      id: 'new',
      order: 30,
      title: () => t('Bot browser'),
      description: () => t('Open a page yourself, then hand the browser to this Bot.'),
      icon: GlobeIcon,
    }],
  })
  let releaseBody
  let releaseHeader
  try {
    releaseBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: BOT_BROWSER_ID,
      inject: sessionId => ({ ...face(), sessionId }),
    }, Body))
    releaseHeader = slots.inject('conversation.session.header.actions', () => slots.register({
      name: 'conversation.session.header.actions',
      id: 'bot-browser-open',
      order: -50,
      label: () => t('Bot browser'),
      inject: sessionId => ({ open: () => sidebar.openTabIn(sessionId, BOT_BROWSER_KIND) }),
    }, BotBrowserButton))
  } catch (error) {
    try { releaseHeader?.() } finally { try { releaseBody?.() } finally { releaseType() } }
    throw error
  }
  return () => {
    try {
      // Only our kind; closeIn targets each tab's own Session, never the mounted one.
      for (const tab of sidebar?.openTabs.getSnapshot() ?? []) {
        if (tab.kind === BOT_BROWSER_KIND) sidebar.closeIn(tab.sessionId, tab.tabId)
      }
    } finally { try { releaseHeader?.() } finally { try { releaseBody?.() } finally { releaseType() } } }
  }
}
