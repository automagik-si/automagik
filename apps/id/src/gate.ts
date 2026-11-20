// Translate ticket checks and D1 reservation state into Better Auth's JSON API errors.
import { APIError } from 'better-auth/api';
import {
  AdmissionRefused, reserveSignup, verifyAdmission, ADMISSION_MESSAGES,
  type Admission, type AdmissionCode, type AdmissionEnv,
} from './admission';

/** A refused ticket: HTTP 403 with `{code, message}`. */
export function refusal(code: AdmissionCode): APIError {
  return new APIError('FORBIDDEN', { code, message: ADMISSION_MESSAGES[code] });
}

/** Checks a sign-up ticket without writing anything. */
export async function checkTicket(env: AdmissionEnv, token: string | null | undefined): Promise<Admission> {
  try {
    return await verifyAdmission(env, token, 'signup');
  } catch (error) {
    if (error instanceof AdmissionRefused) throw refusal(error.code);
    throw error;
  }
}

/** A valid, unused ticket's reserved user id; refuses before any row is written otherwise. */
export async function admitSignup(env: AdmissionEnv & { DB: D1Database },
  token: string | null | undefined): Promise<string> {
  const admission = await checkTicket(env, token);
  try {
    return await reserveSignup(env.DB, admission);
  } catch (error) {
    if (error instanceof AdmissionRefused) throw refusal(error.code);
    throw error;
  }
}

/** Inspect the reservation at verification. After a storage error, an already persisted
 * credential means a later operation failed: preserve the original provider error. */
export async function passkeyAdmissionFailure(db: D1Database, userId: string, savedCredentialId?: string):
  Promise<AdmissionCode | null> {
  const row = await db.prepare(`SELECT state, expiresAt <= cutoff AS expired,
    EXISTS (SELECT 1 FROM passkey WHERE userId = ?1 AND credentialID = ?2) AS saved
    FROM admission_ticket, admission_clock WHERE userId = ?1 AND ceremonies > 0`).bind(userId, savedCredentialId ?? null)
    .first<{ state: string; expired: number; saved: number }>();
  if (row?.saved) return null;
  if (!row || row.state !== 'pending') return 'INVITATION_USED';
  return row.expired ? 'INVITATION_INVALID' : null;
}
