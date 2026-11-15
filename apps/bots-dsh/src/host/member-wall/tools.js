// The member wall's tool list: a member session may call only the tools on an exact-name
// allowlist. With `members` off (the default) it does nothing.
//
// - The wall is DSH's final tool guard (`ctx.tools.guard`): it runs after every pre-execute
//   listener and has no "allow" answer, so no listener can turn its denial back. It also sees
//   the calls a code run makes inside itself. A prepended pre-execute listener denies the same
//   calls, so the wall still holds if a DSH ever stopped calling its guards.
// - Fail closed: until the guard is in place and answers for a member (no tools service, or a
//   DSH without guards), a member session's step is rejected, so it gets no tool and no turn.
// - The list is exact names, never a pattern, so a tool added later starts denied. It lives
//   in this row's config, in the owner's profile: the read fence keeps a member's writes in its
//   own area, and the tools that change settings or Bots are not on the list.
// - ACP runs are not tool calls: a member step on an `acp-*` model route is rejected, so no ACP
//   process starts for it.
// - The shell (bash, terminals, jobs, code runs) stays denied until the member runner runs a
//   member's commands under the member's own identity.
import z from '@deepseek-ai/schemastery'
import { currentSession, principalOf, sessionOfAgent } from './principals.js'

export const name = 'member-wall-tools'

export const MEMBER_TOOLS = Object.freeze([
  'read', 'read_image', 'grep', 'glob', 'write', 'edit', 'skill', 'todo_write', 'ask_user_question',
])

export const Config = z.object({
  members: z.boolean().default(false).description('Members on. Off: every session keeps its tools.'),
  principalsFile: z.string().default('').description('The principal record (mode 0600).'),
  memberTools: z.array(z.string().pattern(/^[A-Za-z0-9_-]+$/)).default([...MEMBER_TOOLS])
    .description('The only tools a member session may call: exact names.'),
})

const PROBE = Object.freeze({ callId: 'member-wall-probe', name: 'member-wall-probe', arguments: {} })

export function apply(ctx, config) {
  if (!config.members) return
  if (!config.principalsFile.startsWith('/')) throw new Error('member wall: members on needs an absolute principalsFile')
  const allowed = new Set(config.memberTools)
  const isMember = sessionId => principalOf(config.principalsFile, sessionId).kind !== 'owner'
  const sessionOf = exec => sessionOfAgent(exec.agent) ?? currentSession()
  // Calls with no session (the owner's own interface) keep their tools.
  const denial = exec => {
    const sessionId = sessionOf(exec)
    if (sessionId === undefined || allowed.has(exec.name) || !isMember(sessionId)) return undefined
    return `${exec.name} is not available in a member's session`
  }

  // Armed only once the guard is registered and answers for a member.
  let armed = false
  ctx.inject(['tools'], scope => {
    const tools = scope.tools
    if (typeof tools.guard !== 'function' || typeof tools.checkGuards !== 'function') return
    const dispose = tools.guard(exec => denial(exec))
    const probe = { ...PROBE, agent: { id: 'member-wall-probe' } }
    // An unrecorded session is a member's, and the probe's name is on no list.
    if (tools.checkGuards(probe) === undefined) {
      dispose()
      return
    }
    armed = true
    scope.effect(() => () => {
      armed = false
    }, 'member wall: tool guard')
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = denial(exec)
    return reason === undefined ? next() : { kind: 'deny', reason }
  }, { prepend: true })

  ctx.on('agent/pre-step', async (step, next) => {
    const sessionId = sessionOfAgent(step?.agent)
    if (sessionId === undefined || !isMember(sessionId)) return next()
    if (!armed) return { kind: 'reject' }
    if (String(step.modelSelection?.provider ?? '').startsWith('acp-')) return { kind: 'reject' }
    return next()
  }, { prepend: true })
}
