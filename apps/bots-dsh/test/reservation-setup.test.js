import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/reservations-setup.sh', import.meta.url))
const doc = new URL('../../../docs/cloud/0024-reservations-setup.md', import.meta.url)
function groupName(root) {
  const path = join(root, 'group-name')
  const fd = fs.openSync(path, 'wx')
  try {
    const result = spawnSync('id', ['-gn'], { stdio: ['ignore', fd, 'inherit'] })
    if (result.error) throw result.error
    assert.equal(result.status, 0)
    return fs.readFileSync(path, 'utf8').trim()
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(path)
  }
}
const mode = path => fs.lstatSync(path).mode & 0o7777
const args = (dir, group) => [script, '--group', group, dir]
function run(dir) {
  const path = join(dirname(dirname(dir)), 'stderr')
  const group = groupName(dirname(dirname(dir)))
  const fd = fs.openSync(path, 'w')
  try {
    const result = spawnSync('sh', args(dir, group), { stdio: ['ignore', 'inherit', fd] })
    if (result.error) throw result.error
    return { status: result.status, stderr: fs.readFileSync(path, 'utf8') }
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(path)
  }
}

function setup(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'automagik-reservation-setup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, dir: join(root, 'p/reservations') }
}

function keyOf(dir) {
  const path = join(dir, 'key')
  const key = fs.readFileSync(path)
  assert.equal(mode(dir), 0o3770)
  assert.equal(mode(path), 0o640)
  assert.equal(key.length, 32)
  assert.equal(fs.statSync(path).gid, fs.statSync(dir).gid)
  assert.equal(fs.statSync(path).gid, userInfo().gid)
  assert.deepEqual(fs.readdirSync(dir), ['key'])
  return key
}

test('setup creates a group directory and an unchanged key on rerun', t => {
  const { dir } = setup(t)
  const first = run(dir)
  assert.equal(first.status, 0, first.stderr)
  const bytes = keyOf(dir)
  const second = run(dir)
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(keyOf(dir), bytes)
})

for (const kind of ['symlink', 'file', 'group writable', 'foreign owner']) {
  test(`setup refuses a ${kind} path before touching it`, t => {
    if (kind === 'foreign owner' && process.getuid() !== 0) return t.skip('requires root')
    const { root, dir } = setup(t)
    const parent = join(root, 'p')
    fs.mkdirSync(parent)
    if (kind === 'symlink') fs.symlinkSync(root, dir)
    if (kind === 'file') fs.writeFileSync(dir, 'untouched')
    if (kind === 'group writable') fs.chmodSync(parent, 0o770)
    if (kind === 'foreign owner') fs.chownSync(parent, 65534, 65534)
    const snapshot = () => ({
      root: fs.readdirSync(root), entries: fs.readdirSync(parent), mode: mode(parent),
      target: fs.existsSync(dir) ? mode(dir) : undefined,
    })
    const before = snapshot()
    const result = run(dir)
    assert.notEqual(result.status, 0)
    assert.deepEqual(snapshot(), before)
  })
}

test('setup leaves a missing parent untouched under an unsafe ancestor', t => {
  const { root, dir } = setup(t)
  fs.chmodSync(root, 0o770)
  const result = run(dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /every folder above/)
  assert.deepEqual(fs.readdirSync(root), [])
})

for (const kind of ['symlink', 'short', 'world-readable']) {
  test(`setup keeps the folder closed and preserves a ${kind} key`, t => {
    const { dir } = setup(t)
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    fs.chmodSync(dir, 0o3770)
    const path = join(dir, 'key')
    const bytes = Buffer.alloc(kind === 'short' ? 31 : 32, 1)
    if (kind === 'symlink') {
      const other = join(dir, 'other')
      fs.writeFileSync(other, bytes, { mode: 0o640 })
      fs.symlinkSync(other, path)
    } else {
      fs.writeFileSync(path, bytes)
      fs.chmodSync(path, kind === 'short' ? 0o640 : 0o644)
    }
    const before = mode(path)
    const result = run(dir)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /folder stays closed/)
    assert.equal(mode(dir) & 0o777, 0o700)
    assert.equal(mode(path), before)
    assert.deepEqual(fs.readFileSync(path), bytes)
  })
}

test('concurrent setup preserves the first key and removes publication temps', async t => {
  const { dir, root } = setup(t)
  const group = groupName(root)
  let firstKey
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn('sh', args(dir, group), { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', code => {
      try {
        firstKey ??= fs.readFileSync(join(dir, 'key'))
        resolve(code)
      } catch (error) {
        reject(error)
      }
    })
  })
  const codes = await Promise.all([launch(), launch()])
  assert.ok(codes.includes(0), String(codes))
  assert.deepEqual(keyOf(dir), firstKey)
})

test('the setup guide carries the exact script', () => {
  const block = /<!-- setup-script:start -->\n```sh\n([\s\S]*?)```\n<!-- setup-script:end -->/
  assert.equal(block.exec(fs.readFileSync(doc, 'utf8'))?.[1], fs.readFileSync(script, 'utf8'))
})
