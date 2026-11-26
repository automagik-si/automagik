// A person's approval grant lives in this host, for one task, chat part or group Session.
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { commandCapableAgent, piAiRoutes, routeOf } from '../shared/routes.js'
import { teamLookup, teamToolOf } from './approvals.js'
import { bindTicketDesk } from './grant-ticket.js'
import { cleanArgs, effectiveRoute, hardContext, hardToUndo } from './auto-judge.js'
import { capabilityOfArgs } from './turns.js'
import { shellDelegateOf } from './steer.js'

const EVIDENCE_MAX = 2000
const ENDED_MAX = 4000
const LOST_MAX = 2000
const ISSUED_MAX = 200
const RECEIPT_MS = 30_000
const PARENT_DEPTH = 32
const SHELLS = new Set(['bash', 'pwsh'])
const PERSISTENT = new Set(['tool-bash-persistent', 'tool-pwsh-persistent'])
const internals = new WeakMap()
const listeners = new WeakMap()
export const grantInternals = rt => internals.get(rt)
export function bindGrantDecisions(rt, listener) {
  if (!listeners.has(rt)) listeners.set(rt, listener)
}
// oxlint-disable-next-line eslint/no-control-regex -- Match the approval card's reason rule.
const CONTROL = /[\u0000-\u001f\u007f]/
const pair = (sessionId, id) => JSON.stringify([sessionId, id])
const hash = text => createHash('sha256').update(text).digest('hex')
const identifier = value => typeof value === 'string' && value !== ''
const shellTargets = ['command', 'cmd']
const fileTargets = ['path', 'file_path']
const targets = new Map([
  ['bash', shellTargets], ['pwsh', shellTargets],
  ['read', fileTargets], ['read_image', fileTargets], ['edit', fileTargets],
  ['write', fileTargets], ['grep', fileTargets], ['glob', fileTargets],
  ['browser_open', ['url']],
])

// Team tools (tools.js), agent endpoint aliases (agent-access.js), and the window operations
// those setters cover (channel.js and the extension endpoint surface in extend.js).
export const GRANT_MUTATORS = Object.freeze({
  setters: Object.freeze(['set_bot_auto', 'switch_route']),
  updates: Object.freeze(['update_bot', 'update_group', 'update_room']),
  fields: Object.freeze([
    'permission', 'permission_level', 'permission_auto', 'permission_rev', 'auto', 'auto_stamp',
    'level', 'model', 'route', 'deny_tools', 'shell',
  ]),
})

export function isGrantMutator(tool, args) {
  const name = teamToolOf(tool).replaceAll('-', '_')
  return GRANT_MUTATORS.setters.includes(name) || (GRANT_MUTATORS.updates.includes(name)
    && Object.keys(args).some(key => GRANT_MUTATORS.fields.includes(
      key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
    )))
}

// RFC 0031 asks for a push of a version tag ("v" and a digit). Auto's predicate reads only
// dotted versions there; a grant never covers a git push at all.
function versionTagPush(args) {
  const command = typeof args?.command === 'string' ? args.command : ''
  // Shell wrappers (sh -c '...', eval, xargs) can hide a push from the word scan below, so no
  // command that names both git and push is grantable: the person answers each one.
  if (/\bgit\b/.test(command) && /\bpush\b/.test(command)) return true
  if (command.split(/[;&|\n]+/).some(part => /\bgit\b.*\bpush\b/.test(part)
    && /(?:^|[\s:'"])(?:refs\/tags\/|v\d)/.test(part))) return true

  const tokens = command.matchAll(/((?:[^\s"'\\;&|]|\\.|"[^"]*"|'[^']*')+)|[;&|\n]/g)
  let git = false
  let push = false
  for (const [token, word] of tokens) {
    if (word === undefined) {
      git = push = false
      continue
    }
    const value = token.replace(/"([^"]*)"|'([^']*)'|\\(.)/g,
      (_, double, single, escaped) => double ?? single ?? escaped)
    if (push) {
      if (value === '--tags' || value === '--follow-tags') return true
      if (value.startsWith('-')) continue
      const dest = value.split(':').at(-1).replace(/^\+/, '').replace(/^refs\/heads\//, '')
      if (dest.startsWith('refs/tags/') || /^v\d/.test(dest)) return true
    } else if (git && value === 'push') push = true
    else if (/(?:^|[/\\])git$/.test(value)) git = true
  }
  return false
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function objectArgs(raw) {
  try {
    const value = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw))
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {}
  return undefined
}

// The pinned sandbox modes; any other value never reaches a card, a key or an event.
const SANDBOX_MODES = new Set(['workspace-write', 'danger-full-access', 'read-only'])
const isSandboxMode = mode => SANDBOX_MODES.has(mode)

export function shownTarget(tool, args) {
  const fields = targets.get(teamToolOf(tool))
  if (fields === undefined) return undefined
  const target = capabilityOfArgs(JSON.stringify(args), tool)
  if (target === undefined) return undefined
  const [field, text, sandboxMode] = JSON.parse(target)
  if (!fields.includes(field)) return undefined
  if (args.sandbox_permissions != null && !isSandboxMode(args.sandbox_permissions)) return
  return { target, text, sandboxMode }
}

// oxlint-disable-next-line eslint/no-control-regex -- The confirmation must show every character.
const INVISIBLE = /[\p{C}\p{M}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|[^\S ]/u
const BLANK = /[\u2800\u3164\uffa0\u115f\u1160]/u
const visible = text => text === text.normalize('NFC') && !INVISIBLE.test(text) && !BLANK.test(text)
const sameRefs = (a, b) => a.length === b.length && a.every((ref, i) => ref === b[i])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const routeOfConfig = config => identifier(config?.provider) && identifier(config?.model)
  ? config.provider + '/' + config.model : undefined

// Only the pinned foreground executors resolve cwd through workingDirectory.ensure.
function shellDefinition(ctx, tool) {
  if (!SHELLS.has(tool)) return
  const runtimes = ctx.registry?.values?.()
  if (!runtimes) return
  const tools = ctx.get('tools')
  const definition = tools?.get?.(tool)
  if (!definition) return
  let pinned = false
  for (const runtime of runtimes) {
    const name = runtime.name?.replace(/^@deepseek-ai\/dsh-/, '')
    if (PERSISTENT.has(name)) return
    if (name !== 'tool-' + tool || typeof runtime.callback !== 'function') continue
    // A live, unscoped plugin owns the global registration.
    const ownsRegistration = [...runtime.fibers].some(fiber => fiber.state === 2
      && scopeOf(fiber.ctx) === undefined && fiber.ctx.get('tools')?.get(tool) === definition
      && fiber.getEffects?.().some(effect => effect.label === 'tools.register()'))
    if (!ownsRegistration) continue
    // defineTool wraps execute. The plugin callback still contains the pinned implementation.
    const source = Function.prototype.toString.call(runtime.callback)
    pinned ||= /\bworkingDirectory\.ensure\(/.test(source) && /\bresolveWorkdir\(/.test(source)
  }
  if (!pinned) return
  if (definition?.name === tool && definition.parameters?.properties?.command?.type === 'string'
    && definition.parameters?.properties?.workdir?.type === 'string'
    && typeof definition.output?.presentationMeta === 'function') return definition
}

// A snapshot binds both identity and the policy inherited from a task's whole lineage.
function ownerOf(rt, entry, sessionId) {
  if (entry?.child || entry?.run || entry?.sessionId !== sessionId
    || rt.pastOwners?.has(sessionId)) return
  const { botId, taskId, roomId } = entry
  const bot = rt.botOf?.(botId)
  if (!bot || rt.botDeleting?.(botId) || bot.shellHeld !== undefined
    || bot.shell === false || entry.shellOffCli) return
  if (entry.kind === 'task') {
    const task = rt.state?.tasks?.[taskId]
    if (taskId === sessionId && task?.from === botId && task.status === 'working'
      && !task.shellOffCli) return { kind: 'task', id: taskId }
  }
  if (entry.kind === 'chat' && rt.chatOf?.(botId) === sessionId) {
    return { kind: 'part', id: sessionId }
  }
  if (entry.kind === 'group') {
    const room = rt.roomOf?.(roomId)
    if (room?.members?.includes(botId) && room.sessions?.[botId] === sessionId) {
      return { kind: 'group', id: sessionId, roomId }
    }
  }
}

const botPolicy = bot => [
  bot.permission, bot.permissionRev, bot.permissionAuto, bot.denyTools, bot.shell,
  bot.shellHeld, bot.browserGrants, bot.model, bot.appliedModel, bot.workDir,
]

export function install(rt) {
  const { ctx } = rt
  if (typeof ctx.get?.('approval')?.request !== 'function') return
  const calls = new Map()
  const asks = new Map()
  const ended = new Map()
  const lost = new Set()
  const turnStarts = new Map()
  const attempts = new Map()
  const issued = new Map()
  const grants = new Map()
  const holds = new Set()
  const generations = new WeakMap()
  const routes = new WeakMap()
  let disposed = false
  let generation = 0
  let endedCount = 0
  let saturation = 0
  const sessions = ctx.get('sessions')
  const genOf = id => generations.get(sessions?.get?.(id)) ?? 0
  const folderOf = session => ctx.get('workingDirectory')?.get?.(session)
  const liveOwner = (session, agent) => rt.teamOwnerOf?.(session.id, agent ?? { session })
  const teamVersion = () => {
    const team = rt.teamGeneration?.()
    return [team?.epoch, team?.term ?? rt.lockTerm?.()]
  }
  let version = teamVersion()

  function holdsLock() {
    if (disposed) return false
    const current = teamVersion()
    if (!same(current, version)) dropAllGrants()
    version = current
    // After the heartbeat saw the lock go, it no longer watches it: a later loss and return
    // between two reads would go unseen, so no grant is offered or used until a restart.
    if (rt.holdsLock?.() === true && rt.lockBeating?.() !== false) return true
    dropAllGrants()
    return false
  }

  function taskLineage(id) {
    const chain = []
    const seen = new Set()
    while (id !== undefined) {
      const task = rt.state?.tasks?.[id]
      if (!task || seen.has(id) || chain.length > PARENT_DEPTH) return
      seen.add(id)
      chain.push([id, task])
      id = task.levelTaskId
    }
    return chain
  }

  function snapshot(entry, session) {
    const { id: sessionId } = session
    const owner = ownerOf(rt, entry, sessionId)
    if (!owner || session.header?.origin === 'subagent' || rt.asksThroughBot?.(sessionId)) return
    const { botId } = entry
    const bot = rt.botOf(botId)
    const room = owner.roomId === undefined ? undefined : rt.roomOf(owner.roomId)
    const refs = [session, bot, room]
    const chain = owner.kind === 'task' ? taskLineage(sessionId) : []
    if (chain === undefined) return
    const levels = []
    for (const [id, task] of chain) {
      const parentBot = rt.botOf(task.from)
      const run = rt.grantTaskRun?.(id)
      if (!parentBot || rt.botDeleting?.(task.from) || run?.unproven === true) return
      const taskRoom = rt.roomOf?.(task.roomId)
      const levelRoom = rt.roomOf?.(task.levelRoomId)
      refs.push(task, parentBot, taskRoom, levelRoom)
      levels.push([task.from, task.levelTaskId, task.permissionCap, task.auto, task.autoRev,
        botPolicy(parentBot), taskRoom?.permission, levelRoom?.permission, run?.level])
    }
    const service = ctx.get('permissionPresets')
    const preset = service?.current?.(session)
    if (!identifier(preset) || ['auto', 'custom'].includes(preset)) return
    const knobs = service.resolve?.(preset)
    if (knobs === undefined) return
    const policy = ctx.get('approval')?.effectivePolicy?.(session)
    const shell = ctx.get('shell')?.sandboxMode
    const fingerprint = JSON.stringify([
      botPolicy(bot), room?.permission, room?.workDir, room?.memberDirs?.[botId],
      levels, preset, knobs.sandbox, knobs.approval, policy, shell,
    ])
    const gens = [generation, generations.get(session) ?? 0]
    return { owner, botId, sessionId, refs, fingerprint, gens }
  }

  function nativeRoute(session) {
    const route = effectiveRoute(session)
    if (!route || commandCapableAgent(route)) return
    if (routes.has(session) && routes.get(session) !== route) return
    const provider = route.split('/')[0]
    if (provider.startsWith('herdr')) return
    const listed = ctx.get('llm')?.listProviders?.()?.some(row => row.id === provider)
    if (!listed) return
    const { connectedBy } = routeOf(provider, { piAi: piAiRoutes(rt.providerDirectory?.()) })
    if (connectedBy === 'native' || connectedBy === 'pi-ai') return route
  }

  function covers(scope, entry) {
    if (scope.all || scope.sessionIds?.includes(entry.sessionId)) return true
    if (scope.botId !== undefined && scope.botId === entry.botId) return true
    if (scope.roomId !== undefined && scope.roomId === entry.owner?.roomId) return true
    if (entry.owner?.kind !== 'task') return false
    return taskLineage(entry.sessionId)?.some(([, task]) =>
      (scope.botId !== undefined && task.from === scope.botId)
      || (scope.roomId !== undefined && (task.roomId === scope.roomId
        || task.levelRoomId === scope.roomId))) === true
  }

  // The never-auto list and its classifiers (an external sender added since the claim) are
  // read again when DSH decides: a step that became never-auto is allowed once, not granted.
  function neverAutoNow(binding, callId, args) {
    try {
      if (args === undefined) return true
      const { tool, reason, session, folder } = binding
      const step = { tool, args, callId, reason }
      const context = { ...hardContext(rt, session.id, step, session), root: folder }
      return isGrantMutator(tool, args) || hardToUndo(step, context) || versionTagPush(args)
    } catch { return true }
  }

  function liveBinding(binding, agent) {
    try {
      const { session, route, folder, tool, definition } = binding
      if (sessions?.get?.(session.id) !== session || nativeRoute(session) !== route
        || folderOf(session) !== folder || shellDefinition(ctx, tool) !== definition) {
        return false
      }
      const current = snapshot(liveOwner(session, agent), session)
      return current !== undefined && current.botId === binding.botId
        && same(current.owner, binding.owner) && same(current.gens, binding.gens)
        && current.fingerprint === binding.fingerprint && sameRefs(current.refs, binding.refs)
    } catch { return false }
  }

  const unavailable = () => lost.size >= LOST_MAX
    || calls.size >= EVIDENCE_MAX || endedCount >= ENDED_MAX
  // A dropped start may be an unseen duplicate in any open turn.
  const observedTurn = session => turnStarts.get(session)?.saturation === saturation
  const available = () => bindTicketDesk(rt)?.available() === true
  const held = binding => [...holds].some(scope => covers(scope, binding)
    || scope.heldIds.has(binding.sessionId))

  const dispatchedDefinition = exec =>
    ctx.get('tools')?.executable?.(exec.name, exec.agent, exec.toolSet)

  function liveDispatch(call, callId) {
    const { dispatch, start, args, session, tool } = call ?? {}
    if (!dispatch || !start) return
    const { exec, definition, arguments: recorded } = dispatch
    try {
      if (exec.callId === callId && exec.agent?.session === session && exec.name === tool
        && (definition === start.definition || shellDelegateOf(definition) === start.definition)
        && dispatchedDefinition(exec) === definition && exec.arguments === recorded
        && isDeepStrictEqual(recorded, args)) {
        return exec
      }
    } catch {}
  }

  function projection(sessionId, callId, tool, request) {
    const call = calls.get(pair(sessionId, callId))
    const shown = call?.projection
    if (!shown || call.collided || call.tool !== tool) return
    try {
      const reason = request.reason ?? ''
      const { botId } = liveOwner(call.session, request.agent) ?? {}
      if (!identifier(botId) || !identifier(call.groupingFolder)
        || typeof reason !== 'string' || reason.length > 500 || CONTROL.test(reason)) return
      const capabilityKey = hash(JSON.stringify(
        ['v1', botId, call.groupingFolder, tool, reason, shown.targetHash],
      ))
      return {
        capabilityKey, shownTarget: shown.text,
        ...(shown.sandboxMode !== null && !reason.includes(shown.sandboxMode)
          ? { sandboxMode: shown.sandboxMode } : {}),
      }
    } catch {}
  }

  function eligibility(entry, request, call) {
    try {
      if (!call?.start || call.ask?.request !== request || call.collided
        || !observedTurn(call.session) || lost.has(call.session) || unavailable()
        || !available() || !holdsLock()
        || 'bridgeCall' in request || call.ask.signal?.aborted) return
      const { start, session, tool } = call
      if ((request.agent?.session ?? request.agent) !== session || request.toolName !== tool
        || held(start) || !liveBinding(start, request.agent)) return
      const exec = liveDispatch(call, request.callId)
      if (!exec) return
      const args = exec.arguments
      if (!same(ownerOf(rt, entry, session.id), start.owner) || entry.botId !== start.botId) return
      const shown = projection(session.id, request.callId, tool, request)
      const reason = request.reason ?? ''
      if (!shown || !visible(reason) || !visible(shown.shownTarget)) return
      const cleaned = JSON.stringify(cleanArgs(args))
      for (const raw of [request.arguments, request.args]) {
        if (raw === undefined) continue
        const input = objectArgs(raw)
        if (!input || JSON.stringify(cleanArgs(input)) !== cleaned) return
      }
      const step = { tool, args, callId: request.callId, reason }
      const context = { ...hardContext(rt, session.id, step, session), root: start.folder }
      if (isGrantMutator(tool, args) || hardToUndo(step, context) || versionTagPush(args)) return
      return { ...start, ...shown, argsKey: hash(cleaned), reason }
    } catch { return undefined }
  }

  function sameBinding(a, b) {
    return b !== undefined && a.session === b.session && a.botId === b.botId
      && same(a.owner, b.owner) && a.route === b.route && a.tool === b.tool
      && a.definition === b.definition && a.folder === b.folder
      && a.capabilityKey === b.capabilityKey && a.argsKey === b.argsKey
      && a.fingerprint === b.fingerprint && same(a.gens, b.gens) && sameRefs(a.refs, b.refs)
  }

  function demote(call) {
    if (call.ask) delete call.ask.offer
    delete call.start
    delete call.args
    delete call.dispatch
  }

  function invalidate(matches) {
    let removed = 0
    for (const [id, grant] of grants) {
      if (!matches(grant.binding)) continue
      grants.delete(id)
      removed++
    }
    for (const call of calls.values()) {
      if (call.start && matches(call.start)) demote(call)
    }
    for (const attempt of attempts.values()) {
      if (matches(attempt.binding)) attempt.authorityEnded = true
    }
    return removed
  }

  const sweep = () => invalidate(binding => !liveBinding(binding))
  function matching(binding) {
    sweep()
    return [...grants.values()].find(grant => sameBinding(grant.binding, binding))
  }

  function publicOffer({ token, binding }) {
    const { shownTarget, sandboxMode, folder } = binding
    return { grantable: true, offer: token, shownTarget, folder,
      ...(sandboxMode === undefined ? {} : { sandboxMode }) }
  }

  function offer(entry, request, { signal }) {
    const call = calls.get(pair(entry.sessionId, request.callId))
    if (!call?.ask || call.ask.offered || signal?.aborted) return
    call.ask.offered = true
    const binding = eligibility(entry, request, call)
    if (!binding || entry.capabilityKey !== binding.capabilityKey || entry.tool !== binding.tool
      || entry.callId !== request.callId || entry.reason !== binding.reason) return
    const offered = { id: entry.id, binding, signal, token: randomUUID() }
    call.ask.offer = offered
    return publicOffer(offered)
  }

  function currentOffer(entry, request, call) {
    const offered = call?.ask?.offer
    if (!offered || offered.id !== entry.id || offered.signal?.aborted
      || attempts.has(call.ask.key)) return
    const binding = eligibility(entry, request, call)
    if (call.ask.offer === offered && sameBinding(offered.binding, binding)) return offered
  }

  function offerView(entry, request) {
    const offered = currentOffer(entry, request, calls.get(pair(entry.sessionId, request.callId)))
    if (offered) return publicOffer(offered)
  }

  function finish(key, result) {
    const attempt = attempts.get(key)
    if (attempt === undefined) return
    attempts.delete(key)
    clearTimeout(attempt.timer)
    attempt.resolve(result)
  }

  function claim(ticket, lookup, answer) {
    const admitted = bindTicketDesk(rt)?.spend(ticket)
    if (!admitted) return
    const context = lookup(admitted.id)
    if (!context) return { stale: true }
    const { grantEntry: entry, request } = context
    if (!entry || !request) return { changed: true }
    const call = calls.get(pair(entry.sessionId, request.callId))
    const offered = currentOffer(entry, request, call)
    if (!offered || offered.token !== admitted.offer) return { changed: true }
    const { key, signal: original } = call.ask
    const shared = [...attempts.values()].find(attempt => attempt.won
      && !attempt.authorityEnded && sameBinding(attempt.binding, offered.binding))
    const grantId = matching(offered.binding)?.id ?? shared?.grantId ?? randomUUID()
    const { promise: receipt, resolve } = Promise.withResolvers()
    const timer = setTimeout(() => finish(key, { allowed: 'unknown' }), RECEIPT_MS)
    timer.unref?.()
    const attempt = { ...offered, grantId, original, resolve, timer, callId: request.callId }
    attempts.set(key, attempt)
    attempt.won = answer(entry.id, 'allowed-once', 'web') === true
    if (!attempt.won) finish(key, { allowed: false })
    return { receipt }
  }

  function record(binding, callId, requestId, grantId, decidedBy, approvalId) {
    const { sessionId } = binding
    try {
      ctx.logger?.info?.('ds-bot: grant decision request=%s session=%s call=%s '
        + 'decidedBy=%s grantId=%s', requestId, sessionId, callId, decidedBy, grantId)
    } catch {}
    listeners.get(rt)?.({
      sessionId, callId, requestId, outcome: 'allowed-once', grantId, decidedBy,
      ...(approvalId === undefined ? {} : { approvalId }),
    })
  }

  function decided(sessionId, { id, outcome }) {
    const key = pair(sessionId, id)
    const attempt = attempts.get(key)
    if (attempt) {
      const anotherWon = attempt.signal !== attempt.original && attempt.signal?.aborted
      if (outcome !== 'allowed-once' || !attempt.won || anotherWon) {
        finish(key, { allowed: false })
        return
      }
      const { binding, callId } = attempt
      const call = calls.get(pair(sessionId, callId))
      const live = holdsLock() && !attempt.authorityEnded && available() && !unavailable()
        && call?.ask?.key === key && observedTurn(binding.session) && !attempt.original?.aborted
        && !held(binding) && liveBinding(binding)
        && liveDispatch(call, callId) !== undefined
        && !neverAutoNow(binding, callId, liveDispatch(call, callId)?.arguments)
      const grantId = (live && matching(binding)?.id) || attempt.grantId
      if (live && !grants.has(grantId)) {
        grants.set(grantId, { id: grantId, binding, at: Date.now(), uses: 0 })
      }
      finish(key, { allowed: true, live, grantId })
      record(binding, callId, id, grantId, 'web', attempt.id)
      return
    }
    const replay = issued.get(key)
    if (!replay) return
    issued.delete(key)
    if (outcome !== 'allowed-once') return
    const { binding, callId, grantId, rev } = replay
    const grant = grants.get(grantId)
    if (grant) grant.uses++
    rt.appendAutoAudit?.({
      at: Date.now(), sessionId, callId, tool: binding.tool, decision: 'allow',
      code: 'person-grant', grantId, route: binding.route, rev,
    })
    record(binding, callId, id, grantId, 'grant')
  }

  function grantsView() {
    if (!holdsLock()) return []
    sweep()
    return [...grants.values()].map(({ id, binding, at, uses }) => {
      const { botId, owner, tool, shownTarget: target, sandboxMode } = binding
      return { id, botId, owner: { ...owner }, tool, target, uses, at,
        ...(sandboxMode === undefined ? {} : { sandboxMode }) }
    })
  }

  function revokeGrant(id) {
    if (!holdsLock()) return false
    sweep()
    const grant = grants.get(id)
    if (!grant) return false
    invalidate(binding => sameBinding(grant.binding, binding))
    return true
  }

  function dropGrantsForSession(sessionId, route) {
    const session = sessions?.get?.(sessionId)
    if (session && route === undefined) generations.set(session, genOf(sessionId) + 1)
    return invalidate(binding => binding.sessionId === sessionId
      && (route === undefined || binding.route !== route))
  }

  function endGrants(sessionIds, why, { botId } = {}) {
    if (why === 'bot' && botId !== undefined) return dropGrantsForBot(botId)
    let count = 0
    for (const id of new Set([sessionIds].flat())) {
      if (identifier(id)) count += dropGrantsForSession(id)
    }
    return count
  }

  function sessionsCovered(scope) {
    const ids = new Set(scope.sessionIds)
    for (const session of sessions?.list?.() ?? []) {
      const entry = liveOwner(session)
      const owner = ownerOf(rt, entry, session.id)
      if (covers(scope, { ...entry, sessionId: session.id, owner })) ids.add(session.id)
    }
    return ids
  }

  function dropScope(scope, heldIds = new Set()) {
    const ids = sessionsCovered(scope)
    if (scope.all) generation++
    else for (const id of new Set([...ids, ...heldIds])) {
      const session = sessions?.get?.(id)
      if (session) generations.set(session, genOf(id) + 1)
    }
    return invalidate(binding => covers(scope, binding)
      || ids.has(binding.sessionId) || heldIds.has(binding.sessionId))
  }

  const dropGrantsForBot = botId => dropScope({ botId })
  const dropAllGrants = () => {
    generation++
    invalidate(() => true)
  }
  // Only shell calls can acquire grant bindings.
  const dropAllShellGrants = dropAllGrants

  function holdGrants(scope, watch) {
    const heldIds = sessionsCovered(scope)
    let before
    let unreadable = false
    try { before = JSON.stringify(watch?.()) } catch { unreadable = true }
    const hold = { ...scope, heldIds }
    holds.add(hold)
    return threw => {
      if (!holds.delete(hold)) return
      let changed = threw || unreadable || watch === undefined
      try { changed ||= before !== JSON.stringify(watch()) } catch { changed = true }
      if (changed) dropScope(scope, heldIds)
    }
  }

  function forgetCall(key, call) {
    if (call.ask) asks.delete(call.ask.key)
    calls.delete(key)
  }

  function clearEvidence(session) {
    for (const [key, call] of calls) {
      if (call.session === session) forgetCall(key, call)
    }
    endedCount -= ended.get(session)?.size ?? 0
    ended.delete(session)
    lost.delete(session)
  }

  function clearTurn(session) {
    turnStarts.delete(session)
    clearEvidence(session)
  }

  function lose(session) {
    if (lost.has(session)) return true
    if (lost.size >= LOST_MAX) return false
    clearEvidence(session)
    for (const attempt of attempts.values()) {
      if (attempt.binding.session === session) attempt.authorityEnded = true
    }
    lost.add(session)
    return true
  }

  function evict(session) {
    if (calls.size < EVIDENCE_MAX) return true
    const busy = new Set()
    for (const call of calls.values()) if (call.ask?.request) busy.add(call.session)
    for (const { binding } of attempts.values()) busy.add(binding.session)
    for (const { binding } of issued.values()) busy.add(binding.session)
    const oldest = [...calls.values()].find(call => !busy.has(call.session))?.session
    return lose(oldest ?? session) && oldest !== undefined && oldest !== session
  }

  function startCall(session, callId, tool, raw) {
    // Stop taking evidence at the lost-marker limit so there is no untracked lost Session.
    if (!identifier(callId) || disposed) return
    if (lost.size >= LOST_MAX) {
      saturation++
      return
    }
    if (lost.has(session)) return
    const locked = holdsLock()
    const key = pair(session.id, callId)
    const previous = calls.get(key)
    if (!previous && !evict(session)) {
      saturation++
      return
    }
    if (previous || ended.get(session)?.has(callId)) {
      const attempt = attempts.get(previous?.ask?.key)
      if (attempt) attempt.authorityEnded = true
      if (previous) forgetCall(key, previous)
      calls.set(key, { session, collided: true })
      return
    }
    const call = { session, tool }
    calls.set(key, call)
    const args = objectArgs(raw)
    if (args === undefined) return
    // ACP grouping uses its own existing path. Never retain its canonical input here.
    const target = tool === 'acp_tool' ? undefined : capabilityOfArgs(JSON.stringify(args), tool)
    if (target !== undefined) {
      const [, text, sandboxMode] = JSON.parse(target)
      // Only a pinned sandbox mode is shown; any other value stays inside the hashed key.
      call.projection = { targetHash: hash(target), text,
        sandboxMode: isSandboxMode(sandboxMode) ? sandboxMode : null }
      call.groupingFolder = rt.sessionFolder?.(session)
    }
    if (!locked || !observedTurn(session) || !SHELLS.has(tool) || !shownTarget(tool, args)
      || Buffer.byteLength(JSON.stringify(args)) >= 8192 || unavailable()) return
    const route = nativeRoute(session)
    const folder = folderOf(session)
    const definition = shellDefinition(ctx, tool)
    if (!route || !identifier(folder) || !isAbsolute(folder) || !visible(folder)
      || !definition) return
    const current = snapshot(liveOwner(session), session)
    if (!current || held(current)) return
    call.groupingFolder = folder
    call.args = args
    call.start = { ...current, session, route, folder, tool, definition }
  }

  function noteResult(session, id) {
    const key = pair(session.id, id)
    const call = calls.get(key)
    if (!call || call.collided) return
    const attempt = attempts.get(call.ask?.key)
    if (attempt) attempt.authorityEnded = true
    if (endedCount >= ENDED_MAX) {
      if (!lose(session)) {
        // Keep a tombstone in the existing slot until the turn ends.
        forgetCall(key, call)
        calls.set(key, { session, collided: true })
      }
      return
    }
    const keys = ended.get(session) ?? new Set()
    keys.add(id)
    ended.set(session, keys)
    endedCount++
    forgetCall(key, call)
  }

  // Pinned Cordis events.ts register appends by default and waterfall shifts listeners
  // before calling the inner body. Grants install after the other team tool wrappers.
  // DSH passes exec.arguments to the body. Freeze that object and check its identity.
  // A host plugin that swaps the arguments and puts them back, or a locally modified
  // tool-bash with the pinned plugin's name and shape, is trusted in-process code.
  // RFC 0039's threat model covers the agent.
  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session
    const call = calls.get(pair(session?.id, exec.callId))
    if (!call?.start || call.session !== session) return rt.dispatchSolverProgress?.(exec, next) ?? next()
    if (call.dispatch) {
      demote(call)
      return next()
    }
    try {
      const definition = dispatchedDefinition(exec)
      const args = deepFreeze(structuredClone(exec.arguments))
      exec.arguments = args
      call.dispatch = { exec, definition, arguments: args }
    } catch { return next() }
    try { return await next() } finally { delete call.dispatch }
  })

  ctx.on('session/event', (session, { type, data = {} }) => {
    const sessionId = session.id
    switch (type) {
      case 'tool/call':
      case 'tool/ptc-dispatch-start':
        try {
          const ptc = type === 'tool/ptc-dispatch-start'
          startCall(session, ptc ? data.subCallId : data.callId, data.name, data.arguments)
        } catch {}
        break
      case 'tool/result':
      case 'tool/ptc-dispatch':
        noteResult(session, data.callId)
        noteResult(session, data.message?.source?.callId)
        noteResult(session, data.subCallId)
        break
      case 'turn/start': {
        const prior = turnStarts.get(session)
        if (prior?.turn === data.turn) break
        // A turn refused before its first step can leave no end event.
        if (prior) clearTurn(session)
        if (turnStarts.size < EVIDENCE_MAX) {
          turnStarts.set(session, { turn: data.turn, saturation })
        }
        break
      }
      case 'turn/end':
        clearTurn(session)
        break
      case 'approval/asked': {
        const call = calls.get(pair(sessionId, data.callId))
        if (!call || call.collided) break
        if (call.asked) {
          const attempt = attempts.get(call.ask?.key)
          if (attempt) attempt.authorityEnded = true
          demote(call)
        } else if (call.tool === data.toolName && identifier(data.id)) {
          call.ask = { key: pair(sessionId, data.id), reason: data.reason }
          asks.set(call.ask.key, call)
        }
        call.asked = true
        break
      }
      case 'approval/decided': {
        const key = pair(sessionId, data.id)
        const call = asks.get(key)
        try { decided(sessionId, data) } finally {
          if (call) {
            demote(call)
            delete call.ask
            asks.delete(key)
          }
        }
        break
      }
      case 'model/selection':
      case 'request/header': {
        const route = routeOfConfig(type === 'model/selection' ? data : data.header?.config)
        routes.set(session, route)
        if (route === undefined) invalidate(binding => binding.sessionId === sessionId)
        else dropGrantsForSession(sessionId, route)
        break
      }
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'working-directory/change':
        dropGrantsForSession(sessionId)
        break
    }
  })

  function archive({ sessionId }) {
    dropGrantsForSession(sessionId)
    const session = sessions?.get?.(sessionId)
    if (session) clearTurn(session)
    else {
      for (const call of calls.values()) {
        if (call.session.id === sessionId) clearTurn(call.session)
      }
      for (const endedSession of ended.keys()) {
        if (endedSession.id === sessionId) clearTurn(endedSession)
      }
      for (const lostSession of lost) if (lostSession.id === sessionId) clearTurn(lostSession)
      for (const started of turnStarts.keys()) if (started.id === sessionId) clearTurn(started)
    }
  }
  ctx.on('workspace/session-archived', archive)
  ctx.on('session/disposed', session => {
    dropGrantsForSession(session.id)
    clearTurn(session)
  })

  ctx.on('approval/request', (request, next) => {
    if (teamLookup(request)) return next()
    const session = request.agent?.session ?? request.agent
    const call = calls.get(pair(session?.id, request.callId))
    const ask = call?.ask
    if (!call?.start || !ask || ask.request || call.tool !== request.toolName
      || ask.reason !== request.reason) {
      return next()
    }
    Object.assign(ask, { request, signal: request.signal })
    if ('bridgeCall' in request) demote(call)
    if (issued.size >= ISSUED_MAX) return next()
    const binding = eligibility(liveOwner(session, request.agent), request, call)
    const grant = binding && matching(binding)
    if (!grant) return next()
    issued.set(ask.key, { binding, grantId: grant.id, callId: request.callId,
      rev: rt.botOf(binding.botId).permissionRev ?? 0 })
    return 'allowed-once'
  }, { prepend: true })

  internals.set(rt, { projection, offer, offerView, claim, genOf })
  Object.assign(rt, {
    grantsView, revokeGrant, holdGrants, endGrants, dropGrantsForBot, dropGrantsForSession,
    dropAllGrants, dropAllShellGrants,
  })
  return () => {
    disposed = true
    dropAllGrants()
    calls.clear()
    asks.clear()
    ended.clear()
    lost.clear()
    turnStarts.clear()
    issued.clear()
    holds.clear()
    for (const key of attempts.keys()) finish(key, { allowed: false })
    internals.delete(rt)
    listeners.delete(rt)
  }
}

export const grantModelFields = bot => [bot?.model, bot?.appliedModel]
export const grantTeamModels = rt => Object.values(rt.state.bots ?? {}).map(bot =>
  [bot.id, ...grantModelFields(bot), bot.effort, bot.appliedEffort])

export async function withGrantHold(rt, scope, watch, run) {
  const release = rt.holdGrants?.(scope, watch)
  let threw = true
  try {
    const result = await run()
    threw = false
    return result
  } finally {
    release?.(threw)
  }
}
