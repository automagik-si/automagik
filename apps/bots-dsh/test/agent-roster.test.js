import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { EMPTY_ROSTER, indexRoster, isAgentSession } from '../src/client/sources.js'
import { groupsFor } from '../src/client/surface.js'
import { DEFAULT_ROUTE_POLICY } from '../src/shared/route-policy.js'

const ROSTER_VALUE = {
  revision: 3,
  mainBotId: 'm1',
  mainBotIds: ['m1'],
  bots: [{ id: 'm1', sessionId: 'm1', name: 'Omni', parts: [] }],
  rooms: [{ id: 'g1', name: 'Group', members: ['m1'] }],
  agents: [{ id: 'a1', name: 'DSH Agent', sessions: ['s1', 's2'], createdAt: 5 }],
  exchangeTurns: {},
  questions: {},
}

test('indexRoster indexes agents by id and by Session', () => {
  const roster = indexRoster(ROSTER_VALUE)
  assert.deepEqual(roster.agents.map(agent => agent.id), ['a1'])
  assert.equal(roster.agentsById.a1.name, 'DSH Agent')
  assert.equal(roster.agentOf.s1, 'a1')
  assert.equal(roster.agentOf.s2, 'a1')
  assert.equal(roster.agentOf.m1, undefined)
  // The Agent never enters the Bot index.
  assert.equal(roster.byId.s1, undefined)
  assert.equal(roster.byId.a1, undefined)
})

test('a roster without agents still answers the index reads', () => {
  const roster = indexRoster({ ...ROSTER_VALUE, agents: undefined })
  assert.deepEqual(roster.agents, [])
  assert.deepEqual(roster.agentOf, {})
})

// The plain flag decides which groups mount: an Agent Session keeps the shell and
// withdraws only the conversation replacements.
test('isAgentSession follows the roster first, the cache before it is ready', () => {
  const roster = indexRoster(ROSTER_VALUE)
  assert.equal(isAgentSession(roster, new Set(), 's1'), true)
  assert.equal(isAgentSession(roster, new Set(), 'm1'), false)
  assert.equal(isAgentSession(roster, new Set(), 'g1'), false)
  // Not ready: the cached ids from the last pull answer.
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(['s1']), 's1'), true)
  // A ready roster wins over a stale cache.
  assert.equal(isAgentSession(roster, new Set(['m1']), 'm1'), false)
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(), ''), false)
  assert.equal(isAgentSession(EMPTY_ROSTER, new Set(), undefined), false)
})

test('adopted DSH chats keep native rendering while remaining team Bots; groups keep relay rendering', () => {
  const dsh = { id: 'adopted', sessionId: 'current', parts: ['original'], kind: 'dsh', name: 'Brain' }
  const roster = indexRoster({ ...ROSTER_VALUE, bots: [...ROSTER_VALUE.bots, dsh] })
  for (const id of ['adopted', 'current', 'original']) {
    assert.equal(roster.byId[id], dsh)
    assert.equal(isAgentSession(roster, new Set(), id), true)
    assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(roster, new Set(), id) }), { shell: true, conversation: false })
  }
  assert.equal(isAgentSession(roster, new Set(['g1']), 'g1'), false)
})

test('the New DSH bot UI requests team membership and opens the native member session', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(source, /call\('add-agent', \{ \.\.\.fields, teamMember: true \}\)/)
  assert.match(source, /agent\?\.adoptedBotId !== undefined\) actions\.openSession\(agent\.adoptedBotId\)/)
})

test('the plain flag maps to the mounted groups', () => {
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(indexRoster(ROSTER_VALUE), new Set(), 's1') }), { shell: true, conversation: false })
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(indexRoster(ROSTER_VALUE), new Set(), 'm1') }), { shell: true, conversation: true })
})

test('the default selector policy leaves the adopted DSH own chat on the native composer', () => {
  const dsh = { id: 'adopted', sessionId: 'current', kind: 'dsh', name: 'Brain' }
  const roster = indexRoster({ ...ROSTER_VALUE, bots: [...ROSTER_VALUE.bots, dsh], routePolicy: DEFAULT_ROUTE_POLICY })
  assert.deepEqual(roster.routePolicy, DEFAULT_ROUTE_POLICY)
  assert.deepEqual(groupsFor({ mode: 'bot', plain: isAgentSession(roster, new Set(), dsh.sessionId) }), {
    shell: true, conversation: false,
  })
})
