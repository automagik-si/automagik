import { call } from './api.js'
import { clearClientErrors } from './diagnostics.js'

const VIEWER_KEY = 'automagik.viewer'
const RELOAD_KEY = 'automagik.retired'
// A replacement plugin instance can start in the same document.
const HIDDEN_DOCUMENT = Symbol.for('automagik.hidden-document')
const REFUSAL_BODY_MS = 5_000
const REVALIDATE_MS = 5_000
const REVALIDATE_RETRY_MS = 750
const CHECK_DEADLINE = Object.assign(new Error('Viewer check deadline'), { name: 'AbortError' })
const ROLES = new Set(['owner', 'member', 'guest', 'none'])
let guard

export function bootView() {
  const boot = globalThis.__AUTOMAGIK_VIEW__
  if (boot === undefined) return
  return boot?.version === 1 && ROLES.has(boot.role) ? boot : { role: 'none' }
}

export const mountedViewer = () => guard?.retired || guard?.signal?.aborted ? undefined : guard?.viewer
export const isRetired = () => guard?.retired === true
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
  if (!active) return
  if (guard !== active || active.retired || active.signal?.aborted) throw unavailable()
  if (active.viewer) {
    const current = storedViewer()
    if ((current !== null || active.markerSet) && current !== active.viewer.id) {
      retire(active)
      throw unavailable()
    }
  }
}

export function viewerRefused(active, code) {
  if (active && code === 'bot/viewer-changed') retire(active)
}

export const viewerChanged = answer => answer?.code === 'bot/viewer-changed' || answer?.error?.code === 'bot/viewer-changed'

async function refusalBody(response, signal) {
  if (!response.body || signal?.aborted) return
  const reader = response.body.getReader()
  let cancelled = false
  const cancel = () => {
    cancelled = true
    void reader.cancel().catch(() => {})
  }
  const timer = setTimeout(cancel, REFUSAL_BODY_MS)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const decoder = new TextDecoder()
    let text = ''
    while (!cancelled) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    if (!cancelled) return JSON.parse(text + decoder.decode())
  } catch { /* Refusals can have empty or non-JSON bodies. */ }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export async function viewerResponse(active, response, endpoint, signal) {
  const authRefused = response.status === 401 || response.status === 403
  const refresh = response.status === 401 && response.headers?.get('x-automagik-dsh-refresh') === '1'
  if (authRefused && endpoint === 'whoami' && !active.viewer && !refresh) retire(active)
  const attempt = active.checkAttempt
  if (authRefused && attempt && signal === attempt.controller.signal) {
    // Revalidation can act on the status while the optional error code is read.
    attempt.refusal = refusalBody(response, signal).then(answer => {
      if (viewerChanged(answer)) retire(active)
    }).catch(() => {})
    return { refresh }
  }
  const answer = await refusalBody(response, signal ?? active.signal)
  signal?.throwIfAborted()
  const changed = viewerChanged(answer)
  if (changed) retire(active)
  else if (authRefused && endpoint !== 'whoami') void active.revalidate?.()
  return { answer, changed, refresh }
}

const authRefusal = error => error?.code === 'HTTP_401' || error?.code === 'HTTP_403'

export function revalidateViewerOnRefusal(active, error) {
  if (authRefusal(error) && !error.refresh) void active.revalidate?.()
}

export function onRetire(hook) {
  if (!guard) return () => {}
  const hooks = guard.hooks
  if (guard.retired) hook()
  else hooks.add(hook)
  return () => hooks.delete(hook)
}

function hideDocument() {
  const body = document.body
  const hidden = document[HIDDEN_DOCUMENT] ??= {
    display: body?.style?.getPropertyValue('display'),
    priority: body?.style?.getPropertyPriority('display'),
    inert: body?.inert,
  }
  if (body) {
    body.inert = true
    body.style?.setProperty('display', 'none', 'important')
  }
  return hidden
}

function retire(active) {
  if (guard !== active || active.retired) return
  active.retired = true
  active.viewer = undefined
  const hidden = hideDocument()
  delete hidden.handoff
  for (const hook of active.hooks) {
    try { hook() } catch { /* Other retirement hooks still need to run. */ }
  }
  active.hooks.clear()
  document.body?.replaceChildren?.()
  clearClientErrors()
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === '1') return
    sessionStorage.setItem(RELOAD_KEY, '1')
  } catch { return } // Hold closed if a reload cannot be bounded.
  try { location.reload() } catch { /* The page is already closed. */ }
}

// DSH writes its conversation store synchronously, including when cleanup clears
// the in-memory draft. Keep those writes scoped to this document.
function trackDrafts(active, viewer, written = new Map()) {
  try {
    const storage = localStorage
    const prototype = Object.getPrototypeOf(storage)
    const set = prototype.setItem
    const remove = prototype.removeItem
    if (typeof set !== 'function' || typeof remove !== 'function') return
    const current = () => storage.getItem(VIEWER_KEY) === viewer.id
    const conversation = key => typeof key === 'string' && key.startsWith('dsh.conversation.')
    prototype.setItem = function (key, value) {
      if (this !== storage || !conversation(key)) return set.call(this, key, value)
      if (active.viewer && !active.retired && !active.signal?.aborted && current()) {
        set.call(this, key, value)
        written.set(key, storage.getItem(key))
      }
    }
    prototype.removeItem = function (key) {
      if (this !== storage || !conversation(key)) return remove.call(this, key)
      if (active.viewer && !active.retired && !active.signal?.aborted && current()) {
        remove.call(this, key)
        written.delete(key)
      }
    }
    const clear = () => {
      try {
        if (current()) {
          for (const [key, value] of written) if (storage.getItem(key) === value) remove.call(storage, key)
        }
      } finally { written.clear() }
    }
    return {
      written,
      clear,
      stop() {
        prototype.setItem = set
        prototype.removeItem = remove
      },
    }
  } catch { /* DSH can still render with site storage unavailable. */ }
}

function confirmed(answer, boot) {
  const viewer = answer?.viewer
  return boot.role !== 'none' && answer?.multiuser === true && answer.role === boot.role &&
    (viewer?.role === boot.role || (boot.role === 'owner' && viewer?.role === 'admin')) &&
    typeof viewer.id === 'string' && /^[\w-]{1,64}$/.test(viewer.id)
}

export function checkViewerAnswer(active, answer) {
  const viewer = active?.viewer
  if (viewer && (!confirmed(answer, active.boot) || answer.viewer.id !== viewer.id || answer.viewer.role !== viewer.role)) {
    retire(active)
    throw unavailable()
  }
}

export async function startViewer(boot, signal, prepare, clearNativeDrafts) {
  if (guard) throw new Error('Viewer already started')
  if (signal?.aborted) throw unavailable()
  const active = guard = { hooks: new Set(), retired: false, boot, signal }
  const previousViewer = storedViewer()
  const hidden = hideDocument()
  const handoff = hidden.handoff
  const retained = handoff?.viewer
  const current = () => guard === active && !active.retired && !signal?.aborted
  let cancelDelay
  const pause = async delay => {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, delay)
      cancelDelay = () => { clearTimeout(timer); resolve() }
    })
    cancelDelay = undefined
  }
  active.hooks.add(() => cancelDelay?.())
  let drafts = handoff?.drafts
  let stopTrackingDrafts
  const startTracking = viewer => {
    const tracking = trackDrafts(active, viewer, drafts?.written)
    if (tracking) {
      drafts = tracking
      stopTrackingDrafts = tracking.stop
    }
  }
  // Keep native cleanup from persisting over retained drafts during confirmation.
  if (retained) startTracking(retained)
  const draftRole = retained?.role ?? boot.role
  const clearDrafts = () => {
    try {
      if (draftRole === 'owner' || draftRole === 'admin') clearNativeDrafts?.()
    } catch { /* The native session service may be disposing too. */ }
    try { drafts?.clear() } catch { /* Storage may be unavailable. */ }
  }
  if (retained) active.hooks.add(clearDrafts)
  const abort = () => {
    cancelDelay?.()
    if (guard === active && !active.retired) {
      const hidden = hideDocument()
      if (active.viewer) {
        hidden.handoff = { viewer: active.viewer, drafts }
      }
      active.stop?.()
      stopTrackingDrafts?.()
      guard = undefined
      delete globalThis.__AUTOMAGIK_MOUNTED_VIEWER__
    }
  }
  signal?.addEventListener('abort', abort, { once: true })
  let answer
  let delay = 250
  while (current()) {
    try {
      answer = await call('whoami', undefined, signal)
      break
    } catch {
      if (!current()) break
      await pause(delay)
      delay = Math.min(15_000, delay * 2)
    }
  }
  if (!current()) throw new Error('Viewer unavailable')
  const currentViewer = storedViewer()
  if (!confirmed(answer, boot) ||
      (retained && (retained.id !== answer.viewer.id || retained.role !== answer.viewer.role)) ||
      (currentViewer !== null && currentViewer !== previousViewer && currentViewer !== answer.viewer.id)) {
    retire(active)
    throw new Error('Viewer role changed')
  }
  const viewer = active.viewer = answer.viewer
  try {
    localStorage.setItem(VIEWER_KEY, viewer.id)
    active.markerSet = true
  } catch { /* The server still checks each request's viewer. */ }
  if (!stopTrackingDrafts) startTracking(viewer)
  active.hooks.add(clearDrafts)

  const pendingChecks = new Set()
  const checkWhoami = async () => {
    const controller = new AbortController()
    const attempt = active.checkAttempt = { controller }
    pendingChecks.add(controller)
    const { signal } = controller
    const deadline = setTimeout(() => controller.abort(CHECK_DEADLINE), REVALIDATE_MS)
    // Bound the check even if a response body ignores cancellation.
    const aborted = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    try { await Promise.race([call('whoami', undefined, signal), aborted]) }
    finally {
      active.checkAttempt = undefined
      const finish = () => {
        clearTimeout(deadline)
        pendingChecks.delete(controller)
      }
      if (attempt.refusal) void attempt.refusal.then(finish)
      else finish()
    }
  }
  let checking = false
  const check = active.revalidate = async () => {
    if (checking || !current()) return
    checking = true
    try {
      await checkWhoami()
    } catch (first) {
      if (!current() || !authRefusal(first)) return
      await pause(REVALIDATE_RETRY_MS)
      if (!current()) return
      try { await checkWhoami() }
      catch (retry) {
        if (authRefusal(retry) && !retry.refresh) retire(active)
      }
    } finally { checking = false }
  }
  const visibility = () => { if (document.visibilityState === 'visible') void check() }
  const storage = event => {
    if (event.key === null || (event.key === VIEWER_KEY && event.newValue !== viewer.id)) retire(active)
  }
  window.addEventListener('focus', check)
  window.addEventListener('storage', storage)
  document.addEventListener('visibilitychange', visibility)
  const timer = setInterval(check, 15_000)
  active.stop = () => {
    for (const controller of pendingChecks) controller.abort()
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
    response: response => viewerResponse(active, response),
    refused: code => viewerRefused(active, code),
  })
  if (prepare) {
    try { await prepare() }
    catch (error) { if (current()) retire(active); throw error }
    if (!current()) throw unavailable()
  }
  checkViewer(active)
  const body = document.body
  if (body) {
    body.inert = hidden.inert
    body.style?.setProperty('display', hidden.display, hidden.priority)
  }
  delete document[HIDDEN_DOCUMENT]
  try { sessionStorage.removeItem(RELOAD_KEY) } catch { /* The page is ready even without site storage. */ }
  return viewer
}
