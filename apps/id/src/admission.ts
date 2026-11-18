// Admission tickets: account creation is invite only (RFC 0032, Decided 9).
//
// Invitations are Automagik Cloud records; this service stores none and no invite code. After
// Cloud redeems an invitation it signs a short-lived admission ticket: a compact JWS, EdDSA
// (Ed25519) only, checked here against the public keys in `ADMISSION_KEYS`. A ticket's `jti`
// is kept in D1 (`admission_ticket`), so one ticket creates at most one account. With no valid
// key or issuer configured, every ticket is refused and no account can be created.
import { compactVerify, decodeProtectedHeader, importJWK } from 'jose';

/** The request header that carries a ticket. Never the URL query: queries land in logs. */
export const ADMISSION_HEADER = 'x-automagik-admission';
/** The longest life a ticket may claim (`exp - iat`), in seconds. */
export const ADMISSION_MAX_LIFE = 15 * 60;
/** Clock skew allowed between Cloud and this service, in seconds. */
export const ADMISSION_SKEW = 30;
/** How many passkey ceremonies one ticket may start; each one reuses the ticket's one user row. */
export const ADMISSION_CEREMONIES = 10;
const MAX_KEYS = 8;
const MAX_TICKET = 4096;

export type AdmissionCode = 'INVITATION_REQUIRED' | 'INVITATION_INVALID' | 'INVITATION_USED';
export const ADMISSION_MESSAGES: Record<AdmissionCode, string> = {
  INVITATION_REQUIRED: 'Creating an account needs an invitation',
  INVITATION_INVALID: 'This invitation is not valid or has expired',
  INVITATION_USED: 'This invitation has already been used',
};

export class AdmissionRefused extends Error {
  constructor(readonly code: AdmissionCode) { super(ADMISSION_MESSAGES[code]); }
}

export interface AdmissionEnv {
  BETTER_AUTH_URL: string;
  /** A JWKS (JSON string) of Ed25519 public keys, each with a unique `kid`. */
  ADMISSION_KEYS?: string;
  /** The `iss` every ticket must carry: Cloud's HTTPS issuer URL, compared exactly. */
  ADMISSION_ISSUER?: string;
}

export interface AdmissionKey { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA'; use: 'sig' }
export interface Admission { jti: string; expiresAt: number }

/**
 * The listed public keys, or null when the value is absent or malformed in any way: fail closed.
 * A key that carries private material (`d`) makes the whole value malformed.
 */
export function parseAdmissionKeys(raw: string | undefined): AdmissionKey[] | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const list = (value as { keys?: unknown }).keys;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_KEYS) return null;
  const keys: AdmissionKey[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const key = entry as Record<string, unknown>;
    if ('d' in key || key.kty !== 'OKP' || key.crv !== 'Ed25519') return null;
    if (typeof key.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key.x)) return null;
    if (typeof key.kid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid)) return null;
    if (keys.some(other => other.kid === key.kid)) return null;
    if (key.alg !== undefined && key.alg !== 'EdDSA') return null;
    if (key.use !== undefined && key.use !== 'sig') return null;
    if (key.key_ops !== undefined && !(Array.isArray(key.key_ops) &&
        key.key_ops.every(operation => operation === 'verify'))) return null;
    keys.push({ kty: 'OKP', crv: 'Ed25519', x: key.x, kid: key.kid, alg: 'EdDSA', use: 'sig' });
  }
  return keys;
}

/** The configured issuer, or null unless it is an HTTPS URL with no credentials, query or fragment. */
export function parseAdmissionIssuer(raw: string | undefined): string | null {
  if (!raw || raw.length > 256) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  return raw;
}

/** What a ticket may do. Only sign-up exists; recovery is an open owner decision (RFC 0032 (c)). */
export type AdmissionUse = 'signup';

// The one place a ticket's purpose is checked. A later `use: "recover"` ticket, which names the
// account in `sub`, would be accepted here and nowhere else.
function checkUse(payload: Record<string, unknown>, use: AdmissionUse): void {
  if (payload.use !== use) throw new AdmissionRefused('INVITATION_INVALID');
  // A sign-up ticket names no account.
  if (payload.sub !== undefined) throw new AdmissionRefused('INVITATION_INVALID');
}

function audienceMatches(aud: unknown, audience: string): boolean {
  if (typeof aud === 'string') return aud === audience;
  return Array.isArray(aud) && aud.length > 0 && aud.every(entry => typeof entry === 'string') &&
    aud.includes(audience);
}

/**
 * Checks a ticket's signature and claims; it writes nothing. Throws AdmissionRefused:
 * INVITATION_REQUIRED without a ticket, INVITATION_INVALID for every other failure, including
 * a service with no valid key or issuer configured.
 */
export async function verifyAdmission(env: AdmissionEnv, token: string | null | undefined,
  use: AdmissionUse, now = Date.now()): Promise<Admission> {
  if (!token) throw new AdmissionRefused('INVITATION_REQUIRED');
  const invalid = () => new AdmissionRefused('INVITATION_INVALID');
  const keys = parseAdmissionKeys(env.ADMISSION_KEYS);
  const issuer = parseAdmissionIssuer(env.ADMISSION_ISSUER);
  if (!keys || !issuer) throw invalid();
  if (token.length > MAX_TICKET || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw invalid();
  }
  let payload: Record<string, unknown>;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'EdDSA') throw invalid();
    const listed = keys.find(key => key.kid === header.kid);
    if (!listed) throw invalid();
    const key = await importJWK(listed, 'EdDSA');
    const verified = await compactVerify(token, key, { algorithms: ['EdDSA'] });
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw invalid();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
  const seconds = Math.floor(now / 1000);
  const { iat, exp, nbf, jti } = payload;
  if (payload.iss !== issuer) throw invalid();
  if (!audienceMatches(payload.aud, new URL(env.BETTER_AUTH_URL).origin)) throw invalid();
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) throw invalid();
  if ((exp as number) <= seconds - ADMISSION_SKEW) throw invalid();
  if ((iat as number) > seconds + ADMISSION_SKEW) throw invalid();
  if ((exp as number) <= (iat as number) || (exp as number) - (iat as number) > ADMISSION_MAX_LIFE) throw invalid();
  if (nbf !== undefined && (!Number.isSafeInteger(nbf) || (nbf as number) > seconds + ADMISSION_SKEW)) throw invalid();
  if (typeof jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(jti)) throw invalid();
  checkUse(payload, use);
  return { jti, expiresAt: (exp as number) * 1000 };
}

/** A user id in Better Auth's own shape: 32 letters and digits. */
export function newUserId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // 62 does not divide 256: draw again for a byte past the last whole multiple.
  let id = '';
  while (id.length < 32) {
    for (const byte of crypto.getRandomValues(new Uint8Array(40))) {
      if (byte < 248 && id.length < 32) id += alphabet[byte % 62];
    }
  }
  return id;
}

/**
 * Reserves a verified ticket for a passkey ceremony, in one statement. The first ceremony
 * records the ticket with a fresh user id; a retry of an unused ticket gets that same id back,
 * so a ticket never makes more than one user row, and an abandoned ceremony does not strand the
 * person while the ticket lives. A used ticket, or one past its ceremony limit, returns nothing.
 */
export async function reserveSignup(db: D1Database, admission: Admission, now = Date.now()): Promise<string> {
  const row = await db.prepare(`INSERT INTO admission_ticket (jti, userId, state, ceremonies, expiresAt, createdAt)
    VALUES (?1, ?2, 'pending', 1, ?3, ?4)
    ON CONFLICT(jti) DO UPDATE SET ceremonies = ceremonies + 1
      WHERE admission_ticket.state = 'pending' AND admission_ticket.ceremonies < ?5
    RETURNING userId`).bind(admission.jti, newUserId(), admission.expiresAt, now, ADMISSION_CEREMONIES)
    .first<{ userId: string }>();
  if (!row) throw new AdmissionRefused('INVITATION_USED');
  return row.userId;
}

/** Marks the ticket reserved for this user used, once; false when there is none left to use. */
export async function claimSignup(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare(`UPDATE admission_ticket SET state = 'used'
    WHERE userId = ? AND state = 'pending' RETURNING jti`).bind(userId).first();
  return row !== null;
}

/** True when this ticket id was never recorded. */
export async function admissionUnused(db: D1Database, jti: string): Promise<boolean> {
  return await db.prepare('SELECT 1 FROM admission_ticket WHERE jti = ?').bind(jti).first() === null;
}

/**
 * Uses a ticket for a phone account in one statement; returns the new account's id, or null
 * when the ticket was already recorded (used, or reserved by a passkey ceremony).
 */
export async function consumeForPhone(db: D1Database, jti: string, expiresAt: number,
  now = Date.now()): Promise<string | null> {
  const userId = newUserId();
  const result = await db.prepare(`INSERT INTO admission_ticket (jti, userId, state, ceremonies, expiresAt, createdAt)
    VALUES (?, ?, 'used', 0, ?, ?) ON CONFLICT(jti) DO NOTHING`).bind(jti, userId, expiresAt, now).run();
  return result.meta.changes ? userId : null;
}
