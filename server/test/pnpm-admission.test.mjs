import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

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
