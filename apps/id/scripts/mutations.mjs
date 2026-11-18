import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

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
    name: 'let CI skip the page browser tests',
    test: 'the CI job runs the browser tests',
    edits: [['../../.github/workflows/ci.yml', 'ID_PAGES_BROWSER: required', 'ID_PAGES_BROWSER: optional']],
  },
  // The invite gate (RFC 0032, Decided 9).
  {
    name: 'invite gate removed',
    test: 'sign-up without a ticket is refused before any row',
    edits: [['src/auth.ts', 'const id = await admitSignup(env, endpoint.headers?.get(ADMISSION_HEADER));',
      "const id = crypto.randomUUID().replace(/-/g, '');"]],
  },
  {
    name: 'admission signature not checked',
    test: 'refused with no row: wrong signature',
    edits: [['src/admission.ts', "const verified = await compactVerify(token, key, { algorithms: ['EdDSA'] });",
      "const verified = { payload: Buffer.from(token.split('.')[1], 'base64url') };"]],
  },
  {
    name: 'admission aud not checked',
    test: 'refused with no row: wrong aud',
    edits: [['src/admission.ts', 'if (!audienceMatches(payload.aud, new URL(env.BETTER_AUTH_URL).origin))', 'if (false)']],
  },
  {
    name: 'admission exp not checked',
    test: 'refused with no row: expired',
    edits: [['src/admission.ts', 'if ((exp as number) <= seconds - ADMISSION_SKEW)', 'if (false)']],
  },
  {
    name: 'admission jti reuse allowed',
    test: 'a used ticket is refused',
    edits: [['src/admission.ts', "WHERE admission_ticket.state = 'pending' AND admission_ticket.ceremonies",
      'WHERE admission_ticket.ceremonies']],
  },
  {
    name: 'missing admission keys allow sign-up',
    test: 'no ADMISSION_KEYS: sign-up is refused',
    edits: [['src/admission.ts', 'if (!keys || !issuer) throw invalid();',
      'if (!keys || !issuer) return { jti: crypto.randomUUID(), expiresAt: now + 60_000 };']],
  },
  {
    name: 'phone path ungated',
    test: 'unknown number without a ticket creates no account',
    edits: [['src/whatsapp.ts', 'if (!admittedId) {', 'if (false) {']],
  },
  {
    name: "a ticket's second ceremony completes",
    test: 'second ceremony cannot finish after its first',
    edits: [['src/gate.ts', "if (!(await claimSignup(env.DB, userId))) throw refusal('INVITATION_USED');",
      'await claimSignup(env.DB, userId);']],
  },
  {
    name: 'admission iss not checked',
    test: 'refused with no row: wrong iss',
    edits: [['src/admission.ts', 'if (payload.iss !== issuer)', 'if (false)']],
  },
  {
    name: 'admission use not checked',
    test: 'refused with no row: use not signup',
    edits: [['src/admission.ts', 'if (payload.use !== use)', 'if (false)']],
  },
  {
    name: 'admission life not capped at 15 minutes',
    test: 'refused with no row: life over 15 minutes',
    edits: [['src/admission.ts', ' || (exp as number) - (iat as number) > ADMISSION_MAX_LIFE', '']],
  },
  {
    name: 'accept a private key in ADMISSION_KEYS',
    test: 'admission settings are validated',
    edits: [['src/admission.ts', "if ('d' in key || key.kty", 'if (key.kty']],
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
      await writeFile(file, current.replace(before, after));
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
    for (const [file, original] of originals) await writeFile(file, original);
  }
}
