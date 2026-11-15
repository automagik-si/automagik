// A refusal never becomes a grant: the person only decides whether work continues.
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { hardToUndo, hardContext, refusalCounter } from './auto-judge.js'
import { TEAM_LOOKUPS, teamToolOf } from './approvals.js'
import { REMOTE_TOOL } from './remote-chat-adapter.js'

// Office operations create host-owned output files outside the shell sandbox. Read only
// declines them. User-terminal observations need Full access: they are outside the Bot
// workspace and may contain secrets.
export const OFFICE_OUTPUT_TOOLS = new Set(['office_convert', 'office_recalculate', 'office_render'])
export const USER_TERMINAL_TOOLS = new Set(['user_terminal_list', 'user_terminal_read'])
export const KEEP_WORKING = 'keep_working'
export const askText = step => `This step is hard to undo: ${step}. Allow it once?`
export const questionText = (name, count, tool) => `${name} was refused ${count} times in this turn, the last time on ${tool}. Let it keep working?`
export const stopPerson = count => `The person stopped you after ${count} refused steps in this turn. Do not try again or another way: reply with what you could not do and why.`
export const stopNever = count => `Approvals are off in this conversation, so nobody could be asked whether you may keep working after ${count} refused steps. Stop here and tell whoever gave you this work what you could not do and why.`
export const stopNobody = count => `Nobody could be asked whether you may keep working after ${count} refused steps in this turn, so you stop here. Reply with what you could not do and why.`
export const hardNever = step => `This step is hard to undo (${step}) and approvals are off in this conversation, so nobody was asked and it did not run. Do not try it another way: tell whoever gave you this work that the person must decide it.`
export const hardNobody = step => `This step is hard to undo (${step}) and nobody can be asked about it here, so it did not run. Do not try it another way: say that the person must decide it.`

const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
function stepText(exec) {
  const args = exec.arguments ?? {}
  const command = [args.command, args.cmd].find(value => typeof value === 'string' || Array.isArray(value))
  const detail = command !== undefined ? (Array.isArray(command) ? command.filter(value => typeof value === 'string').join(' ') : command)
    : teamToolOf(exec.name) === 'apply_patch' ? strings(args).flatMap(text => [...text.matchAll(/^\*\*\* Delete File: (.+)$/gm)].map(match => match[1])).join(', ')
      : args.bot ?? args.group
  const text = `${exec.name}${detail ? `: ${detail}` : ''}`.replace(/\s+/g, ' ').trim()
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}
const outerRun = exec => exec.parent === undefined && exec.name === RUN_CODE_NAME
const keyOf = (id, call) => `${id}\n${call}`
const remember = (map, key, value) => { map.set(key, value); if (map.size > 200) map.delete(map.keys().next().value) }

export function install(rt) {
  const { ctx } = rt
  const counter = refusalCounter()
  const stopped = new Map()
  const refusedHere = new WeakSet()
  const asks = new Map()
  const outcomes = new Map()
  const policyOf = session => { try { return ctx.get('approval')?.effectivePolicy?.(session) ?? 'ask' } catch { return 'ask' } }
  const fullHere = session => {
    try {
      if (ctx.get('permissionPresets')) return rt.sessionWide(session.id, session)
      return policyOf(session) === 'never' && ctx.get('sandboxPolicy')?.resolve({ session }).mode === 'danger-full-access'
    } catch { return false }
  }
  const answerable = id => rt.chatOwners.has(id) || rt.groupOwners.has(id)
    || (rt.state.tasks?.[id]?.status === 'working' && rt.botOf(rt.state.tasks[id].from) !== undefined)
  const note = (id, why, exec, text) => { try { rt.noteStop?.(id, { why, tool: exec.name, callId: exec.callId, text }, exec.agent) } catch {} }
  ctx.on('session/event', (session, event) => {
    const id = session.id
    if (id === undefined) return
    if (event.type === 'turn/start' || event.type === 'turn/end') { counter.reset(id); stopped.delete(id) }
    const data = event.data
    if (event.type === 'approval/asked' && data?.callId !== undefined && data.toolName !== KEEP_WORKING) {
      remember(asks, keyOf(id, data.id), { callId: data.callId, never: policyOf(session) === 'never' })
    } else if (event.type === 'approval/decided') {
      const key = keyOf(id, data?.id)
      const ask = asks.get(key)
      asks.delete(key)
      if (ask) remember(outcomes, keyOf(id, ask.callId), { outcome: data.outcome, never: ask.never })
    }
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    const id = session?.id ?? exec.agent?.id
    if (id === undefined) return next()
    if (stopped.has(id)) return { kind: 'deny', reason: stopped.get(id) }
    if (USER_TERMINAL_TOOLS.has(teamToolOf(exec.name)) && rt.botOfSession(id, exec.agent) && !fullHere(session)) {
      return { kind: 'deny', reason: 'Only Full access may read the user’s terminals: they are outside this Bot’s workspace and can contain secrets.' }
    }
    if (OFFICE_OUTPUT_TOOLS.has(teamToolOf(exec.name)) && rt.botOfSession(id, exec.agent)) {
      let mode
      try { mode = ctx.get('sandboxPolicy')?.resolve({ session })?.mode } catch {
        return { kind: 'deny', reason: 'The Office tool cannot run because this conversation’s filesystem permission could not be read.' }
      }
      if (mode === 'read-only') return { kind: 'deny', reason: 'Read only does not allow Office tools to create output files. Choose a permission level that allows writes before converting, rendering or recalculating a document.' }
    }
    const decision = await next()
    if (decision.kind === 'deny') { refusedHere.add(exec); return decision }
    if (decision.kind !== 'allow') return decision
    try {
      const tool = teamToolOf(exec.name)
      const pending = { tool: exec.name, args: exec.arguments }
      // Lookups read their arguments as text; they never execute the steps it describes. A mirror
      // card runs nothing here: the step ran, or runs, on the other side under its own rules
      // (the ACP agent's, Remote Hermes's), and what Hermes asks reaches the person as its own question.
      if (!exec.agent || outerRun(exec) || tool === 'acp_tool' || exec.name === REMOTE_TOOL || TEAM_LOOKUPS.has(tool)
        || !hardToUndo(pending, hardContext(rt, id, pending, session)) || !rt.botOfSession(id, exec.agent)
        || fullHere(session) || outcomes.get(keyOf(id, exec.callId))?.outcome === 'allowed-once') return decision
      const step = stepText(exec)
      const never = policyOf(session) === 'never'
      if (never || !answerable(id)) {
        const reason = (never ? hardNever : hardNobody)(step)
        refusedHere.add(exec)
        note(id, never ? 'never' : 'unavailable', exec, reason)
        return { kind: 'deny', reason }
      }
      return { kind: 'ask', reason: askText(step) }
    } catch (error) { rt.warn('ds-bot: hard step could not be checked: %s', error); return decision }
  }, { prepend: true })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const session = exec.agent?.session
    const id = session?.id ?? exec.agent?.id
    if (id === undefined) return decision
    const key = keyOf(id, exec.callId)
    const outcome = outcomes.get(key)
    outcomes.delete(key)
    try {
      if (!exec.agent || outerRun(exec) || stopped.has(id) || !rt.botOfSession(id, exec.agent)
        || fullHere(session) || rt.autoCounts?.(session) === true) return decision
      const refused = refusedHere.has(exec) || outcome?.outcome === 'unavailable'
        || (outcome?.outcome === 'rejected' && outcome.never)
        || ['AUTO_REVIEW_DENIED', 'AUTO_REVIEW_FAILED', 'FS_SANDBOX_DENIED'].includes(result.error?.info?.code)
        || result.value?.sandbox?.denied === true
      if (!refused) { counter.allowed(id); return decision }
      if (!counter.tripped(id)) { counter.refused(id); return decision }
      const count = counter.total(id) + 1
      const block = text => ({ kind: 'block', feedback: [{ type: 'text', text }] })
      const stop = (text, why) => { stopped.set(id, text); note(id, why, exec, text); return block(text) }
      if (policyOf(session) === 'never') return stop(stopNever(count), 'never')
      if (!answerable(id)) return stop(stopNobody(count), 'unavailable')
      let answer
      try {
        answer = await ctx.get('approval').request({ agent: exec.agent, toolName: KEEP_WORKING, callId: exec.callId,
          reason: questionText(rt.botOfSession(id, exec.agent).name, count, exec.name), signal: exec.signal })
      } catch { answer = 'unavailable' }
      if (answer === 'allowed-once') { counter.reset(id); return decision }
      if (answer === 'cancelled') return decision
      if (answer === 'rejected') {
        if (policyOf(session) === 'never') return stop(stopNever(count), 'never')
        const text = stopPerson(count)
        stopped.set(id, text)
        return block(text)
      }
      return stop(stopNobody(count), 'unavailable')
    } catch (error) { rt.warn('ds-bot: refusal ladder could not be checked: %s', error); return decision }
  }, { prepend: true })
}
