// Independent recovery rows for issue #842: the real pinned 0.2.2-rc.2 loader and persistence
// worker bytes, the carried narrowed acp-bridge-tool-lifecycle.patch, and synthetic v4 logs made
// in this file. Nothing here is copied from a real session.
//
// The contract under test (issue #842, PR #851): a session written before the bridge advertised
// every tool call has one turn with a tool/call and its tool/result but no assistant/message
// carrying the tool-call block. The unpatched reader refuses the whole session with
// `SessionFormatError: tool/call <id> has no advertised tool lifecycle`; the carried patch
// tolerates only a first unadvertised call of a never-seen id, leaves the events and the session
// file untouched (no repair, no backup), and reports the tolerated count once on stderr. An
// orphan tool/result and a repeated call of the same id must keep failing on the patched
// readers, and two unadvertised ids must still load so the tolerance is not narrower than the
// fix's scope.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { patchRuntime } from '../scripts/runtime-patches.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = dirname(HERE)
const PATCHES = join(APP, 'runtime', 'patches')
const FIXTURE = join(HERE, 'fixtures', 'acp-bridge-tool-lifecycle')
const FORMAT_FIXTURE = join(FIXTURE, 'format-v3-to-v4.js')
const WORKER_FIXTURE = join(FIXTURE, 'worker.cjs')
const PATCH = 'acp-bridge-tool-lifecycle.patch'
const FORMAT = '@deepseek-ai/dsh-session-format-v3-to-v4'
const PERSIST = '@deepseek-ai/dsh-session-persistence-jsonl'
const FORMAT_FILE = 'lib/index.js'
const WORKER_FILE = 'lib/worker.cjs'
const DSH = '0.2.2-rc.2'
const VERSION = '0.2.2-rc.2'

const CALL = 'bridge_probe_alpha'
const OTHER = 'bridge_probe_beta'
const ORPHAN_RESULT = 'bridge_probe_orphan'
const NO_ADVERTISEMENT = id => `tool/call ${id} has no advertised tool lifecycle`
const NO_LIFECYCLE = id => `tool/result ${id} has no advertised tool lifecycle`
const MISMATCH = id => `tool/call ${id} does not match one advertised tool call`

const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')

// The patched loader imports these two packages only to construct its module. They are not the
// code under test; the pinned lib/index.js is, and the fixture's hash is checked against the pin.
function stubSources() {
  return {
    '@deepseek-ai/dsh-session-format': [
      "export class SessionFormatError extends Error { name = 'SessionFormatError' }",
      "export class SessionFormatUnsupportedMigrationError extends SessionFormatError { name = 'SessionFormatUnsupportedMigrationError' }",
      'export const defineSessionFormatMigration = value => value',
      "export const isSessionFormatJsonObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)",
      'export const sessionFormatCount = (value, label) => {',
      '  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new SessionFormatError(`${label} must be a non-negative safe integer`)',
      '  return value',
      '}',
      '',
    ].join('\n'),
    '@deepseek-ai/dsh-session-format-v2-to-v3': [
      'export const assertReleasedV3Header = () => {}',
      'export const releasedV2SessionFormatCodec = {}',
      'export const releasedV3SessionFormatCodec = {}',
      '',
    ].join('\n'),
  }
}

function writePackage(dir, name, fields = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: VERSION, type: 'module', ...fields }))
}

function writeStub(root, name, source) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  writePackage(dir, name, { main: 'index.js' })
  writeFileSync(join(dir, 'index.js'), source)
}

// A runtime holding exactly the pinned package bytes the patch names, a scratch patches folder
// with only the carried patch, and a logs folder for the synthetic session files.
function makeRuntime(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-bridge-lifecycle-independent-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const modules = join(root, 'node_modules')
  writePackage(join(modules, '@deepseek-ai', 'dsh'), '@deepseek-ai/dsh', { version: DSH })

  const format = join(modules, ...FORMAT.split('/'))
  writePackage(format, FORMAT)
  mkdirSync(join(format, 'lib'), { recursive: true })
  cpSync(FORMAT_FIXTURE, join(format, FORMAT_FILE))

  const persist = join(modules, ...PERSIST.split('/'))
  writePackage(persist, PERSIST)
  mkdirSync(join(persist, 'lib'), { recursive: true })
  cpSync(WORKER_FIXTURE, join(persist, WORKER_FILE))

  for (const [name, source] of Object.entries(stubSources())) writeStub(root, name, source)

  const patches = join(root, 'patches')
  mkdirSync(patches)
  const entries = readJson(join(PATCHES, 'patches.json')).filter(entry => entry.patch === PATCH)
  assert.equal(entries.length, 1, `patches.json must carry exactly one ${PATCH}`)
  writeFileSync(join(patches, 'patches.json'), `${JSON.stringify(entries, null, 2)}\n`)
  for (const entry of entries) cpSync(join(PATCHES, entry.patch), join(patches, entry.patch))

  const logs = join(root, 'logs')
  mkdirSync(logs)
  return { root, modules, patches, logs, format: join(format, FORMAT_FILE), worker: join(persist, WORKER_FILE) }
}

function patchEntry() {
  const entries = readJson(join(PATCHES, 'patches.json')).filter(entry => entry.patch === PATCH)
  assert.equal(entries.length, 1)
  return entries[0]
}

// The pinned fixture must be the same bytes the pin was made against; after patchRuntime it must
// be exactly the patched bytes the pin names.
function assertPinnedBefore(runtime) {
  const [format, worker] = patchEntry().files
  assert.equal(sha256(readFileSync(FORMAT_FIXTURE)), format.before)
  assert.equal(sha256(readFileSync(WORKER_FIXTURE)), worker.before)
  assert.equal(sha256(readFileSync(runtime.format)), format.before)
  assert.equal(sha256(readFileSync(runtime.worker)), worker.before)
}

function applyPatch(runtime) {
  assertPinnedBefore(runtime)
  const states = patchRuntime(runtime.modules, runtime.patches).map(result => result.state)
  assert.deepEqual(states, ['patched', 'patched'], 'the carried patch must apply to the pinned bytes')
  const [format, worker] = patchEntry().files
  assert.equal(sha256(readFileSync(runtime.format)), format.after)
  assert.equal(sha256(readFileSync(runtime.worker)), worker.after)
}

const HEADER = { version: 4, id: 'probe-independent-842', createdAt: 0, isSeeded: false, delegationDepth: 0 }
const artifactOf = events => ({ header: HEADER, events: structuredClone(events), inheritedEventCount: 0 })

// One synthetic v4 log: turn 1 has its request/header; turn 2 has rows and (the broken shape)
// no request/header. Rows are ['call', id] and ['result', id]; a result cites the latest call of
// its id as its source, or nothing when there was none (the orphan shape).
function eventsFor(rows) {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
    { type: 'request/header', time: 0, data: { header: { config: { provider: 'acp-probe', model: 'probe-model' } }, reason: 'initial' } },
    { type: 'step/end', time: 0, data: { turn: 1, step: 1 } },
    { type: 'turn/end', time: 0, data: { turn: 1, reason: 'stop' } },
    { type: 'turn/start', time: 0, data: { turn: 2 } },
    { type: 'step/start', time: 0, data: { turn: 2, step: 1 } },
  ]
  const calls = new Map()
  for (const [kind, id] of rows) {
    if (kind === 'call') {
      calls.set(id, events.length)
      events.push({ type: 'tool/call', time: 0, data: { turn: 2, step: 1, callId: id, name: 'bash', arguments: '{"command":"probe"}' } })
      continue
    }
    const callSeq = calls.get(id)
    events.push({
      type: 'tool/result',
      time: 0,
      data: {
        turn: 2,
        step: 1,
        message: {
          id: `probe-result-${id}-${events.length}`,
          role: 'tool',
          toolCallId: id,
          source: { kind: 'tool', callId: id },
          content: [{ type: 'text', text: 'probe ok' }],
          isError: false,
        },
      },
      surfaceOp: 'append',
      ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }),
    })
  }
  events.push({ type: 'step/end', time: 0, data: { turn: 2, step: 1 } })
  events.push({ type: 'turn/end', time: 0, data: { turn: 2, reason: 'stop' } })
  return events.map((event, seq) => ({ ...event, seq }))
}

const BROKEN = eventsFor([['call', CALL], ['result', CALL]])
const ORPHAN = eventsFor([['result', ORPHAN_RESULT]])
const REPEATED_AFTER = eventsFor([['call', CALL], ['result', CALL], ['call', CALL], ['result', CALL]])
const REPEATED_BEFORE = eventsFor([['call', CALL], ['call', CALL]])
const DISTINCT = eventsFor([['call', CALL], ['result', CALL], ['call', OTHER], ['result', OTHER]])
const KNOWN = new Set(BROKEN.map(event => event.type))

function writeLog(file, events) {
  const lines = [{ type: 'session', ...HEADER }, ...events]
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
}

// The loader's tolerated-count line is written to stderr (console.warn). Capture the real thing
// for the duration of the synchronous restore rather than asserting on an internal counter.
function restoreCapturingStderr(loader, artifact, known = KNOWN) {
  const chunks = []
  const original = process.stderr.write
  process.stderr.write = function capture(chunk, ...rest) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return rest.length > 0 && typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true
  }
  try {
    return { result: loader.restoreReleasedV4Artifact(artifact, known), stderr: chunks.join('') }
  } finally {
    process.stderr.write = original
  }
}

function verify(workerPath, logPath, eventCount) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(workerPath), {
      workerData: { path: logPath, compression: 'none', expectedId: HEADER.id, expectedEventCount: eventCount },
      stderr: true,
    })
    let stderr = ''
    worker.stderr.on('data', chunk => { stderr += chunk })
    worker.once('message', message => resolve({ ...message, stderr }))
    worker.once('error', reject)
  })
}

const stderrLines = text => text.trim() === '' ? [] : text.trim().split('\n')
const tolerated = text => /tolerated\s+(\d+)\s+tool call/i.exec(text)?.[1]

test('A1: the unpatched loader and worker refuse the broken shape with the exact SessionFormatError, the carried patch recovers both without touching the session file', async (t) => {
  const runtime = makeRuntime(t)
  const broken = artifactOf(BROKEN)

  const unpatched = await import(`${pathToFileURL(runtime.format).href}?a1-before`)
  assert.throws(
    () => unpatched.restoreReleasedV4Artifact(broken, KNOWN),
    error => error.name === 'SessionFormatError' && error.message === NO_ADVERTISEMENT(CALL),
    'the unpatched loader must reproduce the issue error exactly',
  )

  const log = join(runtime.logs, 'broken-shape.v4.jsonl')
  writeLog(log, BROKEN)
  const originalBytes = readFileSync(log)
  const refusal = await verify(runtime.worker, log, BROKEN.length)
  assert.equal(refusal.ok, false, 'the unpatched worker must refuse the broken shape')
  assert.equal(refusal.message, NO_ADVERTISEMENT(CALL), 'the unpatched worker must reproduce the issue error exactly')
  assert.equal(sha256(readFileSync(log)), sha256(originalBytes), 'a refused verify must not rewrite the file')

  applyPatch(runtime)
  const patched = await import(`${pathToFileURL(runtime.format).href}?a1-after`)
  const artifact = artifactOf(BROKEN)
  const { result, stderr } = restoreCapturingStderr(patched, artifact)
  assert.equal(result, artifact, 'the loader returns the same artifact, it does not repair a copy')
  assert.deepEqual(result.events, BROKEN, 'recovery must not discard or rewrite any event')
  assert.equal(result.events.length, BROKEN.length)
  assert.equal(stderrLines(stderr).length, 1, 'the loader writes exactly one stderr line')
  assert.equal(tolerated(stderr), '1', `unexpected stderr: ${JSON.stringify(stderr)}`)

  const recovered = await verify(runtime.worker, log, BROKEN.length)
  assert.equal(recovered.ok, true, recovered.message)
  assert.equal(stderrLines(recovered.stderr).length, 1, 'the worker writes exactly one stderr line')
  assert.equal(tolerated(recovered.stderr), '1', `unexpected worker stderr: ${JSON.stringify(recovered.stderr)}`)

  assert.equal(sha256(readFileSync(log)), sha256(originalBytes), 'tolerance happens on read: the session file must stay byte-identical')
  assert.deepEqual(readdirSync(runtime.logs), ['broken-shape.v4.jsonl'], 'no .bak, .pre-repair or any other backup may be written')
  assert.equal(existsSync(`${log}.bak`), false)
  assert.equal(existsSync(`${log}.pre-repair`), false)
})

test('A2: an orphan tool/result with no tool/call fails closed on the patched loader and the patched worker', async (t) => {
  const runtime = makeRuntime(t)
  const orphan = artifactOf(ORPHAN)

  const unpatched = await import(`${pathToFileURL(runtime.format).href}?a2-before`)
  assert.throws(
    () => unpatched.restoreReleasedV4Artifact(orphan, KNOWN),
    error => error.name === 'SessionFormatError' && error.message === NO_LIFECYCLE(ORPHAN_RESULT),
  )
  const log = join(runtime.logs, 'orphan.v4.jsonl')
  writeLog(log, ORPHAN)
  const before = await verify(runtime.worker, log, ORPHAN.length)
  assert.equal(before.ok, false)
  assert.equal(before.message, NO_LIFECYCLE(ORPHAN_RESULT))

  applyPatch(runtime)
  const patched = await import(`${pathToFileURL(runtime.format).href}?a2-after`)
  assert.throws(
    () => restoreCapturingStderr(patched, artifactOf(ORPHAN)),
    error => error.name === 'SessionFormatError' && error.message === NO_LIFECYCLE(ORPHAN_RESULT),
    'the patch must not tolerate a result with no call',
  )
  const after = await verify(runtime.worker, log, ORPHAN.length)
  assert.equal(after.ok, false, 'the patched worker must still refuse an orphan result')
  assert.equal(after.message, NO_LIFECYCLE(ORPHAN_RESULT))
})

test('A3: a repeated tool/call stays refused on the patched loader and worker, while two distinct unadvertised ids load', async (t) => {
  const runtime = makeRuntime(t)

  const unpatched = await import(`${pathToFileURL(runtime.format).href}?a3-before`)
  assert.throws(
    () => unpatched.restoreReleasedV4Artifact(artifactOf(REPEATED_AFTER), KNOWN),
    error => error.name === 'SessionFormatError' && error.message === NO_ADVERTISEMENT(CALL),
  )
  assert.throws(
    () => unpatched.restoreReleasedV4Artifact(artifactOf(REPEATED_BEFORE), KNOWN),
    error => error.name === 'SessionFormatError' && error.message === NO_ADVERTISEMENT(CALL),
  )
  const repeatedAfterLog = join(runtime.logs, 'repeated-after.v4.jsonl')
  const repeatedBeforeLog = join(runtime.logs, 'repeated-before.v4.jsonl')
  writeLog(repeatedAfterLog, REPEATED_AFTER)
  writeLog(repeatedBeforeLog, REPEATED_BEFORE)
  const beforeAfter = await verify(runtime.worker, repeatedAfterLog, REPEATED_AFTER.length)
  assert.equal(beforeAfter.ok, false)
  assert.equal(beforeAfter.message, NO_ADVERTISEMENT(CALL))
  const beforeBefore = await verify(runtime.worker, repeatedBeforeLog, REPEATED_BEFORE.length)
  assert.equal(beforeBefore.ok, false)
  assert.equal(beforeBefore.message, NO_ADVERTISEMENT(CALL))

  applyPatch(runtime)
  const patched = await import(`${pathToFileURL(runtime.format).href}?a3-after`)
  // A second call after its result: the id was seen, so it is not a first unadvertised call.
  assert.throws(
    () => restoreCapturingStderr(patched, artifactOf(REPEATED_AFTER)),
    error => error.name === 'SessionFormatError' && error.message === NO_ADVERTISEMENT(CALL),
    'a call repeated after its result must still fail',
  )
  // A second call before its result: the first call already started, so it cannot be repeated.
  assert.throws(
    () => restoreCapturingStderr(patched, artifactOf(REPEATED_BEFORE)),
    error => error.name === 'SessionFormatError' && error.message === MISMATCH(CALL),
    'a call repeated before its result must still fail',
  )
  const afterAfter = await verify(runtime.worker, repeatedAfterLog, REPEATED_AFTER.length)
  assert.equal(afterAfter.ok, false, 'the patched worker must refuse a call repeated after its result')
  assert.equal(afterAfter.message, NO_ADVERTISEMENT(CALL))
  const afterBefore = await verify(runtime.worker, repeatedBeforeLog, REPEATED_BEFORE.length)
  assert.equal(afterBefore.ok, false, 'the patched worker must refuse a call repeated before its result')
  assert.equal(afterBefore.message, MISMATCH(CALL))

  // Control: two distinct unadvertised ids are two first calls, so both are tolerated and load.
  const distinctEvents = artifactOf(DISTINCT)
  const { result, stderr } = restoreCapturingStderr(patched, distinctEvents)
  assert.deepEqual(result.events, DISTINCT)
  assert.equal(tolerated(stderr), '2', `unexpected stderr: ${JSON.stringify(stderr)}`)
  const distinctLog = join(runtime.logs, 'distinct.v4.jsonl')
  writeLog(distinctLog, DISTINCT)
  const distinctBytes = readFileSync(distinctLog)
  const accepted = await verify(runtime.worker, distinctLog, DISTINCT.length)
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(tolerated(accepted.stderr), '2')
  assert.equal(sha256(readFileSync(distinctLog)), sha256(distinctBytes), 'the control log is not rewritten either')
})

// A4: the chat acp-dsh writes (apps/acp-dsh/test/wire-replay.test.js keeps this fixture equal to
// what its real DSH host writes: one approved tool call, the agent's plan and its usage) opens on
// the pinned worker and the patched loader, unrepaired, with its plan and usage rows and the
// todo list the panel draws.
const REOPEN_FIXTURE = join(HERE, 'fixtures', 'acp-reopen', 'planned.v4.jsonl')

test('A4: a chat acp-dsh wrote with a plan and usage opens on the pinned reader with its rows and list', async (t) => {
  const runtime = makeRuntime(t)
  applyPatch(runtime)
  const lines = readFileSync(REOPEN_FIXTURE, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const [{ type: _session, ...header }, ...events] = lines
  const log = join(runtime.logs, 'acp-reopen.v4.jsonl')
  cpSync(REOPEN_FIXTURE, log)
  const bytes = readFileSync(log)
  const checked = await new Promise((resolve, reject) => {
    const worker = new Worker(pathToFileURL(runtime.worker), { workerData: { path: log, compression: 'none', expectedId: header.id, expectedEventCount: events.length }, stderr: true })
    let stderr = ''
    worker.stderr.on('data', chunk => { stderr += chunk })
    worker.once('message', message => resolve({ ...message, stderr }))
    worker.once('error', reject)
  })
  assert.equal(checked.ok, true, checked.message)
  assert.equal(stderrLines(checked.stderr).length, 0, 'nothing tolerated: every call is advertised')
  const patched = await import(`${pathToFileURL(runtime.format).href}?a4`)
  const known = new Set(events.map(event => event.type).filter(type => !type.startsWith('plugin:')))
  const { result, stderr } = restoreCapturingStderr(patched, { header, events: structuredClone(events), inheritedEventCount: 0 }, known)
  assert.equal(stderrLines(stderr).length, 0)
  assert.deepEqual(result.events, events)
  assert.ok(known.has('todo/write'))
  // What the chat draws from them: the notices' summaries, and the last todo list of the turn.
  const notices = result.events.filter(event => event.type === 'user/message' && event.data.source?.form === 'notice').map(event => event.data.source)
  assert.deepEqual(notices.map(source => [source.kind, source.notice, source.summary]), [
    ['acp-session', 'plan', 'Plan: Report plan'],
    ['acp-session', 'usage', 'Tokens: 1,200 in · 330 out · 900 cache read · 1,530 total (as the agent reported it)'],
  ])
  const todos = result.events.filter(event => event.type === 'todo/write').at(-1).data.todos
  assert.deepEqual(todos, [{ content: 'Create the report', status: 'completed' }, { content: 'Check it', status: 'completed' }])
  assert.equal(sha256(readFileSync(log)), sha256(bytes), 'reading never rewrites the chat')
})
