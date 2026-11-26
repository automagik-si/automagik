// Antigravity's sign-in link (#2048, the Bot chat's row): only Google's own OAuth entry points,
// over https, asking for a code for a named client, with a loopback return address on port 1024
// or above (agy's own listener) and one printable state. A copy of welcome-dsh's
// src/host/sign-in-url.js (and of acp-dsh's agents.js isSignInUrl), kept equal by
// cli-login-host.test.js. No imports, so the client bundle could carry it.
const GOOGLE_SIGN_IN = new Set(['accounts.google.com/o/oauth2/v2/auth', 'accounts.google.com/o/oauth2/auth'])
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackReturn(value) {
  if (typeof value !== 'string') return false
  try {
    const back = new URL(value)
    return back.protocol === 'http:' && LOOPBACK.has(back.hostname) && /^\d+$/.test(back.port)
      && Number(back.port) >= 1024 && !back.username && !back.password && !back.hash
  } catch { return false }
}

// The state agy waits for back: exactly one, printable, 8-512 characters (#2048, paste-back).
const stateOf = url => {
  const states = url.searchParams.getAll('state')
  return states.length === 1 && /^[^\p{Cc}\s]{8,512}$/u.test(states[0])
}

export function isSignInUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\p{Cc}\s]/u.test(value)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false
    if (!GOOGLE_SIGN_IN.has(`${url.hostname}${url.pathname}`)) return false
    return url.searchParams.get('response_type') === 'code'
      && /^[\w.-]{1,256}$/.test(url.searchParams.get('client_id') ?? '')
      && isLoopbackReturn(url.searchParams.get('redirect_uri')) && stateOf(url)
  } catch { return false }
}
