// Cleanup of accounts whose passkey ceremony was abandoned.
//
// `GET /api/auth/passkey/generate-register-options` needs no session, so it creates the user row
// before any passkey exists. A person who cancels the authenticator prompt, or a client that only
// asks for options, leaves a user with no way to sign in. The scheduled handler removes them.

/**
 * How old a passkeyless user must be before it is removed. A registration challenge lives for
 * minutes, so a day leaves every ceremony that could still finish untouched, including one
 * delayed by a slow authenticator or a clock that is somewhat off.
 */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** At most this many users are removed per run, so one run stays short on a large backlog. */
export const ORPHAN_BATCH_LIMIT = 100;

// A user is an orphan only when every condition holds: older than the cutoff, no passkey, no
// verified phone number (WhatsApp accounts have no passkey but sign in by phone), and no OAuth
// client of its own. The date columns hold ISO 8601 strings, which compare in time order.
// The order makes LIMIT pick the same rows in every statement of the batch.
const ORPHANS = `SELECT u.id FROM "user" u
  WHERE u.createdAt < ?1
    AND NOT EXISTS (SELECT 1 FROM passkey p WHERE p.userId = u.id)
    AND u.phoneNumber IS NULL
    AND NOT EXISTS (SELECT 1 FROM oauthClient c WHERE c.userId = u.id)
  ORDER BY u.createdAt, u.id LIMIT ?2`;

/**
 * Removes up to ORPHAN_BATCH_LIMIT orphan users with their sessions, accounts and passkey
 * registration challenges, in one D1 batch (a single transaction). Returns how many users went.
 */
export async function cleanupOrphanUsers(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - ORPHAN_MIN_AGE_MS).toISOString();
  const bind = (sql: string) => db.prepare(sql).bind(cutoff, ORPHAN_BATCH_LIMIT);
  // Better Auth keeps a registration challenge in `verification` with the user id inside its JSON
  // value; other verification values need not be JSON, so only valid JSON is inspected.
  const results = await db.batch([
    bind(`DELETE FROM verification WHERE CASE WHEN json_valid(value)
      THEN json_extract(value, '$.userData.id') END IN (${ORPHANS})`),
    bind(`DELETE FROM session WHERE userId IN (${ORPHANS})`),
    bind(`DELETE FROM account WHERE userId IN (${ORPHANS})`),
    bind(`DELETE FROM "user" WHERE id IN (${ORPHANS})`),
  ]);
  return results[3].meta.changes ?? 0;
}
