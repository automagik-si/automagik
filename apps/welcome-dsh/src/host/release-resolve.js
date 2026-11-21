// Resolve missing plugins from their publishers' lanes. The signed pointer names a commit,
// and that commit's manifests say which versions and peers DSH will actually install.
// follow-omni.yml keeps the shared Omni pin at the newest Omni release on GitHub. A fresh install
// considers that pin and the signed lane, preferring plugins whose Omni server can be installed:
// npm's newest, or the pinned release the welcome builds from GitHub (omni-github.js).
import { randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { GENIE_PIN_CHOICE, GENIE_PLUGIN, GENIE_RELEASE, OMNI_PIN_CHOICE, OMNI_PLUGINS, OMNI_RELEASE, onPath } from './bot-types.js'
import { tarballDir, verifyLane } from './release-lane.js'
import { installationRoute, npmStatusOf, registryOf } from './omni-github.js'

export { registryOf }

const PUBLISHER_KEYS = JSON.parse(readFileSync(new URL('./publisher-keys.json', import.meta.url), 'utf8'))
const [botTeam, channels, canvas] = OMNI_PLUGINS
const RAW = 'https://raw.githubusercontent.com/automagik-si'
const OMNI_LANE = 'https://github.com/automagik-si/omni/releases/download/plugin-lane/lane.json'
const GENIE_LANE = `${RAW}/genie/lane/lane.json`
const OMNI_GITHUB = 'https://api.github.com/repos/automagik-si/omni/releases/latest'
const OMNI_NPM = '@automagik%2fomni'
const OMNI_VERSION = /^\d+\.\d{6}\.\d+$/
const COMMIT = /^[0-9a-f]{40}$/
const MAX_BODY = 64 * 1024
const MAX_GITHUB_RELEASE_BODY = 1024 * 1024
const SUCCESS_MS = 10 * 60_000
const FAILURE_MS = 60_000

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const numeric = (a, b) => order(BigInt(a), BigInt(b))
const compareCore = (a, b) => numeric(a[0], b[0]) || numeric(a[1], b[1]) || numeric(a[2], b[2])
const compareOmni = (a, b) => compareCore(a.split('.'), b.split('.'))

function semver(value) {
  if (typeof value !== 'string') return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i.exec(value)
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  return pre.some(part => /^0\d+$/.test(part)) ? null : { core: match.slice(1, 4), pre }
}

function compareIdentifier(a, b) {
  const aNumber = /^\d+$/.test(a)
  const bNumber = /^\d+$/.test(b)
  if (aNumber && bNumber) return numeric(a, b)
  if (aNumber !== bNumber) return aNumber ? -1 : 1
  return order(a, b)
}

export function compareVersions(a, b) {
  const left = semver(a)
  const right = semver(b)
  if (!left || !right) return NaN
  const core = compareCore(left.core, right.core)
  if (core) return core
  if (!left.pre.length || !right.pre.length) return order(right.pre.length, left.pre.length)
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const compared = compareIdentifier(left.pre[i], right.pre[i])
    if (compared) return compared
  }
  return order(left.pre.length, right.pre.length)
}

export function satisfies(version, range) {
  if (typeof range !== 'string') return false
  return range.trim().split(/\s+/).every((part) => {
    const match = /^(>=|<=|>|<|=)(.+)$/.exec(part)
    if (!match) return false
    const result = compareVersions(version, match[2])
    return { '>=': result >= 0, '<=': result <= 0, '>': result > 0, '<': result < 0, '=': result === 0 }[match[1]]
  })
}

const installed = (rows, name) => rows.find(row => row.name === name && row.availability !== 'missing')
const omniPresent = rows => [installed(rows, channels.name), installed(rows, canvas.name)].filter(Boolean)
const peerMet = (manifest, name, version) => !Object.hasOwn(manifest.peerDependencies ?? {}, name)
  || satisfies(version, manifest.peerDependencies[name])
const acceptsTeam = (manifest, team, dsh) => team !== null && dsh(manifest) && peerMet(manifest, botTeam.name, team)

export function orderedCandidates(candidates) {
  const commits = new Set()
  return [...candidates].sort((a, b) => compareOmni(b.release, a.release)).filter(({ commit }) => {
    if (commits.has(commit)) return false
    commits.add(commit)
    return true
  })
}

export function omniMinimum(manifest) {
  return /^>=\s*(\d+\.\d{6}\.\d+)(?:\s|$)/.exec(String(manifest.engines?.omni ?? '').trim())?.[1] ?? manifest.version
}

const packageOf = ({ name, version }) => ({ name, version })
const laneChoice = ({ from, release, commit, sequence }, manifests) => ({
  from, release, commit, ...(from === 'lane' ? { sequence } : {}), plugins: manifests.map(packageOf),
})

/**
 * A partial profile picks by its installed sibling. A fresh one prefers a server pair: plugins
 * whose minimum Omni is at most the newest server that can be installed, npm's (`server`) or
 * the pinned release built from GitHub (`buildable`).
 */
export function chooseOmni({ candidates, server, buildable, team, dsh, present }) {
  const viable = orderedCandidates(candidates).filter(({ manifests }) => {
    const pair = [manifests.channels, manifests.canvas]
    return (!present || pair.some(({ name, version }) => name === present.name && version === present.version))
      && pair.every(manifest => acceptsTeam(manifest, team, dsh))
      && peerMet(manifests.canvas, channels.name, manifests.channels.version)
  })
  const known = typeof server === 'string' && OMNI_VERSION.test(server)
  const builds = typeof buildable === 'string' && OMNI_VERSION.test(buildable)
  const installable = known && builds ? (compareOmni(server, buildable) >= 0 ? server : buildable) : known ? server : builds ? buildable : null
  const pairs = ({ manifests }) => {
    const minimum = omniMinimum(manifests.channels)
    return installable !== null && OMNI_VERSION.test(minimum) && compareOmni(minimum, installable) <= 0
  }
  const picked = (!present && installable !== null ? viable.find(pairs) : undefined) ?? viable[0]
  if (!picked) return { ...OMNI_PIN_CHOICE, ...(known ? { server } : {}) }
  return {
    ...laneChoice(picked, [picked.manifests.channels, picked.manifests.canvas]),
    ...(known ? { server, pair: pairs(picked) } : {}),
  }
}

export function chooseGenie({ candidate, team, dsh }) {
  const manifest = candidate?.manifest
  return manifest?.name === GENIE_PLUGIN.name
    && compareVersions(manifest.version, GENIE_RELEASE.version) >= 0
    && acceptsTeam(manifest, team, dsh)
    ? laneChoice(candidate, [manifest])
    : GENIE_PIN_CHOICE
}

export async function dshCheck(ctx) {
  const hasEngine = manifest => typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.trim() !== ''
  try {
    const loader = ctx?.get?.('loader')
    const loaded = await loader?.import?.('@deepseek-ai/dsh-app-boot')
    const appBoot = loader?.unwrapExports?.(loaded) ?? loaded?.default ?? loaded
    if (typeof appBoot?.evaluatePluginCompatibility !== 'function' || typeof appBoot?.getDshRuntimeVersion !== 'function') return hasEngine
    const version = appBoot.getDshRuntimeVersion()
    return (manifest) => {
      if (!hasEngine(manifest)) return false
      try { return appBoot.evaluatePluginCompatibility(manifest, {}, version) === undefined } catch { return true }
    }
  } catch { return hasEngine }
}

async function untilAbort(promise, signal) {
  if (!signal) return promise
  let listener
  try {
    const aborted = new Promise((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason))
    })
    return await Promise.race([aborted, promise])
  } finally {
    listener?.[Symbol.dispose]()
  }
}

export async function readBounded(response, max, signal) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty response body')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await untilAbort(reader.read(), signal)
      if (done) return Buffer.concat(chunks, size)
      size += value.byteLength
      if (size > max) throw new Error('Response body is too large')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const bytesOf = (response, signal, max = MAX_BODY) => {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`HTTP ${response.status}`)
  }
  return readBounded(response, max, signal)
}
const jsonOf = async (response, signal, max) => JSON.parse((await bytesOf(response, signal, max)).toString('utf8'))

// Readers validate each URL's result before caching it. Failed fetches, reads and validation
// get the shorter TTL, and concurrent callers share the same request.
function releaseRequests({ fetch, env, now, requestMs }) {
  const cached = new Map()
  const inFlight = new Map()
  const registry = registryOf(env)
  const get = async (url, signal, read) => {
    if (signal.aborted) return null
    const known = cached.get(url)
    if (known && now() < known.until) return known.value
    if (!inFlight.has(url)) {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(requestMs)])
      const request = Promise.resolve().then(async () => {
        requestSignal.throwIfAborted()
        const response = await untilAbort(fetch(url, { signal: requestSignal }), requestSignal)
        return read(response, requestSignal)
      }).catch(() => null).then((value) => {
        if (!signal.aborted) {
          const ttl = value === null || value === 404 ? FAILURE_MS : SUCCESS_MS
          cached.set(url, { value, until: now() + ttl })
        }
        return value
      }).finally(() => inFlight.delete(url))
      inFlight.set(url, request)
    }
    return untilAbort(inFlight.get(url), signal).catch(() => null)
  }
  const npmLatest = signal => get(`${registry}-/package/${OMNI_NPM}/dist-tags`, signal, async (response, requestSignal) => {
    const tags = await jsonOf(response, requestSignal)
    return typeof tags?.latest === 'string' && OMNI_VERSION.test(tags.latest) ? tags.latest : null
  })
  return { get, npmLatest, registry }
}

const laneFile = env => join(dirname(tarballDir(env)), 'lanes.json')
function takenOf(env) {
  try {
    const record = JSON.parse(readFileSync(laneFile(env), 'utf8'))
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid lane record')
    return record
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function sequenceAllowed(env, publisher, sequence) {
  try {
    const last = takenOf(env)[publisher]
    return last === undefined || (Number.isSafeInteger(last) && sequence >= last)
  } catch { return false }
}

function recordTaken(env, publisher, sequence) {
  if (!Object.hasOwn(PUBLISHER_KEYS, publisher) || !Number.isSafeInteger(sequence)) return
  const file = laneFile(env)
  const part = `${file}.${randomUUID()}.part`
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const taken = takenOf(env)
  taken[publisher] = Math.max(taken[publisher] ?? sequence, sequence)
  try {
    writeFileSync(part, `${JSON.stringify(taken)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(part, file)
  } finally {
    rmSync(part, { force: true })
  }
}

async function publisherLane(publisher, url, { get, env, signal, keys }) {
  const [bytes, sig] = await Promise.all([get(url, signal, bytesOf), get(`${url}.sig`, signal, bytesOf)])
  if (!bytes || !sig) return null
  try {
    const lane = verifyLane(bytes, sig, keys[publisher] ?? [])
    if (lane.publisher !== publisher || !Number.isSafeInteger(lane.sequence)
      || typeof lane.commit !== 'string' || !COMMIT.test(lane.commit)
      || !sequenceAllowed(env, publisher, lane.sequence)) return null
    return lane
  } catch { return null }
}

const loadManifest = (get, signal, repo, commit, path, name) => get(`${RAW}/${repo}/${commit}/${path}/package.json`, signal, async (response, requestSignal) => {
  const manifest = await jsonOf(response, requestSignal)
  return manifest?.name === name && semver(manifest.version) ? manifest : null
})

export function createReleases({ fetch = globalThis.fetch, env = process.env, now = Date.now, ctx, keys = PUBLISHER_KEYS, requestMs = 5000, resolutionMs = 20_000 } = {}) {
  const requests = releaseRequests({ fetch, env, now, requestMs })
  const { get, npmLatest } = requests
  let cachedOmni = null
  let cachedGenie = null

  async function omni(rows, team) {
    if (omniPresent(rows).length === 2) return null
    const signal = AbortSignal.timeout(resolutionMs)
    const options = { get, env, signal, keys }
    const readOmni = async (from, { version: release, commit, sequence }) => {
      const [channelsManifest, canvasManifest] = await Promise.all([channels, canvas].map(plugin =>
        loadManifest(get, signal, 'omni', commit, `apps/${plugin.dir}`, plugin.name)))
      return channelsManifest && canvasManifest
        ? { from, release, commit, sequence, manifests: { channels: channelsManifest, canvas: canvasManifest } }
        : null
    }
    const readLane = async () => {
      const lane = await publisherLane('omni', OMNI_LANE, options)
      return typeof lane?.version === 'string' && OMNI_VERSION.test(lane.version) ? readOmni('lane', lane) : null
    }
    const [server, lane, pin, dsh] = await Promise.all([
      npmLatest(signal), readLane(), readOmni('pin', OMNI_RELEASE),
      untilAbort(dshCheck(ctx), signal).catch(() => () => false),
    ])
    const rechoose = (current, currentTeam) => {
      const present = omniPresent(current)
      const candidates = [lane && sequenceAllowed(env, 'omni', lane.sequence) ? lane : null, pin].filter(Boolean)
      cachedOmni = present.length === 2 ? null : chooseOmni({ candidates, server, buildable: OMNI_RELEASE.version, team: currentTeam, dsh, present: present.length === 1 ? present[0] : null })
      return cachedOmni
    }
    return { ...rechoose(rows, team), rechoose }
  }

  async function genie(rows, team) {
    if (installed(rows, GENIE_PLUGIN.name)) return null
    const signal = AbortSignal.timeout(resolutionMs)
    const readLane = async () => {
      const lane = await publisherLane('genie', GENIE_LANE, { get, env, signal, keys })
      if (!semver(lane?.version) || !Array.isArray(lane.plugins) || lane.plugins.length !== 1 || lane.plugins[0]?.name !== GENIE_PLUGIN.name) return null
      const manifest = await loadManifest(get, signal, 'genie', lane.commit, GENIE_RELEASE.path, GENIE_PLUGIN.name)
      return manifest ? { from: 'lane', release: lane.version, commit: lane.commit, sequence: lane.sequence, manifest } : null
    }
    const [candidate, dsh] = await Promise.all([readLane(), untilAbort(dshCheck(ctx), signal).catch(() => () => false)])
    const rechoose = (current, currentTeam) => {
      const allowed = candidate && sequenceAllowed(env, 'genie', candidate.sequence) ? candidate : null
      cachedGenie = installed(current, GENIE_PLUGIN.name) ? null : chooseGenie({ candidate: allowed, team: currentTeam, dsh })
      return cachedGenie
    }
    return { ...rechoose(rows, team), rechoose }
  }

  return {
    omni, genie, cachedOmni: () => cachedOmni, cachedGenie: () => cachedGenie,
    recordTaken: (publisher, sequence) => recordTaken(env, publisher, sequence),
    checkOmniServer: omniServerCheck(requests, { env, resolutionMs }),
  }
}

export function createOmniServerCheck({ fetch = globalThis.fetch, env = process.env, now = Date.now, requestMs = 5000, ...options } = {}) {
  return omniServerCheck(releaseRequests({ fetch, env, now, requestMs }), { env, ...options })
}

function omniServerCheck({ get, npmLatest, registry }, {
  env, platform = process.platform, arch = process.arch, run, pin, resolutionMs = 20_000,
}) {
  return async (version, capability, available) => {
    if (capability !== true && platform === 'linux' && !onPath('systemctl', env)) return { ok: false, reason: 'no-systemd' }
    const signal = AbortSignal.timeout(resolutionMs)
    const status = await get(`${registry}${OMNI_NPM}/${version}`, signal, (response) => {
      // The status alone answers this lookup. There is no manifest to keep.
      void response.body?.cancel().catch(() => {})
      return response.status === 200 || response.status === 404 ? response.status : null
    })
    const releaseDetails = async () => Promise.all([
      npmLatest(signal),
      get(OMNI_GITHUB, signal, async (response, requestSignal) => {
        const release = await jsonOf(response, requestSignal, MAX_GITHUB_RELEASE_BODY)
        return typeof release?.tag_name === 'string' && release.tag_name !== '' ? release.tag_name : null
      }),
    ])
    if (capability !== true) {
      if (status === 200) return { ok: true }
      if (status !== 404) return { ok: true, unchecked: true }
      const [npm, github] = await releaseDetails()
      return { ok: false, reason: 'unpublished', version, npm, github }
    }
    const state = npmStatusOf(status)
    const { route, login, fallback } = await installationRoute({ V: version, npm: state, env, platform, arch, run, pin, available })
    if (route === 'terminal') return { ok: true, fallback, ...(state === 'unknown' ? { unchecked: true } : {}) }
    if (!login) return { ok: false, reason: 'no-systemd', version, npmHas: route === 'npm', fallback }
    const [npm, github] = await releaseDetails()
    return { ok: false, reason: state === 'published' ? 'behind' : 'unpublished', version, npm, github, fallback }
  }
}
