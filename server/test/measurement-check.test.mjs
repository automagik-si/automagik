import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MEASUREMENT_DIR, MEASUREMENT_MARKER, writeMeasurementMarker } from '../lib.mjs'
import { SEED_MARKER } from '../profile-state.mjs'

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
  for (const dir of ['dsh/profiles/automagik-web', MEASUREMENT_DIR, ...EXPOSED]) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  const marker = { version: 1, release: '3.155.0', packageSha256: 'a'.repeat(64) }
  chmodSync(join(root, 'dsh'), 0o700)
  const markerPath = join(root, MEASUREMENT_MARKER)
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

const run = (root) => {
  const capture = mkdtempSync(join(tmpdir(), 'measurement-output-'))
  TEMPS.push(capture)
  const stdout = join(capture, 'stdout'), stderr = join(capture, 'stderr')
  const out = openSync(stdout, 'w'), err = openSync(stderr, 'w')
  try {
    const result = spawnSync(process.execPath, [CHECK, root], { stdio: ['ignore', out, err] })
    assert.ifError(result.error)
    return { status: result.status, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') }
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

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
  // Read and search only on the roots the measurement identity consumes, each one guarded so an
  // absent vendor directory is skipped rather than failing the setup.
  for (const root of [
    '.claude/projects', '.claude/session-archive', '.codex/sessions',
    '.codex/archived_sessions', '.automagik/meter',
  ]) {
    assert.ok(setup.includes(root), `the grant names ${root}`)
  }
  assert.ok(setup.includes('[ -d "$view/$d" ]'), 'the grant skips an absent root')
  assert.ok(
    setup.includes('[ -e "$view/$marker" ]') &&
      setup.includes(`marker=${MEASUREMENT_MARKER}`),
    'the grant names the seeded marker',
  )
  assert.ok(setup.includes(`"$view/${MEASUREMENT_DIR}"`) && setup.includes('d:u:$me:r--'),
    'the grant survives an atomic replacement')
  assert.doesNotMatch(setup, /dsh\/profiles|for d in .*\bdsh\b/)
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

test('a second publication keeps the measurement grant under a restrictive parent', t => {
  const volume = mkdtempSync(join(tmpdir(), 'measurement-publish-'))
  TEMPS.push(volume)
  chmodSync(volume, 0o701)
  const profile = join(volume, 'dsh')
  mkdirSync(profile, { mode: 0o700 })
  const uid = process.geteuid() === 2200 ? 2201 : 2200
  const output = join(profile, 'acl-output')
  const acl = (command, args) => {
    const out = openSync(output, 'w')
    try {
      const result = spawnSync(command, args, { stdio: ['ignore', out, out] })
      return { ...result, text: readFileSync(output, 'utf8') }
    } finally { closeSync(out) }
  }
  const parentAcl = acl('setfacl', ['-m', `u:${uid}:--x,d:u:${uid}:---`, volume])
  const hasAcl = parentAcl.status === 0
  if (!hasAcl) t.diagnostic('POSIX ACL unavailable, checking the mode-based grant')
  const grantDir = join(volume, MEASUREMENT_DIR)
  const marker = join(volume, MEASUREMENT_MARKER)
  const publish = char => {
    const seed = { version: 1, release: '3.155.0', packageSha256: char.repeat(64) }
    writeFileSync(join(profile, SEED_MARKER), JSON.stringify(seed))
    writeMeasurementMarker(volume, profile)
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), seed)
  }
  const assertGrant = () => {
    if (hasAcl) {
      const published = acl('getfacl', ['-cn', marker])
      assert.equal(published.status, 0, published.text)
      assert.match(published.text, new RegExp(`^user:${uid}:r--$`, 'm'))
    } else {
      assert.equal(statSync(grantDir).mode & 0o005, 0o005)
      assert.equal(statSync(marker).mode & 0o007, 0o004)
    }
  }
  const originalUmask = process.umask(0o077)
  try {
    publish('a')
    if (hasAcl) {
      const aclBefore = acl('getfacl', ['-cn', marker])
      assert.equal(aclBefore.status, 0, aclBefore.text)
      assert.match(aclBefore.text, new RegExp(`^user:${uid}:---$`, 'm'))
      for (const args of [
        ['-m', `u:${uid}:--x,d:u:${uid}:r--`, grantDir], ['-m', `u:${uid}:r--`, marker],
      ]) {
        const grant = acl('setfacl', args)
        assert.equal(grant.status, 0, grant.text)
      }
    }
    assertGrant()
    const previous = openSync(marker, 'r')
    try {
      const inode = statSync(marker).ino
      publish('b')
      assert.notEqual(statSync(marker).ino, inode)
    } finally { closeSync(previous) }
    assertGrant()
    if (hasAcl) {
      const inherited = acl('getfacl', ['-cn', grantDir])
      assert.equal(inherited.status, 0, inherited.text)
      assert.match(inherited.text, new RegExp(`^default:user:${uid}:r--$`, 'm'))
    }
    assert.equal(statSync(profile).mode & 0o777, 0o700)
  } finally { process.umask(originalUmask) }
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
  const marker = join(root, MEASUREMENT_MARKER)
  writeFileSync(join(root, 'dsh/profiles/automagik-web/automagik-server-profile'), readFileSync(marker))
  chmodSync(root, 0o755)
  rmSync(marker)
  chmodSync(root, 0o555)
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
