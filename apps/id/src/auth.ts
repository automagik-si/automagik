import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { oauthProvider } from '@better-auth/oauth-provider';
import { whatsappEnabled, whatsappPlugin } from './whatsapp';
import { passkeySiteName } from './site';
import { passkeyAccountPlugin } from './passkeys';

function strictRedirectUri(uri: string, registered: readonly string[], defaultResult: boolean) {
  const url = new URL(uri);
  // RFC 8252's changing-port exception is for IP literals, never a DNS name.
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    return defaultResult && registered.includes(uri);
  }
  return defaultResult;
}

export interface Env {
  DB: D1Database;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  /** The passkey site name (WebAuthn relying-party ID); automagik.si for real use. */
  PASSKEY_RP_ID: string;
  WHATSAPP_RECEIVING_NUMBER?: string;
  OMNI_INBOUND_TOKEN?: string;
  PAGES?: Fetcher;
}

export function createAuth(env: Env, ctx: Pick<ExecutionContext, 'waitUntil'>) {
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
          async resolveUser({ ctx: endpoint }) {
            const user = await endpoint.context.internalAdapter.createUser({
              name: 'Automagik user',
              email: `${crypto.randomUUID()}@id.invalid`,
              emailVerified: false,
            }, { method: 'passkey' });
            return { id: user.id, name: 'Automagik user', displayName: 'Automagik user' };
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
      }),
      ...(whatsappEnabled(env) ? [whatsappPlugin(env)] : []),
    ],
  });
}
