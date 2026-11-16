// Typing into a watched pane (RFC 0030 delivery 2's first half): the owner takes a pane, types
// into it from the app, and gives it back. The watch route stays a watcher; typing is its own
// exact route, opened on a click and closed on Escape, on leaving the pane, on another Bot or
// on an ended session.
//
// Rules this file keeps:
//   - owner only: every request re-admits through DSH's Connection. DSH's own /api layer
//     refuses a signed-out or expired cookie (401) before this route runs, so the attach must
//     also be let go on its own: an idle lease (60 s by default, injectable) ends a session
//     with no accepted batch, and the watch stream ending lets that viewer's attach go. A
//     signed-out page cannot keep typing open by going quiet;
//   - nothing typed before typing is confirmed is sent: after the lease, the waking key or
//     paste only takes the pane again, and the pane says typing paused / typing is back so the
//     owner types again (a lost first batch is never replayed);
//   - the same pane resolution as the watch route: a Bot id (and its own folded worker
//     terminal), confirmed by this computer's core, never a terminal id from the request;
//   - one typing viewer per pane: a second window is refused and sees view only;
//   - keystrokes are never written anywhere: no log, store or event carries `data`; the
//     record on disk says only who took the pane, when, and for which Bot or worker;
//   - no start, stop, resize or kill: the attach is opened at the terminal's own size and the
//     only frames this module sends are DATA frames (keys) and one CLOSE when it lets go.
import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isBotId } from '../shared/registry.js'
import { connectCore, KINDS } from './code-core.js'
import { resolvePane } from './code-tree.js'

export const CODE_TAKE_ROUTE = '/api/omni-ui/code/take'
export const CODE_INPUT_ROUTE = '/api/omni-ui/code/input'
export const CODE_RELEASE_ROUTE = '/api/omni-ui/code/release'
/** The record's name in the team's home: which Bot or worker was taken, by whom, when. */
export const TYPING_FILE = 'code-typing.jsonl'
export const TYPING_MODE = 0o600
/** One keystroke batch's cap; anything bigger is refused, never truncated. */
export const MAX_INPUT_BYTES = 16 * 1024
/** How many panes one host lets be typed into at once (one per window, a few windows). */
export const MAX_SESSIONS = 4
const VIEWER = /^[A-Za-z0-9._:-]{8,128}$/
const WORKER_QUERY = /^[A-Za-z0-9._-]{1,64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

const ok = (body = {}) => ({ status: 200, body })
const refuse = (status, error) => ({ status, body: { error } })

/** One typing session as this host holds it (its bytes are never kept). */
function sessionOf({ viewer, pane, core, channel }) {
  return { id: randomUUID(), viewer, pane, core, channel, at: new Date().toISOString(), closed: false }
}

/**
 * The typing service one Bot-team host owns. Pure enough to test without an HTTP server:
 * each method takes a Request-shaped `{ headers }` and answers `{ status, body }`.
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectCore, readFile?: Function,
 *   admit?: (request: any) => { rejection?: number }, recordPath?: string, warn?: Function }} options
 */
export function createTypingService({ env = process.env, connect = connectCore, readFile, admit, recordPath, warn = () => {}, idleMs = 60_000 } = {}) {
  const byPane = new Map()
  // Claimed before any wait: two windows racing for one pane must not both get in. The
  // reservation is per Bot and worker (the pane those name), held until the take answers.
  const pending = new Set()
  const byId = new Map()
  const byViewer = new Map()
  let recordQueue = Promise.resolve()

  /** One append per record, owner-only file, no keystrokes in any row. */
  const record = (row) => {
    if (!recordPath) return Promise.resolve()
    recordQueue = recordQueue.then(async () => {
      try {
        await mkdir(dirname(recordPath), { recursive: true })
        const handle = await open(recordPath, 'a', TYPING_MODE)
        try { await handle.write(`${JSON.stringify({ v: 1, ...row })}\n`) } finally { await handle.close() }
      } catch (error) {
        warn(`the typing record could not be written: ${error?.code ?? error?.message ?? error}`)
      }
    })
    return recordQueue
  }

  const close = async (session, reason) => {
    if (!session || session.closed) return
    session.closed = true
    clearTimeout(session.idle)
    byPane.delete(session.pane.key)
    byId.delete(session.id)
    if (byViewer.get(session.viewer) === session) byViewer.delete(session.viewer)
    try { session.core.detach(session.channel) } catch { /* going */ }
    try { session.core.close() } catch { /* going */ }
    await record({ event: 'release', session: session.id, bot: session.pane.botId, worker: session.pane.worker, terminal: session.pane.terminal, at: new Date().toISOString(), reason })
  }

  // The attach is let go on its own: a session with no accepted batch for one idle span ends,
  // so a page whose cookie died (DSH answers 401 before the route) cannot keep typing open.
  const armLease = (session) => {
    clearTimeout(session.idle)
    session.idle = setTimeout(() => { void close(session, 'idle') }, Math.max(1, idleMs))
    session.idle.unref?.()
  }

  const admitted = (request) => {
    if (typeof admit !== 'function') return true
    try { return admit(request)?.rejection === undefined } catch { return false }
  }

  return {
    /** One pane's or one window's current session, for tests and the host's own bookkeeping. */
    sessions: () => [...byId.values()].map(session => ({ id: session.id, viewer: session.viewer, bot: session.pane.botId, worker: session.pane.worker, terminal: session.pane.terminal })),

    /**
     * Take a pane for typing. A window that already holds a pane lets it go first (typing follows
     * the Bot the person picked); a pane another window holds stays with that window.
     */
    async take({ request, bot, worker = null, viewer } = {}) {
      if (!admitted(request)) return refuse(401, 'unauthorized')
      if (!isBotId(bot)) return refuse(404, 'no-bot')
      if (worker !== null && worker !== undefined && !WORKER_QUERY.test(worker)) return refuse(404, 'no-worker')
      if (!VIEWER.test(String(viewer ?? ''))) return refuse(400, 'no-viewer')
      if (byId.size >= MAX_SESSIONS) return refuse(429, 'busy')
      const held = byViewer.get(viewer)
      if (held) await close(held, 'moved')
      const key = `${bot}\0${worker ?? ''}`
      if (byPane.has(key)) return refuse(409, 'typing-elsewhere')
      if (pending.has(key)) return refuse(409, 'typing-elsewhere')
      pending.add(key)
      try {
        const pane = await resolvePane({ botId: bot, worker: worker ?? null, env, connect, readFile, warn })
        if (!pane) return refuse(404, 'no-pane')
        let core
        try {
          core = await connect({ env })
        } catch {
          return refuse(503, 'no-core')
        }
        let attached
        try {
          // Not a watcher: this viewer may type. The size is the terminal's own, and no RESIZE
          // frame is ever sent: the app does not resize a terminal.
          attached = await core.attach({ terminal: pane.terminal, cols: pane.cols, rows: pane.rows, history: 0, observe: false })
        } catch (error) {
          core.close()
          warn(`the typing attach was refused: ${error?.kind ?? error?.message ?? error}`)
          return refuse(409, 'attach-refused')
        }
          const session = sessionOf({ viewer, pane: { ...pane, key, worker: worker ?? null }, core, channel: attached.channel })
        // The attach's own output is drained and credited so the core keeps the stream healthy;
        // its bytes are thrown away here (the watch pane already draws them) and never logged. The
        // first paint marks the stream ready, so a batch sent right after taking is not dropped.
        let ready
        const painted = new Promise((resolve) => { ready = resolve })
        core.watch(attached.channel, {
          onData: bytes => {
            ready()
            try { core.credit(attached.channel, bytes.length) } catch { /* going */ }
          },
          onClose: reason => { ready(); void close(session, reason || 'ended') },
        })
        await Promise.race([painted, new Promise(resolve => { const timer = setTimeout(resolve, 500); timer.unref?.() })])
        byPane.set(key, session)
        byId.set(session.id, session)
        byViewer.set(viewer, session)
        armLease(session)
        await record({ event: 'take', session: session.id, bot, worker: worker ?? null, terminal: pane.terminal, core: pane.core, at: session.at })
        return ok({ session: session.id, mode: 'typing', bot, worker: worker ?? null, terminal: pane.terminal })
      } finally {
        pending.delete(key)
      }
    },

    /** One keystroke batch, base64. Re-admitted every time: a dropped session refuses at once.
     * Typing ends after 60 s with no accepted batch (the idle lease) or when the window closes;
     * the pane takes it again in place with the next click or key. */
    async input({ request, session, data } = {}) {
      if (!admitted(request)) {
        const held = byId.get(String(session ?? ''))
        if (held) await close(held, 'session-ended')
        return refuse(401, 'unauthorized')
      }
      const held = byId.get(String(session ?? ''))
      if (!held) return refuse(409, 'not-typing')
      if (typeof data !== 'string' || data === '' || !BASE64.test(data)) return refuse(400, 'no-data')
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) return refuse(413, 'too-big')
      try {
        held.core.writeFrame(held.channel, KINDS.data, bytes)
      } catch {
        await close(held, 'ended')
        return refuse(409, 'not-typing')
      }
      armLease(held)
      // Deliberately no record and no log here: keystrokes never leave this call.
      return { status: 204, body: null }
    },

    /** The watch stream for a viewer ended (its page went, or a refused batch closed it): that
     * viewer's typing attach goes with it, so a signed-out session leaves nothing behind. */
    async releaseViewer(viewer) {
      const held = byViewer.get(String(viewer ?? ''))
      if (!held) return { released: false }
      await close(held, 'viewer-gone')
      return { released: true }
    },

    /** Let the pane go (Escape, leaving it, another Bot, a closed window). */
    async release({ request, session } = {}) {
      if (!admitted(request)) return refuse(401, 'unauthorized')
      const held = byId.get(String(session ?? ''))
      if (!held) return { status: 204, body: null }
      await close(held, 'released')
      return ok({ released: true })
    },

    /** The host's own way out: every session let go, nothing else touched. */
    async dispose() {
      for (const session of [...byId.values()]) await close(session, 'host-stopped')
      await recordQueue
    },
  }
}

/** The JSON body of one route request, or a refusal: buffered, capped, never stored. */
export async function routeBody(request, { max = MAX_INPUT_BYTES + 4 * 1024 } = {}) {
  const type = request.headers?.get?.('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (type !== 'application/json') return { error: refuse(415, 'not-json') }
  let text
  try { text = await request.text() } catch { return { error: refuse(400, 'no-body') } }
  if (typeof text !== 'string' || text.length > max) return { error: refuse(413, 'too-big') }
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' ? { body } : { error: refuse(400, 'no-body') }
  } catch { return { error: refuse(400, 'no-body') } }
}

/** The routes the service serves, as [path, handler] for one exact Fetch route each. */
export function typingRoutes(service) {
  const json = (answer) => answer.body === null
    ? new Response(null, { status: answer.status, headers: { 'cache-control': 'no-store' } })
    : Response.json(answer.body, { status: answer.status, headers: { 'cache-control': 'no-store' } })
  const route = (handle) => async (request) => {
    const parsed = await routeBody(request)
    if (parsed.error) return json(parsed.error)
    return json(await handle(request, parsed.body))
  }
  return [
    [CODE_TAKE_ROUTE, route((request, body) => service.take({ request, bot: body.bot, worker: body.worker ?? null, viewer: body.viewer }))],
    [CODE_INPUT_ROUTE, route((request, body) => service.input({ request, session: body.session, data: body.data }))],
    [CODE_RELEASE_ROUTE, route((request, body) => service.release({ request, session: body.session }))],
  ]
}

/** The record's path in the team's home (the same home the ledgers live beside). */
export const typingRecordPath = (home) => join(home, TYPING_FILE)
