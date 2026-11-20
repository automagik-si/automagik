import { randomUUID } from 'node:crypto'
import { callerService, multiuserMode } from './multiuser.js'
import { cleanPeople, ownersOnly, peopleOf } from './people.js'
import { closesPart } from './caller-view.js'
import { refusal } from './refusal.js'

const inSegments = (segments, id) => Array.isArray(segments) && segments.some(segment => segment?.sessionId === id)
const unavailable = () => refusal('Sharing needs multiuser mode')

export function install(rt) {
  const { ctx, state } = rt
  const shares = new Map()
  const closed = new Set()
  const listeners = new Set()
  let queue = Promise.resolve()
  let service, removeProvider, removeEvent, ready, disposed
  let adopted = rt.teamLoaded()
  let resetDirty = false

  const peopleQueue = fn => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }
  const active = () => !disposed && service !== undefined && service === callerService(ctx)
  const enabled = () => active() && ready === service
  const accessChanged = (withdrawn = false) => {
    rt.accessGeneration++
    const caller = callerService(ctx)
    if (!caller && !withdrawn) return
    try { caller?.invalidate() } catch {}
    for (const listener of listeners) {
      try { listener('*') } catch {}
    }
  }

  function claims(botId, sessionId) {
    const found = []
    for (const [id, room] of Object.entries(state.rooms)) {
      if (rt.sessionOfRoom(room) === sessionId || inSegments(room.parts, sessionId) ||
          Object.values(room.segments ?? {}).some(segments => inSegments(segments, sessionId)) ||
          Object.values(room.sessions ?? {}).includes(sessionId)) found.push('room:' + id)
    }
    for (const [id, run] of Object.entries(state.subscriptionRuns ?? {})) {
      if (run?.sessionId === sessionId) found.push('run:' + id)
    }
    if (Object.hasOwn(state.tasks ?? {}, sessionId)) found.push('task:' + sessionId)
    for (const [id, bot] of Object.entries(state.bots)) {
      if (id !== botId && (rt.chatOf(id) === sessionId || inSegments(bot.segments, sessionId))) found.push('bot:' + id)
    }
    return found.sort()
  }

  function readableParts(botId) {
    const share = shares.get(botId)
    const bot = rt.botOf(botId)
    if (!enabled() || share?.state !== 'open' || !bot || rt.readOnly() !== undefined ||
        !rt.canWriteTeam() || peopleOf(bot).mode === 'owners') return []
    const published = new Set(share.parts)
    return rt.partsOf(botId).filter(({ sessionId }) => published.has(sessionId) && !closed.has(sessionId) &&
      (rt.chatOf(botId) === sessionId || inSegments(bot.segments, sessionId)) && claims(botId, sessionId).length === 0)
  }

  function commit(botId, bot, people, afterCommit) {
    return rt.saveCopy(copy => { copy.bots[botId].people = people }, {
      afterWrite: () => {
        bot.people = people
        afterCommit?.()
        accessChanged()
      },
    })
  }

  function checkOpening(bot, current) {
    if ([...rt.switchJobs()].some(job => job.botId === bot.id)) {
      throw refusal(bot.name + ' is already moving to a new conversation.')
    }
    if (bot.sessionPinned === true) throw refusal(rt.freshPinnedText(bot))
    if (Object.values(state.switching).some(entry => entry?.botId === bot.id)) {
      throw refusal(bot.name + ' is still handing on earlier messages; try again shortly.')
    }
    if (Object.hasOwn(state.questions, current) || Object.hasOwn(state.views, current)) {
      throw refusal("Answer or dismiss " + bot.name + "'s open card first.")
    }
    if (ctx.get('goals')?.get?.(current)?.phase === 'active') {
      throw refusal("Pause " + bot.name + "'s goal first.")
    }
  }

  async function setPeople(botId, input) {
    if (!callerService(ctx)) throw unavailable()
    return peopleQueue(async () => {
      if (!enabled()) throw unavailable()
      const bot = rt.botOf(botId)
      if (!bot) throw refusal('Unknown Bot', { code: 'bot/not-found' })
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) throw refusal(readOnly, { code: 'bot/read-only' })
      const main = rt.isMain(botId)
      const prev = peopleOf(bot, { main })
      const next = cleanPeople(input, { main, current: prev, seen: service.seen() })
      // A spoiled or withdrawn share can be reopened only by an explicit owners-to-shared edit.
      if (prev.mode !== 'owners' || next.mode === 'owners') {
        await commit(botId, bot, next, next.mode === 'owners' ? () => shares.delete(botId) : undefined)
        return { id: botId, people: next }
      }
      const activation = service
      const current = rt.chatOf(botId)
      checkOpening(bot, current)
      const agent = await rt.resolveAgent(current)
      if (!enabled() || service !== activation) throw unavailable()
      if (rt.botOf(botId) !== bot || rt.chatOf(botId) !== current) {
        throw refusal(bot.name + ' is already moving to a new conversation.')
      }
      checkOpening(bot, current)
      if (agent?.status !== 'idle') throw refusal('Wait for ' + bot.name + ' to finish, then share it.')
      if (agent.inbox.nextStep.length + agent.inbox.nextTurn.length > 0) {
        throw refusal(bot.name + ' has messages waiting; let them run or remove them, then share it.')
      }
      await commit(botId, bot, next)
      if (!enabled() || service !== activation || rt.botOf(botId) !== bot) throw unavailable()
      const share = { id: randomUUID(), state: 'opening', parts: [] }
      shares.set(botId, share)
      try {
        await rt.startFresh(botId, { shareId: share.id })
      } catch (error) {
        spoilShare(botId, share.id)
        throw error
      }
      return { id: botId, people: next, opening: true }
    })
  }

  function spoilShare(botId, id) {
    const share = shares.get(botId)
    if (!enabled() || share?.id !== id || share.state !== 'opening') return
    share.state = 'spoiled'
    ctx.logger.warn('omni-ui: a fresh part could not open for caller sharing')
    accessChanged()
  }

  function publishPart({ botId, fromPart, freshId, shareId, kind, carried }) {
    if (!enabled()) return
    return peopleQueue(() => {
      const share = shares.get(botId)
      const bot = rt.botOf(botId)
      if (!enabled() || !rt.canWriteTeam() || rt.readOnly() !== undefined || !bot || rt.chatOf(botId) !== freshId ||
          peopleOf(bot).mode === 'owners' || !share || share.id !== shareId || closed.has(freshId)) {
        if (kind === 'share') spoilShare(botId, shareId)
        return
      }
      if (kind === 'share') {
        if (share.state !== 'opening') return
        if (carried) return spoilShare(botId, shareId)
        share.parts = [freshId]
        share.state = 'open'
      } else {
        if (share.state !== 'open' || !readableParts(botId).some(part => part.sessionId === fromPart)) return
        share.parts = [...share.parts, freshId].slice(-256)
      }
      accessChanged()
    })
  }

  function unpublishPart(botId, freshId) {
    if (!enabled()) return
    const share = shares.get(botId)
    if (!share?.parts.includes(freshId)) return
    share.parts = share.parts.filter(id => id !== freshId)
    accessChanged()
  }

  function closePart(sessionId, reason) {
    if (!active() || closed.has(sessionId)) return
    closed.add(sessionId)
    ctx.logger.info('omni-ui: a chat part closed to callers (%s)', reason)
    accessChanged()
  }

  function forgetShare(botId) {
    shares.delete(botId)
    accessChanged()
  }

  async function mainChanged(botId) {
    const bot = rt.botOf(botId)
    const people = peopleOf(bot)
    if (bot && rt.isMain(botId) && people.mode === 'workspace') {
      const next = { ...people, mode: 'allowlist' }
      try {
        await commit(botId, bot, next)
      } catch (error) {
        // Promotion already took effect. A failed follow-up write must not let later
        // demotion restore workspace visibility to this share.
        if (rt.botOf(botId) === bot) bot.people = next
        accessChanged()
        throw error
      }
      return
    }
    accessChanged()
  }

  function fingerprint(botId, share) {
    return JSON.stringify({
      main: rt.isMain(botId),
      current: rt.chatOf(botId),
      segments: (rt.botOf(botId)?.segments ?? []).map(segment => segment?.sessionId),
      claims: share.parts.map(id => claims(botId, id)),
    })
  }

  const hostAuthority = {
    capture() {
      if (!adopted) return
      return {
        people: new Map(Object.entries(state.bots).map(([id, bot]) => [id, bot.people])),
        fingerprints: new Map([...shares].map(([id, share]) => [id, fingerprint(id, share)])),
      }
    },
    restore(kept) {
      adopted = true
      if (!kept) return
      const withdrawn = []
      for (const [id, bot] of Object.entries(state.bots)) {
        if (!kept.people.has(id)) bot.people = ownersOnly()
        else if (kept.people.get(id) === undefined) delete bot.people
        else bot.people = kept.people.get(id)
      }
      for (const [id, share] of shares) {
        const bot = rt.botOf(id)
        if (!bot) shares.delete(id)
        else if (fingerprint(id, share) !== kept.fingerprints.get(id)) {
          bot.people = { mode: 'owners', allow: peopleOf(bot).allow }
          withdrawn.push(id)
          shares.delete(id)
        }
      }
      if (withdrawn.length > 0) {
        ctx.logger.warn('omni-ui: an outside edit of the team file closed %d shared Bot(s) to members until the owner shares again', withdrawn.length)
        void peopleQueue(async () => {
          // Another save can have queued a second adoption of the same edit. Wait
          // for that to settle and persist the surviving records from this team.
          await rt.refresh()
          const updates = withdrawn.flatMap(id => {
            const people = rt.botOf(id)?.people
            return people?.mode === 'owners' ? [[id, people]] : []
          })
          if (updates.length === 0) return
          await rt.saveCopy(copy => {
            for (const [id, people] of updates) copy.bots[id].people = people
          })
        }).catch(() => ctx.logger.warn('omni-ui: saving withdrawn sharing after a team edit failed'))
      }
      accessChanged()
    },
  }

  const provider = {
    *bots() {
      if (!enabled() || !rt.canWriteTeam() || rt.readOnly() !== undefined) return
      for (const [id, bot] of Object.entries(state.bots)) {
        if (bot.id !== id) continue
        const main = rt.isMain(id)
        const { mode, allow } = peopleOf(bot, { main })
        yield { id, main, people: { mode, allow: allow.map(({ issuer, subject }) => ({ issuer, subject })) } }
      }
    },
  }

  function changeService() {
    const next = callerService(ctx)
    if (next === service || disposed) return
    const withdrawn = service !== undefined
    removeProvider?.()
    removeProvider = ready = undefined
    service = next
    rt.hostAuthority = next ? hostAuthority : undefined
    shares.clear()
    accessChanged(withdrawn)
    if (!next) {
      removeEvent?.()
      removeEvent = undefined
      return
    }
    removeEvent ??= ctx.on('session/event', (session, event) => {
      if (enabled() && shares.has(rt.selfOf(session?.id)) && closesPart(event)) closePart(session.id, 'relay')
    })
    void peopleQueue(async () => {
      await rt.load()
      if (!active() || service !== next) return
      adopted = true
      shares.clear()
      closed.clear()
      const bots = Object.values(state.bots).filter(bot => Object.hasOwn(bot, 'people') &&
        (bot.people?.mode !== 'owners' || !Array.isArray(bot.people.allow) || bot.people.allow.length !== 0 ||
          Object.keys(bot.people).length !== 2))
      for (const bot of bots) bot.people = ownersOnly()
      if (bots.length > 0) resetDirty = true
      if (resetDirty) {
        await rt.save({ required: true })
        resetDirty = false
      }
      if (!active() || service !== next || rt.readOnly() !== undefined) return
      removeProvider = next.provide(provider)
      ready = next
      accessChanged()
    }).catch(() => ctx.logger.warn('omni-ui: resetting Bot sharing failed; callers have no visibility'))
  }

  Object.assign(rt, {
    peopleQueue, setPeople, publishPart, unpublishPart, closePart, readableParts, accessChanged,
    forgetShare, mainChanged, spoilShare, accessGeneration: 0,
    shareIdOf: botId => enabled() ? shares.get(botId)?.id : undefined,
    shareState: botId => enabled() ? shares.get(botId)?.state : undefined,
    onAccessLoss(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const watchService = () => ctx.on('internal/service', name => {
    if (name === 'automagikCaller') changeService()
  })
  // A Cordis host sees adapter activations even if bots-dsh loaded first. Contexts
  // without a service lifecycle can opt in with the service or host mode.
  const removeService = typeof ctx.inject === 'function' || callerService(ctx) || multiuserMode()
    ? watchService()
    : undefined
  changeService()
  return () => {
    disposed = true
    removeService?.()
    removeEvent?.()
    removeProvider?.()
    shares.clear()
    closed.clear()
    listeners.clear()
    rt.hostAuthority = undefined
  }
}
