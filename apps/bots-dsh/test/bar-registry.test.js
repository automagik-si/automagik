import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs, { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { attachPath } from '../src/shared/attach-record.js'
import { MAX_PROJECTS, MAX_REGISTRY_BYTES } from '../src/host/code-tree.js'
import { dirname, join } from 'node:path'
import { readAttachLedger, readBarRegistry } from '../src/host/bar-registry.js'
import { checkRegistry, HOME_PATH, parseRegistry, REPO_PATH } from '../src/shared/registry.js'

const ONE = 'b-aaaaaaaaaa'
const TWO = 'b-bbbbbbbbbb'
const THREE = 'b-cccccccccc'
const FOUR = 'b-dddddddddd'
const FIVE = 'b-eeeeeeeeee'
const HOME = '/automagik'
const P = '/repo/alpha'
const Q = '/repo/beta'
const R = '/repo/other'
const homePath = join(HOME, HOME_PATH)
const repo = (bots, fields = {}) => ({ version: 2, bots, ...fields })
const row = (id, fields = {}) => ({ id, name: id, ...fields })

function snapshot(home, repos) {
  const files = new Map([[homePath, home], ...repos.map(([folder, data]) => [join(folder, REPO_PATH), data])])
  const reads = []
  const warnings = []
  const readFile = path => {
    reads.push(path)
    if (!files.has(path)) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' })
    return JSON.stringify(files.get(path))
  }
  const warn = message => warnings.push(message)
  return { files, reads, warnings, readFile, warn, read: () => readBarRegistry({ homePath, readFile, warn }) }
}

test('front is accepted only in the home registry and requires a valid placement and Bot id', () => {
  const front = { project: P, bot: ONE, machine: 'box' }
  const registry = repo([row(ONE, { main: true })], { front })
  const parsed = kind => parseRegistry(JSON.stringify(registry), { kind })
  assert.deepEqual(parsed('home').file.front, front)
  assert.equal(parsed('repo').file.front, undefined)
  assert.match(parsed('repo').warnings.join('\n'), /front is read from the home file only/)
  assert.match(checkRegistry(registry, { kind: 'repo' }).join('\n'), /front: only the home file holds it/)
  for (const bad of [{ project: 'relative', bot: ONE }, { project: null, bot: 'bad' }, { bot: ONE }, { ...front, machine: 42 }]) {
    const data = { ...registry, front: bad }
    const { file, warnings } = parseRegistry(JSON.stringify(data), { kind: 'home' })
    assert.equal(file.front, undefined)
    assert.match(warnings.join('\n'), /front: .*; left out/)
    assert.match(checkRegistry(data, { kind: 'home' }).join('\n'), /front:/)
  }
})

test('a local pick grants only the named Bots, repo identity wins, and a remote pick never reads its repo', () => {
  const front = { project: Q, machine: 'box', bot: FOUR }
  const f = snapshot(repo([
    row(THREE), row(ONE, { folder: P, name: 'Old Name', main: true }),
    row(FOUR, { folder: Q, machine: 'box', main: true }),
    row('session-12345678-1234-1234-1234-123456789abc'),
  ], {
    shown: [{ project: P + '/.', bots: [ONE] }, { project: Q, machine: 'box', bots: [FOUR] }],
    projects: [{ folder: Q, machine: 'box', name: 'Box Project' }, { folder: R }],
    front,
  }), [
    [P, repo([row(ONE, { name: 'New Name', main: true, role: 'lead', agent: 'codex' }), row(TWO)], { name: 'Alpha Project' })],
    [Q, repo([row(FOUR, { main: true })])],
    [R, repo([row(FIVE, { main: true })])],
  ])
  const found = f.read()
  assert.deepEqual(found.bots.map(bot => [bot.id, bot.name, bot.role, bot.agent]), [
    [THREE, THREE, '', undefined], [ONE, 'New Name', 'lead', 'codex'],
  ])
  assert.deepEqual(found.projects, [{ folder: P }])
  assert.equal(found.projectNames[P], 'Alpha Project')
  assert.deepEqual(found.remote.map(bot => [bot.key, bot.project, bot.main]), [[FOUR + '@box', 'Box Project', true]])
  assert.deepEqual(found.front, front)
  assert.deepEqual(f.reads, [homePath, join(P, REPO_PATH)])

})

test('repo rows cannot revive duplicate, invalid, relative or ambiguously placed home Bots', () => {
  const dropped = 'b-ffffffffff'
  const f = snapshot(repo([
    row(ONE, { folder: 42 }), row(TWO), row(TWO, { name: 'Duplicate' }), row(TWO),
    row(THREE), row(FOUR, { folder: Q }), row(FIVE, { folder: 'relative' }), row(dropped, { name: '' }),
  ], {
    shown: [{ project: P, bots: [ONE, TWO, FOUR, FIVE, dropped] }],
  }), [[P, repo([row(ONE, { main: true }), row(TWO), row(FOUR), row(FIVE), row(dropped)])]])
  assert.deepEqual(f.read().bots.map(bot => bot.id), [THREE])
  assert.equal(f.warnings.filter(message => message.includes(TWO)).length, 1)
})

test('an unpicked repo row in another shown checkout makes the Team seat ambiguous', () => {
  const f = snapshot(repo([], { shown: [{ project: P, bots: [ONE] }, { project: Q, bots: [] }] }), [
    [P, repo([row(ONE, { main: true })])], [Q, repo([row(ONE, { main: true })])],
  ])
  assert.deepEqual(f.read().bots, [])
  assert.deepEqual(f.reads, [homePath, join(P, REPO_PATH), join(Q, REPO_PATH)])
})

test('Team keeps globals and refuses project seats when an ambiguous checkout is the 201st shown folder', () => {
  const folders = Array.from({ length: 201 }, (_, index) => `/repo/project-${index + 1}`)
  const first = folders[0]
  const last = folders.at(-1)
  assert.equal(folders.length, MAX_PROJECTS + 1)
  const f = snapshot(repo([row(TWO)], {
    shown: folders.map(project => ({ project, bots: project === first ? [ONE] : [] })),
  }), [[first, repo([row(ONE)])], [last, repo([row(ONE)])]])
  const found = f.read()
  assert.deepEqual(found.bots.map(bot => bot.id), [TWO])
  assert.equal(found.roots.size, 201)
  assert.ok(f.reads.length <= MAX_PROJECTS + 1, 'repo reads remain bounded')
})

test('the Team repo owns its main flag and its name precedes the home and basename fallbacks', () => {
  const home = repo([row(ONE, { folder: P, name: 'ZZ', main: true })], {
    shown: [{ project: P, bots: [ONE, TWO, FOUR] }],
    projects: [{ folder: P, name: 'Home Project' }],
  })
  const f = snapshot(home, [[P, repo([row(THREE, { main: true }), row(TWO, { name: 'A' }), row(FOUR, { name: 'Z' })], { name: 'Alpha Project' })]])
  let team = f.read()
  assert.equal(team.projectNames[P], 'Alpha Project')
  assert.deepEqual(team.bots.map(bot => [bot.id, bot.main === true]), [[ONE, false], [TWO, false], [FOUR, false]])

  f.files.set(join(P, REPO_PATH), repo([row(TWO, { main: true })]))
  team = f.read()
  assert.equal(team.projectNames[P], 'Home Project')
  assert.deepEqual(team.bots.map(bot => [bot.id, bot.main]), [[ONE, false], [TWO, true]])

  f.files.delete(join(P, REPO_PATH))
  assert.equal(f.read().bots[0].main, true)
  home.projects = []
  assert.equal(f.read().projectNames[P], 'alpha')
})

test('a local repo Bot and its remote namesake have distinct placement keys', () => {
  const f = snapshot(repo([row(ONE, { folder: P, machine: 'box', main: true })], {
    shown: [{ project: P, bots: [ONE] }, { project: P, machine: 'box', bots: [ONE] }],
  }), [[P, repo([row(ONE, { name: 'Local', main: true })])]])
  const { bots, remote } = f.read()
  assert.deepEqual([...bots, ...remote].map(bot => bot.key), [ONE, ONE + '@box'])
})

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'team-registry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('the descriptor read refuses an oversized Team registry', (t) => {
  const path = join(scratch(t), 'bots.json')
  writeFileSync(path, JSON.stringify(repo([row(ONE)])))
  writeFileSync(path, ' '.repeat(MAX_REGISTRY_BYTES + 1), { flag: 'a' })
  const warnings = []
  const unbounded = t.mock.method(fs, 'readFileSync', fs.readFileSync)
  const dataReads = t.mock.method(fs, 'readSync', fs.readSync)
  syncBuiltinESMExports()
  t.after(() => { unbounded.mock.restore(); dataReads.mock.restore(); syncBuiltinESMExports() })
  assert.deepEqual(readBarRegistry({ homePath: path, warn: message => warnings.push(message) }).bots, [])
  assert.match(warnings.join('\n'), /could not be read/)
  assert.equal(unbounded.mock.calls.filter(call => call.arguments[0] === path).length, 0)
  assert.equal(dataReads.mock.callCount(), 0)
})

test('the attach ledger verifies owner and mode on cache hits and refuses links', (t) => {
  const appHome = scratch(t)
  const path = attachPath(appHome)
  mkdirSync(dirname(path), { recursive: true })
  const warnings = []
  const read = getuid => readAttachLedger({ appHome, getuid, warn: message => warnings.push(message) })
  assert.deepEqual(read().rows, [], 'a missing ledger is trusted and empty')
  writeFileSync(path, '', { mode: 0o600 })
  assert.equal(read().trusted, true)
  if (process.getuid) assert.equal(read(() => process.getuid() + 1).trusted, false)
  assert.equal(read().trusted, true, 'the real owner can warm the cache again')
  chmodSync(path, 0o666)
  assert.equal(read().trusted, false, 'a warmed writable ledger is refused')
  rmSync(path)
  const target = join(appHome, 'target')
  writeFileSync(target, '', { mode: 0o600 })
  symlinkSync(target, path)
  assert.equal(read().trusted, false, 'even a link to a trusted file is refused')
  assert.equal(warnings.length, process.getuid ? 3 : 2)
})
