import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import * as adapter from '../index.js'
import { invoke, prefix, provideConnection } from './runtime.mjs'

const instance = 'record-plugin-fixture'
const botId = 'b-aaaaaaaaaa'
const step = 'agent/pre-step'
const tool = 'tools/pre-execute'
const created = 'agent/created'
const events = [created, step, tool]

function fixture(t, { mode = '1', id = instance } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'principal-plugin-'))
  const file = join(home, 'multiuser-dsh', 'principals.json')
  const env = { DSH_HOME: home, AUTOMAGIK_MULTIUSER: mode, AUTOMAGIK_INSTANCE_ID: id }
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key]
    if (value === null) delete process.env[key]
    else process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const warn = t.mock.method(ctx.logger, 'warn', () => {})
  const listeners = () => events.map(event => ctx.events.dispatch('emit', [event]).length)
  const activate = () => ctx.plugin(adapter)
  const provide = (botOf, version = 1) => ctx.provide('automagikBotSessions', { version, botOf })
  const rows = () => JSON.parse(readFileSync(file, 'utf8')).sessions
  return { ctx, file, warn, listeners, activate, provide, rows }
}

for (const [label, mode] of [['unset', null], ['empty', ''], ['zero', '0']]) {
  test(`multiuser ${label} registers no record listeners and creates no directory`, async t => {
    const f = fixture(t, { mode })
    await f.activate()
    assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
    assert.deepEqual(f.listeners(), [0, 0, 0])
    assert.equal(existsSync(dirname(f.file)), false)
    assert.equal(f.warn.mock.callCount(), 0)
  })
}

test('multiuser with no instance warns once and registers no record listeners', async t => {
  const f = fixture(t, { id: '  ' })
  await f.activate()
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
  assert.deepEqual(f.listeners(), [0, 0, 0])
  assert.equal(existsSync(dirname(f.file)), false)
  assert.equal(f.warn.mock.callCount(), 1)
  assert.match(f.warn.mock.calls[0].arguments.join(' '), /principal record off: no AUTOMAGIK_INSTANCE_ID/)
})

test('first activation reserves the caller route and refuses only Bots when record setup fails', async t => {
  const f = fixture(t)
  const webServer = new WebServer(f.ctx, { host: '127.0.0.1', port: 0 })
  const fallback = t.mock.fn((_req, res) => res.writeHead(200).end())
  webServer.registerFallback(fallback)
  await provideConnection(f.ctx)
  const folder = dirname(f.file)
  mkdirSync(folder)
  chmodSync(folder, 0o770)
  f.provide(id => id === 'bot' ? botId : id === 'person' ? null : undefined)

  await f.activate()
  assert.ok(f.ctx.get('automagikCaller'))
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
  const responder = webServer.responderFor(prefix)
  const response = await invoke(responder.handler ?? responder, { url: prefix, method: 'GET', headers: {} })
  assert.equal(response.status, 401)
  assert.equal(fallback.mock.callCount(), 0)
  const refusal = /multiuser-dsh: the principal record is unavailable: .*private directory/
  await assert.rejects(() => f.ctx.serial(created, { agent: { id: 'bot' } }), refusal)
  for (const event of [step, tool]) {
    const next = t.mock.fn(() => 'ran')
    assert.throws(() => f.ctx.waterfall(event, { agent: { id: 'bot' } }, next), refusal)
    assert.equal(next.mock.callCount(), 0)
    for (const id of ['person', 'unknown']) assert.equal(f.ctx.waterfall(event, { agent: { id } }, next), 'ran')
  }
  assert.equal(f.warn.mock.callCount(), 1)
  assert.match(f.warn.mock.calls[0].arguments.join(' '), /principal record off: .*private directory/)
  assert.equal(existsSync(f.file), false)
})

test('creation, pre-step and pre-execute record the Bot ahead of existing listeners', async t => {
  const f = fixture(t)
  const check = ({ agent }) => assert.equal(f.rows()[agent.id ?? agent.session.id], `bot:${botId}`)
  f.ctx.on(created, payload => { check(payload) })
  for (const event of [step, tool]) f.ctx.on(event, (payload, next) => { check(payload); return next() })
  await f.activate()
  const authority = f.ctx.get('automagikPrincipalRecord')
  const { dev, ino } = statSync(dirname(f.file), { bigint: true })
  assert.deepEqual(authority, { version: 1, file: f.file, instance, folder: `${dev}:${ino}` })
  assert.equal(Object.isFrozen(authority), true)
  const botOf = t.mock.fn(() => botId)
  f.provide(botOf)
  await f.ctx.serial(created, { agent: { id: 'created' }, source: 'startup' })
  for (const [event, agent, id] of [[step, { id: 'step' }, 'step'], [tool, { session: { id: 'tool' } }, 'tool']]) {
    assert.equal(f.ctx.waterfall(event, { agent }, () => {
      assert.equal(f.rows()[id], `bot:${botId}`)
      return 'next'
    }), 'next')
    assert.deepEqual(botOf.mock.calls.at(-1).arguments, [id, agent])
  }
  assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).instance, instance)
  assert.deepEqual(f.rows(), Object.fromEntries(['created', 'step', 'tool'].map(id => [id, `bot:${botId}`])))
})

test('only the active writer provides record authority during an adapter overlap', async t => {
  const f = fixture(t)
  new WebServer(f.ctx, { host: '127.0.0.1', port: 0 })
  await provideConnection(f.ctx)
  const first = f.activate()
  await first
  const authority = f.ctx.get('automagikPrincipalRecord')
  assert.ok(authority)

  const waiting = f.ctx.isolate('connection')
  await waiting.plugin(adapter)
  assert.equal(f.ctx.get('automagikPrincipalRecord'), authority)
  assert.deepEqual(f.listeners(), [1, 1, 1])
  await first.dispose()
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)

  const connection = provideConnection(waiting)
  await connection
  const replacement = f.ctx.get('automagikPrincipalRecord')
  assert.deepEqual(replacement, authority)
  assert.notEqual(replacement, authority)
  assert.deepEqual(f.listeners(), [1, 1, 1])
  await connection.dispose()
  assert.equal(f.ctx.get('automagikPrincipalRecord'), replacement)
})

test('the carrier takes over the writer when its provider leaves with the connection still active', async t => {
  const f = fixture(t)
  new WebServer(f.ctx, { host: '127.0.0.1', port: 0 })
  const first = f.activate()
  await first
  const authority = f.ctx.get('automagikPrincipalRecord')
  assert.ok(authority)
  assert.equal(f.ctx.get('automagikCaller'), undefined)

  const carrier = f.ctx.isolate('connection')
  await provideConnection(carrier)
  await carrier.plugin(adapter)
  const caller = f.ctx.get('automagikCaller')
  assert.ok(caller)
  assert.equal(f.ctx.get('automagikPrincipalRecord'), authority)
  assert.deepEqual(f.listeners(), [1, 1, 1])

  await first.dispose()
  assert.equal(f.ctx.get('automagikCaller'), caller)
  const replacement = f.ctx.get('automagikPrincipalRecord')
  assert.deepEqual(replacement, authority)
  assert.notEqual(replacement, authority)
  assert.deepEqual(f.listeners(), [1, 1, 1])
  f.provide(() => botId)
  assert.equal(f.ctx.waterfall(step, { agent: { id: 'bot' } }, () => 'next'), 'next')
  assert.deepEqual(f.rows(), { bot: `bot:${botId}` })
})

test('first activation under umask 0477 keeps the new private directory descriptor open until disposal', async t => {
  const f = fixture(t)
  const folder = dirname(f.file)
  const open = fs.openSync
  const descriptors = []
  t.mock.method(fs, 'openSync', (path, ...args) => {
    const fd = open(path, ...args)
    if (path === folder) descriptors.push(fd)
    return fd
  })
  const close = t.mock.method(fs, 'closeSync')
  assert.equal(existsSync(folder), false)
  const previous = process.umask(0o477)
  const fiber = f.activate()
  try {
    await fiber
    assert.equal(statSync(folder).mode & 0o777, 0o700)
    const { dev, ino } = statSync(folder, { bigint: true })
    assert.equal(f.ctx.get('automagikPrincipalRecord').folder, `${dev}:${ino}`)
    f.provide(() => botId)
    assert.equal(f.ctx.waterfall(step, { agent: { id: 'bot' } }, () => 'next'), 'next')
    assert.deepEqual(f.rows(), { bot: `bot:${botId}` })
    assert.equal(statSync(f.file).mode & 0o777, 0o600)
    assert.equal(descriptors.length, 1)
    assert.equal(fs.fstatSync(descriptors[0], { bigint: true }).ino, ino)
    assert.equal(close.mock.calls.some(({ arguments: [fd] }) => fd === descriptors[0]), false)
  } finally {
    process.umask(previous)
    await fiber.dispose()
  }
  assert.equal(close.mock.calls.filter(({ arguments: [fd] }) => fd === descriptors[0]).length, 1)
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
})

test('only a string classification from the live v1 service is recorded', async t => {
  const f = fixture(t)
  await f.activate()
  const run = async () => {
    const agent = { id: 'session' }
    await f.ctx.serial(created, { agent, source: 'startup' })
    for (const event of [step, tool]) assert.equal(f.ctx.waterfall(event, { agent }, () => 'next'), 'next')
    assert.equal(existsSync(f.file), false)
  }
  await run()
  for (const botOf of [() => null, () => undefined, () => { throw new Error('resolver unavailable') }]) {
    const remove = f.provide(botOf)
    await run()
    remove()
  }
  const botOf = t.mock.fn(() => botId)
  f.provide(botOf, 2)
  await run()
  assert.equal(botOf.mock.callCount(), 0)
})

test('writer failures block creation, the step and the tool, and disposal removes the hooks', async t => {
  const f = fixture(t)
  const fiber = f.activate()
  await fiber
  const botOf = t.mock.fn(() => botId)
  f.provide(botOf)
  assert.deepEqual(f.listeners(), [1, 1, 1])
  writeFileSync(f.file, 'invalid', { mode: 0o600 })
  const payload = { agent: { id: 'session' }, source: 'startup' }
  const next = t.mock.fn(() => 'next')
  const error = { message: /multiuser-dsh: could not record Bot session session: .*invalid JSON/, cause: /invalid JSON/ }
  const verify = thrown => {
    assert.match(thrown.message, error.message)
    assert.match(thrown.cause.message, error.cause)
    return true
  }
  await assert.rejects(() => f.ctx.serial(created, payload), verify)
  for (const event of [step, tool]) assert.throws(() => f.ctx.waterfall(event, payload, next), verify)
  assert.equal(next.mock.callCount(), 0)
  assert.equal(f.warn.mock.callCount(), 2, 'one record refusal and one creation failure')
  assert.equal(readFileSync(f.file, 'utf8'), 'invalid')

  await fiber.dispose()
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
  assert.deepEqual(f.listeners(), [0, 0, 0])
  await f.ctx.serial(created, payload)
  for (const event of [step, tool]) assert.equal(f.ctx.waterfall(event, payload, next), 'next')
  assert.equal(botOf.mock.callCount(), 3)
})
