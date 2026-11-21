import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { COMMAND_MAX, install, installAhead } from '../src/host/auto-judge.js'
import { install as installDiagnostics } from '../src/host/diagnostics.js'
import { fakeContext } from './fake-ctx.js'

const hidden = 'a credential command, not shown'

async function fixture(t, mark = 'acp-hermes') {
  const home = await mkdtemp(join(tmpdir(), 'wincred-auto-'))
  const ctx = fakeContext({ services: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } } })
  const events = []
  const payloads = []
  const bot = { id: 'fixture', name: 'Fixture', permissionAuto: mark }
  const session = { id: bot.id, snapshotEvents: () => events }
  const rt = {
    ctx, home, config: {}, state: { bots: { [bot.id]: bot }, rooms: {}, mainBotIds: [bot.id] },
    chatOwners: new Map([[bot.id, bot.id]]), botOf: id => id === bot.id ? bot : undefined,
    autoWhy: () => undefined, backgroundModel: async () => 'deepseek/v4',
  }
  ctx.llm = {
    resolveModelInfo: async () => ({}),
    async* stream(payload) {
      payloads.push(payload)
      yield { type: 'text-delta', index: 0, text: '{"decision":"allow","reason":"local work"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  installDiagnostics(rt)
  install(rt)
  installAhead(rt)
  t.after(async () => {
    await ctx.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const approve = ctx.listeners.get('approval/request').at(-1)
  const mirror = (input, options = {}) => {
    const { callId = randomUUID(), title = 'Run shell', ...permission } = options
    return approve({ agent: { session }, toolName: 'acp_tool', callId, reason: 'local work',
      mirrorCall: { allowOnce: true, kind: 'execute', title, input }, ...permission }, () => 'person')
  }
  const escalate = (name, args, callId = randomUUID()) => ctx.listeners.get('tools/pre-execute').at(-1)({
    name, callId, agent: { session },
    arguments: { sandbox_permissions: 'danger-full-access', justification: 'local work', ...args },
  }, () => 'person')
  return { ctx, rt, home, events, payloads, mirror, escalate, approve, session }
}

test('the Auto approval entry asks before recognized credential commands in argv, text and terminal input', async t => {
  const h = await fixture(t)
  const marker = randomUUID()
  const cmd = ['C:\\Windows\\System32\\CMDKEY.EXE', '/generic:' + marker]
  cmd.push('/' + 'pass' + ':' + randomUUID())
  const commands = [
    cmd, 'cmdkey /list', 'CmDkEy /delete:' + marker, 'cmdkey /add:' + marker,
    'VAULTCMD.exe /list', 'C:\\Windows\\System32\\vaultcmd.exe',
    ['C:\\Program Files\\PowerShell\\7\\PwSh.ExE', '-NoProfile', '-CoMmAnD', 'Get-StoredCredential ' + marker],
    'powershell.exe -Command "[Native]::CredReadW()"', 'powershell -c "[Native]::CredEnumerateW()"',
    'powershell -c "[Native]::CredWriteW()"', 'pwsh -c "[Windows.Security.Credentials.PasswordVault]"',
    'pwsh -e ' + marker, 'pwsh -ec ' + marker, 'powershell -ENC ' + marker, 'powershell -EncodedCommand ' + marker,
    'powershell -File entry.ps1', 'powershell -f entry.ps1', 'pwsh -', 'pwsh -Command -', 'pwsh entry.ps1',
    'bash -lc "powershell.exe -c Get-StoredCredential"',
  ]
  for (const command of commands) assert.equal(await h.mirror({ command }), 'person')
  assert.equal(await h.mirror({ text: 'cmdkey /list:' + marker }, { title: 'terminal_send' }), 'person')
  assert.equal(await h.mirror({ script: 'Get-StoredCredential ' + marker }, { title: 'pwsh' }), 'person')
  assert.equal(await h.mirror({ script: '$generatedCommand' }, { title: 'PWSH' }), 'person')
  assert.equal(h.payloads.length, 0)
  assert.equal(h.rt.autoAuditRows().every(row => row.code === 'hard' && row.tool === 'acp_tool' && row.detail === hidden), true)
  assert.equal(await h.mirror({ command: 'pwsh -NoProfile -Command Get-Location' }), 'allowed-once')
  assert.equal(h.payloads.length, 1)
})

test('credential text in permission title, reason or escalation justification hard-asks', async t => {
  const h = await fixture(t)
  const marker = randomUUID()
  const command = 'cmdkey /list:' + marker
  assert.equal(await h.mirror({ command: 'ls' }, { permissionTitle: 'Run ' + command }), 'person')
  assert.equal(await h.mirror({ command: 'ls' }, { reason: 'Need to run ' + command }), 'person')
  assert.equal(await h.mirror({ command: 'ls' }, { justification: 'Need to run ' + command }), 'person')
  assert.equal(h.payloads.length, 0)
  const own = await fixture(t, 'api:deepseek/v4')
  assert.equal(await own.escalate('bash', { command: 'ls', justification: 'Need to run ' + command }), 'person')
  assert.equal(own.payloads.length, 0)
  assert.equal(own.rt.autoAuditRows()[0].code, 'hard')
})

test('a mirror’s title and input stay out of Auto diagnostics, audit and later judge payloads', async t => {
  const h = await fixture(t)
  const target = randomUUID()
  const value = randomUUID()
  const title = 'Inspect ' + target + ' with cmdkey /list'
  const input = { command: ['cmdkey', '/generic:' + target, '/' + 'pass' + ':' + value] }
  assert.equal(await h.mirror(input, { title, callId: 'credential-step' }), 'person')
  assert.equal(h.payloads.length, 0)

  h.events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [
    { type: 'text', text: 'Please inspect the fixture with ' + input.command.join(' ') },
  ] } })
  h.events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [
    { type: 'text', text: 'Then list these files.' },
  ] } })

  // The mirror title affected the decision, but the historical event need not repeat it.
  h.events.push({ type: 'tool/call', data: { callId: 'credential-step', name: 'acp_tool',
    arguments: { opaque: [target, value] } } })
  h.events.push({ type: 'tool/call', data: { callId: 'historical', name: 'acp_tool',
    title: 'cmdkey /list:' + target, arguments: { opaque: value } } })
  h.events.push({ type: 'tool/call', data: { callId: 'macos', name: 'bash',
    arguments: { command: 'security find-generic-password -w -s ' + target } } })
  assert.equal(await h.mirror({ command: 'ls' }), 'allowed-once')
  assert.equal(h.payloads.length, 1)
  const payload = h.payloads[0].messages[0].content[0].text
  assert.equal(JSON.parse(payload).callsThisTurn.every(call => call.arguments === hidden), true)
  const requests = JSON.parse(payload).requests
  assert.equal(requests.length === 2 && requests[0].text === hidden && requests[1].text === 'Then list these files.', true)
  const report = JSON.stringify(await h.rt.diagnostics.report())
  const audit = JSON.stringify(h.rt.autoAuditRows())
  await h.ctx.dispose()
  const file = await readFile(join(h.home, 'logs', 'diagnostics.jsonl'), 'utf8')
  const needles = [target, value, Buffer.from(target).toString('base64'), Buffer.from(value).toString('base64')]
  for (const surface of [report, audit, file, payload, JSON.stringify(h.payloads[0])]) {
    assert.ok(surface.includes(hidden))
    assert.equal(needles.some(needle => surface.includes(needle)), false, 'canaries stay private')
  }
})

test('macOS password reads in prose permission fields hard-ask before judge dispatch', async t => {
  const h = await fixture(t)
  const read = '/usr/bin/security find-generic-password -w -s ' + randomUUID()
  assert.equal(await h.mirror({ command: 'ls' }, { reason: 'Need to run ' + read }), 'person')
  assert.equal(await h.mirror({ command: 'ls' }, { permissionTitle: 'Run ' + read }), 'person')
  assert.equal(await h.mirror({ command: 'ls' }, { justification: 'Need to run "' + read + '"' }), 'person')
  assert.equal(h.payloads.length, 0)
  assert.equal(await h.mirror({ command: 'ls' }, { reason: 'Need to run security list-keychains' }), 'allowed-once')
})

test('large command-bearing bodies hard-ask within a bounded classification time', async t => {
  const h = await fixture(t)
  const large = 'file body '.repeat(COMMAND_MAX * 8)
  const start = performance.now()
  assert.equal(await h.mirror({ file_path: 'fixture.txt', content: large }, { title: 'write_file' }), 'person')
  assert.equal(performance.now() - start < 1000, true, 'oversized input is refused before tokenization')
  assert.equal(h.payloads.length, 0)
  assert.equal(h.rt.autoAuditRows().at(-1).code, 'hard')
})

test('serialized chat argv and ACP arguments are private in the complete next judge request', async t => {
  const h = await fixture(t)
  const markers = []
  const marker = () => {
    const value = randomUUID()
    markers.push(value)
    return value
  }
  const message = text => ({ type: 'user/message', data: {
    source: { kind: 'user' }, content: [{ type: 'text', text }],
  } })
  const pasted = JSON.stringify(['cmdkey.exe', '/generic:' + marker(), '/' + 'pass' + ':' + marker()])
  const read = () => '/usr/bin/security find-generic-password -w -s ' + marker()
  const mirrorRow = (id, tool) => ({ type: 'tool/call', data: {
    callId: id, name: 'acp_tool', arguments: JSON.stringify({
      id, title: tool.title ?? 'Run shell', kind: 'execute', input: tool.input ?? null,
    }),
  } })
  h.events.push(...[
    { type: 'turn/start' },
    message(pasted),
    message('Now list the files.'),
    mirrorRow('title', { title: 'Need to run ' + read() }),
    ...['command', 'cmd', 'script', 'text', 'justification', 'permissionTitle'].map(key =>
      mirrorRow(key, { input: { [key]: 'Need to run ' + read() } })),
    mirrorRow('nested-argv', { input: { arguments: { command: ['cmdkey', '/generic:' + marker()] } } }),
    mirrorRow('ordinary', { title: 'List files', input: { command: 'ls' } }),
  ].map(event => ({ event })))
  assert.equal(await h.mirror({ command: 'ls' }), 'allowed-once')
  assert.equal(h.payloads.length, 1)
  const completeRequest = JSON.stringify(h.payloads[0])
  assert.equal(markers.some(value => [value, Buffer.from(value).toString('base64')]
    .some(needle => completeRequest.includes(needle))), false, 'no history canary in the full judge request')
  const { requests, callsThisTurn } = JSON.parse(h.payloads[0].messages[0].content[0].text)
  assert.deepEqual(requests.map(request => request.text), [hidden, 'Now list the files.'])
  assert.equal(callsThisTurn.filter(call => call.arguments === hidden).length, 8)
  assert.match(callsThisTurn.at(-1).arguments, /List files/)
})

test('introduced, inline and fenced JSON argv stay out of the complete next judge request', async t => {
  const h = await fixture(t)
  const target = randomUUID(), value = randomUUID()
  const command = ['C:\\Windows\\System32\\CMDKEY.EXE', '/generic:' + target, '/' + 'pass' + ':' + value]
  const pasted = JSON.stringify(command)
  const fence = String.fromCharCode(96).repeat(3)
  const ordinary = 'Finally run ["ls","-l"] to check the files.'
  for (const text of [
    'Please run this ' + pasted,
    'Run ' + fence[0] + pasted + fence[0] + ' when ready.',
    'Please run this:\n' + fence + 'json\n' + JSON.stringify(command, null, 2) + '\n' + fence,
    ordinary,
  ]) {
    h.events.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  }
  assert.equal(await h.mirror({ command }), 'person')
  assert.equal(h.payloads.length, 0)
  assert.equal(await h.mirror({ command: 'ls' }), 'allowed-once')
  assert.equal(h.payloads.length, 1)
  const completeRequest = JSON.stringify(h.payloads[0])
  const needles = [target, value].flatMap(marker => [marker, Buffer.from(marker).toString('base64')])
  assert.equal(needles.some(needle => completeRequest.includes(needle)), false, 'the full judge request has no canaries')
  const { requests } = JSON.parse(h.payloads[0].messages[0].content[0].text)
  assert.deepEqual(requests.map(request => request.text), [hidden, hidden, hidden, ordinary])
})

test('the next judge sees the risk of running a package script after a private write', async t => {
  const h = await fixture(t)
  const target = randomUUID(), value = randomUUID()
  const file = { file_path: join(target, 'package.json'), content: value.repeat(COMMAND_MAX) }
  const callId = randomUUID()
  assert.equal(await h.mirror(file, { title: 'Write a file', callId }), 'person')
  assert.equal(h.payloads.length, 0)
  h.events.push({ type: 'tool/call', data: { name: 'write', callId, arguments: JSON.stringify(file) } })
  assert.equal(await h.mirror({ command: 'npm run fixture' }), 'allowed-once')
  assert.equal(h.payloads.length, 1)
  const { step, callsThisTurn } = JSON.parse(h.payloads[0].messages[0].content[0].text)
  assert.deepEqual(step.runsFilesItWrote, ['a prior file write with hidden details'])
  assert.equal(callsThisTurn[0].arguments, hidden)
  const needles = [target, value].flatMap(marker => [marker, Buffer.from(marker).toString('base64')])
  const completeRequest = JSON.stringify(h.payloads[0])
  assert.equal(needles.some(needle => completeRequest.includes(needle)), false, 'the write path and body stay private')
})

test('a native PowerShell grant checks every supplied body and binds request input', async t => {
  const h = await fixture(t, 'api:deepseek/v4')
  const cmd = { sandbox_permissions: 'danger-full-access', justification: 'local work', command: 'Get-Location' }
  const agent = { session: h.session }
  const toolName = 'mcp__dsh__pwsh'
  const reason = 'escalate sandbox to danger-full-access: local work'
  const opaque = '$' + randomUUID().replaceAll('-', '')
  for (const [input, expected, code, logged = cmd] of [
    [cmd, 'allowed-once', 'grant'],
    [JSON.stringify({ ...cmd, command: 'Get-Date' }), 'person', 'grant'],
    [opaque, 'person', 'hard'],
    [{ ...cmd, script: opaque }, 'person', 'hard'],
    [cmd, 'person', 'hard', { ...cmd, command: opaque }],
  ]) {
    const callId = randomUUID()
    assert.equal(await h.escalate(toolName, cmd, callId), 'person')
    const reviewed = h.rt.autoAuditRows().at(-1)
    assert.equal(reviewed.decision === 'allow' && reviewed.kept, true, 'the plain logged body earned a grant')
    h.events.push({ type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(logged) } })
    const before = h.payloads.length
    assert.equal(await h.approve({ agent, toolName, callId, reason, input }, () => 'person'), expected)
    assert.equal(h.payloads.length, before, 'the approval does not dispatch another judge request')
    const audit = h.rt.autoAuditRows().at(-1)
    assert.equal(audit.code, code)
    if (code === 'grant') assert.equal(audit.kept, expected === 'allowed-once')
  }
  assert.equal(JSON.stringify(h.payloads).includes(opaque), false)
})

test('large and credential-bearing subtrees at the depth limit hard-ask before serialization', async t => {
  const team = await fixture(t)
  const own = await fixture(t, 'api:deepseek/v4')
  const target = randomUUID(), value = randomUUID()
  const nested = command => ({ a: { b: { c: { d: { command } } } } })
  const sparse = []
  sparse.length = COMMAND_MAX * 8
  for (const args of [
    nested('file body '.repeat(COMMAND_MAX * 8)),
    nested(['cmdkey', '/generic:' + target, '/' + 'pass' + ':' + value]),
    { a: { b: { c: { d: sparse } } } },
  ]) {
    let serialized = false
    Object.defineProperty(args.a, 'toJSON', { value: () => { serialized = true; return {} } })
    assert.equal(await team.mirror(args), 'person')
    assert.equal(serialized, false)
    assert.equal(await own.escalate('bash', args), 'person')
    assert.equal(serialized, false)
  }
  for (const h of [team, own]) {
    assert.equal(h.payloads.length, 0)
    assert.equal(h.rt.autoAuditRows().every(row => row.code === 'hard' && row.detail === hidden), true)
  }
  team.events.push({ type: 'tool/call', data: {
    callId: 'nested', name: 'bash', arguments: JSON.stringify(nested('cmdkey /list:' + target)),
  } })
  assert.equal(await team.mirror({ command: 'ls' }), 'allowed-once')
  assert.equal(JSON.stringify(team.payloads[0]).includes(target), false)
})
