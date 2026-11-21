// The generation record CliGenerations writes beside the per-vendor pointers (#1509, rev 2):
// one atomic object for both vendors, written after the home and the pointer it names, on a
// switch of either vendor, on a reset, and once at start when it is absent or stale.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { CliGenerations, ownershipAt, ownershipState } from '../src/host/cli-generations.js'
import { CliHomes } from '../src/host/cli-homes.js'
import { installationCliHome, installationIdentity } from '../src/host/installation.js'
import { processBirth } from '../src/host/process-identity.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RECORD = 'generation.json'

function paths(t) {
  const root = mkdtempSync(join(tmpdir(), 'acp-generation-record-'))
  chmodSync(root, 0o700)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, cliHome: join(root, 'cli-homes') }
}

function place(t) {
  const { root, cliHome } = paths(t)
  return { root, cliHome, generations: new CliGenerations(cliHome, `${process.pid}-${randomUUID()}`) }
}

const recordPath = cliHome => join(cliHome, 'current', RECORD)
const recordOf = cliHome => JSON.parse(readFileSync(recordPath(cliHome), 'utf8'))
const pointerOf = (cliHome, vendor) => readFileSync(join(cliHome, 'current', vendor), 'utf8')
const tempRecordNames = cliHome => readdirSync(join(cliHome, 'current'))
  .filter(name => name.startsWith(`${RECORD}.`))

test('a panel publishes only after startup and either withdrawal order preserves its peer',
  { skip: !['linux', 'darwin'].includes(process.platform) }, t => {
  const { root: acpHome } = paths(t)
  const dshHome = join(acpHome, 'dsh')
  mkdirSync(dshHome)
  const identity = installationIdentity(dshHome)
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32)
  const directory = join(acpHome, 'selected', digest)
  const options = { acpHome, identity }
  const { root } = installationCliHome(acpHome, dshHome, { identity })
  const open = () => {
    const panel = new CliHomes(root, options)
    t.after(() => panel.dispose())
    const path = join(directory, panel.instance + '.json')
    assert.equal(existsSync(path), false)
    panel.startup('claude')
    assert.equal(existsSync(path), false)
    panel.publishSelection()
    const registration = join(root, 'instances', 'claude', panel.instance)
    const ownership = ownershipAt(registration, { legacy: 'root' })
    assert.equal(ownershipState(ownership), 'live')
    assert.equal(JSON.parse(readFileSync(registration, 'utf8')).reader, true)
    const selection = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(selection, {
      version: 1, identity, root, instance: panel.instance, pid: process.pid,
      birth: processBirth(process.pid), vendors: ['claude'], startedAt: selection.startedAt,
      descriptor: selection.descriptor,
    })
    assert.ok(Number.isInteger(selection.descriptor))
    assert.match(selection.startedAt, ISO_MS)
    const env = panel.environment('claude', { DSH_HOME: '/wrong', AUTOMAGIK_HOME: '/wrong' })
    assert.equal(env.DSH_HOME, identity)
    assert.equal(env.AUTOMAGIK_HOME, dirname(acpHome))
    return { panel, path, registration }
  }
  const first = open(), second = open()
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    assert.equal(statSync(second.path).mode & 0o777, 0o600)
  }
  second.panel.dispose()
  assert.equal(existsSync(second.path), false)
  assert.equal(existsSync(second.registration), false)
  assert.equal(existsSync(first.path), true)
  const third = open()
  first.panel.dispose()
  assert.equal(existsSync(first.path), false)
  assert.equal(existsSync(first.registration), false)
  assert.equal(existsSync(third.path), true)
})

test('withdrawal preserves a replacement file and revokes the original open inode',
  { skip: !['linux', 'darwin'].includes(process.platform) }, t => {
  const { root: acpHome, cliHome } = paths(t)
  const errors = []
  const panel = new CliHomes(cliHome, { acpHome, identity: join(acpHome, 'dsh'),
    onSelectionError: action => errors.push(action) })
  panel.startup('claude')
  panel.publishSelection()
  const { path } = panel.selection
  const moved = join(acpHome, 'unlinked-panel')
  renameSync(path, moved)
  writeFileSync(path, 'replacement', { mode: 0o600 })
  const registration = join(cliHome, 'instances', 'claude', panel.instance)
  const release = panel.generations.release.bind(panel.generations)
  let attempts = 0
  panel.generations.release = (file, options) => {
    if (file === registration && ++attempts < 3) throw new Error('simulated withdrawal failure')
    return release(file, options)
  }
  panel.dispose()
  assert.equal(readFileSync(moved, 'utf8'), '', 'the old bytes cannot vouch for a still-live PID')
  assert.equal(existsSync(registration), false)
  assert.equal(attempts, 3)
  assert.equal(readFileSync(path, 'utf8'), 'replacement')
  assert.deepEqual(errors, [])
  assert.equal(panel.selection, undefined)
})

test('failed unlink, revocation and unregister still close the panel descriptor',
  { skip: process.platform !== 'linux' }, t => {
    const { root: acpHome, cliHome } = paths(t)
    const errors = []
    const panel = new CliHomes(cliHome, { acpHome, identity: join(acpHome, 'dsh'),
      onSelectionError: action => errors.push(action) })
    panel.startup('claude')
    panel.publishSelection()
    const { path, handle } = panel.selection
    const { descriptor } = JSON.parse(readFileSync(path, 'utf8'))
    const fdPath = `/proc/${process.pid}/fd/${descriptor}`
    assert.equal(statSync(fdPath).ino, statSync(path).ino)
    const blocked = () => { throw new Error('simulated durable I/O failure') }
    t.mock.method(handle, 'unlink', blocked)
    t.mock.method(handle, 'revoke', blocked)
    t.mock.method(panel.generations, 'unregister', blocked)
    panel.dispose()
    assert.equal(existsSync(path), true)
    assert.equal(existsSync(join(cliHome, 'instances', 'claude', panel.instance)), true)
    assert.equal(existsSync(fdPath), false)
    assert.deepEqual(errors, ['withdrawn', 'withdrawn', 'withdrawn'])
  })

test('a DSH symlink change cannot split root selection from the published identity',
  { skip: process.platform === 'win32' }, t => {
    const { root: acpHome } = paths(t)
    const first = join(acpHome, 'first'), second = join(acpHome, 'second'), link = join(acpHome, 'dsh')
    mkdirSync(first); mkdirSync(second)
    symlinkSync(first, link)
    const identity = installationIdentity(link)
    const { root } = installationCliHome(acpHome, link, { identity })
    rmSync(link)
    symlinkSync(second, link)
    const panel = new CliHomes(root, { acpHome, identity })
    t.after(() => panel.dispose())
    panel.startup('claude')
    panel.publishSelection()
    assert.equal(panel.environment('claude').DSH_HOME, identity)
    assert.notEqual(identity, installationIdentity(link))
    assert.equal(JSON.parse(readFileSync(panel.selection.path, 'utf8')).identity, identity)
    assert.equal(JSON.parse(readFileSync(join(root, 'installation.json'), 'utf8')).identity, identity)
  })

test('a failed vendor startup and a symlinked selection directory publish no authorization',
  { skip: process.platform === 'win32' }, t => {
    const { root: acpHome, cliHome } = paths(t)
    const errors = []
    const panel = new CliHomes(cliHome, { acpHome, identity: join(acpHome, 'dsh'),
      onSelectionError: action => errors.push(action) })
    t.after(() => panel.dispose())
    mkdirSync(join(cliHome, 'current'), { recursive: true })
    writeFileSync(join(cliHome, 'current', 'codex.activated'), '')
    assert.throws(() => panel.startup('codex'))
    panel.publishSelection()
    const selected = join(acpHome, 'selected')
    assert.equal(existsSync(selected), false)
    const other = join(acpHome, 'other')
    mkdirSync(other)
    symlinkSync(other, selected)
    panel.startup('claude')
    assert.deepEqual(errors, ['recorded'])
    assert.deepEqual(readdirSync(other), [])
    rmSync(selected)
    panel.publishSelection()
    assert.deepEqual(JSON.parse(readFileSync(panel.selection.path, 'utf8')).vendors, ['claude'])
  })

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
  const second = new CliGenerations(cliHome, `${process.pid}-${randomUUID()}`)
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
  assert.throws(() => service.reset('claude'), /pointer moved, but the generation record could not be saved/)
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

test('the record and the temp file it renames are private (0600)',
  { skip: process.platform === 'win32' }, t => {
    const { cliHome, generations } = place(t)
    const tempModes = []
    const rename = generations.rename
    generations.rename = (from, to) => {
      tempModes.push([statSync(from).mode & 0o777, to])
      return rename(from, to)
    }
    generations.select('claude', randomUUID())
    assert.deepEqual(tempModes.map(([mode]) => mode), [0o600],
      'the temp file is private before the rename')
    assert.equal(tempModes[0][1], recordPath(cliHome))
    assert.equal(statSync(recordPath(cliHome)).mode & 0o777, 0o600,
      'the record the reader opens is private')
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

test('interleaved select and startup reconciliation share the whole-record claim', t => {
  const { cliHome, generations: first } = place(t)
  const second = new CliGenerations(cliHome, `${process.pid}-${randomUUID()}`)
  const old = randomUUID()
  const newest = randomUUID()
  first.select('claude', old)
  let blocked = 0
  const rename = first.rename
  first.rename = (from, to) => {
    assert.throws(() => second.select('claude', newest), /Close other Automagik sessions/)
    blocked++
    return rename(from, to)
  }
  // Force reconciliation to write, then interleave another writer while it is in flight.
  const stale = recordOf(cliHome)
  writeFileSync(recordPath(cliHome), JSON.stringify({ ...stale, claude: null }))
  first.ensureRecord()
  assert.equal(blocked, 1)
  second.select('claude', newest)
  assert.equal(recordOf(cliHome).claude.generation, newest)
  assert.equal(recordOf(cliHome).sequence, stale.sequence + 2)

  // The reverse interleaving: startup cannot write while a selection is in flight.
  const latest = randomUUID()
  first.rename = (from, to) => {
    assert.throws(() => second.ensureRecord(), /Close other Automagik sessions/)
    blocked++
    return rename(from, to)
  }
  first.select('claude', latest)
  assert.equal(blocked, 2)
  assert.equal(second.ensureRecord(), false)
  assert.equal(recordOf(cliHome).claude.generation, latest)
  assert.equal(recordOf(cliHome).sequence, stale.sequence + 3)
})

test('startup reports an unwritable record and continues', t => {
  const { cliHome } = paths(t)
  const reports = []
  const service = new CliHomes(cliHome, { onRecordError: vendor => reports.push(vendor) })
  t.after(() => service.dispose())
  service.generations.rename = () => { throw new Error('injected write failure') }
  assert.doesNotThrow(() => service.startup('claude'))
  assert.deepEqual(reports, ['claude'])
  assert.equal(existsSync(recordPath(cliHome)), false)
})

test('start repairs a Codex mismatch', t => {
  const { cliHome, generations } = place(t)
  const generation = randomUUID()
  generations.select('codex', generation)
  const old = recordOf(cliHome)
  writeFileSync(recordPath(cliHome), JSON.stringify({ ...old, codex: null }))
  assert.equal(generations.ensureRecord(), true)
  assert.equal(recordOf(cliHome).codex.generation, generation)
  assert.equal(recordOf(cliHome).sequence, old.sequence + 1)
})

test('start repairs a record with the wrong version', t => {
  const { cliHome, generations } = place(t)
  generations.select('claude', randomUUID())
  const old = recordOf(cliHome)
  writeFileSync(recordPath(cliHome), JSON.stringify({ ...old, version: 99 }))
  assert.equal(generations.ensureRecord(), true)
  assert.equal(recordOf(cliHome).version, 1)
  assert.equal(recordOf(cliHome).sequence, old.sequence + 1)
})

test('start leaves matching records with bad metadata alone; select resets a bad sequence to one', t => {
  const { cliHome, generations } = place(t)
  generations.select('claude', randomUUID())
  for (const sequence of ['3', -1]) {
    const bytes = JSON.stringify({ ...recordOf(cliHome), sequence, updatedAt: 'invalid' })
    writeFileSync(recordPath(cliHome), bytes)
    assert.equal(generations.ensureRecord(), false)
    assert.equal(readFileSync(recordPath(cliHome), 'utf8'), bytes)
    generations.select('claude', randomUUID())
    assert.equal(recordOf(cliHome).sequence, 1)
  }
})

test('a damaged pointer is recorded as null', t => {
  const { cliHome, generations } = place(t)
  generations.select('codex', randomUUID())
  const old = recordOf(cliHome)
  writeFileSync(join(cliHome, 'current', 'codex'), 'damaged')
  assert.equal(generations.ensureRecord(), true)
  assert.equal(recordOf(cliHome).codex, null)
  assert.equal(recordOf(cliHome).sequence, old.sequence + 1)
})
