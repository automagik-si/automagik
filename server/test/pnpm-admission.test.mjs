import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

test('the admission wrapper uses only commands the distroless image ships', () => {
  const shell = readFileSync(join(ROOT, '..', 'bin', 'pnpm-admission'), 'utf8')
  assert.doesNotMatch(shell, /^[\t ]*mkdir\b/m)
  assert.match(shell, /mkdirSync/)
  assert.match(shell, /\/usr\/bin\/flock/)
})

test('the build wraps every runtime and profile pnpm.cjs and records it', () => {
  const out = mkdtempSync(join(tmpdir(), 'automagik-pnpm-admission-'))
  const runtime = join(out, 'runtime', 'node_modules', 'pnpm', 'bin')
  const profile = join(out, 'profile', 'node_modules', 'pnpm', 'bin')
  mkdirSync(runtime, { recursive: true })
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(runtime, 'pnpm.cjs'), "console.log('runtime-real')\n")
  writeFileSync(join(profile, 'pnpm.cjs'), "console.log('profile-real')\n")
  try {
    const result = spawnSync(process.execPath, [join(ROOT, '..', 'install-pnpm-admission.mjs'), out], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    for (const file of [join(runtime, 'pnpm.cjs'), join(profile, 'pnpm.cjs')]) {
      assert.match(readFileSync(file, 'utf8'), /automagik-pnpm-admission/)
      assert.equal(existsSync(join(dirname(file), 'pnpm-real.cjs')), true)
    }
    const manifest = JSON.parse(readFileSync(join(out, 'pnpm-admission.json'), 'utf8'))
    assert.equal(manifest.wrapped.length, 2)
    assert.ok(manifest.wrapped.every((entry) => entry.wrapper.endsWith('/pnpm/bin/pnpm.cjs') && entry.real.endsWith('/pnpm/bin/pnpm-real.cjs')))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('the refusal record stays one JSON line for crafted owners', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-pnpm-refusal-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const flock = join(dir, 'flock')
  const real = join(dir, 'pnpm.mjs')
  writeFileSync(flock, '#!/bin/sh\nexit "$TEST_FLOCK_STATUS"\n', { mode: 0o755 })
  writeFileSync(real, '')
  const shell = readFileSync(join(ROOT, '..', 'bin', 'pnpm-admission'), 'utf8')
    .replaceAll('/data/run', '${TEST_ADMISSION_DIR}')
    .replaceAll('/nodejs/bin/node', '"$TEST_NODE"')
    .replaceAll('/usr/bin/flock', '"$TEST_FLOCK"')

  for (const [index, owner] of ['ada', 'ada"x', 'ada\\x', 'ada\nx'].entries()) {
    const scratch = join(dir, String(index))
    mkdirSync(scratch)
    const run = (status, admissionOwner) => spawnSync('/bin/sh', [
      '-c', shell, 'pnpm-admission', real,
    ], {
      encoding: 'utf8',
      env: {
        TEST_ADMISSION_DIR: scratch, TEST_NODE: process.execPath, TEST_FLOCK: flock,
        TEST_FLOCK_STATUS: String(status), AUTOMAGIK_PNPM_OWNER: admissionOwner,
        AUTOMAGIK_PNPM_LOCK_WAIT: '0',
      },
    })
    const holder = run(0, owner)
    assert.equal(holder.status, 0, holder.stderr)
    const waiter = run(1, 'someone')
    assert.equal(waiter.status, 1, waiter.stderr)
    const line = readFileSync(join(scratch, 'pnpm-admission-refusal'), 'utf8')
    const expected = owner === 'ada' ? owner : 'unknown'
    assert.match(line, /^[^\r\n]+\n$/)
    const refusal = JSON.parse(line)
    assert.equal(refusal.owner, expected)
    assert.match(refusal.message, new RegExp(`^failed, lock held by ${expected} for \\d+s$`))
    assert.equal(waiter.stderr, `${refusal.message}\n`)
  }
})
