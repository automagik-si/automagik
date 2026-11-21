import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { buildCodeTree, readRegistryTree } from '../../bots-dsh/src/host/code-tree.js'
import { codeRowPlace } from '../src/herdr-space.js'
import { HOME_PATH, MAX_FILE_BYTES, REPO_PATH } from '../src/registry.js'

test('the desktop registry is a byte copy of the shared registry', () => {
  const desktop = readFileSync(new URL('../src/registry.js', import.meta.url))
  const shared = readFileSync(new URL('../../bots-dsh/src/shared/registry.js', import.meta.url))
  assert.deepEqual(desktop, shared)
})

const base32 = 'abcdefghijklmnopqrstuvwxyz234567'
const id = n => `b-aaaaaaaa${base32[Math.floor(n / 32)]}${base32[n % 32]}`
const bot = (n, fields) => ({ id: id(n), name: `Bot ${n}`, ...fields })
const grant = project => ({ project, bots: [] })

function writeRegistry(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ version: 2, bots: [], ...data }))
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-registry-parity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registryRoot = join(root, 'registry')
  const homeFile = join(registryRoot, HOME_PATH)
  const project = name => {
    const folder = join(root, name)
    mkdirSync(folder)
    return folder
  }
  return { registryRoot, homeFile, project }
}

async function assertParity(registryRoot, expected, allIds) {
  const registry = readRegistryTree({ env: { AUTOMAGIK_HOME: registryRoot } })
  const tree = buildCodeTree({
    ...registry, attach: { fold: { byBot: new Map() } }, workers: new Map(), terminals: new Map(),
    core: { id: 'test-core', name: 'test' },
  })
  const listed = new Map(tree.projects.flatMap(({ folder, bots }) => bots.map(({ id }) => [id, folder])))
  assert.deepEqual(listed, expected)
  for (const [id, folder] of listed) {
    assert.deepEqual(await codeRowPlace(id, { registryRoot }), folder === null ? { folder: null } : { folder, machine: null }, id)
  }
  for (const id of allIds) {
    if (!listed.has(id)) assert.equal(await codeRowPlace(id, { registryRoot }), null, id)
  }
}

test('Code row lookup matches the Code tree grants, folder order and id reservations', async t => {
  const { registryRoot, homeFile, project } = fixture(t)
  const first = project('z-first')
  const second = project('a-second')
  const fromHomeBot = project('bot-only-project')
  const unshown = project('unshown')
  const malformed = project('malformed-grant')
  const remote = project('remote-only')
  const firstUnresolved = `${first}/../z-first/`
  writeRegistry(homeFile, {
    projects: [{ folder: firstUnresolved }, { folder: second }, { folder: unshown }, { folder: malformed }, { folder: remote, machine: 'box' }],
    shown: [grant(first), grant(second), grant(fromHomeBot), { project: malformed, bots: 'invalid' }, { ...grant(remote), machine: 'box' }],
    bots: [
      bot(1, { folder: firstUnresolved }), bot(2, { folder: unshown }), bot(3, { folder: remote, machine: 'box' }),
      bot(4, { folder: malformed }), bot(5), bot(6, { folder: fromHomeBot }), bot(7, { folder: remote, machine: 'box' }),
      bot(8, { name: '' }), bot(9, { folder: remote }),
    ],
  })
  writeRegistry(join(first, REPO_PATH), {
    bots: [bot(2), bot(3), bot(10), bot(11, { folder: unshown, machine: 'box', dsh: { model: 'ignored' } })],
    projects: [{ folder: unshown }], shown: [grant(unshown)],
  })
  writeRegistry(join(second, REPO_PATH), { bots: [bot(1), bot(8), bot(10)] })
  writeRegistry(join(fromHomeBot, REPO_PATH), { bots: [bot(12)] })
  writeRegistry(join(unshown, REPO_PATH), { bots: [bot(13)] })
  writeRegistry(join(malformed, REPO_PATH), { bots: [bot(14)] })
  writeRegistry(join(remote, REPO_PATH), { bots: [bot(15)] })
  await assertParity(registryRoot, new Map([
    [id(1), first], [id(3), first], [id(5), null], [id(6), fromHomeBot], [id(8), second],
    [id(10), first], [id(11), first], [id(12), fromHomeBot],
  ]), Array.from({ length: 16 }, (_, i) => id(i + 1)))
})

test('Code row lookup matches the Code tree cap before sorting or dropping empty projects', async t => {
  const { registryRoot, homeFile, project } = fixture(t)
  const folders = Array.from({ length: 201 }, (_, i) => project(i === 200 ? 'a-outside-cap' : `z-project-${i}`))
  const lastVisible = folders[199]
  const outside = folders[200]
  writeRegistry(homeFile, {
    bots: [bot(1, { folder: outside }), bot(2)],
    projects: folders.map(folder => ({ folder })), shown: folders.map(grant),
  })
  writeRegistry(join(lastVisible, REPO_PATH), { bots: [bot(3)] })
  writeRegistry(join(outside, REPO_PATH), { bots: [bot(4)] })
  await assertParity(registryRoot, new Map([[id(2), null], [id(3), lastVisible]]), [id(1), id(2), id(3), id(4)])
})

test('Code row lookup ignores registries that are not version 2 files', async t => {
  const { registryRoot, homeFile, project } = fixture(t)
  const folder = project('project')
  const repoFile = join(folder, REPO_PATH)
  writeRegistry(homeFile, { bots: [bot(1, { folder })], projects: [{ folder }], shown: [grant(folder)] })
  writeRegistry(repoFile, { bots: [bot(2)] })

  const home = JSON.parse(readFileSync(homeFile, 'utf8'))
  writeFileSync(homeFile, JSON.stringify({ ...home, version: 1 }))
  await assertParity(registryRoot, new Map(), [id(1), id(2)])

  writeFileSync(homeFile, JSON.stringify(home))
  const repo = JSON.parse(readFileSync(repoFile, 'utf8'))
  writeFileSync(repoFile, JSON.stringify({ ...repo, version: 1 }))
  await assertParity(registryRoot, new Map([[id(1), folder]]), [id(1), id(2)])
})

test('Code row lookup enforces the UTF-8 size cap on home and repo registries', async t => {
  const { registryRoot, homeFile, project } = fixture(t)
  const folder = project('project')
  const repoFile = join(folder, REPO_PATH)
  writeRegistry(homeFile, { projects: [{ folder }], shown: [grant(folder)], padding: '' })
  writeRegistry(repoFile, { bots: [bot(1)], padding: '' })
  const atCap = file => {
    const text = readFileSync(file, 'utf8')
    const left = MAX_FILE_BYTES - Buffer.byteLength(text)
    return text.replace('"padding":""', `"padding":"${'é'.repeat(Math.floor(left / 2))}${'x'.repeat(left % 2)}"`)
  }
  const homeAtCap = atCap(homeFile)
  const repoAtCap = atCap(repoFile)
  writeFileSync(homeFile, homeAtCap)
  writeFileSync(repoFile, repoAtCap)
  assert.deepEqual(await codeRowPlace(id(1), { registryRoot }), { folder, machine: null })
  for (const [file, text] of [[homeFile, homeAtCap], [repoFile, repoAtCap]]) {
    writeFileSync(file, `${text} `)
    assert.equal(await codeRowPlace(id(1), { registryRoot }), null, file)
    assert.equal(await codeRowPlace(id(1), { registryRoot, read: file => readFileSync(file, 'utf8') }), null, file)
    writeFileSync(file, text)
  }
})

test('Code row lookup declines a filesystem root before reading and requires a current folder', async t => {
  const { registryRoot, homeFile, project } = fixture(t)
  for (const [platform, root] of [['linux', '/'], ['linux', '/elsewhere/..'], ['win32', 'C:\\'], ['win32', '\\\\host\\share\\']]) {
    let reads = 0
    const read = () => { reads++; return '{}' }
    assert.equal(await codeRowPlace(id(1), { registryRoot: root, platform, read }), null, root)
    assert.equal(reads, 0, root)
  }
  const folder = project('vanishing')
  writeRegistry(homeFile, { bots: [bot(1, { folder })], shown: [grant(folder)] })
  assert.deepEqual(await codeRowPlace(id(1), { registryRoot }), { folder, machine: null })
  rmSync(folder, { recursive: true })
  writeFileSync(folder, '')
  assert.equal(await codeRowPlace(id(1), { registryRoot }), null)
})
