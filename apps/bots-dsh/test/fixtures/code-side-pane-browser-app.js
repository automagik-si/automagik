// Browser fixture for the typing pane's resume rule (RFC 0030 delivery 2): the real
// TerminalPane with the real xterm, a stub EventSource, and a fetch that records every call,
// so a test can prove what a waking key or a paste does (and does not) send. Made-up names.
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { TerminalPane } from '../../src/client/code-side-pane.js'

window.__calls = []
window.__inputStatus = 204
window.__takeDelay = 0
window.__closed = false

class FakeEventSource {
  constructor(url) {
    this.url = url
    window.__stream = url
  }

  addEventListener() {}
  close() { window.__closed = true }
}
window.EventSource = FakeEventSource

window.fetch = async (url, init = {}) => {
  const target = String(url)
  const body = init.body ? JSON.parse(init.body) : null
  window.__calls.push({ url: target, body })
  if (target.includes('/take')) {
    if (window.__takeDelay) await new Promise(resolve => setTimeout(resolve, window.__takeDelay))
    return new Response(JSON.stringify({ session: `s-${window.__calls.length}`, mode: 'typing' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (target.includes('/input')) return new Response(null, { status: window.__inputStatus })
  if (target.includes('/release')) return new Response(null, { status: 204 })
  return new Response(null, { status: 404 })
}

window.mountPane = () => {
  createRoot(document.getElementById('root')).render(h(TerminalPane, { botId: 'b-aaaaaaaaaa', worker: null, title: 'Atlas' }))
}
