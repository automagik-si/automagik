import { Readable } from 'node:stream'
import { verifyAssertion } from './assertion.js'
import { frontendPath } from './frontend.js'

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 314572800
const DRAIN_TIMEOUT_MS = 30_000
const PREFIX = '/_automagik/caller'
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

async function bufferedBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) return null
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return size ? Buffer.concat(chunks, size) : undefined
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

export function createCarrier({ connection, staticResource, clientModules, appResource, keys, nonces, scope, multiuser, keysConfigured,
  expectedAuthority, maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES, now = () => Date.now(), active = () => true,
}) {
  const api = connection.createSharedFetchHandler('/api')
  const inFlight = new Set()
  let onIdle
  const handler = async (req, res) => {
    const refuse = status => res.writeHead(status).end()
    if (!multiuser) return refuse(401)
    if (!keysConfigured) {
      if (!warned) {
        warned = true
        console.warn('automagik caller: key source is not configured')
      }
      return refuse(401)
    }
    const authority = expectedAuthority()
    const hosts = rawHeader(req, 'host')
    const origins = rawHeader(req, 'origin')
    if (!authority || hosts.length !== 1 || hosts[0] !== authority ||
        origins.length > 1 || (origins.length === 1 && origins[0] !== `http://${authority}`) ||
        rawHeader(req, 'sec-fetch-site').includes('cross-site')) return refuse(403)
    const assertions = rawHeader(req, 'x-automagik-caller')
    if (assertions.length !== 1) return refuse(401)
    let nowSec
    try { nowSec = nonces.verificationSecond(Math.floor(now() / 1000)) }
    catch { return refuse(503) }
    let url, verified
    try {
      url = restore(req)
      verified = verifyAssertion(assertions[0], {
        keys, method: req.method, path: url.pathname + url.search, nowSec, startedAtSec: nonces.startupSecond,
      })
    } catch { return refuse(401) }
    const consumed = nonces.consume(verified.nonce, verified.exp)
    if (consumed !== 'ok') return refuse(consumed === 'full' ? 503 : 401)
    const person = Object.freeze({ ...verified.principal, roles: Object.freeze(verified.principal.roles) })
    const principal = Object.freeze({ kind: 'automagik', instance: verified.aud, person })
    const abort = new AbortController()
    const onClose = () => { if (!res.writableEnded) abort.abort() }
    res.once('close', onClose)
    const cancel = () => {
      abort.abort()
      res.destroy()
    }
    let peer
    try {
      const { method } = req
      const headers = new Headers({ host: authority })
      for (const name of REQUEST_HEADERS) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name])
      }
      const apiRequest = within(url.pathname, '/api')
      const streaming = apiRequest && api.requestBodyMode({ method, url }) === 'streaming'
      const body = apiRequest && !streaming ? await bufferedBody(req, maxRequestBodyBytes) : undefined
      if (!active()) return req.readableEnded ? refuse(503) : closeRequest(req, res, 503)
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
      inFlight.add(cancel)
      await scope.run(principal, async () => {
        let response
        if (apiRequest) response = await api.fetch(request, peer)
        else if (kind === 'bundle') response = await clientModules?.()?.fetchBundle(request)
        else if (kind === 'app') response = await appResource?.(request)
        else response = await staticResource?.(request, peer)
        if (!response) return refuse(404)
        await writeResponse(response, req, res, abort.signal, streaming && !req.readableEnded)
      })
    } catch {
      if (res.headersSent || res.destroyed) res.destroy()
      else refuse(500)
    } finally {
      if (inFlight.delete(cancel) && !inFlight.size) onIdle?.()
      res.off('close', onClose)
      await peer?.dispose()
    }
  }
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
