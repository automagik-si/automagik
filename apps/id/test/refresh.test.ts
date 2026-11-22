import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from 'vitest';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { migrate } from './migrations';
import { clientSeedSQL } from '../scripts/client-seed';
import { SoftwareAuthenticator } from './authenticator';
import { ADMISSION_HEADER, admissions, TEST_ISSUER, type Admissions } from './admission';

// Refresh tokens through the real Worker: passkey sign-in, authorize, S256 PKCE, token endpoint.
// The lifetimes asserted here are the contract in README.md, "Token lifetimes".
const origin = 'https://id.automagik.si';
const cloudSecret = 'test-only-cloud-client-secret-never-deployed';
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const verifier = 'c'.repeat(64);
const desktop = { client_id: 'automagik-desktop', redirect_uri: 'http://127.0.0.1:53001/callback' };
const cloud = { client_id: 'automagik-cloud', redirect_uri: 'https://cloud.example.com/auth/callback' };
const cloudBasic = `Basic ${Buffer.from(`automagik-cloud:${cloudSecret}`).toString('base64')}`;
const ACCESS_TTL = 15 * 60;
const ID_TTL = 15 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
let tickets: Admissions;
let bundle: string;
let root: string;
let runtime: Miniflare;
let cookie: string;
let ip: number;

beforeAll(async () => {
  tickets = await admissions(origin);
  await mkdir('.wrangler', { recursive: true });
  root = await mkdtemp('.wrangler/test-refresh-');
  bundle = resolve(root, 'worker.mjs');
  await build({
    entryPoints: ['src/index.ts'], outfile: bundle, bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', conditions: ['workerd', 'worker'],
    external: ['node:*', 'cloudflare:*'], logLevel: 'silent',
  });
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

beforeEach(async () => {
  const state = resolve(await mkdtemp(`${root}/db-`));
  runtime = new Miniflare({
    modules: [{ type: 'ESModule', path: bundle }],
    compatibilityDate: '2025-11-18', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'test-identity-database' }, d1Persist: state,
    outboundService: async request => {
      if (request.method === 'GET' && request.url === `${origin}/api/auth/jwks`) {
        return runtime.dispatchFetch(request.url);
      }
      throw new Error('Unexpected outbound network request');
    },
    bindings: {
      BETTER_AUTH_URL: origin,
      ADMISSION_KEYS: tickets.keys,
      ADMISSION_ISSUER: TEST_ISSUER,
      PASSKEY_RP_ID: 'automagik.si',
      BETTER_AUTH_SECRET: 'test-only-auth-secret-placeholder-never-deployed',
    },
  });
  const db = await runtime.getD1Database('DB');
  await migrate(db);
  for (const sql of clientSeedSQL(digest(cloudSecret)).split(';').filter(Boolean)) {
    await db.prepare(sql).run();
  }
  cookie = '';
  ip = 1;
});
afterEach(async () => { await runtime.dispose(); });

function expectNoInternalEmail(value: string) {
  expect(value).not.toContain('@id.invalid');
  for (const match of value.matchAll(/[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
    catch { continue; }
    expect(JSON.stringify(payload)).not.toContain('@id.invalid');
  }
}

async function request(path: string, body?: Record<string, unknown>, options: {
  form?: boolean; cookie?: string; headers?: Record<string, string>;
} = {}) {
  const response = await runtime.dispatchFetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(options.form ? {} : { origin }), 'cf-connecting-ip': `192.0.2.${ip++}`,
      cookie: options.cookie ?? cookie, accept: 'application/json', ...options.headers,
      ...(body === undefined ? {} : {
        'content-type': options.form ? 'application/x-www-form-urlencoded' : 'application/json',
      }),
    },
    body: body === undefined ? undefined : options.form ?
      new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    redirect: 'manual',
  });
  for (const [name, value] of response.headers) {
    expectNoInternalEmail(name);
    expectNoInternalEmail(value);
  }
  expectNoInternalEmail(await response.clone().text());
  const jar = new Map(cookie.split('; ').filter(Boolean).map(entry => {
    const at = entry.indexOf('=');
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  for (const entry of response.headers.getSetCookie()) {
    const [pair] = entry.split(';');
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  return response;
}

type WorkerResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;

async function jsonOK(response: WorkerResponse) {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return JSON.parse(text);
}

async function signup() {
  const authenticator = new SoftwareAuthenticator();
  const options = await jsonOK(await request('/api/auth/passkey/generate-register-options', undefined, {
    headers: { [ADMISSION_HEADER]: await tickets.mint() },
  }));
  const result = await jsonOK(await request('/api/auth/passkey/verify-registration', {
    response: authenticator.register(options, origin), createSession: true,
  }));
  const session = result.redirect ? await jsonOK(await request('/api/auth/get-session')) : result;
  expect(session.session.userId).toBeTruthy();
  return session.session.userId as string;
}

/** Authorize and exchange the code; returns the token response. */
async function signIn(client = desktop, scope = 'openid profile offline_access') {
  const query = new URLSearchParams({
    ...client, response_type: 'code', scope, state: 'refresh-state', nonce: 'refresh-nonce',
    code_challenge: digest(verifier), code_challenge_method: 'S256',
  });
  const response = await request('/api/auth/oauth2/authorize?' + query);
  const body = await response.text();
  const target = new URL(response.headers.get('location') ?? JSON.parse(body).url, origin);
  expect(target.searchParams.has('error'), target.search).toBe(false);
  const code = target.searchParams.get('code');
  expect(code, body).toBeTruthy();
  return jsonOK(await request('/api/auth/oauth2/token', {
    grant_type: 'authorization_code', ...client, code: code!, code_verifier: verifier,
  }, { form: true, cookie: '', headers: client === cloud ? { authorization: cloudBasic } : {} }));
}

function refresh(token: string, client_id = desktop.client_id, headers: Record<string, string> = {}) {
  return request('/api/auth/oauth2/token', { grant_type: 'refresh_token', client_id, refresh_token: token },
    { form: true, cookie: '', headers });
}

async function expectInvalid(response: WorkerResponse, error = 'invalid_grant', status = 400) {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  expect(JSON.parse(text).error, text).toBe(error);
}

function userinfo(accessToken: string) {
  return request('/api/auth/oauth2/userinfo', undefined, {
    cookie: '', headers: { authorization: `Bearer ${accessToken}` },
  });
}

describe('refresh tokens', () => {
  test('a refresh token is issued only with offline_access', async () => {
    await signup();
    const without = await signIn(desktop, 'openid profile');
    expect(without.access_token).toBeTruthy();
    expect(without.id_token).toBeTruthy();
    expect(without.refresh_token).toBeUndefined();
    // No consent prompt is needed: both first-party clients skip consent.
    const withOffline = await signIn();
    expect(withOffline.refresh_token).toBeTruthy();
    expect(withOffline.scope.split(' ').sort()).toEqual(['offline_access', 'openid', 'profile']);
    const db = await runtime.getD1Database('DB');
    expect((await db.prepare('SELECT count(*) AS n FROM oauthRefreshToken').first<{ n: number }>())!.n)
      .toBe(1);
  });

  test('token lifetimes are 15 minutes for access and ID tokens and 30 days for refresh tokens', async () => {
    await signup();
    for (const tokens of [await signIn(), await signIn(cloud)]) {
      expect(tokens.expires_in).toBe(ACCESS_TTL);
      const id = decodeJwt(tokens.id_token);
      expect(id.exp! - id.iat!).toBe(ID_TTL);
      const refreshed = await jsonOK(await refresh(tokens.refresh_token, id.aud as string,
        id.aud === cloud.client_id ? { authorization: cloudBasic } : {}));
      expect(refreshed.expires_in).toBe(ACCESS_TTL);
      const refreshedId = decodeJwt(refreshed.id_token);
      expect(refreshedId.exp! - refreshedId.iat!).toBe(ID_TTL);
    }
    const db = await runtime.getD1Database('DB');
    const rows = (await db.prepare('SELECT createdAt, expiresAt FROM oauthRefreshToken').all<any>()).results;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect((new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime()) / 1000).toBe(REFRESH_TTL);
    }
  });

  test('refreshing rotates: new access and refresh tokens, and the old refresh token then fails', async () => {
    const userId = await signup();
    const first = await signIn();
    const second = await jsonOK(await refresh(first.refresh_token));
    expect(second.refresh_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.scope.split(' ').sort()).toEqual(['offline_access', 'openid', 'profile']);
    // The refreshed tokens identify the person and never carry the internal address.
    const metadata = await jsonOK(await request('/.well-known/openid-configuration'));
    const jwks = createLocalJWKSet(await jsonOK(await request(new URL(metadata.jwks_uri).pathname)));
    const id = await jwtVerify(second.id_token, jwks, { issuer: metadata.issuer, audience: desktop.client_id });
    expect(id.payload.sub).toBe(userId);
    expect(id.payload.email).toBeUndefined();
    expectNoInternalEmail(JSON.stringify(second));
    const user = await jsonOK(await userinfo(second.access_token));
    expect(user.sub).toBe(userId);
    expect(user.email).toBeUndefined();
    await expectInvalid(await refresh(first.refresh_token));
  });

  // Pins the pinned plugin's reuse detection (refreshTokenReuseInterval 0): presenting a rotated
  // refresh token deletes every refresh token the user holds for that client, plus their access
  // tokens. That is wider than one rotation family: a second sign-in on the same client goes too.
  // Other clients' tokens survive.
  test('reusing a rotated refresh token revokes every refresh token of that user and client', async () => {
    await signup();
    const first = await signIn();
    const otherSignIn = await signIn();
    const cloudTokens = await signIn(cloud);
    const rotated = await jsonOK(await refresh(first.refresh_token));
    expect((await userinfo(rotated.access_token)).status).toBe(200);
    await expectInvalid(await refresh(first.refresh_token));
    await expectInvalid(await refresh(rotated.refresh_token));
    await expectInvalid(await refresh(otherSignIn.refresh_token));
    expect((await userinfo(rotated.access_token)).status).toBe(401);
    const db = await runtime.getD1Database('DB');
    expect((await db.prepare('SELECT count(*) AS n FROM oauthRefreshToken WHERE clientId = ?')
      .bind(desktop.client_id).first<{ n: number }>())!.n).toBe(0);
    await jsonOK(await refresh(cloudTokens.refresh_token, cloud.client_id, { authorization: cloudBasic }));
  });

  test('an expired refresh token fails', async () => {
    await signup();
    const tokens = await signIn();
    const db = await runtime.getD1Database('DB');
    await db.prepare('UPDATE oauthRefreshToken SET expiresAt = ?').bind(Date.now() - 1000).run();
    await expectInvalid(await refresh(tokens.refresh_token));
  });

  test('a refresh token is bound to its client; a confidential client must authenticate', async () => {
    await signup();
    const desktopTokens = await signIn();
    const cloudTokens = await signIn(cloud);
    // Another client, even authenticated, cannot spend this client's token.
    await expectInvalid(await refresh(desktopTokens.refresh_token, cloud.client_id, { authorization: cloudBasic }));
    await expectInvalid(await refresh(cloudTokens.refresh_token, desktop.client_id));
    // A disabled client is refused before the token is looked at.
    await expectInvalid(await refresh(desktopTokens.refresh_token, 'arca'), 'invalid_client');
    // The confidential client needs its secret. A wrong one fails too, with 401 because the
    // client attempted Basic authentication (RFC 6749 section 5.2).
    await expectInvalid(await refresh(cloudTokens.refresh_token, cloud.client_id), 'invalid_client');
    await expectInvalid(await refresh(cloudTokens.refresh_token, cloud.client_id, {
      authorization: `Basic ${Buffer.from('automagik-cloud:wrong-secret').toString('base64')}`,
    }), 'invalid_client', 401);
    // None of those attempts spent either token.
    await jsonOK(await refresh(desktopTokens.refresh_token));
    await jsonOK(await refresh(cloudTokens.refresh_token, cloud.client_id, { authorization: cloudBasic }));
  });

  test('revoking a refresh token makes it fail; another client cannot revoke it', async () => {
    await signup();
    const tokens = await signIn();
    const foreign = await request('/api/auth/oauth2/revoke', {
      token: tokens.refresh_token, token_type_hint: 'refresh_token',
    }, { form: true, cookie: '', headers: { authorization: cloudBasic } });
    expect(foreign.status).toBe(200);
    const live = await jsonOK(await refresh(tokens.refresh_token));
    const revoked = await request('/api/auth/oauth2/revoke', {
      client_id: desktop.client_id, token: live.refresh_token, token_type_hint: 'refresh_token',
    }, { form: true, cookie: '' });
    expect(revoked.status).toBe(200);
    await expectInvalid(await refresh(live.refresh_token));
    expect((await userinfo(live.access_token)).status).toBe(401);
  });
});
