import { createHash } from 'node:crypto'

export const provider = 'hashicorp-vault'
export const fail = code => ({ ok: false, code })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const segments = value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
export const validMount = value => typeof value === 'string'
  && /^[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,127}$/.test(value) && !/[^A-Za-z0-9_./-]/.test(value) && segments(value)
export const validPath = value => typeof value === 'string' && value.length <= 400
  && value.isWellFormed() && !value.startsWith('-') && !value.includes('\0') && segments(value)
export const validField = value => typeof value === 'string' && value.length >= 1 && value.length <= 128 && !value.includes('\0')
export const validItem = (mount, path) => validMount(mount) && validPath(path) && JSON.stringify([mount, path]).length <= 512

export function itemParts(item) {
  if (typeof item !== 'string' || item.length > 512) return
  try {
    const parts = JSON.parse(item)
    if (Array.isArray(parts) && parts.length === 2 && validItem(...parts) && JSON.stringify(parts) === item) return parts
  } catch {}
}

const hasControl = text => [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)

// Vault's namespace.Canonicalize, applied by the CLI to VAULT_NAMESPACE after
// trimming the flag: no leading '/', always a trailing '/'.
export function canonicalNamespace(namespace) {
  let value = namespace.trim()
  if (value === '') return ''
  if (value.startsWith('/')) value = value.slice(1)
  return value.endsWith('/') ? value : value + '/'
}

export function endpointOf(address, namespace = '') {
  if (typeof address !== 'string' || typeof namespace !== 'string' || hasControl(namespace)) return
  namespace = canonicalNamespace(namespace)
  const input = address.trim()
  const authority = /^https?:\/\/([^/\\?#]+)(?:\/|$)/i.exec(input)?.[1]
  if (authority === undefined || authority.includes('@') || /[\s\\?#]/.test(input) || hasControl(input)) return
  try {
    const url = new URL(input)
    if (url.protocol === 'http:' && !/^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i.test(authority)) return
    // The CLI joins the decoded base path with each API path using Go's path.Join.
    const parts = []
    for (const part of decodeURIComponent(url.pathname).split('/')) {
      if (part === '..') parts.pop()
      else if (part !== '' && part !== '.') parts.push(encodeURIComponent(part))
    }
    const canonical = url.origin + (parts.length === 0 ? '' : '/' + parts.join('/'))
    const label = createHash('sha256').update(JSON.stringify({ v: 1, address: canonical, namespace })).digest('hex').slice(0, 32)
    return { address: canonical, namespace, connection: 'hv:' + label }
  } catch {}
}

export const validToken = token => typeof token === 'string' && token !== '' && !/\s/.test(token) && !hasControl(token)
export const supportedVersion = text => /^Vault v2\.[012]\.(?:0|[1-9]\d*)(?: |,|\r?\n?$)/.test(text)

export function classify(result, verb, path) {
  if (result.failure !== undefined) return result.failure === 'unavailable' ? 'unavailable' : 'refused'
  if (result.code !== 2 || result.stdout !== '') return 'refused'
  const stderr = result.stderr.replace(/\r\n/g, '\n').replace(/\n+$/, '')
  if (stderr === 'No value found at ' + path) return 'missing'
  const prefix = (verb === 'list' ? 'Error listing ' : 'Error reading ') + path + ': '
  if (!stderr.startsWith(prefix)) return 'refused'
  const diagnostic = stderr.slice(prefix.length)
  const api = /^Error making API request\.\n\n(?:Namespace: [^\n]*\n)?URL: [A-Z]+ [^\n]+\nCode: (\d{3})\. (Errors|Raw Message):\n\n([\s\S]*)$/.exec(diagnostic + (diagnostic.endsWith(':') ? '\n\n' : ''))
  if (api === null) {
    return /^(?:Get|List) "[^\n]*": /.test(diagnostic) && !/^Code:/m.test(diagnostic) ? 'unavailable' : 'refused'
  }
  const [, code, format, body] = api
  if (code === '404') return 'revoked'
  if (code !== '403' || format !== 'Errors' || !body.startsWith('* ')) return 'refused'
  const messages = body.slice(2).split(/\n?\* /)
  if (messages.some(message => /^(?:invalid token|token (?:is )?expired)$/i.test(message))) return 'auth'
  return messages.includes('permission denied') ? 'denied' : 'refused'
}

export function json(result, verb, path) {
  if (result.failure !== undefined || result.code !== 0 || result.stderr !== '') return fail(classify(result, verb, path))
  try { return { ok: true, data: JSON.parse(result.stdout) } }
  catch { return fail('refused') }
}

export function mountVersion(envelope, mount) {
  const data = envelope?.data
  if (!record(data) || !['kv', 'generic'].includes(data.type) || data.path !== mount + '/') return
  if (data.options != null && !record(data.options)) return
  const version = data.options?.version
  if (version === '1' || (version === undefined && data.type === 'generic')) return '1'
  if (version === '2') return '2'
}

export function fieldMap(envelope, version) {
  const data = envelope?.data
  if (!record(data)) return fail('refused')
  if (version === '1') return { ok: true, data }
  if (record(data.data)) return { ok: true, data: data.data }
  if (data.data === null && record(data.metadata)
    && (data.metadata.destroyed === true || (typeof data.metadata.deletion_time === 'string' && data.metadata.deletion_time !== ''))) {
    return fail('revoked')
  }
  return fail('refused')
}
