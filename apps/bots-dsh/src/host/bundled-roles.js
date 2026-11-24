import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SOLVER_ROLE_ID } from '../shared/solver-method.js'
import { compareVersions } from './lane-verify.js'

export const BUNDLED_ROLE_IDS = Object.freeze([SOLVER_ROLE_ID])
// Each key starts a new content range. Keep all released entries and append a new
// range when the source changes. The release check compares against its predecessor.
export const BUNDLED_ROLE_HISTORY = Object.freeze({
  solver: Object.freeze(JSON.parse(readFileSync(new URL('./bundled-roles.json', import.meta.url))).solver),
})

export function expectedBundleDigest(history, id, version) {
  const starts = Object.keys(history[id] ?? {}).sort(compareVersions)
  const start = starts.findLast(from => compareVersions(from, version) <= 0)
  return history[id]?.[start]
}

export const manifestBytes = manifest => Buffer.from(JSON.stringify(manifest, null, 2) + '\n')

export function bundleDigest(files) {
  const hash = createHash('sha256')
  for (const path of [...files.keys()].sort()) {
    const bytes = path === 'role.json'
      ? manifestBytes({ ...JSON.parse(files.get(path)), version: '0.0.0' })
      : files.get(path)
    hash.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  return hash.digest('hex')
}
