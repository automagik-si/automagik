import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { credentialFields, credentialParts } from './credential-fields.js'
import { CONNECTOR_KEY, publishConnectorKey, readConnectorKey } from './credential-key.js'

export const ENCRYPTED_STATE_VERSION = 3
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isEnvelope = value => record(value) && Object.hasOwn(value, 'enc')
const isLiteral = value => record(value) && Object.hasOwn(value, 'literal')
const address = ({ id, kind, name }) => JSON.stringify([id, kind, name])
const aad = (field, parts) => Buffer.from(JSON.stringify(['v1', field.id, field.kind, field.name, parts]))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function fromBase64(value, length) {
  if (typeof value !== 'string') throw new Error()
  const bytes = Buffer.from(value, 'base64')
  if ((length !== undefined && bytes.length !== length) || bytes.toString('base64') !== value) throw new Error()
  return bytes
}

function decrypt(field, envelope, key) {
  try {
    const { enc, kid, iv, data, tag, parts } = envelope
    if (enc !== 'v1' || key.kid === undefined || kid !== key.kid || Object.keys(envelope).length !== 6
      || !Array.isArray(parts) || !parts.includes(null) || !parts.every(part => part === null || typeof part === 'string')) return undefined
    const cipher = createDecipheriv('aes-256-gcm', key.bytes, fromBase64(iv, 12), { authTagLength: 16 })
    cipher.setAAD(aad(field, parts))
    cipher.setAuthTag(fromBase64(tag, 16))
    const literals = JSON.parse(Buffer.concat([cipher.update(fromBase64(data)), cipher.final()]).toString())
    if (!Array.isArray(literals) || literals.length !== parts.filter(part => part === null).length
      || !literals.every(literal => typeof literal === 'string')) return undefined
    let index = 0
    return parts.map(part => part === null ? literals[index++] : part).join('')
  } catch {
    return undefined
  }
}

function encrypt(field, parts, key) {
  if (key?.bytes === undefined) return undefined
  try {
    const layout = parts.map(part => part.reference ? part.text : null)
    const literals = parts.filter(part => !part.reference).map(part => part.text)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key.bytes, iv, { authTagLength: 16 })
    cipher.setAAD(aad(field, layout))
    const data = Buffer.concat([cipher.update(JSON.stringify(literals)), cipher.final()])
    return { enc: 'v1', kid: key.kid, iv: iv.toString('base64'), data: data.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), parts: layout }
  } catch {
    return undefined
  }
}

function copyConnectorFields(state) {
  const copy = { ...state }
  if (state.connectors === null || typeof state.connectors !== 'object') return copy
  copy.connectors = Array.isArray(state.connectors) ? [...state.connectors] : { ...state.connectors }
  for (const [id, row] of Object.entries(state.connectors)) {
    if (row?.custom === null || typeof row?.custom !== 'object') continue
    const custom = { ...row.custom }
    for (const kind of ['headers', 'env']) {
      if (record(custom[kind])) custom[kind] = { ...custom[kind] }
      else if (Array.isArray(custom[kind])) custom[kind] = [...custom[kind]]
    }
    copy.connectors[id] = { ...row, custom }
  }
  return copy
}

export function checkImportedCredentials(bytes, key) {
  let parsed
  try { parsed = JSON.parse(bytes) } catch { return }
  if (parsed?.version !== ENCRYPTED_STATE_VERSION) return
  for (const field of credentialFields(parsed.connectors)) {
    if (isEnvelope(field.value) && decrypt(field, field.value, key) === undefined) {
      throw new Error('The imported Bot team needs a matching connector key.')
    }
  }
}

export function connectorState(home, holdsLock) {
  const path = join(home, CONNECTOR_KEY)
  let committed = new Map()
  const unavailable = new WeakSet()

  const decode = (parsed) => {
    committed = new Map()
    let key
    for (const field of credentialFields(parsed?.connectors)) {
      const { fields, name, value } = field
      if (parsed.version === ENCRYPTED_STATE_VERSION && isEnvelope(value)) {
        key ??= readConnectorKey(path)
        const clear = decrypt(field, value, key)
        committed.set(address(field), { value, envelope: true, hash: clear === undefined ? undefined : hash(clear) })
        if (clear === undefined) unavailable.add(value)
        else fields[name] = clear
      } else {
        if (parsed.version === ENCRYPTED_STATE_VERSION && isLiteral(value)) fields[name] = value.literal
        committed.set(address(field), { value: fields[name] })
      }
    }
  }

  const retry = (connectors) => {
    let key
    for (const field of credentialFields(connectors)) {
      if (!unavailable.has(field.value)) continue
      key ??= readConnectorKey(path)
      const clear = decrypt(field, field.value, key)
      if (clear === undefined) continue
      const saved = committed.get(address(field))
      if (saved?.value === field.value) saved.hash = hash(clear)
      field.fields[field.name] = clear
    }
  }

  const clone = (state) => {
    const copy = JSON.parse(JSON.stringify(state))
    for (const { id, kind, name, value } of credentialFields(state.connectors)) {
      if (unavailable.has(value)) copy.connectors[id].custom[kind][name] = value
    }
    return copy
  }

  const encode = (state, { initializeKey = true } = {}) => {
    const copy = copyConnectorFields(state)
    const snapshot = new Map()
    let key
    let usedKey = false
    let refused = false
    let encrypted = false
    let pending = false
    const keyIds = new Set([...committed.values()].filter(entry => entry.envelope).map(entry => entry.value.kid))
    const loadKeyForWrite = () => {
      if (key !== undefined) return
      key = readConnectorKey(path)
      if (key.missing && initializeKey && holdsLock() && keyIds.size === 0) {
        try { publishConnectorKey(path) } catch (error) {
          if (error?.code !== 'EEXIST') return
        }
        key = readConnectorKey(path)
      }
    }
    for (const field of credentialFields(copy.connectors)) {
      const { fields, kind, name, value } = field
      const slot = address(field)
      let entry = { value }
      if (unavailable.has(value)) {
        entry = { value, envelope: true }
      } else {
        const parts = credentialParts(kind, name, value)
        if (parts.some(part => part.forms !== undefined)) {
          const digest = hash(value)
          const saved = committed.get(slot)
          loadKeyForWrite()
          const matchesTeamKey = keyIds.size === 0 || (keyIds.size === 1 && keyIds.has(key.kid))
          const envelope = matchesTeamKey ? encrypt(field, parts, key) : undefined
          if (envelope !== undefined) {
            usedKey = true
            entry = { value: envelope, envelope: true, hash: digest }
          } else if (saved?.hash === digest) {
            entry = saved
          } else if (!saved?.envelope && saved?.value === value) {
            pending = true
            entry = saved
          } else {
            refused = true
            entry = saved
          }
        }
      }
      if (entry === undefined) delete fields[name]
      else {
        snapshot.set(slot, entry)
        fields[name] = entry.value
        encrypted ||= entry.envelope === true
      }
    }
    if (encrypted) {
      copy.version = ENCRYPTED_STATE_VERSION
      for (const field of credentialFields(copy.connectors)) {
        if (!snapshot.get(address(field))?.envelope && (isEnvelope(field.value) || isLiteral(field.value))) {
          field.fields[field.name] = { literal: field.value }
        }
      }
    }
    return { bytes: JSON.stringify(copy), encrypted, refused, pending,
      keyIsCurrent: () => !usedKey || readConnectorKey(path).identity === key.identity,
      commit: () => { committed = snapshot } }
  }

  return { clone, decode, encode, retry, hasUnavailable: custom => {
    return Object.values(custom?.headers ?? {}).some(value => unavailable.has(value))
      || Object.values(custom?.env ?? {}).some(value => unavailable.has(value))
  } }
}
