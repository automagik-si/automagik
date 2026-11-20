import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const integrity = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64')

export function pnpmLock(profile, manifest) {
  const importers = []
  const packages = []
  const snapshots = []
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    assert.ok(spec.startsWith('file:'))
    importers.push(`      '${name}':\n        specifier: ${spec}\n        version: ${spec}`)
    packages.push(`  '${name}@${spec}':\n    resolution: {integrity: ${integrity(readFileSync(join(profile, spec.slice(5))))}, tarball: ${spec}}`)
    snapshots.push(`  '${name}@${spec}': {}`)
  }
  return [
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: false\n  excludeLinksFromLockfile: false",
    'importers:\n\n  .:\n    dependencies:\n' + importers.join('\n'),
    'packages:\n\n' + packages.join('\n\n'),
    'snapshots:\n\n' + snapshots.join('\n\n'),
  ].join('\n\n') + '\n'
}

export function verifyOfflineLock(profile) {
  const lock = readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json')))
  assert.match(lock, /^lockfileVersion: '9\.0'/)
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    assert.ok(lock.includes(`'${name}@${spec}':`))
    assert.ok(lock.includes('specifier: ' + spec))
    assert.ok(lock.includes('version: ' + spec))
  }
  const pins = [...lock.matchAll(/resolution: \{integrity: (\S+), tarball: file:([^}]+)\}/g)]
  assert.equal(pins.length, Object.keys(manifest.dependencies).length)
  for (const [, expected, path] of pins) assert.equal(integrity(readFileSync(join(profile, path))), expected)
}
