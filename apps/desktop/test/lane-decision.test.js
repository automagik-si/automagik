import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { beforeStart, checkLane, laneDecision, laneUpdate, PUBLISHERS, satisfies } from '../src/lane.js'
import { compareVersions } from '../src/update.js'
import { generateKeyPairSync, sign } from 'node:crypto'

const publisher = PUBLISHERS[0]
const name = '@automagik/bots-dsh'
const plugin = { name, version: '3.22.1', url: 'https://github.com/example/plugin.tgz', engines: { dsh: '>=0.2.1-rc.3 <0.2.2-0' } }
const lane = { schemaVersion: 1, keyId: 'test', publisher: publisher.publisher, sequence: 220001, version: '3.22.1', base: '3.22.0', plugins: [plugin] }
const context = { publisher, appVersion: '3.22.0', dshVersion: '0.2.1-rc.3', installed: { [name]: '3.22.0' } }

test('every rejection explains the existing eligibility decision', () => {
  for (const [value, ctx, reason] of [
    [null, context, 'invalid-lane'], [{ ...lane, publisher: 'other' }, context, 'invalid-lane'],
    [lane, { ...context, last: 220002 }, 'older-sequence'],
    [lane, { ...context, appVersion: '3.21.0' }, 'app-line'],
    [{ ...lane, base: '3.22.2' }, context, 'app-minimum'],
    [lane, { ...context, bad: ['3.22.1'] }, 'trial-failed'],
    [lane, { ...context, dshVersion: '0.2.2' }, 'dsh-range'],
    [lane, { ...context, installed: { [name]: '3.22.1' } }, 'up-to-date'],
    [lane, context, null],
  ]) {
    const decision = laneDecision(value, ctx)
    assert.equal(decision.reason, reason)
    assert.deepEqual(decision.update, laneUpdate(value, ctx))
    assert.equal(Boolean(decision.update), reason === null)
  }
})

test('published versions include the newest per publisher plugin even when ineligible', () => {
  const decision = laneDecision({ ...lane, addons: [
    { ...plugin, version: '3.22.4', engines: { dsh: '>=9.0.0' } },
    { ...plugin, version: '3.22.2' }, { ...plugin, name: 'other', version: '9.0.0' },
  ] }, { ...context, appVersion: '3.21.0' })
  assert.deepEqual(decision.plugins, [{ name, version: '3.22.4' }])
  assert.equal(decision.line, '3.22')
  assert.equal(decision.base, '3.22.0')
})

test('the existing eligibility fixtures also pass through laneDecision with identical updates', () => {
  // Run only the existing pure eligibility cases, leaving their fixtures and assertions intact.
  const source = readFileSync(new URL('./lane.test.js', import.meta.url), 'utf8')
  const start = source.indexOf('const lane =')
  const end = source.indexOf('// A profile as pnpm')
  assert.ok(start > 0 && end > start)
  let calls = 0
  runInNewContext(source.slice(start, end).replaceAll('import.meta.url', JSON.stringify(import.meta.url)), {
    automagik: publisher, PUBLISHERS, satisfies, compareVersions,
    laneUpdate(value, ctx) {
      calls++
      const update = laneDecision(value, ctx).update
      assert.equal(JSON.stringify(update), JSON.stringify(laneUpdate(value, ctx)))
      return update
    },
    assert: { ...assert, deepEqual: (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b)) },
    test(title, body) { if (!/trusts the keys|opens only/.test(title)) body() },
  })
  assert.ok(calls >= 15)
})

test('a verified check reports the decision without changing its return shape', async () => {
  const pair = generateKeyPairSync('ed25519')
  const bytes = Buffer.from(JSON.stringify(lane))
  const signature = Buffer.from(sign(null, bytes, pair.privateKey).toString('base64'))
  const decisions = []
  const result = await checkLane({ ...context,
    publisher: { ...publisher, url: 'https://example.test/lane.json', keys: [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }] },
    fetch: async url => ({ ok: true, arrayBuffer: async () => url.endsWith('.sig') ? signature : bytes }),
    onDecision: (decision, version) => decisions.push({ decision, version }),
  })
  assert.deepEqual(result, laneUpdate(lane, context))
  assert.equal(decisions[0].version, '3.22.1')
  assert.deepEqual(decisions[0].decision.update, result)
})

test('a failed swap reports rollback while keeping the legacy null answer and previous plugin', t => {
  const home = mkdtempSync(join(tmpdir(), 'force-rollback-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const target = join(home, 'profile'), real = join(target, 'node_modules', name)
  const dir = join(home, 'next'), archive = join(home, 'bad-archive')
  for (const path of [real, dir, archive, join(home, 'lane')]) mkdirSync(path, { recursive: true })
  writeFileSync(join(real, 'package.json'), JSON.stringify({ name, version: '3.22.0' }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '3.22.1' }))
  writeFileSync(join(target, 'package.json'), JSON.stringify({ dependencies: { [name]: 'old' } }))
  writeFileSync(join(home, 'lane', 'staged.json'), JSON.stringify({ version: '3.22.1',
    lanes: { automagik: { version: '3.22.1', sequence: 1 } },
    plugins: [{ publisher: 'automagik', name, version: '3.22.1', dir, archive }],
  }))
  let restored = 0
  assert.equal(beforeStart({ home, target, onRollback: () => restored++ }), null)
  assert.equal(restored, 1)
  assert.equal(JSON.parse(readFileSync(join(real, 'package.json'))).version, '3.22.0')
  assert.deepEqual(JSON.parse(readFileSync(join(target, 'package.json'))), { dependencies: { [name]: 'old' } })
})
