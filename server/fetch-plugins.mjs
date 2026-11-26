#!/usr/bin/env node
// Fetch the plugin tarballs a release carries, and prove they are the release's bytes before
// they reach the image. The release's plugins.json says what each tarball is and its sha512
// integrity and size; PLUGINS.SHA256SUMS says its sha256, and plugins.json's own sha256. Both
// come from the same immutable release, and the build refuses a tarball that fails either.
//
// Every asset comes from the public release-download URL first. When that fails with a 5xx, a
// timeout or a network error, it is retried a bounded number of times, then fetched through the
// REST API asset route (the one `gh release download` uses): GET
// /repos/<owner>/<repo>/releases/tags/<tag>, then the named asset's `url` as octet-stream. A 4xx
// is not retryable and fails at once. GITHUB_TOKEN is only ever an `Authorization: Bearer` header
// on API requests: never on the public download, never in a URL or a log line. Each asset logs
// one line naming the route that served it, and the checks below run on those bytes whichever
// route served them.
//
//   node fetch-plugins.mjs --version 3.160.6 --out vendor
//     [--repository https://github.com/automagik-si/automagik]
//     [--packages @automagik/bots-dsh,@automagik/welcome-dsh,@automagik/acp-dsh,@automagik/multiuser-dsh]
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PACKAGES = [
  '@automagik/bots-dsh', '@automagik/welcome-dsh', '@automagik/acp-dsh', '@automagik/multiuser-dsh',
]

const DEFAULT_REPOSITORY = 'https://github.com/automagik-si/automagik'
const PUBLIC_ROUTE = 'public release download'
const API_ROUTE = 'REST API asset route'

/** The sha256 a sum file names a file by, or undefined. */
export function sumOf(sums, file) {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line.trim())
    if (match && match[2] === file) return match[1]
  }
  return undefined
}

/** Refuse bytes that are not the release's: size, sha512 integrity, and the sum file's sha256. */
export function verifyTarball(bytes, entry, sha256) {
  if (bytes.byteLength !== entry.size) throw new Error(`${entry.file}: ${bytes.byteLength} bytes, not the release's ${entry.size}`)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== entry.integrity) throw new Error(`${entry.file}: sha512 integrity does not match plugins.json`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (!sha256) throw new Error(`${entry.file}: not in PLUGINS.SHA256SUMS`)
  if (digest !== sha256) throw new Error(`${entry.file}: sha256 does not match PLUGINS.SHA256SUMS`)
  return digest
}

/** An HTTP or transport failure; a 5xx, a timeout and a network error are retryable. */
class AssetError extends Error {
  constructor(url, { status, cause } = {}) {
    super(status === undefined ? `${url}: ${cause?.message ?? cause}` : `${url}: HTTP ${status}`)
    this.retryable = status === undefined || status >= 500
  }
}

/** One GET as bytes, following redirects; a timeout or network error is an AssetError. */
async function download(fetchImpl, url, headers, timeout) {
  let response
  try {
    response = await fetchImpl(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(timeout) })
  } catch (cause) {
    throw new AssetError(url, { cause })
  }
  if (!response.ok) throw new AssetError(url, { status: response.status })
  try {
    return Buffer.from(await response.arrayBuffer())
  } catch (cause) {
    throw new AssetError(url, { cause })
  }
}

/**
 * The same GET, retried on a retryable failure, with a short, bounded backoff (the caller's
 * `delay` so tests do not sleep). A 4xx is thrown unretried.
 */
async function downloadWithRetry(fetchImpl, url, headers, { timeout, attempts, retryDelay, delay }) {
  let failure
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await download(fetchImpl, url, headers, timeout)
    } catch (error) {
      if (!(error instanceof AssetError) || !error.retryable) throw error
      failure = error
      if (attempt < attempts) await delay(retryDelay * attempt)
    }
  }
  throw failure
}

/** The REST API root GitHub serves a github.com repository's releases at, or undefined. */
function apiRootOf(repository) {
  let url
  try { url = new URL(repository) } catch { return undefined }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined
  const [owner, repo] = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (!owner || !repo) return undefined
  return `https://api.github.com/repos/${owner}/${repo}`
}

/** The API headers: the release's metadata as JSON, an asset as its raw bytes, the token when set. */
const apiHeaders = (token, accept) => ({ Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) })

/**
 * A fetcher for one release's assets: the public URL first, a bounded retry on a retryable
 * failure, then the REST API asset route. The API's asset list is read once per fetcher; `log`
 * gets the one route line per asset. `api` is derived only for github.com (an explicit root
 * overrides it, and no root keeps the public route alone).
 */
function releaseAssets({
  repository,
  version,
  api,
  token,
  fetch: fetchImpl,
  log,
  timeout,
  attempts,
  retryDelay,
  delay,
}) {
  const tag = `v${version}`
  const base = `${repository.replace(/\/$/, '')}/releases/download/${tag}`
  const configured = api === undefined ? apiRootOf(repository) : api
  const root = typeof configured === 'string' && configured ? configured.replace(/\/$/, '') : undefined
  const release = { loaded: false, value: null }
  const retry = { timeout, attempts, retryDelay, delay }

  async function apiAsset(name) {
    if (!release.loaded) {
      const body = await downloadWithRetry(fetchImpl, `${root}/releases/tags/${encodeURIComponent(tag)}`,
        apiHeaders(token, 'application/vnd.github+json'), retry)
      try { release.value = JSON.parse(body.toString('utf8')) } catch { throw new Error(`the API's ${tag} release is not JSON`) }
      release.loaded = true
    }
    const assets = Array.isArray(release.value?.assets) ? release.value.assets : []
    const asset = assets.find((candidate) => candidate?.name === name)
    if (!asset?.url) throw new Error(`the API's ${tag} release has no asset named ${name}`)
    return downloadWithRetry(fetchImpl, asset.url, apiHeaders(token, 'application/octet-stream'), retry)
  }

  return {
    async get(name) {
      let publicError
      try {
        const bytes = await downloadWithRetry(fetchImpl, `${base}/${name}`, {}, retry)
        log(`${name}: served by the ${PUBLIC_ROUTE}`)
        return bytes
      } catch (error) {
        if (!(error instanceof AssetError) || !error.retryable) throw error
        publicError = error
      }
      if (!root) throw publicError
      try {
        const bytes = await apiAsset(name)
        log(`${name}: served by the ${API_ROUTE}`)
        return bytes
      } catch (apiError) {
        throw new Error(`${publicError.message}; the API asset route failed too: ${apiError.message}`)
      }
    },
  }
}

function argsOf(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${name} needs a value`)
    args[name.slice(2)] = value
    index += 1
  }
  return args
}

/**
 * Fetch one release's plugin assets into `out`, verifying each before it is written. The
 * optional `api` root overrides the one derived from a github.com repository; `token` defaults
 * to GITHUB_TOKEN and only rides API requests. `fetch`, `log`, `timeout`, `attempts`,
 * `retryDelay` and `delay` are injectable for tests.
 */
export async function fetchPlugins({
  version,
  out,
  repository = DEFAULT_REPOSITORY,
  packages = DEFAULT_PACKAGES,
  api,
  token = process.env.GITHUB_TOKEN ?? '',
  fetch: fetchImpl = globalThis.fetch,
  log = console.log,
  timeout = 120_000,
  attempts = 2,
  retryDelay = 250,
  delay = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a release version: ${version}`)
  if (!/^https:\/\/[\w.-]+(?:\/[\w.-]+)+\/?$/.test(repository)) throw new Error(`not an https repository URL: ${repository}`)
  const tries = Number.isInteger(attempts) && attempts > 0 ? attempts : 1
  const source = releaseAssets({ repository, version, api, token, fetch: fetchImpl, log, timeout, attempts: tries, retryDelay, delay })
  const pluginsBytes = await source.get('plugins.json')
  const sums = (await source.get('PLUGINS.SHA256SUMS')).toString('utf8')
  const pluginsSum = sumOf(sums, 'plugins.json')
  if (!pluginsSum) throw new Error('PLUGINS.SHA256SUMS does not list plugins.json')
  const pluginsDigest = createHash('sha256').update(pluginsBytes).digest('hex')
  if (pluginsDigest !== pluginsSum) throw new Error('plugins.json: sha256 does not match PLUGINS.SHA256SUMS')
  const plugins = JSON.parse(pluginsBytes.toString('utf8'))
  if (plugins.version !== version) throw new Error(`plugins.json is for ${plugins.version}, not ${version}`)
  mkdirSync(out, { recursive: true })
  const fetched = {}
  for (const name of packages) {
    const entry = plugins.packages?.[name]
    if (!entry) throw new Error(`plugins.json lists no ${name}`)
    if (entry.version !== version) throw new Error(`${name} is ${entry.version}, not ${version}`)
    if (!/^[^/]+\.tgz$/.test(entry.file)) throw new Error(`${name}: unexpected file name ${entry.file}`)
    const bytes = await source.get(entry.file)
    const sha256 = verifyTarball(bytes, entry, sumOf(sums, entry.file))
    writeFileSync(join(out, entry.file), bytes, { mode: 0o644 })
    fetched[name] = { file: entry.file, version: entry.version, size: entry.size, sha256 }
  }
  return { version, plugins: fetched }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = argsOf(process.argv.slice(2))
    if (!args.version || !args.out) throw new Error('usage: node fetch-plugins.mjs --version <v> --out <dir> [--repository <url>] [--packages <a,b>]')
    const fetched = await fetchPlugins({
      version: args.version,
      out: args.out,
      repository: args.repository,
      packages: args.packages ? args.packages.split(',').map((name) => name.trim()).filter(Boolean) : DEFAULT_PACKAGES,
    })
    for (const [name, entry] of Object.entries(fetched.plugins)) console.log(`${name} ${entry.version} ${entry.file} ${entry.size} bytes sha256=${entry.sha256}`)
  } catch (error) {
    console.error(`fetch-plugins: ${error?.message ?? error}`)
    process.exit(1)
  }
}
