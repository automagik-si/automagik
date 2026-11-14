import { markOf } from '../shared/permission-levels.js'
import { ROLE_MAX } from '../shared/bot-profile.js'
// Roster: creating, changing, and deleting Bots and group chats, the Main Bot role, and
// the first Main Bot of a new team.
import { mkdir } from 'node:fs/promises'
import { refusal } from './refusal.js'
import { MAX_AVATAR_IMAGE, ROOM_MAX_MEMBERS, ROOM_MODES, ROOM_NAME_MAX, ROOM_NOTICE_MAX, inUnfoldInstance } from './constants.js'
import { currentColor, isColor, normalize, unquote } from './text.js'
import { nameProblem } from '../shared/mentions.js'
import { contextPatch } from '../shared/context-policy.js'
import { crossesHarness } from '../shared/routes.js'
import { cleanPetId, shippedPet } from './pets.js'
import { cleanDenyTools } from './tool-deny.js'

// A Bot's role: a few words of plain text on one line, shown beside the first Main Bot's
// name in the sidebar and under a Bot's name elsewhere. Line breaks and control
// characters become spaces.
export { ROLE_MAX }
export function cleanRole(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw refusal('A role is a few words of text')
  return value.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, ROLE_MAX)
}

// The kinds of Bot that other Omni plugins add to the team; the sidebar puts them first.
// 'omni' is the Omni Bot the welcome's team step adds: it operates Omni without being a
// Main Bot (Omni's plugin and prompt.js give it what it needs). Deleted, the New menu's Add
// Omni (welcome-dsh) brings it back. 'unfold' is Unfold inside DSH (@automagik/unfold-bot-dsh),
// the Main Bot of Unfold's own instance.
export const BOT_KINDS = ['omni', 'genie', 'unfold']
export const OMNI_KIND = 'omni'


const BROWSER_GRANT_KINDS = new Set(['post', 'upload', 'download', 'delete', '*'])
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/

function cleanBrowserGrants(input) {
  if (input === null) return null
  if (!Array.isArray(input) || input.length > 50) throw refusal('Browser grants must be an array of at most 50 entries')
  const grants = []
  const seen = new Set()
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw refusal('Each browser grant must have a site and kinds')
    }
    const until = entry.until
    if (until !== undefined) {
      if (typeof until !== 'number' || !Number.isFinite(until)) {
        throw refusal('Browser grant until must be a future epoch-millisecond timestamp')
      }
      if (until <= Date.now()) continue
    }
    const site = typeof entry.site === 'string' ? entry.site.trim().toLowerCase() : ''
    if (site !== '*' && !HOSTNAME.test(site)) throw refusal('Browser grant site must be * or a hostname')
    if (!Array.isArray(entry.kinds) || entry.kinds.length === 0
      || entry.kinds.some(kind => typeof kind !== 'string' || !BROWSER_GRANT_KINDS.has(kind))) {
      throw refusal('Browser grant kinds must be a non-empty subset of post, upload, download, delete, *')
    }
    const kinds = [...new Set(entry.kinds)].sort()
    const key = `${site}\0${kinds.join('\0')}\0${until ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    grants.push({ site, kinds, ...(until !== undefined ? { until } : {}) })
  }
  return grants
}

// How long a plugin's Main Bot maker (rt.mainBotMaker) may take before the team goes on without it.
export const MAIN_BOT_MAKER_MS = 10_000
const NO_ANSWER = Symbol('no answer from the Main Bot maker')

export function install(rt) {
  const { ctx, defaults, state } = rt

  let bootstrapping = null

  // The team folder is DS Bot's own: deleted, it is made again before a Session needs it.
  async function keepTeamFolder() {
    const team = rt.teamFolder()
    if (team !== undefined) await mkdir(team, { recursive: true }).catch(error => rt.warn('ds-bot: team folder %s not made again: %s', team, error))
    return team
  }

  async function ensureWorkspace() {
    if (state.workspaceId && ctx.workspaceRegistry.get(state.workspaceId)) {
      await keepTeamFolder()
      return state.workspaceId
    }
    const path = rt.defaultTeamFolder()
    await mkdir(path, { recursive: true })
    const workspace = await ctx.workspaceRegistry.resolveByPath(path) ?? await ctx.workspaceRegistry.create(path, 'Omni')
    state.workspaceId = workspace.id
    await rt.save()
    return workspace.id
  }

  // Under the PTC preset (DSH Desktop's default) a model may call only run_code, which
  // turns down the group_relay call that a group chat's Session is given. A Session
  // keeps the preset it is made with.
  async function botPreset(profile) {
    const presets = ctx.get?.('agentPresets')
    if (presets === undefined) return {}
    const served = (await presets.list()).filter(preset => preset.broken === undefined)
    if (profile !== undefined) {
      if (profile === null) return {} // Adopted default DSH preset, not the team's standard.
      if (!served.some(preset => preset.id === profile)) throw refusal(`The preset ${profile} is not available in this DSH`)
      return { agentPreset: profile }
    }
    return served.some(preset => preset.id === 'standard') ? { agentPreset: 'standard' } : {}
  }

  // `dir` is a working folder outside the team workspace. Such a Session is made by cwd
  // alone, so it joins no DSH workspace and the user's own project lists stay as they are.
  async function createSession(title, { dir, profile } = {}) {
    // A Bot's tools run here too; while another dsh holds the team, a new Session would
    // belong to no saved Bot.
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly)
    const usable = dir !== undefined && await rt.isFolder(dir)
    if (dir !== undefined && !usable) rt.warn('ds-bot: the working folder %s is gone; %s starts in the team workspace', dir, title)
    const place = usable ? { cwd: dir } : { workspaceId: await ensureWorkspace() }
    const { sessionId } = await ctx.sessionController.create({ ...place, ...await botPreset(profile) })
    const agent = await rt.resolveAgent(sessionId)
    await ctx.sessionTitle.rename(agent.session, title)
    return sessionId
  }

  function cleanAvatar(input) {
    if (input === null || typeof input !== 'object') return undefined
    const avatar = {}
    if (typeof input.shape === 'string' && /^[a-z][\w-]{0,31}$/.test(input.shape)) avatar.shape = input.shape
    if (typeof input.image === 'string') {
      if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(input.image)) throw refusal('Avatar images must be PNG, JPEG, WebP, or GIF')
      if (input.image.length > MAX_AVATAR_IMAGE) throw refusal('Avatar image is too large')
      avatar.image = input.image
    }
    // A pet (pets.js) the team keeps or ships; a photo, set after it, wins.
    const pet = input.pet
    if (avatar.image === undefined && pet !== null && typeof pet === 'object' && ['builtin', 'team'].includes(pet.source) && cleanPetId(pet.id) && [1, 2].includes(pet.version)) {
      avatar.pet = shippedPet({ source: pet.source, id: pet.id, version: pet.version, ...(pet.sleep === true ? { sleep: true } : {}) })
    }
    return Object.keys(avatar).length > 0 ? avatar : undefined
  }

  // A new Bot or group is written only after its Session is made, several awaits after
  // its name was checked. The name is held from the check until the create ends, so a
  // create or rename that runs meanwhile cannot take it too.
  const held = { bot: new Set(), room: new Set() }
  const heldSessions = new Set()
  const isHeld = (kind, name) => held[kind].has(normalize(name))
  // Bots whose deletion has begun but whose record is still in the team (deleteBot waits
  // on their Sessions first). A group change counts them as gone, whichever call goes on
  // first, so it never adds one back or reports it added (#366).
  const deleting = new Set()
  const isLive = id => rt.botOf(id) !== undefined && !deleting.has(id)
  // Each deleteBot still running, by Bot. A second call for the same Bot gets that one,
  // so it ends with it (#376): see deleteBot.
  const deletions = new Map()
  // What other modules clear of a Bot as it is deleted (btw cards, side chats). They run
  // inside deleteBot, after its checks, after the Bot left its groups and after its
  // Sessions were released, so a refused deletion, or one whose release fails, clears
  // nothing (#366, #376), and no wait of theirs comes before the Bot is out.
  const deleteSteps = []
  const beforeBotDelete = (step) => { deleteSteps.push(step) }
  async function holdName(kind, name, work) {
    const key = normalize(name)
    if (key === '') return work()
    held[kind].add(key)
    try {
      return await work()
    } finally {
      held[kind].delete(key)
    }
  }
  const botNameTaken = name => rt.findBot(name) !== undefined || isHeld('bot', name)

  const freshName = (base) => {
    const stem = base.slice(0, 34)
    if (!botNameTaken(stem)) return stem
    let index = 2
    while (botNameTaken(`${stem} ${index}`)) index += 1
    return `${stem} ${index}`
  }

  // `pickModel` leaves the model to the user: the chat opens on a model card, and the
  // greeting waits until a model is chosen. So does a Bot made when no model is served.
  async function createBot(options) {
    const cleanName = String(options.name ?? '').trim().slice(0, 40)
    const problem = nameProblem(cleanName)
    if (problem !== undefined) throw refusal(problem)
    if (botNameTaken(cleanName)) throw refusal(`A Bot named ${cleanName} already exists`)
    const existing = options.existingSessionId
    if (existing === undefined) return holdName('bot', cleanName, () => buildBot(cleanName, options))
    if (typeof existing !== 'string' || !existing.trim()) throw refusal('An existing Session needs its id')
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw refusal(readOnly)
    if (heldSessions.has(existing) || rt.botOf(existing) || rt.roomOf(existing) || rt.selfOf(existing) || rt.agentOf?.(existing)) throw refusal('Session already belongs to the team')
    heldSessions.add(existing)
    try {
      return await holdName('bot', cleanName, () => buildBot(cleanName, options))
    } finally {
      heldSessions.delete(existing)
    }
  }

  async function buildBot(cleanName, { role = '', instructions = '', color, brief = '', createdBy, main = false, avatar, model, effort, workDir, copyOf, pickModel = false, kind, existingSessionId, inheritAuto, denyTools: denyToolsInput }) {
    const opener = createdBy === undefined ? undefined : { level: rt.callerLevel?.(), roomId: rt.callerGroup?.() }
    const cleanAvatarValue = cleanAvatar(avatar)
    const roleText = cleanRole(role)
    // Checked before the Session exists, so a bad list creates no Bot and leaves no orphan.
    const denyTools = cleanDenyTools(denyToolsInput)
    // The model is fixed at creation, so a later change of the DSH default leaves it alone.
    // A model that cannot run now (an agent whose CLI is signed out) refuses the Bot before
    // its Session exists.
    const modelRef = model ? await rt.resolveModel(model, { checkAccess: true, remember: false }) : pickModel ? undefined : await rt.defaultModel()
    // A thinking level needs a model to resolve against; with none it would be dropped
    // silently, so the create fails before a Session is made.
    if (effort && modelRef === undefined) throw refusal('Pick a model before choosing a thinking level')
    // An explicit level wins; an explicit Default (null) picks the model's own
    // level; an untouched pick inherits the profile default's level.
    const effortId = modelRef === undefined ? undefined
      : effort === null || effort === '' ? undefined
      : (await rt.resolveEffort(modelRef, effort)) ?? await rt.defaultEffort(modelRef)
    const dir = workDir === undefined || workDir === null ? undefined : await rt.cleanWorkDir(workDir)
    // A Bot made by another Bot takes its creator's level, before its Session is made; else
    // the team default. A Session adopted from a host keeps its own.
    const creator = rt.botOf(createdBy)
    const carried = Array.isArray(creator?.denyTools) ? creator.denyTools : []
    const denied = carried.length === 0 ? denyTools : cleanDenyTools([...new Set([...carried, ...(denyTools ?? [])])])
    const permission = existingSessionId !== undefined ? undefined
      : creator !== undefined ? rt.inheritedPermission(creator, opener) ?? state.prefs.permission
        : state.prefs.permission
    // A host adapter may already own a configured root Session. Adopt it without creating
    // another Session or moving its workspace; this option is internal, not a user payload.
    const id = existingSessionId ?? await createSession(cleanName, { dir })
    // Checked against the Session's own tool surface, before the Bot record exists: a name
    // this DSH does not serve refuses the create (the catch below archives the Session).
    if (denyTools) await rt.assertDenyTools(id, denyTools)
    if (existingSessionId !== undefined) {
      const agent = await rt.resolveAgent(id)
      if (agent?.session?.id !== id) throw refusal('The existing Session could not be resolved')
      await ctx.sessionTitle.rename(agent.session, cleanName)
    }
    try {
      state.bots[id] = {
        id,
        name: cleanName,
        role: roleText,
        advanced: false,
        // A color is only stored when the user picks one; otherwise the id picks it.
        ...(isColor(currentColor(color)) ? { color: currentColor(color) } : {}),
        ...(cleanAvatarValue ? { avatar: cleanAvatarValue } : {}),
        ...(modelRef ? { model: modelRef } : {}),
        ...(effortId ? { effort: effortId } : {}),
        ...(dir ? { workDir: dir } : {}),
        ...(permission ? { permission } : {}),
        // The host runs an adopted Session, so the Bot never moves to a fresh part (parts.js).
        ...(existingSessionId !== undefined ? { sessionPinned: true } : {}),
        // What a team member brought in by its own plugin is for (omni: Omni's channels).
        ...(BOT_KINDS.includes(kind) ? { kind } : {}),
        // The tools this Bot never gets, enforced on every Session it speaks from.
        ...(denied ? { denyTools: denied } : {}),
        instructions: String(instructions).trim(),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
        capabilities: [],
      }
      if (main) state.mainBotIds.push(id)
      const original = rt.botOf(copyOf)
      const language = rt.uiLanguage?.()
      // The kickoff arrives as a user message, so it outranks the Bot's instructions
      // unless it gives way to them, and it names no tool those instructions may rule out.
      const kickoff = main
        ? `You were just set up as the user's Main Bot. Greet the user in one or two short messages: say you will run their Bot team and that they can come to you for anything that needs a decision. Then ask in one short question what they want the team to help with first. Write in ${language ?? 'the user\'s language if known; otherwise Chinese'}.`
        : original
          ? `The user just made you as a copy of ${original.name}: same job, fresh memory. Greet the user in one short message, then ask in one short question what this copy should focus on.`
          : creator
            ? `${creator.name} just created you for the user.${brief ? ` Why you exist: ${brief}` : ''}\nGreet the user in one short message, then ask in one short question where to start. Keep it brief.`
            : brief
              ? `The user just created you and sent this first message:\n\n${brief}\n\nIntroduce yourself in one short line, then help with it.`
              : 'The user just created you. Greet the user in one short message, then ask in one short question what you should focus on.'
      const opener = `${kickoff}\nWhere your instructions say otherwise, follow them.`
      const text = !main && language ? `${opener}\nWrite in ${language}.` : opener
      const bot = state.bots[id]
      // A host-owned conversation already has its own history and turn source. Adoption
      // adds only its team identity, never a greeting or a deferred model turn.
      if (existingSessionId !== undefined) {
        await rt.save()
        return bot
      }
      // A Bot about to greet whose level did not hold is not kept: the catch below takes
      // it back, so it never greets on a level wider than the one it was given. One whose
      // greeting waits for a model starts nothing yet (the first Main Bot, which the team
      // view needs, or a copy whose model is not served): its level is checked when the
      // greeting is let go.
      if (modelRef === undefined) {
        await rt.applyPermission(bot, id)
          .catch(error => rt.warn('ds-bot: permission for %s not applied: %s', cleanName, error))
      } else {
        await rt.applyPermission(bot, id, undefined, undefined, { start: true })
      }
      if (denied) {
        await rt.applyToolDeny(bot)
          .catch(error => rt.warn('ds-bot: the denied tools of %s not applied: %s', cleanName, error))
      }
      if (modelRef === undefined) {
        bot.kickoff = { text, from: createdBy ?? null, ...(main ? { main: true } : {}) }
        await rt.save()
        return bot
      }
      await rt.save()
      if (inheritAuto !== undefined && existingSessionId === undefined) await rt.markInherited?.(bot, inheritAuto.route)
      // The greeting runs on the Bot's own model, once its provider is registered.
      void rt.waitForModel(bot)
        .then(() => rt.applyModel(bot).then(() => false, (error) => {
          rt.warn('ds-bot: model for %s not applied: %s', cleanName, error)
          return true
        }))
        // At Full access with its coding CLI model not served, or not selected just above: no
        // greeting on another model.
        .then(unselected => rt.assertNotOffCli(bot, rt.chatOf(bot.id), undefined, { unselected }))
        .then(() => sendKickoff(bot, { text, from: createdBy }), error => rt.warn('ds-bot: %s does not greet: %s', cleanName, error?.message ?? error))
      return bot
    } catch (error) {
      // The Bot's Session was already made: archive it instead of leaving an orphan.
      delete state.bots[id]
      state.mainBotIds = state.mainBotIds.filter(other => other !== id)
      rt.chatOwners.delete(id)
      // A save that another change queued meanwhile still carries this Bot; a later
      // one writes the team without it.
      void rt.save().catch(() => {})
      if (existingSessionId === undefined) await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', cleanName, archiveError))
      throw error
    }
  }

  function sendKickoff(bot, { text, from }) {
    void rt.deliver({ fromId: from ?? undefined, toId: bot.id, text, role: 'kickoff' })
      .catch(error => rt.warn('ds-bot: kickoff failed: %s', error))
  }

  // The user wrote first, so the held greeting would only interrupt.
  function dropKickoff(botId) {
    const bot = rt.botOf(botId)
    if (bot?.kickoff === undefined) return
    delete bot.kickoff
    void rt.save().catch(() => {})
  }

  async function duplicateBot(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw refusal('Unknown Bot')
    const served = (await rt.catalog()).some(entry => entry.ref === bot.model)
    // A folder that went away since leaves the copy in the team workspace.
    const workDir = bot.workDir !== undefined && await rt.isFolder(bot.workDir) ? bot.workDir : undefined
    // No await from here to createBot's check, so two copies at once get different names.
    return createBot({
      name: freshName(`${bot.name} copy`),
      role: bot.role,
      instructions: bot.instructions,
      color: bot.color,
      avatar: bot.avatar,
      model: served ? bot.model : undefined,
      // A copy of a Bot on the model's own default stays on it (null marks the
      // explicit Default pick); else the create would inherit the profile level.
      effort: served ? (bot.effort ?? null) : undefined,
      workDir,
      copyOf: bot.id,
    })
  }

  async function updateBot(id, patch, actorId, fromSessionId) {
    if (['permissionAuto', 'permissionRev', 'autoStamp'].some(key => Object.hasOwn(patch, key))) throw refusal('Only the person turns Auto on, from the Bot\'s permission choice.')
    const bot = rt.botOf(id)
    if (bot === undefined) throw refusal('Unknown Bot')
    // A Bot whose model menu its plugin owns (host-models.js): the model and level are the
    // plugin's, picked by the person only; the rest of the patch goes on as for any Bot.
    if (rt.hostOwned?.(bot) && (patch.model !== undefined || patch.effort !== undefined)) {
      await rt.pickHostModel(bot, { id: patch.model, effort: patch.effort, ack: patch.ack }, actorId)
      const { model: _model, effort: _effort, ack: _ack, ...rest } = patch
      if (Object.keys(rest).every(key => key === 'id')) return bot
      patch = rest
    }
    const policyPatch = contextPatch(patch)
    const policyOnly = Object.keys(patch).every(key => key === 'id' || Object.hasOwn(policyPatch, key))
    if (patch.browserGrants !== undefined && actorId !== undefined) {
      throw refusal(`Only the user can set what ${bot.name} may do in the browser`)
    }
    // The deny list is the Bot's hard restriction, so a Bot cannot lift or narrow it by
    // editing itself (or through a Main Bot's call): only the user's settings change it.
    // Same rule as the browser grants above (#584).
    if (patch.denyTools !== undefined && actorId !== undefined) {
      throw refusal(`Only the user can set what ${bot.name} may use`)
    }
    const browserGrants = patch.browserGrants === undefined ? undefined : cleanBrowserGrants(patch.browserGrants)
    // The tool deny list is checked with the rest, before anything is written: a name this
    // DSH does not serve refuses the update, so a typo cannot quietly weaken the list.
    const denyTools = cleanDenyTools(patch.denyTools)
    if (denyTools !== undefined && denyTools !== null) await rt.assertDenyTools(rt.chatOf(bot.id), denyTools)
    // Checked first, so a folder, model or level that does not pass leaves the rest
    // unchanged too.
    const role = patch.role === undefined ? undefined : cleanRole(patch.role)
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    // An adopted Session works in the folder its host gave it (parts.js `pinned`).
    if (moving && workDir !== bot.workDir && bot.sessionPinned === true) {
      throw refusal(`${bot.name} works in the folder its host gave its conversation, so its folder cannot change here`)
    }
    const modelRef = patch.model === undefined ? undefined
      : patch.model === null || patch.model === '' ? null
      : await rt.resolveModel(patch.model, { checkAccess: true, remember: false, keep: bot.model })
    // A model on another route, or another ACP agent, is a new conversation with a handoff
    // note (RFC 0030, Decided 6 and 10). The menu uses switchRoute for it; a direct update-bot
    // is the same person's pick, so it takes that path too rather than silently carrying the
    // old conversation across the harness. Other fields cannot ride along: the switch is its
    // own step, and the caller can update them after it.
    const currentModel = bot.model ?? bot.appliedModel
    if (modelRef !== undefined && modelRef !== null && currentModel !== undefined && crossesHarness(currentModel, modelRef)) {
      // A host-owned Session has no DSH agent with `whenIdle`, so no fresh part can be
      // started here: its host owns the conversation, and the host's in-place move stands.
      // A DSH agent, pinned included, takes the new-conversation path; the pinned check in
      // switchRoute refuses it rather than carrying the Session across the harness.
      const agent = await rt.resolveAgent(rt.chatOf(bot.id)).catch(() => undefined)
      if (typeof agent?.whenIdle === 'function') {
        const extra = Object.keys(patch).filter(key => key !== 'id' && key !== 'model' && key !== 'effort')
        if (extra.length > 0) throw refusal(`${bot.name} needs a new conversation for that route, so change only its model in this step.`)
        await rt.switchRoute(bot.id, modelRef, patch.effort)
        return bot
      }
    }
    // A new level resolves against the model the Bot will run on: the new one, the
    // model it keeps, or — the model cleared — the one it last ran on.
    const effortRef = modelRef === undefined ? bot.model ?? bot.appliedModel : modelRef ?? bot.appliedModel
    let effortId
    if (patch.effort !== undefined) {
      if (patch.effort === null || patch.effort === '') effortId = null
      else {
        if (effortRef === undefined) throw refusal('Pick a model before choosing a thinking level')
        effortId = await rt.resolveEffort(effortRef, patch.effort)
      }
    }
    // The name and the permission level are checked here too, before the model switch below
    // writes anything: a refusal of either leaves the model as it was.
    const nextName = patch.name === undefined ? undefined : String(patch.name).trim().slice(0, 40)
    if (nextName !== undefined) {
      const clash = rt.findBot(nextName)
      const pending = isHeld('bot', nextName) && normalize(nextName) !== normalize(bot.name)
      if (nextName === '' || (clash && clash.id !== id) || pending) throw refusal(`Name ${nextName} is not available`)
      // A name saved before the rule stays usable until it changes.
      const problem = nextName === bot.name ? undefined : nameProblem(nextName)
      if (problem !== undefined) throw refusal(problem)
    }
    if (patch.permission !== undefined) rt.checkPreset(patch.permission)
    // The model goes first: checked above, applied to the Session now, and only then part of
    // the record. A selection DSH turns down refuses the whole update, with nothing written.
    const markBefore = markOf(bot.model)
    const revBefore = bot.permissionRev
    if (patch.permission !== undefined || (patch.model !== undefined && (bot.permissionAuto
      ? markOf(String(patch.model)) !== bot.permissionAuto
      : String(patch.model).split('/')[0] !== 'acp-codex'))) await rt.clearAuto?.(bot)
    if (patch.denyTools !== undefined && bot.permissionRev === revBefore) rt.movePermissionRev(bot)
    const modelChanged = patch.model !== undefined || patch.effort !== undefined
    const modelBefore = modelChanged ? modelFields(bot) : undefined
    if (modelChanged) await switchModel(bot, patch, modelRef, effortId)
    const roleBefore = bot.role
    const instructionsBefore = bot.instructions
    let unapplied
    try {
      if (nextName !== undefined) {
        bot.name = nextName
        const agent = await rt.resolveAgent(rt.chatOf(id))
        await ctx.sessionTitle.rename(agent.session, nextName)
        await followMemberNames(Object.values(state.rooms).filter(room => room.members.includes(id)))
      }
      if (role !== undefined) bot.role = role
      if (patch.instructions !== undefined) bot.instructions = String(patch.instructions).trim()
      if (patch.color !== undefined) {
        if (patch.color === null) delete bot.color
        else if (isColor(currentColor(patch.color))) bot.color = currentColor(patch.color)
      }
      if (patch.avatar !== undefined) {
        const avatar = cleanAvatar(patch.avatar)
        if (avatar) bot.avatar = avatar
        else delete bot.avatar
      }
      if (patch.permission !== undefined) {
        // A level that was kept but did not reach every Session: the update goes on, and
        // the person is told last.
        await rt.setPermission(bot, patch.permission).catch((error) => {
          if (error?.levelNotApplied !== true) throw error
          unapplied = error
        })
      }
    } catch (error) {
      // A step after the switch still failed (the title, the level's apply): the model goes
      // back too, on the record and on its Sessions, so the refused update leaves it as it was.
      if (modelChanged) await restoreModel(bot, modelBefore)
      throw error
    }
    if (browserGrants !== undefined) {
      if (browserGrants === null) delete bot.browserGrants
      else bot.browserGrants = browserGrants
    }
    if (denyTools !== undefined) {
      if (denyTools === null) delete bot.denyTools
      else bot.denyTools = denyTools
    }
    const moved = moving && workDir !== bot.workDir
    if (moving) {
      if (workDir === undefined) delete bot.workDir
      else bot.workDir = workDir
    }
    for (const [key, value] of Object.entries(policyPatch)) {
      if (value === null) delete bot[key]
      else bot[key] = value
    }
    if (!bot.permissionAuto && markOf(bot.model) !== markBefore && bot.permissionRev === revBefore) rt.movePermissionRev(bot)
    await rt.save()
    // The list changed: every Session of this Bot is lifted and re-set from the new one, so
    // a name added now disappears at once and a name removed comes back.
    if (denyTools !== undefined) {
      await rt.applyToolDeny(bot)
      if (bot.permissionAuto) rt.endAuto(bot)
      // The list changed either way: a restricted Bot's already-armed fresh-Session tasks
      // would keep opening Sessions no deny layer can bind (#584, L5), and a Bot that just
      // became unrestricted releases a task whose pause had been stuck.
      try {
        await rt.revokeNewSchedules?.(bot.id)
      } catch (error) {
        rt.warn('ds-bot: the fresh-Session tasks of %s were not paused: %s', bot.name, error)
      }
    }
    // The system prompt reads the live profile every turn, but a Session with
    // several rounds behind it follows the old kickoff's pull until a message
    // lands; notify the Bot's chat so the next turn honors the new profile.
    const notes = []
    if (bot.role !== roleBefore) notes.push(`Your role is now "${bot.role || '(none)'}"`)
    if (bot.instructions !== instructionsBefore) notes.push(`Your instructions now read:\n${bot.instructions || '(none)'}`)
    // A held greeting means the model pick is still open: the kickoff it later sends
    // already reads the new profile, and a notice would start a turn before that.
    // A Bot editing itself in its own chat just got the tool result in the turn
    // that made the edit; a notice there would only buy it a second, unsolicited
    // reply. The same edit made from a group Session reaches no own-chat turn, so
    // the notice still goes out.
    const selfEditInChat = actorId === bot.id && fromSessionId === rt.chatOf(bot.id)
    if (notes.length > 0 && bot.kickoff === undefined && !selfEditInChat) {
      void rt.deliver({ toId: bot.id, text: notes.join('\n'), role: 'update' })
        .catch(error => rt.warn('ds-bot: profile update for %s not delivered: %s', bot.name, error?.message ?? error))
    }
    if (moved) void rt.followFolder(bot.id)
    if (!policyOnly && bot.model && bot.kickoff !== undefined) {
      // The held greeting is the Bot's first turn: not sent on a level that did not hold.
      // It stays held then, and the next change to the Bot tries again.
      const ready = await rt.applyPermission(bot, rt.chatOf(bot.id), undefined, undefined, { start: true })
        .then(() => true, (error) => {
          rt.warn('ds-bot: the greeting of %s stays held: %s', bot.name, error?.message ?? error)
          return false
        })
      const held = bot.kickoff
      if (ready && held !== undefined) {
        delete bot.kickoff
        await rt.save()
        sendKickoff(bot, held)
      }
    }
    if (unapplied !== undefined) throw unapplied
    return bot
  }

  // A Bot's new model or level, on its Sessions before it is saved. `previousModel` keeps the
  // model it leaves (model-state.js), so a switch that fails on its first turn goes back to it.
  // If DSH turns the selection down, the record is as it was and the update is refused.
  const MODEL_FIELDS = ['model', 'effort', 'previousModel', 'appliedModel', 'appliedEffort']
  const modelFields = bot => Object.fromEntries(MODEL_FIELDS.filter(key => Object.hasOwn(bot, key)).map(key => [key, bot[key]]))
  function putModelFields(bot, before) {
    for (const key of MODEL_FIELDS) {
      if (Object.hasOwn(before, key)) bot[key] = before[key]
      else delete bot[key]
    }
  }

  // An accepted switch undone because the rest of its update was refused: the old fields back,
  // and the old selection on the Bot's Sessions again (applyModel saves the record it restores).
  async function restoreModel(bot, before) {
    putModelFields(bot, before)
    try {
      await rt.applyModel(bot, { force: true })
    } catch (error) {
      rt.warn('ds-bot: the model of %s was not selected again: %s', bot.name, error?.message ?? error)
    }
    putModelFields(bot, before)
  }

  async function switchModel(bot, patch, modelRef, effortId) {
    const before = modelFields(bot)
    if (patch.model !== undefined) {
      rt.noteModelChoice?.(bot, modelRef ?? undefined)
      if (modelRef === null) delete bot.model
      else bot.model = modelRef
    }
    if (patch.effort !== undefined) {
      if (effortId === null) delete bot.effort
      else bot.effort = effortId
    }
    try {
      await rt.applyModel(bot, { force: true })
    } catch (error) {
      putModelFields(bot, before)
      rt.warn('ds-bot: the model of %s was not changed: %s', bot.name, error?.message ?? error)
      if (typeof error?.code === 'string' && error.code.startsWith('bot/')) throw error
      const wanted = patch.model === undefined ? 'this thinking level' : modelRef ?? 'no model'
      throw refusal(`${bot.name} could not switch to ${wanted}. It stays on ${before.model ?? 'its current model'}.`, { cause: error })
    }
  }

  async function setFlags(id, { pinned, hidden }) {
    const entry = rt.botOf(id) ?? rt.roomOf(id) ?? rt.own(state.agents, id)
    if (entry === undefined) throw refusal('Unknown conversation')
    if (typeof pinned === 'boolean') entry.pinned = pinned
    if (typeof hidden === 'boolean') entry.hidden = hidden
    await rt.save()
    return entry
  }

  // ---------------------------------------------------------------------------
  // Group chat settings. The user and every Main Bot may change any group; a group's
  // admin may change its own group but not delete it. Only a member can be admin.

  const roomBusy = id => [...rt.roomProgress.values()].some(round => round.roomId === id)
  const autoRoomName = members => ['You', ...members.map(id => rt.botOf(id)?.name).filter(Boolean)].join(', ')
  const cleanNotice = text => String(text ?? '').trim().slice(0, ROOM_NOTICE_MAX)

  function cleanRoomName(text, selfId) {
    const next = unquote(text).replace(/\s+/g, ' ').slice(0, ROOM_NAME_MAX)
    if (next !== '' && (rt.findRooms(next).some(room => room.id !== selfId) || isHeld('room', next))) throw refusal(`Another group chat is already called "${next}"`)
    return next
  }

  async function retitleRoom(room) {
    try {
      const agent = await rt.resolveAgent(room.id)
      await ctx.sessionTitle.rename(agent.session, room.name)
    } catch (error) {
      rt.warn('ds-bot: group title for %s not updated: %s', room.name, error)
    }
  }

  // Groups without a chosen name are named after their members, so they follow renames.
  async function followMemberNames(rooms = Object.values(state.rooms)) {
    for (const room of rooms) {
      if (room.named) continue
      const next = autoRoomName(room.members)
      if (next === room.name) continue
      room.name = next
      await retitleRoom(room)
    }
  }

  function checkMembers(members) {
    if (members.length < 2) throw refusal('A group chat needs at least two Bots')
    if (members.length > ROOM_MAX_MEMBERS) throw refusal(`A group chat holds at most ${ROOM_MAX_MEMBERS} Bots`)
  }

  // A Main Bot leads the groups it makes; a group the user makes is led by a Main Bot
  // member when it has one.
  const defaultAdmin = (members, createdBy) => (members.includes(createdBy) ? createdBy : members.find(rt.isMain) ?? null)

  async function createRoom({ members: memberIds = [], name: roomName, notice, mode, admin, createdBy } = {}) {
    const members = [...new Set(memberIds)].filter(isLive)
    checkMembers(members)
    const custom = cleanRoomName(roomName ?? '')
    const adminId = admin !== undefined ? admin : defaultAdmin(members, createdBy)
    if (adminId !== null && !members.includes(adminId)) throw refusal('The admin must be a member of the group')
    if (mode !== undefined && !ROOM_MODES.includes(mode)) throw refusal(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    return holdName('room', custom, () => buildRoom({ members, custom, notice, mode, adminId, createdBy }))
  }

  async function buildRoom({ members, custom, notice, mode, adminId, createdBy }) {
    const title = custom || autoRoomName(members)
    // The group's own Session only relays, so it stays in the team workspace; the
    // group's folder is for its members' Sessions.
    const id = await createSession(title)
    try {
      // A member deleted while the Session was made stays out, and the group is checked
      // again as it is written.
      const live = members.filter(isLive)
      checkMembers(live)
      const lead = adminId === null || live.includes(adminId) ? adminId : defaultAdmin(live, createdBy)
      const name = custom || autoRoomName(live)
      const room = {
        id,
        name,
        ...(custom ? { named: true } : {}),
        members: live,
        admin: lead,
        mode: mode ?? 'admin',
        notice: cleanNotice(notice),
        createdAt: Date.now(),
        createdBy: createdBy ?? null,
      }
      state.rooms[id] = room
      await rt.save()
      if (name !== title) await retitleRoom(room)
      return room
    } catch (error) {
      // The group's Session was already made: archive it instead of leaving an orphan.
      delete state.rooms[id]
      void rt.save().catch(() => {})
      await ctx.workspaceRegistry.archiveSession(id)
        .catch(archiveError => rt.warn('ds-bot: archiving the Session for %s failed: %s', title, archiveError))
      throw error
    }
  }

  // What a change would write to the group as it is now, or why it cannot be made. It
  // reads only the team, so updateRoom runs it to fail fast and again after its last
  // await: another change or a deleted Bot may have come in meanwhile, and `add` and
  // `remove` apply to the members the group has then.
  function planRoomChange(room, patch, actorId) {
    const byMain = actorId === undefined || rt.isMain(actorId)
    const byAdmin = !byMain && rt.isAdminOf(room, actorId)
    if (!byMain && !byAdmin) throw refusal(`Only the user, a Main Bot, or the admin of "${room.name}" can change it`)
    let members = Array.isArray(patch.members) ? [...new Set(patch.members)] : [...room.members]
    for (const member of patch.add ?? []) if (!members.includes(member)) members.push(member)
    members = members.filter(member => !(patch.remove ?? []).includes(member) && isLive(member))
    // A group left with one Bot by a deletion can still change its other settings.
    const current = room.members.filter(isLive)
    if (members.length !== current.length || members.some(member => !current.includes(member))) checkMembers(members)
    let admin = room.admin ?? null
    if (patch.admin !== undefined) {
      admin = patch.admin || null
      if (admin === null && byAdmin) throw refusal('Hand the admin role to another member instead of leaving the group without one')
      if (admin !== null && !members.includes(admin)) throw refusal(`${rt.botOf(admin)?.name ?? 'That Bot'} must be a member to be the admin`)
    }
    if (admin !== null && !members.includes(admin)) {
      if (byAdmin && admin === actorId) throw refusal('Hand the admin role to another member before leaving the group')
      admin = null
    }
    if (patch.mode !== undefined && !ROOM_MODES.includes(patch.mode)) throw refusal(`Reply mode must be one of ${ROOM_MODES.join(', ')}`)
    const notice = patch.notice === undefined ? undefined : cleanNotice(patch.notice)
    if (patch.workDir !== undefined && byAdmin) throw refusal(`Only the user or a Main Bot can set the folder of "${room.name}"`)
    // A Bot's own permissions are the user's to set, so a group's are too.
    if (patch.permission !== undefined && actorId !== undefined) throw refusal(`Only the user can set the permissions of "${room.name}"`)
    const permission = patch.permission === undefined ? undefined : rt.cleanRoomPermission(patch.permission)
    // The relay limit is the user's guard against a group that never stops; it is
    // not a member's to move, whatever its role.
    if (patch.relayLimit !== undefined && actorId !== undefined) throw refusal(`Only the user can set the relay limit of "${room.name}"`)
    let relayLimit
    if (patch.relayLimit === null) relayLimit = null
    else if (patch.relayLimit !== undefined) {
      if (!Number.isInteger(patch.relayLimit) || patch.relayLimit < 1 || patch.relayLimit > 200) throw refusal('Relay limit must be a whole number from 1 to 200')
      relayLimit = patch.relayLimit
    }
    // The second run is the last check before the change is written, so no other change
    // can take the name in between.
    const name = patch.name === undefined ? undefined : cleanRoomName(patch.name, room.id)
    return { members, admin, name, notice, permission, relayLimit }
  }

  // `actorId` is the Bot asking, or undefined for the user. Returns what changed, in words.
  async function updateRoom(id, patch, actorId) {
    const asked = rt.roomOf(id)
    if (asked === undefined) throw refusal('Unknown group chat')
    planRoomChange(asked, patch, actorId)
    const moving = patch.workDir !== undefined
    const workDir = moving ? await rt.cleanWorkDir(patch.workDir ?? '') : undefined
    // No await from here until every change is written.
    const room = rt.roomOf(id)
    if (room === undefined) throw refusal('Unknown group chat')
    const { members, admin, name, notice, permission, relayLimit } = planRoomChange(room, patch, actorId)

    const changes = []
    const names = ids => ids.map(member => rt.botOf(member)?.name).filter(Boolean).join(', ')
    const added = members.filter(member => !room.members.includes(member))
    const removed = room.members.filter(member => !members.includes(member))
    const addedAt = changes.length
    if (added.length > 0) changes.push(`added ${names(added)}`)
    // A deleted Bot still listed goes without a word.
    if (names(removed) !== '') changes.push(`removed ${names(removed)}`)
    // A member who leaves and comes back starts from a fresh look at the log.
    for (const member of removed) {
      if (room.seen) delete room.seen[member]
      // Its group Session leaves the team's maps here, and that Session is the only lineage
      // a fresh-Session task armed there has (#584, L5): capture the ids now and let the
      // pause finish on its own, so this change stays written without an await.
      const parts = (room.segments?.[member] ?? []).map(part => part.sessionId)
      const lost = [room.sessions?.[member], ...parts].filter(Boolean)
      if (lost.length > 0) {
        void rt.revokeNewSchedules?.(member, lost)
          .catch(error => rt.warn('ds-bot: the fresh-Session tasks of %s were not paused: %s',
            member, error))
      }
      rt.dropGroupSession(room, member)
    }
    room.members = members
    if (admin !== (room.admin ?? null)) changes.push(admin ? `made ${rt.botOf(admin).name} the admin` : 'removed the admin')
    room.admin = admin
    if (patch.mode !== undefined && patch.mode !== room.mode) {
      room.mode = patch.mode
      changes.push(patch.mode === 'admin' ? 'plain messages now go to the admin first' : 'every member now replies in turn')
    }
    if (relayLimit !== undefined && relayLimit !== (room.relayLimit ?? null)) {
      if (relayLimit === null) delete room.relayLimit
      else room.relayLimit = relayLimit
      changes.push(relayLimit === null ? 'Bots pause at the default relay count again' : `Bots now pause after ${relayLimit} relays`)
    }
    if (notice !== undefined && notice !== (room.notice ?? '')) {
      room.notice = notice
      changes.push(notice ? 'updated the notice' : 'cleared the notice')
    }
    // Members' group conversations move on to the folder at their next turn there.
    if (moving && workDir !== room.workDir) {
      if (workDir === undefined) delete room.workDir
      else room.workDir = workDir
      changes.push(workDir ? `every member now works in ${workDir} here` : 'every member works in its own folder again')
    }
    const before = room.name
    if (name !== undefined) {
      if (name !== '') {
        room.named = true
        room.name = name
      } else {
        delete room.named
      }
    }
    if (!room.named) room.name = autoRoomName(room.members)
    // The preset is written before its first await; the members' Sessions follow it. One
    // that was kept but did not reach every Session: the update goes on, and the person is
    // told last.
    let unapplied
    const releveled = permission !== undefined && await rt.setRoomPermission(room, permission).catch((error) => {
      if (error?.levelNotApplied !== true) throw error
      unapplied = error
      return true
    })
    if (releveled) {
      changes.push(permission ? `every member now works with the ${permission} permissions here` : 'every member uses its own permissions again')
    }
    if (room.name !== before) {
      changes.push(`renamed it "${room.name}"`)
      await retitleRoom(room)
    }
    await rt.save()
    // The words say what the group holds now: a Bot whose deletion began during the
    // awaits above has left it again, so it is not reported as added.
    const kept = added.filter(member => room.members.includes(member) && isLive(member))
    if (kept.length < added.length) changes.splice(addedAt, 1, ...(kept.length > 0 ? [`added ${names(kept)}`] : []))
    if (unapplied !== undefined) throw unapplied
    return { room, changes }
  }

  async function deleteRoom(id) {
    const room = rt.roomOf(id)
    if (room === undefined) throw refusal('Unknown group chat')
    // Before the group's Sessions leave the state, which the archive reads.
    const archived = rt.archiveGroupMemory(room)
    // A fresh-Session task armed from one of these Sessions has no other lineage (#584, L5).
    for (const botId of Object.keys(room.sessions ?? {})) {
      const parts = (room.segments?.[botId] ?? []).map(part => part.sessionId)
      const lost = [room.sessions[botId], ...parts]
      try {
        await rt.revokeNewSchedules?.(botId, lost)
      } catch (error) {
        rt.warn('ds-bot: the fresh-Session tasks of %s were not paused: %s', botId, error)
      }
    }
    for (const botId of Object.keys(room.sessions ?? {})) rt.dropGroupSession(room, botId)
    // Its tasks keep the level they run at as a cap, then take their Bot's own or lower.
    rt.capTasks(task => rt.taskOfRoom(task, id))
    delete state.rooms[id]
    rt.roomInbox.delete(id)
    rt.dropGroupLines(id)
    await rt.reapplyTasks(task => rt.taskOfRoom(task, id))
    await archived
    const failed = await saveForDelete()
    // Armed scheduled tasks refuse a plain archive and would keep delivering into
    // the deleted group; the session-stop that stopActivity runs removes them.
    await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
      .catch(error => rt.warn('ds-bot: group chat %s not archived: %s', room.name, error))
    if (failed !== undefined) throw failed
  }

  // The first Main Bot is the sidebar tile. `replace` gives a Main Bot's place to
  // another Bot in one step, so the team never has none; `primary` moves a Bot to the
  // front and keeps the others.
  async function setMain(id, main, { primary = false, replace } = {}) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw refusal('Unknown Bot')
    const others = state.mainBotIds.filter(other => other !== id)
    let next
    if (!main) {
      if (!rt.isMain(id)) return
      if (others.length === 0) throw refusal('The team needs at least one Main Bot')
      next = others
    } else if (replace !== undefined && replace !== id) {
      const at = others.indexOf(replace)
      if (at === -1) throw refusal('Only a Main Bot can be replaced')
      next = others.with(at, id)
    } else if (primary) {
      next = [id, ...others]
    } else {
      next = rt.isMain(id) ? state.mainBotIds : [...others, id]
    }
    // The sidebar shows every Main Bot, so a hidden Bot would vanish again once demoted.
    if (main) delete bot.hidden
    // A held setup greeting says "you are the Main Bot"; it must not go out after demotion.
    for (const other of state.mainBotIds.filter(other => !next.includes(other))) {
      if (rt.botOf(other)?.kickoff?.main) delete rt.botOf(other).kickoff
    }
    state.mainBotIds = next
    await rt.save()
  }

  // #376: a second deleteBot of a Bot whose deletion still runs gets that deletion, so it
  // ends with it: it resolves once the Bot is deleted, or rejects with the same error when
  // the deletion fails and the Bot stays. Nothing runs twice. Once the first has ended,
  // the Bot is unknown (deleted) or can be deleted again (failed).
  function deleteBot(id) {
    const running = deletions.get(id)
    if (running !== undefined) return running
    const run = deleteNow(id)
    deletions.set(id, run)
    const forget = () => { if (deletions.get(id) === run) deletions.delete(id) }
    run.then(forget, forget)
    return run
  }

  async function deleteNow(id) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw refusal('Unknown Bot')
    if (rt.isMain(id)) throw refusal('A Main Bot cannot be deleted; remove its Main Bot role first')
    if (bot.dshAgentId !== undefined) throw refusal('Roll back DSH adoption before deleting the original DSH bot')
    const current = rt.chatOf(id)
    // Questions and exchange turns are kept per Session, so every part of the chat is cleared.
    const parts = new Set([id, current, ...(bot.segments ?? []).map(segment => segment.sessionId)])
    // Read before the Bot leaves its groups' Sessions: releaseBot tells who waits on them.
    const sessions = [...parts, ...rt.groupSessionsOf(id)]
    // #366: the Bot leaves its groups, and its admin roles, before the first await, so a
    // group change that goes on meanwhile sees it gone whichever call resumes first. Its
    // record stays until releaseBot is done: the archive and releaseBot read it (the Bots
    // told of the deletion hear its name), and a failure up to there leaves it in the
    // team, where putBack puts it back in the groups in `left`.
    deleting.add(id)
    const left = []
    for (const room of Object.values(state.rooms)) {
      const index = room.members.indexOf(id)
      if (index === -1) continue
      left.push({ room, index, admin: room.admin === id })
      room.members = room.members.filter(member => member !== id)
      if (room.admin === id) room.admin = null
    }
    // A Bot's already-armed fresh-Session tasks would keep opening Sessions after it is
    // gone, with no Bot left to bind them to (#584, L5). Pause them before its Sessions are
    // released; the records stay, and a failed deletion leaves them paused.
    try {
      await rt.revokeNewSchedules?.(id, sessions, { any: true })
    } catch (error) {
      rt.warn('ds-bot: the fresh-Session tasks of %s were not paused: %s', bot.name, error)
    }
    let archived
    try {
      await rt.releaseBot(id, sessions)
      // #376: only once its Sessions are released, so a failed release keeps its memory.
      // Before the Bot and its group Sessions leave the state, which the archive reads.
      archived = rt.archiveBotMemory(id)
    } catch (error) {
      deleting.delete(id)
      await putBack(id, left)
      throw error
    }
    // #376: only once its Sessions are released, so a failed release keeps the Bot's btw
    // cards and side chats. From here the deletion goes on (the Bots waiting on it were
    // told it was deleted), so a step that fails is warned and does not keep the Bot.
    for (const step of deleteSteps) {
      try {
        await step(id)
      } catch (error) {
        rt.warn('ds-bot: clearing Bot %s failed: %s', bot.name, error)
      }
    }
    deleting.delete(id)
    // Its tasks keep the level they run at as a cap, so the default cannot raise them.
    rt.capTasks(task => task.from === id)
    if (bot.permissionAuto) rt.endAuto?.(bot)
    delete state.bots[id]
    // Only a still-unapproved local MCP this Bot alone asked for leaves with it.
    rt.dropOrphanCapabilities?.(bot)
    for (const part of parts) {
      delete state.questions[part]
      if (state.views !== undefined) delete state.views[part]
      delete state.exchangeTurns[part]
      delete state.switching[part]
    }
    const touched = []
    // Every group is checked again, not only those it left above, so none keeps it.
    for (const room of Object.values(state.rooms)) {
      if (!room.members.includes(id) && !left.some(entry => entry.room === room)) continue
      room.members = room.members.filter(member => member !== id)
      if (room.admin === id) room.admin = null
      rt.dropGroupSession(room, id)
      touched.push(room)
    }
    await followMemberNames(touched)
    // Its tasks go on as Sessions of their own, at the catalog default or lower.
    await rt.reapplyTasks(task => task.from === id)
    await rt.forgetBotSecrets(id)
    await archived
    const failed = await saveForDelete()
    // Same as deleteRoom: stopActivity removes the Session's armed scheduled tasks.
    // Past parts are archived too: a part move can leave tasks on the old Session,
    // which otherwise stays armed and invisible. Already-archived ids are a no-op.
    for (const part of parts) {
      await ctx.workspaceRegistry.archiveSession(part, { stopActivity: true })
        .catch(error => rt.warn('ds-bot: Bot %s not archived: %s', bot.name, error))
    }
    if (failed !== undefined) throw failed
  }

  // A deletion that fails puts the Bot back in the groups it left, as their member and
  // admin again, and saves that (#376): a save in the window wrote them without it, and a
  // restart before the next save would read them so. Only its place is put back, so a
  // change made meanwhile stays, in memory and on disk. The Bot counts as live again
  // before the save, so a group change that goes on meanwhile keeps it. A failed save is
  // warned, and the caller hears the deletion's own error.
  async function putBack(id, left) {
    let back = false
    for (const { room, index, admin } of left) {
      if (state.rooms[room.id] !== room) continue
      if (!room.members.includes(id)) room.members = room.members.toSpliced(Math.min(index, room.members.length), 0, id)
      if (admin && (room.admin ?? null) === null) room.admin = id
      back = true
    }
    if (!back) return
    try {
      await rt.save()
    } catch (error) {
      rt.warn('ds-bot: Bot %s is back in its groups, but that was not saved: %s', id, error)
    }
  }

  // A deletion whose save fails stays in memory, and the next save writes it, so its
  // Sessions are stopped anyway: left armed, their scheduled tasks would keep running
  // with nothing in the team to show or delete them. Only a host that lost the team
  // to another dsh keeps them, since the other host's copy still has them.
  async function saveForDelete() {
    try {
      await rt.save()
      return undefined
    } catch (error) {
      if (error?.code === 'ELOCKLOST' || rt.readOnly() !== undefined) throw error
      return error
    }
  }

  async function bootstrap() {
    await rt.load()
    void rt.syncModels()
    if (state.mainBotIds.some(id => rt.botOf(id))) return
    // Only the team's first Main Bot is stored as the DeepSeek whale; other Bots get a
    // look from their id, and a Bot made Main Bot later keeps its own. A plugin that brings
    // the team's first Main Bot (rt.mainBotMaker: Unfold in its own instance) makes it
    // instead; one that brings none leaves the default to the team.
    const makeDefault = () => createBot({ name: defaults.mainName, role: defaults.mainRole, main: true, color: 'deepseek', avatar: { shape: 'octopus' }, pickModel: true })
    const maker = typeof rt.mainBotMaker === 'function' ? rt.mainBotMaker : undefined
    // In Unfold's own instance Unfold leads: until its plugin applies, a state read makes no
    // default Main Bot, and the plugin's own bootstrap makes Unfold the first one.
    if (maker === undefined && bootstrapping === null && inUnfoldInstance()) return
    // A maker that fails or gives no answer is dropped for this bootstrap, so a state read never
    // fails or waits on it: the team goes on as with no maker (its default, or none in Unfold's
    // instance).
    const fromMaker = async () => {
      const bot = await askMaker(maker)
      if (bot === NO_ANSWER) return inUnfoldInstance() ? undefined : makeDefault()
      return state.mainBotIds.some(id => rt.botOf(id)) ? bot : makeDefault()
    }
    bootstrapping ??= (maker ? fromMaker() : makeDefault())
      .finally(() => { bootstrapping = null })
    await bootstrapping
  }

  function askMaker(maker) {
    const ms = rt.mainBotMakerMs ?? MAIN_BOT_MAKER_MS
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        rt.warn('ds-bot: the Main Bot maker gave no answer in %d ms; the team makes its own', ms)
        resolve(NO_ANSWER)
      }, ms)
      Promise.resolve().then(maker).then((bot) => {
        clearTimeout(timer)
        resolve(bot)
      }, (error) => {
        clearTimeout(timer)
        rt.warn('ds-bot: the Main Bot maker failed; the team makes its own: %s', error?.message ?? error)
        resolve(NO_ANSWER)
      })
    })
  }

  Object.assign(rt, {
    ensureWorkspace, keepTeamFolder, createSession, createBot, duplicateBot, updateBot, setFlags,
    roomBusy, autoRoomName, retitleRoom, createRoom, updateRoom, deleteRoom,
    setMain, deleteBot, beforeBotDelete, bootstrap, dropKickoff,
  })
}
