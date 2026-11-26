import { createHmac, randomBytes } from 'node:crypto'
import { callerEndpoint } from './caller-policy.js'
import { isSkillEndpoint } from './skill-library.js'
import { ROUTE } from './constants.js'
import { FEED_ROUTE } from './feed.js'
import { callerService, multiuserMode } from './multiuser.js'

const PUBLIC_ERRORS = new Set(['bot/not-found', 'bot/invalid', 'bot/read-only', 'bot/refused'])
const ROLES = new Set(['owner', 'admin', 'member', 'guest'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
const identity = value => bounded(value, 512) && !/\p{Cc}/u.test(value)

export const callerJson = result => Response.json(result, { headers: { 'cache-control': 'no-store' } })
const ok = value => callerJson({ ok: true, value })
const fail = (message, code, reason) => callerJson({
  ok: false, error: { code, message, details: {}, ...(reason === undefined ? {} : { reason }) },
})
const invalid = () => fail('Bad request', 'bot/invalid')

export function install(rt) {
  const { ctx, state } = rt
  const secret = randomBytes(32)
  const viewerOf = (principal, role = callerService(ctx)?.roleOf(principal)) => {
    const { issuer, subject } = principal.person
    const identity = createHmac('sha256', secret).update(issuer + '\n' + subject)
    // A viewer issued before a promotion cannot be used on the owner route.
    if (role === 'owner' || role === 'admin') identity.update('\n' + role)
    const digest = identity.digest()
    return { id: digest.subarray(0, 16).toString('base64url'), role }
  }
  rt.viewerOf = viewerOf
  rt.ownerViewer = request => {
    const header = request.headers.get('x-automagik-principal')
    if (header && /^[\w-]+$/.test(header)) {
      try {
        const person = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
        if (identity(person?.issuer) && identity(person.subject) && Array.isArray(person.roles) &&
            person.roles.length === new Set(person.roles).size && person.roles.every(role => ROLES.has(role))) {
          if (person.roles.includes('owner')) return viewerOf({ person }, 'owner')
          if (person.roles.includes('admin')) return viewerOf({ person }, 'admin')
        }
      } catch { /* A malformed gate identity cannot identify a viewer. */ }
    }
    if (!multiuserMode() && header === null) return { id: 'local', role: 'owner' }
  }

  async function post(request, principal) {
    let body
    try { body = await request.json() } catch { return invalid() }
    if (!object(body) || !bounded(body.endpoint, 64) ||
        (body.payload != null && !object(body.payload)) ||
        (body.viewer !== undefined && !bounded(body.viewer, 64))) return invalid()
    const { endpoint, payload } = body
    const role = callerService(ctx)?.roleOf(principal)
    const viewer = viewerOf(principal, role)
    if (!(endpoint === 'whoami' && body.viewer === undefined) && body.viewer !== viewer.id) {
      return fail('Your sign-in changed; reload this page.', 'bot/viewer-changed')
    }
    const decision = callerEndpoint(role, endpoint)
    if (!decision.allow) {
      if (isSkillEndpoint(endpoint) ||
          (endpoint === 'update-bot' && Object.hasOwn(payload ?? {}, 'skills'))) {
        await rt.skillLibrary?.refuse(endpoint, payload, role ?? 'untrusted')
      }
      return fail(decision.message, decision.code, decision.reason)
    }
    try {
      await rt.load()
      switch (endpoint) {
        case 'whoami': {
          const { issuer, subject } = principal.person
          return ok({ role, identity: { issuer, subject }, multiuser: true, viewer })
        }
        case 'state': return ok({ revision: state.revision, bots: rt.callerBots(principal), viewer })
        case 'list-bots': return ok(rt.callerBots(principal))
        case 'get-bot':
          if (!bounded(payload?.id, 512)) return invalid()
          return ok(rt.callerBot(principal, payload.id))
        case 'chat':
        case 'earlier':
          if (!bounded(payload?.botId, 512) || (payload.cursor != null && typeof payload.cursor !== 'string')) return invalid()
          return ok(await rt.callerChat(principal, payload.botId, payload.cursor ?? undefined))
        default: return fail('Not available', 'bot/refused')
      }
    } catch (error) {
      if (PUBLIC_ERRORS.has(error?.code)) return fail(error.message, error.code)
      const kind = [error?.code, error?.name].find(value => typeof value === 'string' && /^[\w./-]{1,40}$/.test(value))
      rt.warn('omni-ui: a caller read failed (%s)', kind ?? 'error')
      return fail('Something went wrong.', 'bot/internal')
    }
  }

  let disposed = false
  const unprovide = ctx.provide('automagikCallerRoutes', Object.freeze({
    version: 1,
    match(path, method) {
      if (disposed || !callerService(ctx)) return
      if (path === ROUTE && method === 'POST') return post
      if (path === FEED_ROUTE && method === 'GET') return rt.callerFeed
    },
  }))
  const offIndex = ctx.on('webserver/index-inject', (table, peer) => {
    const service = callerService(ctx)
    if (disposed || (!multiuserMode() && !service)) return
    const principal = peer?.principal
    const role = principal?.kind === 'owner' ? 'owner' :
      principal?.kind === 'automagik' ? service?.roleOf(principal) : undefined
    table.push({ kind: 'global', name: '__AUTOMAGIK_VIEW__', value: { version: 1, role: role ?? 'none' } })
  })
  return () => {
    disposed = true
    offIndex?.()
    unprovide?.()
  }
}
