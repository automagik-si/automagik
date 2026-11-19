import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as upstreamOffice from '@deepseek-ai/dsh-skill-office'
import { install as installGoalSkills } from '../src/host/goal-skills.js'
import { install as installOfficeSkills } from '../src/host/office-skills.js'

test('the Bot team skills resolve by name alongside upstream Office skills', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(upstreamOffice, { pythonEnvironment: 'user' })
  assert.equal((await ctx.skills.get('office'))?.provider, 'dsh-office')

  installOfficeSkills({ ctx })
  installGoalSkills({ ctx })
  await new Promise(resolve => setTimeout(resolve, 0))

  // The registry checks each candidate's provider against the registered name.
  assert.equal((await ctx.skills.get('office'))?.provider, 'automagik-bots-office')
  assert.equal((await ctx.skills.get('office-tools'))?.provider, 'automagik-bots-office')
  assert.equal((await ctx.skills.get('goal-grill'))?.provider, 'automagik-bots-goal')
  assert.equal((await ctx.skills.get('office-docx'))?.provider, 'dsh-office')
})
