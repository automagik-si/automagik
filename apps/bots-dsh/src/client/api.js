import { hostText, t } from './i18n.js'
import { markNoted, noteClientError } from './diagnostics.js'

const ROUTE = 'api/omni-ui'
// Refusals carry a message meant for the user, who sees it where they acted. The adopt
// flow's refusals are a family (`bot/adopt-*`): each names its reason and the Bot and
// Session involved, so the toast shows it and reportError records it once.
const REFUSALS = new Set(['bot/refused', 'bot/sign-in-required', 'bot/account-confirm-required', 'bot/account-changed', 'bot/account-signed-out', 'bot/invalid', 'bot/read-only', 'bot/not-found', 'bot/browser-off', 'bot/login-ended', 'bot/login-restarted'])
const isRefusal = code => REFUSALS.has(code) || code.startsWith('bot/adopt-') || code.startsWith('bot/reservation-')

export const call = async (endpoint, payload, signal) => {
  const vault = endpoint.startsWith('vault-')
  let response
  try {
    // Document-relative so the Web UI keeps working under a mounted base path.
    response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    if (!vault) noteClientError(endpoint, Object.assign(new Error(`network error: ${error?.message ?? error}`), { code: 'NETWORK' }))
    // The browser's own text ("Failed to fetch", "Load failed") does not say what failed.
    throw markNoted(Object.assign(new Error(t('Could not reach DSH. Check that it is still running.')), {
      code: 'NETWORK', ...(!vault ? { cause: error } : {}),
    }))
  }
  if (!response.ok) {
    const error = Object.assign(new Error(hostText(`HTTP ${response.status}`)), { code: `HTTP_${response.status}` })
    if (!vault) noteClientError(endpoint, error)
    throw error
  }
  const result = await response.json()
  if (!result.ok) {
    const code = result.error?.code ?? 'bot/error'
    const message = hostText(result.error?.message ?? 'Request failed')
    const error = Object.assign(new Error(code === 'bot/internal' ? `${message} ${t('Settings → Feedback has the details.')}` : message), { code })
    if (code === 'bot/refused' && result.error?.reason === 'needs-new-conversation') error.reason = result.error.reason
    if (!vault && !isRefusal(code)) {
      noteClientError(endpoint, Object.assign(new Error(result.error?.message ?? 'Request failed'), { code }))
      markNoted(error)
    }
    throw error
  }
  return result.value
}
