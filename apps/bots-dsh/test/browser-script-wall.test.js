// The outer wall of browser_exec (src/host/browser/script-runner.js): what Node refuses
// the script's process, as if the script had got out of its interpreter and owned all of
// that process's JavaScript. So the checks are not scripts: a fixture of plain Node code
// (fixtures/browser-script-wall-child.mjs) is started by the real runner in place of
// script-child.js, and each check is a handful of ordinary, documented calls that must be
// refused. One test for each line of the runner's list, on each runtime the Bot team
// ships on: Node, and Electron as Node (the desktop app). A runtime that takes the flags
// and enforces nothing answers 'allowed' and turns its test red.
//
// What the runner lists as not refused has no test here: the network, signals to the
// same user's processes, facts about the machine, V8's flags.
//
// The last tests run real scripts in the real child on both runtimes: the interpreter is
// what a script meets, with no Node in reach, and its memory stops at the runner's cap.
// At that cap a helper's reply that does not fit is refused: once through the real child,
// and once in a process that reads the interpreter's memory before and after
// (fixtures/browser-script-memory-probe.mjs). And a child whose output fails with a
// stack error leaves at once: the real child again, with that one write made to fail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { GLOBALS } from './fixtures/browser-script-globals.js'

const HOST = fileURLToPath(new URL('./fixtures/browser-script-wall-host.mjs', import.meta.url))
const MEMORY_PROBE = fileURLToPath(new URL('./fixtures/browser-script-memory-probe.mjs', import.meta.url))
const CHILD = fileURLToPath(new URL('../src/host/browser/script-child.js', import.meta.url))
// Placed in front of a copy of the child: its first write to the host throws the error
// of a stack that ran out, and nothing written after that leaves the process.
const OUTPUT_FAILS = `{
  let failed = false
  process.stdout.write = () => {
    if (failed) return true
    failed = true
    throw new RangeError('Maximum call stack size exceeded')
  }
}
`
// How src/script-child/main.js leaves when it can no longer speak to its host.
const SILENT = 70
// script-runner.js's cap on the interpreter's memory, and what sandbox.js tells a script
// whose memory has no room for a reply.
const MEMORY_CAP = '--wasm-max-mem-pages=2048'
const NO_ROOM = 'Error: The helper\'s reply does not fit in the memory the script has left.'
const SECRET = 'BROWSER_SCRIPT_TEST_SECRET'
const REFUSED = /not a helper call or an answer/

// ELECTRON_BIN, else the binary of the desktop app's own install (apps/desktop, npm ci).
export function electronPath({ env = process.env, read = readFileSync } = {}) {
  if (env.ELECTRON_BIN) return env.ELECTRON_BIN
  const dir = resolve(import.meta.dirname, '..', '..', 'desktop', 'node_modules', 'electron')
  try { return join(dir, 'dist', read(join(dir, 'path.txt'), 'utf8').trim()) } catch { return undefined }
}

// Under CI the Electron half never skips: its job installs the desktop app's Electron.
export function electronGuard({ env = process.env, exists = existsSync, read = readFileSync } = {}) {
  const path = electronPath({ env, read })
  if (path !== undefined && exists(path)) return { path }
  if (env.CI) assert.fail(`The script wall check found no Electron at ${path ?? 'apps/desktop/node_modules/electron'} (ELECTRON_BIN=${env.ELECTRON_BIN ?? 'unset'}); CI must run it`)
  return { skip: 'The Electron half requires ELECTRON_BIN or the desktop app\'s npm install' }
}

const RUNTIMES = [
  { name: 'Node', find: () => ({ path: process.execPath }), env: {} },
  { name: 'Electron as Node', find: electronGuard, env: { ELECTRON_RUN_AS_NODE: '1' }, electron: true },
]

// Runs one check in a host on this runtime; undefined when the test was skipped. With
// `args` it runs those in place of the host: a fixture of its own.
async function check(t, runtime, request, args = [HOST, JSON.stringify({ timeout: 10_000, ...request })]) {
  const { path, skip } = runtime.find()
  if (skip) {
    t.skip(skip)
    return undefined
  }
  const stdout = await new Promise((done, fail) => {
    execFile(path, args, {
      env: { ...process.env, ...runtime.env, [SECRET]: 'test-only-value' },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }, (error, out, err) => error ? fail(new Error(`${runtime.name} host failed: ${error.message}\n${err}`)) : done(out))
  })
  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  // The host really ran on the runtime this test names.
  assert.equal(typeof result.electron, runtime.electron ? 'string' : 'object', `host ran on ${JSON.stringify(result)}`)
  t.diagnostic(`node ${result.node}${result.electron ? `, electron ${result.electron}` : ''}`)
  return result
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'script-wall-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// Every call of the check was refused with this code.
const refused = (result, code) => {
  assert.equal(result.error, undefined)
  const calls = JSON.parse(result.answer)
  assert.ok(Object.keys(calls).length > 0)
  assert.deepEqual(calls, Object.fromEntries(Object.keys(calls).map(name => [name, code])))
}

for (const runtime of RUNTIMES) {
  test(`${runtime.name}: Node refuses the script's process a file to read`, async (t) => {
    // A file the host can read. (The process's own entry file is the one it may read.)
    const path = join(scratch(t), 'readable.json')
    writeFileSync(path, '{"host":"file"}')
    const result = await check(t, runtime, { check: 'readFile', path })
    if (result) refused(result, 'ERR_ACCESS_DENIED')
  })

  test(`${runtime.name}: Node refuses the script's process a file to write or change`, async (t) => {
    const dir = scratch(t)
    const path = join(dir, 'kept.txt')
    writeFileSync(path, 'host file')
    const result = await check(t, runtime, { check: 'writeFile', path })
    if (!result) return
    refused(result, 'ERR_ACCESS_DENIED')
    assert.deepEqual(readdirSync(dir), ['kept.txt'])
    assert.equal(readFileSync(path, 'utf8'), 'host file')
  })

  test(`${runtime.name}: the script's process has no database module to reach files with`, async (t) => {
    const dir = scratch(t)
    const path = join(dir, 'kept.db')
    const database = new DatabaseSync(path)
    database.exec("create table kept (value); insert into kept values ('host row')")
    database.close()
    const before = readFileSync(path)
    const result = await check(t, runtime, { check: 'sqlite', path, fresh: join(dir, 'made.db') })
    if (!result) return
    assert.equal(result.error, undefined)
    const calls = JSON.parse(result.answer)
    assert.equal(calls.import, 'ERR_UNKNOWN_BUILTIN_MODULE')
    assert.equal(Object.values(calls).includes('allowed'), false, JSON.stringify(calls))
    assert.deepEqual(readdirSync(dir), ['kept.db'])
    assert.deepEqual(readFileSync(path), before)
  })

  test(`${runtime.name}: Node refuses the script's process another process`, async (t) => {
    const result = await check(t, runtime, { check: 'spawn' })
    if (result) refused(result, 'ERR_ACCESS_DENIED')
  })

  test(`${runtime.name}: Node refuses the script's process a worker thread`, async (t) => {
    const result = await check(t, runtime, { check: 'worker' })
    if (result) refused(result, 'ERR_ACCESS_DENIED')
  })

  test(`${runtime.name}: Node refuses the script's process a native addon`, async (t) => {
    // No such file: without the wall the load is tried and fails with another code.
    const result = await check(t, runtime, { check: 'addon', path: join(scratch(t), 'missing.node') })
    if (result) refused(result, 'ERR_DLOPEN_DISABLED')
  })

  test(`${runtime.name}: Node refuses the script's process WASI`, async (t) => {
    const result = await check(t, runtime, { check: 'wasi' })
    if (result) refused(result, 'ERR_ACCESS_DENIED')
  })

  test(`${runtime.name}: Node refuses the script's process its own inspector`, async (t) => {
    const result = await check(t, runtime, { check: 'inspector' })
    if (result) refused(result, 'ERR_ACCESS_DENIED')
  })

  test(`${runtime.name}: Node refuses to write a report or a heap snapshot for the script's process`, async (t) => {
    const dir = scratch(t)
    const result = await check(t, runtime, { check: 'diagnostics', path: dir })
    if (!result) return
    refused(result, 'ERR_ACCESS_DENIED')
    assert.deepEqual(readdirSync(dir), [])
  })

  test(`${runtime.name}: the script's process works in an empty folder of the run's own, and cannot leave it`, async (t) => {
    const elsewhere = scratch(t)
    const result = await check(t, runtime, { check: 'folder', path: elsewhere })
    if (!result) return
    assert.equal(result.error, undefined)
    const { cwd, chdir } = JSON.parse(result.answer)
    assert.equal(chdir, 'ERR_ACCESS_DENIED')
    assert.match(basename(cwd), /^browser-exec-/)
    assert.notEqual(cwd, result.hostCwd)
    // Whatever Node wrote there for the process went with it.
    assert.equal(existsSync(cwd), false)
  })

  test(`${runtime.name}: the script's process has none of the host's environment variables`, async (t) => {
    const result = await check(t, runtime, { check: 'env' })
    if (!result) return
    assert.equal(result.error, undefined)
    const names = JSON.parse(result.answer)
    assert.equal(names.includes(SECRET), false)
    // Windows needs SystemRoot to start a process, Electron needs its switch to be Node,
    // and macOS adds its text encoding to every process.
    assert.deepEqual(names.filter(name => !['SystemRoot', 'ELECTRON_RUN_AS_NODE', '__CF_USER_TEXT_ENCODING'].includes(name)), [])
    assert.equal(names.includes('ELECTRON_RUN_AS_NODE'), Boolean(runtime.electron))
  })

  test(`${runtime.name}: the script's process dies when its own heap passes the cap`, async (t) => {
    // Three times script-runner.js's --max-old-space-size: with no cap the check gets
    // there and answers. The deadline is far off, so it is not what ends the run.
    const result = await check(t, runtime, { check: 'heap', megabytes: 384, timeout: 20_000 })
    if (!result) return
    assert.equal(result.answer, undefined)
    assert.doesNotMatch(result.error, /longer than/)
    assert.notEqual(result.exit, 'survived')
    assert.notDeepEqual(result.exit, { code: 0, signal: null })
  })

  test(`${runtime.name}: a process that ignores the polite stop is gone at the deadline`, async (t) => {
    const result = await check(t, runtime, { check: 'ignoreStop', timeout: 300 })
    if (!result) return
    assert.match(result.error, /longer than 0\.3 seconds/)
    assert.notEqual(result.exit, 'survived')
    // Not a Windows matter: there every kill is the hard one.
    if (process.platform !== 'win32') assert.equal(result.exit.signal, 'SIGKILL')
  })

  test(`${runtime.name}: a line that is not a helper call or an answer ends the run`, async (t) => {
    const lines = ['notJson', 'notAnObject', 'unknownType', 'unknownHelper', 'inheritedHelper', 'argsNotText', 'idNotANumber', 'answerNotText', 'errorNotText']
    for (const line of lines) {
      const result = await check(t, runtime, { check: line, timeout: 3_000 })
      if (!result) return
      assert.match(result.error ?? `answered ${result.answer}`, REFUSED, line)
      assert.equal(result.helperCalls, 0, line)
      assert.notEqual(result.exit, 'survived', line)
    }
  })

  test(`${runtime.name}: helper arguments longer than the host takes end the run`, async (t) => {
    // One character past script-runner.js MAX_TEXT, in a line well under its MAX_LINE.
    const over = await check(t, runtime, { check: 'argsTooLong', length: 4_000_000 - 3, timeout: 3_000 })
    if (!over) return
    assert.match(over.error ?? `answered ${over.answer}`, REFUSED)
    assert.equal(over.helperCalls, 0)
    // At the limit the helper is called; the fixture then says nothing more.
    const at = await check(t, runtime, { check: 'argsTooLong', length: 4_000_000 - 4, timeout: 1_000 })
    assert.match(at.error, /longer than 1 seconds/)
    assert.equal(at.helperCalls, 1)
  })

  test(`${runtime.name}: an answer or an error longer than the host takes ends the run`, async (t) => {
    // One character past script-runner.js MAX_TEXT, in a line well under its MAX_LINE.
    for (const line of ['answerOfLength', 'errorOfLength']) {
      const over = await check(t, runtime, { check: line, length: 4_000_000 + 1, timeout: 3_000 })
      if (!over) return
      assert.match(over.error ?? `answered ${over.answerLength} characters`, REFUSED, line)
      assert.notEqual(over.exit, 'survived', line)
    }
    // At the limit both are taken.
    const answer = await check(t, runtime, { check: 'answerOfLength', length: 4_000_000, timeout: 3_000 })
    assert.equal(answer.error, undefined)
    assert.equal(answer.answerLength, 4_000_000)
    const error = await check(t, runtime, { check: 'errorOfLength', length: 4_000_000, timeout: 3_000 })
    assert.equal(error.answer, undefined)
    assert.equal(error.errorLength, 4_000_000)
  })

  test(`${runtime.name}: a message with no end ends the run`, async (t) => {
    // More than the longest line the host holds (script-runner.js MAX_LINE).
    const result = await check(t, runtime, { check: 'endlessLine', length: 25_000_000, timeout: 5_000 })
    if (!result) return
    assert.match(result.error, REFUSED)
    assert.notEqual(result.exit, 'survived')
  })
}

for (const runtime of RUNTIMES) {
  test(`${runtime.name}: a script runs in the interpreter, with its built-ins and no Node`, async (t) => {
    const result = await check(t, runtime, {
      script: `
        const went = await goto('https://example.com/')
        await new Promise(resolve => setTimeout(resolve, 20))
        const reach = [typeof process, typeof require, typeof fetch, globalThis.constructor.constructor('return typeof process')()]
        return JSON.stringify({ went, reach, globals: Object.getOwnPropertyNames(globalThis).sort() })
      `,
    })
    if (!result) return
    assert.equal(result.error, undefined)
    const { went, reach, globals } = JSON.parse(result.answer)
    assert.equal(went, 'went to https://example.com/')
    assert.deepEqual(reach, ['undefined', 'undefined', 'undefined', 'undefined'])
    assert.deepEqual(globals, GLOBALS)
  })

  test(`${runtime.name}: a script's memory stops at the cap, with an error the script can catch`, async (t) => {
    const result = await check(t, runtime, {
      script: `
        const kept = []
        let error = 'none'
        try { for (;;) kept.push(new Array(100000).fill(kept.length)) } catch (caught) { error = caught === null ? 'null' : caught.name + ': ' + caught.message }
        const arrays = kept.length
        kept.length = 0
        return JSON.stringify({ error, arrays })
      `,
    })
    if (!result) return
    assert.equal(result.error, undefined)
    const { error, arrays } = JSON.parse(result.answer)
    assert.match(error, /^(InternalError: out of memory|null)$/)
    // Each array is 100,000 numbers, about 0.8 MB: 128 MB holds fewer than 160 of them.
    assert.ok(arrays > 40 && arrays < 160, `${arrays} arrays`)
  })

  test(`${runtime.name}: a helper reply too large for the memory a script has left fails that call, and the script goes on`, async (t) => {
    // The script fills the interpreter to the cap, gives 1.6 MB back and asks for 3.9 MB.
    const result = await check(t, runtime, {
      script: `
        const kept = []
        try { while (kept.length < 400) kept.push(new Array(100000).fill(kept.length)) } catch (error) {}
        const filled = kept.length
        kept.length -= 2
        let reply
        try { reply = 'got ' + (await big(3900000)).length } catch (error) { reply = error === null ? 'null' : error.name + ': ' + error.message }
        kept.length = 0
        const fits = (await big(3900000)).length
        return JSON.stringify({ filled, reply, fits, sum: [1, 2, 3].map(value => value * 2).join() })
      `,
    })
    if (!result) return
    assert.equal(result.error, undefined)
    const { filled, reply, fits, sum } = JSON.parse(result.answer)
    assert.ok(filled > 40 && filled < 160, `${filled} arrays`)
    assert.equal(reply, NO_ROOM)
    assert.equal(fits, 3_900_000)
    assert.equal(sum, '2,4,6')
    assert.equal(result.helperCalls, 2)
  })

  test(`${runtime.name}: a helper reply the interpreter has no room for is refused, and its memory is as it was`, async (t) => {
    const probe = request => check(t, runtime, request, [MEMORY_CAP, MEMORY_PROBE, JSON.stringify(request)])
    // Full to the cap but for 1.6 MB, and a reply of 3.9 MB.
    const result = await probe({ free: 2, reply: 3_900_000 })
    if (!result) return
    assert.deepEqual(result.calls, ['big'])
    assert.equal(result.before.megabytes > 100 && result.before.megabytes <= 128, true, `${result.before.megabytes} MB`)
    assert.deepEqual(result.after, result.before)
    assert.equal(result.finishes.length, 1, JSON.stringify(result.finishes))
    assert.equal(result.finishes[0][1], null)
    const { filled, reply, after } = JSON.parse(result.finishes[0][0])
    assert.ok(filled > 40 && filled < 160, `${filled} arrays`)
    assert.equal(reply, NO_ROOM)
    assert.equal(after, `2,4,6 {"a":"b"} function ${filled - 2}`)
    // The same script with a reply that fits gets it, and the memory is as it was too.
    const fits = await probe({ free: 2, reply: 500 })
    assert.deepEqual(fits.after, fits.before)
    assert.equal(JSON.parse(fits.finishes[0][0]).reply, 'got 500')
  })

  test(`${runtime.name}: a helper reply the interpreter can copy but not hold as its own text is refused, and its memory is as it was`, async (t) => {
    const probe = request => check(t, runtime, request, [MEMORY_CAP, MEMORY_PROBE, JSON.stringify(request)])
    // More given back than above, and the same reply: room for the copy this time, and
    // none for the interpreter's own text of it.
    const result = await probe({ free: 5, reply: 3_900_000 })
    if (!result) return
    assert.deepEqual(result.calls, ['big'])
    assert.equal(result.before.megabytes > 100 && result.before.megabytes <= 128, true, `${result.before.megabytes} MB`)
    assert.deepEqual(result.after, result.before)
    assert.equal(result.finishes.length, 1, JSON.stringify(result.finishes))
    assert.equal(result.finishes[0][1], null)
    const { filled, reply, after } = JSON.parse(result.finishes[0][0])
    assert.ok(filled > 40 && filled < 160, `${filled} arrays`)
    assert.equal(reply, NO_ROOM)
    assert.equal(after, `2,4,6 {"a":"b"} function ${filled - 5}`)
    // This is the case the test is for: the reply was placed and did not come back as
    // text, and what the script is told in its place did.
    assert.deepEqual(result.placed, [false, true])
  })

  test(`${runtime.name}: a child whose output fails with a stack error leaves at once, and the run ends as stopped`, async (t) => {
    // The real child with that one write made to fail. The process may read its entry
    // file and nothing else, so the change is written in front of a copy of it.
    const entry = join(scratch(t), 'script-child.mjs')
    writeFileSync(entry, OUTPUT_FAILS + readFileSync(CHILD, 'utf8'))
    // The first thing the child has to say is a helper call, then the answer.
    for (const script of ['return await goto("https://example.com/")', 'return "said"']) {
      const result = await check(t, runtime, { script, entry, timeout: 10_000 })
      if (!result) return
      assert.equal(result.answer, undefined, script)
      assert.equal(result.error, `Script stopped before it finished (exit ${SILENT}).`, script)
      assert.deepEqual(result.exit, { code: SILENT, signal: null }, script)
      assert.equal(result.helperCalls, 0, script)
      // Well before the deadline, which a child that stays would wait for.
      assert.ok(result.ms < 5_000, `${script}: settled after ${result.ms} ms`)
    }
  })

  test(`${runtime.name}: a script that recurses too deep gets a stack error and the run goes on`, async (t) => {
    const result = await check(t, runtime, {
      script: 'const down = () => down(); try { down() } catch (error) { return error.name + ": " + error.message }',
    })
    if (!result) return
    assert.equal(result.error, undefined)
    assert.equal(result.answer, 'InternalError: stack overflow')
  })
}

test('under CI a missing Electron fails, naming the path and ELECTRON_BIN', () => {
  const missing = () => false
  assert.throws(() => electronGuard({ env: { CI: '1', ELECTRON_BIN: '/nowhere/electron' }, exists: missing }),
    { name: 'AssertionError', message: /no Electron at \/nowhere\/electron \(ELECTRON_BIN=\/nowhere\/electron\); CI must run it/ })
  assert.match(electronGuard({ env: {}, exists: missing }).skip, /ELECTRON_BIN/)
  assert.deepEqual(electronGuard({ env: { ELECTRON_BIN: '/opt/electron' }, exists: () => true }), { path: '/opt/electron' })
})
