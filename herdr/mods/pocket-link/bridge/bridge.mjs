#!/usr/bin/env node
// Pocket Link bridge: lets paired phones reach this machine's herdr-core over iroh
// (dial by key, direct when it can, an end-to-end encrypted relay when it can't).
//
//   node bridge.mjs serve            run the bridge (the mod starts it; `install` keeps it running at login)
//   node bridge.mjs pair [minutes]   make a one-time pairing link and QR, print {link, expires, rows}
//   node bridge.mjs status           print {running, id, ticket, devices, pairing, login, state}
//   node bridge.mjs start | stop     start the bridge detached; stop it (and its login service)
//   node bridge.mjs cancel           end the pairing code, if one is live (the dialog does on close)
//   node bridge.mjs copied           the code's link was copied: it ends 2 minutes from now, print {expires}
//   node bridge.mjs forget <id>      remove a paired phone (the running bridge does, over bridge.sock: devices.mjs)
//   node bridge.mjs reset            change the desktop key and unpair every phone
//   node bridge.mjs install|uninstall   start at login (LaunchAgent on macOS, systemd user unit on Linux)
//
// What a stranger can make it do before pairing is bounded in guard.mjs; the code itself in pairing.mjs.
//
// State lives outside the mod folder (see state.mjs), so reinstalling the mod keeps the pairings.
import { Endpoint, EndpointTicket, SecretKey } from '@number0/iroh'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync, readdirSync, openSync, rmSync } from 'node:fs'
import { homedir, hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import { acceptOne, slots, throttle, rotateLog, routesFor, endRemoved, sessionName, ALPN } from './guard.mjs'
import { ChatConnection, ChatEngines, chatWriter } from './chat.mjs'
import { DshSource, withDsh } from './dsh-source.mjs'
import { createEngine } from '../chat/engine.js'
import { judgeCode, cancelCode, shortenCode, fingerprint, desktopFingerprint } from './pairing.mjs'
import { pipeSession } from './pipe.mjs'
import { open as openState } from './state.mjs'
import { presence, publicStatus, writePublic, HEARTBEAT } from './presence.mjs'
import { store, listen, unlinkOwn, forget, bridgeState, claim, stopBridge, startedAt, withLock, SOCKET } from './devices.mjs'
import { keeper, resetKey, wipe } from './reset.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SESSION = [...Buffer.from(ALPN.session)]
const PAIR = [...Buffer.from(ALPN.pair)]
// The chat (RFC 0015): an older bridge does not offer it, and the phone falls back to the terminal.
const CHAT = [...Buffer.from(ALPN.chat)]
const LABEL = 'dev.herdr.pocket-link'

// As a service, stderr already is the log file; in a terminal, write both.
let files = null
const log = (...args) => { const line = `${new Date().toISOString()} ${args.join(' ')}\n`; process.stderr.write(line); if (process.stderr.isTTY && files) fs.appendFile(files.log, line, { mode: 0o600 }).catch(() => {}) }
// Outside the mod folder (state.mjs); the first run moves an older <mod>/.state there.
// `dir` is the old one only while an older bridge still runs from it; `target` is where it belongs.
const { dir: STATE, target: STATE_HOME } = openState({ env: process.env, home: homedir(), modRoot: join(HERE, '..'), log })
files = {
  key: join(STATE, 'secret.key'), status: join(STATE, 'status.json'), devices: join(STATE, 'devices.json'),
  pairing: join(STATE, 'pairing.json'), log: join(STATE, 'bridge.log'), socket: join(STATE, SOCKET),
}
// Lines any peer can cause, before it is trusted: at most a few of each kind a minute.
const refused = throttle(log)
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback } }
// Atomic, owner-only writes: a reader never sees half a file.
const writeJson = (path, value) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(tmp, path) }
const devices = () => readJson(files.devices, [])
// The running bridge owns devices.json; `forget` and `reset` ask it over bridge.sock.
const phoneList = store(files.devices)
// Older versions wrote QR files here; clean them up.
const clearQr = () => { for (const f of readdirSync(STATE)) if (/^qr-\d+\.svg$/.test(f)) try { unlinkSync(join(STATE, f)) } catch {} }

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
  const { verdict, next } = judgeCode(pending, phone, value?.code)
  if (next === null) try { unlinkSync(files.pairing) } catch {}
  else if (next) writeJson(files.pairing, next)
  if (verdict === 'gone') return reply({ ok: false, error: 'This pairing code was already used or has expired. Make a new one on the desktop.' })
  if (verdict === 'locked') { refused('pair', 'too many wrong codes from', fingerprint(phone)); return reply({ ok: false, error: 'Too many wrong codes from this phone. Make a new code on the desktop.' }) }
  if (verdict === 'wrong') { refused('pair', 'wrong code from', fingerprint(phone)); return reply({ ok: false, error: 'That code is not the one on the desktop.' }) }
  const name = String(value.device ?? 'Phone').replace(/[\u0000-\u001f]/g, '').slice(0, 60) || 'Phone'
  phoneList.add({ id: phone, name, paired: Date.now(), seen: Date.now() })
  clearQr()
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
// lists nothing. Writes on them go to it only when it answered `write: 1` (dsh-source.mjs).
const dsh = new DshSource({ log, attachments: true })

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
      clearQr()
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
      reset: () => changeKey(() => wipe({ dir: STATE, generate })),
      adopt: () => changeKey(() => withLock(STATE, () => {
        const id = SecretKey.fromBytes([...readFileSync(files.key)]).public().toString()
        // A code already issued for the replacement key can still be used.
        if (readJson(files.pairing, null)?.id !== id) rmSync(files.pairing, { force: true })
        return { unpaired: phoneList.clear() }
      })),
      log,
    })
    process.on('exit', () => unlinkOwn(control, files.socket))
  } catch (e) { log('serve: no control socket:', e.message) }
  publish()
  watchAddress(keys.current())
  // Older versions kept the usage meter's status here; the meter is the Automagik Herdr pack's now.
  try { unlinkSync(join(STATE, 'meter.json')) } catch {}
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
      pair: job => pairPhone(job, pendingCode()),
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
  writeJson(files.pairing, { code, expires, name: status.name, id: status.id })
  const link = `herdr-pocket://pair?v=1&n=${encodeURIComponent(status.name)}&c=${code}&t=${status.ticket}`
  clearQr()
  // The QR as rows of "1" (dark) and "0" (light) modules, for the mod to draw.
  const { modules } = QRCode.create(link, { errorCorrectionLevel: 'M' })
  const rows = Array.from({ length: modules.size }, (_, y) => Array.from({ length: modules.size }, (_, x) => modules.get(y, x) ? '1' : '0').join(''))
  return { link, expires, rows }
}

// Homebrew's versioned Cellar path disappears on the next upgrade; its opt link stays.
function nodePath() {
  const m = process.execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/)
  const opt = m && `${m[1]}/opt/${m[2]}/bin/node`
  return opt && existsSync(opt) ? opt : process.execPath
}

// The dialog runs the bridge with this Node next time (find-node.js): Herdr's own PATH may not have it.
function recordNode() { try { writeFileSync(join(HERE, '..', '.node'), nodePath() + '\n') } catch {} }

function loginService() {
  if (platform() === 'darwin') {
    const plist = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)
    return { path: plist, body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${nodePath()}</string><string>${join(HERE, 'bridge.mjs')}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>POCKET_LINK_STATE_DIR</key><string>${STATE_HOME}</string></dict>
  <key>StandardErrorPath</key><string>${join(STATE_HOME, 'bridge.log')}</string>
</dict></plist>
`, on: () => {
      // A bootout finishes in the background: bootstrap again until launchd lets go of the old one.
      try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }) } catch {}
      for (let i = 0; ; i++) {
        try { execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { stdio: 'pipe' }); return } catch (e) {
          if (i >= 15) throw e
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
        }
      }
    },
      off: () => { try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }) } catch {} } }
  }
  const unit = join(homedir(), '.config/systemd/user', 'herdr-pocket-link.service')
  return { path: unit, body: `[Unit]
Description=Herdr Pocket Link bridge

[Service]
ExecStart=${nodePath()} ${join(HERE, 'bridge.mjs')} serve
Environment="POCKET_LINK_STATE_DIR=${STATE_HOME}"
Restart=on-failure

[Install]
WantedBy=default.target
`, on: () => { execFileSync('systemctl', ['--user', 'daemon-reload']); execFileSync('systemctl', ['--user', 'enable', '--now', 'herdr-pocket-link.service']) },
    off: () => { try { execFileSync('systemctl', ['--user', 'disable', '--now', 'herdr-pocket-link.service'], { stdio: 'ignore' }) } catch {} } }
}

const [command = 'status', arg] = process.argv.slice(2)
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
try {
  if (command === 'serve') await serve()
  else if (command === 'pair') out(await pair(arg))
  else if (command === 'status') {
    const { running } = await bridgeState({ dir: STATE })
    const s = readJson(files.status, {})
    const p = readJson(files.pairing, null)
    out({ running, id: s.id ?? null, name: s.name ?? null, ticket: s.ticket ?? null,
      fingerprint: desktopFingerprint(s, running),
      devices: devices().map(({ id, name, paired, seen }) => ({ id, name, fingerprint: fingerprint(id), paired, seen })),
      pairing: !s.rotating && p && (!p.id || p.id === s.id) && Date.now() < p.expires ? { expires: p.expires } : null,
      login: existsSync(loginService().path), state: STATE })
  }
  else if (command === 'cancel') {
    const cancelled = cancelCode(files.pairing); clearQr()
    out({ ok: true, cancelled, devices: devices().map(({ id, name, paired }) => ({ id, name, fingerprint: fingerprint(id), paired })) })
  }
  else if (command === 'copied') {
    // The serving bridge reads pairing.json on every try, so a shorter `expires` there is enough.
    const { expires, error } = shortenCode(files.pairing)
    out(expires ? { ok: true, expires }
      : error === 'gone' ? { ok: false, error: 'This pairing code was already used or has expired. Make a new one.' }
        : { ok: false, error: "The pairing code kept changing, so the link wasn't copied. Try again." })
  }
  else if (command === 'start') {
    // Without the login service: a detached bridge that lives until stopped or logout.
    // A stale pid's socket and status.json are cleared first (devices.mjs claim).
    const { running } = await claim({ dir: STATE })
    recordNode()
    if (!running) {
      const err = openSync(files.log, 'a', 0o600)
      spawn(process.execPath, [join(HERE, 'bridge.mjs'), 'serve'], { detached: true, stdio: ['ignore', 'ignore', err] }).unref()
    }
    out({ ok: true })
  }
  else if (command === 'stop') {
    const s = loginService(); s.off(); try { unlinkSync(s.path) } catch {}
    // Only a pid verified as the bridge is signalled (devices.mjs stopBridge).
    const { stopped } = await stopBridge({ dir: STATE })
    cancelCode(files.pairing); clearQr()
    out({ ok: true, stopped })
  }
  else if (command === 'forget') out(await forget({ dir: STATE, id: arg }))
  else if (command === 'reset') { out(await resetKey({ dir: STATE, generate })); clearQr() }
  else if (command === 'install') { const s = loginService(); mkdirSync(dirname(s.path), { recursive: true }); writeFileSync(s.path, s.body); s.on(); recordNode(); out({ ok: true, path: s.path }) }
  else if (command === 'uninstall') { const s = loginService(); s.off(); try { unlinkSync(s.path) } catch {}; out({ ok: true }) }
  else { out({ ok: false, error: `unknown command ${command}` }); process.exit(2) }
} catch (e) { out({ ok: false, error: e.message }); process.exit(1) }
