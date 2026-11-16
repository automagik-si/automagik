// The Code side's host half (RFC 0030 delivery 1): the team tree, and one stream of one
// terminal's bytes for the pane that shows it. Never a tool, never an RPC endpoint a Bot can
// call: the tree rides the team's read-only /api/omni-ui endpoints, and the stream is its own
// exact Fetch route, which DSH's Connection answers only for the owner's browser Peer — an
// unauthenticated request, or a Bot's Session, is refused before this code runs.
//
// The route takes a Bot id (and, for a worker, one of that Bot's own folded worker terminals),
// never an arbitrary terminal id: `resolvePane` reads the registry and the two ledgers fresh,
// requires the row to name this computer's core, and has the core itself confirm the terminal
// is live with the same `created_ms` before attaching it with `observe: true` (watch only, no
// input, no resize). The pane is a watcher beside the person's own terminal, not a second
// owner of it.
import { isBotId } from '../shared/registry.js'
import { connectCore } from './code-core.js'
import { readCodeTree, resolvePane } from './code-tree.js'
import { createTypingService, typingRecordPath, typingRoutes } from './code-typing.js'

/** The one terminal stream: exact GET under the shared API channel, so only the owner Peer reaches it. */
export const CODE_STREAM_ROUTE = '/api/omni-ui/code/stream'
/** The team tree, a read-only endpoint on the team's usual route. */
export const CODE_TREE_ENDPOINT = 'code-tree'
/** How many panes one host streams at once. Delivery 1 shows one; the cap keeps it bounded. */
export const MAX_STREAMS = 2
/** A client that stops reading gets no more than this queued before its stream is cut. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024
/** A stream with no bytes and no pulls for this long is let go as gone. */
export const STREAM_IDLE_MS = 5 * 60_000
/** A comment event this often keeps a proxy from closing an idle stream. */
export const HEARTBEAT_MS = 20_000
const WORKER_QUERY = /^[A-Za-z0-9._-]{1,64}$/
const VIEWER_QUERY = /^[A-Za-z0-9._:-]{8,128}$/

const sse = (event, data) => `event: ${event}\ndata: ${data}\n\n`
const jsonError = (status, reason) => Response.json({ error: reason }, { status, headers: { 'cache-control': 'no-store' } })
const noStore = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }

/** The request's query, or a refusal: only `bot`, and for a worker its `worker` terminal. */
export function streamTarget(url) {
  const params = new URL(url).searchParams
  for (const key of params.keys()) {
    if (key !== 'bot' && key !== 'worker' && key !== 'viewer') return { error: 'unknown-parameter' }
  }
  const bots = params.getAll('bot')
  const workers = params.getAll('worker')
  const viewers = params.getAll('viewer')
  if (bots.length !== 1 || !isBotId(bots[0])) return { error: 'no-bot' }
  if (workers.length > 1 || (workers.length === 1 && !WORKER_QUERY.test(workers[0]))) return { error: 'no-worker' }
  if (viewers.length > 1 || (viewers.length === 1 && !VIEWER_QUERY.test(viewers[0]))) return { error: 'no-viewer' }
  return { bot: bots[0], worker: workers.length === 1 ? workers[0] : null, viewer: viewers.length === 1 ? viewers[0] : null }
}

/** Whether a request may read a pane at all: same-origin page fetch/EventSource, never a cross-site one. */
export function streamAdmission(request) {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return { error: 'cross-site', status: 403 }
  const accept = request.headers.get('accept') ?? ''
  if (!accept.includes('text/event-stream')) return { error: 'not-an-event-stream', status: 406 }
  return null
}

/**
 * Serve one terminal to one pane until it goes: SSE events `open`, `data` (base64 terminal
 * bytes), `close`. Credits the core only as the pane pulls, so a slow reader cannot make the
 * host hold an unbounded stream.
 * @param {{ url: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv, warn?: Function,
 *   connect?: typeof connectCore, readFile?: Function, onEnd?: () => void,
 *   onStop?: (close: () => void) => void }} options
 */
export function openPaneStream({ url, signal, env = process.env, warn = () => {}, connect = connectCore, readFile, onEnd = () => {}, onStop = () => {} }) {
  return (async () => {
    const target = streamTarget(url)
    if (target.error) return jsonError(404, target.error)
    const pane = await resolvePane({ botId: target.bot, worker: target.worker, env, connect, readFile, warn })
    if (!pane) return jsonError(404, 'no-pane')
    let core
    try {
      core = await connect({ env })
    } catch {
      return jsonError(503, 'no-core')
    }
    let attached
    try {
      attached = await core.attach({ terminal: pane.terminal, cols: pane.cols, rows: pane.rows, history: 1000 })
    } catch (error) {
      core.close()
      warn(`the Code pane could not attach ${pane.terminal}: ${error?.kind ?? error?.message ?? error}`)
      return jsonError(409, 'attach-refused')
    }
    const { channel } = attached
    let controller = null
    let closed = false
    let idle = null
    let heartbeat = null
    let queued = 0
    const queue = [] // { event, data, bytes } in arrival order
    let waiter = null
    const wake = () => { const next = waiter; waiter = null; next?.() }

    const stop = (reason) => {
      if (closed) return
      closed = true
      clearTimeout(idle)
      clearInterval(heartbeat)
      try { core.detach(channel) } catch { /* the connection is going */ }
      core.close()
      signal?.removeEventListener?.('abort', onCancel)
      onEnd()
      if (controller) {
        try {
          if (reason && reason !== 'closed') controller.enqueue(new TextEncoder().encode(sse('close', JSON.stringify({ reason }))))
        } catch { /* already cut */ }
        try { controller.close() } catch { /* already cut */ }
        controller = null
      }
      wake()
    }
    const onCancel = () => stop('closed')
    signal?.addEventListener?.('abort', onCancel, { once: true })
    if (signal?.aborted) { stop('closed'); return new Response(null, { status: 204 }) }

    const touch = () => {
      clearTimeout(idle)
      idle = setTimeout(() => stop('idle'), STREAM_IDLE_MS)
      idle.unref?.()
    }
    touch()

    core.watch(channel, {
      onData: (bytes) => {
        if (closed) return
        const copy = Buffer.from(bytes)
        if (queued + copy.length > MAX_QUEUED_BYTES) { stop('slow'); return }
        queue.push({ event: 'data', data: copy.toString('base64'), bytes: copy.length })
        queued += copy.length
        touch()
        wake()
      },
      onClose: reason => stop(reason || 'ended'),
    })

    const body = new ReadableStream({
      start(c) {
        controller = c
        c.enqueue(new TextEncoder().encode(sse('pane', JSON.stringify({ bot: pane.botId, terminal: pane.terminal, cols: pane.cols, rows: pane.rows, name: pane.name }))))
      },
      async pull(c) {
        while (queue.length === 0 && !closed) {
          await new Promise((resolve) => { waiter = resolve })
        }
        if (queue.length === 0) { try { c.close() } catch { /* cut */ } return }
        const next = queue.shift()
        queued -= next.bytes
        touch()
        try {
          c.enqueue(new TextEncoder().encode(sse(next.event, next.data)))
        } catch {
          stop('closed')
          return
        }
        // The pane has taken these bytes: let the core send more. Never before.
        try { core.credit(channel, next.bytes) } catch { /* the connection is going */ }
      },
      cancel() {
        stop('closed')
      },
    })
    heartbeat = setInterval(() => {
      if (closed || !controller || queue.length > 0) return
      try { controller.enqueue(new TextEncoder().encode(': keep-alive\n\n')) } catch { stop('closed') }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    // The host keeps a way to end this stream when its own scope ends (plugin or Connection).
    onStop(() => stop('stopped'))
    return new Response(body, { status: 200, headers: { ...noStore, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } })
  })()
}

/**
 * Install the Code side on a running team: the tree endpoint and the pane stream route.
 * @param {any} rt the team runtime
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectCore, readFile?: typeof readFileSync }} [options]
 */
export function install(rt, { env = process.env, connect = connectCore, readFile } = {}) {
  const warn = (...args) => rt.warn?.(`omni-ui: ${args.map(value => (typeof value === 'string' ? value : String(value))).join(' ')}`)
  rt.hooks.endpoint(CODE_TREE_ENDPOINT, async () => {
    const answer = await readCodeTree({ env, warn, connect, readFile })
    if (answer.tree) return answer.tree
    return { v: 1, machine: null, projects: [], reason: answer.reason ?? 'unavailable' }
  }, { read: true })
  const streams = new Set()
  const live = new Set()
  const closeAll = () => {
    for (const close of [...live]) { try { close() } catch { /* going */ } }
    live.clear()
    streams.clear()
    void typing.dispose()
  }
  // A host without a browser carrier (a test's bare context, a headless run) has no route
  // registry: the tree still answers, and the pane simply has nowhere to stream to.
  const fetchRoutes = rt.ctx?.connection?.fetch
  if (typeof fetchRoutes?.register !== 'function') return () => {}
  // Typing: its own exact routes, owner-only and re-admitted per batch (code-typing.js).
  const typing = createTypingService({
    env, connect, readFile, warn,
    recordPath: typingRecordPath(rt.home ?? process.cwd()),
    admit: request => rt.ctx.connection.admit(request),
  })
  rt.ctx.effect(() => () => { void typing.dispose() }, 'omni-ui: code typing releases')
  for (const [path, handler] of typingRoutes(typing)) {
    rt.ctx.effect(() => fetchRoutes.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handler(request),
    }), `omni-ui: code typing ${path}`)
  }
  rt.ctx.effect(() => fetchRoutes.register({
    path: CODE_STREAM_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const refusal = streamAdmission(request)
      if (refusal) return jsonError(refusal.status, refusal.error)
      const target = streamTarget(request.url)
      if (target.error) return jsonError(404, target.error)
      const tag = target.worker === null ? target.bot : `${target.bot}\0${target.worker}`
      if (streams.has(tag)) return jsonError(409, 'already-open')
      if (streams.size >= MAX_STREAMS) return jsonError(429, 'busy')
      streams.add(tag)
      let forgetCloser = () => {}
      try {
        const response = await openPaneStream({
          url: request.url, signal: request.signal, env, warn, connect, readFile,
          onEnd: () => {
            streams.delete(tag)
            forgetCloser()
            // The watch stream ending is how a signed-out page (or a refused batch that made
            // the client close it) tells this host to let that viewer's typing attach go.
            if (target.viewer) void typing.releaseViewer(target.viewer)
          },
          onStop: (close) => {
            const stop = () => { live.delete(stop); close() }
            live.add(stop)
            // A stream that ends on its own (its reader went, the terminal ended) must not
            // leave its closer in the live set.
            forgetCloser = () => live.delete(stop)
          },
        })
        // A refusal owns no stream: its slot goes back at once, or refusals would spend the
        // pane budget and every later open would read busy.
        if (response.status !== 200) streams.delete(tag)
        return response
      } catch (error) {
        streams.delete(tag)
        warn(`the Code pane failed: ${error?.message ?? error}`)
        return jsonError(503, 'unavailable')
      }
    },
  }), 'omni-ui: code pane stream')
  // The only scope ends of a browser stream are the plugin and its Connection: close every
  // stream (and typing attach) when either goes. A stopped Connection has no `fetch` service
  // to hear from, so this watches for it while a stream is live.
  const scopeWatch = setInterval(() => {
    if (live.size === 0) return
    if (typeof rt.ctx.get === 'function' && rt.ctx.get('connection') === undefined) closeAll()
  }, 250)
  scopeWatch.unref?.()
  return () => { clearInterval(scopeWatch); closeAll() }
}
