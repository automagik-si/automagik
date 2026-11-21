import { randomUUID } from 'node:crypto'
import { callerService, hasCallerLock, multiuserMode } from './multiuser.js'
import { cleanPeople, ownersOnly, peopleOf } from './people.js'
import { closesPart } from './caller-view.js'
import { refusal } from './refusal.js'

const inSegments = (segments, id) => Array.isArray(segments) && segments.some(segment => segment?.sessionId === id)
const unavailable = () => refusal('Sharing needs multiuser mode')
const readOnly = rt => refusal(rt.readOnly() ?? 'This host does not hold the Bot team.', { code: 'bot/read-only' })
const modes = ['owners', 'allowlist', 'workspace']
const hasPerson = (list, entry) => list.some(person => person.issuer === entry.issuer &&
  person.subject === entry.subject && person.role === entry.role)

export function install(rt) {
  const { ctx, state } = rt
  const shares = new Map()
  const closed = new Set()
  const listeners = new Set()
  let queue = Promise.resolve()
  let service, removeProvider, removeEvent, ready, disposed
  let adopted = rt.teamLoaded()
  let adoption

  const peopleQueue = fn => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }
  const active = () => !disposed && service !== undefined && service === callerService(ctx)
  const enabled = () => active() && ready === service && !adoption && rt.teamLoaded()
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
    for (const id of rt.agentClaims(sessionId)) found.push('agent:' + id)
    for (const [id, bot] of Object.entries(state.bots)) {
      if (id !== botId && (rt.chatOf(id) === sessionId || inSegments(bot.segments, sessionId))) found.push('bot:' + id)
    }
    return found.sort()
  }

  function readableParts(botId) {
    const share = shares.get(botId)
    const bot = rt.botOf(botId)
    if (!enabled() || share?.state !== 'open' || !bot || !hasCallerLock(rt) || peopleOf(bot).mode === 'owners') return []
    const published = new Set(share.parts)
    return rt.partsOf(botId).filter(({ sessionId }) => {
      if (!published.has(sessionId) || closed.has(sessionId) ||
          (rt.chatOf(botId) !== sessionId && !inSegments(bot.segments, sessionId))) return false
      if (claims(botId, sessionId).length === 0) return true
      closePart(sessionId, 'ownership conflict')
      return false
    })
  }

  function checkCommit(generation) {
    if (!hasCallerLock(rt) || !rt.sameTeam(generation)) throw readOnly(rt)
  }

  function commit(botId, bot, people, generation, afterCommit) {
    return rt.saveCopy(copy => { copy.bots[botId].people = people }, {
      beforeCommit: () => checkCommit(generation),
      afterWrite: () => {
        bot.people = people
        afterCommit?.()
        accessChanged()
      },
    })
  }

  function checkOpening(bot, current, agent) {
    if ([...rt.switchJobs()].some(job => job.botId === bot.id)) {
      throw refusal(bot.name + ' is already moving to a new conversation.')
    }
    if (bot.sessionPinned === true) throw refusal(rt.freshPinnedText(bot))
    if (rt.hasHeldInput(bot.id) || Object.values(state.switching).some(entry => entry?.botId === bot.id)) {
      throw refusal(bot.name + ' is still handing on earlier messages; try again shortly.')
    }
    if (Object.hasOwn(state.questions, current) || Object.hasOwn(state.views, current)) {
      throw refusal("Answer or dismiss " + bot.name + "'s open card first.")
    }
    if (agent && ctx.get('goals')?.get?.(agent)?.phase === 'active') {
      throw refusal("Pause " + bot.name + "'s goal first.")
    }
  }

  async function setPeople(botId, input, { expect } = {}) {
    if (!callerService(ctx)) throw unavailable()
    return peopleQueue(async () => {
      if (!enabled()) throw unavailable()
      const bot = rt.botOf(botId)
      if (!bot) throw refusal('Unknown Bot', { code: 'bot/not-found' })
      if (!hasCallerLock(rt)) throw readOnly(rt)
      const generation = rt.teamGeneration()
      const main = rt.isMain(botId)
      const prev = peopleOf(bot, { main })
      const expected = expect === undefined ? prev : peopleOf({ people: expect }, { main })
      const stale = JSON.stringify(expected) !== JSON.stringify(prev)
      const narrowing = input?.mode === 'owners'
      let next = narrowing
        ? cleanPeople({ allow: prev.allow, ...input }, { main, current: prev, narrow: true })
        : cleanPeople(input, { main, current: expected, seen: service.seen() })
      if (stale && !narrowing) {
        // Validate the edit against the window's list first. A stale narrowing can
        // only keep grants that also exist in the committed list and mode.
        const mode = modes.indexOf(next.mode)
        const expectedMode = modes.indexOf(expected.mode)
        const currentMode = modes.indexOf(prev.mode)
        const removes = next.allow.length < expected.allow.length && next.allow.every(entry => hasPerson(expected.allow, entry))
        if (mode < expectedMode || (mode === expectedMode && removes)) {
          next = { mode: modes[Math.min(mode, currentMode)], allow: next.allow.filter(entry => hasPerson(prev.allow, entry)) }
        } else if (mode > currentMode || next.allow.some(entry => !hasPerson(prev.allow, entry))) {
          throw refusal('Who may talk to ' + bot.name + ' changed in another window; check it and save again.', { code: 'bot/stale' })
        }
      }
      // A spoiled or withdrawn share can be reopened only by an explicit owners-to-shared edit.
      if (prev.mode !== 'owners' || next.mode === 'owners') {
        await commit(botId, bot, next, generation, next.mode === 'owners' ? () => shares.delete(botId) : undefined)
        return { id: botId, people: next }
      }
      const activation = service
      const current = rt.chatOf(botId)
      checkOpening(bot, current)
      const agent = await rt.resolveAgent(current)
      if (!enabled() || service !== activation) throw unavailable()
      checkCommit(generation)
      if (rt.botOf(botId) !== bot || rt.chatOf(botId) !== current) {
        throw refusal(bot.name + ' is already moving to a new conversation.')
      }
      checkOpening(bot, current, agent)
      if (agent?.status !== 'idle') throw refusal('Wait for ' + bot.name + ' to finish, then share it.')
      if (agent.inbox.nextStep.length + agent.inbox.nextTurn.length > 0) {
        throw refusal(bot.name + ' has messages waiting; let them run or remove them, then share it.')
      }
      await commit(botId, bot, next, generation)
      if (!enabled() || service !== activation || rt.botOf(botId) !== bot) throw unavailable()
      checkCommit(generation)
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
      if (!enabled() || !hasCallerLock(rt) || !bot || rt.chatOf(botId) !== freshId ||
          peopleOf(bot).mode === 'owners' || !share || share.id !== shareId || closed.has(freshId) || claims(botId, freshId).length > 0) {
        if (kind === 'share') spoilShare(botId, shareId)
        return
      }
      if (kind === 'share') {
        if (share.state !== 'opening') return
        if (carried || rt.hasHeldInput(botId)) return spoilShare(botId, shareId)
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
      // A failed migration leaves a partially adopted team in memory. Keep its
      // callers closed and preserve the last trusted snapshot for the next adopt.
      if (adoption) return
      adoption = {}
      if (adopted) {
        adoption.people = new Map(Object.entries(state.bots).map(([id, bot]) => [id, bot.people]))
        adoption.fingerprints = new Map([...shares].map(([id, share]) => [id, fingerprint(id, share)]))
      }
      accessChanged()
    },
    restore() {
      const kept = adoption
      adopted = true
      if (!kept?.people) {
        adoption = undefined
        return
      }
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
      adoption = undefined
      accessChanged()
    },
  }

  const provider = {
    *bots() {
      if (!enabled() || !hasCallerLock(rt)) return
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
    // A new activation cannot inherit grants from before an interrupted adoption.
    adoption?.people?.clear()
    adoption?.fingerprints?.clear()
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
      const bots = Object.entries(state.bots).filter(([, bot]) => Object.hasOwn(bot, 'people') &&
        (bot.people?.mode !== 'owners' || !Array.isArray(bot.people.allow) || bot.people.allow.length !== 0 ||
          Object.keys(bot.people).length !== 2))
      if (bots.length > 0) {
        const generation = rt.teamGeneration()
        checkCommit(generation)
        await rt.save({
          required: true,
          copy: {
            change(copy) {
              for (const [id] of bots) copy.bots[id].people = ownersOnly()
            },
            beforeCommit: () => checkCommit(generation),
            afterWrite() {
              for (const [, bot] of bots) bot.people = ownersOnly()
            },
          },
        })
        checkCommit(generation)
      }
      if (!active() || service !== next || rt.readOnly() !== undefined) return
      removeProvider = next.provide(provider)
      ready = next
      accessChanged()
    }).catch(() => ctx.logger.warn('omni-ui: resetting Bot sharing failed; callers have no visibility'))
  }

  Object.assign(rt, {
    peopleQueue, setPeople, publishPart, unpublishPart, closePart, readableParts, accessChanged,
    forgetShare, spoilShare, accessGeneration: 0,
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
