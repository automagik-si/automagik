import { timingSafeEqual } from 'node:crypto'
import { DIGEST, validInstanceId } from '../shared/account-reservations.js'
import { fill, machineRefusal } from '../shared/machine-reservations.js'

const PROVIDERS = { 'acp-claude': 'claude', 'acp-codex': 'codex' }
const REFUSING = new Set(['refused', 'ambiguous', 'unreadable'])
const digestOk = value => typeof value === 'string' && DIGEST.test(value)
const display = ({ state, notice, label, owner, why }) => ({
  state,
  ...(notice === undefined ? {} : { notice }),
  ...(label === undefined ? {} : { label }),
  ...(owner === undefined ? {} : { owner }),
  ...(why === undefined ? {} : { why }),
})
const agrees = (a, b) => ['state', 'ref', 'outcome', 'exact', 'loose', 'label']
  .every(key => a[key] === b[key])

export function createReservationCheck(rt, { machine, instanceId, evidenceTimeoutMs = 20_000 }) {
  const providerIds = Object.keys(PROVIDERS)
  const providers = new Map(providerIds.map(id => [id, {
    gen: 0, verdict: { state: 'unknown', gen: -1 }, stale: true, starting: 0, work: 0,
  }]))
  const active = new Map()
  const adopted = new Set()
  const seen = new Set()
  let disposed = false

  function acp() {
    try { return rt.ctx.get?.('acpAgents') } catch {}
  }

  async function read(acpService, provider, key) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let timer
      try {
        const ev = await Promise.race([
          acpService.accountEvidence(provider, { key }),
          new Promise(resolve => {
            timer = setTimeout(resolve, evidenceTimeoutMs)
            timer.unref?.()
          }),
        ])
        if (ev?.outcome !== 'changed' || attempt === 2) return ev
      } catch {
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }
  }

  function decide(provider, ev, ready) {
    const current = machine.open()
    if (current.state !== 'ready') return { state: 'notice', notice: current.state }
    if (!timingSafeEqual(current.key, ready.key)) return { state: 'unread' }
    if (ev?.id !== provider || ev.supported === false) return { state: 'open' }
    if (ev.outcome === 'changed') return { state: 'unread' }
    if (ev.signedIn !== true) return { state: 'open', signedOutRead: true }
    if (ev.outcome !== 'complete' && ev.outcome !== 'ambiguous') return { state: 'open' }

    const vendor = PROVIDERS[provider]
    const complete = ev.outcome === 'complete'
    if (ev.vendor !== vendor || !digestOk(ev.loose)
      || (complete ? !digestOk(ev.exact) : ev.exact !== undefined)) return { state: 'unread' }
    const id = instanceId()
    const ours = validInstanceId(id) ? id : undefined
    const evidence = {
      ref: ev.ref, outcome: ev.outcome, exact: ev.exact, loose: ev.loose,
      isolated: ev.authScope === 'isolated',
    }
    if (complete) {
      const found = machine.readExact(current, vendor, ev.exact)
      if (found.state === 'folder-unreadable') return { state: 'notice', notice: 'unreadable' }
      if (found.state === 'absent') return { state: 'shared' }
      if (found.state === 'unreadable') return { state: 'unreadable', ...evidence }
      const { record: { instance, label }, owner } = found
      return instance === ours ? { state: 'mine', label } : {
        state: 'refused', label, owner, ...evidence,
      }
    }
    const found = machine.scanLoose(current, vendor, ev.loose)
    if (found.state === 'folder-unreadable') return { state: 'notice', notice: 'unreadable' }
    const other = found.matches.find(match => match.record.instance !== ours)
    if (other) return {
      state: 'ambiguous', label: other.record.label, owner: other.owner, ...evidence,
      why: vendor === 'claude' ? 'no-organisation' : 'unknown-plan',
    }
    return found.matches.length ? { state: 'mine', label: found.matches[0].record.label }
      : { state: 'shared' }
  }

  async function observation(provider, service) {
    const ready = machine.open()
    if (ready.state !== 'ready') return { result: { state: 'notice', notice: ready.state } }
    const ev = await read(service, provider, ready.key)
    return { result: decide(provider, ev, ready), ready, ev }
  }

  async function observe(provider) {
    const service = acp()
    if (typeof service?.accountEvidence !== 'function') {
      return { state: 'notice', notice: 'unsupported-acp' }
    }
    let { result } = await observation(provider, service)
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!REFUSING.has(result.state)) return result
      const next = (await observation(provider, service)).result
      if (agrees(result, next)) return { ...next, confirmed: true }
      result = next
    }
    return REFUSING.has(result.state) ? { state: 'unread' } : result
  }

  function commit(provider, s, gen, result) {
    if (disposed || s.gen !== gen) return
    s.stale = result.state === 'unread'
    if (result.state === 'unread' && REFUSING.has(s.verdict.state)) {
      s.verdict = { ...s.verdict, gen }
      s.queuedSignOut = undefined
      return
    }
    s.verdict = { ...result, gen }
    if (!result.signedOutRead) s.afterSignOut = undefined
    s.queuedSignOut = undefined
    const service = result.confirmed && result.isolated ? acp() : undefined
    if (service?.reservationEvidence >= 2 && typeof service.accountSignOut === 'function') {
      s.queuedSignOut = s.verdict
      maybeSignOut(provider)
    }
    if (result.notice && s.lastNotice !== result.notice) {
      rt.warn('ds-bot: account reservations are not checked here (%s)', result.notice)
    }
    s.lastNotice = result.notice
  }

  function fresh(provider) {
    const s = providers.get(provider)
    if (!s || disposed) return Promise.resolve()
    if (s.queuedRead) return s.queuedRead
    if (s.pending) {
      s.queuedRead = s.pending.then(() => {
        s.queuedRead = undefined
        return fresh(provider)
      })
      return s.queuedRead
    }
    const gen = s.gen
    s.pending = Promise.resolve().then(() => observe(provider))
      .then(result => commit(provider, s, gen, result))
      .catch(() => rt.warn('ds-bot: account reservation check failed'))
      .finally(() => { s.pending = undefined })
    return s.pending
  }

  async function settled(provider, s) {
    for (let round = 0; round < 3 && !disposed; round++) {
      if (s.pending || s.queuedRead) await (s.pending ?? s.queuedRead)
      else if (s.verdict.gen !== s.gen) await fresh(provider)
      else break
    }
  }

  function idleFor(provider, s) {
    return !s.starting && !s.work && !adopted.size
      && !Array.from(active.values()).includes(provider)
  }

  function maybeSignOut(provider) {
    const s = providers.get(provider)
    const queued = s.queuedSignOut
    if (disposed || !queued || s.running || queued.gen !== s.gen || !idleFor(provider, s)) return
    const current = () => !disposed && s.gen === queued.gen && s.queuedSignOut === queued
    const drop = () => { if (current()) s.queuedSignOut = undefined }
    const retry = () => {
      if (!current()) return
      drop()
      void fresh(provider)
    }
    s.running = Promise.resolve().then(async () => {
      const service = acp()
      if (!current() || !idleFor(provider, s)) return
      if (!(service?.reservationEvidence >= 2) || typeof service?.accountSignOut !== 'function') {
        return drop()
      }
      const { result, ready, ev } = await observation(provider, service)
      if (!current()) return
      if (!agrees(result, queued) || !result.isolated) return retry()
      if (!idleFor(provider, s)) return

      const { exact, loose } = result
      let heldForWork = false
      try {
        await service.accountSignOut(provider, { expect: {
          key: ready.key, loose, ...(exact === undefined ? {} : { exact }),
          recheck: () => {
            if (!current()) return false
            heldForWork = !idleFor(provider, s)
            return !heldForWork && agrees(decide(provider, ev, ready), result)
          },
        } })
        if (current()) {
          s.afterSignOut = display(result)
          // Until the next read confirms logout, keep the refusal and report the action.
          s.verdict = { state: 'open', signedOutRead: true, gen: s.gen }
          drop()
        }
      } catch (error) {
        if (error?.code === 'acp-account/busy') return
        if (error?.code === 'acp-account/changed') {
          if (!heldForWork) retry()
          return
        }
        drop()
        rt.warn('ds-bot: the reserved account of %s was not signed out', provider)
      } finally {
        if (heldForWork && current() && idleFor(provider, s)) void fresh(provider)
      }
    }).catch(() => {
      drop()
      rt.warn('ds-bot: the reserved account of %s was not signed out', provider)
    }).finally(() => {
      s.running = undefined
      if (s.queuedSignOut !== queued) maybeSignOut(provider)
    })
  }

  function held(provider) {
    const s = providers.get(provider)
    const verdict = s && (REFUSING.has(s.verdict.state) ? s.verdict : s.afterSignOut)
    const template = verdict && machineRefusal(verdict)
    return template ? fill(template, verdict) : undefined
  }

  async function gate(provider, sessionId) {
    const s = providers.get(provider)
    if (!s || active.has(sessionId) || disposed) return undefined
    try {
      const key = `${sessionId}\0${provider}`
      // The first read for this pair must begin after this call, even during a start read.
      if (!seen.has(key) || s.stale) {
        seen.add(key)
        await fresh(provider)
      }
      await settled(provider, s)
      return held(provider)
    } catch {
      rt.warn('ds-bot: account reservation check failed')
    }
  }

  async function imageGate(provider) {
    const s = providers.get(provider)
    if (!s || disposed) return undefined
    await settled(provider, s)
    return held(provider)
  }

  function startingWork(provider, field) {
    const s = providers.get(provider)
    if (!s) return
    s[field]++
    let released = false
    return () => {
      if (released) return
      released = true
      s[field]--
      maybeSignOut(provider)
    }
  }

  function turnEnded(id) {
    active.delete(id)
    adopted.delete(id)
    providerIds.forEach(maybeSignOut)
  }

  function loginReady(provider) {
    const s = providers.get(provider)
    if (!s || disposed) return
    s.gen++
    s.queuedSignOut = s.afterSignOut = undefined
    s.verdict = { state: 'unknown', gen: -1 }
    s.stale = true
    void fresh(provider)
  }

  function started() {
    disposed = false
    try {
      for (const agent of rt.ctx.get?.('agents')?.list?.() ?? []) {
        if (agent?.status === 'running') adopted.add(agent.session?.id ?? agent.id)
      }
    } catch {}
    for (const [provider, s] of providers) {
      s.gen++
      s.queuedSignOut = undefined
      void fresh(provider)
    }
    return () => {
      disposed = true
      for (const s of providers.values()) {
        s.gen++
        s.queuedSignOut = undefined
      }
    }
  }

  async function idle() {
    for (;;) {
      const promises = [...providers.values()].flatMap(s => [s.pending, s.queuedRead, s.running])
        .filter(Boolean)
      if (promises.length === 0) break
      await Promise.all(promises)
    }
    await rt.reservationWritesIdle?.()
  }

  return {
    started, loginReady, gate, held, imageGate, turnEnded, fresh, idle,
    isAdmitted: sessionId => active.has(sessionId),
    starting: provider => startingWork(provider, 'starting'),
    workStarted: provider => startingWork(provider, 'work'),
    admitted(sessionId, provider) {
      if (typeof sessionId === 'string' && providers.has(provider)) active.set(sessionId, provider)
    },
    sessionOpened(session) {
      try {
        if (rt.isBotSession?.(session?.id) !== true) return
        const provider = session.requestHeader?.()?.config?.provider
        if (!providers.has(provider)) return
        seen.add(`${session.id}\0${provider}`)
        void fresh(provider)
      } catch {}
    },
    sessionDisposed(id) {
      turnEnded(id)
      for (const key of seen) if (key.startsWith(`${id}\0`)) seen.delete(key)
    },
    status(provider) {
      const s = providers.get(provider)
      if (!s) return { state: 'unknown' }
      if (s.afterSignOut && s.verdict.signedOutRead) {
        return { ...s.afterSignOut, signedOut: true }
      }
      return display(s.verdict)
    },
  }
}
