import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function claudeNativeBash(live, tool) {
  return live.native === true && live.provider === 'acp-claude' && tool.structuredName === 'Bash'
    && tool.mcp !== true && tool.mcpServer === undefined
}

// Claude's completed Bash input can omit a streamed cd to its working directory.
const LEADING_CD = /^cd (?:'([^']+)'|"([^"\\$`!]+)"|([^\s'"\\$`&;|<>()*?[\]{}!]+)) && /

export function isWorkspacePath(path, workspace) {
  // A same-directory alias can still change Bash's logical PWD.
  return path === workspace && typeof path === 'string' && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)
    // Shell cd can resolve .. logically before following symlinks.
    && !path.split(process.platform === 'win32' ? /[\\/]/ : '/').includes('..')
    && realpathSync.native(path) === workspace
}

export function stripsWorkspaceCd(before, after, launch) {
  const workspace = launch?.workspace
  if (workspace === undefined || typeof before.command !== 'string'
    || typeof after.command !== 'string' || after.command === '') return false
  const prefix = LEADING_CD.exec(before.command)
  return prefix !== null && before.command.slice(prefix[0].length) === after.command
    && isWorkspacePath(launch.workspaceArgument, workspace)
    && isWorkspacePath(prefix[1] ?? prefix[2] ?? prefix[3], workspace)
    && [before, after].every(input => ['cwd', 'workdir'].every(key =>
      !Object.hasOwn(input, key) || isWorkspacePath(input[key], workspace)))
}
