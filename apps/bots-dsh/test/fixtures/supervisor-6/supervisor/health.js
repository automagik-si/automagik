import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'
import { localListener, webOption } from './child.js'
import { liveTeamLineage } from './rollback.js'

const WINDOW_MS = 60_000
const DOCUMENT_LIMIT = 2 * 1024 * 1024
const SCRIPT_LIMIT = 64 * 1024 * 1024
const UNAUTHORIZED = 'dsh web authentication required; reopen the URL printed by dsh web.\n'

export function healthListener(args) {
  return webOption(args, '--tls-cert') === undefined ? localListener(args) : null
}

const loopback = hostname => hostname === 'localhost' ? '127.0.0.1' : hostname

export function listenerOf(child, args) {
  if (!child?.launchUrl || child.result || !healthListener(args)) return null
  const announced = URL.parse(child.launchUrl)
  const listener = URL.parse(child.listener?.(child.launchUrl))
  if (!announced || listener?.protocol !== 'http:') return null
  const isPublic = webOption(args, '--public-url') !== undefined
  if (!isPublic && (announced.protocol !== listener.protocol || announced.port !== listener.port
    || loopback(announced.hostname) !== loopback(listener.hostname))) return null
  // A wildcard is a bind address. Use its loopback address as the connection target.
  if (listener.hostname === '0.0.0.0') listener.hostname = '127.0.0.1'
  if (listener.hostname === '[::]') listener.hostname = '[::1]'
  const host = loopback(listener.hostname)
  if (host !== '[::1]' && !host.startsWith('127.') && !Object.values(networkInterfaces()).flat().some(iface => {
    const authority = iface.family === 'IPv6' ? '[' + iface.address + ']' : iface.address
    return URL.parse('http://' + authority)?.hostname === host
  })) return null
  return { listener, isPublic }
}

export function localRequest(url, { signal, cookie, payload, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const headers = { host: url.host }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }
    const req = request(url, {
      hostname: loopback(url.hostname).replace(/^\[|\]$/g, ''), agent: false,
      method: body === undefined ? 'GET' : 'POST', headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)].filter(Boolean)),
    }, async res => {
      try {
        const chunks = []
        let size = 0
        for await (const part of res) {
          size += part.length
          if (size > (stream ? SCRIPT_LIMIT : DOCUMENT_LIMIT)) throw new Error('Health response exceeded its limit')
          if (!stream) chunks.push(part)
        }
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), size })
      } catch {
        res.destroy()
        reject(new Error('Health response interrupted'))
      }
    })
    req.on('error', () => reject(new Error('Health request failed')))
    req.end(body)
  })
}

export async function verifyListener(child, args, { signal, probe = localRequest } = {}) {
  const found = listenerOf(child, args)
  if (!found || signal?.aborted) return null
  if (!found.isPublic) return { ...found, status: 'verified' }
  try {
    const reply = await probe(found.listener, { signal })
    if (reply.status === 401 && reply.body === UNAUTHORIZED
      && reply.headers['cache-control'] === 'no-store' && reply.headers['content-type'] === 'text/plain; charset=utf-8') {
      return { ...found, status: 'verified-argv' }
    }
  } catch {}
  return null
}

function valueOf(reply) {
  if (reply.status !== 200) return null
  try {
    const json = JSON.parse(reply.body)
    return json?.ok === true ? json.value : null
  } catch {
    return null
  }
}

function cookieOf(reply) {
  if (reply.status !== 303) return ''
  return (reply.headers['set-cookie'] ?? []).map(row => row.split(';', 1)[0])
    .filter(row => /^[^=;\s]+=[^;\r\n]+$/.test(row)).join('; ')
}

function decodeHtml(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
    const name = entity.toLowerCase().slice(1, -1)
    const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    if (name.startsWith('#')) return code <= 0x10ffff ? String.fromCodePoint(code) : entity
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name]
  })
}

// Match the client manifest parser's wire checks and require the host's release stamp.
function validBootGraph(graph) {
  const string = value => typeof value === 'string'
  const strings = value => Array.isArray(value) && value.every(string)
  if (!string(graph?.rev) || !string(graph.release?.version)
    || (graph.release.commit !== undefined && !string(graph.release.commit))
    || !Array.isArray(graph.entries) || !Array.isArray(graph.batches)) return false

  const entries = new Set()
  for (const row of graph.entries) {
    if (!string(row?.id) || !string(row.url) || !string(row.rev) || entries.has(row.id)
      || (row.inject !== undefined && !strings(row.inject))
      || (row.external !== undefined && !strings(row.external))
      || (row.immediately !== undefined && typeof row.immediately !== 'boolean')) return false
    entries.add(row.id)
  }
  const urls = new Set()
  for (const batch of graph.batches) {
    if (!['bootstrap', 'application'].includes(batch?.phase)
      || !string(batch.url) || !string(batch.rev) || urls.has(batch.url)
      || !strings(batch.entries) || batch.entries.length === 0) return false
    urls.add(batch.url)
    for (const id of batch.entries) if (!entries.delete(id)) return false
  }
  return entries.size === 0
}

function scriptsOf(html, listener) {
  const scripts = new Set()
  const blocking = new Set()
  const preloads = new Set()
  let frontend = false
  let mount = false
  let loader = false
  let graph
  const urlOf = src => {
    const url = typeof src === 'string' && URL.parse(src, listener)
    if (url?.origin !== listener.origin || url.username || url.password) return null
    url.hash = ''
    return url
  }
  // DSH emits the boot graph as JSON in an inline script, followed by the frontend module.
  for (const [, scriptTag, scriptAttrs, body, element, elementAttrs] of html.matchAll(/<!--[\s\S]*?-->|<(?:style|textarea|title|template|noscript)\b[^>]*>[\s\S]*?<\/(?:style|textarea|title|template|noscript)\s*>|<(script)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>|<([a-z][\w-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
    if (!scriptTag && !element) continue
    const attrs = Object.fromEntries(Array.from((scriptAttrs ?? elementAttrs).matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g),
      ([, key, double, single, bare]) => [key.toLowerCase(), decodeHtml(double ?? single ?? bare ?? '')]))
    const script = scriptTag !== undefined
    const link = element?.toLowerCase() === 'link'
    const classic = !attrs.type || /^(?:application|text)\/(?:java|ecma)script$/i.test(attrs.type)
    if (script && !Object.hasOwn(attrs, 'src') && classic) {
      const boot = body.match(/^\s*(?:globalThis\["__DSH_BOOT__"\]|window\.__DSH_BOOT__)\s*=\s*([\s\S]+?)\s*;?\s*$/)
      if (boot) graph = JSON.parse(boot[1])
      loader ||= /\bwindow\.__ModuleLoader__\s*=\s*\{[\s\S]*?\bload\s*\([^)]*\)\s*\{[\s\S]*?\bcreate\s*\([^)]*\)\s*\{/.test(body)
    }
    if (!script && !link) {
      mount ||= attrs.id === 'root'
      continue
    }
    const src = script ? attrs.src
      : attrs.rel === 'modulepreload' || (attrs.rel === 'preload' && attrs.as === 'script') ? attrs.href : undefined
    if (!src) continue
    const url = urlOf(src)
    if (!url) return null
    if (!script) preloads.add(url.href)
    else if (attrs.type === 'module') frontend ||= /\/assets\/index-[^/]+\.js$/.test(url.pathname)
    else if (!Object.hasOwn(attrs, 'async') && !Object.hasOwn(attrs, 'defer')
      && classic) blocking.add(url.href)
    scripts.add(url.href)
  }
  if (!mount || !loader || !frontend || !validBootGraph(graph)) return null
  const bootstrap = graph.batches.filter(row => row.phase === 'bootstrap')
  if (!bootstrap.every(row => blocking.has(urlOf(row.url)?.href))
    || !bootstrap.some(row => row.entries.includes('@deepseek-ai/dsh-client-modules')
      && /[/?&,]@deepseek-ai\/dsh-client-modules\/client\.js(?:$|[?&,])/.test(decodeURIComponent(row.url)))) return null
  const bots = graph.batches.some(row => row.phase === 'application'
    && row.entries.includes('@automagik/bots-dsh') && preloads.has(urlOf(row.url)?.href)
    && /[/?&,]@automagik\/bots-dsh\/client\.js(?:$|[?&,])/.test(decodeURIComponent(row.url)))
  return bots ? scripts : null
}

function pluginsMatch(value, expect, runId) {
  if (!Array.isArray(value?.plugins) || value.hold?.state !== 'closed' || value.hold.run !== runId) return false
  return Object.entries(expect).every(([name, version]) => {
    const rows = value.plugins.filter(row => row?.name === name)
    return rows.length === 1 && rows[0].loaded === true && typeof rows[0].version === 'string'
      && (version === null || rows[0].version === version)
  })
}

export async function checkHealth(child, {
  args, expect, runId, signal, probe = localRequest, verifiedListener, since = Date.now(), team, legacy = false,
  windows = { first: WINDOW_MS, second: WINDOW_MS }, retryMs = 250,
}) {
  const exit = new AbortController()
  void child.exited?.then(() => exit.abort())
  const deadline = ms => AbortSignal.any([signal, exit.signal, AbortSignal.timeout(Math.max(0, ms))].filter(Boolean))
  const failed = (step, extra) => ({ ok: false, failed: child.result ? 'exited' : step, ...extra })
  const poll = async (window, check) => {
    while (!window.aborted && !child.result) {
      try {
        const result = await check(window)
        if (result && !window.aborted && !child.result) return result
      } catch {}
      await wait(retryMs, undefined, { signal: window }).catch(() => {})
    }
  }
  let step = 'port'
  let listener, cookie
  const signIn = async window => {
    const token = new URL(child.launchUrl).searchParams.get('token')
    if (!token) return ''
    const url = new URL(listener)
    url.searchParams.set('token', token)
    return cookieOf(await probe(url, { signal: window }))
  }
  const rpc = (endpoint, window) => probe(new URL('api/omni-ui', listener), {
    signal: window, cookie, payload: { endpoint, payload: legacy ? {} : { health: true } },
  })

  const first = since + windows.first - Date.now()
  if (first <= 0) return failed(step)
  const firstPassed = await poll(deadline(first), async window => {
    const verified = await (verifiedListener?.(window) ?? verifyListener(child, args, { signal: window, probe }))
    if (!verified) return
    listener = verified.listener
    if (!cookie) {
      cookie = await signIn(window)
      if (!cookie) {
        step = 'sign-in'
        return
      }
    }
    if (legacy) return true
    step = 'plugins'
    const reply = await rpc('self-update-status', window)
    if ([401, 403].includes(reply.status)) {
      cookie = ''
      step = 'sign-in'
    }
    return pluginsMatch(valueOf(reply), expect, runId)
  })
  if (!firstPassed) return failed(step)

  const checkTeam = () => {
    if (!team) return
    const lineage = liveTeamLineage(team)
    if (lineage !== 'descended') return failed('roster', lineage === 'lost' ? { teamMissing: true } : undefined)
  }
  step = 'roster'
  const result = await poll(deadline(windows.second), async window => {
    const before = checkTeam()
    if (before) return before
    if (!cookie) cookie = await signIn(window)
    if (!cookie) return
    if (step === 'roster') {
      const reply = await rpc(legacy ? 'list-bots' : 'state', window)
      if ([401, 403].includes(reply.status)) cookie = ''
      const value = valueOf(reply)
      if (team && value?.present === false) return failed('roster', { teamMissing: true })
      if (legacy ? !Array.isArray(value)
        : typeof value?.present !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0
          || !Number.isSafeInteger(value.bots) || value.bots < 0) return
      const after = checkTeam()
      if (after) return after
      step = 'page'
    }
    const page = await probe(listener, { signal: window, cookie })
    if ([401, 403].includes(page.status)) cookie = ''
    if (page.status !== 200 || !/^text\/html\b/i.test(page.headers['content-type'] ?? '')) return
    const scripts = scriptsOf(page.body, listener)
    if (!scripts) return
    for (const url of scripts) {
      const script = await probe(new URL(url), { signal: window, cookie, stream: true })
      if ([401, 403].includes(script.status)) cookie = ''
      if (script.status !== 200 || !/^(?:application|text)\/(?:x-)?(?:java|ecma)script\b/i.test(script.headers['content-type'] ?? '')
        || !(script.size > 0)) return
    }
    return checkTeam() ?? { ok: true }
  })
  return result ?? failed(step)
}
