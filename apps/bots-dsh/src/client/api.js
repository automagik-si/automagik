import { hostText, t } from './i18n.js'
import { checkViewer, checkViewerAnswer, isRetired, requestViewer, viewerChanged, viewerRefused, viewerResponse } from './viewer.js'
import { markNoted, noteClientError } from './diagnostics.js'

const ROUTE = 'api/omni-ui'
// Refusals carry a message meant for the user, who sees it where they acted. The adopt
// flow's refusals are a family (`bot/adopt-*`): each names its reason and the Bot and
// Session involved, so the toast shows it and reportError records it once.
const REFUSALS = new Set(['bot/refused', 'bot/sign-in-required', 'bot/account-confirm-required', 'bot/account-changed', 'bot/account-signed-out', 'bot/invalid', 'bot/read-only', 'bot/viewer-changed', 'bot/not-found', 'bot/browser-off', 'bot/login-ended', 'bot/login-restarted'])
export const isRefusal = code => REFUSALS.has(code) || code.startsWith('bot/adopt-') || code.startsWith('bot/reservation-')

export const call = async (endpoint, payload, signal) => {
  const active = requestViewer(endpoint)
  const viewer = active?.viewer?.id
  const vault = endpoint.startsWith('vault-')
  let response
  try {
    // Document-relative so the Web UI keeps working under a mounted base path.
    response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload: payload ?? null, ...(viewer === undefined ? {} : { viewer }) }),
      signal,
    })
  } catch (error) {
    checkViewer(active)
    if (error?.name === 'AbortError') throw error
    if (!vault) noteClientError(endpoint, Object.assign(new Error(`network error: ${error?.message ?? error}`), { code: 'NETWORK' }))
    // The browser's own text ("Failed to fetch", "Load failed") does not say what failed.
    throw markNoted(Object.assign(new Error(t('Could not reach DSH. Check that it is still running.')), {
      code: 'NETWORK', ...(!vault ? { cause: error } : {}),
    }))
  }
  // Only a whoami answer must not apply once its check was aborted; other callers (a cancelled Hermes test that
  // must still close its late resources) keep the answer that arrives after an abort, as before.
  const whoami = endpoint === 'whoami'
  if (whoami) signal?.throwIfAborted()
  checkViewer(active)
  if (!response.ok) {
    const refusal = active && await viewerResponse(active, response, endpoint, signal)
    const error = Object.assign(new Error(hostText(`HTTP ${response.status}`)), {
      code: refusal?.changed ? 'bot/viewer-changed' : `HTTP_${response.status}`,
      ...(refusal?.refresh ? { refresh: true } : {}),
    })
    if (!vault && !isRetired()) noteClientError(endpoint, error)
    throw error
  }
  const result = await response.json()
  if (whoami) signal?.throwIfAborted()
  checkViewer(active)
  const changed = active && viewerChanged(result)
  if (!result.ok || changed) {
    const code = changed ? 'bot/viewer-changed' : result.error?.code ?? 'bot/error'
    viewerRefused(active, code)
    const message = hostText(result.error?.message ?? 'Request failed')
    const error = Object.assign(new Error(code === 'bot/internal' ? `${message} ${t('Settings → Feedback has the details.')}` : message), { code })
    // The two refusals the selector answers with a question of its own: a Hermes crossing with
    // history, and a pick that would stop a running reply (RFC 0030, Handoff note).
    if (code === 'bot/refused' && (result.error?.reason === 'needs-new-conversation' || result.error?.reason === 'reply-running')) error.reason = result.error.reason
    if (code === 'bot/refused') {
      const { key, params } = result.error ?? {}
      if (typeof key === 'string' && /^skill\.[a-z-]{1,40}$/.test(key)) error.key = key
      if (params && Object.getPrototypeOf(params) === Object.prototype) {
        const entries = Object.entries(params)
        if (entries.length <= 8 && entries.every(([, value]) => (
          typeof value === 'string' ? value.length <= 200 : Number.isFinite(value)
        ))) error.params = params
      }
    }
    const staleShare = code === 'bot/stale' && endpoint === 'update-bot' && Object.hasOwn(payload ?? {}, 'people')
    if (!vault && !staleShare && !isRefusal(code)) {
      noteClientError(endpoint, Object.assign(new Error(result.error?.message ?? 'Request failed'), { code }))
      markNoted(error)
    }
    throw error
  }
  if (whoami) checkViewerAnswer(active, result.value)
  return result.value
}
