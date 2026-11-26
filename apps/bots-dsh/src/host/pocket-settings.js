import { createHash } from 'node:crypto'
import { MARK_LEVEL } from '../shared/permission-levels.js'
import { routeAllowed } from '../shared/route-policy.js'
import { commandCapableAgent, crossesHarness } from '../shared/routes.js'
import { deniesAcpTool } from '../shared/own-tools.js'
import { CUSTOM, LEVELS } from './permission-diagnostics.js'
import { MAX_SCHEDULE_LINE, MODEL_REF_OK, refusedWrite, settingsReply } from './pocket-socket.js'

export { MODEL_REF_OK }

const NOT_APPLIED = 'The computer could not switch the Bot to that model, so it stays on its current one.'
const PENDING = { ok: false, state: 'unknown', reason: 'pending' }
const MAX_MODEL_ENTRIES = 200
const cut = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : null

export class SettingsRefusal extends Error {
  constructor(reason, withSettings) {
    super(reason)
    this.reason = reason
    this.withSettings = withSettings
  }
}

/** The own chat refused the pick before a selection was applied. */
export class SettingsSelectionRejected extends Error {}

export function settingsRevOf(botId, bot) {
  return createHash('sha256').update(JSON.stringify([
    botId, typeof bot.name === 'string' ? bot.name : '', bot.model ?? null, bot.effort ?? null,
    bot.permission ?? null, bot.permissionAuto ?? null, bot.permissionRev ?? 0,
  ])).digest('hex').slice(0, 16)
}

function blockOf(rt, bot, method) {
  if (bot.kickoff !== undefined) return { reason: 'computer', editable: 'greeting' }
  if (method !== 'model') return
  if (rt.hostOwned?.(bot)) return { reason: 'computer', editable: 'host-model' }
  if (bot.shellHeld !== undefined) return { reason: 'computer', editable: 'shell' }
  if ((bot.model ?? bot.appliedModel) === undefined) return { reason: 'computer', editable: 'no-model' }
  if (rt.pickingModel?.(bot.id) || rt.switchingChat?.(bot.id)) return { reason: 'changing', editable: 'changing' }
}

export function modelChoiceOf(rt, bot, entry) {
  const current = bot.model ?? bot.appliedModel
  return MODEL_REF_OK(entry.ref) && !entry.covered && !entry.needsKey && !entry.needsSignIn
    && !entry.needsAccount && !entry.superseded && current !== undefined
    && !crossesHarness(current, entry.ref) && routeAllowed(bot, entry.ref, rt.routePolicy)
    && !(bot.shell === false && commandCapableAgent(entry.ref))
    // The server refuses a Bot that denies acp_tool a model that runs its own tools (#2026).
    && !(entry.ref !== current && deniesAcpTool(bot.denyTools) && rt.ownToolsRoute?.(entry.ref) === true)
}

const modelChoicesOf = (rt, bot, catalog) => catalog.filter(entry => modelChoiceOf(rt, bot, entry))
const listsModel = (rt, bot, catalog, entry) => catalog !== undefined
  && modelChoicesOf(rt, bot, catalog).slice(0, MAX_MODEL_ENTRIES).includes(entry)

const levelKey = value => typeof value !== 'string' || value === '' ? null : LEVELS.has(value) ? value : CUSTOM

function readField(read) {
  try { return read() } catch { return undefined }
}

const snapshotOf = rt => rt.cachedCatalog({ held: true })

export function settingsOf(rt, botId, bot, terminal) {
  const catalog = readField(() => snapshotOf(rt)) ?? []
  const running = readField(() => rt.runningOf?.(bot))
  const label = readField(() => rt.hostOwned?.(bot) ? rt.hostAnsweringOf?.(bot) : catalog.find(entry => entry.ref === bot.model)?.name)
  const presets = readField(() => rt.permissionCatalog?.())
  const fallback = readField(() => rt.permissionFallbackOf?.('bot', bot))
  const autoView = readField(() => rt.autoViewOf?.(bot))
  const runs = levelKey(readField(() => {
    const chat = rt.chatOf(botId)
    const session = rt.ctx.sessions?.list?.().find(session => session.id === chat)
    return rt.permissionFactsOf?.(chat, session)?.effective
  }))
  const nameBlock = blockOf(rt, bot, 'name')
  const modelBlock = readField(() => blockOf(rt, bot, 'model'))
  const reason = (nameBlock ?? modelBlock)?.editable
  const editable = { name: nameBlock === undefined, model: modelBlock === undefined, ...(reason === undefined ? {} : { reason }) }
  const settings = {
    terminal, rev: settingsRevOf(botId, bot), name: typeof bot.name === 'string' ? bot.name : '',
    model: {
      saved: bot.model ?? null, label: cut(label, 200), applied: bot.appliedModel ?? null,
      running: running?.runningModel ?? null, effort: bot.effort ?? null, runningEffort: running?.runningEffort ?? null,
    },
    level: {
      saved: levelKey(bot.permission ?? presets?.defaultPreset),
      inherited: bot.permission === undefined,
      auto: bot.permission === MARK_LEVEL && typeof bot.permissionAuto === 'string',
      ...(fallback?.permissionFallback || autoView?.permissionFallback ? { fallback: MARK_LEVEL } : {}),
      ...(fallback?.permissionNotOffered || autoView?.permissionNotOffered ? { notOffered: true } : {}),
      ...(runs === null ? {} : { runs }),
    },
    editable,
  }
  const entries = editable.model ? modelChoicesOf(rt, bot, catalog).map(entry => ({
    id: entry.ref, label: cut(entry.name ?? entry.ref, 200), provider: cut(entry.providerName ?? entry.provider ?? '', 80),
  })) : []
  return { settings, entries }
}

export function fitReply(base, entries, overhead, limit = MAX_SCHEDULE_LINE) {
  const models = { entries: [], truncated: false }
  const result = { ...base, models }
  let bytes = overhead + Buffer.byteLength(JSON.stringify(result))
  if (bytes > limit) return refusedWrite('too-large')
  for (const entry of entries.slice(0, MAX_MODEL_ENTRIES)) {
    const extra = Buffer.byteLength(JSON.stringify(entry)) + (models.entries.length === 0 ? 0 : 1)
    // "true" takes one fewer byte than "false".
    if (bytes + extra - (models.entries.length + 1 < entries.length ? 1 : 0) > limit) break
    bytes += extra
    models.entries.push(entry)
  }
  models.truncated = models.entries.length < entries.length
  return result
}

export function pocketSettingsOf(rt) {
  const enabled = () => [
    rt.updateBot, rt.catalog, rt.cachedCatalog, rt.quietCatalog, rt.botNameRefusal,
    rt.holdsLock, rt.readOnly, rt.teamLoaded, rt.teamCurrent,
  ].every(fn => typeof fn === 'function')
  const readable = () => rt.teamLoaded() === true && rt.holdsLock() === true
    && rt.readOnly() === undefined && rt.teamCurrent() === true

  async function run(method, { botId, terminal, rev, name, model, allowed }) {
    const reason = allowed()
    if (reason !== undefined) return refusedWrite(reason)
    const bot = rt.botOf(botId)
    const withSettings = (result, applied = false) => ({
      ...result, applied,
      [settingsReply]: (overhead) => {
        const { settings, entries } = settingsOf(rt, botId, rt.botOf(botId), terminal)
        return fitReply({ ...result, settings }, entries, overhead)
      },
    })
    if (method === 'read') return withSettings({ ok: true, state: 'read' })

    const readingName = method === 'name'
    const snapshot = readingName ? undefined : snapshotOf(rt)
    if (!readingName && snapshot === undefined) return refusedWrite('unavailable')
    const stale = target => target !== bot || rt.botOf(botId) !== bot || settingsRevOf(botId, bot) !== rev
    if (stale(bot)) return withSettings(refusedWrite('stale'))
    if (readingName ? name.trim().slice(0, 40) === bot.name : model === bot.model) {
      return withSettings({ ok: true, state: 'unchanged' })
    }
    const block = blockOf(rt, bot, method)
    if (block) return withSettings(refusedWrite(block.reason))

    const nameRefusal = () => {
      const message = rt.botNameRefusal(botId, name)
      return message === undefined ? undefined : refusedWrite('invalid', { message: cut(message, 300) })
    }
    let modelEntry
    if (readingName) {
      const invalid = nameRefusal()
      if (invalid) return withSettings(invalid)
    } else {
      modelEntry = snapshot.find(entry => entry.ref === model)
      if (!modelEntry) return withSettings(refusedWrite('unknown-model'))
      if (!listsModel(rt, bot, snapshot, modelEntry)) return withSettings(refusedWrite('model-not-allowed'))
    }

    let admitted = false
    const admit = ({ bot: target, model: ref, checkOnly }) => {
      const reason = allowed()
      if (reason !== undefined) throw new SettingsRefusal(reason, false)
      if (stale(target)) throw new SettingsRefusal('stale', true)
      const block = blockOf(rt, target, method)
      if (block) throw new SettingsRefusal(block.reason, true)
      if (modelEntry && (ref !== model || !listsModel(rt, target, snapshotOf(rt), modelEntry))) {
        throw new SettingsRefusal('model-not-allowed', true)
      }
      if (!checkOnly) admitted = true
    }
    const patch = readingName ? { id: botId, name } : { id: botId, model }
    try {
      await rt.quietCatalog(() => rt.updateBot(botId, patch, undefined, undefined,
        modelEntry === undefined ? { admit } : { admit, modelEntry }))
      rt.noteFailure?.({ level: 'info', source: 'host', bot: botId, where: 'pocket-settings',
        text: readingName ? "Pocket changed the Bot's name" : "Pocket changed the Bot's model" })
      return withSettings({ ok: true, state: 'saved' }, true)
    } catch (error) {
      if (error instanceof SettingsRefusal) {
        return error.withSettings ? withSettings(refusedWrite(error.reason)) : refusedWrite(error.reason)
      }
      // A model found to run its own tools after admission (#2026): refused, never pending.
      if (error?.ownTools === true) return withSettings(refusedWrite('model-not-allowed'))
      if (!admitted && typeof error?.code === 'string' && error.code.startsWith('bot/')) {
        if (stale(bot)) return withSettings(refusedWrite('stale'))
        const block = blockOf(rt, bot, method)
        if (block) return withSettings(refusedWrite(block.reason))
        return withSettings(readingName ? nameRefusal() ?? refusedWrite('computer')
          : refusedWrite(error.modelUnavailable === true ? 'unknown-model' : 'model-not-allowed'))
      }
      if (modelEntry && error instanceof SettingsSelectionRejected) {
        return withSettings(refusedWrite('not-applied', { message: error.message || NOT_APPLIED }), true)
      }
      rt.warn('pocket settings: unavailable')
      return admitted ? withSettings(PENDING, true) : refusedWrite('unavailable')
    }
  }

  return { enabled, readable, run }
}
