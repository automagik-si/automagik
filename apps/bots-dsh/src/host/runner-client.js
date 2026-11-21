import fs from 'node:fs'
import { connect } from 'node:net'
import { constants as osConstants } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isBotId } from '../shared/registry.js'

export const MAX_TIMEOUT_MS = 600_000
const MAX_REQUEST_BYTES = 64 * 1024
const CHUNK_BYTES = 64 * 1024
const MAX_LINE_BYTES = Math.ceil(CHUNK_BYTES / 3) * 4 + 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024 // Maximum supported runner configuration.
const PROVISION_ALLOWANCE_MS = 20_000 // The runner can spend 20 seconds provisioning before spawn.
const REPLY_GRACE_MS = 10_000
const MIN_SUBORDINATE_ID = 1000
const ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TZ']
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const normalizedAbsolute = path => typeof path === 'string' && !path.includes('\0') && isAbsolute(path) && resolve(path) === path
const numericId = (value, min = 1) => Number.isInteger(value) && value >= min && value <= 0xfffffffe
const configuredId = value => /^\d+$/.test(value ?? '') ? Number(value) : NaN

let cached

function protectedChain(path, uid) {
  const parent = dirname(path)
  if (parent !== path && !protectedChain(parent, uid)) return false
  const info = fs.lstatSync(path)
  return info.isDirectory() && (info.uid === 0 || info.uid === uid) && (info.mode & 0o022) === 0
}

function matches(path, kind, uid, gid, mode) {
  const info = fs.lstatSync(path)
  return info[kind]() && info.uid === uid && info.gid === gid && (info.mode & 0o7777) === mode
}

// Inspect path metadata only. Dispatch always takes a fresh reading before connecting.
export function inspect({ maxAgeMs = 0 } = {}) {
  const {
    AUTOMAGIK_BOT_RUNNER_SOCKET: socket,
    AUTOMAGIK_BOT_RUNNER_PROOFS: proofs,
    AUTOMAGIK_BOT_RUNNER_WORK_ROOT: workRoot,
    AUTOMAGIK_BOT_RUNNER_UID: runnerUid,
    AUTOMAGIK_BOT_RUNNER_GID: socketGid,
  } = process.env
  const key = JSON.stringify([socket, proofs, workRoot, runnerUid, socketGid])
  const now = performance.now()
  if (maxAgeMs > 0 && cached?.key === key && now - cached.at < maxAgeMs) return cached.result
  const uid = configuredId(runnerUid)
  const gid = configuredId(socketGid)
  let result = { ok: false }
  try {
    if (process.platform === 'linux' && [socket, proofs, workRoot].every(normalizedAbsolute)
      && numericId(uid) && uid !== process.geteuid()
      && numericId(gid) && gid !== process.getegid() && process.getgroups().includes(gid)
      && protectedChain(dirname(socket), uid) && protectedChain(dirname(proofs), uid)
      && matches(dirname(socket), 'isDirectory', uid, gid, 0o750)
      && matches(proofs, 'isDirectory', uid, gid, 0o1730)
      && matches(socket, 'isSocket', uid, gid, 0o660)) {
      result = { ok: true, socket, proofs, workRoot, runnerUid: uid }
    }
  } catch {
    // A disappeared or inaccessible endpoint is unavailable.
  }
  cached = { key, at: now, result: Object.freeze(result) }
  return cached.result
}

export function workDirectory(workRoot, botId, cwd) {
  if (!isBotId(botId)) return undefined
  const area = join(workRoot, '.bots', botId)
  if (cwd === undefined) return area
  if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0')) return undefined
  const target = resolve(area, cwd)
  if (target === area || target.startsWith(`${area}/`)) return target
}

function readLines(onLine) {
  const pending = Buffer.alloc(MAX_LINE_BYTES)
  let length = 0
  return {
    push(chunk) {
      for (let offset = 0; offset < chunk.length;) {
        const newline = chunk.indexOf(0x0a, offset)
        const end = newline === -1 ? chunk.length : newline
        const size = end - offset
        if (length + size > pending.length) throw new Error('runner line is too long')
        chunk.copy(pending, length, offset, end)
        length += size
        if (newline === -1) return
        const line = utf8.decode(pending.subarray(0, length))
        length = 0
        offset = newline + 1
        onLine(line)
      }
    },
    complete: () => length === 0,
  }
}

function exitResult(frame) {
  const signal = typeof frame.signal === 'string' && Object.hasOwn(osConstants.signals, frame.signal)
    ? osConstants.signals[frame.signal] : undefined
  const code = Number.isInteger(frame.code) && frame.code >= 0 && frame.code <= 255 ? frame.code : undefined
  const validStatus = frame.signal === null ? code !== undefined : frame.code === null && signal !== undefined
  if (!validStatus || typeof frame.timedOut !== 'boolean' || typeof frame.truncated !== 'boolean'
    || !Number.isSafeInteger(frame.ms) || Object.keys(frame).length !== 6) throw new Error('invalid runner exit frame')
  return { code: frame.timedOut ? 124 : code ?? 128 + signal, timedOut: frame.timedOut, truncated: frame.truncated }
}

function collectOutput() {
  let bytes = Buffer.alloc(0)
  let length = 0
  return {
    append(chunk) {
      const end = length + chunk.length
      if (end > bytes.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_OUTPUT_BYTES, Math.max(end, bytes.length * 2)))
        bytes.copy(grown, 0, 0, length)
        bytes = grown
      }
      chunk.copy(bytes, length)
      length = end
    },
    text: () => bytes.toString('utf8', 0, length),
  }
}

const failure = (code, message) => ({ code: 125, timedOut: false, truncated: false, refusal: { code, message } })

export async function run({ botId, argv, cwd, env = {}, timeoutMs, signal, beforeWrite }) {
  const failed = (code, message) => ({ ...failure(code, message), stdout: '', stderr: '' })
  if (signal?.aborted) return failed('CANCELLED', 'Bot command cancelled')
  const config = inspect()
  if (!config.ok) return failed('UNAVAILABLE', 'Bot runner endpoint is unavailable')
  if (!normalizedAbsolute(cwd) || workDirectory(config.workRoot, botId, cwd) !== cwd
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !Array.isArray(argv) || argv.length < 1 || argv.length > 1024
    || !argv.every(value => typeof value === 'string' && !value.includes('\0'))
    || !argv[0] || argv[0].startsWith('-')) return failed('BAD_REQUEST', 'Invalid Bot command request')
  const allowedEnv = Object.fromEntries(ENV_KEYS.flatMap(key => {
    const value = env?.[key]
    return typeof value === 'string' && value.length <= 32 * 1024 && !value.includes('\0') ? [[key, value]] : []
  }))
  const request = JSON.stringify({ v: 2, identity: { kind: 'bot', id: botId }, argv, cwd, env: allowedEnv, timeoutMs })
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) return failed('TOO_LARGE', 'Bot command exceeds the runner request limit')
  const dshUid = process.geteuid()

  return new Promise(resolveResult => {
    let socket
    try { socket = connect(config.socket) } catch {
      resolveResult(failed('UNAVAILABLE', 'Bot runner connection failed'))
      return
    }
    const stdout = collectOutput()
    const stderr = collectOutput()
    let outputBytes = 0
    let state = 'challenge'
    let started = false
    let terminal
    let timer
    let settled = false

    function finish(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      resolveResult({
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
      })
    }

    function deadline(ms) {
      clearTimeout(timer)
      timer = setTimeout(() => finish(failure('NO_REPLY', 'Bot runner did not finish in time')), ms)
    }

    function abort() {
      finish(failure('CANCELLED', 'Bot command cancelled'))
    }

    function onLine(line) {
      if (terminal !== undefined) throw new Error('data after the terminal runner frame')
      if (state !== 'frames' && line.startsWith('refused: ')) {
        terminal = failure('REFUSED', line.slice('refused: '.length))
        return
      }
      if (state === 'challenge') {
        if (line.length !== 48 || !/^[0-9a-f]+$/.test(line)) throw new Error('invalid runner proof challenge')
        const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW
        try {
          const fd = fs.openSync(join(config.proofs, line), flags, 0o600)
          try { fs.fchmodSync(fd, 0o600) } finally { fs.closeSync(fd) }
        } catch {
          terminal = failure('PROOF_FAILED', 'Could not create the Bot runner proof')
          finish(terminal)
          return
        }
        state = 'verdict'
        socket.write('\n')
        return
      }
      if (state === 'verdict') {
        if (line !== 'ok') throw new Error('invalid runner proof verdict')
        state = 'frames'
        // The runner starts its command timer at spawn, before the switch marker arrives.
        deadline(PROVISION_ALLOWANCE_MS + timeoutMs + REPLY_GRACE_MS)
        try { beforeWrite?.() } catch {
          terminal = failure('REFUSED', 'Bot command admission is no longer valid')
          finish(terminal)
          return
        }
        socket.write(`${request}\n`)
        return
      }
      const frame = JSON.parse(line)
      switch (frame?.t) {
        case 'start':
          if (started || frame.bot !== botId || Object.hasOwn(frame, 'member') || Object.keys(frame).length !== 7
            || !numericId(frame.uid, MIN_SUBORDINATE_ID) || !numericId(frame.gid, MIN_SUBORDINATE_ID)
            || frame.uid === config.runnerUid || frame.uid === dshUid || frame.mode !== 'subuid'
            || typeof frame.run !== 'string' || frame.run === '' || frame.unit !== `am-bot-${frame.run}`) {
            throw new Error('invalid runner start frame')
          }
          started = true
          // The runner owns the command deadline. Allow a bounded wait for its reply.
          deadline(timeoutMs + REPLY_GRACE_MS)
          break
        case 'out':
        case 'err': {
          if (!started || typeof frame.d !== 'string' || Object.keys(frame).length !== 2) throw new Error('invalid runner output frame')
          const chunk = Buffer.from(frame.d, 'base64')
          if (chunk.length > CHUNK_BYTES || chunk.toString('base64') !== frame.d) throw new Error('invalid runner output encoding')
          outputBytes += chunk.length
          if (outputBytes > MAX_OUTPUT_BYTES) throw new Error('runner output exceeds the protocol limit')
          const stream = frame.t === 'out' ? stdout : stderr
          stream.append(chunk)
          break
        }
        case 'exit':
          if (!started) throw new Error('runner exit before start')
          terminal = exitResult(frame)
          break
        case 'error':
          if (typeof frame.code !== 'string' || !/^[A-Z][A-Z_0-9]*$/.test(frame.code)
            || typeof frame.message !== 'string' || Object.keys(frame).length !== 3) throw new Error('invalid runner error frame')
          terminal = failure(frame.code, frame.message)
          break
        default:
          throw new Error('invalid runner frame')
      }
    }

    const lines = readLines(onLine)
    socket.on('data', chunk => {
      try { lines.push(chunk) } catch {
        finish(failure('PROTOCOL', 'Malformed Bot runner reply'))
      }
    })
    socket.on('error', () => finish(failure('UNAVAILABLE', 'Bot runner connection failed')))
    socket.once('close', () => finish(failure('PROTOCOL', 'Bot runner closed without a clean reply')))
    socket.once('end', () => {
      finish(terminal !== undefined && lines.complete() ? terminal : failure('PROTOCOL', 'Incomplete Bot runner reply'))
    })
    signal?.addEventListener('abort', abort, { once: true })
    deadline(5_000)
    if (signal?.aborted) abort()
  })
}
