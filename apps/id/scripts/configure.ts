import { readFile, writeFile } from 'node:fs/promises';
import { hostUnderSiteName, PASSKEY_SITE_NAME } from '../src/site';

// Passkeys are bound to the site name automagik.si, so the service's host is that name or
// a subdomain of it: a workers.dev address can never carry it.
const origin = new URL(process.env.ID_WORKER_ORIGIN ?? '');
if (origin.protocol !== 'https:' || !hostUnderSiteName(origin.hostname, PASSKEY_SITE_NAME) ||
    origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
    origin.port) {
  throw new Error(`ID_WORKER_ORIGIN must be an HTTPS origin on ${PASSKEY_SITE_NAME} or a subdomain of it`);
}
const databaseId = process.env.ID_DATABASE_ID ?? '';
if (!/^[0-9a-f-]{36}$/i.test(databaseId)) throw new Error('Set ID_DATABASE_ID');
const receiving = process.env.WHATSAPP_RECEIVING_NUMBER;
if (receiving && !/^\+?[1-9]\d{7,14}$/.test(receiving)) throw new Error('Invalid receiving number');
const template = await readFile('wrangler.toml', 'utf8');
await writeFile('wrangler.local.toml', template + '\n[vars]\n' +
  `BETTER_AUTH_URL = ${JSON.stringify(origin.origin)}\n` +
  `PASSKEY_RP_ID = ${JSON.stringify(PASSKEY_SITE_NAME)}\n` +
  (receiving ? `WHATSAPP_RECEIVING_NUMBER = ${JSON.stringify(receiving)}\n` : '') +
  '\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "automagik-id"\n' +
  `database_id = ${JSON.stringify(databaseId)}\nmigrations_dir = "migrations"\n` +
  // The service's only address: Wrangler attaches it as a Custom Domain on the zone that holds
  // it, creating its DNS record and certificate. No zone or account ID is needed here.
  `\n[[routes]]\npattern = ${JSON.stringify(origin.hostname)}\ncustom_domain = true\n`, { mode: 0o600 });
