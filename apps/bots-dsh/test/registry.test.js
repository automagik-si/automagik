import { SEAT_AGENTS as CLIENT_SEAT_AGENTS } from '../src/shared/bot-types.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  BOT_ID, SEAT_AGENTS, MAX_FILE_BYTES, checkRegistry, defaultLook, dropBot, dropLock, emptyRegistry, fromDshState, fromHerdrV1,
  indentOf, isBotId, newBotId, parseRegistry, putBot, readRegistryText, takeLock, updateRegistry, writeRegistry,
} from '../src/shared/registry.js'

const ID = { main: 'b-mainmain22', dev: 'b-devdevdev3', dsh: 'session-0b3c1f9e-4d1a-4c55-9a7e-2f6b8d1e0a77' }
const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-registry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }))
  return dir
}
const repoFile = () => ({
  version: 2,
  name: 'Automagik',
  categories: [{ id: 'core', title: 'Core' }],
  bots: [
    { id: ID.main, name: 'Captain', role: 'leads', instructions: 'Lead.', main: true, agent: 'claude', rank: 'captain' },
    { id: ID.dev, name: 'Dev', role: 'builds', instructions: '', agent: 'codex', lead: ID.main, category: 'core' },
  ],
})
const homeFile = () => ({
  version: 2,
  bots: [
    { id: ID.dsh, name: 'Omni', role: '', instructions: 'Hi.', main: true, identity: 'omni',
      pet: { source: 'builtin', id: 'genie-clay' }, dsh: { model: 'deepseek/v4', effort: 'high', color: 'teal' } },
    { id: ID.main, name: 'Remote', folder: '/srv/repo', machine: 'khal-labs' },
  ],
  projects: [{ folder: '/Users/me/repo' }, { folder: '/srv/repo', machine: 'g9' }],
  shown: [{ project: null, bots: [ID.dsh] }, { project: '/Users/me/repo', bots: [ID.main] }],
})
const text = (raw, indent = 2) => `${JSON.stringify(raw, null, indent)}\n`

test('ids: newBotId mints b- plus 10 base32, and both shapes are accepted', () => {
  for (let i = 0; i < 1000; i += 1) assert.match(newBotId(), /^b-[a-z2-7]{10}$/)
  assert.equal(newBotId(() => 0), 'b-aaaaaaaaaa')
  assert.equal(newBotId(() => 0.999999), 'b-7777777777')
  assert.ok(isBotId(ID.main))
  assert.ok(isBotId(ID.dsh))
  assert.ok(BOT_ID.test(`session-${crypto.randomUUID()}`))
  for (const bad of ['unfold-root', 'b-short', 'b-ABCDEFGHIJ', 'b-0123456789', 'session-xyz', 'session-1234', '', null, 7]) {
    assert.equal(isBotId(bad), false, String(bad))
  }
})

test('parse: a good repo file and a good home file read as written', () => {
  const repo = parseRegistry(text(repoFile()), { kind: 'repo' })
  assert.deepEqual(repo.warnings, [])
  assert.deepEqual(repo.file, repoFile())
  assert.equal(repo.indent, '  ')
  const home = parseRegistry(text(homeFile()), { kind: 'home' })
  assert.deepEqual(home.warnings, [])
  assert.deepEqual(home.file.bots.map(b => b.id), [ID.dsh, ID.main])
  assert.equal(home.file.bots[1].machine, 'khal-labs')
  assert.deepEqual(home.file.shown, homeFile().shown)
  assert.deepEqual(checkRegistry(repo.file, { kind: 'repo' }), [])
  assert.deepEqual(checkRegistry(home.file, { kind: 'home' }), [])
})

test('parse: what is not a version 2 file throws', () => {
  for (const [bad, why] of [
    ['{', /JSON|Expected|Unexpected/],
    ['[]', /not an object/],
    [text({ version: 1, bots: [] }), /version 1, expected 2/],
    [text({ version: 2 }), /no bots list/],
  ]) assert.throws(() => parseRegistry(bad, { kind: 'repo' }), why)
  assert.throws(() => parseRegistry(text(repoFile()), {}), /kind is "home" or "repo"/)
})

test('parse: bad entries are left out with a warning, as Herdr does', () => {
  const raw = repoFile()
  raw.bots.push(
    { id: 'unfold-root', name: 'Unfold' },
    { id: ID.dev, name: 'Twice' },
    { id: 'b-nonamenone', name: ' ' },
    { id: 'b-badpetbad2', name: 'Pet', pet: { source: 'team', id: '../../.ssh' } },
    { id: 'b-badmainxx2', name: 'Main?', main: 'yes', role: 7 },
  )
  const { file, warnings } = parseRegistry(text(raw), { kind: 'repo' })
  assert.deepEqual(file.bots.map(b => b.id), [ID.main, ID.dev, 'b-badpetbad2', 'b-badmainxx2'])
  assert.equal(file.bots[2].pet, undefined)
  assert.equal(file.bots[3].main, undefined)
  assert.equal(file.bots[3].role, '')
  assert.equal(warnings.length, 6, warnings.join('\n'))
  assert.ok(warnings.includes('bots[2] (unfold-root): id is not b- plus 10 base32 characters or session-<uuid>; left out'))
  assert.ok(warnings.includes(`bots[3] (${ID.dev}): id used twice; left out`))
  assert.ok(warnings.includes('bots[4] (b-nonamenone): name is missing; left out'))
  assert.ok(warnings.some(w => /pet id "..\/..\/.ssh" is not one path segment/.test(w)))
})

test('parse: a repo file with two main Bots warns and the first counts', () => {
  const raw = repoFile()
  raw.bots[1].main = true
  const { file, warnings } = parseRegistry(text(raw), { kind: 'repo' })
  assert.deepEqual(file.bots.map(b => b.main), [true, false])
  assert.deepEqual(warnings, [`bots: 2 main bots; ${ID.main} counts`])
})

test('a repo file cannot set folder, machine, dsh, shown or projects', () => {
  const raw = repoFile()
  Object.assign(raw.bots[0], { folder: '/', machine: 'g9', dsh: { model: 'x' } })
  raw.shown = [{ project: null, bots: [ID.main] }]
  raw.projects = [{ folder: '/etc' }]
  const parsed = parseRegistry(text(raw), { kind: 'repo' })
  assert.equal(parsed.file.shown, undefined)
  assert.equal(parsed.file.projects, undefined)
  for (const key of ['folder', 'machine', 'dsh']) assert.equal(parsed.file.bots[0][key], undefined)
  assert.equal(parsed.warnings.length, 5, parsed.warnings.join('\n'))
  // The raw copy still holds them: a reader keeps what it does not use.
  assert.equal(parsed.raw.bots[0].folder, '/')
  // A writer may not add them; one a hand-written file already had stays writable.
  const errors = checkRegistry(raw, { kind: 'repo', before: text(repoFile()) })
  assert.deepEqual(errors.sort(), [
    `bots[0] (${ID.main}): dsh: only the home file holds it`,
    `bots[0] (${ID.main}): folder: only the home file holds it`,
    `bots[0] (${ID.main}): machine: only the home file holds it`,
    'projects: only the home file holds it',
    'shown: only the home file holds it',
  ])
  assert.deepEqual(checkRegistry(raw, { kind: 'repo', before: text(raw) }), [])
})

test('check: what a write refuses', () => {
  const noMain = repoFile()
  noMain.bots[0].main = false
  assert.deepEqual(checkRegistry(noMain, { kind: 'repo' }), ['bots: 0 with main: true; a project has exactly one main bot'])
  assert.deepEqual(checkRegistry({ version: 2, bots: [] }, { kind: 'repo' }), [])
  assert.deepEqual(checkRegistry({ version: 1, bots: [] }, { kind: 'home' }), ['not a version 2 bots file'])
  const bad = homeFile()
  bad.bots.push({ id: 'unfold-root', name: 'U' }, { id: ID.dsh, name: '' })
  bad.bots[0].pet = { source: 'codex', id: 'x' }
  bad.bots[1].machine = '-oProxyCommand'
  bad.shown.push({ project: '/x', bots: ['nope'] })
  bad.projects.push({ machine: 'g9' })
  // Each refusal names the entry (its place and id) and the field, so it can be fixed by hand.
  assert.deepEqual(checkRegistry(bad, { kind: 'home' }).sort(), [
    `bots[0] (${ID.dsh}): pet source "codex" is not builtin or team`,
    `bots[1] (${ID.main}): machine needs a folder and a machine name`,
    'bots[2] (unfold-root): id is not b- plus 10 base32 characters or session-<uuid>',
    `bots[3] (${ID.dsh}): id used twice`,
    `bots[3] (${ID.dsh}): name is missing`,
    'projects[2]: folder is missing',
    'shown[2] (/x): bots: an id that is not a Bot id',
  ].sort())
  // A home file may hold any number of team Main Bots.
  const mains = homeFile()
  mains.bots[1].main = true
  assert.deepEqual(checkRegistry(mains, { kind: 'home' }), [])
})

test('unknown fields round-trip through a write, and the indentation is kept', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  const raw = homeFile()
  raw.futureTop = { keep: true }
  raw.bots[0].dsh.futureInk = 'x'
  raw.bots[1].rank = 'dev'
  raw.bots[1].worker = { agent: 'codex', template: 'reviewer', swap: { agent: 'claude' } }
  raw.bots[1].somethingNew = [1, 2]
  const before = text(raw, '\t')
  writeFileSync(path, before)
  const { raw: written } = await updateRegistry(path, r => putBot(r, { id: ID.main, name: 'Renamed' }), { kind: 'home' })
  const after = readFileSync(path, 'utf8')
  assert.equal(indentOf(after), '\t')
  const expected = structuredClone(raw)
  expected.bots[1].name = 'Renamed'
  assert.deepEqual(JSON.parse(after), expected)
  assert.deepEqual(written, expected)
  assert.equal(existsSync(`${path}.lock`), false)
})

test('a new file gets its folder, two spaces, and is created exclusively', async (t) => {
  const path = join(tempDir(t), 'repo', '.automagik', 'bots', 'bots.json')
  const bot = { id: newBotId(), name: 'Captain', main: true }
  const written = await writeRegistry(path, { version: 2, bots: [bot] }, null, { kind: 'repo' })
  assert.equal(readFileSync(path, 'utf8'), written)
  assert.equal(indentOf(written), '  ')
  await assert.rejects(writeRegistry(path, { version: 2, bots: [bot] }, null, { kind: 'repo' }), { code: 'registry/stale' })
})

test('two writers from the same text: one saved, one refused', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  const start = text(repoFile())
  writeFileSync(path, start)
  const edit = name => putBot(parseRegistry(start, { kind: 'repo' }).raw, { id: ID.dev, name })
  const results = await Promise.allSettled([
    writeRegistry(path, edit('From DSH'), start, { kind: 'repo' }),
    writeRegistry(path, edit('From the CLI'), start, { kind: 'repo' }),
  ])
  const saved = results.filter(r => r.status === 'fulfilled')
  const refused = results.filter(r => r.status === 'rejected')
  assert.equal(saved.length, 1)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason.code, 'registry/stale')
  assert.match(refused[0].reason.message, /changed since it was read/)
  assert.equal(readFileSync(path, 'utf8'), saved[0].value)
  assert.deepEqual(readdirSync(join(path, '..')), ['bots.json'])
})

test('updateRegistry redoes the edit on the fresh text when another write landed first', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  writeFileSync(path, text(repoFile()))
  let calls = 0
  const { raw } = await updateRegistry(path, r => {
    calls += 1
    // Another writer lands between this edit's read and its write, once.
    if (calls === 1) writeFileSync(path, text(putBot(repoFile(), { id: ID.main, role: 'from Herdr' })))
    return putBot(r, { id: ID.dev, role: 'from DSH' })
  }, { kind: 'repo' })
  assert.equal(calls, 2)
  assert.equal(raw.bots[0].role, 'from Herdr')
  assert.equal(raw.bots[1].role, 'from DSH')
  // It gives up after `tries`.
  await assert.rejects(updateRegistry(path, r => {
    writeFileSync(path, text(putBot(JSON.parse(readFileSync(path, 'utf8')), { id: ID.main, name: newBotId() })))
    return r
  }, { kind: 'repo', tries: 3 }), { code: 'registry/stale' })
  // A file that does not parse is never written.
  writeFileSync(path, '{ broken')
  await assert.rejects(updateRegistry(path, r => r, { kind: 'repo' }), SyntaxError)
  assert.equal(readFileSync(path, 'utf8'), '{ broken')
})

test('the lock: a fresh one is waited for, then refused; another holder\'s is never removed', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  const start = text(repoFile())
  writeFileSync(path, start)
  // The CLI's lock: its pid and a token, made a moment ago.
  const cliToken = `99999 ${crypto.randomUUID()}`
  writeFileSync(`${path}.lock`, cliToken)
  const began = Date.now()
  await assert.rejects(writeRegistry(path, repoFile(), start, { kind: 'repo', wait: 150 }), { code: 'registry/locked' })
  assert.ok(Date.now() - began >= 150)
  assert.equal(readFileSync(path, 'utf8'), start)
  await dropLock(`${path}.lock`, 'not its token')
  assert.equal(readFileSync(`${path}.lock`, 'utf8'), cliToken)
})

test('the lock: a stale one (a writer killed mid-write) is taken over', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  const start = text(repoFile())
  writeFileSync(path, start)
  writeFileSync(`${path}.lock`, `99999 ${crypto.randomUUID()}`)
  const old = (Date.now() - 11_000) / 1000
  utimesSync(`${path}.lock`, old, old)
  const next = putBot(repoFile(), { id: ID.dev, name: 'Saved' })
  await writeRegistry(path, next, start, { kind: 'repo', wait: 500 })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).bots[1].name, 'Saved')
  assert.deepEqual(readdirSync(join(path, '..')), ['bots.json'])
})

test('the lock holds the CLI\'s format, and a holder drops only its own', async (t) => {
  const lock = join(tempDir(t), 'bots.json.lock')
  const token = await takeLock(lock)
  assert.match(token, new RegExp(`^${process.pid} [0-9a-f-]{36}$`))
  assert.equal(readFileSync(lock, 'utf8'), token)
  await assert.rejects(takeLock(lock, { wait: 50 }), { code: 'registry/locked' })
  await dropLock(lock, token)
  assert.equal(existsSync(lock), false)
})

test('a rename Windows refuses is retried, then not saved; the temporary file goes', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  const start = text(repoFile())
  writeFileSync(path, start)
  let refusals = 2
  const flaky = { ...fs, renameSync: (from, to) => {
    if (to === path && refusals-- > 0) throw Object.assign(new Error('busy'), { code: 'EPERM' })
    return fs.renameSync(from, to)
  } }
  await writeRegistry(path, putBot(repoFile(), { id: ID.dev, name: 'Late' }), start, { kind: 'repo', fs: flaky })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).bots[1].name, 'Late')
  const now = readFileSync(path, 'utf8')
  const stuck = { ...fs, renameSync: (from, to) => {
    if (to === path) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return fs.renameSync(from, to)
  } }
  await assert.rejects(writeRegistry(path, repoFile(), now, { kind: 'repo', fs: stuck }), { code: 'EBUSY' })
  assert.equal(readFileSync(path, 'utf8'), now)
  assert.deepEqual(readdirSync(join(path, '..')), ['bots.json'])
})

test('an invalid file is refused before anything is touched, naming the file, entry and field', async (t) => {
  const path = join(tempDir(t), 'bots.json')
  await assert.rejects(writeRegistry(path, { version: 2, bots: [{ id: 'unfold-root', name: 'U' }] }, null, { kind: 'home' }), {
    code: 'registry/invalid',
    message: `Not saved: ${path}: bots[0] (unfold-root): id is not b- plus 10 base32 characters or session-<uuid>`,
  })
  // A hand-written file with one bad entry: every write is refused, and says which entry.
  const handWritten = homeFile()
  handWritten.bots[1].name = ''
  writeFileSync(path, text(handWritten))
  await assert.rejects(updateRegistry(path, r => putBot(r, { id: ID.dsh, role: 'x' }), { kind: 'home' }), {
    code: 'registry/invalid',
    message: `Not saved: ${path}: bots[1] (${ID.main}): name is missing`,
  })
  rmSync(path)
  assert.equal(await readRegistryText(path), null)
  await assert.rejects(writeRegistry(path, emptyRegistry('home')), /pass the text the edit started from/)
})

test('putBot changes only the fields it names; dropBot removes one Bot', () => {
  const raw = repoFile()
  raw.bots[1].somethingNew = 1
  putBot(raw, { id: ID.dev, role: undefined, name: 'Dev 2' })
  assert.deepEqual(raw.bots[1], { id: ID.dev, name: 'Dev 2', instructions: '', agent: 'codex', lead: ID.main, category: 'core', somethingNew: 1 })
  putBot(raw, { id: ID.dsh, name: 'New' })
  assert.deepEqual(raw.bots.at(-1), { id: ID.dsh, name: 'New' })
  dropBot(raw, ID.dsh)
  assert.deepEqual(raw.bots.map(b => b.id), [ID.main, ID.dev])
  assert.throws(() => putBot(raw, { id: 'unfold-root' }), /not a Bot id/)
})

test('the module imports nothing, so it can be copied byte-equal into Herdr', () => {
  const source = readFileSync(new URL('../src/shared/registry.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\brequire\(/)
  const dynamic = [...source.matchAll(/import\(\s*(['"])([^'"]+)\1\s*\)/g)].map(m => m[2])
  assert.deepEqual(dynamic, ['node:fs'])
})

const fixture = name => readFileSync(new URL(`./fixtures/registry/${name}`, import.meta.url), 'utf8')

test('v1 reader: this repo\'s own .herdr/bots.json reads as a version 2 repo file', () => {
  const { file, warnings } = fromHerdrV1(fixture('herdr-v1-automagik.json'))
  assert.deepEqual(warnings, [])
  assert.equal(file.version, 2)
  assert.deepEqual(file.categories, [])
  assert.deepEqual(file.bots, [{
    id: 'b-xzrwondddr',
    name: 'Automagik Orchestrator',
    role: 'Orchestrates automagik (DSH desktop): non-coding work; leads bot-system unification with Herdr',
    instructions: '',
    agent: 'claude',
    look: { character: 'kitty', colour: 'yellow' },
    main: true,
    pet: { source: 'team', id: 'kitty-yellow' },
  }])
  assert.deepEqual(checkRegistry(file, { kind: 'repo' }), [])
})

test('v1 reader: a team keeps its seat and team fields; what v2 cannot use is left out', () => {
  const { file, warnings } = fromHerdrV1(fixture('herdr-v1-team.json'))
  assert.deepEqual(file.bots.map(b => b.id), ['b-aaaaaaaaaa', 'b-cccccccccc', 'b-dddddddddd', 'b-ffffffffff'])
  assert.deepEqual(file.categories, [{ id: 'core', title: 'Core', sub: 'the build' }])
  const [captain, dev, planned, badLook] = file.bots
  assert.equal(captain.main, true)
  assert.equal(captain.kind, undefined)
  assert.deepEqual([captain.agent, captain.model, captain.rank], ['claude', 'opus', 'captain'])
  assert.equal(dev.main, undefined)
  assert.deepEqual([dev.lead, dev.category, dev.rank], ['b-aaaaaaaaaa', 'core', 'dev'])
  assert.deepEqual(dev.worker, { agent: 'codex', effort: 'high', template: 'implementer' })
  assert.deepEqual(dev.someFutureField, { kept: true })
  assert.deepEqual(dev.pet, { source: 'team', id: 'star-green' })
  assert.deepEqual(planned.planned, { wave: 2 })
  assert.equal(badLook.pet, undefined)
  assert.equal(badLook.folder, undefined)
  assert.deepEqual(warnings, [
    'bots[3] (b-eeeeeeeeee): kind "helper" is not main or member; left out',
    'bots[4] (b-ffffffffff): pet id "../..-x" is not one path segment; ignored',
    'bots[4] (b-ffffffffff): folder is read from the home file only; ignored',
  ])
  assert.throws(() => fromHerdrV1(text({ version: 2, bots: [] })), /version 2, expected 1/)
})

test('state.json reader: DSH\'s Bots in the v2 shape, nothing private, pinned and odd ids kept home', () => {
  const state = fixture('state.json')
  const { bots, warnings } = fromDshState(state)
  assert.deepEqual(bots, [
    {
      id: ID.dsh,
      name: 'Omni',
      role: 'Main Bot',
      instructions: 'Answer on WhatsApp.',
      identity: 'omni',
      main: true,
      pet: { source: 'builtin', id: 'genie-clay', version: 1, sleep: true },
      dsh: { model: 'deepseek/deepseek-v4', effort: 'high', color: 'teal' },
    },
    {
      id: 'session-5e6f7a8b-1c2d-4e3f-9a0b-c1d2e3f4a5b6',
      name: 'Writer',
      role: '',
      instructions: '',
      folder: '/Users/me/notes',
    },
  ])
  assert.deepEqual(warnings, [
    "unfold-root: a host's pinned Session; stays in Automagik only",
    'host-chat: not b- or session-<uuid>; stays in Automagik only',
  ])
  const exported = JSON.stringify(bots)
  for (const secret of ['permission', 'capabilities', 'sessionId', 'memory', 'createdAt', 'data:image', 'never exported']) {
    assert.ok(!exported.includes(secret), secret)
  }
  assert.deepEqual(fromDshState(JSON.parse(state)).bots, bots)
  assert.deepEqual(checkRegistry({ ...emptyRegistry('home'), bots }, { kind: 'home' }), [])
  assert.throws(() => fromDshState('{}'), /no bots/)
  // A warning names the Bot by its key in state.json.
  const noName = JSON.parse(state)
  noName.bots[ID.dsh].name = ''
  assert.deepEqual(fromDshState(noName).warnings.at(-1), `bots.${ID.dsh}: name is missing; left out`)
})

test('the fields never in either file, and dash-led seat fields, stay in raw but out of file', () => {
  const raw = repoFile()
  Object.assign(raw.bots[1], {
    permission: 'full', capabilities: ['shell'], sessionId: 'session-x', memory: { a: 1 }, avatar: { image: 'data:' },
    agent: '-rf', model: '--dangerously-skip-permissions', worker: { agent: 'codex', template: '-x' },
  })
  raw.secrets = { token: 'x' }
  const parsed = parseRegistry(text(raw), { kind: 'repo' })
  const dev = parsed.file.bots[1]
  for (const key of ['permission', 'capabilities', 'sessionId', 'memory', 'avatar', 'agent', 'model', 'worker']) {
    assert.equal(Object.hasOwn(dev, key), false, key)
  }
  assert.equal(parsed.file.secrets, undefined)
  assert.equal(parsed.raw.bots[1].permission, 'full')
  assert.equal(parsed.raw.secrets.token, 'x')
  assert.ok(parsed.warnings.includes(`bots[1] (${ID.dev}): permission is never kept in bots.json; ignored`))
  assert.ok(parsed.warnings.includes(`bots[1] (${ID.dev}): agent starts with a dash; ignored`))
  assert.ok(parsed.warnings.includes(`bots[1] (${ID.dev}): worker template starts with a dash; ignored`))
  assert.ok(parsed.warnings.includes('secrets is never kept in bots.json; ignored'))
  // A write may not add them, in either file; one a hand-written file already had stays writable.
  const errors = checkRegistry(raw, { kind: 'repo', before: text(repoFile()) })
  for (const want of [
    `bots[1] (${ID.dev}): permission: never kept in bots.json`,
    `bots[1] (${ID.dev}): capabilities: never kept in bots.json`,
    `bots[1] (${ID.dev}): sessionId: never kept in bots.json`,
    `bots[1] (${ID.dev}): agent starts with a dash`,
    `bots[1] (${ID.dev}): model starts with a dash`,
    `bots[1] (${ID.dev}): worker template starts with a dash`,
    'secrets: never kept in bots.json',
  ]) assert.ok(errors.includes(want), want)
  const fixedSeats = structuredClone(raw)
  Object.assign(fixedSeats.bots[1], { agent: 'codex', worker: { agent: 'codex' } })
  delete fixedSeats.bots[1].model
  assert.deepEqual(checkRegistry(fixedSeats, { kind: 'repo', before: text(raw) }), [])
})

test('putBot skips __proto__, constructor and prototype keys', () => {
  const raw = repoFile()
  const patch = JSON.parse(`{ "id": "${ID.dev}", "name": "Safe", "__proto__": { "polluted": true }, "constructor": { "x": 1 }, "prototype": 2 }`)
  putBot(raw, patch)
  const dev = raw.bots[1]
  assert.equal(Object.getPrototypeOf(dev), Object.prototype)
  assert.equal(dev.polluted, undefined)
  assert.equal({}.polluted, undefined)
  assert.equal(Object.hasOwn(dev, 'constructor'), false)
  assert.equal(Object.hasOwn(dev, 'prototype'), false)
  assert.equal(dev.name, 'Safe')
  // A parsed file never carries one either.
  const own = text(repoFile()).replace(`"id": "${ID.dev}",`, `"id": "${ID.dev}", "__proto__": { "polluted": true },`)
  const { file } = parseRegistry(own, { kind: 'repo' })
  assert.equal(Object.hasOwn(file.bots[1], '__proto__'), false)
  assert.equal(Object.getPrototypeOf(file.bots[1]), Object.prototype)
})

test('identity is a lowercase slug, never a path', () => {
  for (const bad of ['../../etc', 'Omni', 'a/b', '-x', 'x'.repeat(65), ' ']) {
    const raw = homeFile()
    raw.bots[0].identity = bad
    const parsed = parseRegistry(text(raw), { kind: 'home' })
    assert.equal(parsed.file.bots[0].identity, undefined, bad)
    assert.ok(parsed.warnings.includes(`bots[0] (${ID.dsh}): identity is not a lowercase slug; ignored`), bad)
    assert.deepEqual(checkRegistry(raw, { kind: 'home' }), [`bots[0] (${ID.dsh}): identity is not a lowercase slug`], bad)
  }
  for (const good of ['omni', 'genie', 'my-own-2']) {
    const raw = homeFile()
    raw.bots[0].identity = good
    assert.deepEqual(checkRegistry(raw, { kind: 'home' }), [], good)
  }
})

test('size limits: the file, the name, the role and the instructions', async (t) => {
  const raw = repoFile()
  raw.bots[0].instructions = 'x'.repeat(4001)
  raw.bots[1].role = 'r'.repeat(1001)
  raw.bots.push({ id: 'b-longnamexx', name: 'n'.repeat(201) })
  const parsed = parseRegistry(text(raw), { kind: 'repo' })
  // Herdr v1's 4000: read with a warning (DSH sets no limit, so a write keeps them).
  assert.equal(parsed.file.bots[0].instructions.length, 4001)
  assert.ok(parsed.warnings.includes(`bots[0] (${ID.main}): instructions longer than 4000 characters`))
  assert.equal(parsed.file.bots[1].role, '')
  assert.ok(parsed.warnings.includes(`bots[1] (${ID.dev}): role is longer than 1000 characters; ignored`))
  assert.deepEqual(parsed.file.bots.map(b => b.id), [ID.main, ID.dev])
  assert.deepEqual(checkRegistry(raw, { kind: 'repo' }).sort(), [
    `bots[1] (${ID.dev}): role is longer than 1000 characters`,
    'bots[2] (b-longnamexx): name is longer than 200 characters',
  ])
  const huge = repoFile()
  huge.bots[0].instructions = 'x'.repeat(100_001)
  assert.deepEqual(checkRegistry(huge, { kind: 'repo' }), [`bots[0] (${ID.main}): instructions is longer than 100000 characters`])
  // The whole file: not read, not written.
  const big = repoFile()
  big.padding = 'p'.repeat(MAX_FILE_BYTES)
  assert.throws(() => parseRegistry(text(big), { kind: 'repo' }), /larger than 1048576 bytes/)
  const path = join(tempDir(t), 'bots.json')
  await assert.rejects(writeRegistry(path, big, null, { kind: 'repo' }), { code: 'registry/invalid', message: /larger than 1048576 bytes/ })
  assert.equal(existsSync(path), false)
})

test('v1 reader: a Bot with no look gets Herdr\'s default look, and its pet', () => {
  // Herdr's own model.js defaultLook gives these (checked against it on 5000 ids).
  assert.deepEqual(defaultLook('b-aaaaaaaaaa'), { character: 'peanut', colour: 'blue' })
  assert.deepEqual(defaultLook('b-cccccccccc'), { character: 'acorn', colour: 'orange' })
  assert.deepEqual(defaultLook('b-xzrwondddr'), { character: 'kitty', colour: 'yellow' })
  const v1 = JSON.parse(fixture('herdr-v1-automagik.json'))
  delete v1.bots[0].look
  v1.bots.push({ id: 'b-cccccccccc', kind: 'member', name: 'Dev', agent: 'claude', look: 'star' })
  const { file, warnings } = fromHerdrV1(JSON.stringify(v1))
  assert.deepEqual(file.bots.map(b => [b.look, b.pet]), [
    [{ character: 'kitty', colour: 'yellow' }, { source: 'team', id: 'kitty-yellow' }],
    [{ character: 'acorn', colour: 'orange' }, { source: 'team', id: 'acorn-orange' }],
  ])
  assert.deepEqual(warnings, [
    'bots[0] (b-xzrwondddr): no look, the default is used',
    'bots[1] (b-cccccccccc): no look, the default is used',
  ])
})

test('parse: permissionAuto is never imported from bots.json', () => {
  const raw = repoFile()
  raw.bots[0].permissionAuto = 'acp-codex'
  const parsed = parseRegistry(text(raw), { kind: 'repo' })
  assert.equal(parsed.file.bots[0].permissionAuto, undefined)
  assert.match(JSON.stringify(parsed.warnings), /permissionAuto/)
})


test('the registry accepts optional herdr type; absent type remains native despite seat fields', () => {
  for (const kind of ['home', 'repo']) {
    const raw = { version: 2, bots: [{ id: ID.main, name: 'Typed', main: true, type: 'herdr' }, { id: ID.dev, name: 'Native', agent: 'codex', model: 'acp-codex/default' }] }
    assert.deepEqual(checkRegistry(raw, { kind }), [])
    const { file, warnings } = parseRegistry(JSON.stringify(raw), { kind })
    assert.equal(file.bots[0].type, 'herdr')
    assert.equal(Object.hasOwn(file.bots[1], 'type'), false, 'absent type must remain native')
    assert.deepEqual(warnings, [])
  }
})

test('the registry validator refuses unknown type values', () => {
  for (const type of ['native', 'unknown', '', null, 1, {}, ['herdr']]) {
    const raw = { version: 2, bots: [{ id: ID.main, name: 'Bad', main: true, type }] }
    assert.match(checkRegistry(raw, { kind: 'home' }).join(';'), /unknown type/)
  }
})

test('the registry parser leaves out unknown types with a warning and preserves raw', () => {
  for (const type of ['native', 'unknown', '', 1, {}, ['herdr']]) {
    const raw = { version: 2, bots: [{ id: ID.main, name: 'Bad', type }] }
    const parsed = parseRegistry(JSON.stringify(raw), { kind: 'home' })
    assert.equal(parsed.file.bots.length, 0, 'unknown type must not reach the app')
    assert.match(parsed.warnings.join(';'), /unknown type.*left out/)
    assert.deepEqual(parsed.raw, raw)
  }
})


test('the registry parser treats explicit null type as absent', () => {
  const parsed = parseRegistry(JSON.stringify({ version: 2, bots: [{ id: ID.main, name: 'Native', type: null, agent: 'codex' }] }), { kind: 'home' })
  assert.equal(Object.hasOwn(parsed.file.bots[0], 'type'), false)
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.raw.bots[0].type, null)
})

test('a Herdr registry Bot refuses an unknown terminal agent on save', () => {
  const raw = { version: 2, bots: [{ id: ID.main, name: 'Bad', type: 'herdr', agent: 'unknown' }] }
  assert.match(checkRegistry(raw, { kind: 'home' }).join(';'), /unknown terminal agent/)
})

test('a Herdr registry Bot refuses an unknown terminal agent on parse', () => {
  const raw = { version: 2, bots: [{ id: ID.main, name: 'Bad', type: 'herdr', agent: 'unknown' }] }
  const parsed = parseRegistry(JSON.stringify(raw), { kind: 'home' })
  assert.deepEqual(parsed.file.bots, [])
  assert.match(parsed.warnings.join(';'), /unknown terminal agent/)
})


test('the client seat agent catalog agrees with the self-contained registry', () => {
  assert.deepEqual(CLIENT_SEAT_AGENTS, SEAT_AGENTS)
})
