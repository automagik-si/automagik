import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { roleOf, visibleBotIds } from './src/access.js'
import { createSeen } from './src/seen.js'
import { createCarrier, DEFAULT_MAX_REQUEST_BODY_BYTES } from './src/carrier.js'
import { createStaticFrontend } from './src/frontend-static.js'
import { createKeySource } from './src/keys.js'
import { createMuxCarrier, MUX_PATH } from './src/mux-carrier.js'
import { createNonces } from './src/nonces.js'
import { createPrincipalRecord } from './src/record.js'
import { createPeerRegistry } from './src/peers.js'
import { namespace, reservationOf, reserved } from './src/reservation.js'
import { createScope } from './src/scope.js'

// Cordis exposes fiber.state. FiberState.ACTIVE is 2 in lib/types/fiber.d.ts (a TypeScript const enum).
const ACTIVE = 2
const original = service => service?.[Symbol.for('cordis.original')] ?? service

// Compose Connection's shared Fetch handler with the live exact routes and a private
// interceptor bound to the pinned gateway.
function gatewayApi(connection, gateway) {
  const { fetchRoutes, registerInterceptor, createSharedFetchHandler } = connection
  if (!(fetchRoutes instanceof Map) || typeof registerInterceptor !== 'function' ||
      typeof createSharedFetchHandler !== 'function' ||
      typeof gateway.claimsEndpoint !== 'function' || typeof gateway.dispatchRpc !== 'function') return
  const routes = { fetchRoutes, interceptors: new Map() }
  registerInterceptor.call(routes, { effect: register => register() }, '/api',
    gateway.claimsEndpoint.bind(gateway), gateway.dispatchRpc.bind(gateway))
  if (typeof routes.interceptors.get('/api')?.fetchHandler?.fetch !== 'function') return
  return createSharedFetchHandler.call(routes, '/api')
}

// Cordis exposes the injection callback but no owner on the interceptor entry.
// Match the pinned gateway's inline callback and its live /api registration effect.
function connectionSetup(gateway, connection, Gateway) {
  const gatewaySource = Function.prototype.toString.call(Gateway)
  for (const runtime of gateway.ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.parent !== gateway.ctx || Object.keys(fiber.inject).length !== 1 ||
          !Object.hasOwn(fiber.inject, 'connection') || fiber.state !== ACTIVE ||
          original(fiber.ctx.get('connection')) !== connection ||
          !fiber.getEffects().some(effect => effect.label === 'client-connection: /api rpc interceptor')) continue
      if (gatewaySource.includes(Function.prototype.toString.call(runtime.callback))) return fiber
    }
  }
}

export const name = 'multiuser-dsh'
// The automagik policy multiuser-dsh owns. It is empty until the role table lands: every business
// call and every policy-filtered notification of a member or guest is denied.
const EMPTY_RULES = Object.freeze({ bindings: () => [], explain: () => undefined })
export const Config = Schema.object({
  maxRequestBodyBytes: Schema.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

function wrapMethod(webServer, name, wrap) {
  const own = Object.hasOwn(webServer, name)
  const original = webServer[name]
  webServer[name] = wrap(original)
  return () => {
    if (own) webServer[name] = original
    else delete webServer[name]
  }
}

// Match bots-dsh's dshHomeOf, including spaces in a nonblank path.
function principalRecordHome(value) {
  const path = value?.trim() ? value : join(homedir(), '.dsh')
  return resolve(path === '~' ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path)
}

function installPrincipalRecord(ctx, home, instance) {
  let record
  let unavailable
  try {
    record = createPrincipalRecord({
      dshHome: principalRecordHome(home), instance,
      warn: message => ctx.logger.warn('multiuser-dsh: %s', message),
    })
  } catch (cause) {
    unavailable = cause
    ctx.logger.warn('multiuser-dsh: principal record off: %s', cause.message)
  }
  if (record !== undefined) {
    ctx.effect(() => record.dispose)
    ctx.provide('automagikPrincipalRecord', Object.freeze({
      version: 1, file: record.file, instance, folder: record.folderIdentity,
    }))
  }
  const recordAgent = agent => {
    const sessionId = agent?.id ?? agent?.session?.id
    const service = ctx.get('automagikBotSessions')
    let id
    try {
      if (service?.version === 1) id = service.botOf(sessionId, agent)
    } catch {
      return
    }
    if (typeof id !== 'string') return
    if (unavailable !== undefined) {
      throw new Error(`multiuser-dsh: the principal record is unavailable: ${unavailable.message}`, { cause: unavailable })
    }
    try {
      record.recordBot(sessionId, id)
    } catch (cause) {
      throw new Error(`multiuser-dsh: could not record Bot session ${sessionId}: ${cause.message}`, { cause })
    }
  }
  // Cordis disposes these listeners with the plugin's fiber.
  ctx.on('agent/created', ({ agent }) => {
    try {
      recordAgent(agent)
    } catch (error) {
      if (record !== undefined) ctx.logger.warn('%s', error.message)
      // DSH announces creation serially and allows a listener to reject it.
      throw error
    }
  }, { prepend: true })
  const recordBefore = ({ agent }, next) => {
    recordAgent(agent)
    return next()
  }
  ctx.on('agent/pre-step', recordBefore, { prepend: true })
  ctx.on('tools/pre-execute', recordBefore, { prepend: true })
}

export async function apply(ctx, config) {
  const value = process.env.AUTOMAGIK_MULTIUSER
  const multiuser = value !== undefined && value !== '' && value !== '0'
  const file = process.env.AUTOMAGIK_CALLER_KEYS
  const configuredInstance = process.env.AUTOMAGIK_INSTANCE_ID
  const keys = createKeySource({ file, expectedInstance: configuredInstance })
  const startedAtSec = Math.floor(Date.now() / 1000)
  const home = process.env.DSH_HOME
  const dshHome = home?.trim() || join(homedir(), '.dsh')
  const guard = ctx.inject(['webServer'], c => { reservationOf(c.webServer) })
  const instance = multiuser && configuredInstance?.trim() ? configuredInstance : undefined
  let recordStarted = false
  const startRecord = () => {
    if (!instance || recordStarted || ctx.get('automagikPrincipalRecord', false) !== undefined) return
    recordStarted = true
    ctx.effect(() => installPrincipalRecord(ctx, home, instance))
  }
  if (multiuser && !instance) ctx.logger.warn('multiuser-dsh: principal record off: no AUTOMAGIK_INSTANCE_ID')
  startRecord()
  let modules
  const load = () => modules ??= Promise.all([import('@deepseek-ai/dsh-api-gateway'), import('./src/mux.js')])
    .then(([{ TypertGatewayService }, { createMux }]) => ({ TypertGatewayService, createMux }), () => undefined)
  let transport
  if (multiuser && ctx.get('webServer')) {
    await guard
    transport = await load()
  }
  // A Peer admitted under an earlier policy epoch is never live.
  let policy
  let epoch = 0
  const gatewaySetups = new WeakMap()
  const rules = EMPTY_RULES
  const seen = createSeen()
  let callerProvider
  const warnedProviders = new WeakSet()
  const warnProvider = provider => {
    if (warnedProviders.has(provider)) return
    warnedProviders.add(provider)
    ctx.logger.warn('multiuser-dsh: caller visibility provider failed')
  }
  const provide = provider => {
    if (callerProvider) throw new Error('multiuser-dsh: a caller provider is already registered')
    if (typeof provider?.bots !== 'function') throw new TypeError('multiuser-dsh: a caller provider needs bots()')
    const registration = { provider }
    callerProvider = registration
    return () => {
      if (callerProvider === registration) callerProvider = undefined
    }
  }
  const registry = createPeerRegistry({ epoch: () => epoch })
  // A foreign or lost policy closes admission and every caller Peer at once, HTTP included.
  const lost = () => {
    policy = undefined
    epoch++
    registry.revokeAll('automagik policy lost')
    console.warn('multiuser-dsh: the automagik policy is not ours; members are refused')
  }
  let policyCtx, removePolicy
  // Register the empty policy when remoteAccess is present, and again when an activation claims
  // the reservation after another instance released the policy.
  const claimPolicy = () => {
    if (!multiuser || policy || policyCtx === undefined) return
    const access = policyCtx.remoteAccess
    const entry = { bindings: p => rules.bindings(p), explain: r => rules.explain(r) }
    try {
      removePolicy = access.registerPolicy('automagik', entry)
    } catch {
      lost()
      return
    }
    policy = { access: original(access), entry, fiber: policyCtx.fiber }
    epoch++
  }
  ctx.inject(['remoteAccess'], c => c.effect(() => {
    policyCtx = c
    claimPolicy()
    return () => {
      policyCtx = undefined
      const held = policy !== undefined
      // The plugin's own unload is the activation's business: admitted HTTP drains there.
      if (ctx.fiber.state === ACTIVE) lost()
      else {
        policy = undefined
        epoch++
      }
      if (held) removePolicy?.()
      removePolicy = undefined
    }
  }))
  ctx.inject(['connection', 'webServer'], c => c.effect(() => {
    const { webServer } = c
    const reservation = reservationOf(webServer)
    if ([webServer.exact, webServer.prefixes, webServer.upgrades].some(table => [...table.keys()].some(reserved))) {
      console.error('multiuser-dsh: startup refused because /_automagik already has a route')
      return reservation.refuse()
    }
    const owner = reservation.claim({ active: () => c.fiber.state === ACTIVE, admitUpgrade: () => multiuser })
    if (!owner) {
      console.error('multiuser-dsh: startup refused because /_automagik is already reserved')
      return
    }
    claimPolicy()
    const cleanups = []
    let carrier, mux
    // Unload closes admission at once and closes every carried socket; admitted HTTP drains.
    const release = () => {
      owner.release()
      carrier?.stopPending()
      registry.closeSockets(1011, 'adapter unloaded')
      for (const cleanup of cleanups.reverse()) cleanup()
    }
    try {
      startRecord()
      if (instance && !recordStarted) {
        // The current writer can leave while this carrier's connection stays active.
        c.on('internal/service', (name, value) => {
          if (name === 'automagikPrincipalRecord' && value === undefined && owner.live()) startRecord()
        })
      }
      const app = c.get('appReady')
      let appReady = app === undefined
      if (app !== undefined) cleanups.push(app.onReady(() => { appReady = true }))
      const keysConfigured = Boolean(file)
      const connection = original(c.connection)
      let binding
      const ready = () => {
        if (!owner.live() || !multiuser || !keysConfigured || !appReady || !transport || policy?.fiber.state !== ACTIVE) return
        const gateway = original(c.get('typertGateway'))
        if (!(gateway instanceof transport.TypertGatewayService) || gateway.ctx.fiber.state !== ACTIVE) return
        // Read the gateway's defining context, since Cordis proxies expose the reader's ctx.
        // The registration entry also pins the policy generation on the enforcing service.
        const access = original(gateway.ctx.get('remoteAccess'))
        if (access !== policy.access || access.policies?.get('automagik')?.policy !== policy.entry) return
        const interceptor = connection.interceptors?.get('/api')
        if (!interceptor) return
        if (binding?.gateway === gateway && binding.policy === policy && binding.fiber.state === ACTIVE) {
          if (binding.interceptor === interceptor) return binding
          return
        }
        const fiber = connectionSetup(gateway, connection, transport.TypertGatewayService)
        const known = gatewaySetups.get(gateway)
        if (!fiber || (known && (known.fiber !== fiber ||
            (known.connection === connection && known.interceptor !== interceptor)))) return
        let api
        try { api = gatewayApi(connection, gateway) } catch { return }
        if (!api) return
        gatewaySetups.set(gateway, { fiber, connection, interceptor })
        return binding = { gateway, policy, fiber, interceptor, api }
      }
      const scope = createScope()
      const expectedAuthority = () => webServer.port === undefined ? undefined : `127.0.0.1:${webServer.port}`
      const nonces = createNonces({
        startedAtSec, anchorSec: Math.floor(Date.now() / 1000),
        file: multiuser ? join(dshHome, 'multiuser-dsh', 'caller-watermark') : undefined,
      })
      carrier = createCarrier({
        connection: c.connection,
        active: ready, apiFor: binding => binding.api, registry,
        clientModules: () => c.get('clientModules'),
        appResource: request => c.get('automagikAppResource')?.(request),
        staticResource: multiuser ? createStaticFrontend(webServer) : undefined,
        keys, nonces, scope, multiuser, keysConfigured,
        expectedAuthority, seen: seen.record,
        maxRequestBodyBytes: config.maxRequestBodyBytes,
      })
      cleanups.push(owner.register({ kind: 'prefix', path: namespace + '/caller', handler: carrier }))
      let upgrade = createMuxCarrier({ ready: () => false })
      cleanups.push(owner.registerUpgrade({ path: MUX_PATH, handler: (...args) => upgrade(...args) }))
      const installMux = loaded => {
        if (!loaded) return
        mux = loaded.createMux({ wireStream: binding => binding.gateway.wireStream, scope, registry, ready })
        const closeLostBinding = () => {
          if (!binding) return
          binding = ready()
          mux.closeStaleBindings(binding)
        }
        cleanups.push(c.on('internal/status', fiber => {
          if (binding && (fiber === binding.fiber || fiber === binding.gateway.ctx.fiber)) closeLostBinding()
        }), c.on('internal/service', name => {
          if (name === 'typertGateway' || name === 'connection' || name === 'remoteAccess') closeLostBinding()
        }))
        upgrade = createMuxCarrier({
          admission: { keys, nonces, multiuser, keysConfigured, expectedAuthority, seen: seen.record }, connection: c.connection, registry, ready, mux,
        })
        transport = loaded
      }
      if (transport) installMux(transport)
      else if (multiuser) load().then(loaded => { if (owner.live()) installMux(loaded) })
      const reserve = original => function (route) {
        if (reserved(route.path)) throw new Error(`multiuser-dsh: ${namespace} routes are reserved`)
        return original.call(this, route)
      }
      cleanups.push(wrapMethod(webServer, 'register', reserve))
      cleanups.push(wrapMethod(webServer, 'registerUpgrade', reserve))
      // Keep c's service scope with an independent fiber that stays active during teardown.
      const Context = c.root.constructor
      const provider = c.extend({ fiber: new Context().fiber })
      const removeCaller = provider.provide('automagikCaller', Object.freeze({
        version: 2, multiuser, current: scope.current, roleOf, provide,
        visibleBotIds: principal => visibleBotIds(principal, multiuser ? callerProvider?.provider : undefined, warnProvider),
        invalidate() {
          try { policyCtx?.remoteAccess?.invalidate?.() } catch {}
        },
        seen() {
          if (scope.current() !== undefined) throw new Error("multiuser-dsh: the admitted-person list is the owner's")
          return seen.list()
        },
      }))
      // automagikCaller outlives every admitted HTTP request and every stream pump.
      return async () => {
        release()
        try { await Promise.all([carrier.drain(), mux?.close()]) }
        finally { removeCaller() }
      }
    } catch (error) {
      release()
      throw error
    }
  }))
}
