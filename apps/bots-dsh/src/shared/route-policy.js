import { routeOfRef } from './routes.js'

export const DEFAULT_ROUTE_POLICY = Object.freeze({
  default: Object.freeze(['native', 'acp', 'hermes-remote']),
  dsh: Object.freeze(['native', 'hermes-remote']),
})

export const TASK_ROUTE_DEFAULT = Object.freeze({
  default: Object.freeze(['native', 'acp']),
  dsh: Object.freeze(['native']),
})

export const taskRoutes = (bot, policy) => {
  const kind = bot.kind ?? 'automagik'
  const routes = Object.hasOwn(policy ?? {}, kind) ? policy[kind] : policy?.default
  return Array.isArray(routes) ? routes : []
}

export const routeLabel = ref => ({ native: 'Native', acp: 'ACP', herdr: 'Herdr', 'hermes-remote': 'Remote Hermes' })[routeOfRef(ref).route]

// Match the selector's kind lookup (model-menu.js routesFor).
export function routeAllowed(bot, ref, policy) {
  const routes = policy?.[bot?.kind ?? 'automagik'] ?? policy?.default
  return !Array.isArray(routes) || routes.includes(routeOfRef(ref).route)
}
