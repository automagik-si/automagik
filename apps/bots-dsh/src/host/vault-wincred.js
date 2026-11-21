// Keep the durable reference format in step with vault-dsh.
export const windowsCredential = 'windows-credential'
export const windowsConnection = 'current-user'
const reasons = new Map([
  ['platform', 'Windows Credential Manager needs Windows.'],
  ['cloud', 'Windows Credential Manager is unavailable in Automagik Cloud.'],
  ['arch', 'Windows Credential Manager needs 64-bit x64 Windows.'],
  ['root', 'This Windows is installed in a folder the credential reader does not trust.'],
  ['blocked', 'The Windows credential reader could not start here (for example Constrained Language Mode, AppLocker or antivirus).'],
])
export const windowsReason = code => reasons.get(code)
const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
export const windowsTarget = target => typeof target === 'string' && target.length >= 4 && target.length <= 256
  && target.isWellFormed() && !unsafe.test(target) && !target.includes('*')
  && !target.toUpperCase().startsWith('AUTOMAGIK-VAULT:')

// Include invariant lower- and upper-case matching as a conservative approximation of ordinal ignore-case.
export const mentionsWindowsTarget = (text, target) => text.toLowerCase().includes(target.toLowerCase())
  || text.toUpperCase().includes(target.toUpperCase())

export function windowsItems(result, target) {
  if (result?.ok !== true || !Array.isArray(result.items)) return
  if (result.items.length === 0) return []
  const [row] = result.items
  if (result.items.length !== 1 || row?.id !== target || row.target !== target
    || !Array.isArray(row.fields) || row.fields.length !== 1 || row.fields[0] !== 'password') return
  const { userName } = row
  const safe = typeof userName === 'string' && userName.length > 0 && userName.isWellFormed()
    && Buffer.byteLength(userName) <= 2560 && !unsafe.test(userName)
  return [{ id: target, target, userName: safe ? userName : null, fields: [{ selector: 'password', label: 'Password' }] }]
}
