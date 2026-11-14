// The one switch for new WhatsApp sign-ups. While false, the form offers email only and the
// endpoint refuses a WhatsApp sign-up, so no new code is issued. Codes already issued still
// confirm through whatsapp-confirm, and removal still takes a WhatsApp sender or code.
export const WHATSAPP_SIGNUPS_OPEN = false
export const WHATSAPP_BACKLOG_SECONDS = 180 * 86400
export const CONSENT_VERSION = '2026-11-11'
export const encoder = new TextEncoder()
export const now = () => Math.floor(Date.now() / 1000)
export const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
export const hash = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, typeof value === 'string' ? encoder.encode(value) : value))
}
export function constantEqual(a, b) {
  // Both values are fixed-length SHA-256 hex. No content-dependent early exit.
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false
  let different = 0
  for (let i = 0; i < 64; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return different === 0
}
export const e164 = value => /^\+[1-9][0-9]{6,14}$/.test(value)
export const codePattern = /^AMG-[0-9A-HJKMNP-TV-Z]{6}$/
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } })
export const empty = status => new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } })
export async function boundedBody(request, max = 8192) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks = []; let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > max) { await reader.cancel(); throw new Error('BODY_LIMIT') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
export async function cleanup(db, time, processingMs = Date.now()) {
  await db.batch([
    db.prepare("DELETE FROM waitlist WHERE confirmed_at IS NULL AND ((channel='email' AND expires_at<=?) OR (channel='whatsapp' AND (expires_at+?)*1000<?))").bind(time, WHATSAPP_BACKLOG_SECONDS, processingMs),
    db.prepare('DELETE FROM waitlist_quota WHERE expires_at<=?').bind(time),
    db.prepare('DELETE FROM waitlist_cooldown WHERE sent_at<=?').bind(time - 86400),
  ])
}
export async function quota(db, key, limit, expires) {
  return db.prepare('INSERT INTO waitlist_quota(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count').bind(key, expires, limit).first()
}
export const reply = language => language === 'pt-BR'
  ? 'Seu interesse no Automagik Cloud está confirmado. Para remover seus dados, abra https://automagik.si/api/waitlist#privacy e use o formulário de remoção.'
  : 'Your Automagik Cloud interest is confirmed. To remove your details, open https://automagik.si/api/waitlist#privacy and use the removal form.'
