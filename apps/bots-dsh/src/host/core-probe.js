// Derived from the pack's coreSocket.mjs. Code's resolver also follows hc's configured
// socket, accepts session names as given, and tries every candidate until one answers.
import { readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const absolute = path => typeof path === 'string' && isAbsolute(path)
const inTestRoots = (path, env) => !env.AUTOMAGIK_HERDR_TEST_ROOTS
  || env.AUTOMAGIK_HERDR_TEST_ROOTS.split(':').filter(absolute).some((root) => {
    const rest = relative(resolve(root), resolve(path))
    return rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest)
  })

function readSocketFile(path, env, read) {
  if (!inTestRoots(path, env)) return null
  try { return read(readFileSync(path, 'utf8')) } catch { return null }
}

function configuredSocket(text) {
  for (const line of text.split(/\r?\n/)) {
    // The socket setting is a top-level TOML string, before any table.
    if (/^\s*\[/.test(line)) break
    const match = /^\s*(?:socket|"socket"|'socket')\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(line)
    if (!match) continue
    const value = match[1]
    return value.startsWith("'") ? value.slice(1, -1) : JSON.parse(value)
  }
  return null
}

export function coreSockets(env = process.env, { platform = process.platform, uid = process.getuid?.(), home = env.HOME || homedir() } = {}) {
  if (platform !== 'linux' && platform !== 'darwin') return []
  const config = absolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config')
  const state = absolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local', 'state')
  const session = env.HC_SESSION || 'default'
  const sessionState = join(state, 'herdr-core', session)
  const runtime = typeof uid === 'number' ? `/run/user/${uid}` : null
  let socketDir = sessionState
  if (absolute(env.XDG_RUNTIME_DIR)) {
    socketDir = join(env.XDG_RUNTIME_DIR, 'herdr-core')
  } else if (runtime && inTestRoots(runtime, env)) {
    try {
      if (statSync(runtime).isDirectory()) socketDir = join(runtime, 'herdr-core')
    } catch { /* hc falls back to session state */ }
  }
  const paths = [
    env.HC_SOCKET,
    env.AUTOMAGIK_HERDR_CORE_SOCKET,
    readSocketFile(join(config, 'herdr-core', 'config.toml'), env, configuredSocket),
    join(socketDir, `${session}.sock`),
    readSocketFile(join(sessionState, 'core.lock'), env, text => text.split('\n')[0].trim()),
  ]
  return [...new Set(paths.filter(path => absolute(path) && inTestRoots(path, env)))]
}

function answersStatus(path, timeoutMs) {
  return new Promise((done) => {
    let socket
    let buffer = Buffer.alloc(0)
    const finish = (answered) => {
      clearTimeout(timer)
      socket?.destroy()
      done(answered)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
    try {
      socket = createConnection(path)
      socket.once('connect', () => socket.write('{"jsonrpc":"2.0","id":1,"method":"server.status","params":{}}\n'))
      socket.on('data', (bytes) => {
        buffer = Buffer.concat([buffer, bytes])
        const newline = buffer.indexOf(10)
        if ((newline < 0 ? buffer.length : newline) > 64 * 1024) return finish(false)
        if (newline < 0) return
        try {
          const reply = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
          finish(reply?.id === 1 && Object.hasOwn(reply, 'result') && !Object.hasOwn(reply, 'error'))
        } catch { finish(false) }
      })
      socket.once('error', () => finish(false))
      socket.once('close', () => finish(false))
    } catch { finish(false) }
  })
}

/** A read-only probe. Give every candidate a share of the timeout, even after a silent listener. */
export async function probeCore(env = process.env, { timeoutMs = 3000 } = {}) {
  const sockets = coreSockets(env)
  for (const path of sockets) {
    if (await answersStatus(path, timeoutMs / sockets.length)) return path
  }
  return null
}
