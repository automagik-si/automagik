// One agent process over ACP (Agent Client Protocol): spawned once per DSH Session, one ACP
// session inside it, prompted once per DSH turn. What the agent streams lands in a queue the
// adapter drains step by step; its tool calls are kept by id so the mirror tool (tool.js) can
// wait on each one and answer its permission request through DSH.
import { execFile, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
// The `/unstable` entry: stable ACP v1 plus `session/fork` (how acp-codex's tool set follows a
// preset change) and the session updates newer adapters send (a stable-only parser refuses an
// update it does not know, and the whole notification with it).
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { batchSafe } from './batch-spawn.js'
import { HOME_ENV, releaseRun, trackRun } from './cli-homes.js'
import { BRIDGE_NAME, isBridgeName } from './names.js'
import { processBirth } from './process-identity.js'
import { descendants, signalTree, snapshotBudget, supportsTree, treeStates }
  from './process-tree.js'
import { usageLimitOf } from './usage-limit.js'
import { sonnetWire } from './model-identity.js'
import { observeTerminal } from './terminal-evidence.js'

const STDERR_KEEP = 4000
// How long a closed connection waits for the agent's exit, which says why (start()).
const EXIT_GRACE_MS = 500
const TERMINAL = new Set(['completed', 'failed'])
const isToolId = id => typeof id === 'string' && id !== ''
// Keep recent call identities without retaining every turn's payloads for the session.
export const RETIRED_MAX = 1024
// SDK 2.x refuses an incoming message over 32 MiB by default and closes the connection on it.
// An image call carries its picture twice (content and rawOutput), base64: one a little over the
// 12 MiB this plugin keeps (image.js) would end the turn as a dead agent instead of the "too
// large" answer. The cap stays, four times wider.
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024

/**
 * The structured tool name a call carries, when the adapter sends one: Claude Code puts it at
 * the update's root and in `_meta.claudeCode.toolName` (the spike's wire). codex-acp sends none
 * for an MCP call, so matching there stays unsupported until a name is proven.
 */
export function structuredNameOf(update) {
  if (typeof update?.name === 'string' && update.name !== '') return update.name
  const meta = update?._meta?.claudeCode
  if (typeof meta?.toolName === 'string' && meta.toolName !== '') return meta.toolName
  return undefined
}

/**
 * The Agent/Task call a call ran inside, when the agent says so: Claude Code's adapter stamps
 * every call a native subagent makes, and its result, with `_meta.claudeCode.parentToolUseId`,
 * the subagent's own Agent/Task call id. Undefined for a call the main agent made.
 */
export function parentToolOf(update) {
  const parent = update?._meta?.claudeCode?.parentToolUseId
  return isToolId(parent) ? parent : undefined
}

// Claude Code's subagent tool: `Agent`, `Task` on older CLIs (the adapter's agent reporter).
export const WORKER_TOOLS = new Set(['Agent', 'Task'])
export const WORKERS_MAX = 12
export const WORKER_STEPS_MAX = 40
const WORKER_TEXT_MAX = 160
// A call DSH closed itself (`ended`: endPrompt, when the turn was stopped or the agent went
// away) did not finish, whatever status it was closed with: it failed, it was never done.
const workerStatus = tool => (tool.ended === true ? 'failed' : tool.status === 'completed' ? 'done' : tool.status === 'failed' ? 'failed' : 'running')
const shortLine = text => String(text ?? '').slice(0, 4096).split('\n').map(line => line.trim()).find(Boolean)?.slice(0, WORKER_TEXT_MAX) ?? ''
// The ending a worker reports: its stripped report, else the raw result less the adapter's
// `<usage>` block and `agentId:` line, which only the raw text still carries for this client.
// One DSH stopped reports only that (`Stopped`, with `stopped`): what it had said is partial.
const workerResult = (tool) => {
  if (tool.ended === true) return 'Stopped'
  if (workerStatus(tool) === 'running') return ''
  const text = contentText(tool.content) || (typeof tool.rawOutput === 'string' ? tool.rawOutput : '')
  return shortLine(text.replace(/<usage>[\s\S]*?<\/usage>/g, '').replace(/^agentId:.*$/gm, ''))
}

/**
 * The native subagents of one prompt, as workers: each Agent/Task call in `ids` (the prompt's
 * calls, in the order they came) with its title, its state, the line its result opens with and
 * the calls stamped with its id as its steps. Newest workers last; bounded, never the payloads.
 * One DSH closed when its turn ended (`ended`) is failed, `stopped`, and its result `Stopped`.
 * @param {Map<string, any>} tools
 * @param {Iterable<string>} ids
 */
export function workersOf(tools, ids) {
  const calls = [...ids].map(id => tools.get(id)).filter(tool => tool !== undefined && tool.retired !== true)
  const workers = calls.filter(tool => WORKER_TOOLS.has(tool.structuredName)).slice(-WORKERS_MAX)
  return workers.map((worker) => {
    const steps = calls.filter(tool => tool.parent === worker.id)
    const shown = steps.slice(-WORKER_STEPS_MAX)
    const result = workerResult(worker)
    return {
      id: worker.id,
      title: shortLine(worker.title) || worker.structuredName,
      state: workerStatus(worker),
      ...(result ? { result } : {}),
      ...(worker.ended === true ? { stopped: true } : {}),
      ...(worker.seenAt === undefined ? {} : { at: worker.seenAt }),
      steps: shown.map(step => ({
        id: step.id,
        title: shortLine(step.title) || step.structuredName || 'Tool',
        ...(step.structuredName === undefined ? {} : { tool: String(step.structuredName).slice(0, 80) }),
        state: workerStatus(step),
      })),
      ...(steps.length > shown.length ? { more: steps.length - shown.length } : {}),
    }
  })
}

// The text of ACP content: a content block, or a tool call's content items.
export function contentText(content) {
  if (content == null) return ''
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n')
  if (content.type === 'content') return contentText(content.content)
  if (content.type === 'text') return content.text ?? ''
  if (content.type === 'resource_link') return content.uri ?? ''
  if (content.type === 'resource') return content.resource?.text ?? content.resource?.uri ?? ''
  return ''
}

// The image blocks of ACP content: a content block, or a tool call's content items. An image is
// `{ type: 'image', data, mimeType }`, inside a `content` wrapper or not. The block is returned
// as the agent sent it, so its base64 data is never decoded and encoded again; a durable DSH
// image block (`attachment`) is returned too, for a tool result that already carries one.
export function contentImages(content) {
  if (content == null) return []
  if (Array.isArray(content)) return content.flatMap(contentImages)
  if (content.type === 'content') return contentImages(content.content)
  return content.type === 'image' ? [content] : []
}

// Saved image paths still scrub later replies; the image bytes and other output can go.
function retiredTool(tool) {
  const record = { id: tool.id, retired: true, unanswerable: true }
  for (const key of ['title', 'kind', 'status', 'structuredName', 'mcp', 'bridge', 'drift', 'refused', 'mirrored']) {
    if (tool[key] !== undefined) record[key] = tool[key]
  }
  record.listeners = new Set()
  record.content = []
  for (const item of Array.isArray(tool.content) ? tool.content : []) {
    const block = item?.type === 'content' ? item.content : item
    if (block?.type !== 'image' || typeof block.uri !== 'string') continue
    const image = { type: 'image', uri: block.uri }
    record.content.push(item.type === 'content' ? { type: 'content', content: image } : image)
  }
  for (const key of ['savedPath', 'saved_path']) {
    if (typeof tool.rawOutput?.[key] === 'string') {
      record.rawOutput ??= {}
      record.rawOutput[key] = tool.rawOutput[key]
    }
  }
  return record
}

// How long the agent has to answer. A CLI that waits on a first-run question, a keychain dialog
// or an update starts and then never answers, and the chat must not wait with it: the whole
// start (initialize, session/new, the bridge's first list) has START_MS, and every request sent
// after it and before a prompt (a model, an effort, a mode, a fork, a close) has REQUEST_MS.
export const START_MS = 60_000
export const REQUEST_MS = 15_000
// How long the agent's processes have to end once asked to (SIGTERM) before they are killed.
export const KILL_AFTER_MS = 3000
const UNANSWERED = 'acp_unanswered'
// The answer to a permission question that is withdrawn, or that nobody is left to answer.
const CANCELLED = Object.freeze({ outcome: Object.freeze({ outcome: 'cancelled' }) })
const STOPPED = 'acp_stopped'

/** A wait as the person reads it: whole seconds (under one second, as a test sets it, in ms). */
export const waited = ms => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`)
/** The agent did not answer a request before its deadline (`error.ms`). */
export const isUnanswered = error => error?.code === UNANSWERED
/** The turn's Stop ended the wait for a request. */
export const isStopped = error => error?.code === STOPPED

function unanswered(what, ms) {
  const error = new Error(`it did not answer${what ? ` while ${what}` : ''} (${waited(ms)})`)
  return Object.assign(error, { code: UNANSWERED, ms })
}

function stopped(what) {
  const error = new Error(`it was stopped${what ? ` while ${what}` : ''}`)
  return Object.assign(error, { code: STOPPED })
}

export class AgentRun {
  /**
   * @param {{ command: string, args?: string[], env?: Record<string, string>, cwd: string,
   *   name: string, provider?: string, onIgnored?: (message: string) => void, onRejected?: (what: string) => void,
   *   onWarn?: (message: string) => void, refuseTools?: boolean, onForbiddenTool?: (tool: any) => void,
   *   startMs?: number, requestMs?: number, authenticate?: string, logout?: boolean,
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout } }} spec
   *   startMs, requestMs: the deadlines, START_MS and REQUEST_MS unless a test sets shorter ones.
   *   authenticate: a sign-in run, the id of the ACP auth method to ask for instead of a session.
   *   logout: a sign-out run, ACP `logout` when the agent offers it, instead of a session.
   *   timers: the clock the deadlines run on, for a test that moves it by hand.
   */
  constructor(spec) {
    this.spec = spec
    this.startMs = spec.startMs ?? START_MS
    this.requestMs = spec.requestMs ?? REQUEST_MS
    this.timers = spec.timers ?? globalThis
    this.queue = []
    this.waiters = []
    this.tools = new Map()
    // Told of each question stored for a call (onPermission): a mirror body that waits on
    // another call hears of it (tool.js, native-tools mode: a subagent's nested calls).
    this.askListeners = new Set()
    this.turn = new Set()
    this.retired = new Set()
    this.didIgnore = false
    this.stderr = ''
    this.prompting = undefined
    this.exited = undefined
    // Whether this prompt was cancelled by the app (a Stop, a reap, an ended session), so a
    // cancel the app did not ask for is told apart: it comes from the host stopping.
    this.cancelled = false
  }

  /**
   * Spawn the agent and open its session. It ends early, with the process disposed, when the
   * agent exits, when `signal` aborts (the person's Stop) or after `startMs` with no session.
   * @param {{ signal?: AbortSignal }} [options]
   */
  async start({ signal } = {}) {
    trackRun(this)
    const { command, args = [], env, cwd, mcpServers = [], sessionMeta } = this.spec
    // Its own process group, where the platform has them: what the agent starts (the CLI behind
    // an adapter, the command behind a tool call) is ended with it, as one group (`endTree`).
    // Through batchSafe: a native agent's CLI can be a Windows batch file (hermes.cmd), which
    // Node refuses to spawn without a shell.
    const child = spawn(...batchSafe(command, args, {
      cwd, env: env?.[HOME_ENV] ? env : { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32',
    }))
    this.child = child
    this.grouped = process.platform !== 'win32'
    if (supportsTree(process.platform)) this.birth = processBirth(child.pid)
    // An idle agent never keeps DSH running: only a prompt in flight holds the event loop.
    child.unref()
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.unref?.()
    this.holdOn()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP)
      // A sign-in run reads what the agent prints there (a sign-in link, index.js signInNative).
      try { this.spec.onStderr?.(chunk) } catch {}
    })
    const gone = new Promise((_, fail) => {
      child.once('error', error => fail(error))
      child.once('exit', (code, signal) => {
        this.exited = { code, signal }
        // Whatever it left running goes too, however it ended: nothing reports to it any more.
        this.endTree()
        const error = new Error(`${this.spec.name} exited (${signal ?? code})${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)
        // Keep the import origin for repair detection without changing the displayed tail.
        const missing = /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Cannot find package/.exec(this.stderr)
        if (missing !== null) error.missingModule = this.stderr.slice(missing.index, missing.index + 2000)
        fail(error)
      })
    })
    gone.catch(() => {})
    this.gone = gone
    child.stdin.on('error', () => {})
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: MAX_MESSAGE_BYTES })
    this.conn = connect(this, stream)
    const ready = (async () => {
      this.init = await this.conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      // The agent answers the version it will speak: the one asked for, or its own latest when
      // it does not support that one. Going on over another version would read its messages
      // with the wrong shapes, so the session stops here with what to do about it.
      const answered = this.init?.protocolVersion
      if (answered !== PROTOCOL_VERSION) {
        const error = new Error(answered > PROTOCOL_VERSION
          ? `its connector speaks a newer ACP protocol (version ${answered}) than this app (version ${PROTOCOL_VERSION}): update Automagik`
          : `its connector speaks ACP protocol version ${answered ?? 'unknown'}, and this app speaks version ${PROTOCOL_VERSION}: update the connector`)
        error.code = 'acp_protocol_mismatch'
        throw error
      }
      // A sign-in run (`authenticate`, a method id the agent offers) or a sign-out run
      // (`logout`) opens no session: it asks that one thing of the agent and ends.
      if (this.spec.authenticate !== undefined) {
        const offered = Array.isArray(this.init?.authMethods) ? this.init.authMethods : []
        if (!offered.some(method => method?.id === this.spec.authenticate)) {
          throw Object.assign(new Error(`${this.spec.name} did not offer that sign-in`), { code: 'acp-sign-in/unsupported' })
        }
        // The sign-in run's own clock starts here (index.js signInNative, the 15 s rule).
        try { this.spec.onAuthenticate?.() } catch {}
        await this.conn.authenticate({ methodId: this.spec.authenticate })
        this.authenticated = true
        return
      }
      if (this.spec.logout === true) {
        // Only an agent that says it can sign out over ACP is asked to.
        if (this.init?.agentCapabilities?.auth?.logout) {
          await this.conn.logout({})
          this.loggedOut = true
        }
        return
      }
      const identity = this.spec.botIdentity?.()
      this.spec.botIdentity = undefined
      this.identityDelivery = identity
        ? this.init.agentCapabilities?.sessionCapabilities?.systemPrompt != null
          ? 'systemPrompt' : 'preamble'
        : 'none'
      if (this.identityDelivery === 'systemPrompt') {
        this.systemPrompt = { mode: 'append', content: [{ type: 'text', text: identity }] }
      } else if (this.identityDelivery === 'preamble') {
        this.identityPreamble = identity
      }
      this.spec.onIdentity?.(this.identityDelivery)
      const session = await this.conn.newSession({
        cwd,
        mcpServers,
        ...(sessionMeta === undefined ? {} : { _meta: sessionMeta }),
        ...(this.systemPrompt === undefined ? {} : { systemPrompt: this.systemPrompt }),
      })
      this.sessionId = session.sessionId
      this.modes = session.modes
      this.takeOptions(session.configOptions ?? [], session.models)
      // The model the agent started on: DSH's `default` model goes back to it.
      this.startModel = optionOf(this.options, 'model')?.currentValue
      // The session exists (the spike's ordering rule for the bridge's first announcement) and
      // a bridge that never listed its tools fails the turn here, before the prompt.
      await this.spec.onReady?.(this)
    })()
    ready.catch(() => {})
    try {
      await this.held(() => ready, { ms: this.startMs, signal, what: 'starting' })
    } catch (error) {
      // The request nobody answered, for the log: the person is told only that it did not start.
      if (isUnanswered(error)) error.step = this.init === undefined ? 'initialize' : this.sessionId === undefined ? 'session/new' : 'its DSH tools'
      // An agent that dies at its start closes its output a moment before its exit is
      // reported, and the closed connection says nothing of why. Its exit does (the code and
      // what it wrote), so that is the failure when it follows at once. A deadline or a Stop
      // is its own reason and waits for nothing.
      let reason = error
      if (!isUnanswered(error) && !isStopped(error) && this.exited === undefined && (child.stdout.readableEnded || child.stdout.destroyed)) {
        let timer
        const exit = await Promise.race([gone.catch(left => left), new Promise((resolve) => { timer = setTimeout(resolve, EXIT_GRACE_MS) })])
        clearTimeout(timer)
        if (exit !== undefined) reason = exit
      }
      this.dispose()
      throw reason
    } finally {
      this.letGo()
    }
    return this
  }

  /**
   * Replace this ACP session with a fork that carries the same conversation and the new server
   * set, then close the source session: `acp-codex` ignores `tools/list_changed` and a new server
   * list on resume, so this is how its tool set follows a preset or level change. Both bridges
   * are the plugin's to end; the source's credential is revoked by the caller. Each request
   * has its deadline, and a close nobody answers is left like one that fails. The turn's Stop
   * comes from the caller, which holds the whole fork (`held` with the signal and no deadline).
   * @param {{ cwd: string, mcpServers: any[] }} options
   * @returns {Promise<string>} the forked session id
   */
  async fork({ cwd, mcpServers }) {
    if (typeof this.conn.forkSession !== 'function') throw new Error('it cannot fork its session')
    const source = this.sessionId
    const answer = await this.held(() => this.conn.forkSession({
      sessionId: source, cwd, mcpServers,
      ...(this.systemPrompt === undefined ? {} : { systemPrompt: this.systemPrompt }),
    }))
    this.sessionId = answer.sessionId
    this.modelProof = undefined
    this.reportedModel = undefined
    if (answer.modes !== undefined && answer.modes !== null) this.modes = answer.modes
    if (Array.isArray(answer.configOptions) || answer.models) {
      this.takeOptions(answer.configOptions ?? [], answer.models, modelStateOf(this.options))
    }
    for (const tool of this.tools.values()) tool.permission?.answer(CANCELLED)
    this.tools.clear()
    this.turn.clear()
    this.retired.clear()
    // The fork's source is closed by us: the spike did not show the fork closing it, and a
    // Session must never hold two bridges.
    try {
      if (typeof this.conn.closeSession === 'function') {
        await this.held(() => this.conn.closeSession({ sessionId: source }))
      }
    } catch {
      // A source session that will not close still ends with this process, which is disposed
      // with the fork's Session.
    }
    await this.spec.onReady?.(this)
    return this.sessionId
  }

  // Each request the agent has yet to answer holds the event loop; the last answer lets it go.
  holdOn() {
    this.holds = (this.holds ?? 0) + 1
    this.hold ??= setInterval(() => {}, 1 << 30)
  }
  letGo(all = false) {
    this.holds = all ? 0 : Math.max(0, (this.holds ?? 0) - 1)
    if (this.holds > 0) return
    clearInterval(this.hold)
    this.hold = undefined
  }
  /**
   * One request to the agent, or a few of them as one piece of work. It is never waited for
   * longer than the agent's process lives (`gone`), than the turn it is for (`signal`, the
   * person's Stop) or than its deadline (`ms`, REQUEST_MS unless said; 0 for work whose own
   * requests each have one). The wait that ends first is the error: `isUnanswered`, `isStopped`
   * or the exit. A request cannot be taken back and the agent may still act on it, so a caller
   * that gets one of the first two ends the run (`dispose`) rather than ask it anything else.
   * @param {() => Promise<any>} work
   * @param {{ ms?: number, signal?: AbortSignal, what?: string }} [options]
   */
  async held(work, { ms = this.requestMs, signal, what } = {}) {
    this.holdOn()
    let timer
    let onAbort
    try {
      if (signal?.aborted) throw stopped(what)
      const waits = [work()]
      if (this.gone !== undefined) waits.push(this.gone)
      if (ms > 0) {
        waits.push(new Promise((_, fail) => {
          // The hold above keeps the event loop for it; a run disposed meanwhile does not.
          timer = this.timers.setTimeout(() => fail(unanswered(what, ms)), ms)
          timer.unref?.()
        }))
      }
      if (signal !== undefined) {
        waits.push(new Promise((_, fail) => {
          onAbort = () => fail(stopped(what))
          signal.addEventListener('abort', onAbort, { once: true })
        }))
      }
      return await Promise.race(waits)
    } finally {
      this.timers.clearTimeout(timer)
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      this.letGo()
    }
  }

  // A disposed run is over at once, though its process may take a moment to exit.
  get alive() { return this.child !== undefined && this.exited === undefined && this.disposed !== true }
  get busy() { return this.prompting !== undefined }

  push(event) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(event)
    else this.queue.push(event)
  }

  /** The next event the agent sent: text, thought, tool (first sight of a call), end, error. */
  next(signal) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter(waiter => waiter !== take)
        resolve({ type: 'aborted' })
      }
      const take = (event) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(event)
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(take)
    })
  }

  prompt(prompt) {
    if (this.busy) throw new Error(`${this.spec.name} is still answering`)
    this.queue = []
    this.reviews = { denied: 0, inRow: 0, last: undefined, after: false }
    this.promptEnded = false
    this.forbiddenToolSeen = false
    this.cancelled = false
    // The calls of the prompts before this one are over for DSH too: their cards ran in turns
    // that have ended, and a call already known never gets a second card. A question for one
    // has nobody left to answer it (onPermission); one still stored is withdrawn here.
    for (const id of this.turn) {
      const tool = this.tools.get(id)
      if (tool === undefined) continue
      tool.unanswerable = true
      tool.permission?.answer(CANCELLED)
      // A mirror body may still hold the old object while it saves its result.
      this.tools.set(id, retiredTool(tool))
      this.retired.add(id)
    }
    this.turn = new Set()
    // An update for a call more than 1024 calls old is treated as new; no session restart.
    while (this.retired.size > RETIRED_MAX) {
      const id = this.retired.values().next().value
      this.retired.delete(id)
      this.tools.delete(id)
    }
    this.holdOn()
    const carried = this.identityPreamble !== undefined
    if (carried) {
      prompt = [{ type: 'text', text: this.identityPreamble }, ...prompt]
      this.identityPreamble = undefined
    }
    const run = this.conn.prompt({ sessionId: this.sessionId, prompt })
    this.prompting = Promise.race([run, this.gone]).then(
      result => {
        if (carried) {
          this.preambleOutcome = result?.stopReason !== 'cancelled' && !this.cancelled
            ? 'delivered' : 'unsure'
        }
        return this.endPrompt({ type: 'end', stopReason: result?.stopReason ?? 'end_turn' })
      },
      error => {
        if (carried) this.preambleOutcome = 'unsure'
        return this.endPrompt({
          type: 'error', message: error?.message ?? String(error),
          ...(error?.code === undefined ? {} : { code: error.code }),
          ...(this.exited === undefined && usageLimitOf(this.spec.provider, error)
            ? { usageLimit: true } : {}),
        })
      },
    )
    return this.prompting
  }

  endPrompt(event) {
    this.prompting = undefined
    // From here to the next prompt, a call seen for the first time gets no card (seeTool).
    this.promptEnded = true
    this.letGo()
    // A call the agent never closed is over with its turn; a question it never got an answer to is withdrawn.
    for (const id of this.turn) {
      const tool = this.tools.get(id)
      if (tool === undefined) continue
      tool.permission?.answer({ outcome: { outcome: 'cancelled' } })
      if (!TERMINAL.has(tool.status)) this.changeTool(tool, { status: tool.status === 'pending' ? 'failed' : 'completed', ended: true })
    }
    this.push(event)
  }

  /**
   * Switch the agent's own permission mode to the first of `modeIds` it offers (most wanted
   * first, the strict one last). One it lacks falls back to the next; when it offers none of
   * them, not even the strict one, the turn fails rather than run in whatever mode the agent
   * started in (the person's own default, which may let calls through unasked).
   * @param {string | string[] | undefined} modeIds
   * @param {{ signal?: AbortSignal }} [options] the turn's Stop
   */
  async setMode(modeIds, { signal, force = false } = {}) {
    if (modeIds === undefined) return
    const wanted = [modeIds].flat()
    const offered = new Set((this.modes?.availableModes ?? []).map(mode => mode.id))
    const modeId = wanted.find(id => offered.has(id))
    try { this.spec.onMode?.({ wanted, offered: [...offered], chosen: modeId }) } catch {}
    if (modeId === undefined) throw new Error(`it offers none of the modes ${wanted.join(', ')} (it offers ${[...offered].join(', ') || 'no modes'})`)
    if (!force && this.modes?.currentModeId === modeId) return
    await this.held(() => this.conn.setSessionMode({ sessionId: this.sessionId, modeId }), { signal, what: 'taking its permission mode' })
    this.modes = { ...this.modes, currentModeId: modeId }
  }

  takeOptions(options, models, fallback) {
    const reported = optionOf(withModels(options, models), 'model')
    // The legacy session model list can be separate from an effort option update.
    if (reported || models !== undefined || !fallback || this.reportedModel?.id !== MODEL_STATE) this.reportedModel = reported
    this.options = withModels(options, models ?? fallback)
    if (this.modelProof && !this.confirmsModel(this.modelProof)) this.modelProof = undefined
  }

  confirmsModel({ wire, sonnetPin }) {
    const confirms = option => option?.currentValue === wire && (sonnetPin
      ? sonnetWire(valuesOf(option)) === wire
      : valuesOf(option).filter(choice => choice.value === wire).length === 1)
    return confirms(this.reportedModel) && confirms(this.option('model'))
  }

  bindModel(model, wire, sonnetPin) {
    const proof = { session: this.sessionId, model, wire, sonnetPin }
    if (wire !== undefined && this.confirmsModel(proof)) this.modelProof = proof
  }

  acknowledgedModel() {
    const proof = this.modelProof
    if (proof && proof.session === this.sessionId && this.confirmsModel(proof)) return proof.model
  }

  /** The agent's own option of `category` (`model`, `thought_level`), as it last said. */
  option(category) {
    return optionOf(this.options, category)
  }

  /**
   * Set the agent's option of `category` to `value`, one of the values it offers. One it does
   * not offer fails, naming those it does: the turn then fails rather than run on another model
   * or effort than the person chose.
   * @param {string} category
   * @param {string} value
   * @param {{ signal?: AbortSignal, requireReported?: boolean }} [options]
   */
  async setOption(category, value, { signal, requireReported = false } = {}) {
    const option = this.option(category)
    if (option === undefined) throw new Error(`it has no ${category} setting`)
    const values = valuesOf(option)
    if (!values.some(choice => choice.value === value)) throw new Error(`it offers no ${category} ${value} (it offers ${values.map(choice => choice.value).join(', ') || 'none'})`)
    if (option.currentValue === value && (!requireReported || this.reportedModel?.currentValue === value)) return
    if (category === 'model') {
      this.reportedModel = undefined
      this.modelProof = undefined
    }
    if (option.id === MODEL_STATE) {
      // The session's own model list (`session/set_model`), for an agent with no model option.
      const params = { sessionId: this.sessionId, modelId: value }
      let answer
      try {
        answer = await this.held(() => this.conn.setSessionModel(params), { signal, what: `taking its ${category}` })
      } catch (error) {
        // A request nobody answered, or one the turn's Stop ended, goes up as it is: the turn
        // ends the session on it (adapter.js `abandoned`), which a wrapped error would hide.
        if (isUnanswered(error) || isStopped(error)) throw error
        // An agent can list a model it then cannot resolve (seen with Hermes: "Internal error",
        // the reason only in the error's data). Say which model and, when it is a plain word, why.
        const details = typeof error?.data?.details === 'string' && /^[\w .:-]{1,80}$/.test(error.data.details) ? ` (${error.data.details})` : ''
        throw new Error(`it could not switch to ${value}: ${error?.message ?? error}${details}`, { cause: error })
      }
      if (Array.isArray(answer?.configOptions) || answer?.models) {
        this.takeOptions(answer.configOptions ?? [], answer.models, modelStateOf(this.options))
      } else if (!this.reportedModel) {
        this.options = this.options.map(other => (other.id === MODEL_STATE ? { ...other, currentValue: value } : other))
      }
      return
    }
    const answer = await this.held(() => this.conn.setSessionConfigOption({ sessionId: this.sessionId, configId: option.id, value }), { signal, what: `taking its ${category}` })
    // The answer is the whole set: a new model may bring other efforts.
    if (Array.isArray(answer?.configOptions) || answer?.models) {
      this.takeOptions(answer.configOptions ?? [], answer.models, modelStateOf(this.options))
    } else if (category !== 'model' || !this.reportedModel) {
      this.options = this.options.map(other => (other.id === option.id ? { ...other, currentValue: value } : other))
    }
  }

  async cancel() {
    if (!this.busy || this.sessionId === undefined) return
    this.cancelled = true
    await this.held(() => this.conn.cancel({ sessionId: this.sessionId })).catch(() => {})
  }

  dispose() {
    if (this.disposed === true) return
    this.disposed = true
    const child = this.child
    const deps = snapshotBudget(this.treeDeps)
    if (this.grouped && supportsTree(deps.platform ?? process.platform)
      && child?.exitCode === null && child?.signalCode === null) {
      if (!this.birth) this.birth = processBirth(child.pid, deps)
      const snapshot = descendants(child.pid, this.birth, deps)
      this.detached = snapshot.records.filter(record => record.pgid !== child.pid)
      if (!snapshot.complete) {
        try {
          this.spec.onWarn?.('Could not read the whole Bot process tree; '
            + 'stopping known tools and checking the agent group for the rest.')
        } catch {}
      }
    }
    this.letGo(true)
    for (const tool of this.tools.values()) tool.permission?.answer({ outcome: { outcome: 'cancelled' } })
    try { this.child?.stdin.end() } catch {}
    if (child && child.exitCode === null && child.signalCode === null) this.endTree()
    void releaseRun(this)
  }

  // Account changes wait for the group and the detached tools in the snapshot. Sending
  // SIGTERM alone is not proof that the old account stopped doing work.
  async stop() {
    this.dispose()
    const child = this.child
    if (!Number.isInteger(child?.pid) || child.pid <= 1) return
    const now = this.treeDeps?.now ?? Date.now
    const until = now() + 5000
    while (true) {
      let running = child.exitCode === null && child.signalCode === null
      if (this.grouped) {
        try { process.kill(-child.pid, 0); running = true } catch (error) {
          // Only ESRCH proves the group gone. EPERM means a member we may not signal (on macOS,
          // a zombie not yet reaped), so the wait goes on within the deadline.
          if (error.code === 'ESRCH') running = false
          else if (error.code === 'EPERM') running = true
          else throw new Error('The Bot process could not be stopped.')
        }
      }
      const states = this.grouped ? await treeStates(this.detached ?? [], this.treeDeps) : []
      const detachedGone = states.every(state => state === 'dead')
      if (!running && detachedGone) return
      if (now() >= until) throw new Error('The Bot process has not stopped. Try again.')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  /**
   * End the agent and everything it started. A session that is over must leave nothing
   * running: an agent that ignored a cancel is usually stuck in a tool command, and that
   * command is its child or its child's child, which a signal to the agent alone would leave
   * working in the person's folder beside the next session. The whole process group is asked
   * to end, and what is left of it after KILL_AFTER_MS is killed; the agent's own exit does not
   * end that wait while any of the group is alive. Windows has no groups: the process tree is
   * killed there, at once. Detached tools found before disposal get the same signals, with
   * their births checked again. Tools reparented before that snapshot, including those left
   * by an agent that exits by itself, are not found. Birth checks cannot make a numeric kill
   * atomic against pid reuse; macOS births have only whole seconds.
   */
  endTree() {
    if (this.ending === true) return
    this.ending = true
    const child = this.child
    const running = child?.exitCode === null && child?.signalCode === null
    // No process id (it never started), or one that must never be negated into a group.
    if (!Number.isInteger(child?.pid) || child.pid <= 1) {
      try { child?.kill?.('SIGTERM') } catch {}
      return
    }
    if (!this.grouped) {
      // taskkill walks the tree from the agent by parent id, so it runs only while the agent
      // is still there: Windows gives an ended process's id to the next one.
      if (!running) return
      try {
        execFile('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true }, (error) => {
          if (error) try { child.kill('SIGKILL') } catch {}
        }).unref?.()
      } catch {
        try { child.kill('SIGKILL') } catch {}
      }
      return
    }
    // False once nobody is left in the group (the signal finds no process).
    const signal = (name) => {
      try {
        process.kill(-child.pid, name)
        return true
      } catch (error) {
        // EPERM means the group is still there; keep the SIGKILL timer.
        return error?.code === 'EPERM'
      }
    }
    if (!signal('SIGTERM')) {
      // No group to signal while the agent runs: it is ended alone rather than not at all.
      if (running) try { child.kill('SIGTERM') } catch {}
    } else {
      const timer = this.timers.setTimeout(() => signal('SIGKILL'), KILL_AFTER_MS)
      timer.unref?.()
      // Nothing left in the group: its id is free again.
      const settled = () => { if (!signal(0)) this.timers.clearTimeout(timer) }
      if (running) child.once('exit', settled)
    }
    // Each detached pass checks births asynchronously on macOS, with its own timeout.
    if (this.detached?.length) {
      const deps = { ...this.treeDeps, agentPgid: child.pid }
      const detachedTimer = this.timers.setTimeout(() => {
        void signalTree(this.detached, 'SIGKILL', deps)
      }, KILL_AFTER_MS)
      detachedTimer.unref?.()
      void signalTree(this.detached, 'SIGTERM', deps)
    }
  }

  // --- the agent's side of the conversation ---------------------------------------------

  /**
   * The native subagents this prompt started, as workers (workersOf): what the Bot team draws
   * under the Bot's row. The prompt's calls only, so a finished worker stays until the next
   * prompt. Read-only.
   */
  workers() {
    return workersOf(this.tools, this.turn)
  }

  ignored(what, payload) {
    // Rejected traffic still needs safety checks, without retaining it or making a card.
    try {
      if (payload !== undefined && this.tools.get(payload?.toolCallId)?.retired !== true) {
        this.markCall({ title: payload?.title ?? 'Tool', listeners: new Set() }, payload)
      }
    } catch {}
    try { this.spec.onRejected?.(what) } catch {}
    if (this.didIgnore) return
    this.didIgnore = true
    try { this.spec.onIgnored?.(`${this.spec.name} sent ${what} with no usable call id or for another session; such updates are ignored`) } catch {}
  }

  acceptsPermission(params) {
    if (!isToolId(params?.toolCall?.toolCallId)
      || (params.sessionId !== undefined && this.sessionId !== undefined && params.sessionId !== this.sessionId)) {
      this.ignored('a permission request', params?.toolCall)
      return false
    }
    return true
  }

  async onUpdate(update, sessionId) {
    const isTool = update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update'
    if (sessionId !== undefined && this.sessionId !== undefined && sessionId !== this.sessionId) {
      this.ignored('an update', isTool ? update : undefined)
      return
    }
    if (isTool) {
      if (!isToolId(update.toolCallId)) {
        this.ignored('a tool update', update)
        return
      }
      if (this.tools.get(update.toolCallId)?.retired === true) return
    }
    const observedAt = isTool ? performance.now() : undefined
    switch (update?.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content)
        if (text && this.reviews?.last) this.reviews.after = true
        if (text) this.push({ type: 'text', text })
        break
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content)
        if (text && this.reviews?.last) this.reviews.after = true
        if (text) this.push({ type: 'thought', text })
        break
      }
      case 'tool_call':
        this.seeTool(update, observedAt)
        break
      case 'tool_call_update': {
        const tool = this.tools.get(update.toolCallId) ?? this.seeTool(update, observedAt)
        if (tool !== undefined) this.changeTool(tool, update)
        break
      }
      case 'config_option_update':
        if (typeof sessionId === 'string' && sessionId === this.sessionId && (Array.isArray(update.configOptions) || update.models)) {
          this.takeOptions(update.configOptions ?? [], update.models, modelStateOf(this.options))
        }
        break
      case 'current_mode_update':
        if (this.modes) this.modes = { ...this.modes, currentModeId: update.currentModeId }
        break
      default:
        break
    }
    if (isTool && isToolId(sessionId) && sessionId === this.sessionId) {
      const tool = this.tools.get(update.toolCallId)
      if (tool !== undefined) observeTerminal(tool, update, sessionId, observedAt)
    }
  }

  seeTool(update, observedAt = performance.now()) {
    if (!isToolId(update?.toolCallId)) {
      this.ignored('a tool update', update)
      return undefined
    }
    const known = this.tools.get(update.toolCallId)
    if (known) {
      if (known.retired !== true) this.changeTool(known, update)
      return known
    }
    if (this.spec.refuseTools === true) {
      if (!this.forbiddenToolSeen) {
        this.forbiddenToolSeen = true
        this.spec.onForbiddenTool?.(update)
      }
      return undefined
    }
    if (this.reviews?.last) this.reviews.after = true
    const tool = { id: update.toolCallId, title: update.title ?? 'Tool', kind: update.kind ?? 'other', status: update.status ?? 'pending', content: update.content ?? [], locations: update.locations ?? [], rawInput: update.rawInput, rawOutput: update.rawOutput, listeners: new Set(), seenAt: Date.now(), observedAt }
    // A native subagent's call keeps the Agent/Task call it ran inside (workers()).
    const parent = parentToolOf(update)
    if (parent !== undefined && parent !== tool.id) tool.parent = parent
    // First seen after its prompt ended: its event lands behind the prompt's end, where no step
    // reads it, and the next prompt drops it. No card will ever ask its question.
    if (this.promptEnded === true) tool.unanswerable = true
    this.markCall(tool, update)
    // Drift known at first sight, before its event is queued: the adapter reads the same mark
    // when it takes the event and makes no card for it. Drift found later is marked there
    // if the event is still queued; an existing card keeps its question for its body to ask.
    if (tool.drift === true) tool.unanswerable = true
    // Codex with its own tools off offers none, so a call that is not the bridge's (or one of
    // Codex's two MCP list readers) means the check missed one: it gets no card and no answer
    // but a refusal, and the adapter ends the session (codex-native.js).
    if (this.spec.nativeOff === true && !allowedOff(tool)) {
      tool.refused = 'rejected'
      tool.unanswerable = true
      try { this.spec.onNativeOffCall?.(tool) } catch {}
    }
    this.tools.set(tool.id, tool)
    this.turn.add(tool.id)
    this.push({ type: 'tool', id: tool.id })
    return tool
  }

  /** What an update says the call is: its structured name, whether it is MCP, the bridge's. */
  markCall(tool, update) {
    const name = structuredNameOf(update)
    if (name !== undefined) tool.structuredName = name
    if (typeof update?.rawInput?.server === 'string') tool.mcpServer = update.rawInput.server
    if (update?._meta?.is_mcp_tool_call === true) tool.mcp = true
    if (tool.structuredName !== undefined && tool.structuredName.startsWith('mcp__')) tool.mcp = true
    if (isBridgeName(tool.structuredName)) tool.bridge = true
    if (tool.noted !== true && (tool.structuredName !== undefined || tool.mcp === true)) {
      tool.noted = true
      try {
        this.spec.onToolCall?.(tool)
      } catch {
        // Drift handling is the plugin's, not the run's: a throw must not stop the agent's call.
      }
    }
  }

  changeTool(tool, update) {
    // A command's output, for a client with no terminal of its own (Zed's terminal_output
    // extension, which codex-acp sends): kept as the call's output.
    const chunk = update._meta?.terminal_output?.data
    if (typeof chunk === 'string') tool.output = (tool.output ?? '') + chunk
    for (const key of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput', 'ended']) {
      if (update[key] !== undefined && update[key] !== null) tool[key] = update[key]
    }
    // The link can come on a later update only (a streamed refinement or the result).
    const parent = parentToolOf(update)
    if (parent !== undefined && parent !== tool.id) {
      if (typeof tool.parent === 'string' && tool.parent !== parent) tool.parentConflict = true
      tool.parent = parent
    }
    const status = tool.rawOutput?.review?.status
    if (this.reviews && tool.id.startsWith('guardian_assessment:') && typeof status === 'string' && !tool.reviewed) {
      tool.reviewed = true
      if (status === 'denied') { this.reviews.denied++; this.reviews.inRow++ }
      if (status === 'approved') this.reviews.inRow = 0
      this.reviews.last = status
      this.reviews.after = false
    }
    this.markCall(tool, update)
    for (const listener of tool.listeners) listener()
  }

  /**
   * DSH refused or cancelled the mirror call of the agent's tool `id` before its body ran, so
   * nothing there will answer the agent's question for it: answer it here, with the agent's own
   * reject option, or as cancelled when the call was stopped. A question that comes later gets
   * the same answer (onPermission). It only ever refuses.
   * @param {string} id
   * @param {boolean} cancelled
   */
  refuse(id, cancelled) {
    const tool = this.tools.get(id)
    if (tool === undefined) return
    tool.refused = cancelled ? 'cancelled' : 'rejected'
    const permission = tool.permission
    permission?.answer(refusal(tool.refused, permission.options))
  }

  /**
   * A skipped fork MCP call has no mirror to answer its question. An unanswerable question is
   * cancelled first. The bridge server's call gets `allow_once` when offered and is cancelled
   * otherwise. Answering `allow_always` would let the agent record a standing rule nobody
   * approved (RFC 0039). The bridge's own `approval/request` is the person's dialog. Other
   * servers get the agent's reject option, or are cancelled when none is offered.
   */
  answerSkippedMcp(tool, options) {
    if (this.spec.dshTools !== true || this.spec.refresh !== 'fork' || tool.mcp !== true) return undefined
    const answerFor = (choices) => {
      if (tool.unanswerable === true) return CANCELLED
      if (tool.mcpServer !== BRIDGE_NAME) return refusal('rejected', choices)
      const once = choices.find(option => option.kind === 'allow_once')
      return once === undefined ? CANCELLED : { outcome: { outcome: 'selected', optionId: once.optionId } }
    }
    // A question already stored is answered from its own options, a new one (`options`) from its own.
    const stored = tool.permission
    if (stored !== undefined) stored.answer(answerFor(stored.options ?? []))
    const answer = answerFor(options ?? stored?.options ?? [])
    // Refused with no dialog: the log says so, once per question answered.
    if (tool.unanswerable !== true && tool.mcpServer !== BRIDGE_NAME && (stored !== undefined || options !== undefined)) {
      try { this.spec.onRefusedMcp?.(tool) } catch {}
    }
    return answer
  }

  /**
   * @param {any} params the agent's `session/request_permission`
   * @param {AbortSignal} [signal] aborts when the agent withdraws the request (`$/cancel_request`)
   */
  onPermission(params, signal) {
    if (!this.acceptsPermission(params)) return Promise.resolve(CANCELLED)
    if (this.spec.refuseTools === true) return Promise.resolve(refusal('rejected', params.options ?? []))
    const known = this.tools.get(params.toolCall?.toolCallId)
    const tool = known ?? this.seeTool({ status: 'pending', ...params.toolCall })
    if (tool === undefined) return Promise.resolve(CANCELLED)
    // The question's own title ("Run command?") names the question, not the call the card shows.
    const { title, ...details } = params.toolCall ?? {}
    if (tool.retired !== true) {
      this.changeTool(tool, { ...details, status: undefined })
      try { this.spec.onAsked?.(tool) } catch {}
    }
    // The queued tool event is read after this synchronous handler: mark standalone approvals
    // before the adapter can turn one into a mirror card.
    if (params._meta?.is_mcp_tool_approval === true) {
      tool.mcp = true
      if (typeof params.toolCall?.rawInput?.serverName === 'string') tool.mcpServer = params.toolCall.rawInput.serverName
    }
    // The bridge's call is not the mirror's: acp-dsh answers this ACP request itself with
    // `allow-once` or cancels a question that offers no `allow_once`: never `allow_always`,
    // which would let the agent record a standing rule nobody approved (RFC 0039). The ACP
    // request raises no DSH dialog. The bridge's own `approval/request` is the one dialog the
    // person sees (RFC 0003, amendment, "One dialog per call").
    if (this.spec.dshTools === true && tool.bridge === true) {
      const once = (params.options ?? []).find(option => option.kind === 'allow_once')
      return Promise.resolve(once === undefined ? CANCELLED : { outcome: { outcome: 'selected', optionId: once.optionId } })
    }
    const skipped = this.answerSkippedMcp(tool, params.options ?? [])
    if (skipped !== undefined) return Promise.resolve(skipped)
    // Codex with its own tools off: a question for any call but the bridge's is refused at once.
    if (this.spec.nativeOff === true && !allowedOff(tool)) return Promise.resolve(refusal('rejected', params.options ?? []))
    // DSH already refused this call before the mirror's body could ask (refuse): no body is
    // left to answer the agent, so the refusal is its answer.
    if (tool.refused !== undefined) return Promise.resolve(refusal(tool.refused, params.options ?? []))
    // A question nobody will answer is answered here, at once, and only ever as cancelled: the
    // agent would otherwise wait on it until the next turn's end. That is a call that gets no
    // card (first seen after its prompt ended, left from an earlier prompt, or drift known at
    // first sight or when the adapter skips its event) and one whose card's body is over
    // (tool.js). Any other question waits for its card, including drift found after its card.
    if (tool.unanswerable === true || tool.mirrored === true) return Promise.resolve(CANCELLED)
    // A second question for the call while the first was not asked yet: the first is withdrawn,
    // or nothing would ever answer it. One already in its dialog keeps the dialog's answer.
    const earlier = tool.permission
    earlier?.invalidate?.()
    if (earlier !== undefined && earlier.asked !== true) earlier.answer({ outcome: { outcome: 'cancelled' } })
    return new Promise((resolve) => {
      let done = false
      const lifetime = new AbortController()
      const permission = {
        signal: lifetime.signal,
        invalidate: () => lifetime.abort(),
        options: params.options ?? [],
        // codex-acp renders execute/pending on the question only before the command starts (dist/index.js:35333).
        startsCommand: params.toolCall?.kind === 'execute' && params.toolCall?.status === 'pending',
        answer: (response) => {
          if (done) return
          done = true
          lifetime.abort()
          if (tool.permission === permission) tool.permission = undefined
          resolve(response)
          for (const listener of tool.listeners) listener()
        },
      }
      permission.title = title
      // A later call update must not change what an answer to this question allows
      // (tool.js reviewHolds). A failed copy leaves this question to be asked as before.
      try {
        const { id, title, kind, rawInput, content, locations, structuredName, parent } = tool
        permission.call = structuredClone({ id, title, kind, rawInput, content, locations, structuredName, parent })
      } catch {}
      tool.permission = permission
      // The agent took its question back (it cancelled the request, or the connection closed):
      // nothing waits for an answer any more, so the dialog must not stay up for it.
      const withdraw = () => permission.answer({ outcome: { outcome: 'cancelled' } })
      if (signal?.aborted) return withdraw()
      signal?.addEventListener('abort', withdraw, { once: true })
      for (const listener of tool.listeners) listener()
      for (const listener of this.askListeners) listener(tool)
    })
  }
}

/**
 * This plugin's side of one ACP connection (SDK 2.x: an app with typed handlers, and the peer
 * context for what it asks the agent). The returned object keeps one named method per request
 * the plugin makes, so a caller never spells a wire method name.
 * @param {AgentRun} run
 * @param {import('@agentclientprotocol/sdk/unstable').Stream} stream
 */
function connect(run, stream) {
  const connection = client({ name: 'automagik-acp-dsh' })
    .onNotification(methods.client.session.update, ({ params }) => run.onUpdate(params.update, params.sessionId))
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) => run.onPermission(params, signal))
    .connect(stream)
  const agent = connection.agent
  const { session } = methods.agent
  return {
    connection,
    initialize: params => agent.request(methods.agent.initialize, params),
    authenticate: params => agent.request(methods.agent.authenticate, params),
    logout: params => agent.request(methods.agent.logout, params),
    newSession: params => agent.request(session.new, params),
    forkSession: params => agent.request(session.fork, params),
    closeSession: params => agent.request(session.close, params),
    setSessionMode: params => agent.request(session.setMode, params),
    setSessionConfigOption: params => agent.request(session.setConfigOption, params),
    // The SDK names no method for a session's own model list (Hermes): sent by its wire name.
    setSessionModel: params => agent.request('session/set_model', params),
    prompt: params => agent.request(session.prompt, params),
    cancel: params => agent.notify(session.cancel, params),
  }
}

// The calls Codex with its own tools off may make: the bridge's tools, and Codex's own two MCP
// list readers. Identity comes from markCall (the server and the MCP mark), never the kind.
const OFF_READERS = new Set(['list_mcp_resources', 'list_mcp_resource_templates'])
function allowedOff(tool) {
  if (tool?.mcp !== true) return false
  if (tool.mcpServer === BRIDGE_NAME) return true
  return tool.mcpServer === 'codex' && OFF_READERS.has(tool.rawInput?.tool)
}

// A refusal as the agent's own reject option; a stopped call, or an agent that offers no reject
// option, is answered as cancelled.
function refusal(kind, options) {
  const chosen = kind === 'rejected'
    ? options.find(option => option.kind === 'reject_once') ?? options.find(option => option.kind === 'reject_always')
    : undefined
  return chosen ? { outcome: { outcome: 'selected', optionId: chosen.optionId } } : { outcome: { outcome: 'cancelled' } }
}

// The id of the model option made from a session's own model list (`models` in the answer to
// `session/new`: `availableModels` and `currentModelId`, switched with `session/set_model`).
// Hermes offers its models only there. No agent's own option can carry this id by accident.
export const MODEL_STATE = '\u0000session-models'

/**
 * An agent's config options, with its session model list as the `model` option when it offers
 * no model option of its own (an agent that offers both, as Antigravity does, keeps its own).
 */
export function withModels(options, models) {
  if (optionOf(options, 'model') !== undefined) return options
  const offered = (Array.isArray(models?.availableModels) ? models.availableModels : []).filter(model => typeof model?.modelId === 'string' && model.modelId !== '')
  if (offered.length === 0) return options
  return [...options, {
    id: MODEL_STATE,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: typeof models.currentModelId === 'string' ? models.currentModelId : undefined,
    options: offered.map(model => ({ value: model.modelId, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.modelId, ...(typeof model.description === 'string' && model.description !== '' ? { description: model.description } : {}) })),
  }]
}

// The session model list an option set was made from, to carry it over an answer that names
// only the agent's own options.
const modelStateOf = (options) => {
  const made = (options ?? []).find(option => option?.id === MODEL_STATE)
  return made === undefined ? undefined : { currentModelId: made.currentValue, availableModels: made.options.map(({ value, name, description }) => ({ modelId: value, name, description })) }
}

/** The option of `category` among an agent's session config options. */
export const optionOf = (options, category) => (options ?? []).find(option => option?.category === category && option.type === 'select')

/** The values a select option offers, its groups flattened. */
export const valuesOf = option => (option?.options ?? []).flatMap(entry => (Array.isArray(entry?.options) ? entry.options : [entry])).filter(entry => typeof entry?.value === 'string')

export const isTerminal = tool => TERMINAL.has(tool.status) || tool.ended === true
