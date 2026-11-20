import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { migrate } from './migrations';
import { clientSeedSQL } from '../scripts/client-seed';
import { SoftwareAuthenticator } from './authenticator';
import { ADMISSION_HEADER, admissions, TEST_ISSUER, type Admissions } from './admission';
import { ORPHAN_BATCH_LIMIT, ORPHAN_MIN_AGE_MS } from '../src/cleanup';

// The service runs on a subdomain of the passkey site name, as it does for real.
const origin = 'https://id.automagik.si';
const siteName = 'automagik.si';
const cloudSecret = 'test-only-cloud-client-secret-never-deployed';
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const verifier = 'a'.repeat(64);
const phoneJid = (digits: string) => `${digits}@s.whatsapp.net`;
const inboundToken = 'test-only-inbound-token-placeholder-not-deployed';
let bundle: string;
let root: string;
let state: string;
let runtimes: Miniflare[];
let runtime: Miniflare;
let cookie: string;
let ip: number;
let tickets: Admissions;

// The Worker under test, with its D1 binding wrapped so the suite can see every read it runs.
// Each SELECT is appended to `query_log` with the SHA-256 of any session token the statement
// returned, so a test proves that a refused route never read a particular row instead of only
// trusting its status code. The wrapper is compiled into the bundle, outside the Worker source.
const INSTRUMENTED_ENTRY = `
import worker from './src/index';

const originals = new WeakMap();

function instrument(db) {
  const digest = async (value) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const tokenHashes = async (result) => {
    const rows = Array.isArray(result) ? result : result ? [result] : [];
    const found = [];
    for (const row of rows) {
      if (row && typeof row === 'object' && typeof row.token === 'string') found.push(await digest(row.token));
    }
    return found.sort().join(',');
  };
  const log = async (sql, result) => {
    if (!/^\\s*(SELECT|WITH)\\b/i.test(sql)) return;
    await db.prepare('INSERT INTO query_log (sql, token_hashes) VALUES (?, ?)')
      .bind(sql, await tokenHashes(result)).run();
  };
  const wrap = (statement, sql) => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'first' || prop === 'all') {
          return async (...args) => {
            const result = await target[prop](...args);
            await log(sql, result);
            return result;
          };
        }
        if (prop === 'run') {
          return async (...args) => { await log(sql, null); return target[prop](...args); };
        }
        if (prop === 'bind') return (...args) => wrap(target.bind(...args), sql);
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => wrap(target.prepare(sql), sql);
      if (prop === 'batch') return (list) => target.batch(list.map(entry => originals.get(entry) ?? entry));
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    return worker.fetch(request, { ...env, DB: instrument(env.DB) }, ctx);
  },
  async scheduled(controller, env, ctx) {
    return worker.scheduled(controller, { ...env, DB: instrument(env.DB) }, ctx);
  },
};
`;

beforeAll(async () => {
  await mkdir('.wrangler', { recursive: true });
  root = await mkdtemp('.wrangler/test-');
  bundle = resolve(root, 'worker.mjs');
  await build({
    stdin: { contents: INSTRUMENTED_ENTRY, resolveDir: process.cwd(), sourcefile: 'instrumented.ts', loader: 'ts' },
    outfile: bundle, bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker'],
    external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
  });
  // Admission tickets are signed with a key made for this run.
  tickets = await admissions(origin);
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function instance(whatsapp = false, _unused?: undefined, pages = false, config: Record<string, string> = {}) {
  const mf = new Miniflare({
    modules: [{ type: 'ESModule', path: bundle }],
    compatibilityDate: '2025-11-18', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'test-identity-database' }, d1Persist: state,
    outboundService: async request => {
      // Better Auth validates RP logout hints by fetching its own published JWKS.
      // Dispatch that back into this local runtime; never contact the public origin.
      if (request.method === 'GET' && request.url === `${origin}/api/auth/jwks`) {
        return mf.dispatchFetch(request.url);
      }
      throw new Error('Unexpected outbound network request');
    },
    serviceBindings: pages ? {
      PAGES: async request => {
        const path = new URL(request.url).pathname;
        if (path === '/sign-in.html') return new Response('owner page fixture');
        if (path === '/style.css') return new Response('owner asset fixture');
        return new Response('Not found', { status: 404 });
      },
    } : undefined,
    bindings: {
      BETTER_AUTH_URL: origin,
      PASSKEY_RP_ID: siteName,
      BETTER_AUTH_SECRET: 'test-only-auth-secret-placeholder-never-deployed',
      ADMISSION_KEYS: tickets.keys,
      ADMISSION_ISSUER: TEST_ISSUER,
      ...(whatsapp ? { WHATSAPP_RECEIVING_NUMBER: '15555550100', OMNI_INBOUND_TOKEN: inboundToken } : {}),
      ...config,
    },
  });
  runtimes.push(mf);
  return mf;
}

async function createQueryLog(db: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  // The instrumented binding writes every SELECT here; the suite clears it before a route.
  await db.prepare('CREATE TABLE query_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ' +
    'sql TEXT NOT NULL, token_hashes TEXT NOT NULL)').run();
}

beforeEach(async () => {
  state = resolve(await mkdtemp(`${root}/db-`));
  runtimes = [];
  runtime = await instance();
  const db = await runtime.getD1Database('DB');
  await migrate(db);
  for (const sql of clientSeedSQL(digest(cloudSecret)).split(';').filter(Boolean)) {
    await db.prepare(sql).run();
  }
  await createQueryLog(db);
  cookie = '';
  ip = 1;
});
afterEach(async () => { await Promise.all(runtimes.map(mf => mf.dispose())); });

function expectNoInternalEmail(value: string) {
  expect(value).not.toContain('@id.invalid');
  // A signed JWT still discloses its payload. Check encoded header/body tokens too.
  for (const match of value.matchAll(/[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
    catch { continue; }
    expect(JSON.stringify(payload)).not.toContain('@id.invalid');
  }
}

async function request(path: string, body?: unknown, options: {
  mf?: Miniflare; method?: string; form?: boolean; cookie?: string; ip?: string;
  headers?: Record<string, string>;
} = {}) {
  const headers = {
    ...(options.form ? {} : { origin }), 'cf-connecting-ip': options.ip ?? `192.0.2.${ip++}`,
    cookie: options.cookie ?? cookie, accept: 'application/json', ...options.headers,
    ...(body === undefined ? {} : {
      'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json',
    }),
  };
  const response = await (options.mf ?? runtime).dispatchFetch(`${origin}${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers,
    body: body === undefined ? undefined : options.form ?
      new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    redirect: 'manual',
  });
  // Every route exercised by this suite checks both the wire body and all response headers.
  for (const [name, value] of response.headers) {
    expectNoInternalEmail(name);
    expectNoInternalEmail(value);
  }
  expectNoInternalEmail(await response.clone().text());
  const cookies = response.headers.getSetCookie();
  const jar = new Map(cookie.split('; ').filter(Boolean).map(entry => {
    const at = entry.indexOf('=');
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  for (const entry of cookies) {
    const [pair] = entry.split(';');
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  return response;
}

async function jsonOK(response: Awaited<ReturnType<typeof request>>) {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  try { return JSON.parse(text); } catch { throw new Error(`Invalid JSON response: ${text}`); }
}

/** The header that carries a fresh admission ticket: account creation is invite only. */
async function admit(claims?: Record<string, unknown>) {
  return { [ADMISSION_HEADER]: await tickets.mint(claims) };
}
async function withTicket(options: { cookie?: string; headers?: Record<string, string> }) {
  return { ...options, headers: { ...options.headers, ...(await admit()) } };
}

async function signup(oauth_query?: string) {
  const authenticator = new SoftwareAuthenticator();
  const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined,
    await withTicket({})));
  expect(options.authenticatorSelection.residentKey).toBe('required');
  const response = await request('/api/auth/passkey/verify-registration', {
    response: authenticator.register(options, origin), createSession: true,
    ...(oauth_query ? { oauth_query } : {}),
  });
  const result = await jsonOK(response);
  expect(JSON.stringify(result)).not.toContain('@id.invalid');
  const session = result.redirect ? await jsonOK(await request('/api/auth/get-session')) : result;
  expect(session.session.userId).toBeTruthy();
  return { authenticator, userId: session.session.userId, redirect: result.url };
}

function authorization(overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({
    client_id: 'automagik-desktop', redirect_uri: 'http://127.0.0.1:53001/callback',
    response_type: 'code', scope: 'openid profile', state: 'test-state', nonce: 'test-nonce',
    code_challenge: digest(verifier), code_challenge_method: 'S256', ...overrides,
  });
  for (const [key, value] of [...query]) if (value === '') query.delete(key);
  return '/api/auth/oauth2/authorize?' + query;
}

async function authorizationResult(overrides: Record<string, string> = {}) {
  const response = await request(authorization(overrides));
  const body = await response.text();
  const target = response.headers.get('location') ?? JSON.parse(body).url;
  return { response, url: new URL(target, origin), body };
}

async function code() {
  const result = await authorizationResult();
  expect(result.url.origin).toBe('http://127.0.0.1:53001');
  expect(result.url.searchParams.get('state')).toBe('test-state');
  expect(result.url.searchParams.has('error'), result.body).toBe(false);
  return result.url.searchParams.get('code')!;
}

function exchange(authorizationCode: string, extra: Record<string, string> = {}) {
  const body: Record<string, string> = {
    grant_type: 'authorization_code', client_id: 'automagik-desktop', code: authorizationCode,
    redirect_uri: 'http://127.0.0.1:53001/callback', code_verifier: verifier, ...extra,
  };
  for (const [key, value] of Object.entries(body)) if (value === '') delete body[key];
  return request('/api/auth/oauth2/token', body, { form: true, cookie: '' });
}

async function startWhatsApp(mf: Miniflare, oauth_query?: string, ticket: string | null | 'mint' = 'mint') {
  // A number with no account needs an admission ticket; a fresh one comes by default.
  const token = ticket === 'mint' ? await tickets.mint() : ticket;
  const response = await request('/api/auth/whatsapp/start', oauth_query ? { oauth_query } : {}, {
    mf, headers: token ? { [ADMISSION_HEADER]: token } : {},
  });
  const challengeCookie = response.headers.get('set-cookie') ?? '';
  for (const attribute of ['__Host-automagik-id-whatsapp=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=300']) {
    expect(challengeCookie).toContain(attribute);
  }
  expect(challengeCookie).not.toContain('Domain=');
  return jsonOK(response);
}

function deliver(mf: Miniflare, code: string, options: {
  eventId?: string; externalId?: string; from?: string; timestamp?: number; token?: string;
} = {}) {
  return request('/api/omni/inbound', {
    timestamp: options.timestamp ?? Date.now(),
    payload: { from: options.from ?? '15555550127', externalId: options.externalId ?? crypto.randomUUID(),
      content: { text: `Sign in to Automagik: ${code}` } },
  }, { mf, headers: {
    authorization: `Bearer ${options.token ?? inboundToken}`,
    'x-omni-event-id': options.eventId ?? crypto.randomUUID(),
  } });
}

describe('Worker + D1 identity', () => {
  test('WhatsApp full inbound flow creates a phone account and resumes signed authorization', async () => {
    const mf = await instance(true);
    const login = await authorizationResult({ prompt: 'login' });
    const started = await startWhatsApp(mf, login.url.search.slice(1));
    expect(started.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const link = new URL(started.url);
    expect(link.origin).toBe('https://wa.me');
    expect(link.pathname).toBe('/15555550100');
    expect(link.searchParams.get('text')).toBe(`Sign in to Automagik: ${started.code}`);
    expect(started.expiresAt - Date.now()).toBeGreaterThan(290_000);
    const boundCookie = cookie;
    expect(await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf })))
      .toEqual({ status: 'pending' });
    expect(await jsonOK(await deliver(mf, started.code))).toEqual({
      reply: 'Done. Go back to your browser to finish signing in to Automagik desktop.',
    });
    const status = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    expect(status.redirect).toBe(true);
    const authorizationCode = new URL(status.url).searchParams.get('code')!;
    const tokens = await jsonOK(await exchange(authorizationCode));
    expect(tokens.id_token).toBeTruthy();
    const session = await jsonOK(await request('/api/auth/get-session', undefined, { mf }));
    expect(session.user.phoneNumber).toBe('+15555550127');
    expect(session.user.phoneNumberVerified).toBe(true);
    const replay = await request('/api/auth/whatsapp/status', undefined, { mf, cookie: boundCookie });
    expect(await jsonOK(replay)).toEqual({ status: 'expired' });
    expect(replay.headers.get('set-cookie')).toBeNull();
    const db = await mf.getD1Database('DB');
    const stored = await db.prepare('SELECT * FROM whatsapp_challenge').first<any>();
    expect(stored.state).toBe('used');
    expect(stored.codeHash).toHaveLength(64);
    expect(stored.cookieHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(started.code);
  });

  test('WhatsApp bearer check refuses a wrong token without consuming the proof', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    expect((await deliver(mf, started.code, { token: 'wrong-token' })).status).toBe(401);
    expect((await deliver(mf, started.code)).status).toBe(200);
  });

  test('WhatsApp timestamp window rejects history, future messages and post-life timestamps', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    const db = await mf.getD1Database('DB');
    const row = await db.prepare('SELECT createdAt, expiresAt FROM whatsapp_challenge').first<any>();
    for (const timestamp of [row.createdAt - 1, row.expiresAt + 1, Date.now() + 60_000]) {
      expect((await deliver(mf, started.code, { timestamp })).status).toBe(204);
    }
    expect(await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf })))
      .toEqual({ status: 'pending' });
    expect((await deliver(mf, started.code)).status).toBe(200);
  });

  test('WhatsApp expired proof gives the expiry reply for a delayed in-window message', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    const db = await mf.getD1Database('DB');
    const row = await db.prepare('SELECT createdAt FROM whatsapp_challenge').first<any>();
    await db.prepare('UPDATE whatsapp_challenge SET expiresAt = createdAt').run();
    expect(await jsonOK(await deliver(mf, started.code, { timestamp: row.createdAt })))
      .toEqual({ reply: 'That code expired. Start again on the sign-in page.' });
    expect(await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf })))
      .toEqual({ status: 'expired' });
  });

  test('WhatsApp event and external IDs are independently idempotent and code cannot be reused', async () => {
    const mf = await instance(true);
    const first = await startWhatsApp(mf);
    const originalCookie = cookie;
    const eventId = crypto.randomUUID();
    const externalId = crypto.randomUUID();
    expect((await deliver(mf, first.code, { eventId, externalId })).status).toBe(200);
    const firstUser = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    cookie = '';
    const second = await startWhatsApp(mf);
    expect((await deliver(mf, second.code, { eventId })).status).toBe(204);
    expect((await deliver(mf, second.code, { externalId })).status).toBe(204);
    expect(await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf })))
      .toEqual({ status: 'pending' });
    expect((await deliver(mf, first.code, { from: '15555550128' })).status).toBe(204);
    const replay = await request('/api/auth/whatsapp/status', undefined, { mf, cookie: originalCookie });
    expect(await jsonOK(replay)).toEqual({ status: 'expired' });
    expect(replay.headers.get('set-cookie')).toBeNull();
    expect(firstUser.user.id).toBeTruthy();
  });

  test('WhatsApp accepts numeric sender IDs and phone JIDs, refusing all privacy and non-phone IDs', async () => {
    const mf = await instance(true);
    for (const from of ['15555550129', phoneJid('15555550130')]) {
      cookie = '';
      const started = await startWhatsApp(mf);
      expect((await deliver(mf, started.code, { from })).status).toBe(200);
      await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
      const session = await jsonOK(await request('/api/auth/get-session', undefined, { mf }));
      expect(session.user.phoneNumber).toBe(`+${from.split('@')[0]}`);
    }
    cookie = '';
    const started = await startWhatsApp(mf);
    for (const from of ['15555550129@lid', '15555550129@other.example.com', 'opaque@lid',
      'not-a-number', phoneJid('abc'), '+15555550129', phoneJid('15555550129:2'), '0123456789']) {
      const response = await deliver(mf, started.code, { from });
      expect(response.status, from).toBe(204);
      expect(await response.text()).toBe('');
    }
  });

  test('WhatsApp per-sender rate limit persists across isolated runtimes sharing D1', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    const unknown = started.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let i = 0; i < 10; i++) expect((await deliver(mf, unknown)).status).toBe(204);
    const peer = await instance(true);
    expect((await deliver(peer, started.code)).status).toBe(204);
    expect((await deliver(peer, started.code, { from: '15555550131' })).status).toBe(200);
  });

  test('WhatsApp per-challenge rate limit suppresses repeated expiry replies', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    const db = await mf.getD1Database('DB');
    const row = await db.prepare('SELECT createdAt FROM whatsapp_challenge').first<any>();
    await db.prepare('UPDATE whatsapp_challenge SET expiresAt = createdAt').run();
    for (let i = 0; i < 3; i++) {
      expect((await deliver(mf, started.code, { timestamp: row.createdAt, from: `1555555014${i}` })).status).toBe(200);
    }
    expect((await deliver(mf, started.code, { timestamp: row.createdAt, from: '15555550149' })).status).toBe(204);
  });

  test('WhatsApp concurrent inbound proofs consume a challenge only once', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    const responses = await Promise.all([
      deliver(mf, started.code, { from: '15555550150' }),
      deliver(mf, started.code, { from: '15555550151' }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 204]);
    const signedIn = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    expect(signedIn.user.id).toBeTruthy();
    const replay = await request('/api/auth/whatsapp/status', undefined, { mf });
    expect(await jsonOK(replay)).toEqual({ status: 'expired' });
    expect(replay.headers.get('set-cookie')).toBeNull();
  });

  test('WhatsApp proof signs in its phone account and never links the current passkey account', async () => {
    const { userId } = await signup();
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    expect((await deliver(mf, started.code)).status).toBe(200);
    const phone = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    expect(phone.user.id).not.toBe(userId);
    const db = await mf.getD1Database('DB');
    expect(await db.prepare('SELECT phoneNumber FROM user WHERE id = ?').bind(userId).first())
      .toEqual({ phoneNumber: null });
    await db.prepare('UPDATE user SET phoneNumberVerified = 0 WHERE id = ?').bind(phone.user.id).run();
    cookie = '';
    const again = await startWhatsApp(mf);
    expect((await deliver(mf, again.code)).status).toBe(200);
    const existing = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    expect(existing.user.id).toBe(phone.user.id);
    const verified = await jsonOK(await request('/api/auth/get-session', undefined, { mf }));
    expect(verified.user.phoneNumberVerified).toBe(true);
    expect((await db.prepare('SELECT count(*) AS n FROM user WHERE phoneNumber IS NOT NULL').first<any>()).n).toBe(1);
  });

  test('phone linking flags cannot select an account through WhatsApp start', async () => {
    await signup();
    const mf = await instance(true);
    for (const body of [{ phoneNumber: '+15555550127' }, { updatePhoneNumber: true },
      { userId: 'chosen-user' }, { linkAccount: true }]) {
      const response = await request('/api/auth/whatsapp/start', body, { mf });
      expect(response.status).toBe(400);
      expect((await response.json() as any).code).toBe('INVALID_REQUEST');
    }
  });

  test('WhatsApp status needs the challenge cookie, blocks cross-site polls and forbids public POST', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    expect((await deliver(mf, started.code)).status).toBe(200);
    expect(await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf, cookie: '' })))
      .toEqual({ status: 'expired' });
    expect((await request('/api/auth/whatsapp/status', undefined, {
      mf, headers: { 'sec-fetch-site': 'cross-site' },
    })).status).toBe(403);
    expect((await request('/api/auth/whatsapp/status', {}, { mf })).status).toBe(404);
    expect((await request('/api/auth/whatsapp/status', undefined, { mf })).status).toBe(200);
  });

  test('WhatsApp is off unless both config values exist and outbound phone routes stay absent', async () => {
    for (const config of [{ OMNI_INBOUND_TOKEN: '' }, { WHATSAPP_RECEIVING_NUMBER: '' }] as Record<string, string>[]) {
      const mf = await instance(true, undefined, false, config);
      expect((await request('/api/auth/whatsapp/start', {}, { mf })).status).toBe(404);
      expect((await request('/api/auth/whatsapp/status', undefined, { mf })).status).toBe(404);
      expect((await deliver(mf, 'AAAAAA')).status).toBe(404);
    }
    const mf = await instance(true);
    expect(await jsonOK(await request('/api/id/config', undefined, { mf })))
      .toEqual({ phoneEnabled: false, whatsappEnabled: true });
    for (const path of ['/phone-number/send-otp', '/phone-number/verify', '/sign-in/phone-number']) {
      expect((await request(`/api/auth${path}`, {}, { mf })).status).toBe(404);
    }
    expect((await request('/api/auth/whatsapp/start', { oauth_query: 'invalid' }, { mf })).status).toBe(400);
  });
  test('registering with a session creates a fresh user and preserves the original passkey owner', async () => {
    const first = await signup();
    const second = await signup(); // Deliberately keep the first session cookie in both requests.
    expect(second.userId).not.toBe(first.userId);
    const db = await runtime.getD1Database('DB');
    const owners = await db.prepare('SELECT userId, count(*) AS n FROM passkey GROUP BY userId').all<{
      userId: string; n: number;
    }>();
    expect(owners.results).toHaveLength(2);
    expect(owners.results.find(owner => owner.userId === first.userId)?.n).toBe(1);
    expect(owners.results.find(owner => owner.userId === second.userId)?.n).toBe(1);
    const current = await jsonOK(await request('/api/auth/get-session'));
    expect(current.user.id).toBe(second.userId);
  });

  test.each([
    ['leading space', ' ', ''], ['trailing space', '', ' '], ['spaces around name', ' ', ' '],
    ['leading tab', '\t', ''], ['trailing tab', '', '\t'], ['tabs around name', '\t', '\t'],
  ].flatMap(([label, before, after]) => ['options', 'verification', 'both'].map(step => ({
    label, before, after, step,
  }))))('registration ignores whitespace session cookies: $label in $step', async ({ before, after, step }) => {
    const first = await signup();
    const originalCookie = cookie;
    const spaced = (value: string) => value.split(';').map(pair => {
      const at = pair.indexOf('=');
      return `${before}${pair.slice(0, at).trim()}${after}${pair.slice(at)}`;
    }).join(';');
    // Prove that the same spelling authenticates on a route which accepts sessions.
    expect((await jsonOK(await request('/api/auth/get-session', undefined, {
      cookie: spaced(originalCookie),
    }))).user.id).toBe(first.userId);
    const headers = { aUtHoRiZaTiOn: '\t Bearer unused-session-header \t' };
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined, {
      cookie: step === 'verification' ? originalCookie : spaced(originalCookie),
      headers: { ...headers, ...(await admit()) },
    }));
    const second = await jsonOK(await request('/api/auth/passkey/verify-registration', {
      response: new SoftwareAuthenticator().register(options, origin), createSession: true,
    }, { cookie: step === 'options' ? cookie : spaced(cookie), headers }));
    expect(second.session.userId).not.toBe(first.userId);
    const db = await runtime.getD1Database('DB');
    expect((await db.prepare('SELECT count(*) AS n FROM passkey WHERE userId = ?')
      .bind(first.userId).first<{ n: number }>())!.n).toBe(1);
    expect((await db.prepare('SELECT count(*) AS n FROM user').first<{ n: number }>())!.n).toBe(2);
  });

  test.each(['first', 'second'])('registration strips a session on the $0 Cookie header line', async position => {
    const first = await signup();
    const originalCookie = cookie;
    const duplicateCookie = (value: string) => position === 'first'
      ? { cookie: value, headers: { Cookie: 'unrelated=kept' } }
      : { cookie: 'unrelated=kept', headers: { Cookie: value } };
    expect((await jsonOK(await request('/api/auth/get-session', undefined,
      duplicateCookie(originalCookie)))).user.id).toBe(first.userId);
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined,
      await withTicket(duplicateCookie(originalCookie))));
    const second = await jsonOK(await request('/api/auth/passkey/verify-registration', {
      response: new SoftwareAuthenticator().register(options, origin), createSession: true,
    }, duplicateCookie(cookie)));
    expect(second.session.userId).not.toBe(first.userId);
  });

  test('session cookie names are case-sensitive in Better Call', async () => {
    const first = await signup();
    const differentCase = cookie.replace(/session_token/g, 'SESSION_TOKEN');
    expect(await jsonOK(await request('/api/auth/get-session', undefined, { cookie: differentCase }))).toBeNull();
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined,
      await withTicket({ cookie: differentCase })));
    const second = await jsonOK(await request('/api/auth/passkey/verify-registration', {
      response: new SoftwareAuthenticator().register(options, origin), createSession: true,
    }, { cookie: cookie.replace(/session_token/g, 'SESSION_TOKEN') }));
    expect(second.session.userId).not.toBe(first.userId);
  });

  test('internal email stays out of response headers and bodies, including encoded JWTs', async () => {
    const { userId } = await signup();
    const db = await runtime.getD1Database('DB');
    const stored = await db.prepare('SELECT email FROM user WHERE id = ?').bind(userId)
      .first<{ email: string }>();
    expect(stored!.email).toMatch(/@id\.invalid$/);
    const session = await request('/api/auth/get-session');
    expect(session.status).toBe(200);
    expect(session.headers.get('set-auth-jwt')).toBeNull();
    expect(session.headers.get('access-control-expose-headers') ?? '').not.toContain('set-auth-jwt');
    expect((await session.json() as any).user.email).toBeUndefined();
    // Existing-account registration options must not use the internal email as a display name.
    await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined, await withTicket({})));
  });

  test('software passkey signup, sign-in, native S256 code flow, JWKS, ID token and userinfo', async () => {
    const { authenticator, userId } = await signup();
    cookie = '';
    const options = await jsonOK(await request('/api/auth/passkey/generate-authenticate-options'));
    expect(options.allowCredentials ?? []).toEqual([]); // discoverable credentials / conditional UI
    await jsonOK(await request('/api/auth/passkey/verify-authentication', {
      response: authenticator.authenticate(options, origin),
    }));
    const metadata = await jsonOK(await request('/.well-known/openid-configuration'));
    // The issuer every product stores with the subject; DEPLOY.md's check names this string.
    expect(metadata.issuer).toBe('https://id.automagik.si/api/auth');
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.registration_endpoint).toBeUndefined();
    for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint',
      'revocation_endpoint', 'end_session_endpoint', 'jwks_uri']) expect(metadata[field]).toBeTruthy();
    const tokens = await jsonOK(await exchange(await code()));
    const jwks = await jsonOK(await request(new URL(metadata.jwks_uri).pathname));
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: metadata.issuer, audience: 'automagik-desktop',
    });
    expect(verified.payload.sub).toBe(userId);
    expect(verified.payload.nonce).toBe('test-nonce');
    expect(verified.payload.exp! * 1000).toBeGreaterThan(Date.now());
    expect(verified.payload.email).toBeUndefined();
    await expect(jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: 'https://wrong.example.com', audience: 'automagik-desktop',
    })).rejects.toThrow();
    await expect(jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: metadata.issuer, audience: 'another-client',
    })).rejects.toThrow();
    await expect(jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: metadata.issuer, audience: 'automagik-desktop',
      currentDate: new Date(verified.payload.exp! * 1000 + 1000),
    })).rejects.toThrow();
    const user = await jsonOK(await request('/api/auth/oauth2/userinfo', undefined, {
      headers: { authorization: `Bearer ${tokens.access_token}` }, cookie: '',
    }));
    expect(user.sub).toBe(userId);
    expect(user.email).toBeUndefined();
    expect((await request('/api/auth/oauth2/revoke', {
      client_id: 'automagik-desktop', token: tokens.access_token,
    }, { form: true, cookie: '' })).status).toBe(200);
    const db = await runtime.getD1Database('DB');
    expect((await db.prepare('SELECT count(*) AS n FROM session').first<{ n: number }>())!.n)
      .toBeGreaterThan(0);
    expect((await db.prepare('SELECT count(*) AS n FROM passkey').first<{ n: number }>())!.n).toBe(1);
    const logout = await request('/api/auth/oauth2/end-session', {
      id_token_hint: tokens.id_token, client_id: 'automagik-desktop',
    });
    expect(logout.status).toBe(200);
    expect(await jsonOK(await request('/api/auth/get-session'))).toBeNull();
  });

  test('registered native loopback accepts arbitrary port; localhost, non-loopback and unregistered paths fail', async () => {
    await signup();
    expect((await authorizationResult()).url.searchParams.get('code')).toBeTruthy();
    for (const uri of ['http://localhost:53001/callback', 'http://example.com:53001/callback',
      'http://127.0.0.1:53001/unregistered', 'https://attacker.example.com/callback']) {
      const response = await request(authorization({ redirect_uri: uri }));
      const body = await response.text();
      if (response.status === 200) {
        const errorURL = new URL(JSON.parse(body).url);
        expect(errorURL.origin).toBe(origin);
        expect(errorURL.searchParams.has('error')).toBe(true);
        expect(errorURL.searchParams.has('code')).toBe(false);
      } else expect(response.status, body).toBeGreaterThanOrEqual(400);
      expect(response.headers.get('location')).toBeNull();
    }
    // A registered localhost URI still does not receive the IP-literal port exception.
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE oauthClient SET redirectUris = ? WHERE clientId = ?')
      .bind(JSON.stringify(['http://localhost:49152/callback']), 'automagik-desktop').run();
    const localhost = await authorizationResult({ redirect_uri: 'http://localhost:53001/callback' });
    expect(localhost.url.origin).toBe(origin);
    expect(localhost.url.searchParams.has('error')).toBe(true);
  });

  test('plain and missing PKCE fail for native and confidential clients', async () => {
    await signup();
    for (const client of [
      { client_id: 'automagik-desktop', redirect_uri: 'http://127.0.0.1:53001/callback' },
      { client_id: 'automagik-cloud', redirect_uri: 'https://cloud.example.com/auth/callback' },
    ]) {
      const plain = await authorizationResult({ ...client, code_challenge_method: 'plain' });
      expect(plain.url.searchParams.has('error')).toBe(true);
      expect(plain.url.searchParams.has('code')).toBe(false);
      const missing = await authorizationResult({ ...client, code_challenge: '', code_challenge_method: '' });
      expect(missing.url.searchParams.get('error')).toBe('invalid_request');
      expect(missing.url.searchParams.get('error_description')).toContain('pkce');
      expect(missing.url.searchParams.has('code')).toBe(false);
    }
  });

  test('Cloud confidential client requires its secret and completes S256 exchange', async () => {
    await signup();
    const result = await authorizationResult({
      client_id: 'automagik-cloud', redirect_uri: 'https://cloud.example.com/auth/callback',
    });
    expect(result.url.searchParams.has('error'), result.url.searchParams.get('error_description') ?? '')
      .toBe(false);
    const authorizationCode = result.url.searchParams.get('code')!;
    expect(authorizationCode).toBeTruthy();
    const body = {
      grant_type: 'authorization_code', client_id: 'automagik-cloud', code: authorizationCode,
      redirect_uri: 'https://cloud.example.com/auth/callback', code_verifier: verifier,
    };
    const unauthenticated = await request('/api/auth/oauth2/token', body, { form: true, cookie: '' });
    // extractClientCredentials selects method none; validateClientCredentials rejects the mismatch.
    // throwInvalidClient returns 400 without an attempted Basic authentication challenge.
    expect(unauthenticated.status).toBe(400);
    expect(await unauthenticated.json()).toEqual({
      error: 'invalid_client',
      error_description: 'client registered for client_secret_basic cannot use none',
    });
    const tokens = await jsonOK(await request('/api/auth/oauth2/token', body, {
      form: true, cookie: '', headers: {
        authorization: `Basic ${Buffer.from(`automagik-cloud:${cloudSecret}`).toString('base64')}`,
      },
    }));
    expect(tokens.id_token).toBeTruthy();
  });

  test('missing verifier, wrong verifier, replayed code and expired code fail', async () => {
    await signup();
    expect((await exchange(await code(), { code_verifier: '' })).status).toBe(400);
    expect((await exchange(await code(), { code_verifier: 'b'.repeat(64) })).status).toBe(400);
    const once = await code();
    await jsonOK(await exchange(once));
    expect((await exchange(once)).status).toBe(400);
    const expired = await code();
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE verification SET expiresAt = ?').bind(0).run();
    expect((await exchange(expired)).status).toBe(400);
  });

  test('passkey wrong origin and challenge replay fail', async () => {
    const authenticator = new SoftwareAuthenticator();
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined,
      await withTicket({})));
    const registration = authenticator.register(options, 'https://wrong.example.com');
    expect((await request('/api/auth/passkey/verify-registration', { response: registration })).status).toBe(400);
    expect((await request('/api/auth/passkey/verify-registration', {
      response: authenticator.register(options, origin),
    })).status).toBe(400);
  });

  test('unsupported sign-in, sign-up, recovery, social and public registration routes are absent', async () => {
    for (const path of ['/sign-up/email', '/sign-in/email', '/sign-in/social', '/request-password-reset',
      '/oauth2/register', '/oauth2/create-client', '/sign-in/phone-number']) {
      expect((await request(`/api/auth${path}`, {})).status).toBe(404);
    }
    expect((await request('/api/auth/oauth2/register', {
      client_name: 'Unreviewed client', application_type: 'web',
      redirect_uris: ['https://unreviewed.example.com/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
    })).status).toBe(404);
  });

  test('login redirects carry a signed query; continue resumes it after signup', async () => {
    const login = await authorizationResult();
    expect(login.url.pathname).toBe('/sign-in');
    for (const key of ['client_id', 'scope', 'state', 'nonce', 'exp', 'sig']) {
      expect(login.url.searchParams.get(key)).toBeTruthy();
    }
    const oauth_query = login.url.search.slice(1);
    const client = await jsonOK(await request('/api/auth/oauth2/public-client-prelogin', {
      client_id: 'automagik-desktop', oauth_query,
    }));
    expect(client.client_name).toBe('Automagik desktop');
    await signup();
    const continued = await jsonOK(await request('/api/auth/oauth2/continue', { oauth_query, selected: true }));
    expect(new URL(continued.url).searchParams.get('code')).toBeTruthy();
    expect((await request('/api/auth/oauth2/continue', {
      oauth_query: oauth_query.replace('test-state', 'tampered-state'),
      selected: true,
    })).status).toBe(400);
  });

  test('fresh passkey signup resumes a signed prompt=login query', async () => {
    const login = await authorizationResult({ prompt: 'login' });
    expect(login.url.pathname).toBe('/sign-in');
    const registration = await signup(login.url.search.slice(1));
    expect(registration.redirect).toBeTruthy();
    expect(new URL(registration.redirect).searchParams.get('code')).toBeTruthy();
  });

  test('account creation can resume prompt=create with an explicit created continuation', async () => {
    const login = await authorizationResult({ prompt: 'create' });
    expect(login.url.pathname).toBe('/sign-in');
    await signup();
    const continued = await jsonOK(await request('/api/auth/oauth2/continue', {
      created: true, oauth_query: login.url.search.slice(1),
    }));
    expect(new URL(continued.url).searchParams.get('code')).toBeTruthy();
  });

  test('third-party consent shows verified client metadata and requires acceptance', async () => {
    await signup();
    const db = await runtime.getD1Database('DB');
    await db.prepare(`INSERT INTO oauthClient
      (id, clientId, name, applicationType, tokenEndpointAuthMethod, redirectUris,
       scopes, grantTypes, responseTypes, skipConsent, requirePKCE)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      'test-third-party', 'test-third-party', 'Example third party', 'web', 'none',
      JSON.stringify(['https://third.example.com/callback']),
      JSON.stringify(['openid', 'profile']), JSON.stringify(['authorization_code']),
      JSON.stringify(['code']), 0, 1,
    ).run();
    const consent = await authorizationResult({
      client_id: 'test-third-party', redirect_uri: 'https://third.example.com/callback',
    });
    expect(consent.url.pathname).toBe('/consent');
    expect(consent.url.searchParams.get('scope')).toBe('openid profile');
    expect(consent.url.searchParams.has('code')).toBe(false);
    const oauth_query = consent.url.search.slice(1);
    const client = await jsonOK(await request('/api/auth/oauth2/public-client-prelogin', {
      client_id: 'test-third-party', oauth_query,
    }));
    expect(client.client_name).toBe('Example third party');
    const accepted = await jsonOK(await request('/api/auth/oauth2/consent', { accept: true, oauth_query }));
    expect(new URL(accepted.url).searchParams.get('code')).toBeTruthy();
    const next = await authorizationResult({
      client_id: 'test-third-party', redirect_uri: 'https://third.example.com/callback', prompt: 'consent',
    });
    const denied = await jsonOK(await request('/api/auth/oauth2/consent', {
      accept: false, oauth_query: next.url.search.slice(1),
    }));
    expect(new URL(denied.url).searchParams.get('error')).toBe('access_denied');
    expect((await request('/api/auth/oauth2/consent', { accept: true, oauth_query }, { cookie: '' })).status)
      .toBe(401);
  });

  test('D1 challenges and sessions work in a separate runtime', async () => {
    const authenticator = new SoftwareAuthenticator();
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined,
      await withTicket({})));
    const db = await runtime.getD1Database('DB');
    expect((await db.prepare('SELECT count(*) AS n FROM verification').first<{ n: number }>())!.n)
      .toBeGreaterThan(0);
    const peer = await instance();
    const registration = await jsonOK(await request('/api/auth/passkey/verify-registration', {
      response: authenticator.register(options, origin), createSession: true,
    }, { mf: peer }));
    const session = await jsonOK(await request('/api/auth/get-session'));
    expect(session.user.id).toBe(registration.session.userId);
    expect(session.user.email).toBeUndefined();
  });

  test('pages are owner placeholders; phone routes are off without config', async () => {
    for (const path of ['/sign-in', '/consent']) {
      const response = await request(path);
      expect(response.status).toBe(501);
      expect(await response.text()).toBe('page not built yet');
    }
    expect(await jsonOK(await request('/api/id/config'))).toEqual({ phoneEnabled: false, whatsappEnabled: false });
    for (const path of ['/phone-number/send-otp', '/phone-number/verify']) {
      expect((await request(`/api/auth${path}`, {})).status).toBe(404);
    }
  });

  test('owner pages and supporting assets are served while an absent page stays 501', async () => {
    const pages = await instance(false, undefined, true);
    const response = await request('/sign-in?state=opaque', undefined, { mf: pages });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('owner page fixture');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await request('/consent', undefined, { mf: pages })).status).toBe(501);
    expect(await (await request('/style.css', undefined, { mf: pages })).text()).toBe('owner asset fixture');
  });

  test('direct .html paths answer 404, so a page is only ever served with its headers', async () => {
    const pages = await instance(false, undefined, true);
    for (const path of ['/sign-in.html', '/consent.html', '/sign-in.html?state=opaque', '/sign-in.html/',
      '/SIGN-IN.HTML', '/sign-in%2Ehtml', '/sign-in.htm', '/assets/other.html', '/%ff.html']) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        const response = await request(path, undefined, { mf: pages, method });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.text(), `${method} ${path}`).not.toContain('owner page fixture');
      }
    }
    // The page's own address and its files are untouched.
    const page = await request('/sign-in', undefined, { mf: pages });
    expect(page.status).toBe(200);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect((await request('/style.css', undefined, { mf: pages })).status).toBe(200);
  });

  test('D1 rate limit survives a second isolated runtime sharing the database', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await request('/api/auth/get-session', undefined, { ip: '192.0.2.201' })).status).toBe(200);
    }
    const peer = await instance();
    const limited = await request('/api/auth/get-session', undefined, { mf: peer, ip: '192.0.2.201' });
    expect(limited.status).toBe(429);
    const db = await peer.getD1Database('DB');
    expect((await db.prepare('SELECT count(*) AS n FROM rateLimit').first<{ n: number }>())!.n)
      .toBeGreaterThan(0);
  });
});

describe('passkey site name', () => {
  async function at(mf: Miniflare, base: string, path: string) {
    return mf.dispatchFetch(`${base}${path}`, {
      headers: { origin: base, accept: 'application/json', 'cf-connecting-ip': `192.0.2.${ip++}`,
        ...(path.endsWith('/generate-register-options') ? await admit({ aud: base }) : {}) },
    });
  }

  test('registration and sign-in options carry the site name automagik.si, not the service host', async () => {
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined,
      await withTicket({})));
    expect(options.rp.id).toBe('automagik.si');
    const { authenticator } = await signup();
    cookie = '';
    const sign = await jsonOK(await request('/api/auth/passkey/generate-authenticate-options'));
    expect(sign.rpId).toBe('automagik.si');
    await jsonOK(await request('/api/auth/passkey/verify-authentication', {
      response: authenticator.authenticate(sign, origin),
    }));
  });

  test('the value comes from PASSKEY_RP_ID', async () => {
    const mf = await instance(false, undefined, false, { PASSKEY_RP_ID: 'id.automagik.si' });
    const options = await (await at(mf, origin, '/api/auth/passkey/generate-register-options')).json() as {
      rp: { id: string };
    };
    expect(options.rp.id).toBe('id.automagik.si');
  });

  test('the site name itself and a subdomain of it are accepted', async () => {
    for (const base of ['https://automagik.si', 'https://id.automagik.si']) {
      const mf = await instance(false, undefined, false, { BETTER_AUTH_URL: base });
      const response = await at(mf, base, '/api/auth/passkey/generate-register-options');
      expect(response.status, base).toBe(200);
      expect((await response.json() as { rp: { id: string } }).rp.id).toBe('automagik.si');
    }
  });

  test('a host outside the site name is refused on every route with a plain error', async () => {
    for (const base of ['https://automagik-id.placeholder.workers.dev', 'https://id.example.com',
      'https://notautomagik.si', 'https://automagik.si.example.com']) {
      const mf = await instance(false, undefined, true, { BETTER_AUTH_URL: base });
      for (const path of ['/api/auth/get-session', '/api/auth/passkey/generate-register-options',
        '/api/id/config', '/sign-in', '/.well-known/openid-configuration']) {
        const response = await at(mf, base, path);
        expect(response.status, `${base}${path}`).toBe(500);
        expect(response.headers.get('content-type')).toContain('text/plain');
        expect(await response.text()).toContain(
          `host ${new URL(base).hostname} is not automagik.si or a subdomain of it`);
      }
    }
  });

  test('a missing or malformed site name is refused', async () => {
    for (const [value, message] of [['', 'PASSKEY_RP_ID is not set'],
      ['https://automagik.si', 'PASSKEY_RP_ID must be a lower-case domain name'],
      ['Automagik.si', 'PASSKEY_RP_ID must be a lower-case domain name']]) {
      const mf = await instance(false, undefined, false, { PASSKEY_RP_ID: value });
      const response = await at(mf, origin, '/api/id/config');
      expect(response.status, value).toBe(500);
      expect(await response.text()).toContain(message);
    }
  });
});

// Passkeys on an existing account: add behind a fresh sign-in, list, delete.
describe('passkeys on an existing account', () => {
  const PUBLIC_FIELDS = ['backedUp', 'createdAt', 'deviceType', 'id', 'name'];

  async function count(sql: string, ...values: string[]) {
    const db = await runtime.getD1Database('DB');
    return (await db.prepare(sql).bind(...values).first<{ n: number }>())!.n;
  }

  async function addPasskey(name = 'Second key') {
    const authenticator = new SoftwareAuthenticator();
    const options = await jsonOK(await request('/api/auth/passkey/add/generate-register-options'));
    const added = await jsonOK(await request('/api/auth/passkey/add/verify-registration', {
      response: authenticator.register(options, origin), name, createSession: true,
    }));
    return { authenticator, options, added };
  }

  async function signIn(authenticator: SoftwareAuthenticator) {
    cookie = '';
    const options = await jsonOK(await request('/api/auth/passkey/generate-authenticate-options'));
    return jsonOK(await request('/api/auth/passkey/verify-authentication', {
      response: authenticator.authenticate(options, origin),
    }));
  }

  async function idTokenSubject() {
    const tokens = await jsonOK(await exchange(await code()));
    const metadata = await jsonOK(await request('/.well-known/openid-configuration'));
    const jwks = await jsonOK(await request(new URL(metadata.jwks_uri).pathname));
    const verified = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
      issuer: metadata.issuer, audience: 'automagik-desktop',
    });
    return verified.payload.sub;
  }

  async function ageSessions(ms: number) {
    const db = await runtime.getD1Database('DB');
    const row = await db.prepare('SELECT createdAt FROM session LIMIT 1').first<{ createdAt: string | number }>();
    const past = Date.now() - ms;
    await db.prepare('UPDATE session SET createdAt = ?')
      .bind(typeof row!.createdAt === 'number' ? past : new Date(past).toISOString()).run();
  }

  function jarWith(jar: string, overrides: Record<string, string>) {
    const entries = new Map(jar.split('; ').filter(Boolean).map(entry => {
      const at = entry.indexOf('=');
      return [entry.slice(0, at), entry.slice(at + 1)] as [string, string];
    }));
    for (const [name, value] of Object.entries(overrides)) entries.set(name, value);
    return [...entries].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  const sessionCookie = (jar: string) => jar.split('; ')
    .find(entry => entry.startsWith('__Secure-better-auth.session_token='))!.split('=').slice(1).join('=');

  async function expectError(response: Awaited<ReturnType<typeof request>>, status: number, code: string) {
    const text = await response.text();
    expect(response.status, text).toBe(status);
    expect(JSON.parse(text).code).toBe(code);
    return text;
  }

  test('a second passkey added after a fresh sign-in signs in to the same account and sub', async () => {
    const { authenticator: first, userId } = await signup();
    const before = await jsonOK(await request('/api/auth/get-session'));
    expect(before.session.signInMethod).toBe('passkey');
    const { authenticator: second, options, added } = await addPasskey();
    expect(options.user.name).toBe('Automagik user');
    expect(Object.keys(added).sort()).toEqual(PUBLIC_FIELDS);
    expect(added.name).toBe('Second key');
    // Adding keeps the current session and never starts another one.
    expect((await jsonOK(await request('/api/auth/get-session'))).session.id).toBe(before.session.id);
    expect(await count('SELECT count(*) AS n FROM session')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM user')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', userId)).toBe(2);
    expect(await count("SELECT count(*) AS n FROM admission_ticket WHERE userId = ? AND state = 'used'", userId)).toBe(1);
    expect(await count('SELECT count(*) AS n FROM passkey_write_authorization')).toBe(0);
    for (const authenticator of [first, second]) {
      const signedIn = await signIn(authenticator);
      expect(signedIn.user.id).toBe(userId);
      expect(await idTokenSubject()).toBe(userId);
    }
  });

  test('a pre-admission account can add a second passkey after the admission migration', async () => {
    const { authenticator, userId } = await signup();
    const source = await runtime.getD1Database('DB');
    // Restore only the historical account and its authenticator into a fresh pre-admission
    // schema. The database has never seen an invitation or the new write authorization.
    state = resolve(await mkdtemp(`${root}/legacy-db-`));
    runtime = await instance();
    const db = await runtime.getD1Database('DB');
    await migrate(db, ['0001_auth.sql', '0002_whatsapp.sql', '0004_session_sign_in_method.sql']);
    for (const table of ['user', 'passkey']) {
      const record = (await source.prepare(`SELECT * FROM "${table}"`).first<Record<string, string | number | null>>())!;
      const columns = Object.keys(record);
      await db.prepare(`INSERT INTO "${table}" (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
        .bind(...Object.values(record)).run();
    }
    await migrate(db, ['0003_admission.sql']);
    await createQueryLog(db);
    expect((await signIn(authenticator)).user.id).toBe(userId);
    const { authenticator: second } = await addPasskey();
    expect((await signIn(second)).user.id).toBe(userId);
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', userId)).toBe(2);
    expect(await count('SELECT count(*) AS n FROM admission_ticket')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM passkey_write_authorization')).toBe(0);
  });

  test('adding a passkey without a session is refused and creates no account', async () => {
    for (const jar of ['', '__Secure-better-auth.session_token=not-a-session.fixture']) {
      cookie = jar;
      await expectError(await request('/api/auth/passkey/add/generate-register-options'), 401, 'UNAUTHORIZED');
      await expectError(await request('/api/auth/passkey/add/verify-registration', {
        response: new SoftwareAuthenticator().register({
          challenge: 'unused', rp: { id: siteName }, user: { id: 'unused' },
        }, origin),
      }), 401, 'UNAUTHORIZED');
    }
    expect(await count('SELECT count(*) AS n FROM user')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM passkey')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM verification')).toBe(0);
  });

  test('a stale session cannot add or delete a passkey', async () => {
    const { userId } = await signup();
    const { added } = await addPasskey();
    const pending = await jsonOK(await request('/api/auth/passkey/add/generate-register-options'));
    await ageSessions(5 * 60_000 + 1_000);
    await expectError(await request('/api/auth/passkey/add/generate-register-options'), 403, 'SESSION_NOT_FRESH');
    await expectError(await request('/api/auth/passkey/add/verify-registration', {
      response: new SoftwareAuthenticator().register(pending, origin),
    }), 403, 'SESSION_NOT_FRESH');
    await expectError(await request('/api/auth/passkey/account/delete', { id: added.id }), 403, 'SESSION_NOT_FRESH');
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', userId)).toBe(2);
    // The session still works for everything else, listing included.
    expect(await jsonOK(await request('/api/auth/passkey/account/list'))).toHaveLength(2);
  });

  test('a WhatsApp sign-in session cannot add a passkey', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf);
    expect((await deliver(mf, started.code)).status).toBe(200);
    await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    const session = await jsonOK(await request('/api/auth/get-session', undefined, { mf }));
    expect(session.session.signInMethod).toBe('whatsapp');
    await expectError(await request('/api/auth/passkey/add/generate-register-options', undefined, { mf }),
      403, 'SESSION_NOT_FRESH');
    expect(await count('SELECT count(*) AS n FROM passkey')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM user')).toBe(1);
  });

  test('the add ceremony is bound to the session that started it', async () => {
    const first = await signup();
    const options = await jsonOK(await request('/api/auth/passkey/add/generate-register-options'));
    const firstJar = cookie;
    cookie = '';
    const second = await signup();
    const otherSession = jarWith(firstJar, { '__Secure-better-auth.session_token': sessionCookie(cookie) });
    const refused = await request('/api/auth/passkey/add/verify-registration', {
      response: new SoftwareAuthenticator().register(options, origin),
    }, { cookie: otherSession });
    expect(refused.status).toBe(401);
    for (const userId of [first.userId, second.userId]) {
      expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', userId)).toBe(1);
    }
  });

  test('the list shows only your own passkeys, without secret material, and rename', async () => {
    const { authenticator, userId } = await signup();
    await signIn(authenticator); // A passkey sign-in session is as fresh as a new account's.
    const { added } = await addPasskey('Laptop');
    const listed = await jsonOK(await request('/api/auth/passkey/account/list'));
    expect(listed).toHaveLength(2);
    for (const entry of listed) expect(Object.keys(entry).sort()).toEqual(PUBLIC_FIELDS);
    expect(listed.map((entry: { name: string | null }) => entry.name)).toEqual([null, 'Laptop']);
    const db = await runtime.getD1Database('DB');
    const stored = await db.prepare('SELECT * FROM passkey WHERE userId = ?').bind(userId).all<any>();
    const text = JSON.stringify(listed);
    for (const row of stored.results) {
      for (const secret of [row.publicKey, row.credentialID, row.userId]) expect(text).not.toContain(secret);
    }
    const renamed = await jsonOK(await request('/api/auth/passkey/account/rename', { id: added.id, name: ' Work ' }));
    expect(renamed.passkey).toEqual({ ...added, name: 'Work' });
    await expectError(await request('/api/auth/passkey/account/rename', { id: added.id, name: ' ' }),
      400, 'INVALID_REQUEST');
    cookie = '';
    await signup();
    expect(await jsonOK(await request('/api/auth/passkey/account/list'))).toHaveLength(1);
    await expectError(await request('/api/auth/passkey/account/rename', { id: added.id, name: 'Mine' }),
      404, 'PASSKEY_NOT_FOUND');
    cookie = '';
    await expectError(await request('/api/auth/passkey/account/list'), 401, 'UNAUTHORIZED');
  });

  test('deleting one of two passkeys works; the last one is refused without a phone number', async () => {
    const { userId } = await signup();
    const { added } = await addPasskey();
    expect(await jsonOK(await request('/api/auth/passkey/account/delete', { id: added.id })))
      .toEqual({ status: true });
    const [last] = await jsonOK(await request('/api/auth/passkey/account/list'));
    await expectError(await request('/api/auth/passkey/account/delete', { id: last.id }), 409, 'LAST_PASSKEY');
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', userId)).toBe(1);
  });

  test.each([
    { scenario: 'WhatsApp disabled', enabled: false, phone: '+15555550160', verified: 1 },
    { scenario: 'an unverified phone', enabled: true, phone: '+15555550160', verified: 0 },
    { scenario: 'an unusable phone', enabled: true, phone: '+1555bad0160', verified: 1 },
  ])('keeps the last passkey with $scenario', async ({ enabled, phone, verified }) => {
    const { userId } = await signup();
    const [last] = await jsonOK(await request('/api/auth/passkey/account/list'));
    const mf = enabled ? await instance(true) : runtime;
    const db = await mf.getD1Database('DB');
    await db.prepare('UPDATE user SET phoneNumber = ?, phoneNumberVerified = ? WHERE id = ?')
      .bind(phone, verified, userId).run();
    await expectError(await request('/api/auth/passkey/account/delete', { id: last.id }, { mf }),
      409, 'LAST_PASSKEY');
    expect(await jsonOK(await request('/api/auth/passkey/account/list', undefined, { mf }))).toEqual([last]);
  });

  test('the owner can sign in with WhatsApp after deleting the last passkey', async () => {
    const { userId } = await signup();
    const [last] = await jsonOK(await request('/api/auth/passkey/account/list'));
    const mf = await instance(true);
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE user SET phoneNumber = ?, phoneNumberVerified = 1 WHERE id = ?')
      .bind('+15555550160', userId).run();
    expect(await jsonOK(await request('/api/auth/passkey/account/delete', { id: last.id }, { mf })))
      .toEqual({ status: true });
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', userId)).toBe(0);

    cookie = '';
    const started = await startWhatsApp(mf);
    expect((await deliver(mf, started.code, { from: '15555550160' })).status).toBe(200);
    const signedIn = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    expect(signedIn.user.id).toBe(userId);
  });

  test("someone else's passkey cannot be deleted and answers like a missing one", async () => {
    const victim = await signup();
    await addPasskey();
    const victimPasskey = (await jsonOK(await request('/api/auth/passkey/account/list')))[0].id;
    cookie = '';
    await signup();
    await addPasskey(); // Two passkeys, so the last-passkey guard cannot be what refuses.
    const foreign = await request('/api/auth/passkey/account/delete', { id: victimPasskey });
    const missing = await request('/api/auth/passkey/account/delete', { id: 'no-such-passkey' });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(missing.status).toBe(404);
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', victim.userId)).toBe(2);
  });

  test('an add request never creates an account, even past the session check', async () => {
    const { passkeyAccountPlugin, ADD_PASSKEY_HEADER } = await import('../src/passkeys');
    const plugin = passkeyAccountPlugin({} as never);
    const hooks = (plugin.init!({} as never) as any).options.databaseHooks;
    const create = (headers: Record<string, string>) => hooks.user.create.before({}, { headers: new Headers(headers) });
    await expect(create({ [ADD_PASSKEY_HEADER]: '1' })).rejects.toThrow('Unauthorized');
    await expect(create({})).resolves.toBeUndefined();
  });
});

describe('invite gate', () => {
  const REGISTER = '/api/auth/passkey/generate-register-options';
  type Answer = Awaited<ReturnType<typeof request>>;
  const count = async (table: string, mf: Miniflare = runtime) =>
    (await (await mf.getD1Database('DB')).prepare(`SELECT count(*) AS n FROM "${table}"`).first<{ n: number }>())!.n;
  async function refusedWith(response: Answer, code: string) {
    const text = await response.text();
    expect(response.status, text).toBe(403);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(JSON.parse(text).code).toBe(code);
  }
  // One ceremony in its own cookie jar, so two can run side by side.
  async function begin(ticket: string | null, mf: Miniflare = runtime) {
    const response = await request(REGISTER, undefined, {
      mf, cookie: '', headers: ticket ? { [ADMISSION_HEADER]: ticket } : {},
    });
    const jar = response.headers.getSetCookie().map(entry => entry.split(';')[0]).join('; ');
    return { response, jar };
  }
  async function finish(started: { response: Answer; jar: string }, mf: Miniflare = runtime) {
    const options = await jsonOK(started.response);
    return request('/api/auth/passkey/verify-registration', {
      response: new SoftwareAuthenticator().register(options, origin), createSession: true,
    }, { mf, cookie: started.jar });
  }

  test('sign-up without a ticket is refused before any row is written', async () => {
    await refusedWith(await request(REGISTER), 'INVITATION_REQUIRED');
    // A ticket in the query is not a ticket: it travels in the header only.
    await refusedWith(await request(`${REGISTER}?ticket=${await tickets.mint()}`), 'INVITATION_REQUIRED');
    for (const table of ['user', 'admission_ticket', 'verification', 'passkey']) expect(await count(table), table).toBe(0);
  });

  test.each([
    ['truncated signature', async () => (await tickets.mint()).slice(0, -4)],
    ['wrong aud', () => tickets.mint({ aud: 'https://other.automagik.si' })],
    ['wrong iss', () => tickets.mint({ iss: 'https://cloud.example.org' })],
    ['expired', () => tickets.mint({ iat: Math.floor(Date.now() / 1000) - 700, exp: Math.floor(Date.now() / 1000) - 100 })],
    ['life over 15 minutes', () => tickets.mint({ exp: Math.floor(Date.now() / 1000) + 901 })],
    ['use not signup', () => tickets.mint({ use: 'recover' })],
    ['use missing', () => tickets.mint({ use: undefined })],
    ['jti missing', () => tickets.mint({ jti: undefined })],
    ['issued in the future', () => tickets.mint({ iat: Math.floor(Date.now() / 1000) + 120 })],
    ['unknown kid', () => tickets.mint({}, { kid: 'not-listed' })],
    ['names an account', () => tickets.mint({ sub: 'some-user' })],
    ['not a JWS', async () => 'not-a-ticket'],
  ] as [string, () => Promise<string>][])('a bad ticket is refused with no row: %s', async (_label, make) => {
    await refusedWith(await request(REGISTER, undefined, { headers: { [ADMISSION_HEADER]: await make() } }),
      'INVITATION_INVALID');
    for (const table of ['user', 'admission_ticket', 'verification']) expect(await count(table), table).toBe(0);
  });

  test('a good ticket within the clock skew is accepted', async () => {
    const now = Math.floor(Date.now() / 1000);
    const response = await request(REGISTER, undefined, {
      headers: { [ADMISSION_HEADER]: await tickets.mint({ iat: now + 20, exp: now + 20 + 900 }) },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await count('user')).toBe(1);
  });

  test('a used ticket is refused', async () => {
    const ticket = await tickets.mint();
    expect((await finish(await begin(ticket))).status).toBe(200);
    await refusedWith((await begin(ticket)).response, 'INVITATION_USED');
    expect(await count('user')).toBe(1);
    expect(await count('passkey')).toBe(1);
  });

  test('an abandoned ceremony can be retried on its ticket, reusing its one user row', async () => {
    const ticket = await tickets.mint();
    await jsonOK((await begin(ticket)).response); // the authenticator prompt was cancelled
    const retry = await begin(ticket);
    const db = await runtime.getD1Database('DB');
    expect(await db.prepare('SELECT state, ceremonies FROM admission_ticket').first())
      .toEqual({ state: 'pending', ceremonies: 2 });
    expect(await count('user')).toBe(1);
    const created = await jsonOK(await finish(retry));
    const reserved = await db.prepare('SELECT userId, state FROM admission_ticket').first<any>();
    expect(reserved).toEqual({ userId: created.session.userId, state: 'used' });
    expect(await count('user')).toBe(1);
  });

  test.each([[30, 403], [15, 200]])('a passkey finishes %d seconds after invitation expiry', async (age, status) => {
    const ceremony = await begin(await tickets.mint());
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE admission_ticket SET expiresAt = (unixepoch() - ?) * 1000').bind(age).run();
    const finished = await finish(ceremony);
    if (status === 403) await refusedWith(finished, 'INVITATION_INVALID');
    else expect(finished.status).toBe(200);
    expect(await count('passkey')).toBe(status === 200 ? 1 : 0);
    expect(await count('session')).toBe(status === 200 ? 1 : 0);
  });

  test('a credential write failure leaves the invitation available for a fresh ceremony', async () => {
    const ticket = await tickets.mint();
    const ceremony = await begin(ticket);
    const db = await runtime.getD1Database('DB');
    await db.prepare(`CREATE TRIGGER simulate_storage_failure AFTER INSERT ON passkey
      BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END`).run();
    expect((await finish(ceremony)).status).toBe(500);
    expect(await db.prepare('SELECT state FROM admission_ticket').first('state')).toBe('pending');
    expect(await count('passkey')).toBe(0);
    expect(await count('session')).toBe(0);
    await db.prepare('DROP TRIGGER simulate_storage_failure').run();
    expect((await finish(await begin(ticket))).status).toBe(200);
    expect(await count('user')).toBe(1);
    expect(await count('passkey')).toBe(1);
  });

  test('one ticket starts at most ten ceremonies', async () => {
    const ticket = await tickets.mint();
    for (let i = 0; i < 10; i++) await jsonOK((await begin(ticket)).response);
    await refusedWith((await begin(ticket)).response, 'INVITATION_USED');
    expect(await count('user')).toBe(1);
  });

  test("a ticket's second ceremony cannot finish after its first", async () => {
    const ticket = await tickets.mint();
    const first = await begin(ticket);
    const second = await begin(ticket);
    expect((await finish(first)).status).toBe(200);
    await refusedWith(await finish(second), 'INVITATION_USED');
    expect(await count('user')).toBe(1);
    expect(await count('passkey')).toBe(1);
  });

  test('two concurrent registrations with one ticket create at most one account', async () => {
    // Both requests run at once in one runtime, interleaving at every D1 call. (Miniflare's
    // local D1 answers an internal error to simultaneous writes from two runtimes, so the
    // two-runtime case below interleaves the steps instead.)
    for (let round = 0; round < 3; round++) {
      const ticket = await tickets.mint();
      const started = await Promise.all([begin(ticket), begin(ticket)]);
      const statuses = (await Promise.all(started.map(ceremony => finish(ceremony))))
        .map(response => response.status);
      expect(statuses.sort()).toEqual([200, 403]);
      expect(await count('user')).toBe(round + 1);
      expect(await count('passkey')).toBe(round + 1);
    }
    // Two isolated runtimes sharing D1: either one's ceremony takes the ticket for both.
    const peer = await instance();
    const ticket = await tickets.mint();
    const here = await begin(ticket);
    const there = await begin(ticket, peer);
    expect((await finish(there, peer)).status).toBe(200);
    await refusedWith(await finish(here), 'INVITATION_USED');
    await refusedWith((await begin(ticket, peer)).response, 'INVITATION_USED');
    expect(await count('user')).toBe(4);
    expect(await count('passkey')).toBe(4);
    expect(await count('admission_ticket')).toBe(4);
  });

  test('no ADMISSION_KEYS: sign-up is refused while sign-in and OIDC keep working', async () => {
    const { authenticator, userId } = await signup();
    for (const config of [{ ADMISSION_KEYS: '' }, { ADMISSION_ISSUER: '' }] as Record<string, string>[]) {
      const closed = await instance(false, undefined, false, config);
      await refusedWith((await begin(await tickets.mint(), closed)).response, 'INVITATION_INVALID');
      await refusedWith((await begin(null, closed)).response, 'INVITATION_REQUIRED');
      expect(await count('user')).toBe(1);
      cookie = '';
      const options = await jsonOK(await request('/api/auth/passkey/generate-authenticate-options', undefined, { mf: closed }));
      const signedIn = await jsonOK(await request('/api/auth/passkey/verify-authentication', {
        response: authenticator.authenticate(options, origin),
      }, { mf: closed }));
      expect(signedIn.user.id).toBe(userId);
      expect((await request('/.well-known/openid-configuration', undefined, { mf: closed })).status).toBe(200);
      const result = await request(authorization(), undefined, { mf: closed });
      const target = new URL(result.headers.get('location') ?? JSON.parse(await result.text()).url);
      expect(target.searchParams.get('code')).toBeTruthy();
    }
  });

  test('malformed ADMISSION_KEYS refuse sign-up', async () => {
    const [listed] = JSON.parse(tickets.keys).keys;
    for (const value of ['not json', '[]', '{}', '{"keys":[]}', JSON.stringify(listed),
      JSON.stringify({ keys: [{ ...listed, d: listed.x }] }),
      JSON.stringify({ keys: [{ ...listed, kid: undefined }] }),
      JSON.stringify({ keys: [listed, listed] }),
      JSON.stringify({ keys: [{ ...listed, alg: 'RS256' }] }),
      JSON.stringify({ keys: [{ ...listed, crv: 'X25519' }] }),
      JSON.stringify({ keys: [{ kty: 'RSA', kid: listed.kid, n: 'AQAB', e: 'AQAB' }] })]) {
      const broken = await instance(false, undefined, false, { ADMISSION_KEYS: value });
      await refusedWith((await begin(await tickets.mint(), broken)).response, 'INVITATION_INVALID');
    }
    expect(await count('user')).toBe(0);
  });

  test('WhatsApp: a first proof for an unknown number without a ticket creates no account', async () => {
    const mf = await instance(true);
    const started = await startWhatsApp(mf, undefined, null);
    expect((await deliver(mf, started.code)).status).toBe(200);
    const status = await request('/api/auth/whatsapp/status', undefined, { mf });
    expect(await jsonOK(status)).toEqual({ status: 'invitation_required' });
    expect(status.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await count('user', mf)).toBe(0);
    expect(await jsonOK(await request('/api/auth/get-session', undefined, { mf }))).toBeNull();
  });

  test('WhatsApp: an existing phone account signs in without a ticket', async () => {
    const mf = await instance(true);
    const first = await startWhatsApp(mf);
    expect((await deliver(mf, first.code)).status).toBe(200);
    const created = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    cookie = '';
    const again = await startWhatsApp(mf, undefined, null);
    expect((await deliver(mf, again.code)).status).toBe(200);
    const signedIn = await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }));
    expect(signedIn.status).toBe('verified');
    expect(signedIn.user.id).toBe(created.user.id);
    expect(await count('user', mf)).toBe(1);
  });

  test.each([[30, 403], [15, 200]])('WhatsApp finishes %d seconds after invitation expiry', async (age, status) => {
    const mf = await instance(true);
    const first = await startWhatsApp(mf);
    expect((await deliver(mf, first.code)).status).toBe(200);
    const db = await mf.getD1Database('DB');
    await db.prepare('UPDATE whatsapp_challenge SET admissionExpiresAt = (unixepoch() - ?) * 1000').bind(age).run();
    const finished = await request('/api/auth/whatsapp/status', undefined, { mf });
    if (status === 403) {
      await refusedWith(finished, 'INVITATION_INVALID');
      expect(finished.headers.get('set-cookie')).toContain('Max-Age=0');
    } else expect((await jsonOK(finished)).status).toBe('verified');
    for (const table of ['user', 'admission_ticket', 'session']) expect(await count(table, mf)).toBe(status === 200 ? 1 : 0);
  });

  test('a phone user write failure leaves the invitation available for a fresh proof', async () => {
    const mf = await instance(true);
    const ticket = await tickets.mint();
    const first = await startWhatsApp(mf, undefined, ticket);
    expect((await deliver(mf, first.code)).status).toBe(200);
    const db = await mf.getD1Database('DB');
    await db.prepare(`CREATE TRIGGER simulate_storage_failure AFTER INSERT ON "user"
      BEGIN SELECT RAISE(ABORT, 'test storage unavailable'); END`).run();
    expect((await request('/api/auth/whatsapp/status', undefined, { mf })).status).toBe(500);
    for (const table of ['user', 'admission_ticket', 'session']) expect(await count(table, mf)).toBe(0);
    await db.prepare('DROP TRIGGER simulate_storage_failure').run();
    const retry = await startWhatsApp(mf, undefined, ticket);
    expect((await deliver(mf, retry.code)).status).toBe(200);
    expect((await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf }))).status).toBe('verified');
    for (const table of ['user', 'admission_ticket', 'session']) expect(await count(table, mf)).toBe(1);
  });

  test('WhatsApp: one ticket creates one phone account, and a used or bad ticket is refused at start', async () => {
    const mf = await instance(true);
    const ticket = await tickets.mint();
    const one = await startWhatsApp(mf, undefined, ticket);
    const oneCookie = cookie;
    cookie = '';
    const two = await startWhatsApp(mf, undefined, ticket);
    const twoCookie = cookie;
    expect((await deliver(mf, one.code, { from: '15555550160' })).status).toBe(200);
    expect((await deliver(mf, two.code, { from: '15555550161' })).status).toBe(200);
    expect((await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf, cookie: oneCookie }))).status)
      .toBe('verified');
    expect(await jsonOK(await request('/api/auth/whatsapp/status', undefined, { mf, cookie: twoCookie })))
      .toEqual({ status: 'invitation_used' });
    expect(await count('user', mf)).toBe(1);
    cookie = '';
    await refusedWith(await request('/api/auth/whatsapp/start', {}, { mf, headers: { [ADMISSION_HEADER]: ticket } }),
      'INVITATION_USED');
    await refusedWith(await request('/api/auth/whatsapp/start', {}, {
      mf, headers: { [ADMISSION_HEADER]: 'invalid-ticket' },
    }), 'INVITATION_INVALID');
    expect(await count('whatsapp_challenge', mf)).toBe(2);
  });
});

describe('session management', () => {
  // Signs in again with an existing passkey, returning the new session's cookie jar.
  async function signIn(authenticator: SoftwareAuthenticator) {
    cookie = '';
    const options = await jsonOK(await request('/api/auth/passkey/generate-authenticate-options'));
    await jsonOK(await request('/api/auth/passkey/verify-authentication', {
      response: authenticator.authenticate(options, origin),
    }));
    return cookie;
  }
  async function sessionOf(jar: string) {
    return jsonOK(await request('/api/auth/get-session', undefined, { cookie: jar }));
  }
  async function tokens() {
    const db = await runtime.getD1Database('DB');
    return (await db.prepare('SELECT id, token, userId FROM session').all<{
      id: string; token: string; userId: string;
    }>()).results;
  }
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  async function clearReads() {
    const db = await runtime.getD1Database('DB');
    await db.prepare('DELETE FROM query_log').run();
  }
  async function sessionReads() {
    const db = await runtime.getD1Database('DB');
    const rows = (await db.prepare('SELECT sql, token_hashes FROM query_log ORDER BY seq').all<{
      sql: string; token_hashes: string;
    }>()).results;
    return rows.filter(row => /\bFROM\s+"?session"?\b/i.test(row.sql));
  }

  test('list sessions shows only the caller\'s own sessions, without any token', async () => {
    const a = await signup();
    const a1 = cookie;
    const a2 = await signIn(a.authenticator);
    cookie = '';
    const b = await signup();
    expect((await request('/api/auth/list-sessions', undefined, { cookie: '' })).status).toBe(401);
    const response = await request('/api/auth/list-sessions', undefined, { cookie: a2 });
    const text = await response.clone().text();
    const listed = await jsonOK(response) as Array<Record<string, unknown>>;
    const stored = await tokens();
    expect(listed.map(session => session.id).sort()).toEqual(
      stored.filter(row => row.userId === a.userId).map(row => row.id).sort());
    expect(listed).toHaveLength(2);
    for (const session of listed) {
      expect(session.userId).toBe(a.userId);
      expect(session).not.toHaveProperty('token');
      expect(session.ipAddress).toBeTruthy();
    }
    expect(stored.some(row => row.userId === b.userId)).toBe(true);
    for (const row of stored) expect(text).not.toContain(row.token);
    expect((await sessionOf(a1)).user.id).toBe(a.userId);
  });

  test('an unauthenticated list-sessions reads no session row', async () => {
    await signup();
    await clearReads();
    expect((await request('/api/auth/list-sessions', undefined, { cookie: '' })).status).toBe(401);
    expect(await sessionReads()).toEqual([]);
  });

  test('revoking one session by id ends it and keeps the others', async () => {
    const a = await signup();
    const a1 = cookie;
    const a2 = await signIn(a.authenticator);
    const first = (await sessionOf(a1)).session.id;
    expect(await jsonOK(await request('/api/auth/revoke-session', { id: first }, { cookie: a2 })))
      .toEqual({ status: true });
    expect(await sessionOf(a1)).toBeNull();
    expect((await sessionOf(a2)).user.id).toBe(a.userId);
    const left = await jsonOK(await request('/api/auth/list-sessions', undefined, { cookie: a2 }));
    expect(left.map((session: { id: string }) => session.id)).not.toContain(first);
    expect(left).toHaveLength(1);
  });

  test('an unauthenticated revoke-session fails before any session read', async () => {
    const a = await signup();
    const a1 = cookie;
    const target = (await sessionOf(a1)).session.id;
    await clearReads();
    expect((await request('/api/auth/revoke-session', { id: target }, { cookie: '' })).status).toBe(401);
    // Authenticating first means the refusal happens before the Worker looks up any session row.
    expect(await sessionReads()).toEqual([]);
    expect((await sessionOf(a1)).user.id).toBe(a.userId);
  });

  test('another account\'s id never has its token read', async () => {
    const a = await signup();
    const a1 = cookie;
    const target = (await sessionOf(a1)).session.id;
    const targetToken = (await tokens()).find(row => row.id === target)!.token;
    cookie = '';
    await signup();
    const b1 = cookie;
    await clearReads();
    const response = await request('/api/auth/revoke-session', { id: target }, { cookie: b1 });
    // Better Auth answers the same for a session it will not touch; the session must survive.
    expect(response.status).toBe(200);
    expect(await jsonOK(response)).toEqual({ status: true });
    const reads = await sessionReads();
    // The caller's own session is read to authenticate; the target's token never is.
    expect(reads.some(row => row.token_hashes.split(',').includes(sha256(targetToken)))).toBe(false);
    // Every session lookup by id is scoped to the authenticated caller.
    for (const row of reads.filter(row => /\bid\s*=/i.test(row.sql))) {
      expect(row.sql, row.sql).toMatch(/\buserId\s*=/i);
    }
    expect((await sessionOf(a1)).user.id).toBe(a.userId);
  });

  test('revoke-sessions ends every session of the caller and no one else\'s', async () => {
    const a = await signup();
    const a1 = cookie;
    const a2 = await signIn(a.authenticator);
    cookie = '';
    await signup();
    const b1 = cookie;
    expect(await jsonOK(await request('/api/auth/revoke-sessions', {}, { cookie: a1 })))
      .toEqual({ status: true });
    expect(await sessionOf(a1)).toBeNull();
    expect(await sessionOf(a2)).toBeNull();
    expect((await tokens()).some(row => row.userId === a.userId)).toBe(false);
    expect((await sessionOf(b1)).user).toBeTruthy();
    expect((await request('/api/auth/revoke-sessions', {}, { cookie: '' })).status).toBe(401);
  });

  test('an unauthenticated revoke-sessions reads no session row', async () => {
    await signup();
    await clearReads();
    expect((await request('/api/auth/revoke-sessions', {}, { cookie: '' })).status).toBe(401);
    expect(await sessionReads()).toEqual([]);
  });

  test('another user\'s session cannot be revoked, by id or by token', async () => {
    const a = await signup();
    const a1 = cookie;
    const target = (await sessionOf(a1)).session.id;
    const token = (await tokens()).find(row => row.id === target)!.token;
    cookie = '';
    await signup();
    const b1 = cookie;
    // Better Auth answers the same for a session it will not touch; the session must survive.
    expect((await request('/api/auth/revoke-session', { id: target }, { cookie: b1 })).status).toBe(200);
    expect((await request('/api/auth/revoke-session', { id: target, token }, { cookie: b1 })).status)
      .toBe(200);
    expect((await request('/api/auth/revoke-session', { token }, { cookie: b1 })).status).toBe(400);
    expect((await request('/api/auth/revoke-session', { id: target }, { cookie: '' })).status).toBe(401);
    expect((await request('/api/auth/revoke-session', { id: 'unknown' }, { cookie: '' })).status).toBe(401);
    expect((await sessionOf(a1)).user.id).toBe(a.userId);
    expect((await sessionOf(b1)).user).toBeTruthy();
  });
});

describe('orphan account cleanup', () => {
  const hour = 60 * 60 * 1000;
  const iso = (age: number) => new Date(Date.now() - age).toISOString();
  async function cleanup() {
    const worker = await runtime.getWorker();
    await worker.scheduled({ cron: '17 * * * *', scheduledTime: new Date() });
  }
  async function insertUser(id: string, age: number, phoneNumber: string | null = null) {
    const db = await runtime.getD1Database('DB');
    await db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt,
      phoneNumber) VALUES (?, 'Automagik user', ?, 0, ?, ?, ?)`)
      .bind(id, `${id}@id.invalid`, iso(age), iso(age), phoneNumber).run();
  }
  async function count(sql: string, ...values: unknown[]) {
    const db = await runtime.getD1Database('DB');
    return (await db.prepare(sql).bind(...values).first<{ n: number }>())!.n;
  }
  async function age(userId: string, by: number) {
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE "user" SET createdAt = ? WHERE id = ?').bind(iso(by), userId).run();
  }

  test('cleanup removes an old passkeyless user with its sessions, accounts and challenges', async () => {
    // A real abandoned ceremony: an invited user requested options and never verified a passkey.
    await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined, await withTicket({})));
    const db = await runtime.getD1Database('DB');
    const user = (await db.prepare('SELECT id, createdAt FROM "user"').first<{
      id: string; createdAt: string;
    }>())!;
    expect(user.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(await count(`SELECT count(*) AS n FROM verification
      WHERE json_extract(value, '$.userData.id') = ?`, user.id)).toBe(1);
    await age(user.id, ORPHAN_MIN_AGE_MS + hour);
    const now = iso(0);
    // An expired session row goes with the user; a live one keeps the account (next test).
    await db.prepare(`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
      VALUES ('s-orphan', ?, 't-orphan', ?, ?, ?)`).bind(iso(hour), now, now, user.id).run();
    await db.prepare(`INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
      VALUES ('a-orphan', ?, 'passkey', ?, ?, ?)`).bind(user.id, user.id, now, now).run();
    await db.prepare(`INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
      VALUES ('v-other', 'other', 'not json', ?, ?, ?)`).bind(now, now, now).run();
    await cleanup();
    expect(await count('SELECT count(*) AS n FROM "user" WHERE id = ?', user.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM session WHERE userId = ?', user.id)).toBe(0);
    expect(await count('SELECT count(*) AS n FROM account WHERE userId = ?', user.id)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM verification
      WHERE json_valid(value) AND json_extract(value, '$.userData.id') = ?`, user.id)).toBe(0);
    expect(await count("SELECT count(*) AS n FROM verification WHERE id = 'v-other'")).toBe(1);
  });

  test('cleanup keeps an old user that still has a live session', async () => {
    // A passkeyless account should not have a live session, but the guard is explicit rather
    // than relying on that: a live session row means the account is in use.
    await insertUser('live', ORPHAN_MIN_AGE_MS * 30);
    const now = iso(0);
    const later = new Date(Date.now() + hour).toISOString();
    const db = await runtime.getD1Database('DB');
    await db.prepare(`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
      VALUES ('s-live', ?, 't-live', ?, ?, 'live')`).bind(later, now, now).run();
    await cleanup();
    expect(await count('SELECT count(*) AS n FROM "user" WHERE id = ?', 'live')).toBe(1);
    expect(await count("SELECT count(*) AS n FROM session WHERE id = 's-live'")).toBe(1);
  });

  test('cleanup keeps young passkeyless users, old users with a passkey and old phone accounts', async () => {
    const owner = await signup();
    await age(owner.userId, ORPHAN_MIN_AGE_MS * 30);
    // Expire the owner's session so the passkey condition, not the live-session guard, is what
    // keeps it; the guard has its own test below.
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE session SET expiresAt = ? WHERE userId = ?')
      .bind(iso(ORPHAN_MIN_AGE_MS * 2), owner.userId).run();
    await insertUser('young', ORPHAN_MIN_AGE_MS - hour);
    await insertUser('phone', ORPHAN_MIN_AGE_MS * 30, '+15555550127');
    await cleanup();
    for (const id of [owner.userId, 'young', 'phone']) {
      expect(await count('SELECT count(*) AS n FROM "user" WHERE id = ?', id), id).toBe(1);
    }
    expect(await count('SELECT count(*) AS n FROM passkey WHERE userId = ?', owner.userId)).toBe(1);
  });

  test('cleanup is bounded per run, leaves other accounts alone and finishes the backlog', async () => {
    // A real old account with a passkey must survive runs that are deleting orphans.
    const keeper = await signup();
    await age(keeper.userId, ORPHAN_MIN_AGE_MS * 30);
    for (let index = 0; index < ORPHAN_BATCH_LIMIT + 5; index++) {
      await insertUser(`orphan-${String(index).padStart(4, '0')}`, ORPHAN_MIN_AGE_MS + hour + index);
    }
    await cleanup();
    expect(await count('SELECT count(*) AS n FROM "user"')).toBe(6);
    expect(await count('SELECT count(*) AS n FROM "user" WHERE id = ?', keeper.userId)).toBe(1);
    await cleanup();
    expect(await count('SELECT count(*) AS n FROM "user"')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM "user" WHERE id = ?', keeper.userId)).toBe(1);
    expect((await jsonOK(await request('/api/auth/get-session'))).user.id).toBe(keeper.userId);
  });
});
