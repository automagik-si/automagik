import { addAbortListener } from 'node:events'
import { Readable } from 'node:stream'
import { verifyAssertion } from './assertion.js'
import { frontendPath } from './frontend.js'
import { createPeerRegistry } from './peers.js'

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 314572800
export const CALLER_PAIRS = new Map([['POST /api/omni-ui', 16_384], ['GET /api/omni-ui/feed', 0]])
const DRAIN_TIMEOUT_MS = 30_000
const PREFIX = '/_automagik/caller'
export const READY_PATH = PREFIX + '/_ready'
const REQUEST_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length',
  'if-none-match', 'if-modified-since', 'range', 'if-range']
let warned = false

function rawHeader(req, name) {
  const values = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) values.push(req.rawHeaders[i + 1])
  }
  return values
}

const within = (path, prefix) => path === prefix || path.startsWith(prefix + '/')
const readMethod = method => method === 'GET' || method === 'HEAD'

function restore(req) {
  const { pathname, search } = new URL(req.url, 'http://x')
  if (!within(pathname, PREFIX)) throw new Error('Wrong carrier path')
  const path = pathname.slice(PREFIX.length) || '/'
  if (within(path.toLowerCase(), '/_automagik') || within(path, '/_gate') || path === '/connect' ||
      path.startsWith('//') || (!within(path, '/api') && !readMethod(req.method))) throw new Error('Target refused')
  return new URL(`http://dsh.internal${path}${search}`)
}

function closeRequest(req, res, status) {
  res.writeHead(status, { connection: 'close' })
  res.end(() => req.destroy())
}

async function bufferedBody(req, limit, signal) {
  if (Number(req.headers['content-length']) > limit) return null
  const chunks = []
  let size = 0
  const cancelled = Promise.withResolvers()
  const onAbort = addAbortListener(signal, () => {
    chunks.length = 0
    cancelled.resolve()
  })
  const read = async () => {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      if (signal.aborted) return
      size += chunk.length
      if (size > limit) return null
      chunks.push(chunk)
    }
    if (!signal.aborted && size) return Buffer.concat(chunks, size)
  }
  try { return await Promise.race([read(), cancelled.promise]) }
  finally { onAbort[Symbol.dispose]() }
}

function waitForDrain(res) {
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

async function writeResponse(response, req, res, signal, unread) {
  if (signal.aborted) {
    await response.body?.cancel()
    return
  }
  const headers = Object.fromEntries(response.headers)
  if (unread) headers.connection = 'close'
  res.writeHead(response.status, headers)
  if (req.method === 'HEAD') await response.body?.cancel()
  else if (response.body) {
    for await (const chunk of response.body) {
      if (signal.aborted) break
      if (!res.write(chunk) && !res.destroyed) await waitForDrain(res)
    }
  }
  res.end(unread ? () => req.destroy() : undefined)
}

// The shared admission of a caller request (HTTP and the stream upgrade): the gate's signed
// assertion for this exact method and target, consumed once. Returns `{ status }` on refusal.
export function admitCaller(req, { keys, nonces, multiuser, keysConfigured, expectedAuthority, now = () => Date.now(), seen }) {
  if (!multiuser) return { status: 401 }
  if (!keysConfigured) {
    if (!warned) {
      warned = true
      console.warn('automagik caller: key source is not configured')
    }
    return { status: 401 }
  }
  const authority = expectedAuthority()
  const hosts = rawHeader(req, 'host')
  const origins = rawHeader(req, 'origin')
  if (!authority || hosts.length !== 1 || hosts[0] !== authority ||
      origins.length > 1 || (origins.length === 1 && origins[0] !== `http://${authority}`) ||
      rawHeader(req, 'sec-fetch-site').includes('cross-site')) return { status: 403 }
  const assertions = rawHeader(req, 'x-automagik-caller')
  if (assertions.length !== 1) return { status: 401 }
  let nowSec
  try { nowSec = nonces.verificationSecond(Math.floor(now() / 1000)) }
  catch { return { status: 503 } }
  let url, verified
  try {
    url = restore(req)
    verified = verifyAssertion(assertions[0], {
      keys, method: req.method, path: url.pathname + url.search, nowSec, startedAtSec: nonces.startupSecond,
    })
  } catch { return { status: 401 } }
  // The gate always names the session family; a caller without one cannot be ended with it.
  if (verified.session === undefined) return { status: 401 }
  const consumed = nonces.consume(verified.nonce, verified.exp)
  if (consumed !== 'ok') return { status: consumed === 'full' ? 503 : 401 }
  const person = Object.freeze({ ...verified.principal, roles: Object.freeze(verified.principal.roles) })
  const principal = Object.freeze({ kind: 'automagik', instance: verified.aud, person })
  seen?.(person)
  return { authority, url, principal, session: verified.session, exp: verified.exp, nonce: verified.nonce }
}

export function createCarrier({ connection, staticResource, clientModules, appResource, keys, nonces, scope, multiuser, keysConfigured,
  expectedAuthority, maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES, now = () => Date.now(), active = () => true,
  ready = active, apiFor, seen, registry = createPeerRegistry(), callerRoutes = () => undefined, callerSlots = 4,
}) {
  if (!apiFor) {
    const api = connection.createSharedFetchHandler('/api')
    apiFor = () => api
  }
  const inFlight = new Set()
  const posts = new Map()
  const pending = new Set()
  let onIdle
  const admission = { keys, nonces, multiuser, keysConfigured, expectedAuthority, now, seen }
  const handler = async (req, res) => {
    const refuse = status => res.writeHead(status).end()
    // The gate's readiness probe: an exact raw target that reads no body and needs no assertion.
    if (req.method === 'GET' && req.url === READY_PATH) {
      if (!ready()) return refuse(503)
      return res.writeHead(204, { 'x-automagik-ready': '1' }).end()
    }
    const admitted = admitCaller(req, admission)
    if (admitted.status) return refuse(admitted.status)
    const unavailable = () => {
      if (!res.destroyed) return req.readableEnded ? refuse(503) : closeRequest(req, res, 503)
    }
    const binding = active()
    if (!binding) return unavailable()
    const api = apiFor(binding)
    const { authority, url, principal, session } = admitted
    // A policy change after admission makes this caller's registry entry dead on arrival.
    const epoch = registry.epoch
    const abort = new AbortController()
    const onClose = () => { if (!res.writableEnded) abort.abort() }
    res.once('close', onClose)
    const cancel = () => {
      abort.abort()
      res.destroy()
    }
    let peer, slot
    try {
      const { method } = req
      const raw = req.url.slice(PREFIX.length)
      const pairLimit = CALLER_PAIRS.get(method + ' ' + raw)
      const routes = pairLimit === undefined ? undefined : callerRoutes()
      const callerHandler = routes?.version === 1 ? routes.match(url.pathname, method) : undefined
      if (callerHandler && method === 'POST') {
        const key = JSON.stringify([principal.person.issuer, principal.person.subject])
        const count = posts.get(key) ?? 0
        if (count >= callerSlots) return closeRequest(req, res, 429)
        posts.set(key, count + 1)
        slot = key
      }
      const headers = new Headers({ host: authority })
      for (const name of REQUEST_HEADERS) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name])
      }
      const apiRequest = within(url.pathname, '/api')
      const streaming = apiRequest && !callerHandler && api.requestBodyMode({ method, url }) === 'streaming'
      let body
      if (apiRequest && !streaming) {
        const stop = () => abort.abort()
        pending.add(stop)
        const untrack = registry.trackPending(stop)
        const limit = callerHandler ? Math.min(pairLimit, maxRequestBodyBytes) : maxRequestBodyBytes
        try { body = await bufferedBody(req, limit, abort.signal) }
        finally { pending.delete(stop); untrack() }
      }
      if (abort.signal.aborted || active() !== binding || registry.epoch !== epoch) return unavailable()
      if (body === null) return closeRequest(req, res, 413)
      const kind = apiRequest ? undefined : frontendPath(url)
      if (!apiRequest && !kind) return refuse(404)
      const init = { method, headers, signal: abort.signal }
      if (streaming && !readMethod(method)) {
        init.body = Readable.toWeb(req)
        init.duplex = 'half'
      } else if (body !== undefined) init.body = body
      const request = new Request(url, init)
      peer = connection.createPeer({ principal, interactions: 'none' })
      registry.add(peer, { principal, session, kind: 'http', close: cancel, epoch })
      inFlight.add(cancel)
      await scope.run(principal, async () => {
        if (!registry.live(peer) || active() !== binding) return unavailable()
        let response
        if (callerHandler) response = await callerHandler(request, principal, peer)
        else if (apiRequest) response = await api.fetch(request, peer)
        else if (kind === 'bundle') response = await clientModules?.()?.fetchBundle(request)
        else if (kind === 'app') response = await appResource?.(request)
        else response = await staticResource?.(request, peer)
        if (!response) return refuse(404)
        await writeResponse(response, req, res, abort.signal, streaming && !req.readableEnded)
      }, { session })
    } catch {
      if (res.headersSent || res.destroyed) res.destroy()
      else if (abort.signal.aborted) unavailable()
      else refuse(500)
    } finally {
      if (slot !== undefined) {
        const count = posts.get(slot)
        if (count === 1) posts.delete(slot)
        else posts.set(slot, count - 1)
      }
      if (inFlight.delete(cancel) && !inFlight.size) onIdle?.()
      res.off('close', onClose)
      if (peer) registry.remove(peer)
      await peer?.dispose()
    }
  }
  handler.stopPending = () => { for (const stop of pending) stop() }
  handler.drain = () => {
    if (!inFlight.size) return
    const { promise, resolve } = Promise.withResolvers()
    onIdle = resolve
    const timer = setTimeout(resolve, DRAIN_TIMEOUT_MS)
    return promise.then(() => {
      clearTimeout(timer)
      onIdle = undefined
      for (const cancel of inFlight) cancel()
      inFlight.clear()
    })
  }
  return handler
}
