// In-process children ask through their Bot only where the team can show the ask.
import { answerableOwner } from './approvals.js'
import { rankOf } from './permission-rank.js'
import { detailOfArgs } from './turns.js'

export const CHILD_ASKS_CONTEXT_NAME = 'automagik-bots:subagent-asks'
export const CHILD_ASKS_CONTEXT = 'Approvals in this session: it keeps the permission level of the Bot that started it, with approval prompts on. Unlike what the delegated-subagent statement says, an operation that requires approval is not rejected automatically here: it is asked of the user through that Bot and runs only if the user allows it. If the user rejects it or the ask is cancelled, do not retry it; state the limitation in your reply so the delegating agent can handle it.'

const put = (map, key, value, max) => {
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
}
const pairKey = (sessionId, callId) => JSON.stringify([sessionId, callId])

export function install(rt) {
  const { ctx } = rt
  const switched = new Map()
  const details = new Map()
  const policyOf = session => {
    try {
      const approval = ctx.get('approval')
      return approval.overrideOf(session) ?? approval.config?.policy ?? 'ask'
    } catch { return undefined }
  }
  const levelToKeep = agent => {
    try {
      const presets = ctx.get('permissionPresets')
      const approval = ctx.get('approval')
      const sandbox = ctx.get('sandboxPolicy')
      if (!presets || !approval || !sandbox) return undefined
      const parent = ctx.sessions?.get?.(agent.session.header.parentSession)
      if (!parent || policyOf(parent) !== 'ask') return undefined
      const level = presets.current(parent)
      if (rankOf(presets, level) === undefined) return undefined
      const spec = presets.resolve(level)
      if (spec.approval !== 'ask' || spec.sandbox !== (sandbox.overrideOf(agent.session) ?? sandbox.defaultMode)) return undefined
      const current = presets.current(agent.session)
      return current === 'custom' || current === level ? level : undefined
    } catch { return undefined }
  }

  ctx.on('agent/created', async ({ agent, source } = {}) => {
    try {
      if (agent?.session?.header?.origin !== 'subagent') return
      await rt.load()
      const id = agent.id ?? agent.session.id
      const owner = rt.teamOwnerOf?.(id, agent)
      if (!answerableOwner(rt, owner)) return
      const policy = policyOf(agent.session)
      if (policy === 'ask') {
        put(switched, id, { level: ctx.get('permissionPresets')?.current(agent.session) }, 500)
        return
      }
      if (policy !== 'never' || source !== 'startup') {
        switched.delete(id)
        return
      }
      const level = levelToKeep(agent)
      if (level === undefined) return
      const sandbox = ctx.get('sandboxPolicy')
      const before = sandbox.overrideOf(agent.session)
      ctx.get('permissionPresets').set(agent.session, level)
      if (policyOf(agent.session) === 'ask' && sandbox.overrideOf(agent.session) === before) put(switched, id, { level }, 500)
      else rt.warn('ds-bot: subagent level did not keep approval and sandbox: %s', id)
    } catch (error) {
      rt.warn('ds-bot: subagent level on agent/created failed: %s', error)
    }
  })
  // Every child at `ask` whose asks approvals.js can hold, also one this instance never switched (the
  // plugin reloaded under it, or it was moved to an asking level later): its card needs the command.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'tool/call' && event?.type !== 'tool/ptc-dispatch-start') return
      if (session?.header?.origin !== 'subagent' || policyOf(session) !== 'ask') return
      const data = event.data ?? {}
      if (event.type === 'tool/call') put(details, pairKey(session.id, data.callId), detailOfArgs(String(data.arguments ?? '')), 200)
      else put(details, pairKey(session.id, data.subCallId), detailOfArgs(JSON.stringify(data.arguments ?? {})), 200)
    } catch {}
  })
  // Older snapshots may store ds-bot:subagent-asks. Session restoration does not look up providers by the stored id.
  ctx.effect(() => ctx.systemPrompt.context({
    name: CHILD_ASKS_CONTEXT_NAME,
    order: (ctx.systemPrompt.getContextOrder?.('SUBAGENT_DELEGATION') ?? 120) + 1,
    interpolate: false,
    text: context => {
      try {
        const agent = context?.agent
        const session = agent?.session
        return session?.header?.origin === 'subagent' && policyOf(session) === 'ask'
          && answerableOwner(rt, rt.teamOwnerOf?.(agent.id ?? session.id, agent)) ? CHILD_ASKS_CONTEXT : ''
      } catch { return '' }
    },
  }), 'ds-bot: subagent asks context')

  Object.assign(rt, { asksThroughBot: id => switched.has(id), childCallDetail: (sessionId, callId) => details.get(pairKey(sessionId, callId)) })
}
