import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// node_modules files may be hard links into the package manager's cache: replace, never rewrite.
const PLUGIN = 'node_modules/@better-auth/oauth-provider/dist/authorize-PV1rSogq.mjs';
async function replaceFile(file, text) {
  const temporary = `${file}.mutation-tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

const mutations = [
  {
    name: 'restore the untrimmed registration cookie name',
    test: 'registration ignores whitespace session cookies',
    edits: [['src/index.ts', "part.split('=', 1)[0].trim()", "part.trim().split('=')[0]"]],
  },
  {
    name: 'drop the sign-out before Create a passkey',
    test: 'signed-in Create a passkey creates a fresh account',
    edits: [['pages/id.js', "if (signedIn) { await call('/api/auth/sign-out', {}); signedIn = false; }", '']],
  },
  {
    name: 'drop the inbound bearer check',
    test: 'WhatsApp bearer check',
    edits: [['src/whatsapp.ts', 'if (!authorized)', 'if (false)']],
  },
  {
    name: 'drop the message timestamp window',
    test: 'WhatsApp timestamp window',
    edits: [['src/whatsapp.ts', 'if (!timestampValid)', 'if (false)']],
  },
  {
    name: 'allow WhatsApp code reuse',
    test: 'IDs are independently idempotent',
    edits: [['src/whatsapp.ts', "AND state = 'pending' AND expiresAt > ?", 'AND expiresAt > ?']],
  },
  {
    name: "link to the session's account",
    test: 'never links the current passkey account',
    edits: [
      ['src/whatsapp.ts', 'createAuthEndpoint, APIError', 'createAuthEndpoint, APIError, getSessionFromCtx'],
      ['src/whatsapp.ts', 'let user = await findPhoneUser();',
        'let user = (await getSessionFromCtx(ctx))?.user ?? await findPhoneUser();'],
    ],
  },
  {
    name: 'restore the email-bearing session JWT header',
    test: 'internal email stays out',
    edits: [['src/auth.ts', 'disableSettingJwtHeader: true', 'disableSettingJwtHeader: false']],
  },
  {
    name: 'allow phone-number linking flags',
    test: 'phone linking flags cannot select',
    edits: [['src/whatsapp.ts', "Object.keys(body).some(key => key !== 'oauth_query')", 'false']],
  },
  {
    name: 'drop PKCE enforcement',
    test: 'plain and missing PKCE',
    edits: [['scripts/client-seed.ts', 'requirePKCE: true', 'requirePKCE: false']],
  },
  {
    name: 'allow any redirect',
    test: 'registered native loopback',
    edits: [['src/auth.ts', 'validateRedirectUri: strictRedirectUri', 'validateRedirectUri: () => true']],
  },
  {
    name: 'turn public registration on',
    test: 'unsupported sign-in',
    edits: [
      ['src/auth.ts', 'allowDynamicClientRegistration: false', 'allowDynamicClientRegistration: true'],
      ['src/auth.ts', 'allowUnauthenticatedClientRegistration: false', 'allowUnauthenticatedClientRegistration: true'],
      ['src/index.ts', "'/oauth2/public-client-prelogin',", "'/oauth2/public-client-prelogin', '/oauth2/register',"],
    ],
  },
  {
    name: 'store the rate limit in memory',
    test: 'D1 rate limit survives',
    edits: [['src/auth.ts', "storage: 'database'", "storage: 'memory'"]],
  },
  {
    name: 'serve a page file directly as .html',
    test: 'direct .html paths answer 404',
    edits: [['src/index.ts', 'if (directPage(url.pathname)) return', 'if (false) return']],
  },
  {
    name: 'take the passkey site name from the service host',
    test: 'registration and sign-in options carry the site name automagik.si',
    edits: [['src/auth.ts', '        rpID,', '        rpID: new URL(origin).hostname,']],
  },
  {
    name: 'start on a host outside the passkey site name',
    test: 'a host outside the site name is refused',
    edits: [['src/site.ts', 'if (!hostUnderSiteName(host, siteName))', 'if (false)']],
  },
  {
    name: 'accept a look-alike host ending in the site name',
    test: 'a host outside the site name is refused',
    edits: [['src/site.ts', 'host.endsWith(`.${siteName}`)', 'host.endsWith(siteName)']],
  },
  {
    name: 'let configure accept a workers.dev origin',
    test: 'a host outside automagik.si, a workers.dev one included, is refused',
    edits: [['scripts/configure.ts', '!hostUnderSiteName(origin.hostname, PASSKEY_SITE_NAME)', 'false']],
  },
  {
    name: 'let cleanup ignore the passkey condition',
    test: 'cleanup keeps young passkeyless users',
    edits: [['src/cleanup.ts', 'AND NOT EXISTS (SELECT 1 FROM passkey p WHERE p.userId = u.id)', '']],
  },
  {
    name: 'let cleanup ignore the age cutoff',
    test: 'cleanup keeps young passkeyless users',
    edits: [['src/cleanup.ts', 'WHERE u.createdAt < ?1', 'WHERE ?1 IS NOT NULL']],
  },
  {
    name: 'let cleanup remove phone accounts',
    test: 'cleanup keeps young passkeyless users',
    edits: [['src/cleanup.ts', 'AND u.phoneNumber IS NULL', '']],
  },
  {
    name: 'let cleanup ignore the batch limit',
    test: 'cleanup is bounded per run',
    edits: [['src/cleanup.ts', 'LIMIT ?2', 'LIMIT -1 + 0 * ?2']],
  },
  {
    name: 'return session tokens in the session list',
    test: 'list sessions shows only',
    edits: [['src/index.ts', "['email', 'emailVerified', 'token']", 'undefined']],
  },
  {
    name: 'let CI skip the page browser tests',
    test: 'the CI job runs the browser tests',
    edits: [['../../.github/workflows/ci.yml', 'ID_PAGES_BROWSER: required', 'ID_PAGES_BROWSER: optional']],
  },
  {
    name: 'drop the Content-Security-Policy',
    test: 'security headers on every answer',
    edits: [['src/index.ts', "'content-security-policy': \"default-src", "'x-csp-dropped': \"default-src"]],
  },
  {
    name: 'let inline script run',
    test: 'security headers on every answer',
    edits: [['src/index.ts', "script-src 'self'; style", "script-src 'self' 'unsafe-inline'; style"]],
  },
  {
    name: 'drop nosniff',
    test: 'security headers on every answer',
    edits: [['src/index.ts', "  'x-content-type-options': 'nosniff',\n", '']],
  },
  {
    name: 'send static files and API answers without the headers',
    test: 'security headers on every answer',
    edits: [['src/index.ts', 'return withSecurityHeaders(await router.route(request, env, ctx));',
      'return router.route(request, env, ctx);']],
  },
  {
    name: 'let a direct .html path bypass the page',
    test: 'security headers on every answer',
    edits: [['src/index.ts', 'if (directPage(url.pathname)) return', 'if (false) return']],
  },
  {
    name: 'rebuild the headers and lose the cookies',
    test: 'security headers keep Better Auth redirects',
    edits: [['src/index.ts', '  const headers = new Headers(response.headers);\n  for (const [name',
      '  const headers = new Headers();\n  for (const [name']],
  },
  {
    name: 'lengthen the access token lifetime',
    test: 'token lifetimes are 15 minutes',
    edits: [['src/auth.ts', 'ACCESS_TOKEN_TTL = 15 * 60;', 'ACCESS_TOKEN_TTL = 60 * 60;']],
  },
  {
    name: 'lengthen the ID token lifetime',
    test: 'token lifetimes are 15 minutes',
    edits: [['src/auth.ts', 'ID_TOKEN_TTL = 15 * 60;', 'ID_TOKEN_TTL = 10 * 60 * 60;']],
  },
  {
    name: 'lengthen the refresh token lifetime',
    test: 'token lifetimes are 15 minutes',
    edits: [['src/auth.ts', 'REFRESH_TOKEN_TTL = 30 * 24', 'REFRESH_TOKEN_TTL = 90 * 24']],
  },
  {
    name: 'let a rotated refresh token be replayed for an hour',
    test: 'refreshing rotates',
    edits: [['src/auth.ts', 'REFRESH_TOKEN_REUSE_INTERVAL = 0;', 'REFRESH_TOKEN_REUSE_INTERVAL = 3600;']],
  },
  // The pinned plugin's own refresh checks: a version bump that drops one must fail a test.
  {
    name: 'issue a refresh token without offline_access',
    test: 'issued only with offline_access',
    edits: [[PLUGIN, '(existingRefreshToken?.scopes?.includes("offline_access") || scopes.includes("offline_access"))', 'true']],
  },
  {
    name: 'stop retiring a rotated refresh token',
    test: 'refreshing rotates',
    edits: [[PLUGIN, 'revoked: rotatedAt,', 'revoked: null,']],
  },
  {
    name: 'accept an expired refresh token',
    test: 'an expired refresh token fails',
    edits: [[PLUGIN, 'if (refreshToken.expiresAt < /* @__PURE__ */ new Date())', 'if (false)']],
  },
  {
    name: 'drop the refresh token client binding',
    test: 'a refresh token is bound to its client',
    edits: [[PLUGIN, 'if (refreshToken.clientId !== client_id)', 'if (false)']],
  },
  {
    name: 'ignore refresh token revocation',
    test: 'revoking a refresh token makes it fail',
    edits: [[PLUGIN, 'set: { revoked: /* @__PURE__ */ new Date(iat * 1e3) }', 'set: {}']],
  },
];

const selectedMutation = process.env.ID_MUTATION;
if (selectedMutation && !mutations.some(mutation => mutation.name === selectedMutation)) {
  throw new Error('Unknown mutation name');
}
await mkdir('.wrangler', { recursive: true });
for (const [index, mutation] of mutations.entries()) {
  if (selectedMutation && mutation.name !== selectedMutation) continue;
  const announcement = `Mutation check: ${mutation.name}.`;
  process.stdout.write(`${announcement}\n`);
  const originals = new Map();
  try {
    for (const [file, before, after] of mutation.edits) {
      const current = await readFile(file, 'utf8');
      if (!originals.has(file)) originals.set(file, current);
      if (current.split(before).length !== 2) throw new Error(`Ambiguous mutation in ${file}`);
      await replaceFile(file, current.replace(before, after));
    }
    const result = spawnSync('bun', ['run', 'test', '--', '-t', mutation.test], {
      encoding: 'utf8', timeout: 60000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    await writeFile(`.wrangler/mutation-${index + 1}.log`, output);
    if (result.status !== 1 || !output.includes('AssertionError')) {
      throw new Error(`${mutation.name}: survived or infrastructure failed; see mutation-${index + 1}.log`);
    }
    process.stdout.write(`${mutation.name}: KILLED (assertion failed)\n`);
  } finally {
    for (const [file, original] of originals) await replaceFile(file, original);
  }
}
