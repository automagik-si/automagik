// The Apps page's Automagik overlay is separate data, not an edit to the upstream catalog.
// catalog.js is upstream's file and must keep merging cleanly on the next upstream sync, so
// this test proves both halves: the overlay owns different ids, and the file itself has no
// diff against the upstream base.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { CATALOG, CATEGORIES } from '../src/host/connectors/catalog.js'
import { OFFICIAL_APPS, OFFICIAL_IDS } from '../src/host/connectors/official.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const CATALOG_FILE = 'src/host/connectors/catalog.js'
const git = (...args) => execFileSync('git', ['-C', PLUGIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const upstreamRef = () => {
  for (const ref of ['origin/dev', 'dev']) {
    try {
      git('rev-parse', '--verify', `${ref}^{commit}`)
      return ref
    } catch {}
  }
  return null
}

test('the official overlay is its own list and shadows no upstream id', () => {
  assert.deepEqual(OFFICIAL_IDS, ['omni', 'genie', 'claude', 'codex'])
  const catalogIds = new Set(CATALOG.map(entry => entry.id))
  assert.deepEqual(OFFICIAL_IDS.filter(id => catalogIds.has(id)), [], 'an overlay id is never added to catalog.js')
  assert.deepEqual(CATEGORIES, ['dev', 'docs', 'work', 'design', 'data', 'commerce', 'search', 'mail'], 'the upstream categories stay as upstream has them')
  for (const app of OFFICIAL_APPS) {
    assert.equal(typeof app.about, 'string', `${app.id} has its own one-line text`)
    assert.equal(typeof app.kind, 'string', `${app.id} says what installing it means`)
  }
})

test('catalog.js has no diff against upstream dev, in the tree and in the commit', (t) => {
  const base = upstreamRef()
  if (base === null) return t.skip('no dev ref in this checkout; the gate command covers this')
  assert.equal(git('diff', base, '--', CATALOG_FILE).trim(), '', 'the working tree did not edit catalog.js')
  assert.equal(git('diff', `${base}...HEAD`, '--', CATALOG_FILE).trim(), '', 'the branch did not edit catalog.js')
})
