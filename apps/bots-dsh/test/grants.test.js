import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyDshReview } from '@deepseek-ai/dsh-experimental-auto-review'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as bash from '@deepseek-ai/dsh-tool-bash'
import * as approvals from '../src/host/approvals.js'
import * as auto from '../src/host/auto.js'
import * as autoJudge from '../src/host/auto-judge.js'
import {
  GRANT_MUTATORS, grantInternals, install, isGrantMutator, shownTarget,
} from '../src/host/grants.js'
import { bindTicketDesk, createTicketDesk } from '../src/host/grant-ticket.js'
import { capabilityOfArgs } from '../src/host/turns.js'
import * as models from '../src/host/models.js'
import * as permissions from '../src/host/permissions.js'
import { DshChatSource } from '../src/host/pocket-chat.js'
import { install as installResume } from '../src/host/resume.js'
import * as stops from '../src/host/stops.js'
import { bench as hostBench } from './grants-fixture.js'
import { immediate, until } from './until.js'

const REASON = 'Read the example directory'
const ARGS = { command: 'ls example', timeout: 1000 }
const ROUTE = { provider: 'deepseek', model: 'v4' }
const SENTINEL = 'private-shell-description-157e'
const hash = text => createHash('sha256').update(text).digest('hex')

async function bench(t, { taskRoom } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  for (const plugin of [
    SessionStore, SessionProjectionRegistry, ApprovalService, SystemPrompt, ToolsService,
  ]) {
    await ctx.plugin(plugin)
  }
  const approval = ctx.get('approval')
  const sessions = ctx.get('sessions')
  const phone = []
  const decisions = []
  const team = []
  const inputs = new Map()
  const natives = new WeakMap()
  const presets = new Map()
  const folders = new Map()
  const ledger = []
  const steps = []
  let locked = true
  const bots = {
    ada: { id: 'ada', name: 'Ada', sessionId: 'chat', model: 'deepseek/v4' },
    bob: { id: 'bob', name: 'Bob' },
  }
  const room = { id: 'room', name: 'Room', members: ['ada', 'bob'], sessions: { ada: 'seat' } }
  const tasks = {
    task: { from: 'ada', status: 'working', ...(taskRoom ? { levelRoomId: 'room' } : {}) },
    other: { from: 'ada', status: 'working' },
    bobTask: { from: 'bob', status: 'working' },
  }
  const wd = {
    get: session => folders.get(session.id) ?? '/workspace',
    ensure: async agent => folders.get(agent.session.id) ?? '/workspace',
  }
  ctx.provide('workingDirectory', wd)
  ctx.provide('llm', { listProviders: () => [{ id: ROUTE.provider }] })
  ctx.provide('shell', {})
  ctx.provide('shellEnv', { collect: () => ({}) })
  await ctx.plugin(bash)
  ctx.on('session/event', (session, { type, data }) => {
    const key = JSON.stringify([session.id, data?.callId, data?.name])
    if (type === 'tool/call') inputs.set(key, data.arguments)
  })
  ctx.provide('permissionPresets', {
    current: session => presets.get(session.id) ?? 'workspace-write',
    resolve: name => ({ sandbox: name, approval: 'ask' }),
    catalog: () => ({ defaultPreset: 'workspace-write', options: [] }),
    set: (session, name) => presets.set(session.id, name),
    registerAuto: () => () => {},
  })
  const rt = {
    ctx,
    state: { bots, rooms: { room }, tasks },
    chatOwners: new Map([['chat', 'ada'], ['bob', 'bob']]),
    groupOwners: new Map([['seat', { botId: 'ada', roomId: 'room' }]]),
    taskOwners: new Map([['run', { botId: 'ada' }]]),
    pastOwners: new Map(),
    teamTools: [],
    botOf: id => bots[id],
    chatOf: id => bots[id]?.sessionId ?? id,
    roomOf: id => id === room.id ? room : undefined,
    groupSessionsOf: () => ['seat'],
    holdsLock: () => locked,
    lockTerm: () => 1,
    teamLoaded: () => true,
    load: async () => {},
    save: async () => {},
    saveCopy: async () => {},
    warn() {},
    readOnly: () => undefined,
    groupLoads: new Map(),
    resolveAgent: async id => ({ id, session: sessions.get(id) }),
    sessionFolder: session => folders.get(session.id) ?? '/workspace',
    callCapability: (id, callId, tool) =>
      capabilityOfArgs(inputs.get(JSON.stringify([id, callId, tool])), tool),
  }
  const peer = {}
  const { mint, desk } = createTicketDesk({ browserPeer: peer, admit: () => ({ peer }) })
  bindTicketDesk(rt, desk)
  const browser = new Request('http://localhost/api/omni-ui')
  ctx.on('session/event', (session, event) => {
    if (event.type.startsWith('approval/')) ledger.push([session.id, event.type, event.data])
  })
  ctx.on('approval/request', request => {
    steps.push(['native', request.callId])
    return natives.get(request).promise
  })
  models.install(rt)
  permissions.install(rt)
  auto.install(rt)
  autoJudge.install(rt)
  stops.install(rt)
  approvals.install(rt)
  rt.onApproval((kind, row) => {
    if (kind === 'grant') {
      const { id, at, ...decision } = row
      decisions.push(decision)
      if (row.decidedBy === 'grant') steps.push(['grant', row.callId])
    } else team.push([kind, row])
  })
  const source = new DshChatSource({
    adapter: { prompt() {}, cancel() {} },
    bots: async () => [{ id: 'ada', sessionId: 'chat' }],
    writable: true,
    chatOwner: id => rt.chatOwners.get(id),
  })
  source.entries.set('ada', {
    botId: 'ada', sessionId: 'chat', gone: false, cursor: 0, rows: [],
    scope: { turn: 1, calls: new Map() }, listeners: new Set([event => phone.push(event)]),
  })
  ctx.on('approval/request', (request, next) => source.raceApproval(request, next),
    { prepend: true })
  t.after(install(rt))
  autoJudge.installAhead(rt)

  const open = (id, route = ROUTE, meta) => {
    const session = sessions.create(id, { meta })
    session.append('turn/start', { turn: 1 })
    if (route) selectRoute(session, route)
    return session
  }
  const opened = Object.fromEntries(['task', 'other', 'bobTask', 'chat', 'seat'].map(id =>
    [id, open(id)]))
  await setImmediate()
  let serial = 0
  function call(session, {
    args = ARGS, callId = `call-${++serial}`, tool = 'bash', reason = REASON, requestArgs,
    signal, evidence = true, eventTool = tool,
  } = {}) {
    if (evidence) session.append('tool/call', {
      callId, name: eventTool, turn: 1, step: 0,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    })
    const request = { agent: { session }, callId, toolName: tool, reason, signal, ...requestArgs }
    const native = Promise.withResolvers()
    natives.set(request, native)
    let input = args
    if (typeof input === 'string') {
      try { input = JSON.parse(input) } catch { input = undefined }
    }
    const exec = { agent: request.agent, callId, name: eventTool, arguments: input, signal }
    const answer = ctx.waterfall('tools/execute', exec, () => approval.request(request))
    return { request, answer, native }
  }
  const held = async (session = opened.task, options) => {
    const ask = call(session, options)
    await setImmediate()
    const row = rt.approvalsView().find(entry => entry.sessionId === session.id
      && entry.callId === ask.request.callId)
    assert.ok(row, 'expected the ordinary team card')
    const { grantable, offer, shownTarget, sandboxMode, folder, ...card } = row
    const entry = { ...card, ...rt.teamOwnerOf(session.id, ask.request.agent) }
    return { ...ask, entry, offer: grantable ? { grantable, offer, shownTarget, folder,
      ...(sandboxMode === undefined ? {} : { sandboxMode }) } : undefined }
  }
  const claim = (id, outcome, by) => {
    if (!rt.approvalsView().some(entry => entry.id === id)) return false
    assert.equal(outcome, 'allowed-once')
    rt.answerApproval(id, 'allow', by)
    return true
  }
  const click = ({ entry, request, offer }, answer = claim) => {
    if (!offer) return
    const ticket = mint(browser, { id: entry.id, offer: offer.offer })
    const result = grantInternals(rt).claim(ticket, id => {
      if (id === entry.id && rt.approvalsView().some(row => row.id === id)) {
        return { grantEntry: entry, request }
      }
    }, answer)
    if (result?.receipt && rt.approvalsView().some(row => row.id === entry.id)) return
    return result?.receipt?.then(value => value.allowed === true
      ? { grantId: value.grantId } : undefined)
  }
  const reject = async ({ entry, answer }) => {
    rt.answerApproval(entry.id, 'reject')
    assert.equal(await answer, 'rejected')
  }
  const grant = async (session = opened.task, options) => {
    const ask = await held(session, options)
    assert.equal(ask.offer?.grantable, true)
    const pending = click(ask)
    assert.ok(pending, 'the pending card was claimed')
    assert.equal(await ask.answer, 'allowed-once')
    const { grantId } = await pending
    assert.ok(grantId)
    return grantId
  }
  return {
    ctx, rt, opened, open, call, held, claim, click, reject, grant, ledger, phone, decisions, team,
    steps, bots, room, tasks, folders, presets, source, mint, browser,
    lock: value => { locked = value },
  }
}

function selectRoute(session, route) {
  session.append('request/header', { header: { config: route }, reason: 'epoch' })
}

test('one person grant replays through Cordis and the DSH ledger without another card', async t => {
  const w = await bench(t)
  const hiddenTimeout = 1571579157
  const args = { ...ARGS, timeout: hiddenTimeout }
  const { task } = w.opened
  const grantId = await w.grant(task, { args })
  const before = w.team.length
  const replay = w.call(task, { args })
  assert.equal(await replay.answer, 'allowed-once')
  assert.equal(w.team.length, before)
  const [first, firstAnswer, second, secondAnswer] = w.ledger.map(row => row[2])
  assert.equal(w.ledger.length, 4)
  assert.deepEqual(w.ledger.map(row => row[1]), [
    'approval/asked', 'approval/decided', 'approval/asked', 'approval/decided',
  ])
  assert.notEqual(first.callId, second.callId)
  assert.notEqual(first.id, second.id)
  assert.deepEqual(firstAnswer, { id: first.id, outcome: 'allowed-once' })
  assert.deepEqual(secondAnswer, { id: second.id, outcome: 'allowed-once' })
  assert.deepEqual(w.decisions[1], {
    sessionId: 'task', callId: second.callId, requestId: second.id,
    outcome: 'allowed-once', decidedBy: 'grant', grantId,
  })
  assert.equal(w.decisions[0].requestId, first.id)
  assert.equal(w.decisions[0].decidedBy, 'web')
  assert.deepEqual(w.rt.autoAuditRows(), [{
    at: w.rt.autoAuditRows()[0].at, sessionId: 'task', callId: second.callId, tool: 'bash',
    decision: 'allow', code: 'person-grant', grantId, route: 'deepseek/v4', rev: 0,
  }])
  assert.deepEqual(w.rt.grantsView(), [{
    id: grantId, botId: 'ada', owner: { kind: 'task', id: 'task' }, tool: 'bash',
    target: 'ls example', uses: 1, at: w.rt.grantsView()[0].at,
  }])
  for (const rows of [w.team, w.decisions, w.rt.state, w.rt.grantsView(), w.rt.autoAuditRows()]) {
    assert.ok(!JSON.stringify(rows).includes(String(hiddenTimeout)))
    assert.ok(!JSON.stringify(rows).includes('fingerprint'))
  }
})

test('call evidence gives a key using the target hash', async t => {
  const w = await bench(t)
  const ask = await w.held(w.opened.task, {
    args: { ...ARGS, sandbox_permissions: 'workspace-write' },
    requestArgs: { args: { ...ARGS, sandbox_permissions: 'workspace-write', diffs: SENTINEL } },
  })
  const { request } = ask
  const name = 'bash'
  const target = JSON.stringify(['command', ARGS.command, 'workspace-write'])
  const key = hash(JSON.stringify(['v1', 'ada', '/workspace', name, REASON, hash(target)]))
  const internals = grantInternals(w.rt)
  assert.deepEqual(internals.projection('task', request.callId, name, request), {
    capabilityKey: key, shownTarget: ARGS.command, sandboxMode: 'workspace-write',
  })
  assert.match(ask.offer.offer, /^[0-9a-f-]{36}$/)
  assert.deepEqual(ask.offer, {
    grantable: true, offer: ask.offer.offer, shownTarget: ARGS.command,
    sandboxMode: 'workspace-write', folder: '/workspace',
  })
  await w.reject(ask)
})

for (const [label, changed] of [
  ['timeout', { args: { ...ARGS, timeout: 2000 } }],
  ['shell description', { args: { ...ARGS, description: SENTINEL } }],
  ['target', { args: { ...ARGS, command: 'ls elsewhere' } }],
  ['reason', { reason: 'Read another directory' }],
  ['request.arguments', { requestArgs: { arguments: { ...ARGS, timeout: 2000 } } }],
  ['request.args', { requestArgs: { args: '[]' } }],
  ['missing evidence', { evidence: false }],
  ['malformed evidence', { args: '[object Object]' }],
  ['non-object evidence', { args: '[]' }],
  ['different tool', { eventTool: 'pwsh' }],
  ['extra argument', { args: { ...ARGS, cwd: '/somewhere' } }],
  ['long reason', { reason: 'x'.repeat(501) }],
  ['control character in reason', { reason: 'one\ntwo' }],
  ['ACP mirror', { tool: 'acp_tool', args: { title: 'List', input: ARGS } }],
  ['keep_working', { tool: 'keep_working', args: { command: 'ls example' } }],
  ['unknown tool', { tool: 'made_up_tool' }],
]) test(`a changed ${label} asks while the original grant remains usable`, async t => {
  const w = await bench(t)
  const id = await w.grant()
  const bad = await w.held(w.opened.task, changed)
  if (!['timeout', 'shell description', 'target', 'reason'].includes(label)) {
    assert.equal(bad.offer, undefined)
    assert.equal(w.click(bad), undefined)
  }
  if (['timeout', 'shell description'].includes(label)) {
    const target = JSON.stringify(['command', ARGS.command, null])
    assert.equal(bad.entry.capabilityKey,
      hash(JSON.stringify(['v1', 'ada', '/workspace', 'bash', REASON, hash(target)])))
  }
  await w.reject(bad)
  assert.equal(w.rt.grantsView()[0].id, id)
  assert.equal(await w.call(w.opened.task).answer, 'allowed-once')
  assert.equal(w.rt.grantsView()[0].uses, 1)
})

test('another owner or Bot misses the grant without ending it', async t => {
  const w = await bench(t)
  const id = await w.grant()
  for (const session of [w.opened.other, w.opened.bobTask]) {
    await w.reject(await w.held(session))
    assert.equal(w.rt.grantsView()[0].id, id)
    assert.equal(await w.call(w.opened.task).answer, 'allowed-once')
  }
  assert.equal(w.rt.grantsView()[0].uses, 2)
})

for (const name of ['folder', 'route', 'revision']) {
  test('an away-and-back ' + name + ' ends the old grant', async t => {
    const w = await bench(t)
    const { task } = w.opened
    await w.grant()
    if (name === 'folder') {
      for (const cwd of ['/other-workspace', '/workspace']) {
        w.folders.set(task.id, cwd)
        task.append('working-directory/change', { cwd })
      }
    } else if (name === 'route') {
      selectRoute(task, { ...ROUTE, model: 'v5' })
      selectRoute(task, ROUTE)
    } else {
      w.rt.movePermissionRev(w.bots.ada)
      delete w.bots.ada.permissionRev
    }
    await w.reject(await w.held(task))
    assert.deepEqual(w.rt.grantsView(), [])
  })
}

test('a missing capability key cannot become an offer or a grant', async t => {
  const w = await bench(t)
  const ask = await w.held(w.opened.task, { evidence: false })
  assert.equal(ask.entry.capabilityKey, undefined)
  assert.equal(ask.offer, undefined)
  assert.equal(w.click(ask), undefined)
  await w.reject(ask)
})

test('the offer never refreshes a changed binding, and Allow once still works', async t => {
  const w = await bench(t)
  const ask = await w.held()
  assert.ok(grantInternals(w.rt).offerView(ask.entry, ask.request))
  w.folders.set('task', '/changed')
  assert.equal(grantInternals(w.rt).offerView(ask.entry, ask.request), undefined)
  assert.equal(grantInternals(w.rt).offer(ask.entry, ask.request,
    { signal: ask.request.signal }), undefined)
  assert.equal(w.click(ask), undefined)
  assert.ok(w.claim(ask.entry.id, 'allowed-once', 'web'))
  assert.equal(await ask.answer, 'allowed-once')
  assert.deepEqual(w.rt.grantsView(), [])
})

test('one-shot team lookups run without cards on the computer or Pocket', async t => {
  const w = await bench(t)
  assert.equal(await w.call(w.opened.chat, { tool: 'mcp__dsh__propose_bot_change' }).answer,
    'allowed-once')
  assert.deepEqual(w.phone, [])
  assert.deepEqual(w.team, [])
  assert.deepEqual(w.decisions, [])
})

test('grant targets use a per-tool field and keep the entire displayed value', () => {
  assert.equal(shownTarget('pwsh', { command: 'Get-ChildItem' }).text, 'Get-ChildItem')
  assert.equal(shownTarget('read', { path: 'example.txt' }).text, 'example.txt')
  assert.equal(shownTarget('mcp__dsh__browser_open', { url: 'https://example.test' }).text,
    'https://example.test')
  assert.equal(shownTarget('bash', { path: 'example' }), undefined)
  assert.equal(shownTarget('read', { file_path: 'x'.repeat(401) }), undefined)
  assert.equal(shownTarget('bash', { command: 'ls', sandbox_permissions: 'unknown' }), undefined)
  assert.equal(shownTarget('write', { path: 'example', content: 'hidden' }), undefined)
})

test('permission mutators include both tool and endpoint aliases, with proposals exempt', () => {
  assert.deepEqual(GRANT_MUTATORS.setters, ['set_bot_auto', 'switch_route'])
  for (const alias of GRANT_MUTATORS.setters) {
    assert.equal(isGrantMutator(alias, {}), true)
    assert.equal(isGrantMutator(alias.replaceAll('_', '-'), {}), true)
    assert.equal(isGrantMutator(`mcp__dsh__${alias}`, {}), true)
  }
  for (const alias of ['update_bot', 'mcp__dsh__update_bot', 'update-bot', 'update_group',
    'mcp__dsh__update_group', 'update-room']) {
    for (const field of ['permission', 'permissionAuto', 'denyTools', 'deny_tools', 'model']) {
      assert.equal(isGrantMutator(alias, { [field]: null }), true)
    }
    assert.equal(isGrantMutator(alias, { name: 'Ada' }), false)
  }
  assert.equal(isGrantMutator('propose_bot_change', { model: 'deepseek/v5' }), false)
})

test('a credential ask reviewed on the computer only is never offered as a grant', async t => {
  const w = await bench(t)
  const note = w.rt.privateApprovalNote
  w.rt.privateApprovalNote = () => ({ tool: 'credential', reason: '' })
  const ask = await w.held()
  w.rt.privateApprovalNote = note
  assert.ok(ask.entry.capabilityKey)
  assert.equal(ask.offer, undefined)
  const ticket = w.mint(w.browser, { id: ask.entry.id, offer: 'any' })
  await assert.rejects(approvals.claimGrant(w.rt, ticket), { code: 'bot/refused' })
  assert.ok(w.claim(ask.entry.id, 'allowed-once', 'web'))
  assert.equal(await ask.answer, 'allowed-once')
  assert.deepEqual(w.rt.grantsView(), [])
})

test('a sender hook that now classifies the call as external blocks offer and reuse', async t => {
  const w = await bench(t)
  const id = await w.grant()
  w.rt.sendsOutside = step => step.tool === 'bash' && step.args.command === ARGS.command
  const bad = await w.held()
  assert.ok(bad.entry.capabilityKey)
  assert.equal(bad.offer, undefined)
  assert.equal(w.click(bad), undefined)
  await w.reject(bad)
  delete w.rt.sendsOutside
  assert.equal(await w.call(w.opened.task).answer, 'allowed-once')
  assert.deepEqual(w.rt.grantsView().map(grant => [grant.id, grant.uses]), [[id, 1]])
})

test('never-auto calls cannot be offered even when there is a capability key', async t => {
  const w = await bench(t)
  for (const input of [
    { args: { command: 'rm -rf example' } },
    { args: { command: 'git push --force' } },
    { tool: 'read', args: { path: '.env' } },
    { tool: 'read_image', args: { path: '.env' } },
  ]) {
    const ask = await w.held(w.opened.task, input)
    assert.ok(ask.entry.capabilityKey)
    assert.equal(ask.offer, undefined)
    await w.reject(ask)
  }
})

test('native and PTC completion remove evidence by each production call-id field', async t => {
  const w = await bench(t)
  const { task } = w.opened
  const id = await w.grant()
  const ptc = {
    callId: 'parent', subCallId: 'parent:ptc:0', name: 'bash', arguments: ARGS,
  }
  task.append('tool/ptc-dispatch-start', ptc)
  const replay = w.call(task, { callId: ptc.subCallId, evidence: false })
  assert.equal(await replay.answer, 'allowed-once')
  assert.ok(grantInternals(w.rt).projection(task.id, ptc.subCallId, 'bash', replay.request))
  task.append('tool/ptc-dispatch', ptc)
  assert.equal(grantInternals(w.rt).projection(task.id, ptc.subCallId, 'bash', replay.request),
    undefined)
  for (const callId of ['result-top', 'result-source']) {
    const { seq } = task.append('tool/call', {
      callId, name: 'bash', arguments: JSON.stringify(ARGS),
    })
    const request = { agent: { session: task }, callId, toolName: 'bash', reason: REASON }
    assert.ok(grantInternals(w.rt).projection(task.id, callId, 'bash', request))
    const sourceId = callId === 'result-top' ? 'another-call' : callId
    task.append('tool/result', {
      ...(callId === 'result-top' ? { callId } : {}),
      message: {
        id: `message-${callId}`, role: 'tool', toolCallId: sourceId, content: [],
        source: { kind: 'tool', callId: sourceId },
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
    const bad = await w.held(task, { callId, evidence: false })
    assert.equal(bad.offer, undefined)
    await w.reject(bad)
  }
  assert.deepEqual(w.rt.grantsView().map(grant => [grant.id, grant.uses]), [[id, 1]])
})

test('rfc0039 D4 E8s failure after seat publication ends its grant [H]', async t => {
  const r = await hostBench(t)
  const room = r.rt.roomOf('r')
  const survivor = await r.grant('seat')
  const id = 'new-seat'
  const archived = []
  t.mock.method(r.ctx.get('workspaceRegistry'), 'archiveSession', async id => { archived.push(id) })
  t.mock.method(r.rt, 'createSession', async () => r.open(id).id)
  const applyPermission = r.rt.applyPermission
  const second = Promise.withResolvers()
  let applications = 0
  t.mock.method(r.rt, 'applyPermission', async (bot, sessionId, ...args) => {
    if (sessionId === id && ++applications === 2) await second.promise
    return applyPermission(bot, sessionId, ...args)
  })
  const relay = r.rt.teamTools.find(tool => tool.name === 'group_relay')
  r.rt.roomInbox.set(room.id, [{ text: '@Cy check the fixtures' }])
  await relay.execute({}, { agent: r.agents.get(room.id) })
  try {
    await until(() => applications === 2, { ms: 1800, poll: immediate })
    assert.equal(room.sessions.c, id)
    assert.deepEqual(r.rt.groupOwners.get(id), { botId: 'c', roomId: room.id })
    await r.grant(id)
  } finally { second.reject(new Error('second permission application failed')) }
  await until(() => archived.includes(id), { ms: 1800, poll: immediate })
  await Promise.all(r.rt.roomRounds(room.id))
  assert.equal(room.sessions.c, undefined)
  assert.equal(r.rt.groupOwners.has(id), false)
  // Reattach the same seat before checking authority so the missing owner cannot hide a leak.
  room.sessions.c = id
  r.rt.groupOwners.set(id, { botId: 'c', roomId: room.id })
  const ask = r.ask(id)
  let outcome
  void ask.answer.then(answer => { outcome = answer })
  await until(() => outcome !== undefined || r.records.some(row => row.callId === ask.key),
    { ms: 1800, poll: immediate })
  assert.equal(outcome, undefined, 'the failed seat replayed its old grant')
  const card = await r.held(ask)
  assert.equal(card.grantable, true)
  assert.equal((await r.once(card, 'reject')).ok, true)
  assert.equal(await ask.answer, 'rejected')
  assert.equal(await r.replay('seat'), 'allowed-once')
  assert.deepEqual((await r.state()).work.grants.map(row => row.id), [survivor])
})

test('rfc0039 D4 O1 [H] a lost Session still has ordinary approvals', async t => {
  const w = await bench(t)
  const { task } = w.opened
  const at = Date.now()
  t.mock.method(Date, 'now', () => at + 11 * 60 * 1000)
  const projection = callId => grantInternals(w.rt).projection(task.id, callId, 'bash', {
    agent: { session: task }, toolName: 'bash', callId, reason: REASON,
  })
  const start = callId => task.append('tool/call', {
    callId, name: 'bash', arguments: JSON.stringify(ARGS),
  })
  start('not-expired')
  assert.ok(projection('not-expired'))
  for (let n = 0; n < 2000; n++) start('cap-' + n)
  assert.equal(projection('not-expired'), undefined)
  const ask = await w.held(task, { callId: 'cap-1999' })
  assert.equal(ask.offer, undefined)
  await w.reject(ask)
  task.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  task.append('turn/start', { turn: 2 })
  assert.ok(await w.grant(task))
})

test('rfc0039 D4 O2 [H] only fresh turns can acquire grants after saturation', async t => {
  const w = await bench(t)
  const { task } = w.opened
  const overflow = []
  for (let n = 0; n < 4002; n++) {
    const session = w.open('overflow-' + n)
    overflow.push(session)
    session.append('tool/call', {
      callId: 'overflow', name: 'bash', arguments: JSON.stringify(ARGS),
    })
  }
  const callId = 'dropped-start'
  const pending = await w.held(task, { callId })
  assert.equal(pending.offer, undefined)
  await w.reject(pending)
  for (const session of overflow) {
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  task.append('turn/start', { turn: 1 })
  const repeated = await w.held(task, { callId })
  assert.equal(repeated.offer, undefined)
  await w.reject(repeated)
  task.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  task.append('turn/start', { turn: 2 })
  assert.ok(await w.grant(task, { callId }))
})

test('the same call ID in different sessions has independent ledger IDs', async t => {
  const w = await bench(t)
  const taskGrant = await w.grant(w.opened.task, { callId: 'shared' })
  const otherGrant = await w.grant(w.opened.other, { callId: 'shared' })
  assert.notEqual(taskGrant, otherGrant)
  assert.notEqual(w.decisions[0].requestId, w.decisions[1].requestId)
  assert.deepEqual(w.decisions.map(({ sessionId, callId }) => [sessionId, callId]),
    [['task', 'shared'], ['other', 'shared']])
})

test('overlapping DSH asks on one call leave authority with the person', async t => {
  const w = await bench(t)
  const { task } = w.opened
  await w.grant()
  const first = w.call(task, { callId: 'ambiguous' })
  const second = w.call(task, { callId: 'ambiguous', evidence: false })
  await setImmediate()
  const cards = w.rt.approvalsView().filter(entry => entry.callId === 'ambiguous')
  assert.equal(cards.length, 2)
  for (const entry of cards) w.rt.answerApproval(entry.id, 'reject')
  assert.deepEqual(await Promise.all([first.answer, second.answer]), ['rejected', 'rejected'])
  assert.equal(w.rt.grantsView()[0].uses, 0)
})

for (const [judge, outcome] of [
  ['allow', 'allowed-once'], ['deny', 'rejected'], ['ask', undefined], ['off', undefined],
]) test(`a writable Pocket source sees no replay after team Auto ${judge}`, async t => {
  const w = await bench(t)
  const id = await w.grant(w.opened.chat)
  w.phone.length = 0
  w.steps.length = 0
  w.source.settled.clear()
  const old = w.team.length
  w.rt.autoDecide = request => {
    w.steps.push(['auto', request.callId])
    return judge === 'off' ? undefined : Promise.resolve(outcome)
  }
  const call = w.call(w.opened.chat)
  assert.equal(await call.answer, outcome ?? 'allowed-once')
  assert.deepEqual(w.steps.map(([step]) => step), outcome ? ['auto'] : ['auto', 'grant'])
  assert.deepEqual(w.phone, [])
  assert.equal(w.source.settled.size, 0)
  assert.equal(w.team.length, old)
  assert.deepEqual(w.rt.grantsView().map(grant => [grant.id, grant.uses]),
    [[id, outcome === undefined ? 1 : 0]])
})

for (const downstream of [{ kind: 'allow' }, { kind: 'ask', reason: REASON }]) {
  test(`DSH Auto review leaves the ${downstream.kind} path to the person`, async t => {
    const w = await bench(t)
    const { ctx, rt, opened: { chat } } = w
    const verdict = { risk: 'high', decision: 'deny', reason: 'outside the example' }
    let reviewed = 0
    ctx.get('llm').stream = async function* () {
      reviewed++
      yield { type: 'text-delta', index: 0, text: JSON.stringify(verdict) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await ctx.plugin({
      inject: ['approval', 'llm', 'permissionPresets', 'sessions', 'tools', 'workingDirectory'],
      apply: applyDshReview,
    })
    const reason = downstream.kind === 'ask' ? REASON : 'Auto review denied tool "bash": '
      + verdict.reason
    const id = await w.grant(chat, { reason })
    w.presets.set(chat.id, 'auto')
    const callId = 'reviewed'
    const args = JSON.stringify(ARGS)
    chat.append('request/header', {
      header: { config: ROUTE, tools: [{ name: 'bash', description: 'List', parameters: {} }] },
      reason: 'epoch',
    })
    chat.append('step/start', { turn: 1, step: 1 })
    chat.append('assistant/message', {
      turn: 1, step: 1, stream: [],
      message: {
        id: 'reviewed-message', role: 'assistant', source: { kind: 'model', ...ROUTE },
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }],
      },
    }, { surfaceOp: 'append' })
    chat.append('tool/call', { callId, name: 'bash', turn: 1, step: 1, arguments: args })
    const gate = await ctx.waterfall('tools/pre-execute', {
      agent: { session: chat }, name: 'bash', callId, rootCallId: callId, arguments: ARGS,
      signal: new AbortController().signal,
    }, () => downstream)
    assert.equal(reviewed, 1)
    assert.equal(gate.kind, 'ask', gate.reason)
    assert.equal(gate.reason, reason)
    if (downstream.kind === 'ask') assert.equal(gate, downstream)
    else assert.ok(gate.displayReason)
    w.phone.length = 0
    const ask = await w.held(chat, {
      callId, evidence: false, reason, requestArgs: { displayReason: gate.displayReason },
    })
    assert.equal(ask.offer, undefined)
    assert.equal(w.click(ask), undefined)
    assert.ok(w.phone.some(event => event.row?.answerable === true))
    await w.reject(ask)
    w.presets.delete(chat.id)
    assert.equal(rt.grantsView()[0].uses, 0)
    assert.equal(await w.call(chat, { reason }).answer, 'allowed-once')
    assert.deepEqual(rt.grantsView().map(grant => [grant.id, grant.uses]), [[id, 1]])
  })
}

test('an unresolved DSH review preset leaves the request to the person', async t => {
  const w = await bench(t)
  const id = await w.grant()
  w.presets.set(w.opened.task.id, '')
  const ask = await w.held()
  assert.equal(ask.offer, undefined)
  await w.reject(ask)
  w.presets.delete(w.opened.task.id)
  assert.deepEqual(w.rt.grantsView().map(grant => [grant.id, grant.uses]), [[id, 0]])
})

test('an absent or ambiguous effective route cannot be granted', async t => {
  const w = await bench(t)
  w.tasks.unknown = { from: 'ada', status: 'working' }
  const ask = await w.held(w.open('unknown', null))
  assert.equal(ask.offer, undefined)
  await w.reject(ask)
})

test('only live explicit task, own-chat and group owners can grant', async t => {
  const w = await bench(t)
  const { chat, seat, task } = w.opened
  for (const session of [chat, seat, task]) await w.grant(session)
  for (const [session, move, restore] of [
    [chat, () => { w.bots.ada.sessionId = 'new' }, () => { w.bots.ada.sessionId = 'chat' }],
    [seat, () => w.room.members.shift(), () => w.room.members.unshift('ada')],
    [seat, () => { w.room.sessions.ada = 'new' }, () => { w.room.sessions.ada = 'seat' }],
    [task, () => { w.tasks.task.from = 'bob' }, () => { w.tasks.task.from = 'ada' }],
    [task, () => { w.tasks.task.status = 'stopped' }, () => { w.tasks.task.status = 'working' }],
  ]) {
    const ask = await w.held(session, { args: { ...ARGS, timeout: 42 } })
    assert.equal(ask.offer?.grantable, true)
    move()
    assert.equal(w.click(ask), undefined)
    restore()
    await w.reject(ask)
  }
  const run = await w.held(w.open('run'))
  assert.equal(run.offer, undefined)
  await w.reject(run)
  const child = w.open('child', ROUTE, { origin: 'subagent', parentSession: task.id })
  const childAsk = await w.held(child)
  assert.equal(childAsk.offer, undefined)
  await w.reject(childAsk)
})

test('two already-open identical asks coalesce only after DSH records an allow', async t => {
  const w = await bench(t)
  const first = await w.held()
  const second = await w.held()
  const one = w.click(first)
  const two = w.click(second)
  assert.deepEqual(w.rt.grantsView(), [])
  assert.deepEqual(w.decisions, [])
  assert.equal(w.click(first), undefined)
  assert.deepEqual(await Promise.all([first.answer, second.answer]),
    ['allowed-once', 'allowed-once'])
  const [a, b] = await Promise.all([one, two])
  assert.deepEqual(a, b)
  assert.equal(w.rt.grantsView().length, 1)
  assert.equal(w.rt.grantsView()[0].uses, 0)
  assert.equal(w.rt.revokeGrant(a.grantId), true)
  assert.equal(w.rt.revokeGrant(a.grantId), false)
  assert.deepEqual(w.rt.grantsView(), [])
  await w.reject(await w.held())
})

test('an identical card that was already open stays pending after the first grant', async t => {
  const w = await bench(t)
  const first = await w.held()
  const other = await w.held()
  assert.ok(await w.click(first))
  assert.equal(await first.answer, 'allowed-once')
  assert.deepEqual(w.rt.approvalsView().map(row => row.id), [other.entry.id])
  assert.equal(await w.call(w.opened.task).answer, 'allowed-once')
  await w.reject(other)
})

test('native rejection, an already-settled card and a lost claim create nothing', async t => {
  const w = await bench(t)
  const native = await w.held(w.opened.chat)
  native.native.resolve('rejected')
  assert.equal(await native.answer, 'rejected')
  assert.equal(w.click(native), undefined)
  const pending = await w.held()
  assert.equal(w.click(pending, () => false), undefined)
  await w.reject(pending)
  assert.deepEqual(w.rt.grantsView(), [])
  assert.deepEqual(w.decisions, [])
  assert.deepEqual(w.rt.autoAuditRows(), [])
})

for (const phoneFirst of [true, false]) {
  test(`Pocket rejection wins before approval propagation, phone first: ${phoneFirst}`, async t => {
    const w = await bench(t)
    const ask = await w.held(w.opened.chat)
    const open = [...w.source.open.get('chat').values()][0]
    const phoneReject = () => open.settle('rejected', { by: 'phone', outcome: 'rejected' })
    if (phoneFirst) assert.equal(phoneReject(), true)
    const receipt = w.click(ask)
    if (!phoneFirst) {
      assert.ok(receipt, 'the inner team claim won before the outer Pocket answer')
      assert.equal(phoneReject(), true)
    }
    assert.equal(await ask.answer, 'rejected')
    assert.equal(await receipt, undefined)
    assert.equal(w.ledger.at(-1)[2].outcome, 'rejected')
    assert.deepEqual(w.rt.grantsView(), [])
    assert.deepEqual(w.decisions, [])
    assert.deepEqual(w.rt.autoAuditRows(), [])
  })
}

test('a completed web grant closes the Pocket ask before a later rejection', async t => {
  const w = await bench(t)
  const ask = await w.held(w.opened.chat)
  const open = [...w.source.open.get('chat').values()][0]
  assert.ok(await w.click(ask))
  assert.equal(await ask.answer, 'allowed-once')
  assert.equal(open.settle('rejected', { by: 'phone', outcome: 'rejected' }), false)
  assert.equal(w.rt.grantsView().length, 1)
})

test('a Pocket Allow once wins the outer race without creating a person grant', async t => {
  const w = await bench(t)
  const ask = await w.held(w.opened.chat)
  const open = [...w.source.open.get('chat').values()][0]
  const grant = w.click(ask)
  assert.ok(grant, 'the team claimed its card before its answer reached Pocket')
  assert.equal(open.settle('allowed-once', { by: 'phone', outcome: 'allowed-once' }), true)
  assert.equal(await ask.answer, 'allowed-once')
  assert.equal(await grant, undefined)
  assert.deepEqual(w.rt.grantsView(), [])
  assert.deepEqual(w.decisions, [])
})

test('an original abort after claiming a card wins before DSH accepts the answer', async t => {
  const w = await bench(t)
  const controller = new AbortController()
  const ask = await w.held(w.opened.chat, { signal: controller.signal })
  const grant = w.click(ask)
  assert.ok(grant)
  controller.abort()
  assert.equal(await ask.answer, 'cancelled')
  assert.equal(await grant, undefined)
  assert.deepEqual(w.rt.grantsView(), [])
  assert.deepEqual(w.decisions, [])
})

test('a cancelled grant replay writes no use, decision or audit row', async t => {
  const w = await bench(t)
  const id = await w.grant()
  const controller = new AbortController()
  w.ctx.on('approval/request', async (_request, next) => {
    const outcome = await next()
    controller.abort()
    return outcome
  }, { prepend: true })
  assert.equal(await w.call(w.opened.task, { signal: controller.signal }).answer, 'cancelled')
  assert.equal(w.rt.grantsView()[0].uses, 0)
  assert.equal(w.decisions.length, 1)
  assert.deepEqual(w.rt.autoAuditRows(), [])
  assert.equal(w.rt.grantsView()[0].id, id)
})

test('the replay ledger holds the use and audit until its exact allowed decision', async t => {
  const w = await bench(t)
  await w.grant()
  const answer = Promise.withResolvers()
  w.ctx.on('approval/request', async (_request, next) => {
    const outcome = await next()
    assert.equal(outcome, 'allowed-once')
    await answer.promise
    return outcome
  }, { prepend: true })
  const replay = w.call(w.opened.task)
  await setImmediate()
  assert.equal(w.rt.grantsView()[0].uses, 0)
  assert.deepEqual(w.rt.autoAuditRows(), [])
  assert.equal(w.decisions.length, 1)
  const last = w.ledger.at(-1)[2]
  w.opened.other.append('approval/decided', { id: last.id, outcome: 'allowed-once' })
  assert.equal(w.rt.grantsView()[0].uses, 0)
  answer.resolve('allowed-once')
  assert.equal(await replay.answer, 'allowed-once')
  assert.equal(w.rt.grantsView()[0].uses, 1)
  assert.equal(w.rt.autoAuditRows().length, 1)
})

test('an owner ending after a winning claim leaves the authoritative allow and no live grant',
  async t => {
    const w = await bench(t)
    const ask = await w.held()
    const grant = w.click(ask)
    assert.ok(grant)
    w.rt.endGrants('task', 'task')
    assert.equal(await ask.answer, 'allowed-once')
    assert.ok(await grant)
    assert.equal(w.decisions[0].decidedBy, 'web')
    assert.deepEqual(w.rt.grantsView(), [])
  })

test('revoke during an in-flight coalescing claim cannot restore the live grant', async t => {
  const w = await bench(t)
  const first = await w.held()
  const other = await w.held()
  const { grantId } = await w.click(first)
  const second = w.click(other)
  assert.ok(second)
  assert.equal(w.rt.revokeGrant(grantId), true)
  assert.deepEqual(await second, { grantId })
  assert.equal(await other.answer, 'allowed-once')
  assert.deepEqual(w.rt.grantsView(), [])
  await w.reject(await w.held())
})

test('committed end selectors remove live grants immediately, before another ask', async t => {
  const w = await bench(t)
  for (const session of [w.opened.task, w.opened.chat, w.opened.seat]) await w.grant(session)
  assert.deepEqual(w.rt.approvalsView(), [])
  for (const [session, why, count] of [
    [w.opened.task, 'task', 2], [w.opened.chat, 'part', 1], [w.opened.seat, 'group', 0],
  ]) {
    assert.equal(w.rt.endGrants(session.id, why), 1)
    assert.equal(w.rt.grantsView().length, count)
    await w.reject(await w.held(session))
  }
  await w.grant()
  assert.equal(w.rt.endGrants('chat', 'bot', { botId: 'ada' }), 1)
  assert.deepEqual(w.rt.grantsView(), [])
})

test('lock loss clears existing grants and offers, including before a later reclaim', async t => {
  const w = await bench(t)
  await w.grant()
  const pending = await w.held(w.opened.task, { args: { ...ARGS, timeout: 1500 } })
  w.lock(false)
  const lockless = await w.held(w.opened.other)
  assert.equal(lockless.offer, undefined)
  assert.deepEqual(w.rt.grantsView(), [])
  w.lock(true)
  assert.equal(grantInternals(w.rt).offerView(pending.entry, pending.request), undefined)
  assert.equal(w.click(pending), undefined)
  await w.reject(pending)
  await w.reject(lockless)
  await w.reject(await w.held())
})

test('a lock reclaimed before the next ask invalidates live grants and old offers', async t => {
  const w = await bench(t)
  let term = 1
  w.rt.lockTerm = () => term
  await w.grant()
  const ask = await w.held(w.opened.task, { args: { ...ARGS, timeout: 1500 } })
  term++
  assert.equal(w.click(ask), undefined)
  assert.deepEqual(w.rt.grantsView(), [])
  await w.reject(ask)
  await w.reject(await w.held())
})

test('a request from before a team adopt cannot grant in the replacement team', async t => {
  const w = await bench(t)
  let epoch = 1
  w.rt.teamGeneration = () => ({ epoch, term: 1 })
  await w.grant()
  const waiting = w.held()
  epoch++
  const ask = await waiting
  assert.equal(ask.offer, undefined)
  assert.deepEqual(w.rt.grantsView(), [])
  await w.reject(ask)
  assert.ok(await w.grant())
})

test('a permission revision move or direct Auto assignment drops the Bot’s grants', async t => {
  const w = await bench(t)
  const { task, chat, seat } = w.opened
  const other = await w.grant(w.opened.bobTask)
  await w.grant(task)
  await w.grant(chat)
  await w.rt.clearAuto(w.bots.ada)
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [other])
  await w.grant(task)
  await w.grant(seat)
  w.rt.movePermissionRev(w.bots.ada)
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [other])
  await w.grant(task)
  w.bots.ada.permission = 'workspace-write'
  await w.rt.markInherited(w.bots.ada, 'api:deepseek/v4')
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [other])
  await w.grant(task)
  await w.rt.setPermission(w.bots.ada, 'workspace-write')
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [other])
  await w.grant(task)
  w.bots.ada.appliedModel = w.bots.ada.model
  w.rt.cachedBackground = () => 'deepseek/v4'
  await w.rt.setBotAuto('ada', w.bots.ada.permissionRev)
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [other])
})

test('person-grant audit rows use the same 200-row bound as the team judge', async t => {
  const w = await bench(t)
  await w.grant()
  let last
  for (let n = 0; n < 201; n++) {
    const call = w.call(w.opened.task)
    assert.equal(await call.answer, 'allowed-once')
    last = call.request.callId
  }
  const rows = w.rt.autoAuditRows()
  assert.equal(w.rt.grantsView()[0].uses, 201)
  assert.equal(rows.length, 200)
  assert.equal(rows[0].callId, 'call-3')
  assert.equal(rows.at(-1).callId, last)
})

test('changing a room level drops only its member and affected task grants and offers', async t => {
  const w = await bench(t, { taskRoom: true })
  const { seat, task, chat } = w.opened
  const keep = await w.grant(chat)
  await w.grant(seat)
  await w.grant(task)
  const ask = await w.held(seat, { args: { ...ARGS, timeout: 2500 } })
  assert.equal(await w.rt.setRoomPermission(w.room, 'read-only'), true)
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [keep])
  assert.equal(w.click(ask), undefined)
  await w.reject(ask)
  await w.reject(await w.held(seat))
  await w.reject(await w.held(task))
})

test('native model selections drop changed routes and invalidate the pending offer', async t => {
  const w = await bench(t)
  const { task, chat } = w.opened
  const id = await w.grant(task)
  await w.grant(chat)
  const ask = await w.held(chat, { args: { ...ARGS, timeout: 2500 } })
  chat.append('model/selection', { ...ROUTE, reasoningEffort: 'high' })
  assert.equal(w.rt.grantsView().length, 2)
  chat.append('model/selection', { ...ROUTE, model: 'v5' })
  chat.append('model/selection', ROUTE)
  assert.deepEqual(w.rt.grantsView().map(row => row.id), [id])
  assert.equal(w.click(ask), undefined)
  await w.reject(ask)
  await w.reject(await w.held(chat))
})

test('a new host with the same owner and route has no grants', async t => {
  const first = await bench(t)
  await first.grant()
  const restarted = await bench(t)
  assert.deepEqual(restarted.rt.grantsView(), [])
  await restarted.reject(await restarted.held())
})

for (const committed of [true, false]) {
  test(`a recovery stop ends its grant, committed: ${committed}`, async t => {
    const w = await bench(t)
    const gen = { epoch: 1, term: 1 }
    w.rt.teamGeneration = () => gen
    w.rt.sameTeam = current => current === gen
    await w.grant()
    w.opened.task.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    const home = mkdtempSync(join(tmpdir(), 'bots-grant-recovery-'))
    t.after(() => rmSync(home, { recursive: true, force: true }))
    let saved = false
    Object.assign(w.rt, {
      home,
      // No web self-update verdict is pending in this bench (self-update-hold.js).
      updateHold: undefined,
      updateGate: async () => {},
      async save() {
        saved = w.tasks.task.status === 'stopped'
        return saved && committed
      },
    })
    // Real timers: the boot pass waits its start delay after the update gate (resume.js).
    const before = grantInternals(w.rt).genOf('task')
    installResume(w.rt)
    assert.deepEqual(await w.rt.resumesDone, { resumed: [], resent: [] })
    assert.equal(saved, true)
    // The recovery stop itself ends the grant (a generation bump), not only the later sweep.
    assert.equal(grantInternals(w.rt).genOf('task'), before + 1)
    assert.equal(w.rt.grantsView().length, 0)
  })
}


test('rfc0039 D4 W2h [H] tickets are single use and bound to the installed desk', async t => {
  const w = await bench(t)
  const first = await w.held()
  const second = await w.held()
  const lookup = id => {
    const row = [first, second].find(ask => ask.entry.id === id)
    if (row) return { grantEntry: row.entry, request: row.request }
  }
  const claim = grantInternals(w.rt).claim
  const request = { id: first.entry.id, offer: first.offer.offer }
  const ticket = w.mint(w.browser, request)
  const foreignPeer = {}
  const foreign = createTicketDesk({
    browserPeer: foreignPeer, admit: () => ({ peer: foreignPeer }),
  })
  bindTicketDesk(w.rt, foreign.desk)
  assert.equal(claim(foreign.mint(w.browser, request), lookup, w.claim), undefined)
  assert.deepEqual(claim(w.mint(w.browser, { ...request, id: second.entry.id }), lookup, w.claim),
    { changed: true })
  assert.ok((await claim(ticket, lookup, w.claim).receipt).grantId)
  assert.equal(claim(ticket, lookup, w.claim), undefined)
  assert.equal(await first.answer, 'allowed-once')
  assert.ok(w.rt.approvalsView().some(row => row.id === second.entry.id))
  await w.reject(second)
})

test('rfc0039 D4 R4 [H] a late decision cannot revive an expired creation receipt', async t => {
  const w = await bench(t)
  const gate = Promise.withResolvers()
  w.ctx.on('approval/request', async (_request, next) => {
    const out = await next()
    await gate.promise
    return out
  }, { prepend: true })
  try {
    const ask = await w.held()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const ticket = w.mint(w.browser, { id: ask.entry.id, offer: ask.offer.offer })
    const result = grantInternals(w.rt).claim(ticket,
      () => ({ grantEntry: ask.entry, request: ask.request }), w.claim)
    t.mock.timers.tick(30_000)
    assert.deepEqual(await result.receipt, { allowed: 'unknown' })
    gate.resolve()
    assert.equal(await ask.answer, 'allowed-once')
    assert.deepEqual(w.rt.grantsView(), [])
    assert.deepEqual(w.decisions, [])
  } finally { gate.resolve() }
})

test('rfc0039 D4 R5 [H] issued replay ceiling preserves ordinary cards', async t => {
  const w = await bench(t)
  await w.grant(w.opened.chat)
  const gate = Promise.withResolvers()
  const held = []
  w.ctx.on('approval/request', async (request, next) => {
    const out = await next()
    if (request.agent.session === w.opened.chat) await gate.promise
    return out
  }, { prepend: true })
  try {
    for (let n = 0; n < 200; n++) held.push(w.call(w.opened.chat, { callId: 'issued-' + n }))
    await setImmediate()
    const extra = await w.held(w.opened.chat)
    assert.ok(extra.entry.answerable)
    const rejection = w.reject(extra)
    w.opened.chat.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    gate.resolve()
    await rejection
    assert.ok((await Promise.all(held.map(item => item.answer)))
      .every(outcome => outcome === 'allowed-once'))
    assert.equal(w.rt.grantsView()[0].uses, 200)
    assert.equal(w.rt.autoAuditRows().length, 200)
  } finally { gate.resolve() }
})

test('rfc0039 D4 R5x [H] a late replay decision records the use, audit and event', async t => {
  const w = await bench(t)
  const grantId = await w.grant()
  const gate = Promise.withResolvers()
  w.ctx.on('approval/request', async (_request, next) => {
    const out = await next()
    await gate.promise
    return out
  }, { prepend: true })
  try {
    const replay = w.call(w.opened.task)
    await setImmediate()
    const at = Date.now()
    t.mock.method(Date, 'now', () => at + 11 * 60 * 1000)
    gate.resolve()
    assert.equal(await replay.answer, 'allowed-once')
    assert.equal(w.rt.grantsView()[0].uses, 1)
    assert.equal(w.rt.autoAuditRows()[0].grantId, grantId)
    assert.equal(w.decisions.at(-1).decidedBy, 'grant')
  } finally { gate.resolve() }
})

test('rfc0039 D4 R2 [H] Pocket Allow once first spends no grant authority', async t => {
  const w = await bench(t)
  const ask = await w.held(w.opened.chat)
  const phone = [...w.source.open.get('chat').values()][0]
  assert.equal(phone.settle('allowed-once', { by: 'phone', outcome: 'allowed-once' }), true)
  assert.equal(w.click(ask), undefined)
  assert.equal(await ask.answer, 'allowed-once')
  assert.deepEqual(w.rt.grantsView(), [])
  assert.deepEqual(w.decisions, [])
})

test('rfc0039 D4 E12 [H] selective ends bump only the affected Session generations',
  async t => {
    const w = await bench(t)
    const { genOf } = grantInternals(w.rt)
    const current = genOf('task')
    const other = genOf('seat')
    w.rt.endGrants('task', 'task')
    assert.equal(genOf('task'), current + 1)
    assert.equal(genOf('seat'), other)
    const release = w.rt.holdGrants({ sessionIds: ['task'] }, () => 1)
    release(false)
    assert.equal(genOf('task'), current + 1)
    const failed = w.rt.holdGrants({ sessionIds: ['task'] }, () => 1)
    failed(true)
    assert.equal(genOf('task'), current + 2)
  })
