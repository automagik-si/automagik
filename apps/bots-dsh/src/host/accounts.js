// Settings → Accounts (RFC 0030 deliveries 5c and 5b): this computer's Codex sign-in file, read only,
// and the Claude Code logins of this Herdr home, switched through the accounts CLI's set-login.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir as osHomedir } from 'node:os'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { fromWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'
import { compareVersions } from './lane-verify.js'

// ---- Codex (5c): the default sign-in file, read only ----
const CODEX_MAX_BYTES = 1 << 20
const OVERRIDE = 'AUTOMAGIK_ACCOUNTS_CODEX_HOME'
export const REFRESH = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:?\d\d)$/
const absolute = value => typeof value === 'string' && isAbsolute(value)
const observed = (file, account = null, lastRefresh = null) => ({ file, account, lastRefresh })

// Match the pack's fingerprint, including its UTF-16 code units.
function fingerprint(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) return null
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}

function parseAuth(text) {
  let auth
  try { auth = JSON.parse(text) } catch { return observed('present') }
  const account = fingerprint(auth?.tokens?.account_id)
  const refresh = auth?.last_refresh
  return observed('present', /^[0-9a-f]{8}$/.test(account ?? '') ? account : null,
    typeof refresh === 'string' && REFRESH.test(refresh) ? refresh : null)
}

async function readAuth(path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > CODEX_MAX_BYTES) return observed('unreadable')
    const bytes = Buffer.allocUnsafe(CODEX_MAX_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null)
      if (bytesRead === 0) break
      size += bytesRead
    }
    return size > CODEX_MAX_BYTES ? observed('unreadable') : parseAuth(bytes.toString('utf8', 0, size))
  } catch (error) {
    return observed(error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : 'unreadable')
  } finally {
    await file?.close()
  }
}

function installCodex(rt, { env, homedir }) {
  return windowEndpoint(rt, 'accounts-codex', async (_body, _signal, windowSeen) => {
    if (!fromWindow(windowSeen)) return { reason: 'desktop-only' }
    try {
      const home = absolute(env.HOME) ? env.HOME : homedir()
      const overridden = Object.hasOwn(env, OVERRIDE)
      const homeIsAbsolute = absolute(home)
      const fallback = homeIsAbsolute ? join(home, '.codex') : ''
      const given = overridden ? env[OVERRIDE] : fallback
      if (!absolute(given) || (overridden && (/\p{Cc}/u.test(given) || Buffer.byteLength(given) > 512))) {
        return { codex: { folder: '', ...observed('unreadable') }, proxy: 'unknown' }
      }
      const dir = normalize(given)
      const pathFromHome = homeIsAbsolute ? relative(home, dir) : dir
      const underHome = !isAbsolute(pathFromHome) && pathFromHome !== '..' && !pathFromHome.startsWith('..' + sep)
      const folder = underHome ? join('~', pathFromHome) : dir
      return { codex: { folder: folder.slice(0, 300), ...await readAuth(join(dir, 'auth.json')) }, proxy: 'unknown' }
    } catch {
      return { reason: 'failed', message: "Could not read this computer's accounts." }
    }
  }, { read: true })
}

// ---- Claude Code (5b): read through `accounts here`, switched through `set-login` ----
const SINCE = '3.160.3'
const MAX_BYTES = 65_536
const OFFER_MS = 120_000
const MAX_OFFERS = 4
const WRITER_MARKER = 'export const EXPECT_QUALIFIED = 1;'
// Same version and Claude field rules as the CLI's accountsRows.js.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const EMAIL = /^[^\s@\p{Cc}]{1,64}@[^\s@\p{Cc}]{1,190}$/u
const HASH = /^[a-f0-9]{64}$/
const SLOT_STATES = ['eligible', 'override', 'not-signed-in', 'bad-folder', 'ambiguous', 'timeout', 'failed']
const ROUTE_STATES = ['eligible', 'not-signed-in', 'timeout', 'failed', 'unresolved']
const WRITE_REFUSALS = new Map([
  ['conflict', 'conflict'], ['slot-changed', 'conflict'], ['timeout', 'conflict'],
  ['update-first', 'panel-old'], ['busy', 'busy'], ['home', 'home-mismatch'],
])

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const matches = (shape, value) => typeof value === 'string' && shape.test(value)
const emailOkay = value => value === null || (matches(EMAIL, value) && matches(EMAIL, value.toLowerCase()))
const digest = (id, email) => createHash('sha256').update(`${id}\n${email ?? ''}`).digest('hex')
const refusal = reason => ({ reason })

function isFile(path) {
  try { return statSync(path).isFile() } catch { return false }
}

function readPrefix(path, length) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) return null
    const bytes = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, null)
      if (count === 0) break
      offset += count
    }
    return bytes.subarray(0, offset)
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

function candidate(kind, path) {
  if (!isAbsolute(path)) return null
  let dir
  try { dir = realpathSync(path) } catch { return null }
  const has = file => isFile(join(dir, file))
  if (!has('bin/automagik-herdr.mjs') || !has('bin/run.sh')) return null
  const version = readPrefix(join(dir, 'VERSION'), 66)?.toString('utf8').split(/\r?\n/, 1)[0]
  const reader = version?.length <= 64 && VERSION.test(version) && compareVersions(version, SINCE) >= 0
    && has('bin/accounts.mjs') && has('accountsHere.js')
  const source = reader ? readPrefix(join(dir, 'accountsWrite.js'), MAX_BYTES + 1) : null
  const writer = source !== null && source.length <= MAX_BYTES && source.toString('utf8').split(/\r?\n/).includes(WRITER_MARKER)
  return { kind, dir, version, reader, writer }
}

function discover(env) {
  const home = env.HOME || osHomedir()
  const appHome = (env.HERDR_APP_HOME || `${home}/.config/herdr-app`).replace(/\/+$/, '')
  const override = Object.hasOwn(env, 'AUTOMAGIK_AM_DIR')
  const found = (override
    ? [candidate('override', env.AUTOMAGIK_AM_DIR ?? '')]
    : [candidate('pack', join(appHome || '/', 'mods/am-sidebar')),
      candidate('am', join(env.AM_HOME || `${home}/.automagik`, 'parts/automagik.am/current'))]).filter(Boolean)
  // Stable sorting keeps the pack first at equal version precedence.
  const readers = found.filter(cli => cli.reader).sort((a, b) => compareVersions(b.version, a.version))
  return { home, appHome, reader: readers[0], writer: readers.find(cli => cli.writer),
    reason: !override && found.length ? 'old-cli' : 'not-installed' }
}

export function runAccounts(cli, args, { cwd, env, timeout }) {
  return new Promise(resolve => {
    const child = execFile('sh', [join(cli.dir, 'bin/run.sh'), join(cli.dir, 'bin/accounts.mjs'), ...args], {
      cwd, env, timeout, encoding: 'buffer', maxBuffer: MAX_BYTES, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || stdout.length > MAX_BYTES) return resolve(refusal('cli-protocol'))
      if (error?.killed || error?.signal) return resolve(refusal('cli-timeout'))
      if (error && typeof error.code !== 'number') return resolve(refusal('cli-error'))
      resolve({ code: error?.code ?? 0, stdout })
    })
    // Drain stderr without retaining it in execFile's buffers or letting it limit stdout.
    child.stderr.removeAllListeners('data')
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdin.end()
  })
}

function parseReply(stdout) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)) } catch { return null }
}

// Exactly the CLI's writerQualified predicate with write=true (accountsWrite.js).
function writerQualified(writer) {
  if (writer?.setLogin !== true || !['on', 'off', 'absent', 'unknown'].includes(writer.panel)
    || !['panelWrites', 'sidebarWrites', 'confirmed'].every(key => typeof writer[key] === 'boolean')
    || Object.keys(writer).length !== 5) return false
  return writer.panel === 'off' || writer.panel === 'absent'
    || (writer.panel === 'on' && writer.panelWrites && writer.sidebarWrites && writer.confirmed)
}

function projectClaude(claude) {
  if (!object(claude)) return null
  const { record, snapshot, selected, effective, email, state, slotsComplete, slots, routes } = claude
  // A delivery-1 answer predates the route fields: its rows still show, and it never offers a switch.
  const route = routes?.record?.state ?? null
  if (!['ok', 'absent', 'bad'].includes(record) || !(snapshot === null || matches(HASH, snapshot))
    || (record === 'ok' && snapshot === null) || (record === 'absent' && snapshot !== null)
    || !matches(ID, selected) || !matches(ID, effective) || !emailOkay(email)
    || !(SLOT_STATES.includes(state) || state === 'unresolved') || !(route === null || ROUTE_STATES.includes(route))
    || typeof slotsComplete !== 'boolean' || !Array.isArray(slots)) return null

  const rows = []
  const ids = new Set()
  for (const slot of slots) {
    if (!object(slot) || !matches(ID, slot.id) || ids.has(slot.id) || !emailOkay(slot.email)
      || !SLOT_STATES.includes(slot.state)) return null
    const { id } = slot
    ids.add(id)
    rows.push({ id, label: id === 'default' ? 'default' : 'slot', email: slot.email?.toLowerCase() ?? null,
      state: slot.state, selected: id === selected, effective: id === effective, use: false })
  }
  return { rows, snapshot, effective, email: email?.toLowerCase() ?? null, slotsComplete,
    fallback: record === 'bad' || selected !== effective, launcher: state === 'unresolved' || route === 'unresolved',
    switchable: route !== null && (state === 'eligible' || state === 'not-signed-in') }
}

function readWhy(answer, appHome, writer) {
  if (answer.writer == null) return 'old-cli'
  if (typeof answer.appHome !== 'string' || !isAbsolute(answer.appHome) || answer.appHome !== appHome) return 'home-mismatch'
  if (answer.claude === null) return 'unreadable'
  if (!writer) return 'old-cli'
  if (!writerQualified(answer.writer)) return answer.writer.panel === 'on' ? 'panel-old' : 'panel-unknown'
}

export function install(rt, { env = process.env, homedir = osHomedir, platform = process.platform, now = Date.now, run = runAccounts } = {}) {
  const offCodex = installCodex(rt, { env, homedir })
  let pending = Promise.resolve()
  let epoch = 0
  const offers = new Map()
  const unknown = () => {
    offers.clear()
    epoch += 1
    return refusal('unknown')
  }
  const canWrite = gen => rt.sameTeam(gen) === true && rt.readOnly() === undefined
  const unavailable = () => platform === 'win32' ? 'unavailable'
    : Object.hasOwn(env, 'AUTOMAGIK_AGENT_HOME_LAUNCH') ? 'chosen-home' : undefined

  const offRead = windowEndpoint(rt, 'accounts-claude', async (_body, _signal, proof) => {
    if (!fromWindow(proof)) return refusal('desktop-only')
    try {
      const blocked = unavailable()
      if (blocked) return refusal(blocked)
      const gen = rt.teamGeneration()
      const readEpoch = epoch
      const { home, appHome, reader, writer, reason } = discover(env)
      if (!reader) return refusal(reason)
      const result = await run(reader, ['here', '--within', '15', '--json'], { cwd: home, env, timeout: 20_000 })
      if (result.reason) return refusal(result.reason)
      if (result.code !== 0) return refusal('cli-error')
      const answer = parseReply(result.stdout)
      if (!object(answer) || answer.v !== 1 || answer.kind !== 'accounts.here') return refusal('cli-protocol')
      const why = readWhy(answer, appHome, writer)
      if (answer.claude === null) return { why }
      const claude = projectClaude(answer.claude)
      if (!claude) return refusal('cli-protocol')

      const { rows, fallback, launcher, snapshot } = claude
      const readOnly = !canWrite(gen) || rt.canWriteTeam?.() === false
      const view = { rows, fallback, launcher, readOnly, ...(why ? { why } : {}) }
      if (why || readOnly || readEpoch !== epoch || fallback || launcher || !claude.switchable || !claude.slotsComplete) return view
      const slots = new Map()
      for (const row of rows) {
        if (row.state !== 'eligible' || !row.email || row.effective || (snapshot === null && row.id !== 'default')) continue
        row.use = true
        slots.set(row.id, digest(row.id, row.email))
      }
      if (slots.size === 0) return view
      const token = randomBytes(16).toString('hex')
      offers.set(token, { at: now(), appHome, cli: writer, gen, slots, snapshot: snapshot ?? 'none',
        effDigest: digest(claude.effective, claude.email) })
      if (offers.size > MAX_OFFERS) offers.delete(offers.keys().next().value)
      return { ...view, token }
    } catch {
      return refusal('cli-error')
    }
  }, { read: true })

  const write = async body => {
    try {
      const { id, token } = body ?? {}
      const offer = offers.get(token)
      offers.delete(token)
      const blocked = unavailable()
      if (blocked) return refusal(blocked)
      if (!offer || now() - offer.at >= OFFER_MS || !offer.slots.has(id)) return refusal('changed')
      const { home, appHome, writer } = discover(env)
      if (appHome !== offer.appHome || !writer || writer.kind !== offer.cli.kind || writer.dir !== offer.cli.dir
        || writer.version !== offer.cli.version) return refusal('changed')
      const args = ['set-login', '--use', id, '--snapshot', offer.snapshot, '--expect-home', appHome,
        '--expect-slot', offer.slots.get(id), '--expect-eff', offer.effDigest, '--expect-qualified', '--json']
      if (!canWrite(offer.gen)) return refusal('read-only')
      const result = await run(writer, args, { cwd: home, env, timeout: 30_000 })
      if (result.reason === 'cli-error') return refusal('failed')
      if (result.reason) return unknown()
      if (result.code === 2) return refusal('failed')
      const answer = parseReply(result.stdout)
      if (!object(answer)) return unknown()
      if (result.code === 1) return refusal(WRITE_REFUSALS.get(answer.error) ?? 'failed')
      if (result.code === 0 && answer.ok === true && answer.use === id && matches(HASH, answer.snapshot)
        && Object.keys(answer).length === 3) return { switched: true }
      return unknown()
    } catch {
      // A child error can contain argv and output. Keep only the fixed outcome.
      return unknown()
    }
  }
  const offWrite = windowEndpoint(rt, 'accounts-claude-use', (body, _signal, proof) => {
    if (!fromWindow(proof)) return refusal('desktop-only')
    const next = pending.then(() => write(body))
    pending = next
    return next
  })

  return () => { offCodex(); offRead(); offWrite(); offers.clear(); epoch += 1 }
}
