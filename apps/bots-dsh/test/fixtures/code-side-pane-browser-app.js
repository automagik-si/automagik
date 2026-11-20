// Browser fixture for the typing pane's resume rule (RFC 0030 delivery 2): the real
// TerminalPane with the real xterm, a stub EventSource, and a fetch that records every call,
// so a test can prove what a waking key or a paste does (and does not) send. Made-up names.
import { createElement as h } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { CodeBody, codeStore, loadTree, openTerminal } from '../../src/client/code-side.js'
import { CodeBody as PaneBody, TerminalPane } from '../../src/client/code-side-pane.js'
import { installLocale } from '../../src/client/i18n.js'
import { SeatChatPanel, seatChatView, SEAT_CHAT_CSS } from '../../src/client/seat-chat.js'
import { installStyles } from '../../src/client/styles.js'

window.__calls = []
window.__streams = []
window.__inputStatus = 204
window.__takeDelay = 0
window.__closed = false

class FakeEventSource {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.paneCount = new URL(url, location.href).searchParams.getAll('bot').length
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
  if (body?.endpoint === 'code-tree') return window.__readCodeTree()
  if (window.__seatFixture && body?.endpoint?.startsWith('seat-chat-')) return Response.json({ ok: true, value: { rows: [] } })
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
  return { CodeBody: PaneBody }
}

window.pressTerminal = () => openTerminal('b-aaaaaaaaaa')
window.refreshCodeTree = () => loadTree({ fresh: true })
window.mountCodeBody = (language, portuguese) => {
  const dictionaries = { pt: portuguese }
  installLocale({
    register: (_namespace, locale, dictionary) => { dictionaries[locale] = dictionary; return () => { delete dictionaries[locale] } },
    bind: () => key => dictionaries[language]?.[key] ?? key,
  })
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
  seatChatView.set({ seat: { id: `seat:${bot.id}`, artId: bot.id, name: bot.name, terminal: bot.terminal.id, chat: 'transcript', status: 'idle' } })
  installStyles(SEAT_CHAT_CSS, 'fixture-seat')
  createRoot(document.getElementById('root')).render(h(SeatChatPanel))
}
window.codeSnapshot = codeStore.snapshot
