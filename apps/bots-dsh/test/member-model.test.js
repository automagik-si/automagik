import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPage, botLabels, changedBot, feedEnded, initialMember, isCurrent, pageRows, requestView, selectBot, updateRoster } from '../src/client/member-model.js'
import { personLabels, personKey } from '../src/client/people-model.js'

test('MV1 newest-page replacement drops older pages and overlapping rows keep distinct keys', () => {
  const selection = selectBot(initialMember, 'b')
  const request = requestView(selection)
  const first = { items: [{ kind: 'bot', seq: 2, text: 'a' }, { kind: 'bot', seq: 2, text: 'b' }], cursor: 'older' }
  const newest = applyPage(selection, request, first, false)
  assert.equal(newest.cursor, 'older')
  const earlier = applyPage(newest, request, { items: [{ kind: 'user', seq: 2, text: 'first part' }], cursor: null }, true)
  assert.deepEqual(pageRows(earlier.pages).map(({ row, key }) => [row.text, key]), [['first part', '1:0'], ['a', '0:0'], ['b', '0:1']])
  assert.deepEqual(applyPage(earlier, request, first, false).pages, [first.items])
})

test('MV2 feed end drops all pages, raises the generation and refuses late data', () => {
  const selection = selectBot(initialMember, 'b')
  const request = requestView(selection)
  const p = { items: [{ kind: 'user' }], cursor: 'cursor' }
  const filled = applyPage(applyPage(selection, request, p, false), request, p, true)
  const cleared = feedEnded(filled)
  assert.deepEqual(cleared.pages, [])
  assert.equal(cleared.cursor, null)
  assert.equal(cleared.generation, filled.generation + 1)
  assert.equal(applyPage(cleared, request, p, true), cleared)
})

test('MV3 unrelated and stale signals and pages are dropped, and roster withdrawal clears selection', () => {
  const roster = updateRoster(initialMember, [{ id: 'a' }, { id: 'b' }])
  assert.equal(roster.botId, 'a')
  const request = requestView(roster)
  const selected = selectBot(roster, 'b')
  assert.equal(isCurrent(selected, request), false)
  assert.equal(changedBot(selected, request, 'b'), false)
  assert.equal(changedBot(selected, requestView(selected), 'a'), false)
  assert.equal(changedBot(selected, requestView(selected), 'b'), true)
  const withdrawn = updateRoster(selected, [{ id: 'a' }])
  assert.equal(withdrawn.botId, null)
  assert.equal(withdrawn.withdrawn, true)
  assert.deepEqual(withdrawn.pages, [])
})

test('MV4 duplicate Bot and person labels have visible disambiguators', () => {
  assert.deepEqual([...botLabels([{ id: 'a', name: 'Bot' }, { id: 'b', name: 'Bot' }, { id: 'c', name: 'Chief' }]).values()],
    ['Bot · a', 'Bot · b', 'Chief'])
  const people = ['long-subject-00001', 'long-subject-00002'].map(subject => ({ issuer: 'https://id.invalid', subject }))
  const labels = personLabels(people)
  for (const person of people) assert.equal(labels.get(personKey(person)), 'id.invalid · ' + person.subject)
})
