import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createCarrier, DEFAULT_MAX_REQUEST_BODY_BYTES } from './src/carrier.js'
import { createStaticFrontend } from './src/frontend-static.js'
import { createKeySource } from './src/keys.js'
import { createNonces } from './src/nonces.js'
import { createScope } from './src/scope.js'

export const name = 'multiuser-dsh'
export const Config = Schema.object({
  maxRequestBodyBytes: Schema.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

const namespace = '/_automagik'
const reserved = path => path === namespace || path.startsWith(namespace + '/')

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
  const scope = createScope()
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const nonces = createNonces({ startedAtSec, file: multiuser ? join(dshHome, 'multiuser-dsh', 'caller-watermark') : undefined })
  ctx.inject(['connection', 'webServer'], c => c.effect(() => {
    const { webServer } = c
    if ([webServer.exact, webServer.prefixes, webServer.upgrades].some(table => [...table.keys()].some(reserved))) {
      console.error('multiuser-dsh: startup refused because /_automagik already has a route')
      // DSH can keep listening after an optional plugin fails. Reject private
      // HTTP dispatch even if the gate is already sending member requests.
      return wrapMethod(webServer, 'responderFor', original => function (path) {
        return reserved(path) ? undefined : original.call(this, path)
      })
    }
    const unregister = webServer.register({
      kind: 'prefix',
      path: namespace + '/caller',
      handler: createCarrier({
        connection: c.connection,
        clientModules: () => c.get('clientModules'),
        appResource: request => c.get('automagikAppResource')?.(request),
        staticResource: multiuser ? createStaticFrontend(webServer) : undefined,
        keys, nonces, scope, multiuser, keysConfigured: Boolean(file),
        expectedAuthority: () => webServer.port === undefined ? undefined : `127.0.0.1:${webServer.port}`,
        maxRequestBodyBytes: config.maxRequestBodyBytes,
      }),
    })
    const reserve = original => function (route) {
      if (reserved(route.path)) throw new Error(`multiuser-dsh: ${namespace} routes are reserved`)
      return original.call(this, route)
    }
    const restoreRegister = wrapMethod(webServer, 'register', reserve)
    const restoreUpgrade = wrapMethod(webServer, 'registerUpgrade', reserve)
    c.provide('automagikCaller', Object.freeze({ version: 1, multiuser, current: scope.current }))
    return () => {
      unregister()
      restoreRegister()
      restoreUpgrade()
    }
  }))
}
