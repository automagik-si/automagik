// Antigravity's CLI (`agy`), installed only when the person clicks Install (#2048): the same
// per-platform release manifest and download Google's own install scripts use, read as data.
// No script is ever run or piped to a shell, `agy install` is never run, and no shell profile,
// PATH entry or `~/.local/bin` is written. The download is checked against the manifest's
// sha512 (the manifest itself carries no signature), the binary must answer `--version` with
// the manifest's version, and only then is the folder published (clis.js). Every host below
// is pinned here and nowhere else; scripts/agy-scripts.mjs checks daily that the official
// scripts still name them.
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, rmSync, chmodSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { NO_BUS_ADDRESS } from './agents.js'
import { batchSafe } from './batch-spawn.js'
import { INSTALL_TIMEOUT_MS } from './install.js'
import { redactText } from './redact.js'

export const AGY_MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
export const AGY_DOWNLOAD_HOST = 'storage.googleapis.com'
export const AGY_DOWNLOAD_PATH = '/antigravity-public/antigravity-cli/'
export const AGY_SCRIPTS_BASE = 'https://antigravity.google/cli/'
export const AGY_SCRIPTS = Object.freeze(['install.sh', 'install.ps1', 'install.cmd'])
// The desktop platforms the scripts build a manifest name for (install.sh and install.ps1);
// Termux's `android_<arch>` is not one.
export const AGY_PLATFORMS = Object.freeze(['linux_amd64', 'linux_arm64', 'linux_amd64_musl', 'linux_arm64_musl',
  'darwin_amd64', 'darwin_arm64', 'windows_amd64', 'windows_arm64'])

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MANIFEST_MAX_BYTES = 16 * 1024
export const AGY_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024
const UNREADABLE = 'Antigravity\'s release manifest was unreadable'
const VERSION_FAILED = 'Antigravity did not pass its version check after installation'
// Windows Defender holds a fresh executable for a moment: a rename is tried again a few times.
const RENAME_TRIES = 6
const RENAME_WAIT_MS = 200
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * The manifest name for this desktop: the scripts' own `<os>_<arch>[_musl]`. A desktop that is
 * not one of them gets Antigravity's own refusal, never the Claude Code and Codex one.
 * @param {{ platform?: string, arch?: string, musl?: boolean, translated?: boolean }} [options]
 */
export function agyPlatform({ platform = process.platform, arch = process.arch, musl, translated } = {}) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Antigravity does not support ${platform}/${arch}`)
  }
  if (platform === 'linux' && musl === undefined) musl = !process.report.getReport().header.glibcVersionRuntime
  if (platform === 'darwin' && arch === 'x64') {
    // A desktop started under Rosetta takes the native arm64 build, as install.sh does.
    if (translated === undefined) {
      try {
        translated = execFileSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1'
      } catch { translated = false }
    }
    if (translated) arch = 'arm64'
  }
  const a = arch === 'x64' ? 'amd64' : 'arm64'
  if (platform === 'win32') return `windows_${a}`
  if (platform === 'darwin') return `darwin_${a}`
  return musl ? `linux_${a}_musl` : `linux_${a}`
}

/**
 * The download `raw` names, when it is exactly what the pin allows for `version` on the
 * manifest `key`: https, the pinned host and path, no port, credentials, query, fragment or
 * encoded separator, the platform's own file type, and a first path segment that is the
 * version (or the version and a build number). Otherwise undefined.
 */
export function agyDownloadUrl(raw, version, key) {
  // `?` and `#` are refused even when empty: the parsed URL would drop them, the href keeps them.
  if (typeof raw !== 'string' || /%2f|%5c|\\|\.\.|[?#]/i.test(raw)) return undefined
  let u
  try { u = new URL(raw) } catch { return undefined }
  if (u.protocol !== 'https:' || u.hostname !== AGY_DOWNLOAD_HOST || u.port !== '') return undefined
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return undefined
  if (!u.pathname.startsWith(AGY_DOWNLOAD_PATH)) return undefined
  if (!u.pathname.endsWith(String(key).startsWith('windows_') ? '.exe' : '.tar.gz')) return undefined
  const segment = u.pathname.slice(AGY_DOWNLOAD_PATH.length).split('/')[0]
  const build = segment.startsWith(`${version}-`) ? segment.slice(version.length + 1) : undefined
  if (segment !== version && !(build !== undefined && /^\d{1,32}$/.test(build))) return undefined
  return u
}

/**
 * The manifest's fields, checked: { version, url, sha512 }, the url being the parsed one's
 * `href`. Extra fields are ignored here (the daily check reports them). Throws why not.
 */
export function parseAgyManifest(text, key) {
  let body
  try { body = JSON.parse(text) } catch { throw new Error('the manifest is not JSON') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('the manifest is not an object')
  const { version, sha512, url } = body
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('the manifest names no stable version')
  if (typeof sha512 !== 'string' || !/^[0-9a-f]{128}$/i.test(sha512)) throw new Error('the manifest names no sha512')
  const u = agyDownloadUrl(url, version, key)
  if (u === undefined) throw new Error('the manifest names a download outside the pinned place')
  return { version, url: u.href, sha512: sha512.toLowerCase() }
}

const withTimeout = (signal, ms) => AbortSignal.any([AbortSignal.timeout(ms), ...(signal ? [signal] : [])])

async function readCapped(response, max) {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new Error('the manifest is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Reads the release manifest for `key` (one of AGY_PLATFORMS) from the pinned host, with no
 * redirect followed. Throws "Antigravity's release manifest was unreadable" (with why first).
 */
export async function fetchAgyManifest(key, { fetch = globalThis.fetch, signal, timeoutMs = 15_000 } = {}) {
  try {
    if (!AGY_PLATFORMS.includes(key)) throw new Error('no manifest for this platform')
    const response = await fetch(`${AGY_MANIFEST_BASE}/manifests/${key}.json`, {
      redirect: 'error', headers: { accept: 'application/json' }, signal: withTimeout(signal, timeoutMs),
    })
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {})
      throw new Error(`the manifest answered ${response.status}`)
    }
    return parseAgyManifest(await readCapped(response, MANIFEST_MAX_BYTES), key)
  } catch (error) {
    throw new Error(`${String(error?.message ?? error).split('\n')[0].slice(0, 200)}\n${UNREADABLE}`)
  }
}

/**
 * A rename that, on Windows, tries again while another process (an antivirus) holds the file:
 * up to 5 more times, 200 ms apart. Anywhere else, once.
 */
export async function renameRetry(from, to, { platform = process.platform, rename = renameSync, wait = RENAME_WAIT_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to)
      return
    } catch (error) {
      if (platform !== 'win32' || !RETRY_CODES.has(error?.code) || attempt >= RENAME_TRIES) throw error
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

const tarOf = platform => (platform === 'darwin' ? '/usr/bin/tar' : 'tar')

const run = (command, args, options, runner) => new Promise((resolve, reject) => {
  runner(command, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)))
})

async function download(url, path, expected, { fetch, signal, maxBytes, openFile }) {
  const response = await fetch(url, { redirect: 'error', signal })
  if (response.status !== 200) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error(`Antigravity's download answered ${response.status}`)
  }
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Antigravity\'s download is larger than expected')
  const hash = createHash('sha512')
  const file = await openFile(path, 'wx', 0o600)
  let size = 0
  try {
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('Antigravity\'s download was empty')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error('Antigravity\'s download is larger than expected')
      }
      hash.update(value)
      try {
        await file.write(value)
      } catch (error) {
        if (error?.code === 'ENOSPC') throw new Error('Not enough free disk space to install Antigravity (it needs about twice its download size).')
        throw error
      }
    }
  } finally {
    await file.close().catch(() => {})
  }
  // Nothing is extracted from a download that is not the published one.
  if (hash.digest('hex') !== expected) throw new Error('Antigravity\'s download did not match its published checksum')
}

/**
 * Downloads the manifest's file into the staging folder `dir` (made by clis.js), checks its
 * sha512 and leaves exactly `bin/agy` (or `bin\agy.exe`) there. A tar.gz is unpacked with the
 * system tar, its one `antigravity` member only, as install.sh does; a Windows download is the
 * executable itself. The download and the unpack folder are removed before the version check.
 */
export async function installAgy(dir, spec, manifest, { signal, platform = process.platform, fetch = globalThis.fetch, execFile: runner = execFile, rename = renameSync, maxBytes = AGY_DOWNLOAD_MAX_BYTES, wait, openFile = open } = {}) {
  const bin = join(dir, 'bin')
  const unpack = join(dir, 'x')
  mkdirSync(bin, { mode: 0o700 })
  mkdirSync(unpack, { mode: 0o700 })
  const payload = join(dir, 'payload')
  const limited = withTimeout(signal, INSTALL_TIMEOUT_MS)
  await download(manifest.url, payload, manifest.sha512, { fetch, signal: limited, maxBytes, openFile })
  if (platform === 'win32') {
    await renameRetry(payload, join(bin, `${spec.cli}.exe`), { platform, rename, ...(wait === undefined ? {} : { wait }) })
  } else {
    await run(tarOf(platform), ['-xzf', payload, '-C', unpack, 'antigravity'], { signal: limited, windowsHide: true, maxBuffer: 64 * 1024 }, runner)
    rmSync(payload, { force: true })
    const member = join(unpack, 'antigravity')
    let stat
    try { stat = lstatSync(member) } catch { throw new Error('Antigravity\'s download held no antigravity binary') }
    if (!stat.isFile()) throw new Error('Antigravity\'s download held no regular antigravity binary')
    renameSync(member, join(bin, spec.cli))
    chmodSync(join(bin, spec.cli), 0o755)
  }
  rmSync(unpack, { recursive: true, force: true })
}

/**
 * The version `agy --version` printed, or undefined, with what it printed. It runs with an
 * allowlisted environment and a scratch home (`scratch`, inside the staging folder), never the
 * person's: no DSH secret reaches it, it writes nothing in the person's home, and its updater
 * is off, so the binary whose sha512 was checked is the one published.
 */
export function agyVersion(path, { run: runner = execFile, signal, platform = process.platform, scratch, env = process.env } = {}) {
  const own = {
    ...(env.PATH === undefined ? {} : { PATH: env.PATH }),
    HOME: scratch, USERPROFILE: scratch, LOCALAPPDATA: scratch, APPDATA: scratch,
    XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    // agy finds the session bus by the user id when the address is unset (#2048): this run
    // gets one that can never connect, as every other agy run does (cli-homes.js).
    DBUS_SESSION_BUS_ADDRESS: NO_BUS_ADDRESS,
  }
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT']) if (env[key] !== undefined) own[key] = env[key]
    own.TEMP = scratch
    own.TMP = scratch
  }
  return new Promise(resolve => {
    try {
      runner(...batchSafe(path, ['--version'], {
        env: own, cwd: scratch, signal, timeout: 8000, maxBuffer: 16_384, windowsHide: true,
      }, platform), (error, stdout) => {
        const printed = String(stdout ?? '')
        const line = printed.trim().split(/\r?\n/)[0] ?? ''
        const found = line.match(/^(?:agy|antigravity(?:[ -]cli)?)?(?:\s+version)?\s*v?(\d+\.\d+\.\d+)(?:-\d+|\+[0-9A-Za-z.]+)?(?=\s|$)/i)?.[1]
        resolve({ version: !error && VERSION.test(found ?? '') ? found : undefined, printed })
      })
    } catch (error) {
      resolve({ version: undefined, printed: '', error })
    }
  })
}

/** Throws unless the staged binary says it is `expected`; the error shows what it printed. */
export async function checkAgyVersion(path, expected, options = {}) {
  const { version, printed } = await agyVersion(path, options)
  if (version === expected) return version
  const shown = redactText(printed.slice(0, 120)).replace(/\p{Cc}+/gu, ' ').trim()
  throw new Error(`agy --version printed: "${shown}"\n${VERSION_FAILED}`)
}
