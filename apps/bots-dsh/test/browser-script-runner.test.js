import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runIsolatedScript, SCRIPT_TIMEOUT } from '../src/host/browser/script-runner.js'
import { createSession } from '../src/host/browser/session.js'
import { gateScope } from '../src/host/browser/gate.js'

// The flags script-runner.js starts the child with, and the child.
const CHILD_FLAGS = ['--permission', '--no-experimental-sqlite', '--wasm-max-mem-pages=2048', '--max-old-space-size=128']
const CHILD = fileURLToPath(new URL('../src/host/browser/script-child.js', import.meta.url))

const helpers = () => {
  const calls = []
  const record = name => async (...args) => {
    calls.push([name, ...args])
    return name === 'tabs' ? [{ index: 0, url: 'https://example.com/', current: true }] : `${name} ok`
  }
  return { calls, helpers: { goto: record('goto'), snapshot: record('snapshot'), click: record('click'), tabs: record('tabs') } }
}

function observeChildren(t) {
  const children = []
  const spawn = childProcess.spawn
  const spy = t.mock.method(childProcess, 'spawn', (...args) => {
    const child = spawn(...args)
    children.push({ child, args: args[1], options: args[2] })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => {
    spy.mock.restore()
    syncBuiltinESMExports()
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
  return children
}

test('the child starts with the runner\'s flags and folder, and without the host\'s environment', async t => {
  const children = observeChildren(t)
  const name = 'BROWSER_SCRIPT_TEST_SECRET'
  const previous = process.env[name]
  process.env[name] = 'test-only-value'
  t.after(() => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  })
  assert.equal(await runIsolatedScript('done("ready")', {}), 'ready')
  assert.equal(children.length, 1)
  const { child, args, options } = children[0]
  assert.notEqual(child.pid, process.pid)
  assert.equal(options.env[name], undefined)
  assert.deepEqual(Object.keys(options.env).filter(key => !['SystemRoot', 'ELECTRON_RUN_AS_NODE'].includes(key)), [])
  // The flags, then the child's file: no --allow-* flag grants anything back.
  assert.deepEqual(args.slice(0, -1), CHILD_FLAGS)
  assert.match(args.at(-1), /script-child\.js$/)
  // Its working folder is the run's own, not the host's.
  assert.match(options.cwd, /browser-exec-/)
  assert.notEqual(options.cwd, process.cwd())
  // No Node IPC channel: the host reads and checks every line itself.
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore'])
})

test('browser sessions isolate scripts and keep the source limit and answer contract', async () => {
  const session = createSession({ context: { pages: () => [], on() {} } })
  assert.equal(SCRIPT_TIMEOUT, 20_000)
  assert.equal(await session.runScript('return typeof process + "/" + typeof fetch'), 'undefined/undefined')
  await assert.rejects(session.runScript('await import("node:fs")'))
  await assert.rejects(session.runScript(' '.repeat(8_001)), /longer than 8000 characters/)
  assert.equal(await session.runScript(''), 'Script finished without done().')
  assert.equal(await session.runScript('done("answer"); return "ignored"'), 'answer')
  assert.equal(await session.runScript('return 42'), '42')
})

test('session helpers preserve arguments, screenshot text, handoff origin and approval context', async () => {
  const session = createSession({ context: { pages: () => [], on() {} } })
  const calls = []
  const gate = async () => {}
  const origin = { callId: 'call-1', sessionId: 'session-1' }
  for (const name of ['open', 'snapshotText', 'clickWithOptions', 'type', 'select', 'press', 'scroll', 'tabs', 'selectTab', 'closeTab', 'shot', 'upload', 'handoff', 'resume', 'back']) {
    session[name] = async (...args) => {
      assert.equal(gateScope.getStore(), gate)
      calls.push([name, ...args])
      return name === 'shot' ? { text: 'picture', image: 'image-data' } : 'ok'
    }
  }
  const result = await gateScope.run(gate, () => session.runScript(`
    await goto('https://example.com/')
    await snapshot()
    await click('e1', { confirm: true })
    await type('e2', 'hello', true)
    await fill('e3', 'world')
    await select('e4', ['one'])
    await press('Enter')
    await scroll('down')
    await tabs('list')
    await tabs('select', 1)
    await tabs('close', 2)
    const picture = await screenshot()
    await text()
    await upload('e5', ['file.txt'])
    await handoff('login', 'Please log in.')
    await resume()
    await back()
    done(picture)
  `, origin))
  assert.equal(result, 'picture')
  assert.deepEqual(calls, [
    ['open', 'https://example.com/'], ['snapshotText'], ['clickWithOptions', 'e1', { confirm: true }],
    ['type', 'e2', 'hello', true], ['type', 'e3', 'world'], ['select', 'e4', ['one']],
    ['press', 'Enter'], ['scroll', 'down'], ['tabs'], ['selectTab', 1], ['closeTab', 2],
    ['shot'], ['snapshotText'], ['upload', 'e5', ['file.txt']],
    ['handoff', 'login', 'Please log in.', origin], ['resume'], ['back'],
  ])
})

test('helpers reach the host and their results come back as values', async () => {
  const { calls, helpers: h } = helpers()
  const answer = await runIsolatedScript(`
    await goto('https://example.com/')
    const page = await snapshot()
    await click('e3', { confirm: true })
    const open = await tabs('list')
    done(page + ' / ' + open[0].url)
  `, h)
  assert.equal(answer, 'snapshot ok / https://example.com/')
  assert.deepEqual(calls, [['goto', 'https://example.com/'], ['snapshot'], ['click', 'e3', { confirm: true }], ['tabs', 'list']])
})

test('the return value stands in for done(), and no answer is null', async () => {
  assert.equal(await runIsolatedScript('return 42', {}), '42')
  assert.equal(await runIsolatedScript('const x = 1', {}), null)
})

test('a helper error rejects inside the script and can be caught there', async () => {
  const answer = await runIsolatedScript(`
    try { await goto('x') } catch (error) { done('caught: ' + error.message) }
  `, { goto: async () => { throw new Error('The browser has no open tabs.') } })
  assert.equal(answer, 'caught: The browser has no open tabs.')
})

test('a script error rejects the run with its message, and its kind when it has one', async () => {
  await assert.rejects(runIsolatedScript('throw new Error("boom")', {}), { message: 'boom' })
  await assert.rejects(runIsolatedScript('throw "plain"', {}), { message: 'plain' })
  await assert.rejects(runIsolatedScript('this is not javascript', {}), /^Error: SyntaxError: /)
  await assert.rejects(runIsolatedScript('null.x', {}), /^Error: TypeError: .*'x'/)
  await assert.rejects(runIsolatedScript('await gotoo("x")', {}), /^Error: ReferenceError: .*gotoo/)
})

test('the script has no Node to reach: process, require, import(), fetch and the Function constructor find none', async () => {
  const probes = {
    process: 'return typeof process',
    require: 'return typeof require',
    fetch: 'return typeof fetch',
    globalProcess: 'return typeof globalThis.process',
    getBuiltinModule: 'return typeof globalThis.process?.getBuiltinModule',
    thisEscape: 'try { return typeof this.constructor.constructor("return process")() } catch { return "blocked" }',
    helperEscape: 'try { return typeof goto.constructor("return process")() } catch { return "blocked" }',
    promiseEscape: 'try { return typeof goto("x").constructor.constructor("return process")() } catch { return "blocked" }',
    resultEscape: 'const r = await tabs("list"); try { return typeof r.constructor.constructor("return process")() } catch { return "blocked" }',
    errorEscape: 'try { await click() } catch (e) { try { return typeof e.constructor.constructor("return process")() } catch { return "blocked" } }',
  }
  const { helpers: h } = helpers()
  h.click = async () => { throw new Error('no') }
  for (const [name, body] of Object.entries(probes)) {
    const answer = await runIsolatedScript(body, h)
    assert.ok(answer === 'undefined' || answer === 'blocked', `${name}: got ${answer}`)
  }
  await assert.rejects(runIsolatedScript('await import("node:fs")', {}))
})

test('imports find nothing to load, however they are written, and the error is the script\'s own', async () => {
  const probes = [
    'await import("node:fs")',
    'await import("https://example.com/module.js")',
    'await eval(\'import("node:fs")\')',
    'await (0, eval)(\'import("node:fs")\')',
    'await Function(\'return import("node:fs")\')()',
    'await (async () => {}).constructor(\'await import("node:fs")\')()',
    'await import("node:fs", { with: { type: "json" } })',
    'Error = function () { return {} }; await import("node:fs")',
  ]
  for (const probe of probes) {
    const answer = await runIsolatedScript(`
      try { ${probe} } catch (error) {
        try { return typeof error.constructor.constructor('return process')() }
        catch { return 'no process' }
      }
      return 'import allowed'
    `, {})
    assert.ok(answer === 'undefined' || answer === 'no process', `${probe}: ${answer}`)
  }
  const message = await runIsolatedScript('try { await import("node:fs") } catch (error) { return error.message }', {})
  assert.equal(message, 'Imports are not available.')
  // An import statement is not part of a function body at all.
  await assert.rejects(runIsolatedScript('import fs from "node:fs"', {}), /SyntaxError/)
})

test('a script that never yields is killed at the timeout and the host keeps running', async t => {
  const children = observeChildren(t)
  const started = Date.now()
  await assert.rejects(runIsolatedScript('while (true) {}', {}, { timeout: 500 }), /longer than 0.5 seconds/)
  // A rejected promise alone does not prove that the runaway process stopped.
  const child = children[0].child
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('Script process survived its timeout.')), 2_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  assert.ok(Date.now() - started < 5_000)
  // The host event loop was never blocked: a later script still runs.
  assert.equal(await runIsolatedScript('done("alive")', {}), 'alive')
})

test('an async loop stops at the timeout and makes no more helper calls afterwards', async () => {
  let calls = 0
  await assert.rejects(runIsolatedScript('for (;;) await snapshot()', { snapshot: async () => { calls += 1; return 'x' } }, { timeout: 300 }), /longer than/)
  const seen = calls
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(calls, seen, 'no helper call after the script was terminated')
})

test('setTimeout waits inside the script', async () => {
  const answer = await runIsolatedScript('await new Promise(r => setTimeout(r, 50)); done("waited")', {})
  assert.equal(answer, 'waited')
})

test('rewriting the built-ins the bridge uses does not let a worker object back into the script', async () => {
  const escaped = 'try { return typeof e.constructor.constructor("return process")() } catch { return "blocked" }'
  const probes = {
    badJsonForWait: `JSON.stringify = () => '{'; try { setTimeout(() => {}, 0) } catch (e) { ${escaped} } return "no throw"`,
    numberForWait: `JSON.stringify = () => '5'; try { setTimeout(() => {}, 0) } catch (e) { ${escaped} } return "no throw"`,
    uncloneable: `JSON.stringify = () => (() => 1); try { await goto('x') } catch (e) { ${escaped} } return "no throw"`,
    objectArgs: `JSON.stringify = () => ({}); try { await goto('x') } catch (e) { ${escaped} } return "no throw"`,
    badParse: `JSON.parse = () => { throw new Error('x') }; try { await goto('x') } catch (e) { ${escaped} } return "no throw"`,
  }
  for (const [name, body] of Object.entries(probes)) {
    const answer = await runIsolatedScript(body, { goto: async () => 'ok' })
    assert.ok(['undefined', 'blocked', 'no throw'].includes(answer), `${name}: got ${answer}`)
  }
})

test('a rewritten String cannot make the answer anything but text', async () => {
  const answer = await runIsolatedScript('String = () => ({ a: 1 }); return "x"', {})
  assert.equal(answer, 'x')
})

test('a trailing undefined argument keeps the helper default', async () => {
  const seen = []
  await runIsolatedScript('await click("e3", undefined); done("ok")', { click: async (...args) => { seen.push(args); return 'clicked' } })
  assert.deepEqual(seen, [['e3']])
})

test('a helper result that is not JSON reaches the script as undefined, and an unawaited rejection does not end the run', async () => {
  assert.equal(await runIsolatedScript('const v = await snapshot(); done(typeof v)', { snapshot: async () => () => 1 }), 'undefined')
  assert.equal(await runIsolatedScript('goto("x"); await new Promise(r => setTimeout(r, 50)); done("still here")', { goto: async () => { throw new Error('no') } }), 'still here')
})

test('a script that runs out of memory is told so and the host keeps running', async () => {
  await assert.rejects(runIsolatedScript("const a = 'A'.repeat(60 * 1024 * 1024); const parts = []; for (;;) parts.push(a + parts.length)", {}, { timeout: 15_000 }), /out of memory/)
  assert.equal(await runIsolatedScript('done("alive")', {}), 'alive')
})

test('an oversized helper argument is refused inside the script', async () => {
  const answer = await runIsolatedScript("try { await goto('q=' + 'A'.repeat(5 * 1024 * 1024)) } catch (error) { done(error.message) }", { goto: async () => 'ok' })
  assert.match(answer, /larger than 4 MB/)
})

test('an answer longer than 4 MB is refused with an error that says so', async () => {
  await assert.rejects(runIsolatedScript("done('A'.repeat(5 * 1024 * 1024))", {}), /longer than 4 MB/)
  assert.equal((await runIsolatedScript("done('A'.repeat(4_000_000))", {})).length, 4_000_000)
})

test('an answer and an error text come back whole: a NUL character, half a surrogate pair', async () => {
  assert.equal(await runIsolatedScript('done("ab\\u0000cd\\ud800ef")', {}), 'ab\u0000cd\ud800ef')
  assert.equal(await runIsolatedScript('return "\\u0000"', {}), '\u0000')
  await assert.rejects(runIsolatedScript('throw new Error("ab\\u0000cd\\udc00ef")', {}), { message: 'ab\u0000cd\udc00ef' })
  await assert.rejects(runIsolatedScript('throw "ab\\u0000cd"', {}), { message: 'ab\u0000cd' })
  // Helper arguments and results were whole already: they cross as JSON.
  const seen = []
  const echo = async (text) => { seen.push(text); return text }
  assert.equal(await runIsolatedScript('return await echo("a\\u0000b\\ud800")', { echo }), 'a\u0000b\ud800')
  assert.deepEqual(seen, ['a\u0000b\ud800'])
})

test('the longest answer is 4 MB of any characters: half pairs are not counted as more on the way', async () => {
  const answer = await runIsolatedScript("done('\\ud800'.repeat(4_000_000))", {})
  assert.equal(answer.length, 4_000_000)
  assert.equal(answer, '\ud800'.repeat(4_000_000))
  await assert.rejects(runIsolatedScript("done('\\ud800'.repeat(4_000_001))", {}), /longer than 4 MB/)
  await assert.rejects(runIsolatedScript("throw new Error('\\ud800'.repeat(4_000_001))", {}), /longer than 4 MB/)
})

test('a helper result larger than 4 MB fails that call inside the script, and so does an error text that long', async () => {
  // As JSON a text is two quotes longer than itself.
  const answer = await runIsolatedScript(`
    const sizes = []
    for (const size of [4_000_000 - 1, 4_000_000 - 2]) {
      try { sizes.push((await snapshot(size)).length) } catch (error) { sizes.push(error.message) }
    }
    try { await click() } catch (error) { sizes.push(error.message) }
    return JSON.stringify(sizes)
  `, { snapshot: async size => 'A'.repeat(size), click: async () => { throw new Error('A'.repeat(4_000_001)) } })
  assert.deepEqual(JSON.parse(answer), ['The helper\'s result is larger than 4 MB.', 3_999_998, 'The helper failed.'])
})

test('replies a script does not read are held up to a limit, then the run ends', async (t) => {
  const children = observeChildren(t)
  let calls = 0
  const started = Date.now()
  // Twenty replies of 3.9 MB for a script that makes its calls and never yields.
  await assert.rejects(
    runIsolatedScript('for (let index = 0; index < 20; index += 1) snapshot(); for (;;) {}', { snapshot: async () => { calls += 1; return 'A'.repeat(3_900_000) } }, { timeout: 15_000 }),
    /more than 64 MB of helper replies were waiting for it\. It made calls and did not read their replies, or it waited for too many large replies at once\./,
  )
  assert.equal(calls, 20)
  assert.ok(Date.now() - started < 10_000, 'the deadline ended the run, not the limit')
  const { child } = children[0]
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve))
  assert.equal(child.signalCode, 'SIGKILL')
})

test('the child keeps the deadline itself: with no host to stop it, it ends its script and leaves', async (t) => {
  // Started as the runner starts it, then left alone: its input stays open, so it is not
  // told that its host is gone, and nothing here kills it before it is seen to leave.
  const run = async (body) => {
    const child = childProcess.spawn(process.execPath, [...CHILD_FLAGS, CHILD], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] })
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    let lines = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { lines += chunk })
    const started = Date.now()
    child.stdin.write(`${JSON.stringify({ type: 'start', body, names: [], wait: 300 })}\n`)
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('still running after 8 seconds'), 8_000)
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    return { exit, lines, ms: Date.now() - started }
  }
  // A script that never yields: the interpreter stops it, the run ends with the error
  // the host gives at its own deadline, and the process leaves.
  const loop = await run('for (;;) {}')
  assert.deepEqual(loop.exit, { code: 0, signal: null })
  assert.ok(loop.ms >= 300, `left after ${loop.ms} ms`)
  assert.deepEqual(loop.lines.trim().split('\n').map(line => JSON.parse(line)), [{ type: 'done', answer: null, error: 'Script ran longer than 0.3 seconds.' }])
  // A script that waits for what never comes has nothing to stop; the process leaves.
  const waits = await run('await new Promise(() => {})')
  assert.deepEqual(waits.exit, { code: 0, signal: null })
  assert.ok(waits.ms >= 300, `left after ${waits.ms} ms`)
  assert.equal(waits.lines, '')
})

test('error stacks name the script\'s own frames and no path of the host', async () => {
  const answer = await runIsolatedScript('function inner() { null.x }\ntry { inner() } catch (error) { return error.stack + " | " + new Error("m").stack }', {})
  assert.match(answer, /at inner /)
  assert.doesNotMatch(answer, /script-child|node:|[\\/]/)
})
