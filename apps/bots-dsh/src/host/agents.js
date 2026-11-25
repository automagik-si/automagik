// DSH bots: plain dsh entries listed under the Bots but not Bots. The user makes any number,
// each with a name, a project folder (`workDir`, else the team workspace) and a DSH agent
// preset (`profile`, else DSH's default). Their Sessions are ordinary root Sessions there,
// so they get the whole dsh conversation surface and none of the team tools. One that the
// user wants on the team is adopted instead: its newest Session becomes a Bot's own chat and
// the earlier ones its earlier parts (adoptAsBot), so the conversation, folder and name
// carry over and the Bot gets the team tools, messages, groups, capabilities and tasks.
//
// The tasks record (`kind: 'tasks'`) is not one: it keeps the Sessions of the one-off work
// a Bot hands off (start_task), which show under that Bot; when a task's first turn ends,
// its last words go back to the Bot. Only a task whose Bot is gone shows under it.
import { randomUUID } from 'node:crypto'
import { refusal } from './refusal.js'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AGENT_NAME, AGENT_SESSION_TITLE_MAX, DSH_BOT_NAME_MAX, TEAM_TOOLS } from './constants.js'
import { nameProblem } from '../shared/mentions.js'
import { displayAvatar } from '../shared/solver-look-policy.js'
import { leavesCli, routeOf, routeOfRef } from '../shared/routes.js'
import { routeLabel, taskRoutes } from '../shared/route-policy.js'
import { configured } from './models.js'
import { splitRef } from './text.js'
import { output } from './tools.js'
import { OMNI_KIND } from './roster.js'

const TASK_REPORT_MAX = 1500
const TASKS_KEPT = 60
const TASK_LINE_MAX = 160
const TASK_SUMMARY_MAX = 600
const OLD_TASK_GATE = 'Only a Main Bot or the Omni Bot starts tasks. Ask one of them in its chat.'
const TASK_GRANT = "Starting tasks is not allowed for this Bot yet. The person can allow it in this Bot's Details, under Role."
const MODEL_GRANT = 'Naming a model for a task is not allowed for this Bot, so it can name no model now. Leave out model to run the task on your own model, or ask the person to allow it in your Details, under Role.'
const OFF_CLI = "This Bot has Full access on its coding CLI, so its task cannot run on another agent's model. Name a model of the same agent, or leave out model."
const START_CHANGED = 'The start changed while it was being prepared (a grant, the role, the review guard, the permission level, the Bot or the model catalog), so no turn was sent. Ask again.'
const LEVEL_UNPROVEN = "The task's permission level could not be proven no wider than this Bot's and this conversation's, so it did not start."
const modelUnavailable = model => `The model ${model} cannot run a task now.`
const unknownModel = model => `The model ${model} is not in the list of models.`

function modelRefusal(reason, eligible = [], excluded) {
  const refs = eligible.filter(ref => ref !== excluded).sort()
  const listed = refs.slice(0, 20).join(', ')
  const retry = refs.length === 0 ? 'Models you may name: none; leave out model.'
    : `Models you may name: ${listed}${refs.length > 20 ? ` and ${refs.length - 20} more` : ''}.`
  return refusal(`${reason}\n${retry}`)
}

export const DSH_BOT = 'dsh'
export const TASKS = 'tasks'

export function install(rt) {
  const { ctx, state } = rt

  const dshBots = () => Object.values(state.agents).filter(agent => agent.kind === DSH_BOT && agent.adoptedBotId === undefined && agent.pendingCreation !== true)
  const tasksRecord = () => Object.values(state.agents).find(agent => agent.kind === TASKS)
  // What other plugins read of a DSH bot; null is the team workspace and DSH's default preset.
  const listed = agent => ({ id: agent.id, name: agent.name, workDir: agent.workDir ?? null, profile: agent.profile ?? null })

  // LEGACY: the single DSH Agent, shown as Tasks, held both the Sessions the user opened
  // there and the ones Bots and automations started. The first become a DSH bot of that
  // name in the team workspace, the others the tasks record. store.js calls this as it adopts.
  rt.migrateAgents = () => {
    let migrated = false
    const started = new Set([...Object.keys(state.tasks ?? {}), ...(state.subscriptionRuns ?? []).map(run => run.sessionId)])
    for (const agent of Object.values(state.agents)) {
      if (agent.kind !== undefined) continue
      migrated = true
      const sessions = agent.sessions ?? []
      const own = sessions.filter(id => !started.has(id))
      if (own.length === 0) {
        agent.kind = TASKS
        continue
      }
      agent.kind = DSH_BOT
      agent.sessions = own
      const handed = sessions.filter(id => started.has(id))
      if (handed.length === 0) continue
      const tasks = tasksRecord() ?? (state.agents[`${agent.id}:tasks`] = { id: `${agent.id}:tasks`, kind: TASKS, name: AGENT_NAME, sessions: [], createdAt: agent.createdAt ?? Date.now() })
      tasks.sessions.push(...handed)
    }
    return migrated
  }

  /** @type {Map<string, string>} Session id -> DSH bot or tasks record id. */
  const sessionIndex = new Map()
  // Told when the DSH bots change (rt.dshBots.onChange), with the new list.
  const listeners = new Set()
  let listedKey = ''
  function* agentSessions() {
    for (const [key, agent] of Object.entries(state.agents)) {
      if (agent.adoptedBotId !== undefined) continue
      for (const sessionId of agent.sessions ?? []) yield { key, agent, sessionId }
    }
  }
  rt.agentClaims = function* (id) {
    for (const { key, sessionId } of agentSessions()) if (sessionId === id) yield key
  }
  // store.js calls this from indexSessions after every adopt and save.
  rt.indexAgents = () => {
    sessionIndex.clear()
    for (const { agent, sessionId } of agentSessions()) sessionIndex.set(sessionId, agent.id)
    const list = dshBots().map(listed)
    const key = JSON.stringify(list)
    if (key === listedKey) return
    listedKey = key
    for (const listener of listeners) {
      try {
        listener(list)
      } catch (error) {
        rt.warn('ds-bot: a DSH bot listener failed: %s', error?.message ?? error)
      }
    }
  }
  // The DSH bot or the tasks record a Session belongs to; Bot and group Sessions get undefined.
  const agentOf = sessionId => state.agents[sessionIndex.get(sessionId)]

  // A DSH bot or task Session must not offer the team tools: its agent sees only the
  // global dsh surface minus this plugin's registrations. A Session whose deny
  // has not landed yet (schemas not up, restrict hook missing, a transient
  // throw) stays on the retry list until it sticks or the Session leaves.
  const restricted = new WeakSet()
  // Per Session, the disposer of its team-tools restriction: adopting the DSH bot gives
  // those tools back to the Session that becomes a Bot, without a restart.
  /** @type {Map<string, () => void>} */
  const restrictionLifts = new Map()
  const RETRY_MS = 5_000
  const pendingRestrict = new Set()
  let retryTimer
  const stopRetry = () => {
    if (retryTimer !== undefined) clearInterval(retryTimer)
    retryTimer = undefined
  }
  ctx.effect(() => stopRetry, 'ds-bot: agent tool restrict retry')
  const scheduleRetry = (agent) => {
    pendingRestrict.add(agent)
    if (retryTimer === undefined) {
      retryTimer = setInterval(() => {
        for (const waiting of [...pendingRestrict]) void restrictTeamTools(waiting)
        if (pendingRestrict.size === 0) stopRetry()
      }, RETRY_MS)
      retryTimer.unref?.()
    }
  }
  const restrictTeamTools = async (agent) => {
    if (agent === undefined || restricted.has(agent)) return
    if (agentOf(agent.session?.id) === undefined) {
      pendingRestrict.delete(agent)
      return
    }
    // Unknown names make restrict() throw, so only deny what this profile serves.
    const known = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
    // A Bot's own browser (browser-plugins.js) is the team's too: its tools answer Bots only.
    const deny = [...TEAM_TOOLS, ...rt.browserToolNames ?? []].filter(name => known.has(name))
    // An empty list can mean the schemas are not up yet, and a missing restrict
    // hook means the Agent is still being put together; both retry.
    if (deny.length === 0 || typeof agent.ctx?.tools?.restrict !== 'function') {
      scheduleRetry(agent)
      return
    }
    try {
      const lift = agent.ctx.tools.restrict({ deny })
      restricted.add(agent)
      pendingRestrict.delete(agent)
      if (typeof lift === 'function' && agent.session?.id !== undefined) restrictionLifts.set(agent.session.id, lift)
    } catch (error) {
      rt.warn('ds-bot: team tools stay visible to DSH bot Session %s: %s', agent.session?.id, error)
      scheduleRetry(agent)
    }
  }
  // The team tools a DSH bot Session had denied become available again when it is adopted
  // into a Bot. A Session with no live agent has no restriction to lift.
  const liftRestriction = (sessionId, agent) => {
    const lift = restrictionLifts.get(sessionId)
    restrictionLifts.delete(sessionId)
    if (agent !== undefined) restricted.delete(agent)
    if (lift === undefined) return
    try {
      lift()
    } catch (error) {
      rt.warn('ds-bot: the team tools of the adopted Session %s stay hidden until DSH restarts: %s', sessionId, error)
    }
  }
  // Fires when a root Session resolves its agent, including sessions saved earlier.
  ctx.on('agent/created', ({ agent }) => {
    void rt.load()
      .then(() => restrictTeamTools(agent))
      .catch(error => rt.warn('ds-bot: tool restrict on agent/created failed: %s', error))
  })

  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly)
  }
  const record = (agentId) => {
    const agent = rt.own(state.agents, agentId)
    if (agent === undefined) throw refusal('Unknown DSH bot')
    if (agent.pendingCreation === true && !activeCreations.has(agent.id)) throw refusal('DSH team member creation failed; cleanup is pending')
    if (agent.adoptedBotId !== undefined) throw refusal('This DSH bot is adopted; use its Bot chat or roll back adoption first')
    return agent
  }

  // A Session of a DSH bot starts in its folder with its preset; a task's comes from the caller.
  function createAgentSession(agentId, workspaceId, options, creation) {
    const launch = state.agents?.[agentId]?.kind === TASKS ? taskLaunch(options?.botId) : undefined
    const allocate = () => allocateAgentSession(agentId, workspaceId, options, creation, launch)
    return launch === undefined ? allocate() : settleTaskAllocation(launch, allocate)
  }

  async function allocateAgentSession(agentId, workspaceId, options = {}, creation, launch) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      let agent = record(agentId)
      if (launch !== undefined) launch.agent = agent
      if (agent.kind === DSH_BOT) {
        if (agent.workDir !== undefined && !(await rt.isFolder(agent.workDir))) throw refusal(`The folder ${agent.workDir} of ${agent.name} is gone. Pick another in its settings.`)
        options = { cwd: agent.workDir, agentPreset: agent.profile }
      }
      const { cwd, agentPreset, botId, readScopeSource } = options
      // A folder of its own (a task's `cwd`) makes the Session by cwd alone, outside every
      // DSH workspace, as a Bot's working folder does. Otherwise a known workspace id wins
      // (the Agent's latest Session may live outside the team workspace after a workspace
      // switch); anything else gets the team's own.
      const own = typeof cwd === 'string' && isAbsolute(cwd) && await rt.isFolder(cwd)
      if (cwd !== undefined && !own) rt.warn('ds-bot: the task folder %s is not an absolute path to a folder; the task starts in the team workspace', cwd)
      const place = own
        ? { cwd }
        : { workspaceId: typeof workspaceId === 'string' && ctx.workspaceRegistry.get(workspaceId) ? workspaceId : await rt.ensureWorkspace() }
      const preset = await servedPreset(agentPreset)
      const scopeReservation = readScopeSource === undefined ? undefined : await rt.reserveReadScope(readScopeSource)
      if (launch !== undefined) launch.scopeId = scopeReservation
      const reserved = scopeReservation ?? creation?.reservedSessionId
      rt.assertShellChoice?.(undefined, botId)
      let sessionId
      launch?.check()
      try {
        if (creation !== undefined) creation.started = true
        const created = await ctx.sessionController.create({ ...place, ...(preset ? { agentPreset: preset } : {}), ...(reserved === undefined ? {} : { sessionId: reserved }) })
        sessionId = created.sessionId
        if (launch !== undefined) launch.sessionId = sessionId
        if (scopeReservation !== undefined && sessionId !== scopeReservation) throw refusal('DSH did not use the Session reserved for the file-tool folder.')
      } catch (error) {
        // Native creation can allocate and then fail workspace attachment.
        const actual = error?.code === 'session/workspace-attach-failed' ? error.details?.sessionId : undefined
        if (launch !== undefined && typeof actual === 'string') launch.sessionId = actual
        if (creation !== undefined) await publishCreation(creation, 'failed', actual)
        throw error
      }
      if (creation === undefined) {
        if (launch !== undefined) launch.joined = !agent.sessions.includes(sessionId)
        agent.sessions.push(sessionId)
      } else {
        await publishCreation(creation, 'created', sessionId)
        // A terminal allocation is not permission to finish adoption. A successor
        // may already have consumed this operation or durably claimed its cleanup.
        await rt.refresh()
        agent = currentCreation(creation)
        await rt.save({ required: true })
        agent = currentCreation(creation)
        checkCreationSession(creation, sessionId)
        agent.sessions = [sessionId]
      }
      await rt.save({ required: creation !== undefined })
      // agent/created fired before the session joined the index, so restrict again now.
      await restrictTeamTools(await rt.resolveAgent(sessionId))
      launch?.check()
      return sessionId
    } finally { leave() }
  }

  // A root Session the user opened from a DSH bot page (the hero's workspace
  // picker or a fork) is adopted into the same Agent: it keeps dsh's surface and
  // the team tools stay hidden.
  async function adoptAgentSession(agentId, sessionId) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      const agent = record(agentId)
      if (agent.sessions.includes(sessionId)) return sessionId
      await rt.resolveAgent(sessionId)
      const owned = rt.selfOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined
        || rt.roomOf(sessionId) !== undefined || agentOf(sessionId) !== undefined
      if (owned) throw refusal('Session already belongs to the team')
      agent.sessions.push(sessionId)
      // A deleted Bot's or group's Session in use again keeps its composer state.
      rt.unlistDraftSweep?.([sessionId])
      await rt.save()
      await restrictTeamTools(await rt.resolveAgent(sessionId))
      return sessionId
    } finally { leave() }
  }

  // A DSH bot's name, folder and preset, checked: a folder that exists outside DSH's data
  // (undefined: the team workspace), and a preset this DSH serves (undefined: DSH's default).
  async function dshBotFields({ name, workDir, profile } = {}, id) {
    const clean = String(name ?? '').trim().slice(0, DSH_BOT_NAME_MAX)
    if (clean === '') throw refusal('A DSH bot needs a name')
    const taken = dshBots().some(agent => agent.id !== id && agent.name.toLowerCase() === clean.toLowerCase())
    if (taken) throw refusal(`A DSH bot named ${clean} already exists`)
    const folder = await rt.cleanWorkDir(String(workDir ?? ''))
    const preset = typeof profile === 'string' && profile !== '' ? await servedPreset(profile, { strict: true }) : undefined
    return { name: clean, workDir: folder, profile: preset }
  }
  const setFields = (agent, fields) => {
    agent.name = fields.name
    for (const key of ['workDir', 'profile']) {
      if (fields[key] === undefined) delete agent[key]
      else agent[key] = fields[key]
    }
  }

  // A failed opt-in creation remains owned but is never advertised as a usable
  // standalone bot. Reserve its Session identity durably before asking DSH to
  // allocate it, so even disposal during create leaves a discoverable retry.
  const activeCreations = new Set()
  const creationOf = agent => ({ token: agent.creationToken, agentId: agent.id, reservedSessionId: agent.creationSessionId })
  const creationPath = (creation) => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(creation.token ?? '')) throw refusal('Missing or invalid creation receipt token')
    return join(rt.home, 'agent-creations', `${creation.token}.json`)
  }
  const validReceipt = (receipt, creation) => typeof creation.agentId === 'string' && creation.agentId.length > 0
    && typeof creation.reservedSessionId === 'string' && creation.reservedSessionId.length > 0
    && receipt?.version === 1 && receipt.token === creation.token
    && receipt.agentId === creation.agentId && receipt.reservedSessionId === creation.reservedSessionId
    && (receipt.outcome === 'created' || receipt.outcome === 'failed')
    && (receipt.sessionId === undefined ? receipt.outcome === 'failed' : typeof receipt.sessionId === 'string' && receipt.sessionId.length > 0)
  const readCreation = async (creation) => {
    const receipt = JSON.parse(await readFile(creationPath(creation), 'utf8'))
    if (!validReceipt(receipt, creation)) throw refusal('Creation receipt does not match this operation')
    return receipt
  }
  async function publishCreation(creation, outcome, sessionId) {
    creation.publishAttempted = true
    const receipt = { version: 1, token: creation.token, agentId: creation.agentId, reservedSessionId: creation.reservedSessionId, outcome, ...(sessionId === undefined ? {} : { sessionId }) }
    if (!validReceipt(receipt, creation)) throw refusal('Invalid terminal creation receipt')
    const path = creationPath(creation)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(join(rt.home, 'agent-creations'), { recursive: true, mode: 0o700 })
      await writeFile(temp, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
      try {
        // Publish a complete immutable fact, never overwrite another receipt.
        // This operation alone is producer-owned even after team writer loss.
        await link(temp, path)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existing = await readCreation(creation)
        if (existing.outcome !== outcome || existing.sessionId !== sessionId) throw refusal('Conflicting terminal creation receipt')
      }
    } catch (error) {
      throw refusal(`Terminal creation receipt could not be published: ${error?.message ?? error}`, { cause: error })
    } finally {
      await unlink(temp).catch(error => { if (error?.code !== 'ENOENT') rt.warn('ds-bot: creation receipt temp cleanup failed: %s', error) })
    }
  }
  const discardCreation = async (creation) => {
    await unlink(creationPath(creation)).catch(error => { if (error?.code !== 'ENOENT') rt.warn('ds-bot: creation receipt cleanup failed: %s', error) })
  }
  const currentCreation = (creation, { cleanup = false } = {}) => {
    const agent = state.agents[creation.agentId]
    if (agent?.pendingCreation !== true || agent.creationToken !== creation.token || agent.creationSessionId !== creation.reservedSessionId
      || (!cleanup && agent.creationCleanup === true)) throw refusal('This creation operation is no longer current or its cleanup was claimed')
    return agent
  }
  const checkCreationSession = (creation, sessionId) => {
    const owner = agentOf(sessionId)
    if ((owner !== undefined && owner.id !== creation.agentId) || rt.botOf(sessionId) !== undefined || rt.selfOf(sessionId) !== undefined || rt.roomOf(sessionId) !== undefined) throw refusal('The allocated Session already belongs to another team identity')
  }
  async function cleanupCreation(original) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      const creation = creationOf(original)
      // Re-read canonical state before saving anything: the producer may have lost
      // and regained the lock after a successor already consumed this operation.
      await refresh()
      let agent = currentCreation(creation, { cleanup: true })
      const receipt = await readCreation(creation)
      await rt.save({ required: true })
      agent = currentCreation(creation, { cleanup: true })
      const sessionId = receipt.sessionId ?? creation.reservedSessionId
      checkCreationSession(creation, sessionId)
      agent.sessions = [sessionId]
      agent.creationCleanup = true
      // Claim cleanup durably before external archival; an old producer must never
      // adopt this Session even if the post-archive deletion save later fails.
      await rt.save({ required: true })
      try {
        await ctx.workspaceRegistry.archiveSession(sessionId)
      } catch (error) {
        // A matching terminal receipt proves absence is no longer a producer race.
        if (error?.name !== 'WorkspaceUnknownSessionError' || error.sessionId !== sessionId) throw error
      }
      agent = currentCreation(creation, { cleanup: true })
      const agents = state.agents
      delete agents[agent.id]
      try {
        await rt.save({ required: true })
      } catch (error) {
        if (state.agents === agents && agents[agent.id] === undefined) agents[agent.id] = agent
        rt.indexSessions()
        throw error
      }
      await discardCreation(creation)
    } finally { leave() }
  }
  const load = rt.load
  const refresh = rt.refresh
  let recovering
  const recoverCreations = async () => {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      if (recovering !== undefined) return await recovering
      const pending = Object.values(state.agents).filter(agent => agent.pendingCreation === true && !activeCreations.has(agent.id))
      if (pending.length === 0) return
      recovering = (async () => {
        for (const agent of pending) {
          try {
            await cleanupCreation(agent)
          } catch (error) {
            rt.warn('ds-bot: creation cleanup pending for %s: %s', agent.id, error)
          }
        }
      })()
      try { await recovering } finally { recovering = undefined }
    } finally { leave() }
  }
  rt.load = async () => { await load(); await recoverCreations(); await recoverTaskStarts() }
  // Some later modules memoize load for their own startup. Refresh remains the
  // request lifecycle retry point after writer authority or archival recovers.
  rt.refresh = async () => { await refresh(); await recoverCreations(); await recoverTaskStarts() }

  async function addAgent(fields) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      let agent = { id: randomUUID(), kind: DSH_BOT, sessions: [], createdAt: Date.now() }
      setFields(agent, await dshBotFields(fields))
      const teamMember = fields?.teamMember === true
      const creation = teamMember ? { token: randomUUID(), agentId: agent.id, reservedSessionId: `session-${randomUUID()}` } : undefined
      if (teamMember) {
        agent.pendingCreation = true
        agent.creationToken = creation.token
        agent.creationSessionId = creation.reservedSessionId
        agent.sessions = [creation.reservedSessionId]
      }
      state.agents[agent.id] = agent
      activeCreations.add(agent.id)
      try {
        if (teamMember) await rt.save({ required: true })
        await createAgentSession(agent.id, undefined, {}, creation)
        if (teamMember) agent = currentCreation(creation)
        // The UI creates a native DSH team member immediately. Legacy plugin callers
        // keep the standalone DSH registration/session API unless they opt in.
        if (teamMember) {
          await adoptAsBot(agent.id)
          await discardCreation(creation)
        }
      } catch (caught) {
        let error = caught
        if (teamMember) {
          // No external invocation began, so this producer can attest no allocation.
          // Never retry publication after a failed attempt or after consumption.
          if (!creation.started && !creation.publishAttempted) {
            try { await publishCreation(creation, 'failed') } catch (receiptError) { error = new Error(`${error?.message ?? error}; ${receiptError.message}`, { cause: error }) }
          }
          if (state.agents[agent.id]?.creationToken !== creation.token) throw error
          try {
            await cleanupCreation(agent)
          } catch (cleanupError) {
            rt.indexSessions()
            throw refusal(`DSH team member creation failed: ${error?.message ?? error}. Cleanup pending for ${agent.id}: ${cleanupError?.message ?? cleanupError}; it will retry on the next load.`, { cause: error })
          }
        } else {
          // Preserve the legacy standalone creation contract.
          const createdSessions = [...agent.sessions]
          delete state.agents[agent.id]
          rt.indexSessions()
          for (const sessionId of createdSessions) await ctx.workspaceRegistry.archiveSession(sessionId).catch(() => {})
          await rt.save({ required: true }).catch(() => {})
        }
        throw error
      } finally {
        activeCreations.delete(agent.id)
      }
      return agent
    } finally { leave() }
  }

  // A new name, folder or preset applies to the Sessions made after it; the others keep theirs.
  async function updateAgent(agentId, fields) {
    writeCheck()
    const agent = record(agentId)
    if (agent.kind !== DSH_BOT) throw refusal('Unknown DSH bot')
    setFields(agent, await dshBotFields(fields, agent.id))
    await rt.save()
    return agent
  }

  async function archiveRecordedSession(sessionId, options) {
    try {
      if (options === undefined) await ctx.workspaceRegistry.archiveSession(sessionId)
      else await ctx.workspaceRegistry.archiveSession(sessionId, options)
    } catch (error) {
      // An owned reference can outlive its DSH Session. Only DSH's explicit absence
      // error for this exact Session permits dropping it; storage and active-Session
      // failures must keep the reference and its restriction for a later retry.
      if (error?.name !== 'WorkspaceUnknownSessionError' || error.sessionId !== sessionId) throw error
    }
  }

  async function archiveAgentSession(agentId, sessionId) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      const agent = record(agentId)
      if (!agent.sessions.includes(sessionId)) throw refusal('Session does not belong to the DSH bot')
      // Archive first: the Session leaves the Agent only once it is actually gone,
      // so a failed archive stays retryable and keeps its tool restriction.
      await archiveRecordedSession(sessionId)
      agent.sessions = agent.sessions.filter(id => id !== sessionId)
      restrictionLifts.delete(sessionId)
      await rt.save()
    } finally { leave() }
  }

  async function renameAgentSession(agentId, sessionId, title) {
    writeCheck()
    const agent = record(agentId)
    if (!agent.sessions.includes(sessionId)) throw refusal('Session does not belong to the DSH bot')
    const clean = String(title ?? '').trim()
    if (clean === '') throw refusal('A session needs a title')
    const agent_ = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent_.session, clean.slice(0, AGENT_SESSION_TITLE_MAX))
  }

  async function removeAgent(agentId) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      const agent = record(agentId)
      const sessions = [...agent.sessions]
      const kept = []
      let failure
      for (const sessionId of sessions) {
        try {
          await archiveRecordedSession(sessionId)
          restrictionLifts.delete(sessionId)
        } catch (error) {
          failure ??= error
          kept.push(sessionId)
        }
      }
      // What could not be archived stays with the DSH bot, so it keeps its tool
      // restriction and the removal can be retried from the same place.
      if (kept.length > 0) {
        agent.sessions = kept
        await rt.save()
        throw failure
      }
      delete state.agents[agentId]
      await rt.save()
    } finally { leave() }
  }

  // Adoption adds a team membership to the DSH identity, not a replacement identity.
  // Its newest Session is the own chat and earlier ones remain readable parts. Keep
  // the original registration for undo, preserve native preset/appearance/capabilities,
  // and lift only our team-tool restrictions after the membership is safely saved.
  async function adoptAsBot(agentId) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      const agent = record(agentId)
      if (agent.kind !== DSH_BOT) throw refusal('Only a DSH bot can become a Bot')
      const sessions = [...(agent.sessions ?? [])]
      if (sessions.length === 0) throw refusal('The DSH bot has no Session to adopt first')
      const name = String(agent.name ?? '').trim().slice(0, DSH_BOT_NAME_MAX)
      const problem = nameProblem(name)
      if (problem !== undefined) throw refusal(problem)
      // No Bot takes another Bot's name: the user renames the DSH bot first.
      if (rt.findBot(name) !== undefined) throw refusal(`A Bot named ${name} already exists`)
      const chatId = sessions.at(-1)
      // A Session DSH can no longer open is refused before anything moves; the resolved
      // agent is the one whose team-tools restriction adoption lifts below.
      const before = JSON.stringify(agent)
      const live = await rt.resolveAgent(chatId)
      if (agent.pendingCreation === true) {
        const creation = creationOf(agent)
        await readCreation(creation)
        await rt.refresh()
        if (currentCreation(creation) !== agent) throw refusal('The creation operation changed during membership resolution')
        await rt.save({ required: true })
        if (currentCreation(creation) !== agent) throw refusal('The creation operation changed before membership persistence')
      }
      if (state.agents[agentId] !== agent || JSON.stringify(agent) !== before) throw refusal('The DSH bot changed during adoption; try again')
      if (agent.adoptedBotId !== undefined || rt.findBot(name) !== undefined || rt.botOf(chatId) !== undefined) throw refusal('The DSH bot or name is already adopted')
      const earlier = sessions.slice(0, -1)
      // DSH's persisted request header is also the fresh-part route source (parts.js).
      const route = live.session?.requestHeader?.()?.config
      const now = Date.now()
      rt.dropGrantsForBot?.(chatId)
      rt.endGrants?.(sessions, 'part')
      state.bots[chatId] = {
        ...(route?.provider && route?.model ? { model: `${route.provider}/${route.model}` } : {}),
        ...(route?.reasoningEffort ? { effort: route.reasoningEffort } : {}),
        ...agent,
        id: chatId,
        dshAgentId: agentId,
        kind: DSH_BOT,
        name,
        role: '',
        instructions: '',
        ...(typeof agent.workDir === 'string' && agent.workDir !== '' ? { workDir: agent.workDir } : {}),
        ...(agent.pinned === true ? { pinned: true } : {}),
        createdAt: agent.createdAt ?? now,
        createdBy: null,
        capabilities: [...(agent.capabilities ?? [])],
        // The DSH bot's other Sessions stay readable as the Bot's earlier parts.
        ...(earlier.length === 0 ? {} : { segments: earlier.map(sessionId => ({ sessionId, endedAt: now })) }),
      }
      // Keep the original registration intact for rollback, but out of the standalone
      // roster and restriction index. Only persist before changing live tool access.
      delete state.bots[chatId].sessions
      const adopted = state.bots[chatId]
      const avatar = displayAvatar(adopted)
      if (avatar === undefined) delete adopted.avatar
      else adopted.avatar = avatar
      // A Solver's review fields are the New Solver dialog's and the person's: an adopted record
      // carries none of them, so no adopted Bot is held with no reviewer (RFC 0048 delivery 1.5).
      for (const key of ['reviewGuard', 'reviewerId', 'reviewGuardNotice', 'guardOffNotice', 'reviewTrack', 'waitingRole', 'reviewerMade']) delete state.bots[chatId][key]
      const creationFields = {}
      for (const key of ['pendingCreation', 'creationToken', 'creationSessionId', 'creationCleanup']) {
        delete state.bots[chatId][key]
        if (agent[key] !== undefined) creationFields[key] = agent[key]
        delete agent[key]
      }
      agent.adoptedBotId = chatId
      try {
        await rt.save({ required: true })
      } catch (error) {
        delete state.bots[chatId]
        rt.dropGrantsForBot?.(chatId)
        delete agent.adoptedBotId
        Object.assign(agent, creationFields)
        rt.indexSessions()
        await rt.save({ required: true }).catch(() => {})
        throw error
      }
      for (const sessionId of sessions) {
        const resolved = sessionId === chatId ? live : await rt.resolveAgent(sessionId).catch(() => undefined)
        liftRestriction(sessionId, resolved)
      }
      return { botId: chatId }
    } finally { leave() }
  }

  // The native workspace picker creates/reuses a root Session without a preset.
  // Associate that exact destination with an adopted Bot, never allocate a replacement.
  const associations = new Set()
  const associationTargets = new Set()
  async function adoptBotSession(botId, sessionId, sourceSessionId) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      rt.assertShellChoice?.(undefined, botId)
      const bot = rt.own(state.bots, botId)
      const original = rt.own(state.agents, bot?.dshAgentId)
      // Every refusal names the Bot and the Session in the message the person sees, and its
      // own code so the UI can tell the three eligibility checks apart. It also keeps a host
      // diagnostics entry with those fields: the channel exposes a `bot/`-coded message but
      // only notes an unclassified error, which leaves nothing but a stack location.
      const name = typeof bot?.name === 'string' && bot.name.trim() !== '' ? bot.name.trim() : undefined
      const sessionText = typeof sessionId === 'string' && sessionId !== ''
        ? sessionId
        : sessionId === undefined ? '(missing)' : String(sessionId).slice(0, 80)
      const botLabel = name === undefined
        ? `Bot ${typeof botId === 'string' && botId !== '' ? botId : '(unknown)'}`
        : `Bot "${name}"`
      const sessionLabel = `Session ${sessionText}`
      const sourceText = typeof sourceSessionId === 'string' && sourceSessionId !== '' ? sourceSessionId : '(missing)'
      const refuse = (code, message, { cause } = {}) => {
        rt.noteFailure?.({
          source: 'api',
          text: message,
          code,
          bot: name ?? (typeof botId === 'string' && botId !== '' ? botId : undefined),
          where: `bot-session-adopt (${sessionLabel})`,
          sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined,
        })
        throw refusal(message, { code, cause })
      }
      // A read-only host is the first refusal, under its own code like the others (#877): the
      // store's reason names who holds the team and what to do. The endpoint refuses a host that
      // already was read-only; this one became so since (another dsh took the team).
      const writable = () => {
        const readOnly = rt.readOnly()
        if (readOnly !== undefined) refuse('bot/adopt-read-only', `${sessionLabel} cannot join ${botLabel} because this window cannot change the Bot team now. ${readOnly}`)
      }
      writable()
      if (bot?.kind !== DSH_BOT || original?.kind !== DSH_BOT || original.adoptedBotId !== botId) {
        refuse('bot/adopt-unknown', `${botLabel} is not an adopted DSH Bot, so ${sessionLabel} cannot join it. Open the Bot from the team list and try again.`)
      }
      if (typeof sessionId !== 'string' || sessionId === '' || typeof sourceSessionId !== 'string') {
        refuse('bot/adopt-invalid-transition', `${botLabel} cannot change to ${sessionLabel}: the request needs a valid Session id and the id of the Bot's current part. Pick the project Session again.`)
      }
      if (rt.chatOf(botId) === sessionId && (bot.segments ?? []).some(part => part.sessionId === sourceSessionId)) return sessionId
      if (associations.has(botId) || associationTargets.has(sessionId)) {
        refuse('bot/adopt-pending', `A Bot Session transition is already pending for ${botLabel}, so ${sessionLabel} cannot join it yet. Wait for the current change to finish, then try again.`)
      }
      const before = JSON.stringify(bot)
      const registration = JSON.stringify(original)
      // The native preset this adopt selected on the picked Session, once it has. A later refusal
      // leaves it there, so "Nothing was changed" is said of the team and the selection is named
      // (#877), unless the Session reads the preset it had before.
      let selected
      const untouched = () => {
        const now = selected === undefined ? undefined : ctx.get('agentPresets')?.presetForSession?.(selected.session)
        if (selected === undefined || (selected.from !== undefined && now === selected.from)) return 'Nothing was changed; try again.'
        return `For the Bot team: Nothing was changed; try again. The native preset of ${sessionLabel} was set to "${selected.to}" before this refusal.`
      }
      const validate = () => {
        writable()
        if (state.bots[botId] !== bot || state.agents[bot.dshAgentId] !== original
          || JSON.stringify(bot) !== before || JSON.stringify(original) !== registration
          || rt.chatOf(botId) !== sourceSessionId) {
          refuse('bot/adopt-changed', `${botLabel} changed while ${sessionLabel} was joining it (another window or an edit). ${untouched()}`)
        }
        if (rt.selfOf(sessionId) !== undefined || rt.botOf(sessionId) !== undefined
          || rt.roomOf(sessionId) !== undefined || agentOf(sessionId) !== undefined
          || state.tasks?.[sessionId] !== undefined) {
          refuse('bot/adopt-in-team', `${sessionLabel} already belongs to the team (a Bot, group chat, task, or DSH bot), so it cannot join ${botLabel}. Open a new blank Session or a fork of this Bot instead.`)
        }
      }
      associations.add(botId)
      associationTargets.add(sessionId)
      try {
        validate()
        const live = await rt.resolveAgent(sessionId)
        validate()
        const session = live.session
        const eligible = () => {
          const header = session?.header
          if (session?.id !== sessionId || header === undefined || header.origin === 'subagent'
            || (header.delegationDepth ?? 0) > 0) {
            refuse('bot/adopt-root', `${sessionLabel} is not a root Session (it is a subagent, delegated, or owned by another Session), so it cannot join ${botLabel}. Open the project's own root Session instead.`)
          }
          // dsh 0.2.2 deprecates ctx.sessionProjections.stateOf(session, key); the agent
          // registry exposes it directly. The optional service needs an explicit lookup.
          let agents
          try { agents = ctx.get?.('agents') } catch {}
          let boundary
          try {
            if (agents === undefined) agents = ctx.agents
            boundary = agents?.turnBoundaryOf?.(session)
          } catch {
            boundary = undefined
          }
          const blank = boundary !== undefined && boundary.openTurnStartSeq === null && boundary.lastTurn === 0
          const fork = header.parentSession === sourceSessionId && header.isSeeded === true
          if (!blank && !fork) {
            refuse('bot/adopt-not-blank', `${sessionLabel} is neither blank nor a fork of the current part of ${botLabel} (Session ${sourceText}), so the Session cannot join that Bot. Start a new Session in the project or fork the Bot's current chat.`)
          }
        }
        eligible()
        let preset
        try {
          preset = await servedPreset(bot.profile, { strict: true })
        } catch (error) {
          refuse('bot/adopt-preset-unavailable', `The preset ${bot.profile} is not available in this DSH, so ${sessionLabel} cannot join ${botLabel}. Choose an available preset in the Bot's settings, then try again.`, { cause: error })
        }
        validate()
        eligible()
        if (preset !== undefined && ctx.get('agentPresets')?.presetForSession?.(session) !== preset) {
          const presets = ctx.get('agentPresets')
          if (typeof presets?.select !== 'function') {
            refuse('bot/adopt-preset-unavailable', `${botLabel} needs the native preset "${preset}" for ${sessionLabel}, but native preset selection is unavailable in this DSH. Update DSH or pick a Session already on that preset.`)
          }
          const from = presets.presetForSession?.(session)
          await presets.select(live, preset)
          selected = { session, from, to: preset }
          await ctx.sessions.flush(session)
        }
        validate()
        eligible()
        const persisted = ctx.get('agentPresets')?.presetForSession?.(session)
        if (preset !== undefined && persisted !== preset) {
          refuse('bot/adopt-preset-not-persisted', `${botLabel} could not keep the native preset "${preset}" for ${sessionLabel}, so the Session did not join that Bot. Try again, or pick a Session already on that preset.`)
        }
        const previous = { sessionId: bot.sessionId, segments: bot.segments }
        rt.endGrants?.([previous.sessionId ?? botId, sourceSessionId, sessionId], 'part')
        bot.segments = [...(bot.segments ?? []), { sessionId: sourceSessionId, endedAt: Date.now() }]
        bot.sessionId = sessionId
        try {
          await rt.save({ required: true })
          if (state.bots[botId] !== bot || bot.sessionId !== sessionId || state.agents[bot.dshAgentId] !== original
            || JSON.stringify(original) !== registration) {
            refuse('bot/adopt-changed-persisting', `${botLabel} changed while ${sessionLabel} was being saved. ${untouched()}`)
          }
        } catch (error) {
          // Undo only this operation's tentative ownership; do not erase a successor.
          if (state.bots[botId] === bot && bot.sessionId === sessionId) {
            rt.endGrants?.([previous.sessionId ?? botId, sourceSessionId, sessionId], 'part')
            if (previous.sessionId === undefined) delete bot.sessionId
            else bot.sessionId = previous.sessionId
            if (previous.segments === undefined) delete bot.segments
            else bot.segments = previous.segments
            rt.indexSessions()
            await rt.save({ required: true }).catch(() => {})
          }
          // A save that failed because this host lost the team meanwhile (refused before the
          // write, or the store's ELOCKLOST during it) is the read-only refusal, not an unnamed
          // error; this adopt's own refusals and any other failed save stay as they were.
          if (!String(error?.code ?? '').startsWith('bot/')) writable()
          throw error
        }
        return sessionId
      } finally {
        associations.delete(botId)
        associationTargets.delete(sessionId)
      }
    } finally { leave() }
  }

  // Rollback gives the original its Sessions back as they were, so it is possible only
  // while the adopted Bot's parts are still exactly those Sessions: a New conversation
  // adds a part and ends it. The view (channel.js) reports this same check per adopted
  // Bot, so the menu offers rollback only then; a missing or mismatched original is false.
  function adoptionHistoryMatches(botId) {
    const bot = rt.own(state.bots, botId)
    const original = rt.own(state.agents, bot?.dshAgentId)
    if (original === undefined || original.adoptedBotId !== bot.id) return false
    const parts = [ ...(bot.segments ?? []).map(part => part.sessionId), rt.chatOf(bot.id) ]
    return JSON.stringify(parts) === JSON.stringify(original.sessions)
  }

  // An explicit, non-destructive undo, not deleteBot (which archives conversations).
  // Refuse after new team history is created rather than silently discarding it.
  async function rollbackAdoption(agentId) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      writeCheck()
      const original = rt.own(state.agents, agentId)
      const bot = state.bots[original?.adoptedBotId]
      if (bot?.dshAgentId !== agentId) throw refusal('No adoption to roll back')
      if (rt.isMain(bot.id) || Object.values(state.rooms).some(room => room.members.includes(bot.id))
        || !adoptionHistoryMatches(bot.id)
        || Object.values(state.tasks ?? {}).some(task => task.from === bot.id)) {
        throw refusal('Remove Main Bot/group roles and resolve new team history before rolling back adoption')
      }
      const generation = rt.teamGeneration()
      delete state.bots[bot.id]
      rt.dropGrantsForBot?.(bot.id)
      delete original.adoptedBotId
      try {
        await rt.save({ required: true })
      } catch (error) {
        if (!rt.canRestoreTeamInMemory(generation) || rt.own(state.agents, agentId) !== original
          || rt.botOf(bot.id) !== undefined || (bot.reviewGuard === true && rt.groupsOf(bot.id).length > 0)) throw error
        state.bots[bot.id] = bot
        rt.dropGrantsForBot?.(bot.id)
        original.adoptedBotId = bot.id
        rt.indexSessions()
        if (rt.sameTeam(generation)) await rt.save({ required: true }).catch(() => {})
        throw error
      }
      for (const sessionId of original.sessions) await restrictTeamTools(await rt.resolveAgent(sessionId))
      return { agentId }
    } finally { leave() }
  }

  // The tasks record, made when the first task starts.
  async function ensureTasks() {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      const existing = tasksRecord()
      if (existing !== undefined) return existing
      writeCheck()
      const agent = { id: randomUUID(), kind: TASKS, name: AGENT_NAME, sessions: [], createdAt: Date.now() }
      state.agents[agent.id] = agent
      await rt.save()
      return agent
    } finally { leave() }
  }

  // The DSH agent presets this DSH serves unbroken, for the DSH bot form.
  async function presets() {
    try {
      return ((await ctx.get?.('agentPresets')?.list?.()) ?? []).filter(preset => preset.broken === undefined)
        .map(preset => ({ id: preset.id, name: preset.name ?? preset.id, ...(preset.description ? { description: preset.description } : {}) }))
    } catch {
      return []
    }
  }
  // A DSH agent preset by id, when this DSH serves it unbroken; anything else is DSH's
  // default, or refused when `strict`.
  async function servedPreset(id, { strict = false } = {}) {
    if (typeof id !== 'string' || id === '') return undefined
    if ((await presets()).some(preset => preset.id === id)) return id
    if (strict) throw refusal(`The preset ${id} is not available in this DSH`)
    rt.warn('ds-bot: the agent preset %s is not served here; the task takes DSH\'s default', id)
    return undefined
  }

  // A fresh task Session with a title; automations that run "a new DSH session" use it too.
  // Another plugin may give it a folder (`cwd`) and a DSH agent preset of its own.
  function createTaskSession(title, options) {
    const launch = taskLaunch(options?.botId)
    return settleTaskAllocation(launch, () => allocateTaskSession(title, options, launch))
  }

  function taskLaunch(from, admission) {
    // Capture the executor's identity before any await. The independent host API's
    // `from` is for attribution and cannot stand in for the actual caller.
    const callerSessionId = rt.callerSessionId?.()
    const callerBotId = rt.callerBotId?.()
    return {
      admission,
      check() {
        const current = callerSessionId === undefined ? undefined : rt.botOfSession?.(callerSessionId)?.id
        assertTaskGuard(callerBotId, current, from)
        admission?.check()
      },
    }
  }

  function assertTaskGuard(...ids) {
    for (const id of ids) {
      if (id === undefined) continue
      const held = rt.taskLaunchHold?.(id)
      if (held !== undefined) throw Object.assign(refusal(held.text), { taskStop: held.why })
    }
  }

  const cleaningTaskStarts = new Set()
  const deferredTaskStarts = new Map()
  const canCleanTaskStarts = () => rt.canWriteTeam() && rt.readOnly() === undefined && rt.teamCurrent()
  const claimedSession = (id, agent) => rt.botOf(id) !== undefined || rt.selfOf(id) !== undefined
    || rt.roomOf(id) !== undefined || rt.pastOwners.has(id) || [...rt.agentClaims(id)].some(key => key !== agent?.id)

  async function cleanTaskStart(agent, pending, { persist = false } = {}) {
    const { sessionId, scopeId } = pending
    const key = sessionId ?? scopeId
    if (cleaningTaskStarts.has(key)) return
    cleaningTaskStarts.add(key)
    const leave = rt.enterOwnership?.() ?? (() => {})
    const current = () => canCleanTaskStarts() && state.agents[agent.id] === agent
      && agent.refusedStarts?.includes(pending)
      && (sessionId === undefined || (!claimedSession(sessionId, agent)
        && (state.tasks?.[sessionId] === undefined || state.tasks[sessionId].status === 'failed')))
      && (scopeId === undefined || scopeId === sessionId
        || (!claimedSession(scopeId) && state.tasks?.[scopeId] === undefined))
    try {
      if (!current()) return
      if (persist) {
        // Keep the allocation owned and the cleanup retryable even if archival fails.
        await rt.save({ required: true }).catch(error => rt.warn('ds-bot: saving refused task cleanup failed: %s', error))
        if (!current()) return
      }
      if (sessionId !== undefined) await archiveRecordedSession(sessionId, { stopActivity: true })
      if (!current()) return
      if (scopeId !== undefined) await rt.forgetReadScopes([scopeId])
      if (!current()) return
      const index = agent.sessions.indexOf(sessionId)
      if (index >= 0) agent.sessions.splice(index, 1)
      agent.refusedStarts = agent.refusedStarts.filter(record => record !== pending)
      if (agent.refusedStarts.length === 0) delete agent.refusedStarts
      try {
        await rt.save({ required: true })
      } catch (error) {
        if (state.agents[agent.id] === agent) {
          (agent.refusedStarts ??= []).push(pending)
          if (index >= 0 && !agent.sessions.includes(sessionId)) agent.sessions.splice(index, 0, sessionId)
          rt.indexSessions()
        }
        throw error
      }
      restrictionLifts.delete(sessionId)
    } catch (error) {
      rt.warn('ds-bot: cleanup pending for refused task %s: %s', key, error)
    } finally {
      leave()
      cleaningTaskStarts.delete(key)
    }
  }

  async function recoverTaskStarts() {
    if (rt.readOnly() !== undefined) return
    for (const agent of Object.values(state.agents)) {
      if (agent.kind !== TASKS || !Array.isArray(agent.refusedStarts)) continue
      for (const pending of agent.refusedStarts) await cleanTaskStart(agent, pending)
    }
    for (const [launch, summary] of deferredTaskStarts) await recordRefusedTaskStart(launch, summary)
  }

  async function recordRefusedTaskStart(launch, summary) {
    if (!canCleanTaskStarts()) return
    deferredTaskStarts.delete(launch)
    const { agent: original, sessionId, scopeId } = launch
    const agent = rt.own(state.agents, original.id)
    // The persisted Tasks identity survives a same-team adoption. A different
    // record or a Session already claimed by a successor gives no authority.
    if (agent?.kind !== TASKS || agent.createdAt !== original.createdAt
      || (agent !== original && !rt.holdsLock())) return
    const task = state.tasks?.[sessionId]
    const keepSession = sessionId !== undefined && (claimedSession(sessionId, agent)
      || (task !== undefined && task !== launch.task)
      || (agent.sessions.includes(sessionId) && (agent !== original || !launch.joined)))
    const keepScope = scopeId !== undefined && (scopeId === sessionId ? keepSession
      : claimedSession(scopeId) || state.tasks?.[scopeId] !== undefined)
    const pending = { sessionId: keepSession ? undefined : sessionId, scopeId: keepScope ? undefined : scopeId }
    if (pending.sessionId === undefined && pending.scopeId === undefined) return
    if (pending.sessionId !== undefined) {
      if (task !== undefined) {
        Object.assign(task, { status: 'failed', endedAt: Date.now(), summary })
        rt.endGrants?.(sessionId, 'task')
      }
      if (!agent.sessions.includes(sessionId)) agent.sessions.push(sessionId)
    }
    agent.refusedStarts ??= []
    agent.refusedStarts.push(pending)
    await cleanTaskStart(agent, pending, { persist: true })
  }

  async function settleTaskAllocation(launch, start) {
    try {
      return await start()
    } catch (error) {
      const { agent, sessionId, scopeId } = launch
      if (agent !== undefined && (sessionId !== undefined || scopeId !== undefined)) {
        const reason = String(error?.message ?? error)
        const summary = (launch.admission === undefined ? reason : reason.split('\n')[0]).slice(0, TASK_SUMMARY_MAX)
        deferredTaskStarts.set(launch, summary)
        await recordRefusedTaskStart(launch, summary)
      }
      launch.check()
      throw error
    }
  }

  async function allocateTaskSession(title, { cwd, agentPreset, botId, readScopeSource } = {}, launch) {
    launch.check()
    const agent = await ensureTasks()
    const sessionId = await allocateAgentSession(agent.id, undefined, { cwd, agentPreset, botId, readScopeSource }, undefined, launch)
    const clean = String(title ?? '').trim().slice(0, AGENT_SESSION_TITLE_MAX)
    if (clean !== '') await renameAgentSession(agent.id, sessionId, clean).catch(error => rt.warn('ds-bot: task title not set: %s', error?.message ?? error))
    launch.check()
    return sessionId
  }

  // A task thinks with the model of the Bot that asked, as that Bot's own chat does, not
  // with DSH's default: the default may be a route this machine has no key for. Before the
  // first message, so the first turn already runs on it.
  // It answers false when the Bot's model was to be selected and was not: the task is still
  // on the model DSH made its Session with.
  async function askersModel(sessionId, bot) {
    if (bot === undefined) return true
    try {
      const ref = await rt.desiredModel(bot, { sessionId })
      if (ref === undefined) return true
      const effort = await rt.desiredEffort(bot, ref)
      await rt.selectSessionModel(sessionId, { ...splitRef(ref), ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      return true
    } catch (error) {
      rt.warn('ds-bot: the task keeps the default model, %s\'s was not applied: %s', bot.name, error?.message ?? error)
      return false
    }
  }

  function taskAdmission(botId, sessionId, roomId, named) {
    const roles = rt.roleRuntime
    const held = roles?.heldOf(botId)
    const measure = () => {
      const bot = rt.botOf(botId)
      if (bot === undefined || !rt.isBotSession(sessionId) || rt.selfOf(sessionId) !== botId
        || rt.callerSessionId?.() !== sessionId || rt.groupOwners.get(sessionId)?.roomId !== roomId
        || roles?.heldOf(botId) !== held) return undefined
      const opener = rt.callerLevel({ proven: true })
      const openerRank = rt.taskOpenerRank(opener)
      const parent = rt.callerTask?.()
      const bound = rt.taskBound({ from: botId, roomId, levelTaskId: parent, botBound: true, permissionCap: opener, openerRank })
      if (bound === undefined) return undefined
      return {
        permission: bot.permission, roomPermission: roomId ? rt.roomOf(roomId)?.permission : undefined,
        opener, openerRank, ...bound, parent, ...rt.taskAskerState(bot), kind: bot.kind, name: bot.name,
        routes: taskRoutes(bot, rt.taskRoutePolicy).join(','),
        catalogEpoch: rt.modelsEpoch(),
        taskGrant: roles?.grantOf(botId, 'task-start'), routeGrant: roles?.grantOf(botId, 'route-policy'),
        verdict: bot.reviewTrack?.planVerdictAt,
      }
    }
    const snapshot = measure()
    if (snapshot === undefined) throw refusal(LEVEL_UNPROVEN)
    function check() {
      assertTaskGuard(botId)
      const now = measure()
      if (now === undefined || Object.keys(snapshot).some(key => snapshot[key] !== now[key])) throw refusal(START_CHANGED)
    }
    return {
      snapshot, check, named,
      applied(sessionId, session) {
        try {
          return rt.taskLevelOf(sessionId) === snapshot.level && rt.sessionLevel(session) === snapshot.level
        } catch { return false }
      },
    }
  }

  async function taskModels(admission, requested) {
    const { snapshot, named } = admission
    const mayName = snapshot.routeGrant === 'granted'
    const reasons = new Map()
    const eligible = []
    const entries = await rt.catalog({ fresh: true, remember: false })
    admission.check()
    const remote = routeOfRef(snapshot.model ?? snapshot.appliedModel).route === 'hermes-remote'
    const model = named ? requested : remote ? (snapshot.model ?? snapshot.appliedModel) : rt.taskAskerModel(snapshot, entries)
    const routes = snapshot.routes.split(',')
    for (const entry of entries) {
      const { ref } = entry
      if (reasons.has(ref) || (!mayName && ref !== model)) continue
      const route = routeOfRef(ref).route
      const allowed = routes.includes(route)
      const reason = await taskModelReason(entry, route, allowed || (!named && ref === model), snapshot)
      reasons.set(ref, { entry, reason })
      if (mayName && allowed && reason === undefined) eligible.push(ref)
    }
    admission.check()
    const shown = typeof model === 'string' && model.trim() && !/[\r\n]/.test(model) ? model : JSON.stringify(model)
    if (!reasons.has(model)) {
      const reason = named && routeOfRef(shown).route !== 'hermes-remote'
        ? unknownModel(shown) : modelUnavailable(shown ?? snapshot.model ?? 'of this Bot')
      throw modelRefusal(reason, eligible)
    }
    const { reason, entry } = reasons.get(model)
    if (reason !== undefined) throw modelRefusal(reason, eligible)
    return { ...admission, model, eligible, entry }
  }

  async function taskModelReason(entry, route, allowed, snapshot) {
    const { ref } = entry
    if (route !== 'native' && route !== 'acp') return modelUnavailable(ref)
    if (entry.covered) return `${ref} runs only through its coding CLI; name its CLI model.`
    if (!allowed) return `${snapshot.name} cannot use the ${routeLabel(ref)} route.`
    if (!splitRef(ref)?.model || !configured(entry) || rt.isLocalAgentRef?.(ref) === true) return modelUnavailable(ref)
    if ((await rt.modelAccess(ref)).ready !== true) return modelUnavailable(ref)
    if (snapshot.wide && leavesCli(splitRef(snapshot.model), splitRef(ref))) return OFF_CLI
  }

  const tasks = () => (state.tasks ??= {})
  // When a task ended, for which ended task is forgotten first; an older record has only `at`.
  const endOf = task => task.endedAt ?? task.at ?? 0
  // `roomId`: the group whose Session asked for the task. Its result goes back to that
  // group, where the user saw the request, not to the Bot's own chat.
  // Without one, a task started inside a group Session's tool call keeps that group as
  // `levelRoomId`, which can only narrow its level (permissions.js); the report still goes
  // to the Bot's own chat unless `reportRoomId` chooses a group.
  // Started from inside a task Session's tool call, it keeps that task as `levelTaskId` and
  // never runs wider than it (permissions.js, #1030), with a `roomId` too; without one it
  // also takes the group that task takes its level from.
  // `reportRoomId` changes only delivery, never the level. The Bot must be a member,
  // and a different `roomId` is refused. At the end, a missing group or Bot Session
  // falls back to the Bot's own chat.
  // The task's Session is flagged as starting from the moment it is a task until this
  // returns or throws, whatever fails on the way (permissions.js startingSession).
  const startTask = async args => {
    const result = await startTaskWithAdmission(args)
    if (Object.hasOwn(result, 'flushError')) throw result.flushError
    return result.sessionId
  }
  async function startTaskWithAdmission(args, admission) {
    const launch = taskLaunch(args.from, admission)
    let started
    try {
      const live = await settleTaskAllocation(launch, async () => {
        const child = await prepareTask(args, (sessionId) => { started = rt.startingSession?.(sessionId) }, launch, admission)
        launch.check()
        if (admission !== undefined && !admission.applied(launch.sessionId, child.session)) throw refusal(LEVEL_UNPROVEN)
        // DSH's turn loop reads every input's source: the instructions arrive as the user's.
        child.followup(createUserMessage({ content: [{ type: 'text', text: args.text }], source: { kind: 'user' } }))
        return child
      })
      const { sessionId } = launch
      try {
        const flushed = await ctx.sessions.flush(live.session)
        return { sessionId, persistenceUncertain: flushed === false }
      } catch (flushError) {
        rt.warn('ds-bot: the queued turn for task %s could not be saved: %s', sessionId, flushError)
        return { sessionId, persistenceUncertain: true, flushError }
      }
    } finally {
      started?.()
    }
  }
  async function prepareTask({ title, from, cwd, agentPreset, roomId, reportRoomId, readScopeSource = rt.callerSessionId?.() }, starting, launch, admission) {
    launch.check()
    // Read before the first await: the tool call this runs in may return before the rest.
    const opener = from === undefined ? undefined : rt.callerLevel?.()
    const autoOpener = rt.autoOpener?.()
    const levelTaskId = rt.callerTask?.()
    const parent = levelTaskId === undefined ? undefined : state.tasks?.[levelTaskId]
    if (levelTaskId !== undefined) rt.assertTaskDepth(levelTaskId)
    const levelRoomId = roomId || from === undefined ? undefined : rt.callerGroup?.() ?? parent?.levelRoomId ?? parent?.roomId
    const caller = state.bots?.[from]
    rt.assertShellChoice?.(undefined, from)
    let reportRoom
    if (reportRoomId !== undefined && reportRoomId !== null) {
      if (typeof reportRoomId !== 'string' || reportRoomId.trim() === '') throw refusal('The report room must be a group id')
      const bot = rt.botOf(from)
      if (bot === undefined) throw refusal('A report room needs the Bot that asks for the task')
      reportRoom = rt.roomOf(reportRoomId)
      if (reportRoom === undefined) throw refusal(`There is no group ${reportRoomId} to report to`)
      if (!reportRoom.members?.includes(from)) throw refusal(`${bot.name} is not a member of "${reportRoom.name}", so the task cannot report there`)
      if (roomId && roomId !== reportRoom.id) throw refusal('A task asked for in one group cannot report to another')
    }
    if (from !== undefined && readScopeSource === undefined) rt.assertNoConfiguredReadScope()
    const sessionId = await allocateTaskSession(title, {
      cwd: cwd ?? caller?.workDir, agentPreset: agentPreset ?? caller?.profile, botId: from, readScopeSource,
    }, launch)
    // Until its start is decided: a re-apply DSH asks for meanwhile must not lower the task
    // in place of the refusal a saved level that is no longer offered gets (permissions.js).
    starting(sessionId)
    const task = tasks()[sessionId] = { title: String(title).slice(0, AGENT_SESSION_TITLE_MAX), from, at: Date.now(), status: 'working', ...(roomId ? { roomId } : {}), ...(reportRoom !== undefined && !roomId ? { reportRoomId: reportRoom.id } : {}), ...(levelRoomId ? { levelRoomId } : {}), ...(levelTaskId ? { levelTaskId } : {}) }
    launch.task = task
    if (admission === undefined) rt.capTaskByOpener?.(task, opener)
    else Object.assign(task, { botBound: true, permissionCap: admission.snapshot.opener, openerRank: admission.snapshot.openerRank })
    if (autoOpener !== undefined && autoOpener.botId === from && !roomId && !levelRoomId && !levelTaskId) Object.assign(task, { auto: autoOpener.route, autoRev: autoOpener.rev })
    // Only TASKS_KEPT ended tasks are remembered for their reports. The ended ones go first,
    // the one that ended longest ago first: a long task that just ended is fresh news.
    // A working record is never evicted, whatever its age or whether DSH still holds its
    // Session: it is the only lineage the Bot's tool deny list and permission bind to, so
    // dropping it would lift the tools/execute guard for that Session (#584, L4). The cap
    // is a bound on ended history; working records are bounded by what the host can run.
    const all = Object.entries(tasks())
    const ended = all.filter(([id, task]) => task.status !== 'working'
      && !launch.agent.refusedStarts?.some(pending => pending.sessionId === id)).sort(([, a], [, b]) => endOf(a) - endOf(b))
    // The level each forgotten task ran at is read while it is still a task.
    // An ended task a working task descends from is kept past the cap while that one works:
    // its level bounds the working one, read live. The next oldest go in its place. At most
    // a chain's depth per working task, and they go as any other once it has ended.
    const held = rt.taskForebears?.() ?? new Set()
    const picked = ended.filter(([id]) => !held.has(id)).slice(0, Math.max(0, all.length - TASKS_KEPT)).map(([id]) => id)
    // A fresh-Session task armed by an ended task's Session has that record as its only
    // team lineage; a restricted Bot's such tasks are paused before the record goes
    // (#584, L5). Without a schedule service this is a no-op.
    for (const id of picked) {
      const from = tasks()[id]?.from
      const bot = from === undefined ? undefined : state.bots?.[from]
      const restricted = bot?.shell === false
        || (Array.isArray(bot?.denyTools) && bot.denyTools.length > 0)
      if (!restricted) continue
      try {
        await rt.revokeNewSchedules?.(from, [id])
      } catch (error) {
        rt.warn('ds-bot: the fresh-Session tasks of %s were not paused: %s', bot.name, error)
      }
    }
    // A Bot-bound record holds the proven ceiling until its Session can take
    // and save an eligible level. Leave it for reapply and a later prune on failure.
    for (const id of picked) {
      const task = tasks()[id]
      if (task?.botBound !== true || task.status === 'working' || rt.taskForebears?.().has(id)) continue
      const safe = await rt.applyTaskPermission(id, undefined, { forget: true }).catch(error => {
        rt.warn('ds-bot: keeping the permission bound of the old task %s: %s', id, error?.message ?? error)
        return false
      })
      if (safe && tasks()[id] === task && task.status !== 'working' && !rt.taskForebears?.().has(id)) delete tasks()[id]
    }
    // Looked at again after the waits above, with nothing awaited before the delete: a task
    // started meanwhile from one of them keeps it.
    const needed = rt.taskForebears?.() ?? new Set()
    const forgotten = picked.filter(id => tasks()[id] !== undefined && tasks()[id].botBound !== true
      && tasks()[id].status !== 'working' && !needed.has(id))
      .map(id => [id, rt.taskLevelOf(id)])
    for (const [id] of forgotten) delete tasks()[id]
    await rt.save()
    for (const [id, ranAt] of forgotten) {
      await rt.forgetTaskPermission(id, ranAt)
        .catch(error => rt.warn('ds-bot: the old task %s keeps its permission, the default was not applied: %s', id, error?.message ?? error))
    }
    const selected = admission === undefined && await askersModel(sessionId, state.bots?.[from])
    let live = admission === undefined ? await rt.resolveAgent(sessionId) : undefined
    // And at its Bot's permission level: DSH announced the Session before it was a task,
    // so its session/created listener could not. Before the first turn, as the model is.
    // A task whose level did not hold takes no turn: the default it would run at may be
    // wider. It ends as failed, so nothing resumes it, and its Session is archived, so
    // nothing is typed into it at that default either.
    if (admission !== undefined) {
      launch.check()
      const { model, eligible, entry } = admission
      const target = splitRef(model)
      let actual
      try {
        const effort = await rt.desiredEffort(caller, model, entry)
        launch.check()
        actual = (await rt.selectSessionModel(sessionId, { ...target, ...(effort === undefined ? {} : { reasoningEffort: effort }) }))?.selected
      } catch {
        launch.check()
        throw modelRefusal(`${model} could not be selected for the task.`, eligible, model)
      }
      launch.check()
      if (actual?.provider !== target.provider || actual?.model !== target.model) {
        throw modelRefusal(`${model} could not be selected for the task.`, eligible, model)
      }
      live = await rt.resolveAgent(sessionId)
    }
    await rt.applyTaskPermission(sessionId, live.session, { start: true })
    // At Full access with its Bot's coding CLI not served, or not selected just above: not
    // started on another model.
    if (admission === undefined) await rt.assertNotOffCli(state.bots?.[from], sessionId, live.session, { unselected: !selected })
    // The Session existed before the task record did. Bind its tool deny list before its first turn.
    await rt.applyToolDeny?.(caller, [sessionId])
      .catch(error => rt.warn('ds-bot: the task keeps tools %s denies: %s', caller?.name ?? from, error?.message ?? error))
    return live
  }

  // A task's first turn ends: its last words go to the Bot that asked, once.
  const lastWords = new Map()
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    const task = id === undefined ? undefined : state.tasks?.[id]
    if (task === undefined || task.status !== 'working') return
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content
      const text = Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim() : ''
      // What the task is on, for its card in the chat: its latest words and how far it got.
      task.steps = (task.steps ?? 0) + 1
      const calls = Array.isArray(content) ? content.filter(block => block?.type === 'tool-call' || block?.type === 'tool_use').map(block => block.name ?? block.toolName).filter(Boolean) : []
      if (calls.length > 0) task.tool = String(calls.at(-1)).slice(0, 40)
      if (text) {
        lastWords.set(id, text)
        task.said = text.replace(/\s+/g, ' ').slice(0, TASK_LINE_MAX)
      }
      void rt.save().catch(error => rt.warn('ds-bot: saving a task failed: %s', error))
    } else if (event?.type === 'turn/end') {
      // RFC 0039 delivery 3: the team and task record this end happens in, at event time.
      const gen = rt.teamGeneration?.()
      // A restart cut the turn: the task is not done. resume.js sets it going again, or
      // ends it as stopped when it will not.
      if (rt.cutByRestart?.(event.data?.reason)) return
      // An error fails the task; the user or a Bot stopping it (an abort, or the error a
      // cancelled ACP prompt ends with) only stops it.
      const reason = event.data?.reason
      const provider = session.requestHeader?.()?.config?.provider
      const cancelled = reason?.kind === 'error' && reason.error?.code === 'ABORTED'
        && routeOf(provider).connectedBy === 'acp'
      const stopped = reason?.kind === 'aborted' || cancelled
      const failed = reason?.kind === 'error' && !stopped
      let status = failed ? 'failed' : stopped ? 'stopped' : 'done'
      let endedAt = Date.now()
      const words = lastWords.get(id) ?? ''
      lastWords.delete(id)
      const problem = event.data?.reason?.error?.message || 'unknown error'
      let summary = (failed ? problem : words || (stopped ? 'Stopped before it finished.' : ''))
        .slice(0, TASK_SUMMARY_MAX)
      let delivery
      let written = false
      if (rt.botOf(task.from) !== undefined) {
        const said = failed ? `It failed: ${problem}`
          : stopped ? `It was stopped before it finished.${words ? ` Its last words: ${words}` : ''}`
          : words || 'It ended without a reply.'
        // A task reports to the group that asked for it, falling back to the Bot's own chat.
        const roomId = task.reportRoomId ?? task.roomId
        const room = roomId === undefined ? undefined : rt.roomOf(roomId)
        const inRoom = room !== undefined && room.members?.includes(task.from) ? room.sessions?.[task.from] : undefined
        if (task.reportRoomId !== undefined && inRoom === undefined) rt.warn('ds-bot: the report of task %s goes to its Bot\'s own chat: the group %s is gone or the Bot has no Session there', task.title, task.reportRoomId)
        const key = `task:${id}`
        const prior = rt.wakeLog?.byKey(key)
        if (prior !== undefined) {
          if (prior.outcome !== undefined) ({ status, endedAt, summary } = prior.outcome)
        } else {
          const exchangeId = rt.wakeLog && randomUUID()
          const report = { role: 'task-done', note: task.title, text: said.slice(0, TASK_REPORT_MAX), taskSessionId: id }
          written = rt.wakeLog?.intent({
            id: exchangeId, kind: 'task-report', botId: task.from, key,
            sessionId: inRoom ?? rt.chatOf(task.from),
            ...(inRoom !== undefined ? { roomId: room.id, returnRoomId: room.id } : {}),
            report, outcome: { status, endedAt, summary },
          }) === 'written'
          delivery = { toId: task.from, ...report, ...(inRoom !== undefined ? { sessionId: inRoom, roomId: room.id } : {}),
            ...(exchangeId ? { exchangeId } : {}), ...(written ? { wake: true } : {}) }
        }
      }
      Object.assign(task, { status, endedAt, summary })
      rt.endGrants?.(id, 'task')
      // RFC 0039 delivery 3: publish after this end's own write commits, while its team and task record still hold.
      void rt.save().then((committed) => {
        const valid = () => rt.sameTeam?.(gen) === true && state.tasks?.[id] === task && task.status === status
        if (committed === true && valid()) return rt.endApprovals?.(id, 'task', { task }, valid)
      }, error => rt.warn('ds-bot: saving a task failed: %s', error))
        .catch(error => rt.warn('ds-bot: the asks of task %s were not withdrawn: %s', id, error))
      if (delivery === undefined) return
      const options = written ? rt.wakeLog.firstOptions(delivery.exchangeId) : undefined
      void rt.deliver(delivery, options)
        .catch(error => rt.warn('ds-bot: the report of task %s did not reach its Bot: %s', task.title, error?.message ?? error))
        .finally(() => { if (written) rt.wakeLog.firstFinished(delivery.exchangeId) })
    }
  })

  // A Session under a DSH bot for another plugin, with a title and, optionally, the
  // user's first message, which starts its first turn.
  async function createDshBotSession(botId, { title, firstMessage } = {}) {
    const leave = rt.enterOwnership?.() ?? (() => {})
    try {
      await rt.load()
      const agent = rt.own(state.agents, botId)
      if (agent?.kind !== DSH_BOT) throw refusal('Unknown DSH bot')
      const sessionId = await createAgentSession(agent.id)
      const clean = String(title ?? '').trim().slice(0, AGENT_SESSION_TITLE_MAX)
      if (clean !== '') await renameAgentSession(agent.id, sessionId, clean).catch(error => rt.warn('ds-bot: session title not set: %s', error?.message ?? error))
      const text = String(firstMessage ?? '').trim()
      if (text !== '') {
        const live = await rt.resolveAgent(sessionId)
        live.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await ctx.sessions.flush(live.session)
      }
      return { sessionId }
    } finally { leave() }
  }
  // For other plugins: the DSH bots, a Session under one, and word when the list changes.
  rt.dshBots = {
    list: () => dshBots().map(listed),
    createSession: createDshBotSession,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  ctx.tools.register(defineTool({
    name: 'start_task',
    description: 'Hands one-off work (code, files, a repo, research, a long investigation) to a new session under your row. A Main Bot and the Omni Bot may start tasks. Other Bots need the task-start grant on their role. The review guard must be off. Write instructions that stand on their own: the task cannot see this chat. Its result comes back as a message when its first turn ends.',
    parameters: {
      title: { type: 'string', required: true, description: 'A few words the user will see under your row' },
      instructions: { type: 'string', required: true, description: 'Everything the task needs: the goal, where to work, what to return' },
      // Validate here so malformed names receive the same eligible retry list.
      model: { type: 'json', description: 'Optional exact provider/model string from list_bot_models. Naming one requires both role grants. Omit it to use your own model. A task on omp with its native tools off can only chat.' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const callerSession = exec.agent?.id ?? exec.agent?.session?.id
      const self = rt.selfOf(callerSession)
      const named = args.model !== undefined
      const legacy = !named && self !== undefined && (rt.isMain(self) || rt.botOf(self)?.kind === OMNI_KIND)
      const title = String(args.title ?? '').trim()
      const text = String(args.instructions ?? '').trim()
      let admission
      // Called in a group, the task belongs to that group: its report goes back there.
      try {
        assertTaskGuard(rt.botOfSession?.(callerSession, exec.agent)?.id, self)
        if (!legacy) {
          if (self !== undefined && rt.isBotSession(callerSession)) await rt.roleRuntime?.ready(self)
          assertTaskGuard(rt.botOfSession?.(callerSession, exec.agent)?.id, self)
          const current = self !== undefined && rt.isBotSession(callerSession) && rt.selfOf(callerSession) === self
          const taskGrant = current ? rt.roleRuntime?.grantOf(self, 'task-start') : undefined
          if (named && (taskGrant !== 'granted' || rt.roleRuntime?.grantOf(self, 'route-policy') !== 'granted')) throw modelRefusal(MODEL_GRANT)
          if (taskGrant === 'declared') throw refusal(TASK_GRANT)
          if (taskGrant !== 'granted') return OLD_TASK_GATE
        }
        if (title === '' || text === '') return 'A task needs a title and instructions.'
        const roomId = rt.groupOwners.get(callerSession)?.roomId
        if (!legacy) {
          admission = taskAdmission(self, callerSession, roomId, named)
          admission = await taskModels(admission, args.model)
        }
        const readScopeSource = exec.agent?.session?.id ?? rt.callerSessionId?.() ?? callerSession
        const { sessionId, persistenceUncertain } = await startTaskWithAdmission({ title, text, from: self, roomId, readScopeSource }, admission)
        if (persistenceUncertain) return `The first turn was queued for task "${title.slice(0, AGENT_SESSION_TITLE_MAX)}" in Session ${sessionId}. DeepSeek Harness could not confirm that it saved the turn.`
        const cap = state.tasks?.[sessionId]?.permissionCap
        const level = admission === undefined ? cap : admission.snapshot.level
        return `Started task "${title.slice(0, AGENT_SESSION_TITLE_MAX)}" (${sessionId}) under your row.${named ? ` It runs on ${admission.model}.` : ''}${level ? ` It runs at the ${level} permission level, no wider than this conversation.` : ''} Its result comes back to you as a message; do not wait or poll.`
      } catch (failure) {
        let error = failure
        // Allocation cleanup can await storage and archival. Check live authority
        // at the response boundary before revealing the model choices.
        try {
          assertTaskGuard(rt.botOfSession?.(callerSession, exec.agent)?.id, self)
          admission?.check()
        } catch (changed) { error = changed }
        if (error?.taskStop) rt.noteStop?.(callerSession, { why: error.taskStop, tool: 'start_task', callId: exec.callId, text: error.message }, exec.agent)
        return `The task did not start: ${error?.message ?? error}`
      }
    },
  }))

  Object.assign(rt, { agentOf, addAgent, updateAgent, presets, createAgentSession, adoptAgentSession, adoptBotSession, adoptAsBot, rollbackAdoption, adoptionHistoryMatches, archiveAgentSession, renameAgentSession, removeAgent, createTaskSession, startTask })
}
