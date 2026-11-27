import dns from 'node:dns'
import { readFileSync } from 'node:fs'
import https from 'node:https'
import { isIP } from 'node:net'
import os from 'node:os'
import { addressRefusal, canonicalPeer, isPublicDestination, skillLinkHost } from './skill-address.js'
import { credentialShapes } from './redact.js'
import { refusal } from './refusal.js'

const { name, version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const rateBytes = 4096
const byteLimit = 5 * 1024 * 1024
const credentials = text => credentialShapes(text) !== text
const messages = {
  'link-scheme': 'Paste an https:// link.',
  'link-credentials': 'This link carries a user name, password or token. Use a public link without them.',
  'link-port': 'Only links on the standard https port are accepted.',
  'link-timeout': 'The link did not answer within 10 seconds.',
  'link-slow': 'Fetching the link took longer than 60 seconds.',
  'link-large': "The link's content is larger than 5 MiB.",
  'link-sign-in': 'Only public links work here; download the skill and use File or Folder.',
  'link-missing': 'Nothing public was found at this link. If it is private, download the skill and use File or Folder.',
  'link-http': "The link's server answered with an error (HTTP {status}). Try again later.",
  'link-unreachable': 'The link could not be reached.',
  'link-page': "This link opens a web page, not a skill. Copy the skill's text and use Text.",
  'link-kind': 'This link is not a SKILL.md, a .zip or a .tar.gz.',
  'link-query': 'Links with query parameters (after ?) are not accepted. Remove them, or download the skill and use File or Folder.',
  'link-redirect-host': "The link's redirect could not be followed.",
  'link-redirect-limit': 'The link redirects too many times.',
  'link-signed': 'The link sends to a signed or temporary download. Download the skill and use File or Folder.',
  'link-github-moved': 'This GitHub repository moved or was renamed. Paste its current link.',
  'link-rate': "GitHub's limit for public requests from this network is used up. Try again in about {minutes} minutes, or download the skill and use File or Folder.",
  'link-rate-later': "GitHub's limit for public requests from this network is used up. Try again later, or download the skill and use File or Folder.",
  'link-github-link': 'The GitHub folder holds a link, a submodule or an entry of an unknown type; skills hold regular files only.',
  'link-github-large': 'This GitHub link needs too many steps to read. Link a shallower folder, or download the skill and use File.',
  'link-github-mismatch': "GitHub's answer did not match the commit it names. Try again.",
  'link-github-path': 'This GitHub link names no file or folder. Link to a SKILL.md, a folder or a repository.',
  'link-ref': "This link's branch or tag cannot be resolved to one commit safely. Use GitHub's permanent link (with the commit SHA).",
}

export function refuseLink(reason, params) {
  const message = messages[reason].replace(/\{(\w+)\}/g, (_, key) => String(params[key]))
  throw refusal(message, { code: 'bot/invalid', reason })
}

export const htmlType = type => type === 'text/html' || type === 'application/xhtml+xml'
export function downloadArchiveKind(bytes) {
  const head = bytes.subarray(0, 4).toString('hex')
  if (head === '504b0304' || head === '504b0506') return 'zip'
  if (head.startsWith('1f8b')) return 'tar.gz'
}

export function linkCredentialCheck(url) {
  if (url.username || url.password || credentials(url.href)) refuseLink('link-credentials')
  for (const segment of [...url.pathname.split('/'), url.search]) {
    let decoded
    try { decoded = decodeURIComponent(segment) } catch { refuseLink('link-credentials') }
    if (credentials(decoded)) refuseLink('link-credentials')
  }
}

function withAbort(promise, signal, discard) {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(value => {
      if (signal.aborted) discard?.(value)
      else resolve(value)
    }, reject).finally(() => signal.removeEventListener('abort', cancel))
    if (signal.aborted) cancel()
  })
}

function pinnedLookup(host, addresses) {
  return (hostname, options, callback) => {
    if (hostname !== host) return callback(addressRefusal('link-address'))
    if (options.all) return callback(null, addresses.map(address => ({ address, family: 4 })))
    callback(null, addresses[0], 4)
  }
}

export function createHttpsOpen({ request = (...args) => https.request(...args) } = {}) {
  return (url, { host, addresses, headers, signal, interfaces }) => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const req = request(url, {
      method: 'GET', headers, signal, agent: false, family: 4, autoSelectFamily: false,
      servername: host, lookup: pinnedLookup(host, addresses), rejectUnauthorized: true,
    }, resolve)
    req.on('error', reject)
    req.on('socket', socket => {
      const verify = () => {
        const peer = canonicalPeer(socket.remoteAddress)
        const ownAddresses = Object.values(interfaces()).flat().filter(Boolean).map(entry => entry.address)
        if (socket.remoteFamily !== 'IPv4' || !addresses.includes(peer) ||
            !isPublicDestination(peer, { ownAddresses })) {
          req.destroy(addressRefusal('link-local'))
          socket.destroy()
        }
      }
      if (socket.remoteAddress) verify()
      else socket.prependOnceListener('connect', verify)
    })
    req.end()
  })
}

function mediaType(headers) {
  return String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
}

async function readBody(response, signal, limit, reason, budget, prefixOnly = false) {
  const chunks = []
  let size = 0
  const destroy = () => response.destroy()
  signal.throwIfAborted()
  signal.addEventListener('abort', destroy, { once: true })
  try {
    for await (const chunk of response) {
      signal.throwIfAborted()
      if (chunk.length > budget.remaining) refuseLink('link-large')
      budget.remaining -= chunk.length
      if (!prefixOnly && size + chunk.length > limit) refuseLink(reason)
      const kept = chunk.subarray(0, limit - size)
      chunks.push(kept)
      size += kept.length
      if (prefixOnly && size === limit) break
    }
    signal.throwIfAborted()
    return Buffer.concat(chunks, size)
  } finally { signal.removeEventListener('abort', destroy) }
}

async function checkStatus(response, github, signal, now, budget) {
  const status = response.statusCode
  if (status === 200) return
  if (github && (status === 403 || status === 429)) {
    const headers = response.headers
    if (headers['x-ratelimit-remaining'] === '0' || headers['retry-after'] !== undefined ||
        /rate limit/i.test((await readBody(response, signal, rateBytes, 'link-large', budget, true)).toString('utf8'))) {
      const reset = Number(headers['x-ratelimit-reset']) - now() / 1000
      const retry = Number(headers['retry-after'])
      const seconds = retry > 0 ? retry : reset
      if (Number.isFinite(seconds) && seconds > 0) refuseLink('link-rate', { minutes: Math.ceil(seconds / 60) })
      refuseLink('link-rate-later')
    }
  }
  if (status === 401 || status === 403) refuseLink('link-sign-in')
  if (status === 404 || status === 410) refuseLink('link-missing')
  if (!Number.isInteger(status) || status < 100 || status > 599) refuseLink('link-unreachable')
  refuseLink('link-http', { status })
}

function admit(url, api, raw) {
  if (url.protocol !== 'https:') refuseLink('link-scheme')
  linkCredentialCheck(url)
  if (url.port) refuseLink('link-port')
  if (url.search && !(api && url.search === '?recursive=1')) refuseLink('link-query')
  const host = skillLinkHost(url.hostname)
  if ((api && url.origin !== 'https://api.github.com') || (raw && url.origin !== 'https://raw.githubusercontent.com')) {
    refuseLink('link-github-mismatch')
  }
  url.hostname = host
  url.hash = ''
  return host
}

function redirect(response, from, redirects, github) {
  if (github) refuseLink('link-github-moved')
  if (redirects === 3) refuseLink('link-redirect-limit')
  const location = response.headers.location
  if (typeof location !== 'string' || !location.trim() || location.length > 2048) refuseLink('link-redirect-host')
  let url
  try { url = new URL(location, from) } catch { refuseLink('link-redirect-host') }
  try { linkCredentialCheck(url) } catch { refuseLink('link-signed') }
  if (url.search) refuseLink('link-signed')
  return url
}

const openHttps = createHttpsOpen()

export function skillLinkOperation({
  resolve = (...args) => dns.promises.lookup(...args), open = openHttps,
  interfaces = () => os.networkInterfaces(), now = Date.now, timeout = AbortSignal.timeout,
} = {}) {
  const cancel = new AbortController()
  const operation = AbortSignal.any([cancel.signal, timeout(60_000)])
  const budget = { remaining: byteLimit }

  async function addressesFor(host, signal) {
    let answers
    try { answers = await withAbort(resolve(host, { all: true, family: 4 }), signal) }
    catch (error) {
      if (error?.code !== 'ENOTFOUND' && error?.code !== 'ENODATA') throw error
    }
    if (!Array.isArray(answers) || !answers.length ||
        answers.some(row => row?.family !== 4 || typeof row.address !== 'string' || isIP(row.address) !== 4)) {
      throw addressRefusal('link-address')
    }
    if (answers.some(row => !isPublicDestination(row.address))) throw addressRefusal('link-local')
    return answers.map(row => canonicalPeer(row.address))
  }

  async function linkGet(input, { api = false, raw = false, limit = byteLimit, accept = '*/*' } = {}) {
    const deadline = timeout(10_000)
    const signal = AbortSignal.any([operation, deadline])
    const headers = {
      'user-agent': `${name}/${version}`, accept, 'accept-encoding': 'identity',
      ...(api ? { 'x-github-api-version': '2022-11-28' } : {}),
    }
    let url = new URL(input)
    try {
      for (let redirects = 0; ; redirects++) {
        const host = admit(url, api, raw)
        signal.throwIfAborted()
        const addresses = await addressesFor(host, signal)
        signal.throwIfAborted()
        const response = await withAbort(open(url, { host, addresses, headers, signal, interfaces }), signal, value => value.destroy())
        try {
          signal.throwIfAborted()
          const status = response.statusCode
          if (status >= 300 && status < 400) {
            url = redirect(response, url, redirects, api || raw)
            continue
          }
          await checkStatus(response, api || raw, signal, now, budget)
          const encoding = response.headers['content-encoding']
          if (encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') refuseLink('link-kind')
          const type = mediaType(response.headers)
          if (api && type !== 'application/json') refuseLink('link-github-mismatch')
          const reason = api ? 'link-github-large' : raw ? 'link-github-mismatch' : 'link-large'
          const length = Number(response.headers['content-length'])
          if (length > budget.remaining) refuseLink('link-large')
          if (length > limit) refuseLink(reason)
          const bytes = await readBody(response, signal, limit, reason, budget)
          return { bytes, type, headers: response.headers, host }
        } finally { response.destroy() }
      }
    } catch (error) {
      if (cancel.signal.aborted) throw cancel.signal.reason
      if (operation.aborted) refuseLink('link-slow')
      if (deadline.aborted) refuseLink('link-timeout')
      if (error?.code === 'bot/invalid') throw error
      refuseLink('link-unreachable')
    }
  }

  async function download(rows, read) {
    let next = 0
    const result = new Array(rows.length)
    const worker = async () => {
      while (!cancel.signal.aborted && next < rows.length) {
        const index = next++
        try { result[index] = await read(rows[index]) }
        catch (error) { if (!cancel.signal.aborted) cancel.abort(error) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker))
    cancel.signal.throwIfAborted()
    return result
  }
  const finish = () => { if (operation.aborted) refuseLink('link-slow') }
  return { linkGet, download, now, finish }
}
