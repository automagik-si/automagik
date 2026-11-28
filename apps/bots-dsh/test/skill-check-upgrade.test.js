import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkSkill, SKILL_CHECK_FINGERPRINT, SKILL_CHECK_HISTORY, SKILL_CHECK_VERSION } from '../src/host/skill-check.js'
import { install, SKILL_IMPORT_MARK, SKILL_REVIEW_KEY } from '../src/host/skill-library.js'
import { textSkillMd } from '../src/host/skill-library-rules.js'

const key = Buffer.alloc(32, 7)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha(JSON.stringify(value))
const mac = (...values) => createHmac('sha256', key).update(JSON.stringify(values)).digest('hex')
const stamp = version => ({ version, fingerprint: SKILL_CHECK_HISTORY[version] })
const confirmation = 'Review the warnings, then save again to confirm.'
const reviewNeeded = 'A model has not reviewed this skill yet. Review the stored skill to continue.'

test('checker 4 preserves the shipped history fingerprints', () => {
  assert.equal(SKILL_CHECK_VERSION, 4)
  assert.deepEqual(SKILL_CHECK_HISTORY, {
    1: '420fd71f94985003644b18c79ecb92d34cd0a33e613686032a7234219ceb3cb6',
    2: 'ac081b74af656d1f6e08d8330d63420dd51037bc795a94910a395015260c85e8',
    3: 'e1cafb02e58b7af53dc5508839c9b0bebd1454a74613f4fd577c891f9ed75f98',
    4: SKILL_CHECK_FINGERPRINT,
  })
})

function fixture(t, options) {
  const home = mkdtempSync(join(tmpdir(), 'skill-check-upgrade-'))
  const root = join(home, 'skill-library')
  const path = join(root, 'library.json')
  mkdirSync(root, { mode: 0o700 })
  writeFileSync(join(home, SKILL_REVIEW_KEY), key, { mode: 0o600 })
  let modelCalls = 0
  const unexpectedModelCall = () => { modelCalls++; throw new Error('Unexpected Skills review') }
  const rt = { home, ctx: {}, readOnly: () => undefined, teamGeneration: () => 1,
    sameTeam: generation => generation === 1, botOf: id => id === 'bot' ? { id } : undefined,
    skillReviewModel: unexpectedModelCall, assembleLlm: unexpectedModelCall }
  install(rt, options)
  t.after(async () => {
    await rt.skillLibrary.settled()
    rmSync(home, { recursive: true, force: true })
  })
  const owner = { id: 'owner', role: 'owner' }
  return { home, path, modelCalls: () => modelCalls,
    get: name => rt.skillLibrary.endpoint('skill-library-get', { name }, owner),
    save: form => rt.skillLibrary.endpoint('skill-library-save', form, owner),
    active: () => rt.skillLibrary.active('bot').map(row => row.name),
    write: data => writeFileSync(path, JSON.stringify(data), { mode: 0o600 }),
    read: () => JSON.parse(readFileSync(path, 'utf8')) }
}

const sources = [
  { kind: 'text' },
  { kind: 'file', fileName: 'notes.md' },
  { kind: 'folder', folderName: 'notes' },
  { kind: 'archive', fileName: 'notes.zip' },
  { kind: 'link', url: 'https://notes.example/SKILL.md', ref: null, host: 'notes.example', fetchedAt: 1 },
]

function sealedRow(name, source, version, finding) {
  const record = { name, source, description: 'Write short notes.',
    content: finding === 'gate' ? 'Explain sudo to a beginner.' : 'Write a short note.' }
  const bytes = textSkillMd(record)
  const entries = [{ path: 'SKILL.md', bytes }]
  if (source.kind !== 'text') record.frontmatter = bytes.toString()
  if (source.kind === 'link') record.source = { ...source, revision: 'sha256:' + sha(bytes) }
  if (['folder', 'archive', 'link'].includes(source.kind)) record.files = []

  const check = checkSkill(entries, { expectedName: name })
  assert.equal(check.verdict, finding === 'gate' ? 'warn' : 'pass')
  record.hash = check.hash
  record.check = { ...stamp(version), verdict: check.verdict, ranAt: 1 }
  const findings = finding === 'model'
    ? [{ file: 'SKILL.md', line: 5, area: 'other', severity: 'low', reason: 'Synthetic review finding.' }] : []
  const review = { status: 'done', hash: record.hash, findings, at: 1 }
  const reviewDigest = digest(review)
  record.review = review
  record.reviewSeal = mac('review-v3', reviewDigest)
  if (finding) {
    const gateFindings = check.findings.map(({ rule, level, reason, line, path, area }) =>
      ({ rule, level, reason, line, path, area, injection: false }))
    const report = [...gateFindings, ...findings.map(row => ({ ...row, injection: false }))]
    record.accepted = record.hash
    record.acceptedReview = reviewDigest
    record.acceptanceSeal = mac('accept-v2', name, record.source, record.hash, record.check.fingerprint,
      reviewDigest, digest(report))
  }
  return record
}

const library = (rows, reviews = {}) => ({ version: 1,
  skills: Object.fromEntries(rows.map(row => [row.name, row])), active: { bot: rows.map(row => row.name) }, reviews })

for (const source of sources) {
  test(`checker 3 → 4 carries clean ${source.kind} reviews and requires fresh acceptance`, async t => {
    const f = fixture(t)
    const clean = sealedRow('clean-notes', source, 3)
    const old = ['gate', 'model'].map(finding => sealedRow(finding + '-notes', source, 3, finding))
    const current = ['gate', 'model'].map(finding => sealedRow(finding + '-notes', source, 4, finding))
    const reviews = Object.fromEntries(old.map(row => [row.hash, { review: row.review, seal: row.reviewSeal }]))
    f.write(library([clean, ...current], reviews))
    assert.deepEqual(f.active(), [clean.name, ...current.map(row => row.name)])

    f.write(library([clean, ...old], reviews))
    const before = readFileSync(f.path)
    assert.deepEqual((await f.get(clean.name)).review, clean.review)
    assert.deepEqual(f.active(), [clean.name])
    for (const row of old) {
      const held = await f.get(row.name)
      assert.equal(held.held, confirmation)
      assert.equal(held.reviewHash, row.hash)
      assert.deepEqual(held.review, row.review)
    }
    assert.deepEqual(readFileSync(f.path), before)

    for (const row of old) {
      const input = { name: row.name, reviewHash: row.hash, edit: true }
      const decision = await f.save(input)
      assert.match(decision.needsConfirm ?? '', /^[a-f0-9]{64}$/)
      assert.deepEqual(await f.save({ ...input, confirm: decision.needsConfirm }), { saved: true })
      const stored = f.read().skills[row.name]
      assert.equal(stored.hash, row.hash)
      assert.deepEqual(stored.source, row.source)
      assert.deepEqual(stored.review, row.review)
      assert.deepEqual(stored.reviewSeal, row.reviewSeal)
      assert.equal(stored.check.version, 4)
      assert.equal(stored.check.fingerprint, SKILL_CHECK_FINGERPRINT)
      assert.equal(stored.acceptanceSeal, current.find(item => item.name === row.name).acceptanceSeal)
    }
    assert.deepEqual(f.active(), [clean.name, ...old.map(row => row.name)])
    assert.equal(f.modelCalls(), 0)
  })
}

test('tampered acceptance seals and missing reviews stay held', async t => {
  const f = fixture(t)
  const tampered = [3, 4].map(version => ({ ...sealedRow(`tampered-${version}`, sources[0], version, 'gate'),
    acceptanceSeal: '0'.repeat(64) }))
  const { review, reviewSeal, ...unreviewed } = sealedRow('unreviewed', sources[0], 3)
  f.write(library([...tampered, unreviewed]))
  for (const row of tampered) assert.equal((await f.get(row.name)).held, confirmation)
  assert.equal((await f.get(unreviewed.name)).held, reviewNeeded)
  assert.deepEqual(f.active(), [])
  assert.equal(f.modelCalls(), 0)
})

test('local provenance admits only stamps 1 and 2, and the import mark holds them too', async t => {
  const f = fixture(t, { holdPreexistingTyped: false })
  const rows = [1, 2, 3, 4].map(version => {
    const { review, reviewSeal, ...row } = sealedRow(`legacy-${version}`, sources[0], version)
    row.localProvenance = mac('local-legacy-v1', realpathSync(f.home), row.name, row.hash, row.check.fingerprint)
    return row
  })
  f.write(library(rows))
  assert.deepEqual(f.active(), ['legacy-1', 'legacy-2'])
  for (const row of rows.slice(2)) assert.equal((await f.get(row.name)).held, reviewNeeded)
  writeFileSync(join(f.home, SKILL_IMPORT_MARK), '', { mode: 0o600 })
  assert.deepEqual(f.active(), [])
  for (const row of rows) assert.equal((await f.get(row.name)).held, reviewNeeded)
  assert.equal(f.modelCalls(), 0)
})
