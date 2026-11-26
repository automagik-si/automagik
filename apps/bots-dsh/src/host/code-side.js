// The Code side's host half (RFC 0030 delivery 1): the team tree, and one stream of terminal
// bytes for the panes in each Code view. Never a tool, never an RPC endpoint a Bot can
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
import { validGrid } from '../shared/code-grid.js'
import { connectCore, HISTORY_LINES } from './code-core.js'
import { paneStillOwned, readCodeTree, resolvePane } from './code-tree.js'
import { createTypingService, typingRecordPath, typingRoutes } from './code-typing.js'
import { appBrowserBridge } from './constants.js'
import { fromWindow, verifiedWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'

/** Exact GET under the shared API channel, so only the owner Peer reaches the terminal stream. */
export const CODE_STREAM_ROUTE = '/api/omni-ui/code/stream'
/** The team tree, a read-only endpoint on the team's usual route. */
export const CODE_TREE_ENDPOINT = 'code-tree'
/** Four pane attaches per view, with room for both the seat and bar. */
export const MAX_STREAMS = 8
/** A client that stops reading gets no more than this queued before its stream is cut. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024
/** A stream with no bytes and no pulls for this long is let go as gone. */
export const STREAM_IDLE_MS = 5 * 60_000
/** A comment event this often keeps a proxy from closing an idle stream. */
export const HEARTBEAT_MS = 20_000
const WORKER_QUERY = /^[A-Za-z0-9._-]{1,64}$/
const VIEWER_QUERY = /^[A-Za-z0-9._:-]{8,128}$/
const RESYNC_DELAY_MS = 200
const REOPEN_WAIT_MS = 1500
const REOPEN_POLL_MS = 25
const paneTag = ({ bot, worker }) => `${bot}\0${worker ?? ''}`

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

/** The aligned query for a view with two to four panes, or a refusal. */
export function streamTargets(url) {
  const params = new URL(url).searchParams
  const bots = params.getAll('bot')
  if (bots.length > 4) return { error: 'too-many-panes' }
  for (const key of params.keys()) {
    if (key !== 'bot' && key !== 'worker' && key !== 'viewer') return { error: 'unknown-parameter' }
  }
  const workers = params.getAll('worker')
  const viewers = params.getAll('viewer')
  if (bots.length < 2 || !bots.every(isBotId)) return { error: 'no-bot' }
  if (workers.length !== bots.length || workers.some(worker => worker !== '' && !WORKER_QUERY.test(worker))) return { error: 'no-worker' }
  if (viewers.length !== bots.length || !viewers.every(viewer => VIEWER_QUERY.test(viewer))
    || new Set(viewers).size !== viewers.length) return { error: 'no-viewer' }
  const targets = bots.map((bot, p) => ({ bot, worker: workers[p] || null, viewer: viewers[p] }))
  if (new Set(targets.map(paneTag)).size !== targets.length) return { error: 'duplicate-pane' }
  return targets
}

/** Whether a request may read a pane at all: same-origin page fetch/EventSource, never a cross-site one. */
export function streamAdmission(request) {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') return { error: 'cross-site', status: 403 }
  const accept = request.headers.get('accept') ?? ''
  if (!accept.includes('text/event-stream')) return { error: 'not-an-event-stream', status: 406 }
  return null
}

export function samePane(pane, current) {
  return current?.terminal === pane.terminal && current.core === pane.core && current.created_ms === pane.created_ms
}

/** Attach can race a replacement. Discard the channel before exposing buffered frames. */
export function confirmAttached(core, pane, attached) {
  const terminal = attached.terminal
  if (terminal?.address === pane.terminal && terminal.created_ms === pane.created_ms) return true
  try { core.detach(attached.channel) } catch { /* the connection is going */ }
  return false
}

/** One observer connection, including its resize resync and credit. */
function paneObserver(target, { push, reset, end, warn, connect, env, readFile }) {
  let pane
  let core
  let grid
  let watching
  let closed = false
  let resyncTimer
  let resyncAt = null
  let resyncing = false

  const attach = ({ cols, rows }) => core.attach({ terminal: pane.terminal, cols, rows, history: HISTORY_LINES, observe: true })
  const resolve = (connect) => resolvePane({ botId: target.bot, worker: target.worker, env, connect, readFile, warn })
  const ownership = {}
  const stillOwned = () => paneStillOwned(pane, target.worker, { env, readFile, cache: ownership })
  const stillBound = async (lastGrid) => {
    // A resize can briefly report zero columns or rows. The resolver needs a grid, so use
    // the live observer's grid for this identity check and validate the new size after attach.
    const current = await resolve(async () => ({
      info: core.info,
      async call(method, params) {
        const terminal = await core.call(method, params)
        return method === 'terminal.get' && terminal && lastGrid
          ? { ...terminal, cols: lastGrid.cols, rows: lastGrid.rows } : terminal
      },
      close() {},
    }))
    return samePane(pane, current)
  }
  const stop = (reason) => {
    if (closed) return false
    closed = true
    clearTimeout(resyncTimer)
    end(reason)
    if (watching) {
      try { core.detach(watching.channel) } catch { /* the connection is going */ }
    }
    try { core?.close() } catch { /* the connection is going */ }
    return true
  }

  function scheduleResync() {
    if (closed || resyncing || resyncAt === null) return
    clearTimeout(resyncTimer)
    resyncTimer = setTimeout(resync, Math.max(0, resyncAt - Date.now()))
    resyncTimer.unref?.()
  }

  function watch(attachment) {
    core.watch(attachment.channel, {
      onData: (bytes) => {
        if (closed || watching !== attachment) return
        if (!stillOwned()) { stop('no-pane'); return }
        push('data', bytes, bytes.length, attachment)
      },
      onClose: (reason) => { if (watching === attachment) stop(reason || 'ended') },
      onResize: () => {
        if (closed || watching !== attachment) return
        resyncAt = Date.now() + RESYNC_DELAY_MS
        scheduleResync()
      },
    })
  }

  async function resync() {
    resyncing = true
    resyncAt = null
    try {
      if (!await stillBound(grid)) { stop('no-pane'); return }
      if (closed) return
      const previous = watching
      watching = null
      core.detach(previous.channel)
      const next = await attach(grid)
      if (closed) return
      if (!confirmAttached(core, pane, next)) { stop('no-pane'); return }
      watching = next
      const size = validGrid(next.terminal) ? next.terminal : await core.call('terminal.get', { terminal: pane.terminal })
      if (closed) return
      if (!validGrid(size)) { stop('resize'); return }
      grid = { cols: size.cols, rows: size.rows }
      reset(grid)
      watch(next)
    } catch {
      stop('resize')
    } finally {
      resyncing = false
      scheduleResync()
    }
  }

  return {
    async open() {
      pane = await resolve(connect)
      if (closed) return
      if (!pane) { stop('no-pane'); return 'no-pane' }
      try {
        const connection = await connect({ env })
        if (closed) { connection.close(); return }
        core = connection
      } catch {
        stop('no-core')
        return 'no-core'
      }
      if (!await stillBound()) { stop('no-pane'); return 'no-pane' }
      if (closed) return
      try {
        const attached = await attach(pane)
        if (closed) return
        if (!confirmAttached(core, pane, attached)) { stop('no-pane'); return 'no-pane' }
        watching = attached
        if (!stillOwned()) { stop('no-pane'); return 'no-pane' }
      } catch (error) {
        if (closed) return
        warn(`the Code pane could not attach ${pane.terminal}: ${error?.kind ?? error?.message ?? error}`)
        stop('attach-refused')
        return 'attach-refused'
      }
      grid = validGrid(watching.terminal) ? watching.terminal : pane
      const initialGrid = validGrid(grid) ? { cols: grid.cols, rows: grid.rows } : {}
      push('pane', { bot: pane.botId, terminal: pane.terminal, ...initialGrid, name: pane.name })
    },
    start() { if (!closed) watch(watching) },
    stop,
    credit({ bytes, attachment }) {
      if (closed || !bytes || attachment !== watching) return
      try { core.credit(watching.channel, bytes) } catch { /* the connection is going */ }
    },
  }
}

const OPEN_STATUS = { 'no-pane': 404, 'attach-refused': 409, 'no-core': 503 }

/** Serve the legacy single-pane form with untagged events and HTTP refusals. */
export function openPaneStream({ url, ...options }) {
  const target = streamTarget(url)
  return target.error ? Promise.resolve(jsonError(404, target.error)) : openStream([target], options)
}

/** Serve one stream for a view, with a pane index on every event. */
function openPanesStream(targets, options) {
  return openStream(targets, options)
}

async function openStream(targets, {
  signal, env = process.env, warn = () => {}, connect = connectCore, readFile,
  onPaneEnd = () => {}, onClosing = () => {}, onEnd = () => {}, onStop = () => {},
}) {
  const multi = targets.length > 1
  const encoder = new TextEncoder()
  let remaining = targets.length
  let controller = null
  let stopped = false
  let idle
  let heartbeat
  let queued = 0
  let queue = []
  let waiter
  const wake = () => { const next = waiter; waiter = null; next?.() }
  const encode = ({ p, event, data }) => {
    const payload = event === 'data' ? data.toString('base64') : data
    if (!multi) return encoder.encode(sse(event, event === 'data' ? payload : JSON.stringify(payload)))
    const tagged = event === 'data' ? { p, d: payload } : { p, ...payload }
    return encoder.encode(sse(event, JSON.stringify(tagged)))
  }

  const observe = targets.map((target, p) => paneObserver(target, {
    env, warn, connect, readFile,
    push: (event, data, bytes, attachment) => push({ p, event, data, bytes, attachment }),
    reset: (data) => {
      // Replace only this pane's unseen reset and paint. All other panes keep their order.
      let superseded = false
      queue = queue.filter(item => {
        if (item.p !== p) return true
        if (item.event === 'reset') superseded = true
        else if (!superseded || item.event !== 'data') return true
        queued -= item.bytes
        return false
      })
      push({ p, event: 'reset', data })
    },
    end: (reason) => {
      remaining -= 1
      onPaneEnd(p)
      if (stopped) return
      if (multi || reason === 'resize') push({ p, event: 'close', data: { reason } })
      else stop(reason)
    },
  }))

  function push({ bytes = 0, ...item }) {
    if (stopped) return
    if (queued + bytes > MAX_QUEUED_BYTES) { stop('slow'); return }
    // A frame can be a slice of a larger core buffer. Retain only its counted bytes.
    if (item.event === 'data') item.data = Buffer.from(item.data)
    queue.push({ ...item, bytes })
    queued += bytes
    if (bytes) touch()
    wake()
  }

  // A response-wide stop cuts the queue immediately, as on the single-pane route.
  function stop(reason) {
    if (stopped) return
    stopped = true
    clearTimeout(idle)
    clearInterval(heartbeat)
    signal?.removeEventListener('abort', onCancel)
    onClosing()
    const pendingCloses = queue.filter(item => item.event === 'close')
    for (const [p, pane] of observe.entries()) {
      const endedNow = pane.stop(reason)
      if (!controller || !reason || reason === 'closed') continue
      const close = !multi || endedNow
        ? { p, event: 'close', data: { reason } }
        : pendingCloses.find(item => item.p === p)
      if (close) {
        try { controller.enqueue(encode(close)) } catch { /* already cut */ }
      }
    }
    queue = []
    queued = 0
    if (controller) {
      try { controller.close() } catch { /* already cut */ }
      controller = null
    }
    onEnd()
    wake()
  }
  const onCancel = () => stop('closed')
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => stop('idle'), STREAM_IDLE_MS)
    idle.unref?.()
  }

  onStop(() => stop('stopped'))
  signal?.addEventListener('abort', onCancel, { once: true })
  if (signal?.aborted) { onCancel(); return new Response(null, { status: 204 }) }

  const open = async (pane) => {
    try {
      const refusal = await pane.open()
      if (multi && !refusal) pane.start()
      return refusal
    } catch (error) {
      pane.stop('no-core')
      warn(`the Code pane failed: ${error?.message ?? error}`)
      return multi ? 'no-core' : 'unavailable'
    }
  }
  if (multi) {
    for (const pane of observe) void open(pane)
  } else {
    const refusal = await open(observe[0])
    if (refusal) return jsonError(OPEN_STATUS[refusal] ?? 503, refusal)
    if (stopped) return new Response(null, { status: 204 })
  }

  const body = new ReadableStream({
    start(c) {
      controller = c
      if (!multi) c.enqueue(encode(queue.shift()))
    },
    async pull(c) {
      while (queue.length === 0 && remaining > 0 && !stopped) {
        await new Promise(resolve => { waiter = resolve })
      }
      if (queue.length === 0) { stop(); return }
      const next = queue.shift()
      queued -= next.bytes
      touch()
      try { c.enqueue(encode(next)) } catch { onCancel(); return }
      observe[next.p].credit(next)
      if (queue.length === 0 && remaining === 0) stop()
    },
    cancel: onCancel,
  })
  touch()
  heartbeat = setInterval(() => {
    if (!controller || queue.length > 0 || remaining === 0) return
    try { controller.enqueue(encoder.encode(': keep-alive\n\n')) } catch { onCancel() }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  if (!multi) observe[0].start()
  return new Response(body, { status: 200, headers: { ...noStore, 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' } })
}

/**
 * Install the Code side on a running team: the tree endpoint and the pane stream route.
 * @param {any} rt the team runtime
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectCore, readFile?: typeof readFileSync, desktop?: boolean }} [options]
 */
export function install(rt, { env = process.env, connect = connectCore, readFile, desktop = appBrowserBridge() } = {}) {
  const warn = (...args) => rt.warn?.(`omni-ui: ${args.map(value => (typeof value === 'string' ? value : String(value))).join(' ')}`)
  const offTree = windowEndpoint(rt, CODE_TREE_ENDPOINT, async (_body, _signal, windowSeen = false) => {
    // RFC 0030 delivery 1 keeps standalone hosts from serving terminals (lines 129–130, 439–440).
    if (!desktop || !fromWindow(windowSeen)) return { v: 1, machine: null, projects: [], reason: 'desktop-only' }
    const answer = await readCodeTree({ env, warn, connect, readFile })
    if (answer.tree) return answer.tree
    return { v: 1, machine: null, projects: [], reason: answer.reason ?? 'unavailable' }
  }, { read: true })
  if (!desktop) return offTree
  const reservations = new Map()
  const viewers = new Map()
  const live = new Set()
  let disposed = false
  const closeAll = () => {
    for (const close of [...live]) { try { close() } catch { /* going */ } }
    live.clear()
    void typing.dispose()
  }
  // A host without a browser carrier (a test's bare context, a headless run) has no route
  // registry: the tree still answers, and the pane simply has nowhere to stream to.
  const fetchRoutes = rt.ctx?.connection?.fetch
  if (typeof fetchRoutes?.register !== 'function') return offTree
  // Typing: its own exact routes, owner-only and re-admitted per batch (code-typing.js).
  const typing = createTypingService({
    env, connect, readFile, warn,
    recordPath: typingRecordPath(rt.home ?? process.cwd()),
    admit: request => rt.ctx.connection.admit(request),
  })
  const offEffects = [rt.ctx.effect(() => () => { void typing.dispose() }, 'omni-ui: code typing releases')]
  for (const [path, handler] of typingRoutes(typing, request => verifiedWindow(request, env))) {
    const off = rt.ctx.effect(() => fetchRoutes.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => handler(request),
    }), `omni-ui: code typing ${path}`)
    offEffects.push(off)
  }
  const offStream = rt.ctx.effect(() => fetchRoutes.register({
    path: CODE_STREAM_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (!verifiedWindow(request, env)) return jsonError(403, 'desktop-only')
      const refusal = streamAdmission(request)
      if (refusal) return jsonError(refusal.status, refusal.error)
      const multi = new URL(request.url).searchParams.getAll('bot').length > 1
      const parsed = multi ? streamTargets(request.url) : streamTarget(request.url)
      if (parsed.error) return jsonError(404, parsed.error)
      const targets = multi ? parsed : [parsed]
      const panes = targets.map(target => ({ tag: paneTag(target), viewer: target.viewer, signal: request.signal }))
      const deadline = Date.now() + REOPEN_WAIT_MS
      const isClosing = pane => pane.signal.aborted || pane.closing

      // Check all tags before the attach budget. Reserve them as a group before any core work.
      for (;;) {
        if (disposed || request.signal.aborted) return new Response(null, { status: 204 })
        const overlaps = panes.map(pane => reservations.get(pane.tag)).filter(Boolean)
        const busy = reservations.size + panes.length > MAX_STREAMS
        if (!overlaps.length && !busy) break
        const delay = Math.min(REOPEN_POLL_MS, deadline - Date.now())
        const active = [...reservations.values()].filter(pane => !isClosing(pane)).length
        if (delay <= 0 || !overlaps.every(isClosing) || active + panes.length > MAX_STREAMS) {
          return overlaps.length ? jsonError(409, 'already-open') : jsonError(429, 'busy')
        }
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      for (const pane of panes) {
        reservations.set(pane.tag, pane)
        if (pane.viewer) viewers.set(pane.viewer, pane)
      }
      const release = (p) => {
        const pane = panes[p]
        if (reservations.get(pane.tag) !== pane) return
        reservations.delete(pane.tag)
        // A viewer can survive a view change. Only its current stream may release typing.
        if (pane.viewer && viewers.get(pane.viewer) === pane) {
          viewers.delete(pane.viewer)
          void typing.releaseViewer(pane.viewer)
        }
      }
      let stop
      const options = {
        signal: request.signal, env, warn, connect, readFile,
        onPaneEnd: release,
        onClosing: () => {
          for (const pane of panes) pane.closing = true
          panes.forEach((_, p) => release(p))
        },
        onEnd: () => live.delete(stop),
        onStop: (close) => {
          stop = close
          live.add(stop)
        },
      }
      try {
        return await (multi ? openPanesStream(targets, options) : openPaneStream({ ...options, url: request.url }))
      } catch (error) {
        stop?.()
        panes.forEach((_, p) => release(p))
        warn(`the Code pane failed: ${error?.message ?? error}`)
        return jsonError(503, 'unavailable')
      }
    },
  }), 'omni-ui: code pane stream')
  offEffects.push(offStream)
  // The only scope ends of a browser stream are the plugin and its Connection: close every
  // stream (and typing attach) when either goes. A stopped Connection has no `fetch` service
  // to hear from, so this watches for it while a stream is live.
  const scopeWatch = setInterval(() => {
    if (live.size === 0) return
    if (typeof rt.ctx.get === 'function' && rt.ctx.get('connection') === undefined) closeAll()
  }, 250)
  scopeWatch.unref?.()
  return () => {
    disposed = true
    offTree()
    for (const off of offEffects.splice(0).reverse()) off?.()
    clearInterval(scopeWatch)
    closeAll()
  }
}
