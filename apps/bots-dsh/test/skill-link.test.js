import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchSkillLink, parseSkillLink, validLinkSource } from '../src/host/skill-link.js'
import {
  api, directLink, fakeOpen, folderLink, folderRoutes, json, publicResolver, ref, response, revisionA, revisionB, tree,
} from './fixtures/skill-link-fixtures.js'

test('link folder reads a pinned path one tree at a time and checks archive-like entries', async () => {
  const fixture = folderRoutes()
  const requested = []
  const result = await fetchSkillLink(parseSkillLink(folderLink), { resolve: publicResolver,
    open: fakeOpen(fixture.routes, requested), now: () => 100 })
  assert.deepEqual(result.source, { kind: 'link', url: folderLink, ref: 'refs/heads/main', revision: revisionA,
    host: 'raw.githubusercontent.com', fetchedAt: 100 })
  assert.deepEqual(result.entries.map(entry => entry.path), ['SKILL.md'])
  assert.deepEqual(requested.filter(url => url.includes('/git/trees/')), [
    api('git/trees/' + fixture.root), api('git/trees/' + fixture.parent), fixture.listing,
  ])
  const ambiguous = folderRoutes()
  ambiguous.routes.set(api('git/matching-refs/heads/main'), () => json([
    ref('heads/main', revisionA), ref('heads/main/skills', revisionB),
  ]))
  await assert.rejects(fetchSkillLink(parseSkillLink(folderLink), { resolve: publicResolver, open: fakeOpen(ambiguous.routes) }),
    { reason: 'link-ref' })
  const symlink = folderRoutes()
  symlink.routes.set(symlink.listing, () => json(tree(symlink.folder, [
    { path: 'SKILL.md', mode: '120000', type: 'blob', sha: revisionA, size: 1 },
  ])))
  await assert.rejects(fetchSkillLink(parseSkillLink(folderLink), { resolve: publicResolver, open: fakeOpen(symlink.routes) }),
    { reason: 'link-github-link' })
  const corrupt = folderRoutes()
  const raw = await corrupt.routes.get(corrupt.raw + 'SKILL.md')().toArray()
  corrupt.routes.set(corrupt.raw + 'SKILL.md', () => response(Buffer.alloc(raw[0].length, 88)))
  await assert.rejects(fetchSkillLink(parseSkillLink(folderLink), { resolve: publicResolver, open: fakeOpen(corrupt.routes) }),
    { reason: 'link-github-mismatch' })
})

test('stored link provenance must agree with the permalink and excludes credentials', () => {
  const url = folderLink.replace('/main/', '/' + revisionA + '/')
  const source = { kind: 'link', url, ref: revisionA, revision: revisionA, host: 'raw.githubusercontent.com', fetchedAt: 100 }
  assert.equal(validLinkSource(source), true)
  assert.equal(validLinkSource({ ...source, revision: revisionB }), false)
  assert.equal(validLinkSource({ ...source, ref: 'refs/heads/main' }), false)
  assert.equal(validLinkSource({ ...source, url: url.replace('https://', 'https://user@') }), false)
})

test('an HTML link is refused with the Text pointer', async () => {
  for (const headers of [{ 'content-type': 'text/html' }, {}]) {
    await assert.rejects(fetchSkillLink(parseSkillLink(directLink), { resolve: publicResolver,
      open: () => response('<!doctype html><title>Example</title>', { headers }) }),
    { reason: 'link-page', message: /use Text/ })
  }
})
