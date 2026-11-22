import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Duplex } from 'node:stream'
import { DEFAULT_ENV_ALLOW, parseRequest } from '../../../am/runner/proto.mjs'

export const BOT = 'b-aaaaaaaaaa'
export const OTHER = 'b-bbbbbbbbbb'
export const RUNNER_UID = 40001
export const linuxRunner = { skip: process.platform !== 'linux' && 'Bot runner fixtures require Linux' }
export const exit = (code = 0, options = {}) => ({ t: 'exit', code, signal: null, timedOut: false, truncated: false, ms: 1, ...options })
export const start = bot => ({ t: 'start', bot, uid: 45000, gid: 45000, mode: 'subuid', run: '123456789abc', unit: 'am-bot-123456789abc' })
export const output = (t, buffer) => ({ t, d: Buffer.from(buffer).toString('base64') })
export const frames = (...items) => items.map(item => JSON.stringify(item) + '\n').join('')

// Used explicitly when a sandbox disallows AF_UNIX. Proof files and the wire
// bytes are still real, but endpoint type and stream delivery are simulated.
function streamPair() {
  const side = peer => new Duplex({
    read() {},
    write(chunk, _encoding, done) { peer().push(chunk); done() },
    final(done) { peer().push(null); done() },
  })
  const client = side(() => server)
  const server = side(() => client)
  client.once('close', () => server.destroy())
  return { client, server }
}

export function setEnv(t, env) {
  const previous = new Map(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

export async function fakeRunner(t, {
  challenge, prepareProof, beforeVerdict, proofVerdict = 'ok', dshUid,
  reply = (conn, request) => conn.end(frames(start(request.identity.id), exit())),
} = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'br-'))
  const folder = join(root, 'socket')
  const socket = join(folder, 'runner.sock')
  const workRoot = join(root, 'work')
  const proofs = join(root, 'proofs')
  const requests = []
  const proofUid = process.geteuid()
  const peers = new Set()
  let connections = 0
  let acknowledgements = 0
  let listening = true
  const stop = async () => {
    if (!listening) return
    listening = false
    for (const peer of peers) peer.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    else if (memory) fs.rmSync(socket, { force: true })
  }
  t.after(async () => {
    await stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(folder, { mode: 0o750 })
  fs.mkdirSync(proofs)
  fs.chmodSync(proofs, 0o1730)
  fs.mkdirSync(workRoot)
  const handle = conn => {
    connections += 1
    peers.add(conn)
    conn.on('close', () => peers.delete(conn))
    conn.on('error', () => {})
    const name = challenge ?? randomBytes(24).toString('hex')
    const file = join(proofs, name)
    prepareProof?.(file)
    conn.write(name.slice(0, 19))
    setImmediate(() => conn.write(name.slice(19) + '\n'))
    let buffer = ''
    let waitingForProof = true
    conn.on('data', async data => {
      buffer += data
      for (let eol = buffer.indexOf('\n'); eol >= 0; eol = buffer.indexOf('\n')) {
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 1)
        if (waitingForProof) {
          waitingForProof = false
          acknowledgements += 1
          assert.equal(line, '')
          const stat = fs.lstatSync(file)
          assert.ok(stat.isFile())
          assert.equal(stat.mode & 0o7777, 0o600)
          assert.equal(stat.uid, proofUid)
          assert.equal(stat.nlink, 1)
          assert.equal(stat.size, 0)
          fs.unlinkSync(file)
          if (beforeVerdict !== undefined) await beforeVerdict(conn)
          if (proofVerdict !== 'ok') return conn.end(proofVerdict + '\n')
          conn.write('ok\n')
          continue
        }
        const wire = JSON.parse(line)
        assert.equal(wire.v, 2)
        const request = parseRequest(line, { envAllow: DEFAULT_ENV_ALLOW, maxTimeoutMs: 600_000 })
        requests.push({ wire, ...request })
        reply(conn, request)
      }
    })
  }
  const server = net.createServer(handle)
  const memory = process.env.BOT_RUNNER_TEST_MEMORY === '1'
  if (memory) {
    fs.writeFileSync(socket, '')
    const connect = t.mock.method(net, 'connect', path => {
      assert.equal(path, socket)
      const pair = streamPair()
      setImmediate(() => {
        if (listening) handle(pair.server)
        else pair.client.destroy(new Error('fixture runner unavailable'))
      })
      return pair.client
    })
    syncBuiltinESMExports()
    t.after(() => { connect.mock.restore(); syncBuiltinESMExports() })
  } else {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
  }
  fs.chmodSync(socket, 0o660)

  // The stream and proof are real. Supply the runner's separate uid and socket group
  // as metadata so the fixture needs neither privilege nor a real service account.
  const socketGid = 40002
  if (dshUid !== undefined) t.mock.method(process, 'geteuid', () => dshUid)
  t.mock.method(process, 'getgroups', () => [socketGid])
  const lstat = fs.lstatSync
  const ancestors = new Set()
  for (let at = root; ; at = dirname(at)) {
    ancestors.add(at)
    if (at === dirname(at)) break
  }
  const endpoint = new Set([folder, socket, proofs])
  t.mock.method(fs, 'lstatSync', (path, options) => {
    const info = lstat(path, options)
    if (info === undefined) return undefined
    if (memory && path === socket) info.isSocket = () => true
    if (endpoint.has(path)) {
      info.uid = RUNNER_UID
      info.gid = socketGid
    }
    if (ancestors.has(path)) {
      info.mode &= ~0o022
      info.uid = path === root ? RUNNER_UID : 0
    }
    return info
  })
  setEnv(t, {
    AUTOMAGIK_BOT_RUNNER_SOCKET: socket, AUTOMAGIK_BOT_RUNNER_PROOFS: proofs, AUTOMAGIK_BOT_RUNNER_WORK_ROOT: workRoot,
    AUTOMAGIK_BOT_RUNNER_UID: String(RUNNER_UID), AUTOMAGIK_BOT_RUNNER_GID: String(socketGid),
  })
  return {
    root, folder, socket, proofs, workRoot, requests, stop,
    get connections() { return connections },
    get acknowledgements() { return acknowledgements },
  }
}
