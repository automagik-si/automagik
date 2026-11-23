// Antigravity's install source (#2048): the pin, the manifest rule, the download and its
// sha512, the unpack and the version check. Pure: every fetch is a fake, nothing is spawned but
// the test's own `tar` (to build and unpack a fixture archive), and no network is reached.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AGENTS, NO_BUS_ADDRESS } from '../src/host/agents.js'
import {
  AGY_DOWNLOAD_HOST, AGY_DOWNLOAD_PATH, AGY_MANIFEST_BASE, AGY_PLATFORMS, AGY_SCRIPTS, AGY_SCRIPTS_BASE,
  agyPlatform, agyVersion, checkAgyVersion, fetchAgyManifest, installAgy, renameRetry,
} from '../src/host/agy-source.js'
import { MANIFEST_LINES, scriptBase } from '../scripts/agy-scripts.mjs'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const SPEC = AGENTS['acp-antigravity']
const unixOnly = { skip: process.platform === 'win32' ? 'builds its archive with a POSIX tar' : false }
const SHA = 'ab'.repeat(64)
const URL_OF = (version = '1.5.15', file = 'linux-x64/cli_linux_x64.tar.gz', build = '-5514532022517760') =>
  `https://${AGY_DOWNLOAD_HOST}${AGY_DOWNLOAD_PATH}${version}${build}/${file}`
const manifestBody = (over = {}) => JSON.stringify({ version: '1.5.15', url: URL_OF(), sha512: SHA, ...over })

// A fetch that answers one body, and records what it was asked.
function fakeFetch(answer) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return typeof answer === 'function' ? answer(url, options) : answer
  }
  return { fetch, calls }
}
const respond = (body, status = 200, headers = {}) => new Response(body, { status, headers })
const streamOf = (chunks) => new Response(new ReadableStream({
  pull(controller) {
    const next = chunks.shift()
    if (next === undefined) controller.close()
    else controller.enqueue(next)
  },
}))
const sha512 = bytes => createHash('sha512').update(bytes).digest('hex')
const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-source-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('T1: the fixture records the three official scripts, their sha256 and the manifest fields', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'agy-install.json'), 'utf8'))
  assert.equal(fixture.source, AGY_SCRIPTS_BASE)
  assert.deepEqual(Object.keys(fixture.scripts), [...AGY_SCRIPTS])
  assert.deepEqual(fixture.manifestKeys, ['sha512', 'url', 'version'])
  const sums = readFileSync(join(FIXTURES, 'agy-install.SHA256SUMS'), 'utf8').trim().split('\n')
  assert.equal(sums.length, AGY_SCRIPTS.length)
  for (const name of AGY_SCRIPTS) {
    const { sha256, bytes } = fixture.scripts[name]
    assert.match(sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isInteger(bytes) && bytes > 0)
    assert.ok(sums.includes(`${sha256}  ${name}`), `${name} is in SHA256SUMS with the same sha256`)
  }
})

test('T2: the pin is the host every script names, and the platforms are the scripts\' own', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'agy-install.json'), 'utf8'))
  for (const name of AGY_SCRIPTS) {
    const { baseLine, manifestLine } = fixture.scripts[name]
    assert.equal(scriptBase(name, baseLine), AGY_MANIFEST_BASE, `${name} names the pinned manifest host`)
    assert.match(manifestLine, /\/manifests\//)
    assert.match(manifestLine, /\.json/)
    assert.match(manifestLine, MANIFEST_LINES[name])
  }
  assert.deepEqual(fixture.platforms, [...AGY_PLATFORMS])
  // A base line that names another host is not the pin.
  assert.notEqual(scriptBase('install.sh', 'DOWNLOAD_BASE_URL="https://elsewhere.example"'), AGY_MANIFEST_BASE)
  // Two base lines are no answer.
  assert.equal(scriptBase('install.sh', `${fixture.scripts['install.sh'].baseLine}\n${fixture.scripts['install.sh'].baseLine}`), undefined)
})

test('T3: the manifest name for each desktop, and Antigravity\'s own refusal for any other', () => {
  const cases = [
    [{ platform: 'linux', arch: 'x64', musl: false }, 'linux_amd64'],
    [{ platform: 'linux', arch: 'arm64', musl: false }, 'linux_arm64'],
    [{ platform: 'linux', arch: 'x64', musl: true }, 'linux_amd64_musl'],
    [{ platform: 'linux', arch: 'arm64', musl: true }, 'linux_arm64_musl'],
    [{ platform: 'darwin', arch: 'x64', translated: false }, 'darwin_amd64'],
    [{ platform: 'darwin', arch: 'arm64' }, 'darwin_arm64'],
    [{ platform: 'darwin', arch: 'x64', translated: true }, 'darwin_arm64'],
    [{ platform: 'win32', arch: 'x64' }, 'windows_amd64'],
    [{ platform: 'win32', arch: 'arm64' }, 'windows_arm64'],
  ]
  for (const [input, key] of cases) {
    assert.equal(agyPlatform(input), key)
    assert.ok(AGY_PLATFORMS.includes(key))
  }
  for (const input of [{ platform: 'linux', arch: 'ia32' }, { platform: 'freebsd', arch: 'x64' }, { platform: 'win32', arch: 'ia32' }]) {
    assert.throws(() => agyPlatform(input), error => error.message.startsWith('Antigravity does not support') && !/Claude Code and Codex/.test(error.message))
  }
})

test('T4: the manifest is read from the pinned host with no redirect, and only the pinned download passes', async () => {
  const ok = fakeFetch(() => respond(manifestBody()))
  assert.deepEqual(await fetchAgyManifest('linux_amd64', { fetch: ok.fetch }), { version: '1.5.15', url: URL_OF(), sha512: SHA })
  assert.equal(ok.calls.length, 1)
  assert.equal(ok.calls[0].url, `${AGY_MANIFEST_BASE}/manifests/linux_amd64.json`)
  assert.equal(ok.calls[0].options.redirect, 'error')
  // A plain version and an upper-case sha512 pass too (kept lowercased); extra fields are ignored.
  const plain = await fetchAgyManifest('darwin_arm64', { fetch: fakeFetch(() => respond(manifestBody({ url: URL_OF('1.5.15', 'darwin-arm/cli_mac_arm64.tar.gz', ''), sha512: SHA.toUpperCase(), signature: 'x' }))).fetch })
  assert.equal(plain.sha512, SHA)
  const win = await fetchAgyManifest('windows_amd64', { fetch: fakeFetch(() => respond(manifestBody({ url: URL_OF('1.5.15', 'windows-x64/agy.exe') }))).fetch })
  assert.match(win.url, /\.exe$/)

  const refused = async (answer, key = 'linux_amd64') => {
    await assert.rejects(fetchAgyManifest(key, { fetch: fakeFetch(answer).fetch }), /Antigravity's release manifest was unreadable$/)
  }
  // A redirect: the fetch is told to fail on one, as a real fetch does.
  await refused((url, options) => {
    assert.equal(options.redirect, 'error')
    throw new TypeError('fetch failed: redirect mode is set to error')
  })
  await refused(() => respond('moved', 302, { location: 'https://evil.example/' }))
  await refused(() => respond('', 404))
  await refused(() => respond(`{"version":"1.5.15","pad":"${'x'.repeat(17 * 1024)}"}`))
  await refused(() => respond('{not json'))
  for (const version of ['1.5.15-rc.1', 'v1.5.15', '1.5', '01.5.15']) await refused(() => respond(manifestBody({ version })))
  for (const sha of ['ab'.repeat(63), 'zz'.repeat(64), 7]) await refused(() => respond(manifestBody({ sha512: sha })))
  const bad = [
    URL_OF().replace('https:', 'http:'),
    URL_OF().replace(AGY_DOWNLOAD_HOST, 'storage.example.com'),
    `https://${AGY_DOWNLOAD_HOST}/other-bucket/antigravity-cli/1.5.15/linux-x64/cli.tar.gz`,
    `https://${AGY_DOWNLOAD_HOST}@evil.example/antigravity-public/antigravity-cli/x.tar.gz`,
    `https://${AGY_DOWNLOAD_HOST}/antigravity-public/antigravity-cli/%2e%2e/other/x.tar.gz`,
    URL_OF().replace(AGY_DOWNLOAD_HOST, `${AGY_DOWNLOAD_HOST}:8443`),
    `${URL_OF()}?x=1`,
    `${URL_OF()}#frag`,
    `${URL_OF()}?`,
    `${URL_OF()}#`,
    URL_OF().replace('/linux-x64/', '\\linux-x64/'),
    URL_OF().replace('/linux-x64/', '/linux-x64/%2f'),
    URL_OF('1.5.15', 'linux-x64/cli.zip'),
    URL_OF('1.5.14', 'linux-x64/cli_linux_x64.tar.gz', '-5514532022517760'),
    URL_OF('1.5.15', 'linux-x64/cli_linux_x64.tar.gz', '-beta'),
  ]
  for (const url of bad) await refused(() => respond(manifestBody({ url })))
  for (const file of ['windows-x64/agy.zip', 'windows-x64/agy.msi', 'windows-x64/install.ps1', 'windows-x64/agy.tar.gz']) {
    await refused(() => respond(manifestBody({ url: URL_OF('1.5.15', file) })), 'windows_amd64')
  }
  // A platform that is not one of the scripts' asks nothing.
  const none = fakeFetch(() => assert.fail('no manifest is fetched for an unknown platform'))
  await assert.rejects(fetchAgyManifest('android_arm64', { fetch: none.fetch }), /unreadable/)
})

// A tar.gz holding `members` (name -> text, or { link } for a symlink), built with the test's tar.
function archive(t, members) {
  const dir = scratch(t)
  const src = join(dir, 'src')
  mkdirSync(src)
  for (const [name, value] of Object.entries(members)) {
    if (typeof value === 'object') symlinkSync(value.link, join(src, name))
    else writeFileSync(join(src, name), value, { mode: 0o755 })
  }
  const out = join(dir, 'payload.tar.gz')
  execFileSync('tar', ['-czf', out, '-C', src, ...Object.keys(members)])
  return readFileSync(out)
}
const staging = (t) => {
  const dir = join(scratch(t), '.install-1')
  mkdirSync(dir, { mode: 0o700 })
  return dir
}
const manifestFor = (bytes, url = URL_OF()) => ({ version: '1.5.15', url, sha512: sha512(bytes) })

test('T5: a verified tar.gz leaves only bin/agy; a wrong checksum, a symlink, a missing member or an oversize body publish nothing', unixOnly, async (t) => {
  const bytes = archive(t, { antigravity: '#!/bin/sh\necho 1.5.15\n' })
  const dir = staging(t)
  const got = fakeFetch(() => respond(bytes))
  await installAgy(dir, SPEC, manifestFor(bytes), { fetch: got.fetch, platform: 'linux' })
  assert.deepEqual(readdirSync(dir).sort(), ['bin'])
  assert.deepEqual(readdirSync(join(dir, 'bin')), ['agy'])
  assert.equal(readFileSync(join(dir, 'bin', 'agy'), 'utf8'), '#!/bin/sh\necho 1.5.15\n')
  assert.equal(got.calls[0].url, URL_OF())
  assert.equal(got.calls[0].options.redirect, 'error')

  // The checksum is checked before anything is unpacked.
  const wrong = staging(t)
  await assert.rejects(installAgy(wrong, SPEC, { ...manifestFor(bytes), sha512: SHA }, { fetch: fakeFetch(() => respond(bytes)).fetch, platform: 'linux', execFile: () => assert.fail('nothing is unpacked from a download that does not match') }),
    /did not match its published checksum/)
  assert.equal(existsSync(join(wrong, 'bin', 'agy')), false)

  const link = archive(t, { antigravity: { link: '/bin/sh' } })
  const linked = staging(t)
  await assert.rejects(installAgy(linked, SPEC, manifestFor(link), { fetch: fakeFetch(() => respond(link)).fetch, platform: 'linux' }), /no regular antigravity binary/)
  assert.equal(existsSync(join(linked, 'bin', 'agy')), false)

  const other = archive(t, { 'not-it': 'x' })
  const missing = staging(t)
  await assert.rejects(installAgy(missing, SPEC, manifestFor(other), { fetch: fakeFetch(() => respond(other)).fetch, platform: 'linux' }))
  assert.equal(existsSync(join(missing, 'bin', 'agy')), false)

  const big = staging(t)
  const chunk = new Uint8Array(1024)
  await assert.rejects(installAgy(big, SPEC, manifestFor(chunk), { fetch: fakeFetch(() => streamOf([chunk, chunk, chunk])).fetch, platform: 'linux', maxBytes: 2048 }), /larger than expected/)
  assert.equal(existsSync(join(big, 'bin', 'agy')), false)

  await assert.rejects(installAgy(staging(t), SPEC, manifestFor(bytes), { fetch: fakeFetch(() => respond('', 503)).fetch, platform: 'linux' }), /answered 503/)
})

test('T5: a full disk says so in words', async (t) => {
  const bytes = Buffer.from('payload')
  const full = async () => ({
    write: async () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }) },
    close: async () => {},
  })
  await assert.rejects(installAgy(staging(t), SPEC, manifestFor(bytes), { fetch: fakeFetch(() => respond(bytes)).fetch, platform: 'linux', openFile: full }),
    { message: 'Not enough free disk space to install Antigravity (it needs about twice its download size).' })
})

test('T5: on Windows the download is bin\\agy.exe itself, its rename retried while a scanner holds it', async (t) => {
  const bytes = Buffer.from('MZ fake exe')
  const url = URL_OF('1.5.15', 'windows-x64/agy.exe')
  const dir = staging(t)
  await installAgy(dir, SPEC, manifestFor(bytes, url), { fetch: fakeFetch(() => respond(bytes)).fetch, platform: 'win32', execFile: () => assert.fail('nothing is run on Windows'), wait: 1 })
  assert.deepEqual(readdirSync(dir), ['bin'])
  assert.deepEqual(readFileSync(join(dir, 'bin', 'agy.exe')), bytes)

  // Twice EBUSY, then the rename goes through.
  let tries = 0
  const flaky = (from, to) => {
    tries++
    if (tries <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return execFileSync('mv', [from, to])
  }
  const held = staging(t)
  await installAgy(held, SPEC, manifestFor(bytes, url), { fetch: fakeFetch(() => respond(bytes)).fetch, platform: 'win32', rename: flaky, wait: 1 })
  assert.equal(tries, 3)
  assert.ok(existsSync(join(held, 'bin', 'agy.exe')))

  // Six failures: it gives up.
  let attempts = 0
  const stuck = () => { attempts++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
  await assert.rejects(renameRetry('a', 'b', { platform: 'win32', rename: stuck, wait: 1 }), /busy/)
  assert.equal(attempts, 6)
  // Elsewhere, or for another error, once.
  attempts = 0
  await assert.rejects(renameRetry('a', 'b', { platform: 'linux', rename: stuck, wait: 1 }))
  assert.equal(attempts, 1)
})

test('T6: the version reader takes the forms agy may print, refuses prereleases, and runs with an allowlisted env', async () => {
  const seen = []
  const runner = stdout => (file, args, options, done) => {
    seen.push({ file, args, options })
    if (stdout instanceof Error) done(stdout, '')
    else done(null, stdout)
  }
  const env = { PATH: '/usr/bin', HOME: '/srv/person', AUTOMAGIK_TEST_SECRET: 'planted', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/4242/bus', ANTHROPIC_API_KEY: 'x', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'cmd.exe', PATHEXT: '.EXE', APPDATA: 'C:\\Users\\p' }
  const read = (stdout, platform = 'linux') => agyVersion('/stage/bin/agy', { run: runner(stdout), platform, scratch: '/stage/home', env })
  for (const out of ['1.5.15', 'agy 1.5.15', 'agy version v1.5.15', 'Antigravity CLI 1.5.15', '1.5.15-5514532022517760', 'agy version 1.5.15 (5514532022517760)', '1.5.15+abc', '1.5.15\nmore']) {
    assert.equal((await read(`${out}\n`)).version, '1.5.15', out)
  }
  for (const out of ['1.5.15-rc.1', '1.5.15-beta', '', 'version unknown']) assert.equal((await read(out)).version, undefined, out)
  assert.equal((await read(new Error('exit 1'))).version, undefined)

  assert.deepEqual(seen[0].args, ['--version'])
  assert.equal(seen[0].file, '/stage/bin/agy')
  assert.deepEqual(Object.keys(seen[0].options.env).sort(), ['AGY_CLI_DISABLE_AUTO_UPDATE', 'APPDATA', 'DBUS_SESSION_BUS_ADDRESS', 'HOME', 'LOCALAPPDATA', 'PATH', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'])
  assert.equal(seen[0].options.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
  // The install-time run reaches no session bus either (#2048): the address never connects.
  assert.equal(seen[0].options.env.DBUS_SESSION_BUS_ADDRESS, NO_BUS_ADDRESS)
  assert.equal(seen[0].options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/dev/null/automagik-no-bus')
  assert.equal(seen[0].options.env.HOME, '/stage/home')
  assert.equal(seen[0].options.env.PATH, '/usr/bin')
  assert.equal(seen[0].options.cwd, '/stage/home')
  assert.equal('AUTOMAGIK_TEST_SECRET' in seen[0].options.env, false)
  seen.length = 0
  await read('1.5.15', 'win32')
  assert.deepEqual(Object.keys(seen[0].options.env).sort(), ['AGY_CLI_DISABLE_AUTO_UPDATE', 'APPDATA', 'ComSpec', 'DBUS_SESSION_BUS_ADDRESS', 'HOME', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'windir'])
  assert.equal(seen[0].options.env.APPDATA, '/stage/home')
  assert.equal(seen[0].options.env.TEMP, '/stage/home')
  assert.equal('AUTOMAGIK_TEST_SECRET' in seen[0].options.env, false)

  // A refusal names what it printed (the first 120 characters), then the headline.
  const long = `agy says ${'z'.repeat(200)}`
  await assert.rejects(checkAgyVersion('/stage/bin/agy', '1.5.15', { run: runner(long), scratch: '/stage/home', env }), (error) => {
    const [first, last] = error.message.split('\n')
    assert.equal(first, `agy --version printed: "${long.slice(0, 120)}"`)
    assert.equal(last, 'Antigravity did not pass its version check after installation')
    return true
  })
  await assert.rejects(checkAgyVersion('/stage/bin/agy', '1.5.16', { run: runner('1.5.15'), scratch: '/stage/home', env }), /did not pass its version check/)
  assert.equal(await checkAgyVersion('/stage/bin/agy', '1.5.15', { run: runner('agy 1.5.15'), scratch: '/stage/home', env }), '1.5.15')
})
