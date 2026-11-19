import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { channelOf, cleanStaleCache, compareVersions, feedFileOf, feedOverride, fetchReleases, isReleasePage, isTransient, MAX_RELEASE_PAGES, nextPage, pickUpdate, QUICK_RETRIES, QUICK_RETRY_MS, RELEASES_URL, RETRY_MS, startUpdates, updaterCacheDir, updateMode, updatesEnabled, versionFromArtifact } from '../src/update.js'

const release = (tag, assets = ['latest-mac.yml', 'latest-linux.yml'], extra = {}) => ({ tag_name: tag, draft: false, assets: assets.map(name => ({ name })), ...extra })

test('versions compare by semver: a dev cut is newer than the labs build of the version before it', () => {
  assert.equal(compareVersions('2.261022.1', '2.261019.10-labs.14'), 1)
  assert.equal(compareVersions('2.261019.10', '2.261019.10-labs.14'), 1)
  assert.equal(compareVersions('2.261019.10-labs.14', '2.261019.10-labs.9'), 1)
  assert.equal(compareVersions('2.261019.9', '2.261019.10'), -1)
  assert.equal(compareVersions('2.261019.10', '2.261019.10'), 0)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  assert.ok(Number.isNaN(compareVersions('v2', '2.0.0')))
})

test('an artifact name gives its version whole, the x86_64 AppImage included', () => {
  assert.equal(versionFromArtifact('Automagik-3.95.0-mac-arm64.zip'), '3.95.0')
  // Splitting on `_` broke `x86_64` into `x86` and `64` and kept `3.95.0-linux-x86-64` (#654).
  assert.equal(versionFromArtifact('Automagik-3.95.0-linux-x86_64.AppImage'), '3.95.0')
  assert.equal(versionFromArtifact('Automagik Setup 3.95.0.exe'), '3.95.0')
  assert.equal(versionFromArtifact('Automagik-3.95.0-labs.1-mac-arm64.zip'), '3.95.0-labs.1')
  assert.equal(versionFromArtifact('Automagik-3.95.0-mac-arm64.zip.blockmap'), '3.95.0')
  assert.equal(versionFromArtifact('latest-mac.yml'), null)
  assert.equal(versionFromArtifact(''), null)
})

test("the update is the newest release above this one with this platform's feed; drafts and other tags are not", () => {
  const releases = [
    release('nightly'),
    release('v2.261025.1', ['latest-linux.yml']),
    release('v2.261024.2', ['latest-mac.yml', 'latest-linux.yml'], { draft: true }),
    release('v2.261023.1'),
    release('v2.261022.1'),
    release('v2.261019.1'),
    { tag_name: 7 },
    null,
  ]
  assert.deepEqual(pickUpdate(releases, { current: '2.261019.10-labs.14', platform: 'darwin' }), {
    version: '2.261023.1',
    url: 'https://github.com/automagik-si/automagik/releases/download/v2.261023.1/',
    page: 'https://github.com/automagik-si/automagik/releases/tag/v2.261023.1',
  })
  assert.equal(pickUpdate(releases, { current: '2.261019.10-labs.14', platform: 'linux' }).version, '2.261025.1')
  assert.equal(pickUpdate(releases, { current: '2.261025.1', platform: 'linux' }), null)
  // No release here carries latest.yml, Windows' feed: none is a Windows update.
  assert.equal(pickUpdate(releases, { current: '2.261019.10', platform: 'win32' }), null)
  assert.equal(pickUpdate([...releases, release('v2.261022.2', ['latest.yml']), release('v2.261024.1', ['latest.json'])], { current: '2.261019.10', platform: 'win32' }).version, '2.261022.2')
  assert.equal(pickUpdate([release('v2.261022.2', ['latest.yml'])], { current: '2.261019.10', platform: 'darwin' }), null)
  assert.equal(pickUpdate({ message: 'rate limited' }, { current: '2.261019.10', platform: 'darwin' }), null)
})

// The rolling lane releases (docs/rfcs/0011-monorepo-parts-and-releases.md): plugin-lane, herdr-lane and
// Pocket's pocket-lane are newer than any version and hold small files, but their tags are not v*, so
// the app never takes one for a build of its own, on either channel, even with a feed file on it.
test('the rolling lanes, pocket-lane included, are never an update', () => {
  const releases = [
    release('pocket-lane', ['latest.json', 'latest-mac.yml', 'latest-linux.yml'], { prerelease: true }),
    release('herdr-lane', ['pack.json', 'pack.json.sig'], { prerelease: true }),
    release('plugin-lane', ['lane.json', 'lane.json.sig'], { prerelease: true }),
    release('v3.58.1', ['automagik-pocket-3.58.1.apk', 'latest.json']),
    release('v3.58.0'),
  ]
  for (const channel of ['stable', 'prerelease']) {
    assert.equal(pickUpdate(releases, { current: '3.57.0', platform: 'darwin', channel }).version, '3.58.0')
  }
  // A Pocket-only release carries no desktop feed: nothing to take when the app is already on 3.58.0.
  assert.equal(pickUpdate(releases, { current: '3.58.0', platform: 'linux' }), null)
})

test('only a packaged build updates itself: on macOS or Windows, or from an AppImage; OMNI_DESKTOP_UPDATES=off turns it off', () => {
  assert.equal(updatesEnabled({ packaged: true, platform: 'darwin', env: {} }), true)
  assert.equal(updatesEnabled({ packaged: true, platform: 'darwin', env: { OMNI_DESKTOP_UPDATES: 'off' } }), false)
  assert.equal(updatesEnabled({ packaged: false, platform: 'darwin', env: {} }), false)
  assert.equal(updatesEnabled({ packaged: true, platform: 'linux', env: { APPIMAGE: '/home/u/Omni.AppImage' } }), true)
  assert.equal(updatesEnabled({ packaged: true, platform: 'linux', env: {} }), false)
  assert.equal(updatesEnabled({ packaged: true, platform: 'win32', env: {} }), true)
  assert.equal(updatesEnabled({ packaged: true, platform: 'win32', env: { OMNI_DESKTOP_UPDATES: 'off' } }), false)
  assert.equal(updatesEnabled({ packaged: false, platform: 'win32', env: {} }), false)
  assert.equal(updatesEnabled({ packaged: true, platform: 'freebsd', env: {} }), false)
  assert.equal(feedFileOf('darwin'), 'latest-mac.yml')
  assert.equal(feedFileOf('linux'), 'latest-linux.yml')
  // electron-updater's NSIS updater reads latest.yml, the name electron-builder gives Windows' feed.
  assert.equal(feedFileOf('win32'), 'latest.yml')
  assert.equal(feedFileOf('freebsd'), null)
})

test('a feed override is https, or http on loopback only', () => {
  assert.equal(feedOverride({ OMNI_DESKTOP_UPDATE_FEED: 'https://example.com/feed' }), 'https://example.com/feed/')
  assert.equal(feedOverride({ OMNI_DESKTOP_UPDATE_FEED: 'http://127.0.0.1:8099/' }), 'http://127.0.0.1:8099/')
  assert.equal(feedOverride({ OMNI_DESKTOP_UPDATE_FEED: 'http://example.com/feed' }), null)
  assert.equal(feedOverride({ OMNI_DESKTOP_UPDATE_FEED: 'file:///tmp/feed' }), null)
  assert.equal(feedOverride({ OMNI_DESKTOP_UPDATE_FEED: 'not a url' }), null)
  assert.equal(feedOverride({}), null)
})

function fakeUpdater() {
  const updater = new EventEmitter()
  updater.feeds = []
  updater.installs = []
  updater.setFeedURL = feed => updater.feeds.push(feed)
  updater.checkForUpdates = async () => ({ checked: true })
  updater.quitAndInstall = (...args) => updater.installs.push(args)
  return updater
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const noTimers = { setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {} }

for (const [platform, mode] of [['linux', 'auto'], ['darwin', 'auto'], ['win32', 'auto'], ['linux', 'notify']]) {
  test(`automatic checks continue every 15 minutes on ${platform} (${mode}) when no update is available`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const updater = fakeUpdater()
    const states = []
    let calls = 0
    let available = false
    const updates = startUpdates({
      updater, current: '3.101.0', platform, mode, env: {}, log: quiet,
      onState: state => states.push(state),
      releases: async () => {
        calls++
        return [release(available ? 'v3.102.0' : 'v3.101.0', [feedFileOf(platform)])]
      },
    })
    t.after(() => updates.stop())
    const advance = async (ms) => {
      t.mock.timers.tick(ms)
      await new Promise(resolve => setImmediate(resolve))
    }
    await advance(19_999)
    assert.equal(calls, 0)
    await advance(1)
    assert.equal(calls, 1, 'the initial check still runs after 20 seconds')
    await advance(15 * 60_000 - 20_000 - 1)
    assert.equal(calls, 1)
    await advance(1)
    assert.equal(calls, 2, 'an up-to-date app still checks at the next quarter hour')
    assert.deepEqual(updater.feeds, [])
    available = true
    await advance(15 * 60_000)
    assert.equal(calls, 3, 'a later release is found without a restart or manual check')
    if (mode === 'auto') {
      assert.equal(updater.autoDownload, true)
      assert.equal(updater.feeds.at(-1).url, 'https://github.com/automagik-si/automagik/releases/download/v3.102.0/')
    } else {
      assert.equal(states.at(-1).state, 'available')
      assert.equal(states.at(-1).version, '3.102.0')
      assert.deepEqual(updater.feeds, [])
    }
    updates.stop()
    await advance(15 * 60_000)
    assert.equal(calls, 3, 'stopping the watcher cancels future checks')
  })
}

test('a check points electron-updater at the chosen release, reports the download, and installs only once it is ready', async () => {
  const updater = fakeUpdater()
  const states = []
  const updates = startUpdates({
    updater, current: '2.261019.10-labs.14', platform: 'darwin', env: {}, log: quiet, timers: noTimers,
    onState: state => states.push(state),
    releases: async () => [release('v2.261022.1')],
  })
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.allowDowngrade, false)
  updates.install()
  assert.deepEqual(updater.installs, [])
  assert.deepEqual(await updates.check(), { result: 'found', version: '2.261022.1' })
  // One range per request: GitHub answers several at once with 501, and the update would come whole.
  assert.deepEqual(updater.feeds, [{ provider: 'generic', url: 'https://github.com/automagik-si/automagik/releases/download/v2.261022.1/', useMultipleRangeRequest: false }])
  updater.emit('download-progress', { percent: 41.6 })
  updater.emit('update-downloaded', { version: '2.261022.1' })
  assert.deepEqual(states, [{ version: '2.261022.1', state: 'downloading', percent: 42 }, { version: '2.261022.1', state: 'ready' }])
  assert.equal(updates.ready, '2.261022.1')
  assert.deepEqual(await updates.check(), { result: 'ready', version: '2.261022.1' })
  updates.install()
  assert.deepEqual(updater.installs, [[false, true]])
})

test('on macOS the update is ready only once Squirrel has it, since quitting earlier would not install it', async () => {
  const updater = fakeUpdater()
  updater.nativeUpdater = new EventEmitter()
  const states = []
  const updates = startUpdates({
    updater, current: '2.261019.10-labs.14', platform: 'darwin', env: {}, log: quiet, timers: noTimers,
    onState: state => states.push(state),
    releases: async () => [release('v2.261022.1')],
  })
  await updates.check()
  updater.emit('update-downloaded', { version: '2.261022.1' })
  assert.equal(updates.ready, null)
  updates.install()
  assert.deepEqual(updater.installs, [])
  updater.nativeUpdater.emit('update-downloaded')
  assert.equal(updates.ready, '2.261022.1')
  assert.deepEqual(states.at(-2), { version: '2.261022.1', state: 'downloading', percent: 100 })
  assert.deepEqual(states.at(-1), { version: '2.261022.1', state: 'ready' })
})

// Windows: electron-updater's NSIS updater downloads the installer latest.yml names and checks its
// sha512; there is no Squirrel step, so the update is ready once downloaded, and Restart now runs
// the installer, which opens the app again.
test('on Windows the update comes from the release with latest.yml and is ready once downloaded', async () => {
  const updater = fakeUpdater()
  const states = []
  const updates = startUpdates({
    updater, current: '3.65.0', platform: 'win32', env: {}, log: quiet, timers: noTimers,
    onState: state => states.push(state),
    releases: async () => [release('v3.66.0', ['latest-mac.yml', 'latest-linux.yml']), release('v3.65.1', ['latest.yml', 'latest-mac.yml'])],
  })
  assert.deepEqual(await updates.check(), { result: 'found', version: '3.65.1' })
  assert.deepEqual(updater.feeds, [{ provider: 'generic', url: 'https://github.com/automagik-si/automagik/releases/download/v3.65.1/', useMultipleRangeRequest: false }])
  updater.emit('update-downloaded', { version: '3.65.1' })
  assert.equal(updates.ready, '3.65.1')
  assert.deepEqual(states.at(-1), { version: '3.65.1', state: 'ready' })
  updates.install()
  assert.deepEqual(updater.installs, [[false, true]])
})

test('no newer release is logged as up to date; GitHub failing is a warning and an additional retry', async () => {
  const updater = fakeUpdater()
  const infos = []
  const warnings = []
  const later = []
  const log = { ...quiet, info: message => infos.push(message), warn: message => warnings.push(message) }
  const timers = { ...noTimers, setTimeout: (fn, ms) => { later.push({ fn, ms }); return later.length } }
  const none = startUpdates({ updater, current: '2.261022.1', platform: 'linux', env: {}, log, timers, onState() {}, releases: async () => [release('v2.261022.1')] })
  assert.deepEqual(await none.check(), { result: 'latest' })
  assert.deepEqual(infos, ['update check: 2.261022.1 is the newest stable release'])
  later.length = 0
  let calls = 0
  const down = startUpdates({ updater, current: '2.261022.1', platform: 'linux', env: {}, log, timers, onState() {}, releases: async () => { calls++; throw new Error('offline') } })
  assert.deepEqual(await down.check(), { result: 'error' })
  assert.deepEqual(updater.feeds, [])
  assert.deepEqual(warnings, ['update check: offline'])
  const retry = later.filter(entry => entry.ms === RETRY_MS)
  assert.equal(retry.length, 1)
  await down.check()
  assert.equal(later.filter(entry => entry.ms === RETRY_MS).length, 1, 'one pending retry at a time')
  retry[0].fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 3)
})

test('an electron-updater error is logged and schedules a retry', async () => {
  const updater = fakeUpdater()
  const later = []
  const warnings = []
  const timers = { ...noTimers, setTimeout: (fn, ms) => { later.push({ fn, ms }); return later.length } }
  startUpdates({ updater, current: '2.261022.1', platform: 'darwin', env: {}, log: { ...quiet, warn: m => warnings.push(m) }, timers, onState() {}, releases: async () => [] })
  updater.emit('error', new Error('sha512 checksum mismatch'))
  assert.deepEqual(warnings, ['update: sha512 checksum mismatch'])
  assert.equal(later.filter(entry => entry.ms === RETRY_MS).length, 1)
})

test('a network that changed mid-check is retried within a minute, a few times, then after RETRY_MS', async () => {
  assert.equal(isTransient(new Error('net::ERR_NETWORK_CHANGED')), true)
  assert.equal(isTransient(new Error('getaddrinfo ENOTFOUND api.github.com')), true)
  assert.equal(isTransient(new Error('sha512 checksum mismatch')), false)
  const later = []
  const timers = { ...noTimers, setTimeout: (fn, ms) => { later.push({ fn, ms }); return later.length } }
  let fail = true
  const updates = startUpdates({ updater: fakeUpdater(), current: '2.261022.1', platform: 'linux', env: {}, log: quiet, timers, onState() {}, releases: async () => { if (fail) throw new Error('net::ERR_NETWORK_CHANGED'); return [release('v2.261022.1')] } })
  // Each retry's own check fails again and schedules the next one.
  await updates.check()
  for (let i = 0; i < QUICK_RETRIES + 1; i++) {
    const next = later.pop()
    assert.equal(next.ms, i < QUICK_RETRIES ? QUICK_RETRY_MS : RETRY_MS, `retry ${i + 1}`)
    if (i === QUICK_RETRIES) fail = false
    next.fn()
    await new Promise(resolve => setImmediate(resolve))
  }
  // That last retry got through, which gives the next failure its quick retries back.
  fail = true
  await updates.check()
  assert.equal(later.pop().ms, QUICK_RETRY_MS)
})

test('a deb build only says a release is out: no feed, no download, and its page to open', async () => {
  assert.equal(updateMode({ packaged: true, platform: 'linux', env: {} }), 'notify')
  assert.equal(updateMode({ packaged: true, platform: 'linux', env: { APPIMAGE: '/x' } }), 'auto')
  assert.equal(updateMode({ packaged: true, platform: 'darwin', env: {} }), 'auto')
  assert.equal(updateMode({ packaged: true, platform: 'win32', env: {} }), 'auto')
  assert.equal(updateMode({ packaged: true, platform: 'linux', env: { OMNI_DESKTOP_UPDATES: 'off' } }), null)
  assert.equal(updateMode({ packaged: false, platform: 'linux', env: {} }), null)
  const updater = fakeUpdater()
  const states = []
  const updates = startUpdates({
    updater, current: '2.261022.1', platform: 'linux', env: {}, log: quiet, timers: noTimers, mode: 'notify',
    onState: state => states.push(state),
    releases: async () => [release('v2.261023.1')],
  })
  assert.deepEqual(await updates.check(), { result: 'found', version: '2.261023.1' })
  assert.deepEqual(states, [{ version: '2.261023.1', state: 'available', page: 'https://github.com/automagik-si/automagik/releases/tag/v2.261023.1' }])
  assert.deepEqual(updater.feeds, [])
  assert.equal(updater.autoDownload, undefined)
  assert.equal(updater.listenerCount('update-downloaded'), 0)
  assert.equal(isReleasePage(states[0].page), true)
  assert.equal(isReleasePage('https://github.com/automagik-si/automagik/releases/tag/v1/../../evil'), false)
  assert.equal(isReleasePage('https://evil.example/releases/tag/v1'), false)
})

test('a stable build never moves to a prerelease; a prerelease build follows both; the env can choose', () => {
  const releases = [
    release('v2.261024.1', undefined, { prerelease: true }),
    release('v2.261023.5'),
    release('v2.261023.3', undefined, { prerelease: true }),
  ]
  assert.equal(channelOf(releases, { current: '2.261023.5' }), 'stable')
  assert.equal(channelOf(releases, { current: '2.261023.3' }), 'prerelease')
  assert.equal(channelOf(releases, { current: '2.261023.4' }), 'stable')
  assert.equal(channelOf(releases, { current: '2.261023.5', env: { OMNI_DESKTOP_UPDATE_CHANNEL: 'prerelease' } }), 'prerelease')
  assert.equal(pickUpdate(releases, { current: '2.261023.5', platform: 'darwin', channel: 'stable' }), null)
  assert.equal(pickUpdate(releases, { current: '2.261023.5', platform: 'darwin', channel: 'prerelease' }).version, '2.261024.1')
  assert.equal(pickUpdate(releases, { current: '2.261023.3', platform: 'darwin', channel: 'stable' }).version, '2.261023.5')
})

// The updater retry (#654): a releases API outage (a 5xx, or 429) is transient and retried in a
// minute a few times, while another 4xx still waits 30 minutes.
function answerStatus(status) {
  return { ok: status >= 200 && status < 300, status, json: async () => [] }
}

function stubFetch(t, answer) {
  const real = globalThis.fetch
  globalThis.fetch = async () => answer()
  t.after(() => { globalThis.fetch = real })
}

function recordingTimers() {
  const scheduled = []
  const cleared = []
  const timers = {
    setTimeout: (fn, ms) => { const entry = { fn, ms }; scheduled.push(entry); return entry },
    setInterval: () => ({ interval: true }),
    clearTimeout: entry => { if (entry) cleared.push(entry) },
    clearInterval() {},
  }
  return { timers, retries: ms => scheduled.filter(entry => entry.ms === ms), cleared }
}

// Runs a scheduled retry and waits for its async check() (the timer calls it with void).
async function settle(condition, what) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a releases API 5xx or 429 is transient; other 4xx are not; the network patterns stay', () => {
  for (const status of [500, 502, 504, 599]) assert.equal(isTransient(new Error(`GitHub answered ${status} for the desktop releases`)), true, `HTTP ${status}`)
  assert.equal(isTransient(new Error('GitHub answered 429 for the desktop releases')), true)
  for (const status of [400, 401, 403, 404, 422]) assert.equal(isTransient(new Error(`GitHub answered ${status} for the desktop releases`)), false, `HTTP ${status}`)
  assert.equal(isTransient('GitHub answered 504 for the desktop releases'), true)
  for (const message of ['net::ERR_NETWORK_CHANGED', 'read ECONNRESET', 'connect ETIMEDOUT', 'getaddrinfo ENOTFOUND api.github.com', 'EAI_AGAIN', 'ENETUNREACH']) {
    assert.equal(isTransient(new Error(message)), true, message)
  }
  assert.equal(isTransient(new Error('sha512 checksum mismatch')), false)
  assert.equal(isTransient(undefined), false)
})

test("GitHub's Link header names the next page, and nothing when there is none or another host", () => {
  assert.equal(nextPage(`<${RELEASES_URL}&page=2>; rel="next", <${RELEASES_URL}&page=9>; rel="last"`), `${RELEASES_URL}&page=2`)
  assert.equal(nextPage(`<${RELEASES_URL}&page=1>; rel="prev"`), null)
  assert.equal(nextPage('<https://evil.example/repos/x/releases?page=2>; rel="next"'), null)
  assert.equal(nextPage('<http://api.github.com/repos/x/releases?page=2>; rel="next"'), null)
  assert.equal(nextPage(''), null)
  assert.equal(nextPage(undefined), null)
})

test('the release list is read past its first page, so an older feed is never hidden', async () => {
  const first = Array.from({ length: 100 }, (_, i) => release(`v3.${900 - i}.0`, []))
  const second = [release('v3.50.0', ['latest-mac.yml']), release('v3.49.0')]
  const calls = []
  const page = async url => {
    calls.push(url)
    if (calls.length === 1) {
      return { ok: true, status: 200, headers: { get: () => `<${RELEASES_URL}&page=2>; rel="next"` }, json: async () => first }
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => second }
  }
  const list = await fetchReleases(page)
  assert.deepEqual(calls, [RELEASES_URL, `${RELEASES_URL}&page=2`])
  assert.equal(list.length, 102)
  // The first page is all patches without a feed; the older page still gives the update.
  assert.equal(pickUpdate(list, { current: '3.1.0', platform: 'darwin' }).version, '3.50.0')
})

test('one page with no next is the whole list, and a failed later page fails the check', async () => {
  const calls = []
  const list = await fetchReleases(async url => {
    calls.push(url)
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => [release('v3.1.0')] }
  })
  assert.deepEqual(calls, [RELEASES_URL])
  assert.equal(list.length, 1)

  const failed = []
  await assert.rejects(
    fetchReleases(async url => {
      failed.push(url)
      if (failed.length === 1) {
        return { ok: true, status: 200, headers: { get: () => `<${RELEASES_URL}&page=2>; rel="next"` }, json: async () => [release('v3.1.0')] }
      }
      return { ok: false, status: 503, headers: { get: () => null }, json: async () => [] }
    }),
    /GitHub answered 503 for the desktop releases/,
  )
})

test('the list stops at MAX_RELEASE_PAGES, and says so instead of hiding the rest', async () => {
  const original = console.warn
  const warnings = []
  console.warn = message => warnings.push(message)
  try {
    let calls = 0
    const list = await fetchReleases(async () => {
      calls += 1
      return {
        ok: true,
        status: 200,
        headers: { get: () => `<${RELEASES_URL}&page=${calls + 1}>; rel="next"` },
        json: async () => [release(`v3.${1000 - calls}.0`)],
      }
    })
    assert.equal(calls, MAX_RELEASE_PAGES)
    assert.equal(list.length, MAX_RELEASE_PAGES)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /older feed may be hidden/)
  } finally {
    console.warn = original
  }
})

test('a later page that is not a release list fails the check, never hides the pages before it', async () => {
  const calls = []
  await assert.rejects(
    fetchReleases(async url => {
      calls.push(url)
      if (calls.length === 1) {
        return { ok: true, status: 200, headers: { get: () => `<${RELEASES_URL}&page=2>; rel="next"` }, json: async () => [release('v3.1.0')] }
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ message: 'rate limited' }) }
    }),
    /other than a release list/,
  )
  assert.equal(calls.length, 2)
})

test('a next page on another host ends the list instead of being followed', async () => {
  const calls = []
  const list = await fetchReleases(async url => {
    calls.push(url)
    return { ok: true, status: 200, headers: { get: () => '<https://evil.example/releases?page=2>; rel="next"' }, json: async () => [release('v3.1.0')] }
  })
  assert.equal(calls.length, 1)
  assert.equal(list.length, 1)
})

test('paging stops once the running release and a usable feed are in hand', async () => {
  const calls = []
  const page = async url => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      headers: { get: () => `<${RELEASES_URL}&page=2>; rel="next"` },
      json: async () => [release('v3.102.0', ['latest-mac.yml']), release('v3.101.0')],
    }
  }
  const enough = list => pickUpdate(list, { current: '3.101.0', platform: 'darwin', channel: channelOf(list, { current: '3.101.0' }) }) !== null
  const list = await fetchReleases(page, enough)
  assert.equal(calls.length, 1)
  assert.equal(list.length, 2)
})

test('an up-to-date app reads one page, not the whole list', async (t) => {
  let calls = 0
  stubFetch(t, () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      headers: { get: () => `<${RELEASES_URL}&page=2>; rel="next"` },
      json: async () => [release('v3.101.0'), release('v3.100.0')],
    }
  })
  const { timers } = recordingTimers()
  const updates = startUpdates({ updater: fakeUpdater(), current: '3.101.0', platform: 'darwin', env: {}, timers, log: quiet, onState() {} })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'latest' })
  assert.equal(calls, 1)
})

test('a check reads one page when that page already holds the update', async (t) => {
  let calls = 0
  stubFetch(t, () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      headers: { get: () => `<${RELEASES_URL}&page=2>; rel="next"` },
      json: async () => [release('v3.102.0', ['latest-mac.yml']), release('v3.101.0')],
    }
  })
  const { timers } = recordingTimers()
  const updates = startUpdates({ updater: fakeUpdater(), current: '3.101.0', platform: 'darwin', env: {}, timers, log: quiet, onState() {} })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'found', version: '3.102.0' })
  assert.equal(calls, 1)
})

async function quickRetryEvidence(t, status) {
  stubFetch(t, () => answerStatus(status))
  const states = []
  const warnings = []
  const { timers, retries } = recordingTimers()
  const updates = startUpdates({
    updater: fakeUpdater(), current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  const answer = await updates.check()
  return { answer, states, warnings, retries }
}

test('a 504 from the releases API quick-retries in 60 s and reports the retrying state', async (t) => {
  // No test waits a minute: the retry is a captured setTimeout, so its delay is the evidence.
  const { answer, states, warnings, retries } = await quickRetryEvidence(t, 504)
  assert.equal(QUICK_RETRY_MS, 60_000)
  assert.equal(QUICK_RETRIES, 3)
  assert.deepEqual(answer, { result: 'error', retrying: true })
  assert.deepEqual(states, [{ state: 'retrying', failure: 'check' }])
  assert.deepEqual(warnings, ['update check: GitHub answered 504 for the desktop releases'])
  assert.equal(retries(QUICK_RETRY_MS).length, 1)
  assert.equal(retries(RETRY_MS).length, 0)
})

test('a 429 from the releases API quick-retries in 60 s and reports the retrying state', async (t) => {
  const { answer, states, warnings, retries } = await quickRetryEvidence(t, 429)
  assert.deepEqual(answer, { result: 'error', retrying: true })
  assert.deepEqual(states, [{ state: 'retrying', failure: 'check' }])
  assert.deepEqual(warnings, ['update check: GitHub answered 429 for the desktop releases'])
  assert.equal(retries(QUICK_RETRY_MS).length, 1)
  assert.equal(retries(RETRY_MS).length, 0)
})

test('the retrying state clears to idle when a quick retry starts, and a non-transient failure takes over', async (t) => {
  let status = 504
  stubFetch(t, () => answerStatus(status))
  const states = []
  const warnings = []
  const { timers, retries } = recordingTimers()
  const updates = startUpdates({
    updater: fakeUpdater(), current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'error', retrying: true })
  const [quick] = retries(QUICK_RETRY_MS)
  assert.ok(quick, 'the quick retry is scheduled')
  status = 404
  quick.fn()
  await settle(() => retries(RETRY_MS).length === 1, 'the 30-minute retry a 404 schedules')
  assert.deepEqual(states, [{ state: 'retrying', failure: 'check' }, { state: 'idle' }])
  assert.match(warnings.at(-1), /GitHub answered 404 for the desktop releases/)
})

test('a non-transient failure takes over a pending quick retry instead of inheriting its 60 s', async (t) => {
  stubFetch(t, () => answerStatus(504))
  const states = []
  const warnings = []
  const { timers, retries, cleared } = recordingTimers()
  const updater = fakeUpdater()
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'error', retrying: true })
  const [quick] = retries(QUICK_RETRY_MS)
  assert.ok(quick, 'the quick retry is scheduled')
  // The 404 arrives while the quick timer still waits: it must not inherit its minute.
  updater.emit('error', new Error('GitHub answered 404 for the desktop releases'))
  assert.ok(cleared.includes(quick), 'the pending quick retry is cleared')
  assert.equal(retries(RETRY_MS).length, 1, 'the 30-minute retry replaces it')
  assert.equal(retries(QUICK_RETRY_MS).length, 1, 'no second quick retry is scheduled')
  assert.deepEqual(states, [{ state: 'retrying', failure: 'check' }, { state: 'idle' }])
  assert.deepEqual(warnings, [
    'update check: GitHub answered 504 for the desktop releases',
    'update: GitHub answered 404 for the desktop releases',
  ])
})

test('a transient failure that arrives while a retry waits inherits it, with no second timer', async (t) => {
  stubFetch(t, () => answerStatus(504))
  const states = []
  const { timers, retries, cleared } = recordingTimers()
  const updater = fakeUpdater()
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: quiet, onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'error', retrying: true })
  updater.emit('error', new Error('net::ERR_NETWORK_CHANGED'))
  assert.equal(retries(QUICK_RETRY_MS).length, 1, 'still one quick retry')
  assert.equal(retries(RETRY_MS).length, 0)
  assert.deepEqual(cleared, [], 'the pending retry is kept')
  assert.ok(states.length > 0 && states.every(state => state.state === 'retrying'))
})

test('the retrying state clears to idle when a quick retry succeeds', async (t) => {
  let status = 504
  stubFetch(t, () => answerStatus(status))
  const states = []
  const infos = []
  const { timers, retries } = recordingTimers()
  const updates = startUpdates({
    updater: fakeUpdater(), current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: { ...quiet, info: message => infos.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'error', retrying: true })
  status = 200
  retries(QUICK_RETRY_MS)[0].fn()
  await settle(() => infos.includes('update check: 3.95.0 is the newest stable release'), 'the retried check')
  assert.deepEqual(states, [{ state: 'retrying', failure: 'check' }, { state: 'idle' }])
})

test('a non-transient 404 waits 30 minutes and reports no retrying state', async (t) => {
  stubFetch(t, () => answerStatus(404))
  const states = []
  const warnings = []
  const { timers, retries } = recordingTimers()
  const updates = startUpdates({
    updater: fakeUpdater(), current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'error' })
  assert.deepEqual(warnings, ['update check: GitHub answered 404 for the desktop releases'])
  assert.deepEqual(states, [])
  assert.equal(retries(RETRY_MS).length, 1)
  assert.equal(retries(QUICK_RETRY_MS).length, 0)
})

test('a releases API 5xx quick-retries QUICK_RETRIES times, then waits RETRY_MS', async (t) => {
  stubFetch(t, () => answerStatus(504))
  const { timers, retries } = recordingTimers()
  const updates = startUpdates({
    updater: fakeUpdater(), current: '3.95.0', platform: 'darwin', env: {}, timers,
    log: quiet, onState() {},
  })
  t.after(() => updates.stop())
  assert.deepEqual(await updates.check(), { result: 'error', retrying: true })
  const fired = []
  for (let i = 0; i < QUICK_RETRIES; i++) {
    const next = retries(QUICK_RETRY_MS).find(entry => !fired.includes(entry))
    assert.ok(next, `quick retry ${i + 1} is scheduled`)
    fired.push(next)
    next.fn()
    // The retried check fails again: the next quick retry, or the 30-minute one once they run out.
    await settle(() => (i + 1 < QUICK_RETRIES ? retries(QUICK_RETRY_MS).length === i + 2 : retries(RETRY_MS).length === 1), `retry ${i + 1} to finish`)
  }
  assert.equal(retries(QUICK_RETRY_MS).length, QUICK_RETRIES)
  assert.equal(retries(RETRY_MS).length, 1)
})

// The stale pending update (#654): after 3.95.0 installed, Felipe's Mac still had the 3.95.0
// pending download beside update.zip and current.blockmap, which could look ready to install.
function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// The updater cache as macOS had it: the base archive and blockmap, and the pending installer
// electron-updater wrote for that same version.
function writeMacCache(cacheDir, version) {
  mkdirSync(join(cacheDir, 'pending'), { recursive: true })
  writeFileSync(join(cacheDir, 'update.zip'), 'zip')
  writeFileSync(join(cacheDir, 'current.blockmap'), 'blockmap')
  writeFileSync(join(cacheDir, 'pending', 'update-info.json'), JSON.stringify({ fileName: `Automagik-${version}-mac-arm64.zip`, sha512: 'sha512', isAdminRightsRequired: false }))
  writeFileSync(join(cacheDir, 'pending', `Automagik-${version}-mac-arm64.zip`), 'installer')
}

const macPendingPaths = (cacheDir, version) => [
  join(cacheDir, 'pending', 'update-info.json'),
  join(cacheDir, 'pending', `Automagik-${version}-mac-arm64.zip`),
]
const macBasePaths = cacheDir => [join(cacheDir, 'update.zip'), join(cacheDir, 'current.blockmap')]
const macCachePaths = (cacheDir, version) => [...macPendingPaths(cacheDir, version), ...macBasePaths(cacheDir)]

// A fake electron-updater whose app-update.yml (in a temp dir) names the cache folder, as the
// real one does: these tests never look at, or write to, an installed app's cache.
function updaterWithCache(t, name = 'automagik-desktop-updater') {
  const base = tempDir(t, 'automagik-updater-base-')
  const config = join(base, 'app-update.yml')
  writeFileSync(config, `provider: github\nupdaterCacheDirName: ${name}\n`)
  const updater = fakeUpdater()
  updater.app = { baseCachePath: base, appUpdateConfigPath: config, name: 'Automagik' }
  return { updater, cacheDir: join(base, name) }
}

test('cleanStaleCache keeps the equal 3.95.0 base in the real Mac cache shape and removes only pending', (t) => {
  const cacheDir = tempDir(t, 'automagik-updater-cache-')
  writeMacCache(cacheDir, '3.95.0')
  const cleaned = cleanStaleCache(cacheDir, { current: '3.95.0' })
  assert.equal(cleaned.stale, true)
  assert.equal(cleaned.version, '3.95.0')
  // Equal is the normal state after every Mac install: electron-updater keeps update.zip and
  // current.blockmap as the next update's differential base (MacUpdater.js), so only the
  // pending files go; removing the base would make every later update a full download.
  assert.deepEqual([...cleaned.removed].sort(), [
    'pending/update-info.json',
    'pending/Automagik-3.95.0-mac-arm64.zip',
  ].sort())
  for (const path of macPendingPaths(cacheDir, '3.95.0')) assert.equal(existsSync(path), false, path)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
  // A missing cache dir, or a current version it cannot read, is a no-op.
  assert.deepEqual(cleanStaleCache(join(cacheDir, 'missing'), { current: '3.95.0' }), { stale: false, version: null, removed: [] })
  assert.deepEqual(cleanStaleCache(cacheDir, { current: 'not-a-version' }), { stale: false, version: null, removed: [] })
})

// The cache exactly as issue #654 reported it: no update-info.json, only the pending installer's
// name carrying the version.
test('the observed Mac cache without update-info.json is recognized from the pending installer name', (t) => {
  const cacheDir = tempDir(t, 'automagik-updater-cache-')
  mkdirSync(join(cacheDir, 'pending'), { recursive: true })
  writeFileSync(join(cacheDir, 'update.zip'), 'zip')
  writeFileSync(join(cacheDir, 'current.blockmap'), 'blockmap')
  writeFileSync(join(cacheDir, 'pending', 'Automagik-3.95.0-mac-arm64.zip'), 'installer')
  assert.deepEqual(cleanStaleCache(cacheDir, { current: '3.95.0' }), {
    stale: true,
    version: '3.95.0',
    removed: ['pending/Automagik-3.95.0-mac-arm64.zip'],
  })
  for (const path of macPendingPaths(cacheDir, '3.95.0')) assert.equal(existsSync(path), false, path)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
})

// The AppImage cache names its installer `Automagik-3.95.0-linux-x86_64.AppImage`. Parsed with
// the `_` as a separator it read as the prerelease 3.95.0-linux-x86-64, strictly older than
// 3.95.0, so a normal AppImage update deleted its own differential base too.
test('a Linux AppImage pending at the running version keeps the base too', (t) => {
  const cacheDir = tempDir(t, 'automagik-updater-cache-')
  mkdirSync(join(cacheDir, 'pending'), { recursive: true })
  writeFileSync(join(cacheDir, 'update.zip'), 'zip')
  writeFileSync(join(cacheDir, 'current.blockmap'), 'blockmap')
  writeFileSync(join(cacheDir, 'pending', 'Automagik-3.95.0-linux-x86_64.AppImage'), 'installer')
  assert.deepEqual(cleanStaleCache(cacheDir, { current: '3.95.0' }), {
    stale: true,
    version: '3.95.0',
    removed: ['pending/Automagik-3.95.0-linux-x86_64.AppImage'],
  })
  assert.equal(existsSync(join(cacheDir, 'pending', 'Automagik-3.95.0-linux-x86_64.AppImage')), false)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
})

test('cleanStaleCache never removes a newer pending, even when a stale version is named', (t) => {
  const cacheDir = tempDir(t, 'automagik-updater-cache-')
  writeMacCache(cacheDir, '3.96.0')
  assert.deepEqual(cleanStaleCache(cacheDir, { current: '3.95.0' }), { stale: false, version: '3.96.0', removed: [] })
  assert.deepEqual(cleanStaleCache(cacheDir, { current: '3.95.0', version: '3.95.0' }), { stale: false, version: '3.96.0', removed: [] })
  for (const path of macCachePaths(cacheDir, '3.96.0')) assert.equal(existsSync(path), true, path)
})

test('cleanStaleCache removes the base only when the cached version is strictly older', (t) => {
  const older = tempDir(t, 'automagik-updater-cache-')
  writeMacCache(older, '3.94.0')
  assert.deepEqual(cleanStaleCache(older, { current: '3.95.0' }), {
    stale: true,
    version: '3.94.0',
    removed: [
      'pending/Automagik-3.94.0-mac-arm64.zip',
      'pending/update-info.json',
      'update.zip',
      'current.blockmap',
    ],
  })
  for (const path of macCachePaths(older, '3.94.0')) assert.equal(existsSync(path), false, path)
  // An equal version named by a download report keeps the base too: it is still the next
  // update's differential base, even with no pending files left beside it.
  const equalBase = tempDir(t, 'automagik-updater-cache-')
  writeFileSync(join(equalBase, 'update.zip'), 'zip')
  writeFileSync(join(equalBase, 'current.blockmap'), 'blockmap')
  assert.deepEqual(cleanStaleCache(equalBase, { current: '3.95.0', version: '3.95.0' }), { stale: true, version: '3.95.0', removed: [] })
  for (const path of macBasePaths(equalBase)) assert.equal(existsSync(path), true, path)
})

// Windows makes a directory symlink only for an administrator or Developer Mode, but a junction
// needs neither (and lstat reports it as a link too).
function linkDir(target, path) {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

test('a symlinked pending folder is never followed: nothing outside the cache is read or removed', (t) => {
  const cacheDir = tempDir(t, 'automagik-updater-cache-')
  const outside = tempDir(t, 'automagik-updater-outside-')
  writeFileSync(join(cacheDir, 'update.zip'), 'zip')
  writeFileSync(join(cacheDir, 'current.blockmap'), 'blockmap')
  writeFileSync(join(outside, 'update-info.json'), JSON.stringify({ fileName: 'Automagik-3.95.0-mac-arm64.zip' }))
  writeFileSync(join(outside, 'Automagik-3.95.0-mac-arm64.zip'), 'installer')
  if (!linkDir(outside, join(cacheDir, 'pending'))) return t.skip('this machine cannot make a directory link')
  // The version scan does not read through the link, so the cache names no version at all.
  assert.deepEqual(cleanStaleCache(cacheDir, { current: '3.95.0' }), { stale: false, version: null, removed: [] })
  // Even a version named by a download report (equal, so stale) touches neither the link's
  // target nor the link itself; the base files stay.
  assert.deepEqual(cleanStaleCache(cacheDir, { current: '3.95.0', version: '3.95.0' }), { stale: true, version: '3.95.0', removed: [] })
  for (const name of ['update-info.json', 'Automagik-3.95.0-mac-arm64.zip']) assert.equal(existsSync(join(outside, name)), true, name)
  assert.equal(lstatSync(join(cacheDir, 'pending')).isSymbolicLink(), true)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
})

test("the updater cache is electron-updater's own layout from a temp app-update.yml, never a hardcoded path", (t) => {
  const base = tempDir(t, 'automagik-updater-base-')
  const configDir = tempDir(t, 'automagik-updater-config-')
  const config = join(configDir, 'app-update.yml')
  const app = { baseCachePath: base, appUpdateConfigPath: config, name: 'Automagik' }
  writeFileSync(config, 'provider: github\nupdaterCacheDirName: "@automagik/omni-desktop"\n')
  assert.equal(updaterCacheDir({ app }), join(base, '@automagik/omni-desktop'))
  // electron-updater's DownloadedUpdateHelper wins once a download has made one.
  assert.equal(updaterCacheDir({ app, downloadedUpdateHelper: { cacheDir: join(base, 'known') } }), join(base, 'known'))
  // The app's name is electron-updater's fallback when the config is not there.
  assert.equal(updaterCacheDir({ app: { ...app, appUpdateConfigPath: join(configDir, 'missing.yml') } }), join(base, 'Automagik'))
  writeFileSync(config, 'provider: github\nupdaterCacheDirName: automagik-updater # sanitized package name\n')
  assert.equal(updaterCacheDir({ app }), join(base, 'automagik-updater'))
  assert.equal(updaterCacheDir({}), null)
  assert.equal(updaterCacheDir({ app: { name: 'Automagik' } }), null)
  assert.equal(updaterCacheDir({ app: { baseCachePath: base, appUpdateConfigPath: null, name: '' } }), null)
})

test('startUpdates drops the install-time stale pending at start and on a stale update-downloaded, with no ready state', async (t) => {
  const { updater, cacheDir } = updaterWithCache(t)
  writeMacCache(cacheDir, '3.95.0')
  const states = []
  const warnings = []
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'darwin', env: {}, timers: noTimers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  // Equal: the pending files go so nothing can be ready, and the base stays for the next update.
  for (const path of macPendingPaths(cacheDir, '3.95.0')) assert.equal(existsSync(path), false, path)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
  assert.equal(updates.ready, null)
  assert.deepEqual(states, [])
  assert.deepEqual(warnings, ['update: the cached 3.95.0 update is not newer than 3.95.0; ignoring it'])
  // electron-updater reports the same download again: it is ignored and its pending files removed.
  writeMacCache(cacheDir, '3.95.0')
  updater.emit('update-downloaded', { version: '3.95.0' })
  assert.equal(updates.ready, null)
  assert.deepEqual(states, [])
  for (const path of macPendingPaths(cacheDir, '3.95.0')) assert.equal(existsSync(path), false, path)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
  assert.match(warnings.at(-1), /update: 3\.95\.0 is not newer than 3\.95\.0; ignoring it/)
})

test('a newer pending update survives the start cleanup and still readies and installs', async (t) => {
  const { updater, cacheDir } = updaterWithCache(t)
  writeMacCache(cacheDir, '3.96.0')
  const states = []
  const warnings = []
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'darwin', env: {}, timers: noTimers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  for (const path of macCachePaths(cacheDir, '3.96.0')) assert.equal(existsSync(path), true, path)
  assert.deepEqual(warnings, [])
  updater.emit('update-downloaded', { version: '3.96.0' })
  assert.equal(updates.ready, '3.96.0')
  assert.deepEqual(states, [{ version: '3.96.0', state: 'ready' }])
  updates.install()
  assert.deepEqual(updater.installs, [[false, true]])
})

test('a stale update-downloaded never disturbs a newer ready update, and removes only the stale files', async (t) => {
  const { updater, cacheDir } = updaterWithCache(t)
  const states = []
  const warnings = []
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'darwin', env: {}, timers: noTimers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  updater.emit('update-downloaded', { version: '3.96.0' })
  assert.equal(updates.ready, '3.96.0')
  writeMacCache(cacheDir, '3.95.0')
  updater.emit('update-downloaded', { version: '3.95.0' })
  // 3.96.0 is still newer than 3.95.0: a stale report must not clear it, and it stays the ready one.
  assert.equal(updates.ready, '3.96.0')
  assert.deepEqual(states, [{ version: '3.96.0', state: 'ready' }])
  assert.match(warnings.at(-1), /3\.95\.0 is not newer than 3\.95\.0/)
  for (const path of macPendingPaths(cacheDir, '3.95.0')) assert.equal(existsSync(path), false, path)
  for (const path of macBasePaths(cacheDir)) assert.equal(existsSync(path), true, path)
})

test('an update-downloaded version equal to, older than, or invalid for the app is logged and never ready', async (t) => {
  const updater = fakeUpdater()
  const warnings = []
  const states = []
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'linux', env: {}, timers: noTimers,
    log: { ...quiet, warn: message => warnings.push(message) },
    onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  for (const version of ['3.95.0', '3.94.9', 'not-a-version']) {
    updater.emit('update-downloaded', { version })
    assert.equal(updates.ready, null, version)
  }
  assert.deepEqual(states, [])
  assert.equal(warnings.length, 3)
  assert.match(warnings[0], /3\.95\.0 is not newer/)
  assert.match(warnings[1], /3\.94\.9 is not newer/)
  assert.match(warnings[2], /not-a-version is not newer/)
})

test("Squirrel's update-downloaded cannot ready a pending download that is not newer", async (t) => {
  const { updater } = updaterWithCache(t)
  updater.nativeUpdater = new EventEmitter()
  const states = []
  const updates = startUpdates({
    updater, current: '3.95.0', platform: 'darwin', env: {}, timers: noTimers,
    log: quiet, onState: state => states.push(state),
  })
  t.after(() => updates.stop())
  updater.emit('update-downloaded', { version: '3.95.0' })
  updater.nativeUpdater.emit('update-downloaded')
  assert.equal(updates.ready, null)
  assert.deepEqual(states, [])
})
