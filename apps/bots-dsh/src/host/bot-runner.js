import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Context, symbols } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { commandCapableAgent } from '../shared/routes.js'
import { resolveBotSession } from './bot-sessions.js'
import { SOURCE_KIND } from './constants.js'
import { currentSession, scopeSessions, scopeWith, sessionScope } from './member-wall/principals.js'
import { multiuserMode } from './multiuser.js'
import { isEnforcingMemberWall, wallFileSystemOf } from './read-scope-provider.js'
import { reachesShell, shellCall } from './tool-deny.js'
import { attestToolRegistration, isTrustedToolRegistration } from './tool-registrations.js'

import { NO_BOT_RUNNER, NO_BOT_RUNNER_REASON as reason } from './no-runner.js'

export { NO_BOT_RUNNER }

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch'])
const TEAM_TOOLS = new Set([
  'list_bots', 'message_bot', 'post_to_group', 'group_relay', 'read_own_chat', 'read_group_chat',
  'remember', 'forget', 'recall',
])

export function botRunnerReady() {
  return false
}

export const noBotRunner = (detail = '') => new LlmError(reason + detail, NO_BOT_RUNNER)

// A Bot can also open a relay step in the group's shared Session. Its persisted
// source names the sender, so that step does not inherit the group's person scope.
export const isBotGroupPost = (rt, message) => message?.role === 'user'
  && message.source?.kind === SOURCE_KIND && message.source.role === 'post'
  && rt.botRunnerRequired?.(message.source.senderSessionId) === true

export function install(rt) {
  if (!multiuserMode() || botRunnerReady() !== false) return
  rt.botRunnerRequired = (sessionId, agent) => resolveBotSession(rt, sessionId, agent) !== null
  rt.assertBotRunnerProvider = (provider, sessionId, agent) => {
    if (commandCapableAgent(provider) && rt.botRunnerRequired(sessionId, agent)) throw noBotRunner()
  }
}

const sessionIdOf = agent => agent?.session?.id ?? agent?.id
const require = createRequire(import.meta.url)

function optionalPlugin(name, entry) {
  try { return require(fileURLToPath(import.meta.resolve(name)))[entry] } catch { return undefined }
}

function wrapMethod(target, name, wrap) {
  const own = Object.getOwnPropertyDescriptor(target, name)
  const replacement = wrap(target[name])
  Object.defineProperty(target, name, { configurable: true, writable: true, value: replacement })
  return () => {
    if (target[name] !== replacement) return
    if (own === undefined) delete target[name]
    else Object.defineProperty(target, name, own)
  }
}

// The pinned recorder has no per-Session Git policy. At observer selection,
// keep its turn/start listener off restricted turns, before it creates a
// recorder or obtains a Git runner. Keep publishing the actual turn event.
function gateWorkspaceChanges(events, restricted) {
  return wrapMethod(events, 'dispatch', dispatch => function (mode, args) {
    const [target, name, session, event] = args
    if (name !== 'session/event' || event?.type !== 'turn/start' || !restricted(session)) {
      return dispatch.call(this, mode, args)
    }
    const filter = target[Context.filter]
    const scoped = {
      [Context.filter](listener) {
        return listener.fiber.runtime?.name !== 'workspace-changes' && (filter === undefined || filter.call(target, listener))
      },
    }
    return dispatch.call(this, mode, [scoped, ...args.slice(1)])
  })
}

function gateTitleProvider(rt) {
  const title = rt.ctx.sessionTitle?.[symbols.original]
  const llm = rt.ctx.llm?.[symbols.original]
  if (typeof title?.runProvider !== 'function' || typeof llm?.prepareCall !== 'function') return
  // The pinned title service hands the Session to both automatic and explicit
  // generation. Its LLM helper chooses any configured override inside that call.
  const titleSession = new AsyncLocalStorage()
  const stopTitle = wrapMethod(title, 'runProvider', run => function (session, ...args) {
    return titleSession.run(session, () => run.call(this, session, ...args))
  })
  const stopPrepare = wrapMethod(llm, 'prepareCall', prepare => function (config, ...args) {
    const session = titleSession.getStore()
    if (session !== undefined) rt.assertBotRunnerProvider(config?.provider, session.id)
    return prepare.call(this, config, ...args)
  })
  return () => { stopPrepare(); stopTitle() }
}

// ToolsService in DSH 0.2.2-rc.2 has no definition predicate. Filter its
// derived view, including registrations local to an Agent. Both resolve()
// and its retained step view consult this method, so a scope change cannot
// restore a denied definition or expose its callbacks to the pipeline.
function gateToolViews(tools, restricted, allowed, trustedPlanTools) {
  if (typeof tools.view !== 'function') throw new Error('ds-bot: cannot install the Bot runner policy on this DSH tool registry')
  const todo = optionalPlugin('@deepseek-ai/dsh-tool-todo', 'apply')
  const plan = optionalPlugin('@deepseek-ai/dsh-plan-mode', 'default')
  const stopRegister = wrapMethod(tools, 'register', register => function (definition, options) {
    const plugin = this.ctx.fiber.runtime?.callback
    const dispose = register.call(this, definition, options)
    if (plugin !== undefined && ((definition.name === 'todo_write' && plugin === todo)
      || (definition.name === 'exit_plan_mode' && plugin === plan))) {
      attestToolRegistration(this, definition)
      trustedPlanTools.add(definition)
    }
    return dispose
  })
  const stopView = wrapMethod(tools, 'view', view => function (scope) {
    const result = view.call(this, scope)
    if (scope?.session === undefined || !restricted(scope)) return result
    for (const [name, definition] of result.visible) {
      if (isTrustedToolRegistration(result.registrations.get(name)) && allowed(name, definition)) continue
      result.visible.delete(name)
      result.registrations.delete(name)
    }
    return result
  })
  const stopExecutable = wrapMethod(tools, 'executable', executable => function (name, agent, toolSet) {
    const definition = executable.call(this, name, agent, toolSet)
    if (!restricted(agent)) return definition
    return allowed(name, definition) && isTrustedToolRegistration(this.view(agent).registrations.get(name)) ? definition : undefined
  })
  return () => { stopExecutable(); stopView(); stopRegister() }
}

export function installAhead(rt) {
  if (rt.botRunnerRequired === undefined) return
  const { ctx } = rt
  const trustedPlanTools = new WeakSet()
  // Keep the shipped definitions, so another scoped tool cannot take a messaging or
  // memory tool's name. File, todo and plan registrations are attested at source.
  const team = new Map()
  for (const tool of rt.teamTools) {
    if (TEAM_TOOLS.has(tool.name) && !team.has(tool.name)) team.set(tool.name, tool)
  }
  const relayTurns = new WeakSet()
  const restricted = (agent, sessionId = sessionIdOf(agent) ?? currentSession()) => rt.botRunnerRequired(sessionId, agent)
    || relayTurns.has(agent?.session)
    || scopeSessions().some(id => rt.botRunnerRequired(id, agent))
  const allowed = (name, definition, hasWall = wallFileSystemOf(definition) !== undefined) => {
    if (definition === undefined) return false
    const attested = FILE_TOOLS.has(name) ? hasWall
      : TEAM_TOOLS.has(name) ? team.get(name) === definition : trustedPlanTools.has(definition)
    return attested && definition.name === name && !reachesShell(name, definition)
  }
  const events = ctx.events?.[symbols.original]
  const tools = ctx.tools[symbols.original]
  const stopViews = tools === undefined ? undefined : gateToolViews(tools, restricted, allowed, trustedPlanTools)
  const stopTitles = gateTitleProvider(rt)
  const stopRecorder = events === undefined ? undefined : gateWorkspaceChanges(events, session => {
    const agent = ctx.get?.('agents')?.get(session.id)
    if (restricted(agent, session.id)) return true
    if (!rt.roomOwners.has(session.id)) return false
    return isBotGroupPost(rt, agent?.inbox?.nextTurn[0]) || agent?.inbox?.nextStep.some(message => isBotGroupPost(rt, message))
  })
  function admitTool(exec, next) {
    const { name, agent, toolSet } = exec
    if (!restricted(agent)) return next()
    const sessionId = sessionIdOf(agent) ?? currentSession()
    const file = FILE_TOOLS.has(name)
    if (file && (sessionId === undefined || relayTurns.has(agent?.session) || !isEnforcingMemberWall(ctx.get?.('fs')))) {
      throw noBotRunner(' (no member wall for this call)')
    }
    const definition = ctx.tools.get?.(name, agent, toolSet)
    const wall = file ? wallFileSystemOf(definition) : undefined
    if (!allowed(name, definition, wall !== undefined) || (tools !== undefined && !isTrustedToolRegistration(tools.view(agent).registrations.get(name)))
      || shellCall(name, exec.arguments, definition) || reachesShell(name, exec.schema)
      || reachesShell(name, { parameters: { properties: exec.arguments } })) throw noBotRunner()
    if (!file) return next()
    const botId = resolveBotSession(rt, sessionId, agent)
    const [principal] = wall.principals([sessionId])
    if (typeof botId !== 'string' || principal.kind !== 'bot' || principal.id !== botId) {
      throw noBotRunner(' (no effective Bot file principal)')
    }
    return sessionScope.run(scopeWith(sessionId, botId), next)
  }
  // The pinned pipeline sends even missing definitions to pre-execute, and its
  // public guard runs after policy and approval. Check before Cordis enumerates
  // the waterfall listeners, regardless of which plugin prepended last.
  const stopToolEntry = events === undefined ? undefined : wrapMethod(events, 'waterfall', waterfall => function (...args) {
    const index = typeof args[0] === 'object' || typeof args[0] === 'function' ? 1 : 0
    if (args[index] !== 'tools/pre-execute') return waterfall.apply(this, args)
    return admitTool(args[index + 1], () => waterfall.apply(this, args))
  })
  const ahead = { prepend: true }
  const claim = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (rt.roomOwners.has(sessionIdOf(agent)) && isBotGroupPost(rt, message)) relayTurns.add(agent.session)
  }, ahead)
  const end = ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') relayTurns.delete(session)
  }, ahead)
  const preExecute = ctx.on('tools/pre-execute', admitTool, ahead)
  const execute = ctx.on('tools/execute', admitTool, ahead)
  // DSH resolves exact model metadata before its stream waterfall. Check the model
  // selection frozen for this step before the Bot's own pre-step work or DSH's lookup.
  const preStep = ctx.on('agent/pre-step', ({ agent, modelSelection, messages }, next) => {
    const sessionId = sessionIdOf(agent)
    const provider = modelSelection?.provider
    rt.assertBotRunnerProvider(provider, sessionId, agent)
    if (commandCapableAgent(provider) && rt.roomOwners.has(sessionId)
      && (relayTurns.has(agent?.session) || messages?.some(message => isBotGroupPost(rt, message)))) throw noBotRunner()
    return next()
  }, ahead)
  const stream = ctx.on('llm/stream', (options, next) => {
    rt.assertBotRunnerProvider(options?.provider, options?.sessionId)
    return next()
  }, ahead)
  return () => {
    claim(); end(); preExecute(); execute(); preStep(); stream()
    stopToolEntry?.(); stopRecorder?.(); stopViews?.(); stopTitles?.()
  }
}
