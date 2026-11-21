// The app's links. The app registers both schemes with the system (electron-builder.yml, and
// main.js at run time), so a link opens the app:
//
//   automagik://open                                          bring the app to the front
//   automagik://open?bot=<id>                                 the same; the Bot is only logged
//   omni://open, omni://open?bot=<id>                         the same (omni:// is the alias)
//   omni://connect?url=https://omni.example.com              connect to that Omni (the app asks first)
//   omni://connect?url=https://omni.example.com&grant=<grant> the same, with a one-time grant
//
// automagik:// is Automagik's own (RFC 0013): Herdr's Work button opens it. It only ever
// opens: any page or app can fire it, so it never starts, sends or changes anything. Selecting
// the link's Bot comes with the shared Bot ids (RFC 0013 delivery 8); until then main logs it.
// omni:// is Omni's, and its pages make the links ("Open in the Omni app", /api/login/app).
//
// A connect link without a grant carries an address and nothing else: whoever made it,
// connecting still means signing in on that Omni's own page (a passkey, or a code on WhatsApp).
// A grant comes from the link an Omni sends its owner who texted "connect" to themselves: it is
// the owner's yes already, spent on first use. Either way the app shows the address and asks
// before it starts, and a grant is passed on to Omni's page, never logged.
import { isBotId } from './bot-views.js'

export const SCHEMES = ['automagik', 'omni']

// A grant as an Omni mints it: 24 base64url characters.
export const GRANT = /^[A-Za-z0-9_-]{24}$/

// A Bot id in either shape a link can carry: the Herdr pack's registry id (`b-` and 10 base32
// characters, herdr/mods/am-sidebar/model.js) or the Bot team's Session id (`session-<uuid>`,
// bot-views.js). The pack's attach ledger holds both (workers.js LEAD_SHAPE).
const REGISTRY_ID = /^b-[a-z2-7]{10}$/
export const isLinkBotId = value => (typeof value === 'string' && REGISTRY_ID.test(value)) || isBotId(value)

/**
 * What a link asks for: { action: 'open', bot? }, { action: 'connect', url, host, secure, grant? },
 * or null. An open link's `bot` is there only when it is a Bot id: any other `bot` still opens.
 */
export function parseDeepLink(text) {
  let link
  try {
    link = new URL(String(text))
  } catch {
    return null
  }
  const scheme = link.protocol.slice(0, -1)
  if (!SCHEMES.includes(scheme)) return null
  // omni://connect?… parses with "connect" as the host; omni:connect?… as the path.
  const action = (link.host || link.pathname).replace(/^\/+|\/+$/g, '')
  if (action === 'open') {
    const bot = link.searchParams.get('bot')
    return isLinkBotId(bot) ? { action: 'open', bot } : { action: 'open' }
  }
  // Connecting stays omni://'s: automagik:// only opens.
  if (action !== 'connect' || scheme !== 'omni') return null
  let target
  try {
    target = new URL(link.searchParams.get('url') ?? '')
  } catch {
    return null
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null
  if (target.username || target.password) return null
  const url = `${target.origin}${target.pathname.replace(/\/api\/v2\/?$/, '').replace(/\/+$/, '')}`
  // A grant that is not one an Omni mints makes the whole link suspect.
  const grant = link.searchParams.get('grant')
  if (grant !== null && !GRANT.test(grant)) return null
  return { action: 'connect', url, host: target.host, secure: target.protocol === 'https:', ...(grant === null ? {} : { grant }) }
}

/**
 * Makes this app the system's handler for each scheme, and returns the ones it took. Only a
 * packaged app does: a dev `electron .` would hand the links to Electron itself. On Linux each
 * call runs xdg-settings and waits for it, so main calls this once the page is in, not at start.
 */
export function registerSchemes(app) {
  if (!app?.isPackaged) return []
  return SCHEMES.filter(scheme => app.setAsDefaultProtocolClient(scheme))
}

export const isAppLink = arg => typeof arg === 'string' && SCHEMES.some(scheme => arg.startsWith(`${scheme}:`))

/** The first of the app's links in a command line (Linux and Windows pass it as an argument). */
export function linkInArgs(argv) {
  return (Array.isArray(argv) ? argv : []).find(isAppLink) ?? null
}
