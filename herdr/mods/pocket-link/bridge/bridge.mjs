#!/usr/bin/env node
// Pocket Link bridge: lets paired phones reach this machine's herdr-core over iroh
// (dial by key, direct when it can, an end-to-end encrypted relay when it can't).
//
//   node bridge.mjs serve            run the bridge (the mod starts it; `install` keeps it running at login)
//   node bridge.mjs pair [minutes]   make a one-time pairing link and QR, print {code, link, expires, rows}
//   node bridge.mjs status           print {running, id, ticket, devices, pairing, login, state}
//   node bridge.mjs start | stop     start the bridge detached; stop it (and its login service)
//   node bridge.mjs cancel [challenge-id]  end this caller’s pairing code (or the current code without an argument)
//   node bridge.mjs copied [challenge-id]  the link was copied: shorten its code to 2 minutes, print {expires}
//   node bridge.mjs forget <id>      remove a paired phone (the running bridge does, over bridge.sock: devices.mjs)
//   node bridge.mjs reset            change the desktop key and unpair every phone
//   node bridge.mjs install|uninstall   start at login (LaunchAgent on macOS, systemd user unit on Linux)
//
// What a stranger can make it do before pairing is bounded in guard.mjs; the code itself in pairing.mjs.
//
// State lives outside the mod folder (see state.mjs), so reinstalling the mod keeps the pairings.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, linkSync, renameSync, chmodSync, unlinkSync, rmSync, closeSync } from 'node:fs'
import { homedir, hostname, platform } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptOne, assertSafeLogs, openAppendLog, slots, throttle, rotateLog, routesFor, endRemoved, sessionName, ALPN } from './guard.mjs'
import { ChatConnection, ChatEngines, chatWriter } from './chat.mjs'
import { DshSource, withDsh } from './dsh-source.mjs'
import { createEngine } from '../chat/engine.js'
import { acceptPairing, cancelCode, challengeId, discardGrant, shortenCode, fingerprint, desktopFingerprint, GRANT, resumePairing } from './pairing.mjs'
import { pipeSession } from './pipe.mjs'
import { open as openState, stateDir } from './state.mjs'
import { presence, publicStatus, writePublic, HEARTBEAT } from './presence.mjs'
import { store, listen, unlinkOwn, forget, bridgeState, claim, startedAt, withLock, SOCKET } from './devices.mjs'
import { keeper, resetKey, wipe } from './reset.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { LABEL, assertNoPurge, assertStandalone, assertStateOwner, definitionDigest, managerLock, matchesJob, ownsJob,
  processAlive, readService, sameProcess, serviceFile, serviceManager, servesEntry, stateLock, storeForEntry, underLock } from './service.mjs'
import { servicePaths, unitArg, xml } from './service-paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SESSION = [...Buffer.from(ALPN.session)]
const PAIR = [...Buffer.from(ALPN.pair)]
// The chat (RFC 0015): an older bridge does not offer it, and the phone falls back to the terminal.
const CHAT = [...Buffer.from(ALPN.chat)]

// launchd and detached starts redirect stderr. On systemd and in a terminal, write the log too.
let files = null
const log = (...args) => {
  const line = `${new Date().toISOString()} ${args.join(' ')}\n`
  process.stderr.write(line)
  if (files && (process.stderr.isTTY || (command === 'serve' && platform() === 'linux' && !process.env.POCKET_LINK_DETACHED))) {
    try {
      const fd = openAppendLog(files.log)
      try { writeFileSync(fd, line) } finally { closeSync(fd) }
    } catch {}
  }
}
// Outside the mod folder (state.mjs); the first run moves an older <mod>/.state there.
// `dir` is the old one only while an older bridge still runs from it; `target` is where it belongs.
const STATE_HOME = stateDir({ env: process.env, home: homedir() })
let STATE
function loadState(readOnly = false) {
  STATE = readOnly ? STATE_HOME : openState({ env: process.env, home: homedir(), modRoot: join(HERE, '..'), log }).dir
  files = {
    key: join(STATE, 'secret.key'), status: join(STATE, 'status.json'), devices: join(STATE, 'devices.json'),
    pairing: join(STATE, 'pairing.json'), log: join(STATE, 'bridge.log'), socket: join(STATE, SOCKET),
  }
  phoneList = store(files.devices)
}
// Lines any peer can cause, before it is trusted: at most a few of each kind a minute.
const refused = throttle(log)
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
// Atomic, owner-only writes: a reader never sees half a file.
const writeJson = (path, value) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path) }
const devices = () => readJson(files.devices, [])
// The running bridge owns devices.json; `forget` and `reset` ask it over bridge.sock.
let phoneList

let Endpoint, EndpointTicket, SecretKey
const generate = () => Buffer.from(SecretKey.generate().toBytes())
const CHANGING_KEY = "Pocket Link is changing this computer's key. Try again in a moment."
const BIND_FAILED = 'The key changed and every phone was unpaired, but the bridge could not start on the new key. Turn off Pocket Link and Turn on.'
const PUBLISH_FAILED = 'The key changed and every phone was unpaired, but the bridge could not record its new address. Turn off Pocket Link and Turn on.'

/** hc as the desktop finds it: HC, PATH, then the usual install places (a login service has a short PATH). */
function hcPath() {
  const candidates = [process.env.HC, join(homedir(), '.local/bin/hc'), '/opt/homebrew/bin/hc', '/usr/local/bin/hc'].filter(Boolean)
  try { candidates.unshift(execFileSync('/bin/sh', ['-lc', 'command -v hc || command -v herdr-core'], { encoding: 'utf8' }).trim().split('\n')[0]) } catch {}
  return candidates.find(p => p && existsSync(p)) ?? 'hc'
}

// The header is in (guard.mjs read it, within its deadline). Synchronous from reading pairing.json to
// writing it, so two tries at once can't both count from the same state.
async function pairPhone({ bi, value, peer: phone }, pending) {
  // The phone hangs up as soon as it has the reply, which can fail finish(); nothing to do about it then.
  const reply = value => bi.send.writeAll([...Buffer.from(JSON.stringify(value) + '\n')]).then(() => bi.send.finish()).catch(() => {})
  const { verdict, name } = acceptPairing(STATE, phoneList, { pending, peer: phone, code: value?.code, device: value?.device })
  if (verdict === 'gone') return reply({ ok: false, error: 'This pairing code was already used or has expired. Make a new one on the desktop.' })
  if (verdict === 'locked') { refused('pair', 'too many wrong codes from', fingerprint(phone)); return reply({ ok: false, error: 'Too many wrong codes from this phone. Make a new code on the desktop.' }) }
  if (verdict === 'wrong') { refused('pair', 'wrong code from', fingerprint(phone)); return reply({ ok: false, error: 'That code is not the one on the desktop.' }) }
  log('pair: added', name, fingerprint(phone))
  return reply({ ok: true, name: pending.name })
}

// Sessions now open, so removing a phone also ends what it has open.
const live = new Set()
// The phones those sessions belong to, for public-status.json (presence.mjs), the file other mods read.
let serving = false
const publishPublic = () => { try { writePublic(STATE, publicStatus({ running: serving, phones: phones.phones() })) } catch (e) { log('public status:', e.message) } }
const phones = presence({ changed: () => { if (serving) publishPublic() } })
// End a removed phone's terminal sessions and chats (guard.mjs endRemoved).
function revoke() { endRemoved(live, new Set(devices().map(d => d.id)), log) }

// Admitted (a paired key) and its header read, by guard.mjs.
async function session({ conn, bi, value, rest, peer: phone }) {
  const device = devices().find(d => d.id === phone)
  if (!device) { conn.close(1n, [...Buffer.from('not paired')]); return } // removed since it was admitted
  const name = sessionName(value)
  // Read again: a phone removed meanwhile must stay removed.
  phoneList.touch(phone)
  log('session:', device.name, 'session', name)
  const hc = spawn(hcPath(), ['connect'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HC_SESSION: name } })
  hc.on('error', e => {
    log('session: hc failed:', e.message)
    conn.close(2n, [...Buffer.from('hc failed')])
  })
  const open = { phone, conn, hc, end: () => { hc.kill(); try { conn.close(1n, [...Buffer.from('not paired')]) } catch {} } }
  live.add(open)
  // Counted from here until the phone hangs up or hc exits (a removed phone's hc is killed), whichever comes first.
  const close = phones.open(phone, device.name)
  hc.on('exit', close); hc.on('close', close)
  try { await pipeSession({ hc, conn, bi, rest, log, onClosed: () => live.delete(open) }) }
  finally { close() }
}

// The chat's engines, one per hc session name (chat.mjs), each reaching herdr-core through its
// own `hc connect` with that session and no HC_TERMINAL_ID (chat/engine.js chatEnv).
const appHome = () => (process.env.HERDR_APP_HOME?.startsWith('/') ? process.env.HERDR_APP_HOME : join(homedir(), '.config/herdr-app'))
const engines = new ChatEngines({
  make: name => createEngine({ home: homedir(), appHome: appHome(), hcPath: hcPath(), env: { ...process.env, HC_SESSION: name }, log }),
})
// The Automagik Bots' chats, from bots-dsh's owner-only socket in the team home (#517); absent, it
// lists nothing. Writes go to it only when it answered `write: 1` (dsh-source.mjs). It also serves
// the team's group chats for a phone that asks (RFC 0040).
const dsh = new DshSource({ log, attachments: true, documents: true, groups: true })

// Admitted (a paired key) and its header read, by guard.mjs, on the chat route.
async function chatRoute({ conn, bi, value, rest, peer: phone }) {
  const device = devices().find(d => d.id === phone)
  if (!device) { conn.close(1n, [...Buffer.from('not paired')]); return } // removed since it was admitted
  const name = sessionName(value)
  log('chat:', device.name, 'session', name)
  let revoked = false
  let chat = null
  const open = { phone, conn, end: () => { revoked = true; chat?.close('not paired'); try { conn.close(1n, [...Buffer.from('not paired')]) } catch {} } }
  const engine = engines.acquire(name, open, phone)
  if (!engine) { conn.close(3n, [...Buffer.from('too many chat sessions')]); return }
  live.add(open)
  const close = phones.open(phone, device.name)
  const write = chatWriter({
    send: bytes => bi.send.writeAll([...bytes]),
    isClosed: () => chat.closed,
    isRevoked: () => revoked,
    onFail: () => chat.close('write failed'),
  })
  chat = new ChatConnection({
    // by: the phone's name, which the socket records with an answer (who answered on the phone).
    engine: withDsh(engine, dsh, { by: device.name }),
    // The paired key guard.mjs admitted: a Retry after a reconnect is the same message, typed once.
    device: phone,
    // The promise lets chat.mjs count bytes not yet taken (MAX_UNSENT).
    write,
    end: () => { write.done().then(() => bi.send.finish()).catch(() => {}) },
    log,
  })
  try {
    // The hello answer says dshWrite only for a socket that answered write: 1: greet it first
    // (absent resolves at once; each socket hello waits at most REQUEST_MS).
    await dsh.open().catch(() => null)
    if (rest.length) chat.feed(Buffer.from(rest))
    while (!chat.closed) {
      const data = await bi.recv.read(65536).catch(() => null)
      if (!data || data.length === 0) break
      chat.feed(Buffer.from(data))
    }
  } finally {
    chat.close('hung up')
    live.delete(open)
    engines.release(name, open)
    close()
  }
}

async function serve() {
  checkLogs()
  // Never two bridges; but a pid a crash left to another process is no bridge (devices.mjs).
  const other = await claim({ dir: STATE, self: process.pid })
  if (other.running) { log('serve: already running as', other.pid ?? 'an unknown pid'); process.exit(0) }
  if (other.stale) log('serve: status.json named pid', other.stalePid, 'which is not a bridge; replacing it')
  // A reset may create the key while serve starts.
  if (!existsSync(files.key)) await withLock(STATE, () => {
    if (!existsSync(files.key)) writeFileSync(files.key, generate(), { mode: 0o600 })
  })
  chmodSync(files.key, 0o600)
  // This process's start time, which tells it apart from a later process given the same pid.
  const pidStart = startedAt(process.pid)
  const status = () => ({ pid: process.pid, ...(pidStart ? { pidStart } : {}), id: keys.current().id().toString(),
    name: hostname().replace(/\.local$/, ''), started: Date.now() })
  const markRotating = () => writeJson(files.status, { ...status(), rotating: true })
  const publish = () => writeJson(files.status, { ...status(), ticket: EndpointTicket.fromAddr(keys.current().addr()).toString() })
  const recordAddress = () => {
    try { publish() } catch (e) {
      refused('key:', e.message)
      throw new Error(PUBLISH_FAILED)
    }
  }
  const repairAddress = () => {
    const saved = readJson(files.status, null)
    if (!keys.rotating && (!saved?.ticket || saved.id !== keys.current().id().toString())) recordAddress()
  }
  let watch
  const watchAddress = (ep) => {
    const refresh = () => {
      if (ep === keys.current() && !keys.rotating) try { publish() } catch (e) { refused('key:', e.message) }
    }
    watch = ep.watchAddr(refresh)
    ep.online().then(() => {
      if (ep !== keys.current()) return
      refresh()
      log('serve: online as', ep.id().fmtShort())
    }, e => log('serve: no relay yet:', e.message))
  }
  const keys = keeper({
    read: () => readFileSync(files.key),
    async bind(bytes) {
      const replacing = Boolean(keys.current())
      if (replacing && !readJson(files.status, null)?.rotating) {
        try { markRotating() } catch (e) { refused('key:', e.message) }
      }
      try { return await Endpoint.bind({ secretKey: [...bytes], alpns: [SESSION, PAIR, CHAT] }) } catch (e) {
        if (!replacing) throw e
        refused('key:', e.message)
        throw new Error(BIND_FAILED)
      }
    },
    async swapped(ep) {
      await watch.stop().catch(e => log('stop address watch:', e.message))
      watchAddress(ep)
      recordAddress()
    },
    log,
  })
  await keys.start()
  const changeKey = async (change) => {
    const result = await keys.rotate(async () => {
      markRotating()
      const rotated = await change()
      revoke()
      return rotated
    })
    repairAddress()
    return { ...result, id: keys.current().id().toString() }
  }
  // Remove (`forget`) arrives here, before status.json names this bridge: it removes the phone and
  // ends its sessions now. Without the socket (a path too long for one), forget writes the file.
  try {
    const control = await listen(files.socket, {
      forget: id => { const removed = phoneList.remove(id); revoke(); if (removed) log('forget: removed', fingerprint(id)); return removed },
      reset: owner => underLock(stateLock(STATE_HOME), () => {
        assertNoPurge(STATE_HOME)
        assertStateOwner(STATE_HOME, owner)
        return changeKey(() => wipe({ dir: STATE, generate }))
      }),
      adopt: owner => underLock(stateLock(STATE_HOME), () => {
        assertNoPurge(STATE_HOME)
        assertStateOwner(STATE_HOME, owner)
        return changeKey(() => withLock(STATE, () => {
          discardGrant(STATE)
          const id = SecretKey.fromBytes([...readFileSync(files.key)]).public().toString()
          // A code already issued for the replacement key can still be used.
          if (readJson(files.pairing, null)?.id !== id) rmSync(files.pairing, { force: true })
          return { unpaired: phoneList.clear() }
        }))
      }),
      log,
    })
    process.on('exit', () => unlinkOwn(control, files.socket))
  } catch (e) { log('serve: no control socket:', e.message) }
  publish()
  if (existsSync(join(STATE, GRANT))) {
    // am waits for publish() while it holds service.lock. Recover once it releases the lock.
    underLock(stateLock(STATE_HOME), () => {
      assertNoPurge(STATE_HOME)
      resumePairing(STATE, phoneList, Date.now(), keys.current().id().toString())
    }).catch(e => log('pair: could not recover grant:', e.message))
  }
  watchAddress(keys.current())
  // The log stays under guard.mjs's LOG_MAX (plus one older copy), checked each minute.
  const logs = [...new Set([files.log, join(STATE_HOME, 'bridge.log')])]
  const rotate = () => { for (const l of logs) try { rotateLog(l) } catch (e) { log('log:', e.message) } }
  rotate(); setInterval(rotate, 60_000).unref()
  const stop = async () => { serving = false; engines.closeAll(); dsh.close(); publishPublic(); try { const s = readJson(files.status, {}); if (s.pid === process.pid) unlinkSync(files.status) } catch {}; await keys.current().close().catch(() => {}); process.exit(0) }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  // public-status.json: running from here (a stop now writes running: false), then `updated` every
  // HEARTBEAT and on each session open and close.
  serving = true; publishPublic()
  setInterval(publishPublic, HEARTBEAT).unref()
  // Revocation every second (RFC 0036: management ends within 2 s); the key check every 2 s.
  setInterval(revoke, 1000).unref()
  setInterval(() => { keys.ensure().then(repairAddress).catch(e => refused('key:', e.message)) }, 2000).unref()
  // Pairing: only while a code is live, and all of it within the handshake deadline; anyone with
  // the address may try then. Sessions: only paired keys. Others are closed before anything is read.
  const endpointRoutes = (ep) => {
    const id = ep.id().toString()
    const pendingCode = () => {
      if (keys.rotating || keys.current() !== ep) return null
      const p = readJson(files.pairing, null)
      return p?.id && p.id !== id ? null : p
    }
    return routesFor({
      paired: phone => devices().some(d => d.id === phone),
      codeLive: () => { const p = pendingCode(); return Boolean(p && Date.now() <= p.expires) },
      pair: job => underLock(stateLock(STATE_HOME), () => {
        assertNoPurge(STATE_HOME)
        return pairPhone(job, pendingCode())
      }, { wait: 0 }),
      session,
      chat: chatRoute,
    })
  }
  const cap = slots()
  let ep = keys.current(), routes = endpointRoutes(ep)
  for (;;) {
    const incoming = await keys.accept()
    if (!incoming) break
    if (ep !== keys.current()) { ep = keys.current(); routes = endpointRoutes(ep) }
    acceptOne(incoming, { routes, cap, refused, log })
  }
  serving = false; publishPublic()
}

async function pair(minutes = 10) {
  const { running } = await bridgeState({ dir: STATE })
  const status = readJson(files.status, null)
  if (status?.rotating && running) throw new Error(CHANGING_KEY)
  if (!status?.ticket || !running) throw new Error('The bridge is not running.')
  const code = randomBytes(16).toString('base64url')
  const expires = Date.now() + Math.max(1, Math.min(60, Number(minutes) || 10)) * 60_000
  const link = `herdr-pocket://pair?v=1&n=${encodeURIComponent(status.name)}&c=${code}&t=${status.ticket}`
  // The QR as rows of "1" (dark) and "0" (light) modules, for the mod to draw.
  const { default: QRCode } = await import('qrcode')
  const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' })
  const rows = Array.from({ length: modules.size }, (_, y) => Array.from({ length: modules.size }, (_, x) => modules.get(y, x) ? '1' : '0').join(''))
  writeJson(files.pairing, { code, expires, name: status.name, id: status.id })
  return { code, challengeId: challengeId(code), link, expires, rows }
}

// Homebrew's versioned Cellar path disappears on the next upgrade; its opt link stays.
function nodePath() {
  const node = serviceValue('POCKET_LINK_SERVICE_NODE', process.execPath)
  const m = node.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/)
  const opt = m && `${m[1]}/opt/${m[2]}/bin/node`
  return opt && existsSync(opt) ? opt : node
}

// The dialog runs the bridge with this Node next time (find-node.js): Herdr's own PATH may not have it.
function recordNode() { if (process.env.POCKET_LINK_SERVICE_ENTRY) return; try { writeFileSync(join(HERE, '..', '.node'), nodePath() + '\n') } catch {} }

function serviceValue(name, fallback) {
  const value = process.env[name]
  return value && isAbsolute(value) ? value : fallback
}

const entry = serviceValue('POCKET_LINK_SERVICE_ENTRY', join(HERE, 'bridge.mjs'))
const managedStore = () => storeForEntry(entry)
function loginBody() {
  if (platform() === 'darwin') return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath())}</string><string>${xml(entry)}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>POCKET_LINK_STATE_DIR</key><string>${xml(STATE_HOME)}</string></dict>
  <key>StandardErrorPath</key><string>${xml(join(STATE_HOME, 'bridge.log'))}</string>
</dict></plist>
`
  return `[Unit]
Description=Herdr Pocket Link bridge

[Service]
ExecStart=${unitArg(nodePath(), true)} ${unitArg(entry, true)} serve
Environment=${unitArg('POCKET_LINK_STATE_DIR=' + STATE_HOME)}
Restart=on-failure

[Install]
WantedBy=default.target
`
}

const stateOperation = (fn, { checkOwner = false } = {}) => underLock(stateLock(STATE_HOME), () => {
  assertNoPurge(STATE_HOME, process.env.POCKET_LINK_STATE_LOCK && process.env.POCKET_LINK_PURGE_TOKEN)
  if (checkOwner) assertStateOwner(STATE_HOME, managedStore())
  loadState()
  return fn()
}, { delegation: process.env.POCKET_LINK_STATE_LOCK })
const serviceOperation = fn => underLock(managerLock(), () => {
  if (!process.env.POCKET_LINK_MANAGER_LOCK) assertStandalone()
  return stateOperation(fn)
}, { delegation: process.env.POCKET_LINK_MANAGER_LOCK })

function writeDefinition(body, replace = false) {
  mkdirSync(dirname(serviceFile()), { recursive: true })
  const temp = `${serviceFile()}.${process.pid}.tmp`
  try {
    writeFileSync(temp, body, { flag: 'wx', mode: 0o600 })
    if (replace) renameSync(temp, serviceFile())
    else linkSync(temp, serviceFile())
  } finally { rmSync(temp, { force: true }) }
}

function foreign(definition, replace) {
  if (process.env.POCKET_LINK_MANAGER_LOCK &&
      (definition.present ? definition.digest : '') !== process.env.POCKET_LINK_SERVICE_DIGEST) {
    return { ok: false, error: 'Pocket Link’s login definition changed. Turn it off from the install that wrote it.' }
  }
  // Replacement is limited to the previous entry named by the transaction holding both locks.
  if (!definition.present || definition.entry === entry) return null
  if (replace && process.env.POCKET_LINK_MANAGER_LOCK && definition.entry &&
      definition.entry === process.env.POCKET_LINK_PREVIOUS_ENTRY) {
    const store = dirname(dirname(dirname(dirname(entry))))
    const prior = relative(store, definition.entry)
    if (entry === join(store, 'current/link/bridge/bridge.mjs') && /^(?:previous|\d[\w.+-]*)\/link\/bridge\/bridge\.mjs$/.test(prior)) return null
  }
  return { ok: false, foreign: definition.entry ?? serviceFile(),
    error: 'Pocket Link already uses another service entry. Turn it off from the dialog or am that installed it.' }
}

const ownsServiceJob = (job, definition) => process.env.POCKET_LINK_MANAGER_LOCK
  ? matchesJob(job, definition, definition.entry) : ownsJob(job, definition, definition.entry)

function requireDefinition(definition) {
  const current = readService()
  if (current.present !== definition.present || current.digest !== definition.digest) {
    throw new Error('Pocket Link’s login definition changed during the operation.')
  }
}

function requireInstallDigest(body) {
  if (process.env.POCKET_LINK_MANAGER_LOCK && definitionDigest(body) !== process.env.POCKET_LINK_INSTALL_DIGEST) {
    throw new Error('Pocket Link’s login definition does not match the transaction.')
  }
}

function checkLogs() {
  assertSafeLogs(files.log)
  if (STATE_HOME !== STATE) assertSafeLogs(join(STATE_HOME, 'bridge.log'))
}

function verifyReloadedUnit(manager, body) {
  const definition = { present: true, ...servicePaths(body) }
  const job = manager.inspect()
  if (!job.loaded || !matchesJob(job, definition, entry) || readService().digest !== definitionDigest(body)) {
    throw new Error('The effective systemd definition differs from Pocket Link’s unit. Check the fragment, ExecStart and drop-ins.')
  }
}

async function stopService(definition) {
  const manager = serviceManager()
  const before = await bridgeState({ dir: STATE })
  let watched = [], unloaded = false, stopped = null, error, managerError
  try {
    let job
    try { job = manager.inspect() } catch (e) {
      if (definition.present || process.env.POCKET_LINK_MANAGER_LOCK || !servesEntry(before.pid, entry)) throw e
      managerError = e.message
    }
    if (job && (!ownsServiceJob(job, definition) || (job.pid && !servesEntry(job.pid, definition.entry)))) {
      throw new Error('Pocket Link already uses another service entry. Turn it off from the dialog or am that installed it.')
    }
    if (before.running && !servesEntry(before.pid, definition.entry ?? entry)) {
      throw new Error('The running Pocket Link bridge uses another entry.')
    }
    watched = [...new Set([job?.pid, before.pid].filter(Boolean))].map(pid => ({ pid, start: startedAt(pid) }))
    if (job) {
      requireDefinition(definition)
      if (job.loaded || (platform() !== 'darwin' && definition.present)) manager.off()
      unloaded = true
    }
    if (before.pid && watched.some(p => p.pid === before.pid && p.start && sameProcess(p))) {
      try { process.kill(before.pid, 'SIGTERM'); stopped = before.pid } catch (e) { if (e.code !== 'ESRCH') throw e }
    }
    const stillLoaded = () => platform() === 'darwin' && job?.loaded && manager.inspect().loaded
    const deadline = Date.now() + 10_000
    while ((watched.some(sameProcess) || stillLoaded()) && Date.now() < deadline) await delay(100)
    if (stillLoaded()) throw new Error('launchd still has the Pocket Link job loaded.')
    if (!watched.some(sameProcess) && !(await bridgeState({ dir: STATE })).running) {
      if (definition.present) {
        requireDefinition(definition)
        rmSync(serviceFile(), { force: true })
        manager.reload()
      }
      cancelCode(files.pairing)
    }
  } catch (e) { error = e.message }
  const running = watched.some(sameProcess) || (await bridgeState({ dir: STATE })).running
  return { ok: (unloaded || Boolean(managerError && stopped)) && !running && !error, unloaded, stopped, running,
    ...(managerError ? { managerError } : {}),
    ...(error ? { error } : running ? { error: 'Pocket Link is still running.' } : {}) }
}

const [command = 'status', arg] = process.argv.slice(2)
function scopedChallenge() {
  if (arg !== undefined && !/^[0-9a-f]{64}$/.test(arg)) throw new Error('Invalid Pocket Link challenge ID.')
  return arg
}
const out = value => {
  process.stdout.write(JSON.stringify(value) + '\n')
  if (value.ok === false) process.exitCode = 1
}
try {
  if (command === 'status' && !process.env.POCKET_LINK_SERVICE_ENTRY) await stateOperation(() => {})
  else if (!['pair', 'cancel', 'copied', 'forget', 'start', 'stop', 'install', 'uninstall', 'restore-inactive', 'definition-digest'].includes(command)) {
    if (command === 'serve' || command === 'reset') assertNoPurge(STATE_HOME)
    if (command === 'reset') assertStateOwner(STATE_HOME, managedStore())
    loadState(command === 'status')
  }
  if (command === 'serve' || command === 'reset') ({ Endpoint, EndpointTicket, SecretKey } = await import('@number0/iroh'))
  if (command === 'serve') await serve()
  else if (command === 'definition-digest') out(definitionDigest(loginBody()))
  else if (command === 'pair') out(await stateOperation(() => pair(arg), { checkOwner: true }))
  else if (command === 'status') {
    const packages = ['@number0/iroh', 'qrcode'].every(name => existsSync(join(HERE, 'node_modules', name, 'package.json')))
    const { running } = await bridgeState({ dir: STATE })
    const s = readJson(files.status, {})
    const p = readJson(files.pairing, null)
    out({ running, id: s.id ?? null, name: s.name ?? null, ticket: s.ticket ?? null,
      fingerprint: desktopFingerprint(s, running),
      devices: devices().map(({ id, name, paired, seen }) => ({ id, name, fingerprint: fingerprint(id), paired, seen })),
      pairing: !s.rotating && p && (!p.id || p.id === s.id) && Date.now() < p.expires ? { expires: p.expires } : null,
      login: existsSync(serviceFile()), state: STATE, packages })
  }
  else if (command === 'cancel') out(await stateOperation(() => {
    const cancelled = cancelCode(files.pairing, Date.now(), scopedChallenge())
    return { ok: true, cancelled, devices: devices().map(({ id, name, paired }) => ({ id, name, fingerprint: fingerprint(id), paired })) }
  }, { checkOwner: true }))
  else if (command === 'copied') out(await stateOperation(() => {
    const { expires, error } = shortenCode(files.pairing, undefined, Date.now(), { settle: 0, only: scopedChallenge() })
    return expires ? { ok: true, expires }
      : error === 'gone' ? { ok: false, error: 'This pairing code was already used or has expired. Make a new one.' }
        : { ok: false, error: "The pairing code kept changing, so the link wasn't copied. Try again." }
  }, { checkOwner: true }))
  else if (command === 'start') out(await serviceOperation(async () => {
    const definition = readService()
    const conflict = foreign(definition)
    if (conflict) return conflict
    if (definition.present) {
      return { ok: false, error: 'Pocket Link has a login service. Turn it off before starting a detached bridge.' }
    }
    checkLogs()
    const { running } = await claim({ dir: STATE })
    recordNode()
    if (!running) {
      const err = openAppendLog(files.log)
      let child
      try {
        child = spawn(process.execPath, [entry, 'serve'], { detached: true, stdio: ['ignore', 'ignore', err],
          env: { ...process.env, POCKET_LINK_DETACHED: '1' } })
      }
      finally { closeSync(err) }
      child.on('error', () => {})
      const deadline = Date.now() + 10_000
      while (child.pid && processAlive(child.pid) && Date.now() < deadline) {
        if (readJson(files.status, {}).pid === child.pid) { child.unref(); return { ok: true } }
        await delay(100)
      }
      child.kill('SIGTERM')
      return { ok: false, error: 'The detached bridge did not start. See ' + files.log }
    }
    return { ok: true }
  }))
  else if (command === 'stop' || command === 'uninstall') out(await serviceOperation(async () => {
    const definition = readService()
    const conflict = foreign(definition)
    if (!conflict) return stopService(definition)
    return { ...conflict, unloaded: false, stopped: null, running: (await bridgeState({ dir: STATE })).running }
  }))
  else if (command === 'forget') out(await stateOperation(() => {
    resumePairing(STATE, phoneList)
    return forget({ dir: STATE, id: arg })
  }, { checkOwner: true }))
  else if (command === 'reset') out(await resetKey({ dir: STATE, generate, owner: managedStore(), write: fn => underLock(stateLock(STATE_HOME), () => {
    assertNoPurge(STATE_HOME)
    assertStateOwner(STATE_HOME, managedStore())
    return fn()
  }) }))
  else if (command === 'restore-inactive') out(await serviceOperation(async () => {
    const { body, enabled } = JSON.parse(arg)
    const prior = servicePaths(body)
    const manager = serviceManager()
    const launchd = platform() === 'darwin'
    if (!process.env.POCKET_LINK_MANAGER_LOCK || prior.entry !== entry || prior.state !== STATE_HOME
        || !(launchd ? ['disabled', 'loaded'] : ['disabled', 'enabled']).includes(enabled)
        || readService().present || manager.inspect().loaded) {
      throw new Error('Cannot safely restore Pocket Link’s inactive service.')
    }
    requireInstallDigest(body)
    if (enabled === 'loaded') checkLogs()
    writeDefinition(body)
    manager.reload()
    if (launchd && enabled === 'loaded') {
      manager.on()
      const restored = manager.inspect()
      if (!restored.loaded || !matchesJob(restored, readService(), entry)) {
        throw new Error('Could not verify the restored Pocket Link launchd job.')
      }
    }
    if (!launchd) {
      verifyReloadedUnit(manager, body)
      if (enabled === 'enabled') manager.enable()
    }
    return { ok: true }
  }))
  else if (command === 'install') out(await serviceOperation(async () => {
    const definition = readService()
    const conflict = foreign(definition, arg === '--replace')
    if (conflict) return conflict
    checkLogs()
    if (!process.env.POCKET_LINK_SERVICE_ENTRY) await import('@number0/iroh')
    const manager = serviceManager()
    const job = manager.inspect()
    if (!ownsServiceJob(job, definition) || (job.pid && !servesEntry(job.pid, definition.entry))) {
      return { ok: false, foreign: serviceFile(), error: 'Turn off the existing Pocket Link service first.' }
    }
    let replace = definition.present
    if (definition.present && (definition.entry !== entry || (definition.state && definition.state !== STATE_HOME))) {
      const stopped = await stopService(definition)
      if (!stopped.ok) return stopped
      replace = false
    } else if (definition.present && job.pid) return { ok: true, path: serviceFile() }
    const body = loginBody()
    requireInstallDigest(body)
    writeDefinition(body, replace)
    if (platform() === 'linux') {
      try {
        manager.reload()
        verifyReloadedUnit(manager, body)
      } catch (e) {
        // Activation has not been attempted. Undo only the definition this command wrote.
        if (readService().digest === definitionDigest(body)) {
          if (replace) writeDefinition(definition.body, true)
          else rmSync(serviceFile())
          manager.reload()
        }
        throw e
      }
    }
    // A failed activation can leave a loaded job. Keep its definition for verified cleanup.
    if (!(platform() === 'darwin' && job.loaded && definition.entry === entry && definition.state === STATE_HOME)) manager.on()
    recordNode()
    return { ok: true, path: serviceFile() }
  }))
  else { out({ ok: false, error: `unknown command ${command}` }); process.exit(2) }
} catch (e) {
  if (command === 'serve') log('serve:', e.message)
  out({ ok: false, error: e.message })
}
