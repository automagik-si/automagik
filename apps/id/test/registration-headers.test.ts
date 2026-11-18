import { expect, test, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/auth';

// Observe the actual request delivered to Better Auth, including headers which the
// current plugin set does not use for session authentication (Authorization).
vi.mock('../src/auth', () => ({
  createAuth: () => ({
    options: { baseURL: 'https://id.automagik.si' },
    handler: (request: Request) => Response.json({
      cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization'),
    }),
  }),
}));

const origin = 'https://id.automagik.si';
const env = { BETTER_AUTH_URL: origin, PASSKEY_RP_ID: 'automagik.si' } as Env;
const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
const challenge = '__Secure-better-auth.passkey_challenge=ceremony%2Btoken%3D';
const whitespace = [' ', '\t', ' \t'];

for (const route of ['generate-register-options', 'verify-registration']) {
  test.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    `${route} strips %s and every whitespace session cookie, retaining the challenge`, async authorization => {
      const cookies = whitespace.flatMap(space => [
        `${space}__Secure-better-auth.session_token=token-fixture`,
        `__Secure-better-auth.session_token${space}=token-fixture`,
        `${space}__Secure-better-auth.session_data${space}=cache-fixture`,
        `${space}__Secure-better-auth.session_data.0${space}=chunk-fixture`,
        `${space}__Secure-better-auth.session_token.0${space}=chunk-fixture`,
      ]);
      const headers = new Headers([
        ['CoOkIe', [challenge, 'unrelated=exact%3Dbytes', ...cookies].join(';')],
        ['Cookie', '__Secure-better-auth.session_token =second-header-fixture'],
        [authorization, '\t Bearer session-header-fixture \t'],
      ]);
      const response = await worker.fetch(new Request(`${origin}/api/auth/passkey/${route}`, {
        method: route === 'verify-registration' ? 'POST' : 'GET', headers,
      }), env, ctx);
      expect(response.status).toBe(200);
      const forwarded = await response.json() as { cookie: string; authorization: string | null };
      expect(forwarded.authorization).toBeNull();
      expect(forwarded.cookie).toContain(challenge);
      expect(forwarded.cookie).toContain('unrelated=exact%3Dbytes');
      expect(forwarded.cookie).not.toContain('session_token');
      expect(forwarded.cookie).not.toContain('session_data');
      expect(forwarded.cookie).not.toContain('fixture');
    },
  );
}
