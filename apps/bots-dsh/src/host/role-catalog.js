import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isPackageRoleId, isRoleVersion } from '../shared/roles.js'
import { refusal } from './refusal.js'
import { boundedGet as get } from './bounded-get.js'

// Rotate in RFC 0011 order: update plugin-lane/keys.json and this copy before switching the signer.
export const ROLE_KEYS = Object.freeze(JSON.parse(readFileSync(new URL('./role-keys.json', import.meta.url), 'utf8')).keys.map(Object.freeze))
export const ROLE_CAPABILITIES = Object.freeze(['audio-out', 'task-start', 'route-policy', 'history-read'])
const REPOSITORY = 'https://github.com/automagik-si/automagik'
const RELEASES = `${REPOSITORY}/releases/download/`
const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
export const ROLE_PLUGIN_VERSION = PKG.version
const MAX_PACKAGE = 16 * 1024 * 1024
export const ROLE_EVIDENCE_LIMITS = [MAX_PACKAGE, 256 * 1024, 1024]
const UNCHECKED = Object.freeze({ available: false, roles: Object.freeze([]) })
const READ_ONLY = Object.freeze({ ...UNCHECKED, reason: 'read-only' })

export const plainObject = value => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype
export const isSha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
export const validCapabilities = value => Array.isArray(value) && value.every(capability => ROLE_CAPABILITIES.includes(capability))
  && new Set(value).size === value.length
export const roleName = value => typeof value === 'string' && value.length >= 1 && value.length <= 60
export const roleDescription = value => typeof value === 'string' && value.length <= 200
export const roleToolName = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
export const parseRoleJson = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

export const boundedGet = (fetch, url, options) => get(fetch, url, { ...options, errorOf: refusal })

function verifiedIndex(bytes, signature, keys, releaseVersion) {
  let index
  try { index = parseRoleJson(bytes) } catch { throw refusal('roles.json is not valid JSON.') }
  const key = keys.find(entry => entry.keyId === index?.keyId)
  if (!key) throw refusal('roles.json names an unknown signing key.')
  const encoded = signature.toString('utf8').trim()
  let verified = false
  if (/^[A-Za-z0-9+/]{86}==$/.test(encoded)) {
    try {
      const publicKey = createPublicKey(key.publicKey)
      verified = publicKey.asymmetricKeyType === 'ed25519' && verify(null, bytes, publicKey, Buffer.from(encoded, 'base64'))
    } catch {}
  }
  if (!verified) throw refusal('roles.json signature does not match.')
  if (!plainObject(index) || index.schemaVersion !== 1 || index.publisher !== 'automagik' || !isRoleVersion(index.version)
    || (releaseVersion !== undefined && index.version !== releaseVersion)
    || index.repository !== REPOSITORY || !Array.isArray(index.roles) || index.roles.length > 200) {
    throw refusal('roles.json does not match the running release or catalog schema.')
  }
  return index
}

function catalogEntries(raw, release, warn) {
  const counts = new Map()
  for (const entry of raw) {
    if (typeof entry?.id === 'string') counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }
  const entries = new Map()
  for (const [position, entry] of raw.entries()) {
    if (counts.get(entry?.id) > 1) {
      warn('roles.json: ignoring duplicate role at position %d.', position + 1)
      continue
    }
    if (!plainObject(entry) || !isPackageRoleId(entry.id) || !isRoleVersion(entry.version) || !roleName(entry.name)
      || !roleName(entry.publisher) || typeof entry.official !== 'boolean' || !isSha256(entry.sha256)
      || !Number.isInteger(entry.size) || entry.size < 1 || entry.size > MAX_PACKAGE || !validCapabilities(entry.capabilities)) {
      warn('roles.json: ignoring invalid role at position %d.', position + 1)
      continue
    }
    const { id, version, name, publisher, capabilities, sha256, size, official, description, tools } = entry
    const source = `${release}automagik-role-${id}-${version}.tgz`
    if (entry.source !== source) {
      warn('roles.json: ignoring invalid source at position %d.', position + 1)
      continue
    }
    const installable = official && publisher === 'automagik'
    const display = Object.freeze({ id, version, name, publisher, capabilities: Object.freeze(capabilities),
      installable, ...(installable ? {} : { reason: 'community' }) })
    const details = Object.freeze({
      version, sha256: sha256.toLowerCase(),
      ...(roleDescription(description) ? { description } : {}),
      ...(Array.isArray(tools) && tools.length <= 16 && tools.every(roleToolName) ? { tools: Object.freeze(tools) } : {}),
    })
    entries.set(id, { display, details, sha256: details.sha256, size, source })
  }
  return entries
}

export function createRoleCatalog({ fetch = globalThis.fetch, keys = ROLE_KEYS, base = RELEASES, now = Date.now, canFetch, warn }) {
  const release = `${base}v${ROLE_PLUGIN_VERSION}/`
  let cached = { view: UNCHECKED }
  let expires = -Infinity
  let inFlight
  let sequence = 0
  const load = async () => {
    const signal = AbortSignal.timeout(15_000)
    try {
      const bytes = await boundedGet(fetch, `${release}roles.json`, { label: 'roles.json', limit: 256 * 1024, signal, missing: true })
      if (bytes === undefined) return { view: Object.freeze({ ...UNCHECKED, reason: 'none' }) }
      const signature = await boundedGet(fetch, `${release}roles.json.sig`, { label: 'roles.json.sig', limit: 1024, signal })
      const entries = catalogEntries(verifiedIndex(bytes, signature, keys, PKG.version).roles, release, warn)
      const roles = Object.freeze([...entries.values()].map(entry => entry.display))
      return { view: Object.freeze({ available: true, roles }), entries, bytes, signature }
    } catch (error) {
      const message = error?.code === 'bot/refused' ? error.message : 'Role catalog verification failed.'
      warn('%s', message)
      return { view: Object.freeze({ ...UNCHECKED, reason: 'unverified' }), error: message }
    }
  }
  const readOnly = { view: READ_ONLY }
  const snapshot = async () => {
    if (!canFetch()) return readOnly
    if (now() < expires) return cached
    if (inFlight === undefined) {
      const request = ++sequence
      inFlight = load().then(result => {
        if (request === sequence) {
          cached = result
          expires = now() + (result.view.reason === 'unverified' ? 60_000 : 600_000)
        }
        return cached
      }).finally(() => {
        if (request === sequence) inFlight = undefined
      })
    }
    const result = await inFlight
    return canFetch() ? result : readOnly
  }
  return {
    view: () => canFetch() ? cached.view : READ_ONLY,
    entries: () => canFetch() ? cached.entries : undefined,
    retained: (bytes, signature, id) => {
      const index = verifiedIndex(bytes, signature, keys)
      return catalogEntries(index.roles, `${base}v${index.version}/`, warn).get(id)
    },
    snapshot,
    async download(entry) {
      try {
        return await boundedGet(fetch, entry.source, { limit: entry.size, signal: AbortSignal.timeout(60_000), label: 'Role package' })
      } catch (error) {
        if (error?.code === 'bot/refused') throw error
        throw refusal('Role package could not be downloaded.')
      }
    },
  }
}
