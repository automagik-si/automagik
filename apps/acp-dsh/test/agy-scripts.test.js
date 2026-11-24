// The daily Antigravity install-scripts check (scripts/agy-scripts.mjs, #2048), offline: a fake
// fetch stands for Google's scripts and manifests. One case per exit code, in its order.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { AGY_DOWNLOAD_HOST, AGY_DOWNLOAD_PATH, AGY_MANIFEST_BASE, AGY_PLATFORMS, AGY_SCRIPTS, AGY_SCRIPTS_BASE } from '../src/host/agy-source.js'
import { check } from '../scripts/agy-scripts.mjs'

// Stand-in script texts: only their base and manifest lines are real lines of the shape.
const texts = (base = AGY_MANIFEST_BASE) => ({
  'install.sh': `#!/bin/sh\nDOWNLOAD_BASE_URL="${base}"\nMANIFEST_URL="$DOWNLOAD_BASE_URL/manifests/$platform.json"\n`,
  'install.ps1': `$ErrorActionPreference = "Stop"\n$DOWNLOAD_BASE_URL = "${base}"\n$MANIFEST_URL = "$DOWNLOAD_BASE_URL/manifests/$platform.json"\n`,
  'install.cmd': `@echo off\nset "DOWNLOAD_BASE_URL=${base}"\nset "MANIFEST_URL=%DOWNLOAD_BASE_URL%/manifests/%PLATFORM%.json"\n`,
})
const fixtureOf = (scripts) => ({
  source: AGY_SCRIPTS_BASE,
  scripts: Object.fromEntries(Object.entries(scripts).map(([name, text]) => {
    const lines = text.split('\n')
    return [name, {
      bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex'),
      baseLine: lines[1].trim(), manifestLine: lines[2].trim(),
    }]
  })),
  platforms: [...AGY_PLATFORMS],
  manifestKeys: ['sha512', 'url', 'version'],
})
const manifest = (key, over = {}) => JSON.stringify({
  version: '1.5.15',
  url: `https://${AGY_DOWNLOAD_HOST}${AGY_DOWNLOAD_PATH}1.5.15-1/${key}/${key.startsWith('windows') ? 'agy.exe' : 'cli.tar.gz'}`,
  sha512: 'ab'.repeat(64),
  ...over,
})

// The network as the check sees it: scripts under AGY_SCRIPTS_BASE, manifests under the pin.
function world({ scripts = texts(), script = () => undefined, manifestOf = key => new Response(manifest(key)) } = {}) {
  const asked = []
  const fetch = async (url, options) => {
    asked.push(url)
    assert.equal(options.redirect, 'error')
    if (url.startsWith(AGY_SCRIPTS_BASE)) {
      const name = url.slice(AGY_SCRIPTS_BASE.length)
      return script(name) ?? new Response(scripts[name])
    }
    const key = url.slice(`${AGY_MANIFEST_BASE}/manifests/`.length, -'.json'.length)
    return manifestOf(key)
  }
  return { fetch, asked }
}

test('0: the scripts and the manifests are as a person last read them', async () => {
  const net = world()
  const { code, report } = await check({ fetch: net.fetch, fixture: fixtureOf(texts()) })
  assert.equal(code, 0)
  assert.equal(report.moved, false)
  assert.equal(report.changed, false)
  // The scripts are read first, then the 8 manifests.
  assert.deepEqual(net.asked.slice(0, 3), AGY_SCRIPTS.map(name => `${AGY_SCRIPTS_BASE}${name}`))
  assert.equal(net.asked.length, 3 + AGY_PLATFORMS.length)
})

test('2: a script that cannot be fetched gives no verdict, and no manifest is read', async () => {
  for (const script of [() => new Response('gone', { status: 404 }), () => { throw new TypeError('fetch failed') }]) {
    const net = world({ script: name => (name === 'install.ps1' ? script() : undefined) })
    const { code } = await check({ fetch: net.fetch, fixture: fixtureOf(texts()) })
    assert.equal(code, 2)
    assert.equal(net.asked.some(url => url.includes('/manifests/')), false)
  }
})

test('1: scripts that name another host are a move, even when the old manifests are gone', async () => {
  const moved = texts('https://new-host.example')
  const net = world({ scripts: moved, manifestOf: () => new Response('', { status: 404 }) })
  const { code, report } = await check({ fetch: net.fetch, fixture: fixtureOf(texts()) })
  assert.equal(code, 1)
  assert.equal(report.moved, true)
  // The base lines changed too: the changed issue is raised beside the move.
  assert.equal(report.changed, true)
})

test('1: a manifest gone at the pinned base, or naming a download outside the pin, is a move', async () => {
  for (const manifestOf of [
    key => (key === 'darwin_arm64' ? new Response('', { status: 410 }) : new Response(manifest(key))),
    key => new Response(manifest(key, key === 'linux_amd64' ? { url: 'https://elsewhere.example/agy.tar.gz' } : {})),
  ]) {
    const { code, report } = await check({ fetch: world({ manifestOf }).fetch, fixture: fixtureOf(texts()) })
    assert.equal(code, 1)
    assert.equal(report.moved, true)
    assert.equal(report.changed, false)
  }
})

test('2: a manifest that cannot be read (network, 5xx) gives no verdict', async () => {
  for (const manifestOf of [
    key => (key === 'windows_arm64' ? new Response('', { status: 503 }) : new Response(manifest(key))),
    key => { if (key === 'linux_arm64') throw new TypeError('fetch failed'); return new Response(manifest(key)) },
  ]) {
    const { code } = await check({ fetch: world({ manifestOf }).fetch, fixture: fixtureOf(texts()) })
    assert.equal(code, 2)
  }
})

test('3: a script whose bytes changed, or a manifest with a new field, is a change', async () => {
  const edited = { ...texts(), 'install.sh': `${texts()['install.sh']}# one more line\n` }
  const first = await check({ fetch: world({ scripts: edited }).fetch, fixture: fixtureOf(texts()) })
  assert.equal(first.code, 3)
  assert.deepEqual(first.report.scripts['install.sh'].differences, ['bytes', 'sha256'])
  const signed = await check({ fetch: world({ manifestOf: key => new Response(manifest(key, { signature: 'x' })) }).fetch, fixture: fixtureOf(texts()) })
  assert.equal(signed.code, 3)
  assert.equal(signed.report.manifests.linux_amd64.keysChanged, true)
  // The report is JSON: fetched text stays an escaped string.
  const odd = { ...texts(), 'install.cmd': `@echo off\nset "DOWNLOAD_BASE_URL=${AGY_MANIFEST_BASE}"\nset "MANIFEST_URL=%DOWNLOAD_BASE_URL%/manifests/\`$(x)\`.json"\n` }
  const strange = await check({ fetch: world({ scripts: odd }).fetch, fixture: fixtureOf(texts()) })
  assert.equal(strange.code, 3)
  assert.equal(JSON.parse(JSON.stringify(strange.report)).scripts['install.cmd'].manifestLine, 'set "MANIFEST_URL=%DOWNLOAD_BASE_URL%/manifests/`$(x)`.json"')
})
