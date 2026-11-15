// Code mode's first step (RFC 0013, delivery 1): find herdr-app, start or raise its window,
// and wait for it. Pure apart from what it is handed: main.js passes the real file system,
// execFile and spawn; tests pass fakes. Every call to herdr-app is execFile with an argv array
// and an absolute path, never a shell, with a 10 s limit. The page never names a path here.
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { CLOSE_INHERITED, DETACH_CLEAN } from './child-paths.js'

export const OVERRIDE = 'AUTOMAGIK_HERDR_APP'
export const BUNDLE_ID = 'dev.herdr.app'
export const LIMIT_MS = 10_000
export const NO_FOCUS = 'Herdr is open in another window'
export const NOT_OPENED = "Herdr didn't open"

const pathOf = platform => (platform === 'win32' ? win32 : posix)

/** Intel Macs and Windows on ARM get no herdr-app build, so no switch (Decided 7). */
export const supportedHost = ({ platform, arch }) =>
  (platform === 'darwin' && arch === 'arm64') ||
  (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
  (platform === 'win32' && arch === 'x64')

/**
 * Where herdr-app may be, in order: the override; herdr's own install paths for the OS (an app
 * started from Finder has no ~/.local/bin on its PATH, so these come first); then PATH. On
 * macOS herdrdev's installer writes ~/Applications/Herdr.app, so it comes before /Applications
 * (a dragged copy).
 */
export function candidatesOf({ platform, env = {}, home }) {
  const p = pathOf(platform)
  const listed = []
  if (platform === 'darwin') {
    listed.push(p.join(home, 'Applications', 'Herdr.app', 'Contents', 'MacOS', 'Herdr'))
    listed.push(p.join('/Applications', 'Herdr.app', 'Contents', 'MacOS', 'Herdr'))
    listed.push(p.join(home, '.local', 'bin', 'herdr-app'))
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA) listed.push(p.join(env.LOCALAPPDATA, 'Programs', 'herdr-app', 'herdr-app.exe'))
  } else {
    const data = env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, '.local', 'share')
    listed.push(p.join(data, 'herdr-app', 'herdr-app'))
    listed.push(p.join(home, '.local', 'bin', 'herdr-app'))
  }
  const name = platform === 'win32' ? 'herdr-app.exe' : 'herdr-app'
  const dirs = String(env.PATH ?? env.Path ?? '').split(p.delimiter).filter(dir => dir && p.isAbsolute(dir))
  for (const dir of dirs) listed.push(p.join(dir, name))
  return [...new Set(listed)]
}

/** The .app bundle a macOS binary lives in, or null. */
export function bundleOf(file) {
  const match = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(file)
  return match ? match[1] : null
}

/**
 * herdr-app on this computer: `{ bin, app, source }` (`app` the macOS bundle LaunchServices
 * opens, else null; `source` 'override', 'install' or 'path'), or null. An override that names
 * nothing usable means "not set up": it never falls through to an installed copy.
 */
export function findHerdr({ platform, env = {}, home, isFile = defaultIsFile, resolve = defaultResolve }) {
  const p = pathOf(platform)
  const found = (file, source) => {
    let bin = file
    let app = null
    if (platform === 'darwin') {
      if (/\.app\/?$/.test(file)) bin = p.join(file.replace(/\/$/, ''), 'Contents', 'MacOS', 'Herdr')
      app = bundleOf(resolve(bin)) ?? bundleOf(bin)
    }
    return isFile(bin) ? { bin, app, source } : null
  }
  const override = env[OVERRIDE]
  if (override !== undefined && override !== '') return p.isAbsolute(override) ? found(override, 'override') : null
  const installed = candidatesOf({ platform, env: { ...env, PATH: '', Path: '' }, home })
  for (const file of installed) {
    const hit = found(file, 'install')
    if (hit) return hit
  }
  for (const file of candidatesOf({ platform, env, home }).filter(file => !installed.includes(file))) {
    const hit = found(file, 'path')
    if (hit) return hit
  }
  return null
}

function defaultIsFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function defaultResolve(file) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** Runs `file args…` with no shell: `{ code, stdout, stderr }`, never a throw. */
export function run(file, args, { env, timeout = LIMIT_MS, execFile = nodeExecFile } = {}) {
  return new Promise(done => {
    execFile(file, args, { env, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout = '', stderr = '') => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      done({ code, stdout: String(stdout), stderr: String(stderr || (error && code === null ? error.message : '')) })
    })
  })
}

const lastLine = text => String(text ?? '').trim().split(/\r?\n/).pop() ?? ''

/**
 * What the Code side would show, read now: 'unsupported', 'missing', 'closed' (`status` exits
 * 2, no window), 'open' (exit 0), or 'error' with herdr-app's last stderr line.
 */
export async function herdrStatus({ platform, arch, env, home, isFile, resolve, execFile } = {}) {
  if (!supportedHost({ platform, arch })) return { state: 'unsupported' }
  const found = findHerdr({ platform, env, home, isFile, resolve })
  if (!found) return { state: 'missing' }
  const result = await run(found.bin, ['status'], { env, execFile })
  if (result.code === 0) return { state: 'open', source: found.source }
  if (result.code === 2) return { state: 'closed', source: found.source }
  return { state: 'error', source: found.source, message: lastLine(result.stderr) || `status exited ${result.code}` }
}

/**
 * How to start or raise the window. macOS: LaunchServices (`open -a`), so Herdr is never the
 * app's child; `--env` carries HERDR_APP_HOME when one is set (only a start reads it). Linux and
 * Windows: the bare binary, detached, which opens or raises the window.
 */
export function launchOf({ platform, found, env = {} }) {
  if (platform === 'darwin' && found.app) {
    const args = env.HERDR_APP_HOME ? ['--env', `HERDR_APP_HOME=${env.HERDR_APP_HOME}`] : []
    return { file: '/usr/bin/open', args: [...args, '-a', found.app], detached: false }
  }
  return { file: found.bin, args: [], detached: true }
}

export function startDetached(file, args, {
  env = process.env, spawn = nodeSpawn, node = process.execPath, platform = process.platform,
} = {}) {
  if (platform === 'linux') {
    return new Promise(done => {
      const failed = () => done({ code: null, stderr: 'herdr could not start' })
      try {
        const child = spawn(node, ['--require', CLOSE_INHERITED, DETACH_CLEAN, file, ...args], {
          env: {
            ...env, ELECTRON_RUN_AS_NODE: '1',
            AUTOMAGIK_HOP_RUN_AS_NODE: env.ELECTRON_RUN_AS_NODE ?? '',
          },
          detached: true, stdio: 'ignore', windowsHide: false,
        })
        child.once('error', failed)
        child.once('exit', code => {
          if (code === 0) done({ code: 0, stderr: '' })
          else failed()
        })
      } catch {
        failed()
      }
    })
  }
  return new Promise(done => {
    let child
    try {
      child = spawn(file, args, { env, detached: true, stdio: 'ignore', windowsHide: false })
    } catch (error) {
      return done({ code: null, stderr: error.message })
    }
    child.once('error', error => done({ code: null, stderr: error.message }))
    child.once('spawn', () => {
      child.unref()
      done({ code: 0, stderr: '' })
    })
  })
}

export const GRACE_MS = 1500

/**
 * `status` until it exits 0, for up to `limit` ms. Exit 2 (no window yet) keeps waiting. Any
 * other answer is borne for `grace` ms from the start (a window just started or restarted can
 * answer 1 for a moment: the harness saw it on Linux), then stops the wait with herdr-app's
 * last stderr line (`failed` true).
 */
export async function waitOpen(bin, { env, execFile, limit = LIMIT_MS, grace = GRACE_MS, every = 250, now = Date.now, sleep = defaultSleep } = {}) {
  const start = now()
  let last = { code: null, stderr: '' }
  for (;;) {
    last = await run(bin, ['status'], { env, execFile, timeout: Math.max(1000, limit - (now() - start)) })
    if (last.code === 0) return { ready: true, ms: now() - start }
    if (last.code !== 2 && now() - start >= grace) return { ready: false, failed: true, ms: now() - start, code: last.code, stderr: lastLine(last.stderr) }
    if (now() - start + every > limit) return { ready: false, ms: now() - start, code: last.code, stderr: lastLine(last.stderr) }
    await sleep(every)
  }
}

const defaultSleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * Which app is in front, as `{ front, detail }`: `front` true when it is herdr-app, false when
 * it is something else, null when this system cannot tell (Wayland, no window manager).
 */
export async function frontmost({ platform, env, execFile }) {
  if (platform === 'darwin') {
    const asn = await run('/usr/bin/lsappinfo', ['front'], { env, execFile })
    const id = asn.stdout.trim()
    if (asn.code !== 0 || !id) return { front: null, detail: lastLine(asn.stderr) || 'lsappinfo front: nothing' }
    const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', id], { env, execFile })
    const bundle = /"CFBundleIdentifier"="([^"]*)"/.exec(info.stdout)?.[1] ?? null
    return { front: bundle === null ? null : bundle === BUNDLE_ID, detail: bundle ?? lastLine(info.stderr) }
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -Namespace AM -Name W -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);\'',
      '$h = [AM.W]::GetForegroundWindow(); $p = 0; [void][AM.W]::GetWindowThreadProcessId($h, [ref]$p)',
      '$q = Get-Process -Id $p -ErrorAction SilentlyContinue; "$($q.ProcessName)`t$($q.MainWindowTitle)"',
    ].join('\n')
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
    const shell = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const out = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { env, execFile })
    const [name = '', title = ''] = out.stdout.trim().split('\t')
    if (out.code !== 0 || !name) return { front: null, detail: lastLine(out.stderr) || 'no foreground window' }
    return { front: name.toLowerCase() === 'herdr-app', detail: `${name}${title ? `: ${title}` : ''}` }
  }
  if (env.WAYLAND_DISPLAY || !env.DISPLAY) return { front: null, detail: env.WAYLAND_DISPLAY ? 'Wayland' : 'no DISPLAY' }
  const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { env, execFile })
  const id = /window id # (0x[0-9a-f]+)/i.exec(root.stdout)?.[1]
  if (root.code !== 0 || !id || /^0x0+$/.test(id)) return { front: null, detail: lastLine(root.stderr) || 'no active window (no window manager?)' }
  const prop = await run('xprop', ['-id', id, '_NET_WM_PID', 'WM_CLASS'], { env, execFile })
  const wmClass = /WM_CLASS\(STRING\) = (.+)/.exec(prop.stdout)?.[1] ?? ''
  if (prop.code !== 0) return { front: null, detail: lastLine(prop.stderr) }
  return { front: /"herdr-app"/i.test(wmClass), detail: wmClass || id }
}

/**
 * Start or raise Herdr and wait for its window (protocol steps 1, 3 and 4). Resolves to
 * `{ ok: true, raised, message? }` (`raised` true, false, or null when the OS cannot tell; the
 * no-focus message unless it is true) or `{ ok: false, reason, message }`. `mark(step)` times
 * the steps for logs/switch.log.
 */
export async function openHerdr({
  platform, arch, env, home, isFile, resolve, execFile, spawn, node, now, sleep, limit,
  mark = () => {}, log = () => {},
} = {}) {
  if (!supportedHost({ platform, arch })) {
    log('unsupported-host')
    return { ok: false, reason: 'unsupported', message: 'Herdr has no build for this computer' }
  }
  const found = findHerdr({ platform, env, home, isFile, resolve })
  if (!found) {
    log('missing')
    return { ok: false, reason: 'missing', message: 'Herdr is not set up' }
  }
  mark('found')
  return raiseHerdr({ platform, found, env, execFile, spawn, node, now, sleep, limit, mark, log })
}

/**
 * Steps 3 and 4 for a herdr-app already found: start or raise it, wait for its window, and
 * look at what is in front. The same answers as openHerdr.
 */
export async function raiseHerdr({
  platform, found, env, execFile, spawn, node, now, sleep, limit,
  mark = () => {}, log = () => {},
}) {
  const launch = launchOf({ platform, found, env })
  const started = launch.detached
    ? await startDetached(launch.file, launch.args, { env, spawn, node, platform })
    : await run(launch.file, launch.args, { env, execFile })
  if (started.code !== 0) {
    log(`start-error ${lastLine(started.stderr)}`)
    return { ok: false, reason: 'start', message: NOT_OPENED, detail: lastLine(started.stderr) }
  }
  mark('started')
  const waited = await waitOpen(found.bin, { env, execFile, now, sleep, limit })
  if (waited.failed) {
    const message = waited.stderr || `status exited ${waited.code}`
    log(`status-error ${message}`)
    return { ok: false, reason: 'error', message, detail: message }
  }
  if (!waited.ready) {
    log(`timeout ${waited.stderr}`)
    return { ok: false, reason: 'timeout', message: NOT_OPENED, detail: waited.stderr }
  }
  mark('ready')
  // The window can come forward a moment after it answers: look up to three times.
  let focus = await frontmost({ platform, env, execFile })
  for (let tries = 1; focus.front === false && tries < 3; tries++) {
    await (sleep ?? defaultSleep)(300)
    focus = await frontmost({ platform, env, execFile })
  }
  if (focus.front === true) {
    mark('raised')
    return { ok: true, raised: true }
  }
  log(`no-focus ${focus.detail ?? ''}`.trim())
  return { ok: true, raised: focus.front, message: NO_FOCUS, detail: focus.detail }
}
