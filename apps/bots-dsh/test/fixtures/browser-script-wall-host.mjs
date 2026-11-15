// The host's side of test/browser-script-wall.test.js, run by the runtime under test
// (Node, or Electron as Node). It goes through the real runner, so the flags, the
// environment and the channel are the runner's own, and prints what came of it as one
// line of JSON. With a check it starts browser-script-wall-child.mjs in the child's
// place; with a script it runs that script in the real child, or in the file `entry`
// names in its place.
//   <runtime> browser-script-wall-host.mjs '<{"check": ..., "timeout": ms, ...}>'
//   <runtime> browser-script-wall-host.mjs '<{"script": "...", "timeout": ms, "entry": path}>'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const request = JSON.parse(process.argv[2])
const entry = fileURLToPath(new URL('./browser-script-wall-child.mjs', import.meta.url))

// The runner's child, to see for ourselves that it is gone afterwards.
let child
const spawn = childProcess.spawn
childProcess.spawn = (...args) => (child = spawn(...args))
syncBuiltinESMExports()
const { runIsolatedScript } = await import('../../src/host/browser/script-runner.js')

let helperCalls = 0
const helpers = {
  goto: async (url) => { helperCalls += 1; return `went to ${url}` },
  big: async (size) => { helperCalls += 1; return 'A'.repeat(size) },
}
const result = { node: process.versions.node, electron: process.versions.electron ?? null, hostCwd: process.cwd() }
const started = performance.now()
try {
  result.answer = typeof request.script === 'string'
    ? await runIsolatedScript(request.script, helpers, { timeout: request.timeout, entry: request.entry })
    : await runIsolatedScript(JSON.stringify(request), helpers, { timeout: request.timeout, entry })
} catch (error) {
  result.error = String(error?.message ?? error)
}
// How long the run took to settle.
result.ms = Math.round(performance.now() - started)
// A long answer or error is told by its length and its ends: the test reads one line of this.
for (const name of ['answer', 'error']) {
  if (typeof result[name] !== 'string' || result[name].length <= 10_000) continue
  result[`${name}Length`] = result[name].length
  result[name] = `${result[name].slice(0, 20)}...${result[name].slice(-20)}`
}
result.helperCalls = helperCalls
// A settled run alone does not prove that the process stopped.
result.exit = await new Promise((resolve) => {
  const ended = () => ({ code: child.exitCode, signal: child.signalCode })
  if (child.exitCode !== null || child.signalCode !== null) return resolve(ended())
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    resolve('survived')
  }, 3_000)
  child.once('exit', () => { clearTimeout(timer); resolve(ended()) })
})
console.log(JSON.stringify(result))
process.exit(0)
