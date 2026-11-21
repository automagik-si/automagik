import { call } from './api.js'
import { clearClientErrors } from './diagnostics.js'

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
export const canClearDraftInMemory = () => guard?.draftsProtected === true
const unavailable = () => Object.assign(new Error('Viewer unavailable'), { code: 'bot/retired' })
function storedViewer() {
  try { return localStorage.getItem(VIEWER_KEY) }
  catch { return null }
}
export function requestViewer(endpoint) {
  checkViewer(guard)
  if (isRetired() || (endpoint !== 'whoami' && !guard?.viewer && bootView() !== undefined)) {
    throw unavailable()
  }
  return guard
}

export function checkViewer(active) {
  if (active && guard === active && active.viewer) {
    const current = storedViewer()
    if (current !== null && current !== active.viewer.id) retire()
  }
  if (active && (guard !== active || active.retired)) throw unavailable()
}

export function viewerRefused(code) {
  if (guard && ['bot/viewer-changed', 'HTTP_401', 'HTTP_403'].includes(code)) retire()
}

export function viewerResponse(response) {
  if (response.status === 401 && response.headers?.get?.('x-automagik-dsh-refresh') === '1') return
  viewerRefused(`HTTP_${response.status}`)
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
  guard.viewer = undefined
  const body = document.body
  if (body) {
    body.inert = true
    body.style?.setProperty('display', 'none', 'important')
  }
  for (const hook of guard.hooks) {
    try { hook() } catch { /* Other retirement hooks still need to run. */ }
  }
  guard.hooks.clear()
  body?.replaceChildren?.()
  clearClientErrors()
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === '1') return
    sessionStorage.setItem(RELOAD_KEY, '1')
  } catch { return } // Hold closed if a reload cannot be bounded.
  try { location.reload() } catch { /* The page is already closed. */ }
}

// DSH writes its conversation store synchronously, including when a retirement
// hook clears the in-memory draft. Keep those writes scoped to this document.
function trackDrafts(active, viewer) {
  try {
    const storage = localStorage
    const prototype = Object.getPrototypeOf(storage)
    const set = prototype.setItem
    const remove = prototype.removeItem
    if (typeof set !== 'function' || typeof remove !== 'function') return
    const written = new Map()
    const current = () => storage.getItem(VIEWER_KEY) === viewer.id
    const conversation = key => typeof key === 'string' && key.startsWith('dsh.conversation.')
    prototype.setItem = function (key, value) {
      if (this !== storage || !conversation(key)) return set.call(this, key, value)
      if (!active.retired && current()) {
        set.call(this, key, value)
        written.set(key, storage.getItem(key))
      }
    }
    prototype.removeItem = function (key) {
      if (this !== storage || !conversation(key)) return remove.call(this, key)
      if (!active.retired && current()) {
        remove.call(this, key)
        written.delete(key)
      }
    }
    active.hooks.add(() => {
      try {
        if (current()) {
          for (const [key, value] of written) if (storage.getItem(key) === value) remove.call(storage, key)
        }
      } finally { written.clear() }
    })
    return () => {
      prototype.setItem = set
      prototype.removeItem = remove
    }
  } catch { /* DSH can still render with site storage unavailable. */ }
}

function confirmed(answer, boot) {
  const viewer = answer?.viewer
  return boot.role !== 'none' && answer?.multiuser === true && answer.role === boot.role &&
    (viewer?.role === boot.role || (boot.role === 'owner' && viewer?.role === 'admin')) &&
    typeof viewer.id === 'string' && /^[\w-]{1,64}$/.test(viewer.id)
}

export async function startViewer(boot, signal, prepare) {
  if (guard) throw new Error('Viewer already started')
  if (signal?.aborted) throw unavailable()
  const active = guard = { hooks: new Set(), retired: false }
  const previousViewer = storedViewer()
  const body = document.body
  const display = body?.style?.getPropertyValue('display')
  const priority = body?.style?.getPropertyPriority('display')
  const inert = body?.inert
  const show = () => {
    if (!body) return
    body.inert = inert
    body.style?.setProperty('display', display, priority)
  }
  if (body) {
    body.inert = true
    body.style?.setProperty('display', 'none', 'important')
  }
  const current = () => guard === active && !active.retired && !signal?.aborted
  let cancelDelay
  active.hooks.add(() => cancelDelay?.())
  let answer
  const abort = () => {
    cancelDelay?.()
    active.stop?.()
    if (guard === active && !active.retired) {
      if (!active.viewer) show()
      guard = undefined
      delete globalThis.__AUTOMAGIK_MOUNTED_VIEWER__
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  let delay = 250
  while (current()) {
    try {
      answer = await call('whoami', undefined, signal)
      break
    } catch {
      if (!current()) break
      await new Promise(resolve => {
        const timer = setTimeout(resolve, delay)
        cancelDelay = () => { clearTimeout(timer); resolve() }
      })
      cancelDelay = undefined
      delay = Math.min(15_000, delay * 2)
    }
  }
  if (!current()) throw new Error('Viewer unavailable')
  const currentViewer = storedViewer()
  if (!confirmed(answer, boot) || (currentViewer !== null && currentViewer !== previousViewer && currentViewer !== answer.viewer.id)) {
    retire()
    throw new Error('Viewer role changed')
  }
  const viewer = active.viewer = answer.viewer
  try {
    localStorage.setItem(VIEWER_KEY, viewer.id)
  } catch { /* The server still checks each request's viewer. */ }
  const untrackDrafts = trackDrafts(active, viewer)
  active.draftsProtected = untrackDrafts !== undefined

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
    if (!active.retired) untrackDrafts?.()
    clearInterval(timer)
    window.removeEventListener('focus', check)
    window.removeEventListener('storage', storage)
    document.removeEventListener('visibilitychange', visibility)
  }
  active.hooks.add(active.stop)
  // Welcome uses the same guard for its Omni UI requests from this document.
  const checkMounted = () => checkViewer(active)
  globalThis.__AUTOMAGIK_MOUNTED_VIEWER__ = Object.freeze({
    get id() { checkMounted(); return active.viewer.id },
    check: checkMounted,
    response: viewerResponse,
    refused: viewerRefused,
  })
  if (prepare) {
    try { await prepare() }
    catch (error) { if (current()) retire(); throw error }
    if (!current()) throw unavailable()
  }
  show()
  try { sessionStorage.removeItem(RELOAD_KEY) } catch { /* The page is ready even without site storage. */ }
  return viewer
}
