import qrcode from '../../waitlist/vendor/qrcode.mjs'
import { boundedBody, cleanup, CONSENT_VERSION, codePattern, hash, hmac, now, WHATSAPP_SIGNUPS_OPEN } from '../../waitlist/lib/shared.js'
import { escape, htmlPage, privacyNote, unavailable, waitlistForm } from '../../waitlist/lib/ui.js'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const randomCode = () => 'AMG-' + [...crypto.getRandomValues(new Uint8Array(6))].map(byte => alphabet[byte & 31]).join('')
const token = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const address = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254
const resultPage = () => htmlPage('Check your confirmation', '<p>If your request was accepted, use the confirmation message to finish registering your interest. A repeated email request sends no additional message during the cooldown.</p><p><a href="/cloud/">Back to Cloud</a></p>')
const bad = () => htmlPage('Check your details', '<p>Choose a contact channel, describe your goal and expected result, and agree to the privacy note. Email confirmation needs a valid email.</p><p><a href="/cloud/">Back to the form</a></p>', 400)

export function networkPrefix(ip) {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every(part => Number(part) <= 255)) return ip
  try {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
    const [left, right] = normalized.split('::')
    const a = left ? left.split(':') : [], b = right ? right.split(':') : []
    return [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b].slice(0, 4).map(part => part.padStart(4, '0')).join(':')
  } catch { return null }
}
export async function onRequest({ request, env }) {
  const time = now()
  const url = new URL(request.url)
  if (request.method === 'GET') return htmlPage('Register your interest in Cloud', waitlistForm() + privacyNote())
  if (request.method !== 'POST') return htmlPage('Method not allowed', '', 405)
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return htmlPage('Use the registration form', '', 415)
  let fields
  try { fields = new URLSearchParams(await boundedBody(request)) } catch { return bad() }
  const action = fields.get('action')
  if (!['add', 'remove', 'confirm'].includes(action)) return bad()
  // A stale page or a direct POST gets no new WhatsApp code while sign-ups are paused.
  if (action === 'add' && fields.get('channel') === 'whatsapp' && !WHATSAPP_SIGNUPS_OPEN) return unavailable()
  if (!env.WAITLIST_DB || !env.WAITLIST_CONFIRM_SECRET || env.WAITLIST_DATA_JURISDICTION !== 'eu') return unavailable()
  const db = env.WAITLIST_DB
  try {
    await cleanup(db, time)
    if (action === 'remove') {
      const rawContact = (fields.get('contact') ?? '').trim()
      const contact = fields.get('channel') === 'email' ? rawContact.toLowerCase() : rawContact
      const channel = fields.get('channel')
      if (channel === 'email' && address(contact)) await db.prepare('DELETE FROM waitlist WHERE email=?').bind(contact).run()
      else if (channel === 'whatsapp' && contact.length > 0 && contact.length <= 256) await db.prepare('DELETE FROM waitlist WHERE whatsapp_sender=? OR whatsapp_number=?').bind(contact, contact).run()
      else if (channel === 'code' && codePattern.test(contact.toUpperCase())) await db.prepare("DELETE FROM waitlist WHERE confirmation_hash=? AND channel='whatsapp'").bind(await hash(contact.toUpperCase())).run()
      else return bad()
      return htmlPage('Removal complete', '<p>If those details were on the list, they are removed. Confirmation cooldowns still expire on their original schedule.</p><p><a href="/cloud/">Back to Cloud</a></p>')
    }
    if (action === 'confirm') {
      const value = fields.get('token') ?? ''
      if (!/^[0-9a-f]{64}$/.test(value)) return bad()
      const row = await db.prepare("UPDATE waitlist SET confirmed_at=? WHERE confirmation_hash=? AND channel='email' AND confirmed_at IS NULL AND expires_at>? RETURNING id").bind(time, await hash(value), time).first()
      return row ? htmlPage('Your interest is confirmed', '<p>Thank you. Your interest in Automagik Cloud is registered. No other email will be sent.</p>' + privacyNote()) : htmlPage('This link is unavailable', '<p>It has expired or has already been used. You can remove your details below.</p>' + privacyNote(), 404)
    }
    const channel = fields.get('channel')
    const goal = (fields.get('goal') ?? '').trim()
    const platform = fields.get('platform')
    const apps = (fields.get('apps') ?? '').trim()
    const expected = (fields.get('expected_result') ?? '').trim()
    const language = fields.get('language') ?? 'en'
    const email = channel === 'email' ? (fields.get('email') ?? '').trim().toLowerCase() : null
    if (!['email', 'whatsapp'].includes(channel) || !goal || goal.length > 1000 || !['android', 'linux', 'both'].includes(platform) || apps.length > 200 || !expected || expected.length > 500 || !['en', 'pt-BR'].includes(language) || fields.get('consent') !== 'yes' || (channel === 'email' && !address(email))) return bad()
    const prefix = networkPrefix(request.headers.get('CF-Connecting-IP') ?? '')
    // Cloudflare supplies this header. Fail closed if the real client address is absent.
    if (!prefix) return unavailable()
    const number = String(env.WAITLIST_WHATSAPP_NUMBER ?? '')
    if ((channel === 'email' && !env.RESEND_API_KEY) || (channel === 'whatsapp' && !/^[1-9][0-9]{6,14}$/.test(number))) return unavailable()
    const id = crypto.randomUUID()
    const secretValue = channel === 'email' ? token() : randomCode()
    const digest = await hash(secretValue)
    const day = new Date(time * 1000).toISOString().slice(0, 10)
    const group = await hmac(env.WAITLIST_CONFIRM_SECRET, `${day}.${prefix}`)
    const addressKey = email ? await hmac(env.WAITLIST_CONFIRM_SECRET, email) : null
    try {
      await db.prepare('INSERT INTO waitlist(id,channel,email,goal,platform,apps,expected_result,language,consent_version,created_at,expires_at,confirmation_hash,address_key,group_key,mail_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, channel, email, goal, platform, apps, expected, language, CONSENT_VERSION, time, time + (channel === 'email' ? 86400 : 1800), digest, addressKey, group, day).run()
    } catch (error) {
      const message = String(error?.message)
      if (message.includes('WAITLIST_COOLDOWN') || message.includes('UNIQUE constraint failed: waitlist.email')) return resultPage()
      if (message.includes('WAITLIST_RATE')) return htmlPage('Please try later', '<p>The confirmation limit has been reached. Please come back later.</p>', 429)
      // A rare random code collision gets no ambiguous success; no send occurred.
      return unavailable()
    }
    if (channel === 'whatsapp') {
      const link = `https://wa.me/${number}?text=${encodeURIComponent(`Confirm my Automagik waitlist: ${secretValue}`)}`
      const qr = qrcode(0, 'M'); qr.addData(link); qr.make()
      return htmlPage('Send your confirmation to our support Bot', `<p>You start the conversation. Open WhatsApp or scan this code, then send the prepared message to <strong>+${escape(number)}</strong>.</p><a class="button primary" href="${escape(link)}">Open WhatsApp</a><div class="qr" role="img" aria-label="QR code for the WhatsApp confirmation link">${qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true })}</div><p>Your code: <strong>${secretValue}</strong>. Send it within half an hour. WhatsApp confirmation may take a little while. <span lang="pt-BR">A confirmação pelo WhatsApp pode demorar um pouco.</span> Our support Bot replies once when your interest is confirmed; we send nothing else.</p><p>Changed your mind? Do not send the code. The pending entry expires automatically.</p>`)
    }
    const origin = url.origin
    if (!(origin === 'https://automagik.si' || /^https:\/\/[a-z0-9.-]+\.pages\.dev$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))) return unavailable()
    const confirmLink = `${origin}/api/waitlist/email-confirm?token=${secretValue}`
    const text = language === 'pt-BR'
      ? `Confirme seu interesse no Automagik Cloud: ${confirmLink}\nEste link expira em um dia. Esta é a única mensagem por email. Se você não pediu, ignore; os dados pendentes expiram. Remoção: ${origin}/cloud/#privacy`
      : `Confirm your interest in Automagik Cloud: ${confirmLink}\nThis link expires in a day. This is the only email. If you did not request it, ignore it; the pending details expire. Removal: ${origin}/cloud/#privacy`
    let sent
    try {
      sent = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `waitlist-${id}` }, body: JSON.stringify({ from: 'Automagik <confirm@send.automagik.si>', to: [email], subject: language === 'pt-BR' ? 'Confirme seu interesse no Automagik Cloud' : 'Confirm your Automagik Cloud interest', text }), signal: AbortSignal.timeout(10000) })
    } catch { return unavailable() }
    // The reservation remains consumed on failure/timeout: no retry email inside 24 hours.
    if (!sent.ok) return unavailable()
    return resultPage()
  } catch { return unavailable() }
}
