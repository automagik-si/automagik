// One address policy for the Bot team's browser and web_fetch. The lists live in the team
// file's prefs (Settings -> Browser -> Address lists), so a change applies to the next
// navigation or fetch without restarting the profile. Both lists start empty: localhost,
// LAN and tailnet addresses are reachable by default. A deny entry always wins; when the
// allow list is not empty, only a matching target opens.
import { decideAddress, localRefusal, normalizeAddressList } from './browser/address-policy.js'

export { normalizeAddressList }

export function install(rt) {
  const services = {}
  if (typeof rt.ctx.inject === 'function') {
    for (const name of ['webServer', 'webApp']) {
      rt.ctx.inject([name], scope => {
        const service = scope[name]
        scope.effect(() => {
          services[name] = service
          return () => {
            if (services[name] === service) delete services[name]
          }
        })
      })
    }
  }
  const own = () => {
    const { webServer, webApp } = services
    let port, host, advertised
    try { port = webServer?.port } catch { /* unavailable */ }
    try { host = webServer?.host } catch { /* unavailable */ }
    try {
      if (webApp) advertised = new URL(webApp.getAdvertisedUrl())
    } catch { /* unavailable */ }
    return {
      listener: Number.isInteger(port) && port > 0 && port <= 65535 ? { port, host } : undefined,
      advertised,
    }
  }
  const lists = () => {
    const prefs = rt.state?.prefs ?? {}
    return {
      allow: Array.isArray(prefs.browserAllow) ? prefs.browserAllow : [],
      deny: Array.isArray(prefs.browserDeny) ? prefs.browserDeny : [],
    }
  }
  const check = (url, action = 'open') => {
    const { allow, deny } = lists()
    return decideAddress(url, { allow, deny, action })
  }
  rt.addressPolicy = { lists, check, local: async (url, kind) => localRefusal(url, kind, own()) }

  // web_fetch is a host tool over DSH's web seam. Its provider is local and has no address
  // policy of its own, so the same lists gate the tool before it reaches the provider.
  // A redirect the provider follows is same-origin only; a cross-origin target is refused
  // by the provider itself, so the initial URL is the one to classify here.
  if (typeof rt.ctx.on === 'function') {
    rt.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec?.name !== 'web_fetch') return next()
      const url = exec.arguments?.url
      if (typeof url !== 'string') return next()
      await rt.load?.()
      const decision = await check(url, 'fetch')
      if (!decision.allowed) {
        rt.noteStop?.(exec.agent?.id ?? exec.agent?.session?.id, { why: 'address', tool: 'web_fetch', callId: exec.callId }, exec.agent)
        return { kind: 'deny', reason: decision.message }
      }
      return next()
    })
  }
}
