// Independent cover for #801: a degraded public release-download URL must not fail the server
// image build. Every asset (plugins.json, PLUGINS.SHA256SUMS and each tarball) is retried and
// then served by the REST API asset route, and the existing checks still guard the bytes.
// Stubbed fetch only: no live network, no real release bytes, no credentials.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fetchPlugins } from '../fetch-plugins.mjs'

const VERSION = '3.108.0'
const TAG = `v${VERSION}`
const REPOSITORY = 'https://github.com/example-org/example-repo'
const PUBLIC_BASE = `${REPOSITORY}/releases/download/${TAG}`
const API_ROOT = 'https://api.github.com/repos/example-org/example-repo'
const TOKEN = 'fixture-token-not-a-real-credential'
const PUBLIC_ROUTE = 'public release download'
const API_ROUTE = 'REST API asset route'
const PACKAGES = ['@automagik/bots-dsh', '@automagik/welcome-dsh', '@automagik/acp-dsh', '@automagik/multiuser-dsh']

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const fileFor = (name) => `${name.slice(1).replaceAll('/', '-')}-${VERSION}.tgz`

/** Deterministic fixtures built from pieces; nothing here is a real release artifact. */
function buildRelease() {
  const files = new Map()
  for (const [index, name] of PACKAGES.entries()) {
    files.set(fileFor(name), Buffer.concat([
      Buffer.from(`fixture tarball ${index} for ${name}\n`),
      Buffer.from([0x1f, 0x8b, 0x08, 0x00, index, 0x00, 0x00]),
      Buffer.from(`release ${TAG}\n`),
    ]))
  }
  const packages = {}
  for (const name of PACKAGES) {
    const file = fileFor(name)
    const bytes = files.get(file)
    packages[name] = { version: VERSION, file, size: bytes.byteLength, integrity: sha512(bytes) }
  }
  const plugins = Buffer.from(`${JSON.stringify({ version: VERSION, packages }, null, 2)}\n`)
  const sums = Buffer.from([
    `${sha256(plugins)}  plugins.json`,
    ...[...files].map(([file, bytes]) => `${sha256(bytes)}  ${file}`),
  ].join('\n') + '\n')
  const assets = new Map([['plugins.json', plugins], ['PLUGINS.SHA256SUMS', sums], ...files])
  const assetUrls = new Map([...assets.keys()].map((name, index) => [
    name,
    `${API_ROOT}/releases/assets/${index + 100}`,
  ]))
  return { assets, assetUrls, files, packages }
}

const RELEASE = buildRelease()

/** A Response-shaped success; the fetcher only reads `ok`, `status` and `arrayBuffer`. */
const ok = (bytes) => ({ ok: true, status: 200, arrayBuffer: async () => bytes })
const httpStatus = (code) => ({ ok: false, status: code })

/** Records every request so a row can prove which route served each asset, and with what. */
function recordingFetch(handler) {
  const calls = []
  const fetch = async (input, init = {}) => {
    const call = { url: String(input), headers: init.headers ?? {} }
    calls.push(call)
    return handler(call)
  }
  return { calls, fetch }
}

function publicHandler({ failure, status: code = 200, bytes = RELEASE.assets } = {}) {
  return (call) => {
    const prefix = `${PUBLIC_BASE}/`
    const name = call.url.startsWith(prefix) ? call.url.slice(prefix.length) : ''
    if (!name || !bytes.has(name)) throw new Error(`unexpected public request: ${call.url}`)
    if (failure) throw failure()
    if (code !== 200) return httpStatus(code)
    return ok(bytes.get(name))
  }
}

function apiHandler({ releaseStatus = 200, bytes = RELEASE.assets } = {}) {
  return (call) => {
    if (call.url === `${API_ROOT}/releases/tags/${TAG}`) {
      if (releaseStatus !== 200) return httpStatus(releaseStatus)
      const assets = [...RELEASE.assets.keys()].map((name) => ({
        name,
        url: RELEASE.assetUrls.get(name),
      }))
      return ok(Buffer.from(JSON.stringify({ tag_name: TAG, assets })))
    }
    for (const [name, url] of RELEASE.assetUrls) {
      if (call.url === url) return ok(bytes.get(name))
    }
    throw new Error(`unexpected API request: ${call.url}`)
  }
}

const API_FORBIDDEN = (call) => {
  throw new Error(`the API route must not be called: ${call.url}`)
}

const timeoutError = () => Object.assign(
  new Error('The operation was aborted due to timeout'),
  { name: 'TimeoutError' },
)
const networkError = () => new TypeError('fetch failed')

function makeFetch({ public: publicOptions = {}, api = apiHandler() } = {}) {
  const servePublic = publicHandler(publicOptions)
  return recordingFetch((call) => (
    call.url.startsWith(`${PUBLIC_BASE}/`) ? servePublic(call) : api(call)
  ))
}

/**
 * The dev fetcher (the fail-before baseline) ignores the injected `fetch` option and calls the
 * global, so point both at the stub: the PR head uses the option, the overlay stays offline.
 */
async function run(out, options = {}) {
  const original = globalThis.fetch
  globalThis.fetch = options.fetch
  try {
    return await fetchPlugins({
      version: VERSION,
      out,
      repository: REPOSITORY,
      api: API_ROOT,
      token: '',
      attempts: 2,
      retryDelay: 0,
      delay: async () => {},
      ...options,
    })
  } finally {
    globalThis.fetch = original
  }
}

function tempOut(t) {
  const out = mkdtempSync(join(tmpdir(), 'fetch-plugins-independent-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  return out
}

/** The API route served every asset after the public URL's bounded retry, one line each. */
function assertServedByApi(logs, calls) {
  const routeLines = logs.filter((line) => line.includes(API_ROUTE))
  assert.equal(routeLines.length, RELEASE.assets.size)
  assert.equal(logs.filter((line) => line.includes(PUBLIC_ROUTE)).length, 0)
  for (const name of RELEASE.assets.keys()) {
    const named = routeLines.filter((line) => line.includes(name))
    assert.equal(named.length, 1, `one API route line names ${name}`)
    assert.ok(!named[0].includes(PUBLIC_ROUTE))
    assert.equal(
      calls.filter((call) => call.url === `${PUBLIC_BASE}/${name}`).length,
      2,
      `${name}: the public URL is tried twice before the fallback`,
    )
    assert.equal(
      calls.filter((call) => call.url === RELEASE.assetUrls.get(name)).length,
      1,
      `${name}: served once by the API asset route`,
    )
  }
}

function assertTokenOnlyOnApi(calls, token) {
  for (const call of calls) {
    if (call.url.startsWith(`${API_ROOT}/`)) {
      assert.equal(call.headers.Authorization, `Bearer ${token}`)
    } else {
      assert.equal(call.headers.Authorization, undefined)
      assert.ok(!call.url.includes(token))
      for (const value of Object.values(call.headers)) assert.ok(!String(value).includes(token))
    }
  }
}

function assertVerified(out, result) {
  assert.deepEqual(readdirSync(out).sort(), [...RELEASE.files.keys()].sort())
  for (const [file, bytes] of RELEASE.files) {
    assert.deepEqual(readFileSync(join(out, file)), bytes)
  }
  const plugins = {}
  for (const name of PACKAGES) {
    const entry = RELEASE.packages[name]
    plugins[name] = {
      file: entry.file,
      version: VERSION,
      size: entry.size,
      sha256: sha256(RELEASE.files.get(entry.file)),
    }
  }
  assert.deepEqual(result, { version: VERSION, plugins })
}

function assertNothingWritten(out) {
  if (!existsSync(out)) return
  assert.deepEqual(readdirSync(out), [])
}

test('public 504 on every asset falls back to the REST API asset route', async (t) => {
  const out = tempOut(t)
  const logs = []
  const stub = makeFetch({ public: { status: 504 }, api: apiHandler() })
  const result = await run(out, {
    fetch: stub.fetch,
    log: (line) => logs.push(line),
    token: TOKEN,
  })
  assertServedByApi(logs, stub.calls)
  assertTokenOnlyOnApi(stub.calls, TOKEN)
  assertVerified(out, result)
})

test('a public timeout falls back to the REST API asset route', async (t) => {
  const out = tempOut(t)
  const logs = []
  const stub = makeFetch({ public: { failure: timeoutError }, api: apiHandler() })
  const result = await run(out, { fetch: stub.fetch, log: (line) => logs.push(line) })
  assertServedByApi(logs, stub.calls)
  assertVerified(out, result)
})

test('a public network error falls back to the REST API asset route', async (t) => {
  const out = tempOut(t)
  const logs = []
  const stub = makeFetch({ public: { failure: networkError }, api: apiHandler() })
  const result = await run(out, { fetch: stub.fetch, log: (line) => logs.push(line) })
  assertServedByApi(logs, stub.calls)
  assertVerified(out, result)
})

test('API-served bytes that fail the checksum are refused and nothing is written', async (t) => {
  const out = tempOut(t)
  const logs = []
  const file = RELEASE.packages[PACKAGES[0]].file
  const damaged = Buffer.from(RELEASE.files.get(file))
  damaged[damaged.length - 1] ^= 0xff
  const bytes = new Map(RELEASE.assets)
  bytes.set(file, damaged)
  const stub = makeFetch({ public: { status: 504 }, api: apiHandler({ bytes }) })
  await assert.rejects(
    run(out, { fetch: stub.fetch, log: (line) => logs.push(line) }),
    (error) => {
      assert.ok(error.message.includes(file), `the error names ${file}`)
      assert.match(error.message, /sha512 integrity does not match plugins\.json/)
      return true
    },
  )
  assert.ok(stub.calls.some((call) => call.url === RELEASE.assetUrls.get(file)))
  assertNothingWritten(out)
})

test('both routes failing names both routes and writes nothing', async (t) => {
  const out = tempOut(t)
  const stub = makeFetch({ public: { status: 504 }, api: apiHandler({ releaseStatus: 503 }) })
  await assert.rejects(
    run(out, { fetch: stub.fetch, log: () => {} }),
    (error) => {
      assert.ok(error.message.includes(`${PUBLIC_BASE}/plugins.json`))
      assert.ok(error.message.includes(`${API_ROOT}/releases/tags/${TAG}`))
      assert.match(error.message, /API asset route/i)
      return true
    },
  )
  assertNothingWritten(out)
})

test('public success never calls the API route', async (t) => {
  const out = tempOut(t)
  const stub = makeFetch({ api: API_FORBIDDEN })
  const result = await run(out, { fetch: stub.fetch, log: () => {} })
  assert.equal(stub.calls.length, RELEASE.assets.size)
  assert.equal(stub.calls.filter((call) => call.url.startsWith(`${API_ROOT}/`)).length, 0)
  assertVerified(out, result)
})

test('a public 404 fails at once with no API fallback', async (t) => {
  const out = tempOut(t)
  const stub = makeFetch({ public: { status: 404 }, api: API_FORBIDDEN })
  await assert.rejects(
    run(out, { fetch: stub.fetch, log: () => {} }),
    (error) => {
      assert.match(error.message, /HTTP 404/)
      return true
    },
  )
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].url, `${PUBLIC_BASE}/plugins.json`)
  assertNothingWritten(out)
})

test('GITHUB_TOKEN rides only on API requests and never reaches the logs', async (t) => {
  const out = tempOut(t)
  const logs = []
  const previous = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = TOKEN
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previous
  })
  const stub = makeFetch({ public: { status: 504 }, api: apiHandler() })
  const result = await run(out, {
    fetch: stub.fetch,
    log: (line) => logs.push(line),
    token: undefined,
  })
  assertServedByApi(logs, stub.calls)
  assertVerified(out, result)
  const apiCalls = stub.calls.filter((call) => call.url.startsWith(`${API_ROOT}/`))
  const publicCalls = stub.calls.filter((call) => !call.url.startsWith(`${API_ROOT}/`))
  assert.equal(apiCalls.length, RELEASE.assets.size + 1)
  for (const call of apiCalls) assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`)
  for (const call of publicCalls) {
    assert.equal(call.headers.Authorization, undefined)
    assert.ok(!call.url.includes(TOKEN))
    for (const value of Object.values(call.headers)) {
      assert.ok(!String(value).includes(TOKEN))
    }
  }
  assert.ok(!logs.join('\n').includes(TOKEN))
})
