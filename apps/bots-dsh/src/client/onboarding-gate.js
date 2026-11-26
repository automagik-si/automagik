import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

const SLOT = 'settings.onboarding'
const FLAGS = ['companionDone', 'teamDone', 'migrateDone', 'connectAiDone']
const isBotChat = (roster, id) => Boolean(roster.byId?.[id] || roster.agentOf?.[id])

export function suppressed(roster, mainId, firstRunDone = 'pending') {
  if (mainId === undefined) return false
  if (roster.ready !== true) return 'pending'
  if (roster.roomsById?.[mainId] || roster.tasks?.[mainId]
    || roster.rooms?.some(room => room.parts?.includes(mainId))) return true
  if (isBotChat(roster, mainId)) return firstRunDone
  return false
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

function useFirstRunDone(read) {
  const [done, setDone] = useState('pending')
  useEffect(() => {
    if (read === undefined) return
    let mounted = true
    void read().then(value => { if (mounted) setDone(value) })
    return () => { mounted = false }
  }, [read])
  return done
}

function OnboardingGate({ explicit, complete, roster, mainId, read }) {
  const state = useSyncExternalStore(roster.subscribe, roster.getSnapshot)
  const firstRunDone = useFirstRunDone(!explicit && state.ready && isBotChat(state, mainId) ? read : undefined)
  const decision = suppressed(state, mainId, firstRunDone)
  useEffect(() => {
    if (explicit || decision === false) complete()
  }, [explicit, complete, decision])
  return null
}

export function installOnboardingGate(ctx, { roster, mainView, sessions }) {
  let sequence = 0
  return ctx.slots.inject(SLOT, () => {
    let previous
    let offGate
    const sync = () => {
      const mainId = mainView()
      if (offGate !== undefined && previous === mainId) return
      const offPrevious = offGate
      previous = mainId
      // SettingsRoot retains completed step IDs across blank-to-blank navigation.
      // Register the new ID before withdrawing the old one.
      const request = new AbortController()
      let flags
      const read = () => (flags ??= readFirstRun(request.signal).catch(() => false))
      const dispose = ctx.slots.register({ name: SLOT, id: `bot-team-gate-${++sequence}`, order: -1000 },
        props => h(OnboardingGate, { ...props, roster, mainId, read }))
      offGate = () => { request.abort(); dispose() }
      offPrevious?.()
    }
    sync()
    const offSessions = sessions.subscribe(sync)
    return () => { offSessions(); offGate?.() }
  })
}
