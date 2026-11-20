// Only this module talks to DSH, always on loopback. No discovery or Cloud connection.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LAUNCH_FILE } from './gate-view.mjs'
import { GATE_VIEW_MOUNT, PORT } from './lib.mjs'

export const DSH_HOST = '127.0.0.1'
export class DshCredentials {
  constructor({ launchFile = join(GATE_VIEW_MOUNT, LAUNCH_FILE), port = PORT } = {}) {
    this.launchFile = launchFile
    this.port = port
    this.authority = `${DSH_HOST}:${port}`
    this.pending = undefined
  }
  request(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const request = http.get({ hostname: DSH_HOST, port: this.port, path, headers: { ...headers, host: this.authority }, timeout: 5000 }, response => {
        response.resume()
        response.on('end', () => resolve(response))
        response.on('error', reject)
      })
      request.on('timeout', () => request.destroy(new Error('DSH timeout')))
      request.on('error', reject)
    })
  }
  async cookie(refresh = false) {
    if (refresh) this.cached = undefined
    if (this.cached) return this.cached
    if (!this.pending) this.pending = this.mint().finally(() => { this.pending = undefined })
    return this.pending
  }
  async mint() {
    const launch = new URL(readFileSync(this.launchFile, 'utf8').trim())
    const value = launch.searchParams.get('token')
    if (!value) throw new Error('DSH launch credential unavailable')
    // Never follow the launch URL's host or a redirect, even if the volume is tampered with.
    const query = new URLSearchParams({ token: value })
    const response = await this.request(`/?${query}`)
    const cookies = response.headers['set-cookie']
    if (response.statusCode !== 303 || !cookies?.length) throw new Error('DSH exchange refused')
    this.cached = cookies.map(c => c.split(';', 1)[0]).join('; ')
    return this.cached
  }
}

// Use an allowlist: hop-by-hop nominations cannot remove the credential or principal, and
// browser cookies, bearer tokens and forwarding/identity assertions never cross this hop.
const REQUEST_HEADERS = ['accept', 'accept-encoding', 'accept-language', 'content-type', 'content-length', 'if-none-match', 'if-modified-since', 'range', 'if-range', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']
export function upstreamHeaders(req, credentials, cookie, principal, upgrade = false) {
  const headers = {}
  for (const name of REQUEST_HEADERS) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  headers.host = credentials.authority
  headers.origin = `http://${credentials.authority}`
  headers.cookie = cookie
  headers['x-automagik-principal'] = Buffer.from(JSON.stringify(principal)).toString('base64url')
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket' }
  return headers
}
export function responseHeaders(headers) {
  const excluded = new Set(['set-cookie', 'connection', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade', ...(headers.connection ?? '').toLowerCase().split(',').map(v => v.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)))
}

// The sole non-browser route. Its plugin authenticates the bearer on every call.
// No browser cookie, principal, forwarding assertion or general /api path crosses here.
export function agentMcpHeaders(req, credentials, cookie) {
  const headers = { host: credentials.authority, cookie }
  for (const name of ['authorization', 'accept', 'content-type', 'content-length',
    'mcp-protocol-version', 'mcp-session-id', 'origin']) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name]
  }
  return headers
}
