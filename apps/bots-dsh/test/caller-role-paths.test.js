import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installAppManifest } from '../src/host/app-manifest.js'
import { fixture } from './caller-fixture.js'
import paths from '../../../server/test/fixtures/caller-role-paths.json' with { type: 'json' }
import frontend from '../../../server/test/fixtures/caller-frontend-paths.json' with { type: 'json' }

test('RP1 the two runtime Fetch inventories and matching caller route pairs agree with the fixture', t => {
  const configs = new Map()
  for (const config of ['desktop', 'standalone']) {
    const old = process.env.AUTOMAGIK_APP_BROWSER
    const send = process.send
    if (config === 'desktop') { process.env.AUTOMAGIK_APP_BROWSER = '1'; process.send = () => true }
    else delete process.env.AUTOMAGIK_APP_BROWSER
    let f
    try { f = fixture(t) } finally {
      if (old === undefined) delete process.env.AUTOMAGIK_APP_BROWSER
      else process.env.AUTOMAGIK_APP_BROWSER = old
      if (send === undefined) delete process.send
      else process.send = send
    }
    const service = f.ctx.get('automagikCallerRoutes')
    for (const { path, methods } of f.routes.values()) {
      for (const method of methods) {
        const pair = method + ' ' + path
        const configurations = configs.get(pair) ?? []
        configurations.push(config)
        configs.set(pair, configurations)
        const expected = paths.routes.find(row => row.method === method && row.path === path)
        assert.equal(typeof service.match(path, method), expected?.decision === 'caller' ? 'function' : 'undefined', pair)
      }
    }
  }
  const pairs = rows => rows.map(row => row.method + ' ' + row.path).sort()
  assert.deepEqual(configs, new Map(paths.routes.map(row => [row.method + ' ' + row.path, row.configurations])))
  assert.deepEqual(pairs(paths.routes.filter(row => row.decision === 'caller')), pairs(paths.targets.filter(row => row.callerRoute)))

  // app-manifest uses webServer resources, which belong to the frontend allowlist.
  const assets = []
  installAppManifest({ config: {}, ctx: {
    provide() {},
    inject(_names, apply) {
      apply({ webServer: { tapIndex: () => () => {}, register: route => { assets.push(route.path); return () => {} } }, effect: fn => fn() })
    },
  } })
  assert.deepEqual(assets, ['/manifest.webmanifest', '/omni-ui/app-icon.png'])
  for (const path of assets) assert.ok(frontend.allowed.includes(path), path)
})
