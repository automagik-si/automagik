import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Context, symbols } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { isBotId } from '../shared/registry.js'
import { commandCapableAgent } from '../shared/routes.js'
import { BOT_SHELL, createBotShell, shellRequest } from './bot-shell.js'
import { resolveBotSession } from './bot-sessions.js'
import { SOURCE_KIND } from './constants.js'
import { botPrincipalOf, currentSession, scopeSessions, scopeWith, sessionScope } from './member-wall/principals.js'
import { multiuserMode } from './multiuser.js'
import { isEnforcingMemberWall, wallFileSystemOf } from './read-scope-provider.js'
import { inspect } from './runner-client.js'
import { reachesShell, shellCall } from './tool-deny.js'
import { attestToolRegistration, isTrustedToolRegistration } from './tool-registrations.js'

import { NO_BOT_RUNNER, NO_BOT_RUNNER_REASON as reason } from './no-runner.js'

export { NO_BOT_RUNNER }

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'apply_patch'])
const TEAM_TOOLS = new Set([
  'list_bots', 'message_bot', 'post_to_group', 'group_relay', 'read_own_chat', 'read_group_chat',
  'remember', 'forget', 'recall',
])

const readiness = () => inspect({ maxAgeMs: 250 })

export function botRunnerReady() {
  return readiness().ok
}

export const noBotRunner = (detail = '') => new LlmError(reason + detail, NO_BOT_RUNNER)

// A Bot can also open a relay step in the group's shared Session. Its persisted
// source names the sender, so that step does not inherit the group's person scope.
export const isBotGroupPost = (rt, message) => message?.role === 'user'
  && message.source?.kind === SOURCE_KIND && message.source.role === 'post'
  && rt.botRunnerRequired?.(message.source.senderSessionId) === true

export function install(rt) {
  if (!multiuserMode()) return
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
function gateToolViews(tools, restricted, allowed, trustedPlanTools, botShell, shellDispatch) {
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
    if (scope?.session === undefined) return result
    const needsRunner = restricted(scope)
    for (const [name, definition] of result.visible) {
      if (!needsRunner && definition !== botShell) continue
      if (isTrustedToolRegistration(result.registrations.get(name)) && allowed(name, definition, scope)) continue
      result.visible.delete(name)
      result.registrations.delete(name)
    }
    return result
  })
  const stopExecutable = wrapMethod(tools, 'executable', executable => function (name, agent, toolSet) {
    const definition = executable.call(this, name, agent, toolSet)
    if (!restricted(agent) && definition !== botShell) return definition
    const registration = this.view(agent).registrations.get(name)
    if (registration?.definition === definition && isTrustedToolRegistration(registration) && allowed(name, definition, agent)) return definition
    if (name === BOT_SHELL && shellDispatch.getStore()?.agent === agent && agent !== undefined) throw noBotRunner()
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
  const shellAdmissions = new WeakMap()
  const shellDispatch = new AsyncLocalStorage()
  const restricted = (agent, sessionId = sessionIdOf(agent) ?? currentSession()) => shellDispatch.getStore() !== undefined
    || rt.botRunnerRequired(sessionId, agent)
    || relayTurns.has(agent?.session)
    || scopeSessions().some(id => rt.botRunnerRequired(id, agent))

  // A relay or nested call keeps all of its earlier scopes. Each must still
  // prove the same Bot against the live registry and adapter's principal record.
  function shellBinding(agent) {
    const session = agent?.session
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || (agent.id !== undefined && agent.id !== sessionId) || relayTurns.has(session)) return
    const botId = resolveBotSession(rt, sessionId, agent)
    if (!isBotId(botId)) return
    const bot = rt.botOf(botId)
    if (bot?.id !== botId || bot.sessionPinned === true || bot.shell === false || bot.shellHeld !== undefined
      || bot.denyTools?.includes(BOT_SHELL) || bot.denyTools?.includes('bash')) return
    const record = ctx.get?.('automagikPrincipalRecord')
    const instance = process.env.AUTOMAGIK_INSTANCE_ID
    if (!instance?.trim() || record?.version !== 1 || record.instance !== instance
      || typeof record.file !== 'string' || typeof record.folder !== 'string') return
    const sessions = [...new Set([sessionId, ...scopeSessions()])]
    const expected = sessionScope.getStore()?.bots
    for (const id of sessions) {
      if (expected?.has(id) && expected.get(id) !== botId) return
      const principal = botPrincipalOf(record.file, id, {
        botOf: () => resolveBotSession(rt, id, agent), folderIdentity: record.folder, instance,
      })
      if (principal.kind !== 'bot' || principal.id !== botId) return
    }
    return Object.freeze({ botId, session, sessions: Object.freeze(sessions) })
  }

  function shellCallBinding(exec, definition) {
    const config = readiness()
    if (definition !== botShell || exec.parent !== undefined || !config.ok) throw noBotRunner()
    const registration = tools?.view(exec.agent).registrations.get(BOT_SHELL)
    if (registration?.definition !== botShell || !isTrustedToolRegistration(registration)) throw noBotRunner()
    const binding = shellBinding(exec.agent)
    if (binding === undefined) throw noBotRunner(' (no effective Bot command principal)')
    const mode = shellMode(binding)
    const request = shellRequest(config, binding.botId, exec.arguments, mode, noBotRunner)
    return { binding, registration, request }
  }

  function shellMode({ session, sessions }) {
    try {
      const policy = ctx.get?.('sandboxPolicy')
      for (const id of sessions) {
        const scoped = ctx.sessions?.get(id)
        if (scoped?.id !== id || (id === session.id && scoped !== session)) return
        const mode = policy?.resolve({ session: scoped })?.mode
        if (mode !== 'workspace-write') return mode
      }
      return 'workspace-write'
    } catch {
      // Missing or unreadable policy cannot grant workspace-write.
    }
  }

  function checkShellDispatch(exec) {
    const admission = shellAdmissions.get(exec)
    if (admission === undefined || admission.agent !== exec.agent || admission.args !== exec.arguments) throw noBotRunner()
    const current = shellCallBinding(exec, ctx.tools.get(exec.name, exec.agent, exec.toolSet))
    const { botId, session, sessions } = admission.binding
    if (current.registration !== admission.registration || current.binding.botId !== botId || current.binding.session !== session
      || current.binding.sessions.length !== sessions.length || !sessions.every(id => current.binding.sessions.includes(id))
      || current.request.cwd !== admission.request.cwd) throw noBotRunner(' (Bot command binding changed)')
    return current
  }

  // The DSH execution object survives approval, async wrappers and the runner
  // proof exchange. Keep its admission through the final check before writing.
  const botShell = createBotShell((args, exec) => {
    if (shellDispatch.getStore() !== exec || args !== exec.arguments) throw noBotRunner()
    const { request, binding } = checkShellDispatch(exec)
    return {
      ...request,
      beforeWrite() {
        try {
          checkShellDispatch(exec)
          if (binding.sessions.some(id => rt.levelHeldFor(id))) throw noBotRunner(' (a bound session is held)')
        } finally { shellAdmissions.delete(exec) }
      },
    }
  })
  rt.teamTools.push(botShell)
  const allowed = (name, definition, agent) => {
    if (definition === undefined) return false
    if (definition === botShell) return name === BOT_SHELL && botRunnerReady() && shellBinding(agent) !== undefined
    const attested = FILE_TOOLS.has(name) ? wallFileSystemOf(definition) !== undefined
      : TEAM_TOOLS.has(name) ? team.get(name) === definition : trustedPlanTools.has(definition)
    return attested && definition.name === name && !reachesShell(name, definition)
  }
  const events = ctx.events?.[symbols.original]
  const tools = ctx.tools[symbols.original]
  const stopViews = tools === undefined ? undefined : gateToolViews(tools, restricted, allowed, trustedPlanTools, botShell, shellDispatch)
  const stopTitles = gateTitleProvider(rt)
  const stopRecorder = events === undefined ? undefined : gateWorkspaceChanges(events, session => {
    const agent = ctx.get?.('agents')?.get(session.id)
    if (restricted(agent, session.id)) return true
    if (!rt.roomOwners.has(session.id)) return false
    return isBotGroupPost(rt, agent?.inbox?.nextTurn[0]) || agent?.inbox?.nextStep.some(message => isBotGroupPost(rt, message))
  })
  function admitTool(exec, next, preparing = false) {
    const { name, agent, toolSet } = exec
    if (!restricted(agent) && !shellAdmissions.has(exec)) return next()
    const sessionId = sessionIdOf(agent) ?? currentSession()
    const file = FILE_TOOLS.has(name)
    if (file && (sessionId === undefined || relayTurns.has(agent?.session) || !isEnforcingMemberWall(ctx.get?.('fs')))) {
      throw noBotRunner(' (no member wall for this call)')
    }
    const definition = ctx.tools.get?.(name, agent, toolSet)
    if (name === BOT_SHELL) {
      if (preparing && !shellAdmissions.has(exec)) {
        const admission = shellCallBinding(exec, definition)
        shellAdmissions.set(exec, { ...admission, agent, args: exec.arguments })
        return next()
      }
      const { binding } = checkShellDispatch(exec)
      return preparing ? next() : shellDispatch.run(exec, () => sessionScope.run(scopeWith(sessionId, binding.botId), next))
    }
    const wall = file ? wallFileSystemOf(definition) : undefined
    if (!allowed(name, definition, agent) || (tools !== undefined && !isTrustedToolRegistration(tools.view(agent).registrations.get(name)))
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
  const prepareTool = (exec, next) => admitTool(exec, next, true)
  const stopToolEntry = events === undefined ? undefined : wrapMethod(events, 'waterfall', waterfall => function (...args) {
    const index = typeof args[0] === 'object' || typeof args[0] === 'function' ? 1 : 0
    if (args[index] !== 'tools/pre-execute') return waterfall.apply(this, args)
    return prepareTool(args[index + 1], () => waterfall.apply(this, args))
  })
  const ahead = { prepend: true }
  const claim = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (rt.roomOwners.has(sessionIdOf(agent)) && isBotGroupPost(rt, message)) relayTurns.add(agent.session)
  }, ahead)
  const end = ctx.on('session/event', (session, event) => {
    if (event?.type === 'turn/end') relayTurns.delete(session)
  }, ahead)
  const preExecute = ctx.on('tools/pre-execute', prepareTool, ahead)
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
