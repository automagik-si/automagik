import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { assertPublish, proveImage } from '../image-source.mjs'
import { sha256 } from '../checkout-input.mjs'
import { DEFAULT_PACKAGES } from '../fetch-plugins.mjs'

const revision = 'a'.repeat(40), manifest = 'b'.repeat(64), imageId = `sha256:${'c'.repeat(64)}`
function fixture(kind = 'checkout', change = '') {
  const options = { image: 'automagik-server:test', kind, event: kind === 'checkout' ? 'pull_request' : 'release', revision, version: '1.2.3',
    manifest: kind === 'checkout' ? manifest : '', child: sha256('committed child') }
  const source = { kind, ...(kind === 'checkout' ? { revision, manifest } : {}) }
  const labels = { 'ai.automagik.input.kind': kind, 'ai.automagik.input.manifest': options.manifest,
    'org.opencontainers.image.revision': revision, 'org.opencontainers.image.version': kind === 'checkout' ? `checkout-${revision}` : options.version }
  const versions = { automagik: options.version, revision, source, plugins: Object.fromEntries(DEFAULT_PACKAGES.map((name) => [name, options.version])) }
  const calls = [], copies = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'image') {
      if (change === 'label-kind') labels['ai.automagik.input.kind'] = 'checkout'
      if (change === 'label-revision') labels['org.opencontainers.image.revision'] = 'd'.repeat(40)
      if (change === 'label-manifest') labels['ai.automagik.input.manifest'] = 'e'.repeat(64)
      return JSON.stringify([{ Id: imageId, Config: { Labels: labels } }])
    }
    if (args[0] === 'create') return 'container-id'
    if (args[0] === 'inspect') return change === 'container-image' ? `sha256:${'d'.repeat(64)}` : imageId
    if (args[0] === 'cp') {
      copies.push(args[2])
      if (change === 'copy-failure') throw new Error('copy failure')
      if (change === 'metadata-kind') versions.source.kind = 'checkout'
      if (change === 'metadata-revision') versions.source.revision = 'e'.repeat(40)
      if (change === 'metadata-manifest') versions.source.manifest = 'e'.repeat(64)
      if (change === 'plugin-version') versions.plugins['@automagik/bots-dsh'] = '1.2.4'
      if (change === 'version') versions.automagik = '1.2.4'
      writeFileSync(args[2], args[1].endsWith('/versions.json') ? JSON.stringify(versions) : change === 'child' ? 'wrong child' : 'committed child')
      return ''
    }
    if (args[0] === 'rm') return ''
    throw new Error('unexpected Docker operation')
  }
  return { options, run, calls, copies }
}

test('binds stopped-container child, source metadata, full revision and actual image ID; cleans only owned resources', () => {
  const f = fixture(), proof = proveImage(f.options, f.run)
  assert.equal(proof.imageId, imageId); assert.equal(proof.revision, revision)
  assert.equal(proof.checkoutChild, proof.installedChild); assert.equal(proof.source.manifest, manifest)
  const create = f.calls.find((c) => c[0] === 'create')
  assert.equal(create[3], imageId); assert.match(create[2], /^automagik-source-/)
  assert.deepEqual(f.calls.at(-1), ['rm', create[2]])
  assert.ok(f.calls.some((c) => c[0] === 'cp' && c[1].endsWith('/profile/node_modules/@automagik/bots-dsh/src/host/browser/script-child.js')))
  assert.ok(f.copies.every((path) => !existsSync(path)))
  assert.ok(!f.calls.some((c) => ['start', 'exec', 'run', 'login', 'push'].includes(c[0])))
})

for (const change of ['label-revision', 'label-manifest', 'container-image', 'copy-failure', 'metadata-revision', 'metadata-manifest', 'plugin-version', 'version', 'child']) {
  test(`refuses ${change} and removes a created container and copied files`, () => {
    const f = fixture('checkout', change); assert.throws(() => proveImage(f.options, f.run))
    const create = f.calls.find((c) => c[0] === 'create')
    if (create) assert.deepEqual(f.calls.at(-1), ['rm', create[2]])
    assert.ok(f.copies.every((path) => !existsSync(path)))
  })
}

test('release publication checks actual loaded rootfs and labels, not just upstream mode', () => {
  for (const event of ['release', 'workflow_dispatch']) {
    const f = fixture('release'); f.options.event = event
    assert.deepEqual(proveImage(f.options, f.run).source, { kind: 'release' })
    assert.equal(f.copies.length, 1)
  }
  for (const change of ['label-kind', 'metadata-kind', 'label-manifest', 'metadata-manifest', 'metadata-revision']) {
    const f = fixture('release', change); assert.throws(() => proveImage(f.options, f.run))
  }
})

test('forged publishing outputs cannot authorize PR/push/unknown events or checkout source', () => {
  for (const event of ['pull_request', 'push', 'unknown', '']) for (const kind of ['release', 'checkout']) assert.throws(() => assertPublish(event, kind))
  for (const event of ['release', 'workflow_dispatch']) {
    assert.doesNotThrow(() => assertPublish(event, 'release'))
    assert.throws(() => assertPublish(event, 'checkout'))
  }
})
