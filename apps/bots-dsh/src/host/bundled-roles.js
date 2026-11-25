import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SOLVER_ROLE_ID } from '../shared/solver-method.js'

export const BUNDLED_ROLE_IDS = Object.freeze([SOLVER_ROLE_ID])
export const BUNDLED_ROLE_CAPABILITIES = Object.freeze({
  [SOLVER_ROLE_ID]: Object.freeze(['task-start', 'route-policy']),
})
// Only the release cut adds versions to this history. The candidate digest is
// checked against the source before the cut and never authenticates an install.
export const BUNDLED_ROLE_HISTORY = Object.freeze({
  solver: Object.freeze(JSON.parse(readFileSync(new URL('./bundled-roles.json', import.meta.url))).solver),
})

export function expectedBundleDigest(history, id, version) {
  return Object.hasOwn(history[id] ?? {}, version) ? history[id][version] : undefined
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
