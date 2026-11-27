import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { ipv4Of, normalizedHost, stripBrackets } from './browser/address-policy.js'
import { refusal } from './refusal.js'

export const ADDRESS_POLICY = Object.freeze({
  version: 1,
  excluded: Object.freeze([
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
    '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24',
    '192.168.0.0/16', '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
    '224.0.0.0/4', '240.0.0.0/4', '168.63.129.16/32',
  ]),
})
const excluded = ADDRESS_POLICY.excluded.map(range => ipaddr.parseCIDR(range))
const local = ['localhost', 'local', 'internal', 'home.arpa', 'lan', 'metadata.goog', 'instance-data']
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function addressRefusal(reason) {
  const message = reason === 'link-local'
    ? 'This link points to this computer, a local network or a cloud metadata address. Only public addresses are fetched.'
    : 'Use a link with a host name that has an IPv4 address. Numeric addresses and IPv6-only hosts are not accepted yet.'
  return refusal(message, { code: 'bot/invalid', reason })
}

export function skillLinkHost(hostname) {
  const host = normalizedHost(hostname)
  if (isIP(host)) throw addressRefusal('link-address')
  if (!host.includes('.') || local.some(suffix => host === suffix || host.endsWith('.' + suffix))) {
    throw addressRefusal('link-local')
  }
  if (host.length > 253 || !host.split('.').every(part => label.test(part))) throw addressRefusal('link-address')
  return host
}

function ipv4(text) {
  const address = stripBrackets(text)
  if (!isIP(address) || address.includes('%')) return undefined
  const parsed = ipv4Of(ipaddr.parse(address))
  return parsed.kind() === 'ipv4' ? parsed : undefined
}

export function isPublicDestination(text, { ownAddresses = [] } = {}) {
  const address = ipv4(text)
  return !!address && address.range() === 'unicast' && !excluded.some(range => address.match(range))
    && !ownAddresses.some(own => ipv4(own)?.toString() === address.toString())
}

export const canonicalPeer = address => ipv4(address)?.toString()
