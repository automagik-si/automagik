import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const OMP_OFF_OVERLAY = `# Written by Automagik for omp with native tools off. Rewritten at each start; never edit.
memory:
  backend: "off"
autolearn:
  enabled: false
externalThinking: false
goal:
  enabled: false
speechgen:
  enabled: false
generate_image:
  enabled: false
dev:
  autoqa: false
`

export function writeOmpOverlay(dir) {
  const posix = process.platform !== 'win32'
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (posix) chmodSync(dir, 0o700)
  const file = resolve(dir, 'native-off.yml')
  const temp = `${file}.${process.pid}.${randomUUID()}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, OMP_OFF_OVERLAY) }
    finally { closeSync(fd) }
    renameSync(temp, file)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
  if (posix) chmodSync(file, 0o600)
  if (readFileSync(file, 'utf8') !== OMP_OFF_OVERLAY || (posix && (statSync(file).mode & 0o777) !== 0o600)) {
    throw new Error('its native-tools-off settings failed verification')
  }
  return file
}
