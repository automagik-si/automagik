// The generation record CliGenerations writes beside the per-vendor pointers (#1509, rev 2):
// one atomic object for both vendors, written after the home and the pointer it names, on a
// switch of either vendor, on a reset, and once at start when it is absent or stale.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { CliGenerations } from '../src/host/cli-generations.js'
import { CliHomes } from '../src/host/cli-homes.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RECORD = 'generation.json'

function paths(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-generation-record-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, cliHome: join(root, 'cli-homes') }
}

function place(t) {
  const { root, cliHome } = paths(t)
  return { root, cliHome, generations: new CliGenerations(cliHome, `test-${randomUUID()}`) }
}

const recordPath = cliHome => join(cliHome, 'current', RECORD)
const recordOf = cliHome => JSON.parse(readFileSync(recordPath(cliHome), 'utf8'))
const pointerOf = (cliHome, vendor) => readFileSync(join(cliHome, 'current', vendor), 'utf8')
const tempRecordNames = cliHome => readdirSync(join(cliHome, 'current'))
  .filter(name => name.startsWith(`${RECORD}.`))

test('the record sits beside the pointers, one object with a field per vendor', t => {
  const { cliHome, generations } = place(t)
  const claude = randomUUID()
  const codex = randomUUID()
  generations.select('claude', claude)
  generations.select('codex', codex)
  const record = recordOf(cliHome)
  assert.deepEqual(Object.keys(record).sort(), ['claude', 'codex', 'sequence', 'updatedAt', 'version'])
  assert.equal(record.version, 1)
  assert.equal(record.sequence, 2)
  assert.match(record.updatedAt, ISO_MS)
  assert.equal(new Date(record.updatedAt).toISOString(), record.updatedAt)
  assert.match(record.claude.generation, UUID)
  assert.match(record.codex.generation, UUID)
  assert.equal(record.claude.generation, claude)
  assert.equal(record.codex.generation, codex)
  assert.deepEqual(record.claude, {
    generation: claude, configDir: join(cliHome, 'homes', 'claude', claude, '.claude'),
  })
  assert.deepEqual(record.codex, {
    generation: codex, home: join(cliHome, 'homes', 'codex', codex, '.codex'),
  })
  assert.ok(isAbsolute(record.claude.configDir))
  assert.ok(isAbsolute(record.codex.home))
  // The pointers stay as they are; the record is the only new path.
  assert.equal(pointerOf(cliHome, 'claude'), claude)
  assert.equal(pointerOf(cliHome, 'codex'), codex)
  assert.equal(existsSync(join(cliHome, RECORD)), false)
})

test('a vendor with no generation is null, and the other vendor keeps its field', t => {
  const { cliHome, generations } = place(t)
  const claude = randomUUID()
  generations.select('claude', claude)
  const first = recordOf(cliHome)
  assert.equal(first.claude.generation, claude)
  assert.equal(first.codex, null)
  const codex = randomUUID()
  generations.select('codex', codex)
  const second = recordOf(cliHome)
  assert.deepEqual(second.claude, first.claude)
  assert.equal(second.codex.generation, codex)
  // A legacy home is not a generation: no pointer, no field.
  const { cliHome: legacyHome } = paths(t)
  const service = new CliHomes(legacyHome)
  t.after(() => service.dispose())
  service.startup('claude')
  service.startup('codex')
  const boot = recordOf(legacyHome)
  assert.equal(boot.claude, null)
  assert.equal(boot.codex, null)
})

test('every write advances the sequence, across vendors, instances and resets', t => {
  const { cliHome, generations } = place(t)
  generations.select('claude', randomUUID())
  assert.equal(recordOf(cliHome).sequence, 1)
  generations.select('claude', randomUUID())
  assert.equal(recordOf(cliHome).sequence, 2)
  const second = new CliGenerations(cliHome, `test-${randomUUID()}`)
  second.select('codex', randomUUID())
  assert.equal(recordOf(cliHome).sequence, 3)
  const service = new CliHomes(cliHome)
  t.after(() => service.dispose())
  service.reset('codex')
  assert.equal(recordOf(cliHome).sequence, 4)
})

test('a switch of one vendor preserves the other vendor’s exact field', t => {
  const { cliHome, generations } = place(t)
  const claude = randomUUID()
  const codex = randomUUID()
  generations.select('claude', claude)
  generations.select('codex', codex)
  const claudeField = {
    generation: claude, configDir: join(cliHome, 'homes', 'claude', claude, '.claude'),
  }
  const codexField = {
    generation: codex, home: join(cliHome, 'homes', 'codex', codex, '.codex'),
  }
  const before = recordOf(cliHome)
  assert.deepEqual(before.claude, claudeField)
  assert.deepEqual(before.codex, codexField)
  assert.equal(before.codex.generation, pointerOf(cliHome, 'codex'))
  // A Claude switch keeps Codex's present field exactly as it was.
  const nextClaude = randomUUID()
  generations.select('claude', nextClaude)
  const afterClaude = recordOf(cliHome)
  assert.deepEqual(afterClaude.codex, codexField)
  assert.equal(afterClaude.codex.generation, pointerOf(cliHome, 'codex'))
  assert.equal(afterClaude.codex.home, codexField.home)
  assert.equal(afterClaude.claude.generation, nextClaude)
  assert.equal(afterClaude.sequence, before.sequence + 1)
  // The reverse: a Codex switch keeps Claude's present field exactly as it was.
  const nextCodex = randomUUID()
  generations.select('codex', nextCodex)
  const afterCodex = recordOf(cliHome)
  const nextClaudeField = {
    generation: nextClaude, configDir: join(cliHome, 'homes', 'claude', nextClaude, '.claude'),
  }
  assert.deepEqual(afterClaude.claude, nextClaudeField)
  assert.deepEqual(afterCodex.claude, nextClaudeField)
  assert.equal(afterCodex.claude.generation, pointerOf(cliHome, 'claude'))
  assert.equal(afterCodex.claude.configDir, nextClaudeField.configDir)
  assert.equal(afterCodex.codex.generation, nextCodex)
  assert.equal(afterCodex.sequence, before.sequence + 2)
})

test('a reset writes its new generation and leaves the other vendor field unchanged', t => {
  const { cliHome } = paths(t)
  const service = new CliHomes(cliHome)
  t.after(() => service.dispose())
  const codexHome = service.reset('codex')
  const first = recordOf(cliHome)
  assert.equal(first.claude, null)
  assert.equal(first.codex.generation, pointerOf(cliHome, 'codex'))
  assert.equal(first.codex.home, join(codexHome, '.codex'))
  assert.equal(first.sequence, 1)
  const claudeHome = service.reset('claude')
  const second = recordOf(cliHome)
  assert.deepEqual(second.codex, first.codex)
  assert.equal(second.claude.generation, pointerOf(cliHome, 'claude'))
  assert.equal(second.claude.configDir, join(claudeHome, '.claude'))
  assert.equal(second.sequence, 2)
})

test('a failed record rename leaves the old record while the pointer has already moved', t => {
  const { cliHome } = paths(t)
  const service = new CliHomes(cliHome)
  t.after(() => service.dispose())
  service.reset('claude')
  const oldBytes = readFileSync(recordPath(cliHome), 'utf8')
  const oldRecord = recordOf(cliHome)
  const oldPointer = pointerOf(cliHome, 'claude')
  const rename = service.generations.rename
  let targeted = 0
  service.generations.rename = (from, to) => {
    if (to !== recordPath(cliHome)) return rename(from, to)
    targeted++
    assert.equal(dirname(from), dirname(to), 'the temp file is in the record’s directory')
    throw Object.assign(new Error('injected record rename failure'), { code: 'EIO' })
  }
  assert.throws(() => service.reset('claude'), /injected record rename failure/)
  assert.equal(targeted, 1, 'only the record rename failed')
  assert.notEqual(pointerOf(cliHome, 'claude'), oldPointer)
  assert.match(pointerOf(cliHome, 'claude'), UUID)
  assert.equal(readFileSync(recordPath(cliHome), 'utf8'), oldBytes)
  assert.deepEqual(recordOf(cliHome), oldRecord)
  assert.deepEqual(tempRecordNames(cliHome), [])
})

test('the record write fsyncs the file, renames, then fsyncs the directory',
  { skip: process.platform === 'win32' }, t => {
    const { cliHome } = paths(t)
    const service = new CliHomes(cliHome)
    t.after(() => service.dispose())
    service.reset('claude')
    const calls = []
    const fsync = service.generations.fsync
    const rename = service.generations.rename
    service.generations.fsync = fd => { calls.push(['fsync', fd]); return fsync(fd) }
    service.generations.rename = (from, to) => { calls.push(['rename', from, to]); return rename(from, to) }
    service.reset('claude')
    assert.deepEqual(calls.map(([kind]) => kind), ['fsync', 'rename', 'fsync'])
    assert.equal(calls[1][2], recordPath(cliHome))
    assert.equal(dirname(calls[1][1]), dirname(calls[1][2]))
  })

test('start writes an absent record once and leaves a matching record untouched', t => {
  const { cliHome } = paths(t)
  const first = new CliHomes(cliHome)
  first.reset('claude')
  first.reset('codex')
  first.dispose()
  const matching = readFileSync(recordPath(cliHome), 'utf8')
  const restarted = new CliHomes(cliHome)
  t.after(() => restarted.dispose())
  restarted.startup('claude')
  restarted.startup('codex')
  assert.equal(readFileSync(recordPath(cliHome), 'utf8'), matching, 'a matching record is not rewritten')
  rmSync(recordPath(cliHome))
  const boot = new CliHomes(cliHome)
  t.after(() => boot.dispose())
  boot.startup('claude')
  boot.startup('codex')
  const record = recordOf(cliHome)
  assert.equal(record.version, 1)
  assert.equal(record.sequence, 1)
  assert.equal(record.claude.generation, pointerOf(cliHome, 'claude'))
  assert.equal(record.codex.generation, pointerOf(cliHome, 'codex'))
})

test('start rewrites a record that does not match the pointers and advances its sequence', t => {
  const { cliHome } = paths(t)
  const first = new CliHomes(cliHome)
  first.reset('claude')
  first.dispose()
  const stale = recordOf(cliHome)
  writeFileSync(recordPath(cliHome), JSON.stringify({ ...stale, claude: null }))
  const restarted = new CliHomes(cliHome)
  t.after(() => restarted.dispose())
  restarted.startup('claude')
  const record = recordOf(cliHome)
  assert.equal(record.sequence, stale.sequence + 1)
  assert.equal(record.claude.generation, pointerOf(cliHome, 'claude'))
  assert.equal(record.claude.configDir, stale.claude.configDir)
  assert.equal(record.codex, null)
})
