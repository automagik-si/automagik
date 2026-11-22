// Run only when deliberately updating the pinned auth schema; review the resulting SQL.
// Its output also holds columns a later migration adds (0004: session.signInMethod); keep those out of 0001.
import { Database } from 'bun:sqlite';
import { getMigrations } from 'better-auth/db/migration';
import { mkdir, writeFile } from 'node:fs/promises';
import { createAuth, type Env } from '../src/auth';

const auth = createAuth({
  BETTER_AUTH_URL: 'https://id.example.com',
  BETTER_AUTH_SECRET: 'schema-generation-placeholder-not-a-credential',
} as Env, { waitUntil() {} });
const migration = await getMigrations({ ...auth.options, database: new Database(':memory:') });
await mkdir(new URL('../migrations/', import.meta.url), { recursive: true });
await writeFile(new URL('../migrations/0001_auth.sql', import.meta.url),
  `-- Generated from Better Auth 1.7.21, passkey, jwt, OAuth provider and phone account fields.\n${await migration.compileMigrations()}\n`);
