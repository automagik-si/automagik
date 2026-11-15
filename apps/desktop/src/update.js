// Updates: the app follows its own releases, `v<version>` in automagik-si/automagik on
// GitHub (the ones `omni desktop` downloads). Builds released from automagik-dev/omni-desktop
// (up to 2.261023.x) reach these through that repository's last release, which is this app. A newer one downloads in the background and installs when
// the app quits, or at once from the title bar's Restart now. electron-updater downloads
// it, checks its sha512 and installs it (on macOS through Squirrel, which also requires the
// update to carry the running app's signature; on Windows by running the release's NSIS
// installer, which checks a signature only once the app names a publisher, see
// electron-builder.yml `win`). This module picks the release: the newest
// one above this version, on this build's channel, that carries this platform's feed.
// A deb is the system package manager's to replace, so there the app only says a release is out.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RELEASES_URL = 'https://api.github.com/repos/automagik-si/automagik/releases?per_page=50'
export const DESKTOP_TAG_PREFIX = 'v'
const DOWNLOADS = 'https://github.com/automagik-si/automagik/releases/download/'
const RELEASE_PAGE = 'https://github.com/automagik-si/automagik/releases/tag/'
export const FIRST_CHECK_MS = 20_000
// The app and plugin lanes share the same recurring check interval.
export const CHECK_EVERY_MS = 15 * 60_000
export const RETRY_MS = 30 * 60 * 1000
// A network that changed or dropped during a check (Wi-Fi, a VPN, waking from sleep) is usually
// back within a minute: such a failure is retried that soon, a few times, before RETRY_MS.
export const QUICK_RETRY_MS = 60 * 1000
export const QUICK_RETRIES = 3

// fetchReleases's own failure text, so a releases API outage is retried soon instead of after
// RETRY_MS. A 5xx or 429 is worth a minute; another 4xx (a bad token, a moved endpoint) is not.
const GITHUB_STATUS = /GitHub answered (\d+) for the desktop releases/

/** Whether a failure is worth retrying within a minute: the network changed, or GitHub's releases API was briefly unavailable or rate-limited. */
export function isTransient(error) {
  const message = String(error?.message ?? error ?? '')
  if (/net::ERR_|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH/.test(message)) return true
  const status = Number(GITHUB_STATUS.exec(message)?.[1])
  return status === 429 || (status >= 500 && status <= 599)
}

// electron-updater's own words for an update that is not what its release says: a sha512 that
// does not match (ERR_CHECKSUM_MISMATCH), an installer its publisher did not sign
// (ERR_UPDATER_INVALID_SIGNATURE, Windows), or a bundle macOS's Squirrel turns down.
const UNVERIFIED = /checksum mismatch|code signature|not signed by|ERR_CHECKSUM_MISMATCH|ERR_UPDATER_INVALID_SIGNATURE/i

/** Whether a failure says the downloaded update could not be verified (its hash or its signature). */
export function isVerification(error) {
  const code = String(error?.code ?? '')
  if (code === 'ERR_CHECKSUM_MISMATCH' || code === 'ERR_UPDATER_INVALID_SIGNATURE') return true
  return UNVERIFIED.test(String(error?.message ?? error ?? ''))
}

/** The update feed electron-updater reads for `platform`, or null where the app does not update. */
export function feedFileOf(platform) {
  if (platform === 'darwin') return 'latest-mac.yml'
  if (platform === 'linux') return 'latest-linux.yml'
  if (platform === 'win32') return 'latest.yml'
  return null
}

/**
 * How this copy of the app updates: `auto` (a packaged build on macOS or Windows, or run from
 * an AppImage), `notify` (a packaged Linux build installed from the deb, which belongs to the
 * system's package manager: the app only says a release is out), or null (a dev run, another
 * platform, or OMNI_DESKTOP_UPDATES=off).
 */
export function updateMode({ packaged, platform, env }) {
  if (!packaged || env.OMNI_DESKTOP_UPDATES === 'off') return null
  if (platform === 'darwin' || platform === 'win32') return 'auto'
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'notify'
  return null
}

/** Whether this copy of the app replaces itself (see updateMode). */
export function updatesEnabled(options) {
  return updateMode(options) === 'auto'
}

/**
 * The channel this build follows: OMNI_DESKTOP_UPDATE_CHANNEL (`stable` or `prerelease`), else
 * the channel of its own release, else stable. A stable build never moves to a prerelease.
 */
export function channelOf(releases, { current, env = {} }) {
  const wanted = env.OMNI_DESKTOP_UPDATE_CHANNEL?.trim()
  if (wanted === 'stable' || wanted === 'prerelease') return wanted
  const own = (Array.isArray(releases) ? releases : []).find(release => release?.tag_name === `${DESKTOP_TAG_PREFIX}${current}`)
  return own?.prerelease === true ? 'prerelease' : 'stable'
}

/** OMNI_DESKTOP_UPDATE_FEED: a feed folder to take updates from instead (https, or http on loopback). */
export function feedOverride(env) {
  const raw = env.OMNI_DESKTOP_UPDATE_FEED?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.href.endsWith('/') ? url.href : `${url.href}/`
  } catch {}
  return null
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Semver precedence: negative when `a` is older than `b`, 0 when equal, NaN when either is not a version. */
export function compareVersions(a, b) {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return Number.NaN
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return Math.sign(d)
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0
  const p = x[4].split('.')
  const q = y[4].split('.')
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue
    const pn = /^\d+$/.test(p[i])
    const qn = /^\d+$/.test(q[i])
    if (pn && qn) return Math.sign(Number(p[i]) - Number(q[i]))
    if (pn !== qn) return pn ? -1 : 1
    return p[i] < q[i] ? -1 : 1
  }
  return Math.sign(p.length - q.length)
}

const ARCHITECTURES = new Set(['mac', 'darwin', 'win', 'windows', 'linux', 'arm64', 'x64', 'x86_64', 'ia32', 'universal', 'amd64', 'armv7l', 'arm', 'x86'])

/**
 * The version in an updater artifact name: `Automagik-3.95.0-mac-arm64.zip`,
 * `Automagik-3.95.0-linux-x86_64.AppImage` and `Automagik Setup 3.95.0.exe` are 3.95.0,
 * `Automagik-3.95.0-labs.1-mac-arm64.zip` is 3.95.0-labs.1. Null when the name carries no
 * version.
 */
export function versionFromArtifact(name) {
  let stem = basename(String(name ?? ''))
  for (let i = 0; i < 3; i++) stem = stem.replace(/\.(?:zip|exe|appimage|dmg|pkg|blockmap|7z)$/i, '')
  // Not on `_`: it belongs to the architecture token `x86_64`, and splitting it there left
  // `3.95.0-linux-x86-64` as the version (issue #654). electron-builder's artifact names use
  // hyphens and spaces as separators.
  const tokens = stem.split(/[- ]+/)
  while (tokens.length > 1 && ARCHITECTURES.has(tokens.at(-1).toLowerCase())) tokens.pop()
  const start = tokens.findIndex(token => /^\d+\.\d+\.\d+$/.test(token))
  if (start === -1) return null
  // A prerelease is the token after the version (`-labs.14`, `-beta.1`); the platform and
  // architecture tokens at the end are gone by now.
  const version = tokens.slice(start).join('-')
  return compareVersions(version, version) === 0 ? version : null
}

const PENDING_DIR = 'pending'
const BASE_CACHE_FILES = ['update.zip', 'current.blockmap']

// electron-updater's app-update.yml names the folder it keeps downloads in
// (`updaterCacheDirName`, from electron-builder's sanitized package name). YAML quotes a value
// that starts with `@`, as this app's does.
function cacheDirNameFrom(configPath) {
  try {
    const text = readFileSync(configPath, 'utf8')
    const match = /^updaterCacheDirName:\s*(.+?)\s*$/m.exec(text)
    if (!match) return null
    let value = match[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, '').trim()
    return value || null
  } catch {
    return null
  }
}

/**
 * The folder electron-updater 6.8.10 downloads into: its own DownloadedUpdateHelper when a
 * download already made one, else `app.baseCachePath` (the OS cache root) plus the
 * `updaterCacheDirName` from the updater's app-update.yml (falling back to the app's name, as
 * electron-updater does). Null when the updater cannot say.
 */
export function updaterCacheDir(updater) {
  try {
    const known = updater?.downloadedUpdateHelper?.cacheDir
    if (typeof known === 'string' && known !== '') return known
    const app = updater?.app
    const base = app?.baseCachePath
    if (typeof base !== 'string' || base === '') return null
    const config = app?.appUpdateConfigPath
    const name = (typeof config === 'string' ? cacheDirNameFrom(config) : null) ?? (typeof app?.name === 'string' && app.name !== '' ? app.name : null)
    return name === null ? null : join(base, name)
  } catch {
    return null
  }
}

// The pending folder, only when it is a real directory: a symlink there is never followed, so
// nothing outside the cache is scanned or removed through it (a malicious or moved cache entry
// must not take files elsewhere with it).
function pendingDir(cacheDir) {
  const path = join(cacheDir, PENDING_DIR)
  try {
    return lstatSync(path).isDirectory() ? path : null
  } catch {
    return null
  }
}

function updateInfoFile(cacheDir) {
  const dir = pendingDir(cacheDir)
  if (dir === null) return null
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'update-info.json'), 'utf8'))
    return typeof parsed?.fileName === 'string' ? parsed.fileName : null
  } catch {
    return null
  }
}

function pendingFiles(cacheDir) {
  const dir = pendingDir(cacheDir)
  if (dir === null) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

function versionsInCache(cacheDir, version) {
  const versions = []
  if (typeof version === 'string' && compareVersions(version, version) === 0) versions.push(version)
  for (const name of [updateInfoFile(cacheDir), ...pendingFiles(cacheDir)]) {
    if (typeof name !== 'string' || name === '') continue
    const found = versionFromArtifact(name)
    if (found !== null && !versions.includes(found)) versions.push(found)
  }
  return versions
}

/**
 * Removes a pending update that is not newer than `current`, so a version already installed (or
 * an older one) can never look ready to install. An EQUAL version is the normal state on macOS
 * after a Mac install: electron-updater keeps its download as the next update's differential
 * base, so `update.zip` and `current.blockmap` stay, and only the pending files go
 * (`pending/update-info.json` and the installer beside it). A STRICTLY OLDER version removes
 * those base files too. A pending version newer than `current` is never touched, and a missing
 * cache folder (or an unreadable version) is a no-op. A `pending` folder that is a symlink is
 * never followed (see pendingDir).
 *
 * Returns `{ stale, version, removed }`: whether a stale pending update was found, the newest
 * version found in the cache, and the cache-relative paths removed (`pending/<file>`, and
 * `update.zip` and `current.blockmap` for a strictly older version only).
 */
export function cleanStaleCache(cacheDir, { current, version } = {}) {
  const nothing = { stale: false, version: null, removed: [] }
  if (typeof cacheDir !== 'string' || cacheDir === '' || !existsSync(cacheDir)) return nothing
  if (compareVersions(current, current) !== 0) return nothing
  const versions = versionsInCache(cacheDir, version)
  if (versions.length === 0) return nothing
  const newest = versions.reduce((best, found) => (compareVersions(found, best) > 0 ? found : best))
  const order = compareVersions(newest, current)
  if (order > 0) return { stale: false, version: newest, removed: [] }
  const removed = []
  const remove = (relative, path) => {
    try {
      rmSync(path, { force: true })
      removed.push(relative)
    } catch {}
  }
  const pending = pendingDir(cacheDir)
  if (pending !== null) for (const name of pendingFiles(cacheDir)) remove(`${PENDING_DIR}/${name}`, join(pending, name))
  // Equal: the download is the next update's differential base, so keep it. Only a strictly
  // older version's base is useless once its pending files are gone.
  if (order < 0) {
    for (const name of BASE_CACHE_FILES) {
      const path = join(cacheDir, name)
      if (existsSync(path)) remove(name, path)
    }
  }
  return { stale: true, version: newest, removed }
}

/**
 * The newest desktop release above `current` on `channel` that carries `platform`'s update
 * feed: `{ version, url, page }`, where `url` is the folder electron-updater reads the feed from
 * and `page` the release's own page. Null when there is none. A prerelease is only offered on
 * the prerelease channel.
 */
export function pickUpdate(releases, { current, platform, channel = 'prerelease' }) {
  const feed = feedFileOf(platform)
  let best = null
  for (const release of Array.isArray(releases) ? releases : []) {
    const tag = release?.tag_name
    if (release?.draft || typeof tag !== 'string' || !tag.startsWith(DESKTOP_TAG_PREFIX)) continue
    if (release.prerelease === true && channel !== 'prerelease') continue
    const version = tag.slice(DESKTOP_TAG_PREFIX.length)
    if (!(compareVersions(version, current) > 0)) continue
    if (!release.assets?.some(asset => asset?.name === feed)) continue
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, url: `${DOWNLOADS}${encodeURIComponent(tag)}/`, page: `${RELEASE_PAGE}${encodeURIComponent(tag)}` }
    }
  }
  return best
}

export async function fetchReleases(fetchImpl = fetch) {
  const response = await fetchImpl(RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'omni-desktop' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the desktop releases`)
  return response.json()
}

/**
 * Checks after FIRST_CHECK_MS and every CHECK_EVERY_MS (with an additional retry after RETRY_MS
 * when a check failed; after QUICK_RETRY_MS a few times when the failure is transient), and reports to
 * `onState`:
 * - `auto`: `{ version, state: 'downloading', percent }` (with `transferred` and `total`, in
 *   bytes, when electron-updater counts them), then `{ version, state: 'ready' }`;
 *   `install()` restarts into the downloaded update, which otherwise installs on quit. Nothing
 *   here restarts the app by itself: `install()` is the person's Restart.
 * - `{ version, state: 'failed', failure: 'download' | 'verify' }` when a download that had
 *   started did not arrive, or what arrived is not what the release says: nothing is ready, the
 *   running version stays, and the next check (the retry's, the quarter hour's or the person's)
 *   takes the mark away and tries again. A check that failed is not reported here (its answer is
 *   `check()`'s), so a computer that is offline shows nothing.
 * - `notify`: `{ version, state: 'available', page }`; nothing is downloaded.
 * - `{ state: 'retrying', failure: 'check' }` while a quick retry waits; `idle` once it starts
 *   or a non-transient failure takes over.
 * It also drops a pending download that is not newer than `current` (see cleanStaleCache): an
 * installed version must never show "Restart to update".
 * `check()` also serves the menu's Check for Updates, and answers what it found:
 * `{ result: 'latest' | 'found' | 'ready' | 'error' | 'busy', version?, retrying? }`.
 */
export function startUpdates({ updater, current, platform, env, log, onState, mode = 'auto', releases = fetchReleases, timers = globalThis }) {
  const readyWaiters = new Set()
  let lastCheck = null
  let latestVersion = null
  let busy = false
  let pending = null
  let ready = null
  let retry = null
  let retryQuick = false
  let quickRetries = 0
  let retrying = false
  // A failed download is on screen; a download is under way (from electron-updater's
  // update-available until it is ready or fails); and how many of its failures were retried
  // within a minute. A check that passes resets quickRetries before the download ends, so the
  // download keeps a count of its own, or one that keeps failing would be retried forever.
  let failed = false
  let fetching = false
  let downloadRetries = 0
  let cacheDir = null
  const auto = mode === 'auto'
  const newer = version => compareVersions(version, current) > 0
  if (auto) {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.allowDowngrade = false
    updater.logger = log
    cacheDir = updaterCacheDir(updater)
    const cleaned = cleanStaleCache(cacheDir, { current })
    if (cleaned.stale) {
      log.warn(`update: the cached ${cleaned.version} update is not newer than ${current}; ignoring it`)
      if (cleaned.removed.length > 0) log.info(`update: removed ${cleaned.removed.join(', ')} from the updater cache`)
    }
  }
  // On macOS the download is handed to Squirrel, which swaps the app on quit only once it has
  // the update too: until Squirrel says so, the update is not ready.
  const squirrel = auto && platform === 'darwin' ? updater.nativeUpdater : null
  // Every report goes through here, so a downloading/ready/available state takes the retrying
  // marker away and a quick retry's state cannot outlive it.
  function report(state) {
    retrying = state?.state === 'retrying'
    failed = state?.state === 'failed'
    if (state?.version) latestVersion = state.version
    if (state?.state === 'ready' || failed) for (const done of readyWaiters) done(!failed)
    onState(state)
  }
  // Only a failure's mark goes: a check that runs while a download is under way leaves its
  // progress on screen.
  function clearFailed() {
    if (failed) report({ state: 'idle' })
  }
  const bytes = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null)
  function progressOf(progress) {
    const transferred = bytes(progress?.transferred)
    const total = bytes(progress?.total)
    return transferred !== null && total !== null && total > 0 ? { transferred: Math.min(transferred, total), total } : {}
  }
  function clearRetrying() {
    if (retrying) report({ state: 'idle' })
  }
  function cacheDirNow() {
    const found = updaterCacheDir(updater)
    if (found !== null) cacheDir = found
    return cacheDir
  }
  function discardStale(version) {
    log.warn(`update: ${version ?? 'the cached update'} is not newer than ${current}; ignoring it`)
    if (ready !== null && !newer(ready)) {
      ready = null
      report({ state: 'idle' })
    }
    if (!newer(pending)) pending = null
    fetching = false
    const cleaned = cleanStaleCache(cacheDirNow(), { current, version })
    if (cleaned.removed.length > 0) log.info(`update: removed ${cleaned.removed.join(', ')} from the updater cache`)
  }
  const markReady = () => {
    if (ready !== null) {
      if (newer(ready)) return
      ready = null
      report({ state: 'idle' })
    }
    if (!newer(pending)) return discardStale(pending)
    ready = pending
    fetching = false
    downloadRetries = 0
    log.info(`update: ${ready} is ready and installs on quit`)
    report({ version: ready, state: 'ready' })
  }
  if (auto) {
    updater.on('update-available', () => { fetching = true })
    updater.on('update-cancelled', () => { fetching = false })
    updater.on('download-progress', (progress) => {
      fetching = true
      report({ version: pending, state: 'downloading', percent: Math.round(progress?.percent ?? 0), ...progressOf(progress) })
    })
    updater.on('update-downloaded', (info) => {
      const version = info?.version ?? pending
      if (!newer(version)) return discardStale(version)
      pending = version
      if (!squirrel) return markReady()
      log.info(`update: ${pending} is downloaded; macOS is preparing it`)
      report({ version: pending, state: 'downloading', percent: 100 })
    })
    squirrel?.on('update-downloaded', markReady)
    squirrel?.on('error', error => log.warn(`update (macOS): ${error?.message ?? error}`))
    updater.on('error', (error) => {
      log.warn(`update: ${error?.message ?? error}`)
      const unverified = isVerification(error)
      // A download's failure, or an update that is not what the release says. A feed that could
      // not be read is a failed check (no download had started), and stays check()'s to answer.
      // While a check runs (`busy`), an error is that check's: a download that is under way
      // goes on, and its count of retries is not spent.
      const download = fetching && !busy
      const lost = download || unverified
      const again = !download || downloadRetries < QUICK_RETRIES
      if (download && isTransient(error)) downloadRetries += 1
      if (download) fetching = false
      const soon = retryLater(error, again)
      // An update that is ready stays ready: macOS repeats Squirrel's errors here.
      if (lost && !soon && ready === null) {
        const failure = unverified ? 'verify' : 'download'
        log.info(`update: ${pending ?? 'the update'} ${failure === 'verify' ? 'could not be verified' : 'did not download'}; ${current} stays, and the next check tries again`)
        report({ ...(pending ? { version: pending } : {}), state: 'failed', failure })
      }
    })
  }

  function retryLater(error, quick = true) {
    const soon = quick && isTransient(error) && quickRetries < QUICK_RETRIES
    // A retry is already scheduled (an electron-updater error, say): a failure that would wait
    // as long inherits it, and no second timer is set. A non-transient failure must not inherit
    // a pending quick retry's minute: it replaces that timer with RETRY_MS and clears the
    // retrying mark (through report(), like every other state change).
    if (retry !== null && !(retryQuick && !soon)) {
      if (retryQuick) report({ state: 'retrying', failure: 'check' })
      return retryQuick
    }
    if (retry !== null) timers.clearTimeout(retry)
    if (soon) quickRetries += 1
    retryQuick = soon
    retry = timers.setTimeout(() => {
      retry = null
      retryQuick = false
      clearRetrying()
      void check()
    }, soon ? QUICK_RETRY_MS : RETRY_MS)
    if (soon) report({ state: 'retrying', failure: 'check' })
    else clearRetrying()
    return soon
  }

  async function check() {
    const answer = await checkOnce()
    if (answer.result !== 'busy') lastCheck = answer.result
    if (answer.version) latestVersion = answer.version
    return answer
  }

  async function checkOnce() {
    if (ready !== null) {
      if (newer(ready)) return { result: 'ready', version: ready }
      discardStale(ready)
    }
    if (busy) return { result: 'busy' }
    clearRetrying()
    clearFailed()
    busy = true
    try {
      const override = auto ? feedOverride(env) : null
      let update
      if (override) update = { version: null, url: override }
      else {
        const list = await releases()
        const channel = channelOf(list, { current, env })
        update = pickUpdate(list, { current, platform, channel })
        if (!update) {
          log.info(`update check: ${current} is the newest ${channel} release`)
          quickRetries = 0
          return { result: 'latest' }
        }
      }
      log.info(`update check: ${update.version ?? 'a release from the feed override'} is out`)
      if (!auto) {
        report({ version: update.version, state: 'available', page: update.page })
        return { result: 'found', version: update.version }
      }
      pending = update.version
      // GitHub's download host answers a request for several ranges at once with 501, which
      // costs the whole app instead of the blocks that changed: ask for them one range at a time.
      updater.setFeedURL({ provider: 'generic', url: update.url, useMultipleRangeRequest: false })
      await updater.checkForUpdates()
      quickRetries = 0
      return { result: 'found', version: update.version }
    } catch (error) {
      log.warn(`update check: ${error?.message ?? error}`)
      const soon = retryLater(error)
      return soon ? { result: 'error', retrying: true } : { result: 'error' }
    } finally {
      busy = false
    }
  }

  const first = timers.setTimeout(check, FIRST_CHECK_MS)
  const every = timers.setInterval(check, CHECK_EVERY_MS)
  return {
    check,
    get ready() { return ready },
    get appUpdate() { return { version: latestVersion, latest: lastCheck === 'latest' } },
    whenReady({ timeoutMs = 5 * 60_000 } = {}) {
      if (ready !== null) return Promise.resolve(true)
      if (failed) return Promise.resolve(false)
      return new Promise(resolve => {
        const done = value => { timers.clearTimeout(timer); readyWaiters.delete(done); resolve(value) }
        const timer = timers.setTimeout(() => done(false), timeoutMs)
        readyWaiters.add(done)
      })
    },
    install: () => { if (ready !== null && newer(ready)) updater.quitAndInstall(false, true) },
    stop: () => {
      for (const done of readyWaiters) done(false)
      timers.clearTimeout(first)
      timers.clearInterval(every)
      if (retry !== null) timers.clearTimeout(retry)
    },
  }
}

/** Whether `url` is a desktop release page, the only page the notice may open. */
export function isReleasePage(url) {
  return typeof url === 'string' && url.startsWith(RELEASE_PAGE) && !url.slice(RELEASE_PAGE.length).includes('/')
}
