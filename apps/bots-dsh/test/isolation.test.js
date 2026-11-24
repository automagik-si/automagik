// Installed into someone's own DSH, the team keeps its files in $AUTOMAGIK_HOME/bots and writes
// nothing under DSH_HOME (DSH's own Sessions and workspaces are DSH's business, and the
// fake context keeps those in memory).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { makeSkillFixtureWritable } from './fixtures/skill-home-cleanup.mjs'

const filesUnder = (dir) => {
  const out = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.push(relative(dir, path))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out.sort()
}

function start(config = {}, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'omni-isolation-'))
  const dshHome = join(root, 'dsh')
  const automagikHome = join(root, 'automagik')
  mkdirSync(dshHome)
  const saved = { DSH_HOME: process.env.DSH_HOME, AUTOMAGIK_HOME: process.env.AUTOMAGIK_HOME, AUTOMAGIK_BOTS_HOME: process.env.AUTOMAGIK_BOTS_HOME, ...env }
  for (const key of Object.keys(saved)) saved[key] = process.env[key]
  process.env.DSH_HOME = dshHome
  process.env.AUTOMAGIK_HOME = automagikHome
  delete process.env.AUTOMAGIK_BOTS_HOME
  Object.assign(process.env, env)
  const ctx = fakeContext()
  const rt = createRuntime(ctx, config)
  const stop = async () => {
    await ctx.dispose()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  return { root, dshHome, automagikHome, rt, stop }
}

test('with no home configured, the team lives in $AUTOMAGIK_HOME/bots and nothing lands under DSH_HOME', async (t) => {
  const { dshHome, automagikHome, rt, stop } = start()
  t.after(stop)
  assert.equal(rt.home, join(automagikHome, 'bots'))
  await rt.load()
  rt.state.prefs.quiet = true
  await rt.save()
  assert.deepEqual(filesUnder(join(automagikHome, 'bots')).filter(name => name.startsWith('state.')), ['state.json', 'state.lock'])
  assert.deepEqual(filesUnder(dshHome), [])
})

test('AUTOMAGIK_BOTS_HOME names the team\'s home (the desktop app keeps its own team)', async (t) => {
  const own = join(tmpdir(), `automagik-bots-${process.pid}`)
  const { rt, stop } = start({}, { AUTOMAGIK_BOTS_HOME: own })
  t.after(stop)
  assert.equal(rt.home, own)
})

test('a team kept under ~/.dsh/bot before is copied in only when asked, and left where it was', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'omni-import-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const old = join(root, 'old-bot')
  mkdirSync(old)
  const team = JSON.stringify({ version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, exchanges: [], revision: 7 })
  writeFileSync(join(old, 'state.json'), team)
  writeFileSync(join(old, 'state.lock'), '{"pid":1}')

  const plain = start()
  t.after(plain.stop)
  assert.equal(existsSync(join(plain.automagikHome, 'bots', 'state.json')), false)

  const asked = start({ importHome: old })
  t.after(asked.stop)
  assert.equal(existsSync(join(asked.automagikHome, 'bots', 'state.json')), true)
  assert.equal(filesUnder(old).join(','), 'state.json,state.lock')
})

test('skill import: excludes store aliases, preserves the destination and ignores imported trust fields', async t => {
  const root = mkdtempSync(join(tmpdir(), 'omni-skill-import-'))
  t.after(() => {
    makeSkillFixtureWritable(join(root, 'target'))
    rmSync(root, { recursive: true, force: true })
  })
  const source = join(root, 'source')
  const target = join(root, 'target')
  mkdirSync(join(source, 'Skills'), { recursive: true })
  mkdirSync(join(target, 'skills'), { recursive: true })
  writeFileSync(join(source, 'Skills', 'unverified'), 'source')
  writeFileSync(join(target, 'skills', 'existing'), 'destination')
  const item = { name: 'field-guide', kind: 'skill', description: 'Keep notes', content: 'Write a short note.' }
  const hash = 'b9b358086a46b5258de7d18d14ed7d8e692874155873e351d8abde3fed0c5697'
  const items = {
    [item.name]: {
      ...item, skillFormat: 1, hash, files: [{ path: 'SKILL.md' }],
      accepted: { by: 'move' }, source: { kind: 'bot' }, check: { verdict: 'pass' },
    },
    'folder-guide': { ...item, name: 'folder-guide', skillFormat: 1, hash, files: [{ path: 'SKILL.md' }, { path: 'notes.md' }] },
  }
  writeFileSync(join(source, 'state.json'), JSON.stringify({
    version: 2, mainBotIds: [], bots: {}, rooms: {}, agents: {}, exchanges: [], revision: 1, capabilities: { items },
  }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home: target, importHome: source, diagnosticsFile: false, github: false })
  t.after(() => ctx.dispose())
  assert.equal(existsSync(join(target, 'Skills')), false)
  assert.equal(existsSync(join(target, 'skills')), false)
  const aside = readdirSync(target).find(name => name.startsWith('skills.pre-import-'))
  assert.equal(readFileSync(join(target, aside, 'existing'), 'utf8'), 'destination')
  assert.equal(readFileSync(join(source, 'Skills', 'unverified'), 'utf8'), 'source')
  const gates = []
  rt.skillGate = request => { gates.push(request) }
  await rt.load()
  await rt.skillsReady()
  assert.deepEqual(gates.map(({ op, imported, source, legacy, previous }) => ({ op, imported, source, legacy, previous })), [
    { op: 'restore', imported: true, source: { kind: 'text' }, legacy: false, previous: undefined },
  ])
  const saved = rt.state.capabilities.items[item.name]
  assert.equal(saved.hash, hash)
  assert.equal(saved.accepted, undefined)
  assert.deepEqual(saved.source, { kind: 'text' })
  assert.equal(rt.skillDelivery('folder-guide').status.state, 'changed')
  assert.equal(rt.skillStore.readLedger().names[item.name].generations[hash].via, 'import')
})

test('skill import: refuses aliases that collide before copying either source', t => {
  const root = mkdtempSync(join(tmpdir(), 'omni-skill-import-collision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const target = join(root, 'target')
  mkdirSync(join(source, 'skills'), { recursive: true })
  if (existsSync(join(source, 'SKILLS'))) return t.skip('case-insensitive scratch filesystem')
  mkdirSync(join(source, 'SKILLS'))
  writeFileSync(join(source, 'state.json'), '{}')
  assert.throws(() => createRuntime(fakeContext(), { home: target, importHome: source }), /conflicting skill store names/)
  assert.equal(existsSync(target), false)
})
