import assert from 'node:assert/strict'
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFs from '@deepseek-ai/dsh-skill-filesystem'
import * as toolFs from '@deepseek-ai/dsh-tool-fs'
import * as toolSearch from '@deepseek-ai/dsh-tool-fs-search'
import { provideBotSessions } from '../src/host/bot-sessions.js'
import MemberWallFileSystem from '../src/host/member-wall/fs.js'
import { sessionScope } from '../src/host/member-wall/principals.js'
import { officeProvider } from '../src/host/office-skills.js'
import { goalProvider } from '../src/host/goal-skills.js'

const A = 'b-aaaaaaaaaa'
const B = 'b-bbbbbbbbbb'
const OWNER = 'session-owner'
const ANA = 'session-ana'
const CANARY = 'owner-only canary f45a'
const INSTANCE = 'probe-instance'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const entries = { [OWNER]: 'owner', [ANA]: 'member:ana', [A]: `bot:${A}`, [B]: `bot:${B}` }

function layout(t) {
  const root = mkdtempSync(join(tmpdir(), 'member-wall-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dshHome = join(root, 'dsh-home')
  const automagikHome = join(root, 'automagik')
  const team = join(root, 'team')
  const effectiveTeam = join(root, 'effective', 'team')
  const gate = join(root, 'gate-view')
  const members = join(root, 'members')
  const ana = join(members, 'ana')
  const botsRoot = join(root, 'bots')
  const own = join(botsRoot, A)
  const other = join(botsRoot, B)
  const owner = join(root, 'owner')
  const grant = join(root, 'grant')
  const principals = join(dshHome, 'multiuser-dsh', 'principals.json')
  for (const dir of [dirname(principals), automagikHome, team, effectiveTeam, gate, ana, own, other, owner, grant]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const denied = [
    [join(dshHome, 'launch-token'), dshHome], [join(gate, 'launch-token'), gate],
    [join(team, 'secrets.json'), team], [join(automagikHome, 'private.txt'), automagikHome],
    [join(other, 'private.txt'), other], [join(members, 'private.txt'), members],
    [join(ana, 'notes.txt'), ana], [join(owner, 'secret.txt'), owner],
  ]
  for (const [file, dir] of denied) {
    writeFileSync(file, file === join(ana, 'notes.txt') ? 'ana canary\n' : `${CANARY}\n`)
    writeFileSync(join(dir, 'pic.png'), PNG)
  }
  writeFileSync(join(own, 'own.txt'), 'bot canary\n')
  writeFileSync(join(grant, 'guide.txt'), 'grant canary\n')
  writeFileSync(join(effectiveTeam, 'secrets.json'), CANARY)
  writeFileSync(join(dirname(effectiveTeam), 'outside.txt'), 'public by itself\n')
  const record = (sessions = entries, { version = 2, instance = INSTANCE, mode = 0o600 } = {}) => {
    writeFileSync(principals, JSON.stringify({ version, instance, sessions }), { mode })
    chmodSync(principals, mode)
  }
  record()
  const env = {
    AUTOMAGIK_MULTIUSER: '1', AUTOMAGIK_INSTANCE_ID: INSTANCE, DSH_HOME: dshHome,
    AUTOMAGIK_HOME: automagikHome, AUTOMAGIK_BOTS_HOME: team,
  }
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  return { root, dshHome, team, effectiveTeam, gate, members, ana, botsRoot, own, other, owner, grant, principals, denied, record }
}

function configFor(p, overrides) {
  return {
    cwd: p.owner,
    members: true, principalsFile: p.principals, membersRoot: p.members,
    sharedReadRoots: [p.grant], denyReadRoots: [p.dshHome],
    bots: true, botsRoot: p.botsRoot, botReadRoots: { [A]: [p.grant] }, botDenyRoots: [p.gate],
    ...overrides,
  }
}

function mountPolicy(ctx, p) {
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: p.own, additionalWritableRoots: [p.owner, p.grant] }),
  })
}

async function world(t, p, { provider = true, config, skills } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(native)
  mountPolicy(ctx, p)
  provideWorkingDirectoryFixture(ctx, p.own)
  const sessions = new Map([OWNER, ANA, A, B].map(id => [id, { id, header: {} }]))
  const rt = {
    ctx: { sessions },
    botOfSession: id => id === A || id === B ? { id } : undefined,
    teamLoaded: () => true, teamCurrent: () => true,
    home: p.effectiveTeam, dshHome: p.dshHome,
  }
  const mount = () => ctx.plugin(function botSessionFixture(child) { provideBotSessions(child, rt) })
  const { dev, ino } = statSync(dirname(p.principals), { bigint: true })
  ctx.provide('automagikPrincipalRecord', Object.freeze({
    version: 1, file: p.principals, instance: INSTANCE, folder: `${dev}:${ino}`,
  }))
  await ctx.plugin(MemberWallFileSystem, configFor(p, config))
  if (provider) await mount()
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('agents', { list: () => [], get: () => undefined })
  ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) })
  ctx.provide('attachments', {
    imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 20 },
    saveImage: async ({ data, mediaType }) => ({ attachmentId: 'a1', mediaType, bytes: data.length, width: 1, height: 1 }),
  })
  await ctx.plugin(toolFs, {})
  await ctx.plugin(toolSearch, { sampleOverCapGlobResults: false })
  if (skills !== undefined) {
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(skillFs, skills)
    ctx.skills.registerProvider(() => officeProvider())
    ctx.skills.registerProvider(() => goalProvider())
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const name of ['fs', 'tools', 'subprocess']) assert.ok(ctx.get(name), `${name} is mounted`)
  return { ctx, sessions, mount, rt }
}

const agentFor = (id, cwd) => ({
  id,
  options: { provider: 'test', model: 'test' },
  session: { id, header: { cwd }, requestHeader: () => undefined },
})

async function call(ctx, id, cwd, name, args) {
  const agent = agentFor(id, cwd)
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, signal })
  try {
    const out = await ctx.tools.execute({ calls: [{ id: 'read-1', name, arguments: args }], agent, signal, toolSet })
    const { result } = out.results[0]
    return { error: result.isError === true, text: JSON.stringify(result) }
  } finally {
    toolSet.dispose?.()
  }
}

const read = (ctx, id, file) => call(ctx, id, dirname(file), 'read', { file_path: file })
const allowed = (out, label, pattern) => {
  assert.equal(out.error, false, `${label}: ${out.text.slice(0, 300)}`)
  if (pattern) assert.match(out.text, pattern, label)
}
const refused = (out, label, pattern = /not found/) => {
  assert.equal(out.error, true, label)
  assert.match(out.text, pattern, `${label}: ${out.text.slice(0, 300)}`)
  assert.doesNotMatch(out.text, /f45a/, label)
}
const scope = (sessions, run) => sessionScope.run({ sessionId: sessions.at(-1), sessions }, run)
const deniedWrite = { code: 'FS_SANDBOX_DENIED', message: /outside the files this Bot may use/ }

test('member-read FENCED with Bot mode on', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const launch = join(p.dshHome, 'launch-token')
  allowed(await read(ctx, OWNER, launch), 'owner launch control', /f45a/)
  refused(await read(ctx, ANA, launch), 'Ana launch')
  allowed(await read(ctx, ANA, join(p.ana, 'notes.txt')), 'Ana notes', /ana canary/)
})

test('bot-read CLOSED on protected roots with a Bot binding or an owner entry', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const probes = ([file, dir]) => [
    ['read', { file_path: file }],
    ['read_image', { file_path: join(dir, 'pic.png') }],
    ['grep', { pattern: 'canary', path: dir }],
    ['glob', { pattern: '*', path: dir }],
  ]
  for (const location of p.denied) {
    for (const [tool, args] of probes(location)) {
      allowed(await call(ctx, OWNER, p.owner, tool, args), `owner ${tool} at ${location[1]}`)
    }
  }
  for (const [version, entry] of [[2, `bot:${A}`], [1, 'owner'], [2, 'owner']]) {
    p.record({ ...entries, [A]: entry }, { version })
    for (const location of p.denied) {
      for (const [tool, args] of probes(location)) {
        const message = tool === 'grep' || tool === 'glob' ? /outside the files this Bot may search/ : undefined
        refused(await call(ctx, A, p.own, tool, args), `v${version} ${entry} ${tool} at ${location[1]}`, message)
      }
    }
  }
})

test('a Bot uses its own folder for reads, writes and search and its grants for reads', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const own = join(p.own, 'own.txt')
  const grant = join(p.grant, 'guide.txt')
  const owner = join(p.owner, 'secret.txt')
  allowed(await read(ctx, A, own), 'own read', /bot canary/)
  allowed(await read(ctx, A, grant), 'granted read', /grant canary/)
  for (const path of [undefined, p.own]) {
    const at = path === undefined ? {} : { path }
    allowed(await call(ctx, A, p.own, 'grep', { pattern: 'canary', ...at }), 'own grep', /bot canary/)
    allowed(await call(ctx, A, p.own, 'glob', { pattern: '*.txt', ...at }), 'own glob', /own\.txt/)
  }
  allowed(await call(ctx, A, p.own, 'write', { file_path: 'new.txt', content: 'via write tool' }), 'own write tool')
  assert.equal(readFileSync(join(p.own, 'new.txt'), 'utf8'), 'via write tool')
  allowed(await call(ctx, OWNER, p.owner, 'write', { file_path: grant, content: 'grant canary\n' }), 'owner write tool control')
  // DSH renders every FS_SANDBOX_DENIED as a sandbox marker. The calls to ctx.fs below
  // also check the wall's message before the tool maps it.
  refused(await call(ctx, A, p.own, 'write', { file_path: grant, content: 'no' }), 'grant write tool',
    /FS_SANDBOX_DENIED/)
  symlinkSync(p.dshHome, join(p.own, 'dsh-link'))
  refused(await read(ctx, A, join(p.own, 'dsh-link', 'launch-token')), 'link to DSH home')
  const throughB = `${p.other}/../${A}`
  refused(await read(ctx, A, `${throughB}/own.txt`), 'read spelling through the other Bot')
  refused(await call(ctx, A, p.own, 'glob', { pattern: '*.txt', path: throughB }), 'search through the other Bot',
    /outside the files this Bot may search/)

  const [ownTarget, grantTarget, ownerTarget] = await Promise.all([own, grant, owner].map(file => ctx.fs.resolve(file)))
  await scope([OWNER], () => ctx.fs.writeText(ownerTarget, CANARY))
  await scope([OWNER], () => ctx.fs.writeText(grantTarget, 'grant canary\n'))
  await scope([A], async () => {
    await ctx.fs.writeText(ownTarget, 'updated\n')
    await assert.rejects(() => ctx.fs.writeText(grantTarget, 'no'), deniedWrite)
    await assert.rejects(() => ctx.fs.writeText(grantTarget, 'no', undefined, undefined, { mode: 'danger-full-access' }), deniedWrite)
    await assert.rejects(() => ctx.fs.writeText(ownerTarget, 'no'), deniedWrite)
    await assert.rejects(() => ctx.fs.moveFile(ownTarget, ownerTarget, {}), deniedWrite)
    await assert.rejects(() => ctx.fs.moveFile(ownTarget, grantTarget, {}), deniedWrite)
    await assert.rejects(() => ctx.fs.moveFile(grantTarget, ownTarget, {}), deniedWrite)
  })
  assert.equal(readFileSync(own, 'utf8'), 'updated\n')
  assert.equal(readFileSync(grant, 'utf8'), 'grant canary\n')
  assert.equal(readFileSync(owner, 'utf8'), CANARY)
})

test('Bot and unclassified searches require an absolute path when a path is given', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const nested = join(p.own, 'nested')
  mkdirSync(nested)
  for (const [tool, pattern, match] of [['grep', 'canary', /bot canary/], ['glob', '*.txt', /own\.txt/]]) {
    allowed(await call(ctx, A, nested, tool, { pattern, path: `${nested}/..` }), `absolute ${tool} control`, match)
    const reason = new RegExp(`${tool}: give an absolute path`)
    for (const path of ['.', 'nested', 'nested/../.']) {
      refused(await call(ctx, A, p.own, tool, { pattern, path }), `relative ${tool} for a Bot: ${path}`, reason)
    }
    refused(await call(ctx, 'unknown', p.own, tool, { pattern, path: '.' }), `relative ${tool} for NOBODY`, reason)
    allowed(await call(ctx, OWNER, p.own, tool, { pattern, path: '.' }), `relative ${tool} for the owner`, match)
    allowed(await call(ctx, ANA, p.ana, tool, { pattern, path: '.' }), `relative ${tool} for a member`,
      tool === 'grep' ? /ana canary/ : /notes\.txt/)
  }
})

test('a matching Bot entry confers no access before the team is loaded and current', async t => {
  const p = layout(t)
  const { ctx, rt } = await world(t, p)
  const file = join(p.own, 'own.txt')
  allowed(await read(ctx, A, file), 'matching Bot entry with a ready team', /bot canary/)
  rt.teamLoaded = () => false
  refused(await read(ctx, A, file), 'team not loaded')
  rt.teamLoaded = () => true
  rt.teamCurrent = () => false
  refused(await read(ctx, A, file), 'team no longer current')
  rt.teamCurrent = () => undefined
  refused(await read(ctx, A, file), 'team currency is unknown')
  delete rt.teamCurrent
  refused(await read(ctx, A, file), 'team currency check is missing')
})

test('a Bot cannot read a hard link to a protected file through a grant', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const linked = join(p.grant, 'linked.txt')
  linkSync(join(p.dshHome, 'launch-token'), linked)
  allowed(await read(ctx, OWNER, linked), 'owner can read the linked file', /f45a/)
  refused(await read(ctx, A, linked), 'Bot reading a hard link')
  allowed(await read(ctx, A, join(p.grant, 'guide.txt')), 'ordinary file beside the hard link', /grant canary/)
})

test('write rechecks the target DSH resolved after the initial wall check', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const link = join(p.own, 'link.txt')
  const grantedFile = join(p.grant, 'guide.txt')
  symlinkSync(join(p.own, 'own.txt'), link)
  const target = await ctx.fs.resolve(link)
  const resolve = MemberWallFileSystem.prototype.resolve
  t.mock.method(MemberWallFileSystem.prototype, 'resolve', function (spelling, ...args) {
    if (spelling === target.displayPath) {
      unlinkSync(link)
      symlinkSync(grantedFile, link)
    }
    return resolve.call(this, spelling, ...args)
  })
  await scope([A], async () => {
    await assert.rejects(() => ctx.fs.writeText(target, 'outside'), {
      code: 'FS_SANDBOX_DENIED', message: /outside the files this Bot may use/,
    })
  })
  assert.equal(readFileSync(grantedFile, 'utf8'), 'grant canary\n')
})

test('children inherit Bot restrictions and an unknown or lost lineage cannot become owner', async t => {
  const p = layout(t)
  const { ctx, sessions } = await world(t, p)
  sessions.set('child', { header: { origin: 'subagent', parentSession: A } })
  sessions.set('unknown-parent', { header: { origin: 'subagent', parentSession: 'missing' } })
  sessions.set('evicted', { header: {} })
  p.record({ ...entries, child: `bot:${A}`, 'unknown-parent': 'owner', evicted: `bot:${A}` })
  const launch = join(p.dshHome, 'launch-token')
  allowed(await read(ctx, 'child', join(p.own, 'own.txt')), 'child uses Bot folder', /bot canary/)
  for (const id of ['child', 'unknown-parent', 'evicted']) refused(await read(ctx, id, launch), id)
  for (const id of ['unknown-parent', 'evicted']) {
    refused(await read(ctx, id, join(p.grant, 'guide.txt')), `${id} has no shared access`)
  }
})

test('a combined scope needs the Bot and the other principal to allow each path in either order', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const launch = join(p.dshHome, 'launch-token')
  const own = join(p.own, 'own.txt')
  const files = { member: join(p.ana, 'notes.txt'), shared: join(p.grant, 'guide.txt') }
  for (const sessions of [[A, OWNER], [OWNER, A], [A, ANA], [ANA, A]]) {
    await scope(sessions, async () => {
      refused(await read(ctx, sessions.at(-1), launch), `${sessions} launch`)
      refused(await read(ctx, sessions.at(-1), files.member), `${sessions} member area`)
      allowed(await read(ctx, sessions.at(-1), files.shared), `${sessions} shared area`, /grant canary/)
      const out = await read(ctx, sessions.at(-1), own)
      if (sessions.includes(ANA)) refused(out, `${sessions} Bot area outside member reach`)
      else allowed(out, `${sessions} Bot area`, /bot canary/)
    })
  }
})

test('an fs-first wall follows provision and disposal of the resolver at decision time', async t => {
  const p = layout(t)
  const { ctx, mount } = await world(t, p, { provider: false })
  const file = join(p.owner, 'secret.txt')
  const target = await ctx.fs.resolve(file)
  const withoutProvider = async () => {
    assert.equal(ctx.get('automagikBotSessions'), undefined)
    refused(await read(ctx, OWNER, file), 'owner entry with no service')
    await scope([OWNER], () => assert.rejects(() => ctx.fs.writeText(target, 'no'), deniedWrite))
  }
  await withoutProvider()
  const fiber = mount()
  await fiber
  assert.equal(ctx.get('automagikBotSessions')?.version, 1)
  allowed(await read(ctx, OWNER, file), 'owner entry once the provider is available', /f45a/)
  await scope([OWNER], () => ctx.fs.writeText(target, CANARY))
  await fiber.dispose()
  await withoutProvider()
})

test('records with the wrong instance, open permissions, foreign uid or an array do not confer trust', async t => {
  const p = layout(t)
  const { ctx, sessions } = await world(t, p)
  const owner = join(p.owner, 'secret.txt')
  const own = join(p.own, 'own.txt')
  const grant = join(p.grant, 'guide.txt')
  const invalid = async (label, rejectedLeaf = false) => {
    refused(await read(ctx, OWNER, owner), `${label}: owner entry`)
    if (rejectedLeaf) {
      refused(await read(ctx, OWNER, grant), `${label}: rejected leaf denies shared access`)
    } else {
      allowed(await read(ctx, OWNER, grant), `${label}: verified person falls back to member`, /grant canary/)
    }
    refused(await read(ctx, A, own), `${label}: Bot entry`)
  }
  allowed(await read(ctx, OWNER, owner), 'owner positive control', /f45a/)
  allowed(await read(ctx, A, own), 'right instance Bot binding', /bot canary/)
  p.record(entries, { instance: 'other-instance' })
  await invalid('wrong instance')
  p.record(entries, { mode: 0o644 })
  await invalid('open mode', true)
  sessions.set('0', { header: {} })
  p.record({ '0': 'owner' })
  allowed(await read(ctx, '0', owner), 'verified session 0 with an owner entry', /f45a/)
  p.record(['owner'])
  refused(await read(ctx, '0', owner), 'array cannot confer owner access to session 0')
  allowed(await read(ctx, '0', grant), 'verified session 0 falls back to member', /grant canary/)
  p.record()
  allowed(await read(ctx, OWNER, owner), 'owner positive control before UID change', /f45a/)
  const uid = process.getuid()
  t.mock.method(process, 'getuid', () => uid + 1)
  await invalid('foreign uid', true)
})

test('construction refuses forbidden grants, a linked Bot root and disabled prerequisites', async t => {
  const p = layout(t)
  const link = join(p.root, 'linked-bots')
  symlinkSync(p.botsRoot, link)
  const construct = config => {
    const ctx = new Context()
    mountPolicy(ctx, p)
    t.after(() => ctx.fiber.dispose())
    return new MemberWallFileSystem(ctx, MemberWallFileSystem.Config(configFor(p, config)))
  }
  for (const root of [p.dshHome, join(p.team, 'inside'), p.ana, p.other, p.botsRoot, p.root]) {
    assert.throws(() => construct({ botReadRoots: { [A]: [root] } }), /member wall: a botReadRoots grant overlaps/)
  }
  assert.throws(() => construct({ botsRoot: link }), /member wall: botsRoot/)
  assert.throws(() => construct({ members: false }), /member wall: bots on needs members on/)
  delete process.env.AUTOMAGIK_MULTIUSER
  assert.throws(() => construct({}), /member wall: bots on needs AUTOMAGIK_MULTIUSER on/)
})

test('the provider protects an effective team home and suppresses grants that hold it', async t => {
  const p = layout(t)
  const parent = dirname(p.effectiveTeam)
  const { ctx } = await world(t, p, { config: { botReadRoots: { [A]: [parent] }, denyReadRoots: [] } })
  const outside = join(parent, 'outside.txt')
  allowed(await read(ctx, OWNER, outside), 'owner can use the static grant path', /public by itself/)
  refused(await read(ctx, A, outside), 'grant holds an effective protected root')
  refused(await read(ctx, A, join(p.effectiveTeam, 'secrets.json')), 'effective team secrets')
})

test('Bot access needs a provider with valid protected roots', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p, { provider: false })
  const provider = { version: 1, botOf: id => id === A ? A : null }
  ctx.provide('automagikBotSessions', provider)
  const file = join(p.own, 'own.txt')
  const grant = join(p.grant, 'guide.txt')
  for (const [label, roots] of [
    ['absent method'],
    ['undefined roots', () => undefined],
    ['non-array roots', () => p.dshHome],
    ['empty roots', () => []],
    ['one root', () => [p.dshHome]],
    ['non-string root', () => [p.dshHome, 0]],
    ['relative root', () => [p.dshHome, 'relative']],
    ['throwing method', () => { throw new Error('unavailable') }],
  ]) {
    if (roots !== undefined) provider.protectedRoots = roots
    refused(await read(ctx, A, file), `${label}: own folder`)
    refused(await read(ctx, A, grant), `${label}: granted folder`)
  }
  provider.protectedRoots = () => [p.effectiveTeam, p.dshHome]
  allowed(await read(ctx, A, file), 'valid provider: own folder', /bot canary/)
  allowed(await read(ctx, A, grant), 'valid provider: granted folder', /grant canary/)
})

test('a change to the Bot root owner closes the own folder and grants', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const own = join(p.own, 'own.txt')
  const grant = join(p.grant, 'guide.txt')
  allowed(await read(ctx, A, own), 'own folder before ownership change', /bot canary/)
  allowed(await read(ctx, A, grant), 'grant before ownership change', /grant canary/)
  const lstat = fs.lstatSync
  const mock = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    const info = lstat(path, ...args)
    if (path === p.botsRoot) info.uid = process.getuid() + 1
    return info
  })
  syncBuiltinESMExports()
  try {
    refused(await read(ctx, A, own), 'own folder with a foreign root owner')
    refused(await read(ctx, A, grant), 'grant with a foreign root owner')
  } finally {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('an own folder must be private and unlinked and its Bot root must keep its identity', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p)
  const file = join(p.own, 'own.txt')
  allowed(await read(ctx, A, file), 'private own folder control', /bot canary/)
  chmodSync(p.botsRoot, 0o720)
  refused(await read(ctx, A, file), 'group-writable Bot root')
  refused(await read(ctx, A, join(p.grant, 'guide.txt')), 'group-writable Bot root refuses grants too')
  chmodSync(p.botsRoot, 0o700)
  chmodSync(p.own, 0o755)
  refused(await read(ctx, A, file), 'open own folder')
  assert.equal(statSync(p.own).mode & 0o777, 0o755)
  const saved = join(p.root, 'saved')
  renameSync(p.own, saved)
  chmodSync(saved, 0o700)
  symlinkSync(saved, p.own)
  refused(await read(ctx, A, file), 'linked own folder')
  unlinkSync(p.own)
  await scope([A], async () => {
    await ctx.fs.writeText(await ctx.fs.resolve(file), 'made in a new folder')
  })
  assert.equal(statSync(p.own).mode & 0o777, 0o700)
  renameSync(p.botsRoot, join(p.root, 'old-root'))
  mkdirSync(p.botsRoot, { mode: 0o700 })
  refused(await read(ctx, A, join(p.grant, 'guide.txt')), 'changed Bot root refuses grants too')
  assert.equal(existsSync(p.own), false)
})

test('with Bots off a v1 owner reads as owner and v2 falls back to member', async t => {
  const p = layout(t)
  const { ctx } = await world(t, p, { provider: false, config: { bots: false } })
  const file = join(p.owner, 'secret.txt')
  refused(await read(ctx, OWNER, file), 'v2 ignored without Bot mode')
  allowed(await read(ctx, OWNER, join(p.grant, 'guide.txt')), 'member fallback uses the shared root', /grant canary/)
  p.record(entries, { version: 1 })
  allowed(await read(ctx, OWNER, file), 'v1 owner', /f45a/)
})

test('MEASURE skill catalog, body and resource reach for each provider', async t => {
  const p = layout(t)
  const home = join(p.dshHome, 'skills')
  const bundled = join(p.dshHome, 'bundled')
  const custom = join(p.own, 'custom')
  const filesystem = [
    ['default', 'probe-default', home], ['bundled', 'probe-bundled', bundled], ['custom', 'probe-custom', custom],
  ]
  for (const [, name, base] of filesystem) {
    const dir = join(base, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Probe skill\n---\nRead notes.txt\n`)
    writeFileSync(join(dir, 'notes.txt'), `${name} resource\n`)
  }
  const { ctx } = await world(t, p, {
    skills: { includeDefaultRoots: true, dshHome: p.dshHome, agentsHome: p.dshHome, bundledSkillDir: bundled,
      customSkillDirs: [custom], watch: false },
  })
  const sources = [
    ...filesystem.map(([source, name]) => [source, name, 'notes.txt']),
    ['officeProvider', 'office', 'SKILL.md'], ['officeProvider', 'office-tools', 'SKILL.md'],
    ['goalProvider', 'goal-grill', 'SKILL.md'],
  ]
  const resources = new Map()
  for (const [principal, id] of [['owner', OWNER], ['bot', A]]) {
    await scope([id], async () => {
      const options = { scope: agentFor(id, p.own), cwd: p.own }
      const names = new Set((await ctx.skills.list(options)).map(skill => skill.name))
      for (const [source, name, resource] of sources) {
        const body = await ctx.skills.get(name, options)
        if (principal === 'owner' && body?.resourceBase?.kind === 'directory') {
          resources.set(name, join(body.resourceBase.path, resource))
        }
        const path = resources.get(name)
        let readable = false
        if (path !== undefined) {
          try {
            await ctx.fs.readText(await ctx.fs.resolve(path))
            readable = true
          } catch (error) {
            if (error.code !== 'FS_NOT_FOUND') throw error
          }
        }
        t.diagnostic(`MEASURE ${source} ${name} ${principal} listed=${names.has(name)} body=${Boolean(body?.content)} resource=${readable}`)
      }
    })
  }
})

// RFC 0038 delivery 3 (#1374): the OS half of the probe, against the real member runner with real
// uids. CI's runner-vm job sets it up as root on a throwaway VM (am/test/vm-run.sh, VM-RUN.md rows
// 1-32), then runs these three rows as root with AUTOMAGIK_RUNNER_VM_PROBE naming the endpoint it
// wrote. Each Bot command goes through the shipped bot_shell client (src/host/runner-client.js) in a
// child that drops from root to DSH's account first. Anywhere else the rows skip, saying why; with
// the variable set they must run, so a broken VM setup fails instead of skipping.
const RUNNER_VM = process.env.AUTOMAGIK_RUNNER_VM_PROBE
const runnerVm = RUNNER_VM ? false
  : 'needs the real-uid member runner: CI runner-vm sets AUTOMAGIK_RUNNER_VM_PROBE as root after am/test/vm-run.sh'
const RUNNER_CLIENT = new URL('../src/host/runner-client.js', import.meta.url).href
const BOT_SHELL_TOOL = new URL('../src/host/bot-shell.js', import.meta.url).href
const HARNESS = new URL('./harness-resolve.mjs', import.meta.url).href
// Imports the client (and, for a tool request, the bot_shell tool) while still root, since the
// checkout may be closed to DSH's account, then drops to DSH's uid, gid and groups for good, then
// asks the runner for one Bot command: through run(), or through the tool's own execute() with
// the request shellRequest() makes from the model's arguments.
const AS_DSH = `
const { client, tool, groups, gid, uid, request } = JSON.parse(process.argv[1])
const { run } = await import(client)
const shell = tool ? await import(tool) : undefined
process.setgroups(groups)
process.setgid(gid)
process.setuid(uid)
const extra = process.getgroups().filter(group => group !== gid)
if (process.getuid() !== uid || process.geteuid() !== uid || process.getegid() !== gid
  || JSON.stringify(extra) !== JSON.stringify(groups)) process.exit(70)
let result
if (shell) {
  const config = { workRoot: process.env.AUTOMAGIK_BOT_RUNNER_WORK_ROOT }
  const dispatch = args => shell.shellRequest(config, request.botId, args, 'workspace-write', why => new Error(why))
  result = await shell.createBotShell(dispatch).execute(request.args, { signal: new AbortController().signal })
} else {
  result = await run(request)
}
process.stdout.write(JSON.stringify(result))
`

function runnerVmEndpoint() {
  assert.equal(process.platform, 'linux', 'AUTOMAGIK_RUNNER_VM_PROBE is set: the runner VM is Linux')
  assert.equal(process.getuid(), 0, 'AUTOMAGIK_RUNNER_VM_PROBE is set: these rows run as root on the VM')
  const vm = JSON.parse(readFileSync(RUNNER_VM, 'utf8'))
  for (const key of ['socket', 'proofs', 'workRoot', 'homesRoot', 'node', 'launch', 'gateStore', 'ownerCanary', 'dshHome', 'gateUser']) {
    assert.equal(typeof vm[key], 'string', `probe endpoint ${key}`)
  }
  for (const key of ['runnerUid', 'socketGid', 'dshUid', 'dshGid', 'uidStart', 'uidCount']) {
    assert.ok(Number.isInteger(vm[key]) && vm[key] > 0, `probe endpoint ${key}`)
  }
  return vm
}

// `tool` sends model arguments ({ command, cwd?, timeoutMs? }) through bot_shell instead of argv.
function botCommand(vm, botId, argv, { socketGroup = true, cwd = join(vm.workRoot, '.bots', botId), tool } = {}) {
  const request = tool ? { botId, args: tool } : { botId, argv, cwd, timeoutMs: 60_000 }
  const input = JSON.stringify({
    client: RUNNER_CLIENT, tool: tool ? BOT_SHELL_TOOL : undefined,
    groups: socketGroup ? [vm.socketGid] : [], gid: vm.dshGid, uid: vm.dshUid, request,
  })
  const child = spawnSync(process.execPath, ['--import', HARNESS, '--input-type=module', '-e', AS_DSH, input], {
    cwd: '/',
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      AUTOMAGIK_BOT_RUNNER_SOCKET: vm.socket,
      AUTOMAGIK_BOT_RUNNER_PROOFS: vm.proofs,
      AUTOMAGIK_BOT_RUNNER_WORK_ROOT: vm.workRoot,
      AUTOMAGIK_BOT_RUNNER_UID: String(vm.runnerUid),
      AUTOMAGIK_BOT_RUNNER_GID: String(vm.socketGid),
    },
  })
  assert.equal(child.status, 0, `the DSH-side child for ${tool?.command ?? argv.join(' ')}: ${child.stderr}`)
  return JSON.parse(child.stdout)
}

// The account's own read, as that account (setpriv), proving each canary is there to be refused.
function readAs(user, file) {
  const out = spawnSync('setpriv', ['--reuid', user, '--regid', user, '--init-groups', '--', 'cat', file], {
    cwd: '/', encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(out.status, 0, `${user} reads ${file}: ${out.stderr}`)
  return out.stdout
}

// cat and touch exit 1 on a refused file; ls exits 2 on a folder named on its command line.
const denied = (result, label, code = 1) => {
  assert.equal(result.code, code, `${label}: exit code (${JSON.stringify(result)})`)
  assert.equal(result.refusal, undefined, `${label}: the runner ran it`)
  assert.match(result.stderr, /Permission denied/, label)
  assert.doesNotMatch(result.stdout, /canary|secret/, label)
}

test('delivery 3: bot-shell', { skip: runnerVm }, () => {
  const vm = runnerVmEndpoint()
  const inRange = uid => Number.isInteger(uid) && uid >= vm.uidStart && uid < vm.uidStart + vm.uidCount
  // Through the shipped bot_shell tool, as a model's call reaches it (timeoutMs within this
  // runner's maxTimeoutMs: the tool's own default is 120000).
  const a = botCommand(vm, A, null, { tool: { command: 'id -u; echo "$HOME"; pwd', timeoutMs: 60_000 } })
  assert.equal(a.code, 0, JSON.stringify(a))
  const [uidA, home, cwd] = a.stdout.trim().split('\n')
  const b = botCommand(vm, B, ['id', '-u'])
  assert.equal(b.code, 0, JSON.stringify(b))
  const uidB = Number(b.stdout.trim())
  for (const uid of [Number(uidA), uidB]) {
    assert.ok(inRange(uid), `Bot uid ${uid} is in the runner's range`)
    assert.notEqual(uid, vm.dshUid, 'a Bot is not DSH')
    assert.notEqual(uid, vm.runnerUid, 'a Bot is not the runner')
    assert.notEqual(uid, 0, 'a Bot is not root')
  }
  assert.notEqual(Number(uidA), uidB, 'two Bots, two uids')
  assert.equal(home, join(vm.homesRoot, '.bots', A))
  assert.equal(cwd, join(vm.workRoot, '.bots', A))
  // No fallback, from the client: without the runner endpoint the bot_shell tool refuses with 125
  // before it connects, and runs nothing itself.
  const alone = botCommand(vm, A, null, { socketGroup: false, tool: { command: 'echo ran-locally', timeoutMs: 60_000 } })
  assert.equal(alone.code, 125, JSON.stringify(alone))
  assert.equal(alone.refusal?.code, 'UNAVAILABLE')
  assert.equal(alone.stdout, '')
  // No fallback, from the real runner: a cwd that leaves the Bot's area through a link inside it
  // passes the tool's and the client's path checks, and the runner refuses it over the connection
  // with 125. The marker is in DSH's own folder, which a command run as DSH (a fallback) could
  // write: DSH makes a sibling there first, as the control.
  const link = botCommand(vm, A, ['ln', '-sfn', '/etc', 'probe-escape'])
  assert.equal(link.code, 0, JSON.stringify(link))
  const control = spawnSync('setpriv', ['--reuid', String(vm.dshUid), '--regid', String(vm.dshGid), '--init-groups', '--',
    'touch', join(vm.dshHome, 'probe-control')], { cwd: '/', encoding: 'utf8', timeout: 30_000 })
  assert.equal(control.status, 0, `DSH can write its own folder: ${control.stderr}`)
  const marker = join(vm.dshHome, 'probe-escape-ran')
  const escaped = botCommand(vm, A, null, { tool: { command: `touch '${marker}'`, cwd: 'probe-escape', timeoutMs: 60_000 } })
  assert.equal(escaped.code, 125, JSON.stringify(escaped))
  assert.equal(escaped.refusal?.code, 'BAD_CWD', JSON.stringify(escaped))
  assert.equal(escaped.stdout, '')
  assert.equal(existsSync(marker), false, 'the refused command did not run, as the Bot or as DSH')
})

test('delivery 3: gate-credential', { skip: runnerVm }, () => {
  const vm = runnerVmEndpoint()
  assert.equal(readAs(String(vm.dshUid), vm.launch), 'launch-canary\n')
  assert.equal(readAs(vm.gateUser, vm.gateStore), 'gate-canary\n')
  denied(botCommand(vm, A, ['cat', vm.launch]), 'Bot read of the launch file')
  denied(botCommand(vm, A, ['cat', vm.gateStore]), 'Bot read of the gate store')
})

test('delivery 3: bot-owner-rights', { skip: runnerVm }, () => {
  const vm = runnerVmEndpoint()
  assert.equal(readAs(String(vm.dshUid), vm.ownerCanary), 'canary\n')
  denied(botCommand(vm, A, ['cat', vm.ownerCanary]), 'Bot read of an owner file')
  const touched = join(vm.dshHome, 'probe-x')
  denied(botCommand(vm, A, ['touch', touched]), 'Bot write in the owner folder')
  assert.equal(existsSync(touched), false)
  const socket = botCommand(vm, A, [vm.node, '-e',
    "require('net').connect(process.argv[1]).on('error',e=>{console.log(e.code);process.exit(1)})", vm.socket])
  assert.equal(socket.code, 1, JSON.stringify(socket))
  assert.equal(socket.stdout.trim(), 'EACCES', 'a Bot cannot reach the runner to ask for another identity')
  const wrote = botCommand(vm, A, ['sh', '-c', 'echo secret-probe > "$HOME/.probe-a"'])
  assert.equal(wrote.code, 0, JSON.stringify(wrote))
  denied(botCommand(vm, B, ['cat', join(vm.homesRoot, '.bots', A, '.probe-a')]), "Bot B read of Bot A's home")
  denied(botCommand(vm, B, ['ls', join(vm.workRoot, '.bots', A)]), "Bot B listing of Bot A's work area", 2)
})
