// RFC 0014's seed: one project's Herdr v1 roster becomes the two version 2 registry files.
//
// With temp folders only (never a real home): an empty home is filled, an identical re-run
// writes nothing, a conflicting file is refused instead of overwritten, a roster with fields
// version 2 cannot use keeps what it can, no Bot id is minted, and neither stored file carries
// a Session id, Session list or segment at any depth.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { SeedError, defaultHome, formatSeedReport, scrubSessions, seedRegistry } from '../src/host/registry-seed.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'scripts', 'seed-registry.mjs')
const ROSTER = join('.herdr', 'bots.json')
const REPO = join('.automagik', 'bots', 'bots.json')
const HOME = join('bots', 'bots.json')
const ID = { main: 'b-mainmain22', dev: 'b-devdevdev3', other: 'b-otherbot23' }
const SESSION_KEYS = ['sessionId', 'sessions', 'segments']

const fixture = name => readFileSync(new URL(`./fixtures/registry/${name}`, import.meta.url), 'utf8')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFileSync(path, 'utf8')
const json = path => JSON.parse(read(path))

/** A temp project with a v1 roster (text or object) and a temp Automagik home. */
function layout(t, roster, { withRoster = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-seed-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  const project = join(root, 'project')
  mkdirSync(join(project, '.herdr'), { recursive: true })
  if (withRoster) writeFileSync(join(project, ROSTER), typeof roster === 'string' ? roster : `${JSON.stringify(roster, null, 2)}\n`)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return { root, project, home }
}

const v1 = bots => ({ version: 1, categories: [{ id: 'core', title: 'Core' }], bots })

/** Walks a parsed value and returns every key named in `wanted`, at any depth, with its path. */
function keysNamed(value, wanted, path = '', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => keysNamed(item, wanted, `${path}[${index}]`, found))
    return found
  }
  if (value === null || typeof value !== 'object') return found
  for (const [key, item] of Object.entries(value)) {
    const at = path === '' ? key : `${path}.${key}`
    if (wanted.includes(key)) found.push(at)
    keysNamed(item, wanted, at, found)
  }
  return found
}

test('an empty home gets both version 2 files, the project entry and its one main seat', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const result = await seedRegistry({ project, home })
  const repoPath = join(project, REPO)
  const homePath = join(home, HOME)

  assert.equal(result.repo.action, 'created')
  assert.equal(result.home.action, 'created')
  assert.ok(existsSync(repoPath))
  assert.ok(existsSync(homePath))

  const repo = json(repoPath)
  const seat = json(homePath)
  assert.equal(repo.version, 2)
  assert.deepEqual(repo.bots.map(bot => bot.id), ['b-aaaaaaaaaa', 'b-cccccccccc', 'b-dddddddddd', 'b-ffffffffff'])
  assert.deepEqual(repo.bots.filter(bot => bot.main === true).map(bot => bot.id), ['b-aaaaaaaaaa'])
  assert.deepEqual(repo.categories, [{ id: 'core', title: 'Core', sub: 'the build' }])
  assert.equal(seat.version, 2)
  assert.deepEqual(seat.projects, [{ folder: project }])
  assert.equal(seat.bots.length, 1)
  assert.equal(seat.bots[0].id, 'b-aaaaaaaaaa')
  assert.equal(seat.bots[0].folder, project)
  assert.equal(seat.bots[0].main, true)
  assert.deepEqual(seat.shown, [])

  // The report reads both files back: counts, warnings and the exact bytes' hashes.
  assert.equal(result.repo.bots, 4)
  assert.equal(result.repo.mains, 1)
  assert.equal(result.home.bots, 1)
  assert.equal(result.home.projects, 1)
  assert.equal(result.repo.sha256, sha256(readFileSync(repoPath)))
  assert.equal(result.home.sha256, sha256(readFileSync(homePath)))
  const report = formatSeedReport(result)
  assert.match(report, /seed-registry: source .* \(5 Bots, 1 main Bot, 3 warnings\)/)
  assert.match(report, /seed-registry: home .* created \(1 Bot, 1 project, 0 warnings, sha256 [0-9a-f]{64}\)/)
  assert.match(report, /seed-registry: repo .* created \(4 Bots, 1 main Bot, 0 warnings, sha256 [0-9a-f]{64}\)/)
  assert.ok(report.includes(`sha256 ${sha256(readFileSync(repoPath))}`))
})

test('an identical re-run is a no-op: no byte changes and no file touched', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const first = await seedRegistry({ project, home })
  const repoPath = join(project, REPO)
  const homePath = join(home, HOME)
  const repoBytes = readFileSync(repoPath)
  const homeBytes = readFileSync(homePath)
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(repoPath, old, old)
  utimesSync(homePath, old, old)

  const second = await seedRegistry({ project, home })
  assert.equal(second.repo.action, 'unchanged')
  assert.equal(second.home.action, 'unchanged')
  assert.deepEqual(readFileSync(repoPath), repoBytes)
  assert.deepEqual(readFileSync(homePath), homeBytes)
  assert.equal(second.repo.sha256, first.repo.sha256)
  assert.equal(second.home.sha256, first.home.sha256)
  assert.equal(statSync(repoPath).mtimeMs, old.getTime())
  assert.equal(statSync(homePath).mtimeMs, old.getTime())
})

test('a conflicting repo file is refused before either file is written, and is never overwritten', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const repoPath = join(project, REPO)
  mkdirSync(dirname(repoPath), { recursive: true })
  const other = `${JSON.stringify({ version: 2, bots: [{ id: ID.other, name: 'Other', main: true }] }, null, 2)}\n`
  writeFileSync(repoPath, other)

  await assert.rejects(seedRegistry({ project, home }), (error) => {
    assert.ok(error instanceof SeedError)
    assert.equal(error.code, 'seed/conflict')
    assert.match(error.message, /already holds a different project roster/)
    assert.match(error.message, /Nothing was written and nothing was overwritten/)
    return true
  })
  assert.equal(read(repoPath), other)
  assert.equal(existsSync(join(home, HOME)), false, 'the home file is not written when the repo file conflicts')
})

test('an existing repo file with Session data is refused, not rewritten', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const repoPath = join(project, REPO)
  mkdirSync(dirname(repoPath), { recursive: true })
  const withSessions = `${JSON.stringify({
    version: 2,
    bots: [{ id: ID.other, name: 'Other', main: true }],
    unknownTop: { sessionId: 'x', keep: true },
  }, null, 2)}\n`
  writeFileSync(repoPath, withSessions)
  await assert.rejects(seedRegistry({ project, home }), (error) => {
    assert.equal(error.code, 'seed/conflict')
    assert.match(error.message, /holds 1 Session key \(unknownTop\.sessionId\)/)
    return true
  })
  assert.equal(read(repoPath), withSessions)
})

test('a conflicting home file is refused before the repo file is written, and is never overwritten', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const homePath = join(home, HOME)
  mkdirSync(dirname(homePath), { recursive: true })
  const other = `${JSON.stringify({
    version: 2,
    projects: [{ folder: project }],
    bots: [{ id: ID.other, name: 'Other main', folder: project, main: true }],
    shown: [],
  }, null, 2)}\n`
  writeFileSync(homePath, other)

  await assert.rejects(seedRegistry({ project, home }), (error) => {
    assert.equal(error.code, 'seed/conflict')
    assert.match(error.message, /already names .* as this project's main Bot/)
    return true
  })
  assert.equal(read(homePath), other)
  assert.equal(existsSync(join(project, REPO)), false, 'the repo file is not written when the home file conflicts')
})

test('a v1 with odd fields keeps what version 2 can hold and writes no Session key anywhere', async (t) => {
  const odd = {
    version: 1,
    name: 'Odd project',
    categories: [{ id: 'core', title: 'Core', nested: { kept: true } }],
    sessions: [{ id: 'top' }],
    sessionId: 'top-level',
    segments: [],
    unknownTop: { kept: { answer: 42 }, sessionId: 'x', sessions: [{}], segments: [] },
    bots: [
      {
        id: ID.main, kind: 'main', name: 'Captain', role: 'leads', instructions: 'Keep the plan.',
        agent: 'claude', model: 'opus', rank: 'captain',
        look: { character: 'octopus', colour: 'blue' },
        someFutureField: { kept: true },
        agyPermissions: { allow: ['read'], deny: [], sessionId: 'x' },
        dsh: { model: 'a-model', sessionId: 'x', sessions: [], segments: [] },
      },
      {
        id: ID.dev, kind: 'member', name: 'Dev', role: 'builds', instructions: '',
        agent: 'codex', lead: ID.main, worker: { agent: 'codex', effort: 'high', template: 'implementer', sessions: [] },
        planned: { wave: 2, sessionId: 'x' }, look: { character: 'star', colour: 'green' },
      },
      { id: 'b-eeeeeeeeee', kind: 'helper', name: 'Unknown kind', agent: 'claude' },
      {
        id: 'b-ffffffffff', kind: 'member', name: 'Bad look', agent: 'claude',
        look: { character: '../..', colour: 'x' }, folder: '/etc', dsh: { sessionId: 'x' }, sessions: [],
      },
    ],
  }
  const { project, home } = layout(t, odd)
  const result = await seedRegistry({ project, home })
  const repoPath = join(project, REPO)
  const homePath = join(home, HOME)
  const repo = json(repoPath)
  const seat = json(homePath)

  assert.deepEqual(repo.bots.map(bot => bot.id), [ID.main, ID.dev, 'b-ffffffffff'])
  assert.deepEqual(repo.bots.filter(bot => bot.main === true).map(bot => bot.id), [ID.main])
  assert.deepEqual(repo.categories, [{ id: 'core', title: 'Core', nested: { kept: true } }])
  assert.equal(repo.name, 'Odd project')
  assert.deepEqual(repo.unknownTop.kept, { answer: 42 })
  assert.deepEqual(repo.bots[0].someFutureField, { kept: true })
  assert.deepEqual(repo.bots[0].agyPermissions, { allow: ['read'], deny: [] })
  assert.deepEqual(repo.bots[1].planned, { wave: 2 })
  assert.deepEqual(repo.bots[1].worker, { agent: 'codex', effort: 'high', template: 'implementer' })
  assert.equal(repo.bots[0].look.character, 'octopus')
  assert.deepEqual(repo.bots[0].pet, { source: 'team', id: 'octopus-blue' })
  // A home-only field on a repo Bot, and the invalid look, are left out with a warning.
  assert.equal(repo.bots[2].folder, undefined)
  assert.equal(repo.bots[2].pet, undefined, 'an unusable look leaves no pet behind')
  assert.equal(seat.bots[0].id, ID.main)
  assert.equal(seat.bots[0].folder, project)
  assert.equal(seat.bots[0].dsh, undefined)
  assert.ok(result.source.warnings.some(warning => /kind "helper" is not main or member/.test(warning)))
  assert.ok(result.source.warnings.some(warning => /folder is read from the home file only/.test(warning)))
  assert.ok(result.source.warnings.some(warning => /sessionId is never kept in bots.json; removed/.test(warning)))

  // The post-write check the issue asks for: the stored bytes carry no Session key, at any
  // depth, and neither does what the parser reads back.
  for (const path of [repoPath, homePath]) {
    const bytes = read(path)
    for (const key of SESSION_KEYS) {
      assert.equal(bytes.includes(`"${key}"`), false, `${path} stores ${key}`)
      assert.deepEqual(keysNamed(JSON.parse(bytes), [key]), [], `${path} nests ${key}`)
    }
  }
})

test('no Bot id is minted: no roster is refused, and a copied roster keeps its ids', async (t) => {
  const empty = layout(t, '', { withRoster: false })
  await assert.rejects(seedRegistry({ project: empty.project, home: empty.home }), (error) => {
    assert.equal(error.code, 'seed/no-roster')
    assert.match(error.message, /mints no Bot ids/)
    return true
  })
  assert.equal(existsSync(join(empty.project, '.automagik')), false)
  assert.equal(existsSync(join(empty.home, HOME)), false)

  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const result = await seedRegistry({ project, home })
  const source = JSON.parse(fixture('herdr-v1-team.json'))
  const usable = source.bots.filter(bot => ['b-aaaaaaaaaa', 'b-cccccccccc', 'b-dddddddddd', 'b-ffffffffff'].includes(bot.id)).map(bot => bot.id)
  assert.deepEqual(json(join(project, REPO)).bots.map(bot => bot.id), usable)
  assert.deepEqual(json(join(home, HOME)).bots.map(bot => bot.id), ['b-aaaaaaaaaa'])
  assert.equal(result.repo.bots, usable.length, 'every stored Bot came from the roster')
})

test('a roster without exactly one main is refused, and nothing is written', async (t) => {
  const two = layout(t, v1([
    { id: ID.main, kind: 'main', name: 'One' },
    { id: ID.other, kind: 'main', name: 'Two' },
  ]))
  await assert.rejects(seedRegistry({ project: two.project, home: two.home }), error => error.code === 'seed/main' && /2 main Bots/.test(error.message))
  assert.equal(existsSync(join(two.project, REPO)), false)

  const none = layout(t, v1([{ id: ID.dev, kind: 'member', name: 'Only a member' }]))
  await assert.rejects(seedRegistry({ project: none.project, home: none.home }), error => error.code === 'seed/main' && /0 main Bots/.test(error.message))
  assert.equal(existsSync(join(none.home, HOME)), false)
})

test('a shared home keeps another project and its picks, and adds only this project', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const homePath = join(home, HOME)
  const other = {
    version: 2,
    projects: [{ folder: '/srv/other', machine: 'elsewhere' }],
    bots: [{ id: ID.other, name: 'Other main', folder: '/srv/other', machine: 'elsewhere', main: true }],
    shown: [{ project: null, bots: [ID.other] }],
    unknownTop: { kept: true, sessions: [] },
  }
  mkdirSync(dirname(homePath), { recursive: true })
  writeFileSync(homePath, `${JSON.stringify(other, null, 2)}\n`)

  const result = await seedRegistry({ project, home })
  const merged = json(homePath)
  assert.equal(result.home.action, 'updated')
  assert.deepEqual(merged.bots.find(bot => bot.id === ID.other), other.bots[0])
  assert.deepEqual(merged.projects[0], { folder: '/srv/other', machine: 'elsewhere' })
  assert.deepEqual(merged.projects[1], { folder: project })
  assert.deepEqual(merged.shown, other.shown)
  assert.deepEqual(merged.unknownTop.kept, true)
  assert.deepEqual(keysNamed(merged, SESSION_KEYS), [])
  assert.equal(merged.bots.filter(bot => bot.folder === project).length, 1)
  assert.deepEqual(json(join(project, REPO)).bots.map(bot => bot.id), ['b-aaaaaaaaaa', 'b-cccccccccc', 'b-dddddddddd', 'b-ffffffffff'])
})

test('the command runs with the same report and exits 0, 1 on a conflict and 2 on bad usage', async (t) => {
  const { project, home } = layout(t, fixture('herdr-v1-team.json'))
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const first = run('--project', project, '--home', home)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /seed-registry: home .* created \(1 Bot, 1 project/)
  assert.match(first.stdout, /seed-registry: repo .* created \(4 Bots, 1 main Bot/)
  assert.match(first.stdout, /sha256 [0-9a-f]{64}/)

  const again = run('--project', project, '--home', home)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /seed-registry: home .* unchanged/)
  assert.match(again.stdout, /seed-registry: repo .* unchanged/)

  mkdirSync(dirname(join(project, 'nope', ROSTER)), { recursive: true })
  const missing = run('--project', join(project, 'nope'), '--home', home)
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /No version 1 roster/)

  const usage = run('--bogus')
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /unknown argument --bogus/)
  assert.match(usage.stderr, /Usage: node seed-registry\.mjs/)

  const help = run('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^Seed the shared version 2 Bot registry/)
})

test('helpers stay small and explicit: scrub paths, default home and error codes', () => {
  const value = { keep: 1, sessions: [], nested: { sessionId: 'x', segments: [], keep: { sessions: [] } } }
  const removed = []
  scrubSessions(value, '', removed)
  assert.deepEqual(value, { keep: 1, nested: { keep: {} } })
  assert.deepEqual(removed, ['sessions', 'nested.sessionId', 'nested.segments', 'nested.keep.sessions'])
  const previous = process.env.AUTOMAGIK_HOME
  process.env.AUTOMAGIK_HOME = '/tmp/some-automagik-home'
  try {
    assert.equal(defaultHome(), '/tmp/some-automagik-home')
    assert.equal(defaultHome({ AUTOMAGIK_HOME: '~/registry' }), join(homedir(), 'registry'))
  } finally {
    if (previous === undefined) delete process.env.AUTOMAGIK_HOME
    else process.env.AUTOMAGIK_HOME = previous
  }
})
