// Native Hermes wire. Its public boundary is rows, questions and durable identities; no ACP SDK.
import { redactSshText } from './hermes-redact.js'
import { headOf } from './text.js'
export const HERMES_DEADLINES = Object.freeze({ start: 60_000, control: 15_000, cancel: 5000 })
export const LOST = 'Connection lost; remote outcome unknown'
export const REPLAY_GAP = 'Some remote Hermes events could not be replayed after reconnecting. Reconnect and reconcile to see the current remote state.'
// The oldest Desktop contract this wire speaks. A newer one that still answers is not an error.
export const OLDEST_CONTRACT = 8
export const OUTDATED = 'Remote Hermes is too old for this connection. Update Hermes, then connect again.'
export const CANONICAL = 'This Hermes is run by a gateway that owns its sessions. Connect to a Hermes started with “hermes serve”.'
const TURN_FAILURE = 'Remote Hermes reported a turn failure. Inspect the remote session before sending again.'
const FAILED_TURN = 'Remote Hermes reported a failed turn. Review the remote session.'
const REASON_LIMIT = 500

// The remote's own words for a failed turn: its `error` frame carries `payload.message`, a
// failed `message.complete` carries `payload.error` and sometimes `failure_reason`. The wire
// redacts a frame before a chat sees it; this also runs the SSH path's rule for Hermes's own
// words, so a reason that quotes a key block, an opaque token, a `ticket=` query or a home
// folder is masked too. This only makes it one bounded line. A detail that is blank after
// that is no detail: the fixed sentence says more than an empty reason.
function remoteReason(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const line = redactSshText(value).replace(/\s+/g, ' ').trim()
    if (!line) continue
    return line.length > REASON_LIMIT ? `${headOf(line, REASON_LIMIT - 1)}…` : line
  }
  return undefined
}

// tui_gateway/methods_prompt.py at 3bcd071226d3d605a2bb3b4f3933e7d583e189d6:
// refusals say "Nothing was sent"; unconfirmed "may already be queued".
function refusedSubmit(error) {
  const remote = error?.remote
  return Boolean(remote && ([4004, 4009, 4091, 4120, 4121, 4124, 5035].includes(remote.code)
    || remote.code === 4090 && ['SESSION_OWNER_BUSY', 'SESSION_NOT_OWNED'].includes(remote.reason)))
}

const localFailures = new WeakSet()
const failure = (message, code = 'bot/hermes') => {
  const error = Object.assign(new Error(message), { code })
  localFailures.add(error)
  return error
}
const safeModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]@-]{0,200}$/.test(value)

export const INVALID_FRAME = 'Remote Hermes returned an invalid protocol frame. Reconnect and reconcile the remote session.'
const FRAME_BYTES = 8 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = value => typeof value === 'string'
const id = value => string(value) || Number.isSafeInteger(value)
const optional = (value, type) => value === undefined || value === null || type(value)
const fields = (value, names, type) => names.every(name => optional(value[name], type))
// A live legacy session's info may omit stored_session_id (its session_key carries it);
// the field stays optional and the snapshot normalizes it.
const infoShape = value => object(value) && fields(value, ['approval_mode', 'stored_session_id', 'model', 'provider'], string)
  && fields(value, ['yolo', 'running', 'lazy'], value => typeof value === 'boolean')
const requestShape = value => object(value) && id(value.id) && string(value.method) && object(value.params)
  && (value.method !== 'approval' || (string(value.params.session_id) && string(value.params.request_id)
    && fields(value.params, ['command', 'description'], string)))
function eventShape(value) {
  // message.start and a plain sessions.changed carry no payload at all; a known event
  // that needs fields still fails below when its payload is missing.
  if (!object(value) || !string(value.type) || !optional(value.payload, object) || !optional(value.session_id, string)
    || !optional(value.seq, value => Number.isSafeInteger(value) && value >= 0)) return false
  const p = value.payload ?? {}
  if (['session.info', 'message.delta', 'message.interim', 'message.complete', 'tool.start', 'tool.complete', 'request.cancel'].includes(value.type) && (!string(value.session_id) || !value.session_id)) return false
  if (value.type === 'gateway.ready') return string(p.replay_epoch) && optional(p.session_authority, value => typeof value === 'boolean')
  if (value.type === 'session.info') return infoShape(p)
  if (value.type === 'request.cancel') return string(p.id) && string(p.method) && string(p.reason)
  if (['message.delta', 'message.interim'].includes(value.type)) return string(p.text)
    && optional(p.offset, value => Number.isSafeInteger(value) && value >= 0) && optional(p.already_streamed, value => typeof value === 'boolean')
  if (value.type === 'message.complete') return fields(p, ['text', 'status', 'error', 'failure_reason'], string)
    && optional(p.response_reused, value => typeof value === 'boolean')
  if (['tool.start', 'tool.complete'].includes(value.type)) return string(p.tool_id)
    && (value.type !== 'tool.start' || string(p.name)) && fields(p, ['name', 'result_text', 'summary'], string)
    && optional(p.args, object)
  return true // Unknown events are ignored by the chat boundary.
}
function snapshotShape(value) {
  return object(value) && string(value.session_id) && infoShape(value.info)
    && fields(value, ['stored_session_id', 'session_key', 'status', 'admission_id'], string)
    && fields(value, ['running', 'hydrating'], value => typeof value === 'boolean')
    && optional(value.inflight, value => object(value) && fields(value, ['assistant', 'user'], string) && optional(value.streaming, value => typeof value === 'boolean'))
    && optional(value.open_requests, value => Array.isArray(value) && value.every(requestShape))
    && Array.isArray(value.messages) && value.messages.every(message => object(message) && string(message.role)
      && optional(message.text, string))
}
function resultShape(method, value) {
  if (!object(value)) return false
  if (['session.create', 'session.resume', 'session.activate'].includes(method)) return snapshotShape(value)
  if (method === 'session.list') return Array.isArray(value.sessions) && value.sessions.every(row => object(row) && string(row.id) && optional(row.resolved_id, string) && optional(row.title, string))
  if (method === 'client.capabilities') return Array.isArray(value.server_requests) && value.server_requests.every(string)
  if (method === 'session.events.since') return string(value.epoch) && Number.isSafeInteger(value.latest_seq) && value.latest_seq >= 0
    && typeof value.truncated === 'boolean' && Array.isArray(value.events) && value.events.every(eventShape)
    && Array.isArray(value.open_requests) && value.open_requests.every(requestShape)
  if (method === 'model.options') return Array.isArray(value.providers) && value.providers.every(provider => object(provider)
    && string(provider.slug) && optional(provider.models, value => Array.isArray(value) && value.every(string))
    && optional(provider.unavailable_models, value => Array.isArray(value) && value.every(string))
    && optional(provider.authenticated, value => typeof value === 'boolean'))
  if (method === 'config.set') return fields(value, ['scope'], string)
    && fields(value, ['confirm_required', 'deferred'], value => typeof value === 'boolean')
  if (method === 'prompt.submit') return fields(value, ['admission_id', 'status'], string)
  return true
}
function frameShape(value) {
  if (!object(value) || value.jsonrpc !== '2.0') return false
  if (value.method !== undefined) return string(value.method) && !Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error') && (value.method === 'event'
    ? value.id === undefined && eventShape(value.params) : requestShape(value))
  return id(value.id) && (Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error'))
    && (!Object.hasOwn(value, 'error') || (object(value.error) && Number.isInteger(value.error.code) && string(value.error.message)))
}
// Bound structure before recursive redaction; JSON.parse itself does not recurse through user callbacks.
function boundedStructure(value) {
  const stack = [[value, 0]]
  while (stack.length) {
    const [item, depth] = stack.pop()
    if (depth > 32) return false
    if (item && typeof item === 'object') for (const nested of Object.values(item)) stack.push([nested, depth + 1])
  }
  return true
}

export function remoteAddress(input, { allowLoopback = false } = {}) {
  let url
  try { url = new URL(input) } catch { throw failure('Enter an HTTPS address for Hermes.') }
  const tunnel = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((!tunnel && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
    throw failure('Use an HTTPS address without credentials, a query or fragment.')
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

// A socket address carries its credential in the query (token, ticket, internal): whatever
// follows one of those names is never kept, whoever's token it is.
const SOCKET_QUERY = /([?&](?:token|ticket|internal)=)[^&#\s"'<>\\]+/gi
/** Text with the credential of any socket address in it removed. */
export const redactSocketQuery = text => String(text ?? '').replace(SOCKET_QUERY, '$1[redacted]')

// The rules whose secret has no end of its own: a mark, then every character of a kind.
// Text that is all there takes `whole`. A stream can be cut inside either part: `cut` is a
// mark, or the start of one, at the end of what has arrived; `more` is the rest of a value
// at the start of what arrives next.
const starts = word => Array.from(word, (_, index) => word.slice(0, index + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const OPEN_ENDED = [
  { whole: /\bBearer\s+\S+/gi, shown: 'Bearer [redacted]', cut: new RegExp(`\\b(?:Bearer\\s+|${starts('Bearer')})$`, 'i'), more: /^\S+/ },
  { whole: /hermes-gateway-ticket\.[A-Za-z0-9._~-]+/g, shown: 'hermes-gateway-ticket.[redacted]', cut: new RegExp(`(?:${starts('hermes-gateway-ticket.')})$`), more: /^[A-Za-z0-9._~-]+/ },
  { whole: SOCKET_QUERY, shown: '$1[redacted]', cut: new RegExp(`[?&](?:${['token=', 'ticket=', 'internal='].map(starts).join('|')})?$`, 'i'), more: /^[^&#\s"'<>\\]+/ },
]
// The events whose text is one stream: it reaches a chat only through text().
const STREAM_TEXT = new Set(['message.delta', 'message.interim', 'message.complete'])

// The requests that are about the connection, not a profile: Hermes refuses a field its
// contract does not name, so these never carry one.
const UNSCOPED = new Set(['client.capabilities'])

// Errors are fixed sentences. Never forward a fetch/socket/RPC error, headers or response body
// to the caller: those surfaces can echo credentials, tickets and private remote configuration.
// The one exception is the remote's own word on a failed turn: the wire has already redacted it,
// and the chat shows it bounded to one line. Known transient values are also removed from model
// names, rows, and approval descriptions.
export class HermesTransport {
  constructor({ address, profile, credential, authHeaders, allowLoopback = false, attached = false, redactionSecrets = [], fetch: fetcher = globalThis.fetch, socket = (url, protocols) => new WebSocket(url, protocols), deadlines = HERMES_DEADLINES }) {
    this.address = remoteAddress(address, { allowLoopback })
    this.profile = profile
    this.credential = credential
    this.fetcher = fetcher
    this.socket = socket
    this.deadlines = deadlines
    this.startUntil = Date.now() + deadlines.start
    this.pending = new Map()
    this.listeners = new Set()
    this.authHeaders = authHeaders ?? { Authorization: `Bearer ${credential}` }
    this.attached = attached === true
    // A session token (the one-time token of an SSH connection, a saved session token)
    // opens the chat socket itself, as Hermes Desktop does: Hermes mints a socket ticket
    // only for a signed-in session (a password sign-in's cookies, a bearer). An attached
    // serve's host token is the dashboard token: the socket carries it as ?token=.
    const sessionToken = Object.entries(this.authHeaders).find(([name]) => /^x-hermes-session-token$/i.test(name))?.[1]
    this.socketToken = typeof sessionToken === 'string' && sessionToken ? sessionToken
      : this.attached && typeof credential === 'string' && credential ? credential : undefined
    this.secrets = new Set([credential, ...redactionSecrets].filter(value => typeof value === 'string' && value))
    for (const [name, value] of Object.entries(this.authHeaders)) {
      if (typeof value !== 'string' || !value) continue
      this.secrets.add(value)
      if (/^authorization$/i.test(name)) this.secrets.add(value.replace(/^\S+\s+/, ''))
      if (/^cookie$/i.test(name)) for (const pair of value.split(';')) {
        const separator = pair.indexOf('=')
        if (separator >= 0) {
          const cookie = pair.slice(separator + 1).trim()
          if (cookie) this.secrets.add(cookie)
          if (cookie.startsWith('"') && cookie.endsWith('"')) this.secrets.add(cookie.slice(1, -1))
        }
      }
    }
    this.serial = 0
    // The turn the wire is streaming here. Only a start (or a delta that names its turn) opens
    // one: a submit opens nothing, because a completion carries no turn id and an earlier
    // turn's completion may arrive after the submit. A completion names none, so it ends the
    // turn this connection has open, or no turn at all.
    this.turnId = undefined
    this.turnSerial = 0
  }

  /** The secrets this connection knows, in each form they are written. */
  known(text) {
    for (const secret of this.secrets) {
      if (!secret) continue
      for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) text = text.split(form).join('[redacted]')
    }
    return text
  }

  redact(value) {
    const clean = text => OPEN_ENDED.reduce((out, rule) => out.replace(rule.whole, rule.shown), this.known(text))
    if (typeof value === 'string') return clean(value)
    if (Array.isArray(value)) return value.map(item => this.redact(item))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), /authorization|cookie|ticket|token|secret|password|headers/i.test(key) ? '[redacted]' : this.redact(item)]))
    return value
  }

  /**
   * One stream of text, as it arrives. A secret can be cut between two frames, anywhere:
   * inside a known secret, inside the mark of an open-ended rule or inside its value. So
   * the text arrives here as Hermes sent it, and what could still be the start of a
   * secret is held until the next frame or the end (`flush`).
   */
  text(text = '', flush = false) {
    const carry = this.known((this.textCarry ?? '') + text)
    let keep = 0
    if (!flush) for (const secret of this.secrets) {
      if (!secret) continue
      for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
        for (let count = Math.min(form.length - 1, carry.length); count > keep; count--) {
          if (form.startsWith(carry.slice(-count))) { keep = count; break }
        }
      }
    }
    let head = carry.slice(0, carry.length - keep)
    // A value the last frame cut goes on here. While all of it is taken, or only the held
    // start of a known secret is left, the value is not over.
    if (this.textRun) {
      head = head.replace(this.textRun, '')
      if (head || flush) this.textRun = undefined
    }
    // Again until nothing more is held: "?token=b" holds the "b" a bearer may start with,
    // and then the "?token=" that has no value yet.
    if (!flush) for (;;) {
      const cut = Math.max(0, ...OPEN_ENDED.map(rule => head.match(rule.cut)?.[0].length ?? 0))
      if (!cut) break
      keep += cut
      head = head.slice(0, head.length - cut)
    }
    for (const rule of OPEN_ENDED) {
      const last = [...head.matchAll(rule.whole)].at(-1)
      if (!flush && last && last.index + last[0].length === head.length) this.textRun = rule.more
      head = head.replace(rule.whole, rule.shown)
    }
    this.textCarry = carry.slice(carry.length - keep)
    return head
  }

  async bounded(promise, ms, message, code = 'bot/hermes-timeout') {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(message, code)), ms) })]) }
    finally { clearTimeout(timer) }
  }

  async connect() {
    try {
      await this.bounded(this.open(), this.deadlines.start, 'Remote Hermes did not start within 60 seconds.')
      return this
    } catch (error) {
      const unopened = this.unopened === true
      this.close()
      if (unopened) throw await this.refusal()
      if (localFailures.has(error)) throw error
      throw failure('Remote Hermes could not connect. Check the saved credential and address.', 'bot/hermes-connection')
    }
  }

  // A socket that never opened does not say why. One request with the same token tells a
  // token Hermes refuses from a Hermes that is not answering.
  async refusal() {
    const refused = () => failure('Remote Hermes authentication expired or was refused. Replace the saved credential.', 'bot/hermes-auth')
    try {
      const response = await this.bounded(this.fetcher(`${this.address}/api/profiles`, { headers: this.authHeaders, redirect: 'error' }), Math.min(this.deadlines.control, 5000), 'Remote Hermes did not answer.')
      if (response?.status === 401 || response?.status === 403) return refused()
    } catch (error) { if (error?.code === 'bot/hermes-auth') return refused() }
    return failure('Remote Hermes did not open the chat connection. Check that Hermes is running, then try again.', 'bot/hermes-connection')
  }

  // The single-use ticket a signed-in session (cookies, a bearer) opens its socket with.
  async ticket(controller) {
    let response
    try {
      response = await this.fetcher(`${this.address}/api/auth/ws-ticket`, {
        method: 'POST', headers: this.authHeaders,
        redirect: 'error', signal: controller.signal,
      })
    } catch (error) {
      if (error?.code === 'bot/hermes-auth') throw failure('Remote Hermes authentication expired or was refused. Replace the saved credential.', 'bot/hermes-auth')
      if (error?.code === 'bot/hermes-timeout') throw failure('Remote Hermes did not answer within the connection deadline. Connect again.', 'bot/hermes-timeout')
      throw failure('Remote Hermes could not connect. Check the saved address and that Hermes is running.', 'bot/hermes-connection')
    }
    if (!response.ok) throw response.status === 401 || response.status === 403
      ? failure('Remote Hermes authentication expired or was refused. Replace the saved credential.', 'bot/hermes-auth')
      : failure('Remote Hermes could not complete the connection request. Check that Hermes is running.', 'bot/hermes-connection')
    let ticket
    try { ticket = (await response.json()).ticket } catch { throw failure('Remote Hermes returned an invalid authentication ticket.', 'bot/hermes-protocol') }
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9._~-]+$/.test(ticket)) throw failure('Remote Hermes returned an invalid authentication ticket.', 'bot/hermes-protocol')
    this.secrets.add(ticket)
    return ticket
  }

  async open() {
    const controller = new AbortController()
    this.openAbort = controller
    const ticket = this.socketToken ? undefined : await this.ticket(controller)
    if (this.closed || controller.signal.aborted) throw failure('Remote Hermes startup was cancelled.')
    let readyResolve, readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    // A socket that cannot even be made ends this open before anything waits on `ready`.
    ready.catch(() => {})
    this.readyReject = readyReject
    const url = new URL(`${this.address}/api/ws`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    // The address that holds the token goes to the socket and nowhere else: it is never
    // kept, logged or put in an error. Hermes takes no subprotocol beside a token.
    if (this.socketToken) url.searchParams.set('token', this.socketToken)
    this.ws = this.socket(url.href, this.socketToken ? [] : ['hermes-gateway-v1', `hermes-gateway-ticket.${ticket}`])
    // With a token on the address, a socket Hermes turns away closes before it says anything.
    let answered = false
    const dropped = () => { if (this.socketToken && !answered && !this.closed) this.unopened = true; this.lost() }
    this.ws.addEventListener('open', () => { answered = true })
    this.ws.addEventListener('message', event => {
      answered = true
      if (this.closed || this.lostNotified) return
      try {
        if (!string(event.data) || Buffer.byteLength(event.data, 'utf8') > FRAME_BYTES) throw failure(INVALID_FRAME, 'bot/hermes-protocol')
        const frame = JSON.parse(event.data)
        if (!boundedStructure(frame) || !frameShape(frame)) throw failure(INVALID_FRAME, 'bot/hermes-protocol')
        if (frame.method === 'event' && frame.params.type === 'gateway.ready') {
          if (frame.params.payload.session_authority === true) { readyReject(failure(CANONICAL, 'bot/hermes-unsupported')); return }
          this.epoch = frame.params.payload.replay_epoch
          readyResolve()
        } else this.receive(frame)
      } catch { this.lost(INVALID_FRAME); this.close() }
    })
    this.ws.addEventListener('close', dropped)
    this.ws.addEventListener('error', dropped)
    await ready
    if (this.closed || controller.signal.aborted) throw failure('Remote Hermes startup was cancelled.')
    this.readyReject = undefined
    // Whether this Hermes sends its approval questions here is its own setting: one that
    // does not ask simply runs its tools.
    await this.request('client.capabilities', { server_requests: true })
    this.connected = true
  }

  /**
   * The turn a reply frame belongs to. The wire stamps `message.start` and the streamed frames
   * with their turn id but stamps `message.complete` with none, so a completion ends the turn
   * this connection opened. A start always opens one, even without a wire id (a legacy start
   * has an empty payload): a locally numbered turn is still a turn the wire actually began,
   * unlike a provisional submit turn. A completion with no open turn belongs to an earlier
   * turn and is never attributed to a submit that has not streamed anything yet.
   */
  turnOf(type, payload) {
    const named = typeof payload?.turn_id === 'string' && payload.turn_id ? payload.turn_id : undefined
    if (type === 'message.start') {
      this.turnId = named ?? `turn-${++this.turnSerial}`
      return this.turnId
    }
    if (type === 'message.delta' || type === 'message.interim') {
      if (named !== undefined) this.turnId = named
      return this.turnId ?? null
    }
    if (type === 'message.complete') {
      const turn = this.turnId ?? null
      this.turnId = undefined
      return turn
    }
    return undefined
  }

  receive(frame) {
    if (frame.method && frame.id !== undefined) {
      for (const listener of this.listeners) listener({ kind: 'question', id: frame.id, method: frame.method, params: this.redact(frame.params), epoch: this.epoch })
      return
    }
    if (frame.method === 'event') {
      const params = this.redact(frame.params)
      // Masking one frame would lose the mark its value belongs to; text() masks the stream.
      if (STREAM_TEXT.has(frame.params.type) && typeof frame.params.payload.text === 'string') params.payload.text = frame.params.payload.text
      const event = { kind: 'event', ...params, epoch: this.epoch }
      const turn = this.turnOf(frame.params.type, params.payload)
      if (turn !== undefined) event.turn = turn
      for (const listener of this.listeners) listener(event)
      return
    }
    const pending = this.pending.get(frame.id)
    if (!pending) return
    if (!frame.error && !resultShape(pending.method, frame.result)) throw failure(INVALID_FRAME, 'bot/hermes-protocol')
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.error) {
      const remote = this.redact(frame.error)
      pending.reject(Object.assign(failure('Remote Hermes refused a control request. Check the remote session.'), {
        remote: { code: remote.code, reason: typeof remote.data?.reason === 'string' ? remote.data.reason : undefined, message: remoteReason(remote.message) },
      }))
    } else pending.resolve(this.redact(frame.result))
  }

  request(method, params = {}, ms = this.deadlines.control) {
    if (this.closed || this.lostNotified) return Promise.reject(failure(LOST))
    // A submit opens no turn: its response says the wire accepted it, not that a turn has
    // streamed, and an earlier turn's completion carries no id to tell it apart. Only the
    // wire's own start or a stamped delta opens the turn a completion may end.
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(failure(method === 'prompt.submit' ? LOST : 'Remote Hermes did not answer a control request within 15 seconds.', method === 'prompt.submit' ? 'bot/hermes' : 'bot/hermes-timeout'))
      }, ms)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...(this.profile && !UNSCOPED.has(method) ? { profile: this.profile } : {}) } })) }
      catch { this.lost() }
    })
  }

  answer(id, result, unsupported = false) {
    if (this.closed || this.lostNotified) return
    try { this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, ...(unsupported ? { error: { code: -32601, message: 'This client does not support this request.' } } : { result }) })) }
    catch { this.lost() }
  }

  lost(message = LOST) {
    if (this.closed || this.lostNotified) return
    this.lostNotified = true
    this.connected = false
    this.turnId = undefined
    this.readyReject?.(failure(message))
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(message)) }
    this.pending.clear()
    for (const listener of this.listeners) listener({ kind: 'lost', text: message })
  }

  close() {
    this.openAbort?.abort()
    this.lost()
    this.closed = true
    try { this.ws?.close() } catch {}
  }

  /**
   * A session snapshot this wire can use. Which profile it is and how that profile
   * approves its tools are Hermes's own settings: nothing here reads or requires them.
   */
  check(snapshot) {
    // Create uses stored_session_id; live resume/activate use session_key (plus info's copy).
    const stored = [snapshot?.stored_session_id, snapshot?.session_key, snapshot?.info?.stored_session_id].filter(Boolean)
    if (new Set(stored).size > 1) throw failure('Remote Hermes returned conflicting stored session IDs.')
    snapshot = { ...snapshot, stored_session_id: stored[0] }
    if (snapshot?.session_authority || snapshot?.protocol === 'hermes-gateway-v1') throw failure(CANONICAL, 'bot/hermes-unsupported')
    const contract = snapshot?.info?.desktop_contract
    if (!Number.isInteger(contract) || contract < OLDEST_CONTRACT) throw failure(OUTDATED, 'bot/hermes-outdated')
    if (!snapshot.session_id || !snapshot.stored_session_id) throw failure('Remote Hermes did not return both stored and runtime session IDs.')
    return snapshot
  }

  async session(identity, model) {
    const remaining = () => {
      const ms = this.startUntil - Date.now()
      if (ms <= 0) throw failure('Remote Hermes did not start within 60 seconds.', 'bot/hermes-timeout')
      return Math.min(ms, this.deadlines.control)
    }
    if (identity?.canonicalBot === true) {
      const listing = await this.request('session.list', { title: 'Bot Chat', include_hidden: true }, remaining())
      if (listing.sessions.length !== 1 || listing.sessions[0].title !== 'Bot Chat') throw failure('This profile must have exactly one existing Bot Chat. Open it in Hermes before pairing.', 'bot/hermes-pairing')
      const row = listing.sessions[0], stored = row.resolved_id || row.id
      if (!stored) throw failure('Hermes did not identify its Bot Chat.', 'bot/hermes-pairing')
      if ((identity.pendingSubmit || identity.uncertain) && identity.storedSessionId && ![row.id, stored].includes(identity.storedSessionId)) throw failure('Bot Chat changed while a turn was uncertain. Reconcile the original session in Hermes before pairing again.', 'bot/hermes-pairing')
      const snapshot = this.check(await this.request('session.resume', { session_id: stored, inline_images: false, close_on_disconnect: false }, remaining()))
      // A live legacy session may omit profile_name and report only session_key; the
      // listing was still requested under this profile and is the id we resumed. Reject
      // only a profile that is named and different, or an id that is neither this row
      // nor the id this chat joined before.
      const profileName = snapshot.info?.profile_name
      const known = [row.id, stored, identity.storedSessionId].filter(Boolean)
      if ((this.profile && profileName && profileName !== this.profile) || !known.includes(snapshot.stored_session_id)) throw failure('Hermes returned a different profile or Bot Chat; nothing was submitted.', 'bot/hermes-pairing')
      // A paired bot owns its model. The Automagik provider selection is transport only.
      return snapshot
    }
    const snapshot = this.check(await this.request(identity?.storedSessionId ? 'session.resume' : 'session.create', identity?.storedSessionId
      ? { session_id: identity.storedSessionId, inline_images: false, close_on_disconnect: false }
      : { model: model?.model, provider: model?.provider, idempotency_key: identity?.createKey, close_on_disconnect: false, source: 'automagik' }, remaining()))
    if (identity?.storedSessionId && model && (snapshot.info.model !== model.model || snapshot.info.provider !== model.provider)) {
      if (!safeModel(model.model) || !safeModel(model.provider)) throw failure('Hermes returned an unsupported model identifier.')
      const result = await this.request('config.set', { session_id: snapshot.session_id, key: 'model', value: `${model.model} --provider ${model.provider} --session` }, remaining())
      if (result.scope !== 'session' || result.confirm_required || result.deferred) throw failure('Hermes has not applied this session model. Confirm it in Hermes before sending again.')
    }
    return snapshot
  }

  async models() {
    const result = await this.request('model.options', { include_unconfigured: false })
    return (result.providers ?? []).filter(provider => provider.authenticated !== false && safeModel(provider.slug)).flatMap(provider =>
      (provider.models ?? []).filter(id => safeModel(id) && !provider.unavailable_models?.includes(id)).map(model => ({ id: `${provider.slug}:${model}`, name: model, provider: provider.slug, model })))
  }
}

// Transport-neutral chat boundary. A run owns only one turn; resume always inspects the
// existing session before any submit. In particular no pending submit is ever replayed.
export class RemoteChat {
  constructor(transport, { identity = {}, save = async () => {}, question } = {}) {
    this.transport = transport
    this.identity = identity
    this.save = save
    this.question = question
    this.queue = []
    this.recovered = []
    this.joinGap = false
    this.tools = new Map()
    this.questions = new Map()
    this.cancelledQuestions = new Set()
    this.openAtJoin = []
    this.streamed = ''
    // The wire turn this run saw begin after its submit. A completion only ends the run's own
    // turn; one for an earlier turn is recovered or ignored, never terminal.
    this.turn = undefined
    this.off = event => this.receive(event)
    transport.listeners.add(this.off)
  }

  push(row) { this.queue.push(row); this.wake?.(); this.wake = undefined }

  takeRecovered() {
    const recovered = this.recovered
    this.recovered = []
    return recovered
  }

  /**
   * Whether a completion belongs to this run's turn. The wire names a turn on every streamed
   * frame but the completion, so the transport stamps the completion with the turn it opened;
   * a completion with no open turn is an earlier turn's and names none. This run owns one only
   * after its own start (or stamped delta) opened it: a submit's provisional wait owns nothing,
   * so an earlier turn's completion that arrives after the send cannot end the new reply.
   */
  ownsCompletion(turn) {
    if (turn === undefined) return true // a caller that hands an event straight in, not the wire
    if (this.joining) return false
    return typeof turn === 'string' && turn === this.turn
  }

  async next() {
    if (!this.queue.length) await new Promise(resolve => { this.wake = resolve })
    return this.queue.shift()
  }

  receive(event) {
    if (event.kind === 'lost') {
      this.identity.uncertain = true
      this.turn = undefined
      for (const tool of this.tools.values()) { tool.status = 'unknown'; tool.done?.() }
      for (const asking of this.questions.values()) asking.abort?.()
      void this.save().catch(() => {})
      this.push({ kind: 'error', text: event.text ?? LOST })
      return
    }
    if (this.reconciling) { this.reconciling.push(event); return }
    if (this.joining && (event.kind === 'question' || event.type === 'request.cancel')) {
      this.joinControls.push(event)
      return
    }
    if (event.epoch && this.identity.epoch && event.epoch !== this.identity.epoch) return
    const sid = event.kind === 'question' ? event.params?.session_id : event.session_id
    if (sid !== this.identity.runtimeSessionId && sid !== this.identity.storedSessionId) return
    if (event.kind === 'question') { if (this.question) void this.control(event); return }
    if (Number.isInteger(event.seq)) {
      this.joining?.add(event.seq)
      if (event.seq <= (this.identity.lastSeq ?? 0)) return
      this.identity.lastSeq = event.seq
    }
    const payload = event.payload ?? {}
    // A turn the wire names is the one this run streams. The transport derives the id for a
    // frame that carries none (a completion) from the turn it opened, so a completion of an
    // earlier turn is recognisable and never ends this one. A start opens the turn even when
    // the transport had to number it locally; a stamped delta opens one only when none is open.
    if (typeof event.turn === 'string' && !this.joining
      && (event.type === 'message.start' || (this.turn === undefined && (event.type === 'message.delta' || event.type === 'message.interim')))) this.turn = event.turn
    if (event.type === 'request.cancel') {
      this.cancelledQuestions.add(payload.id)
      this.questions.get(payload.id)?.abort?.()
      this.questions.delete(payload.id)
      return
    }
    if (event.type === 'session.info' && typeof payload.stored_session_id === 'string' && payload.stored_session_id) {
      this.identity.storedSessionId = payload.stored_session_id
      void this.save().catch(() => {})
    }
    if (event.type === 'message.delta' && typeof payload.text === 'string') {
      const text = Number.isInteger(payload.offset) ? payload.text.slice(Math.max(0, this.streamed.length - payload.offset)) : payload.text
      this.streamed += text
      const safe = this.transport.text(text)
      if (safe) this.push({ kind: 'text', text: safe })
    }
    if (event.type === 'message.interim') {
      const safe = this.transport.text(!payload.already_streamed ? payload.text ?? '' : '', true)
      if (safe) this.push({ kind: 'text', text: safe })
      this.streamed = ''
    }
    if (event.type === 'tool.start') {
      const safe = this.transport.text('', true)
      if (safe) this.push({ kind: 'text', text: safe })
      const tool = { id: payload.tool_id, title: payload.name, input: payload.args, status: 'running' }
      this.tools.set(tool.id, tool)
      this.push({ kind: 'tool', tool })
    }
    if (event.type === 'tool.complete') {
      const tool = this.tools.get(payload.tool_id)
      if (tool) { tool.status = 'completed'; tool.text = payload.result_text ?? payload.summary ?? ''; tool.done?.() }
    }
    if (event.type === 'message.complete') {
      if (!this.ownsCompletion(event.turn)) {
        // An earlier turn's completion never ends this run's turn: during the join its reply
        // is recovered once, and the run waits for its own completion.
        if (this.joining && typeof payload.text === 'string' && payload.text) {
          const text = this.transport.text(payload.text, true)
          if (text) this.recovered.push(text)
        }
        return
      }
      this.turn = undefined
      this.terminalCounter = (this.terminalCounter ?? 0) + 1
      this.terminalPayload = payload
      let rest = ''
      if (!payload.response_reused && typeof payload.text === 'string') {
        const goesOn = payload.text.startsWith(this.streamed)
        // A final text that is not what was streamed replaces it: what is held of the
        // stream is not the start of this text.
        if (!goesOn) this.dropHeld()
        rest = goesOn ? payload.text.slice(this.streamed.length) : payload.text
      }
      const safe = this.transport.text(rest, true)
      if (safe) this.push({ kind: 'text', text: safe })
      this.identity.uncertain = false
      this.identity.pendingSubmit = false
      this.stopped?.()
      const reason = remoteReason(payload.error, payload.failure_reason)
      const terminal = payload.status === 'error' || payload.error || payload.failure_reason
        ? { kind: 'error', text: reason ? `Remote Hermes reported a failed turn: ${reason}` : FAILED_TURN }
        : payload.status === 'interrupted' ? { kind: 'aborted', text: 'The remote turn was interrupted. Background remote work may continue.' } : { kind: 'done' }
      const generation = this.generation
      void this.save().then(() => { if (generation === this.generation) this.push(terminal) }, () => { if (generation === this.generation) this.push({ kind: 'error', text: 'Remote session identity could not be saved.' }) })
    }
    if (event.type === 'error') {
      this.identity.uncertain = true
      if (this.identity.pendingSubmit) this.remoteFailed = true
      void this.save().catch(() => {})
      const reason = remoteReason(payload.message, payload.detail)
      this.push({ kind: 'error', text: reason ? `Remote Hermes reported a turn failure: ${reason}` : TURN_FAILURE })
    }
  }

  async control(event) {
    const epoch = event.epoch ?? this.transport.epoch
    if (this.reconciling || epoch !== this.transport.epoch || (epoch && this.identity.epoch && epoch !== this.identity.epoch)) return
    if (event.method === 'approval' && !this.question) return
    if (event.params?.session_id !== this.identity.runtimeSessionId && event.params?.session_id !== this.identity.storedSessionId) return
    if (this.questions.has(event.id) || this.cancelledQuestions.has(event.id)) return
    // Hermes's own question, for the person: it waits as long as they take. Only Hermes
    // withdrawing it, or this chat stopping, ends the wait without an answer.
    const asking = new AbortController()
    this.questions.set(event.id, asking)
    const generation = this.generation
    if (event.method !== 'approval') { this.transport.answer(event.id, undefined, true); return }
    let choice = 'deny'
    try { choice = await this.question(event.params, asking.signal) } catch {}
    if (this.reconciling || this.released || this.cancelledQuestions.has(event.id) || generation !== this.generation || epoch !== this.transport.epoch
      || (epoch && this.identity.epoch && epoch !== this.identity.epoch)) return
    this.transport.answer(event.id, { choice: choice === 'once' ? 'once' : 'deny' })
  }

  checkProfile(snapshot) {
    const profileName = snapshot.info?.profile_name
    if (typeof profileName === 'string' && profileName && this.transport.profile
      && profileName !== this.transport.profile) {
      throw failure('Hermes returned a different profile or Bot Chat; nothing was submitted.',
        'bot/hermes-pairing')
    }
    return snapshot
  }

  async prepare(model) {
    this.joinGap = false
    await this.save()
    let snapshot = await this.transport.session(this.identity, model)
    let requests = (snapshot.open_requests ?? []).map(request => ({ ...request, epoch: this.transport.epoch }))
    let cancels = []
    try {
      if (this.transport.attached === true) {
        // The attach JOIN is resume -> activate -> the gap: activate returns the
        // authoritative snapshot and the viewer subscription, which detach later releases.
        const cursor = this.identity.lastSeq ?? 0
        const joined = snapshot.stored_session_id
        this.joining = new Set()
        this.joinControls = []
        snapshot = this.checkProfile(this.transport.check(await this.transport.request(
          'session.activate', { session_id: snapshot.session_id },
          this.transport.deadlines?.control)))
        // Only resume verified the stored id against the Bot Chat we joined.
        snapshot = { ...snapshot, stored_session_id: joined }
        const replay = await this.transport.request('session.events.since', {
          session_id: snapshot.session_id, last_seen: cursor, replay_epoch: this.identity.epoch,
        }, this.transport.deadlines?.control)
        // Replay is newer than activate; an approval may already have been answered.
        requests = (replay.open_requests ?? []).map(request => ({ ...request, epoch: replay.epoch }))
        cancels = (replay.events ?? []).filter(event => event.type === 'request.cancel')
        const changedEpoch = typeof replay?.epoch === 'string' && replay.epoch !== this.identity.epoch
        // A reloaded session (new runtime) or a sequence that went backwards is the same
        // reset as a restart even when the epoch string did not change: the new events start
        // near zero and receive would drop them all against the old, larger lastSeq.
        const reloaded = this.identity.runtimeSessionId !== undefined && this.identity.runtimeSessionId !== snapshot.session_id
        const rewound = Number.isSafeInteger(replay?.latest_seq) && Number.isSafeInteger(cursor) && replay.latest_seq < cursor
        const gap = replay.truncated === true || Boolean((changedEpoch || reloaded || rewound)
          && this.identity.epoch
          && (cursor > 0 || this.identity.pendingSubmit === true
            || this.identity.uncertain === true))
        if (changedEpoch || reloaded || rewound) {
          // A restarted serve has a new epoch and sequence numbers near zero. Taking the new
          // latest_seq (not max with the old) is what reconcile does; otherwise submit sees
          // equal epochs, never resets, and receive drops every new event.
          this.resetStream()
          if (typeof replay?.epoch === 'string') this.identity.epoch = replay.epoch
          if (typeof replay?.epoch === 'string') this.transport.epoch = replay.epoch
          this.identity.lastSeq = Number.isSafeInteger(replay?.latest_seq) ? replay.latest_seq : 0
        } else if (typeof replay?.epoch === 'string') {
          const events = (replay.events ?? []).filter(event => Number.isInteger(event.seq) && event.seq > cursor
            && !this.joining.has(event.seq) && (event.epoch === undefined || event.epoch === replay.epoch)
            && (event.session_id === snapshot.session_id || event.session_id === snapshot.stored_session_id)).sort((a, b) => a.seq - b.seq)
          let deltas = ''
          // Recovered completions are text only: a terminal row would end the new turn.
          for (const event of events) {
            const payload = event.payload ?? {}
            if (event.type === 'message.delta' && typeof payload.text === 'string') deltas += payload.text
            if (event.type === 'message.complete') {
              if (typeof payload.text === 'string') {
                const text = this.transport.text(payload.text || deltas, true)
                if (text) this.recovered.push(text)
              }
              deltas = ''
            }
          }
          this.identity.epoch = replay.epoch
          this.transport.epoch = replay.epoch
          if (Number.isSafeInteger(replay.latest_seq)) this.identity.lastSeq = Math.max(this.identity.lastSeq ?? 0, replay.latest_seq)
        }
        if (gap) {
          this.joinGap = true
          this.recovered.push(REPLAY_GAP)
        }
      }
      Object.assign(this.identity, { runtimeSessionId: snapshot.session_id, storedSessionId: snapshot.stored_session_id })
      if (typeof snapshot.subscription_id === 'string' && snapshot.subscription_id) this.identity.subscriptionId = snapshot.subscription_id
      if (snapshot.admission_id) this.identity.admissionId = snapshot.admission_id
      const open = new Map()
      for (const request of [...requests, ...(this.joinControls ?? []).filter(event => event.kind === 'question')]) {
        if (request.method !== 'approval' || (request.params?.session_id !== this.identity.runtimeSessionId
          && request.params?.session_id !== this.identity.storedSessionId) || open.has(request.id)) continue
        open.set(request.id, request)
      }
      // These controls can precede the new identity or fall behind the replay cursor.
      for (const event of [...cancels, ...(this.joinControls ?? []).filter(event => event.type === 'request.cancel')]) {
        if ((event.session_id !== this.identity.runtimeSessionId && event.session_id !== this.identity.storedSessionId)
          || (event.epoch !== undefined && event.epoch !== this.identity.epoch)) continue
        this.cancelledQuestions.add(event.payload.id)
        this.questions.get(event.payload.id)?.abort?.()
        this.questions.delete(event.payload.id)
        open.delete(event.payload.id)
      }
      this.openAtJoin = [...open.values()]
      for (const event of this.joinControls ?? []) {
        if (event.kind === 'question' && event.method !== 'approval' && this.question) void this.control(event)
      }
    } finally {
      this.joining = undefined
      this.joinControls = undefined
    }
    await this.save()
    return snapshot
  }

  resetStream() {
    this.generation = (this.generation ?? 0) + 1
    this.queue.length = 0
    for (const tool of this.tools.values()) { tool.status = 'unknown'; tool.done?.() }
    this.tools.clear()
    for (const asking of this.questions.values()) asking.abort?.()
    this.questions.clear()
    this.cancelledQuestions.clear()
    this.streamed = ''
    this.turn = undefined
    this.dropHeld()
  }

  /** Forget what the transport holds of a stream that will not go on. */
  dropHeld() {
    this.transport.textCarry = ''
    this.transport.textRun = undefined
  }

  async reconcile({ answerQuestions = false } = {}) {
    // Fence outstanding answers before resume, replay or persistence can yield. A restarted
    // server can reuse request IDs while an old DSH approval is still awaiting a choice.
    this.generation = (this.generation ?? 0) + 1
    this.reconciling = []
    try {
      await this.prepare()
      this.openAtJoin = []
      const joinGap = this.joinGap
      this.recovered = []
      const replay = await this.transport.request('session.events.since', {
        session_id: this.identity.runtimeSessionId, last_seen: this.identity.lastSeq ?? 0, replay_epoch: this.identity.epoch,
      })
      const changedEpoch = this.identity.epoch !== replay.epoch
      const gap = replay.truncated || Boolean(this.identity.epoch && changedEpoch) || joinGap
      this.resetStream()
      this.identity.epoch = replay.epoch
      this.transport.epoch = replay.epoch
      this.identity.lastSeq = changedEpoch ? replay.latest_seq : Math.max(this.identity.lastSeq ?? 0, replay.latest_seq)
      // Buffer live events while fetching an authoritative snapshot. A terminal received
      // during the fetch requires a newer snapshot; no old queued delta can cross epochs.
      // Controls can also be emitted after _open_requests was captured but before the
      // reply was written. Re-read their current pending state before answering any.
      const snapshotChanges = () => this.reconciling.filter(event => event.epoch === replay.epoch
        && (event.kind === 'question' ? [this.identity.runtimeSessionId, this.identity.storedSessionId].includes(event.params?.session_id)
          : ['message.complete', 'request.cancel'].includes(event.type) && [this.identity.runtimeSessionId, this.identity.storedSessionId].includes(event.session_id))).length
      let snapshot
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = snapshotChanges()
        snapshot = this.checkProfile(this.transport.check(await this.transport.request(
          'session.activate', { session_id: this.identity.runtimeSessionId })))
        if (snapshotChanges() === before) break
        if (attempt === 2) throw failure('Remote session changed while reconciling. Reconnect and reconcile again before sending.')
      }
      // Keep the stored id that prepare verified, including in the returned snapshot.
      snapshot = { ...snapshot, stored_session_id: this.identity.storedSessionId }
      this.identity.runtimeSessionId = snapshot.session_id
      for (const event of this.reconciling) if (event.epoch === replay.epoch && Number.isSafeInteger(event.seq)) this.identity.lastSeq = Math.max(this.identity.lastSeq, event.seq)
      this.identity.uncertain = snapshot.running === true || snapshot.info?.running === true || snapshot.hydrating === true || snapshot.inflight?.streaming === true
        || ['starting', 'waiting', 'working', 'streaming', 'resuming'].includes(snapshot.status) || (snapshot.open_requests?.length ?? 0) > 0 || Boolean(snapshot.auto_continue)
      if (!this.identity.uncertain) this.identity.pendingSubmit = false
      this.reconciling = undefined
      await this.save()
      if (answerQuestions) for (const request of snapshot.open_requests ?? []) void this.control({ ...request, kind: 'question', epoch: replay.epoch })
      return { snapshot, gap, unknown: this.identity.uncertain }
    } finally { this.reconciling = undefined }
  }

  async submit(text, model) {
    if (this.identity.pendingSubmit || this.identity.uncertain) throw failure('Reconcile the existing remote session before sending again; its outcome is unknown.')
    await this.prepare(model)
    // A completed turn may resume on a newly owned SSH backend. Its sequence numbers
    // start again; only uncertain turns take the reconciliation path above.
    if (this.identity.epoch !== this.transport.epoch) {
      this.resetStream()
      this.identity.lastSeq = 0
    }
    this.identity.epoch = this.transport.epoch
    for (const { epoch, ...request } of this.openAtJoin) void this.control({ ...request, kind: 'question', epoch })
    this.openAtJoin = []
    // This run owns one turn at a time, and only after the wire starts it: its own completion
    // ends it, never an earlier turn's completion that arrives after this send.
    this.turn = undefined
    this.identity.pendingSubmit = true
    await this.save() // Durable before any submit bytes leave.
    try {
      const result = await this.transport.request('prompt.submit', { session_id: this.identity.runtimeSessionId, text })
      if (result.admission_id) this.identity.admissionId = result.admission_id
      await this.save()
    } catch (error) {
      this.turn = undefined
      if (refusedSubmit(error)) {
        this.identity.pendingSubmit = false
        await this.save()
        const message = error.remote.message
        throw failure(message ? `Remote Hermes refused this message: ${message}` : 'Remote Hermes refused this message. Nothing was sent; send it again.', 'bot/hermes')
      }
      this.identity.uncertain = true
      await this.save()
      throw failure(LOST)
    }
  }

  async stop() {
    if (this.released && !this.stopping) return
    if (this.stopping) return this.stopping
    this.stopping = this.stopOnce()
    return this.stopping
  }

  async stopOnce() {
    if (!this.identity.pendingSubmit) { await this.close(); return }
    this.identity.uncertain = true
    await this.save()
    try {
      // An interrupt reply is only receipt. Wait for message.complete during the cancel grace.
      await this.transport.bounded((async () => {
        await this.transport.request('session.interrupt', { session_id: this.identity.runtimeSessionId })
        if (this.identity.pendingSubmit) await new Promise(resolve => { this.stopped = resolve })
      })(), this.transport.deadlines.cancel, LOST)
    } catch { this.push({ kind: 'error', text: LOST }) }
    if (this.remoteFailed && this.identity.uncertain && !this.transport.lostNotified && !this.transport.closed) {
      // Only the remote's settled snapshot can clear a nonterminal failure.
      try { await this.transport.bounded(this.reconcile(), this.transport.deadlines.control, LOST) } catch {}
    }
    await this.save()
    // Closing detaches this viewer; it says nothing about remote children.
    await this.close()
  }

  /**
   * Close an attached view: drop this viewer's subscription, then the WebSocket and its
   * tunnel. It never asks the remote to close, stop or clean the session. A serve that
   * does not speak `session.detach` simply loses the socket, which is still no stop.
   */
  async close() {
    if (this.closed) return
    this.closed = true
    await this.detach()
    this.dispose()
  }

  /**
   * Close a replaced run with the same detach as close(), but stop listening first so
   * the old socket cannot change the shared identity or answer questions during detach.
   */
  async release() {
    if (this.released || this.closed) return
    this.released = true
    if (this.stopping) {
      await this.stopping.catch(() => {})
      return
    }
    this.closed = true
    this.quiet()
    await this.detach()
    this.dispose()
  }

  async detach() {
    if (this.detached || this.transport.attached !== true) return
    this.detached = true
    const sessionId = this.identity.runtimeSessionId
    const subscriptionId = this.identity.subscriptionId
    if (!sessionId || !subscriptionId) return
    try { await this.transport.request('session.detach', { session_id: sessionId, subscription_id: subscriptionId }, this.transport.deadlines?.control) } catch {}
  }

  quiet() {
    if (this.quieted) return
    this.quieted = true
    this.transport.listeners.delete(this.off)
    for (const asking of this.questions.values()) asking.abort?.()
    for (const tool of this.tools.values()) { if (tool.status === 'running') tool.status = 'unknown'; tool.done?.() }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.quiet()
    this.transport.close()
  }
}

// Exported for the wire tests: the real legacy serve sends events with no payload at all
// (message.start) and a live session's info may omit stored_session_id.
export { eventShape as hermesEventShape, infoShape as hermesInfoShape }
