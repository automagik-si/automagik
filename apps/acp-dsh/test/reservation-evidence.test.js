// RFC 0024 reservation evidence, from invented vendor replies only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeReservation, CODEX_PLAN_CLASSES, codexPlanClass, codexReservation,
  reservationDigests, reservationOutcome } from '../src/host/reservation-evidence.js'

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const claude = overrides => claudeReservation(JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai', email: 'Ana@example.test', orgId: 'org-1', ...overrides,
}))
const codex = (planType, overrides, result) => codexReservation({
  account: { type: 'chatgpt', email: 'Ana@example.test', planType, ...overrides }, ...result,
})

const complete = { outcome: 'complete', reservable: true }
const ambiguous = why => ({ outcome: 'ambiguous', reservable: false, why })
const none = why => ({ outcome: 'none', reservable: false, why })

test('Claude reservation evidence requires a first-party subscription sign-in', () => {
  assert.deepEqual(claude({ apiProvider: 'firstParty' }), {
    person: true, vendor: 'claude', email: 'ana@example.test', org: 'org-1',
  })
  assert.deepEqual(reservationOutcome(claude()), complete)
  for (const orgId of [null, undefined]) {
    assert.deepEqual(reservationOutcome(claude({ orgId })), ambiguous('no-organisation'))
  }
  assert.deepEqual(reservationOutcome(claude({ email: undefined })), none('no-email'))
  for (const overrides of [
    { authMethod: 'api_key' }, { authMethod: 'gateway', orgId: undefined },
    { authMethod: 'oauth_token' }, { apiProvider: 'bedrock' }, { apiProvider: 'vertex' },
    { apiKeySource: 'ANTHROPIC_API_KEY' }, { loggedIn: false }, { authMethod: 'other' },
  ]) {
    assert.deepEqual(claude(overrides), { person: false })
    assert.deepEqual(reservationOutcome(claude(overrides)), none('not-a-subscription'))
  }
  assert.deepEqual(reservationOutcome(claudeReservation('not JSON')), none('unknown'))
})

test('reservation identity validates the raw fields before lowercasing the email', () => {
  const longestEmail = `${'a'.repeat(252)}@b`
  assert.deepEqual(reservationOutcome(claude({ email: longestEmail })), complete)
  for (const email of [`${longestEmail}b`, 'ana@example.test\n', ' ana@example.test',
    'ana@example.test ', 'ana\u0007@example.test', 'ana\u007f@example.test',
    'ana\uD800@example.test', 'a@', 'ana.example.test', 'ana@@example.test', 30]) {
    assert.deepEqual(reservationOutcome(claude({ email })), none('no-email'))
    assert.deepEqual(reservationOutcome(codex('plus', { email })), none('no-email'))
  }
  assert.equal(claude({ orgId: 'A' }).org, 'A')
  assert.equal(claude({ orgId: ' Org ' }).org, ' Org ')
  assert.deepEqual(reservationOutcome(claude({ orgId: 'a'.repeat(200) })), complete)
  for (const orgId of ['', 'a'.repeat(201), 'org\n', 'org-\uD800', 'org-\uD801', 30]) {
    const evidence = claude({ orgId })
    assert.equal(Object.hasOwn(evidence, 'org'), false)
    assert.deepEqual(reservationOutcome(evidence), ambiguous('no-organisation'))
    assert.deepEqual(reservationDigests(evidence, key), { loose: reservationDigests(claude(), key).loose })
  }
})

test('Codex reservation evidence uses exact plan values and ignores workspace and user names', () => {
  const classes = {
    personal: ['free', 'go', 'plus', 'pro', 'prolite', 'promax'],
    workspace: ['team', 'business', 'self_serve_business_prolite', 'self_serve_business_usage_based',
      'enterprise', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
      'edu', 'edu_plus', 'edu_pro'],
  }
  assert.deepEqual(CODEX_PLAN_CLASSES, classes)
  for (const [group, plans] of Object.entries(classes)) for (const plan of plans) {
    assert.equal(codexPlanClass(plan), group, plan)
    assert.deepEqual(codex(plan), { person: true, vendor: 'codex', email: 'ana@example.test', class: group })
    assert.deepEqual(reservationOutcome(codex(plan)), complete, plan)
  }
  for (const plan of [undefined, null, 'Plus', ' plus', 'sci', 'sci_plus', 'unknown', 'future-plan', 1]) {
    assert.equal(codexPlanClass(plan), 'unknown')
    assert.deepEqual(reservationOutcome(codex(plan)), ambiguous('unknown-plan'))
  }
  const noEmail = codex('team', { email: null })
  assert.deepEqual(noEmail, { person: true, vendor: 'codex', class: 'workspace' })
  assert.deepEqual(reservationOutcome(noEmail), none('no-email'))
  for (const account of [{ type: 'apiKey' }, { type: 'amazonBedrock' }, { type: 'gcp' }, null, undefined]) {
    const evidence = codexReservation({ account })
    assert.deepEqual(evidence, { person: false })
    assert.deepEqual(reservationOutcome(evidence), none('not-a-subscription'))
  }
  assert.deepEqual(reservationDigests(codex('team', { workspaceName: 'First' }, { userId: 'one' }), key),
    reservationDigests(codex('team', { workspaceName: 'Second' }, { userId: 'two' }), key))
})

test('reservation digests use the v1 canonical bytes and a 32-byte key', () => {
  const claudeDigests = reservationDigests(claude(), key)
  const codexDigests = reservationDigests(codex('plus'), key)
  assert.deepEqual(claudeDigests, {
    exact: 'rMX4_C6kKIJheIB2gAVOdiCfBj99qgMc6K3Bxd_e0qk',
    loose: 'r0KnohZ2T2JxOF4la7Y5waKRR8SQhGax8ushxAtX2ZQ',
  })
  assert.deepEqual(codexDigests, {
    exact: 'ONItomzTpcoLJNZIXkjowyqnh1mhYmXeX9rl2DOdjxQ',
    loose: 'Eg_9KNK2-fnbAF7Pfq9aq4pMaZcGMDtKiaWDzj-3iCc',
  })
  assert.deepEqual(reservationDigests(claude(), Uint8Array.from(key)), claudeDigests)
  const otherKey = reservationDigests(claude(), Buffer.alloc(32, 45))
  assert.notEqual(otherKey.exact, claudeDigests.exact)
  assert.notEqual(otherKey.loose, claudeDigests.loose)
  const otherOrg = reservationDigests(claude({ orgId: 'Org-1' }), key)
  assert.notEqual(otherOrg.exact, claudeDigests.exact)
  assert.equal(otherOrg.loose, claudeDigests.loose)
  assert.deepEqual(reservationDigests(claude({ email: 'ANA@EXAMPLE.TEST' }), key), claudeDigests)
  assert.deepEqual(reservationDigests(codex('pro'), key), codexDigests)
  const workspace = reservationDigests(codex('team'), key)
  assert.notEqual(workspace.exact, codexDigests.exact)
  assert.equal(workspace.loose, codexDigests.loose)
  assert.deepEqual(reservationDigests(claude({ orgId: undefined }), key), { loose: claudeDigests.loose })
  assert.deepEqual(reservationDigests(codex('unknown'), key), { loose: codexDigests.loose })
  assert.deepEqual(reservationDigests(codex('team', { email: null }), key), {})
  assert.deepEqual(reservationDigests(undefined, key), {})
  assert.notEqual(codexDigests.loose, claudeDigests.loose)
  const otherEmail = reservationDigests(claude({ email: 'other@example.test' }), key)
  assert.notEqual(otherEmail.exact, claudeDigests.exact)
  assert.notEqual(otherEmail.loose, claudeDigests.loose)
  for (const invalid of [Buffer.alloc(31), Buffer.alloc(33), 'a'.repeat(32), new DataView(key.buffer, key.byteOffset, 32)]) {
    assert.throws(() => reservationDigests(undefined, invalid), TypeError)
  }
  for (const digest of [...Object.values(claudeDigests), ...Object.values(codexDigests)]) {
    assert.match(digest, /^[A-Za-z0-9_-]{43}$/)
    assert.doesNotMatch(digest, /ana@example\.test|org-1|plus/i)
  }
})
