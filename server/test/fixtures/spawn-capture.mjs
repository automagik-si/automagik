import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function spawnCapture(dir, command, args, options) {
  const stdout = join(dir, 'subprocess-stdout')
  const stderr = join(dir, 'subprocess-stderr')
  const out = openSync(stdout, 'w')
  const err = openSync(stderr, 'w')
  let result
  try {
    result = spawnSync(command, args, { ...options, stdio: ['ignore', out, err] })
  } finally {
    closeSync(out)
    closeSync(err)
  }
  return { ...result, stdout: readFileSync(stdout, 'utf8'), stderr: readFileSync(stderr, 'utf8') }
}
