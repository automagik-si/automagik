import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CHECK = join(ROOT, 'server', 'measurement-check.mjs')
const read = (file) => readFileSync(join(ROOT, file), 'utf8')
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

function fixture(setup) {
  const root = mkdtempSync(join(tmpdir(), 'measurement-check-'))
  TEMPS.push(root)
  for (const dir of ['dsh/profiles/automagik-web', ...EXPOSED]) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  const marker = { version: 1, release: '3.155.0', packageSha256: 'a'.repeat(64) }
  const markerPath = join(root, 'dsh/profiles/automagik-web/automagik-server-profile')
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`)
  writeFileSync(join(root, '.claude/projects/workspace.jsonl'), '{}\n')
  writeFileSync(join(root, '.claude/session-archive/old.jsonl'), '{}\n')
  writeFileSync(join(root, '.codex/sessions/s.jsonl'), '{}\n')
  writeFileSync(join(root, '.codex/archived_sessions/s.jsonl'), '{}\n')
  writeFileSync(join(root, '.automagik/meter/meter.db'), '')
  writeFileSync(join(root, '.automagik/meter/claude-limits.jsonl'), '{}\n')
  const secrets = [
    '.claude/.credentials.json', '.codex/auth.json', '.claude.json', '.claude/settings.json',
  ]
  for (const secret of secrets) {
    writeFileSync(join(root, secret), '{}')
    chmodSync(join(root, secret), 0o000)
  }
  if (setup) setup(root)
  // A read-only view: neither the root nor an exposed root is writable.
  for (const dir of EXPOSED) chmodSync(join(root, dir), 0o555)
  chmodSync(root, 0o555)
  return root
}

const run = (root) => spawnSync(process.execPath, [CHECK, root], { encoding: 'utf8' })

// The measurement section is the pilot's only public contract for reading a workspace volume.
// It must stay truthful about the one mount the image makes and the roots it does not expose.
test('the measurement docs name the one volume, the read-only view and the negatives', () => {
  const readme = read('server/README.md')
  const start = readme.indexOf('## Measurement access (read-only)')
  assert.ok(start >= 0, 'server/README.md has a Measurement access section')
  const end = readme.indexOf('\n## ', start + 1)
  const section = readme.slice(start, end < 0 ? undefined : end)
  for (const phrase of [
    'one volume, at `/data`',
    'docker volume inspect',
    'incus',
    '`/srv/automagik/measure/<workspace>`',
    '.claude/projects',
    '.codex/sessions',
    '.automagik/meter',
    '`.claude.json`',
    '`.codex/auth.json`',
    'server/measurement-check.mjs',
  ]) {
    assert.ok(section.includes(phrase), `the measurement section names ${phrase}`)
  }
})

test('the documented grant reads only the exposed roots and denies every credential', () => {
  const readme = read('server/README.md')
  const start = readme.indexOf('## Measurement access (read-only)')
  assert.ok(start >= 0, 'server/README.md has a Measurement access section')
  const end = readme.indexOf('\n## ', start + 1)
  const section = readme.slice(start, end < 0 ? undefined : end)
  // A recursive grant over the whole view makes every credential readable.
  assert.doesNotMatch(
    section,
    /setfacl\s+-R\s+-m\s+u:<measurement>:rX\s+\/srv\/automagik\/measure\/automagik-data/,
  )
  const setup = section.slice(section.indexOf('view=/srv/automagik/measure/automagik-data'))
  assert.ok(setup.length > 0, 'the section is one runnable setup block')
  // Read and search only on the roots the measurement identity consumes.
  for (const root of [
    '.claude/projects', '.claude/session-archive', '.codex/sessions',
    '.codex/archived_sessions', '.automagik/meter',
  ]) {
    assert.ok(setup.includes(`"$view/${root}"`), `the grant names ${root}`)
  }
  assert.ok(
    setup.includes('"$view/dsh/profiles/automagik-web/automagik-server-profile"'),
    'the grant names the seeded marker',
  )
  // The documented grant runs before the view is remounted read-only: setfacl needs a writable
  // mount.
  assert.ok(
    setup.indexOf('mount -o remount,ro,bind "$view"') > setup.indexOf('setfacl -R'),
    'the grants precede the read-only remount',
  )
  // Every credential path gets an explicit deny, whatever the file mode.
  const deny = setup.slice(setup.indexOf('# Never readable'))
  assert.ok(deny.length > 0, 'the section denies the never-exposed paths explicitly')
  for (const secret of [
    '.claude/.credentials.json', '.codex/auth.json', '.claude.json', '.claude/settings.json',
    '.gemini/settings.json', '.gemini/antigravity-cli/settings.json', '.antigravity/settings.json',
  ]) {
    assert.ok(deny.includes(secret), `the deny loop names ${secret}`)
  }
})

test('passes on a readable read-only view', () => {
  const result = run(fixture())
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /^OK: /m)
  assert.match(result.stdout, /ok: readable: \.claude\/projects/)
})

/** Write the derived model-name file into a fixture and lock it down. */
function derived(root, value = '{"model":"gemini-3-pro"}\n') {
  const dir = join(root, '.automagik/measure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model-name.json'), value)
  chmodSync(join(dir, 'model-name.json'), 0o444)
  chmodSync(dir, 0o555)
}

/** Mark a fixture as running Gemini, whose raw settings must never be readable. */
function gemini(root, mode = 0o000) {
  mkdirSync(join(root, '.gemini'), { recursive: true })
  writeFileSync(join(root, '.gemini/settings.json'), '{"apiKey":"secret"}')
  chmodSync(join(root, '.gemini/settings.json'), mode)
  chmodSync(join(root, '.gemini'), 0o555)
}

test('passes when a Gemini workspace exposes the derived model name', () => {
  const root = fixture((dir) => { gemini(dir); derived(dir) })
  const result = run(root)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /ok: readable: \.automagik\/measure\/model-name\.json/)
  assert.doesNotMatch(result.stderr, /exposed: /)
})

test('passes when an Antigravity workspace exposes the derived model name', () => {
  const root = fixture((dir) => {
    mkdirSync(join(dir, '.gemini/antigravity-cli'), { recursive: true })
    derived(dir)
  })
  const result = run(root)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /ok: readable: \.automagik\/measure\/model-name\.json/)
})

test('fails when a Gemini workspace has no derived model-name file', () => {
  const root = fixture((dir) => gemini(dir))
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing: \.automagik\/measure\/model-name\.json/)
})

test('fails when the derived model-name file is not readable', () => {
  const root = fixture((dir) => {
    mkdirSync(join(dir, '.automagik/measure'), { recursive: true })
    writeFileSync(join(dir, '.automagik/measure/model-name.json'), '{"model":"x"}\n')
    chmodSync(join(dir, '.automagik/measure/model-name.json'), 0o000)
    chmodSync(join(dir, '.automagik/measure'), 0o555)
  })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not readable: \.automagik\/measure\/model-name\.json/)
})

test('fails when the derived model-name file carries more than the model', () => {
  const root = fixture((dir) => derived(dir, '{"model":"x","apiKey":"secret"}\n'))
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /not model-only: \.automagik\/measure\/model-name\.json/)
})

test('fails when a raw Gemini settings file is readable', () => {
  const root = fixture((dir) => { gemini(dir, 0o644); derived(dir) })
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exposed: \.gemini\/settings\.json is readable/)
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
