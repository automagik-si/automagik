import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { createAuth, type Env } from './auth';
import { getCookies } from 'better-auth/cookies';
import { inbound, readChallenge, whatsappEnabled } from './whatsapp';
import { passkeySiteName } from './site';

function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'email' && key !== 'emailVerified')
      .map(([key, entry]) => [key, publicData(entry)]));
  if (typeof value === 'string' && value.endsWith('@id.invalid')) return 'Automagik user';
  return value;
}

// Every answer the Worker gives carries these, whatever produced it: a page, a static file,
// Better Auth, the well-known metadata, an error. PAGES-CONTRACT.md lists them.
// The CSP is the strictest the pages run under: same-origin script, style, fonts, images and
// fetch, no inline code, no framing. It goes on every response, not only HTML: an SVG or any
// file a browser renders as a document gets the same limits, and elsewhere it is inert.
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// Copies the response so its headers can change; status, body, Location and every Set-Cookie
// stay as they were.
function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The pages answer only at /sign-in and /consent, where the Worker adds their headers.
// A direct .html path, however it is spelled, is not a page.
function directPage(pathname: string): boolean {
  try {
    return /\.html?$/i.test(decodeURIComponent(pathname).replace(/\/+$/, ''));
  } catch {
    return true;
  }
}

const router = {
  async route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // A service whose host cannot carry the passkey site name answers nothing else.
    try {
      passkeySiteName(env);
    } catch (error) {
      console.error(error);
      return new Response(`Automagik ID is not configured: ${(error as Error).message}\n`, {
        status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const url = new URL(request.url);
    if (url.pathname === '/sign-in' || url.pathname === '/consent') {
      if (env.PAGES) {
        const page = new URL(`${url.pathname.slice(1)}.html`, url.origin);
        const response = await env.PAGES.fetch(new Request(page, request));
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('cache-control', 'no-store');
          return new Response(response.body, { status: response.status, headers });
        }
      }
      return new Response('page not built yet', { status: 501 });
    }
    if (directPage(url.pathname)) return new Response('Not found', { status: 404 });
    const whatsappOn = whatsappEnabled(env);
    if (url.pathname === '/api/id/config') {
      return Response.json({ phoneEnabled: false, whatsappEnabled: whatsappOn });
    }
    if (url.pathname === '/api/omni/inbound') {
      if (!whatsappOn || request.method !== 'POST') return new Response('Not found', { status: 404 });
      return inbound(request, env);
    }
    if (url.pathname === '/api/auth/whatsapp/status') {
      if (!whatsappOn || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const origin = new URL(env.BETTER_AUTH_URL).origin;
      const suppliedOrigin = request.headers.get('origin');
      if ((suppliedOrigin && suppliedOrigin !== origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
        return new Response('Forbidden', { status: 403 });
      }
      const challenge = await readChallenge(env, request);
      const headers = new Headers(request.headers);
      headers.set('origin', origin);
      headers.set('content-type', 'application/json');
      // Only a cookie-bound stored query reaches Better Auth's normal OAuth/session hooks.
      request = new Request(url, { method: 'POST', headers, body: JSON.stringify({
        ...(challenge?.state === 'verified' && challenge.oauthQuery ? { oauth_query: challenge.oauthQuery } : {}),
      }) });
    }
    if (env.PAGES && ['GET', 'HEAD'].includes(request.method) &&
        !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/.well-known/')) {
      return env.PAGES.fetch(request);
    }
    const auth = createAuth(env, ctx);
    if (url.pathname === '/.well-known/openid-configuration' ||
        url.pathname === '/api/auth/.well-known/openid-configuration') {
      return oauthProviderOpenIdConfigMetadata(auth)(request);
    }
    if (url.pathname === '/.well-known/oauth-authorization-server/api/auth') {
      return oauthProviderAuthServerMetadata(auth)(request);
    }
    // Expose only the authentication surface we support. Managed client CRUD is server only.
    const path = url.pathname.replace(/^\/api\/auth/, '');
    const allowed = new Set([
      '/get-session', '/sign-out', '/jwks',
      '/passkey/generate-register-options', '/passkey/verify-registration',
      '/passkey/generate-authenticate-options', '/passkey/verify-authentication',
      '/oauth2/authorize', '/oauth2/token', '/oauth2/userinfo', '/oauth2/revoke',
      '/oauth2/end-session', '/oauth2/end-session/confirm', '/oauth2/consent', '/oauth2/continue',
      '/oauth2/public-client-prelogin',
      ...(whatsappOn ? ['/whatsapp/start', '/whatsapp/status'] : []),
    ]);
    if (!url.pathname.startsWith('/api/auth/') || !allowed.has(path)) {
      return new Response('Not found', { status: 404 });
    }
    if (path === '/passkey/generate-register-options' || path === '/passkey/verify-registration') {
      // These routes create an account. Keep the ceremony cookie, but ignore session identity
      // in both steps so the passkey plugin cannot enroll into the current account.
      const cookies = getCookies(auth.options);
      const sessionNames = [cookies.sessionToken.name, cookies.sessionData.name];
      const headers = new Headers(request.headers);
      const ceremonyCookies = (headers.get('cookie') ?? '').split(';').filter(part => {
        // Match Better Call's getSignedCookie parser: trim the name before '='.
        const name = part.split('=', 1)[0].trim();
        return !sessionNames.some(sessionName => name === sessionName || name.startsWith(`${sessionName}.`));
      }).join(';');
      headers.set('cookie', ceremonyCookies);
      headers.delete('authorization');
      request = new Request(request, { headers });
    }
    const response = await auth.handler(request);
    if (response.headers.get('content-type')?.includes('application/json')) {
      const text = await response.text();
      if (!text) return new Response(null, response);
      const body = publicData(JSON.parse(text));
      return new Response(JSON.stringify(body), response);
    }
    return response;
  },
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await router.route(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
