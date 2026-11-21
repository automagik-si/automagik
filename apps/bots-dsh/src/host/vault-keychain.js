import { userInfo } from 'node:os'
import { posix } from 'node:path'

// Keep the durable format in step with vault-dsh. Loading mappings also works
// on hosts with a different passwd home or without the vault plugin.
export const keychain = 'macos-keychain'
export const keychainConnection = 'login-keychain'
export const keychainPlatform = 'macOS Keychain needs macOS.'
export const keychainCloud = 'macOS Keychain is unavailable in Automagik Cloud.'
export const keychainReason = code => code === 'platform' ? keychainPlatform : code === 'cloud' ? keychainCloud : undefined

const login = '/Library/Keychains/login.keychain-db'
// oxlint-disable-next-line eslint(no-control-regex) -- C0 and C1 are forbidden in an identity.
const forbiddenName = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u
const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 128
  && value.isWellFormed() && !forbiddenName.test(value)

export function keychainItem(item) {
  if (typeof item !== 'string' || item.length > 512) return
  try {
    const parts = JSON.parse(item)
    if (!Array.isArray(parts) || parts.length !== 3) return
    const [path, service, account] = parts
    if (typeof path === 'string' && path.isWellFormed() && !path.includes('\0') && path.startsWith('/') && path.endsWith(login)
      && validName(service) && validName(account) && JSON.stringify(parts) === item) return parts
  } catch {}
}

export function keychainLookup(service, account) {
  if (!validName(service) || !validName(account)) return
  try {
    const id = JSON.stringify([posix.join(userInfo().homedir, login), service, account])
    if (keychainItem(id) !== undefined) return id
  } catch {}
}

export function keychainItems(result, id, service, account) {
  if (result?.ok !== true || !Array.isArray(result.items)) return
  if (result.items.length === 0) return []
  const [row] = result.items
  if (result.items.length === 1 && row?.id === id && row.service === service && row.account === account
    && Array.isArray(row.fields) && row.fields.length === 1 && row.fields[0] === 'password') {
    return [{ id, service, account, fields: [{ selector: 'password', label: 'Password' }] }]
  }
}
