import {
  APIError, createAuthEndpoint, createAuthMiddleware, getAuthoritativeSessionFromCtx, sessionMiddleware,
} from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import type { Env } from './auth';

// Passkeys on an existing account. Adding or deleting a passkey needs
// a session created by a passkey ceremony less than five minutes ago. Better Auth's own
// session.freshAge is not used: it is one global setting (it also governs /list-sessions),
// and it cannot tell a passkey sign-in from a WhatsApp one. So each session records the
// ceremony that created it, and this file checks that and session.createdAt explicitly.

export const FRESH_SIGN_IN_MS = 5 * 60_000;

/** The Worker sets this only on the add routes and removes it from account creation. */
export const ADD_PASSKEY_HEADER = 'x-automagik-id-add-passkey';

/** The add routes, and the passkey plugin registration step each one forwards to. */
export const ADD_PASSKEY_ROUTES = new Map([
  ['/passkey/add/generate-register-options', '/passkey/generate-register-options'],
  ['/passkey/add/verify-registration', '/passkey/verify-registration'],
]);
const ADD_TARGETS = new Set(ADD_PASSKEY_ROUTES.values());

export const PASSKEY_ACCOUNT_ROUTES = ['/passkey/account/list', '/passkey/account/rename', '/passkey/account/delete'];

const SIGN_IN_METHODS: Record<string, string> = {
  '/passkey/verify-authentication': 'passkey',
  '/passkey/verify-registration': 'passkey',
  '/whatsapp/status': 'whatsapp',
};

// A passkey is deleted only when the account keeps another passkey or a phone number.
const KEEPS_A_WAY_IN = `((SELECT count(*) FROM passkey WHERE userId = ?2) > 1
  OR EXISTS (SELECT 1 FROM "user" WHERE id = ?2 AND phoneNumber IS NOT NULL))`;

interface StoredPasskey {
  id: string; name?: string | null; createdAt?: string | number | Date | null;
  deviceType: string; backedUp: boolean | number;
}

/** What a page may see of a passkey: never its public key, credential ID or counter. */
export function passkeyView(row: StoredPasskey) {
  return {
    id: row.id, name: row.name ?? null,
    createdAt: row.createdAt == null ? null : new Date(row.createdAt).toISOString(),
    deviceType: row.deviceType, backedUp: Boolean(row.backedUp),
  };
}

const unauthorized = () => new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED', message: 'Unauthorized' });
const notFresh = () => new APIError('FORBIDDEN', {
  code: 'SESSION_NOT_FRESH', message: 'Sign in again with a passkey to change your passkeys',
});
const notFound = () => new APIError('NOT_FOUND', { code: 'PASSKEY_NOT_FOUND', message: 'Passkey not found' });
const invalid = () => new APIError('BAD_REQUEST', { code: 'INVALID_REQUEST', message: 'Invalid passkey request' });

type SessionRecord = { session: { createdAt: string | number | Date; signInMethod?: string | null } };

function requireFreshPasskeySession(session: SessionRecord | null) {
  if (session?.session.signInMethod !== 'passkey') throw notFresh();
  if (Date.now() - new Date(session.session.createdAt).getTime() >= FRESH_SIGN_IN_MS) throw notFresh();
}

function passkeyId(body: unknown, extra: string[] = []): string {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => key !== 'id' && !extra.includes(key))) throw invalid();
  const { id } = body as { id?: unknown };
  if (typeof id !== 'string' || !id || id.length > 200) throw invalid();
  return id;
}

export function passkeyAccountPlugin(env: Env): BetterAuthPlugin {
  return {
    id: 'automagik-passkey-account',
    schema: { session: { fields: { signInMethod: { type: 'string', required: false, input: false } } } },
    init: () => ({ options: { databaseHooks: {
      session: { create: { before: async (_session, ctx) => ({
        data: { signInMethod: SIGN_IN_METHODS[ctx?.path ?? ''] ?? null },
      }) } },
      // An add request never creates an account, even if its session vanished mid-request.
      user: { create: { before: async (_user, ctx) => {
        if (ctx?.headers?.get(ADD_PASSKEY_HEADER)) throw unauthorized();
      } } },
    } } }),
    hooks: { before: [{
      matcher: ctx => ADD_TARGETS.has(ctx.path ?? '') && Boolean(ctx.headers?.get(ADD_PASSKEY_HEADER)),
      handler: createAuthMiddleware(async ctx => {
        const session = await getAuthoritativeSessionFromCtx(ctx);
        if (!session) throw unauthorized();
        requireFreshPasskeySession(session as SessionRecord);
        // Adding a passkey keeps the current session; it never starts another one.
        if (ctx.path === '/passkey/verify-registration') {
          const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
          return { context: { body: { ...body, createSession: false } } };
        }
      }),
    }] },
    endpoints: {
      listOwnPasskeys: createAuthEndpoint('/passkey/account/list', {
        method: 'GET', use: [sessionMiddleware], metadata: { noStore: true },
      }, async ctx => {
        const rows = await env.DB.prepare(`SELECT id, name, createdAt, deviceType, backedUp FROM passkey
          WHERE userId = ? ORDER BY createdAt, id`).bind(ctx.context.session.user.id).all<StoredPasskey>();
        return ctx.json(rows.results.map(passkeyView));
      }),
      renameOwnPasskey: createAuthEndpoint('/passkey/account/rename', {
        method: 'POST', use: [sessionMiddleware],
      }, async ctx => {
        const id = passkeyId(ctx.body, ['name']);
        const name = (ctx.body as { name?: unknown }).name;
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) throw invalid();
        const row = await env.DB.prepare(`UPDATE passkey SET name = ? WHERE id = ? AND userId = ?
          RETURNING id, name, createdAt, deviceType, backedUp`)
          .bind(name.trim(), id, ctx.context.session.user.id).first<StoredPasskey>();
        if (!row) throw notFound();
        return ctx.json({ passkey: passkeyView(row) });
      }),
      deleteOwnPasskey: createAuthEndpoint('/passkey/account/delete', {
        method: 'POST', use: [sessionMiddleware],
      }, async ctx => {
        requireFreshPasskeySession(ctx.context.session as SessionRecord);
        const id = passkeyId(ctx.body);
        const userId = ctx.context.session.user.id;
        // One statement, so two concurrent deletes cannot both pass the last-passkey guard.
        const deleted = await env.DB.prepare(`DELETE FROM passkey WHERE id = ?1 AND userId = ?2
          AND ${KEEPS_A_WAY_IN}`).bind(id, userId).run();
        if (deleted.meta.changes === 1) return ctx.json({ status: true });
        // Someone else's passkey and a missing one get the same answer.
        const owned = await env.DB.prepare('SELECT 1 FROM passkey WHERE id = ? AND userId = ?')
          .bind(id, userId).first();
        if (!owned) throw notFound();
        throw new APIError('CONFLICT', {
          code: 'LAST_PASSKEY', message: 'This is the only way into your account; add another passkey first',
        });
      }),
    },
  };
}
