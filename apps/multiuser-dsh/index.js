import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createCarrier, DEFAULT_MAX_REQUEST_BODY_BYTES } from './src/carrier.js'
import { createStaticFrontend } from './src/frontend-static.js'
import { createKeySource } from './src/keys.js'
import { createNonces } from './src/nonces.js'
import { namespace, reservationOf, reserved } from './src/reservation.js'
import { createScope } from './src/scope.js'

// Cordis exposes fiber.state. FiberState.ACTIVE is 2 in lib/types/fiber.d.ts (a TypeScript const enum).
const ACTIVE = 2

export const name = 'multiuser-dsh'
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

export function apply(ctx, config) {
  const value = process.env.AUTOMAGIK_MULTIUSER
  const multiuser = value !== undefined && value !== '' && value !== '0'
  const file = process.env.AUTOMAGIK_CALLER_KEYS
  const keys = createKeySource({ file, expectedInstance: process.env.AUTOMAGIK_INSTANCE_ID })
  const startedAtSec = Math.floor(Date.now() / 1000)
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  ctx.inject(['webServer'], c => { reservationOf(c.webServer) })
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
    const cleanups = []
    const release = () => {
      owner.release()
      for (const cleanup of cleanups.reverse()) cleanup()
    }
    try {
      const scope = createScope()
      const nonces = createNonces({
        startedAtSec, anchorSec: Math.floor(Date.now() / 1000),
        file: multiuser ? join(dshHome, 'multiuser-dsh', 'caller-watermark') : undefined,
      })
      const carrier = createCarrier({
        connection: c.connection,
        active: owner.live,
        clientModules: () => c.get('clientModules'),
        appResource: request => c.get('automagikAppResource')?.(request),
        staticResource: multiuser ? createStaticFrontend(webServer) : undefined,
        keys, nonces, scope, multiuser, keysConfigured: Boolean(file),
        expectedAuthority: () => webServer.port === undefined ? undefined : `127.0.0.1:${webServer.port}`,
        maxRequestBodyBytes: config.maxRequestBodyBytes,
      })
      cleanups.push(owner.register({ kind: 'prefix', path: namespace + '/caller', handler: carrier }))
      // #1373 registers here with owner.registerUpgrade. Admission is checked before upgrade dispatch.
      const reserve = original => function (route) {
        if (reserved(route.path)) throw new Error(`multiuser-dsh: ${namespace} routes are reserved`)
        return original.call(this, route)
      }
      cleanups.push(wrapMethod(webServer, 'register', reserve))
      cleanups.push(wrapMethod(webServer, 'registerUpgrade', reserve))
      // Keep c's service scope with an independent fiber that stays active during teardown.
      const Context = c.root.constructor
      const provider = c.extend({ fiber: new Context().fiber })
      const removeCaller = provider.provide('automagikCaller', Object.freeze({ version: 1, multiuser, current: scope.current }))
      return () => {
        release()
        const draining = carrier.drain()
        return draining ? draining.finally(removeCaller) : removeCaller()
      }
    } catch (error) {
      release()
      throw error
    }
  }))
}
