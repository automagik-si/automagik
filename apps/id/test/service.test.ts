import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { clientSeedSQL } from '../scripts/client-seed';
import { SoftwareAuthenticator } from './authenticator';

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

beforeAll(async () => {
  await mkdir('.wrangler', { recursive: true });
  root = await mkdtemp('.wrangler/test-');
  bundle = resolve(root, 'worker.mjs');
  await build({
    entryPoints: ['src/index.ts'], outfile: bundle, bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker'],
    external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
  });
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
      ...(whatsapp ? { WHATSAPP_RECEIVING_NUMBER: '15555550100', OMNI_INBOUND_TOKEN: inboundToken } : {}),
      ...config,
    },
  });
  runtimes.push(mf);
  return mf;
}

beforeEach(async () => {
  state = resolve(await mkdtemp(`${root}/db-`));
  runtimes = [];
  runtime = await instance();
  const db = await runtime.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    const migration = await readFile(`migrations/${file}`, 'utf8');
    for (const sql of migration.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  }
  for (const sql of clientSeedSQL(digest(cloudSecret)).split(';').filter(Boolean)) {
    await db.prepare(sql).run();
  }
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

async function signup(oauth_query?: string) {
  const authenticator = new SoftwareAuthenticator();
  const options = await jsonOK(await request('/api/auth/passkey/generate-register-options'));
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

async function startWhatsApp(mf: Miniflare, oauth_query?: string) {
  const response = await request('/api/auth/whatsapp/start', oauth_query ? { oauth_query } : {}, { mf });
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
      cookie: step === 'verification' ? originalCookie : spaced(originalCookie), headers,
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
      duplicateCookie(originalCookie)));
    const second = await jsonOK(await request('/api/auth/passkey/verify-registration', {
      response: new SoftwareAuthenticator().register(options, origin), createSession: true,
    }, duplicateCookie(cookie)));
    expect(second.session.userId).not.toBe(first.userId);
  });

  test('session cookie names are case-sensitive in Better Call', async () => {
    const first = await signup();
    const differentCase = cookie.replace(/session_token/g, 'SESSION_TOKEN');
    expect(await jsonOK(await request('/api/auth/get-session', undefined, { cookie: differentCase }))).toBeNull();
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined, {
      cookie: differentCase,
    }));
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
    await jsonOK(await request('/api/auth/passkey/generate-register-options'));
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
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options'));
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
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options'));
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
      headers: { origin: base, accept: 'application/json', 'cf-connecting-ip': `192.0.2.${ip++}` },
    });
  }

  test('registration and sign-in options carry the site name automagik.si, not the service host', async () => {
    const options = await jsonOK(await request('/api/auth/passkey/generate-register-options'));
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
