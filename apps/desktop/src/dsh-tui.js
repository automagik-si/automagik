// DSH as a Herdr agent, the desktop side (#561): the opt-in setup in the title bar's menu.
//
// The installer is am/dshTui.mjs, the same module `automagik-herdr dsh-tui` and the Herdr pack
// use. This file owns only the desktop's layer: where that module is, the child runner that
// calls it, the dialog's words, and adding the user bin folder to the login shell's PATH. The
// pin, the `dsh-tui` profile, the shim, the release-age exception and the doctor facts stay the
// module's;
// none is repeated here.
//
// The module is not copied into git: scripts/prepare-runtime.mjs copies it and its local import
// closure into build/dsh-tui, and electron-builder ships that folder as a resource.
// A packaged app reads it from process.resourcesPath; a checkout reads the repository's am/.
import { execFile as nodeExecFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DSH_TUI_LABEL = 'Set up DSH in Herdr…'
export const DSH_TUI_LOG = 'dsh-tui.log'
export const DSH_TUI_TIMEOUT_MS = 20 * 60_000
/** The installer's local import closure and sandbox wrapper; prepare-runtime keeps folders. */
export const DSH_TUI_FILES = Object.freeze([
  'dshTui.mjs', 'approved.js', 'workers.js', 'models.js', 'model.js', 'logins.js', 'loginWords.js',
  'hermesPair.js',
  'retired.js', 'layoutSafe.mjs', 'release.js', 'bin/dsh-sandbox.mjs', 'bin/hc-socket-mask.mjs',
])
/** The shipped folder is ESM: its release.js has no package.json above it in a packaged app. */
export const DSH_TUI_PACKAGE = '{"type":"module","private":true}\n'
/** The patch line a shell config gets when the user bin folder is not on the login shell's PATH. */
export const PATH_MARK = "# Automagik: the dsh-tui shim "
  + "(Herdr's built-in DSH entry finds it on PATH)"

/** Where the shared installer is in this repository (appPath is apps/desktop). */
export const dshTuiSourceDir = ({ appPath }) => resolve(appPath, '..', '..', 'am')
/** The module the app imports: its shipped resource when packaged, am/ in a checkout. */
export function dshTuiModuleDir({ packaged, resourcesPath, appPath }) {
  return packaged ? join(resourcesPath, 'dsh-tui') : dshTuiSourceDir({ appPath })
}
/** The child runner: shipped beside the module when packaged, `src/` in a checkout. */
export function dshTuiRunnerOf({ packaged, resourcesPath, appPath }) {
  return packaged
    ? join(resourcesPath, 'dsh-tui', 'dsh-tui-run.mjs')
    : join(appPath, 'src', 'dsh-tui-run.mjs')
}
/** dsh-TUI's shim is a POSIX shell script; the native Windows app is off. */
export const dshTuiSupported = (platform = process.platform) =>
  platform === 'darwin' || platform === 'linux'

const lastLine = text => String(text ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
const lastJson = (text) => {
  const lines = String(text ?? '').trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* not the answer */ }
  }
  return null
}

/**
 * Run one action through the shared module in a child Node process, and answer its one JSON
 * result: `{ ok, action, pane, pin, profile, presence, result, skip, error }`. Electron's own
 * binary runs the child as Node, so a pnpm install never blocks the app's main process.
 */
export function runDshTui({
  action, moduleDir, env = process.env, node = process.execPath,
  runner = join(HERE, 'dsh-tui-run.mjs'), execFile = nodeExecFile, timeout = DSH_TUI_TIMEOUT_MS,
} = {}) {
  return new Promise((done) => {
    execFile(node, [runner, action], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', AUTOMAGIK_DSH_TUI_MODULE: moduleDir },
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout = '', stderr = '') => {
      const answer = lastJson(stdout)
      if (!answer) {
        const why = lastLine(stderr) || error?.message || 'the dsh-TUI runner gave no answer'
        return done({ ok: false, action, error: why })
      }
      if (answer.error) return done({ ok: false, action, error: answer.error, pane: answer.pane })
      done({
        ok: true,
        action,
        pane: answer.pane,
        pin: answer.pin,
        profile: answer.profile,
        presence: answer.presence,
        result: answer.result,
        skip: answer.result?.skip ?? null,
      })
    })
  })
}

/** The doctor's checks as the module's CLI prints them: `ok`/`FAIL`, the detail and any fix. */
export function formatDoctor(checks = []) {
  return checks
    .map(check => `${check.ok ? 'ok  ' : 'FAIL'} ${check.check}: ${check.detail}`
      + (check.fix ? ` (fix: ${check.fix})` : ''))
    .join('\n')
}

const closeButton = { id: 'close', label: 'Close' }
const versionOf = pin => (typeof pin === 'string' && pin.includes('@')
  ? pin.slice(pin.lastIndexOf('@') + 1) : pin)
const NEVER = "It never writes DSH's credentials, its reserved desktop profile "
  + "or Automagik's settings."
const AUTH = 'Sign in inside dsh-TUI with /model (DeepSeek Account) or /auth; a '
  + "DEEPSEEK_API_KEY already in the environment or in DSH's credential store works too."
const SESSIONS = 'Sessions land in your DSH home and show in DSH Desktop after you quit and '
  + 'reopen it (no live refresh).'

/**
 * The setup dialog for one doctor answer: what the dialog says, and the one action each button
 * takes. Read-only; a person picks install, repair, uninstall or close, and the caller runs it.
 */
export function setupView({ answer, platform = process.platform } = {}) {
  if (!answer || answer.ok === false) {
    return {
      type: 'warning',
      message: 'DSH in Herdr',
      detail: `Could not read the dsh-TUI state: ${answer?.error ?? 'the runner gave no answer'}.`,
      buttons: [closeButton],
      defaultId: 0,
      cancelId: 0,
    }
  }
  if (!dshTuiSupported(platform)) {
    return {
      type: 'info',
      message: 'DSH in Herdr is not available here',
      detail: "dsh-TUI's shim is a POSIX shell script, which this computer cannot run.",
      buttons: [closeButton],
      defaultId: 0,
      cancelId: 0,
    }
  }
  if (answer.skip) {
    const checks = formatDoctor(answer.result?.checks ?? [])
    return {
      type: 'info',
      message: 'DSH is not installed',
      detail: `${answer.skip}${checks ? `\n\n${checks}` : ''}\n\n`
        + 'Open this menu again once DSH is on the PATH Herdr panes get.',
      buttons: [closeButton],
      defaultId: 0,
      cancelId: 0,
    }
  }
  const checks = answer.result?.checks ?? []
  const presence = answer.presence ?? {}
  const healthy = answer.result?.code === 0
  const installed = presence.profile === true || presence.shimExists === true
  const version = versionOf(answer.pin)
  const named = version ? `dsh-TUI ${version}` : 'dsh-TUI'
  const profile = answer.profile ?? 'dsh-tui'
  const doctor = formatDoctor(checks)
  if (!installed) {
    return {
      type: 'info',
      message: 'DSH in Herdr',
      detail: `${doctor}\n\nInstall puts ${named} in the ${profile} DSH profile (never the `
        + `reserved desktop profile) and writes the dsh-tui shim in your user bin folder. `
        + `${NEVER}\n${AUTH}\n${SESSIONS}`,
      buttons: [{ id: 'install', label: `Install ${named}` }, closeButton],
      defaultId: 0,
      cancelId: 1,
    }
  }
  if (!healthy) {
    return {
      type: 'warning',
      message: 'DSH in Herdr needs repair',
      detail: `${doctor}\n\nRepair installs ${named} in the ${profile} profile again. `
        + `Uninstall removes the plugin and this installer's shim; sessions and dsh-TUI's `
        + `state stay.`,
      buttons: [
        { id: 'install', label: 'Repair dsh-TUI' },
        { id: 'uninstall', label: 'Uninstall' },
        closeButton,
      ],
      defaultId: 0,
      cancelId: 2,
    }
  }
  return {
    type: 'info',
    message: 'DSH in Herdr is set up',
    detail: `${doctor}\n\nReinstall / update keeps the ${profile} profile on ${named}. `
      + `Uninstall removes the plugin and this installer's shim; sessions and dsh-TUI's `
      + `state stay.\n${SESSIONS}`,
    buttons: [
      { id: 'install', label: 'Reinstall / update' },
      { id: 'uninstall', label: 'Uninstall' },
      closeButton,
    ],
    defaultId: 0,
    cancelId: 2,
  }
}

/** The one action an install, update or uninstall result asks for: a dialog. */
export function resultView({ action, answer }) {
  const status = answer?.result?.status
  const failed = !answer?.ok || status === 'failed'
  const lines = answer?.ok
    ? (answer.result?.lines?.length ? answer.result.lines : [answer.result?.detail ?? ''])
    : [answer?.error ?? 'the runner gave no answer']
  const message = !answer?.ok || status === 'failed'
    ? 'DSH in Herdr setup failed'
    : status === 'skipped'
      ? 'DSH is not installed'
      : action === 'uninstall'
        ? (status === 'removed' ? 'dsh-TUI removed' : 'dsh-TUI is not installed')
        : 'dsh-TUI is set up'
  return {
    type: failed ? 'warning' : 'info',
    message,
    detail: lines.filter(Boolean).join('\n'),
    buttons: [closeButton],
    defaultId: 0,
    cancelId: 0,
  }
}

/**
 * Where the shim's folder is missing from the login shell's PATH: the config file to add it to,
 * and the line for that shell. Null when the pane PATH already has it, or on Windows.
 */
export function pathActionOf({ pane, home = homedir(), platform = process.platform } = {}) {
  if (!dshTuiSupported(platform)) return null
  if (!pane || typeof pane.path !== 'string' || typeof pane.config !== 'string') return null
  const binDir = join(home, '.local', 'bin')
  if (pane.path.split(delimiter).includes(binDir)) return null
  const shell = typeof pane.shell === 'string' && pane.shell ? pane.shell : '/bin/sh'
  const config = pane.config.replace(/^~(?=$|\/)/, home)
  const line = basename(shell) === 'fish'
    ? 'fish_add_path "$HOME/.local/bin"'
    : 'export PATH="$HOME/.local/bin:$PATH"'
  return { binDir, config, shell, line, mark: PATH_MARK }
}

/**
 * Add the PATH line once: a config that already names the user bin folder, or the exact line, is
 * left as it is. Creates the config's folder when the shell has none yet (fish).
 */
export function ensurePathLine({
  action, read = readFileSync, append = appendFileSync, mkdir = mkdirSync,
} = {}) {
  let text = null
  try {
    text = read(action.config, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const known = [action.line, action.binDir, '~/.local/bin', '$HOME/.local/bin']
  if (typeof text === 'string' && known.some(value => text.includes(value))) {
    return { changed: false, config: action.config }
  }
  mkdir(dirname(action.config), { recursive: true })
  const lead = typeof text === 'string' && text !== '' && !text.endsWith('\n') ? '\n' : ''
  append(action.config, `${lead}${action.mark}\n${action.line}\n`)
  return { changed: true, config: action.config }
}

/** The question before writing the PATH line; the answer is the only consent to write it. */
export function pathView(action) {
  return {
    type: 'question',
    message: 'Add the dsh-tui shim to your PATH?',
    detail: `${action.binDir} is not on the PATH your login shell (${action.shell}) gives `
      + `Herdr, so Herdr's built-in DSH entry will not find the dsh-tui command.\n\nAdd this `
      + `line to ${action.config}?\n\n${action.mark}\n${action.line}\n\n`
      + `Herdr reads the new PATH when it restarts.`,
    buttons: [{ id: 'add-path', label: 'Add to PATH' }, closeButton],
    defaultId: 0,
    cancelId: 1,
  }
}

/** What the app says after writing the PATH line. */
export function pathDoneView(action) {
  return {
    type: 'info',
    message: 'Added to your PATH',
    detail: `Wrote the line to ${action.config}. Restart Herdr so its + menu sees the `
      + `dsh-tui command.`,
    buttons: [{ id: 'close', label: 'OK' }],
    defaultId: 0,
    cancelId: 0,
  }
}
