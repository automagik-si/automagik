export const shell = '/assets/index-fixture.js'
export const batch = '/plugin/??@automagik/bots-dsh/client.js&rev=abc'
export const bootstrap = '/plugin/??@deepseek-ai/dsh-client-modules/client.js&rev=def'
export const frontendRow = '<script type="module" crossorigin src=".' + shell + '"></script>'
export const mountRow = '<div id="root"></div>'
const batches = [
  { phase: 'bootstrap', url: bootstrap.slice(1), rev: 'def', entries: ['@deepseek-ai/dsh-client-modules'] },
  { phase: 'application', url: batch.slice(1), rev: 'abc', entries: ['@automagik/bots-dsh'] },
]
const graph = {
  rev: 'fixture-rev',
  release: { version: '0.2.2-rc.2', commit: 'fixture-commit' },
  entries: batches.map(({ entries: [id], rev }) => ({ id, url: `plugin/${id}/client.js?rev=${rev}`, rev })),
  batches,
}
const fixtureMarkup = '<!doctype html><html><head><link rel="preload" as="style" href="/assets/style.css">'
  + frontendRow + '</head><body>' + mountRow + '</body></html>'
// Subprocesses receive the rendered document so the copied fixture needs no DSH package resolution.
async function renderPage() {
  const { bootInjections } = await import('@deepseek-ai/dsh-client-modules')
  const { renderIndexInjections } = await import('@deepseek-ai/dsh-host-webserver')
  return renderIndexInjections(fixtureMarkup, bootInjections(graph))
}
export const healthPage = process.env.SUPERVISOR_HEALTH_PAGE ?? await renderPage()
export const bootGraphJson = healthPage.match(/<script>globalThis\["__DSH_BOOT__"\] = ([^]*?)<\/script>/)?.[1]
export const loaderRow = healthPage.match(/<script>[^]*?window\.__ModuleLoader__=[^]*?<\/script>/)?.[0]
export const bootstrapRow = healthPage.match(/<script src="[^"]*dsh-client-modules[^"]*"><\/script>/)?.[0]
export const applicationRow = healthPage.match(/<link rel="preload" as="script" href="[^"]*bots-dsh[^"]*">/)?.[0]
export const cookie = 'dsh_test=fixture-cookie'
const unauthorized = 'dsh web authentication required; reopen the URL printed by dsh web.\n'

export function healthReply({ url, headers = {}, payload, plugins, run, present = true, bots = 1, legacy = false, fault }) {
  const reply = (status, headers, body = '') => ({ status, headers, body, size: Buffer.byteLength(body) })
  const ok = value => reply(200, { 'content-type': 'application/json' }, JSON.stringify({ ok: true, value }))
  if (url.pathname === '/' && url.searchParams.has('token')) {
    if (fault !== 'sign-in' && ['stdout-secret', 'fixture-token'].includes(url.searchParams.get('token'))) {
      return reply(303, { 'set-cookie': [cookie + '; Path=/; HttpOnly'], location: './' })
    }
  }
  if (headers.cookie !== cookie) {
    return reply(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }, unauthorized)
  }
  if (url.pathname === '/api/omni-ui') {
    if (legacy) {
      return payload?.endpoint === 'list-bots' && payload.payload?.health !== true
        ? ok(Array.from({ length: bots }, () => ({}))) : reply(400, {})
    }
    if (payload?.payload?.health !== true) return reply(400, {})
    if (payload.endpoint === 'self-update-status') {
      return ok({ plugins, hold: { state: fault === 'plugins' ? 'open' : 'closed', run } })
    }
    if (payload.endpoint === 'state' && fault !== 'roster') return ok({ present, revision: 3, bots })
    return reply(500, {})
  }
  if (url.pathname === '/') {
    return reply(200, { 'content-type': 'text/html' }, healthPage)
  }
  const asset = url.pathname + url.search
  if ([shell, bootstrap].includes(asset) || (asset === batch && fault !== 'page')) {
    return reply(200, { 'content-type': 'application/javascript' }, 'export {};')
  }
  return reply(500, {})
}
