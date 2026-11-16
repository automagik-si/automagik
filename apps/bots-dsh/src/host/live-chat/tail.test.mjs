// node --test chat/tail.test.mjs: following a transcript here (temp files) and on another
// machine (the fake hc). The poll path is what is tested; fs.watch only wakes it sooner.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalTail, openAdmitted, readLocalLines as readLines2, RemoteTail } from './tail.js'
import { localTranscriptPath } from './folder-rule.js'
import { createFakeHc } from './fake-hc.mjs'

const noTimers = { setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => ({}), clearInterval: () => {} }
const tmp = () => join(mkdtempSync(join(tmpdir(), 'chat-tail-')), 's.jsonl')

function localTail(path) {
  const got = []
  let resets = 0
  const tail = new LocalTail(path, { onLines: (l) => got.push(...l), onReset: () => { resets += 1 }, watch: null, timers: noTimers })
  return { tail, got, resets: () => resets }
}

test('local: complete lines with their numbers; a partial last line waits for its newline', async () => {
  const p = tmp()
  writeFileSync(p, 'one\ntwo\nthr')
  const { tail, got } = localTail(p)
  await tail.start()
  assert.deepEqual(got, [{ n: 1, text: 'one' }, { n: 2, text: 'two' }])
  appendFileSync(p, 'ee\r\nfour\n')
  await tail.tick()
  assert.deepEqual(got.slice(2), [{ n: 3, text: 'three' }, { n: 4, text: 'four' }])
  await tail.tick()
  assert.equal(got.length, 4, 'nothing new, nothing again')
  await tail.stop()
})

test('local: a UTF-8 character split across two writes arrives whole', async () => {
  const p = tmp()
  const bytes = Buffer.from('olá 👋\n', 'utf8')
  writeFileSync(p, bytes.subarray(0, 6))
  const { tail, got } = localTail(p)
  await tail.start()
  appendFileSync(p, bytes.subarray(6))
  await tail.tick()
  assert.deepEqual(got, [{ n: 1, text: 'olá 👋' }])
  await tail.stop()
})

test('local: a file that shrinks or is replaced starts again from line 1', async () => {
  const p = tmp()
  writeFileSync(p, 'a\nb\n')
  const { tail, got, resets } = localTail(p)
  await tail.start()
  truncateSync(p, 0)
  appendFileSync(p, 'c\n')
  await tail.tick()
  assert.equal(resets(), 1)
  assert.deepEqual(got.at(-1), { n: 1, text: 'c' })
  const other = `${p}.new`
  writeFileSync(other, 'x\ny\nz\n')
  renameSync(other, p)
  await tail.tick()
  assert.equal(resets(), 2)
  assert.deepEqual(got.slice(-3), [{ n: 1, text: 'x' }, { n: 2, text: 'y' }, { n: 3, text: 'z' }])
  await tail.stop()
})

test('local: a file that is not there yet is waited for', async () => {
  const p = tmp()
  const { tail, got } = localTail(p)
  await tail.start()
  assert.deepEqual(got, [])
  writeFileSync(p, 'late\n')
  await tail.tick()
  assert.deepEqual(got, [{ n: 1, text: 'late' }])
  await tail.stop()
})

test('local: concurrent ticks read once', async () => {
  const p = tmp()
  writeFileSync(p, 'a\n')
  const { tail, got } = localTail(p)
  await Promise.all([tail.start(), tail.tick(), tail.tick()])
  assert.deepEqual(got, [{ n: 1, text: 'a' }])
  await tail.stop()
})

function remoteTail(hc, extra = {}) {
  const got = []
  let resets = 0
  const delays = []
  const timers = { ...noTimers, setTimeout: (_, ms) => { delays.push(ms); return {} } }
  const tail = new RemoteTail({ hc, on: 'box', path: '.claude/projects/p/s.jsonl', onLines: (l) => got.push(...l), onReset: () => { resets += 1 }, timers, ...extra })
  return { tail, got, delays, resets: () => resets }
}

test('remote: reads by offset with on from the address and no cwd, paging by limit', async () => {
  const hc = createFakeHc({ files: { box: { '.claude/projects/p/s.jsonl': 'a\nb\nc\nd\ne\n' } } })
  const { tail, got } = remoteTail(hc, { page: 2 })
  await tail.start()
  assert.deepEqual(got.map((l) => l.text), ['a', 'b', 'c', 'd', 'e'])
  const reads = hc.calls.filter((c) => c.method === 'file.read').map((c) => c.params)
  // Pages after the first read again from the last line held (the overlap check).
  assert.deepEqual(reads.filter((p) => p.limit !== 0).map((p) => [p.offset, p.limit]), [[1, 2], [2, 3], [4, 3]])
  assert.deepEqual(reads[0], { path: '.claude/projects/p/s.jsonl', on: 'box', offset: 1, limit: 0 }, 'first, how many lines')
  for (const p of reads) {
    assert.equal(p.on, 'box')
    assert.equal(p.path, '.claude/projects/p/s.jsonl')
    assert.ok([0, 2, 3].includes(p.limit))
    assert.ok(!('cwd' in p), 'no cwd: the base is that machine home')
  }
  hc.append('box', '.claude/projects/p/s.jsonl', 'f\n')
  await tail.tick()
  assert.equal(hc.calls.filter((c) => c.method === 'file.read').at(-1).params.offset, 5)
  assert.deepEqual(got.at(-1), { n: 6, text: 'f' })
  await tail.stop()
})

test('remote: a last line without its newline is read again next time', async () => {
  const hc = createFakeHc({ files: { box: { '.claude/projects/p/s.jsonl': 'a\npart' } } })
  const { tail, got } = remoteTail(hc)
  await tail.start()
  assert.deepEqual(got, [{ n: 1, text: 'a' }])
  hc.append('box', '.claude/projects/p/s.jsonl', 'ial\n')
  await tail.tick()
  assert.deepEqual(got, [{ n: 1, text: 'a' }, { n: 2, text: 'partial' }])
  await tail.stop()
})

test('remote: a file with fewer lines than read starts again', async () => {
  const hc = createFakeHc({ files: { box: { '.claude/projects/p/s.jsonl': 'a\nb\nc\n' } } })
  const { tail, got, resets } = remoteTail(hc)
  await tail.start()
  hc.files.box['.claude/projects/p/s.jsonl'] = 'new\n'
  await tail.tick()
  assert.equal(resets(), 1)
  assert.deepEqual(got.at(-1), { n: 1, text: 'new' })
  await tail.stop()
})

test('remote: polls every 2 s while working and 10 s when idle; a failed read is reported, not thrown', async () => {
  let working = true
  const hc = createFakeHc({ files: { box: { '.claude/projects/p/s.jsonl': 'a\n' } } })
  const errors = []
  const { tail, delays } = remoteTail(hc, { working: () => working, onError: (e) => errors.push(e.message) })
  await tail.start()
  working = false
  await tail.tick()
  delete hc.files.box['.claude/projects/p/s.jsonl']
  await tail.tick()
  assert.deepEqual(delays, [2000, 10_000, 10_000])
  assert.deepEqual(errors, ['not_found'])
  await tail.stop()
})

test('local: the folder rule is asked at every open; a refused file is not read', async () => {
  const p = tmp()
  writeFileSync(p, 'a\n')
  let allow = false
  const got = []
  const tail = new LocalTail(p, { onLines: (l) => got.push(...l), admit: (q) => (allow ? q : null), watch: null, timers: noTimers })
  await tail.start()
  assert.deepEqual(got, [])
  allow = true
  await tail.tick()
  assert.deepEqual(got, [{ n: 1, text: 'a' }])
  await tail.stop()
})

test('local: readLocalLines reads old lines by number through the sparse index, multi-byte text included', async () => {
  const { readLocalLines, INDEX_EVERY } = await import('./tail.js')
  const p = tmp()
  const lines = Array.from({ length: INDEX_EVERY * 3 + 7 }, (_, i) => `línea ${i + 1} ✓`)
  writeFileSync(p, lines.join('\n') + '\n')
  const { tail } = localTail(p)
  await tail.start()
  assert.equal(tail.index.length, 4)
  for (const [from, to] of [[1, 3], [INDEX_EVERY, INDEX_EVERY + 2], [INDEX_EVERY * 2 + 5, INDEX_EVERY * 2 + 5], [INDEX_EVERY * 3 + 6, INDEX_EVERY * 3 + 9]]) {
    const got = await readLocalLines(tail, from, to)
    const want = lines.slice(from - 1, to).map((text, i) => ({ n: from + i, text }))
    assert.deepEqual(got, want, `${from}..${to}`)
  }
  await tail.stop()
})

test('remote: readLines reads a range with on and no cwd', async () => {
  const hc = createFakeHc({ files: { box: { '.claude/projects/p/s.jsonl': 'a\nb\nc\nd\n' } } })
  const { tail } = remoteTail(hc)
  assert.deepEqual(await tail.readLines(2, 3), [{ n: 2, text: 'b' }, { n: 3, text: 'c' }])
  const last = hc.calls.at(-1).params
  assert.deepEqual(last, { path: '.claude/projects/p/s.jsonl', on: 'box', offset: 2, limit: 2 })
})

// ---------------------------------------------------------------- review of #280

/** A temp home with a transcript inside .claude/projects and a secret outside it. */
function swapHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'chat-swap-')))
  mkdirSync(join(home, '.claude/projects/p'), { recursive: true })
  mkdirSync(join(home, '.ssh'), { recursive: true })
  const inside = join(home, '.claude/projects/p/s.jsonl')
  const secret = join(home, '.ssh/secret.jsonl')
  writeFileSync(inside, '{"ok":1}\n')
  writeFileSync(secret, '{"SECRET":1}\n')
  const rule = (q) => { const r = localTranscriptPath('claude', q, home); return r.ok ? r.path : null }
  const swap = () => { unlinkSync(inside); symlinkSync(secret, inside) }
  const unswap = () => { unlinkSync(inside); writeFileSync(inside, '{"ok":1}\n') }
  return { home, inside, secret, rule, swap, unswap }
}

test('swap probe: a symlink out of the folder swapped in after the open is refused', async () => {
  const { inside, rule, swap } = swapHome()
  const got = []
  const tail = new LocalTail(inside, { onLines: (l) => got.push(...l), admit: (q) => { swap(); return rule(q) }, watch: null, timers: noTimers })
  await tail.start()
  assert.deepEqual(got, [])
  await tail.stop()
})

test('swap probe: a file opened while swapped, then swapped back before the rule, is refused (dev+inode)', async () => {
  const { inside, rule, swap, unswap } = swapHome()
  swap()
  const got = []
  const tail = new LocalTail(inside, { onLines: (l) => got.push(...l), admit: (q) => { unswap(); return rule(q) }, watch: null, timers: noTimers })
  await tail.start()
  assert.ok(!JSON.stringify(got).includes('SECRET'), 'read the file outside the folder')
  assert.deepEqual(got, [])
  await tail.stop()
})

test('swap probe: readLocalLines and openAdmitted check the open handle too', async () => {
  const { inside, rule, swap, unswap } = swapHome()
  const tail = new LocalTail(inside, { onLines: () => {}, admit: rule, watch: null, timers: noTimers })
  await tail.start()
  await tail.stop()
  assert.deepEqual(await readLines2(tail, 1, 1), [{ n: 1, text: '{"ok":1}' }])
  swap()
  tail.admit = (q) => { unswap(); return rule(q) }
  assert.deepEqual(await readLines2(tail, 1, 1), [])
  tail.admit = () => null
  assert.deepEqual(await readLines2(tail, 1, 1), [], 'the rule is asked: refused, nothing read')
  assert.equal(await openAdmitted(join(inside, 'missing'), rule), null)
})

const openFds = () => { try { return readdirSync('/dev/fd').length } catch { return -1 } }

test('stop() during the first open leaves no file open', async () => {
  const p = tmp()
  writeFileSync(p, 'a\n')
  const before = openFds()
  for (let i = 0; i < 50; i++) {
    const tail = new LocalTail(p, { onLines: () => {}, watch: null, timers: noTimers })
    tail.start()
    await tail.stop()
  }
  // Let any open still in flight finish: a leaked handle shows only then.
  await new Promise((r) => setTimeout(r, 100))
  if (before >= 0) assert.ok(openFds() <= before + 1, `${openFds() - before} files left open`)
})

test('a line longer than maxLine is counted but not kept, here and in readLocalLines', async () => {
  const p = tmp()
  writeFileSync(p, `short\n${'x'.repeat(50)}\nafter\n`)
  const got = []
  const tail = new LocalTail(p, { onLines: (l) => got.push(...l), maxLine: 20, watch: null, timers: noTimers })
  await tail.start()
  assert.deepEqual(got, [{ n: 1, text: 'short' }, { n: 2, text: null }, { n: 3, text: 'after' }])
  assert.deepEqual(await readLines2(tail, 2, 2), [{ n: 2, text: null }])
  await tail.stop()
})

test('a long line split across reads is skipped whole', async () => {
  const p = tmp()
  writeFileSync(p, 'x'.repeat(30))
  const got = []
  const tail = new LocalTail(p, { onLines: (l) => got.push(...l), maxLine: 20, watch: null, timers: noTimers })
  await tail.start()
  appendFileSync(p, 'y'.repeat(30) + '\nok\n')
  await tail.tick()
  assert.deepEqual(got, [{ n: 1, text: null }, { n: 2, text: 'ok' }])
  await tail.stop()
})

test('local: the first read starts window lines before the end; numbers stay right', async () => {
  const p = tmp()
  writeFileSync(p, Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n')
  const got = []
  const tail = new LocalTail(p, { onLines: (l) => got.push(...l), window: 3, watch: null, timers: noTimers })
  await tail.start()
  assert.equal(tail.first, 8)
  assert.deepEqual(got, [{ n: 8, text: 'l8' }, { n: 9, text: 'l9' }, { n: 10, text: 'l10' }])
  assert.deepEqual(await readLines2(tail, 2, 3), [{ n: 2, text: 'l2' }, { n: 3, text: 'l3' }])
  appendFileSync(p, 'l11\n')
  await tail.tick()
  assert.deepEqual(got.at(-1), { n: 11, text: 'l11' })
  await tail.stop()
})

test('remote: the first read starts window lines before the end; caught up is not an error', async () => {
  const hc = createFakeHc({ files: { box: { '.claude/projects/p/s.jsonl': 'a\nb\nc\nd\ne\n' } } })
  const errors = []
  const { tail, got } = remoteTail(hc, { window: 2, onError: (e) => errors.push(e.message) })
  await tail.start()
  assert.equal(tail.first, 4)
  assert.deepEqual(got, [{ n: 4, text: 'd' }, { n: 5, text: 'e' }])
  assert.deepEqual(hc.calls[0].params, { path: '.claude/projects/p/s.jsonl', on: 'box', offset: 1, limit: 0 })
  await tail.tick()
  await tail.tick()
  assert.deepEqual(errors, [], 'an offset past the end means caught up')
})

// ---------------------------------------------------------------- re-review of #280

test('remote: a file truncated and written again past the old offset is a new file, not spliced', async () => {
  const path = '.claude/projects/p/s.jsonl'
  const hc = createFakeHc({ files: { box: { [path]: 'old1\nold2\nold3\n' } } })
  const { tail, got, resets } = remoteTail(hc)
  await tail.start()
  hc.files.box[path] = 'new1\nnew2\nnew3\nnew4\nnew5\n'
  await tail.tick()
  assert.equal(resets(), 1)
  assert.deepEqual(got.slice(3), [1, 2, 3, 4, 5].map((n) => ({ n, text: `new${n}` })))
  await tail.stop()
})

test('remote: caught up means no reset, no line twice and no error, poll after poll', async () => {
  const path = '.claude/projects/p/s.jsonl'
  const hc = createFakeHc({ files: { box: { [path]: 'a\nb\n' } } })
  const errors = []
  const { tail, got, resets } = remoteTail(hc, { onError: (e) => errors.push(e.message) })
  await tail.start()
  for (let i = 0; i < 3; i++) await tail.tick()
  assert.deepEqual(got, [{ n: 1, text: 'a' }, { n: 2, text: 'b' }])
  assert.equal(resets(), 0)
  assert.deepEqual(errors, [])
  hc.append('box', path, 'c\n')
  await tail.tick()
  assert.deepEqual(got.at(-1), { n: 3, text: 'c' })
  assert.equal(got.length, 3)
  await tail.stop()
})

/** An hc whose file.read pages fail with `kind` while counting works (`lines`: one count, or each in turn). */
function failingPages(kind, lines) {
  const counts = [lines].flat()
  return {
    async call(method, params) {
      if (params.limit === 0) return { text: '', first: 1, last: 0, lines: counts.length > 1 ? counts.shift() : counts[0] }
      throw Object.assign(new Error(kind), { kind })
    }
  }
}

test('remote: an error that is not past-the-end is reported, never taken for caught up', async () => {
  const errors = []
  // An empty file: had the error been taken for past-the-end, 0 lines would read as caught up.
  const hc = failingPages('machine_unknown', 0)
  const { tail, resets } = remoteTail(hc, { onError: (e) => errors.push(e.kind) })
  await tail.start()
  assert.deepEqual(errors, ['machine_unknown'])
  assert.equal(resets(), 0)
})

test('remote: invalid_params while the file has lines not yet read is reported, not a silent stall', async () => {
  const errors = []
  const hc = failingPages('invalid_params', 5)
  const { tail, resets } = remoteTail(hc, { onError: (e) => errors.push(e.kind) })
  await tail.start()
  assert.deepEqual(errors, ['invalid_params'])
  assert.equal(resets(), 0)
})

test('remote: past-the-end with exactly the lines already read is caught up, silently', async () => {
  // Counted 10 (window 3: start at line 8), then the file is 7 lines when the page is read.
  const errors = []
  const hc = failingPages('invalid_params', [10, 7])
  const { tail, got, resets } = remoteTail(hc, { window: 3, onError: (e) => errors.push(e.kind) })
  await tail.start()
  assert.equal(tail.first, 8)
  assert.deepEqual([errors, got, resets()], [[], [], 0])
})

// ---------------------------------------------------------------- second re-review of #280

test('remote: a line past the read cap is reported as too long, and the lines after it are read', async () => {
  const path = '.claude/projects/p/s.jsonl'
  const hc = createFakeHc({ files: { box: { [path]: `a\n${'x'.repeat(9 * 1024 * 1024)}\nb\nc\n` } } })
  const { tail, got, resets } = remoteTail(hc)
  await tail.start()
  assert.deepEqual(got, [{ n: 1, text: 'a' }, { n: 2, text: null }, { n: 3, text: 'b' }, { n: 4, text: 'c' }])
  assert.equal(resets(), 0)
  hc.append('box', path, 'd\n')
  await tail.tick()
  assert.deepEqual(got.at(-1), { n: 5, text: 'd' })
  await tail.stop()
})

test('remote: a caught-up poll only counts; the last line is not carried again', async () => {
  const path = '.claude/projects/p/s.jsonl'
  const hc = createFakeHc({ files: { box: { [path]: `a\n${'y'.repeat(1000)}\n` } } })
  const { tail } = remoteTail(hc)
  await tail.start()
  const before = hc.calls.length
  for (let i = 0; i < 5; i++) await tail.tick()
  const polls = hc.calls.slice(before).map((c) => c.params)
  assert.equal(polls.length, 5)
  assert.ok(polls.every((p) => p.offset === 1 && p.limit === 0), JSON.stringify(polls))
  await tail.stop()
})
