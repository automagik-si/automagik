import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { approvalPolicyOf } from './approval-policy.js'

export { approvalPolicyOf }

export const NOBODY_ASKED = 'nobody was asked: approval prompts are off in this conversation (a subagent, or Full access)'

export function rewordRefusal(exec, result, content, decided) {
  if (result.isError !== true || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return undefined
  const { text } = content[0]
  const name = exec.name
  let rewritten
  if (result.error?.info?.code === 'AUTO_REVIEW_DENIED' && text === `Error: Auto review rejected tool "${name}"; its body was not executed`) {
    const reason = String(result.error.info.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
    rewritten = `Error: Auto review refused tool "${name}" and nobody was asked, because approval prompts are off in this conversation; its body was not executed.` + (reason ? ` The reviewer's reason: ${reason}` : '')
  } else if (decided?.outcome === 'rejected' && decided.policy === 'never') {
    const escalation = /^Error: the user rejected escalating this (command|operation|program) to "([^"]+)"; it stays denied, so stop and explain instead of working around it$/.exec(text)
    if (text === `Error: the user rejected tool "${name}"`) rewritten = `Error: tool "${name}" did not run, and ${NOBODY_ASKED}.`
    else if (escalation) rewritten = `Error: escalating this ${escalation[1]} to "${escalation[2]}" was refused, and ${NOBODY_ASKED}. It stays denied, so stop and explain instead of working around it.`
  } else if (decided?.outcome === 'unavailable') {
    const escalation = /^Error: sandbox escalation to "([^"]+)" requires approval, but no approval channel is available$/.exec(text)
    if (text === `Error: tool "${name}" requires approval, but no approval channel is available`) rewritten = `Error: tool "${name}" needed the person's approval, but nobody could answer here, so it did not run.`
    else if (escalation) rewritten = `Error: escalating to "${escalation[1]}" needed the person's approval, but nobody could answer here, so the call did not run.`
  }
  return rewritten === undefined ? undefined : [{ type: 'text', text: rewritten }]
}

const guarded = why => why === 'guard' || why === 'guard-request'

export function childRefusalNote(childId, { items, more }, parentPolicy) {
  const n = items.length + more
  const list = items.map(({ tool, why, reason }) => {
    const explanation = why === 'never' ? 'approval prompts are off there'
      : why === 'unavailable' ? 'nobody could answer its approval request'
        : why === 'review' ? 'Auto review refused it' + (reason ? `: ${reason}` : '')
          : guarded(why) ? 'the review guard holds work until the reviewer answers the plan'
            : 'the sandbox blocked it and it could not ask to widen it'
    return `${tool || 'a tool call'} (${explanation})`
  }).join('; ')
  // A step the review guard held is held in this conversation too: never "do it yourself" (H6-8).
  const tail = items.some(({ why }) => guarded(why)) ? 'Send the plan to your reviewer with message_bot and wait for its verdict; until then work steps are refused here too.'
    : parentPolicy === 'ask' ? 'If a step is still needed, you can do it yourself in this conversation, where approval prompts are on and its own permission level applies.'
      : parentPolicy === 'never' ? 'Approval prompts are off in this conversation too, so a step that needs approval is refused here as well: say in your reply which steps did not run.'
        : 'Say in your reply which steps did not run.'
  const text = `Subagent ${childId} was refused ${n === 1 ? 'a step' : `${n} steps`} without anyone being asked: ${list}${more ? `; and ${more} more` : ''}. ${tail}`
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'permission-refusals', form: 'notice', summary: boundContextSummary(`Subagent ${childId}: ${n} step(s) refused without asking anyone`) },
  })
}

export function install(rt) {
  const { ctx } = rt
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (result.isError !== true || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      const sessionId = exec.agent?.id ?? exec.agent?.session?.id
      const content = rewordRefusal(exec, result, decision.content ?? result.content, rt.decidedOf?.(sessionId, exec.callId))
      if (content !== undefined && rt.teamOwnerOf?.(sessionId, exec.agent) !== undefined) return { ...decision, content }
    } catch {}
    return decision
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter') return decision
      const notes = []
      for (const message of payload.messages) {
        const { source } = message
        if (source?.kind !== 'subagent-settled' || typeof source.senderSessionId !== 'string') continue
        const id = source.senderSessionId
        const record = rt.takeUnasked?.(id)
        if (record) notes.push(childRefusalNote(id, record, approvalPolicyOf(ctx.get?.('approval'), payload.agent?.session)))
      }
      if (notes.length) return { ...decision, messages: [...decision.messages, ...notes] }
    } catch {}
    return decision
  })
}
