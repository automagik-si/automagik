// fetchPlugins against a stubbed fetch: every test reaches no host. The public release download
// can answer 200, a 4xx or a 5xx, time out or fail in transport; the REST API asset route lists
// and serves the same fixture, so the route that served each asset is checked as well as the
// size/sha512/sha256 guard the fetcher keeps.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { DEFAULT_PACKAGES, fetchPlugins } from '../fetch-plugins.mjs'

const VERSION = '3.108.0'
const TAG = `v${VERSION}`
const REPOSITORY = 'https://github.com/automagik-si/automagik'
const API = 'https://api.github.com/repos/automagik-si/automagik'
const CUSTOM_API = 'https://api.example.test/repos/automagik-si/automagik'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const fileName = (name) => `automagik-${name.slice('@automagik/'.length)}-${VERSION}.tgz`
const TARBALLS = Object.fromEntries(DEFAULT_PACKAGES.map((name, index) => [
  fileName(name),
  Buffer.from(`plugin ${name} tarball ${index}\n`),
]))
const PLUGINS = {
  version: VERSION,
  packages: Object.fromEntries(DEFAULT_PACKAGES.map((name) => {
    const file = fileName(name)
    return [name, {
      version: VERSION,
      file,
      size: TARBALLS[file].length,
      integrity: integrityOf(TARBALLS[file]),
    }]
  })),
}
const PLUGINS_BYTES = Buffer.from(`${JSON.stringify(PLUGINS, null, 2)}\n`)
const SUMS = Buffer.from([
  `${sha256(PLUGINS_BYTES)}  plugins.json`,
  ...Object.entries(TARBALLS).map(([file, bytes]) => `${sha256(bytes)}  ${file}`),
].join('\n') + '\n')
const FILES = { 'plugins.json': PLUGINS_BYTES, 'PLUGINS.SHA256SUMS': SUMS, ...TARBALLS }
const NAMES = Object.keys(FILES)

const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** A fetch-shaped answer for the stub; only ok/status/arrayBuffer are read. */
function reply(status, body = '') {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
}

/**
 * The stubbed GitHub: `<repository>/releases/download/<tag>/<name>` answers `publicStatus` (or
 * `publicFailure`), `<apiRoot>/releases/tags/<tag>` lists the fixture's assets and
 * `<apiRoot>/releases/assets/<name>` serves `apiFiles`. Every request is recorded.
 */
function fakeFetch({
  publicStatus = 200,
  apiStatus = 200,
  assetStatus = 200,
  files = FILES,
  apiFiles = files,
  publicFailure,
  apiFailure,
  apiRoot = API,
} = {}) {
  const requests = []
  const fetch = async (url, init = {}) => {
    const request = String(url)
    requests.push({ url: request, headers: init.headers ?? {} })
    const path = new URL(request).pathname
    const marker = `/releases/download/${TAG}/`
    const at = path.indexOf(marker)
    if (at >= 0) {
      if (publicFailure) throw publicFailure
      const name = decodeURIComponent(path.slice(at + marker.length))
      return publicStatus === 200 && files[name] ? reply(200, files[name]) : reply(publicStatus, 'public failed')
    }
    if (request === `${apiRoot}/releases/tags/${TAG}`) {
      if (apiFailure) throw apiFailure
      if (apiStatus !== 200) return reply(apiStatus, 'api failed')
      const assets = Object.keys(files).map((name) => ({
        name,
        url: `${apiRoot}/releases/assets/${encodeURIComponent(name)}`,
      }))
      return reply(200, JSON.stringify({ assets }))
    }
    if (request.startsWith(`${apiRoot}/releases/assets/`)) {
      if (assetStatus !== 200) return reply(assetStatus, 'asset failed')
      const name = decodeURIComponent(request.slice(`${apiRoot}/releases/assets/`.length))
      return apiFiles[name] ? reply(200, apiFiles[name]) : reply(404, 'missing asset')
    }
    throw new TypeError(`unexpected request: ${request}`)
  }
  return { fetch, requests }
}

/** Run one fetch into a temp folder, capturing the result, the error, logs and requests. */
async function run({ host = {}, repository = REPOSITORY, api, token = '', attempts = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fetch-plugins-test-'))
  temps.push(root)
  const out = join(root, 'vendor')
  const logs = []
  const fake = fakeFetch(host)
  let result
  let error
  try {
    result = await fetchPlugins({
      version: VERSION,
      out,
      repository,
      ...(api === undefined ? {} : { api }),
      token,
      fetch: fake.fetch,
      log: (line) => logs.push(line),
      attempts,
      retryDelay: 0,
      delay: async () => {},
    })
  } catch (caught) {
    error = caught
  }
  return { result, error, logs, requests: fake.requests, out }
}

const publicRequests = (r, repository = REPOSITORY) =>
  r.requests.filter(({ url }) => url.startsWith(`${repository}/releases/download/${TAG}/`))
const apiRequests = (r, apiRoot = API) => r.requests.filter(({ url }) => url.startsWith(`${apiRoot}/`))
const assetRequests = (r, apiRoot = API) =>
  r.requests.filter(({ url }) => url.startsWith(`${apiRoot}/releases/assets/`))
const tagRequests = (r, apiRoot = API) => r.requests.filter(({ url }) => url === `${apiRoot}/releases/tags/${TAG}`)

test('a 504 from the public download is served by the API asset route for every asset', async () => {
  const r = await run({ host: { publicStatus: 504 }, token: 'test-token' })
  assert.equal(r.error, undefined, r.error?.message)
  assert.equal(r.result.version, VERSION)
  assert.equal(r.logs.length, NAMES.length, 'one route line per asset')
  for (const name of NAMES) {
    assert.ok(r.logs.includes(`${name}: served by the REST API asset route`), `${name} names the API route`)
  }
  for (const [file, bytes] of Object.entries(TARBALLS)) {
    assert.deepEqual(readFileSync(join(r.out, file)), bytes, `${file} is the verified bytes`)
  }
  for (const name of DEFAULT_PACKAGES) {
    const file = PLUGINS.packages[name].file
    assert.equal(r.result.plugins[name].sha256, sha256(TARBALLS[file]), `${name}'s summary carries its sha256`)
  }
  assert.equal(tagRequests(r).length, 1, 'the API release metadata is read once')
  assert.equal(assetRequests(r).length, NAMES.length, 'every asset came from the API')
  assert.ok(apiRequests(r).every(({ headers }) => headers.Authorization === 'Bearer test-token'), 'GITHUB_TOKEN is the API bearer')
  assert.ok(tagRequests(r).every(({ headers }) => headers.Accept === 'application/vnd.github+json'), 'metadata asks for JSON')
  assert.ok(assetRequests(r).every(({ headers }) => headers.Accept === 'application/octet-stream'), 'assets ask for octet-stream')
  const publicCalls = publicRequests(r)
  assert.equal(publicCalls.length, NAMES.length * 2, 'the public route is tried twice before the fallback')
  assert.ok(publicCalls.every(({ headers }) => headers.Authorization === undefined), 'the token never reaches the public URL')
  assert.ok(!r.logs.join('\n').includes('test-token'), 'the token is never logged')
})

test('wrong bytes from the API asset route still fail the tarball integrity check', async () => {
  const file = PLUGINS.packages[DEFAULT_PACKAGES[0]].file
  const wrong = Buffer.from(TARBALLS[file])
  wrong[0] ^= 0xff
  const r = await run({ host: { publicStatus: 504, apiFiles: { ...FILES, [file]: wrong } } })
  assert.ok(r.error, 'the fetch refused the tarball')
  assert.match(r.error.message, /sha512 integrity does not match plugins\.json/)
  assert.ok(r.logs.includes(`${file}: served by the REST API asset route`), 'the bad bytes did come from the API')
  assert.equal(existsSync(join(r.out, file)), false, 'the unverified tarball was not written')
})

test('when both routes fail the error names both and nothing is written', async () => {
  const r = await run({ host: { publicStatus: 504, apiStatus: 503 } })
  assert.ok(r.error, 'the fetch failed')
  assert.match(r.error.message, /HTTP 504/, 'the public failure is reported')
  assert.match(r.error.message, /the API asset route failed too/, 'the fallback failure is reported')
  assert.match(r.error.message, /HTTP 503/, 'the API status is reported')
  assert.equal(existsSync(r.out), false, 'the output folder was never made')
  assert.equal(r.logs.length, 0, 'no route served an asset')
  assert.equal(publicRequests(r).length, 2, 'the public route retried once')
  assert.equal(tagRequests(r).length, 2, 'the API route retried once')
})

test('a public download that serves is used alone', async () => {
  const r = await run()
  assert.equal(r.error, undefined, r.error?.message)
  assert.equal(r.logs.length, NAMES.length, 'one route line per asset')
  for (const name of NAMES) {
    assert.ok(r.logs.includes(`${name}: served by the public release download`), `${name} names the public route`)
  }
  assert.equal(apiRequests(r).length, 0, 'the API was not needed')
  assert.equal(publicRequests(r).length, NAMES.length, 'one public request per asset')
  for (const [file, bytes] of Object.entries(TARBALLS)) {
    assert.deepEqual(readFileSync(join(r.out, file)), bytes, `${file} was written`)
  }
})

test('a 404 from the public download fails at once and never calls the API', async () => {
  const r = await run({ host: { publicStatus: 404 } })
  assert.ok(r.error, 'the fetch failed')
  assert.match(r.error.message, /\/plugins\.json: HTTP 404$/)
  assert.equal(publicRequests(r).length, 1, 'the 404 is not retried')
  assert.equal(apiRequests(r).length, 0, 'the API is not a fallback for a 404')
  assert.equal(r.logs.length, 0)
  assert.equal(existsSync(r.out), false)
})

test('a timeout on the public download falls back to the API asset route', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const r = await run({ host: { publicFailure: timeout } })
  assert.equal(r.error, undefined, r.error?.message)
  for (const name of NAMES) {
    assert.ok(r.logs.includes(`${name}: served by the REST API asset route`), `${name} names the API route`)
  }
  assert.equal(assetRequests(r).length, NAMES.length)
  assert.equal(publicRequests(r).length, NAMES.length * 2, 'the timeout is retried before the fallback')
})

test('a network error on the public download falls back to the API asset route', async () => {
  const r = await run({ host: { publicFailure: new TypeError('fetch failed') } })
  assert.equal(r.error, undefined, r.error?.message)
  assert.equal(r.logs.length, NAMES.length)
  for (const name of NAMES) {
    assert.ok(r.logs.includes(`${name}: served by the REST API asset route`), `${name} names the API route`)
  }
  assert.equal(assetRequests(r).length, NAMES.length)
})

test('a repository that is not github.com keeps the public route only', async () => {
  const repository = 'https://gitlab.com/automagik-si/automagik'
  const r = await run({ repository, host: { publicStatus: 504 } })
  assert.ok(r.error, 'the fetch failed')
  assert.match(r.error.message, /HTTP 504/)
  assert.equal(r.requests.length, 2, 'two public attempts and no invented API host')
  assert.ok(r.requests.every(({ url }) => url.startsWith(`${repository}/releases/download/${TAG}/`)))
})

test('an explicit api root overrides the one derived from the repository', async () => {
  const r = await run({ api: CUSTOM_API, host: { publicStatus: 504, apiRoot: CUSTOM_API } })
  assert.equal(r.error, undefined, r.error?.message)
  assert.equal(tagRequests(r, CUSTOM_API).length, 1)
  assert.equal(assetRequests(r, CUSTOM_API).length, NAMES.length)
  assert.equal(apiRequests(r, API).length, 0, 'the derived github.com root was not used')
})
