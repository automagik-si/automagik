// The invite gate on account creation, in Better Auth's terms. src/admission.ts holds the ticket
// checks and the D1 statements; this file turns their refusals into plain JSON API errors.
import { APIError, getSessionFromCtx } from 'better-auth/api';
import type { GenericEndpointContext } from 'better-auth';
import {
  AdmissionRefused, claimSignup, reserveSignup, verifyAdmission, ADMISSION_MESSAGES,
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

/**
 * At passkey verification: the ceremony's account takes its ticket, once. A passkey added to
 * the signed-in account's own user creates no account, so it needs no ticket; the passkey plugin
 * already refuses a ceremony whose user is not the session's.
 */
export async function signupClaimed(env: { DB: D1Database }, endpoint: GenericEndpointContext,
  userId: string): Promise<void> {
  const session = await getSessionFromCtx(endpoint);
  if (session?.user?.id === userId) return;
  if (!(await claimSignup(env.DB, userId))) throw refusal('INVITATION_USED');
}
