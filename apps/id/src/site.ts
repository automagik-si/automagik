// The passkey site name (WebAuthn's relying-party ID) is a setting, not the service's own
// host: every Automagik and Arca sign-in shares one name, so a passkey made on any of
// their hosts works on all of them. A passkey is bound to this name for good; the
// service's own host must be the name itself or a subdomain of it, or browsers refuse
// every ceremony. A workers.dev host can never carry a name outside workers.dev.

/** The passkey site name for real use. */
export const PASSKEY_SITE_NAME = 'automagik.si';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);

/** The host is the site name itself or one of its subdomains. */
export function hostUnderSiteName(host: string, siteName: string): boolean {
  return host === siteName || host.endsWith(`.${siteName}`);
}

/**
 * The passkey site name from `PASSKEY_RP_ID`, checked against the service's own host
 * (`BETTER_AUTH_URL`). Throws a plain error when either is missing or they do not match.
 */
export function passkeySiteName(env: { BETTER_AUTH_URL?: string; PASSKEY_RP_ID?: string }): string {
  const siteName = env.PASSKEY_RP_ID ?? '';
  if (!siteName) {
    throw new Error(`PASSKEY_RP_ID is not set; set it to the passkey site name (${PASSKEY_SITE_NAME})`);
  }
  if (!DOMAIN.test(siteName) || siteName.length > 253) {
    throw new Error(`PASSKEY_RP_ID must be a lower-case domain name such as ${PASSKEY_SITE_NAME}`);
  }
  let host: string;
  try {
    host = new URL(env.BETTER_AUTH_URL ?? '').hostname;
  } catch {
    throw new Error('BETTER_AUTH_URL is not a valid URL');
  }
  if (!hostUnderSiteName(host, siteName)) {
    throw new Error(`This service's host ${host} is not ${siteName} or a subdomain of it, ` +
      `so passkeys for ${siteName} cannot work here; the service will not start`);
  }
  return siteName;
}
