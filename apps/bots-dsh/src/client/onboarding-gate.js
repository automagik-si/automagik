import { createElement as h, useEffect, useSyncExternalStore } from 'react'
import { createSource } from './sources.js'

const SLOT = 'settings.onboarding'
const FLAGS = ['companionDone', 'teamDone', 'migrateDone', 'connectAiDone']
function classify(roster, mainId, hasPendingAdoption) {
  if (mainId === undefined) return 'personal'
  if (roster.ready !== true) return 'waiting'
  if (roster.roomsById?.[mainId] || roster.tasks?.[mainId]
    || roster.rooms?.some(room => room.parts?.includes(mainId))) return 'team'
  if (roster.byId?.[mainId] || roster.agentOf?.[mainId]) return 'owned'
  return hasPendingAdoption?.(mainId) ? 'adopting' : 'personal'
}

async function readFirstRun(signal) {
  const response = await fetch('api/omni-ai', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state', payload: null }),
    signal,
  })
  if (!response.ok) return false
  const result = await response.json()
  return result.ok === true && FLAGS.every(flag => result.value?.[flag] === true)
}

function OnboardingGate({ explicit, complete, classification, flags, read, current }) {
  const firstRunDone = useSyncExternalStore(flags.subscribe, flags.getSnapshot)
  useEffect(() => {
    if (!current()) return
    if (!explicit && classification === 'owned') read()
    if (explicit || classification === 'personal' || (classification === 'owned' && firstRunDone === false)) complete()
  }, [explicit, complete, classification, firstRunDone, read, current])
  return null
}

export function installOnboardingGate(ctx, { roster, mainView, sessions, adoption, hasPendingAdoption }) {
  let sequence = 0
  return ctx.slots.inject(SLOT, () => {
    let view
    let previousClass
    let offGate
    const sync = () => {
      const id = mainView()
      const classification = classify(roster.getSnapshot(), id, hasPendingAdoption)
      if (view !== undefined && view.id === id && previousClass === classification) return
      if (view === undefined || view.id !== id) {
        view?.request.abort()
        const request = new AbortController()
        const flags = createSource('pending')
        let pending
        const read = () => (pending ??= readFirstRun(request.signal).catch(() => false).then(value => {
          if (!request.signal.aborted) flags.set(value)
        }))
        view = { id, request, flags, read }
      }
      const offPrevious = offGate
      previousClass = classification
      // SettingsRoot retains completed step IDs across navigation and roster changes.
      // Register the new ID before withdrawing the old one.
      const key = ++sequence
      const { flags, read } = view
      const current = () => view !== undefined && key === sequence
      offGate = ctx.slots.register({ name: SLOT, id: `bot-team-gate-${key}`, order: -1000 },
        props => h(OnboardingGate, { ...props, classification, flags, read, current }))
      offPrevious?.()
    }
    const offSessions = sessions.subscribe(sync)
    const offRoster = roster.subscribe(sync)
    const offAdoption = adoption?.subscribe(sync)
    sync()
    return () => {
      offSessions()
      offRoster()
      offAdoption?.()
      view?.request.abort()
      view = undefined
      offGate?.()
    }
  })
}
