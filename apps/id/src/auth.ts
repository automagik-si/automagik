import { betterAuth, type GenericEndpointContext } from 'better-auth';
import { APIError } from 'better-auth/api';
import { jwt } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { oauthProvider } from '@better-auth/oauth-provider';
import { whatsappEnabled, whatsappPlugin } from './whatsapp';
import { passkeySiteName } from './site';
import { passkeyAccountPlugin } from './passkeys';
import { admitSignup } from './gate';
import { ADMISSION_HEADER } from './admission';

function strictRedirectUri(uri: string, registered: readonly string[], defaultResult: boolean) {
  const url = new URL(uri);
  // RFC 8252's changing-port exception is for IP literals, never a DNS name.
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    return defaultResult && registered.includes(uri);
  }
  return defaultResult;
}

// Token lifetimes in seconds: the contract in README.md, "Token lifetimes".
// A stolen access token is bearer-usable until it expires and revocation cannot recall a JWT.
export const ACCESS_TOKEN_TTL = 15 * 60;
// The ID token proves one sign-in to the client; nothing should accept it hours later.
export const ID_TOKEN_TTL = 15 * 60;
// Desktop and Cloud stay signed in for a month of inactivity; each use rotates the token.
export const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
// No grace window: any reuse of a rotated refresh token counts as replay.
export const REFRESH_TOKEN_REUSE_INTERVAL = 0;

export interface Env {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  /** The passkey site name (WebAuthn relying-party ID); automagik.si for real use. */
  PASSKEY_RP_ID: string;
  WHATSAPP_RECEIVING_NUMBER?: string;
  OMNI_INBOUND_TOKEN?: string;
  /** Public keys (a JWKS JSON string) that admission tickets are checked against. */
  ADMISSION_KEYS?: string;
  /** The issuer every admission ticket must name. */
  ADMISSION_ISSUER?: string;
  PAGES?: Fetcher;
}

export function createAuth(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>,
  authorizeRegistration?: (endpoint: GenericEndpointContext, userId: string, credentialId: string) => Promise<void>) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be provisioned');
  }
  const rpID = passkeySiteName(env);
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  return betterAuth({
    appName: 'Automagik ID',
    baseURL: origin,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    emailAndPassword: { enabled: false },
    socialProviders: {},
    logger: { disabled: true },
    user: { additionalFields: {
      phoneNumber: { type: 'string', required: false, unique: true, input: false },
      phoneNumberVerified: { type: 'boolean', required: false, defaultValue: false, input: false },
    } },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60 },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      backgroundTasks: { handler: promise => ctx.waitUntil(promise) },
    },
    plugins: [
      passkey({
        rpID,
        rpName: 'Automagik ID',
        origin,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        registration: {
          requireSession: false,
          // Invite only (RFC 0032, Decided 9): the ticket is checked, and reserved, before the
          // user row is written. Every ceremony on one ticket gets the same row.
          async resolveUser({ ctx: endpoint }) {
            const id = await admitSignup(env, endpoint.headers?.get(ADMISSION_HEADER));
            const adapter = endpoint.context.internalAdapter;
            let user = await adapter.findUserById(id);
            if (!user) {
              try {
                user = await adapter.createUser({
                  id, name: 'Automagik user', email: `${crypto.randomUUID()}@id.invalid`, emailVerified: false,
                } as Parameters<typeof adapter.createUser>[0], { method: 'passkey' });
              } catch {
                // A concurrent ceremony on the same ticket wrote the row first.
                user = await adapter.findUserById(id);
                if (!user) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Please start again' });
              }
            }
            return { id: user.id, name: 'Automagik user', displayName: 'Automagik user' };
          },
          async afterVerification({ ctx: endpoint, user, verification }) {
            if (!authorizeRegistration) throw new APIError('FORBIDDEN');
            await authorizeRegistration(endpoint, user.id, verification.registrationInfo!.credential.id);
          },
        },
      }),
      passkeyAccountPlugin(env),
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        scopes: ['openid', 'profile', 'offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        allowPublicClientPrelogin: true,
        clientPrivileges: async () => false,
        clientRegistrationRequirePKCE: true,
        validateRedirectUri: strictRedirectUri,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL,
        idTokenExpiresIn: ID_TOKEN_TTL,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL,
        refreshTokenReuseInterval: REFRESH_TOKEN_REUSE_INTERVAL,
      }),
      ...(whatsappEnabled(env) ? [whatsappPlugin(env)] : []),
    ],
  });
}
