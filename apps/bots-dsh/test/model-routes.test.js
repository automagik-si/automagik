import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SELECTOR_ROUTES, crossesHarness, routeOfRef, selectorRouteOf, selectorRoutePolicy } from '../src/shared/routes.js'

test('the selector offers Native, ACP and Remote Hermes without Herdr', () => {
  assert.deepEqual([...SELECTOR_ROUTES], ['native', 'acp', 'hermes-remote'])
})

test('a provider is placed on its selector route and harness', () => {
  assert.deepEqual(routeOfRef('deepseek/v4'), { provider: 'deepseek', route: 'native', harness: 'dsh' })
  assert.equal(selectorRouteOf('anthropic'), 'native')
  assert.deepEqual(routeOfRef('acp-claude/default'), { provider: 'acp-claude', route: 'acp', harness: 'claude-code' })
  assert.deepEqual(routeOfRef('acp-hermes/default'), { provider: 'acp-hermes', route: 'acp', harness: 'hermes' })
  // A provider acp-dsh adds later is an ACP route without a selector change.
  assert.equal(selectorRouteOf('acp-something-new'), 'acp')
})

test('a route or an ACP agent is a harness crossing; a model under one provider is not', () => {
  assert.equal(crossesHarness('deepseek/v4', 'acp-claude/default'), true)
  assert.equal(crossesHarness('acp-claude/default', 'acp-codex/default'), true)
  // A model change inside one agent keeps the conversation.
  assert.equal(crossesHarness('acp-claude/opus', 'acp-claude/sonnet'), false)
  assert.equal(crossesHarness('deepseek/v4', 'deepseek/v4-pro'), false)
  // No current model: a first pick is never a crossing.
  assert.equal(crossesHarness(undefined, 'acp-claude/default'), false)
  assert.equal(crossesHarness('', 'deepseek/v4'), false)
})

test('a route policy hides routes per bot type, refuses unknown routes, and keeps no bot type hard-coded', () => {
  assert.equal(selectorRoutePolicy(undefined), undefined)
  assert.equal(selectorRoutePolicy(null), undefined)
  assert.equal(selectorRoutePolicy({}), undefined)
  assert.deepEqual(selectorRoutePolicy({ dsh: ['native'], default: ['native', 'acp'] }), { dsh: ['native'], default: ['native', 'acp'] })
  // A repeated route is one route; an empty list hides every route for that type.
  assert.deepEqual(selectorRoutePolicy({ genie: ['native', 'native'] }), { genie: ['native'] })
  assert.deepEqual(selectorRoutePolicy({ default: [] }), { default: [] })
  // Any kind name is accepted: #1007's rules fill the map, the selector does not name the kinds.
  assert.deepEqual(selectorRoutePolicy({ automagik: ['native', 'acp'], omni: ['native'], unfold: ['native'] }),
    { automagik: ['native', 'acp'], omni: ['native'], unfold: ['native'] })
  assert.throws(() => selectorRoutePolicy({ dsh: ['native', 'terminal'] }), /unknown route/)
  assert.throws(() => selectorRoutePolicy({ dsh: 'native' }), /must be a list/)
  assert.throws(() => selectorRoutePolicy([]), /must be an object/)
})


test('a legacy herdr policy drops only herdr and warns instead of throwing', () => {
  const warnings = []
  const result = selectorRoutePolicy({ default: ['native', 'herdr', 'acp'], genie: ['herdr'] }, warning => warnings.push(warning))
  assert.deepEqual(result, { default: ['native', 'acp'], genie: [] })
  assert.equal(warnings.length, 2, 'each legacy policy entry must warn')
  assert.match(warnings[0], /default.*herdr.*no longer.*ignored/)
  assert.match(warnings[1], /genie.*herdr/)
})
