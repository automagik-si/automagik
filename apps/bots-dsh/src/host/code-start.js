// New › Start an existing Bot, from the Code tree (RFC 0030 delivery 6a, Q17 (a)): one owner-only,
// desktop-window-only endpoint that starts a not-running Bot of this computer's projects through
// the pack CLI's local-only start (`am start <id> --project DIR --local-only --json`, herdr lane,
// v3.167.0). The CLI starts the pane and writes the attach ledger; this file only decides whether
// to ask it, and how.
//
// The page sends a Bot id and nothing else. The folder comes from this computer's registry, read
// fresh over a connection pinned to the core socket that answered and decided again just before
// the start; the CLI's module comes from the installers' own folders (the pack's mod, am's part,
// laid out as their installers keep them), never from PATH or ~/.local/bin, and runs on this
// host's own Node. The child gets that socket and a PATH of absolute folders outside the project,
// and is never killed: a start that takes longer than the page waits answers `pending`, and the
// page reads the tree again. The answer is a fixed outcome word; the CLI's output, paths and argv
// never reach the page.
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isSea } from 'node:sea'
import { isBotId } from '../shared/registry.js'
import { connectCore } from './code-core.js'
import { FALLBACK_PATH, inProjects, inside, linkIntoProjects, startEnv } from './code-env.js'
import { checkoutRoots, effectiveKey, readCodeTree, readRegistryTree, startTarget } from './code-tree.js'
import { probeCore } from './core-probe.js'
import { appBrowserBridge } from './constants.js'
import { fromWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'
import { compareVersions } from './lane-verify.js'

export const CODE_START_ENDPOINT = 'code-start'
/** The first release whose CLI takes `--local-only` (#1976). */
export const LOCAL_ONLY_SINCE = '3.167.0'
/** How long the page waits for a start before it gets `pending`; the start itself goes on. */
export const START_WAIT_MS = 25_000
/** What is kept of each of the child's streams; the rest is read and dropped. */
export const MAX_STREAM_BYTES = 1024 * 1024
/** After the child exits, how long its pipes may stay open before its output is read as it is. */
export const CLOSE_GRACE_MS = 2_000
export { FALLBACK_PATH, startEnv }
/** Every answer the endpoint gives, as `{ outcome }`. */
export const START_OUTCOMES = Object.freeze([
  'started', 'already-running', 'pending', 'busy', 'desktop-only', 'invalid', 'read-only', 'not-this-computer',
  'global-bot', 'folder-missing', 'ambiguous-clone', 'not-in-roster', 'unverified', 'not-startable', 'held-elsewhere',
  'no-core', 'update-am', 'no-cli', 'start-failed', 'unknown',
])

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
// This computer's own terminal id, as the CLI's isHcTerminalId: never a linked machine's `lab/t3`.
const TERMINAL = /^t[0-9a-z]+$/
// A refusal counts only with the exit code the CLI gives it (localStartRefusal).
const REFUSED = new Map([
  ['no-folder', [2, 'folder-missing']], ['no-roster', [1, 'not-in-roster']], ['not-in-roster', [1, 'not-in-roster']],
  ['not-startable', [1, 'not-startable']], ['held-elsewhere', [1, 'held-elsewhere']], ['no-core', [1, 'no-core']],
  // Refused before anything was launched. (incomplete-identity can also come after the launch:
  // it is unknown, as any other exit 1.)
  ['no-name', [1, 'start-failed']],
])
const OLD_CLI = "am: Unknown option '--local-only'"

const answer = outcome => ({ outcome })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const real = (path) => { try { return realpathSync(path) } catch { return null } }
// A real folder, not a link to one, owned by this user.
const mine = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid()
const ownFolder = (path) => {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && mine(stat)
  } catch { return false }
}
// A configured home: the entry itself (a folder, or a link to one) and the folder it resolves to
// both belong to this user, as am's own requireStore checks. Its real path, or null.
const ownHome = (path) => {
  try {
    if (!mine(lstatSync(path))) return null
    const home = realpathSync(path)
    return ownFolder(home) ? home : null
  } catch { return null }
}

function firstLine(path, length = 66) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return null
    const bytes = Buffer.alloc(length)
    const count = readSync(fd, bytes, 0, length, null)
    return bytes.subarray(0, count).toString('utf8').split(/\r?\n/, 1)[0]
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}

/** One installed CLI in `dir` (already checked to be in its store), or null. */
function candidate(kind, dir) {
  const file = (name) => {
    const at = real(join(dir, name))
    try { return at && inside(dir, at) && statSync(at).isFile() ? at : null } catch { return null }
  }
  const entry = file('bin/automagik-herdr.mjs')
  if (!entry) return null
  const versionFile = file('VERSION')
  const version = versionFile ? firstLine(versionFile) : null
  const known = typeof version === 'string' && version.length <= 64 && VERSION.test(version)
  return { kind, dir, entry, version: known ? version : null, localOnly: known && compareVersions(version, LOCAL_ONLY_SINCE) >= 0 }
}

/**
 * am's installed release, laid out as am's own installer keeps it (am/lib/self.mjs requireStore,
 * placeExtract): the configured home may be a link, `parts/automagik.am` are real folders of this
 * user, and `current` names a release folder directly inside that store.
 */
function amRelease(amHome) {
  const home = ownHome(amHome)
  if (!home) return null
  const store = join(home, 'parts', 'automagik.am')
  if (!ownFolder(join(home, 'parts')) || !ownFolder(store)) return null
  const release = real(join(store, 'current'))
  return release && dirname(release) === store && !basename(release).startsWith('.') ? release : null
}

/** The pack's sidebar mod: `mods/am-sidebar` as real folders in herdr-app's home. */
function packRelease(appHome) {
  const home = ownHome(appHome)
  if (!home) return null
  const mods = join(home, 'mods')
  const mod = join(mods, 'am-sidebar')
  return ownFolder(mods) && ownFolder(mod) ? mod : null
}

/**
 * The CLI a start runs: the pack's mod or am's part, whichever is newer and takes `--local-only`
 * (am at an equal version). `{ cli }`, or `{ outcome }` when none is installed (`no-cli`) or
 * every installed one is older (`update-am`).
 */
export function resolveStartCli(env = process.env, homedir = osHomedir, checkouts = []) {
  const home = resolve(env.HOME || homedir())
  const appHome = resolve(env.HERDR_APP_HOME || join(home, '.config', 'herdr-app'))
  const amHome = resolve(env.AM_HOME || join(home, '.automagik'))
  const am = amRelease(amHome)
  const pack = packRelease(appHome)
  // An installation inside a checkout is the project's code, never a CLI to run.
  const found = [am && candidate('am', am), pack && candidate('pack', pack)]
    .filter(cli => cli && !inProjects(cli.dir, checkouts) && !inProjects(cli.entry, checkouts))
  if (found.length === 0) return answer('no-cli')
  // Stable sort: am stays first at equal versions.
  const ready = found.filter(cli => cli.localOnly).sort((a, b) => compareVersions(b.version, a.version))
  return ready.length ? { cli: ready[0] } : answer('update-am')
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return null }
}

/** The page's outcome for one finished CLI run. */
export function startOutcome(botId, { code, signal, stdout, stderr, truncated = false, closed = true }) {
  if (signal === 'spawn') return 'start-failed'
  // Killed by someone else, or output still coming when it was read: a pane may be up.
  if (signal || !closed) return 'unknown'
  const reply = truncated ? null : parseJson(stdout)
  if (code === 0) {
    if (!record(reply) || reply.id !== botId) return 'unknown'
    if (typeof reply.terminal === 'string' && TERMINAL.test(reply.terminal) && !Object.hasOwn(reply, 'running')) return 'started'
    if (typeof reply.running === 'string' && TERMINAL.test(reply.running) && !Object.hasOwn(reply, 'terminal')) return 'already-running'
    return 'unknown'
  }
  const known = record(reply) && typeof reply.refused === 'string' ? REFUSED.get(reply.refused) : undefined
  if (known && known[0] === code) return known[1]
  if (code === 2) return stderr.toString('utf8').split('\n', 1)[0].startsWith(OLD_CLI) ? 'update-am' : 'start-failed'
  // Exit 1 without a refusal made before the launch: a pane may be up (an attach row that could
  // not be written, an address the CLI would not trust). The page reads the tree again.
  return 'unknown'
}

/** Keep the first `MAX_STREAM_BYTES` of a stream, and drain the rest. */
function collect(stream) {
  const chunks = []
  let size = 0
  let truncated = false
  stream.on('data', (chunk) => {
    if (size >= MAX_STREAM_BYTES) { truncated = true; return }
    const part = chunk.subarray(0, MAX_STREAM_BYTES - size)
    if (part.length < chunk.length) truncated = true
    chunks.push(part)
    size += part.length
  })
  stream.on('error', () => {})
  return () => ({ bytes: Buffer.concat(chunks), truncated })
}

/**
 * The runtime that runs the CLI's module: this host's own Node, never one found on a PATH. In the
 * desktop that is Electron's binary run as Node, as the desktop runs DSH itself; a host built as
 * a single executable cannot run another module, so it has none.
 */
export function startRuntime() {
  if (isSea()) return null
  return { node: process.execPath, env: process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * Run one start, never killing it. `exited` settles when the child exits (or could not start);
 * `result` once its output is read: at its pipes' close, or `CLOSE_GRACE_MS` after it exited.
 */
export function runStart(cli, argv, { cwd, env, runtime, spawn: spawnProcess = spawn }) {
  let child
  try {
    child = spawnProcess(runtime.node, [cli.entry, ...argv], { cwd, env: { ...env, ...runtime.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  } catch {
    const failed = Promise.resolve({ code: null, signal: 'spawn', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })
    return { exited: failed, result: failed }
  }
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  let exitedWith = null
  const exited = new Promise((done) => {
    child.once('error', () => { exitedWith ??= { code: null, signal: 'spawn' }; done() })
    child.once('exit', (code, signal) => { exitedWith ??= { code, signal }; done() })
  })
  const result = new Promise((done) => {
    let timer
    let finished = false
    const finish = (closed) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      const out = stdout()
      const err = stderr()
      done({ ...exitedWith, stdout: out.bytes, stderr: err.bytes, truncated: out.truncated, closed })
    }
    child.once('close', () => { void exited.then(() => finish(true)) })
    void exited.then(() => {
      timer = setTimeout(() => finish(false), CLOSE_GRACE_MS)
      timer.unref?.()
    })
  })
  return { exited, result }
}

/** The folders and files the CLI reads its settings from, as it finds them, defaults included. */
export function settingsPaths(env) {
  const home = typeof env.HOME === 'string' && isAbsolute(env.HOME) ? env.HOME : null
  const or = (value, fallback) => (typeof value === 'string' && isAbsolute(value) ? value : fallback)
  const appHome = or(env.HERDR_APP_HOME, home && join(home, '.config', 'herdr-app'))
  return [
    home,
    appHome, appHome && join(appHome, 'programs.json'),
    or(env.XDG_CONFIG_HOME, home && join(home, '.config')),
    or(env.XDG_STATE_HOME, home && join(home, '.local', 'state')),
    or(env.AM_HOME, home && join(home, '.automagik')),
    or(env.AUTOMAGIK_HOME, home && join(home, '.automagik')),
  ].filter(Boolean)
}

// One start at a time in this host process, across reinstalls of the plugin: held from admission
// until the child exits.
let slot = null

/**
 * Install the endpoint on a running team.
 * @param {any} rt the team runtime
 * @param {{ env?: NodeJS.ProcessEnv, desktop?: boolean, probe?: typeof probeCore, connect?: typeof connectCore,
 *   readTree?: typeof readCodeTree, target?: typeof startTarget, spawn?: typeof spawn, homedir?: () => string,
 *   waitMs?: number, runtime?: typeof startRuntime }} [options]
 */
export function install(rt, {
  env = process.env, desktop = appBrowserBridge(), probe = probeCore, connect = connectCore,
  readTree = readCodeTree, target = startTarget, spawn: spawnProcess = spawn, homedir = osHomedir, waitMs = START_WAIT_MS,
  runtime = startRuntime,
} = {}) {
  const warn = (text) => rt.warn?.(`omni-ui: ${text}`)
  let disposed = false
  const canWrite = gen => !disposed && rt.sameTeam?.(gen) === true && rt.readOnly?.() === undefined

  async function start(botId, gen, hold) {
    const socket = await probe(env)
    if (socket === null) return 'no-core'
    // The tree read chooses its own hc, never one inside a project (code-tree.js readCodeTree).
    const read = await readTree({ env, warn, connect: options => connect({ ...options, socket }) })
    if (!read.tree) return read.reason === 'no-core' ? 'no-core' : 'not-this-computer'
    const project = read.tree.projects.find(group => group.bots.some(bot => bot.id === botId))
    const bot = project?.bots.find(row => row.id === botId)
    if (!bot) return 'not-this-computer'
    if (bot.status !== 'not-running') return 'already-running'
    if (project.global === true) return 'global-bot'
    if (bot.blocked) return bot.blocked
    if (typeof project.folder !== 'string' || !isAbsolute(project.folder)) return 'not-this-computer'
    const node = runtime()
    if (!node) return 'start-failed'
    // Decided again from the registry and the project's files, as close to the start as it gets:
    // a grant withdrawn, a folder moved, a clone added or another launch folder starts nothing.
    const fresh = await target(botId, { env })
    if (!fresh || fresh.folder !== project.folder) return 'not-this-computer'
    if (fresh.blocked) return fresh.blocked
    if (fresh.key !== (project.launch ?? project.folder)) return 'not-this-computer'
    // And from git itself, as the CLI asks it, whatever the folder's files suggest.
    const avoid = checkoutRoots(readRegistryTree({ env }).projects.map(group => group.folder), new Map([[project.folder, fresh.key]]))
    const asked = await effectiveKey(project.folder, env, avoid, { askAlways: true })
    if (asked === null) return 'unverified'
    if (asked !== fresh.key) return 'not-this-computer'
    const checkouts = [project.folder, fresh.key]
    const resolved = resolveStartCli(env, homedir, checkouts)
    if (!resolved.cli) return resolved.outcome
    const childEnv = startEnv(env, socket, checkouts)
    // Where the CLI reads its own settings (its program table among them), defaults included, may
    // not be a checkout.
    if (settingsPaths(childEnv).some(path => inProjects(real(path) ?? path, checkouts))) return 'start-failed'
    // Any program the CLI runs by name comes from a folder it searches: none of their links may
    // lead into the checkout the start is for.
    if (linkIntoProjects(childEnv, checkouts, [dirname(node.node)])) return 'start-failed'
    // The team's lock may have moved meanwhile: only a writer starts.
    if (!canWrite(gen)) return 'read-only'
    const argv = ['start', botId, '--project', project.folder, '--local-only', '--json']
    const run = runStart(resolved.cli, argv, { cwd: project.folder, env: childEnv, runtime: node, spawn: spawnProcess })
    hold(run.exited)
    void run.result.then(result => warn(`a Code start ended: ${startOutcome(botId, result)} (exit ${result.code ?? result.signal})`))
    let timer
    const late = new Promise((done) => {
      timer = setTimeout(() => done('pending'), waitMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([run.result.then(result => startOutcome(botId, result)), late])
    } finally { clearTimeout(timer) }
  }

  const off = windowEndpoint(rt, CODE_START_ENDPOINT, async (body, _signal, proof) => {
    if (!desktop || !fromWindow(proof)) return answer('desktop-only')
    if (!record(body) || Object.keys(body).length !== 1 || !isBotId(body.botId)) return answer('invalid')
    if (slot) return answer('busy')
    const gen = rt.teamGeneration?.()
    if (!canWrite(gen)) return answer('read-only')
    // Held from here, so a second request while this one reads the tree is busy too; a spawned
    // start hands the slot to its child's exit.
    const held = {}
    slot = held
    let child = null
    try {
      // A spawned start frees the slot when its child exits, whenever that is.
      return answer(await start(body.botId, gen, (exited) => {
        child = exited
        void exited.then(() => { if (slot === held) slot = null })
      }))
    } catch {
      return answer('start-failed')
    } finally {
      if (!child && slot === held) slot = null
    }
  })
  return () => { disposed = true; off() }
}
