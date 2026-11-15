import { remoteAddress, HERMES_DEADLINES } from './hermes-transport.js'
import { refusal } from './refusal.js'

const fail = (message, kind = 'connection') => refusal(message, { code: `bot/hermes-${kind}` })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clean = (value, max = 16_384) => typeof value === 'string' && value.length > 0 && value.length <= max && !['\r', '\n', '\0'].some(character => value.includes(character))
const profileName = value => clean(value, 100) && value.trim() === value && !value.includes('/') && !value.includes('\\')

function cookiePairs(response) {
  const headers = response.headers
  const values = headers?.getSetCookie?.() ?? (headers?.get?.('set-cookie') ? [headers.get('set-cookie')] : [])
  const cookies = values.flatMap(value => value.split(/,(?=\s*[^=;,\s]+=)/)).map(value => value.trim().split(';', 1)[0])
  if (cookies.some(value => !clean(value) || !/^[^=;,\s]+=[^;]*$/.test(value))) {
    throw fail('Hermes did not return a usable sign-in session. Sign in again.', 'auth')
  }
  return cookies
}
function cookiesOf(response) {
  const cookies = cookiePairs(response)
  if (!cookies.length) throw fail('Hermes did not return a usable sign-in session. Sign in again.', 'auth')
  return cookies.join('; ')
}

export function connectionRedactor(values) {
  return text => {
    for (const secret of values) {
      if (typeof secret !== 'string' || !secret) continue
      for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) text = text.split(form).join('[redacted]')
    }
    return text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  }
}

// What the attached connection offers DSH: one model row, the bot's own. The id is stable
// across profile changes so a paired Bot keeps its model reference; the name is the model
// and provider the CLI reported, never parsed out of a joined provider:model string.
export function attachedModelOf(profile) {
  const model = typeof profile?.model === 'string' ? profile.model.trim() : ''
  const provider = typeof profile?.provider === 'string' ? profile.provider.trim() : ''
  return {
    id: 'attach',
    name: model ? (provider ? `${model} (${provider})` : model) : 'Hermes',
    provider: 'hermes-remote',
    model,
    providerId: provider,
  }
}

// Only the SSH factory can grant HTTP loopback. No draft flag changes this boundary.
export async function prepareHermesConnection(draft, {
  fetch: fetcher = globalThis.fetch,
  startSsh = async (...args) => (await import('./hermes-attach.js')).startHermesAttach(...args),
  signal,
  deadlines = HERMES_DEADLINES,
  secret,
  existingConnection,
  discover = true,
  onProgress = () => {},
  onAuthUpdate,
} = {}) {
  if (!object(draft) || !['remote', 'ssh'].includes(draft.mode)) throw fail('Choose Remote address or Through SSH.')
  if (signal?.aborted) throw fail('Connection setup was cancelled.')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const until = Date.now() + deadlines.start
  const startup = setTimeout(abort, deadlines.start)
  let owned, attached = false
  const authMode = draft.mode === 'ssh' ? 'token' : draft.authMode === 'password' ? 'password' : 'token'
  let address, credential, authHeaders, persisted, profiles = [], defaultProfile
  const redactionSecrets = []
  const addCookieSecret = value => {
    for (const secret of [value, value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value]) {
      if (secret && !redactionSecrets.includes(secret)) redactionSecrets.push(secret)
    }
  }
  async function captureCookies(response) {
    if (!authHeaders?.Cookie) return
    const updates = cookiePairs(response)
    if (!updates.length) return
    const jar = new Map(authHeaders.Cookie.split(';').map(pair => {
      const separator = pair.indexOf('=')
      return [pair.slice(0, separator).trim(), pair.slice(separator + 1).trim()]
    }))
    for (const pair of updates) {
      const separator = pair.indexOf('='), name = pair.slice(0, separator), value = pair.slice(separator + 1)
      if (value) jar.set(name, value); else jar.delete(name)
    }
    authHeaders.Cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    if (!clean(authHeaders.Cookie)) throw fail('The Hermes sign-in expired. Sign in again.', 'auth')
    persisted.cookie = authHeaders.Cookie
    for (const value of [authHeaders.Cookie, ...jar.values()]) addCookieSecret(value)
    await onAuthUpdate?.(persisted)
  }
  // In SSH mode the address is this computer's own tunnel: a request that gets no
  // answer is the tunnel's failure, and a refused token is the start handshake's.
  let phase = 'reach'
  const viaSsh = (message, kind) => Object.assign(fail(message, `ssh-${kind}`), { sshError: kind, sshStage: phase })
  const remaining = () => {
    if (controller.signal.aborted || Date.now() >= until) throw fail('Connection setup was cancelled or timed out. Connect again.', 'timeout')
    return Math.max(1, Math.min(deadlines.control, until - Date.now()))
  }
  async function request(path, { method = 'GET', body, headers = authHeaders } = {}) {
    const requestController = new AbortController()
    const stop = () => requestController.abort()
    controller.signal.addEventListener('abort', stop, { once: true })
    let timer, rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(fail('Hermes did not answer. Check the connection and try again.', 'timeout')); requestController.signal.addEventListener('abort', rejectAbort, { once: true }) })
    try {
      timer = setTimeout(stop, remaining())
      if (controller.signal.aborted) stop()
      return await Promise.race([(async () => {
        const response = await fetcher(`${address}${path}`, {
          method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: requestController.signal,
        }).catch(error => { throw owned && !requestController.signal.aborted ? viaSsh('The SSH tunnel is open, but Hermes did not answer through it.', 'tunnel') : error })
        if (response.status >= 300 && response.status < 400) throw fail('Hermes redirected this request. Enter its final address and try again.')
        if (owned && (response.status === 401 || response.status === 403)) throw viaSsh('The remote Hermes did not accept this connection’s private token.', 'handshake')
        if (!response.ok) throw fail(response.status === 401 || response.status === 403
          ? 'Hermes did not accept the sign-in. Check the token, user or password.' : 'Hermes could not complete this request. Try again.', response.status === 401 || response.status === 403 ? 'auth' : 'connection')
        await captureCookies(response)
        const value = await response.json()
        if (!object(value) || JSON.stringify(value).length > 1024 * 1024) throw fail('Hermes returned an invalid connection response.')
        return { value, response }
      })(), aborted])
    } catch (error) {
      if (error?.code?.startsWith('bot/hermes-')) throw error
      throw fail('Hermes could not connect. Check its address and sign-in.')
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', stop)
      requestController.signal.removeEventListener('abort', rejectAbort)
    }
  }
  try {
    onProgress('reach')
    if (existingConnection) {
      address = remoteAddress(existingConnection.address, { allowLoopback: existingConnection.allowLoopback })
      credential = existingConnection.credential
      authHeaders = existingConnection.authHeaders
      persisted = existingConnection.secret
      redactionSecrets.push(...existingConnection.redactionSecrets)
    } else if (draft.mode === 'ssh') {
      if (!object(draft.ssh) || !clean(draft.ssh.host, 4096)) throw fail('Enter an SSH host or config name.', 'ssh')
      for (const name of ['user', 'identityFile', 'hermesPath', 'hermesHome']) if (draft.ssh[name] !== undefined && draft.ssh[name] !== '' && !clean(draft.ssh[name], 4096)) throw fail('Enter valid optional SSH details.', 'ssh')
      const ssh = Object.fromEntries(['host', 'user', 'port', 'identityFile', 'hermesPath', 'hermesHome'].filter(name => draft.ssh[name] !== undefined).map(name => [name, draft.ssh[name]]))
      phase = 'ssh'
      owned = await startSsh(ssh, { signal: controller.signal, deadlines, onProgress })
      phase = 'token'
      remaining()
      address = remoteAddress(owned.address, { allowLoopback: true })
      if (!clean(owned.credential)) throw fail('SSH did not return a usable Hermes credential.')
      attached = owned.attached === true
      // The attached serve's host token goes to REST as a bearer and to the socket as
      // ?token=. It is only ever persisted through the app's existing secret endpoint.
      credential = owned.credential
      authHeaders = attached ? { Authorization: `Bearer ${credential}` } : { 'X-Hermes-Session-Token': credential }
      persisted = attached ? { kind: 'attach', credential } : undefined
      if (attached) {
        await onAuthUpdate?.(persisted)
        if (!Array.isArray(owned.profiles) || !owned.profiles.length) throw fail('Hermes is running there, but its profiles could not be read.', 'profiles')
        profiles = owned.profiles
        defaultProfile = owned.defaultProfile
      }
    } else {
      address = remoteAddress(draft.address)
      if (!['token', 'password'].includes(draft.authMode)) throw fail('Choose Session token or User and password.')
      if (secret) {
        if (secret.kind === 'token' && clean(secret.credential)) {
          credential = secret.credential
          authHeaders = { 'X-Hermes-Session-Token': credential }
        } else if (secret.kind === 'session' && clean(secret.cookie)) {
          credential = secret.cookie
          authHeaders = { Cookie: secret.cookie }
        } else throw fail('The saved sign-in is unavailable. Set up this connection again.', 'auth')
        persisted = secret.kind === 'session' ? { kind: 'session', cookie: secret.cookie } : { kind: 'token', credential: secret.credential }
      } else if (authMode === 'token') {
        if (!clean(draft.credential)) throw fail('Enter the session token for this Hermes.', 'auth')
        credential = draft.credential
        authHeaders = { 'X-Hermes-Session-Token': credential }
        persisted = { kind: 'token', credential }
      } else {
        if (!clean(draft.username, 256) || !clean(draft.password)) throw fail('Enter your Hermes user and password.', 'auth')
        redactionSecrets.push(draft.username, draft.password)
        const { value: providers } = await request('/api/auth/providers', { headers: {} })
        onProgress('sign-in')
        const choices = Array.isArray(providers.providers) ? providers.providers.filter(provider => object(provider) && provider.supports_password === true && clean(provider.name, 128)) : []
        if (choices.length !== 1) throw fail('This Hermes does not offer one supported password sign-in. Use a session token.', 'unsupported')
        const { value: login, response } = await request('/auth/password-login', {
          method: 'POST', headers: {}, body: { provider: choices[0].name, username: draft.username, password: draft.password },
        })
        if (login.ok !== true) throw fail('Hermes did not accept the sign-in. Check your user and password.', 'auth')
        if (login.next) {
          let next
          try { next = new URL(login.next, `${address}/`) } catch { throw fail('Hermes returned an invalid sign-in redirect.', 'auth') }
          if (next.origin !== new URL(address).origin || next.username || next.password) throw fail('Hermes returned an unsafe sign-in redirect.', 'auth')
        }
        credential = cookiesOf(response)
        authHeaders = { Cookie: credential }
        persisted = { kind: 'session', cookie: credential }
      }
    }
    redactionSecrets.push(credential, ...Object.values(authHeaders))
    // Cookie components are independently sensitive when a remote echoes one value.
    if (authHeaders.Cookie) for (const cookie of authHeaders.Cookie.split(';')) addCookieSecret(cookie.slice(cookie.indexOf('=') + 1).trim())
    const redact = connectionRedactor(redactionSecrets)
    if (attached && Array.isArray(owned?.profiles)) { profiles = owned.profiles; defaultProfile = owned.defaultProfile }
    if (discover && !attached) {
      const { value: status } = await request('/api/status')
      onProgress('sign-in')
      phase = 'profiles'
      const { value: inventory } = await request('/api/profiles')
      if (!Array.isArray(inventory.profiles)) throw fail('Hermes did not return its profiles.', 'profiles')
      let served
      if (Array.isArray(status.gateway_shared_with) && status.gateway_shared_with.every(profileName)) served = new Set(status.gateway_shared_with)
      else {
        // Pinned profiles.py: current is this running dashboard; active is the sticky CLI default.
        const { value: active } = await request('/api/profiles/active')
        if (!profileName(active.current)) throw fail('Hermes did not identify the profile it serves.', 'profiles')
        served = new Set([active.current])
        defaultProfile = active.current
      }
      profiles = inventory.profiles.filter(profile => object(profile) && profileName(profile.name) && served.has(profile.name) && redact(profile.name) === profile.name)
        .map(profile => ({ id: profile.name, name: redact(typeof profile.display_name === 'string' && profile.display_name.trim() ? profile.display_name : profile.name) }))
      if (!profiles.length) throw fail('This Hermes has no available profiles. Check which profiles its gateway serves.', 'profiles')
      // Several profiles to choose from: the one Hermes itself calls its default is offered
      // first. Asking is optional; a Hermes that does not say leaves the first of its list.
      if (profiles.length > 1 && !defaultProfile) try {
        const { value: active } = await request('/api/profiles/active')
        for (const name of [active?.current, active?.active]) if (!defaultProfile && profiles.some(profile => profile.id === name)) defaultProfile = name
      } catch (error) { if (controller.signal.aborted) throw error }
      if (!profiles.some(profile => profile.id === defaultProfile)) defaultProfile = profiles[0].id
      onProgress('open')
    }
    if (attached) onProgress('open')
    let closePromise
    return {
      mode: draft.mode, authMode, address, credential, authHeaders, redactionSecrets, profiles, defaultProfile, attached,
      ssh: draft.mode === 'ssh' ? Object.fromEntries(['host', 'user', 'port', 'identityFile', 'hermesPath', 'hermesHome'].filter(name => draft.ssh[name] !== undefined).map(name => [name, draft.ssh[name]])) : undefined,
      secret: persisted,
      allowLoopback: draft.mode === 'ssh',
      fetch: async (url, init) => {
        const response = await fetcher(url, init)
        if (response.ok) await captureCookies(response)
        return response
      },
      close: () => closePromise ??= Promise.resolve().then(() => owned?.close()),
    }
  } catch (error) {
    controller.abort()
    if (error && typeof error === 'object' && draft.mode === 'ssh') error.hermesStage ??= phase
    await owned?.close()
    if (error?.code?.startsWith('bot/')) throw error
    throw fail('Hermes could not connect. Check the connection details and try again.')
  } finally {
    clearTimeout(startup)
    signal?.removeEventListener('abort', abort)
  }
}

// Refresh an already-tested target without retaining or requesting the login password.
export async function refreshHermesProfiles(connection, options) {
  // An attached serve's profiles were read read-only through its CLI when the tunnel
  // opened; refreshing them would need another SSH read, never an API that could list
  // a different set.
  if (connection.attached === true) return connection.profiles
  const refreshed = await prepareHermesConnection({ mode: 'remote', authMode: connection.authMode }, { ...options, existingConnection: connection })
  return refreshed.profiles
}
