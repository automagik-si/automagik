import assert from 'node:assert/strict'
import fs from 'node:fs'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as adapter from '../../multiuser-dsh/index.js'
import { provideBotSessions } from '../src/host/bot-sessions.js'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'

const instance = 'wall-adapter-fixture'
const bot = 'b-aaaaaaaaaa'
const first = 'bot-session'
const stale = 'stale-owner-session'
const ana = 'ana-session'
const evicted = 'evicted'
const entry = `bot:${bot}`
const botSessions = new Set([first, stale])

async function world(t, {
  reverse = false, config = () => ({}), homeName = 'dsh-home', tildeHome = false, instanceSetting = instance,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'member-wall-adapter-'))
  const dshHome = join(root, homeName)
  const team = join(root, 'team')
  const gate = join(root, 'gate-view')
  const members = join(root, 'members')
  const shared = join(root, 'shared')
  const bots = join(root, 'bots')
  const own = join(bots, bot)
  const record = join(dshHome, 'multiuser-dsh', 'principals.json')
  for (const dir of [dshHome, team, gate, join(members, 'ana'), shared, own]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const files = {
    launch: join(dshHome, 'launch-token'), home: join(dshHome, 'private.txt'),
    gate: join(gate, 'launch-token'), team: join(team, 'secrets.json'),
    member: join(members, 'ana', 'notes.txt'), own: join(own, 'own.txt'), shared: join(shared, 'notes.txt'),
  }
  for (const [key, file] of Object.entries(files)) writeFileSync(file, `canary-${key}\n`)
  const env = {
    AUTOMAGIK_MULTIUSER: '1', AUTOMAGIK_INSTANCE_ID: instanceSetting,
    DSH_HOME: tildeHome ? `~/${homeName}` : dshHome,
    ...(tildeHome ? { HOME: root } : {}),
  }
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  const sessions = new Map([first, stale, ana, evicted].map(id => [id, { id, header: { cwd: own }, requestHeader: () => undefined }]))
  const agent = id => ({ id, session: sessions.get(id), options: { provider: 'test', model: 'test' } })
  const rt = {
    ctx: { sessions }, botOfSession: id => botSessions.has(id) ? { id: bot } : undefined,
    teamLoaded: () => true, teamCurrent: () => true, home: team, dshHome,
  }
  const mountProvider = () => ctx.plugin(function botSessionFixture(child) { provideBotSessions(child, rt) })
  const mountAdapter = () => ctx.plugin(adapter)
  const mountWall = () => ctx.plugin(MemberWallFileSystem, {
    cwd: own, members: true, bots: true, principalsFile: record, membersRoot: members,
    sharedReadRoots: [shared], denyReadRoots: [dshHome], botsRoot: bots, botDenyRoots: [gate], ...config({ root, record }),
  })

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: own, additionalWritableRoots: [] }),
  })
  provideWorkingDirectoryFixture(ctx, own)
  let provider
  let writer
  if (reverse) {
    await mountWall()
    writer = mountAdapter()
    await writer
    provider = mountProvider()
    await provider
  } else {
    provider = mountProvider()
    await provider
    writer = mountAdapter()
    await writer
    await mountWall()
  }
  ctx.provide('agents', { list: () => [], get: () => undefined })
  await ctx.plugin(toolFs)

  const step = (id, next = () => {}) => agentEvents(ctx, agent(id)).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, next)
  const requestTool = async (id, name, args) => {
    const subject = agent(id)
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent: subject, signal })
    try {
      const { results } = await ctx.tools.execute({
        calls: [{ id: 'fixture-tool', name, arguments: args }], agent: subject, signal, toolSet,
      })
      return results[0].result
    } finally {
      toolSet.dispose?.()
    }
  }
  const read = (id, file) => requestTool(id, 'read', { file_path: file })
  const seed = (sessions, version = 2, file = record, recordInstance = instance) => {
    const bytes = JSON.stringify({ version, instance: recordInstance, sessions })
    writeFileSync(file, bytes, { mode: 0o600 })
    return bytes
  }
  const wallRead = async (id, file) => {
    const target = await ctx.fs.resolve(file)
    return ctx.waterfall('tools/execute', { agent: agent(id) }, () => ctx.fs.readText(target))
  }
  return { ctx, root, record, files, provider, writer, mountProvider, step, requestTool, read, seed, wallRead }
}

function allowed(result, canary) {
  assert.equal(result.isError === true, false, JSON.stringify(result))
  if (canary) assert.match(JSON.stringify(result), new RegExp(canary))
}

function refused(result) {
  assert.equal(result.isError, true, JSON.stringify(result))
  assert.match(JSON.stringify(result), /not found/)
  assert.doesNotMatch(JSON.stringify(result), /canary-/)
}

for (const reverse of [false, true]) {
  const order = reverse ? 'wall first' : 'provider first'
  test(`bot-read CLOSED and member-read FENCED with the adapter, ${order}`, async t => {
    const f = await world(t, { reverse })
    assert.equal(existsSync(f.record), false)
    await f.step(first, async () => {
      assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), { version: 2, instance, sessions: { [first]: entry } })
      const launch = await f.ctx.fs.resolve(f.files.launch)
      await assert.rejects(() => f.ctx.fs.readText(launch), { code: 'FS_NOT_FOUND' })
    })
    for (const file of [f.files.launch, f.files.home, f.files.gate, f.files.team]) refused(await f.read(first, file))
    allowed(await f.read(first, f.files.own), 'canary-own')
    allowed(await f.requestTool(first, 'write', { file_path: f.files.own, content: 'updated\n' }))
    assert.equal(readFileSync(f.files.own, 'utf8'), 'updated\n')

    f.seed({ [first]: entry, [stale]: 'owner', [ana]: 'member:ana' })
    refused(await f.read(stale, f.files.launch))
    refused(await f.read(stale, f.files.team))
    assert.equal(JSON.parse(readFileSync(f.record, 'utf8')).sessions[stale], entry)
    refused(await f.read(ana, f.files.launch))
    allowed(await f.read(ana, f.files.member), 'canary-member')

    await f.provider.dispose()
    assert.equal(f.ctx.get('automagikBotSessions'), undefined)
    refused(await f.read(first, f.files.own))
    unlinkSync(f.record)
    await f.step(first)
    refused(await f.read(first, f.files.own))
    assert.equal(existsSync(f.record), false)
    await f.mountProvider()
    await f.step(first)
    allowed(await f.read(first, f.files.own), 'updated')
    assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')).sessions, { [first]: entry })
  })
}

test('a v1 record keeps the member area and a Bot cannot reach its own area or owner files', async t => {
  const f = await world(t)
  const original = f.seed({ [first]: 'owner', [ana]: 'member:ana' }, 1)
  assert.throws(() => f.step(first), /could not record Bot session bot-session: expected a version 2 principal record/)
  for (const file of [f.files.own, f.files.launch]) {
    const response = await f.read(first, file)
    assert.equal(response.isError, true)
    assert.match(JSON.stringify(response), /expected a version 2 principal record/)
    await assert.rejects(() => f.wallRead(first, file), { code: 'FS_NOT_FOUND' })
  }
  refused(await f.read(ana, f.files.launch))
  allowed(await f.read(ana, f.files.member), 'canary-member')
  assert.equal(readFileSync(f.record, 'utf8'), original)
})

test('Bot mode requires the writer path and the environment instance even with a matching old binding', async t => {
  await t.test('wrong path', async t => {
    const oldRecord = record => join(dirname(record), 'old.json')
    const f = await world(t, { config: ({ record }) => ({ principalsFile: oldRecord(record) }) })
    f.seed({ [first]: entry }, 2, oldRecord(f.record))
    refused(await f.read(first, f.files.own))
  })
  await t.test('wrong instance', async t => {
    const f = await world(t, { config: () => ({ instanceId: 'old-instance' }) })
    f.seed({ [first]: entry }, 2, f.record, 'old-instance')
    await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
  })
  await t.test('missing environment instance', async t => {
    const f = await world(t, { config: () => ({ instanceId: instance }) })
    f.seed({ [first]: entry })
    delete process.env.AUTOMAGIK_INSTANCE_ID
    await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
  })
  await t.test('explicit matching instance', async t => {
    const f = await world(t, { config: () => ({ instanceId: instance }) })
    allowed(await f.read(first, f.files.own), 'canary-own')
  })
})

test('the wall refuses a linked principal record even when its bytes match the Bot', async t => {
  const f = await world(t)
  const contents = join(f.root, 'record-source.json')
  f.seed({ [first]: entry, [evicted]: entry, [ana]: 'member:ana' }, 2, contents)
  assert.equal(f.ctx.get('automagikBotSessions').botOf(evicted), null)
  assert.equal(await f.wallRead(ana, f.files.shared), 'canary-shared\n')
  for (const link of [symlinkSync, linkSync]) {
    link(contents, f.record)
    await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
    await assert.rejects(() => f.wallRead(evicted, f.files.shared), { code: 'FS_NOT_FOUND' })
    await assert.rejects(() => f.wallRead(ana, f.files.shared), { code: 'FS_NOT_FOUND' })
    unlinkSync(f.record)
  }
})

test('Bot mode denies a session with lost lineage and a member when the path or instance disagrees', async t => {
  const oldRecord = record => join(dirname(record), 'old.json')
  await t.test('wrong path', async t => {
    const f = await world(t, { config: ({ record }) => ({ principalsFile: oldRecord(record) }) })
    f.seed({ [evicted]: entry, [ana]: 'member:ana' }, 2, oldRecord(f.record))
    assert.equal(f.ctx.get('automagikBotSessions').botOf(evicted), null)
    for (const id of [evicted, ana]) await assert.rejects(() => f.wallRead(id, f.files.shared), { code: 'FS_NOT_FOUND' })
  })
  await t.test('wrong instance', async t => {
    const f = await world(t, { config: () => ({ instanceId: 'old-instance' }) })
    f.seed({ [evicted]: entry, [ana]: 'member:ana' }, 2, f.record, 'old-instance')
    assert.equal(f.ctx.get('automagikBotSessions').botOf(evicted), null)
    for (const id of [evicted, ana]) await assert.rejects(() => f.wallRead(id, f.files.shared), { code: 'FS_NOT_FOUND' })
  })
  await t.test('environment changes with the writer still mounted', async t => {
    const f = await world(t, { config: () => ({ instanceId: '' }) })
    f.seed({ [evicted]: entry, [ana]: 'member:ana' })
    assert.equal(f.ctx.get('automagikBotSessions').botOf(evicted), null)
    assert.equal(await f.wallRead(ana, f.files.shared), 'canary-shared\n')
    process.env.AUTOMAGIK_INSTANCE_ID = 'another-instance'
    assert.equal(f.ctx.get('automagikPrincipalRecord').instance, instance)
    for (const id of [evicted, ana]) await assert.rejects(() => f.wallRead(id, f.files.shared), { code: 'FS_NOT_FOUND' })
  })
})

test('Bot mode closes scoped access when the writer is disposed and the resolver is still live', async t => {
  const f = await world(t)
  f.seed({ [first]: entry, [evicted]: entry, [ana]: 'owner' })
  assert.equal(await f.wallRead(ana, f.files.team), 'canary-team\n')
  await f.writer.dispose()
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
  assert.equal(f.ctx.get('automagikBotSessions').botOf(evicted), null)
  for (const [id, file] of [[first, f.files.own], [evicted, f.files.shared], [ana, f.files.team]]) {
    await assert.rejects(() => f.wallRead(id, file), { code: 'FS_NOT_FOUND' })
  }
})

test('a trailing space in the instance is significant to the writer and wall', async t => {
  const f = await world(t, { instanceSetting: 'tenant ' })
  const authority = f.ctx.get('automagikPrincipalRecord')
  assert.equal(authority.instance, 'tenant ')
  const original = f.seed({ [ana]: 'owner' }, 2, f.record, 'tenant')
  assert.equal(f.ctx.get('automagikBotSessions').botOf(ana), null)
  await assert.rejects(() => f.wallRead(ana, f.files.team), { code: 'FS_NOT_FOUND' })
  assert.throws(() => f.step(first), /could not record Bot session .*different instance/)
  assert.equal(readFileSync(f.record, 'utf8'), original)

  unlinkSync(f.record)
  await f.step(first)
  assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), {
    version: 2, instance: 'tenant ', sessions: { [first]: entry },
  })
  assert.equal(await f.wallRead(first, f.files.own), 'canary-own\n')
})

test('the member wall can read a Bot record published under an owner-read-masking umask', async t => {
  const f = await world(t)
  const previous = process.umask(0o477)
  try {
    await f.step(first)
  } finally {
    process.umask(previous)
  }
  assert.equal(statSync(f.record).mode & 0o777, 0o600)
  assert.equal(await f.wallRead(first, f.files.own), 'canary-own\n')
})

test('invalid UTF-8 anywhere in the record denies every scoped session', async t => {
  const f = await world(t)
  const bytes = Buffer.from(f.seed({ [first]: entry, [evicted]: entry, 'broken!': 'member:ana', [ana]: 'owner' }))
  assert.equal(await f.wallRead(ana, f.files.team), 'canary-team\n')
  bytes[bytes.indexOf('!')] = 0xff
  writeFileSync(f.record, bytes)
  assert.equal(f.ctx.get('automagikBotSessions').botOf(evicted), null)
  for (const [id, file] of [[first, f.files.own], [evicted, f.files.shared], [ana, f.files.team], [ana, f.files.shared]]) {
    await assert.rejects(() => f.wallRead(id, file), { code: 'FS_NOT_FOUND' })
  }
})

test('first activation refuses a group-writable record directory created before verification', async t => {
  const bytes = JSON.stringify({ version: 2, instance, sessions: { [first]: entry, [ana]: 'owner' } })
  const mkdir = t.mock.method(fs, 'mkdirSync', (folder, options) => {
    mkdirSync(folder, options)
    if (folder === join(process.env.DSH_HOME, 'multiuser-dsh')) {
      chmodSync(folder, 0o770)
      writeFileSync(join(folder, 'principals.json'), bytes, { mode: 0o600 })
    }
  })
  let f
  try {
    f = await world(t)
  } finally {
    mkdir.mock.restore()
  }
  const folder = dirname(f.record)
  assert.equal(statSync(folder).uid, process.getuid())
  assert.equal(statSync(folder).mode & 0o777, 0o770)
  assert.equal(f.ctx.get('automagikPrincipalRecord'), undefined)
  assert.equal(f.ctx.get('automagikBotSessions').botOf(ana), null)
  await assert.rejects(() => f.wallRead(ana, f.files.team), { code: 'FS_NOT_FOUND' })
  await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
  assert.equal(readFileSync(f.record, 'utf8'), bytes)
})

test('the wall and writer refuse a symlink to a private record directory', async t => {
  const f = await world(t)
  const bytes = f.seed({ [first]: entry, [ana]: 'owner' })
  assert.equal(await f.wallRead(first, f.files.own), 'canary-own\n')
  assert.equal(await f.wallRead(ana, f.files.team), 'canary-team\n')
  const folder = dirname(f.record)
  const other = join(f.root, 'old-record-directory')
  renameSync(folder, other)
  symlinkSync(other, folder)

  await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
  for (const file of [f.files.team, f.files.shared]) {
    await assert.rejects(() => f.wallRead(ana, file), { code: 'FS_NOT_FOUND' })
  }
  assert.throws(() => f.step(first), /could not record Bot session .*private directory/)
  assert.equal(readFileSync(f.record, 'utf8'), bytes)
})

test('the wall refuses a replacement directory during the file open and after it settles', async t => {
  const f = await world(t)
  f.seed({ [first]: entry })
  assert.equal(await f.wallRead(first, f.files.own), 'canary-own\n')
  const folder = dirname(f.record)
  const replacement = join(f.root, 'replacement-directory')
  mkdirSync(replacement, { mode: 0o700 })
  f.seed({ [first]: entry, [ana]: 'owner' }, 2, join(replacement, 'principals.json'))
  assert.equal(f.ctx.get('automagikBotSessions').botOf(ana), null)
  const open = fs.openSync
  let replaced = false
  const mocked = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === f.record && !replaced) {
      renameSync(folder, join(f.root, 'original-directory'))
      renameSync(replacement, folder)
      replaced = true
    }
    return open(file, ...args)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
    await assert.rejects(() => f.wallRead(ana, f.files.team), { code: 'FS_NOT_FOUND' })
    assert.equal(mocked.mock.calls.filter(({ arguments: [file] }) => file === f.record).length, 1)
  } finally {
    mocked.mock.restore()
    syncBuiltinESMExports()
  }
})

test('the writer and wall refuse a removed and recreated record directory', async t => {
  const f = await world(t)
  f.seed({ [ana]: 'owner' })
  assert.equal(await f.wallRead(ana, f.files.team), 'canary-team\n')
  const folder = dirname(f.record)
  rmSync(folder, { recursive: true })
  mkdirSync(folder, { mode: 0o700 })
  const original = f.seed({ [first]: entry, [ana]: 'owner' })
  const { dev, ino } = statSync(folder, { bigint: true })
  assert.notEqual(`${dev}:${ino}`, f.ctx.get('automagikPrincipalRecord').folder)
  await assert.rejects(() => f.wallRead(ana, f.files.team), { code: 'FS_NOT_FOUND' })
  await assert.rejects(() => f.wallRead(first, f.files.own), { code: 'FS_NOT_FOUND' })
  assert.throws(() => f.step(first), /could not record Bot session .*private directory/)
  assert.equal(readFileSync(f.record, 'utf8'), original)
})

for (const [label, options] of [
  ['a tilde home', { tildeHome: true }],
  ['a trailing space', { homeName: 'dsh-home ' }],
]) {
  test(`the wall and writer agree on the DSH home path with ${label}`, async t => {
    const f = await world(t, options)
    await f.step(first)
    assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')).sessions, { [first]: entry })
    assert.equal(await f.wallRead(first, f.files.own), 'canary-own\n')
  })
}
