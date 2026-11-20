import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { createCarrier } from '../src/carrier.js'
import { createNonces } from '../src/nonces.js'
import { createScope } from '../src/scope.js'

export const wire = JSON.parse(readFileSync(new URL('../../../server/test/fixtures/caller-assertion-v1.json', import.meta.url)))
export const seconds = wire.payload.iat
export const prefix = '/_automagik/caller'
export const target = wire.payload.path
export const wireEncode = data => Buffer.from(JSON.stringify(data)).toString('base64url')
export const rpc = (method = 'fixture', payload = {}) => JSON.stringify({ type: 'client-request', rpcId: 'fixture', method, payload })

export function signingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const { x } = publicKey.export({ format: 'jwk' })
  const kid = createHash('sha256').update(Buffer.from(x, 'base64url')).digest().subarray(0, 16).toString('base64url')
  const header = { alg: 'EdDSA', kid, typ: 'automagik-caller' }
  const signed = (h, p) => {
    const input = `${h}.${p}`
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`
  }
  return {
    kid, header, signed,
    published: { kid, alg: 'EdDSA', crv: 'Ed25519', x },
    keys: new Map([[kid, { key: publicKey, instance: wire.payload.aud }]]),
    assertion(fields = {}, headerFields = {}) {
      return signed(wireEncode({ ...header, ...headerFields }),
        wireEncode({ ...wire.payload, nonce: randomBytes(16).toString('base64url'), ...fields }))
    },
  }
}

export function runtime(t) {
  const ctx = new Context()
  const webServer = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  const connection = new HostConnectionService(ctx, [], {})
  t.after(() => ctx.fiber.dispose())
  return { ctx, webServer, connection }
}

export async function localHTTP(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })
  return { server, port, authority: `127.0.0.1:${port}` }
}

export function send(port, path, { method = 'GET', headers = {}, body, chunks, upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, res => {
      const buffers = []
      res.on('data', chunk => buffers.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(buffers) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (upgrade) req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode }) })
    req.setTimeout(5000, () => req.destroy(new Error('Test request timed out')))
    if (chunks) for (const chunk of chunks) req.write(chunk)
    req.end(body)
  })
}

export async function invoke(handler, { url, method, headers, body, chunks, rawHeaders, onTransport, waitForEnd = false }) {
  const req = Readable.from(chunks?.map(chunk => Buffer.from(chunk)) ?? (body ? [Buffer.from(body)] : []))
  const flat = Object.entries(headers).filter(([, value]) => value !== undefined)
  Object.assign(req, { url, method, headers: Object.fromEntries(flat), rawHeaders: rawHeaders ?? flat.flat() })
  const buffers = []
  const res = new Writable({ write(chunk, _encoding, done) { buffers.push(chunk); done() } })
  res.writeHead = (status, headers) => Object.assign(res, { status, headers, headersSent: true })
  onTransport?.(req, res)
  await handler(req, res)
  if (waitForEnd) await finished(res, { cleanup: true })
  return { status: res.status, headers: res.headers, bytes: Buffer.concat(buffers), req }
}

export function carrier(t, overrides = {}) {
  const services = runtime(t)
  const key = signingKey()
  const scope = createScope()
  const authority = '127.0.0.1:54321'
  const options = {
    ...services, keys: key.keys, nonces: createNonces({ startedAtSec: seconds - 6 }), scope,
    multiuser: true, keysConfigured: true, expectedAuthority: () => authority,
    now: () => seconds * 1000, ...overrides,
  }
  let handler = createCarrier(options)
  const call = (path = target, options = {}) => {
    const { method = 'POST', assertion = key.assertion({ method, path }), headers, ...rest } = options
    return invoke(handler, {
      url: prefix + path, method, headers: { host: authority, 'content-type': 'application/json', 'x-automagik-caller': assertion, ...headers },
      ...rest,
    })
  }
  const observe = handler => {
    assert.ok(services.connection.rpc.intercept('/api', () => true, handler))
  }
  return { ...services, authority, scope, key, handler, call, observe,
    replaceHandler: () => { handler = createCarrier(options) },
  }
}
