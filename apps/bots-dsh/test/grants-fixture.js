import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as connectionPlugin from '@deepseek-ai/dsh-client-connection'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { Storage } from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as bash from '@deepseek-ai/dsh-tool-bash'
import * as directoryTool from '@deepseek-ai/dsh-tool-working-directory'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { createRuntime } from '../index.js'
import { DshChatSource, terminalOf } from '../src/host/pocket-chat.js'
import { fakeContext } from './fake-ctx.js'
import { immediate, until } from './until.js'

export const ROUTE = { provider: 'deepseek', model: 'v4' }
export const STEP = { command: 'echo ok', description: 'rfc39', justification: 'rfc39',
  sandbox_permissions: 'danger-full-access' }
export const REASON = 'rfc39'
const PERSON = { cookie: 'browser' }
export const API = { authorization: 'Bearer owner-api' }
export const DOMAIN = 'http://127.0.0.1:7700'

async function pinnedConnection(ctx, home) {
  ctx.provide('webServer', {
    host: '127.0.0.1', protocol: 'http:', register: () => () => {},
  })
  await ctx.plugin(LocalCredentialProvider, {
    dshHome: home, path: join(home, '.credentials.yaml'), watch: false,
  })
  await ctx.plugin(connectionPlugin, { trustedHosts: ['127.0.0.1:7700'] })
  const connection = ctx.get('connection')
  const url = new URL(connection.authenticatedUrl(DOMAIN))
  const response = new Map()
  connection.authorizeIndex({ url: url.pathname + url.search, method: 'GET',
    headers: { host: url.host } }, {
    writeHead(code, headers) { response.set('code', code); response.set('headers', headers) },
    end() {},
  })
  assert.equal(response.get('code'), 303)
  const cookie = [response.get('headers')['set-cookie']].flat()[0].split(';')[0]
  assert.ok(cookie)
  return { connection, person: { cookie, host: url.host } }
}

export async function bench(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bots-d4-acceptance-'))
  const { home, folder, otherFolder } = options.restart ?? {
    home: join(root, 'team'), folder: join(root, 'work-a'), otherFolder: join(root, 'work-b'),
  }
  if (!options.restart) for (const path of [home, folder, otherFolder]) mkdirSync(path)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(root, 'dsh')
  const ctx = new Context()
  const agents = new Map()
  const opened = new Map()
  const ledger = []
  const records = []
  const steps = []
  const aborts = new Set()
  let rt
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    for (const abort of aborts) abort.abort()
    await immediate()
    rt?.dispose()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
  t.after(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  const stub = fakeContext()
  const llm = { ...stub.llm, listProviders: () => [{ id: ROUTE.provider }],
    listModels: async () => options.models ?? [], resolveModelInfo: async () => ({}) }
  ctx.provide('llm', llm)
  ctx.provide('agents', { list: () => [...agents.values()] })
  const shell = {
    sandboxMode: 'workspace-write',
    resolve: request => request,
    async execute(spec) {
      steps.push(spec)
      const stream = { text: '', truncated: false }
      return { result: async () => ({
        exitCode: 0, signal: null, aborted: false, timedOut: false, timeoutMs: 0,
        stdout: { ...stream, text: 'ok\n' }, stderr: stream,
      }) }
    },
  }
  ctx.provide('shell', shell)
  ctx.provide('shellEnv', { collect: () => ({}) })
  ctx.provide('sandboxPolicy', { resolve: ({ session } = {}) => ({
    mode: session === undefined ? shell.sandboxMode
      : ctx.get('permissionPresets').resolve(ctx.get('permissionPresets').current(session)).sandbox,
  }) })
  ctx.provide('fs', {
    resolve: async path => path, stat: async () => ({ type: 'directory' }),
    processPath: path => path,
  })
  // The persistent executor only needs a registered backend to mount. The test never runs it.
  ctx.provide('terminals', {})
  ctx.provide('sessionTitle', { rename: async () => {} })
  for (const plugin of [SessionStore, SessionProjectionRegistry, SystemPrompt, ApprovalService,
    ToolsService, nativeExecutor]) await ctx.plugin(plugin)
  await ctx.plugin(PermissionPresetService, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  let agentParent
  await ctx.inject(['tools'], child => { agentParent = child })
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: folder })
  await ctx.plugin(bash, { enableRunInBackground: false })
  await ctx.plugin(directoryTool)

  const wd = ctx.get('workingDirectory')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('permissionPresets')
  const approval = ctx.get('approval')
  const folders = new Map([[folder, { id: 'work-a', path: folder }],
    [otherFolder, { id: 'work-b', path: otherFolder }]])
  if (options.workspace) {
    await ctx.plugin(Storage)
    await ctx.plugin(storageJson, { root: join(home, 'store') })
    await ctx.plugin(storageDomain, { backend: 'json' })
    await ctx.plugin(persistence, { root: join(home, 'sessions') })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.get('workspaceRegistry').create(folder, 'Omni')
  } else ctx.provide('workspaceRegistry', {
    get: id => [...folders.values()].find(item => item.id === id),
    resolveByPath: async path => folders.get(path),
    archiveSession: async () => {},
    unarchiveSession: async () => {},
  })

  let route
  let racePocket
  let person = PERSON
  if (options.pinnedConnection) {
    const pinned = await pinnedConnection(ctx, home)
    person = pinned.person
    const register = pinned.connection.fetch.register
    t.mock.getter(pinned.connection, 'fetch', () => ({
      register: spec => { if (spec.path.endsWith('/omni-ui')) route = spec; return register(spec) },
    }))
  } else {
    const browserPeer = {}
    const apiPeer = {}
    const connection = {
      fetch: { register(spec) {
        if (spec.path.endsWith('/omni-ui')) {
          route = spec
          // Channel installs between the team card and grants, where Pocket joins the race.
          if (racePocket) ctx.on('approval/request', racePocket, { prepend: true })
        }
        return () => {}
      } },
      ...options.desktop ? {} : { browserPeer, admit(request) {
        if (request.headers.get('cookie') === PERSON.cookie) return { peer: browserPeer }
        if (request.headers.get('authorization') === API.authorization) return { peer: apiPeer }
        if (request.headers.has('x-test-admission-error')) throw new Error('admission failed')
        return { rejection: 401 }
      } },
    }
    ctx.provide('connection', connection)
  }
  const resolving = {}
  ctx.provide('sessionController', {
    resolveAgent: async id => {
      if (resolving.before) await resolving.before(id)
      const agent = agents.get(id)
      if (!agent) throw new Error('Unknown fixture Session ' + id)
      return { agent }
    },
    selectModel: async ({ sessionId, ...selected }) => {
      opened.get(sessionId)?.append('model/selection', selected)
      return { selected }
    },
    page: async ({ address }) => ({
      records: [...opened.get(address.sessionId).snapshotEvents()]
        .map(record => ({ event: record.event ?? record })),
      hasMore: false,
    }),
  })
  if (options.desktop) {
    const secret = randomBytes(32).toString('hex')
    const prior = process.env.AUTOMAGIK_WINDOW_DIGEST
    process.env.AUTOMAGIK_WINDOW_DIGEST = createHash('sha256').update(secret).digest('hex')
    person = { 'x-automagik-window': secret }
    t.after(() => {
      if (prior === undefined) delete process.env.AUTOMAGIK_WINDOW_DIGEST
      else process.env.AUTOMAGIK_WINDOW_DIGEST = prior
    })
  }

  const bot = id => ({ id, name: { a: 'Ada', b: 'Bob', c: 'Cy' }[id], model: 'deepseek/v4',
    appliedModel: 'deepseek/v4', permission: 'workspace-write', sessionId: id, createdAt: 1 })
  const task = (from, extra) => ({ from, title: 'Fixture task', at: Date.now(),
    status: 'working', ...extra })
  const workspaceId = options.workspace
    ? (await ctx.get('workspaceRegistry').resolveByPath(folder)).id : 'work-a'
  if (!options.restart) writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, mainBotIds: ['a'], bots: { a: bot('a'), b: bot('b'), c: bot('c') },
    rooms: {
      r: { id: 'r', name: 'Ops', named: true, members: ['a', 'b', 'c'],
        sessions: { a: 'seat', b: 'seat-b' },
        admin: 'a', mode: 'admin', log: [], seq: 0, seen: {} },
      s: { id: 's', name: 'Lab', named: true, members: ['a', 'b'], sessions: { a: 'seat-other' },
        admin: 'a', mode: 'admin', log: [], seq: 0, seen: {} },
    },
    tasks: { t1: task('a'), t2: task('a'), t3: task('b'), ...options.tasks },
    workspaceId, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
  }))
  ctx.on('approval/request', request => new Promise(resolve => {
    if (request.signal?.aborted) resolve('cancelled')
    else request.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }))
  let pocket
  if (options.pocket) {
    const source = new DshChatSource({
      adapter: {
        async *follow(_id, signal) {
          yield { type: 'snapshot', cursor: 0, records: [] }
          if (!signal.aborted) {
            await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
          }
        },
        state: async () => ({ running: false }),
        prompt() {},
        cancel() {},
      },
      bots: async () => [{ id: 'a', sessionId: 'a' }],
      writable: true,
    })
    racePocket = (request, next) => source.raceApproval(request,
      options.pocketGate ? () => options.pocketGate(request, next) : next)
    const events = []
    const watch = await source.watch(terminalOf('a'), event => events.push(event))
    assert.equal(watch.ok, true)
    t.after(() => watch.close())
    pocket = { events, answer: watch.answer }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type.startsWith('approval/') || event.type === 'tool/call') {
      ledger.push({ sessionId: session.id, ...event })
    }
  })
  rt = createRuntime(ctx, { home })
  rt.onApproval((kind, row) => records.push({ kind, ...row }))
  const turn = (session, n = 1) => session.append('turn/start', { turn: n })
  const routeTo = (session, config) => session.append('request/header', {
    header: { config }, reason: 'epoch',
  })
  function open(id, { cwd = folder, model = ROUTE } = {}) {
    const session = sessions.create(id, { meta: { cwd } })
    const agent = { id, session, status: 'idle', inbox: { nextStep: [], nextTurn: [] },
      inject() {}, followup() {}, steer() {}, whenIdle: async () => {},
      runMaintenance: run => run(AbortSignal.timeout(3000)),
    }
    agent.ctx = createScope(agentParent, agent).ctx
    agents.set(id, agent)
    opened.set(id, session)
    turn(session)
    routeTo(session, model)
    return session
  }
  for (const id of ['a', 'b', 'c', 'r', 's', 't1', 't2', 't3', 'seat', 'seat-b',
    'seat-other']) open(id)
  await rt.load()
  await immediate()
  assert.equal(rt.holdsLock(), true)
  assert.ok(route, 'the team registered the production window endpoint')

  async function request(endpoint, payload, headers = person) {
    const response = await route.fetch(new Request(DOMAIN + route.path, {
      method: 'POST', body: JSON.stringify({ endpoint, payload }), headers,
    }))
    return response.json()
  }
  const state = async () => {
    const result = await request('state')
    assert.equal(result.ok, true, result.error?.message)
    return result.value
  }
  const cardOf = async callId => (await state()).work.approvals.find(row => row.callId === callId)
  let serial = 0
  function start(id, { args = STEP, tool = 'bash', callId = 'call-' + (++serial) } = {}) {
    const session = opened.get(id)
    session.append('tool/call', { callId, name: tool, turn: 1, step: 0,
      arguments: typeof args === 'string' ? args : JSON.stringify(args) })
    return callId
  }
  function ask(id, {
    args = STEP, tool = 'bash', callId, reason = REASON, bridgeCall, dispatch = true,
  } = {}) {
    const key = callId ?? start(id, { args, tool })
    const abort = new AbortController()
    aborts.add(abort)
    const request = {
      agent: agents.get(id), toolName: tool, callId: key, reason, signal: abort.signal,
      ...(bridgeCall === undefined ? {} : { bridgeCall }),
    }
    let input = args
    if (typeof input === 'string') {
      try { input = JSON.parse(input) } catch { input = undefined }
    }
    const exec = { agent: request.agent, name: tool, callId: key, arguments: input,
      signal: abort.signal }
    const body = () => approval.request(request)
    const answer = dispatch ? ctx.waterfall('tools/execute', exec, body) : body()
    return { key, answer }
  }
  function pipeline(id, args = STEP, tool = 'bash', { review } = {}) {
    const key = 'pipeline-' + (++serial)
    const abort = new AbortController()
    aborts.add(abort)
    const argumentsText = JSON.stringify(args)
    const call = { type: 'tool-call', id: key, name: tool, arguments: argumentsText }
    const step = review ? 1 : 0
    if (review) {
      const session = opened.get(id)
      session.append('step/start', { turn: 1, step })
      session.append('assistant/message', { turn: 1, step, stream: [],
        message: { id: key + '-model', role: 'assistant', source: { kind: 'model', ...ROUTE },
          content: [call] },
      }, { surfaceOp: 'append' })
    }
    const input = { agent: agents.get(id), signal: abort.signal, calls: [call],
      log: { turn: 1, step },
    }
    return { key, answer: ctx.get('tools').execute(input) }
  }
  async function held(asking) {
    let card
    await until(() => {
      card = records.find(row => row.kind === 'open' && row.callId === asking.key)
      return card !== undefined
    }, { ms: 1800, poll: immediate })
    assert.ok(card?.answerable, 'the asking step must leave an answerable card')
    return card
  }
  async function replay(id, spec) {
    const asking = ask(id, spec)
    let outcome
    void asking.answer.then(value => { outcome = value })
    const opened = () => records.some(row => row.kind === 'open' && row.callId === asking.key)
    await until(() => outcome !== undefined || opened(), { ms: 1800, poll: immediate })
    assert.equal(opened(), false, 'replay opened an approval for ' + id)
    return asking.answer
  }
  const allow = (card, headers) => request('grant-approval',
    { id: card.id, offer: card.offer ?? 'no-grant' }, headers)
  const once = (card, choice = 'allow') => request('approval-answer', { id: card.id, choice })
  async function grant(id = 't1', spec) {
    const asking = ask(id, spec)
    const card = await held(asking)
    assert.equal(card.grantable, true, 'the Bash ask must carry a grant offer')
    const result = await allow(card)
    assert.ok(result.value?.grantId, JSON.stringify(result))
    assert.equal(await asking.answer, 'allowed-once')
    return result.value.grantId
  }
  return { ctx, rt, approval, presets, wd, agents, opened, home, folder, otherFolder, open, turn,
    routeTo, ledger, records, steps, request, state, cardOf, start, ask, pipeline, held, allow,
    once, grant, replay, person, resolving, close, pocket }
}
