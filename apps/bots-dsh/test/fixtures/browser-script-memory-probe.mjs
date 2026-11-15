// The sandbox with the runner's cap on its memory, in one process that can look at the
// interpreter's memory from outside: test/browser-script-wall.test.js starts this on each
// runtime with script-runner.js's --wasm-max-mem-pages flag. A real script fills the
// interpreter to the cap, gives `free` of its arrays back and awaits a helper; this side
// answers the helper with a reply of `reply` characters. Prints, as one line of JSON, what
// the script made of it, whether each text this side placed in the interpreter for that
// reply came back as text of the interpreter's, and a fixed sample of the interpreter's
// memory before and after.
//   <runtime> --wasm-max-mem-pages=2048 browser-script-memory-probe.mjs '<{"free": n, "reply": n}>'
import { createHash } from 'node:crypto'
import { openSandbox } from '../../src/script-child/sandbox.js'

const { free, reply } = JSON.parse(process.argv[2])
const calls = []
const finishes = []
const sandbox = await openSandbox({
  call: (name) => {
    calls.push(name)
    return calls.length
  },
  finish: (...args) => finishes.push(args),
})
// Parts of the interpreter's memory that a helper's reply does not change: its first
// 64 KiB, and a few bytes at three places further on.
const sample = () => {
  // Asked for each time: the memory is a new array after it grew.
  const memory = sandbox.context.module.HEAPU8
  const digest = (from, count) => createHash('sha256').update(memory.subarray(from, from + count)).digest('hex')
  return {
    start: digest(0, 65536),
    places: [digest(65536, 16), digest(1 << 20, 16), digest(3 << 20, 16)],
    megabytes: Math.round(memory.length / 1048576),
  }
}
// The fill stops at 400 arrays (about 320 MB) on a runtime that did not take the cap.
sandbox.start(['big'], `
  const kept = []
  try { while (kept.length < 400) kept.push(new Array(100000).fill(kept.length)) } catch (error) {}
  const filled = kept.length
  kept.length -= ${Number(free)}
  let reply
  try { reply = 'got ' + (await big()).length } catch (error) { reply = error === null ? 'null' : error.name + ': ' + error.message }
  // The script goes on with the interpreter it had.
  const after = [1, 2, 3].map(value => value * 2).join() + ' ' + JSON.stringify({ a: 'b' }) + ' ' + typeof Object.keys + ' ' + kept.length
  return JSON.stringify({ filled, reply, after })
`)
// No change to the sandbox: the context's own function is watched from here.
const placed = []
const { context } = sandbox
const newString = context.newString
context.newString = function (value) {
  const handle = newString.call(this, value)
  placed.push(context.typeof(handle) === 'string')
  return handle
}
const before = sample()
sandbox.settle(1, true, JSON.stringify('A'.repeat(reply)))
const after = sample()
console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron ?? null, calls, placed, before, after, finishes }))
process.exit(0)
