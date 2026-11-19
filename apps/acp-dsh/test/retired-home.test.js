// A retired Bot account home keeps its session and usage history (#1529): reset moves the
// pointer and writes the retirement note, never a delete. Collection reports what it keeps
// and refuses an ambiguous home instead of guessing. Temp homes only.
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliHomes } from '../src/host/cli-homes.js'
import { retiredLine } from '../src/host/retired-home.js'

function place(t) {
  const root = mkdtempSync(join(tmpdir(), 'retired-home-'))
  const homes = new CliHomes(join(root, 'bots'))
  t.after(() => { homes.dispose(); rmSync(root, { recursive: true, force: true }) })
  return { root, homes }
}

/** The one retired marker this test made; no other run can add one to its own temp root. */
function marked(root) {
  const directory = join(root, 'bots', 'retired', 'codex')
  const names = readdirSync(directory)
  const generation = names.find(name => name === 'legacy' || /^[a-f0-9-]{36}$/.test(name))
  assert.ok(generation, `a retired marker exists (${names.join(', ')})`)
  return { directory, generation, marker: join(directory, generation) }
}

test('collection keeps a retired home and its session and usage history', t => {
  const { root, homes } = place(t)
  const old = homes.environment('codex')
  mkdirSync(join(old.CODEX_HOME, 'sessions'), { recursive: true })
  writeFileSync(join(old.CODEX_HOME, 'sessions', 'session.jsonl'), 'native session')
  writeFileSync(join(old.HOME, 'usage.json'), 'usage history')
  homes.reset('codex')
  homes.collect('codex')
  assert.equal(existsSync(old.HOME), true, 'the retired home stays at its bound path')
  assert.equal(readFileSync(join(old.CODEX_HOME, 'sessions', 'session.jsonl'), 'utf8'), 'native session')
  assert.equal(readFileSync(join(old.HOME, 'usage.json'), 'utf8'), 'usage history')
  assert.equal(existsSync(marked(root).marker), true, 'the retirement marker stays too')
})

test('a second reset retires a generation home under homes/ and keeps it too', t => {
  const { homes } = place(t)
  homes.environment('codex')
  homes.reset('codex')
  const first = homes.environment('codex').HOME
  const generation = homes.generations.current('codex')
  mkdirSync(join(first, '.codex', 'sessions'), { recursive: true })
  writeFileSync(join(first, '.codex', 'sessions', 'session.jsonl'), 'second generation session')
  homes.reset('codex')
  homes.collect('codex')
  assert.equal(existsSync(first), true, 'the generation home stays at its bound path')
  assert.equal(readFileSync(join(first, '.codex', 'sessions', 'session.jsonl'), 'utf8'),
    'second generation session')
  const row = homes.retired('codex').find(candidate => candidate.generation === generation)
  assert.ok(row, 'the generation is listed as retired')
  assert.equal(row.home, first)
  assert.equal(row.state, 'kept')
  assert.equal(existsSync(join(first, 'RETIRED.json')), true)
})

test('the retirement note says what is kept, where, how long, how to inspect and how to opt out', t => {
  const { homes } = place(t)
  const old = homes.environment('codex')
  homes.reset('codex')
  const note = JSON.parse(readFileSync(join(old.HOME, 'RETIRED.json'), 'utf8'))
  assert.equal(note.version, 1)
  assert.equal(note.vendor, 'codex')
  assert.equal(note.home, old.HOME)
  assert.deepEqual(note.removed, [])
  assert.match(note.kept.sessions, /session/i)
  assert.match(note.kept.usage, /usage/i)
  assert.match(note.forHowLong, /until/i)
  assert.match(note.inspect, /RETIRED\.json/)
  assert.match(note.optOut, /KEEP/)
  assert.equal(note.collection.allowed, false)
  assert.match(note.collection.because, /kept/i)
  assert.equal(statSync(join(old.HOME, 'RETIRED.json')).mode & 0o777, 0o600)
})

test('retired() reports each kept home, its bound path and why it is kept', t => {
  const { root, homes } = place(t)
  const old = homes.environment('codex')
  homes.reset('codex')
  const rows = homes.retired()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].vendor, 'codex')
  assert.equal(rows[0].generation, marked(root).generation)
  assert.equal(rows[0].home, old.HOME)
  assert.equal(rows[0].state, 'kept')
  assert.equal(rows[0].kept, true)
  assert.equal(rows[0].optedOut, false)
  assert.match(rows[0].reason, /session and usage history stay readable/i)
})

test('a person opts out with KEEP and the report says the home is kept for them', t => {
  const { homes } = place(t)
  const old = homes.environment('codex')
  homes.reset('codex')
  writeFileSync(join(old.HOME, 'KEEP'), '')
  const [row] = homes.retired()
  assert.equal(row.optedOut, true)
  assert.match(row.reason, /KEEP/)
})

test('a home whose path is not provably its own is refused, never collected', t => {
  const { root, homes } = place(t)
  const old = homes.environment('codex')
  homes.reset('codex')
  const elsewhere = join(root, 'not-ours')
  mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, 'keep'), 'someone else')
  rmSync(old.HOME, { recursive: true, force: true })
  symlinkSync(elsewhere, old.HOME)
  const [row] = homes.retired()
  assert.equal(row.state, 'refused')
  assert.match(row.reason, /cannot tell|could not prove/i)
  homes.collect('codex')
  assert.equal(lstatSync(old.HOME).isSymbolicLink(), true, 'the link stays as the person left it')
  assert.equal(readFileSync(join(elsewhere, 'keep'), 'utf8'), 'someone else')
})

test('startup reports a kept retired home once, for the log, without a path', t => {
  const { root, homes } = place(t)
  homes.environment('codex')
  homes.reset('codex')
  homes.dispose()
  const seen = []
  const again = new CliHomes(join(root, 'bots'), { onRetired: (vendor, kept) => seen.push({ vendor, kept }) })
  t.after(() => again.dispose())
  again.startup('codex')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].vendor, 'codex')
  assert.equal(seen[0].kept.length, 1)
  assert.equal(seen[0].kept[0].state, 'kept')
  const line = retiredLine('codex', seen[0].kept)
  assert.match(line, /kept 1 retired codex Bot sign-in home/)
  assert.match(line, /RETIRED\.json/)
  assert.equal(line.includes(root), false, 'the log line carries no local path')
})

test('a marker that is not the retirement marker is refused, never collected', t => {
  const { root, homes } = place(t)
  const old = homes.environment('codex')
  homes.reset('codex')
  writeFileSync(marked(root).marker, 'not a retirement marker')
  const [row] = homes.retired()
  assert.equal(row.state, 'refused')
  assert.equal(row.kept, true)
  homes.collect('codex')
  assert.equal(existsSync(old.HOME), true)
})

test('a person\'s own RETIRED.json is never overwritten by a reset', t => {
  const { homes } = place(t)
  const old = homes.environment('codex')
  writeFileSync(join(old.HOME, 'RETIRED.json'), 'the person wrote this')
  homes.reset('codex')
  assert.equal(readFileSync(join(old.HOME, 'RETIRED.json'), 'utf8'), 'the person wrote this')
})
