// The member wall's spelling table (member-wall-spelling-cells.mjs): every spelling of a denied
// folder looks absent to a member, and the same spelling of its own folder is allowed, for read,
// list, search and skill load. The case and accent rows also run on a case-insensitive disk
// (a casefold tmpfs in a user namespace) where those spellings name the very same folder.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cells } from './member-wall-spelling-cells.mjs'

// On a case-sensitive disk another case or accent form is another name, of a folder that does
// not exist: the wall may let it through, and it must never show the denied folder's content.
const OTHER_NAME_ON_PLAIN_DISK = new Set(['another letter case', 'composed and decomposed accents'])

const check = ({ table, searches, late }, plainDisk) => {
  // A search at the shared root holds a denied folder below it, whatever the case it is spelled
  // in; its team folder holds none. On a plain disk the other case names no folder at all.
  assert.equal(searches.shared, 'refused', 'search at the shared root')
  assert.equal(searches.sharedOtherCase, 'refused', 'search at the shared root, another case')
  assert.equal(searches.team, 'allowed', 'search at the shared team folder')
  if (!plainDisk) assert.equal(searches.teamOtherCase, 'allowed', 'search at the team folder, another case')
  else assert.notEqual(searches.teamOtherCase, 'LEAKED')
  const denied = { read: 'looks absent', list: 'looks absent', search: 'looks absent', 'skill load': 'looks absent' }
  assert.deepEqual(late.made, denied, 'a denied root made after DSH started')
  assert.deepEqual(late.remade, denied, 'a denied root deleted and made again')
  for (const { row, column, denied, own } of table) {
    assert.notEqual(denied, 'LEAKED', `${row} / ${column}: the denied folder's content`)
    assert.notEqual(own, 'LEAKED', `${row} / ${column}`)
    if (plainDisk && OTHER_NAME_ON_PLAIN_DISK.has(row)) continue
    assert.equal(denied, 'looks absent', `${row} / ${column}: the denied folder`)
    assert.equal(own, 'allowed', `${row} / ${column}: the member's own folder`)
  }
}

test('every spelling of a denied folder looks absent; the same spelling of its own is allowed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'member-spelling-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  check(await cells(root), true)
})

// A user namespace may mount a casefold tmpfs; where the host forbids it, the test says so.
const casefold = () => {
  try {
    execFileSync('unshare', ['-Urm', 'sh', '-c', 'd=$(mktemp -d) && mount -t tmpfs -o casefold none "$d" && chattr +F "$d"'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('on a case-insensitive disk, another case or accent form of a denied folder still looks absent', { skip: !casefold() && 'no casefold tmpfs in a user namespace here' }, () => {
  const script = [
    'set -e', 'd=$(mktemp -d)', 'mount -t tmpfs -o casefold none "$d"', 'mkdir "$d/w"', 'chattr +F "$d/w"',
    'exec "$0" --import ./test/harness-resolve.mjs ./test/member-wall-spelling-cells.mjs "$d/w"',
  ].join('\n')
  const run = spawnSync('unshare', ['-Urm', 'sh', '-c', script, process.execPath], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 120_000 })
  assert.equal(run.status, 0, run.stderr.slice(-2000))
  check(JSON.parse(run.stdout.trim().split('\n').at(-1)), false)
})
