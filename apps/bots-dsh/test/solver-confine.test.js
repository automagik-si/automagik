import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solver-confine-')))
  const home = join(root, 'team')
  const folder = join(root, 'workspace')
  const work = join(folder, 'project')
  const protectedRoot = join(folder, 'fixture-private')
  const outside = join(root, 'elsewhere')
  for (const path of [home, work, protectedRoot, outside]) mkdirSync(path, { recursive: true })
  const inside = join(work, 'inside.txt')
  const outsideFile = join(outside, 'outside.txt')
  writeFileSync(inside, 'inside fixture')
  writeFileSync(outsideFile, 'independent fixture')
  let cwd = folder
  const ctx = fakeContext({ services: {
    acpAgents: { signInRoots: () => [protectedRoot] },
    workingDirectory: { get: () => cwd, ensure: async () => cwd },
  } })
  apply(ctx, { home })
  const rt = ctx.provided.get('omniTeam')
  t.after(async () => {
    await ctx.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  await rt.load()
  const bot = rt.state.bots['fixture-solver'] = { id: 'fixture-solver', name: 'Solver', role: 'Solver', workDir: folder, createdAt: 1 }
  rt.chatOwners.set(bot.id, bot.id)
  const session = { id: bot.id, header: { id: bot.id, cwd: folder } }
  const agent = { id: bot.id, session }
  const guard = ctx.listeners.get('tools/execute')[0]
  const execute = (name, args, body = () => 'fake body entered') => {
    const exec = { name, arguments: args, callId: 'fixture-call', agent }
    return guard(exec, () => body(exec.arguments))
  }
  return { root, work, folder, inside, outsideFile, protectedRoot, rt, bot, agent, execute, setCwd: path => { cwd = path } }
}

test('#2134 F5 C1-C4 G6 C7 K5a-b confined reads and traversal refuse before an inert body', async t => {
  const w = await setup(t)
  let entered = 0
  const inert = () => { entered += 1 }
  for (const [name, args] of [
    ['read', { file_path: w.outsideFile }],
    ['read_image', { file_path: join(w.protectedRoot, 'absent-image') }],
    ['grep', { path: w.folder, pattern: 'marker' }],
    ['glob', { path: w.folder, pattern: '**' }],
    ['grep', { pattern: 'marker' }],
  ]) await assert.rejects(w.execute(name, args, inert), /can (read and )?search only inside its folder/)
  assert.equal(entered, 0)
  const positive = await w.execute('read', { file_path: w.inside }, args => readFileSync(args.file_path, 'utf8'))
  assert.equal(positive, 'inside fixture')
  assert.equal(await w.execute('glob', { path: w.work, pattern: '**' }), 'fake body entered')
})

test('#2134 K5c passes the checked canonical filename and omitted search root to the inert body', async t => {
  const w = await setup(t)
  const alias = join(w.work, 'alias.txt')
  symlinkSync(w.inside, alias, 'file')
  assert.equal(await w.execute('read', { file_path: alias }, args => args.file_path), w.inside)
  w.setCwd(w.work)
  assert.equal(await w.execute('grep', { pattern: 'fixture' }, args => args.path), w.work)
})

test('#2134 K5d H5 agent-owned paths require a placed, link-free path', async t => {
  const w = await setup(t)
  const alias = join(w.work, 'alias.txt')
  symlinkSync(w.inside, alias, 'file')
  const call = path => ({ agent: w.agent, provider: 'acp-claude', cwd: w.work, args: {
    kind: 'read', input: { file_path: path }, id: 'fixture-marker',
  } })
  assert.equal(w.rt.solverQuestionDecision?.(call(w.inside))?.decision, 'allow')
  assert.equal(w.rt.solverQuestionDecision(call(alias)).decision, 'refuse')
  assert.equal(w.rt.solverQuestionDecision({ ...call('inside.txt'), cwd: undefined }).decision, 'refuse')
})

test('#2134 K3 AW-R3 missing intermediate ownership cannot dispatch a DSH body', async t => {
  const w = await setup(t)
  const sessions = new Map([['child', { header: { id: 'child', origin: 'subagent', parentSession: 'missing' } }]])
  w.rt.ctx.sessions = { get: id => sessions.get(id) }
  const exec = {
    name: 'read', arguments: { file_path: w.inside },
    agent: { id: 'child', session: { id: 'child', header: sessions.get('child').header } },
  }
  let ran = false
  const guard = w.rt.ctx.listeners.get('tools/execute')[0]
  await assert.rejects(guard(exec, () => { ran = true }), /could not confirm this Session.s rules/)
  assert.equal(ran, false)
  sessions.set('missing', { header: { id: 'missing', origin: 'subagent', parentSession: w.bot.id } })
  assert.equal(w.rt.solverPolicyOf('child', exec.agent).bot, w.bot)
  assert.equal(w.rt.botOfSession('child', exec.agent), w.bot)
})
