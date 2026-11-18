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
  // Passkeys on an existing account.
  {
    name: 'drop the fresh sign-in age check',
    test: 'a stale session cannot add or delete a passkey',
    edits: [['src/passkeys.ts', '.getTime() >= FRESH_SIGN_IN_MS)', '.getTime() >= Infinity)']],
  },
  {
    name: 'drop the session requirement on adding a passkey',
    test: 'adding a passkey without a session is refused and creates no account',
    edits: [['src/passkeys.ts', 'if (!session) throw unauthorized();', '']],
  },
  {
    name: 'drop the last-passkey guard',
    test: 'the last one is refused without a phone number',
    edits: [['src/passkeys.ts', 'AND ${KEEPS_A_WAY_IN}', '']],
  },
  {
    name: 'drop the ownership check on delete',
    test: "someone else's passkey cannot be deleted",
    edits: [['src/passkeys.ts', 'WHERE id = ?1 AND userId = ?2', 'WHERE id = ?1']],
  },
  {
    name: 'accept any sign-in method as fresh',
    test: 'a WhatsApp sign-in session cannot add a passkey',
    edits: [['src/passkeys.ts', "if (session?.session.signInMethod !== 'passkey')", 'if (!session)']],
  },
  {
    name: 'let an add request create an account',
    test: 'an add request never creates an account',
    edits: [['src/passkeys.ts', 'if (ctx?.headers?.get(ADD_PASSKEY_HEADER)) throw unauthorized();', '']],
  },
  {
    name: 'let a client mark an account-creation request',
    test: 'drops a client-sent add-passkey mark',
    edits: [['src/index.ts', 'headers.delete(ADD_PASSKEY_HEADER);', '']],
  },
  {
    name: 'let adding a passkey start another session',
    test: 'a second passkey added after a fresh sign-in',
    edits: [['src/passkeys.ts', 'return { context: { body: { ...body, createSession: false } } };', '']],
  },
  {
    name: 'return the stored passkey row from the add route',
    test: 'a second passkey added after a fresh sign-in',
    edits: [['src/index.ts', 'passkeyView(JSON.parse(text))', 'publicData(JSON.parse(text))']],
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
