import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boundContextSummary, createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SKILL_NOTICE } from '../../src/host/skill-message.js'

export const refusedName = 'legacy-refused-fixture'
export const ordinaryText = 'Keep these exact ordinary words.'
export const rawText = `use the skill ${refusedName} ${ordinaryText}`
export const nativeText = '/help /separate-native-fixture'
export const replyText = 'The historical reply is valid context.'
export const remedy = `The skill ${refusedName} is not active on this Bot. Add it in the Bot's Details, under Skills.`

export function appendLegacyRefusal(session, route) {
  const append = row => session.append('user/message', row, { surfaceOp: 'append' })
  const turn = 1
  const step = 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  for (const text of [nativeText, rawText]) {
    append(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  // The old host logged the unmarked person input followed by a separate remedy in the same step.
  append(createUserMessage({ content: [{ type: 'text', text: remedy }],
    source: { kind: SKILL_NOTICE, form: 'notice', summary: boundContextSummary(remedy) } }))
  session.append('assistant/message', { turn, step, stream: [], message: createAssistantMessage({
    source: route, content: [{ type: 'text', text: replyText }],
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

export function saveModelInput(name, input) {
  const dir = process.env.SKILLS_EXCEPTION_TRACE_DIR
  if (dir) writeFileSync(join(dir, `${name}.json`), JSON.stringify(input, null, 2) + '\n')
}
