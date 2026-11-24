import { defineTool, parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { packageAttachment, rolesOn, sameRolePin } from '../shared/roles.js'
import { SOLVER_ROLE_ID, solverReviewPart } from '../shared/solver-method.js'
import { routeOf } from '../shared/routes.js'
import { createRoleSettings } from './role-settings.js'
import { createRoleVoice } from './role-voice.js'
import { NO_BOT_RUNNER_REASON } from './no-runner.js'
import { refusal } from './refusal.js'
import { output } from './tools.js'

const START_MS = 5_000
const inactive = "This Bot's role changed. Try again."
const cancelled = 'Voice / Mouth speech was cancelled.'
const acpWarning = 'ACP coding agents do not receive this role’s prompt.'
const hermesWarning = "This model uses its Hermes profile's own instructions."
const routeUnavailable = 'Model selection is unavailable.'
const promptOnly = manifest => manifest.tools.length === 0 && manifest.settings.length === 0
const validSpeech = text => typeof text === 'string' && text.length <= 2000 && Boolean(text.trim())

function boundedStart(start) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(refusal('Role runtime setup timed out.')), START_MS)
  })
  return Promise.race([Promise.resolve().then(start), deadline]).finally(() => clearTimeout(timer))
}

export function createRoleRuntime(rt, packages, { fs } = {}) {
  const { ctx, state } = rt
  const voice = createRoleVoice(rt)
  const settings = createRoleSettings(rt.home, fs)
  const pins = new WeakMap()
  const installedModules = new Map()
  const attachments = new Map()
  const turnPrompts = new Map()
  let disposed = false
  let warnedRunner = false

  const owner = sessionId => rt.roomOwners?.has(sessionId) || rt.taskOwners?.has(sessionId) ? undefined
    : rt.chatOwners?.get(sessionId) ?? rt.groupOwners?.get(sessionId)?.botId
  const promptOwner = sessionId => rt.roomOwners?.has(sessionId) ? undefined : rt.selfOf?.(sessionId)
  const ownBot = id => rt.own?.(state.bots, id)
  const enabled = () => !disposed && rolesOn(state.prefs) && rt.readOnly?.() === undefined && rt.holdsLock?.() === true
  const current = (id, held) => enabled() && attachments.get(id) === held && ownBot(id) === held.bot
    && sameRolePin(packageAttachment(held.bot), held.pin) && packages.recordOf(held.pin.id) === held.record
    && !packages.damaged(held.record)
  const active = id => {
    const held = attachments.get(id)
    return held?.runtime && current(id, held) ? held : undefined
  }
  const granted = (held, capability) => current(held.bot.id, held)
    && held.runtime.manifest.capabilities.includes(capability) && held.bot.roles[0].grants.includes(capability)

  async function moduleFor(details, sha256) {
    const { manifest, entryBytes } = details
    if (promptOnly(manifest)) return undefined
    const key = `${manifest.id}@${manifest.version}:${sha256.toLowerCase()}`
    if (!installedModules.has(key)) {
      const url = `data:text/javascript;base64,${entryBytes.toString('base64')}#${key}`
      installedModules.set(key, boundedStart(() => import(url)))
    }
    return installedModules.get(key)
  }

  async function stage(details, sha256) {
    const module = await moduleFor(details, sha256)
    if (typeof module?.install !== 'function') return undefined
    const declarations = new Map(details.manifest.tools.map(tool => {
      const bounds = new Map()
      const parameters = Object.fromEntries(Object.entries(tool.parameters).map(([key, parameter]) => {
        const { maxLength, ...schema } = parameter
        // DSH's parameter compiler does not expose maxLength. Enforce the
        // package's length bound inside the real executor after type validation.
        if (maxLength !== undefined) {
          if (schema.type !== 'string' || !Number.isSafeInteger(maxLength) || maxLength < 1) {
            throw refusal('Invalid role manifest (tools).')
          }
          bounds.set(key, maxLength)
        }
        return [key, schema]
      }))
      parameterSchemaSpecToJsonSchema(parameters)
      return [tool.name, { definition: { name: tool.name, description: tool.description, parameters }, bounds }]
    }))
    const handlers = new Map()
    let accepting = true
    let invalid
    const api = Object.freeze({
      registerTool(name, handler) {
        if (!accepting) throw refusal('Role tool registration is closed.')
        if (!declarations.has(name) || name === 'run_code' || typeof handler !== 'function' || handlers.has(name)
          || rt.teamTools?.some(tool => tool.name === name) || rt.localAgentTools?.some(tool => tool.name === name)
          || ctx?.tools?.view?.()?.knownNames?.has(name) || ctx?.tools?.get?.(name) || rt.packageToolCollision?.(name)) {
          invalid = refusal('The role registered an undeclared or conflicting tool.')
          throw invalid
        }
        handlers.set(name, handler)
      },
    })
    let dispose
    const clean = () => {
      try {
        if (typeof dispose === 'function') void Promise.resolve(dispose()).catch(() => {})
      } catch { rt.warn?.('Role runtime cleanup failed.') }
    }
    try {
      await boundedStart(async () => {
        dispose = await module.install(api)
        if (!accepting) clean()
      })
      if (invalid || handlers.size !== declarations.size) throw invalid ?? refusal('The role did not register its declared tools.')
      return { ...details, tools: [...declarations].map(([name, declaration]) => ({
        ...declaration, handler: handlers.get(name),
      })), dispose: clean }
    } catch (error) {
      clean()
      throw error
    } finally {
      accepting = false
    }
  }

  async function load(held) {
    const { pin, record } = held
    try {
      let proof = pins.get(record)
      if (!proof) {
        proof = packages.authenticate(pin.id, record)
        pins.set(record, proof)
      }
      const details = await proof
      if (!current(held.bot.id, held)) return
      if (promptOnly(details.manifest)) {
        held.manifest = details.manifest
        held.runtime = Object.freeze({ manifest: details.manifest, prompt: details.prompt, tools: [], dispose() {} })
        return
      }
      if (rt.botRunnerRequired !== undefined) {
        held.manifest = details.manifest
        return
      }
      const runtime = await stage(details, record.sha256)
      if (!runtime) return
      if (!current(held.bot.id, held)) { runtime.dispose(); return }
      held.runtime = runtime
      held.manifest = runtime.manifest
      rt.syncScopedTools?.()
    } catch (error) {
      if (current(held.bot.id, held)) {
        const reason = error?.code === 'bot/refused' ? error.message : 'The role runtime could not start.'
        packages.damage(record, reason)
        for (const [id, candidate] of attachments) {
          if (candidate.record === record) drop(id, candidate)
        }
        rt.syncScopedTools?.()
      }
    }
  }

  function drop(id, held) {
    attachments.delete(id)
    held.runtime?.dispose()
  }

  function reconcile() {
    for (const [id, held] of attachments) if (!current(id, held)) drop(id, held)
    for (const [sessionId, snapshot] of turnPrompts) {
      if (promptOwner(sessionId) !== snapshot.id || ownBot(snapshot.id) !== snapshot.bot) turnPrompts.delete(sessionId)
    }
    voice.cancelInvalid()
    if (!enabled()) return
    for (const [id, bot] of Object.entries(state.bots ?? {})) {
      if (attachments.has(id)) continue
      const pin = packageAttachment(bot)
      if (!pin) continue
      const record = packages.recordOf(pin.id)
      if (!record || record.version !== pin.version || packages.damaged(record)) continue
      if (rt.botRunnerRequired !== undefined && !warnedRunner) {
        warnedRunner = true
        rt.warn('ds-bot: Bot role modules skipped: %s', NO_BOT_RUNNER_REASON)
      }
      const held = { pin, record, bot }
      attachments.set(id, held)
      held.ready = load(held)
    }
  }

  function tools(agent, existing) {
    const sessionId = agent.session?.id ?? agent.id
    const id = owner(sessionId)
    const held = id === undefined ? undefined : active(id)
    if (!held?.runtime.tools.length) return undefined
    if (held === existing) return { key: held }
    let registered = true
    let lastTurn
    const executions = new Map()
    return {
      key: held,
      dispose() { registered = false; voice.cancelInvalid() },
      definitions: held.runtime.tools.map(({ definition, bounds, handler }) => defineTool({
        ...definition,
        output,
        execute(args, exec) {
          // DSH calls this after its own guard/approval pipeline. A registration
          // retained by an in-flight step still checks this exact attachment.
          const valid = () => registered && exec.agent === agent && current(id, held) && owner(sessionId) === id
          if (!valid()) throw refusal(inactive)
          for (const [key, max] of bounds) {
            if (args[key]?.length > max) throw refusal(`${key} must contain at most ${max} characters.`)
          }
          const turn = voice.turnOf(sessionId)
          if (turn !== lastTurn) { executions.clear(); lastTurn = turn }
          const callKey = exec.callId === undefined ? undefined : JSON.stringify([definition.name, exec.callId])
          if (callKey !== undefined && executions.has(callKey)) return executions.get(callKey)
          const result = invoke(definition, handler, args, exec, sessionId, id, held, valid)
          if (callKey !== undefined) {
            executions.set(callKey, result)
            if (executions.size > 128) executions.delete(executions.keys().next().value)
          }
          return result
        },
      })),
    }
  }

  async function invoke(declaration, handler, args, exec, sessionId, id, held, valid) {
    if (declaration.name === 'speak' && (!validSpeech(args.text) || Object.keys(args).length !== 1)) {
      throw refusal('Speech text must contain 1 to 2000 characters.')
    }
    let running = true
    let speech
    const sameCall = () => running && !exec.signal?.aborted && valid()
    const allowed = () => sameCall() && granted(held, 'audio-out')
    const declarations = held.runtime.manifest.settings
    const values = Object.freeze(await settings.read(id, held.pin.id, declarations))
    if (!sameCall()) throw refusal(cancelled)
    const forKind = kind => values[declarations.find(setting => setting.kind === kind)?.key]
    const bound = Object.freeze({
      settings: () => {
        if (!sameCall()) throw refusal(inactive)
        return values
      },
      granted: capability => sameCall() && granted(held, capability),
      speak: text => {
        if (!allowed()) throw refusal(cancelled)
        if (!validSpeech(text)) throw refusal('Speech text must contain 1 to 2000 characters.')
        if (!speech) {
          speech = voice.speak(sessionId, id, text, { voice: forKind('voice') ?? '', rate: forKind('speed') ?? 1 },
            { signal: exec.signal, valid: allowed })
          // A handler that returns early still has its delivery cancelled.
          void speech.catch(() => {})
        }
        return speech
      },
    })
    try { return String(await handler(Object.freeze({ ...args }), bound)) } finally {
      running = false
      voice.cancelInvalid()
    }
  }

  const providerOf = ref => String(ref ?? '').split('/')[0]
  const connectionOf = provider => routeOf(provider).connectedBy
  function providerWarning(provider) {
    const connection = connectionOf(provider)
    if (connection === 'hermes-remote') return hermesWarning
    if (connection === 'acp' && rt.acpRolePromptProviders?.includes?.(provider) !== true) return acpWarning
  }
  const savedWarning = bot => [bot.appliedModel, bot.model].map(providerOf).map(providerWarning).find(Boolean)
  const sessionsOf = bot => [rt.chatOf?.(bot.id), ...(rt.groupSessionsOf?.(bot.id) ?? [])].filter(Boolean)
  function liveProvider(sessionId, session) {
    try {
      const agent = ctx.get?.('agents')?.get?.(sessionId)
      const provider = agent?.model?.current?.()?.provider
      if (provider) return provider
      const live = session ?? agent?.session ?? ctx.sessions?.get?.(sessionId)
      if (!live) return undefined
      let selection
      try { selection = ctx.get?.('sessionProjections')?.snapshot?.(live, ['modelSelection'])?.values?.modelSelection } catch {}
      return selection?.next?.provider ?? live.requestHeader?.()?.config?.provider
    } catch { return undefined }
  }
  async function readDeliveryRoutes(bots) {
    const sessions = new Set(bots.flatMap(sessionsOf))
    const needStoredRoute = [...sessions].filter(id => !liveProvider(id))
    return new Map(await Promise.all(needStoredRoute.map(async id => [id, await rt.storedRouteOf?.(id)])))
  }
  function deliveryWarning(bot, routes) {
    const sessions = sessionsOf(bot)
    if (!sessions.length) return routeUnavailable
    for (const id of sessions) {
      const stored = routes?.get(id)
      const provider = liveProvider(id) ?? (stored?.pendingSelection ?? stored)?.provider
      if (typeof provider !== 'string' || !provider) return routeUnavailable
      const warning = providerWarning(provider)
      if (warning) return warning
    }
  }
  function partOf(sessionId, held) {
    if (!held?.runtime.prompt?.trim() || (owner(sessionId) === undefined && !promptOnly(held.manifest))) return undefined
    const tail = held.pin.id === SOLVER_ROLE_ID ? `\n${solverReviewPart(held.bot, ownBot)}` : ''
    return `<role-prompt id="${held.pin.id}">\n${held.runtime.prompt.trimEnd()}${tail}\n</role-prompt>`
  }
  function partFor(sessionId, id) {
    const turn = turnPrompts.get(sessionId)
    return turn?.id === id ? turn.part : partOf(sessionId, active(id))
  }
  function prompt(sessionId, agent) {
    const id = promptOwner(sessionId)
    if (id === undefined) return undefined
    const bot = ownBot(id)
    if (!bot) return undefined
    const provider = agent?.model?.current?.()?.provider ?? liveProvider(sessionId, agent?.session)
      ?? providerOf(bot.appliedModel ?? bot.model)
    if (['acp', 'hermes-remote'].includes(connectionOf(provider))) return undefined
    return partFor(sessionId, id)
  }
  function acpPrompt(sessionId, botId) {
    if (promptOwner(sessionId) !== botId || !ownBot(botId)) return undefined
    return partFor(sessionId, botId)
  }
  function instructionsFor(sessionId, bot) {
    const turn = turnPrompts.get(sessionId)
    return (turn?.bot === bot ? turn.instructions : undefined) ?? bot.instructions
  }
  function event(sessionId, event, session) {
    if (disposed) return
    voice.event(sessionId, event)
    if (event.type === 'turn/end') {
      const turn = turnPrompts.get(sessionId)
      turnPrompts.delete(sessionId)
      if (turn?.instructions && turn.bot.waitingRole?.id === SOLVER_ROLE_ID) rt.solverSettle?.schedule()
    }
    if (event.type === 'turn/start') {
      const id = promptOwner(sessionId)
      const bot = ownBot(id)
      if (!bot) return
      const part = partOf(sessionId, active(id))
      // A greeting may begin before attachment. Keep its complete method if
      // writing the new pin later clears the instructions on the live Bot.
      let instructions
      if (bot.waitingRole?.id === SOLVER_ROLE_ID) {
        const provider = liveProvider(sessionId, session)
        if (!part || (provider ? providerWarning(provider) : savedWarning(bot))) instructions = bot.instructions
      }
      turnPrompts.set(sessionId, { id, bot, part, instructions })
    }
  }

  function requireAttachment(id, pin) {
    if (!ownBot(id)) throw refusal('No such Bot')
    const held = attachments.get(id)
    if (!held?.manifest || !current(id, held) || !sameRolePin(held.pin, pin)) throw refusal(inactive)
    return held
  }

  function view(routes) {
    return Object.fromEntries([...attachments].flatMap(([id, held]) => {
      if (!current(id, held) || !held.manifest
        || (held.pin.id === SOLVER_ROLE_ID && !held.runtime?.prompt?.trim())) return []
      const warning = deliveryWarning(held.bot, routes)
      return [[id, {
        pin: held.pin, settings: held.manifest.settings,
        capabilities: held.manifest.capabilities,
        tools: held.runtime?.tools.map(tool => tool.definition.name) ?? [], acp: warning === acpWarning,
        ...(warning && warning !== acpWarning ? { promptWarning: warning } : {}),
      }]]
    }))
  }

  return {
    voice, event, reconcile, tools, prompt, acpPrompt, instructionsFor, requireAttachment, settings,
    readDeliveryRoutes, view,
    copyWarning: bot => savedWarning(bot) ?? providerWarning(liveProvider(bot.sessionId ?? bot.id)),
    async publicView() {
      const bots = [...attachments.values()].filter(held => held.manifest).map(held => held.bot)
      return view(await readDeliveryRoutes(bots))
    },
    serving(id, record, pin, routes) {
      const held = active(id)
      return held?.record === record && sameRolePin(held?.pin, pin) && Boolean(held.runtime.prompt?.trim())
        && !deliveryWarning(held.bot, routes)
    },
    async prepare(details, sha256) {
      try {
        const runtime = await stage(details, sha256)
        runtime?.dispose()
      } catch (error) {
        if (error?.code === 'bot/refused') throw error
        throw refusal('The role runtime could not start.')
      }
    },
    keepProof(record, details) {
      pins.set(record, Promise.resolve(details))
    },
    reset(record) {
      if (record) pins.delete(record)
    },
    ready: id => id === undefined ? Promise.all([...attachments.values()].map(held => held.ready)) : attachments.get(id)?.ready,
    dispose() {
      disposed = true
      turnPrompts.clear()
      for (const [id, held] of attachments) drop(id, held)
      voice.dispose()
    },
  }
}
