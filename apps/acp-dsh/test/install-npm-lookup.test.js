// npm reads config in a fresh package folder; the registry answers through fetch.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { AdapterStore, registryUnreachable } from '../src/host/install.js'

const PKG = '@example/connector'
const ENDPOINT = '/@example%2Fconnector/latest'
const PUBLIC = 'https://registry.npmjs.org'
const CUSTOM = 'https://scope.example'
const GLOBAL = 'https://global.example'
const publicUrl = `${PUBLIC}${ENDPOINT}`
const customUrl = `${CUSTOM}${ENDPOINT}`
const scoped = (scope, global = PUBLIC) => `registry=${global}/\n@example:registry=${scope}`
const posix = { skip: process.platform === 'win32' }
const published = (version = '1.2.3') => Response.json({ version })

function fixture(t, { output = scoped(CUSTOM), exit = 0, wait = false, fetch = () => published() } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'acp-npm-lookup-')))
  const args = join(root, 'args')
  const cwd = join(root, 'cwd')
  const ready = join(root, 'ready')
  const env = { PATH: root, NPM_ARGS: args, NPM_CWD: cwd, NPM_READY: ready, NPM_OUTPUT: output, NPM_EXIT: String(exit), NPM_WAIT: wait ? '1' : '0' }
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(join(root, 'npm'), `#!/bin/sh
printf '%s\n' "$@" >> "$NPM_ARGS"
[ "$1" = config ] && [ "$2" = get ] && [ -f package.json ] || exit 2
printf '%s\n' "$PWD" > "$NPM_CWD"
: > "$NPM_READY"
printf '%s\n' "$NPM_OUTPUT"
if [ "$NPM_WAIT" = 1 ]; then exec /bin/sleep 5; fi
exit "$NPM_EXIT"
`, { mode: 0o700 })
  const urls = []
  globalThis.fetch = (url, options) => {
    urls.push(url)
    return fetch(url, options)
  }
  const store = new AdapterStore({ home: join(root, 'adapters'), env })
  return {
    store, urls, ready,
    cwd: () => readFileSync(cwd, 'utf8').trim(),
    args: () => readFileSync(args, 'utf8').trimEnd().split('\n'),
  }
}

function assertConfig(f, { scoped = true } = {}) {
  assert.deepEqual(f.args(), ['config', 'get', 'registry', ...(scoped ? ['@example:registry'] : [])])
  assert.equal(existsSync(f.cwd()), false)
  assert.equal(f.store.installing.size, 0)
}

test('the default npm registry uses one public fetch', posix, async t => {
  const f = fixture(t, { output: scoped(`${PUBLIC}/`) })
  assert.equal(await f.store.lookupLatest(PKG, {}), '1.2.3')
  assert.deepEqual(f.urls, [publicUrl])
  assertConfig(f)
})

test('a scoped npm registry takes precedence and supplies the version', posix, async t => {
  const f = fixture(t, { output: scoped(CUSTOM, GLOBAL), fetch: () => published('2.3.4-beta.1+build.2') })
  assert.equal(await f.store.lookupLatest(PKG, {}), '2.3.4-beta.1+build.2')
  assert.deepEqual(f.urls, [customUrl])
  assertConfig(f)
})

test('a path-mounted npm registry keeps its path in the latest endpoint', posix, async t => {
  const f = fixture(t, { output: scoped(`${CUSTOM}/npm/private/`) })
  assert.equal(await f.store.lookupLatest(PKG, {}), '1.2.3')
  assert.deepEqual(f.urls, [`${CUSTOM}/npm/private${ENDPOINT}`])
  assertConfig(f)
})

for (const [answer, fetch] of [
  ...[401, 403, 404].map(status => [`HTTP ${status}`, () => new Response('', { status })]),
  ['unparseable JSON', () => new Response('junk')],
  ['a non-exact version', () => published('2.3.4 junk')],
  ['a transport rejection with a status', () => Promise.reject(Object.assign(new Error('fetch failed'), { status: 403 }))],
]) {
  test(`npm lookup falls back to one public fetch after ${answer}`, posix, async t => {
    const f = fixture(t, { fetch: url => url === customUrl ? fetch() : published() })
    assert.equal(await f.store.lookupLatest(PKG, {}), '1.2.3')
    assert.deepEqual(f.urls, [customUrl, publicUrl])
    assertConfig(f)
  })
}

test('public registry HTTP 401 keeps its error after a custom registry failure', posix, async t => {
  const f = fixture(t, { fetch: url => new Response('', { status: url === customUrl ? 403 : 401 }) })
  await assert.rejects(f.store.lookupLatest(PKG, {}), { message: `npm answered 401 for ${PKG}` })
  assert.deepEqual(f.urls, [customUrl, publicUrl])
  assertConfig(f)
})

for (const [config, output, exit] of [
  ['npm exits 1', scoped(CUSTOM), 1],
  ['the URL has userinfo', scoped('https://user:secret@scope.example')],
  ['the scoped URL is malformed', scoped('not a URL', GLOBAL)],
  ['the scoped URL has a query', scoped(`${CUSTOM}?key=value`, GLOBAL)],
  ['the scoped URL has a fragment', scoped(`${CUSTOM}#private`, GLOBAL)],
]) {
  test(`npm lookup uses the public registry when ${config}`, posix, async t => {
    const f = fixture(t, { output, exit })
    assert.equal(await f.store.lookupLatest(PKG, {}), '1.2.3')
    assert.deepEqual(f.urls, [publicUrl])
    assertConfig(f)
  })
}

for (const value of ['undefined', '']) {
  test(`npm lookup uses the global registry when the scoped value is ${value || 'empty'}`, posix, async t => {
    const f = fixture(t, { output: scoped(value, GLOBAL) })
    assert.equal(await f.store.lookupLatest(PKG, {}), '1.2.3')
    assert.deepEqual(f.urls, [`${GLOBAL}${ENDPOINT}`])
    assertConfig(f)
  })
}

test('unscoped packages ask for just registry and use the bare URL', posix, async t => {
  const f = fixture(t, { output: `  ${GLOBAL}/\n` })
  assert.equal(await f.store.lookupLatest('connector', {}), '1.2.3')
  assert.deepEqual(f.urls, [`${GLOBAL}/connector/latest`])
  assertConfig(f, { scoped: false })
})

function quitting(error) {
  assert.equal(error.message, 'install stopped: DSH is quitting')
  assert.equal(registryUnreachable(error), undefined)
  return true
}

test('aborting during config stops npm, cleans up and makes no fetch', posix, async t => {
  const f = fixture(t, { wait: true })
  const stop = new AbortController()
  const lookup = f.store.lookupLatest(PKG, { signal: stop.signal })
  const ready = async () => {
    const deadline = Date.now() + 4000
    while (!existsSync(f.ready) && Date.now() < deadline) await delay(10)
  }
  try {
    await Promise.race([lookup, ready()])
    assert.ok(existsSync(f.ready), 'npm started its config read')
    assert.ok(f.store.installing.has(f.cwd()))
  } finally {
    stop.abort()
  }
  await assert.rejects(lookup, quitting)
  assert.deepEqual(f.urls, [])
  assertConfig(f)
})

test('aborting during a custom registry fetch makes no public fetch', posix, async t => {
  const fetching = Promise.withResolvers()
  const reply = Promise.withResolvers()
  const f = fixture(t, { fetch: (url, { signal }) => {
    if (url !== customUrl) return published()
    fetching.resolve(signal)
    return reply.promise
  } })
  const stop = new AbortController()
  const lookup = f.store.lookupLatest(PKG, { signal: stop.signal })
  const signal = await Promise.race([lookup, fetching.promise])
  stop.abort()
  reply.resolve(published())
  await assert.rejects(lookup, quitting)
  assert.equal(signal.aborted, true)
  assert.deepEqual(f.urls, [customUrl])
  assertConfig(f)
})

test('the update caller installs the exact version selected through the scoped npm registry', posix, async t => {
  const { mkdirSync } = await import('node:fs')
  const f = fixture(t, { fetch: () => published('4.5.6') })
  const installed = []
  f.store.install = async (dir, pkg, version) => {
    installed.push([pkg, version])
    const folder = join(dir, 'node_modules', '@example', 'connector', 'dist')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'index.js'), '// fake adapter\n')
  }
  const result = await f.store.update(PKG, 'dist/index.js')
  assert.equal(result.version, '4.5.6')
  assert.deepEqual(installed, [[PKG, '4.5.6']])
  assert.deepEqual(f.urls, [customUrl])
  assertConfig(f)
})
