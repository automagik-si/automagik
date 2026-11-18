// Admission tickets for tests: a key made per run, never a real one. Every test that creates an
// account gets its ticket from here.
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomBytes } from 'node:crypto';

export const TEST_ISSUER = 'https://cloud.example.com';
export { ADMISSION_HEADER } from '../src/admission';

type Claims = Record<string, unknown>;

export interface Admissions {
  /** The ADMISSION_KEYS value for this run's key. */
  keys: string;
  kid: string;
  /** A fresh sign-up ticket; a claim set to undefined is left out. */
  mint(claims?: Claims, header?: Record<string, unknown>): Promise<string>;
  /** The same ticket shape signed by another key under this run's kid. */
  forge(claims?: Claims): Promise<string>;
  /** An unsigned token (`alg: none`). */
  unsigned(claims?: Claims): string;
  /** A token signed with HS256, using the public key's bytes as the secret. */
  symmetric(claims?: Claims): Promise<string>;
  jti(): string;
}

export async function admissions(audience: string): Promise<Admissions> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const keys = JSON.stringify({ keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] });
  const jti = () => randomBytes(18).toString('base64url');
  const payload = (claims: Claims = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const all: Claims = { iss: TEST_ISSUER, aud: audience, jti: jti(), iat: now, exp: now + 600, use: 'signup', ...claims };
    for (const [name, value] of Object.entries(all)) if (value === undefined) delete all[name];
    return all;
  };
  const sign = (claims: Claims | undefined, key: CryptoKey, header: Record<string, unknown> = {}) =>
    new SignJWT(payload(claims)).setProtectedHeader({ alg: 'EdDSA', kid, ...header }).sign(key);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    keys, kid, jti,
    mint: (claims, header) => sign(claims, privateKey, header),
    forge: claims => sign(claims, other.privateKey),
    unsigned: claims => `${part({ alg: 'none', kid })}.${part(payload(claims))}.`,
    symmetric: claims => new SignJWT(payload(claims)).setProtectedHeader({ alg: 'HS256', kid })
      .sign(new TextEncoder().encode(String(jwk.x))),
  };
}
