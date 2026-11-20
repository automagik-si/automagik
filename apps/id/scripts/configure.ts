import { readFile, writeFile } from 'node:fs/promises';
import { hostUnderSiteName, PASSKEY_SITE_NAME } from '../src/site';
import { parseAdmissionIssuer, parseAdmissionKeys } from '../src/admission';

// Passkeys are bound to the site name automagik.si, so the service's host is that name or
// a subdomain of it: a workers.dev address can never carry it.
const origin = new URL(process.env.ID_WORKER_ORIGIN ?? '');
if (origin.protocol !== 'https:' || !hostUnderSiteName(origin.hostname, PASSKEY_SITE_NAME) ||
    origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
    origin.port) {
  throw new Error(`ID_WORKER_ORIGIN must be an HTTPS origin on ${PASSKEY_SITE_NAME} or a subdomain of it`);
}
// URL also accepts wildcards and other labels that cannot name a public HTTPS host.
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
if (origin.hostname.length > 253 || !origin.hostname.split('.').every(label => dnsLabel.test(label))) {
  throw new Error('ID_WORKER_ORIGIN must name a concrete DNS hostname for the Custom Domain');
}
const databaseId = process.env.ID_DATABASE_ID ?? '';
if (!/^[0-9a-f-]{36}$/i.test(databaseId)) throw new Error('Set ID_DATABASE_ID');
const receiving = process.env.WHATSAPP_RECEIVING_NUMBER;
if (receiving && !/^\+?[1-9]\d{7,14}$/.test(receiving)) throw new Error('Invalid receiving number');
// Admission tickets (invite-only sign-up): Cloud's public keys and issuer. Both or neither;
// without them no account can be created. Only public keys are accepted, never a private one.
const admissionKeysRaw = process.env.ADMISSION_KEYS;
const admissionIssuerRaw = process.env.ADMISSION_ISSUER;
if (!admissionKeysRaw !== !admissionIssuerRaw) throw new Error('Set ADMISSION_KEYS and ADMISSION_ISSUER together');
const admissionKeys = admissionKeysRaw ? parseAdmissionKeys(admissionKeysRaw) : null;
if (admissionKeysRaw && !admissionKeys) {
  throw new Error('ADMISSION_KEYS must be a JWKS of Ed25519 public keys, each with a unique kid, and no private key');
}
const admissionIssuer = admissionIssuerRaw ? parseAdmissionIssuer(admissionIssuerRaw) : null;
if (admissionIssuerRaw && !admissionIssuer) throw new Error('ADMISSION_ISSUER must be an HTTPS URL');
if (!admissionKeys) process.stderr.write('ADMISSION_KEYS is not set: no account can be created\n');
const template = await readFile('wrangler.toml', 'utf8');
await writeFile('wrangler.local.toml', template + '\n[vars]\n' +
  `BETTER_AUTH_URL = ${JSON.stringify(origin.origin)}\n` +
  `PASSKEY_RP_ID = ${JSON.stringify(PASSKEY_SITE_NAME)}\n` +
  (receiving ? `WHATSAPP_RECEIVING_NUMBER = ${JSON.stringify(receiving)}\n` : '') +
  (admissionKeys ? `ADMISSION_KEYS = ${JSON.stringify(JSON.stringify({ keys: admissionKeys }))}\n` +
    `ADMISSION_ISSUER = ${JSON.stringify(admissionIssuer)}\n` : '') +
  '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "automagik-id"\n' +
  `database_id = ${JSON.stringify(databaseId)}\nmigrations_dir = "migrations"\n` +
  // The service's only address: Wrangler attaches it as a Custom Domain on the zone that holds
  // it, creating its DNS record and certificate. No zone or account ID is needed here.
  `\n[[routes]]\npattern = ${JSON.stringify(origin.hostname)}\ncustom_domain = true\n`, { mode: 0o600 });
