import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as executor from '@deepseek-ai/dsh-tool-executor-native'
import * as files from '@deepseek-ai/dsh-tool-fs'
import * as search from '@deepseek-ai/dsh-tool-fs-search'
import Tools from '@deepseek-ai/dsh-tools'
import { Session, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { nativeWorld, CLAUDE, CODEX, person } from '../../acp-dsh/test/fixtures/managed-native-world.js'
import { AGENTS } from '../../acp-dsh/src/host/agents.js'
import * as profiles from '../../acp-dsh/src/host/codex-chat-profiles.js'
import { apply } from '../index.js'
import { reviewMarkText } from '../src/client/solver-draft.js'
import { fakeContext } from './fake-ctx.js'

async function joinedSolver(t, runTool) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solver-scope-e2e-')))
  const folder = join(root, 'workspace')
  const home = join(root, 'team')
  const denied = join(root, 'other')
  for (const path of [folder, home, denied]) mkdirSync(path)
  const insidePath = join(folder, 'inside.txt')
  const outsidePath = join(denied, 'outside.txt')
  const inside = `IN-${randomBytes(8).toString('hex')}`
  const outside = `OUT-${randomBytes(8).toString('hex')}`
  writeFileSync(insidePath, inside)
  writeFileSync(outsidePath, outside)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let questionGuard
  const world = nativeWorld(t, {
    managed: false, hidden: true,
    runTool,
    policyState: id => world.identityReaders.readState?.(id),
    questionGuard: request => questionGuard?.(request),
    env: { FAKE_ACP_MODES: 'auto,default,bypassPermissions',
      FAKE_ACP_FIXTURE_MARKER: insidePath, FAKE_ACP_FIXTURE_OTHER: outsidePath, FAKE_ACP_STREAM_DIR: root },
  })
  const chat = world.chat('solver', { cwd: folder })
  const acpAgents = {
    botIdentity: world.identityReaders.register,
    questionGuard: fn => { questionGuard = fn; return () => { questionGuard = undefined } },
    endSession: world.adapter.endSession.bind(world.adapter),
    signInRoots: () => [denied],
  }
  const ctx = fakeContext({ services: {
    acpAgents, approval: world.services.approval,
    permissionPresets: { current: () => 'full' },
    workingDirectory: { ensure: async () => folder, get: () => folder },
  } })
  const teamWorkspace = { id: 'fixture-workspace', path: folder }
  ctx.workspaceRegistry = new Map([[teamWorkspace.id, teamWorkspace]])
  Object.assign(ctx, { sessions: { get: id => id === chat.session.id ? chat.session : undefined, list: () => [chat.session] } })
  apply(ctx, { home })
  t.after(() => ctx.dispose())
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  rt.state.workspaceId = teamWorkspace.id
  const reviewer = rt.state.bots.reviewer = { id: 'reviewer', name: 'Reviewer', role: 'Helper', createdAt: 1 }
  const bot = rt.state.bots.solver = {
    id: 'solver', name: 'Solver', role: 'Solver', reviewerId: reviewer.id, model: 'acp-claude/fake-large', createdAt: 1,
    workDir: folder, nativeTools: true, nativeToolsAgent: 'acp-claude', reviewGuard: true,
  }
  rt.chatOwners.set(bot.id, bot.id)
  rt.nativeToolsEligible = () => true
  rt.nativeToolsFor = () => true
  rt.sessionWide = () => true
  let dialogs = 0
  world.services.approval.effectivePolicy = () => 'never'
  world.services.approval.request = async () => { dialogs++; return 'rejected' }
  chat.session.append('sandbox/mode', { mode: 'danger-full-access' })
  chat.session.append('request/header', { header: { config: { provider: 'acp-claude', model: 'fake-large' } } })
  let now = Date.now()
  t.mock.method(Date, 'now', () => ++now)
  const request = await rt.reviewRequest(bot.id, { text: 'Read the fixture and verify the check.' })
  assert.match(await rt.solverProgress(bot, true, { action: 'plan', request, checks: ['fixture'],
    commands: [{ check: 'fixture', command: 'fixture-check' }] }), /Recorded/)
  const designate = (kind, exchangeId) => rt.solverReview(bot, reviewer, true, {
    kind, request, exchangeId, agent: chat.agent, prepare: async () => true,
  })
  const verdict = (kind, exchangeId) => rt.reviewVerdict(reviewer.id, bot.id, undefined, kind, Date.now(),
    { replyTo: exchangeId, reviewReceipt: `receipt-${exchangeId}` }, 'acp-codex/fake-reviewer')
  await designate('plan', 'plan')
  rt.reviewVerdict(reviewer.id, bot.id, undefined, 'SHIP', Date.now())
  return { root, folder, insidePath, outsidePath, inside, outside, world, chat, ctx, rt, reviewer, bot, request, designate,
    verdict, dialogs: () => dialogs }
}

test('#2134 K9 joined synthetic Solver keeps the Session on verdict and delivers a verified result', { timeout: 18_000 }, async t => {
  const { folder, insidePath, outsidePath, inside, outside, world, chat, ctx, rt, bot, request, designate, verdict, dialogs } =
    await joinedSolver(t)
  const execute = (name, args, next) => ctx.listeners.get('tools/execute')[0]({
    name, arguments: args, agent: chat.agent, callId: 'fixture-check',
  }, next)
  const confirmReadPair = async () => {
    await chat.turn(person('plan-scope-marker inside'))
    const allowed = world.events('fixture-permission').at(-1)
    assert.equal(allowed.answer, 'yes')
    assert.equal(allowed.path, insidePath)
    assert.ok(world.events('own-tool-ran').some(row => row.toolCallId === allowed.toolCallId))
    assert.equal(chat.history.at(-2)?.content?.[0]?.text, inside)
    await chat.turn(person('plan-scope-marker other'))
    const refused = world.events('fixture-permission').at(-1)
    assert.equal(refused.answer, 'no')
    assert.equal(refused.path, outsidePath)
    assert.match(chat.history.at(-2)?.content?.[0]?.text ?? '', /only inside its folder/)
    assert.ok(world.events('own-tool-ran').every(row => row.toolCallId !== refused.toolCallId))
    assert.ok(!JSON.stringify(chat.history).includes(outside))
  }
  await confirmReadPair()
  assert.equal(world.events('set-mode').at(-1)?.modeId, 'default')
  await assert.rejects(execute('bash', { command: 'fixture-check' }, () => assert.fail('a held body ran')), /review guard holds work/)
  verdict('PLAN SHIP', 'plan')
  await confirmReadPair()
  assert.equal(world.events('new-session').length, 1)
  assert.equal(world.events('set-mode').at(-1)?.modeId, 'bypassPermissions')
  assert.equal(dialogs(), 0)
  assert.equal(readFileSync(insidePath, 'utf8'), inside)
  assert.match(await rt.solverProgress(bot, true, { action: 'start', request, run: 'check', checks: ['fixture'] }), /Recorded/)
  await execute('bash', { command: 'fixture-check' }, async () => ({
    isError: false, value: { kind: 'foreground', cwd: folder, exitCode: 0, signal: null, timedOut: false, aborted: false },
  }))
  assert.match(await rt.solverProgress(bot, true, { action: 'checks', request, run: 'check',
    results: [{ check: 'fixture', pass: true }] }), /Recorded/)
  await designate('result', 'result')
  await verdict('RESULT SHIP', 'result')
  rt.reviewTurnEnd(bot.id, { completed: true, wroteText: true, request, model: 'acp-claude/fake-large' })
  const mark = bot.reviewTrack.last
  assert.equal(mark?.done, true)
  assert.equal(reviewMarkText({ ...bot, reviewMark: mark }, { byId: rt.state.bots }),
    'Plan and result reviewed by Reviewer.\nDone: every check passed and Reviewer approved.')
  const hanging = chat.turn(person('hang'))
  const deadline = Date.now() + 5_000
  while (!world.events('prompt').some(row => row.text === 'hang')) {
    assert.ok(Date.now() < deadline, 'the fake turn is running in the open mode')
    await pause(10)
  }
  await rt.reviewBotRequest(bot.id, 'fixture-requester', { exchangeId: 'new-fixture-request' })
  const stopped = await hanging
  assert.match(stopped.map(chunk => chunk.text ?? '').join(''), /Work now waits for the reviewer.s verdict on a new plan/)
  await chat.turn('next synthetic request')
  assert.equal(world.events('new-session').length, 2)
  assert.equal(world.events('set-mode').at(-1)?.modeId, 'default')
})

for (const [variant, label, refusal, quote] of [
  ['bash', 'allows streamed Bash after the designated plan verdict'],
  ['cd-plain', 'allows streamed Bash with a plain leading cd after the designated plan verdict', undefined, ''],
  ['cd-single', 'allows streamed Bash with a single-quoted leading cd after the designated plan verdict', undefined, "'"],
  ['cd-double', 'allows streamed Bash with a double-quoted leading cd after the designated plan verdict', undefined, '"'],
  ['write', 'allows streamed Write after the designated plan verdict'],
  ['changed', 'refuses a changed streamed Bash argument', /permission question no longer matches this call/],
  ['outside', 'confines a streamed Read to the Solver folder', /only inside its folder/],
]) {
  test(`#2134 ${label}`, { timeout: 18_000 }, async t => {
    const { root, folder, world, chat, verdict, dialogs } = await joinedSolver(t)
    await verdict('PLAN SHIP', 'plan')
    const path = variant === 'outside' ? join(root, 'outside-stream.txt') : join(folder, `stream-${variant}.txt`)
    const outside = 'Disposable outside marker'
    if (variant === 'outside') writeFileSync(path, outside)

    const firstSeen = []
    const stream = world.adapter.stream
    t.mock.method(world.adapter, 'stream', async function* (...args) {
      for await (const chunk of stream.apply(this, args)) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          firstSeen.push(JSON.parse(chunk.block.arguments))
          writeFileSync(join(root, 'mirror-recorded'), '')
        }
        yield chunk
      }
    })
    await chat.turn(person(`plan-scope-stream ${variant}`))
    const [permission, ...duplicates] = world.events('fixture-stream-permission')
    assert.ok(permission, 'the fake requested permission')
    assert.deepEqual(duplicates, [])
    const command = quote === undefined ? 'fixture-stream-check' : `cd ${quote}${folder}${quote} && fixture-stream-check`
    assert.deepEqual(firstSeen.map(args => [args.id, args.input]), [[permission.toolCallId,
      variant === 'write' || variant === 'outside' ? { file_path: path } : { command }]])
    if (quote !== undefined) {
      assert.equal(firstSeen[0].title, command)
      assert.deepEqual(permission.input, { command: 'fixture-stream-check', description: 'Synthetic streamed operation' })
    }
    assert.equal(dialogs(), 0)
    const result = chat.history.at(-2)?.content?.[0]?.text ?? ''
    assert.equal(permission.answer, refusal ? 'no' : 'yes', result)
    assert.equal(world.events('own-tool-ran').filter(row => row.toolCallId === permission.toolCallId).length, refusal ? 0 : 1)
    if (refusal) assert.match(result, refusal)
    if (variant === 'outside') assert.equal(readFileSync(path, 'utf8'), outside)
    else if (refusal) assert.equal(existsSync(path), false)
    else assert.equal(readFileSync(path, 'utf8'), 'Synthetic streamed operation')
  })
}

for (const variant of ['verbatim', 'cd-strip', 'changed-tail', 'other-folder', 'text-only']) {
  test(`#2153 Claude Solver native Bash check ${variant}`, { timeout: 18_000 }, async t => {
    const executions = []
    const { root, folder, world, chat, ctx, rt, bot, request, designate, verdict } =
      await joinedSolver(t, async (args, exec) => {
        exec.name = 'acp_tool'
        const entry = { exec, args }
        executions.push(entry)
        const result = await ctx.listeners.get('tools/execute')[0](exec, async () => ({
          isError: false, value: await world.adapter.tool.execute(exec.arguments, exec),
        }))
        entry.result = result
        return result.value
      })
    await verdict('PLAN SHIP', 'plan')
    assert.match(await rt.solverProgress(bot, true, { action: 'start', request, run: 'check', checks: ['fixture'] }), /Recorded\./)
    const progress = () => bot.reviewTrack.solver
    assert.equal(progress().pending.evidence, undefined)

    const firstSeen = []
    const stream = world.adapter.stream
    t.mock.method(world.adapter, 'stream', async function* (...params) {
      for await (const chunk of stream.apply(this, params)) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          firstSeen.push(chunk.block)
          writeFileSync(join(root, 'mirror-recorded'), '')
        }
        yield chunk
      }
    })
    try {
      await chat.turn(person(`plan-scope-claude-check ${variant}`))
    } finally {
      assert.equal(firstSeen.length, 1, 'the first Claude Bash surface reached the mirror')
    }
    assert.deepEqual(world.events('claude-check-timeout'), [])
    const [permission, ...duplicates] = world.events('claude-check-permission')
    assert.ok(permission, 'the fake requested permission for the surfaced call')
    assert.deepEqual(duplicates, [])
    assert.equal(executions.length, 1, 'one acp_tool invocation through Bots')
    const [{ args, exec, result }] = executions
    assert.equal(exec.agent.session, chat.session)
    assert.equal(exec.arguments, args)
    assert.equal(exec.callId, firstSeen[0].id)
    assert.deepEqual(args, JSON.parse(firstSeen[0].arguments))
    assert.equal(permission.toolCallId, args.id)
    assert.equal(result.isError, false)
    const { terminalOutcome, terminalStart, text } = result.value
    const evidence = progress().pending.evidence
    const check = () => rt.solverProgress(bot, true, { action: 'checks', request, run: 'check',
      results: [{ check: 'fixture', pass: true }] })
    const finish = () => rt.reviewTurnEnd(bot.id, { completed: true, wroteText: true, request, model: 'acp-claude/fake-large' })
    const refused = variant === 'changed-tail' || variant === 'other-folder'
    const ran = world.events('claude-check-ran')
    assert.equal(permission.answer, refused ? 'no' : 'yes', text)
    assert.deepEqual(ran.map(row => row.toolCallId), refused ? [] : [args.id])
    if (refused || variant === 'text-only') {
      if (refused) assert.match(text, /permission question no longer matches this call|only inside its folder/)
      else {
        // Claude advertises terminal output as metadata. Text alone still cannot prove an exit.
        const capabilities = world.events('initialize').at(-1).clientCapabilities
        assert.deepEqual(capabilities._meta, { terminal_output: true })
        assert.equal(capabilities.terminal, false)
        assert.equal(terminalOutcome.reason, 'Trusted ACP terminal exit data is missing.')
        assert.equal(evidence?.reason, terminalOutcome.reason)
      }
      assert.equal(terminalOutcome?.exitCode, undefined)
      assert.equal(terminalStart, undefined)
      assert.equal(evidence?.pass, undefined)
      assert.match(await check(), /No verified passing evidence/)
      finish()
      assert.notEqual(bot.reviewTrack?.last?.done, true)
      return
    }

    assert.equal(terminalOutcome?.reason, undefined, terminalOutcome?.reason)
    assert.deepEqual(terminalOutcome, {
      sessionId: chat.session.id, callId: exec.callId, toolCallId: args.id, terminalId: args.id, cwd: folder, exitCode: 0,
    })
    assert.equal(result.value.text, '1\n')
    assert.ok(Number.isFinite(terminalStart?.observedAt))
    assert.equal(terminalStart.startedAt, terminalStart.observedAt)
    assert.equal(evidence?.call, `${chat.session.id}:acp:${args.id}`)
    assert.equal(progress().pending.call, evidence.call)
    assert.equal(evidence?.pass, true, evidence?.reason)
    assert.equal(evidence.reason, undefined)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'spawn-env.json'), 'utf8')), { maintainProjectDir: '1' })
    assert.match(await check(), /Recorded\./)
    assert.deepEqual(progress().passed, ['fixture'])
    assert.deepEqual(progress().runs.check.evidence, evidence)
    await designate('result', 'result')
    await verdict('RESULT SHIP', 'result')
    finish()
    const mark = bot.reviewTrack.last
    assert.equal(mark?.resultExchangeId, 'result')
    assert.equal(mark?.done, true)
    assert.equal(reviewMarkText({ ...bot, reviewMark: mark }, { byId: rt.state.bots }),
      'Plan and result reviewed by Reviewer.\nDone: every check passed and Reviewer approved.')
  })
}

function fixtureFolders(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solver-joined-')))
  const workspace = join(root, 'workspace')
  const team = join(root, 'team')
  const protectedRoot = join(workspace, 'fixture-private')
  const project = join(workspace, 'project')
  for (const dir of [team, project, protectedRoot]) mkdirSync(dir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, workspace, team, protectedRoot, project }
}

async function teamOf(t, places, world, { provider = CLAUDE, workspace = places.workspace, protectedRoot = places.protectedRoot } = {}) {
  const sessions = new Map()
  const agents = new Map()
  let guard
  const acpAgents = world ? {
    botIdentity: world.identityReaders.register,
    questionGuard: decide => { guard = decide; return () => { guard = undefined } },
    signInRoots: () => [protectedRoot],
    endSession: world.adapter.endSession.bind(world.adapter),
  } : { signInRoots: () => [protectedRoot] }
  const ctx = fakeContext({ services: {
    acpAgents, agents, workingDirectory: { get: () => workspace, ensure: async () => workspace },
    permissionPresets: { current: () => 'full' },
  } })
  const teamWorkspace = { id: 'fixture-workspace', path: places.workspace }
  ctx.workspaceRegistry = new Map([[teamWorkspace.id, teamWorkspace]])
  ctx.sessions = { get: id => sessions.get(id), list: () => [...sessions.values()] }
  apply(ctx, { home: places.team })
  t.after(() => ctx.dispose())
  const rt = ctx.provided.get('omniTeam')
  await rt.load()
  rt.state.workspaceId = teamWorkspace.id
  const reviewer = rt.state.bots.reviewer = { id: 'reviewer', name: 'Fixture reviewer', createdAt: 1 }
  const bot = rt.state.bots.solver = { id: 'solver', name: 'Fixture Solver', role: 'Solver', workDir: workspace, reviewGuard: true,
    reviewerId: reviewer.id, model: `${provider}/fake-large`, nativeTools: true, nativeToolsAgent: provider, createdAt: 1 }
  rt.chatOwners.set(bot.id, bot.id)
  rt.nativeToolsEligible = () => true
  rt.nativeToolsFor = () => true
  rt.sessionWide = () => true
  const request = await rt.reviewRequest(bot.id, { text: 'Synthetic fixture request.' })
  await rt.solverProgress(bot, true, { action: 'plan', request, checks: ['fixture'] })
  await rt.solverReview(bot, reviewer, true, { kind: 'plan', request, exchangeId: 'plan', prepare: async () => true })
  const accept = () => rt.reviewVerdict(reviewer.id, bot.id, undefined, 'PLAN SHIP', Date.now(),
    { replyTo: 'plan', reviewReceipt: 'receipt-plan' }, 'acp-codex/fixture-reviewer')
  return { bot, rt, ctx, sessions, agents, accept, get guard() { return guard } }
}

test('#2134 K9 E-Child and scheduled controls apply the actual Bots lineage policy', async t => {
  const places = fixtureFolders(t)
  const w = nativeWorld(t, {
    managed: false, hidden: true, env: { FAKE_ACP_MODES: 'auto,default,bypassPermissions' },
    policyState: id => w.identityReaders.readState?.(id),
  })
  w.services.approval.effectivePolicy = () => 'never'
  const standalone = w.chat('standalone', { cwd: places.workspace })
  standalone.session.append('sandbox/mode', { mode: 'danger-full-access' })
  await standalone.turn('standalone synthetic request')
  assert.equal(w.events('set-mode').at(-1)?.modeId, 'bypassPermissions')
  const team = await teamOf(t, places, w)
  team.rt.state.bots.helper = { id: 'helper', name: 'Helper', role: 'Helper', createdAt: 1 }
  const lineage = [
    { id: 'scheduled', wanted: 'bypassPermissions' },
    { id: 'plain', wanted: 'bypassPermissions' },
    { id: 'helper', wanted: 'bypassPermissions' },
    { id: 'child', header: { origin: 'subagent', parentSession: team.bot.id }, wanted: 'default' },
  ]
  team.rt.scheduledNativeOwner = id => id === 'scheduled' ? team.bot.id : undefined
  for (const [index, { id, header, wanted }] of lineage.entries()) {
    const child = w.chat(id, { cwd: places.workspace, header })
    team.sessions.set(id, child.session)
    child.session.append('sandbox/mode', { mode: 'danger-full-access' })
    await child.turn('synthetic lineage request')
    assert.equal(w.events('set-mode').at(-1)?.modeId, wanted)
    assert.equal(w.events('prompt').length, index + 2)
    if (id === 'child') {
      const identity = w.identityReaders.read(id)
      assert.equal(identity?.name, undefined)
      assert.equal(identity?.planGate, true)
    }
  }
})

test('#2134 K9 E-Codex and X1 K2d bind the kept run and reclose it through Bots', { timeout: 18_000 }, async t => {
  const places = fixtureFolders(t)
  const inside = `IN-${randomBytes(8).toString('hex')}`
  const outside = `OUT-${randomBytes(8).toString('hex')}`
  const workspace = places.project
  const insidePath = join(workspace, 'inside.txt')
  const outsidePath = join(places.protectedRoot, 'outside.txt')
  writeFileSync(insidePath, inside)
  writeFileSync(outsidePath, outside)
  const runtime = join(places.root, 'fixture-runtime')
  const isolated = join(places.root, 'fixture-isolated')
  mkdirSync(runtime)
  mkdirSync(isolated)
  const executable = join(runtime, 'fixture-executable')
  writeFileSync(executable, 'inert executable identity')
  const hex = '0123456789abcdef0123456789abcdef'
  const modes = profiles.chatProfileModesFor(hex)
  const gate = `permission-profile:automagik-gate-${hex}`
  writeFileSync(join(isolated, 'config.toml'), profiles.chatProfilesConfig(isolated, hex, runtime))
  const fakeProbe = (_command, args) => {
    const file = args.at(-1)
    if (file.startsWith(workspace + '/')) return { status: 0, stdout: readFileSync(file, 'utf8') }
    return { status: 1, stdout: '', stderr: `cat: ${file}: No such file or directory\n` }
  }
  const w = nativeWorld(t, {
    managed: false, hidden: true,
    policyState: id => w.identityReaders.readState?.(id),
    env: { FAKE_ACP_MODES: `read-only,${gate},agent-full-access,workspace-write`,
      CODEX_HOME: isolated, FAKE_ACP_CHILD: '1', FAKE_ACP_IGNORE_CANCEL: '1',
      FAKE_ACP_FIXTURE_MARKER: insidePath, FAKE_ACP_FIXTURE_OTHER: outsidePath },
    codexPatch: { modeFor: AGENTS[CODEX].modeFor, nativeSwitch: 'config', nativeKeptModels: ['fake-large'] },
  })
  const codex = w.adapter.agents.get(CODEX)
  w.adapter.startModels.set(codex, 'fake-large')
  const spawn = codex.spawn
  codex.spawn = () => {
    const launch = spawn()
    return { ...launch, profileModes: modes,
      gateBinding: profiles.createGateBinding?.(executable, gate, launch.env, places.protectedRoot, { run: fakeProbe }) }
  }
  w.services.approval.effectivePolicy = () => 'never'
  const team = await teamOf(t, places, w, { provider: CODEX, workspace })
  const chat = w.chat(team.bot.id, { cwd: workspace })
  team.sessions.set(team.bot.id, chat.session)
  chat.session.append('sandbox/mode', { mode: 'danger-full-access' })
  await chat.turn(person('plan-scope-sandbox inside'), CODEX)
  const positive = w.events('fixture-sandbox').at(-1)
  assert.equal(positive?.mode, gate)
  assert.deepEqual([positive.path, positive.allowed], [insidePath, true])
  assert.equal(chat.history.at(-2)?.content?.[0]?.text, inside)
  await chat.turn(person('plan-scope-sandbox denied'), CODEX)
  const negative = w.events('fixture-sandbox').at(-1)
  assert.deepEqual([negative.path, negative.allowed], [outsidePath, false])
  assert.match(chat.history.at(-2)?.content?.[0]?.text ?? '', /Permission denied/)
  assert.ok(w.events('own-tool-ran').some(row => row.toolCallId === positive.toolCallId))
  assert.ok(w.events('own-tool-ran').every(row => row.toolCallId !== negative.toolCallId))
  assert.ok(!JSON.stringify(chat.history).includes(outside))
  team.accept()
  await chat.turn(person('plan-scope-sandbox released'), CODEX)
  const released = w.events('fixture-sandbox').at(-1)
  assert.deepEqual([released.path, released.allowed, released.mode], [outsidePath, true, 'agent-full-access'])
  assert.equal(chat.history.at(-2)?.content?.[0]?.text, outside)
  assert.equal(w.events('new-session').length, 1)
  const hang = chat.turn(person('hang'), CODEX)
  const deadline = Date.now() + 5_000
  while (!w.events('prompt').some(row => row.text === 'hang')) {
    assert.ok(Date.now() < deadline, 'the released model-kept turn started')
    await pause(10)
  }
  const pid = w.adapter.live.get(team.bot.id).run.child.pid
  const child = w.events('child').at(-1)?.child
  assert.ok(Number.isInteger(child))
  assert.equal(w.adapter.endNative(team.bot.id, 'fixture'), false)
  await team.rt.reviewBotRequest(team.bot.id, 'fixture-requester', { exchangeId: 'second-request' })
  assert.match((await hang).map(chunk => chunk.text ?? '').join(''), /Work now waits for the reviewer.s verdict on a new plan/)
  const ended = value => {
    try { process.kill(value, 0); return false } catch (error) { return error.code === 'ESRCH' }
  }
  const stoppedAt = Date.now() + 5_000
  while (!ended(pid) || !ended(child)) {
    assert.ok(Date.now() < stoppedAt, 'the fake run and child ended')
    await pause(10)
  }
  await chat.turn('next synthetic request', CODEX)
  assert.equal(w.events('set-mode').at(-1)?.modeId, gate)
})

test('#2134 K9 E-Native real DSH reads and traversals use only synthetic workspace data', { timeout: 18_000 }, async t => {
  const places = fixtureFolders(t)
  const marker = `IN-${randomBytes(8).toString('hex')}`
  const hidden = join(places.project, '.hidden.txt')
  writeFileSync(hidden, marker + '\n')
  const outside = join(places.protectedRoot, 'outside.txt')
  const distinct = `OUT-${randomBytes(8).toString('hex')}`
  writeFileSync(outside, distinct)
  const world = nativeWorld(t, { managed: false, policyState: id => world.identityReaders.readState(id) })
  const team = await teamOf(t, places, world, { provider: 'dsh' })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(executor)
  provideWorkingDirectoryFixture(ctx, places.workspace)
  await ctx.plugin(LocalFileSystem, { cwd: places.workspace })
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(files, { read: true, readImage: false, write: false, edit: false })
  await ctx.plugin(search, { sampleOverCapGlobResults: false })
  const makeAgent = (id, cwd, header) => ({ id, session: Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd, ...header,
  }) })
  const register = (agent, stored = agent.session) => {
    team.agents.set(agent.id, agent)
    team.sessions.set(agent.id, stored)
    return agent
  }
  const agent = register(makeAgent(team.bot.id, places.workspace))
  const guard = team.ctx.listeners.get('tools/execute')[0]
  ctx.on('tools/execute', (exec, next) => guard(exec, () => {
    if (exec.callId.startsWith('denied-')) throw new Error('Fixture fence: legacy guard reached the excluded body')
    return next()
  }))
  async function call(id, name, args, agentForCall = agent) {
    const agent = agentForCall
    const toolSet = await ctx.tools.resolve({ agent, signal: t.signal })
    try {
      const batch = await ctx.tools.execute({ calls: [{ id, name, arguments: args }], agent, signal: t.signal, toolSet })
      return batch.results[0].result
    } finally { toolSet.dispose() }
  }
  for (const phase of ['before', 'after']) {
    if (phase === 'after') team.accept()
    assert.match(JSON.stringify(await call(`${phase}-read`, 'read', { file_path: hidden })), new RegExp(marker))
    assert.match(JSON.stringify(await call(`${phase}-grep`, 'grep', { path: hidden, pattern: '^IN-' })), new RegExp(marker))
    assert.match(JSON.stringify(await call(`${phase}-glob`, 'glob', { path: places.project, pattern: '**' })), /\.hidden\.txt/)
    for (const [name, args] of [
      ['read', { file_path: outside }],
      ['grep', { pattern: '^OUT-' }],
      ['glob', { path: places.workspace, pattern: '**' }],
    ]) {
      const result = await call(`denied-${phase}-${name}`, name, args)
      const text = JSON.stringify(result)
      assert.equal(result.isError, true)
      assert.match(text, /can (read and )?search only inside its folder/)
      assert.ok(!text.includes(distinct))
    }
  }
  const ordinaryFolder = join(places.root, 'ordinary')
  mkdirSync(ordinaryFolder)
  const ordinaryPath = join(ordinaryFolder, 'ordinary.txt')
  const ordinaryText = `FORK-${randomBytes(8).toString('hex')}`
  writeFileSync(ordinaryPath, ordinaryText)
  const historical = { parentSession: team.bot.id }
  const readPolicy = id => world.identityReaders.readState(id)
  const fork = makeAgent('historical-ordinary', ordinaryFolder, historical)
  const helper = team.rt.state.bots[fork.id] = { id: fork.id, name: 'Fixture Helper', role: 'Helper', workDir: ordinaryFolder, createdAt: 1 }
  team.rt.chatOwners.set(fork.id, helper.id)
  register(fork, makeAgent(fork.id, ordinaryFolder, historical).session)
  const ordinary = readPolicy(fork.id)
  assert.equal(ordinary.ok, true)
  assert.equal(ordinary.identity.name, helper.name)
  assert.deepEqual(ordinary.identity.solverPolicy, { state: 'none', bot: helper, own: true })
  assert.equal(ordinary.identity.planGate, false)
  assert.match(JSON.stringify(await call('fork-read', 'read', { file_path: ordinaryPath }, fork)), new RegExp(ordinaryText))

  const solverFork = register(makeAgent(team.bot.id, places.workspace, { parentSession: fork.id, delegationDepth: 0 }))
  const child = register(makeAgent('solver-fork-child', places.workspace, { origin: 'subagent', parentSession: solverFork.id, delegationDepth: 1 }))
  for (const scoped of [solverFork, child]) {
    const identity = readPolicy(scoped.id).identity
    assert.equal(identity.solverPolicy.bot, team.bot)
    assert.equal(identity.solverPolicy.own, true)
    assert.equal(identity.solver, true)
    assert.match(JSON.stringify(await call(`inside-${scoped.id}`, 'read', { file_path: hidden }, scoped)), new RegExp(marker))
    const refused = await call(`denied-fork-${scoped.id}`, 'read', { file_path: ordinaryPath }, scoped)
    assert.equal(refused.isError, true)
    assert.match(JSON.stringify(refused), /can read and search only inside its folder/)
    assert.ok(!JSON.stringify(refused).includes(ordinaryText))
  }
  for (const [id, live, durable] of [
    ['disagreement', historical, { parentSession: fork.id }],
    ['no-registered-header', null, historical],
    ['no-durable-header', historical, null],
    ['supplied-header-only', null, null],
  ]) {
    const supplied = makeAgent(id, ordinaryFolder, historical)
    if (live) team.agents.set(id, makeAgent(id, ordinaryFolder, live))
    else if (durable) team.agents.set(id, { id, session: { id } })
    if (durable) team.sessions.set(id, makeAgent(id, ordinaryFolder, durable).session)
    assert.deepEqual(readPolicy(id), { ok: false }, id)
    const rejected = await call(`denied-${id}`, 'read', { file_path: ordinaryPath }, supplied)
    assert.equal(rejected.isError, true, id)
    assert.match(JSON.stringify(rejected), /could not confirm this Session's rules/, id)
    assert.ok(!JSON.stringify(rejected).includes(ordinaryText), id)
  }
})
