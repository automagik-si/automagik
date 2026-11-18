import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CHECK = join(ROOT, 'server', 'measurement-check.mjs')
const TEMPS = []

/** Restore write permission so a 0555 fixture can be removed. */
function unlock(root) {
  chmodSync(root, 0o755)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(join(root, entry.name))
  }
}

after(() => {
  for (const root of TEMPS) {
    try { unlock(root) } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

const EXPOSED = [
  '.claude/projects',
  '.claude/session-archive',
  '.codex/sessions',
  '.codex/archived_sessions',
  '.automagik/meter',
]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'measurement-check-'))
  TEMPS.push(root)
  for (const dir of ['dsh/profiles/automagik-web', ...EXPOSED]) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'dsh/profiles/automagik-web/automagik-server-profile'), `${JSON.stringify({
    version: 1, release: '3.155.0', packageSha256: 'a'.repeat(64),
  })}\n`)
  writeFileSync(join(root, '.claude/projects/workspace.jsonl'), '{}\n')
  writeFileSync(join(root, '.claude/session-archive/old.jsonl'), '{}\n')
  writeFileSync(join(root, '.codex/sessions/s.jsonl'), '{}\n')
  writeFileSync(join(root, '.codex/archived_sessions/s.jsonl'), '{}\n')
  writeFileSync(join(root, '.automagik/meter/meter.db'), '')
  writeFileSync(join(root, '.automagik/meter/claude-limits.jsonl'), '{}\n')
  for (const secret of ['.claude/.credentials.json', '.codex/auth.json', '.claude.json', '.claude/settings.json']) {
    writeFileSync(join(root, secret), '{}')
    chmodSync(join(root, secret), 0o000)
  }
  // A read-only view: neither the root nor an exposed root is writable.
  for (const dir of EXPOSED) chmodSync(join(root, dir), 0o555)
  chmodSync(root, 0o555)
  return root
}

const run = (root) => spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8' })

test('passes on a readable read-only view', () => {
  const result = run(fixture())
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^OK: /m)
  assert.match(result.stdout, /ok: readable: \.claude\/projects/)
})

test('fails when the documented view is absent', () => {
  const result = run(join(fixture(), 'no-such-view'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /absent: /)
})

test('fails when the view is stale', () => {
  const root = fixture()
  rmSync(join(root, 'dsh/profiles/automagik-web/automagik-server-profile'))
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /stale: /)
})

test('fails when an exposed root is not readable', () => {
  const root = fixture()
  chmodSync(join(root, '.codex/sessions'), 0o000)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not readable: \.codex\/sessions/)
  chmodSync(join(root, '.codex/sessions'), 0o555)
})

test('fails when a secret is readable', () => {
  const root = fixture()
  chmodSync(join(root, '.codex/auth.json'), 0o644)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exposed: \.codex\/auth\.json is readable/)
})

test('fails when an exposed root is writable', () => {
  const root = fixture()
  chmodSync(join(root, '.claude/session-archive'), 0o755)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /writable: \.claude\/session-archive/)
  chmodSync(join(root, '.claude/session-archive'), 0o555)
})

test('fails when the meter directory has no limits log', () => {
  const root = fixture()
  chmodSync(join(root, '.automagik/meter'), 0o755)
  rmSync(join(root, '.automagik/meter/claude-limits.jsonl'))
  chmodSync(join(root, '.automagik/meter'), 0o555)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not readable: \.automagik\/meter\/claude-limits\.jsonl/)
})
