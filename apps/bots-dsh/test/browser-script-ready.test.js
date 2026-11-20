// When the script's budget starts (src/host/browser/script-runner.js): when the child
// says it is ready, not when it is spawned. A machine under load can take long to start a
// process and open its interpreter; that time is not the script's. The start has its own
// bound, twice the budget, so a child that never gets ready is still killed. The host arms
// its budget before it lets the child go, and the child's own clock starts at that `go`,
// so the host's deadline still comes first.
//
// The slow starts here are the real child with one thing slowed in front of it: the
// WebAssembly compile of its interpreter (openSandbox), which is the start's own work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess, { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runIsolatedScript } from '../src/host/browser/script-runner.js'

const CHILD = fileURLToPath(new URL('../src/host/browser/script-child.js', import.meta.url))
const HOST = fileURLToPath(new URL('./fixtures/browser-script-wall-host.mjs', import.meta.url))
const CHILD_FLAGS = ['--permission', '--no-experimental-sqlite', '--wasm-max-mem-pages=2048', '--max-old-space-size=128']
const REFUSED = /not a helper call or an answer/
// src/script-child/main.js's GRACE, and its exit code when it can no longer speak.
const GRACE = 1_000
const SILENT = 70

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'script-ready-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// A file the runner starts in the child's place. The process may read its entry file and
// nothing else, so a change to the real child is written in front of a copy of it.
function entryFile(t, source) {
  const path = join(scratch(t), 'child.mjs')
  writeFileSync(path, source)
  return path
}
const realChild = (t, prefix) => entryFile(t, `${prefix}\n${readFileSync(CHILD, 'utf8')}`)
const slowInit = ms => `{
  const instantiate = WebAssembly.instantiate
  WebAssembly.instantiate = async (...args) => {
    await new Promise(done => setTimeout(done, ${ms}))
    return instantiate.apply(WebAssembly, args)
  }
}`
const neverInit = '{ WebAssembly.instantiate = () => new Promise(() => {}) }'
// A child of our own that writes the lines the start's body names, `after` ms apart.
const SCRIPTED = `
let held = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  held += chunk
  const at = held.indexOf('\\n')
  if (at === -1) return
  const start = JSON.parse(held.slice(0, at))
  held = ''
  if (start.type !== 'start') return
  const { steps } = JSON.parse(start.body)
  let delay = 0
  for (const { after = 0, text } of steps) {
    delay += after
    setTimeout(() => process.stdout.write(text), delay)
  }
})
setInterval(() => {}, 1_000)
`
const line = message => `${JSON.stringify(message)}\n`
const READY = line({ type: 'ready' })
const CALL = line({ type: 'call', id: 1, name: 'goto', args: '["https://example.com/"]' })

// The runner's children, to see that they are gone afterwards.
function observeChildren(t) {
  const children = []
  const spawn = childProcess.spawn
  const spy = t.mock.method(childProcess, 'spawn', (...args) => {
    const child = spawn(...args)
    children.push(child)
    return child
  })
  syncBuiltinESMExports()
  t.after(() => {
    spy.mock.restore()
    syncBuiltinESMExports()
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
  return children
}

// How the process ended, or 'survived' if it is still there after `ms`.
function exitOf(child, ms = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((done) => {
    const timer = setTimeout(() => done('survived'), ms)
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }) })
  })
}

// The clock starts before the run does.
async function timed(run) {
  const started = performance.now()
  try {
    return { answer: await run(), ms: performance.now() - started }
  } catch (error) {
    return { error: String(error?.message ?? error), ms: performance.now() - started }
  }
}

test('a slow start does not eat the budget: the script still gets all of it once the child is ready', async (t) => {
  // The interpreter takes 5 s to open, more than the 4 s budget; the script then waits
  // 2.5 s. Counted from the spawn, that is 7.5 s against 4 and the run would be cut.
  const entry = realChild(t, slowInit(5_000))
  const result = await timed(() => runIsolatedScript('await new Promise(r => setTimeout(r, 2500)); done("waited")', {}, { timeout: 4_000, entry }))
  assert.equal(result.error, undefined)
  assert.equal(result.answer, 'waited')
  assert.ok(result.ms >= 7_500, `answered after ${result.ms} ms`)
})

test('after a slow start, a script that never yields and one that waits forever are stopped at the budget', async (t) => {
  for (const body of ['for (;;) {}', 'await new Promise(() => {})']) {
    const children = observeChildren(t)
    const entry = realChild(t, slowInit(1_500))
    const result = await timed(() => runIsolatedScript(body, {}, { timeout: 1_000, entry }))
    assert.match(result.error ?? `answered ${result.answer}`, /^Script ran longer than 1 seconds\.$/, body)
    // The start's 1.5 s, then the whole budget.
    assert.ok(result.ms >= 2_500, `${body}: stopped after ${result.ms} ms`)
    assert.equal(children.length, 1)
    assert.notEqual(await exitOf(children[0]), 'survived', body)
  }
})

test('a child that never says it is ready is killed at twice the budget', async (t) => {
  const children = observeChildren(t)
  const entry = entryFile(t, 'process.stdin.on("data", () => {})\nsetInterval(() => {}, 1_000)\n')
  const result = await timed(() => runIsolatedScript('return 1', {}, { timeout: 500, entry }))
  assert.equal(result.error, 'Script ran longer than 0.5 seconds.')
  assert.ok(result.ms >= 1_000, `stopped after ${result.ms} ms`)
  assert.ok(result.ms < 15_000, `stopped after ${result.ms} ms`)
  const exit = await exitOf(children[0])
  assert.notEqual(exit, 'survived')
  if (process.platform !== 'win32') assert.equal(exit.signal, 'SIGKILL')
})

test('ready is said once, and never after the run began', async (t) => {
  const run = async (steps) => {
    const calls = []
    const entry = entryFile(t, SCRIPTED)
    const result = await timed(() => runIsolatedScript(JSON.stringify({ steps }), { goto: async (url) => { calls.push(url); return 'went' } }, { timeout: 1_000, entry }))
    return { ...result, calls }
  }
  const twice = await run([{ text: READY }, { after: 100, text: READY }])
  assert.match(twice.error, REFUSED)
  // A helper call before any ready begins the run; a ready after it is refused, whether
  // it comes later or in the same chunk.
  const later = await run([{ text: CALL }, { after: 100, text: READY }])
  assert.match(later.error, REFUSED)
  const sameChunk = await run([{ text: CALL + READY }])
  assert.match(sameChunk.error, REFUSED)
  // Ready then a call in one chunk is the ordinary order: the helper is called, and the
  // child, which then says nothing, is stopped at the budget.
  const ordinary = await run([{ text: READY + CALL }])
  assert.equal(ordinary.error, 'Script ran longer than 1 seconds.')
  assert.deepEqual(ordinary.calls, ['https://example.com/'])
})

test('the child\'s clock starts at the host\'s go, not at its own ready', async (t) => {
  // The real child started by hand, asked to say ready. The host here waits 2.5 s after
  // ready before it says go: longer than the child's budget plus its grace, shorter than
  // its start watchdog (twice the budget plus the grace, 5 s).
  const run = async (body) => {
    const child = childProcess.spawn(process.execPath, [...CHILD_FLAGS, CHILD], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    let lines = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { lines += chunk })
    child.stdin.write(line({ type: 'start', body, names: [], wait: 2_000, ready: true }))
    const deadline = Date.now() + 10_000
    while (lines !== READY && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    assert.equal(lines, READY, `${body}: first and only line before go`)
    await new Promise(r => setTimeout(r, 2_500))
    assert.equal(lines, READY, `${body}: nothing ran before go`)
    assert.equal(child.exitCode, null, `${body}: still there at go`)
    const go = Date.now()
    child.stdin.write(line({ type: 'go' }))
    const exit = await exitOf(child, 10_000)
    return { exit, lines, ms: Date.now() - go }
  }
  const loop = await run('for (;;) {}')
  assert.deepEqual(loop.exit, { code: 0, signal: null })
  assert.ok(loop.ms >= 2_000 + GRACE, `left ${loop.ms} ms after go`)
  assert.deepEqual(loop.lines.trim().split('\n').map(text => JSON.parse(text)), [{ type: 'ready' }, { type: 'done', answer: null, error: 'Script ran longer than 2 seconds.' }])
  const waits = await run('await new Promise(() => {})')
  assert.deepEqual(waits.exit, { code: 0, signal: null })
  assert.ok(waits.ms >= 2_000 + GRACE, `left ${waits.ms} ms after go`)
  assert.equal(waits.lines, READY)
})

test('a child whose interpreter never opens leaves by itself at its start watchdog', async (t) => {
  // Nobody kills it and its input stays open: only its own watchdog ends it.
  const entry = realChild(t, neverInit)
  const child = childProcess.spawn(process.execPath, [...CHILD_FLAGS, entry], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  let lines = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { lines += chunk })
  const started = Date.now()
  child.stdin.write(line({ type: 'start', body: 'return 1', names: [], wait: 300, ready: true }))
  const exit = await exitOf(child, 10_000)
  assert.deepEqual(exit, { code: 0, signal: null })
  assert.ok(Date.now() - started >= 2 * 300 + GRACE, `left after ${Date.now() - started} ms`)
  assert.equal(lines, '')
})

test('a script cannot say ready or go: those texts cross as its own data', async () => {
  const forged = '\n{"type":"ready"}\n{"type":"go"}\n'
  const seen = []
  const answer = await runIsolatedScript(`return await goto(${JSON.stringify(forged)})`, { goto: async (text) => { seen.push(text); return text } })
  assert.equal(answer, forged)
  assert.deepEqual(seen, [forged])
  // Had the host read a ready from the script, the run would end as refused, not at the
  // budget.
  const result = await timed(() => runIsolatedScript(`await goto(${JSON.stringify(forged)}); for (;;) {}`, { goto: async () => 'x' }, { timeout: 500 }))
  assert.equal(result.error, 'Script ran longer than 0.5 seconds.')
})

test('the deadlines hold by the clock even when the host\'s timer has not fired', async (t) => {
  // The host's timers never fire here: only its check of the clock can end these runs.
  // The fixture's delays are the child's own, on its real clock.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const children = observeChildren(t)
  const gone = child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(done => child.once('exit', done))
  const run = async (steps) => {
    const calls = []
    const entry = entryFile(t, SCRIPTED)
    const error = await runIsolatedScript(JSON.stringify({ steps }), { goto: async (url) => { calls.push(url); return 'went' } }, { timeout: 300, entry })
      .then(answer => `answered ${answer}`, error => error.message)
    return { error, calls }
  }
  // Ready after the start's bound (twice 300 ms) has passed: the run ends there.
  const lateReady = await run([{ after: 900, text: READY }])
  assert.equal(lateReady.error, 'Script ran longer than 0.3 seconds.')
  await gone(children.at(-1))
  // Ready in time, then a call after the budget has passed: the helper is not called.
  const lateCall = await run([{ text: READY }, { after: 900, text: CALL }])
  assert.equal(lateCall.error, 'Script ran longer than 0.3 seconds.')
  assert.deepEqual(lateCall.calls, [])
  await gone(children.at(-1))
  // A call before any ready, after the start's bound: not called either.
  const lateFirstCall = await run([{ after: 900, text: CALL }])
  assert.equal(lateFirstCall.error, 'Script ran longer than 0.3 seconds.')
  assert.deepEqual(lateFirstCall.calls, [])
  await gone(children.at(-1))
})

// The real child with its output made to fail at the second write, not the first: the
// first is now its ready line, so test/browser-script-wall.test.js's case fails there. This
// one fails the write of the helper call or the answer, on both runtimes.
const SECOND_WRITE_FAILS = `{
  let writes = 0
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = (...args) => {
    writes += 1
    if (writes === 2) throw new RangeError('Maximum call stack size exceeded')
    if (writes > 2) return true
    return write(...args)
  }
}`

function electronPath() {
  if (process.env.ELECTRON_BIN) return process.env.ELECTRON_BIN
  const dir = resolve(import.meta.dirname, '..', '..', 'desktop', 'node_modules', 'electron')
  try { return join(dir, 'dist', readFileSync(join(dir, 'path.txt'), 'utf8').trim()) } catch { return undefined }
}

const RUNTIMES = [
  { name: 'Node', path: () => process.execPath, env: {} },
  { name: 'Electron as Node', path: electronPath, env: { ELECTRON_RUN_AS_NODE: '1' }, electron: true },
]

for (const runtime of RUNTIMES) {
  test(`${runtime.name}: a child whose output fails after its ready line leaves at once, and the run ends as stopped`, async (t) => {
    const path = runtime.path()
    if (path === undefined || !existsSync(path)) {
      if (process.env.CI) assert.fail(`no Electron at ${path} (ELECTRON_BIN=${process.env.ELECTRON_BIN ?? 'unset'}); CI must run it`)
      t.skip('The Electron half requires ELECTRON_BIN or the desktop app\'s npm install')
      return
    }
    const entry = realChild(t, SECOND_WRITE_FAILS)
    for (const script of ['return await goto("https://example.com/")', 'return "said"']) {
      const stdout = await new Promise((done, fail) => {
        execFile(path, [HOST, JSON.stringify({ script, entry, timeout: 10_000 })], {
          env: { ...process.env, ...runtime.env },
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }, (error, out, err) => error ? fail(new Error(`${runtime.name} host failed: ${error.message}\n${err}`)) : done(out))
      })
      const result = JSON.parse(stdout.trim().split('\n').at(-1))
      assert.equal(typeof result.electron, runtime.electron ? 'string' : 'object', `host ran on ${JSON.stringify(result)}`)
      assert.equal(result.answer, undefined, script)
      assert.equal(result.error, `Script stopped before it finished (exit ${SILENT}).`, script)
      assert.deepEqual(result.exit, { code: SILENT, signal: null }, script)
      assert.equal(result.helperCalls, 0, script)
      // Well before the deadline, which a child that stays would wait for.
      assert.ok(result.ms < 5_000, `${script}: settled after ${result.ms} ms`)
    }
  })
}

test('a host timer that fires before its deadline waits out the rest, in both phases', { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1_000_000
  t.mock.method(performance, 'now', () => now)
  const children = observeChildren(t)
  const settle = (run) => {
    let state
    run.then(answer => { state = { answer } }, error => { state = { error: error.message } })
    return () => state
  }
  const turn = () => new Promise(r => setImmediate(r))
  const error = 'Script ran longer than 0.5 seconds.'

  const neverReady = entryFile(t, 'process.stdin.on("data", () => {})\nsetInterval(() => {}, 1_000)\n')
  const t0 = now
  const start = settle(runIsolatedScript('return 1', {}, { timeout: 500, entry: neverReady }))
  now = t0 + 999.8
  t.mock.timers.tick(1_000)
  await turn()
  assert.equal(start(), undefined)
  t.mock.timers.tick(1)
  await turn()
  assert.equal(start(), undefined)
  now = t0 + 1_000
  t.mock.timers.tick(1)
  await turn()
  assert.deepEqual(start(), { error })
  const child = children[0]
  if (child.exitCode === null && child.signalCode === null) await new Promise(done => child.once('exit', done))
  if (process.platform !== 'win32') assert.equal(child.signalCode, 'SIGKILL')

  const entry = entryFile(t, SCRIPTED)
  const { promise: began, resolve: begin } = Promise.withResolvers()
  const goto = () => {
    begin()
    return new Promise(() => {})
  }
  const t1 = now
  const run = settle(runIsolatedScript(JSON.stringify({ steps: [{ text: READY + CALL }] }), { goto }, { timeout: 500, entry }))
  // The early start timer re-arms before the child can say ready.
  now = t1 + 999.8
  t.mock.timers.tick(1_000)
  await began
  const runDeadline = now + 500
  // Ready clears the re-armed start timer before its deadline passes.
  now = t1 + 1_000
  t.mock.timers.tick(1)
  await turn()
  assert.equal(run(), undefined)

  now = runDeadline - 0.2
  t.mock.timers.tick(499)
  await turn()
  assert.equal(run(), undefined)
  t.mock.timers.tick(1)
  await turn()
  assert.equal(run(), undefined)
  now = runDeadline
  t.mock.timers.tick(1)
  await turn()
  assert.deepEqual(run(), { error })
})
