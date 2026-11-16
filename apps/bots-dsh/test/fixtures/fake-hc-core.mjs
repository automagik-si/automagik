#!/usr/bin/env node
// A stand-in herdr-core for the Code side's tests and its bench pictures. It speaks
// `hc connect`'s framed protocol: one JSON hello line, then frames (9-byte little-endian
// header: int32 channel, uint8 kind, int32 length). Never a real core and never a real pane:
// every terminal, its output and the machine's name come from the test's own files.
//
//   FAKE_CORE_LOG        JSONL of what the host said: hello, calls, frames (payload base64)
//   FAKE_CORE_TERMINALS  JSON array of Terminal rows; a fitting default when unset
//   FAKE_CORE_OUTPUT     the text the attach sends (default "fake-pane\n")
//
// The core closes its stream after the first credit by default; FAKE_CORE_KEEP_OPEN=1 keeps
// it open until the host detaches, for a test that reads more than one event.
import { appendFileSync, readFileSync } from 'node:fs'

const logPath = process.env.FAKE_CORE_LOG
const log = (row) => {
  if (!logPath) return
  try { appendFileSync(logPath, `${JSON.stringify(row)}\n`) } catch { /* a test log is best effort */ }
}

const DEFAULT_TERMINALS = [
  { address: 't7', created_ms: 700, state: 'live', cols: 120, rows: 40, status: 'idle', agent: 'claude-code', cwd: '/src/app', name: 'main' },
  { address: 't8', created_ms: 800, state: 'live', cols: 100, rows: 30, status: 'working', agent: 'claude-code', cwd: '/src/app', name: 'dev' },
]
const terminals = (() => {
  try {
    const parsed = JSON.parse(readFileSync(process.env.FAKE_CORE_TERMINALS, 'utf8'))
    return Array.isArray(parsed) ? parsed : DEFAULT_TERMINALS
  } catch { return DEFAULT_TERMINALS }
})()
const output = Buffer.from((process.env.FAKE_CORE_OUTPUT ?? 'fake-pane\r\n').replace(/\n/g, '\r\n'), 'utf8')
const keepOpen = process.env.FAKE_CORE_KEEP_OPEN === '1'

const frame = (channel, kind, payload = Buffer.alloc(0)) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const bytes = Buffer.allocUnsafe(9 + body.length)
  bytes.writeInt32LE(channel, 0)
  bytes.writeUInt8(kind, 4)
  bytes.writeInt32LE(body.length, 5)
  body.copy(bytes, 9)
  return bytes
}
const say = (...frames) => process.stdout.write(Buffer.concat(frames))
const closeFrame = (channel, reason) => frame(channel, 2, Buffer.from(JSON.stringify({ reason })))
const find = address => terminals.find(terminal => terminal.address === address)

let buffer = Buffer.alloc(0)
let started = false
let attachChannel = 7
let outputSent = false
let closedSent = false

function answer(id, result) {
  say(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))))
}
function refuse(id, kind, message = kind) {
  say(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message, data: { kind } } }))))
}

function handleCall(call) {
  log({ dir: 'in', type: 'call', method: call.method, params: call.params })
  switch (call.method) {
    case 'hello':
      log({ dir: 'out', type: 'hello' })
      say(Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: call.id,
        result: { core: { id: 'core-test', name: 'test-machine' }, framed: true, generation: 1, version: 'fake-0.0.1', features: ['framed', 'attach'], methods: ['hello', 'terminal.list', 'terminal.get', 'terminal.attach'] },
      }) + '\n'))
      started = true
      return
    case 'terminal.list':
      return answer(call.id, { terminals })
    case 'terminal.get': {
      const terminal = find(call.params?.terminal)
      return terminal ? answer(call.id, terminal) : refuse(call.id, 'not_found')
    }
    case 'terminal.attach': {
      const terminal = find(call.params?.terminal)
      if (!terminal) return refuse(call.id, 'not_found')
      log({ dir: 'out', type: 'attach', channel: attachChannel, terminal: terminal.address })
      answer(call.id, { channel: attachChannel, terminal, resize_notifications: true, automatic_input: false })
      say(frame(attachChannel, 0, output))
      outputSent = true
      if (!keepOpen) {
        // A credit means the host took the first paint: hand it the rest, then say why the
        // stream ended, the way herdr-core does for a program that finished.
        // The close is sent when the credit arrives (see handleFrame).
      }
      return
    }
    case 'server.stop':
      answer(call.id, { stopped: true })
      setTimeout(() => process.exit(0), 10)
      return
    default:
      return refuse(call.id, 'unknown_method')
  }
}

function handleFrame(header, payload) {
  log({ dir: 'in', type: 'frame', channel: header.channel, kind: header.kind, length: payload.length, payload: payload.toString('base64') })
  if (header.channel === 0 && header.kind === 0) {
    let call = null
    try { call = JSON.parse(payload.toString('utf8')) } catch { return }
    return handleCall(call)
  }
  if (header.channel === attachChannel && header.kind === 1 && outputSent && !keepOpen && !closedSent) {
    // The first credit: send a second line and close, so a test sees data then close.
    closedSent = true
    say(frame(attachChannel, 0, Buffer.from('second-line\r\n', 'utf8')))
    setTimeout(() => { say(closeFrame(attachChannel, 'ended')); setTimeout(() => process.exit(0), 50) }, 5)
    return
  }
  if (header.channel === attachChannel && header.kind === 2) {
    log({ dir: 'out', type: 'detached', channel: attachChannel })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
  if (!started) {
    const end = buffer.indexOf(10)
    if (end === -1) return
    const line = buffer.subarray(0, end).toString('utf8')
    buffer = buffer.subarray(end + 1)
    log({ dir: 'in', type: 'hello-line' })
    let hello = null
    try { hello = JSON.parse(line) } catch { hello = null }
    if (!hello) process.exit(2)
    handleCall(hello)
    if (!started) return
  }
  while (buffer.length >= 9) {
    const length = buffer.readInt32LE(5)
    if (buffer.length < 9 + length) return
    const header = { channel: buffer.readInt32LE(0), kind: buffer.readUInt8(4), length }
    const payload = buffer.subarray(9, 9 + length)
    buffer = buffer.subarray(9 + length)
    handleFrame(header, payload)
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
