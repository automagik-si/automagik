import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { credentialedManifest } from './frontend.js'

const HTML = 'text/html; charset=utf-8'
const MIME = {
  '.html': HTML,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.gz': 'application/gzip',
}
const missing = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

export function createStaticFrontend(webServer) {
  let root
  try {
    // Resolve from the Web App's own dependency tree, just as its apply does.
    const requireFromWebApp = createRequire(import.meta.resolve('@deepseek-ai/dsh-web-app'))
    root = join(dirname(requireFromWebApp.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist')
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') return undefined
    throw error
  }
  const index = join(root, 'index.html')

  return async (request, peer) => {
    const { method } = request
    if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 })
    const path = resolve(join(root, decodeURIComponent(new URL(request.url).pathname)))
    if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 403 })
    try {
      if (path === root || path === index) {
        const html = await fs.readFile(index, 'utf8')
        const body = credentialedManifest(webServer.renderIndex(html, peer))
          .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
        const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`
        const cache = { 'cache-control': 'no-cache', etag }
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cache })
        return new Response(method === 'HEAD' ? null : body, { headers: { 'content-type': HTML, ...cache } })
      }
      const bytes = await fs.readFile(path)
      const etag = `W/"${createHash('sha1').update(bytes).digest('base64url')}"`
      const cache = { 'cache-control': 'no-cache', etag }
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cache })
      return new Response(method === 'HEAD' ? null : bytes, {
        headers: { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', ...cache },
      })
    } catch (error) {
      if (missing.has(error.code)) return new Response(null, { status: 404 })
      throw error
    }
  }
}
