import { timingSafeEqual } from 'node:crypto';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import type { User } from 'better-auth/types';
import type { Env } from './auth';
import { ADMISSION_HEADER, admissionExpired, admissionUnused, newUserId } from './admission';
import { checkTicket, refusal } from './gate';

const COOKIE = '__Host-automagik-id-whatsapp';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LIFE = 300_000;
const PREFIX = 'Sign in to Automagik: ';

interface Challenge {
  codeHash: string; cookieHash: string; createdAt: number; expiresAt: number;
  oauthQuery: string | null; clientName: string; phoneNumber: string | null;
  state: 'pending' | 'verified' | 'used';
  admissionJti: string | null; admissionExpiresAt: number | null;
}

export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function whatsappEnabled(env: Env): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(env.WHATSAPP_RECEIVING_NUMBER ?? '') &&
    (env.OMNI_INBOUND_TOKEN?.length ?? 0) >= 32;
}

export async function readChallenge(env: Env, request: Request): Promise<Challenge | null> {
  const token = request.headers.get('cookie')?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return env.DB.prepare('SELECT * FROM whatsapp_challenge WHERE cookieHash = ?')
    .bind(await hash(token)).first<Challenge>();
}

/** Omni supplies either a numeric sender ID or a numeric WhatsApp Web phone JID. */
export function senderPhone(from: unknown): string | null {
  if (typeof from !== 'string') return null;
  const digits = from.endsWith('@s.whatsapp.net') ? from.slice(0, -15) : from;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export function whatsappPlugin(env: Env): BetterAuthPlugin {
  return {
    id: 'automagik-whatsapp',
    endpoints: {
      whatsappStart: createAuthEndpoint('/whatsapp/start', {
        method: 'POST', metadata: { noStore: true },
      }, async ctx => {
        const body = ctx.body as { oauth_query?: unknown } | undefined;
        if (body && (typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some(key => key !== 'oauth_query'))) {
          throw new APIError('BAD_REQUEST', { code: 'INVALID_REQUEST', message: 'Invalid sign-in request' });
        }
        const query = body?.oauth_query;
        if (query !== undefined && typeof query !== 'string') throw new APIError('BAD_REQUEST');
        let clientName = 'Automagik';
        if (query) {
          const clientId = new URLSearchParams(query).get('client_id');
          const client = await ctx.context.adapter.findOne<{ name: string; disabled: boolean }>({
            model: 'oauthClient', where: [{ field: 'clientId', value: clientId ?? '' }],
          });
          if (!client || client.disabled) throw new APIError('BAD_REQUEST');
          clientName = client.name || 'Automagik';
        }
        // A ticket is only needed if the number turns out to have no account; check it now.
        const ticket = ctx.headers?.get(ADMISSION_HEADER);
        const admission = ticket ? await checkTicket(env, ticket) : null;
        if (admission && !(await admissionUnused(env.DB, admission.jti))) throw refusal('INVITATION_USED');
        const token = [...crypto.getRandomValues(new Uint8Array(32))]
          .map(byte => byte.toString(16).padStart(2, '0')).join('');
        const now = Date.now();
        for (let attempt = 0; attempt < 5; attempt++) {
          // 32 symbols divide 256 exactly, so masking introduces no sampling bias.
          const code = [...crypto.getRandomValues(new Uint8Array(6))].map(byte => ALPHABET[byte & 31]).join('');
          const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_challenge
            (codeHash, cookieHash, createdAt, expiresAt, oauthQuery, clientName, admissionJti, admissionExpiresAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(await hash(code), await hash(token), now, now + LIFE,
              query || null, clientName, admission?.jti ?? null, admission?.expiresAt ?? null).run();
          if (!inserted.meta.changes) continue;
          ctx.setCookie(COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 300 });
          const receiving = env.WHATSAPP_RECEIVING_NUMBER!.replace(/^\+/, '');
          return ctx.json({ code, expiresAt: now + LIFE,
            url: `https://wa.me/${receiving}?text=${encodeURIComponent(PREFIX + code)}` });
        }
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'Please start again' });
      }),
      // Only the Worker exposes this endpoint, as GET; it supplies the stored signed query.
      whatsappStatus: createAuthEndpoint('/whatsapp/status', {
        method: 'POST', metadata: { noStore: true },
      }, async ctx => {
        const challenge = await readChallenge(env, ctx.request!);
        if (!challenge || challenge.expiresAt <= Date.now() || challenge.state === 'used') {
          return ctx.json({ status: 'expired' });
        }
        if (challenge.state !== 'verified') return ctx.json({ status: 'pending' });
        const signupUserId = newUserId();
        const claimed = await env.DB.prepare(`UPDATE whatsapp_challenge SET state = 'used', signupUserId = ?
          WHERE cookieHash = ? AND state = 'verified' AND expiresAt > ?
          RETURNING phoneNumber, admissionJti, admissionExpiresAt`).bind(signupUserId, challenge.cookieHash, Date.now())
          .first<{ phoneNumber: string; admissionJti: string | null; admissionExpiresAt: number | null }>();
        if (!claimed) return ctx.json({ status: 'expired' });
        const findPhoneUser = () => ctx.context.adapter.findOne<User>({
          model: 'user', where: [{ field: 'phoneNumber', value: claimed.phoneNumber }],
        });
        let user = await findPhoneUser();
        if (!user) {
          const clearChallenge = () => ctx.setCookie(COOKIE, '', {
            httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0,
          });
          if (!claimed.admissionJti) {
            clearChallenge();
            return ctx.json({ status: 'invitation_required' });
          }
          try {
            // The user INSERT consumes the confirmed challenge's live invitation in D1.
            user = await ctx.context.internalAdapter.createUser({
              id: signupUserId, name: 'Automagik user', email: `${crypto.randomUUID()}@id.invalid`,
              emailVerified: false, phoneNumber: claimed.phoneNumber, phoneNumberVerified: true,
            }, { method: 'whatsapp' });
          } catch {
            // A concurrent proof for this number may have completed first. It can sign in.
            user = await findPhoneUser();
            if (!user) {
              clearChallenge();
              if (admissionExpired(claimed.admissionExpiresAt)) throw refusal('INVITATION_INVALID');
              if (!(await admissionUnused(env.DB, claimed.admissionJti))) return ctx.json({ status: 'invitation_used' });
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Please start again' });
            }
          }
        }
        user = await ctx.context.internalAdapter.updateUser(user.id, { phoneNumberVerified: true });
        const session = await ctx.context.internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        ctx.setCookie(COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
        return ctx.json({ status: 'verified', user: { id: user.id, name: user.name } });
      }),
    },
    rateLimit: [
      { pathMatcher: path => path === '/whatsapp/start', window: 60, max: 5 },
      { pathMatcher: path => path === '/whatsapp/status', window: 60, max: 60 },
    ],
  };
}

export async function inbound(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const authorized = request.headers.get('authorization')?.startsWith('Bearer ') &&
    timingSafeEqual(Buffer.from(await hash(provided), 'hex'), Buffer.from(await hash(env.OMNI_INBOUND_TOKEN!), 'hex'));
  if (!authorized) return new Response('Unauthorized', { status: 401 });
  const silent = () => new Response(null, { status: 204 });
  let event: any;
  try { event = await request.json(); } catch { return silent(); }
  const phone = senderPhone(event?.payload?.from);
  const eventId = request.headers.get('x-omni-event-id');
  const externalId = event?.payload?.externalId;
  const text = event?.payload?.content?.text;
  const timestamp = event?.timestamp;
  if (!phone || !eventId || eventId.length > 256 || typeof externalId !== 'string' ||
      !externalId || externalId.length > 256 || typeof text !== 'string' || text.length > 128 ||
      !Number.isSafeInteger(timestamp)) return silent();
  const message = text.trim();
  if (message.slice(0, PREFIX.length).toLowerCase() !== PREFIX.toLowerCase()) return silent();
  const code = message.slice(PREFIX.length).toUpperCase();
  if (code.length !== 6 || [...code].some(character => !ALPHABET.includes(character))) return silent();
  const codeHash = await hash(code);
  const challenge = await env.DB.prepare('SELECT * FROM whatsapp_challenge WHERE codeHash = ?')
    .bind(codeHash).first<Challenge>();
  const now = Date.now();
  const timestampValid = challenge ? timestamp >= challenge.createdAt && timestamp <= challenge.expiresAt && timestamp <= now : true;
  if (!timestampValid) return silent();
  const requestToken = crypto.randomUUID();
  const senderKey = `sender:${await hash(phone)}`;
  const challengeKey = `challenge:${codeHash}`;
  const ownedEvent = 'EXISTS (SELECT 1 FROM whatsapp_event WHERE requestToken = ?)';
  const senderAllowed = '(SELECT count FROM whatsapp_rate WHERE key = ?) <= 10';
  const challengeAllowed = '(SELECT count FROM whatsapp_rate WHERE key = ?) <= 3';
  // Event deduplication, both D1 limits, and challenge consumption commit together.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO whatsapp_event VALUES (?, ?, ?, ?)`)
      .bind(eventId, externalId, requestToken, now),
    env.DB.prepare(`INSERT INTO whatsapp_rate (key, count, resetAt)
      SELECT ?, 1, ? WHERE ${ownedEvent}
      ON CONFLICT(key) DO UPDATE SET count = CASE WHEN resetAt <= ? THEN 1 ELSE count + 1 END,
      resetAt = CASE WHEN resetAt <= ? THEN ? ELSE resetAt END`)
      .bind(senderKey, now + 60_000, requestToken, now, now, now + 60_000),
    env.DB.prepare(`INSERT INTO whatsapp_rate (key, count, resetAt)
      SELECT ?, 1, ? WHERE ${ownedEvent} AND ${senderAllowed}
        AND EXISTS (SELECT 1 FROM whatsapp_challenge WHERE codeHash = ?)
      ON CONFLICT(key) DO UPDATE SET count = CASE WHEN resetAt <= ? THEN 1 ELSE count + 1 END,
      resetAt = CASE WHEN resetAt <= ? THEN ? ELSE resetAt END`)
      .bind(challengeKey, now + LIFE, requestToken, senderKey, codeHash, now, now, now + LIFE),
    env.DB.prepare(`UPDATE whatsapp_challenge SET state = 'verified', phoneNumber = ?
      WHERE codeHash = ? AND state = 'pending' AND expiresAt > ?
        AND ${ownedEvent} AND ${senderAllowed} AND ${challengeAllowed}`)
      .bind(phone, codeHash, now, requestToken, senderKey, challengeKey),
  ]);
  if (!results[0].meta.changes) return silent();
  if (results[3].meta.changes) {
    return Response.json({ reply: `Done. Go back to your browser to finish signing in to ${challenge!.clientName}.` });
  }
  const senderRate = await env.DB.prepare('SELECT count FROM whatsapp_rate WHERE key = ?')
    .bind(senderKey).first<{ count: number }>();
  const challengeRate = await env.DB.prepare('SELECT count FROM whatsapp_rate WHERE key = ?')
    .bind(challengeKey).first<{ count: number }>();
  if (challenge?.state === 'pending' && challenge.expiresAt <= now &&
      (senderRate?.count ?? 11) <= 10 && (challengeRate?.count ?? 4) <= 3) {
    return Response.json({ reply: 'That code expired. Start again on the sign-in page.' });
  }
  return silent();
}
