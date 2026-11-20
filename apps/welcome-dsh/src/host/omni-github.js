import { execFile, spawn as spawnChild } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, chmodSync, constants, copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { stripVTControlCharacters } from 'node:util'
import { Worker } from 'node:worker_threads'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { redactText } from './redact.js'

const PIN = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).automagik.omni
const SHA = /^[a-f0-9]{40}$/
const VERSION = /^\d+\.\d{6}\.\d+(?:-[0-9A-Za-z.]+)?$/
const REPO = 'automagik-si/omni'
const API = 'https://api.github.com/repos/' + REPO + '/git/'
const GIT = 'https://github.com/' + REPO + '.git/git-upload-pack'
const GIT_RESULT = 'application/x-git-upload-pack-result'
const MAX_GIT = 64 * 1024
const NPM_PACKAGE = '@automagik%2fomni'
const BUN_VERSION = '1.4.4'
const BUN = {
  'linux-x64': {
    asset: 'linux-x64',
    zip: 'bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c',
    sha256: '10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235',
  },
  'linux-arm64': {
    asset: 'linux-aarch64',
    zip: 'baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e',
    sha256: '354c2b049c716aca07b2e5cddb887928ac58950675d1258bb6312083917793b6',
  },
  'darwin-x64': {
    asset: 'darwin-x64',
    zip: '50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e',
    sha256: 'c35307c7d45d65c5a385a58c4a6cb0bb9499e4e626abdee207c177a77ba666ab',
  },
  'darwin-arm64': {
    asset: 'darwin-aarch64',
    zip: 'c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510',
    sha256: '0a2237cdcfa0d16ef501d9acca9f0026309ef348bea7393a64e8d1e3609565cc',
  },
}
const DOWNLOAD_MS = 5 * 60_000
const BUILD_MS = 10 * 60_000
const INSTALL_MS = 10 * 60_000
const MAX_LINE = 8 * 1024
const MAX_LOG = 48 * 1024
const MAX_BUN = 256 * 1024 * 1024
const STEPS = ['check', 'download', 'build', 'install']
const SANDBOX_DIRS = ['runtime', 'bin', 'autopg', 'pgserve', 'data', 'logs', 'run', 'config', 'cache']
const NO_SUPERVISOR = 'This server image cannot keep Omni running; update the image.'
const ALREADY_INSTALLED = 'Omni is already installed here. Connect to it or use an Omni on another computer.'
const ANOTHER_INSTALL = 'Another Omni install is running.'
const LIVE_OMNI = 'An Omni here is running: connect to it or stop it first.'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const quietError = (message, next = 'retry') => Object.assign(new Error(message), { next })

function scrub(text) {
  const value = stripVTControlCharacters(String(text ?? '')).replace(
    /(["']?\b(?:[a-z0-9]+[_-])*(?:api[_-]?key|authorization|password|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+[^\s"',}]+|[^\s"',}]+)/gi,
    '$1[hidden]',
  )
  return redactText(value.replace(/\b(Bearer|Basic)\s+[^\s"',}]+/gi, '$1 [hidden]'))
}

function diagnostic(error) {
  return scrub(error?.message ?? error).replace(/[\r\n]+/g, ' ').trim().slice(0, 600) || 'Omni could not be installed.'
}

export const omniRefusal = message => Object.assign(new Error(diagnostic(message)), { code: 'omni-ai/refused' })
export const omniRoot = (env = process.env) => env.OMNI_HOME || join(homedir(), '.omni')
export const bunPathOf = (root, { version, sha256: digest }) => join(root, 'automagik-bun', version + '-' + digest.slice(0, 12), 'bun')

// Use the registry Omni's installer uses, in the same order.
export function registryOf(env = process.env) {
  for (const value of [env.BUN_CONFIG_REGISTRY, env.NPM_CONFIG_REGISTRY, env.npm_config_registry]) {
    const url = URL.parse(value)
    if (url?.protocol === 'https:' && !url.username && !url.password) return url.href.endsWith('/') ? url.href : url.href + '/'
  }
  return 'https://registry.npmjs.org/'
}

export const npmStatusOf = status => status === 200 ? 'published' : status === 404 ? 'unpublished' : 'unknown'

const order = (a, b) => a < b ? -1 : a > b ? 1 : 0
function compareVersions(a, b) {
  const [left, right] = [a, b].map(value => value.split('-', 2))
  const x = left[0].split('.')
  const y = right[0].split('.')
  for (let i = 0; i < 3; i++) {
    const cmp = order(BigInt(x[i]), BigInt(y[i]))
    if (cmp) return cmp
  }
  if (!left[1] || !right[1]) return order(!left[1], !right[1])
  const pre = left[1].split('.')
  const other = right[1].split('.')
  for (let i = 0; i < Math.min(pre.length, other.length); i++) {
    const digits = /^\d+$/.test(pre[i])
    const otherDigits = /^\d+$/.test(other[i])
    const cmp = digits && otherDigits ? order(BigInt(pre[i]), BigInt(other[i]))
      : order(otherDigits, digits) || order(pre[i], other[i])
    if (cmp) return cmp
  }
  return order(pre.length, other.length)
}

export function routeOf({ npm, V, P, atLoginUsable, eligible, npmJobUsable = eligible }) {
  const current = npm === 'published' && compareVersions(V, P) >= 0
  if (atLoginUsable) {
    if (current || npm === 'unknown') return 'terminal'
    if (eligible) return 'github'
    return npm === 'published' ? 'terminal' : 'unpublished'
  }
  if (current) return npmJobUsable ? 'npm' : 'no-systemd'
  return eligible ? 'github' : 'no-systemd'
}

function onPath(name, path) {
  for (const dir of String(path ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      if (statSync(file).isFile()) return file
    } catch {}
  }
  return null
}

function runCommand(file, args, options) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, options, error => error ? reject(error) : resolvePromise(0))
  })
}

export async function atLoginUsable({ env, platform, run = runCommand }) {
  if (env.AUTOMAGIK_GATE_IMAGE === '1') return false
  if (platform === 'darwin') return true
  if (platform !== 'linux') return false
  const file = run === runCommand ? onPath('systemctl', env.PATH) : 'systemctl'
  if (!file) return false
  const options = { timeout: 2000, killSignal: 'SIGKILL', env: installEnv(env), maxBuffer: 1024 * 1024 }
  const signal = AbortSignal.timeout(options.timeout)
  try { return (await abortable(run(file, ['--user', 'show-environment'], options), signal)) === 0 } catch { return false }
}

function restriction(env, platform, arch) {
  if ([env.AUTOMAGIK_HOST, env.AUTOMAGIK_PRELOAD].some(value => String(value ?? '').trim().toLowerCase() === 'unfold')) {
    return "Use the Omni bundled with Unfold's instance."
  }
  if (env.AUTOMAGIK_MULTIUSER === '1') return 'Installing Omni here builds third-party code as the workspace user and is unavailable in multiuser mode.'
  if (!Object.hasOwn(BUN, platform + '-' + arch)) return 'Installing Omni here requires Linux or macOS on x64 or arm64.'
  if (env.AUTOMAGIK_GATE_IMAGE === '1' && env.AUTOMAGIK_OMNI_SUPERVISOR !== '1') return NO_SUPERVISOR
  return null
}

export async function installationRoute({ V, npm, env, platform, arch, run, pin = PIN, available = () => true }) {
  const login = await atLoginUsable({ env, platform, run })
  const comparison = compareVersions(pin.version, V)
  const target = !login && npm === 'published' && comparison <= 0 ? V : pin.version
  const allowed = legalPin(pin) && !restriction(env, platform, arch) && available(login, target)
  // A local npm install can take a newer version even when the GitHub pin cannot.
  const eligible = allowed && comparison >= 0
  const route = routeOf({ npm, V, P: pin.version, atLoginUsable: login, eligible, npmJobUsable: allowed })
  const fallback = eligible ? { version: pin.version, tag: 'v' + pin.version, commit: pin.commit } : null
  return { route, fallback, login }
}

const ENV_KEYS = [
  'PATH', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'BUN_CONFIG_REGISTRY', 'NPM_CONFIG_REGISTRY', 'npm_config_registry',
]
const envOf = (env, keys) => Object.fromEntries(keys.filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
const installEnv = env => ({
  ...envOf(env, [...ENV_KEYS, 'TMPDIR', 'OMNI_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']),
  HOME: env.HOME || homedir(), DO_NOT_TRACK: '1',
})
const buildEnv = (env, home, tmp, cache) => ({
  ...envOf(env, ENV_KEYS), HOME: home, TMPDIR: tmp, BUN_INSTALL_CACHE_DIR: cache,
  HUSKY: '0', DO_NOT_TRACK: '1', TURBO_TELEMETRY_DISABLED: '1', CI: '1',
})

function layoutOf(env) {
  const root = resolve(omniRoot(env))
  const home = join(root, 'sandbox')
  return {
    root, home, build: join(root, 'automagik-build'), packages: join(root, 'packages'),
    state: join(home, 'sandbox.json'), marker: join(home, 'automagik-supervised.json'),
    intent: join(home, 'automagik-install.json'), pid: join(home, 'run', 'supervisor.pid'),
    config: join(home, 'config', 'config.json'),
  }
}

function lstat(path) {
  try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

function owned(path, kind) {
  const stat = lstat(path)
  if (stat && (!(kind === 'dir' ? stat.isDirectory() : stat.isFile())
    || (process.getuid && stat.uid !== process.getuid()))) throw omniRefusal('Unsafe Omni path: ' + path)
  return stat
}

function inside(root, path) {
  const from = relative(root, realpathSync(path))
  if (from === '..' || from.startsWith('../') || isAbsolute(from)) throw omniRefusal('Unsafe Omni path: ' + path)
}

function checkDirs(layout) {
  if (!owned(layout.root, 'dir')) return
  const root = realpathSync(layout.root)
  const dirs = [
    layout.home, ...SANDBOX_DIRS.map(dir => join(layout.home, dir)), layout.packages, layout.build,
    join(layout.build, 'cache'), join(layout.root, 'automagik-bun'),
  ]
  for (const dir of dirs) if (owned(dir, 'dir')) inside(root, dir)
}

function readSmall(path) {
  const stat = owned(path, 'file')
  if (!stat) return null
  if (stat.size > 64 * 1024) throw omniRefusal('The Omni file is too large: ' + path)
  return readFileSync(path, 'utf8')
}

function readRecord(path) {
  const text = readSmall(path)
  if (text === null) return null
  try {
    const record = JSON.parse(text)
    if (record && typeof record === 'object' && !Array.isArray(record)) return record
  } catch {}
  throw omniRefusal('Could not read the Omni record at ' + path)
}

function alive(pid, kill) {
  try { kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

function startsAtLogin(path) {
  const state = readSmall(path)
  try { return JSON.parse(state)?.atLogin === true } catch { return false }
}

function checkSandbox(layout, image, login, kill) {
  owned(layout.config, 'file')
  if (image) {
    if (lstat(layout.marker)) throw omniRefusal(ALREADY_INSTALLED)
    const intent = readRecord(layout.intent)
    if (intent) {
      if (typeof intent.version !== 'string' || !VERSION.test(intent.version)
        || typeof intent.startedAt !== 'string' || !Number.isFinite(Date.parse(intent.startedAt))) {
        throw omniRefusal('Could not recognize the interrupted Omni install at ' + layout.home)
      }
    } else if (lstat(layout.home) && readdirSync(layout.home).length) {
      throw omniRefusal(ALREADY_INSTALLED)
    }
    if (startsAtLogin(layout.state)) throw omniRefusal('This Omni is set to start at login. Use an Omni on another computer.')
    return intent
  }
  // Match the pinned CLI's pid parser so a live pid it could stop is also refused here.
  const pid = Number.parseInt(readSmall(layout.pid)?.trim(), 10)
  if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff && alive(pid, kill)) throw omniRefusal(LIVE_OMNI)
  if (startsAtLogin(layout.state) && !login) {
    throw omniRefusal('This Omni is set to start at login. Start your systemd user session and try again.')
  }
  return null
}

function bootIdentity(read = readFileSync) {
  try { return read('/proc/sys/kernel/random/boot_id', 'utf8').trim() } catch { return '' }
}

function startTicks(pid, read = readFileSync) {
  try {
    const stat = read('/proc/' + pid + '/stat', 'utf8')
    const end = stat.lastIndexOf(')')
    const ticks = end < 0 ? '' : stat.slice(end + 1).trim().split(/\s+/)[19]
    return /^\d+$/.test(ticks ?? '') ? ticks : ''
  } catch { return '' }
}

function staleLock(ownerFile, { boot, ticks, kill }) {
  let owner
  try { owner = readRecord(ownerFile) } catch { return false }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff) return false
  if (boot && typeof owner.bootId === 'string' && owner.bootId && owner.bootId !== boot) return true
  if (!alive(owner.pid, kill)) return true
  const current = ticks(owner.pid)
  return Boolean(current && typeof owner.startTicks === 'string' && owner.startTicks && current !== owner.startTicks)
}

function acquireLock(layout, { now, kill, boot, ticks }) {
  const lock = join(layout.build, 'install.lock')
  const ownerFile = join(lock, 'owner.json')
  try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!owned(lock, 'dir') || !staleLock(ownerFile, { boot, ticks, kill })) throw omniRefusal(ANOTHER_INSTALL)
    // Serialize the stale-owner check and removal. A second reaper must check the new owner.
    const reclaim = join(layout.build, 'install-reclaim.lock')
    try { mkdirSync(reclaim, { mode: 0o700 }) } catch (failure) {
      if (failure.code === 'EEXIST') throw omniRefusal(ANOTHER_INSTALL)
      throw failure
    }
    try {
      if (!owned(lock, 'dir') || !staleLock(ownerFile, { boot, ticks, kill })
        || readdirSync(lock).some(name => name !== 'owner.json')) throw omniRefusal(ANOTHER_INSTALL)
      unlinkSync(ownerFile)
      rmdirSync(lock)
      try { mkdirSync(lock, { mode: 0o700 }) } catch (failure) {
        if (failure.code === 'EEXIST') throw omniRefusal(ANOTHER_INSTALL)
        throw failure
      }
    } finally {
      rmdirSync(reclaim)
    }
  }
  try {
    writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, bootId: boot, startTicks: ticks(process.pid), at: now() }), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    rmSync(lock, { recursive: true, force: true })
    throw error
  }
  return () => {
    unlinkSync(ownerFile)
    rmdirSync(lock)
  }
}

const boundedSignal = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)])

function abortable(promise, signal) {
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolvePromise, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function fetchBody(fetch, url, signal, options) {
  signal.throwIfAborted()
  const response = await abortable(fetch(url, { signal, ...options }), signal)
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw quietError('The Omni download answered HTTP ' + response.status + '.')
  }
  return response.body
}

async function readBody(body, max, signal, { prefix = false } = {}) {
  const reader = body.getReader()
  const parts = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) return Buffer.concat(parts, size)
      if (prefix && size + value.byteLength >= max) {
        parts.push(value.subarray(0, max - size))
        return Buffer.concat(parts, max)
      }
      size += value.byteLength
      if (size > max) throw quietError('The Omni download exceeded its size limit.')
      parts.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function probeNpm(version, fetch, env) {
  const registry = registryOf(env)
  const signal = AbortSignal.timeout(5000)
  const [status, latest] = await Promise.all([
    abortable(Promise.resolve().then(() => fetch(registry + NPM_PACKAGE + '/' + version, { signal })), signal).then(response => {
      void response.body?.cancel().catch(() => {})
      return response.status
    }).catch(() => null),
    (async () => {
      try {
        const body = await fetchBody(fetch, registry + '-/package/' + NPM_PACKAGE + '/dist-tags', signal)
        const { latest } = JSON.parse(await readBody(body, 64 * 1024, signal))
        return typeof latest === 'string' && VERSION.test(latest) && !latest.includes('-') ? latest : null
      } catch { return null }
    })(),
  ])
  return { npm: npmStatusOf(status), latest }
}

const sha1 = bytes => createHash('sha1').update(bytes).digest()
const badGit = () => new Error('Invalid Git response.')

function headerSeconds(value, max = Number.MAX_SAFE_INTEGER) {
  const seconds = /^\d+$/.test(value ?? '') ? Number(value) : 0
  return seconds >= 1 && seconds <= max ? seconds : null
}

const limitedStatus = response => response.status === 403 || response.status === 429

function secondaryDelay(response) {
  if (!limitedStatus(response) || response.headers.get('x-ratelimit-remaining') === '0') return null
  const seconds = headerSeconds(response.headers.get('retry-after'), 10)
  return seconds === null ? null : seconds * 1000
}

async function githubRequest(fetch, url, signal, wait, options, retryDelay = () => null) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const backoff = 1000 * 2 ** attempt
    let response
    try {
      response = await abortable(fetch(url, { signal, redirect: 'error', ...options }), signal)
    } catch {
      signal.throwIfAborted()
      if (attempt === 2) throw new Error('GitHub request failed.')
    }
    const delay = !response || (response.status >= 500 && response.status <= 599) ? backoff : retryDelay(response)
    if (response && (attempt === 2 || delay === null)) return response
    void response?.body?.cancel().catch(() => {})
    await abortable(wait(delay, undefined, { signal }), signal)
  }
}

class GitHubRateLimit extends Error {
  constructor(authenticated, headers, receivedAt) {
    super("GitHub's API rate limit was reached.")
    this.authenticated = authenticated
    const retryAfter = headerSeconds(headers.get('retry-after'), 86_400)
    this.retryAt = retryAfter === null ? null : receivedAt + retryAfter * 1000
    this.reset = headerSeconds(headers.get('x-ratelimit-reset'))
  }
}

async function rateLimited(response, signal) {
  if (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')) {
    void response.body?.cancel().catch(() => {})
    return true
  }
  if (!response.body) return false
  let text
  try { text = (await readBody(response.body, 4 * 1024, signal, { prefix: true })).toString('utf8').trim() } catch {
    signal.throwIfAborted()
    return false
  }
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  const structured = mediaType === 'application/json' || mediaType.endsWith('+json')
    || text.startsWith('{') || text.startsWith('[')
  if (!structured) return /rate limit/i.test(text)
  try {
    const data = JSON.parse(text)
    return data !== null && typeof data === 'object' && !Array.isArray(data)
      && Object.hasOwn(data, 'message') && typeof data.message === 'string' && /rate limit/i.test(data.message)
  } catch {
    return false
  }
}

async function githubApi(fetch, path, signal, { env, wait, now }) {
  const headers = { accept: 'application/vnd.github+json' }
  const token = env.GITHUB_TOKEN
  const authenticated = typeof token === 'string' && /^[\x21-\x7e]{1,255}$/.test(token)
  if (authenticated) headers.authorization = 'Bearer ' + token
  const response = await githubRequest(fetch, API + path, signal, wait, { headers }, secondaryDelay)
  if (!response.ok || !response.body) {
    if (limitedStatus(response)) {
      const receivedAt = now()
      if (await rateLimited(response, signal)) throw new GitHubRateLimit(authenticated, response.headers, receivedAt)
    } else {
      void response.body?.cancel().catch(() => {})
    }
    throw new Error('Invalid GitHub API response.')
  }
  return JSON.parse(await readBody(response.body, 1024 * 1024, signal))
}

function checkCommit(commit, pin, tag) {
  if (commit !== pin.commit) throw quietError("GitHub's " + tag + ' is not the commit this Automagik release pins.', 'update')
}

function checkTree(tree, pin) {
  if (tree !== pin.tree) throw quietError("GitHub's commit does not have the Git tree this Automagik release pins.", 'update')
}

async function checkApiTag(fetch, pin, tag, signal, options) {
  const get = async path => {
    try { return await githubApi(fetch, path, signal, options) } catch (error) {
      signal.throwIfAborted()
      if (error instanceof GitHubRateLimit) throw error
      throw quietError("Could not check Omni's " + tag + ' pin on GitHub.')
    }
  }
  let object = (await get('ref/tags/' + tag))?.object
  if (object?.type === 'tag' && typeof object.sha === 'string' && SHA.test(object.sha)) {
    object = (await get('tags/' + object.sha))?.object
  }
  checkCommit(object?.type === 'commit' ? object.sha : null, pin, tag)
  checkTree((await get('commits/' + pin.commit))?.tree?.sha, pin)
}

const pkt = line => (Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line

async function gitRequest(fetch, command, args, signal, wait) {
  const response = await githubRequest(fetch, GIT, signal, wait, {
    method: 'POST',
    headers: {
      'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request', accept: GIT_RESULT,
    },
    body: pkt('command=' + command + '\n') + '0001' + args.map(arg => pkt(arg + '\n')).join('') + '0000',
  })
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (response.status !== 200 || mediaType !== GIT_RESULT || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw badGit()
  }
  return readBody(response.body, MAX_GIT, signal)
}

function* gitPackets(bytes) {
  for (let at = 0; at + 4 <= bytes.length;) {
    const hex = bytes.toString('latin1', at, at + 4)
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw badGit()
    const length = Number.parseInt(hex, 16)
    if (length === 0) {
      const end = at + 4
      if (end === bytes.length || (end + 4 === bytes.length && bytes.toString('latin1', end) === '0002')) return
      throw badGit()
    }
    if (length === 1) {
      at += 4
      yield null
    } else {
      if (length < 4 || length > 0xfff0 || at + length > bytes.length) throw badGit()
      yield bytes.subarray(at + 4, at + length)
      at += length
    }
  }
  throw badGit()
}

const gitText = packet => packet?.toString('latin1').replace(/\n$/, '')

function validGitRef(name) {
  if (name !== 'HEAD' && !name.startsWith('refs/')) return false
  for (const char of name) {
    if (char <= ' ' || char === '\x7f' || '~^:?*[\\'.includes(char)) return false
  }
  return !name.includes('..') && !name.includes('@{') && !name.endsWith('.')
    && name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'))
}

function gitRef(bytes, ref) {
  let commit = null
  for (const packet of gitPackets(bytes)) {
    const match = gitText(packet)?.match(/^([0-9a-fA-F]{40}) ([^ ]+)(?: peeled:([0-9a-fA-F]{40}))?$/)
    if (!match || !validGitRef(match[2])) throw badGit()
    if (match[2] === ref) {
      if (commit !== null) throw badGit()
      commit = (match[3] ?? match[1]).toLowerCase()
    }
  }
  return commit
}

function gitPack(bytes) {
  const packets = gitPackets(bytes)
  let section = gitText(packets.next().value)
  if (section === 'shallow-info') {
    for (;;) {
      const line = packets.next().value
      if (line === null) break
      if (!/^shallow [0-9a-fA-F]{40}$/.test(gitText(line) ?? '')) throw badGit()
    }
    section = gitText(packets.next().value)
  }
  if (section !== 'packfile') throw badGit()
  const parts = []
  for (const packet of packets) {
    if (packet?.[0] === 1) parts.push(packet.subarray(1))
    else if (packet?.[0] !== 2) throw badGit()
  }
  return Buffer.concat(parts)
}

function gitCommitTree(pack, commit) {
  const trailer = pack.length - 20
  if (trailer <= 12 || pack.toString('latin1', 0, 4) !== 'PACK'
    || pack.readUInt32BE(4) !== 2 || pack.readUInt32BE(8) !== 1
    || !sha1(pack.subarray(0, trailer)).equals(pack.subarray(trailer))) throw badGit()
  let at = 12
  let byte = pack[at++]
  if (((byte >> 4) & 7) !== 1) throw badGit()
  let size = byte & 15
  for (let shift = 4; byte & 128; shift += 7) {
    if (shift > 11 || at >= trailer) throw badGit()
    byte = pack[at++]
    size += (byte & 127) << shift
  }
  if (size > MAX_GIT) throw badGit()
  const compressed = pack.subarray(at, trailer)
  const { buffer: body, engine } = inflateSync(compressed, { maxOutputLength: MAX_GIT, info: true })
  if (engine.bytesWritten !== compressed.length || body.length !== size
    || sha1(Buffer.concat([Buffer.from('commit ' + size + '\0'), body])).toString('hex') !== commit) throw badGit()
  const newline = body.indexOf(10)
  if (newline < 0) throw badGit()
  const tree = /^tree ([0-9a-fA-F]{40})$/.exec(body.toString('latin1', 0, newline))?.[1]
  if (!tree) throw badGit()
  return tree.toLowerCase()
}

async function checkGitTag(fetch, pin, tag, signal, wait) {
  const ref = 'refs/tags/' + tag
  const refs = await gitRequest(fetch, 'ls-refs', ['peel', 'ref-prefix ' + ref], signal, wait)
  const commit = gitRef(refs, ref)
  if (commit === null) throw quietError('GitHub has no ' + tag + ' tag for Omni.', 'update')
  checkCommit(commit, pin, tag)
  const bytes = await gitRequest(fetch, 'fetch', ['want ' + pin.commit, 'deepen 1', 'filter tree:0', 'no-progress', 'done'], signal, wait)
  checkTree(gitCommitTree(gitPack(bytes), pin.commit), pin)
}

function rateLimitError(tag, { authenticated, retryAt, reset }, now) {
  const at = now()
  const deadline = retryAt !== null && retryAt > at ? retryAt : (reset ?? 0) * 1000
  const minutes = Math.ceil((deadline - at) / 60_000)
  const when = minutes <= 0 ? ' Try again later.' : minutes > 60 ? ' Try again in about an hour.'
    : ' Try again in about ' + minutes + (minutes === 1 ? ' minute.' : ' minutes.')
  const advice = authenticated ? " The GITHUB_TOKEN's own limit was reached."
    : ' Everyone on the same network shares this limit. Set GITHUB_TOKEN in the environment Automagik starts with, or try from another network.'
  return quietError("GitHub's API rate limit was reached, so Omni's " + tag + ' pin could not be checked.' + when + advice)
}

async function checkTag(fetch, pin, signal, { env, wait, now }) {
  const tag = 'v' + pin.version
  try {
    await checkApiTag(fetch, pin, tag, signal, { env, wait, now })
    return { via: 'api' }
  } catch (limit) {
    signal.throwIfAborted()
    if (!(limit instanceof GitHubRateLimit)) throw limit
    try {
      await checkGitTag(fetch, pin, tag, signal, wait)
      return { via: 'git' }
    } catch (error) {
      signal.throwIfAborted()
      if (error?.next === 'update') throw error
      throw rateLimitError(tag, limit, now)
    }
  }
}

export async function verifyOmniArchive(stream, pin, signal, limits) {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./omni-github-archive.js', import.meta.url), {
    workerData: { stream, pin, limits }, transferList: [stream], execArgv: [], env: {},
    resourceLimits: { maxOldGenerationSizeMb: 768 },
  })
  try {
    const result = await abortable(new Promise((resolvePromise, reject) => {
      worker.once('message', resolvePromise)
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('The Omni archive verifier exited early.')))
    }), signal)
    if (result.error) throw quietError(result.error, 'update')
    return result.entries
  } finally {
    await worker.terminate()
  }
}

function unzipBun(zip, name) {
  let end = zip.length - 22
  const first = Math.max(0, end - 0xffff)
  for (; end >= first; end--) {
    if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break
  }
  if (end < first) throw quietError('The verified Bun download is not a zip archive.')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50) break
    const method = zip.readUInt16LE(at + 10)
    const packed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const local = zip.readUInt32LE(at + 42)
    if (zip.toString('utf8', at + 46, at + 46 + nameLength) === name) {
      if (local + 30 > at || zip.readUInt32LE(local) !== 0x04034b50 || size > MAX_BUN) break
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      if (start + packed > at || (method !== 0 && method !== 8)) break
      const bytes = zip.subarray(start, start + packed)
      const out = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: MAX_BUN })
      if (out.length === size) return out
      break
    }
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32)
  }
  throw quietError('Could not unpack the Bun binary from its verified zip.')
}

function publish(path, write) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    write(temp)
    renameSync(temp, path)
  } catch (error) {
    if (error.code !== 'EEXIST') rmSync(temp, { force: true })
    throw error
  }
}

async function ensureBun(layout, descriptor, fetch, signal) {
  const bun = bunPathOf(layout.root, descriptor)
  const dir = dirname(bun)
  const root = realpathSync(layout.root)
  const parent = dirname(dir)
  if (owned(parent, 'dir')) inside(root, parent)
  if (owned(dir, 'dir')) inside(root, dir)
  const stat = owned(bun, 'file')
  if (stat?.size <= MAX_BUN) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(bun, { signal })) hash.update(chunk)
    if (hash.digest('hex') === descriptor.sha256 && (stat.mode & 0o100)) return bun
  }

  const asset = 'bun-' + descriptor.asset
  const url = 'https://github.com/oven-sh/bun/releases/download/bun-v' + descriptor.version + '/' + asset + '.zip'
  const zip = await readBody(await fetchBody(fetch, url, signal), MAX_BUN, signal)
  if (sha256(zip) !== descriptor.zip) throw quietError('The Bun zip does not match its pinned SHA-256.', 'update')
  const bytes = unzipBun(zip, asset + '/bun')
  if (sha256(bytes) !== descriptor.sha256) throw quietError('The Bun binary does not match its pinned SHA-256.', 'update')
  signal.throwIfAborted()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  publish(bun, temp => writeFileSync(temp, bytes, { flag: 'wx', mode: 0o755 }))
  return bun
}

function appendLog(job, line) {
  const log = Buffer.concat([job.log, Buffer.from(line + '\n')])
  let start = Math.max(0, log.length - MAX_LOG)
  if (start > 0 && log[start - 1] !== 10) start = log.indexOf(10, start) + 1
  job.log = log.subarray(start)
}

function logStream(job, stream, onLine = () => {}) {
  let partial = Buffer.alloc(0)
  let omitted = false
  let last = ''
  function line() {
    const raw = omitted ? '' : partial.toString('utf8').replace(/\r$/, '')
    if (omitted || raw.trim()) {
      last = omitted ? '[long line omitted]' : scrub(raw)
      appendLog(job, last)
      onLine(raw)
    }
    partial = Buffer.alloc(0)
    omitted = false
  }
  function data(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    for (let offset = 0; offset < bytes.length;) {
      const newline = bytes.indexOf(10, offset)
      const end = newline < 0 ? bytes.length : newline
      if (!omitted) {
        omitted = partial.length + end - offset > MAX_LINE
        partial = omitted ? Buffer.alloc(0) : Buffer.concat([partial, bytes.subarray(offset, end)])
      }
      if (newline >= 0) line()
      offset = end + 1
    }
  }
  stream?.on('data', data)
  return () => {
    stream?.off('data', data)
    if (partial.length || omitted) line()
    return last
  }
}

function send(kill, pid, signal) {
  try { kill(-pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}

async function stopGroup(pid, { kill, wait, termMs, killMs }) {
  async function goneWithin(ms) {
    for (let elapsed = 0; elapsed < ms && alive(-pid, kill);) {
      const delay = Math.min(ms - elapsed, 100)
      await wait(delay)
      elapsed += delay
    }
    return !alive(-pid, kill)
  }
  send(kill, pid, 'SIGTERM')
  if (await goneWithin(termMs)) return
  send(kill, pid, 'SIGKILL')
  if (!await goneWithin(killMs)) throw quietError('Omni’s installer processes are still running. Stop them before retrying.')
}

async function command(job, runtime, args, options, signal) {
  signal.throwIfAborted()
  const child = runtime.spawn(runtime.bun, args, { ...options, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let lastOut = ''
  const out = logStream(job, child.stdout, line => { lastOut = line })
  const err = logStream(job, child.stderr)
  const closed = new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, exitSignal) => resolvePromise({ code, exitSignal }))
  })
  let result, problem, lastError
  try { result = await abortable(closed, signal) } catch (error) { problem = error }
  try {
    if (child.pid && alive(-child.pid, runtime.kill)) await stopGroup(child.pid, runtime)
  } catch (error) {
    runtime.cleanupSafe = false
    throw error
  } finally {
    out()
    lastError = err()
  }
  if (problem) throw problem
  return { ...result, lastOut, lastError }
}

const SHIMS = {
  mkdir: "if (flag === '-p' && args.length) for (const path of args) fs.mkdirSync(path, { recursive: true }); else process.exit(2)",
  cp: "if (flag === '-r' && args.length === 2) fs.cpSync(args[0], args[1], { recursive: true, verbatimSymlinks: true }); else process.exit(2)",
  rm: "if (flag === '-rf' && args.length) for (const path of args) fs.rmSync(path, { recursive: true, force: true }); else process.exit(2)",
}

function buildPath(dir, path, bun) {
  const missing = Object.keys(SHIMS).filter(name => !onPath(name, path))
  const dirs = [dirname(bun)]
  if (missing.length) {
    const shims = join(dir, 'shims')
    mkdirSync(shims, { mode: 0o700 })
    for (const name of missing) {
      const code = '#!' + process.execPath + '\nimport("node:fs").then(fs => {\nconst [flag, ...args] = process.argv.slice(2)\n' + SHIMS[name] + '\n})\n'
      writeFileSync(join(shims, name), code, { flag: 'wx', mode: 0o755 })
    }
    dirs.push(shims)
  }
  if (path) dirs.push(path)
  return dirs.join(delimiter)
}

async function materialize(entries, source, signal) {
  mkdirSync(source, { mode: 0o700 })
  // Create symlinks last so extraction never traverses one, including on case-insensitive disks.
  const ordered = [...entries.filter(entry => entry.type !== '2'), ...entries.filter(entry => entry.type === '2')]
  for (const [index, entry] of ordered.entries()) {
    if (index % 100 === 0) await sleep(0, undefined, { signal })
    const path = join(source, entry.path)
    mkdirSync(entry.type === '5' ? path : dirname(path), { recursive: true })
    if (entry.type === '2') symlinkSync(entry.target, path)
    if (entry.type === '0') writeFileSync(path, entry.body, { flag: 'wx', mode: entry.exec ? 0o755 : 0o644 })
  }
}

async function buildPackage(job, runtime, dir, entries, pin, layout, env, signal) {
  const source = join(dir, 'src')
  await materialize(entries, source, signal)
  const home = join(dir, 'home')
  const tmp = join(dir, 'tmp')
  const out = join(dir, 'out')
  for (const path of [home, tmp, out]) mkdirSync(path, { mode: 0o700 })
  const cache = join(layout.build, 'cache')
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  const childEnv = buildEnv(env, home, tmp, cache)
  childEnv.PATH = buildPath(dir, childEnv.PATH, runtime.bun)
  const cli = join(source, 'packages', 'cli')
  const commands = [
    [source, ['install', '--frozen-lockfile', '--ignore-scripts']],
    [source, ['x', 'turbo', 'run', 'build', '--filter=@automagik/omni']],
    [cli, ['run', 'prepack']],
    [cli, ['pm', 'pack', '--ignore-scripts', '--destination', out]],
  ]
  for (const [cwd, args] of commands) {
    const result = await command(job, runtime, args, { cwd, env: childEnv }, signal)
    if (result.code !== 0) throw quietError(result.lastError || 'The Omni build stopped while running bun ' + args[0] + '.')
  }
  const name = 'automagik-omni-' + pin.version
  const packed = join(out, name + '.tgz')
  if (!owned(packed, 'file')) throw quietError('The Omni build did not produce its package.')
  const target = join(layout.packages, name + '-' + pin.commit.slice(0, 12) + '.tgz')
  owned(target, 'file')
  signal.throwIfAborted()
  mkdirSync(layout.packages, { recursive: true, mode: 0o700 })
  publish(target, temp => {
    copyFileSync(packed, temp, constants.COPYFILE_EXCL)
    chmodSync(temp, 0o600)
  })
  return { bin: join(cli, 'bin', 'omni'), target }
}

function reportOf(lastOut, version, home) {
  let report
  try { report = JSON.parse(lastOut) } catch {}
  const url = typeof report?.apiUrl === 'string' ? URL.parse(report.apiUrl) : null
  if (report?.ok !== true || report.version !== version || !url
    || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw quietError('Omni did not report the expected version and a local API URL.')
  }
  return { version, apiUrl: url.origin, home }
}

function cliError(result) {
  let report
  try { report = JSON.parse(result.lastOut) } catch {}
  return quietError(typeof report?.error === 'string' && report.error
    ? report.error : result.lastError || 'Omni’s installer exited with ' + (result.code ?? result.exitSignal ?? 'an error') + '.')
}

function jobView(job) {
  if (!job) return null
  const { id, acknowledged, cancelRequested, source, reason, npm, release, fellBack, phase, step, log, error, next, report } = job
  const steps = STEPS.map(id => {
    let state = 'next'
    if (job.failedAt === id) state = 'failed'
    else if (id === step) state = 'now'
    else if (job.completed.has(id)) state = 'done'
    else if (source === 'npm' && (id === 'download' || id === 'build')) state = 'skipped'
    return { id, state }
  })
  let tail = log.toString('utf8').replace(/^\ufffd+/, '')
  while (Buffer.byteLength(tail) > MAX_LOG) tail = tail.slice(1)
  return {
    id, acknowledged, cancelRequested, source, reason, npm: { ...npm }, release: { ...release },
    fellBack, phase, step, steps, log: tail, error, next, report: report && { ...report },
  }
}

function jobStep(job, step) {
  if (job.step) job.completed.add(job.step)
  job.step = step
}

function legalPin(pin) {
  return typeof pin.version === 'string' && VERSION.test(pin.version) && !pin.version.includes('-')
    && typeof pin.commit === 'string' && SHA.test(pin.commit) && typeof pin.tree === 'string' && SHA.test(pin.tree)
}

export function omniInstallAvailable({ env, login, version, kill = process.kill }) {
  const layout = layoutOf(env)
  try {
    checkDirs(layout)
    const intent = checkSandbox(layout, env.AUTOMAGIK_GATE_IMAGE === '1', login, kill)
    return !intent || intent.version === version
  } catch { return false }
}

export function createOmniInstaller({
  env = process.env, platform = process.platform, arch = process.arch, fetch = globalThis.fetch, spawn = spawnChild,
  run, probe = version => probeNpm(version, fetch, env), pin = PIN, now = Date.now, kill = process.kill, wait = sleep, boot = bootIdentity(), ticks = startTicks,
  descriptor = { version: BUN_VERSION, ...BUN[platform + '-' + arch] }, verifyArchive = verifyOmniArchive,
  readOnly = () => undefined, downloadMs = DOWNLOAD_MS, buildMs = BUILD_MS, installMs = INSTALL_MS,
  termMs = 10_000, killMs = 5000,
} = {}) {
  let job = null
  let starting = null

  function mutationAllowed() {
    const message = readOnly()
    if (message !== undefined) throw omniRefusal(message)
    const refused = restriction(env, platform, arch)
    if (refused) throw omniRefusal(refused)
  }

  async function install(job, runtime, prep, packed) {
    const { layout, image } = prep
    const login = await atLoginUsable({ env, platform, run })
    job.controller.signal.throwIfAborted()
    mutationAllowed()
    checkDirs(layout)
    const intent = checkSandbox(layout, image, login, kill)
    if (intent && intent.version !== job.release.version) throw omniRefusal('Retry the interrupted Omni install at version ' + intent.version + '.')
    const flags = image ? ['--no-start'] : login ? ['--at-login'] : []
    const spec = packed ? ['--package', 'file:' + packed.target] : []
    const cli = packed ? [packed.bin] : ['x', '--bun', '@automagik/omni@' + job.release.version]
    if (image) {
      mkdirSync(layout.home, { recursive: true, mode: 0o700 })
      if (!intent) writeFileSync(layout.intent, JSON.stringify({ version: job.release.version, startedAt: new Date(now()).toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
    }
    jobStep(job, 'install')
    const childEnv = installEnv(env)
    childEnv.OMNI_HOME = layout.root
    childEnv.PATH = [dirname(runtime.bun), childEnv.PATH].filter(Boolean).join(delimiter)
    const result = await command(job, runtime, [...cli, 'install', '--sandbox', '--home', layout.home, ...spec, ...flags, '--json'],
      { cwd: layout.root, env: childEnv }, boundedSignal(job.controller.signal, installMs))
    if (job.source === 'npm') job.npm.exitCode = result.code
    if (result.code !== 0) throw cliError(result)
    const report = reportOf(result.lastOut, job.release.version, layout.home)
    if (image) {
      const marker = { version: report.version, bun: { version: descriptor.version, sha256: descriptor.sha256 } }
      publish(layout.marker, temp => writeFileSync(temp, JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 }))
      try { unlinkSync(layout.intent) } catch (error) {
        appendLog(job, 'Omni was installed. Its install record could not be removed: ' + diagnostic(error))
      }
    }
    return report
  }

  async function execute(job, prep) {
    const { layout, unlock } = prep
    const runtime = { spawn, kill, wait, termMs, killMs, bun: null, cleanupSafe: true }
    const signal = job.controller.signal
    let dir, report, failure
    try {
      if (job.source === 'npm') {
        runtime.bun = await ensureBun(layout, descriptor, fetch, boundedSignal(signal, downloadMs))
        try {
          report = await install(job, runtime, prep)
        } catch (error) {
          // Only a real npm CLI failure takes the fallback. An install-time cancellation
          // lets that CLI finish and keeps its own outcome.
          if (!runtime.cleanupSafe || job.cancelRequested || !prep.fallback || !job.npm.exitCode) throw error
          job.source = 'github'
          job.release = { version: pin.version, tag: 'v' + pin.version }
          job.fellBack = true
          job.step = 'check'
        }
      }
      if (job.source === 'github') {
        jobStep(job, 'download')
        const download = boundedSignal(signal, downloadMs)
        const { via } = await checkTag(fetch, pin, download, { env, wait, now })
        if (via === 'git') appendLog(job, "GitHub's API rate limit was reached; checked Omni's v" + pin.version + ' tag and commit over Git instead.')
        const url = 'https://codeload.github.com/' + REPO + '/tar.gz/' + pin.commit
        const entries = await verifyArchive(await fetchBody(fetch, url, download, { redirect: 'error' }), pin, download)
        runtime.bun ??= await ensureBun(layout, descriptor, fetch, download)
        download.throwIfAborted()
        jobStep(job, 'build')
        dir = mkdtempSync(join(layout.build, 'omni-'))
        inside(realpathSync(layout.root), dir)
        const packed = await buildPackage(job, runtime, dir, entries, pin, layout, env, boundedSignal(signal, buildMs))
        report = await install(job, runtime, prep, packed)
      }
    } catch (error) {
      failure = error
    } finally {
      if (runtime.cleanupSafe) {
        try { if (dir) rmSync(dir, { recursive: true, force: true }) } catch (error) { failure ??= error }
        try { unlock() } catch (error) { failure ??= error }
      }
    }
    if (signal.aborted && runtime.cleanupSafe) {
      job.phase = 'cancelled'
    } else if (report) {
      if (failure) appendLog(job, 'Omni was installed. Cleanup was incomplete: ' + diagnostic(failure))
      job.completed.add('install')
      job.phase = 'done'
      job.report = report
    } else {
      job.failedAt = job.step
      job.phase = 'failed'
      job.error = failure?.name === 'TimeoutError' ? 'The Omni ' + job.step + ' step took too long.' : diagnostic(failure)
      job.next = failure?.next ?? 'retry'
    }
    job.step = null
  }

  async function prepare({ version, reason, exitCode }) {
    if (typeof version !== 'string' || !VERSION.test(version)) throw omniRefusal('Name an Omni server version.')
    if (!legalPin(pin)) throw omniRefusal('This Automagik release has an invalid Omni pin. Update Automagik and try again.')
    const { npm, latest } = await probe(version)
    mutationAllowed()
    const routing = await installationRoute({ V: version, npm, env, platform, arch, run, pin })
    mutationAllowed()
    const { route, login, fallback } = routing
    const failedTerminal = reason === 'npm-failed' && Number.isInteger(exitCode) && exitCode !== 0 && exitCode !== 130
    const terminalFallback = failedTerminal && fallback
    const source = terminalFallback ? 'github' : route
    if (source !== 'github' && source !== 'npm') {
      if (compareVersions(pin.version, version) < 0) throw omniRefusal('This Automagik release pins an older Omni. Update Automagik or use an Omni on another computer.')
      throw omniRefusal(source === 'terminal' ? 'Install this version through Omni’s terminal.' : 'Omni cannot be installed here. Use an Omni on another computer.')
    }
    const firstReason = terminalFallback ? 'npm-failed' : !login ? 'no-systemd' : npm === 'published' ? 'behind' : 'unpublished'
    const release = source === 'npm' ? { version, tag: null } : { version: pin.version, tag: 'v' + pin.version }
    const image = env.AUTOMAGIK_GATE_IMAGE === '1'
    const layout = layoutOf(env)
    checkDirs(layout)
    const validateSandbox = () => {
      const intent = checkSandbox(layout, image, login, kill)
      if (intent && intent.version !== release.version) throw omniRefusal('Retry the interrupted Omni install at version ' + intent.version + '.')
    }
    validateSandbox()
    mkdirSync(layout.root, { recursive: true, mode: 0o700 })
    mkdirSync(layout.build, { recursive: true, mode: 0o700 })
    checkDirs(layout)
    const unlock = acquireLock(layout, { now, kill, boot, ticks })
    try { validateSandbox() } catch (error) { unlock(); throw error }
    job = {
      id: randomUUID(), acknowledged: false, cancelRequested: false, source, reason: firstReason,
      npm: { version, latest: latest ?? null, exitCode: terminalFallback ? exitCode : null }, release, fellBack: false, phase: 'running',
      step: 'check', completed: new Set(), failedAt: null, log: Buffer.alloc(0), error: null, next: null, report: null,
      controller: new AbortController(),
    }
    const result = { job: jobView(job) }
    void execute(job, { layout, image, fallback, unlock })
    return result
  }

  async function start(payload) {
    mutationAllowed()
    if (job?.phase === 'running') return { job: jobView(job) }
    if (!starting) {
      starting = prepare(payload).catch(error => { throw omniRefusal(error?.message ?? error) }).finally(() => { starting = null })
    }
    return starting
  }
  function status({ id } = {}) {
    return { job: id === undefined || id === job?.id ? jobView(job) : null }
  }
  function cancel({ id } = {}) {
    mutationAllowed()
    if (job?.phase === 'running' && (id === undefined || id === job.id)) {
      job.cancelRequested = true
      if (job.step !== 'install') job.controller.abort()
    }
    return { job: jobView(job) }
  }
  function ack({ id }) {
    mutationAllowed()
    if (!job || id !== job.id) return { job: null, claimed: false }
    const claimed = job.phase === 'done' && !job.acknowledged
    if (claimed) job.acknowledged = true
    return { job: jobView(job), claimed }
  }
  return { start, status, cancel, ack, view: () => jobView(job) }
}
