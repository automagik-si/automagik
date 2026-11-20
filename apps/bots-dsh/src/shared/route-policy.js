import { routeOfRef } from './routes.js'

export const DEFAULT_ROUTE_POLICY = Object.freeze({
  default: Object.freeze(['native', 'acp', 'hermes-remote']),
  dsh: Object.freeze(['native', 'hermes-remote']),
})

// Match the selector's kind lookup (model-menu.js routesFor).
export function routeAllowed(bot, ref, policy) {
  const routes = policy?.[bot?.kind ?? 'automagik'] ?? policy?.default
  return !Array.isArray(routes) || routes.includes(routeOfRef(ref).route)
}
