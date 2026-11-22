export const provider = 'macos-keychain'
export const connection = 'login-keychain'
export const loginKeychain = 'login.keychain-db'
// oxlint-disable-next-line eslint(no-control-regex) -- C0 and C1 are forbidden in an identity.
const forbiddenName = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u
export const validName = value => typeof value === 'string' && value.length >= 1 && value.length <= 128
  && value.isWellFormed() && !forbiddenName.test(value)

export function itemOf(path, service, account) {
  if (validName(service) && validName(account)) {
    const item = JSON.stringify([path, service, account])
    if (item.length <= 512) return item
  }
}

const printable = byte => byte >= 0x20 && byte <= 0x7e && byte !== 0x5c

// SecurityTool's print_buffer uses octal escapes in the quoted part and leaves quotes raw.
export function printBuffer(bytes) {
  const ascii = bytes.some(printable)
  const hex = bytes.some(byte => !printable(byte))
  if (!hex) return ascii ? '"' + bytes.toString('latin1') + '"' : ''
  const prefix = '0x' + bytes.toString('hex').toUpperCase() + (ascii ? '  ' : ' ')
  if (!ascii) return prefix
  let quoted = '"'
  for (const byte of bytes) {
    quoted += printable(byte) ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0')
  }
  return prefix + quoted + '"'
}

const fail = code => ({ ok: false, code })

export function parseLookup(result, path, read) {
  const { code, stdout, stderr, failure } = result
  if (failure !== undefined) return fail('refused')
  if (code === 44 && stdout === '' && /^security: SecKeychainSearchCopyNext: [^\r\n]+\n$/.test(stderr)) {
    return { ...fail('revoked'), audit: 'refused' }
  }
  if (code !== 0 || typeof stdout !== 'string' || typeof stderr !== 'string'
    || stdout.split('\n', 1)[0] !== 'keychain: ' + printBuffer(Buffer.from(path))) return fail('refused')
  if (!read) return stderr === '' ? { ok: true } : fail('refused')

  if (stderr === 'password: \n') return fail('field')
  const record = /^password: ([^\r\n]*)\n$/.exec(stderr)
  if (record === null) return fail('refused')
  const remainder = record[1]
  const hex = /^0x((?:[0-9A-F]{2})+)( |  "[\s\S]*")$/.exec(remainder)
  const ascii = /^"([\x20-\x7e]*)"$/.exec(remainder)
  let bytes
  if (hex !== null) bytes = Buffer.from(hex[1], 'hex')
  else if (ascii !== null) bytes = Buffer.from(ascii[1], 'latin1')
  else return fail('refused')
  if (stderr !== 'password: ' + printBuffer(bytes) + '\n') return fail('refused')
  try {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return value.includes('\0') ? fail('field') : { ok: true, value }
  } catch { return fail('field') }
}
