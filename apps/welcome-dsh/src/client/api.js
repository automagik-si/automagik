// Calls the host endpoint (src/host/endpoint.js). Document-relative, so DSH's web UI keeps
// working under a mounted base path. Its own errors read in the DSH language (i18n.js); the
// host's come as the host words them.
import { t } from './i18n.js'

const ROUTE = 'api/omni-ai'
// The Omni plugins' endpoint, which @automagik/omni-channels-dsh extends with discovery and
// linking (omni-discover, omni-link…). It answers only once those plugins run here.
const OMNI_UI = 'api/omni-ui'

export const call = (endpoint, payload) => callRoute(ROUTE, endpoint, payload)
export const callOmniUi = async (endpoint, payload) => {
  if (globalThis.__AUTOMAGIK_VIEW__ === undefined) return callRoute(OMNI_UI, endpoint, payload)
  const viewer = globalThis.__AUTOMAGIK_MOUNTED_VIEWER__
  if (!viewer) throw Object.assign(new Error('Viewer unavailable'), { code: 'bot/retired' })
  return callRoute(OMNI_UI, endpoint, payload, viewer)
}

async function callRoute(route, endpoint, payload, viewer) {
  const body = { endpoint, payload: payload ?? null }
  if (viewer) body.viewer = viewer.id
  let response
  try {
    response = await fetch(route, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    viewer?.check()
    throw Object.assign(new Error(t('Could not reach DSH. Check that it is still running.')), { code: 'NETWORK' })
  }
  viewer?.check()
  if (!response.ok) {
    viewer?.response(response)
    throw Object.assign(new Error(t('DSH answered HTTP {status}', { status: response.status })), { code: `HTTP_${response.status}` })
  }
  const result = await response.json()
  viewer?.check()
  if (!result.ok) {
    const code = result.error?.code ?? (viewer ? 'bot/error' : 'omni-ai/error')
    viewer?.refused(code)
    throw Object.assign(new Error(result.error?.message ?? t('Request failed')), { code })
  }
  return result.value
}
