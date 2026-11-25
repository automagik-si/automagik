import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const LOGIN_SHELL = '^(?:(?:/usr)?/bin/)?(?:bash|zsh)[ \t]+-lc'
const WRAPPER_PREFIX = new RegExp(LOGIN_SHELL + "(?=[ \t'\"]|$)")
const WRAPPER = new RegExp(LOGIN_SHELL + String.raw`[ \t]+(?:'([^'\r\n\0]*)'|"([^"$\x60\\\r\n\0]*)")$`)
const CD_PREFIX = /^cd(?=[ \t'"]|$)/
const CD_AND_COMMAND = /^cd[ \t]+(?:'([^'\r\n\0]+)'|"([^"$\x60\\\r\n\0]+)"|([A-Za-z0-9_./:-]+))[ \t]*&&[ \t]*(.+)$/
const COMMAND_WORD = /^[A-Za-z0-9_./+-]+(?=[ \t]|$)/
const SHELL_KEYWORD = /^(?:case|coproc|do|done|elif|else|end|esac|fi|for|foreach|function|if|in|repeat|select|then|time|until|while|nocorrect|noglob|-)$/
const SHELL_PROGRAM = /(?:^|\/)(bash|zsh|sh|dash|ksh|fish)$/
const SHELL_COMMAND_OPTION = /^(?:-[A-Za-z]*c|--(?:command|init-command|init-file|rcfile)(?:=|$))/
const FISH_COMMAND_OPTIONS = ['command', 'init-command']
const ARGUMENT_PART = /([^ \t'"\\$\x60;&|()<>\r\n\0*?\[\]{}~#^!]+)|'([^'\r\n\0]*)'|"((?:\\[^\r\n\0]|[^"\\$\x60\r\n\0])*)"|\\([^\r\n\0])/y
const trimShellWhitespace = command => command.replace(/^[ \t\n]+|(?<![ \t\n])[ \t\n]+$/g, '')

function shellCommandOption(shell, argument) {
  if (SHELL_COMMAND_OPTION.test(argument)) return true
  if (shell !== 'fish') return false
  if (/^-[A-Za-z]*C/.test(argument)) return true
  const longOption = /^--([^=]+)/.exec(argument)?.[1]
  return !!longOption && FISH_COMMAND_OPTIONS.some(option => option.startsWith(longOption))
}

function hasLiteralArguments(command) {
  const executable = COMMAND_WORD.exec(command)?.[0]
  if (!executable || SHELL_KEYWORD.test(executable)) return false
  const shell = SHELL_PROGRAM.exec(executable)?.[1]
  let offset = executable.length
  while (offset < command.length) {
    while (command[offset] === ' ' || command[offset] === '\t') offset++
    // zsh can expand a leading unquoted equals sign to an executable path.
    if (command[offset] === '=') return false
    let argument = ''
    while (offset < command.length && command[offset] !== ' ' && command[offset] !== '\t') {
      ARGUMENT_PART.lastIndex = offset
      const part = ARGUMENT_PART.exec(command)
      if (!part) return false
      const [, bare, single, double, escaped] = part
      if (bare && /[=:]=/.test(bare)) return false
      // Double quotes remove the backslash only before a shell-special character.
      if (shell) argument += bare ?? single ?? double?.replace(/\\(["\\$\x60])/g, '$1') ?? escaped
      offset = ARGUMENT_PART.lastIndex
    }
    // Inspect whole literal words, including options after another option's operand.
    if (shell && shellCommandOption(shell, argument)) return false
  }
  return true
}

// The inner command stays literal, with its arguments and quoting intact.
export function normalizeCheckCommand(input) {
  let command = typeof input === 'string' ? trimShellWhitespace(input) : ''
  if (!command) return { reason: 'The command input is missing or ambiguous.' }
  if (WRAPPER_PREFIX.test(command)) {
    const match = WRAPPER.exec(command)
    if (!match) return { reason: 'The shell wrapper is ambiguous.' }
    command = trimShellWhitespace(match[1] ?? match[2])
  }
  let directory
  if (CD_PREFIX.test(command)) {
    const match = CD_AND_COMMAND.exec(command)
    directory = match && (match[1] ?? match[2] ?? match[3])
    if (!directory || directory.startsWith('-')) return { reason: 'The cd directory is ambiguous.' }
    if (!isAbsolute(directory) && !/^\.\.?(?:\/|$)/.test(directory)) {
      return { reason: 'The check working directory depends on CDPATH.' }
    }
    command = trimShellWhitespace(match[4])
  }
  if (WRAPPER_PREFIX.test(command) || CD_PREFIX.test(command) || !hasLiteralArguments(command)) {
    return { reason: 'The command boundaries are ambiguous.' }
  }
  return { command, directory }
}

function effectiveCwd(cwd, directory) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
  try {
    const base = realpathSync.native(cwd)
    if (!lstatSync(base).isDirectory()) return undefined
    if (directory === undefined) return base
    const path = isAbsolute(directory) ? directory : base + sep + directory
    const target = realpathSync.native(path)
    // A symlink and ".." can make logical and physical cd reach different directories.
    if (realpathSync.native(resolve(cwd, directory)) !== target) return undefined
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
