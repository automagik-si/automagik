import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises'
import { pipeSession } from './pipe.mjs'
import { endRemoved } from './guard.mjs'

function child(write = () => true) {
  const hc = new EventEmitter()
  hc.exitCode = hc.signalCode = null
  hc.writes = []
  hc.ends = 0
  hc.kills = 0
  hc.kill = () => { hc.kills++ }
  hc.stdin = new Writable()
  hc.stdin.write = chunk => {
    hc.writes.push(chunk.toString())
    return write(hc.stdin)
  }
  const end = hc.stdin.end.bind(hc.stdin)
  hc.stdin.end = () => { hc.ends++; return end() }
  hc.stdout = new PassThrough()
  return hc
}

function phone({ reads = [], read, write = () => {} } = {}) {
  const gone = Promise.withResolvers()
  const finished = Promise.withResolvers()
  const closes = []
  const output = []
  const hangUp = () => gone.resolve()
  const conn = {
    close(code, reason) { closes.push([code, Buffer.from(reason).toString()]); hangUp() },
    closed: () => gone.promise,
  }
  const bi = {
    recv: { async read() {
      if (reads.length) return reads.shift()
      if (read) return read()
      await gone.promise
      throw new Error('phone closed')
    } },
    send: {
      async writeAll(bytes) {
        const data = Buffer.from(bytes).toString()
        output.push(['write', data])
        await write(data)
      },
      async finish() { output.push(['finish']); finished.resolve() },
    },
  }
  return { conn, bi, output, closes, hangUp, finished: finished.promise }
}

function lateWrite() {
  const hc = child(stdin => {
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    setImmediate(() => stdin.emit('error', error))
    return true
  })
  const read = () => new Promise(resolve => setImmediate(() => resolve(Buffer.from('data'))))
  return { hc, ...phone({ read }) }
}

// The input path from dev. Keep the old write and drain wait here for the regression tests.
async function devLoop(hc, bi, rest, close = () => {}) {
  if (rest.length) hc.stdin.write(rest)
  try {
    for (;;) {
      const data = await bi.recv.read(65536).catch(() => null)
      if (!data || data.length === 0) break
      if (!hc.stdin.write(Buffer.from(data))) await new Promise(r => hc.stdin.once('drain', r))
    }
    hc.stdin.end()
  } finally { close() }
}

const run = ({ hc, conn, bi }, options = {}) =>
  pipeSession({ hc, conn, bi, rest: Buffer.alloc(0), log() {}, ...options })

test('a late EPIPE crashes the old loop and stops writes in the new one', { timeout: 5000 },
  async t => {
    const source = `
      import { EventEmitter } from 'node:events'
      import { PassThrough, Writable } from 'node:stream'
      ${child}
      ${phone}
      ${lateWrite}
      ${devLoop}
      const { hc, bi } = lateWrite()
      await devLoop(hc, bi, Buffer.alloc(0))
    `
    const red = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'ignore', 'pipe'], signal: AbortSignal.timeout(4000),
    })
    let stderr = ''
    red.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const [status] = await once(red, 'close')
    assert.equal(status, 1, stderr)
    assert.match(stderr, /write EPIPE/)

    const link = lateWrite()
    t.after(link.hangUp)
    const lines = []
    await run(link, { log: (...args) => lines.push(args) })
    link.hc.stdin.emit('error', new Error('another late error'))
    assert.deepEqual(link.hc.writes, ['data'])
    assert.equal(link.hc.ends, 0)
    assert.deepEqual(lines, [['session: hc input closed:', 'EPIPE']])
  })

for (const event of ['hc exit', 'stdin close', 'stdin ECONNRESET']) {
  test(`a full stdin wakes on ${event} without drain`, { timeout: 1000 }, async t => {
    const make = () => ({ hc: child(() => false), ...phone({ reads: [Buffer.from('data')] }) })
    const red = make()
    const green = make()
    t.after(red.hangUp)
    t.after(green.hangUp)
    // Keep the old loop alive for the error case so we can check the stalled wait.
    red.hc.stdin.on('error', () => {})
    const old = devLoop(red.hc, red.bi, Buffer.alloc(0))
    const pumped = run(green)
    await turn()
    for (const { hc } of [red, green]) {
      assert.equal(hc.stdin.listenerCount('drain'), 1)
      if (event === 'hc exit') hc.emit('exit', 0, null)
      else if (event === 'stdin close') hc.stdin.emit('close')
      else hc.stdin.emit('error', Object.assign(new Error('input reset'), { code: 'ECONNRESET' }))
    }
    const pending = Symbol('pending')
    const bound = delay(40, pending)
    assert.equal(await Promise.race([pumped, bound]), undefined)
    assert.equal(await Promise.race([old, bound]), pending)
    assert.equal(green.hc.stdin.listenerCount('drain'), 0)
    assert.equal(green.hc.ends, 0)
    red.hangUp()
    red.hc.stdin.emit('drain')
    await old
  })
}

test('rest and twenty full writes drain without accumulating listeners', { timeout: 1000 },
  async t => {
    const hc = child(() => false)
    const link = phone({ reads: [...Array(20).fill(Buffer.from('chunk')), null] })
    t.after(link.hangUp)
    const counts = (emitter, events) => events.map(event => emitter.listenerCount(event))
    const inputCounts = () => counts(hc.stdin, ['drain', 'close', 'error'])
    const childCounts = () => counts(hc, ['exit', 'close', 'error'])
    const pumped = run({ hc, ...link }, { rest: Uint8Array.from(Buffer.from('rest')) })
    const inputBaseline = inputCounts().map(n => n - 1)
    const childBaseline = childCounts().map((n, i) => i < 2 ? n - 1 : n)
    assert.deepEqual(hc.writes, ['rest'])
    for (let i = 0; i <= 20; i++) {
      assert.equal(hc.stdin.listenerCount('drain'), 1)
      assert.equal(hc.writes.length, i + 1)
      hc.stdin.emit('drain')
      assert.deepEqual(inputCounts(), inputBaseline)
      assert.deepEqual(childCounts(), childBaseline)
      await turn()
    }
    await pumped
    assert.deepEqual(hc.writes, ['rest', ...Array(20).fill('chunk')])
    assert.equal(hc.ends, 1)
  })

test('phone EOF ends only stdin and hc close finishes after the last write', { timeout: 1000 },
  async t => {
    const hc = child()
    const first = Promise.withResolvers()
    const last = Promise.withResolvers()
    const link = phone({
      reads: [null], write: data => data === 'first' ? first.promise : last.promise,
    })
    t.after(link.hangUp)
    await run({ hc, ...link })
    assert.equal(hc.ends, 1)
    hc.stdout.write('first')
    await turn()
    hc.emit('exit', 0, null)
    const outputEnded = once(hc.stdout, 'end')
    hc.stdout.end('last')
    assert.deepEqual(link.output, [['write', 'first']])
    first.resolve()
    await outputEnded
    await turn()
    assert.deepEqual(link.output, [['write', 'first'], ['write', 'last']])
    hc.emit('close', 0, null)
    await turn()
    assert.deepEqual(link.output, [['write', 'first'], ['write', 'last']])
    last.resolve()
    await link.finished
    assert.deepEqual(link.output, [['write', 'first'], ['write', 'last'], ['finish']])
    assert.deepEqual(link.closes, [])
  })

for (const event of ['write rejection', 'stdout error']) {
  test(`${event} kills hc`, { timeout: 1000 }, async t => {
    const hc = child()
    const link = phone({ reads: [null], write: () => Promise.reject(new Error('phone closed')) })
    t.after(link.hangUp)
    await run({ hc, ...link })
    if (event === 'write rejection') hc.stdout.write('chunk')
    else hc.stdout.emit('error', new Error('output closed'))
    await turn()
    assert.equal(hc.kills, 1)
  })
}

test('a failed read ends stdin while hc is still alive', { timeout: 1000 }, async t => {
  const hc = child()
  const link = phone({ read: () => Promise.reject(new Error('read failed')) })
  t.after(link.hangUp)
  await run({ hc, ...link })
  assert.equal(hc.ends, 1)
  assert.deepEqual(hc.writes, [])
})

for (const peerCloses of [true, false]) {
  test(`a silent phone ${peerCloses ? 'closes first' : 'is closed by the deadline'}`,
    { timeout: 1000 }, async t => {
      const hc = child()
      const link = phone()
      t.after(link.hangUp)
      const ended = Promise.withResolvers()
      let closed = 0
      let inputDone = false
      const options = { endWait: 20, onClosed: () => { closed++; ended.resolve() } }
      const pumped = run({ hc, ...link }, options).then(() => { inputDone = true })
      hc.emit('exit', 0, null)
      hc.emit('close', 0, null)
      await link.finished
      assert.deepEqual(link.closes, [])
      assert.equal(closed, 0)
      assert.equal(inputDone, false)
      if (peerCloses) link.hangUp()
      await delay(30)
      await ended.promise
      await pumped
      assert.deepEqual(link.closes, peerCloses ? [] : [[0n, 'session ended']])
      assert.equal(closed, 1)
    })
}

test('the deadline starts at exit even when an output write is held', { timeout: 1000 },
  async t => {
    const hc = child()
    const held = Promise.withResolvers()
    const link = phone({ write: () => held.promise })
    t.after(link.hangUp)
    const pumped = run({ hc, ...link }, { endWait: 20 })
    hc.stdout.write('chunk')
    await turn()
    hc.emit('exit', 0, null)
    await delay(30)
    assert.deepEqual(link.closes, [[0n, 'session ended']])
    await pumped
    assert.deepEqual(link.output, [['write', 'chunk']])
    hc.emit('close', 0, null)
    held.resolve()
    await link.finished
  })

test('removal can still close a session after hc exits', { timeout: 1000 }, async t => {
  const hc = child()
  const link = phone()
  t.after(link.hangUp)
  const open = {
    phone: 'ada',
    end: () => { hc.kill(); link.conn.close(1n, [...Buffer.from('not paired')]) },
  }
  const live = new Set([open])
  const pumped = run({ hc, ...link }, { endWait: 20, onClosed: () => live.delete(open) })
  hc.emit('exit', 0, null)
  assert.ok(live.has(open))
  assert.equal(endRemoved(live, new Set()), 1)
  hc.emit('close', 0, null)
  await Promise.all([pumped, link.finished, delay(30)])
  assert.deepEqual(link.closes, [[1n, 'not paired']])
  assert.equal(live.size, 0)
})

test('hc already exited at entry takes no input', { timeout: 1000 }, async t => {
  const hc = child()
  hc.exitCode = 0
  const link = phone({ reads: [Buffer.from('data'), null] })
  t.after(link.hangUp)
  await run({ hc, ...link }, { rest: Buffer.from('rest') })
  assert.deepEqual(hc.writes, [])
  assert.equal(hc.ends, 0)
})

test('a spawn failure with no pipes finishes and arms the deadline at close',
  { timeout: 1000 }, async t => {
    const hc = child()
    hc.stdin = hc.stdout = null
    const link = phone()
    t.after(link.hangUp)
    // bridge.mjs owns the spawn error; only close follows it here.
    hc.on('error', () => {})
    await run({ hc, ...link }, { endWait: 20, rest: Buffer.from('rest') })
    hc.emit('error', new Error('spawn failed'))
    hc.emit('close', -2, null)
    await link.finished
    assert.deepEqual(link.closes, [])
    await delay(30)
    assert.deepEqual(link.closes, [[0n, 'session ended']])
    assert.deepEqual(hc.writes, [])
  })

test('a real child can exit while the phone still sends', { timeout: 5000 }, async t => {
  const hc = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const exited = once(hc, 'exit')
  let readAfterExit = false
  const link = phone({ async read() {
    await exited
    readAfterExit = true
    return Buffer.alloc(1024)
  } })
  t.after(link.hangUp)
  t.after(() => { if (hc.exitCode === null && hc.signalCode === null) hc.kill() })
  // The bridge owns this listener. The promise also reports a spawn error to the test.
  hc.on('error', () => link.hangUp())
  await Promise.all([run({ hc, ...link }), exited, link.finished])
  assert.equal(readAfterExit, true)
  assert.deepEqual(link.output, [['finish']])
})
