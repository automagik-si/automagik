// The operator's stand-in for Cloud's admission tickets, until Cloud mints them itself.
//
//   bun scripts/admission.ts keygen <path>   writes a new Ed25519 private JWK to <path> only
//                                            (mode 0600, never inside a git checkout) and
//                                            prints the public JWKS for ADMISSION_KEYS
//   bun scripts/admission.ts mint            prints one sign-up ticket, signed with the
//                                            private JWK in ADMISSION_PRIVATE_KEY, for
//                                            ADMISSION_ISSUER and the ID at ID_WORKER_ORIGIN
//
// The private key never goes through argv, stdout or a log. `mint` reads it from the
// environment only; pass it from the secret store, never in shell history.
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { ADMISSION_MAX_LIFE, parseAdmissionIssuer } from '../src/admission';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** The nearest folder at or above `path` holding a `.git` entry (a checkout or a worktree). */
function checkoutAbove(path: string): string | null {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

async function keygen(target: string | undefined) {
  if (!target) fail('usage: bun scripts/admission.ts keygen <path>');
  const given = dirname(resolve(target));
  if (!existsSync(given) || !lstatSync(given).isDirectory()) fail('The folder for the key does not exist');
  // The real folder, so a symbolic link cannot lead the key into a checkout.
  const folder = realpathSync(given);
  const path = resolve(folder, basename(target));
  if (checkoutAbove(folder)) fail('Refusing to write a private key inside a git checkout');
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pub = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint({ kty: pub.kty, crv: pub.crv, x: pub.x });
  const secret = { ...(await exportJWK(privateKey)), kid, alg: 'EdDSA', use: 'sig' };
  try {
    // 'wx' never replaces an existing file.
    await writeFile(path, `${JSON.stringify(secret)}\n`, { mode: 0o600, flag: 'wx' });
  } catch {
    fail('Could not create the key file (does it already exist?)');
  }
  await chmod(path, 0o600);
  process.stdout.write(`${JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid, alg: 'EdDSA', use: 'sig' }] })}\n`);
}

async function mint(extra: string[]) {
  if (extra.length) fail('mint takes no arguments: the key comes from ADMISSION_PRIVATE_KEY');
  let jwk: Record<string, unknown>;
  try { jwk = JSON.parse(process.env.ADMISSION_PRIVATE_KEY ?? ''); } catch { fail('Set ADMISSION_PRIVATE_KEY to the private JWK'); }
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' ||
      typeof jwk.x !== 'string' || typeof jwk.kid !== 'string') {
    fail('ADMISSION_PRIVATE_KEY is not an Ed25519 private JWK with a kid');
  }
  const issuer = parseAdmissionIssuer(process.env.ADMISSION_ISSUER);
  if (!issuer) fail('Set ADMISSION_ISSUER to the HTTPS issuer the ID expects');
  let audience: string;
  try { audience = new URL(process.env.ID_WORKER_ORIGIN ?? '').origin; } catch { fail('Set ID_WORKER_ORIGIN'); }
  if (!audience.startsWith('https://')) fail('ID_WORKER_ORIGIN must be an HTTPS origin');
  let key: CryptoKey | Uint8Array;
  try { key = await importJWK(jwk, 'EdDSA'); } catch { fail('ADMISSION_PRIVATE_KEY could not be read'); }
  const now = Math.floor(Date.now() / 1000);
  const jti = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
  const ticket = await new SignJWT({ use: 'signup' })
    .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid as string })
    .setIssuer(issuer).setAudience(audience).setJti(jti)
    .setIssuedAt(now).setExpirationTime(now + ADMISSION_MAX_LIFE)
    .sign(key);
  process.stdout.write(`${ticket}\n`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'keygen' && rest.length <= 1) await keygen(rest[0]);
else if (command === 'mint') await mint(rest);
else fail('usage: bun scripts/admission.ts keygen <path> | mint');
