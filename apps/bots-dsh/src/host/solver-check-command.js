import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const LOGIN_SHELL = '^(?:(?:/usr)?/bin/)?(?:bash|zsh)[ \t]+-lc'
const WRAPPER_PREFIX = new RegExp(LOGIN_SHELL + "(?=[ \t'\"]|$)")
const WRAPPER = new RegExp(LOGIN_SHELL + String.raw`[ \t]+(?:'([^'\r\n\0]*)'|"([^"$\x60\\\r\n\0]*)")$`)
const CD_PREFIX = /^cd(?=[ \t'"]|$)/
const CD_AND_COMMAND = /^cd[ \t]+(?:'([^'\r\n\0]+)'|"([^"$\x60\\\r\n\0]+)"|([A-Za-z0-9_./:-]+))[ \t]*&&[ \t]*(.+)$/
const SHELL_WITH_COMMAND_OPTION = /^(?:[A-Za-z0-9_./+-]*\/)?(?:bash|zsh|sh|dash|ksh|fish)(?:[ \t]+-[A-Za-z-]+)*[ \t]+(?:-[A-Za-z]*c[A-Za-z]*|--command)(?=[ \t=]|$)/
const SINGLE_COMMAND = /^[A-Za-z0-9_./+-]+(?=[ \t]|$)(?:'[^'\r\n\0]*'|"(?:\\[^\r\n\0]|[^"\\$\x60\r\n\0])*"|\\[^\r\n\0]|[^'"\\$\x60;&|()<>\r\n\0])*$/

// The inner command stays literal, with its arguments and quoting intact.
export function normalizeCheckCommand(input) {
  let command = typeof input === 'string' ? input.trim() : ''
  if (!command) return { reason: 'The command input is missing or ambiguous.' }
  if (WRAPPER_PREFIX.test(command)) {
    const match = WRAPPER.exec(command)
    if (!match) return { reason: 'The shell wrapper is ambiguous.' }
    command = (match[1] ?? match[2]).trim()
  }
  let directory
  if (CD_PREFIX.test(command)) {
    const match = CD_AND_COMMAND.exec(command)
    directory = match && (match[1] ?? match[2] ?? match[3])
    if (!directory || directory.startsWith('-')) return { reason: 'The cd directory is ambiguous.' }
    if (!isAbsolute(directory) && !/^\.\.?(?:\/|$)/.test(directory)) {
      return { reason: 'The check working directory depends on CDPATH.' }
    }
    command = match[4].trim()
  }
  if (WRAPPER_PREFIX.test(command) || CD_PREFIX.test(command) || SHELL_WITH_COMMAND_OPTION.test(command) || !SINGLE_COMMAND.test(command)) {
    return { reason: 'The command boundaries are ambiguous.' }
  }
  return { command, directory }
}

function effectiveCwd(cwd, directory) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  try {
    const base = realpathSync.native(cwd)
    const path = directory === undefined ? base : isAbsolute(directory) ? directory : base + sep + directory
    const target = realpathSync.native(path)
    // A symlink and ".." can make logical and physical cd reach different directories.
    if (directory !== undefined && realpathSync.native(resolve(cwd, directory)) !== target) return undefined
    if (lstatSync(target).isDirectory()) return target
  } catch {}
}

export function withinCheckRoot(root, cwd) {
  if (typeof root !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) return false
  const scope = relative(root, cwd)
  return !isAbsolute(scope) && scope !== '..' && !scope.startsWith('..' + sep)
}

export function nativeCheckDirectory(agreed, observed, root, cwd) {
  const effective = effectiveCwd(cwd, observed.directory)
  if (effective === undefined) return false
  if (agreed.directory === undefined) return withinCheckRoot(effectiveCwd(root), effective)
  if (observed.directory === undefined) return false
  return effective === effectiveCwd(root, agreed.directory)
}
