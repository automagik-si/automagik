// node --test chat/folder-rule.test.mjs: the transcript folder rule against the shared vectors
// (herdr/test/fixtures/transcript-folder-rule.json, which am-sidebar's copy of the rule reads too).
// Temp homes only, never the real home.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localTranscriptPath, remoteTranscriptPath, TRANSCRIPT_FOLDERS } from './folder-rule.js'

const here = dirname(fileURLToPath(import.meta.url))
const vectors = JSON.parse(readFileSync(join(here, '../../../test/fixtures/transcript-folder-rule.json'), 'utf8'))

test('every refusal names the reason it expects', () => {
  for (const c of vectors.cases) {
    if (c.expect === 'refuse') assert.equal(typeof c.reason, 'string', c.name)
  }
})

test('the vectors name the same folders as the rule', () => {
  assert.equal(vectors.version, 1)
  assert.deepEqual(vectors.folders, { ...TRANSCRIPT_FOLDERS })
})

/** A fresh, realpathed temp home with the case's files and symlinks made. */
function homeFor(c) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'chat-folder-rule-')))
  const fill = (s) => s.replaceAll('{home}', home)
  for (const d of c.setup?.dirs ?? []) mkdirSync(fill(d), { recursive: true })
  for (const f of c.setup?.files ?? []) {
    mkdirSync(dirname(fill(f)), { recursive: true })
    writeFileSync(fill(f), '')
  }
  for (const l of c.setup?.symlinks ?? []) {
    mkdirSync(dirname(fill(l.at)), { recursive: true })
    symlinkSync(fill(l.to), fill(l.at))
  }
  return { home, fill }
}

for (const c of vectors.cases) {
  test(`${c.mode}: ${c.name}`, () => {
    if (c.mode === 'local') {
      const { home, fill } = homeFor(c)
      const got = localTranscriptPath(c.agent, fill(c.path), home)
      if (c.expect === 'accept') assert.deepEqual(got, { ok: true, path: fill(c.resolved) })
      else assert.equal(got.reason, c.reason, `want ${c.reason}, got ${JSON.stringify(got)}`)
    } else {
      const got = remoteTranscriptPath(c.agent, c.path, c.home)
      if (c.expect === 'accept') assert.deepEqual(got, { ok: true, path: c.relative })
      else assert.equal(got.reason, c.reason, `want ${c.reason}, got ${JSON.stringify(got)}`)
    }
  })
}

test('a refusal names its folder, never the path', () => {
  const got = localTranscriptPath('claude', '/nowhere/.ssh/id_ed25519', '/nowhere')
  assert.equal(got.ok, false)
  assert.equal(got.folder, '.claude/projects')
  assert.ok(!JSON.stringify(got).includes('id_ed25519'))
})

test('a refused agent or home never throws', () => {
  for (const [a, p, h] of [[undefined, '/x.jsonl', '/h'], ['claude', null, '/h'], ['claude', '/h/.claude/projects/p/s.jsonl', undefined], ['__proto__', '/x.jsonl', '/h'], ['toString', '/x.jsonl', '/h']]) {
    assert.equal(localTranscriptPath(a, p, h).ok, false)
    assert.equal(remoteTranscriptPath(a, p, h).ok, false)
  }
})
