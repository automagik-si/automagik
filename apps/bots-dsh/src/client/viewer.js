import { call } from './api.js'

const VIEWER_KEY = 'automagik.viewer'
const RELOAD_KEY = 'automagik.retired'
const ROLES = new Set(['owner', 'member', 'guest', 'none'])
let guard

export function bootView() {
  const boot = globalThis.__AUTOMAGIK_VIEW__
  if (boot === undefined) return
  return boot?.version === 1 && ROLES.has(boot.role) ? boot : { role: 'none' }
}

export const mountedViewer = () => guard?.retired ? undefined : guard?.viewer
export const isRetired = () => guard?.retired === true
export function requestViewer(endpoint) {
  if (isRetired() || (endpoint !== 'whoami' && !guard?.viewer && bootView() !== undefined)) {
    throw Object.assign(new Error('Viewer unavailable'), { code: 'bot/retired' })
  }
  return guard?.viewer?.id
}

export function viewerRefused(code) {
  if (guard && ['bot/viewer-changed', 'HTTP_401', 'HTTP_403'].includes(code)) retire()
}

export function onRetire(hook) {
  if (!guard) return () => {}
  const hooks = guard.hooks
  if (guard.retired) hook()
  else hooks.add(hook)
  return () => hooks.delete(hook)
}

function retire() {
  if (!guard || guard.retired) return
  guard.retired = true
  if (document.body) document.body.inert = true
  for (const hook of guard.hooks) {
    try { hook() } catch { /* Other retirement hooks still need to run. */ }
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith('dsh.conversation.')) localStorage.removeItem(key)
    }
  } catch { /* Site storage can be unavailable. */ }
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === '1') return
    sessionStorage.setItem(RELOAD_KEY, '1')
  } catch { return } // Hold closed if a reload cannot be bounded.
  location.reload()
}

function confirmed(answer, boot) {
  const viewer = answer?.viewer
  return boot.role !== 'none' && answer?.multiuser === true && answer.role === boot.role &&
    (viewer?.role === boot.role || (boot.role === 'owner' && viewer?.role === 'admin')) &&
    typeof viewer.id === 'string' && viewer.id.length > 0 && viewer.id.length <= 64
}

export async function startViewer(boot, signal) {
  if (guard) throw new Error('Viewer already started')
  const active = guard = { hooks: new Set(), retired: false }
  signal?.addEventListener('abort', () => {
    active.stop?.()
    if (guard === active) guard = undefined
  }, { once: true })
  const answer = await call('whoami', undefined, signal)
  if (guard !== active || active.retired) throw new Error('Viewer unavailable')
  if (!confirmed(answer, boot)) {
    retire()
    throw new Error('Viewer role changed')
  }
  const viewer = active.viewer = answer.viewer
  try {
    localStorage.setItem(VIEWER_KEY, viewer.id)
    sessionStorage.removeItem(RELOAD_KEY)
  } catch { /* The server still checks each request's viewer. */ }

  let checking = false
  const check = async () => {
    if (checking || active.retired || guard !== active) return
    checking = true
    try {
      const next = await call('whoami', undefined, signal)
      if (guard === active && (!confirmed(next, boot) || next.viewer.id !== viewer.id || next.viewer.role !== viewer.role)) retire()
    } catch { /* The call handles authentication refusals. A network failure can be retried. */ }
    finally { checking = false }
  }
  const visibility = () => { if (document.visibilityState === 'visible') void check() }
  const storage = event => {
    if ((event.key === VIEWER_KEY || event.key === null) && event.newValue !== viewer.id) retire()
  }
  window.addEventListener('focus', check)
  window.addEventListener('storage', storage)
  document.addEventListener('visibilitychange', visibility)
  const timer = setInterval(check, 15_000)
  active.stop = () => {
    clearInterval(timer)
    window.removeEventListener('focus', check)
    window.removeEventListener('storage', storage)
    document.removeEventListener('visibilitychange', visibility)
  }
  active.hooks.add(active.stop)
  return viewer
}
