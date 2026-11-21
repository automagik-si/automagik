import assert from 'node:assert/strict'
import { setImmediate as settle, setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import { install } from '../src/host/endpoint.js'
import { createOmniTerminalGuard } from '../src/host/omni-terminal-guard.js'
import { fakeContext } from './fake-ctx.js'

const V = '2.261120.1'
const P = '2.261120.2'
const terminal = '2c62a432-73b5-41ff-a07e-89bd2cc87a67'
const secondTerminal = '3a5ffed1-3ab2-414a-b777-b7ee9fdfb631'
const id = 'job-1'
const command = 'bun x --bun @automagik/omni@' + V + ' install --sandbox --at-login'
const report = { version: P, apiUrl: 'http://127.0.0.1:18882/api/v2/' }
const sandbox = { id: 'this-one', source: 'sandbox', reachable: true, version: P, url: 'http://localhost:18882' }
const fallback = { version: P, tag: 'v' + P, commit: 'pinned' }
const unpublished = { ok: false, reason: 'unpublished', fallback, npm: '2.261109.2' }
const running = {
  id, phase: 'running', reason: 'unpublished', npm: { version: V, latest: unpublished.npm, exitCode: null },
  release: { version: P }, source: 'github', steps: [], log: '',
}
const done = { ...running, phase: 'done', report }
const paired = { status: 'paired', origin: 'localhost:18882', version: P }
const error = (message, code = 'bot/refused') => Object.assign(new Error(message), { code })

function fixture(t, options = {}) {
  let time = 0
  const opened = new Set()
  let opens = 0
  let readOnly
  let generation = 1
  let locale = options.language
  let status = options.job ?? running
  let reply = { terminal, state: 'ready', command, data: 'prompt$', base: 0, step: null, ...options.pty }
  const sleeps = []
  const calls = []
  const available = () => true
  const native = {
    open(body) {
      assert.ok(!Object.hasOwn(body, 'via'))
      if (body.extra) throw error('Pick what the terminal is for', 'bot/invalid')
      if (options.reap && ['done', 'failed', 'cancelled'].includes(reply.state)) opened.delete(terminal)
      const next = ++opens === 1 ? terminal : secondTerminal
      opened.add(next)
      return { terminal: next, state: 'preparing', command: null }
    },
    read({ from = 0, terminal: asked }) {
      if (!opened.has(asked)) throw error('That terminal has closed.')
      const { data, base, ...state } = reply
      return { ...state, terminal: asked, data: data.slice(Math.max(from - base, 0)), next: base + data.length }
    },
    write(body) { return options.write ? options.write(body) : { ok: true } },
    resize() { return { ok: true } },
    close(body) {
      opened.delete(body.terminal)
      options.onNativeClose?.()
      return { ok: true }
    },
  }
  const installer = {
    start(payload) {
      calls.push(['start', payload])
      return options.start ? options.start(payload) : { job: status }
    },
    status(payload) {
      calls.push(['status', payload])
      return { job: payload ? status : options.previousJob ?? null }
    },
    ack(payload) {
      calls.push(['ack', payload])
      return options.ack ? options.ack() : { claimed: true }
    },
    cancel(payload) {
      calls.push(['cancel', payload])
      return { job: { ...status, cancelRequested: true } }
    },
  }
  const entries = {
    'omni-terminal-read': body => options.read ? options.read(body, native.read) : native.read(body),
    'omni-terminal-close': body => options.close ? options.close(body, native.close) : native.close(body),
    'omni-discover': () => options.discover ? options.discover() : { omnis: [sandbox] },
    'omni-link': () => options.link ? options.link() : { linked: false },
    'omni-discover-use': body => options.use ? options.use(body) : { status: 'paired', origin: paired.origin },
  }
  const guard = createOmniTerminalGuard({
    check(version, eligibility) {
      calls.push(['check', version])
      assert.equal(eligibility, available)
      return options.check ? options.check() : unpublished
    },
    available,
    installer,
    endpointOf: name => body => {
      calls.push([name, body])
      return entries[name](body)
    },
    readOnly: () => readOnly,
    generation: () => generation,
    sameTeam: captured => captured === undefined || captured === generation,
    language: () => locale,
    now: () => time,
    wait(ms, signal) {
      return new Promise(resolve => {
        const finish = () => {
          signal.removeEventListener('abort', finish)
          resolve()
        }
        if (signal.aborted) finish()
        else {
          sleeps.push({ ms, finish })
          signal.addEventListener('abort', finish, { once: true })
        }
      })
    },
    connectMs: options.connectMs,
  })
  t.after(guard.dispose)
  const route = (name, body) => guard[name](body, undefined, (payload) => {
    calls.push(['next-' + name, payload])
    return native[name](payload)
  })
  return {
    guard, route, calls,
    open: (payload = { kind: 'install' }) => route('open', payload),
    read: (from = 0) => route('read', { terminal, from }),
    write: (data = '\r') => route('write', { terminal, data }),
    close: () => route('close', { terminal }),
    setPty: patch => { reply = { ...reply, ...patch } },
    setJob: job => { status = job },
    setLocale: language => { locale = language },
    readOnly: () => { readOnly = 'This team is read-only.' },
    changeTeam: () => { generation += 1 },
    elapse: ms => { time += ms },
    events: name => calls.filter(([event]) => event === name).map(([, payload]) => payload),
    async tick(ms) {
      await settle()
      const next = sleeps.shift()
      assert.equal(next?.ms, ms)
      time += ms
      next.finish()
      await settle()
    },
  }
}

test('marked welcome, update, unknown terminal and read-only calls leave Omni in charge', async t => {
  for (const [payload, nativePayload] of [
    [{ kind: 'install', via: 'welcome', cols: 80 }, { kind: 'install', cols: 80 }],
    [{ kind: 'update', id: '1234567890abcdef' }, { kind: 'update', id: '1234567890abcdef' }],
    [{ kind: 'install', cols: 80 }, { kind: 'install', cols: 80 }],
  ]) {
    const f = fixture(t)
    if (payload.kind === 'install' && !payload.via) f.readOnly()
    assert.equal((await f.open(payload)).state, 'preparing')
    assert.equal((await f.read()).command, command)
    await f.write()
    const size = { terminal, cols: 60, rows: 9 }
    await f.route('resize', size)
    await f.close()
    await assert.rejects(f.read(), { code: 'bot/refused', message: 'That terminal has closed.' })
    assert.deepEqual(f.calls, [
      ['next-open', nativePayload], ['next-read', { terminal, from: 0 }], ['next-write', { terminal, data: '\r' }],
      ['next-resize', size], ['next-close', { terminal }], ['next-read', { terminal, from: 0 }],
    ])
  }
  const f = fixture(t)
  await assert.rejects(f.open({ kind: 'install', via: 'welcome', extra: true }), { code: 'bot/invalid' })
  const unknown = { terminal: 'another-terminal', data: '\r' }
  await f.route('write', unknown)
  assert.deepEqual(f.events('next-write'), [unknown])
})

test('reads before an authorized Enter only observe Omni and never mutate the installer', async t => {
  const f = fixture(t, { pty: { state: 'failed', exitCode: 1, data: 'prompt$\r\nold failure' } })
  await f.open()
  const first = await f.read()
  const second = await f.read(first.next)
  assert.equal(first.state, 'failed')
  assert.equal(second.data, '')
  assert.equal(second.next, first.next)
  assert.deepEqual(f.events('next-read'), [{ terminal, from: 0 }, { terminal, from: first.next }])
  for (const mutation of ['check', 'start', 'status', 'ack', 'omni-discover-use']) {
    assert.deepEqual(f.events(mutation), [], mutation)
  }
})

test('a terminal opened before the team becomes read-only passes later reads through to Omni', async t => {
  const f = fixture(t)
  await f.open()
  f.readOnly()
  const answer = await f.read(3)
  assert.equal(answer.data, 'mpt$')
  assert.deepEqual(await f.write(), { ok: true })
  f.setPty({ state: 'failed', exitCode: 1 })
  assert.equal((await f.read(answer.next)).exitCode, 1)
  assert.deepEqual(f.events('next-read'), [{ terminal, from: 3 }, { terminal, from: answer.next }])
  assert.deepEqual(f.events('next-write'), [{ terminal, data: '\r' }])
  assert.deepEqual(f.events('check'), [])
  assert.deepEqual(f.events('start'), [])
})

test('the first Enter waits for the planned release, and drops repeated Enters during the check', async t => {
  const check = Promise.withResolvers()
  const f = fixture(t, { check: () => check.promise, pty: { state: 'preparing', command: null } })
  await f.open()
  const first = f.write('\r\n')
  assert.deepEqual(await f.write('\n'), { ok: true })
  f.setPty({ state: 'ready', command })
  await f.tick(250)
  assert.deepEqual(f.events('check'), [V])
  assert.deepEqual(await f.write(), { ok: true })
  assert.deepEqual(f.events('next-write'), [])
  check.resolve(unpublished)
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(f.events('start'), [{ version: V, reason: 'unpublished' }])
  assert.deepEqual(f.events('omni-terminal-close'), [{ terminal }])
  assert.deepEqual(f.events('next-write'), [])
})

test('readiness waits through five minutes and fails visibly at six minutes', async t => {
  for (const language of ['en', 'pt-BR']) {
    const f = fixture(t, { language, pty: { state: 'preparing', command: null } })
    await f.open()
    const writing = f.write()
    await settle()
    f.elapse(5 * 60_000)
    await f.tick(250)
    assert.equal((await f.read()).state, 'preparing')
    f.elapse(60_000)
    await f.tick(250)
    assert.deepEqual(await writing, { ok: false })
    const reply = await f.read()
    assert.equal(reply.state, 'failed')
    assert.match(reply.error, language === 'en' ? /Omni's terminal did not get ready\. Close it and try again\./ : /terminal do Omni não ficou pronto/)
    assert.ok(reply.data.includes(reply.error))
    f.setPty({ state: 'ready', command })
    assert.deepEqual(await f.write(), { ok: false })
    assert.deepEqual(f.events('next-write'), [])
    assert.deepEqual(f.events('check'), [])
  }
})

test('close aborts pending readiness or a pending check before any Enter or job', async t => {
  for (const during of ['ready', 'check']) {
    const pending = Promise.withResolvers()
    const f = fixture(t, during === 'ready' ? { read: () => pending.promise } : { check: () => pending.promise })
    await f.open()
    const writing = f.write()
    await settle()
    assert.deepEqual(await f.close(), { ok: true })
    assert.deepEqual(await writing, { ok: false })
    pending.resolve(unpublished)
    await settle()
    assert.deepEqual(f.events('start'), [])
    assert.deepEqual(f.events('next-write'), [])
    assert.deepEqual(f.events('next-close'), [{ terminal }])
  }
})

test('close frees the PTY while a native write is blocked and drops the queued write', async t => {
  const written = Promise.withResolvers()
  const f = fixture(t, {
    check: () => ({ ok: true, fallback }), write: () => written.promise,
    onNativeClose: () => written.resolve({ ok: true }),
  })
  await f.open()
  const writing = f.write()
  await settle()
  const queued = f.write('x')
  const closing = f.close()
  await settle()
  assert.deepEqual(f.events('next-close'), [{ terminal }])
  assert.deepEqual(await closing, { ok: true })
  assert.deepEqual(await writing, { ok: false })
  assert.deepEqual(await queued, { ok: false })
  assert.deepEqual(f.events('next-write'), [{ terminal, data: '\r' }])
  assert.deepEqual(f.events('omni-terminal-close'), [])
  assert.deepEqual(f.events('start'), [])
})

test('edits, control keys, a multiline paste, and a command without a version stay with Omni', async t => {
  for (const key of ['x', '\x1b[A', '\u0003', '\u0004', 'paste\r\nsecond line', null]) {
    const f = fixture(t, key === null ? { pty: { command: 'bun x @automagik/omni install' } } : {})
    await f.open()
    if (key !== null) await f.write(key)
    await f.write()
    f.setPty({ state: 'failed', exitCode: 1 })
    assert.equal((await f.read()).exitCode, 1)
    assert.deepEqual(f.events('check'), [])
    assert.deepEqual(f.events('start'), [])
    assert.deepEqual(f.events('next-write').map(payload => payload.data), key === null ? ['\r'] : [key, '\r'])
  }
})

test('all check refusals use the installer, whose job decides what source and release to show', async t => {
  for (const reason of ['behind', 'unpublished', 'no-systemd']) {
    const job = { ...running, reason, source: reason === 'no-systemd' ? 'npm' : 'github',
      release: { version: reason === 'no-systemd' ? V : P } }
    const f = fixture(t, { check: () => ({ ...unpublished, reason, npmHas: reason === 'no-systemd' }), job })
    await f.open()
    await f.write()
    const output = await f.read()
    assert.match(output.data, reason === 'no-systemd' ? /needs systemd[\s\S]*from npm/ : /from GitHub instead/)
    assert.equal(output.state, 'ready')
    assert.deepEqual(f.events('start'), [{ version: V, reason }])
    assert.deepEqual(f.events('next-write'), [])
  }
  const refusal = 'Stop the running Omni sandbox before updating it.'
  const f = fixture(t, {
    check: () => ({ ok: false, reason: 'unpublished', fallback: null }),
    start: () => { throw error(refusal, 'omni-ai/refused') },
  })
  await f.open()
  await f.write()
  const output = await f.read()
  assert.equal(output.state, 'failed')
  assert.equal(output.error, refusal)
  assert.match(output.data, /is not on npm[\s\S]*Stop the running Omni sandbox/)
  assert.deepEqual(f.events('start'), [{ version: V, reason: 'unpublished' }])
  assert.deepEqual(f.events('next-write'), [])
})

test('only the authorized npm monitor can start fallback, even with zero readers', async t => {
  for (const unavailable of [false, true]) {
    let tries = 0
    const f = fixture(t, {
      check() {
        tries += 1
        if (unavailable && tries === 1) throw new Error('no lookup')
        return { ok: true, fallback }
      },
      start: () => ({ job: { ...running, reason: 'npm-failed', npm: { ...running.npm, exitCode: 17 } } }),
    })
    await f.open()
    assert.deepEqual(f.events('check'), [])
    await f.write()
    f.setPty({ data: 'prompt$\r\nnpm stderr', state: 'failed', exitCode: 17 })
    await f.tick(400)
    assert.deepEqual(f.events('check'), unavailable ? [V, V] : [V])
    assert.deepEqual(f.events('next-write'), [{ terminal, data: '\r' }])
    assert.deepEqual(f.events('start'), [{ version: V, reason: 'npm-failed', exitCode: 17 }])
    const output = await f.read()
    assert.equal(output.state, 'ready')
    assert.equal(output.exitCode, undefined)
    assert.match(output.data, /npm stderr[\s\S]*Installing Omni from npm failed \(exit code 17\)/)
    assert.deepEqual(f.events('next-read'), [])
    assert.deepEqual(f.events('omni-terminal-read').map(({ from }) => from), [0, 7, 7, 0])
  }
})

test('an open flushes a first terminal whose npm failure Omni is about to reap', async t => {
  for (const payload of [{ kind: 'install' }, { kind: 'install', via: 'welcome' }, { kind: 'update', id: 'found' }]) {
    const f = fixture(t, { reap: true, check: () => ({ ok: true, fallback }) })
    await f.open()
    await f.write()
    f.setPty({ state: 'failed', exitCode: 17, data: 'prompt$\r\nnpm stderr' })
    assert.equal((await f.open(payload)).terminal, secondTerminal)
    assert.deepEqual(f.calls.slice(-2).map(([name]) => name), ['omni-terminal-read', 'next-open'])
    await f.tick(400)
    assert.deepEqual(f.events('start'), [{ version: V, reason: 'npm-failed', exitCode: 17 }])
    const output = await f.read(7)
    assert.equal(output.state, 'ready')
    assert.match(output.data, /npm stderr/)
    assert.equal(output.exitCode, undefined)
  }
})

test('reads use saved output after a second open reaps a terminal with a pending write', async t => {
  for (const route of [fallback, null]) {
    const written = Promise.withResolvers()
    const f = fixture(t, { reap: true, check: () => ({ ok: true, fallback: route }), write: () => written.promise })
    await f.open()
    const prompt = await f.read()
    const writing = f.write()
    await settle()
    f.setPty({ state: 'failed', exitCode: 17, data: 'prompt$\r\nnpm stderr' })
    assert.equal((await f.open()).terminal, secondTerminal)
    const saved = await f.read(prompt.next)
    assert.equal(saved.state, 'ready')
    assert.equal(Object.hasOwn(saved, 'exitCode'), false)
    assert.equal(saved.data, '\r\nnpm stderr')
    assert.equal(saved.next, prompt.next + saved.data.length)
    assert.deepEqual(f.events('next-read'), [{ terminal, from: 0 }])
    assert.deepEqual(f.events('start'), [])
    written.resolve({ ok: true })
    await writing
    await settle()
    const decided = await f.read(saved.next)
    assert.equal(decided.state, route ? 'ready' : 'failed')
    assert.equal(decided.exitCode, route ? undefined : 17)
    assert.deepEqual(f.events('start'), route ? [{ version: V, reason: 'npm-failed', exitCode: 17 }] : [])
  }
})

test('reads keep advancing during the release check and forwarded write, then later Enter reaches npm', async t => {
  const checked = Promise.withResolvers()
  const written = Promise.withResolvers()
  const f = fixture(t, { check: () => checked.promise, write: () => written.promise })
  await f.open()
  const prompt = await f.read()
  const writing = f.write()
  await settle()
  f.setPty({ data: 'prompt$ during check' })
  const checking = await f.read(prompt.next)
  assert.equal(checking.data, ' during check')
  checked.resolve({ ok: true, fallback })
  await settle()
  f.setPty({ data: 'prompt$ during check during write' })
  const forwarding = await f.read(checking.next)
  assert.equal(forwarding.data, ' during write')
  written.resolve({ ok: true })
  await writing
  const monitored = await f.read(forwarding.next)
  assert.equal(monitored.next, forwarding.next)
  assert.equal(monitored.data, '')
  assert.deepEqual(await f.write('\n'), { ok: true })
  assert.deepEqual(f.events('next-write').map(({ data }) => data), ['\r', '\n'])
})

test('an unrouteable npm failure, linking, a success and exit 130 keep their Omni replies', async t => {
  for (const result of [
    { state: 'failed', exitCode: 5 }, { state: 'linking', exitCode: 0 },
    { state: 'done', exitCode: 0, result: paired }, { state: 'cancelled', exitCode: 130 },
  ]) {
    const f = fixture(t, { check: () => ({ ok: true, fallback: result.exitCode === 5 ? null : fallback }) })
    await f.open()
    await f.write()
    f.setPty({ ...result, data: 'prompt$\r\ncontinued' })
    await f.tick(400)
    const read = await f.read(7)
    assert.equal(read.data, '\r\ncontinued')
    assert.equal(read.state, result.state)
    assert.equal(read.exitCode, result.exitCode)
    assert.deepEqual(read.result, result.result)
    assert.deepEqual(f.events('start'), [])
  }
})

test('cutover is atomic for concurrent readers and keeps the native tail in the same offset space', async t => {
  const closing = Promise.withResolvers()
  const f = fixture(t, { pty: { base: 40, data: 'old output' }, close: () => closing.promise })
  await f.open()
  const first = await f.read(44)
  assert.equal(first.data, 'output')
  assert.equal(first.next, 50)
  const writing = f.write()
  await settle()
  let reads = 0
  const early = f.read(0).then(reply => { reads += 1; return reply })
  const after = f.read(first.next).then(reply => { reads += 1; return reply })
  await settle()
  assert.equal(reads, 0)
  assert.deepEqual(f.events('next-read'), [{ terminal, from: 44 }])
  closing.resolve({ ok: true })
  await writing
  const [whole, suffix] = await Promise.all([early, after])
  assert.equal(whole.data, 'old output' + suffix.data)
  assert.equal(whole.next, suffix.next)
  assert.equal(whole.next, 40 + whole.data.length)
  const later = await f.read(whole.next)
  assert.equal(later.next, whole.next + later.data.length)
  assert.equal((await f.read(later.next)).data, '')
  assert.deepEqual(await f.route('resize', { terminal, cols: 60, rows: 10 }), { ok: true })
  assert.deepEqual(await f.write('ordinary key'), { ok: false })
  assert.equal(f.events('omni-terminal-read').length, 2)
  assert.equal(f.events('next-resize').length, 0)
  await f.close()
  assert.deepEqual(f.events('cancel'), [])
  assert.deepEqual(f.events('ack'), [])
})

test('live progress prints the reason, source changes and visible step changes once', async t => {
  const job = { ...running, reason: 'no-systemd', source: 'npm', release: { version: V },
    steps: [{ id: 'check', state: 'now' }, { id: 'build', state: 'skipped' }], log: 'first\nsame\n' }
  const f = fixture(t, { job, check: () => ({ ok: false, reason: 'no-systemd', npmHas: true }) })
  await f.open()
  await f.write()
  f.setJob({ ...job, source: 'github', fellBack: true, release: { version: P },
    steps: [{ id: 'check', state: 'done' }, { id: 'download', state: 'now' }], log: 'same\nsecond\n' })
  await f.tick(1000)
  await f.tick(1000)
  const output = await f.read()
  assert.equal(output.state, 'ready')
  const lines = stripVTControlCharacters(output.data).trimEnd().split('\r\n')
  assert.deepEqual(lines, [
    'prompt$', "Omni's npm installer needs systemd, and this computer has none.",
    `Installing Omni ${V} from npm.`, '→ Check',
    `npm could not install it either. Installing Omni ${P} from GitHub instead.`, '✓ Check', '→ Download',
  ])
})

test('a failed install prints its error, advice and only the last 20 log lines capped at 300 characters', async t => {
  const f = fixture(t, { job: { ...running, log: 'running log\n' } })
  await f.open()
  await f.write()
  const progress = await f.read()
  assert.doesNotMatch(progress.data, /running log/)
  const log = Array.from({ length: 25 }, (_, i) => `log ${i}: ${'x'.repeat(310)}`)
  f.setJob({ ...running, phase: 'failed', error: 'No space left.', next: 'update', log: log.join('\n') + '\n' })
  await f.tick(1000)
  const output = await f.read(progress.next)
  assert.equal(output.state, 'failed')
  assert.equal(output.error, 'No space left.')
  assert.ok(output.data.startsWith('\u001b[31mNo space left.'))
  const lines = stripVTControlCharacters(output.data).trimEnd().split('\r\n')
  assert.deepEqual(lines, ['No space left.', 'Update Automagik, then try again.', ...log.slice(-20).map(text => text.slice(0, 300))])
})

test('Ctrl-C cancels only this job and reports the real terminal outcome after install', async t => {
  for (const outcome of [
    { phase: 'failed', error: 'Installer ran out of space.', next: 'retry' },
    { phase: 'cancelled' },
    { phase: 'done', report },
  ]) {
    const f = fixture(t)
    await f.open()
    await f.write()
    assert.deepEqual(await f.write('\u0003'), { ok: true })
    assert.deepEqual(await f.write('\u0003'), { ok: true })
    assert.deepEqual(f.events('cancel'), [{ id }, { id }])
    f.setJob({ ...running, ...outcome, log: 'job output\n' })
    await f.tick(1000)
    const output = await f.read()
    assert.equal(output.state, outcome.phase)
    assert.equal(output.error, outcome.error)
    assert.equal(output.data.match(/Stopping after this step/g).length, 1)
    assert.equal(output.data.includes('job output'), outcome.phase === 'failed')
    if (outcome.phase === 'done') assert.deepEqual(output.result, paired)
    await f.close()
    assert.equal(f.events('cancel').length, 2)
    assert.equal(f.events('ack').length, outcome.phase === 'done' ? 1 : 0)
  }
})

test('a missing installer job is reported as lost', async t => {
  const f = fixture(t)
  await f.open()
  await f.write()
  f.setJob(null)
  await f.tick(1000)
  const output = await f.read()
  assert.equal(output.state, 'failed')
  assert.match(output.error, /progress was lost/)
})

test('a pending start supplies the exact id for Ctrl-C, while close simply detaches', async t => {
  for (const close of [false, true]) {
    const starting = Promise.withResolvers()
    const f = fixture(t, { start: () => starting.promise })
    await f.open()
    await f.write()
    const stopping = close ? f.close() : f.write('\u0003')
    await settle()
    assert.deepEqual(f.events('cancel'), [])
    if (close) await stopping
    starting.resolve({ job: running })
    await stopping
    assert.deepEqual(f.events('cancel'), close ? [] : [{ id }])
    assert.deepEqual(f.events('ack'), [])
  }
})

test('only the reachable sandbox matching the installed URL and release is claimed and used', async t => {
  const wrong = [
    { ...sandbox, id: 'service', source: 'cli' }, { ...sandbox, id: 'old', version: V },
    { ...sandbox, id: 'down', reachable: false }, { ...sandbox, id: 'tls', url: 'https://localhost:18882/' },
    { ...sandbox, id: 'path', url: 'http://localhost:18882/elsewhere' },
  ]
  const pending = Promise.withResolvers()
  const f = fixture(t, { discover: () => pending.promise })
  await f.open({ kind: 'install', cols: 72, rows: 8 })
  assert.equal((await f.read()).state, 'ready')
  await f.write()
  assert.equal((await f.read()).state, 'ready')
  f.setJob(done)
  await f.tick(1000)
  assert.equal((await f.read()).state, 'linking')
  pending.resolve({ omnis: [...wrong, sandbox] })
  await settle()
  const read = await f.read()
  assert.equal(read.state, 'done')
  assert.deepEqual(read.result, paired)
  assert.match(read.data, /✓ Connect[\s\S]*Connected to Omni 2\.261120\.2\./)
  assert.deepEqual(f.events('ack'), [{ id }])
  assert.deepEqual(f.events('omni-discover-use'), [{ id: sandbox.id }])
})

test('InlineTerminal polling advances once through GitHub, linking and the paired result', async t => {
  const discovered = Promise.withResolvers()
  const f = fixture(t, { discover: () => discovered.promise })
  await f.open()
  let from = 0
  const poll = async state => {
    const answer = await f.read(from)
    assert.equal(answer.state, state)
    assert.ok(answer.next >= from)
    assert.equal(answer.terminal, terminal)
    from = answer.next
    return answer
  }
  const prompt = await poll('ready')
  assert.equal(prompt.data, 'prompt$')
  await f.write()
  const installing = await poll('ready')
  assert.match(installing.data, /not on npm[\s\S]*from GitHub instead/)
  assert.equal((await poll('ready')).data, '')
  const nativeReads = f.events('omni-terminal-read').length
  f.setJob(done)
  await f.tick(1000)
  const linking = await poll('linking')
  assert.match(linking.data, /Connect/)
  discovered.resolve({ omnis: [sandbox] })
  await settle()
  const completed = await poll('done')
  assert.deepEqual(completed.result, paired)
  assert.equal(completed.exitCode, undefined)
  assert.match(completed.data, /Connected to Omni 2\.261120\.2\./)
  assert.equal((await poll('done')).data, '')
  assert.equal(f.events('omni-terminal-read').length, nativeReads)
  assert.deepEqual(f.events('start'), [{ version: V, reason: 'unpublished' }])
  assert.deepEqual(f.events('ack'), [{ id }])
  assert.deepEqual(f.events('omni-discover-use'), [{ id: sandbox.id }])
})

test('losing the claim watches the link for pairing, the correct origin, or a different connection', async t => {
  const pairing = { origin: '[::1]:18882', code: '123' }
  for (const [newLink, wanted, message] of [
    [{ linked: true, origin: 'localhost:18882', url: sandbox.url }, paired],
    [{ pairing }, { status: 'pairing', pairing }],
    [{ pairing: { ...pairing, origin: 'localhost:18883' } }, undefined, /Another Omni sign-in is waiting \(localhost:18883\)/],
    [{ linked: true, origin: 'localhost:18882', url: 'https://localhost:18882' }, undefined, /already connected to another Omni/],
    [{ configured: true, origin: null }, undefined, /already connected to another Omni/],
  ]) {
    let link = { linked: false }
    const f = fixture(t, { job: done, ack: () => ({ claimed: false }), link: () => link })
    await f.open()
    await f.write()
    await settle()
    assert.equal((await f.read()).state, 'linking')
    link = newLink
    await f.tick(2000)
    const output = await f.read()
    assert.deepEqual(output.result, wanted)
    if (message) assert.match(output.error, message)
    if (newLink.pairing) assert.doesNotMatch(output.data, /Connected to Omni/)
    assert.deepEqual(f.events('omni-discover-use'), [])
    assert.deepEqual(f.events('ack'), [{ id }])
    assert.equal(f.events('omni-discover').length, 1)
  }
})

test('validates pending and returned pairing origins before exposing the code', async t => {
  const pairing = { origin: 'localhost:18882', code: '234' }
  const competing = { ...pairing, origin: 'remote.example:443' }
  const current = { linked: true, origin: 'localhost:18882', url: sandbox.url }
  for (const [options, result, use, failure] of [
    [{ link: () => current }, paired, false],
    [{ link: () => ({ pairing }) }, { status: 'pairing', pairing }, false],
    [{ link: () => ({ pairing: competing }) }, undefined, false, /Another Omni sign-in is waiting \(remote.example:443\).*http:\/\/127\.0\.0\.1:18882/],
    [{ use: () => ({ status: 'pairing', pairing }) }, { status: 'pairing', pairing }, true],
    [{ use: () => ({ status: 'pairing', pairing: competing }) }, undefined, true, /Another Omni sign-in is waiting/],
  ]) {
    const f = fixture(t, { job: done, ...options })
    await f.open()
    await f.write()
    await settle()
    const output = await f.read()
    assert.deepEqual(output.result, result)
    assert.equal(output.state, result ? 'done' : 'failed')
    assert.deepEqual(f.events('omni-discover-use'), use ? [{ id: sandbox.id }] : [])
    if (failure) assert.match(output.error, failure)
    if (result?.status === 'pairing') assert.doesNotMatch(output.data, /Connected to Omni/)
  }
})

test('the final link read catches a competing connection before the claim', async t => {
  const found = Promise.withResolvers()
  let link = { linked: false }
  const f = fixture(t, { job: done, discover: () => found.promise, link: () => link })
  await f.open()
  await f.write()
  assert.equal((await f.read()).state, 'linking')
  link = { linked: true, origin: 'remote.example:443', url: 'https://remote.example' }
  found.resolve({ omnis: [sandbox] })
  await settle()
  const output = await f.read()
  assert.equal(output.state, 'failed')
  assert.match(output.error, /already connected to another Omni \(remote.example:443\)/)
  assert.deepEqual(f.events('ack'), [])
  assert.deepEqual(f.events('omni-discover-use'), [])
})

test('connect has a deadline even when an Omni discover or link call never answers', async t => {
  const never = new Promise(() => {})
  for (const stalled of ['discover', 'link']) {
    const f = fixture(t, { job: done, [stalled]: () => never, connectMs: 10 })
    await f.open()
    await f.write()
    await delay(25)
    const output = await f.read()
    assert.equal(output.state, 'failed')
    assert.match(output.error, /did not answer at http:\/\/127\.0\.0\.1:18882/)
    assert.deepEqual(f.events('ack'), [])
    assert.deepEqual(f.events('omni-discover-use'), [])
  }
})

test('Ctrl-C during connect stops only local work, and close only detaches from an active job', async t => {
  const gate = Promise.withResolvers()
  const f = fixture(t, { job: done, discover: () => gate.promise })
  await f.open()
  await f.write()
  assert.equal((await f.read()).state, 'linking')
  assert.deepEqual(await f.write('\u0003'), { ok: true })
  gate.resolve({ omnis: [sandbox] })
  await settle()
  assert.equal((await f.read()).state, 'cancelled')
  assert.deepEqual(f.events('cancel'), [])
  assert.deepEqual(f.events('ack'), [])
  assert.deepEqual(f.events('omni-discover-use'), [])

  const g = fixture(t)
  await g.open()
  await g.write()
  await g.close()
  g.setJob(done)
  await g.tick(1000)
  assert.deepEqual(g.events('cancel'), [])
  assert.deepEqual(g.events('ack'), [])
  assert.deepEqual(g.events('status'), [undefined])
  await assert.rejects(g.read(), { message: 'That terminal has closed.' })
})

test('an authorized Enter is fenced by its team generation before start, claim and use', async t => {
  for (const stage of ['start', 'claim', 'use']) {
    const pending = Promise.withResolvers()
    const f = fixture(t, { job: done,
      check: stage === 'start' ? () => pending.promise : undefined,
      discover: stage === 'claim' ? () => pending.promise : undefined,
      ack: stage === 'use' ? () => pending.promise : undefined,
    })
    await f.open()
    const writing = f.write()
    await settle()
    f.changeTeam()
    pending.resolve({ start: unpublished, claim: { omnis: [sandbox] }, use: { claimed: true } }[stage])
    await writing
    await settle()
    const output = await f.read()
    assert.equal(output.state, 'failed')
    assert.match(output.error, /This window no longer controls the Bot team/)
    assert.ok(output.data.includes(output.error))
    assert.equal(f.events('start').length, stage === 'start' ? 0 : 1)
    assert.deepEqual(f.events('ack'), stage === 'use' ? [{ id }] : [])
    assert.deepEqual(f.events('omni-discover-use'), [])
    assert.deepEqual(f.events('next-write'), [])
  }
})

test('ownership loss during start cancels only a newly created job by its exact ID', async t => {
  for (const [previousJob, loseOwnership] of [[null, 'changeTeam'], [running, 'changeTeam'], [null, 'readOnly']]) {
    const starting = Promise.withResolvers()
    const f = fixture(t, { previousJob, start: () => starting.promise })
    await f.open()
    await f.write()
    assert.deepEqual(f.calls.slice(-2).map(([event]) => event), ['status', 'start'])
    f[loseOwnership]()
    starting.resolve({ job: running })
    await settle()
    const output = await f.read()
    assert.equal(output.state, 'failed')
    assert.match(output.error, /This window no longer controls the Bot team/)
    assert.ok(output.data.includes(output.error))
    assert.deepEqual(f.events('cancel'), previousJob ? [] : [{ id }])
    assert.deepEqual(f.events('ack'), [])
  }
})

test('a running job reports ownership loss in the terminal, in the language captured on open', async t => {
  const f = fixture(t, { language: 'pt-BR' })
  await f.open()
  await f.write()
  f.readOnly()
  await f.tick(1000)
  const output = await f.read()
  assert.equal(output.state, 'failed')
  assert.match(output.error, /Esta janela não controla mais a equipe de Bots/)
  assert.deepEqual(f.events('status'), [undefined])
  assert.deepEqual(f.events('ack'), [])
})

test('once dispatched, use reports the real outcome despite Ctrl-C or a passed deadline', async t => {
  for (const [result, state] of [
    [{ status: 'paired', origin: paired.origin }, 'done'],
    [{ status: 'pairing', pairing: { origin: 'localhost:18882', code: '345' } }, 'done'],
    [{ status: 'refused', message: 'Omni did not accept the key.' }, 'failed'],
  ]) {
    const pending = Promise.withResolvers()
    const f = fixture(t, { job: done, use: () => pending.promise })
    await f.open()
    await f.write()
    await settle()
    assert.deepEqual(f.events('omni-discover-use'), [{ id: sandbox.id }])
    f.elapse(180_001)
    assert.deepEqual(await f.write('\u0003'), { ok: false })
    assert.equal((await f.read()).state, 'linking')
    pending.resolve(result)
    await settle()
    const output = await f.read()
    assert.equal(output.state, state)
    assert.deepEqual(output.result, result.status === 'paired' ? paired : state === 'done' ? result : undefined)
    assert.equal(output.error, result.message)
    assert.deepEqual(f.events('cancel'), [])
  }
})

test('a winning claim dispatches after close without another link read', async t => {
  const claim = Promise.withResolvers()
  const use = Promise.withResolvers()
  const f = fixture(t, { job: done, ack: () => claim.promise, use: () => use.promise })
  await f.open()
  await f.write()
  await settle()
  assert.deepEqual(f.events('ack'), [{ id }])
  await f.close()
  claim.resolve({ claimed: true })
  await settle()
  assert.equal(f.events('omni-link').length, 1)
  assert.deepEqual(f.events('omni-discover-use'), [{ id: sandbox.id }])
  use.resolve({ status: 'paired', origin: paired.origin })
  await settle()
  await assert.rejects(f.read(), { message: 'That terminal has closed.' })
})

test('Ctrl-C before dispatch cancels the connection even when an in-flight claim later wins', async t => {
  const claim = Promise.withResolvers()
  const f = fixture(t, { job: done, ack: () => claim.promise })
  await f.open()
  await f.write()
  await settle()
  assert.deepEqual(f.events('ack'), [{ id }])
  assert.deepEqual(await f.write('\u0003'), { ok: true })
  claim.resolve({ claimed: true })
  await settle()
  assert.equal((await f.read()).state, 'cancelled')
  assert.deepEqual(f.events('omni-discover-use'), [])
})

test('Ctrl-C cancels local connect when install finished between status polls', async t => {
  const f = fixture(t)
  await f.open()
  await f.write()
  f.setJob(done)
  assert.deepEqual(await f.write('\u0003'), { ok: true })
  await f.tick(1000)
  assert.equal((await f.read()).state, 'cancelled')
  assert.deepEqual(f.events('ack'), [])
  assert.deepEqual(f.events('omni-discover-use'), [])
})

test('close or sweep after dispatch lets the pending use settle', async t => {
  for (const leave of ['close', 'sweep']) {
    const use = Promise.withResolvers()
    const f = fixture(t, { job: done, use: () => use.promise })
    await f.open()
    await f.write()
    await settle()
    const reading = f.read()
    if (leave === 'close') await f.close()
    else {
      f.elapse(30 * 60_000 + 1)
      f.guard.sweep()
    }
    assert.equal((await reading).state, 'linking')
    use.resolve({ status: 'paired', origin: paired.origin })
    await settle()
    assert.deepEqual(f.events('cancel'), [])
    await assert.rejects(f.read(), { message: 'That terminal has closed.' })
  }
})

test('idle sweep forgets terminals without cancelling or claiming their jobs', async t => {
  const f = fixture(t, { language: 'Português (Brasil)' })
  await f.open()
  f.setLocale('en')
  await f.write()
  const output = await f.read()
  assert.match(output.data, /não está no npm[\s\S]*pelo GitHub/)
  f.elapse(30 * 60_000 + 1)
  f.guard.sweep()
  f.setJob(done)
  await f.tick(1000)
  assert.deepEqual(f.events('cancel'), [])
  assert.deepEqual(f.events('ack'), [])
  await assert.rejects(f.read(), { message: 'That terminal has closed.' })
})

test('welcome registers the five wrappers on its injected team and disposes with that fiber', async () => {
  for (const hasAround of [false, true]) {
    const hooks = new Map()
    const disposers = []
    const rt = { readOnly: () => undefined, hooks: {}, extended: { endpointOf: () => undefined } }
    if (hasAround) rt.hooks.around = (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name) }
    const { ctx } = fakeContext({ services: { omniTeam: rt } })
    ctx.inject = (services, compose) => {
      assert.deepEqual(services, ['omniTeam', 'omniChannels'])
      compose({ omniTeam: rt, effect: run => disposers.push(run()) })
    }
    install(ctx)
    assert.deepEqual([...hooks.keys()], hasAround ? [
      'omni-terminal-open', 'omni-terminal-read', 'omni-terminal-write', 'omni-terminal-resize', 'omni-terminal-close',
    ] : [])
    if (hasAround) {
      const wrap = hooks.get('omni-terminal-open')
      const body = { kind: 'install', via: 'welcome' }
      assert.deepEqual(await wrap(body, undefined, payload => payload), { kind: 'install' })
    }
    for (const off of disposers) off()
    assert.equal(hooks.size, 0)
  }
})
