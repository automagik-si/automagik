export const protonPass = 'proton-pass'
export const validConnection = connection => connection === undefined || connection === protonPass

// Keep in step with bots-dsh/src/host/vault-proton.js.
export function validToken(token) {
  if (typeof token !== 'string' || token.length !== 113) return false
  const key = /^pst_[!-9;-~]{64}::([A-Za-z0-9_-]{43})$/.exec(token)?.[1]
  if (key === undefined) return false
  const bytes = Buffer.from(key, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === key
}

const id = /^[A-Za-z0-9_-]{86}==$/
export const validId = value => typeof value === 'string' && value.length === 88 && id.test(value)

const fieldsByKind = new Map([
  ['Login', ['username', 'email', 'password']],
  ['CreditCard', ['cardholder_name', 'number', 'verification_number', 'expiration_date', 'pin']],
  ['Wifi', ['ssid', 'password']],
  ['SshKey', ['private_key']],
  ['Identity', []], ['Custom', []], ['Note', []], ['Alias', []],
])
const listKinds = new Map([['login', 'Login'], ['credit_card', 'CreditCard'], ['wifi', 'Wifi'], ['ssh_key', 'SshKey']])
const labels = {
  username: 'Username', email: 'Email', password: 'Password', note: 'Note', cardholder_name: 'Cardholder name',
  number: 'Card number', verification_number: 'Security code', expiration_date: 'Expiration date',
  pin: 'PIN', ssid: 'Wi-Fi name', private_key: 'Private key',
}
export const FIELDS = new Set(Object.keys(labels))
export const pickerFields = kind => [...(fieldsByKind.get(listKinds.get(kind)) ?? []), 'note']
  .map(id => ({ id, label: labels[id] }))

export const fail = code => ({ ok: false, code })
export const success = result => result.failure === undefined && result.code === 0 && result.stderr === ''

export function classify(result) {
  if (result.failure !== undefined) return result.failure === 'refused' ? 'refused' : 'unavailable'
  if (result.code === 0) return 'refused'
  const lines = result.stderr.split(/\r?\n/)
  if (lines.includes('Your session has been invalidated and you have been logged out automatically.')) return 'auth'
  // anyhow prints an Error line and may include an indented cause chain.
  if (!lines.some(line => line.startsWith('Error: '))) return 'refused'
  const causes = lines.flatMap(line => {
    const cause = /^(?:Error: |    (?:\d+: )?)(.+)$/.exec(line)?.[1]
    return cause === undefined ? [] : [cause]
  })
  if (causes.includes('Viewing the contents of this item is not allowed by policy')) return 'refused'
  if (causes.some(cause => cause === 'This personal access token is invalid, expired or has been deleted.'
    || cause === 'This operation requires an authenticated client' || /(?:^|: )session has been invalidated$/.test(cause))) return 'auth'
  if (causes.some(cause => /^Share with id [A-Za-z0-9_-]{86}== not found$/.test(cause))) return 'revoked'
  if (causes.some(cause => /^Error sending request(?:$|: )/.test(cause))) return 'unavailable'
  return 'refused'
}

export function json(result) {
  if (!success(result)) return fail(classify(result))
  try { return { ok: true, value: JSON.parse(result.stdout) } }
  catch { return fail('refused') }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function selectField(result, share, id, field) {
  const parsed = json(result)
  if (!parsed.ok) return parsed
  const item = parsed.value?.item
  if (item?.id !== id || item.share_id !== share) return fail('refused')
  if (item.state === 'Trashed') return fail('revoked')
  if (item.state !== 'Active') return fail('refused')
  const data = item.content
  if (typeof data?.title !== 'string' || typeof data.note !== 'string' || !object(data.content)) return fail('refused')
  const [kind, ...extra] = Object.keys(data.content)
  const fields = fieldsByKind.get(kind)
  const payload = data.content[kind]
  if (extra.length || fields === undefined || (kind === 'Note' || kind === 'Alias' ? payload !== null : !object(payload))) {
    return fail('refused')
  }
  const value = field === 'note' ? data.note : fields.includes(field) && Object.hasOwn(payload, field) ? payload[field] : undefined
  return typeof value === 'string' && value !== '' ? { ok: true, value } : fail('field')
}
