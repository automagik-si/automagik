import { ROLES_OFF_REASON } from '../shared/roles.js'
import { hostText, t } from './i18n.js'
import { checkViewer, checkViewerAnswer, isRetired, requestViewer, viewerChanged, viewerRefused, viewerResponse } from './viewer.js'
import { markNoted, noteClientError } from './diagnostics.js'

const ROUTE = 'api/omni-ui'
// Refusals carry a message meant for the user, who sees it where they acted. The adopt
// flow's refusals are a family (`bot/adopt-*`): each names its reason and the Bot and
// Session involved, so the toast shows it and reportError records it once.
const REFUSALS = new Set(['bot/refused', 'bot/sign-in-required', 'bot/account-confirm-required', 'bot/account-changed', 'bot/account-signed-out', 'bot/invalid', 'bot/read-only', 'bot/viewer-changed', 'bot/not-found', 'bot/browser-off', 'bot/login-ended', 'bot/login-restarted'])
export const isRefusal = code => REFUSALS.has(code) || code === 'bot/review-guard'
  || code.startsWith('bot/adopt-') || code.startsWith('bot/reservation-')

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
  let result
  try { result = await response.json() } catch (error) {
    checkViewer(active)
    if (endpoint !== 'skill-library-save' || error?.name === 'AbortError') throw error
    // Once headers arrived, an interrupted response body can still hide a
    // completed Save. Keep its operation available for recovery.
    throw Object.assign(new Error(t('Could not reach DSH. Check that it is still running.'), { cause: error }), { code: 'NETWORK' })
  }
  if (whoami) signal?.throwIfAborted()
  checkViewer(active)
  const changed = active && viewerChanged(result)
  if (!result.ok || changed) {
    const code = changed ? 'bot/viewer-changed' : result.error?.code ?? 'bot/error'
    viewerRefused(active, code)
    const message = hostText(result.error?.message ?? 'Request failed')
    const error = Object.assign(new Error(code === 'bot/internal' ? `${message} ${t('Settings → Feedback has the details.')}` : message), { code })
    // Keep the selector and Solver dialog's machine-readable refusal reasons through translation.
    if (code === 'bot/refused' && ['needs-new-conversation', 'reply-running', ROLES_OFF_REASON].includes(result.error?.reason)) {
      error.reason = result.error.reason
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
