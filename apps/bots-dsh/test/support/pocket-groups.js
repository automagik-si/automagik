import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../../index.js'
import { bookFile } from '../../src/host/books.js'
import { GroupSource, roomTerminalOf } from '../../src/host/pocket-groups.js'
import { fakeContext } from '../fake-ctx.js'

export const roomSeed = (id = 'r1', fields = {}) => ({
  id, name: 'Ops', members: ['a', 'b'], admin: 'b', named: true, mode: 'admin',
  sessions: { b: 'gb' }, log: [], seq: 0, seen: {}, ...fields,
})
export const terminal = roomTerminalOf('r1')
export const phoneArgs = { phone: 'phone-a', by: 'Pocket A', mine: () => true }
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const readState = home => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))

export function writeBook(home, id, records, dirname = 'ledger') {
  mkdirSync(join(home, dirname), { recursive: true })
  writeFileSync(join(home, dirname, dirname === 'ledger' ? bookFile(`group-${id}`) : `${id}.jsonl`),
    records.map(record => JSON.stringify(record) + '\n').join(''))
}

const bot = (id, name) => ({ id, name, role: name, sessionId: id, createdAt: 1 })
const seed = () => ({
  version: 2, workspaceId: 'workspace', mainBotIds: ['a'],
  bots: { a: bot('a', 'Main'), b: bot('b', 'Writer'), c: bot('c', 'Reader') },
  rooms: { r1: roomSeed() }, agents: {}, exchanges: [], exchangeTurns: {},
  prefs: {}, revision: 0,
})

export async function host(t, { rooms, beforeLoad, load = true, start = true, home: givenHome } = {}) {
  const home = givenHome ?? mkdtempSync(join(tmpdir(), 'pgrp-'))
  const workspace = join(home, 'workspace')
  const automagik = join(home, 'automagik')
  const dsh = join(home, 'dsh')
  const oldHome = process.env.AUTOMAGIK_HOME
  const oldDsh = process.env.DSH_HOME
  process.env.AUTOMAGIK_HOME = automagik
  process.env.DSH_HOME = dsh
  if (!givenHome) {
    const state = seed()
    if (rooms) state.rooms = rooms
    writeFileSync(join(home, 'state.json'), JSON.stringify(state))
    for (const dir of [workspace, automagik, dsh]) mkdirSync(dir)
    writeFileSync(join(automagik, 'bots.json'), '{}')
  }
  beforeLoad?.(home, workspace)
  const loaded = [{ id: 'gb', header: { cwd: workspace } }]
  const levels = new Map()
  const folders = new Map()
  const options = ['read-only', 'workspace-write', 'full-access'].map(value => ({ value }))
  const specs = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const services = {
    permissionPresets: {
      catalog: () => ({ options, defaultPreset: 'workspace-write' }),
      resolve: level => specs[level],
      current: session => levels.get(session.id) ?? 'workspace-write',
      set: (session, level) => levels.set(session.id, level),
    },
    workingDirectory: { get: session => folders.get(session.id) },
  }
  const ctx = fakeContext({ services })
  const effect = ctx.effect
  ctx.effect = (run, label) => {
    if (label !== 'ds-bot: pocket chat') effect(run, label)
  }
  const agents = new Map()
  function agentOf(id) {
    if (!agents.has(id)) {
      const nextTurn = []
      const calls = []
      const session = loaded.find(session => session.id === id) ?? { id }
      agents.set(id, {
        id, session, cancel() {}, calls,
        inbox: {
          nextStep: [], nextTurn,
          remove(id) {
            const at = nextTurn.findIndex(message => message.id === id)
            if (at < 0) return false
            nextTurn.splice(at, 1)
            return true
          },
        },
        followup: message => { calls.push(message); nextTurn.push(message) },
        steer: message => calls.push(message),
        ctx: { tools: { restrict: () => () => {} } },
      })
    }
    return agents.get(id)
  }
  const prompts = []
  const workspaceEntry = { id: 'workspace', path: workspace }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => workspaceEntry, resolveByPath: async () => workspaceEntry, archiveSession: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { list: () => loaded, flush: async () => {} },
    sessionController: {
      async *follow() {}, async *events() {}, async state() {}, async *observeState() {},
      async prompt(prompt) { prompts.push(prompt) }, async cancel() {},
      async resolveAgent(id) { return { agent: agentOf(id) } },
    },
  })
  const routes = new Map()
  ctx.connection.fetch.register = route => { routes.set(route.path, route); return () => {} }
  const rt = createRuntime(ctx, { home })
  rt.registryPath = join(automagik, 'bots.json')
  const places = new Map()
  const shown = new Set()
  const checked = []
  const reader = {
    places: () => places,
    shown(bot) {
      checked.push(bot)
      return bot.project == null || shown.has(bot.project)
    },
    registryIdOf: bot => bot.project == null ? null : `b-${bot.id}`,
  }
  const lines = new Set()
  rt.roomLineAdded = (room, record) => {
    for (const listener of lines) {
      try { listener(room, record) } catch {}
    }
  }
  let poll
  const timers = {
    setInterval(fn) { poll = fn; return 1 },
    clearInterval() { poll = undefined },
  }
  const sources = []
  const newSource = (options = {}) => {
    const source = new GroupSource({ rt, reader, lines, timers, ...options })
    sources.push(source)
    return source
  }
  const source = newSource()
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    for (const source of sources) source.close()
    await ctx.dispose()
    rt.dispose()
    if (oldHome === undefined) delete process.env.AUTOMAGIK_HOME
    else process.env.AUTOMAGIK_HOME = oldHome
    if (oldDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldDsh
  }
  t.after(async () => {
    await dispose()
    if (!givenHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  if (load) await rt.load()
  if (start) source.start()
  const quote = (line, room = rt.roomOf('r1')) => rt.logRoom(room, line)
  const list = async (from = source) => from.rowsNow(await from.eligibleRoomIds(rt.teamGeneration()))
  const ask = (extra = {}, id = 'gb') => {
    const handle = ctx.listeners.get('approval/request')[0]
    return handle({ toolName: 'bash', reason: 'Run this command', agent: agentOf(id), ...extra }, () => 'passed')
  }
  services.approval = { request: request => ctx.listeners.get('approval/request')[0](request, () => 'passed') }
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const endpoint = async (endpoint, payload = {}) => {
    const route = routes.get('/api/omni-ui')
    return (await route.fetch(new Request('http://localhost/api/omni-ui', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  }
  const tool = (name, args, id, extra) => rt.teamTools.find(tool => tool.name === name).execute(args, { agent: agentOf(id), ...extra })
  return {
    rt, ctx, source, home, workspace, workspaceEntry, loaded, levels, folders, services, lines,
    places, shown, checked, newSource, prompts, agentOf, poll: async () => { poll?.(); await tick() },
    list, quote, ask, emit, endpoint, tool, dispose, room: () => rt.roomOf('r1'),
  }
}

export async function watch(host, { source = host.source, after, start = true, room = terminal } = {}) {
  const events = []
  const handle = await source.watch(room, event => events.push(event), { after })
  assert.equal(handle.ok, true, handle.reason)
  if (start) handle.started()
  return { handle, events }
}
