import assert from 'node:assert/strict'
import { test } from 'node:test'
import { goalProvider } from '../src/host/goal-skills.js'

test('the goal provider lists and loads goal-grill', async () => {
  const provider = goalProvider()
  const candidates = await provider.list()
  assert.equal(candidates.length, 1)
  const [candidate] = candidates
  assert.equal(candidate.name, 'goal-grill')
  assert.equal(provider.name, candidate.provider)
  assert.equal(candidate.provider, 'automagik-bots-goal')
  assert.ok((await provider.get(candidate)).content.trim())
})
