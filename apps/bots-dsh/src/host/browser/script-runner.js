// Runs a browser_exec body away from the host process. The model writes the body, and a
// page can talk the model into writing anything. Two walls stand around it.
//
// The inner wall is the boundary: the interpreter (src/script-child/sandbox.js). The body
// runs in QuickJS compiled to WebAssembly, inside the child process. It shares no object
// with that process's Node, and what crosses is two functions that take text. It has no
// file, process, signal or network API, because nothing gives it one.
//
// The outer wall is the process, for the day the interpreter has a bug. It is a seat
// belt and not a second boundary, and Node says so of its permission model: it "does not
// protect against malicious code", which "can bypass the permission model". So this is a
// list of what Node refuses a script that got out of the interpreter, not of what such a
// script cannot do. Each line has a test on both runtimes the Bot team ships on, Node 24
// and Electron as Node (test/browser-script-wall.test.js):
//
//   refused   files through node:fs, node:module and import(): read, write, list, change
//             the database module that reads and writes files past that (node:sqlite):
//             switched off
//             child processes, worker threads, native addons, WASI, its own inspector
//             the files Node writes on request (a report, a heap snapshot)
//             a change of working folder; that folder is an empty one made for the run
//   withheld  the host's environment: the child gets an empty one
//             the host itself: the one channel is JSON lines on the child's stdin and
//             stdout, and a line the host does not accept ends the run
//             time: at the deadline the host kills the child, it does not ask. The child
//             keeps the same deadline itself, one second later: the interpreter stops a
//             script whose own code never yields, and the process leaves
//
// What no flag of Node 24 refuses, and so what a script that got out of the interpreter
// could still do:
//
//   - use the network, local sockets included (Node 26 refuses it with these same flags);
//   - signal, or change the priority of, any process of the same user, this host among
//     them. A host that was stopped that way kills nothing at the deadline, and the
//     child's own deadline is the script's to remove once it is out;
//   - read facts about the machine: user name, home folder, host name, network
//     interfaces, and whether a path exists (the last one not from Node 24.22);
//   - on Node 24.9 only, have Node write a trace log or a heap snapshot into the working
//     folder, which is why that folder is the run's own;
//   - change V8's flags, which Node names as outside the model, and from there whatever
//     the bypass Node warns of allows: at worst, what the user's account allows.
//
// Also not bounded or not cleaned, for any script:
//
//   - memory: the two flags below bound the interpreter's WebAssembly memory and the old
//     space of the child's heap. The rest of the child's memory has no flag bound;
//   - time: a script that is busy inside one long call of a built-in is stopped by the
//     host only, so it can outlive a host that is gone or stopped;
//   - the run's folder stays behind when the host exits before it sees the child exit;
//   - the path of the child's entry file is in the interpreter's memory. A script has no
//     way to read it short of a bug in the interpreter.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPT_TIMEOUT = 20_000
const CHILD = fileURLToPath(new URL('./script-child.js', import.meta.url))

// The child's flags and no others: the host's own (loaders, --expose-internals) are not
// the child's. --permission with no --allow-* flag refuses what the list above says;
// node:sqlite is outside that model and goes by its own flag. Memory: the script's is
// the interpreter's WebAssembly memory, capped here at 2,048 pages of 64 KiB (128 MB),
// past which the script gets an out-of-memory error of its own; the old space of the
// child's own heap is capped beside it at 128 MB. These two flags bound only those two:
// the rest of the child's memory (the young space of its heap, and what Node and the
// interpreter hold outside both) has no flag bound.
const CHILD_FLAGS = ['--permission', '--no-experimental-sqlite', '--wasm-max-mem-pages=2048', '--max-old-space-size=128']

// The longest text that crosses, either way: a helper call's arguments, a helper's reply,
// the answer and an error. The child keeps the same limit on what it sends; this side
// does not take its word for it. And the longest line that can carry such a text: JSON
// escaping makes at most six characters of one.
const MAX_TEXT = 4_000_000
const MAX_LINE = MAX_TEXT * 6 + 1_000
// The most reply text that may wait here for the child to take it, 64 MB: each reply is
// held until the child reads it. Two kinds of script get there: one that makes calls and
// then never yields, and one that waits for many large replies at once, which come
// faster than it can read them.
const MAX_WAITING = MAX_TEXT * 16

// The child sees none of the host's environment (keys, tokens, DSH_HOME). Windows needs
// SystemRoot to start a process; the desktop app's host is Electron run as Node, and so
// must the child be.
function childEnv() {
  const env = {}
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

// What the child sends and nothing else: a call of one of the helpers, or the one
// answer. Anything else comes from a child that is no longer ours.
function readMessage(line, helpers) {
  let message
  try { message = JSON.parse(line) } catch { return undefined }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const text = value => value === null || (typeof value === 'string' && value.length <= MAX_TEXT)
  if (message.type === 'done') return text(message.answer) && text(message.error) ? message : undefined
  if (message.type !== 'call') return undefined
  const { id, name, args } = message
  if (!Number.isSafeInteger(id) || id < 1) return undefined
  if (typeof name !== 'string' || !Object.hasOwn(helpers, name)) return undefined
  if (typeof args !== 'string' || args.length > MAX_TEXT) return undefined
  return message
}

// helpers: name → async function on the host. Only JSON crosses in either direction.
// `entry` is the child's file; only the tests give another.
export function runIsolatedScript(body, helpers, { timeout = SCRIPT_TIMEOUT, entry = CHILD } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let child
    let folder
    // The folder goes when the child is gone: only then is nothing writing into it.
    const clear = () => {
      try { if (folder !== undefined) rmSync(folder, { recursive: true, force: true }) } catch {}
    }
    const end = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // SIGKILL: a child that handles or ignores SIGTERM would outlive its run, and it
      // holds nothing worth a clean exit.
      if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      settle(value)
    }
    // The kill stops a script that never yields, which a Promise.race cannot.
    const timer = setTimeout(() => end(reject, new Error(`Script ran longer than ${timeout / 1000} seconds.`)), timeout)
    try {
      // An empty working folder of the run's own: what Node itself writes for a process
      // (a trace log, a snapshot at the heap limit) lands there and not in the host's.
      folder = mkdtempSync(join(tmpdir(), 'browser-exec-'))
      child = spawn(process.execPath, [...CHILD_FLAGS, entry], {
        cwd: folder,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      })
    } catch (error) {
      clear()
      end(reject, new Error(`Could not start the script: ${error?.message ?? error}`))
      return
    }
    const send = message => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch {}
    }
    const refuse = () => end(reject, new Error('Script stopped: it sent the host something that is not a helper call or an answer.'))
    const receive = async (line) => {
      const message = readMessage(line, helpers)
      if (message === undefined) return refuse()
      if (message.type === 'done') {
        if (message.error === null) end(resolve, message.answer)
        else end(reject, new Error(message.error))
        return
      }
      let reply
      try {
        const args = JSON.parse(message.args)
        const value = await helpers[message.name](...(Array.isArray(args) ? args : []))
        const json = JSON.stringify(value)
        // A reply the script's memory may have no room for is not sent: the call fails.
        if (json !== undefined && json.length > MAX_TEXT) throw new Error('The helper\'s result is larger than 4 MB.')
        reply = { id: message.id, ok: true, value: json === undefined ? null : json }
      } catch (error) {
        const text = String(error?.message ?? error)
        reply = { id: message.id, ok: false, error: text.length > MAX_TEXT ? 'The helper failed.' : text }
      }
      if (settled) return
      send(reply)
      if (child.stdin.writableLength > MAX_WAITING) end(reject, new Error('Script stopped: more than 64 MB of helper replies were waiting for it. It made calls and did not read their replies, or it waited for too many large replies at once.'))
    }
    // One message a line. What has no line end yet is held, up to the longest line.
    let held = []
    let heldLength = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      let from = 0
      // Lines already read when the run ended still arrive; none may act.
      while (!settled) {
        const at = chunk.indexOf('\n', from)
        if (at === -1) break
        held.push(chunk.slice(from, at))
        const line = held.join('')
        held = []
        heldLength = 0
        from = at + 1
        receive(line)
      }
      if (settled || from >= chunk.length) return
      held.push(chunk.slice(from))
      heldLength += chunk.length - from
      if (heldLength > MAX_LINE) refuse()
    })
    // A killed child closes its pipes under a write; the exit below reports it.
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.on('error', (error) => {
      // No process came of it: nothing will exit.
      if (child.pid === undefined) clear()
      end(reject, new Error(`Script stopped: ${error?.message ?? error}`))
    })
    child.on('exit', (code, signal) => {
      clear()
      end(reject, new Error(`Script stopped before it finished (${signal ?? `exit ${code}`}).`))
    })
    send({ type: 'start', body, names: Object.keys(helpers), wait: timeout })
  })
}
