// Closing a Bot browser must never fail the host. DSH turns every unhandled rejection into a
// fatal exit, so a navigation-guard unroute that rejects on a context that is already gone
// (a killed Chrome, a dropped app relay) has to be caught inside the session (#1573).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSession } from '../src/host/browser/session.js'

const turns = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)) }

function closedContext() {
  const listeners = new Map()
  const context = {
    unroutes: 0,
    pages: () => [],
    on(name, listener) { listeners.set(name, listener) },
    route: async () => {},
    unroute: async () => {
      context.unroutes += 1
      throw new Error('browserContext.unroute: Target page, context or browser has been closed')
    },
    cookies: async () => [],
    close: async () => {},
    emit(name) { listeners.get(name)?.() },
  }
  return context
}

for (const ended of [true, false]) {
  test(`close() with an unroute that rejects ${ended ? 'after the context closed' : 'on a live context'} never leaves an unhandled rejection`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-bot-session-close-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const unhandled = []
    const onUnhandled = reason => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    t.after(() => process.off('unhandledRejection', onUnhandled))

    const context = closedContext()
    const session = createSession({ context, cookieFile: join(dir, 'cookies.json'), actionTimeout: 1000 })
    await turns()
    if (ended) {
      context.emit('close')
      assert.equal(session.closed, true)
    }
    await session.close()
    await session.close()
    await turns()

    assert.deepEqual(unhandled, [])
    assert.equal(context.unroutes, ended ? 0 : 1)
  })
}
