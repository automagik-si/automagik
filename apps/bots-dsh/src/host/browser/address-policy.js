// The Bot browser and web_fetch share one per-profile address policy. The lists are empty
// by default, so localhost, LAN and tailnet addresses open as they always did. A deny entry
// always wins; when the allow list is not empty, only a matching target opens.
//
// An entry is an IPv4/IPv6 literal, an IPv4/IPv6 CIDR range, or a hostname. A hostname
// covers itself and its subdomains; a leading "*." is accepted and means the same. "*"
// alone matches every host. Entries are matched against the URL host and every address a
// hostname resolves to, so a public name that resolves into a denied range is denied.
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import ipaddr from 'ipaddr.js'

export const MAX_ADDRESS_ENTRIES = 100
export const MAX_ADDRESS_ENTRY_LENGTH = 253
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ALLOWED = Object.freeze({ allowed: true })

const stripBrackets = value => {
  const text = String(value ?? '').trim()
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
}

const ipv4Of = address => address.kind() === 'ipv6' && address.isIPv4MappedAddress()
  ? address.toIPv4Address()
  : address

const SCHEME_REFUSAL = 'Only web addresses open in the Bot browser.'
const OWN_SERVER_REFUSAL = "This address is Automagik's own server; the Bot browser never opens it."
const WEB_PROTOCOLS = new Map([
  ['http:', 'http:'], ['https:', 'https:'], ['ws:', 'http:'], ['wss:', 'https:'],
])

export function schemeRefusal(url, kind) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return SCHEME_REFUSAL
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return undefined
  const document = parsed.href.split('#', 1)[0]
  if (document === 'about:blank') return undefined
  if (kind === 'request' && (document === 'about:srcdoc'
    || ['ws:', 'wss:', 'data:', 'blob:'].includes(parsed.protocol))) return undefined
  return SCHEME_REFUSAL
}

const normalizedHost = host => stripBrackets(host).replace(/\.$/, '').toLowerCase()

function literalOf(host) {
  const value = normalizedHost(host)
  if (value.includes('%') || isIP(value) === 0) return undefined
  return ipv4Of(ipaddr.parse(value))
}

function isLoopbackAlias(address) {
  return address.range() === 'loopback' || ['0.0.0.0', '::'].includes(address.toString())
}

function effectivePort(url) {
  const protocol = WEB_PROTOCOLS.get(url.protocol)
  return protocol === undefined ? undefined : Number(url.port || (protocol === 'https:' ? 443 : 80))
}

const originHost = url => literalOf(url.hostname)?.toString() ?? normalizedHost(url.hostname)
const pathOf = url => url.pathname.replace(/%2f|%5c/gi, '/')

export function ownServerRefusal(url, { listener, advertised } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const port = effectivePort(parsed)
  if (port === undefined) return undefined
  if (listener?.port === port) {
    const bound = literalOf(listener.host)
    const target = literalOf(parsed.hostname)
    if (!bound || !target || bound.toString() === target.toString()
      || (bound.range() === 'loopback' && isLoopbackAlias(target))) {
      return OWN_SERVER_REFUSAL
    }
  }
  if (advertised && WEB_PROTOCOLS.get(parsed.protocol) === WEB_PROTOCOLS.get(advertised.protocol)
    && port === effectivePort(advertised) && originHost(parsed) === originHost(advertised)) {
    const mount = pathOf(advertised).replace(/\/$/, '')
    const path = pathOf(parsed)
    if (path === mount || path.startsWith(`${mount}/`)) return OWN_SERVER_REFUSAL
  }
  return undefined
}

export function localRefusal(url, kind, own) {
  const message = schemeRefusal(url, kind) ?? ownServerRefusal(url, own)
  return message === undefined ? undefined : { code: 'ADDRESS_REFUSED', message }
}

function ipEntry(text) {
  const value = stripBrackets(text)
  if (value === '') return undefined
  try {
    if (value.includes('/')) {
      const [address, bits] = ipaddr.parseCIDR(value)
      const mapped = ipv4Of(address)
      const width = mapped === address ? bits : bits - 96
      if (width < 0) return undefined
      return { kind: 'ip', text: `${mapped.toString()}/${width}`, address: mapped, bits: width }
    }
    const mapped = ipv4Of(ipaddr.parse(value))
    return { kind: 'ip', text: mapped.toString(), address: mapped, bits: undefined }
  } catch {
    return undefined
  }
}

function hostEntry(text) {
  const lower = text.toLowerCase()
  if (lower === '*') return { kind: 'any', text: '*' }
  const base = (lower.startsWith('*.') ? lower.slice(2) : lower).replace(/\.$/, '')
  if (base === '' || /[\s/:@?#[\]\\]/.test(base)) return undefined
  const ascii = domainToASCII(base)
  if (ascii === '' || ascii.length > MAX_ADDRESS_ENTRY_LENGTH) return undefined
  if (!ascii.split('.').every(label => HOST_LABEL.test(label))) return undefined
  return { kind: 'host', text: lower.startsWith('*.') ? `*.${ascii}` : ascii, host: ascii }
}

/** One entry as the matcher sees it; throws a person-readable message when it is not valid. */
export function parseAddressEntry(value) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error('An address-list entry cannot be empty')
  if (text.length > MAX_ADDRESS_ENTRY_LENGTH) {
    throw new Error(`An address-list entry is longer than ${MAX_ADDRESS_ENTRY_LENGTH} characters`)
  }
  const entry = ipEntry(text) ?? hostEntry(text)
  if (entry === undefined) {
    throw new Error(`"${text.slice(0, 80)}" is not an IPv4/IPv6 address, CIDR range or hostname`)
  }
  return entry
}

/**
 * Clean and validate one list. Returns canonical entry text; an empty list stays empty.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string[]}
 */
export function normalizeAddressList(value, label = 'Address list') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of entries`)
  if (value.length > MAX_ADDRESS_ENTRIES) {
    throw new Error(`${label} has more than ${MAX_ADDRESS_ENTRIES} entries`)
  }
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} entries must be text`)
    if (item.trim() === '') continue
    const entry = parseAddressEntry(item)
    if (seen.has(entry.text)) continue
    seen.add(entry.text)
    out.push(entry.text)
  }
  return out
}

function entriesOf(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    try {
      out.push(parseAddressEntry(item))
    } catch {
      // A list stored by an older or hand-edited file stays best-effort: a bad entry
      // cannot take the browser down. The settings page refuses bad entries.
    }
  }
  return out
}

const hasAddressEntry = entries => entries.some(entry => entry.kind === 'ip')

function matchesHost(host, entry) {
  if (entry.kind === 'any') return true
  if (entry.kind !== 'host') return false
  return host === entry.host || host.endsWith(`.${entry.host}`)
}

function matchesAddress(address, entry) {
  if (entry.kind !== 'ip') return false
  try {
    const parsed = ipv4Of(ipaddr.parse(stripBrackets(address)))
    if (parsed.kind() !== entry.address.kind()) return false
    if (entry.bits === undefined) return parsed.toString() === entry.address.toString()
    return parsed.match(entry.address, entry.bits)
  } catch {
    return false
  }
}

function matching(entries, host, addresses) {
  for (const entry of entries) {
    if (matchesHost(host, entry)) return { entry, via: host }
    for (const address of addresses) {
      if (matchesAddress(address, entry)) return { entry, via: address }
    }
  }
}

async function addressesOf(host, resolve) {
  try {
    const found = await resolve(host, { all: true, order: 'verbatim' })
    if (!Array.isArray(found)) return []
    return found.map(item => String(item?.address ?? '')).filter(Boolean)
  } catch {
    return []
  }
}

function refusal(action, host, match, allowMiss) {
  const verb = action === 'fetch' ? 'fetch' : 'open'
  if (allowMiss) {
    return `This address is not on this profile's allow list: ${host}. A Bot cannot ${verb} it. `
      + 'Ask the person to add it in Settings -> Browser -> Address lists, or leave the '
      + 'allow list empty.'
  }
  const where = match.via === host ? host : `${host} (${match.via})`
  return `This address is denied by this profile's address list: ${where} matches `
    + `"${match.entry.text}". A Bot cannot ${verb} it. Ask the person to change `
    + 'Settings -> Browser -> Address lists.'
}

/**
 * Decide one navigation or fetch against the profile's lists.
 * @param {string} url
 * @param {{
 *   allow?: string[],
 *   deny?: string[],
 *   lookup?: Function,
 *   action?: 'open'|'fetch',
 * }} [options]
 * @returns {Promise<{ allowed: boolean, message?: string }>}
 */
export async function decideAddress(url, options = {}) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return ALLOWED
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ALLOWED
  const host = stripBrackets(parsed.hostname).replace(/\.$/, '').toLowerCase()
  if (host === '') return ALLOWED
  const allow = entriesOf(options.allow)
  const deny = entriesOf(options.deny)
  if (allow.length === 0 && deny.length === 0) return ALLOWED
  const literal = isIP(host) !== 0
  const resolve = options.lookup ?? dnsLookup
  const addresses = literal
    ? [host]
    : hasAddressEntry(allow) || hasAddressEntry(deny) ? await addressesOf(host, resolve) : []
  const action = options.action === 'fetch' ? 'fetch' : 'open'
  const denied = matching(deny, host, addresses)
  if (denied !== undefined) {
    return { allowed: false, message: refusal(action, host, denied, false) }
  }
  if (allow.length > 0 && matching(allow, host, addresses) === undefined) {
    return { allowed: false, message: refusal(action, host, undefined, true) }
  }
  return ALLOWED
}
