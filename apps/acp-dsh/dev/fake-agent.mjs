#!/usr/bin/env node
// "reviewer denies N" emits reviews; "then text" continues afterward. FAKE_ACP_REVIEW_STOP overrides cancelled.
// "ask edited" changes input at the ask. FAKE_ACP_ALWAYS_ONLY=1 offers only lasting allows.
// The new-session trace includes session/new _meta as meta when present.
// A fake ACP agent for tests. Each prompt: two text chunks, one shell-like tool call that asks
// permission first, then a line saying whether it ran. A prompt that says "twice" makes two
// calls; one that says "hang" waits until it is cancelled; one that says "bridge <tool>" calls
// that tool on the `dsh` MCP server it was given and reports what it answered. "bridge-respawn
// <tool>" restarts that server first, and "bridge-drop" closes it. One that says
// "drift" announces a built-in tool call (a call `tools: []` should have removed) and waits;
// one that says "image-call" makes an image the way Codex's image tool reports it.
//
// It connects every `mcpServers` entry of `session/new` itself, as both real adapters do, so the
// plugin's bridge is exercised over real stdio. With FAKE_ACP_SKIP_MCP=1 it connects none, as
// codex-acp does when the person's own Codex config already defines that server name.
// FAKE_ACP_OMP_DISCOVER=1 opens a separate discover probe before the real MCP attachment.
// "history-lookup omp <query>" reads the Bot's chat as omp, with no ACP permission request.
//
// FAKE_ACP_DEAF_TO lists ACP methods (comma separated, as on the wire: `initialize`,
// `session/new`, `session/set_config_option`, `session/set_mode`, `session/fork`,
// `session/close`, `session/cancel`) it never hears: a request among them is never answered, as
// a CLI waiting on a first-run question, a keychain dialog or an update leaves it, and with
// `session/cancel` among them a prompt that waits to be cancelled ("hang", "drift") never ends.
//
// Like Claude Code's and Codex's adapters it offers its models and each model's efforts as
// session config options (categories `model` and `thought_level`, the effort list rebuilt per
// model), and each turn's thoughts start with the model and effort it runs on. With
// FAKE_ACP_NO_OPTIONS=1 in its environment it offers none, as an older agent would. Its effort
// list starts with a "default" row, as Claude Code's does; FAKE_ACP_NO_DEFAULT_EFFORT=1 leaves it
// out, as Codex's does. FAKE_ACP_AUTH=session (or prompt) refuses `session/new` (or every
// prompt) with ACP's auth_required, as an adapter whose CLI is signed out does.
// FAKE_ACP_EXTRA_EFFORT adds an effort only to fake-small.
//
// As a native agent's CLI (a command started with `acp`, #959): FAKE_ACP_SESSION_MODELS=1 offers
// its models only as the session's own list (`models` in the `session/new` answer, switched
// with `session/set_model`) and no config options, as Hermes does. The trace's `start` entry
// keeps the arguments it was started with.
//
// FAKE_ACP_CHILD=1 starts a process of its own before it serves, as an agent's tool command is
// (a shell, a build), and traces its id (`child`) once it runs; FAKE_ACP_CHILD=stubborn starts
// one that ignores SIGTERM. Either ends by itself after a minute, so a failed test leaves none.
//
// FAKE_ACP_MODES=a,b,c makes it offer those permission modes (the first is the one it starts in)
// and take `session/set_mode`, as both real adapters do; without it it offers none, as before.
// A prompt that says "unasked" runs one of its own tools without asking permission, as an agent
// does when its mode (or a rule in the person's own CLI settings) lets the call through, and
// traces `own-tool-ran` with the mode it ran in; "unasked twice" runs two.
// FAKE_ACP_REFUSE_MODES=a,b refuses those session/set_mode requests with invalidParams.
// FAKE_ACP_IGNORE_CANCEL=1 makes it ignore `session/cancel`, as a stuck agent would.
//
// As codex-acp (#1564 PR B): FAKE_ACP_MODELS=a,b,c offers those model slugs instead of the fake
// ones (each with low/medium/high efforts) and FAKE_ACP_START_MODEL picks the one a session
// starts on. "codex-bridge <tool> [<json arguments>]" calls a bridge tool the way codex-acp
// reports one (kind execute, `rawInput.server`, `_meta.is_mcp_tool_call`, no name);
// "codex-edit-ask" is its patch call (an edit `tool_call`, then a permission request; the patch
// runs only when allowed); "codex-subagent" starts one of its own sub-agents (no permission);
// "codex-reader <server> <tool>" is one of its MCP resource readers.
//
// As an agent with its own home that signs in over ACP (Antigravity, #2048):
// FAKE_ACP_AUTH_METHODS=a,b offers those `authMethods` ids in `initialize`. FAKE_ACP_AUTH=file
// refuses `session/new` with auth_required unless `$HOME/.gemini/fake-signed-in` exists, and
// `authenticate` with an offered id writes that file (the sign-in lives in its HOME only);
// FAKE_ACP_AUTH_FAIL=1 makes `authenticate` fail instead. FAKE_ACP_AUTH_STDERR is printed on
// stderr when `authenticate` starts (a sign-in link, as agy may print one), and
// FAKE_ACP_AUTH_HOLD=1 then keeps `authenticate` waiting, as for a person in the browser.
// FAKE_ACP_ENV_FILE appends, at start, the names of the variables it was given and the values
// of its home variables only (HOME, USERPROFILE, the XDG folders, CODEX_HOME and the Claude
// folders), of the D-Bus address, and its PATH (`path`) with its first entry (`pathHead`).
// FAKE_ACP_LOGOUT=1 advertises `agentCapabilities.auth.logout` and answers `logout`
// (traced as `logout` with its HOME).
// FAKE_ACP_AUTH_OPEN=<url> stands for agy's browser opener call during `authenticate`: it runs
// the opener named FAKE_ACP_OPENER (default `xdg-open`) with that URL, only from the first PATH
// entry and only when that entry is an attempt's stand-in folder (`/sign-in/<uuid>/bin`), so a
// test never starts a real browser, and traces `opener` with whether it found one.
// FAKE_ACP_AUTH_LISTEN=1 stands for agy's own sign-in listener (#2048, paste-back): during
// `authenticate` it listens on 127.0.0.1 (a free port), builds Google's link with
// `redirect_uri=http://localhost:<port>/auth/callback` and a random state, hands it to the
// opener as FAKE_ACP_AUTH_OPEN does, and traces `listen` with the port. A GET of that path with
// the right state and one code answers 200 and signs in; any other answers 400 and it keeps
// waiting (FAKE_ACP_AUTH_ANSWER=400 answers 400 to every GET). Each GET is traced as `callback`
// with whether it was right, never its code. The listener closes when `authenticate` ends.
// FAKE_ACP_AUTH_WINDOW_MS=<n> rejects `authenticate` after n ms (agy ending its own wait), and
// FAKE_ACP_AUTH_EXIT=1 exits with 1 right after printing FAKE_ACP_AUTH_STDERR.
// As agy (#1564, native tools off): FAKE_ACP_AGENT_VERSION answers that `agentInfo.version` at
// `initialize`. FAKE_ACP_AGY_LOG names a JSON file read at each `session/new`: `{ lines }` are
// written, before the answer, to agy's own log for this process,
// `$HOME/.gemini/antigravity-cli/<--cli_dir_name>/log/acp-server-<local YYYYMMDD_HHMMSS>-<pid>.log`;
// `{ late: { ms, lines } }` appends more that long after the answer; no `lines` writes none;
// `old`, `stampDaysBack`, `link` and `fifo` are described where it writes (agyLog).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { serveAgent } from './serve-agent.mjs'

const EXTRA_EFFORT = process.env.FAKE_ACP_EXTRA_EFFORT
const MODELS = process.env.FAKE_ACP_MODELS ? process.env.FAKE_ACP_MODELS.split(',').filter(Boolean).map(value => ({ value, name: value, efforts: ['low', 'medium', 'high'], effort: 'medium' })) : [
  { value: 'fake-large', name: 'Fake Large', efforts: ['low', 'medium', 'high'], effort: 'medium' },
  { value: 'fake-small', name: 'Fake Small', description: 'Quick and cheap', efforts: ['low', 'high', ...(EXTRA_EFFORT ? [EXTRA_EFFORT] : [])], effort: 'low' },
  { value: 'fake-plain', name: 'Fake Plain', efforts: [], effort: undefined },
]
const START_MODEL = MODELS.find(entry => entry.value === process.env.FAKE_ACP_START_MODEL) ?? MODELS[0]
const OFFERS = process.env.FAKE_ACP_NO_OPTIONS !== '1'
const DEFAULT_ROW = process.env.FAKE_ACP_NO_DEFAULT_EFFORT === '1' ? [] : [{ value: 'default', name: 'Default' }]
const SKIP_MCP = process.env.FAKE_ACP_SKIP_MCP === '1'
const OMP_DISCOVER = process.env.FAKE_ACP_OMP_DISCOVER === '1'
const AUTH = process.env.FAKE_ACP_AUTH
// A test can read what the client asked for (its servers, a fork, a close) from this file.
const TRACE = process.env.FAKE_ACP_TRACE
const SKILLS_PROBE = JSON.parse(process.env.FAKE_ACP_SKILLS_PROBE ?? 'null')
const trace = (entry) => {
  if (TRACE === undefined) return
  try { appendFileSync(TRACE, `${JSON.stringify({ pid: process.pid, ...entry })}\n`) } catch {}
}
const MODES = (process.env.FAKE_ACP_MODES ?? '').split(',').filter(Boolean)
const SESSION_MODELS = process.env.FAKE_ACP_SESSION_MODELS === '1'
trace({ event: 'start', args: process.argv.slice(2) })
const AUTH_METHODS = (process.env.FAKE_ACP_AUTH_METHODS ?? '').split(',').filter(Boolean)
const SIGNED_IN = () => join(process.env.HOME ?? '', '.gemini', 'fake-signed-in')
if (process.env.FAKE_ACP_ENV_FILE !== undefined) {
  const shown = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'DBUS_SESSION_BUS_ADDRESS']
  const names = Object.keys(process.env).filter(name => !name.startsWith('FAKE_ACP_') && name !== 'ACP_TRACE_FILE').sort()
  try {
    appendFileSync(process.env.FAKE_ACP_ENV_FILE, `${JSON.stringify({
      pid: process.pid, cwd: process.cwd(), names,
      path: process.env.PATH ?? null, pathHead: (process.env.PATH ?? '').split(delimiter)[0],
      values: Object.fromEntries(shown.filter(name => name in process.env).map(name => [name, process.env[name]])),
    })}\n`)
  } catch {}
}
const modesOf = session => (MODES.length === 0 ? {} : { modes: { currentModeId: session.mode, availableModes: MODES.map(id => ({ id, name: id })) } })
// What a `session/new` answer says of models and modes, in either shape.
const offersOf = session => ({
  ...(SESSION_MODELS
    ? { models: { currentModelId: session.model, availableModels: MODELS.map(({ value, name, description }) => ({ modelId: value, name, ...(description ? { description } : {}) })) } }
    : OFFERS ? { configOptions: configOptions(session) } : {}),
  ...modesOf(session),
})

function configOptions(session) {
  const model = MODELS.find(entry => entry.value === session.model)
  const options = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model.value, options: MODELS.map(({ value, name, description }) => ({ value, name, ...(description ? { description } : {}) })) }]
  if (model.efforts.length > 0) {
    options.push({ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: session.effort ?? 'default', options: [...DEFAULT_ROW, ...model.efforts.map(value => ({ value, name: value[0].toUpperCase() + value.slice(1) }))] })
  }
  return options
}

// One MCP server as an agent's adapter would use it: newline-delimited JSON-RPC over its stdio.
// A `tools/list_changed` notification makes it re-list, as Claude Code's adapter does (Codex
// ignores it, which is why the plugin forks there instead); the trace keeps the order observable.
function connect(server, sessionId, { probe = false } = {}) {
  const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) }
  const args = server.args ?? []
  const nameFlag = args.indexOf('--server-name')
  trace({ event: 'mcp-spawn', sessionId, server: server.name, serverNameArg: nameFlag === -1 ? null : args[nameFlag + 1] ?? null })
  const child = spawn(server.command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.on('error', () => {})
  let seq = 0
  const pending = new Map()
  const cancelled = new Set()
  let failure
  const exited = new Promise(resolve => {
    const end = error => {
      failure = error
      for (const { reject } of pending.values()) reject(error)
      pending.clear()
      resolve()
    }
    child.once('error', end)
    child.once('exit', (code, signal) => end(new Error(`${server.name} exited (${signal ?? code})`)))
  })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.method === 'notifications/tools/list_changed') {
        void request('tools/list', {}).then((listed) => {
          trace({ event: 'relist', sessionId, server: server.name, at: Date.now(), tools: (listed?.tools ?? []).map(tool => tool?.name) })
        }).catch(() => {})
        continue
      }
      if (message.id === undefined) continue
      if (cancelled.delete(message.id)) trace({ event: 'mcp-cancelled-reply', sessionId, message })
      const waiter = pending.get(message.id)
      if (waiter === undefined) continue
      pending.delete(message.id)
      if (message.error === undefined) waiter.resolve(message.result)
      else waiter.reject(new Error(message.error.message))
    }
  })
  const request = (method, params, signal) => new Promise((resolve, reject) => {
    if (failure !== undefined) return reject(failure)
    if (signal?.aborted) return reject(signal.reason)
    const id = ++seq
    const abort = () => {
      pending.delete(id)
      cancelled.add(id)
      notify('notifications/cancelled', { requestId: id })
      trace({ event: 'mcp-call-cancelled', sessionId })
      reject(signal.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, {
      resolve: result => { signal?.removeEventListener('abort', abort); resolve(result) },
      reject: error => { signal?.removeEventListener('abort', abort); reject(error) },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const ready = (async () => {
    if (probe) {
      try { await request('server/discover', {}) } catch (error) {
        trace({ event: 'mcp-discover', sessionId, server: server.name, error: error.message })
      }
    }
    const result = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } })
    trace({ event: 'mcp-init', sessionId, server: server.name, serverInfo: result?.serverInfo?.name })
    if (probe) return []
    notify('notifications/initialized', {})
    const listed = await request('tools/list', {})
    return Array.isArray(listed?.tools) ? listed.tools : []
  })()
  const stop = () => {
    child.stdin.end()
    return exited
  }
  const close = () => {
    try { child.stdin.end() } catch {}
    try { child.kill('SIGTERM') } catch {}
  }
  return { request, tools: ready, stop, close }
}

async function attachServer(session, server, sessionId) {
  const connection = connect(server, sessionId)
  session.mcp.set(server.name, connection)
  const tools = await connection.tools.catch(() => [])
  session.listed?.set(server.name, tools.map(tool => tool?.name))
  trace({ event: 'mcp-list', sessionId, server: server.name, tools: tools.map(tool => tool?.name),
    ...(SKILLS_PROBE && { definitions: tools }) })
}

async function attach(session, servers, sessionId) {
  session.mcp = new Map()
  session.bridgeName = undefined
  if (SKIP_MCP) return
  for (const server of servers ?? []) {
    if (server.env?.some(entry => entry.name === 'DSH_BRIDGE_CREDENTIAL')) session.bridgeName = server.name
    if (server.name === 'dsh') session.dshServer = server
    if (OMP_DISCOVER && server.name === 'dsh') {
      const probe = connect(server, sessionId, { probe: true })
      try { await probe.tools } finally { await probe.stop() }
    }
    // The adapter's first `tools/list` for this session, before its `session/new` (or fork)
    // answer: the delivery 6 probes read this order from the trace.
    await attachServer(session, server, sessionId)
  }
}

// A 1x1 PNG, for the image calls.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// The methods this agent never hears are dropped off the wire, before anything can answer them.
const DEAF_TO = new Set((process.env.FAKE_ACP_DEAF_TO ?? '').split(',').filter(Boolean))
function hearing(stream) {
  if (DEAF_TO.size === 0) return stream
  const heard = new TransformStream({
    transform(message, controller) {
      if (DEAF_TO.has(message?.method)) return trace({ event: 'unheard', method: message.method })
      controller.enqueue(message)
    },
  })
  return { ...stream, readable: stream.readable.pipeThrough(heard) }
}

if (process.env.FAKE_ACP_CHILD !== undefined) {
  const deaf = process.env.FAKE_ACP_CHILD === 'stubborn' ? "process.on('SIGTERM', () => {});" : ''
  const child = spawn(process.execPath, ['-e', `${deaf} setTimeout(() => {}, 60_000); process.stdout.write('up')`], { stdio: ['ignore', 'pipe', 'ignore'] })
  // Traced once it has run its first line: a stubborn one ignores the signal from then on.
  child.stdout.once('data', () => trace({ event: 'child', child: child.pid }))
  child.unref()
  child.stdout.unref?.()
}

const stream = hearing(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
const sessions = new Map()
let created = 0

// agy's own per-process log (FAKE_ACP_AGY_LOG, above).
function agyLog() {
  const control = process.env.FAKE_ACP_AGY_LOG
  if (control === undefined) return
  let wanted
  try { wanted = JSON.parse(readFileSync(control, 'utf8')) } catch { return }
  const at = process.argv.indexOf('--cli_dir_name')
  const dir = join(process.env.HOME ?? '', '.gemini', 'antigravity-cli', ...(at >= 0 ? [process.argv[at + 1]] : []), 'log')
  const two = value => String(value).padStart(2, '0')
  const stamp = date => `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}_${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  const day = 24 * 60 * 60 * 1000
  const nameAt = daysBack => join(dir, `acp-server-${stamp(new Date(Date.now() - daysBack * day))}-${process.pid}.log`)
  const text = lines => lines.map(line => `${line}\n`).join('')
  mkdirSync(dir, { recursive: true })
  // `{ old: { lines } }`: an older file of the same pid (another day's stamp and file time).
  if (wanted?.old !== undefined) {
    const file = nameAt(1)
    appendFileSync(file, text(wanted.old.lines))
    const then = new Date(Date.now() - day)
    utimesSync(file, then, then)
  }
  // `{ stampDaysBack }`: this run's own file named with a stamp that many days back, as a clock in
  // another zone would name it; its file time is now.
  const file = nameAt(wanted?.stampDaysBack ?? 0)
  // `{ link: target }` / `{ fifo: true }`: the process's file is a symlink, or a FIFO.
  if (typeof wanted?.link === 'string') { symlinkSync(wanted.link, file); return }
  if (wanted?.fifo === true) { execFileSync('mkfifo', [file]); return }
  if (!Array.isArray(wanted?.lines)) return
  appendFileSync(file, text(wanted.lines))
  if (wanted.late !== undefined) {
    setTimeout(() => { try { appendFileSync(file, text(wanted.late.lines)) } catch {} }, wanted.late.ms)
  }
}

function newSession(sessionId, cwd) {
  const session = { cwd, cancelled: false, turns: 0, model: START_MODEL.value, effort: START_MODEL.effort, mode: MODES[0], mcp: new Map() }
  sessions.set(sessionId, session)
  return session
}

const implementation = {
  async initialize() {
    // FAKE_ACP_PROTOCOL answers another protocol version, as an adapter built for a later ACP does.
    const protocolVersion = process.env.FAKE_ACP_PROTOCOL === undefined ? PROTOCOL_VERSION : Number(process.env.FAKE_ACP_PROTOCOL)
    const agentCapabilities = {
      loadSession: false,
      ...(process.env.FAKE_ACP_SYSTEM_PROMPT === '1'
        ? { sessionCapabilities: { systemPrompt: {} } } : {}),
    }
    if (process.env.FAKE_ACP_LOGOUT === '1') agentCapabilities.auth = { logout: {} }
    return {
      protocolVersion, agentCapabilities, authMethods: AUTH_METHODS.map(id => ({ id, name: id })),
      ...(process.env.FAKE_ACP_AGENT_VERSION === undefined ? {} : { agentInfo: { name: 'Fake ACP Server', version: process.env.FAKE_ACP_AGENT_VERSION } }),
    }
  },
  async authenticate(params) {
    trace({ event: 'authenticate', methodId: params?.methodId })
    // With no methods offered it answers as it always did; with some, only those.
    if (AUTH_METHODS.length > 0 && !AUTH_METHODS.includes(params?.methodId)) throw RequestError.invalidParams(undefined, `Unknown auth method: ${params?.methodId}`)
    if (process.env.FAKE_ACP_AUTH_STDERR) process.stderr.write(`${process.env.FAKE_ACP_AUTH_STDERR}\n`)
    if (process.env.FAKE_ACP_AUTH_EXIT === '1') setTimeout(() => process.exit(1), 50)
    const open = (url) => {
      const head = (process.env.PATH ?? '').split(delimiter)[0]
      const opener = join(head, process.env.FAKE_ACP_OPENER ?? 'xdg-open')
      const found = /\/sign-in\/[0-9a-f-]{36}\/bin$/.test(head) && existsSync(opener)
      if (found) spawnSync(opener, [url], { stdio: 'ignore', timeout: 5000 })
      trace({ event: 'opener', found })
    }
    if (process.env.FAKE_ACP_AUTH_OPEN) open(process.env.FAKE_ACP_AUTH_OPEN)
    const windowMs = Number(process.env.FAKE_ACP_AUTH_WINDOW_MS)
    const ownEnd = Number.isFinite(windowMs) && windowMs > 0
      ? new Promise((resolve, reject) => setTimeout(() => reject(RequestError.internalError(undefined, 'the sign-in wait ended')), windowMs))
      : undefined
    if (process.env.FAKE_ACP_AUTH_LISTEN === '1') {
      const state = randomBytes(16).toString('hex')
      let server
      const signedIn = new Promise((resolve) => {
        server = createServer((req, res) => {
          let right = false
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            right = process.env.FAKE_ACP_AUTH_ANSWER !== '400' && url.pathname === '/auth/callback'
              && url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state
              && url.searchParams.getAll('code').length === 1 && url.searchParams.get('code') !== ''
          } catch {}
          trace({ event: 'callback', right })
          res.writeHead(right ? 200 : 400, { 'content-type': 'text/plain', connection: 'close' })
          res.end(right ? 'signed in' : 'no')
          if (right) resolve()
        })
      })
      const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
      trace({ event: 'listen', port })
      const redirect = encodeURIComponent(`http://localhost:${port}/auth/callback`)
      open(`https://accounts.google.com/o/oauth2/v2/auth?client_id=1-a.apps.googleusercontent.com&redirect_uri=${redirect}`
        + `&response_type=code&state=${state}`)
      try {
        await (ownEnd === undefined ? signedIn : Promise.race([signedIn, ownEnd]))
      } finally {
        server.closeAllConnections?.()
        server.close()
      }
    } else if (ownEnd !== undefined) await ownEnd
    if (process.env.FAKE_ACP_AUTH_HOLD === '1') await new Promise(() => {})
    if (process.env.FAKE_ACP_AUTH_FAIL === '1') throw RequestError.internalError(undefined, 'the browser sign-in did not finish')
    if (AUTH === 'file') {
      mkdirSync(join(process.env.HOME ?? '', '.gemini'), { recursive: true })
      writeFileSync(SIGNED_IN(), 'yes')
    }
    return {}
  },
  async logout() {
    trace({ event: 'logout', home: process.env.HOME })
    if (process.env.FAKE_ACP_LOGOUT !== '1') throw RequestError.methodNotFound('logout')
    return {}
  },
  async newSession(params) {
    if (AUTH === 'session') throw RequestError.authRequired(undefined, 'run the CLI\'s login first')
    if (AUTH === 'file' && !existsSync(SIGNED_IN())) throw RequestError.authRequired(undefined, 'sign in first')
    const sessionId = `fake-${++created}`
    trace({
      event: 'new-session', sessionId,
      ...(params._meta === undefined ? {} : { meta: params._meta }),
      systemPrompt: params.systemPrompt?.content.map(block => block.text).join('\n'),
      servers: (params.mcpServers ?? []).map(server => server.name),
    })
    const session = newSession(sessionId, params.cwd)
    const registryMode = process.env.FAKE_ACP_AGY_REGISTRY
    if (registryMode) {
      session.listed = new Map()
      session.eager = new Set(registryMode === 'eager' ? params._meta?.antigravity?.eagerMcpServers : [])
    }
    await attach(session, params.mcpServers, sessionId)
    agyLog()
    trace({ event: 'new-answer', sessionId, at: Date.now() })
    return { sessionId, ...offersOf(session) }
  },
  // The session's own model list: registered by its wire name (serve-agent.mjs).
  async setSessionModel(params) {
    const session = sessions.get(params?.sessionId)
    if (!SESSION_MODELS || !session) throw RequestError.methodNotFound('session/set_model')
    if (!MODELS.some(entry => entry.value === params.modelId)) throw RequestError.invalidParams(undefined, `Unknown model: ${params.modelId}`)
    // A model the agent lists and then cannot resolve, as Hermes answers for one.
    if (process.env.FAKE_ACP_SET_MODEL_FAIL === params.modelId) throw RequestError.internalError({ details: 'model_resolution_failed' })
    session.model = params.modelId
    session.effort = undefined
    trace({ event: 'set-model', sessionId: params.sessionId, modelId: params.modelId })
    return {}
  },
  async forkSession(params) {
    if (process.env.FAKE_ACP_FORK_FAIL === '1') throw RequestError.invalidParams(undefined, 'fork refused')
    const source = sessions.get(params.sessionId)
    if (source === undefined) throw RequestError.invalidParams(undefined, `Unknown session: ${params.sessionId}`)
    const sessionId = `fake-${++created}`
    const session = newSession(sessionId, params.cwd ?? source.cwd)
    // The fork continues the same conversation: the fake carries its turn count (the point the
    // plugin's refresh relies on) and the agent's mode.
    session.turns = source.turns
    session.model = source.model
    session.effort = source.effort
    session.mode = source.mode
    session.forkedFrom = params.sessionId
    trace({
      event: 'fork', from: params.sessionId, sessionId,
      systemPrompt: params.systemPrompt?.content.map(block => block.text).join('\n'),
      servers: (params.mcpServers ?? []).map(server => server.name),
    })
    // A fork that cannot offer the bridge: `session/fork` answers with a session whose server
    // never started, as codex-acp does when the person's Codex config defines that name.
    if (process.env.FAKE_ACP_FORK_SKIP_MCP !== '1') await attach(session, params.mcpServers, sessionId)
    // The answer is held open, so a probe can land a preset change while the session does not
    // exist yet (the ordering rule is exercised from both sides).
    const delay = Number(process.env.FAKE_ACP_FORK_DELAY_MS ?? 0)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    trace({ event: 'fork-answer', sessionId, from: params.sessionId, at: Date.now() })
    return { sessionId, ...offersOf(session) }
  },
  async closeSession({ sessionId }) {
    trace({ event: 'close', sessionId })
    const session = sessions.get(sessionId)
    if (session !== undefined) {
      session.closed = true
      for (const connection of session.mcp.values()) connection.close()
    }
    return {}
  },
  async setSessionConfigOption({ sessionId, configId, value }) {
    const session = sessions.get(sessionId)
    if (!OFFERS || !session) throw RequestError.invalidParams(undefined, `Unknown config option: ${configId}`)
    const option = configOptions(session).find(entry => entry.id === configId)
    if (!option?.options.some(entry => entry.value === value)) throw RequestError.invalidParams(undefined, `Invalid value for config option ${configId}: ${value}`)
    if (configId === 'model') {
      const model = MODELS.find(entry => entry.value === value)
      session.model = value
      // A new model keeps the effort when it offers it, else takes its own.
      if (!model.efforts.includes(session.effort)) session.effort = model.effort
    } else {
      session.effort = value === 'default' ? undefined : value
    }
    return { configOptions: configOptions(session) }
  },
  async cancel({ sessionId }) {
    trace({ event: 'cancel', sessionId })
    // FAKE_ACP_IGNORE_CANCEL=1: an agent that goes on working after a cancel.
    if (process.env.FAKE_ACP_IGNORE_CANCEL === '1') return
    const session = sessions.get(sessionId)
    if (session) {
      session.cancelled = true
      session.historyRequest?.abort()
      session.wake?.()
    }
  },
  async prompt({ sessionId, prompt }) {
    if (AUTH === 'prompt') throw RequestError.authRequired()
    const session = sessions.get(sessionId)
    session.cancelled = false
    session.turns++
    const said = prompt.filter(block => block.type === 'text').map(block => block.text).join(' ')
    // A catalog can follow the person's message on the first prompt after renewal.
    const current = prompt.findLast(block => block.type === 'text' &&
      !block.text.startsWith('Your skills (load with load_skill):'))?.text ?? ''
    // What the client actually sent this turn (a replayed transcript, for a crossing).
    trace({ event: 'prompt', sessionId, turns: session.turns, text: said, ...(SKILLS_PROBE && { prompt }) })
    const update = u => conn.sessionUpdate({ sessionId, update: u })
    const waitForFile = async file => {
      const deadline = Date.now() + 8_000
      while (!existsSync(file) && !session.cancelled) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    if (process.env.FAKE_ACP_FIXTURE_MARKER && /^plan-scope-marker (inside|other)$/.test(current)) {
      const inside = current.endsWith('inside')
      const path = inside ? process.env.FAKE_ACP_FIXTURE_MARKER : process.env.FAKE_ACP_FIXTURE_OTHER
      const toolCallId = `fixture-read-${session.turns}`
      const toolCall = {
        toolCallId, title: 'Read marker fixture', kind: 'read', status: 'pending',
        rawInput: { file_path: path }, locations: [{ path }], _meta: { claudeCode: { toolName: 'Read' } },
      }
      await update({ sessionUpdate: 'tool_call', ...toolCall })
      const { outcome } = await conn.requestPermission({
        sessionId, toolCall, options: [
          { kind: 'allow_once', optionId: 'yes', name: 'Allow' },
          { kind: 'reject_once', optionId: 'no', name: 'Reject' },
        ],
      })
      const answer = outcome.optionId ?? outcome.outcome
      trace({ event: 'fixture-permission', sessionId, toolCallId, answer, path })
      // The denied operand is deliberately inert even when testing against an older parent.
      const observed = inside && answer === 'yes'
      const text = observed ? readFileSync(path, 'utf8') : 'No marker read.'
      if (observed) trace({ event: 'own-tool-ran', sessionId, toolCallId, mode: session.mode })
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: observed ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text } }],
      })
      return { stopReason: 'end_turn' }
    }
    const streamDir = process.env.FAKE_ACP_STREAM_DIR
    const streamCase = /^plan-scope-stream (bash|write|changed|outside)$/.exec(current)?.[1]
    if (streamDir && streamCase) {
      const isWrite = streamCase === 'write'
      const isRead = streamCase === 'outside'
      const kind = isWrite ? 'edit' : isRead ? 'read' : 'execute'
      const toolName = isWrite ? 'Write' : isRead ? 'Read' : 'Bash'
      const path = isRead ? join(streamDir, 'outside-stream.txt') : join(session.cwd, `stream-${streamCase}.txt`)
      const marker = 'Synthetic streamed operation'
      const firstInput = isWrite || isRead ? { file_path: path } : { command: 'fixture-stream-check' }
      const input = isWrite ? { ...firstInput, content: marker } : { ...firstInput, description: marker }
      if (streamCase === 'changed') input.command = 'fixture-stream-changed'
      const toolCallId = `fixture-stream-${session.turns}`
      const toolCall = {
        toolCallId, kind, title: `Streamed ${toolName} fixture`, status: 'pending',
        _meta: { claudeCode: { toolName } },
      }
      await update({ sessionUpdate: 'tool_call', ...toolCall, rawInput: firstInput })
      await waitForFile(join(streamDir, 'mirror-recorded'))
      if (session.cancelled) return { stopReason: 'cancelled' }
      await update({ sessionUpdate: 'tool_call_update', toolCallId, rawInput: input })
      const { outcome } = await conn.requestPermission({
        sessionId, toolCall: { ...toolCall, rawInput: input,
          ...(isWrite ? { content: [{ type: 'diff', path, oldText: null, newText: marker }] } : {}),
        }, options: [
          { kind: 'allow_once', optionId: 'yes', name: 'Allow' },
          { kind: 'reject_once', optionId: 'no', name: 'Reject' },
        ],
      })
      const answer = outcome.optionId ?? outcome.outcome
      trace({ event: 'fixture-stream-permission', sessionId, toolCallId, answer })
      let text = 'No operation ran.'
      if (answer === 'yes') {
        // Simulate the operation on fixture data. The Bash command is never executed.
        if (isRead) text = readFileSync(path, 'utf8')
        else {
          writeFileSync(path, marker, { flag: 'wx' })
          text = marker
        }
        trace({ event: 'own-tool-ran', sessionId, toolCallId, mode: session.mode })
      }
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: answer === 'yes' ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text } }],
      })
      return { stopReason: 'end_turn' }
    }
    if (process.env.FAKE_ACP_FIXTURE_MARKER && /^plan-scope-sandbox (inside|denied|released)$/.test(current)) {
      const operation = current.split(' ').at(-1)
      const inside = operation === 'inside'
      const path = inside ? process.env.FAKE_ACP_FIXTURE_MARKER : process.env.FAKE_ACP_FIXTURE_OTHER
      const toolCallId = `fixture-sandbox-${session.turns}`
      const allowed = inside || operation === 'released' && session.mode === 'agent-full-access'
      const tool = { toolCallId, kind: 'read', title: 'Read synthetic marker', rawInput: { file_path: path } }
      await update({ sessionUpdate: 'tool_call', status: 'in_progress', ...tool })
      trace({ event: 'fixture-sandbox', sessionId, toolCallId, path, allowed, mode: session.mode })
      if (allowed) trace({ event: 'own-tool-ran', sessionId, toolCallId, mode: session.mode })
      await update({ sessionUpdate: 'tool_call_update', status: allowed ? 'completed' : 'failed', ...tool,
        content: [{ type: 'content', content: { type: 'text', text: allowed ? readFileSync(path, 'utf8') : 'Synthetic sandbox: Permission denied' } }],
      })
      return { stopReason: 'end_turn' }
    }
    if (/\b(?:guard-nested|late-command|no-command)\b/.test(said)) {
      const complete = (toolCallId, text, args = {}) => update({
        sessionUpdate: 'tool_call_update', toolCallId, status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text } }], ...args,
      })
      if (/\bguard-nested\b/.test(said)) {
        const parent = 'guard-parent'
        await update({ sessionUpdate: 'tool_call', toolCallId: parent, title: 'Run parent', kind: 'execute',
          status: 'in_progress', rawInput: { command: 'touch nested-parent' } })
        writeFileSync('nested-parent', '')
        trace({ event: 'own-tool-ran', sessionId, toolCallId: parent, mode: session.mode })
        await waitForFile('.guard-parent-open')
        if (session.cancelled) return { stopReason: 'cancelled' }
        for (const [id, name, rawInput] of [
          ['guard-held', 'Bash', { command: 'touch held-child' }],
          ['guard-sibling', 'Read', { file_path: 'notes.txt' }],
          ['guard-mutated', 'Read', { file_path: 'notes.txt' }],
        ]) {
          const kind = name === 'Bash' ? 'execute' : 'read'
          const toolCall = { toolCallId: id, kind, rawInput }
          const details = { claudeCode: { toolName: name, parentToolUseId: id === 'guard-mutated' ? 'guard-sibling' : parent } }
          await update({ sessionUpdate: 'tool_call', ...toolCall, title: name, status: 'pending', _meta: details })
          const pending = conn.requestPermission({ sessionId, toolCall,
            options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
          })
          if (id === 'guard-mutated') {
            await waitForFile('.guard-child-open')
            await update({ sessionUpdate: 'tool_call_update', toolCallId: id, rawInput: { file_path: 'different.txt' } })
          }
          const { outcome } = await pending
          const answer = outcome.optionId ?? outcome.outcome
          if (answer === 'yes') {
            if (name === 'Bash') writeFileSync('held-child', '')
            trace({ event: 'native-tool-ran', sessionId, toolCallId: id, name })
            if (id !== 'guard-sibling') await complete(id, 'nested result')
          } else {
            trace({ event: 'native-tool-refused', sessionId, toolCallId: id, name, answer })
            await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' })
          }
        }
        await complete('guard-sibling', 'nested result')
        await complete(parent, 'parent result')
      } else {
        const toolCallId = 'guard-terminal'
        await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Terminal command', kind: 'execute', status: 'in_progress' })
        await waitForFile('.guard-terminal-open')
        if (session.cancelled) return { stopReason: 'cancelled' }
        if (/\blate-command\b/.test(said)) {
          await update({ sessionUpdate: 'tool_call_update', toolCallId, rawInput: { command: 'touch late-2132' } })
          writeFileSync('late-2132', '')
        }
        trace({ event: 'own-tool-ran', sessionId, toolCallId, mode: session.mode })
        await complete(toolCallId, 'terminal result')
      }
      return { stopReason: 'end_turn' }
    }
    if (session.listed) {
      // Antigravity resolves the OFF profile against the component registry. Listing a
      // session server is insufficient: only eagerly loaded tools become components.
      const at = process.argv.indexOf('--agent')
      const profile = at >= 0 ? process.argv[at + 1] : undefined
      const file = profile && readFileSync(join(process.env.HOME, '.gemini', 'config', 'agents', profile + '.md'), 'utf8')
      const wanted = file ? JSON.parse(/^tools: (.*)$/m.exec(file)?.[1] ?? '[]') : []
      const registry = [...session.listed].flatMap(([server, names]) => session.eager.has(server)
        ? names.map(name => 'mcp_' + server.replace(/[^A-Za-z0-9_]/g, '_') + '_' + name) : [])
      trace({ event: 'registry', profile, wanted, registry })
      const missing = wanted.find(name => !registry.includes(name))
      if (missing !== undefined) {
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text',
          text: '\n⚠ failed to construct executor: failed to resolve components: unknown component: tool "' + missing + '" not found in registry\n' } })
        return { stopReason: 'end_turn' }
      }
    }
    const probe = SKILLS_PROBE?.turns.find(({ text }) => prompt.some(block => block.text === text))
    if (probe) {
      const { claude } = SKILLS_PROBE
      const options = [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
      const ask = async toolCall => (await conn.requestPermission({ sessionId, toolCall, options })).outcome
      for (const [index, name] of probe.loads.entries()) {
        const load = async retry => {
          const toolCallId = `skills-${session.turns}-${index}-${retry}`
          const operation = 'mcp__dsh__load_skill'
          const toolCall = claude
            ? { name: operation, title: operation, rawInput: { name }, _meta: { claudeCode: { toolName: operation } } }
            : { title: 'mcp.dsh.load_skill', rawInput: { server: 'dsh', tool: 'load_skill', arguments: { name } }, _meta: { is_mcp_tool_call: true } }
          Object.assign(toolCall, { toolCallId, kind: 'execute', status: 'pending' })
          await update({ sessionUpdate: 'tool_call', ...toolCall })
          if (claude) {
            const outcome = await ask(toolCall)
            if (outcome.optionId !== 'yes') return
          }
          const answer = await session.mcp.get('dsh').request('tools/call', { name: 'load_skill', arguments: { name } })
          trace({ event: 'skills-load', sessionId, name, retry, answer })
          await update({ sessionUpdate: 'tool_call_update', toolCallId, status: answer.isError ? 'failed' : 'completed' })
          return answer
        }
        const answer = await load(false)
        if (probe.retryEmpty && !answer?.isError) await load(true)
      }
      for (const [index, skill] of (probe.native ?? []).entries()) {
        const toolCall = { toolCallId: `native-skill-${session.turns}-${index}`, name: 'Skill', title: 'Skill',
          kind: 'other', status: 'pending', rawInput: { skill }, _meta: { claudeCode: { toolName: 'Skill' } } }
        await update({ sessionUpdate: 'tool_call', ...toolCall })
        const outcome = await ask(toolCall)
        trace({ event: 'native-skill-permission', sessionId, skill, outcome })
        await update({ sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId,
          status: outcome.optionId === 'yes' ? 'completed' : 'failed' })
      }
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture work completed.' } })
      return { stopReason: 'end_turn' }
    }
    // omp OFF exercises permission and notification independently. The permission
    // request comes first and neither refusal path sends a tool notification.
    if (/omp-permission-first/.test(said)) {
      const answer = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'permission-first', title: 'Run echo?', kind: 'execute' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          ...(/no-reject/.test(said) ? [] : [{ optionId: 'omp-reject', name: 'Reject', kind: 'reject_once' }]),
        ],
      })
      trace({ event: 'permission-answer', answer: answer.outcome })
      return { stopReason: 'end_turn' }
    }
    const firstTool = /omp-first-(tool_call(?:_update)?)/.exec(said)
    if (firstTool) {
      for (const id of ['first', 'second']) {
        await update({ sessionUpdate: firstTool[1], toolCallId: id, title: 'Unexpected tool', kind: 'execute', status: 'completed' })
      }
      return { stopReason: 'end_turn' }
    }
    const denies = /reviewer denies (\d+)/.exec(said)
    if (denies) {
      for (let n = 0; n < Number(denies[1]); n++) {
        const toolCallId = `guardian_assessment:${session.turns}-${n}`
        await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Guardian Review', kind: 'think', status: 'pending' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { review: { status: 'denied' } } })
      }
      if (/then text/.test(said)) await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continuing.' } })
      return { stopReason: process.env.FAKE_ACP_REVIEW_STOP ?? 'cancelled' }
    }
    if (OFFERS || SESSION_MODELS) await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `On ${session.model} at ${session.effort ?? 'no'} effort. ` } })
    await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking it over.' } })
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Fake agent, turn ${session.turns}: ` } })
    await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `you said "${said}".` } })
    // Updates a newer or a broken adapter could send: a kind this client does not know, and a
    // tool update with no call id. Neither may end the turn or hide what comes after.
    if (/odd-updates/.test(said)) {
      await update({ sessionUpdate: 'kind_from_the_future', detail: { anything: true } })
      await update({ sessionUpdate: 'tool_call_update', status: 'completed' })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Still here.' } })
      return { stopReason: 'end_turn' }
    }
    // A question the agent takes back before it is answered (`$/cancel_request`).
    if (/withdraw/.test(said)) {
      const toolCallId = `withdrawn-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: 'echo withdrawn', kind: 'execute', status: 'pending', rawInput: { command: 'echo withdrawn' } })
      const controller = new AbortController()
      const asked = conn.requestPermission({
        sessionId,
        toolCall: { toolCallId, title: 'Run command?' },
        options: [{ optionId: 'yes', name: 'Allow', kind: process.env.FAKE_ACP_ALWAYS_ONLY === '1' ? 'allow_always' : 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      }, { cancellationSignal: controller.signal })
      setTimeout(() => controller.abort(), Number(process.env.FAKE_ACP_WITHDRAW_MS ?? 50))
      const answer = await asked.then(value => value.outcome?.outcome, error => `error ${error?.code}`)
      trace({ event: 'withdrawn', sessionId, answer })
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` Withdrawn: ${answer}.` } })
      return { stopReason: 'end_turn' }
    }
    // Its own tool under a mode that does not ask: no `session/request_permission` at all, so
    // nothing the client answers can stop the call. The trace says it ran, and in which mode.
    if (/unasked/.test(said)) {
      const calls = /twice/.test(said) ? 2 : 1
      for (let n = 1; n <= calls; n++) {
        if (session.cancelled) return { stopReason: 'cancelled' }
        const toolCallId = `unasked-${session.turns}-${n}`
        const command = `touch unasked-${n}`
        await update({ sessionUpdate: 'tool_call', toolCallId, title: `Run ${command}`, kind: 'execute', status: 'in_progress', rawInput: { command } })
        trace({ event: 'own-tool-ran', sessionId, toolCallId, mode: session.mode })
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `ran ${n}` } }] })
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` It ran unasked ${n}.` } })
        // Between two calls the agent works for a moment, so a cancel can land.
        if (n < calls) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_ACP_UNASKED_GAP_MS ?? 0)))
      }
      return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' }
    }
    // A plain answer with no tool call: the turn ends cleanly, for tests about the session.
    if (/plain/.test(said)) return { stopReason: 'end_turn' }
    if (/hang/.test(said)) {
      if (!session.cancelled) await new Promise((resolve) => { session.wake = resolve })
      return { stopReason: 'cancelled' }
    }
    // A tool call the agent should not be able to make with `tools: []`: the plugin's drift
    // detector records it and cancels on this trace.
    if (/drift/.test(said)) {
      const toolCallId = `drift-${session.turns}`
      trace({ event: 'builtin-tool-call', sessionId, toolCallId, name: 'Bash' })
      await update({ sessionUpdate: 'tool_call', toolCallId, name: 'Bash', title: 'Bash: rm -rf build', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } })
      if (!session.cancelled) await new Promise((resolve) => { session.wake = resolve })
      return { stopReason: 'cancelled' }
    }
    // The adapter's own deferred-tool loader, seen with `tools: []`: it is not a DSH tool.
    if (/toolsearch/.test(said)) {
      const toolCallId = `search-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, name: 'ToolSearch', title: 'ToolSearch', kind: 'other', status: 'pending', rawInput: { query: 'select:mcp__dsh__bash' } })
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'found bash' } }] })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' I found it.' } })
      return { stopReason: 'end_turn' }
    }
    // Agent output carrying credentials: DSH logs what the agent says, so the plugin must
    // redact it before it is written down.
    if (/leak-tool/.test(said)) {
      const toolCallId = `leak-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Read key', kind: 'read', status: 'pending', rawInput: { file_path: '/tmp/leak', note: 'sk-abcdef123456' } })
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'token sk-abcdef123456 npm_abcdefghijklmnopqrstuvwxyz' } }] })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' done' } })
      return { stopReason: 'end_turn' }
    }
    if (/leak/.test(said)) {
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'leak sk-abcdef123456 npm_abcdefghijklmnopqrstuvwxyz Bearer abcdefgh1234' } })
      await update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought sk-abcdef123456' } })
      return { stopReason: 'end_turn' }
    }
    // Codex asks about either a pending MCP tool call or a standalone server approval.
    const mcpAsk = /mcp-ask-(bridge|other|standalone|unknown)/.exec(said)
    if (mcpAsk !== null) {
      const standalone = mcpAsk[1] === 'standalone'
      const server = mcpAsk[1] === 'other' ? 'personal' : 'dsh'
      const toolCallId = `mcp-ask-${session.turns}`
      const rawInput = standalone ? { serverName: server } : { ...(mcpAsk[1] === 'unknown' ? {} : { server }), tool: 'bash', arguments: {} }
      const toolCall = { toolCallId, title: standalone ? 'Approve MCP server' : `mcp.${server}.bash`, kind: 'other', rawInput }
      if (!standalone) await update({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending', _meta: { is_mcp_tool_call: true } })
      const answer = await conn.requestPermission({
        sessionId,
        toolCall,
        _meta: { is_mcp_tool_approval: true },
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      })
      const outcome = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: outcome === 'yes' ? 'completed' : 'failed' })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` MCP permission: ${outcome}.` } })
      return { stopReason: 'end_turn' }
    }
    const history = /^history-lookup omp (\S+)/m.exec(current)
    if (history !== null) {
      const name = 'read_own_chat'
      const toolCallId = `history-${session.turns}`
      const connection = session.mcp.get('dsh')
      let text = 'the bridge is not connected'
      if (connection !== undefined) {
        await update({ sessionUpdate: 'tool_call', toolCallId, name: 'mcp__dsh_read_own_chat', title: 'Read own chat', status: 'in_progress' })
        try {
          const answer = await connection.request('tools/call', { name, arguments: { query: history[1] }, _meta: { callId: toolCallId } })
          trace({ event: 'mcp-history-result', sessionId, toolCallId, answer })
          text = (answer.content ?? []).map(block => block.text ?? '').join('\n')
          await update({ sessionUpdate: 'tool_call_update', toolCallId, status: answer.isError ? 'failed' : 'completed' })
        } catch (error) {
          text = `bridge failed: ${error?.message ?? error}`
        }
      }
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      return { stopReason: 'end_turn' }
    }
    const agyReal = /^agy-real(-parallel)? (\[.*\])$/m.exec(current)
    if (agyReal !== null) {
      const server = session.bridgeName
      const connection = session.mcp.get(server)
      const parallel = agyReal[1] !== undefined
      const runStep = async (step, index) => {
        const { query, meta, operation = 'read_own_chat', conflicting, retry, permission = true, includeQuery } = step
        const toolCallId = `agy-real-${session.turns}-${index}`
        if (permission) {
          // Title, kind and summary reflect the observed ACP shape. The name value and
          // every MCP id variant below are synthetic. The optional query was seen in 5a.
          const name = conflicting ? `mcp_other_${operation}` : `mcp_${server}_${operation}`
          const toolCall = { toolCallId, name, title: `Run mcp_${server}_${operation}`, kind: 'other', status: 'pending',
            rawInput: operation === 'read_own_chat' ? { toolSummary: 'Read this chat', ...(includeQuery && { query }) }
              : { server, tool: operation } }
          await update({ sessionUpdate: 'tool_call', ...toolCall })
          const { outcome } = await conn.requestPermission({ sessionId, toolCall, options: [
            { optionId: 'agy-allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'agy-reject', name: 'Reject', kind: 'reject_once' },
          ] })
          trace({ event: 'permission-answer', answer: outcome })
          // The conflict control deliberately probes the bridge even after ACP refusal.
          if (!conflicting && outcome.optionId !== 'agy-allow') return false
        }
        const callId = meta === 'matching' ? toolCallId : meta
        const controller = new AbortController()
        session.historyRequest = controller
        try {
          for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            const answer = await connection.request('tools/call', { name: operation, arguments: parallel ? { query } : { query, name: query },
              ...(callId !== undefined && { _meta: { callId } }) }, controller.signal)
            trace({ event: 'agy-real-result', sessionId, toolCallId, query, operation, answer })
            const text = (answer.content ?? []).map(block => block.text ?? '').join('\n')
            if (text) await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error
          return true
        } finally {
          session.historyRequest = undefined
        }
        if (permission) await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
      }
      const steps = JSON.parse(agyReal[2])
      if (parallel) {
        if ((await Promise.all(steps.map(runStep))).some(Boolean)) return { stopReason: 'cancelled' }
      } else {
        for (const [index, step] of steps.entries()) {
          if (await runStep(step, index)) return { stopReason: 'cancelled' }
        }
      }
      return { stopReason: 'end_turn' }
    }
    // An inert permission input. A selected mock answer only increments the trace count.
    const approvalFixture = /^agy-approval-fixture (\S+)$/.exec(current)
    if (approvalFixture !== null) {
      const name = approvalFixture[1]
      const toolCallId = `agy-approval-fixture-${session.turns}`
      const toolCall = { toolCallId, name, title: `Run ${name}`, kind: 'other', status: 'pending',
        rawInput: { toolSummary: 'Synthetic approval input' } }
      const stopped = Promise.withResolvers()
      session.wake = stopped.resolve
      try {
        await update({ sessionUpdate: 'tool_call', ...toolCall })
        const answer = conn.requestPermission({ sessionId, toolCall, options: [
          { optionId: 'agy-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'agy-reject', name: 'Reject', kind: 'reject_once' },
        ] }).then(({ outcome }) => {
          trace({ event: 'permission-answer', sessionId, toolCallId, answer: outcome })
          if (outcome.optionId === 'agy-allow') trace({ event: 'synthetic-approved', sessionId, toolCallId })
          return outcome
        })
        const outcome = await Promise.race([answer, stopped.promise])
        if (session.cancelled) return { stopReason: 'cancelled' }
        await update({ sessionUpdate: 'tool_call_update', toolCallId,
          status: outcome.optionId === 'agy-allow' ? 'completed' : 'failed' })
        return { stopReason: 'end_turn' }
      } finally {
        session.wake = undefined
      }
    }
    // codex-acp's own shapes (#1564 PR B), each checked before the generic "bridge" trigger.
    const codexBridge = /\b(agy-bridge(?:-without-id)?) (\S+)(?: (\{.*\}))?/.exec(current)
      ?? /\b(codex-bridge) (\S+)(?: (\{.*\}))?/.exec(said)
    if (codexBridge !== null) {
      const [, style, name, raw] = codexBridge
      const args = raw === undefined ? {} : JSON.parse(raw)
      const toolCallId = `codex-bridge-${session.turns}`
      const agyBridge = style !== 'codex-bridge'
      const server = agyBridge ? session.bridgeName : 'dsh'
      if (agyBridge) {
        const flatName = `mcp_${server}_${name}`
        const toolCall = { toolCallId, name: flatName, title: flatName, kind: 'execute',
          rawInput: { server, tool: name, arguments: args } }
        await update({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending' })
        const { outcome } = await conn.requestPermission({ sessionId, toolCall, options: [
          { optionId: 'agy-allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'agy-reject', name: 'Reject', kind: 'reject_once' },
        ] })
        trace({ event: 'permission-answer', answer: outcome })
        if (outcome.optionId !== 'agy-allow') return { stopReason: 'end_turn' }
      } else {
        await update({ sessionUpdate: 'tool_call', toolCallId, title: `mcp.dsh.${name}`, kind: 'execute', status: 'in_progress', rawInput: { server: 'dsh', tool: name, arguments: args }, _meta: { is_mcp_tool_call: true } })
      }
      let text = 'the bridge is not connected'
      const connection = session.mcp.get(server)
      if (connection !== undefined) {
        try {
          const history = agyBridge && name === 'read_own_chat'
          // Skills on the combined history bridge still need the verified ACP binding.
          const combinedSkill = agyBridge && server !== 'dsh' && name === 'load_skill'
          const answer = await connection.request('tools/call', {
            name, arguments: args,
            ...((history || combinedSkill) && style === 'agy-bridge' && { _meta: { callId: toolCallId } }),
          })
          if (history) trace({ event: 'mcp-history-result', sessionId, toolCallId, answer })
          text = (answer.content ?? []).map(block => block.text ?? '').join('\n') || '(no text)'
        } catch (error) {
          text = `bridge failed: ${error?.message ?? error}`
        }
      }
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text } }] })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` The bridge said: ${text}` } })
      return { stopReason: 'end_turn' }
    }
    if (/codex-edit-ask/.test(said)) {
      const toolCallId = `codex-edit-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Editing files', kind: 'edit', status: 'in_progress' })
      const answer = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId, title: 'Edit files?', kind: 'edit' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      })
      const outcome = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome
      trace({ event: 'permission-answer', answer: answer.outcome })
      if (outcome === 'yes') trace({ event: 'patch-ran', toolCallId })
      return { stopReason: 'end_turn' }
    }
    if (/codex-subagent/.test(said)) {
      const toolCallId = `codex-agent-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: 'Start subagent explorer', kind: 'other', status: 'in_progress' })
      trace({ event: 'subagent-started', toolCallId })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' A sub-agent started.' } })
      return { stopReason: 'end_turn' }
    }
    const reader = /codex-reader (\S+) (\S+)/.exec(said)
    if (reader !== null) {
      const toolCallId = `codex-reader-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: `mcp.${reader[1]}.${reader[2]}`, kind: 'execute', status: 'in_progress', rawInput: { server: reader[1], tool: reader[2], arguments: {} }, _meta: { is_mcp_tool_call: true } })
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'no resources' } }] })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' The reader answered.' } })
      return { stopReason: 'end_turn' }
    }
    // An MCP call from codex-acp: no structured name at all, only `is_mcp_tool_call`.
    if (/mcp-call/.test(said)) {
      const toolCallId = `mcp-${session.turns}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: 'mcp.dsh.bash', kind: 'other', status: 'pending', _meta: { is_mcp_tool_call: true } })
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'answered' } }] })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' The MCP tool answered.' } })
      return { stopReason: 'end_turn' }
    }
    // Claude Code's own tools by their structured names, as in native-tools mode: `native-read`
    // is a Read that does not ask (its default mode lets reads through), `native-bash` a Bash
    // that asks first, `native-agent` an Agent call whose subagent's nested Bash asks while the
    // Agent call is still running. `native-agent-late` stamps the child's parent after asking.
    // A call that asks runs only when allowed; the trace says so.
    const native = /native-(read|bash|agent-late|agent)/.exec(said)
    if (native !== null) {
      const toolCallId = `native-${session.turns}`
      const ask = async (id, title, rawInput) => {
        const answer = await conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: id, title, kind: 'execute', rawInput },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
        })
        return answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome
      }
      const runBash = async (id, parent) => {
        const rawInput = { command: 'echo native' }
        const late = native[1] === 'agent-late'
        await update({ sessionUpdate: 'tool_call', toolCallId: id, name: 'Bash', title: 'echo native', kind: 'execute', status: 'pending', rawInput, _meta: { claudeCode: { toolName: 'Bash', ...(parent === undefined || late ? {} : { parentToolUseId: parent }) } } })
        const asking = ask(id, 'Run command?', rawInput)
        if (late) {
          if (/native-agent-late hold\b/.test(said)) {
            // The test signals from the reviewer once the unstamped row has been logged.
            const deadline = Date.now() + 5_000
            while (!existsSync('.native-agent-late-ready') && !session.cancelled) {
              if (Date.now() >= deadline) throw new Error('Timed out waiting for the late parent test signal')
              await new Promise(resolve => setTimeout(resolve, 10))
            }
          }
          if (!session.cancelled) await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', _meta: { claudeCode: { parentToolUseId: parent } } })
        }
        const answer = await asking
        if (answer === 'yes') {
          trace({ event: 'native-tool-ran', sessionId, toolCallId: id, name: 'Bash' })
          await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'native' } }] })
        } else {
          trace({ event: 'native-tool-refused', sessionId, toolCallId: id, name: 'Bash', answer })
          await update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Not allowed' } }] })
        }
        return answer
      }
      if (native[1] === 'read') {
        await update({ sessionUpdate: 'tool_call', toolCallId, name: 'Read', title: 'Read notes.txt', kind: 'read', status: 'pending', rawInput: { file_path: 'notes.txt' }, _meta: { claudeCode: { toolName: 'Read' } } })
        trace({ event: 'native-tool-ran', sessionId, toolCallId, name: 'Read' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'the notes' } }] })
        // "native-read hold": the turn then waits until it is cancelled, as "drift" does, so a
        // turn the drift detector cancels ends only once that cancel arrived (and was traced).
        if (/hold/.test(said)) {
          if (!session.cancelled) await new Promise((resolve) => { session.wake = resolve })
          return { stopReason: 'cancelled' }
        }
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' I read the notes.' } })
      } else if (native[1] === 'bash') {
        const answer = await runBash(toolCallId)
        if (session.cancelled || answer === 'cancelled') return { stopReason: 'cancelled' }
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer === 'yes' ? ' It printed native.' : ' I was not allowed to run it.' } })
      } else {
        await update({ sessionUpdate: 'tool_call', toolCallId, name: 'Agent', title: 'Look around', kind: 'think', status: 'pending', rawInput: { description: 'Look around', prompt: 'look', subagent_type: 'general-purpose' }, _meta: { claudeCode: { toolName: 'Agent' } } })
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
        const answer = await runBash(`${toolCallId}-child`, toolCallId)
        if (session.cancelled || answer === 'cancelled') return { stopReason: 'cancelled' }
        if (/native-agent twice/.test(said)) await runBash(`${toolCallId}-second-child`, toolCallId)
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `subagent report (${answer})` } }] })
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` The subagent reported (${answer}).` } })
      }
      return { stopReason: 'end_turn' }
    }
    // A tool call on the `dsh` bridge, by the name Claude Code puts on the wire. With "permit"
    // the call first asks session/request_permission, as Claude Code does in Manual; without it
    // the call runs with no ACP-level request at all, as it would in Auto.
    const respawn = /\bbridge(-respawn) (\S+)/.exec(current)
    const drop = /\bbridge-drop\b/.test(current)
    if (respawn !== null || drop) {
      const connection = session.mcp.get('dsh')
      session.mcp.delete('dsh')
      await connection?.stop()
      if (drop) return { stopReason: 'end_turn' }
      if (session.dshServer !== undefined) await attachServer(session, session.dshServer, sessionId)
    }
    const bridged = respawn ?? /bridge(-permit)? (\S+)/.exec(said)
    if (bridged !== null) {
      const permit = bridged[1] === '-permit'
      const name = bridged[2]
      const connection = session.mcp.get('dsh')
      const toolCallId = `bridge-${session.turns}`
      const structured = `mcp__dsh__${name}`
      const toolCall = { toolCallId, name: structured, title: structured, kind: 'other', status: 'pending', rawInput: {}, _meta: { claudeCode: { toolName: structured } } }
      await update({ sessionUpdate: 'tool_call', ...toolCall })
      let permitted = 'not-asked'
      if (permit) {
        const answer = await conn.requestPermission({
          sessionId,
          toolCall,
          options: [
            { optionId: 'yes', name: 'Allow', kind: process.env.FAKE_ACP_ALWAYS_ONLY === '1' ? 'allow_always' : 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        })
        permitted = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : answer.outcome.outcome
        if (permitted === 'cancelled') return { stopReason: 'cancelled' }
      }
      let text = 'the bridge is not connected'
      if (connection !== undefined) {
        try {
          const answer = await connection.request('tools/call', { name, arguments: {} })
          text = (answer.content ?? []).map(block => block.text ?? '').join('\n') || '(no text)'
        } catch (error) {
          text = `bridge failed: ${error?.message ?? error}`
        }
      }
      await update({ sessionUpdate: 'tool_call_update', toolCallId, status: session.cancelled ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text } }] })
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` The bridge said: ${text} (permit ${permitted})` } })
      return { stopReason: session.cancelled ? 'cancelled' : 'end_turn' }
    }
    // Codex's built-in image tool as codex-acp reports it: an `other` call titled "Image
    // generation" whose finished update carries the PNG (an ACP image block and rawOutput.result)
    // and a saved path under a Codex home that must never be opened; then a reply that links that
    // path, split across chunks. "image-call-fail" fails the call; "image-call-other" is a call
    // that makes no image but answers with one (a Read of a JPEG on disk).
    const imaged = /image-call(-fail|-other)?/.exec(said)
    if (imaged !== null) {
      const toolCallId = `image-${session.turns}`
      const other = imaged[1] === '-other'
      const title = other ? 'Read photo.jpg' : 'Image generation'
      await update({ sessionUpdate: 'tool_call', toolCallId, title, kind: other ? 'read' : 'other', status: 'in_progress', rawInput: { id: toolCallId } })
      if (imaged[1] === '-fail') {
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput: { status: 'failed' } })
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' It did not work.' } })
        return { stopReason: 'end_turn' }
      }
      const savedPath = '/fake-codex-home/generated_images/never-open-me.png'
      await update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: other
          ? [{ type: 'content', content: { type: 'text', text: 'Read photo.jpg' } }, { type: 'content', content: { type: 'image', data: '/9j/4AAQSkZJRgABAQ==', mimeType: 'image/jpeg', uri: '/work/photo.jpg' } }]
          : [{ type: 'content', content: { type: 'text', text: 'Revised prompt: a fox' } }, { type: 'content', content: { type: 'image', data: PNG, mimeType: 'image/png', uri: savedPath } }],
        ...(other ? {} : { rawOutput: { status: 'completed', revisedPrompt: 'a fox', result: PNG, savedPath } }),
      })
      for (const text of [' Here it is: ![a fox](/fake-codex-', 'home/generated_images/never-open-me.png)', ' Also at `/fake-codex-home/generated_', 'images/never-open-me.png`.']) {
        await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
      }
      return { stopReason: 'end_turn' }
    }
    const calls = /twice/.test(said) ? 2 : 1
    for (let n = 1; n <= calls; n++) {
      const toolCallId = `call-${session.turns}-${n}`
      const command = /ask edited/.test(said) ? 'echo first' : `echo hello ${n}`
      await update({ sessionUpdate: 'tool_call', toolCallId, title: `Run ${command}`, kind: 'execute', status: 'pending', rawInput: { command } })
      const answer = await conn.requestPermission({
        sessionId,
        toolCall: { toolCallId, title: `Run ${command}`, kind: 'execute', rawInput: { command: /ask edited/.test(said) ? 'echo second' : command } },
        options: [
          { optionId: 'yes', name: 'Allow', kind: process.env.FAKE_ACP_ALWAYS_ONLY === '1' ? 'allow_always' : 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      })
      if (session.cancelled || answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
      const allowed = answer.outcome.optionId === 'yes'
      if (allowed) {
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' })
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `hello ${n}` } }] })
      } else {
        await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Not allowed' } }] })
      }
      await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? ` It printed hello ${n}.` : ' I was not allowed to run it.' } })
    }
    return { stopReason: 'end_turn' }
  },
}

// Only a fake that offers modes takes `session/set_mode`; the others answer Method Not Found.
if (MODES.length > 0) {
  implementation.setSessionMode = async ({ sessionId, modeId }) => {
    // FAKE_ACP_REFUSE_MODES=a,b refuses those modes for permission tests.
    if ((process.env.FAKE_ACP_REFUSE_MODES ?? '').split(',').includes(modeId)) throw RequestError.invalidParams(undefined, `Refused mode: ${modeId}`)
    if (!MODES.includes(modeId)) throw RequestError.invalidParams(undefined, `Unknown mode: ${modeId}`)
    const session = sessions.get(sessionId)
    if (session !== undefined) session.mode = modeId
    trace({ event: 'set-mode', sessionId, modeId })
    return {}
  }
}

const conn = serveAgent(implementation, stream)
