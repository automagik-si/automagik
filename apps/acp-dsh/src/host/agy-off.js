// Antigravity (`agy`) with its own tools off (#1564, RFC 0003 "Amendment: Antigravity native
// tools"). Two agy-side layers, both per process: L1, a main agent of ours with no tools
// (`agy acp --agent automagik-native-off`, the agent file below), and L2, a settings folder of
// ours whose `permissions.deny` names every tool action agy documents (`--cli_dir_name
// automagik-native-off`; the flag is listed by `agy acp --help` but not on agy's documentation
// pages). Under both, acp-dsh's own guard (L3, acp.js `refuseTools`) ends the answer at the
// first tool call agy reports and refuses every ask. agy has no DSH bridge, so OFF is chat only.
//
// Everything here is written to, and read from, the home the child itself runs in
// (`AUTOMAGIK_BOT_CLI_HOME`, cli-homes.js), never the person's. Only our own files and our own
// log folder are read; agy's sign-in store is never touched. Every failure here fails the start
// closed, before or right after agy's session opens, with a fixed sentence: agy's log text never
// leaves this file.
//
// The start failures are English only, as every acp-dsh start failure is (index.js): the Bot
// team does not translate a chat's turn failure. Details shows the translated hooks, plugins and
// Switch account lines (bots-dsh native-tools-copy.js).
import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const AGY_OFF_NAME = 'automagik-native-off'

// The agy version native tools off was checked on (stage 6 of #1564). It moves only by a
// reviewed commit after a stage 6 on the new version; another version still starts OFF and
// warns (the host log, and Details).
export const AGY_OFF_CHECKED = '1.5.15'

export const AGY_OFF_AGENT = `---
name: ${AGY_OFF_NAME}
description: Written by Automagik for Antigravity with native tools off. Rewritten at each start; never edit.
tools: []
excludeDefaultComponents: true
mainAgent: true
subagent: false
hidden: true
commandExecutionPolicy: "off"
---
# ${AGY_OFF_NAME}

You have no tools in this chat. Answer in text only.
`

export const AGY_OFF_SETTINGS = `${JSON.stringify({ permissions: { deny: [
  'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'download_url(*)', 'command(*)', 'mcp(*)',
] } })}\n`

export const AGY_TOOLS_OFF_TEXT = 'Antigravity tried to use a tool while native tools are off, so this answer stopped.'
export const AGY_HOOKS_TEXT = "Antigravity can't start with native tools off while its settings hold a hooks.json file. Remove hooks.json to use it with native tools off."
export const AGY_PLUGINS_TEXT = "Antigravity can't start with native tools off while its settings hold plugins."
export const AGY_FRESH_TEXT = 'Switch account on Antigravity in Settings starts it with empty settings; it also signs it out.'
export const AGY_NOT_LOADED_TEXT = 'Antigravity could not start with its tools off: it did not load its settings.'
export const AGY_UNCHECKED_LOG = 'Antigravity native-tools-off settings could not be checked in its log'
// The fixed text agy 1.5.15 and 1.5.16 log when it could not read or parse its settings (a
// missing or malformed file): `boot.go:109] Failed to load CLI settings, using defaults: …`.
export const AGY_SETTINGS_FAILED = 'Failed to load CLI settings, using defaults:'

const MAX_ENTRIES = 4096
const MAX_BYTES = 256 * 1024
const FRESH_MS = 10 * 60_000

export const agyOffPaths = home => {
  const gemini = join(home, '.gemini')
  const settingsDir = join(gemini, 'antigravity-cli', AGY_OFF_NAME)
  return {
    agentDir: join(gemini, 'config', 'agents'),
    agentFile: join(gemini, 'config', 'agents', `${AGY_OFF_NAME}.md`),
    settingsDir,
    settingsFile: join(settingsDir, 'settings.json'),
    logDir: join(settingsDir, 'log'),
    hooks: join(gemini, 'config', 'hooks.json'),
    plugins: join(gemini, 'config', 'plugins'),
  }
}

function writeVerified(dir, file, text, posix) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (posix) chmodSync(dir, 0o700)
  const temp = `${file}.${process.pid}.${randomUUID()}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, text) }
    finally { closeSync(fd) }
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
  if (posix) chmodSync(file, 0o600)
  if (readFileSync(file, 'utf8') !== text || (posix && (statSync(file).mode & 0o777) !== 0o600)) {
    throw new Error('its native-tools-off settings failed verification')
  }
}

/** Writes both OFF files into `home` (rewritten at every OFF start); throws on any mismatch. */
export function writeAgyOff(home, { platform = process.platform } = {}) {
  const posix = platform !== 'win32'
  const paths = agyOffPaths(home)
  writeVerified(paths.agentDir, paths.agentFile, AGY_OFF_AGENT, posix)
  writeVerified(paths.settingsDir, paths.settingsFile, AGY_OFF_SETTINGS, posix)
  return paths
}

// Whether a literal path exists (a file, a folder or a link, a dangling one included). Only
// `lstat`: never listed, opened or read. Anything but "no such file" is an answer of yes.
const present = path => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    return error?.code !== 'ENOENT'
  }
}

/** What in `home` runs outside every tool layer: agy's own hooks file and its plugins folder. */
export const agyExtensions = home => {
  const paths = agyOffPaths(home)
  return { hooks: present(paths.hooks), plugins: present(paths.plugins) }
}

/** The sentence an OFF start refuses with, or undefined: hooks first, then plugins. */
export function agyExtensionRefusal(home, { platform = process.platform } = {}) {
  const found = agyExtensions(home)
  const text = found.hooks ? AGY_HOOKS_TEXT : found.plugins ? AGY_PLUGINS_TEXT : undefined
  if (text === undefined) return undefined
  // No Switch account on Windows (the account is shared there, #2048).
  return platform === 'win32' ? text : `${text} ${AGY_FRESH_TEXT}`
}

const NAME = /^acp-server-\d{8}_\d{6}-(\d+)\.log$/

/**
 * What agy's own log for the process `pid` says of its OFF settings: 'failed' (it did not load
 * them, or the log cannot be read safely), 'clean' (a fresh log of that process with no failure
 * line) or 'unchecked' (no such log). Bounded: at most 4096 folder entries and 256 KiB of the one
 * file, a regular file only, never through a link, never blocking on a FIFO.
 */
export function readAgyLog(home, pid, spawnedAt) {
  const own = String(pid)
  if (!/^\d+$/.test(own)) return 'unchecked'
  const folder = agyOffPaths(home).logDir
  let dir
  try { dir = opendirSync(folder) } catch (error) { return error?.code === 'ENOENT' ? 'unchecked' : 'failed' }
  let chosen
  try {
    for (let count = 0; ;) {
      const entry = dir.readSync()
      if (entry === null) break
      count += 1
      if (count > MAX_ENTRIES) return 'unchecked'
      // The name's stamp is agy's own clock and zone: only the file's own time says it is fresh.
      if (NAME.exec(entry.name)?.[1] !== own) continue
      let stat
      try { stat = lstatSync(join(folder, entry.name)) } catch (error) {
        if (error?.code === 'ENOENT') continue
        return 'failed'
      }
      if (stat.mtimeMs < spawnedAt - FRESH_MS) continue
      if (chosen === undefined || stat.mtimeMs > chosen.stat.mtimeMs
        || (stat.mtimeMs === chosen.stat.mtimeMs && entry.name > chosen.name)) chosen = { name: entry.name, stat }
    }
  } catch {
    return 'failed'
  } finally {
    try { dir.closeSync() } catch {}
  }
  if (chosen === undefined) return 'unchecked'
  if (!chosen.stat.isFile()) return 'failed'
  let fd
  try {
    fd = openSync(join(folder, chosen.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== chosen.stat.dev || opened.ino !== chosen.stat.ino) return 'failed'
    const buffer = Buffer.alloc(MAX_BYTES)
    let size = 0
    while (size < MAX_BYTES) {
      const read = readSync(fd, buffer, size, MAX_BYTES - size, size)
      if (read === 0) break
      size += read
    }
    return buffer.subarray(0, size).toString('utf8').includes(AGY_SETTINGS_FAILED) ? 'failed' : 'clean'
  } catch {
    return 'failed'
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/**
 * The L2 check of one OFF child, started at `spawnedAt` in `home`: `start(run)` right after its
 * `session/new` (before the first prompt) and `again(run)` before each later prompt. Both throw
 * AGY_NOT_LOADED_TEXT when agy's log says it did not load the OFF settings. No log of that process
 * warns once per child and goes on (L1 and L3 still hold). agy writes no line after it loads its
 * settings (M0, agy 1.5.16: none follows the failure line's position), so the first turn is not
 * covered against a failure line written after its `session/new` answer; the next turn's check
 * catches it.
 */
export function agyOffCheck(home, { spawnedAt, warn = () => {}, read = readAgyLog }) {
  let warned = false
  const check = (run) => {
    const seen = read(home, run?.child?.pid, spawnedAt)
    if (seen === 'failed') throw new Error(AGY_NOT_LOADED_TEXT)
    if (seen === 'unchecked' && !warned) {
      warned = true
      try { warn(AGY_UNCHECKED_LOG) } catch {}
    }
  }
  return { start: check, again: check }
}
