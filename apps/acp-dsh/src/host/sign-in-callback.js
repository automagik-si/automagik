// Antigravity's sign-in from any computer (#2048, paste-back): the person opens agy's Google
// sign-in link anywhere, signs in, and pastes back the address the browser ends on
// (`http://localhost:<port>/<path>?code=…&state=…`). This module checks that address against
// the link the app took, and hands it once to agy's own loopback listener on this computer.
//
// Secrets: the pasted value, its path and its code are never logged, put in a status, an error
// or a page. Every refusal is a bare `undefined` or the fixed Error('unreachable'): no URL in it.
import http from 'node:http'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
// agy's state: any printable value of 8-512 characters (its charset is not known).
const STATE = /^[^\p{Cc}\s]{8,512}$/u
const VALUE_MAX = 8192
const CODE_MAX = 4096

const stateOk = value => typeof value === 'string' && STATE.test(value)

/**
 * From the auth URL acp-dsh accepted (isSignInUrl): where agy listens and the state it waits
 * for. Only an `http:` loopback return address with an explicit port of 1024 or above (#2048,
 * G6-9) and a printable state of 8-512 characters; anything else answers undefined.
 * @param {unknown} signInUrl
 * @returns {{ host: string, port: number, path: string, state: string } | undefined}
 */
export function callbackOf(signInUrl) {
  if (typeof signInUrl !== 'string') return undefined
  try {
    const url = new URL(signInUrl)
    const states = url.searchParams.getAll('state')
    if (states.length !== 1 || !stateOk(states[0])) return undefined
    const back = new URL(url.searchParams.get('redirect_uri') ?? '')
    if (back.protocol !== 'http:' || !LOOPBACK.has(back.hostname)) return undefined
    if (back.username || back.password || back.hash) return undefined
    if (!/^\d+$/.test(back.port)) return undefined
    const port = Number(back.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined
    return { host: back.hostname, port, path: back.pathname, state: states[0] }
  } catch { return undefined }
}

/**
 * The pasted value against that attempt (`expected`, from callbackOf). Parsed with URL only;
 * never throws (Node's ERR_INVALID_URL carries the whole pasted value in `.input`). Answers the
 * request path to send, or undefined.
 *
 * Accepted on purpose: WHATWG URL normalises `LOCALHOST`, a percent-encoded or fullwidth
 * `localhost`, `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1`, backslashes, `http:/…`, `HTTP://…`,
 * `:05555`, `/auth/../auth/callback`, `/./auth/callback` and `sta%74e=` to the same loopback
 * address, port, path and parameter. The connect address never comes from the paste
 * (deliverCallback), so each of them reaches only agy's own listener.
 * @param {unknown} value
 * @param {{ host: string, port: number, path: string, state: string }} expected
 * @returns {{ path: string } | undefined}
 */
export function checkCallback(value, expected) {
  if (typeof value !== 'string' || expected === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > VALUE_MAX || /[\p{Cc}\s]/u.test(trimmed)) return undefined
  let url
  try { url = new URL(trimmed) } catch { return undefined }
  if (url.protocol !== 'http:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  const host = url.hostname
  if (host !== 'localhost' && host !== '127.0.0.1' && !(host === '[::1]' && expected.host === '[::1]')) return undefined
  if (url.port !== String(expected.port)) return undefined
  if (url.pathname !== expected.path) return undefined
  if (url.hash !== '') return undefined
  const states = url.searchParams.getAll('state')
  if (states.length !== 1 || states[0] !== expected.state) return undefined
  const codes = url.searchParams.getAll('code')
  if (codes.length !== 1 || codes[0].length < 1 || codes[0].length > CODE_MAX) return undefined
  return { path: url.pathname + url.search }
}

// Where the GET goes: a literal loopback address chosen here, never the pasted host and never a
// name lookup. A `localhost` return tries 127.0.0.1, then ::1 when that connect is refused.
const addressesOf = host => (host === '[::1]' ? ['::1'] : host === 'localhost' ? ['127.0.0.1', '::1'] : ['127.0.0.1'])

/**
 * Delivers the checked address once to agy's listener: one GET, no redirect followed, the body
 * never read. `timeoutMs` is one deadline for the whole delivery, both connects included. Any
 * status line resolves `{ status }`; every failure rejects the fixed Error('unreachable').
 * @param {{ host: string, port: number, path: string }} target
 * @param {{ timeoutMs?: number, request?: typeof http.request }} [options]
 * @returns {Promise<{ status: number }>}
 */
export function deliverCallback({ host, port, path }, { timeoutMs = 5000, request = http.request } = {}) {
  const deadline = Date.now() + timeoutMs
  const addresses = addressesOf(host)
  return new Promise((resolve, reject) => {
    let settled = false
    let current
    // The deadline holds even for a request that never honours its signal.
    const timer = setTimeout(() => { try { current?.destroy() } catch {} fail() }, Math.max(0, timeoutMs))
    timer.unref?.()
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('unreachable')) } }
    const attempt = (index) => {
      const remaining = Math.ceil(deadline - Date.now())
      if (remaining <= 0) { fail(); return }
      let answered = false
      let req
      try {
        req = request({
          host: addresses[index], port, path, method: 'GET', agent: false,
          headers: { host: `${host}:${port}`, connection: 'close' },
          timeout: remaining, signal: AbortSignal.timeout(remaining), maxHeaderSize: 16384,
        })
      } catch { fail(); return }
      current = req
      req.on('response', (res) => {
        answered = true
        const status = res.statusCode
        try { res.destroy() } catch {}
        if (!settled) { settled = true; clearTimeout(timer); resolve({ status }) }
      })
      req.on('timeout', () => { try { req.destroy() } catch {} })
      req.on('error', (error) => {
        if (settled || answered) return
        if (error?.code === 'ECONNREFUSED' && index + 1 < addresses.length) attempt(index + 1)
        else fail()
      })
      try { req.end() } catch { fail() }
    }
    attempt(0)
  })
}
