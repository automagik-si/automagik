// Browser fixture for the typing pane's resume rule (RFC 0030 delivery 2): the real
// TerminalPane with the real xterm, a stub EventSource, and a fetch that records every call,
// so a test can prove what a waking key or a paste does (and does not) send. Made-up names.
import { createElement as h, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { CODE_PANEL, CodeBarList, CodeBody, CodeMainPanel, CodeSideSwitch, clearSeatOrigin, codePanelNavigation, codeStore, loadTree, openTerminal, setCodeSide, useCodeSide } from '../../src/client/code-side.js'
import { CodeBody as PaneBody, CodeTerminal, CodeTree, TerminalPane } from '../../src/client/code-side-pane.js'
import { installLocale } from '../../src/client/i18n.js'
import { TeamRows } from '../../src/client/left-bar-team.js'
import { teamOf } from '../../src/client/left-bar.js'
import { SeatChatPanel, seatChatView, SEAT_CHAT_CSS, SEAT_CHAT_PANEL, seatNavigation, useSeatRoster, localSeatByKey, useSeats } from '../../src/client/seat-chat.js'
import { useFreshSeat } from '../../src/client/sidebar.js'
import { installStyles } from '../../src/client/styles.js'

window.__calls = []
window.__streams = []
window.__barTraffic = []
window.__inputStatus = 204
window.__takeDelay = 0
window.__closed = false

class FakeEventSource {
  constructor(url) {
    this.url = url
    const { pathname, searchParams } = new URL(url, location.href)
    const bots = searchParams.getAll('bot')
    const workers = searchParams.getAll('worker')
    window.__barTraffic.push({ method: 'EventSource', url: pathname, target: bots.map((bot, i) => [bot, workers[i] || null]) })
    this.listeners = new Map()
    this.paneCount = bots.length
    this.closed = false
    this.previousOpen = window.__streams.filter(stream => !stream.closed).length
    window.__stream = url
    window.__streams.push(this)
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener)
    if (name === 'pane' && !window.__manualPane) queueMicrotask(() => {
      for (let p = 0; p < this.paneCount; p += 1) this.emit('pane', window.__initialGrid ?? {}, p)
    })
  }

  emit(name, data, p) {
    const payload = name === 'data' ? btoa(data) : data
    const tagged = name === 'data' ? { p, d: payload } : { p, ...payload }
    this.listeners.get(name)?.({ data: this.paneCount > 1 ? JSON.stringify(tagged) : name === 'data' ? payload : JSON.stringify(payload) })
  }

  close() { this.closed = true; window.__closed = true }
}
window.EventSource = FakeEventSource

window.fetch = async (url, init = {}) => {
  const target = String(url)
  const body = init.body ? JSON.parse(init.body) : null
  window.__calls.push({ url: target, body })
  window.__barTraffic.push({ method: init.method ?? 'GET', url: new URL(target, location.href).pathname, endpoint: body?.endpoint, target: body?.payload?.terminal ?? body?.terminal ?? null })
  if (body?.endpoint === 'code-tree') return window.__readCodeTree()
  if (window.__seatFixture && body?.endpoint?.startsWith('seat-chat-')) {
    return window.__seatAnswer?.(body) ?? Response.json({ ok: true, value: { seat: { id: window.__seatBot }, rows: [], generation: 'fixture-open' } })
  }
  if (target.includes('/take')) {
    if (window.__takeAnswer) return window.__takeAnswer(body)
    if (window.__takeDelay) await new Promise(resolve => setTimeout(resolve, window.__takeDelay))
    return new Response(JSON.stringify({ session: `s-${window.__calls.length}`, mode: 'typing' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (target.includes('/input')) {
    if (window.__inputAnswer) return window.__inputAnswer(body)
    return new Response(null, { status: window.__inputStatus })
  }
  if (target.includes('/release')) return new Response(null, { status: 204 })
  return new Response(null, { status: 404 })
}

window.mountPane = () => {
  createRoot(document.getElementById('root')).render(h(TerminalPane, { botId: 'b-aaaaaaaaaa', worker: null, title: 'Atlas' }))
}

window.mountTwoPanes = () => {
  createRoot(document.getElementById('root')).render([
    h(TerminalPane, { key: 'a', botId: 'b-aaaaaaaaaa', title: 'Atlas' }),
    h(TerminalPane, { key: 'b', botId: 'b-bbbbbbbbbb', title: 'Builder' }),
  ])
}

window.inspectTerms = async () => {
  const { Terminal } = await import('@xterm/xterm')
  const open = Terminal.prototype.open
  window.__terms = []
  Terminal.prototype.open = function (element) {
    open.call(this, element)
    window.__terms.push(this)
  }
}

window.__chunkRequests = []
window.__dshChunk = async (name) => {
  window.__chunkRequests.push(name)
  return { CodeBody: PaneBody, CodeTree, CodeTerminal }
}

window.mountCodeBarFixture = async (tree, { twoTrees = false } = {}) => {
  window.__codePicks = []
  window.__codeBubbles = 0
  window.__readCodeTree = () => Response.json({ ok: true, value: tree })
  await loadTree({ fresh: true })
  const root = createRoot(document.getElementById('root'))
  function CodeBar() {
    const current = useCodeSide()
    const onSelect = (pane, options) => window.__codePicks.push([pane, options])
    return h('div', { onClick: () => { window.__codeBubbles++ } },
      h(CodeBarList, { current, onSelect }),
      twoTrees ? h(CodeBarList, { current, onSelect }) : null)
  }
  flushSync(() => root.render(h(CodeBar)))
}

window.pressTerminal = () => openTerminal('b-aaaaaaaaaa')
window.refreshCodeTree = () => loadTree({ fresh: true })
window.setCodeLocale = (language, portuguese) => {
  const dictionaries = { pt: portuguese }
  installLocale({
    register: (_namespace, locale, dictionary) => { dictionaries[locale] = dictionary; return () => { delete dictionaries[locale] } },
    bind: () => key => dictionaries[language]?.[key] ?? key,
  })
}
window.mountCodeBody = (language, portuguese) => {
  window.setCodeLocale(language, portuguese)
  createRoot(document.getElementById('root')).render(h('div', { id: 'code-fixture' }, h(CodeBody)))
}

window.flushCodePick = async (pick) => {
  flushSync(pick)
  // The pane subscribes after xterm's asynchronous import.
  await new Promise(resolve => setTimeout(resolve, 0))
}

window.mountSeatFixture = (tree) => {
  window.__seatFixture = true
  window.__tree = tree
  window.__readCodeTree = () => Response.json({ ok: true, value: window.__tree })
  const bot = tree.projects[0].bots[0]
  window.__seatBot = bot.id
  seatChatView.set({ seat: { id: `seat:${bot.id}`, artId: bot.id, name: bot.name, terminal: bot.terminal.id, chat: 'transcript', status: 'idle' } })
  installStyles(SEAT_CHAT_CSS, 'fixture-seat')
  createRoot(document.getElementById('root')).render(h(SeatChatPanel))
}
window.codeSnapshot = codeStore.snapshot

window.localFixtureSeat = localSeatByKey
window.mountBarFixture = ({ tree, seats = [], front = null, denied = false, bridge = 'closed' }) => {
  window.__seatFixture = true
  window.__tree = tree
  window.__readCodeTree = () => Response.json({ ok: true, value: window.__tree })
  window.__herdrOpens = []
  if (bridge !== 'absent') {
    window.omniDesktop = { herdr: {
      status: async () => ({ state: bridge }),
      open: () => { throw new Error('fixture uses the Code row bridge') },
      openCodeRow: (botId, options) => {
        window.__herdrOpens.push({ botId, ...options })
        return window.__herdrAnswer?.(botId, options) ?? { ok: true, raised: false }
      },
    } }
  }
  window.__seatRows = Array.from({ length: 80 }, (_, i) => ({ id: 'row-' + i, kind: 'text', role: 'assistant', text: 'Line ' + i }))
  window.__listedSeats = seats
  window.__listFailure = null
  window.__readRefusal = null
  window.__dialog = null
  let generation = 0
  window.__seatAnswer = ({ endpoint }) => {
    let value
    if (endpoint === 'seat-chat-list') {
      if (window.__listFailure === 'transport') throw new Error('offline')
      if (denied || window.__listFailure === 'refusal') return Response.json({ ok: false, error: { code: 'bot/refused', message: 'desktop-only' } })
      value = { seats: window.__listedSeats, front }
    } else if (endpoint === 'seat-chat-close') {
      value = { closed: true }
    } else if (endpoint === 'seat-chat-read' && window.__readRefusal !== null) {
      return Response.json({ ok: false, error: { code: 'bot/refused', message: window.__readRefusal } })
    } else {
      const { seat } = seatChatView.getSnapshot()
      const id = seat.artId ?? seat.id
      value = { seat: { id }, rows: window.__seatRows, status: { state: seat.status === 'needs' ? 'blocked' : 'idle' }, question: window.__dialog }
      if (endpoint === 'seat-chat-open') value.generation = `fixture-open-${++generation}`
    }
    return Response.json({ ok: true, value })
  }
  const list = () => fetch('api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint: 'seat-chat-list' }) })
    .then(response => response.json())
    .then(answer => { if (!answer.ok) throw new Error(answer.error.message); return answer.value })
  const status = { bots: new Map(), dsh: new Map(), groups: new Map() }
  function Fixture() {
    const [panel, selectPanel] = useState(null)
    const [navigation] = useState(() => codePanelNavigation({
      panelInfo: { getSnapshot: () => ({ activePanelId: window.__panel ?? null }) },
      selectPanel: (id) => { window.__panel = id; selectPanel(id) },
    }, seatNavigation))
    const code = useCodeSide()
    const listed = useSeats(list)
    const { seat } = useSyncExternalStore(seatChatView.subscribe, seatChatView.getSnapshot)
    useFreshSeat(seat, listed)
    const { front } = useSeatRoster()
    const team = teamOf({ order: [], status, seats: listed, front })
    const openSeat = (seat, { fromCode = false } = {}) => {
      if (!fromCode) clearSeatOrigin()
      seatChatView.set({ seat })
      window.__panel = SEAT_CHAT_PANEL
      selectPanel(SEAT_CHAT_PANEL)
    }
    const back = () => { window.__panel = null; selectPanel(null) }
    return h('div', { style: { display: 'flex', width: '100%', height: '100%' } },
      h('div', { style: { width: 260 } },
        h(CodeSideSwitch, { current: code, onSelect: setCodeSide }),
        code.side === 'team'
          ? h(TeamRows, { team, onOpen: row => openSeat(row.bot), renderArt: () => null })
          : h(CodeBarList, { current: code, onSelect: navigation.open })),
      panel === CODE_PANEL ? h(CodeMainPanel, { onBack: navigation.close, openSeat, useSeatRoster })
        : panel === SEAT_CHAT_PANEL ? h(SeatChatPanel, { onBack: back, onReshowCode: navigation.reshow })
          : h('div', { id: 'conversation' }))
  }
  installStyles(SEAT_CHAT_CSS, 'fixture-seat')
  createRoot(document.getElementById('root')).render(h(Fixture))
}
