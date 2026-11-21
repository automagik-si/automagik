import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectRelease, LANE_URL, profileRegistry, releaseSource } from '../src/host/supervisor/release.js'
import { BOTS, fixture, FROM, lane, REGISTRY, TO, WELCOME } from './fixtures/supervisor.mjs'

function inspect(f, { laneUrl, keys }, options = {}) {
  const calls = []
  const saved = new Map()
  const view = {}
  const outcome = inspectRelease({
    profileDir: f.profileDir, view, source: releaseSource(laneUrl, keys),
    getDshVersion: () => '0.2.2-rc.2',
    registry: dir => profileRegistry(dir, f.env),
    fetch: async url => {
      calls.push(url)
      if (url === REGISTRY + '-/ping') return new Response('{}')
      assert.ok(f.tarballs.has(url), `unexpected fetch ${url}`)
      return new Response(f.tarballs.get(url))
    },
    saveTarball: (plugin, bytes) => saved.set(plugin.name, bytes),
    ...options,
  })
  return { outcome, calls, saved, view }
}

test('checks the whole installed set and returns verified tarballs and the registry', async t => {
  const f = fixture(t, { plugins: [BOTS, WELCOME] })
  const { outcome, calls, saved, view } = inspect(f, lane(f))
  const result = await outcome
  assert.equal(result.state, 'available')
  assert.equal(result.registry, REGISTRY)
  assert.equal(view.sequence, 42)
  assert.deepEqual(view.plugins, [BOTS, WELCOME].map(name => ({ name, from: FROM, to: TO })))
  assert.deepEqual(calls, [...f.tarballs.keys(), REGISTRY + '-/ping'])
  for (const plugin of result.plugins) assert.deepEqual(saved.get(plugin.name), f.tarballs.get(plugin.url))
})

test('rejects an invalid signature, lower sequence, engine mismatch and corrupt tarball', async t => {
  const f = fixture(t)
  const source = lane(f)
  const prior = { lastSequence: 43 }
  assert.equal((await inspect(f, source, { current: prior }).outcome).reason, 'sequence-lower')
  assert.equal((await inspect(f, source, { getDshVersion: () => '0.1.0' }).outcome).reason, 'engines-dsh')
  f.tarballs.set(f.release[0].url, Buffer.alloc(f.release[0].size))
  const corrupt = inspect(f, source)
  assert.equal((await corrupt.outcome).reason, 'hash-mismatch')
  assert.equal(corrupt.saved.size, 0)
  fs.appendFileSync(source.path, '\n')
  const tampered = inspect(f, source)
  assert.equal((await tampered.outcome).reason, 'signature-invalid')
  assert.deepEqual(tampered.calls, [])
  assert.equal(releaseSource(LANE_URL, source.keys), null)
  assert.equal(releaseSource('https://example.invalid/lane.json'), null)
})

test('refuses additional npmrc settings even with an explicit registry environment value', async t => {
  const f = fixture(t)
  fs.appendFileSync(join(f.profileDir, '.npmrc'), 'strict-ssl=false\n')
  f.env.NPM_CONFIG_REGISTRY = REGISTRY
  const { outcome, calls } = inspect(f, lane(f))
  assert.equal((await outcome).reason, 'profile-npmrc')
  assert.ok(!calls.includes(REGISTRY + '-/ping'))
})
