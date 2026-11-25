import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { test } from 'node:test'
import { SKILL_CHECK_FINGERPRINT, SKILL_CHECK_HISTORY, SKILL_CHECK_VERSION } from '../src/host/skill-check.js'

const root = new URL('../', import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const source = path => readFileSync(new URL(path, root))
const versionPath = 'src/host/skill-check-version.js'
const version = createRequire(import.meta.url)('ipaddr.js/package.json').version
const fingerprint = (sources, dependency) => sha(JSON.stringify({ v: 1, sources, deps: [['ipaddr.js', dependency]] }))

test('the fingerprint includes each checker source and the installed dependency version', () => {
  const reached = new Set()
  const walk = path => {
    if (path === versionPath || reached.has(path)) return
    reached.add(path)
    for (const [, spec] of source(path).toString().matchAll(/^(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
      walk(posix.normalize(posix.join(posix.dirname(path), spec)))
    }
  }
  walk('src/host/skill-check.js')
  const paths = [...reached].sort()
  assert.deepEqual(paths, [
    'src/host/memory-entries.js', 'src/host/redact.js', 'src/host/skill-check.js',
    'src/host/skill-library-rules.js', 'src/shared/roles.js', 'src/shared/skill-rule-reasons.js',
  ])
  const sources = paths.map(path => [path, sha(source(path))])
  assert.equal(fingerprint(sources, version), SKILL_CHECK_FINGERPRINT)
  assert.equal(SKILL_CHECK_FINGERPRINT, SKILL_CHECK_HISTORY[SKILL_CHECK_VERSION])
  assert.notEqual(fingerprint(sources, `${version}-fixture`), SKILL_CHECK_FINGERPRINT)
  const edit = sources.map(([path, hash]) => [path, path === 'src/host/memory-entries.js'
    ? sha(source(path).toString().replace('PASSWORD_GIVEN', 'PASSWORD_given')) : hash])
  assert.notEqual(fingerprint(edit, version), SKILL_CHECK_FINGERPRINT)
})
