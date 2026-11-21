export const provider = 'windows-credential'
export const connection = 'current-user'
export const maxResponse = 3424
export const maxBlob = 2560

export const validTarget = target => typeof target === 'string' && target.length >= 4 && target.length <= 256
  && target.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}*]/u.test(target)
  && !target.toUpperCase().startsWith('AUTOMAGIK-VAULT:')

export function requestOf(op, target = '') {
  if (op === 'probe' ? target !== '' : !['meta', 'read'].includes(op) || !validTarget(target)) return
  return Buffer.from(op + ' ' + Buffer.from(target).toString('base64') + '\n', 'ascii')
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const utf16 = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true })
const refused = { ok: false, code: 'refused' }
const field = { ok: false, code: 'field' }

export function parseResponse(op, result) {
  const { code, stdout, stderr, signal, failure } = result
  if (failure || signal || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stderr.length
    || stdout.length > maxResponse || stdout.some(byte => byte > 127)) return refused
  if (code !== 0) {
    if (stdout.length) return refused
    if (code === 10 && op !== 'probe') return { ok: false, code: 'revoked', audit: 'refused' }
    if (code === 14) return { ok: false, code: 'blocked' }
    return refused
  }
  if (op === 'probe') return stdout.length ? refused : { ok: true }
  const frame = stdout.toString('ascii')
  if (op === 'read' && frame === 'Z\n') return field
  const prefix = op === 'meta' ? 'M ' : 'V '
  if (!frame.startsWith(prefix) || !frame.endsWith('\n')) return refused
  const encoded = frame.slice(2, -1)
  const bytes = Buffer.from(encoded, 'base64')
  try {
    if (bytes.length > maxBlob || bytes.toString('base64') !== encoded) return refused
    if (op === 'meta') {
      const userName = utf8.decode(bytes)
      return { ok: true, userName: userName && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(userName) ? userName : null }
    }
    if (bytes.length === 0) return refused
    if (bytes.length % 2) return field
    try {
      const value = utf16.decode(bytes)
      return value.includes('\0') ? field : { ok: true, value }
    } catch { return field }
  } catch { return refused }
  finally { bytes.fill(0) }
}
