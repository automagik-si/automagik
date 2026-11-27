import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const CLAUDE = 'acp-claude'
const CODEX = 'acp-codex'
const RESET = 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR'
const COMMAND = 'fixture-check'
const TOOL_ID = 'fixture-bash'
const PENDING_AT = 20
const PROGRESS_AT = 30
const COMMAND_CONFLICT = 'The ACP command input is ambiguous.'
const CWD_CONFLICT = 'The ACP working directory is ambiguous.'
const CWD_MISSING = 'The ACP working directory is missing.'
const EXIT_MISSING = 'Trusted ACP terminal exit data is missing.'
const IDENTITY_CONFLICT = 'The ACP execute call identity changed.'
const TERMINAL_CONFLICT = 'The ACP terminal identity is ambiguous.'

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-terminal-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function pending({ input = { command: COMMAND }, name = 'Bash', terminalId = TOOL_ID } = {}) {
  const terminal = terminalId !== null
  return {
    sessionUpdate: 'tool_call', toolCallId: TOOL_ID, kind: 'execute', status: 'pending', title: 'Terminal',
    rawInput: input,
    content: terminal ? [{ type: 'terminal', terminalId }] : [],
    _meta: {
      ...(name === null ? {} : { claudeCode: { toolName: name } }),
      ...(terminal ? { terminal_info: { terminal_id: terminalId } } : {}),
    },
  }
}

function completion({ terminalId = TOOL_ID, exitCode = 0, status = 'completed' } = {}) {
  return {
    sessionUpdate: 'tool_call_update', toolCallId: TOOL_ID, status,
    _meta: { terminal_exit: { terminal_id: terminalId, exit_code: exitCode, signal: null } },
  }
}

async function fixture(t, { provider = CLAUDE, solverCwdReset = true, env = { [RESET]: '1' } } = {}) {
  const { AgentRun, clientCapabilitiesFor } = await import('../src/host/acp.js')
  const { terminalResult } = await import('../src/host/terminal-evidence.js')
  const { callArguments, mirrorTool } = await import('../src/host/tool.js')
  const root = scratch(t)
  const workspace = join(root, 'workspace')
  const other = join(root, 'other')
  mkdirSync(workspace)
  mkdirSync(other)
  const run = new AgentRun({ provider, cwd: workspace, env })
  run.sessionId = 'fixture-acp'
  const session = { id: 'fixture-dsh', snapshotEvents: () => [] }
  const exec = { agent: { session }, callId: 'mirror-check', signal: t.signal }
  const live = { run, provider, native: true, workspace, workspaceArgument: workspace, solverCwdReset,
    calls: new Set([exec.callId]), toolIds: new Map() }
  let observedAt = PENDING_AT
  t.mock.method(performance, 'now', () => observedAt)
  const update = (fields, at = observedAt) => {
    observedAt = at
    return run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: TOOL_ID, ...fields }, run.sessionId)
  }
  const open = async (frame = pending()) => {
    await update(frame)
    const tool = run.tools.get(frame.toolCallId)
    live.toolIds.set(exec.callId, tool.id)
    exec.arguments = callArguments(tool)
    return tool
  }
  const result = (tool, launch = live) => {
    assert.equal(run.tools.get(tool.id), tool)
    return terminalResult(live, tool, exec.arguments, exec, launch)
  }
  const legacy = tool => terminalResult(live, tool, exec.arguments, exec)
  const mirror = (overrides = {}) => mirrorTool({ runOf: () => live, ownsSession: () => true, ...overrides })
    .execute(exec.arguments, exec)
  const outcome = (tool, cwd = workspace) => ({
    sessionId: session.id, callId: exec.callId, toolCallId: tool.id, terminalId: tool.id, cwd, exitCode: 0,
  })
  return { root, workspace, other, run, live, exec, update, open, result, legacy, mirror, outcome,
    candidate: typeof clientCapabilitiesFor === 'function' }
}

function refused(value) {
  assert.equal(value.terminalOutcome?.exitCode, undefined)
  assert.equal(value.terminalStart, undefined)
}

function missingStart(value) {
  assert.equal(value.terminalStart, undefined)
}

test('#2153 unit 1 declares terminal output only to Claude', async () => {
  const { clientCapabilitiesFor } = await import('../src/host/acp.js')
  assert.equal(typeof clientCapabilitiesFor, 'function')
  assert.deepEqual(clientCapabilitiesFor(CLAUDE), { _meta: { terminal_output: true } })
  for (const provider of [CODEX, 'acp-antigravity', 'acp-omp', undefined]) {
    assert.deepEqual(clientCapabilitiesFor(provider), {})
  }
})

for (const mode of ['Solver', 'ordinary', 'Solver to ordinary']) {
  test(`#2153 unit 2 ${mode} reaches the correct Claude spawn environment`, { timeout: 15_000 }, async t => {
    const { nativeWorld } = await import('./fixtures/managed-native-world.js')
    const dir = scratch(t)
    let solver = mode !== 'ordinary'
    const world = nativeWorld(t, {
      hidden: true,
      identity: () => ({
        name: 'Fixture Bot', nativeTools: true, nativeToolsAgent: CLAUDE, solver,
        solverPolicy: { state: solver ? 'solver' : 'none' },
        confineDeny: solver ? [{ path: join(dir, 'private'), kind: 'directory' }] : undefined,
      }),
      policyState: id => world.identityReaders.readState(id),
      env: { FAKE_ACP_STREAM_DIR: dir, [RESET]: undefined },
    })
    const chat = world.chat('fixture-spawn')
    const env = () => JSON.parse(readFileSync(join(dir, 'spawn-env.json'), 'utf8'))
    await chat.turn('fixture before the policy switch')
    const first = world.adapter.live.get(chat.session.id)
    assert.ok(first?.run)
    if (mode === 'Solver') {
      assert.deepEqual(env(), { maintainProjectDir: '1' })
      assert.equal(first.solverCwdReset, true)
      return
    }
    if (solver) {
      solver = false
      await chat.turn('fixture after the policy switch')
      assert.notEqual(world.adapter.live.get(chat.session.id)?.run, first.run)
      assert.equal(world.events('start').length, 2)
    }
    assert.deepEqual(env(), { maintainProjectDir: null })
    assert.notEqual(world.adapter.live.get(chat.session.id)?.solverCwdReset, true)
  })
}

test('#2153 unit 3a verbatim terminal outcome uses the Solver launch cwd', async t => {
  const w = await fixture(t)
  const tool = await w.open()
  await w.update(completion())
  const { terminalOutcome } = w.result(tool)
  assert.equal(terminalOutcome.reason, undefined, terminalOutcome.reason)
  assert.deepEqual(terminalOutcome, w.outcome(tool))
})

test('#2153 unit 3b binds the first pending observation at notification intake', async t => {
  const w = await fixture(t)
  const tool = await w.open(pending({ input: {} }))
  assert.deepEqual(tool.terminalEvidence.pendingStart, {
    terminalId: tool.id, sessionId: w.run.sessionId, name: 'Bash', at: PENDING_AT,
  })
  assert.equal(tool.terminalEvidence.start, undefined)
})

test('#2153 unit 3c complete streamed outcome carries the pending timestamp', async t => {
  const w = await fixture(t)
  const tool = await w.open(pending({ input: {} }))
  await w.update({ rawInput: { command: COMMAND } }, PENDING_AT + 1)
  w.exec.arguments.input = tool.rawInput
  await w.update(completion())
  const value = w.result(tool)
  // A4 credits 3a and 3b only. This twin tests the complete published shape.
  if (!w.candidate) return refused(value)
  assert.deepEqual(value, {
    terminalOutcome: w.outcome(tool), terminalStart: { observedAt: PENDING_AT, startedAt: PENDING_AT },
  })
})

for (const quote of ['', "'", '"']) {
  test(`#2153 unit 4 accepts one canonical leading cd (quote ${JSON.stringify(quote)})`, async t => {
    const w = await fixture(t)
    const command = `cd ${quote}${w.workspace}${quote} && ${COMMAND}`
    const tool = await w.open(pending({ input: { command } }))
    await w.update({ rawInput: { command: COMMAND, description: 'refined fixture check' } })
    await w.update(completion())
    const { terminalOutcome } = w.result(tool)
    assert.equal(terminalOutcome.reason, undefined, terminalOutcome.reason)
    assert.deepEqual(terminalOutcome, w.outcome(tool))
    assert.equal(tool.terminalEvidence.command, command)
    const { stripsWorkspaceCd } = await import('../src/host/workspace-cd.js')
    assert.equal(stripsWorkspaceCd(w.exec.arguments.input, tool.rawInput, w.live), true)
  })
}

for (const [label, commands] of [
  ['reverse', w => [COMMAND, `cd ${w.workspace} && ${COMMAND}`]],
  ['changed tail', w => [`cd ${w.workspace} && ${COMMAND}`, 'fixture-check-other']],
  ['semicolon', w => [`cd ${w.workspace}; ${COMMAND}`, COMMAND]],
  ['other folder', w => [`cd ${w.other} && ${COMMAND}`, COMMAND]],
  ['symlink alias', w => {
    const alias = join(w.root, 'alias')
    symlinkSync(w.workspace, alias, 'dir')
    return [`cd ${alias} && ${COMMAND}`, COMMAND]
  }],
  ['A B A', w => [`cd ${w.workspace} && ${COMMAND}`, COMMAND, `cd ${w.workspace} && ${COMMAND}`]],
  ['A B C', w => [`cd ${w.workspace} && ${COMMAND}`, COMMAND, 'third-command']],
  ['second strip', w => [`cd ${w.workspace} && cd ${w.workspace} && ${COMMAND}`, `cd ${w.workspace} && ${COMMAND}`, COMMAND]],
]) {
  test(`#2153 unit 5 refuses command ambiguity from ${label}`, async t => {
    const w = await fixture(t)
    const [command, ...updates] = commands(w)
    const tool = await w.open(pending({ input: { command } }))
    for (const change of updates) await w.update({ rawInput: { command: change } })
    await w.update(completion())
    const value = w.result(tool)
    refused(value)
    assert.equal(value.terminalOutcome.reason, COMMAND_CONFLICT)
  })
}

for (const [label, setup, reason, baseReason = CWD_MISSING] of [
  ['first workdir conflict', async w => w.open(pending({ input: { command: COMMAND, workdir: w.other } })), CWD_CONFLICT],
  ['refined workdir conflict', async w => {
    const tool = await w.open(pending({ input: { command: `cd ${w.workspace} && ${COMMAND}` } }))
    await w.update({ rawInput: { command: COMMAND, workdir: w.other } })
    return tool
  }, CWD_CONFLICT, COMMAND_CONFLICT],
  ['mirror cwd conflict', async w => {
    const tool = await w.open()
    w.exec.arguments.input = { command: COMMAND, cwd: w.other }
    return tool
  }, CWD_CONFLICT],
  ['removed workspace', async w => {
    const tool = await w.open()
    rmSync(w.workspace, { recursive: true })
    return tool
  }, CWD_MISSING],
  ['repeated cwd conflicts and returns to the first value', async w => {
    const tool = await w.open(pending({ input: { command: COMMAND, cwd: w.workspace } }))
    for (const cwd of [w.other, w.workspace]) await w.update({ rawInput: { command: COMMAND, cwd } })
    return tool
  }, CWD_CONFLICT, CWD_CONFLICT],
  ['repeated workdir conflicts and returns to the first value', async w => {
    const tool = await w.open(pending({ input: { command: COMMAND, workdir: w.workspace } }))
    for (const workdir of [w.other, w.workspace]) await w.update({ rawInput: { command: COMMAND, workdir } })
    return tool
  }, CWD_CONFLICT],
]) {
  test(`#2153 unit 5 refuses ${label}`, async t => {
    const w = await fixture(t)
    const tool = await setup(w)
    await w.update(completion())
    const value = w.result(tool)
    refused(value)
    assert.equal(value.terminalOutcome.reason, w.candidate ? reason : baseReason)
  })
}

test('#2153 unit 5 accepts an explicit workdir equal to the workspace', async t => {
  const w = await fixture(t)
  const tool = await w.open(pending({ input: { command: COMMAND, workdir: w.workspace } }))
  await w.update(completion())
  const value = w.result(tool)
  if (w.candidate) assert.deepEqual(value.terminalOutcome, w.outcome(tool))
  else assert.equal(value.terminalOutcome.reason, CWD_MISSING)
})

for (const [label, solverCwdReset, env, inherited] of [
  ['ordinary Bash without host flag', false, {}],
  ['ordinary Bash with inherited reset', false, {}, true],
  ['Solver flag without spawn env', true, {}],
]) {
  test(`#2153 unit 5 ${label} cannot infer cwd`, async t => {
    if (inherited) {
      const previous = process.env[RESET]
      process.env[RESET] = '1'
      t.after(() => {
        if (previous === undefined) delete process.env[RESET]
        else process.env[RESET] = previous
      })
    }
    const w = await fixture(t, { solverCwdReset, env })
    const tool = await w.open()
    await w.update(completion())
    const value = w.result(tool)
    refused(value)
    assert.equal(value.terminalOutcome.reason, CWD_MISSING)
  })
}

test('#2153 unit 5 refuses inference when the mirror loses ownership before release', async t => {
  const w = await fixture(t)
  const tool = await w.open()
  await w.update(completion())
  let current = w.live
  const value = await w.mirror({
    runOf: () => current,
    bridgeApprovals: () => { current = { ...w.live } },
  })
  assert.notEqual(current, w.live)
  assert.equal(w.run.tools.get(TOOL_ID), tool)
  refused(value)
  assert.equal(value.terminalOutcome.reason, CWD_MISSING)
})

for (const restriction of ['parent', 'dispatch', 'non-Bash', 'no launch']) {
  test(`#2153 unit 5 does not release a strip or pending start with ${restriction}`, async t => {
    const w = await fixture(t)
    const frame = pending({ input: { command: `cd ${w.workspace} && ${COMMAND}` },
      name: restriction === 'non-Bash' ? 'Other' : 'Bash' })
    if (restriction === 'parent') frame._meta.claudeCode.parentToolUseId = 'parent-call'
    const tool = await w.open(frame)
    await w.update({ rawInput: { command: COMMAND } })
    await w.update(completion())
    let value
    if (restriction === 'dispatch') {
      // Give the nested dispatch a valid pending question for its completed input.
      const { callArguments } = await import('../src/host/tool.js')
      const question = { call: { ...tool }, asked: true, answer: () => { tool.permission = undefined } }
      tool.permission = question
      w.exec.arguments = callArguments(tool)
      const dispatched = { live: w.live, session: w.exec.agent.session, run: w.run, tool, args: w.exec.arguments, question }
      value = await w.mirror({ nestedPermissionOf: () => dispatched })
    } else {
      value = await (restriction === 'no launch' ? w.legacy(tool) : w.mirror())
    }
    refused(value)
    assert.equal(value.terminalOutcome.reason, COMMAND_CONFLICT)
  })
}

for (const [label, prepare] of [
  ['update-first', async (w, frame) => w.open({ ...frame, sessionUpdate: 'tool_call_update' })],
  ['late pending announcement', async (w, frame) => {
    const tool = await w.open({ ...frame, status: undefined })
    await w.update(frame)
    return tool
  }],
  ['missing first terminal info', async (w, frame) => {
    const tool = await w.open({ ...frame, _meta: { claudeCode: { toolName: 'Bash' } } })
    await w.update({ _meta: frame._meta })
    return tool
  }],
  ['stable non-Bash', async (w, frame) => w.open({ ...frame, _meta: {
    ...frame._meta, claudeCode: { toolName: 'Other' },
  } })],
  ['name first supplied by a notification refinement', async (w, frame) => {
    const tool = await w.open({ ...frame, _meta: { terminal_info: frame._meta.terminal_info } })
    await w.update({ name: 'Bash' })
    return tool
  }],
  ['name first supplied by permission', async (w, frame) => {
    const tool = await w.open({ ...frame, _meta: { terminal_info: frame._meta.terminal_info } })
    const answer = w.run.onPermission({ sessionId: w.run.sessionId, toolCall: { toolCallId: tool.id, name: 'Bash' } })
    tool.permission.answer({ outcome: { outcome: 'cancelled' } })
    await answer
    return tool
  }],
]) {
  test(`#2153 unit 5 ${label} does not establish a pending start`, async t => {
    const w = await fixture(t)
    const tool = await prepare(w, pending({ input: { command: COMMAND, cwd: w.workspace } }))
    await w.update(completion())
    assert.equal(tool.terminalEvidence.pendingStart, undefined)
    const value = await w.mirror()
    assert.deepEqual(value.terminalOutcome, w.outcome(tool))
    missingStart(value)
  })
}

for (const [label, first, finish, reason] of [
  ['exit differs from the announced terminal', pending(), completion({ terminalId: 'other-terminal' }),
    'The ACP terminal exit does not match the execute call.'],
  ['announcement and exit belong to another call', pending({ terminalId: 'other-terminal' }),
    completion({ terminalId: 'other-terminal' }), TERMINAL_CONFLICT],
  ['exit code is null', pending(), completion({ exitCode: null }), 'The ACP terminal exit data is incomplete.'],
  ['failed status with zero exit', pending(), completion({ status: 'failed' }),
    'The ACP execute call did not reach a matching completion.'],
]) {
  test(`#2153 unit 5 refuses ${label}`, async t => {
    const w = await fixture(t)
    const tool = await w.open(structuredClone(first))
    if (first._meta.terminal_info.terminal_id !== TOOL_ID) assert.equal(tool.terminalEvidence.pendingStart, undefined)
    await w.update(structuredClone(finish))
    const value = w.result(tool)
    refused(value)
    const baseReason = label === 'announcement and exit belong to another call' || label === 'failed status with zero exit'
      ? CWD_MISSING : reason
    assert.equal(value.terminalOutcome.reason, w.candidate ? reason : baseReason)
  })
}

for (const [label, firstName, changeName, reason = IDENTITY_CONFLICT] of [
  ['non-Bash renamed to Bash', 'Other', async w => w.update({ name: 'Bash' })],
  ['Bash renamed and restored', 'Bash', async w => {
    await w.update({ name: 'Other' })
    await w.update({ name: 'Bash' })
  }],
  ['contradictory root and metadata names', 'Other', async () => {}],
  ['permission temporarily renames Bash', 'Bash', async (w, tool) => {
    const response = w.run.onPermission({ sessionId: w.run.sessionId, toolCall: { toolCallId: tool.id, name: 'Other' } })
    assert.equal(tool.structuredName, 'Other')
    tool.permission.answer({ outcome: { outcome: 'cancelled' } })
    await response
    await w.update({ name: 'Bash' })
  }],
  ['terminal output identifies another call', 'Bash', w => w.update({
    _meta: { terminal_output: { terminal_id: 'other-terminal', data: '1' } },
  }), TERMINAL_CONFLICT],
  ['terminal metadata changes and returns', 'Bash', async w => {
    for (const terminalId of ['other-terminal', TOOL_ID]) {
      await w.update({ _meta: { terminal_info: { terminal_id: terminalId } } })
    }
  }, TERMINAL_CONFLICT],
  ['permission claims MCP', 'Bash', async (w, tool) => {
    const response = w.run.onPermission({ sessionId: w.run.sessionId, toolCall: { toolCallId: tool.id, name: 'Bash' },
      _meta: { is_mcp_tool_approval: true } })
    tool.permission.answer({ outcome: { outcome: 'cancelled' } })
    await response
  }],
]) {
  test(`#2153 unit 5 latches the identity conflict when ${label}`, async t => {
    const w = await fixture(t)
    const frame = pending({ name: firstName })
    if (label === 'contradictory root and metadata names') frame.name = 'Bash'
    const tool = await w.open(frame)
    assert.equal(Boolean(tool.terminalEvidence.pendingStart), w.candidate && firstName === 'Bash')
    await changeName(w, tool)
    await w.update(completion())
    assert.equal(tool.structuredName, 'Bash')
    const value = await w.mirror()
    refused(value)
    const baseReason = label === 'terminal metadata changes and returns' ? reason : CWD_MISSING
    assert.equal(value.terminalOutcome.reason, w.candidate ? reason : baseReason)
  })
}

test('#2153 unit 5 a permission rename before execute evidence vetoes the later outcome', async t => {
  const w = await fixture(t)
  const { callArguments } = await import('../src/host/tool.js')
  const input = { command: COMMAND, cwd: w.workspace }
  const tool = await w.open({
    sessionUpdate: 'tool_call', toolCallId: TOOL_ID, status: 'pending', name: 'Bash',
  })
  assert.equal(tool.structuredName, 'Bash')
  assert.equal(tool.terminalEvidence, undefined)

  const answer = w.run.onPermission({
    sessionId: w.run.sessionId, toolCall: { toolCallId: tool.id, name: 'Other' },
    options: [{ kind: 'allow_once', optionId: 'yes', name: 'Allow' }],
  })
  assert.equal(tool.structuredName, 'Other')
  const allowed = { outcome: { outcome: 'selected', optionId: 'yes' } }
  tool.permission.answer(allowed)
  assert.deepEqual(await answer, allowed)
  assert.equal(tool.terminalEvidence, undefined)

  await w.update({
    ...pending({ input }), sessionUpdate: 'tool_call_update', status: 'in_progress',
  }, PROGRESS_AT)
  assert.equal(w.run.tools.get(TOOL_ID), tool)
  assert.equal(tool.structuredName, 'Bash')
  assert.deepEqual(tool.terminalEvidence.start, { terminalId: TOOL_ID, at: PROGRESS_AT })
  w.exec.arguments = callArguments(tool)
  await w.update(completion(), PROGRESS_AT + 1)
  assert.deepEqual(tool.terminalEvidence.exit, { terminalId: TOOL_ID, exitCode: 0 })
  const value = await w.mirror()
  assert.equal(value.terminalOutcome?.reason, IDENTITY_CONFLICT)
  refused(value)
})

test('#2153 unit 5 terminal exit cannot come from permission or a tool body', async t => {
  const w = await fixture(t)
  const tool = await w.open(pending({ terminalId: null }))
  const claimed = completion()._meta
  const response = w.run.onPermission({
    sessionId: w.run.sessionId,
    toolCall: { toolCallId: tool.id, name: 'Bash', _meta: { ...claimed, terminal_info: { terminal_id: tool.id } } },
  })
  tool.permission.answer({ outcome: { outcome: 'cancelled' } })
  await response
  await w.update({ status: 'completed', rawOutput: claimed,
    content: [{ type: 'content', content: { type: 'text', text: JSON.stringify(claimed) } }],
  })
  const value = w.result(tool)
  refused(value)
  assert.equal(value.terminalOutcome.reason, EXIT_MISSING)
})

test('#2153 unit 5 absent capability leaves the fake native mirror with console text only', { timeout: 15_000 }, async t => {
  const { nativeWorld, person } = await import('./fixtures/managed-native-world.js')
  const dir = scratch(t)
  const results = []
  const world = nativeWorld(t, {
    managed: false, hidden: true, env: { FAKE_ACP_STREAM_DIR: dir },
    runTool: async (args, exec) => {
      writeFileSync(join(dir, 'mirror-recorded'), '')
      const value = await world.adapter.tool.execute(args, exec)
      results.push(value)
      return value
    },
  })
  const chat = world.chat('fixture-no-capability')
  await chat.turn(person('plan-scope-claude-check verbatim'), CODEX)
  assert.deepEqual(world.events('initialize').map(row => row.clientCapabilities), [{}])
  assert.equal(world.events('claude-check-permission').at(-1)?.answer, 'yes')
  assert.equal(results.length, 1)
  const [value] = results
  assert.match(value.text, /^\x60{3}console\n1\n/)
  refused(value)
  assert.equal(value.terminalOutcome.reason, EXIT_MISSING)
})

for (const eligible of [false, true]) {
  test(`#2153 note 2 preserves independent progress start (launch eligible: ${eligible})`, async t => {
    const w = await fixture(t)
    const tool = await w.open(pending({ input: { command: COMMAND, cwd: w.workspace } }))
    await w.update({ status: 'in_progress' }, PROGRESS_AT)
    await w.update({ status: 'in_progress' }, PROGRESS_AT + 1)
    await w.update(completion(), PROGRESS_AT + 2)
    assert.deepEqual(tool.terminalEvidence.start, { terminalId: tool.id, at: PROGRESS_AT })
    const { pendingStart } = tool.terminalEvidence
    if (w.candidate) assert.deepEqual(pendingStart, {
      terminalId: tool.id, sessionId: w.run.sessionId, name: 'Bash', at: PENDING_AT,
    })
    const value = eligible ? w.result(tool) : w.legacy(tool)
    assert.deepEqual(value, {
      terminalOutcome: w.outcome(tool),
      terminalStart: { observedAt: PENDING_AT, startedAt: eligible && w.candidate ? PENDING_AT : PROGRESS_AT },
    })
  })
}

for (const status of ['in_progress', 'pending']) {
  test(`#2153 unit 6 Codex capture preserves its normal ${status} outcome`, async t => {
    const capture = JSON.parse(readFileSync(new URL('./fixtures/permission-payloads/codex-acp-2.6.0.json', import.meta.url)))
    const { updates } = capture.cases.find(item => item.name === 'agent: write outside the workspace')
    const first = updates.find(update => update.kind === 'execute')
    const exit = updates.find(update => update._meta?.terminal_exit)
    const w = await fixture(t, { provider: CODEX })
    const tool = await w.open({ ...first, status })
    await w.update(exit, PROGRESS_AT)
    assert.equal(tool.terminalEvidence.pendingStart, undefined)
    assert.deepEqual(w.legacy(tool), {
      terminalOutcome: w.outcome(tool, first.rawInput.cwd),
      ...(status === 'in_progress' ? { terminalStart: { observedAt: PENDING_AT, startedAt: PENDING_AT } } : {}),
    })
  })
}
