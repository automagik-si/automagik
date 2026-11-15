// The inner wall of browser_exec (src/script-child/sandbox.js): the script runs in an
// interpreter that shares nothing with Node, so its whole reach is what the sandbox
// hands it. These tests take that as the claim and check it: two functions cross, `call`
// and `finish`; each takes text (finish: text written as JSON, or null) and nothing else;
// neither runs code of the script to read its arguments; neither lets an error of this
// side through; and what comes back the other way is a number, a boolean, text or null.
// Then the ways a run ends from this side: this process's stack ran out inside one of the
// two functions, the run's time is up, and after either the interpreter is left alone.
//
// The checks run the sandbox in this process and give it a prelude of their own, which
// gets the two functions bare, as the real prelude does before it hides them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TEXT, openSandbox } from '../src/script-child/sandbox.js'
import { GLOBALS } from './fixtures/browser-script-globals.js'

// Opens a sandbox whose prelude is `code`, a function of (call, finish) run at once;
// report(value) is finish with the value's JSON as the answer. Resolves to what the
// host's two functions were given, and the sandbox. A probe that would never return is
// stopped after `patience` milliseconds, so a broken sandbox fails a test, not the run.
async function probe(code, { call, finish, patience = 5_000 } = {}) {
  const seen = { calls: [], finishes: [] }
  const until = Date.now() + patience
  const sandbox = await openSandbox({
    call: (...args) => {
      seen.calls.push(args)
      return call ? call(...args) : seen.calls.length
    },
    finish: (...args) => {
      seen.finishes.push(args)
      if (finish) finish(...args)
    },
    overdue: () => Date.now() >= until ? 'The probe did not return.' : undefined,
    prelude: `(function (call, finish) { const report = value => finish(JSON.stringify(JSON.stringify(value)), null); ${code} })`,
  })
  sandbox.start([], '')
  return { seen, sandbox }
}

// What a probe reported with finish(text, null).
const reported = ({ seen }) => {
  assert.equal(seen.finishes.length, 1, JSON.stringify(seen.finishes))
  assert.equal(seen.finishes[0][1], null, seen.finishes[0][1])
  return JSON.parse(seen.finishes[0][0])
}

test('the sandbox hands the interpreter two functions and puts nothing on its globals', async (t) => {
  const first = await openSandbox({ call: () => 1, finish: () => {} })
  // Every way the sandbox can give the interpreter something of this side.
  const Context = Object.getPrototypeOf(first.context)
  const made = []
  const newFunction = Context.newFunction
  t.mock.method(Context, 'newFunction', function (name, fn) {
    made.push(name)
    return newFunction.call(this, name, fn)
  })
  const placed = []
  for (const method of ['setProp', 'defineProp']) {
    t.mock.method(Context, method, () => {
      placed.push(method)
      throw new Error(`${method} is not for the sandbox`)
    })
  }
  const run = await probe('report({ args: arguments.length, names: Object.getOwnPropertyNames(globalThis).sort() })')
  assert.deepEqual(made, ['call', 'finish'])
  assert.deepEqual(placed, [])
  const { args, names } = reported(run)
  // The real prelude gets these two and two texts (the helper names and the body).
  assert.equal(args, 4)
  assert.deepEqual(names, GLOBALS)
})

test('the two functions are functions of the interpreter with nothing of this side on them', async () => {
  const run = await probe(`
    const shape = fn => ({
      type: typeof fn,
      proto: Object.getPrototypeOf(fn) === Function.prototype,
      own: Object.getOwnPropertyNames(fn).sort(),
      symbols: Object.getOwnPropertySymbols(fn).length,
      source: String(fn),
      maker: (() => { try { return typeof fn.constructor('return typeof process + typeof require')() } catch (error) { return 'threw' } })(),
    })
    report([shape(call), shape(finish)])
  `)
  for (const shape of reported(run)) {
    assert.equal(shape.type, 'function')
    assert.equal(shape.proto, true)
    assert.deepEqual(shape.own, ['length', 'name'])
    assert.equal(shape.symbols, 0)
    assert.match(shape.source, /\[native code\]/)
    // Their constructor is the interpreter's Function: code it makes sees no Node.
    assert.equal(shape.maker, 'string')
  }
})

test('call takes two texts and answers a number; anything else is refused without running the script\'s code', async () => {
  const run = await probe(`
    let ran = 0
    const spy = { toString() { ran += 1; return 'goto' }, valueOf() { ran += 1; return 'goto' }, get length() { ran += 1; return 1 } }
    const trap = new Proxy({}, { get() { ran += 1; return undefined }, has() { ran += 1; return false }, ownKeys() { ran += 1; return [] } })
    const text = new String('goto')
    const refused = [
      [], ['goto'], [1, '[]'], ['goto', 1], [null, '[]'], ['goto', null], [undefined, undefined], [true, '[]'],
      [spy, '[]'], ['goto', spy], [trap, '[]'], ['goto', trap], [text, '[]'], ['goto', new String('[]')],
      [Symbol('goto'), '[]'], [() => 'goto', '[]'], [['goto'], '[]'], ['goto', ['[]']], [10n, '[]'],
      ['goto', 'x'.repeat(${MAX_TEXT} + 1)], ['y'.repeat(${MAX_TEXT} + 1), '[]'],
      // No longer than the longest by its own count, and longer once copied out.
      ['goto', '\\ud800'.repeat(${MAX_TEXT})],
    ].map(args => call(...args))
    const taken = [call('goto', '["https://example.com/"]'), call('', ''), call('goto', 'x'.repeat(${MAX_TEXT}))]
    report({ refused, taken: taken.map(id => typeof id + ':' + id), ran })
  `)
  const { refused, taken, ran } = reported(run)
  assert.deepEqual(refused, refused.map(() => 0))
  assert.deepEqual(taken, ['number:1', 'number:2', 'number:3'])
  assert.equal(ran, 0, 'reading an argument ran the script\'s code')
  // This side got text, and only for the three calls that were text.
  assert.deepEqual(run.seen.calls.map(args => args.map(arg => typeof arg)), [['string', 'string'], ['string', 'string'], ['string', 'string']])
  assert.deepEqual(run.seen.calls[0], ['goto', '["https://example.com/"]'])
  assert.equal(run.seen.calls[2][1].length, MAX_TEXT)
})

test('call gives the script a positive whole number or 0, whatever this side answers', async () => {
  const answers = [{ secret: 1 }, 'text', NaN, -1, 1.5, Infinity, null, undefined, () => 1, 7]
  const run = await probe(`
    const got = []
    for (let index = 0; index < ${answers.length}; index += 1) got.push(call('goto', '[]'))
    report(got.map(value => typeof value + ':' + value))
  `, { call: () => answers.shift() })
  assert.deepEqual(reported(run), ['number:0', 'number:0', 'number:0', 'number:0', 'number:0', 'number:0', 'number:0', 'number:0', 'number:0', 'number:7'])
})

test('an error of this side never reaches the script', async () => {
  const fail = () => { throw new Error('host detail: /a/host/path') }
  const run = await probe(`
    let out
    try { out = ['call', typeof call('goto', '[]'), call('goto', '[]')] } catch (error) { out = ['threw', String(error && error.message), String(error && error.stack)] }
    let done
    try { done = ['finish', typeof finish('"first"', null)] } catch (error) { done = ['threw', String(error && error.message)] }
    report([out, done])
  `, { call: fail, finish: (answer) => { if (answer === 'first') fail() } })
  assert.equal(run.seen.finishes.length, 2)
  assert.deepEqual(JSON.parse(run.seen.finishes[1][0]), [['call', 'number', 0], ['finish', 'undefined']])
})

test('finish takes null or the JSON of a text for each of its two arguments and answers nothing', async () => {
  const run = await probe(`
    let ran = 0
    const spy = { toString() { ran += 1; return '"answer"' }, toJSON() { ran += 1; return 'answer' } }
    const results = [
      finish('"answer"', null), finish(null, '"failed"'), finish(null, null), finish('""', '""'),
      finish(spy, null), finish(null, spy), finish(1, null), finish(undefined, null), finish('"answer"'), finish(),
      finish(new String('"answer"'), null), finish(['"answer"'], null), finish(Symbol('answer'), null), finish(() => '"answer"', null),
      finish('answer', null), finish(null, 'failed'), finish('{"answer":1}', null), finish('["answer"]', null), finish('1', null), finish('null', null), finish('"answer" "more"', null), finish('', null),
      finish(JSON.stringify('x'.repeat(${MAX_TEXT} + 1)), null), finish(null, JSON.stringify('x'.repeat(${MAX_TEXT} + 1))), finish(JSON.stringify('x'.repeat(${MAX_TEXT})), null),
      finish(' '.repeat(${MAX_TEXT} * 6 + 1) + '""', null),
    ]
    report({ results: results.map(value => typeof value), ran })
  `)
  const { finishes } = run.seen
  const notText = [null, 'Script produced an answer that is not text, or is longer than 4 MB.']
  assert.deepEqual(finishes.slice(0, 14), [
    ['answer', null], [null, 'failed'], [null, null], ['', ''],
    notText, notText, notText, notText, notText, notText, notText, notText, notText, notText,
  ])
  // Text that is not the JSON of one text.
  assert.deepEqual(finishes.slice(14, 22), [notText, notText, notText, notText, notText, notText, notText, notText])
  // The longest text it takes, and one character more, as the answer and as the error.
  assert.deepEqual(finishes.slice(22, 24), [notText, notText])
  assert.equal(finishes[24][0].length, MAX_TEXT)
  // JSON longer than any text's is refused before it is copied or read.
  assert.deepEqual(finishes[25], notText)
  const { results, ran } = JSON.parse(finishes[26][0])
  assert.deepEqual(results, results.map(() => 'undefined'))
  assert.equal(ran, 0, 'reading an argument ran the script\'s code')
})

test('an answer and an error cross whole: a NUL character, half a surrogate pair, and the longest text of them', async () => {
  const run = await probe(`
    const { stringify } = JSON
    finish(stringify('ab\\u0000cd'), null)
    finish(null, stringify('\\u0000ab\\ud800cd\\udc00'))
    finish(stringify('\\ud800'.repeat(${MAX_TEXT})), null)
    finish(stringify('\\ud800'.repeat(${MAX_TEXT} + 1)), null)
  `)
  const { finishes } = run.seen
  assert.deepEqual(finishes.slice(0, 2), [['ab\u0000cd', null], [null, '\u0000ab\ud800cd\udc00']])
  // Counted after the copy as before it: a text of half pairs is not three times as long here.
  assert.equal(finishes[2][0].length, MAX_TEXT)
  assert.equal(finishes[2][0], '\ud800'.repeat(MAX_TEXT))
  assert.deepEqual(finishes[3], [null, 'Script produced an answer that is not text, or is longer than 4 MB.'])
})

test('what this side gives back is a number, a boolean, and text or null', async () => {
  const run = await probe(`
    const got = []
    return (...args) => { got.push(args.map(value => value === null ? 'null' : typeof value)); if (got.length === 4) report(got) }
  `)
  run.sandbox.settle(1, true, 'value')
  run.sandbox.settle(2, false, 'message')
  run.sandbox.settle(3, true, null)
  // Not text: it arrives as null, not as an object of this side.
  run.sandbox.settle(4, 'yes', { host: process })
  assert.deepEqual(reported(run), [
    ['number', 'boolean', 'string'], ['number', 'boolean', 'string'], ['number', 'boolean', 'null'], ['number', 'boolean', 'null'],
  ])
})

test('past its stack limit the script gets an error of its own', async () => {
  const run = await probe(`
    let depth = 0
    const down = () => { depth += 1; down() }
    let error = 'none'
    try { down() } catch (caught) { error = caught.name + ': ' + caught.message }
    report({ error, deep: depth > 500 && depth < 5000 })
  `)
  assert.deepEqual(reported(run), { error: 'InternalError: stack overflow', deep: true })
})

test('a structure too deep for the interpreter ends the run with a stack error, once', async () => {
  const run = await probe(`
    let nested = []
    for (let index = 0; index < 100000; index += 1) nested = [nested]
    report(JSON.stringify(nested).length)
  `)
  assert.deepEqual(run.seen.finishes, [[null, 'InternalError: stack overflow']])
  // The interpreter is not entered again after it failed.
  run.sandbox.settle(1, true, 'late')
  assert.equal(run.seen.finishes.length, 1)
})

test('a stack error of this side inside call ends the run: no more of the script, no more calls', async () => {
  const run = await probe(`
    call('goto', '["first"]')
    call('goto', '["second"]')
    for (;;) {}
  `, { call: () => { throw new RangeError('Maximum call stack size exceeded') } })
  assert.deepEqual(run.seen.finishes, [[null, 'InternalError: stack overflow']])
  assert.deepEqual(run.seen.calls, [['goto', '["first"]']])
})

test('a stack error of this side inside finish ends the run, and the error is said again when saying it failed too', async () => {
  // The answer and the first telling of the error both meet the stack error.
  let failures = 2
  const run = await probe(`
    finish('"first"', null)
    call('goto', '[]')
    finish('"second"', null)
    for (;;) {}
  `, { finish: () => { if (failures-- > 0) throw new RangeError('Maximum call stack size exceeded') } })
  const broke = [null, 'InternalError: stack overflow']
  assert.deepEqual(run.seen.finishes, [['first', null], broke, broke])
  assert.deepEqual(run.seen.calls, [])
})

test('after a run broke the interpreter is not entered again', async (t) => {
  const run = await probe('return () => { throw new Error("boom") }')
  const entered = t.mock.method(run.sandbox.context, 'callFunction')
  const placed = t.mock.method(run.sandbox.context, 'newString')
  run.sandbox.settle(1, true, 'first')
  assert.deepEqual(run.seen.finishes, [[null, 'Error: boom']])
  assert.deepEqual([entered.mock.callCount(), placed.mock.callCount()], [1, 1])
  run.sandbox.settle(2, true, 'late')
  run.sandbox.settle(3, false, 'later')
  run.sandbox.start([], '')
  assert.deepEqual([entered.mock.callCount(), placed.mock.callCount()], [1, 1])
  assert.equal(run.seen.finishes.length, 1)
})

test('a script that never yields is stopped when the run\'s time is up, past its own catch and finally', async () => {
  const finishes = []
  const until = Date.now() + 300
  const sandbox = await openSandbox({
    call: () => 1,
    finish: (...args) => finishes.push(args),
    overdue: () => Date.now() >= until ? 'Script ran longer than its time.' : undefined,
  })
  sandbox.start([], 'for (;;) { try { for (;;) {} } catch (error) {} finally { continue } }')
  assert.ok(Date.now() >= until)
  assert.deepEqual(finishes, [[null, 'Script ran longer than its time.']])
  // Its reactions do not run either, and it is not entered again.
  sandbox.settle(1, true, 'late')
  assert.equal(finishes.length, 1)
})

test('a script that yields runs to its answer while its time is not up', async () => {
  const finishes = []
  let asked = 0
  const sandbox = await openSandbox({ call: () => 1, finish: (...args) => finishes.push(args), overdue: () => { asked += 1 } })
  sandbox.start(['goto'], 'let sum = 0; for (let index = 0; index < 200000; index += 1) sum += index; return (await goto("x")) + sum')
  sandbox.settle(1, true, '"went "')
  assert.deepEqual(finishes, [['went 19999900000', null]])
  assert.ok(asked > 0, 'the interpreter never asked whether the time was up')
})
