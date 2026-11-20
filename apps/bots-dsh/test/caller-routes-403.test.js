import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { Context } from '@deepseek-ai/cordis'
import { CODE_STREAM_ROUTE } from '../src/host/code-side.js'
import { GENUI_MEDIA_ROUTE, IMAGE_ROUTE, PET_ROUTE } from '../src/host/constants.js'
import { fixture, guest, member } from './caller-fixture.js'

test('B-routes the real exact Fetch dispatch refuses both carried roles on every registered route', async t => {
  const old = process.env.AUTOMAGIK_APP_BROWSER
  const send = process.send
  process.env.AUTOMAGIK_APP_BROWSER = '1'
  process.send = () => true
  let f
  try { f = fixture(t) }
  finally {
    if (old === undefined) delete process.env.AUTOMAGIK_APP_BROWSER
    else process.env.AUTOMAGIK_APP_BROWSER = old
    if (send === undefined) delete process.send
    else process.send = send
  }
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  const connection = new HostConnectionService(ctx, [], {})
  for (const route of f.routes.values()) connection.registerFetchRoute(ctx, route)
  for (const path of ['/api/omni-ui', '/api/omni-ui/feed', IMAGE_ROUTE, PET_ROUTE, GENUI_MEDIA_ROUTE, CODE_STREAM_ROUTE, '/api/omni-mcp']) {
    assert.ok(f.routes.has(path), path)
  }
  const shared = connection.createSharedFetchHandler('/api')
  for (const principal of [member, guest]) {
    const peer = connection.createPeer({ principal, interactions: 'answer' })
    try {
      for (const { path, methods } of f.routes.values()) {
        for (const method of methods) {
          const response = await shared.fetch(new Request('http://fixture.invalid' + path, { method }), peer)
          assert.equal(response.status, 403, method + ' ' + path)
        }
      }
    } finally {
      await peer.dispose()
    }
  }
  assert.equal(ctx.get('automagikCallerRoutes'), undefined)
  assert.equal(f.ctx.get('automagikCallerRoutes'), undefined)
})
