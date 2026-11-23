// A sign-in link agy handed over while it signs in (acp-dsh `signInUrl`, agents.js isSignInUrl):
// only Google's own OAuth entry points, over https, asking for a code for a named client, with
// a loopback return address (agy's own listener on this computer). The host checks it before
// the page sees it, and the page again before it opens it (acp-agents.js openSignInLinks). No
// imports, so the client bundle can carry it.
const GOOGLE_SIGN_IN = new Set(['accounts.google.com/o/oauth2/v2/auth', 'accounts.google.com/o/oauth2/auth'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackReturn(value) {
  if (typeof value !== 'string') return false
  try {
    const back = new URL(value)
    return back.protocol === 'http:' && LOOPBACK.has(back.hostname) && back.port !== ''
      && !back.username && !back.password && !back.hash
  } catch { return false }
}

export function isSignInUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\p{Cc}\s]/u.test(value)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (!GOOGLE_SIGN_IN.has(`${url.hostname}${url.pathname}`)) return false
    return url.searchParams.get('response_type') === 'code'
      && /^[\w.-]{1,256}$/.test(url.searchParams.get('client_id') ?? '')
      && isLoopbackReturn(url.searchParams.get('redirect_uri'))
  } catch { return false }
}
