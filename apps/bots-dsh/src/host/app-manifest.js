// The web app's name. DSH's page calls itself "DeepSeek Harness" in dist/manifest.webmanifest
// and in index.html's <title>, and no DSH config changes either. DSH's web server answers a named
// route before its static files and runs index.html through tapIndex transforms, so this module
// serves its own manifest on the exact path the page links, an icon beside it, and swaps the
// <title>: "Automagik" with the Automagik app icon (app-icon.png, apps/desktop/assets/icon.png at
// 512 px), unless config.appManifest names the app otherwise, or is false to keep DSH's name.
import { readFileSync } from 'node:fs'
import { extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MANIFEST_PATH = '/manifest.webmanifest'
export const MANIFEST_TYPE = 'application/manifest+json'
const ICON_BASE = '/omni-ui/app-icon'
const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png' }
const SHIPPED_ICON = fileURLToPath(new URL('./app-icon.png', import.meta.url))
export const DEFAULT_APP = { name: 'Automagik', short_name: 'Automagik' }
const MAX_NAME = 120
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

const text = (value) => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_NAME

// A PNG's size from its IHDR chunk, for the manifest's `sizes`.
function pngSize(body) {
  if (body.length < 24 || body.toString('latin1', 12, 16) !== 'IHDR') return 'any'
  return `${body.readUInt32BE(16)}x${body.readUInt32BE(20)}`
}

function iconOf(path, read) {
  const ext = extname(path).toLowerCase()
  const body = read(path)
  return { path: `${ICON_BASE}${ext}`, type: ICON_TYPES[ext], sizes: ext === '.png' ? pngSize(body) : 'any', body }
}

/**
 * The app to name: the default, the configured one, or null when config.appManifest is false.
 * A configured one it can't use is refused with a warning, and the default stays.
 */
export function appOf(config, { warn = () => {}, read = readFileSync } = {}) {
  const raw = config?.appManifest
  if (raw === false) return null
  const fallback = () => ({ ...DEFAULT_APP, icon: iconOf(SHIPPED_ICON, read) })
  if (raw === undefined || raw === null) return fallback()
  const refuse = (why) => {
    warn(`appManifest refused (${why}); the page is named ${DEFAULT_APP.name}`)
    return fallback()
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return refuse('not an object or false')
  if (!text(raw.name) || !text(raw.short_name)) return refuse('name and short_name are required')
  const app = { name: raw.name, short_name: raw.short_name }
  for (const key of ['theme_color', 'background_color']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'string' || !COLOR.test(raw[key])) return refuse(`${key} is not a #hex color`)
    app[key] = raw[key]
  }
  if (raw.icon === undefined) return { ...app, icon: iconOf(SHIPPED_ICON, read) }
  if (typeof raw.icon !== 'string' || !isAbsolute(raw.icon) || !ICON_TYPES[extname(raw.icon).toLowerCase()]) {
    return refuse('icon is not an absolute path to an .svg or .png file')
  }
  try {
    return { ...app, icon: iconOf(raw.icon, read) }
  } catch (error) {
    return refuse(`icon unreadable: ${error?.code ?? 'error'}`)
  }
}

/** DSH's manifest fields, with the app's names, colors and icon. */
export function manifestOf(app) {
  return {
    name: app.name,
    short_name: app.short_name,
    start_url: './',
    scope: './',
    display: 'fullscreen',
    ...(app.theme_color ? { theme_color: app.theme_color } : {}),
    ...(app.background_color ? { background_color: app.background_color } : {}),
    // Relative to the manifest's URL, as DSH's own entry is.
    icons: [{ src: app.icon.path.slice(1), sizes: app.icon.sizes, type: app.icon.type, purpose: 'any' }],
  }
}

// GET and HEAD, as DSH's static files answer.
function answer(type, body, headers = {}) {
  const responseHeaders = { 'content-type': type, ...headers }
  const handler = async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      return res.end()
    }
    res.writeHead(200, responseHeaders)
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  const resource = request => new Response(request.method === 'HEAD' ? null : body, { headers: responseHeaders })
  return { handler, resource }
}

// The icon is served as the type its extension names, never sniffed; an SVG opened on its own
// runs no script and loads nothing.
function iconHeaders(type) {
  return { 'x-content-type-options': 'nosniff', ...(type === ICON_TYPES['.svg'] ? { 'content-security-policy': "default-src 'none'" } : {}) }
}

/** Exact webServer routes: the manifest and its icon. */
export function appRoutes(app) {
  return [
    { kind: 'exact', path: MANIFEST_PATH, ...answer(MANIFEST_TYPE, Buffer.from(JSON.stringify(manifestOf(app), null, 2))) },
    { kind: 'exact', path: app.icon.path, ...answer(app.icon.type, app.icon.body, iconHeaders(app.icon.type)) },
  ]
}

const escapeHtml = (value) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A tapIndex transform that puts the app's name in index.html's <title>. */
export function titleTap(name) {
  const title = `<title>${escapeHtml(name)}</title>`
  return (html) => html.replace(/<title>[^<]*<\/title>/i, () => title)
}

export function install(rt) {
  const { ctx } = rt
  if (typeof ctx.inject !== 'function') return
  const app = appOf(rt.config, { warn: (line) => rt.warn?.('omni-ui: %s', line) })
  if (!app) return
  ctx.inject(['webServer'], (web) => {
    if (web.webServer === undefined) return
    web.effect(() => {
      // All or nothing: a route that fails to register (a duplicate path) releases the ones before it.
      const disposers = []
      const release = () => disposers.splice(0).reverse().forEach((dispose) => dispose())
      try {
        const routes = appRoutes(app)
        for (const route of routes) disposers.push(web.webServer.register(route))
        disposers.push(web.webServer.tapIndex(titleTap(app.name)))
        if (typeof web.provide === 'function') {
          disposers.push(web.provide('automagikAppResource', request =>
            routes.find(route => route.path === new URL(request.url).pathname)?.resource(request)))
        }
      } catch (error) {
        release()
        throw error
      }
      return release
    }, 'omni-ui: the web app name')
  })
}
