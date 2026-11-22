import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import * as shellEnv from '@deepseek-ai/dsh-shell-env'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Terminals from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import * as bash from '@deepseek-ai/dsh-tool-bash'
import * as persistentBash from '@deepseek-ai/dsh-tool-bash-persistent'
import AutomagikSandboxProvider from '../src/host/sandbox-local.js'

const SYSTEM_CONFIG = '/etc/ssh/ssh_config.d'
const dumpHost = existsSync(join(SYSTEM_CONFIG, '20-systemd-ssh-proxy.conf')) ? 'vsock/1' : 'fixture2024'
const dumpArgs = ['-G', '-q', dumpHost]
const command = `printf 'fixture-config-start\\n'; ssh ${dumpArgs.join(' ')} && printf 'fixture-config-end\\n'`
const args = { description: 'Read the effective fixture SSH configuration', command }
const textOf = result => result.content.map(item => item.text ?? '').join('\n')

function liveSkip() {
  if (process.platform !== 'linux' || spawnSync('bwrap', [
    '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true',
  ], { timeout: 5000 }).status !== 0) return 'bubblewrap cannot create a user namespace'
  const uid = process.getuid()
  if (uid === 0 || !existsSync(SYSTEM_CONFIG) || lstatSync(SYSTEM_CONFIG).uid !== 0
    || !readdirSync(SYSTEM_CONFIG).some(name => name.endsWith('.conf') && statSync(join(SYSTEM_CONFIG, name)).uid !== uid)) {
    return 'no trusted system SSH drop-in with a non-caller owner'
  }
  try {
    lstatSync(join(userInfo().homedir, '.ssh', 'config'))
    return 'OpenSSH would read a personal configuration; use a disposable OS user for this check'
  } catch (error) {
    return error.code === 'ENOENT' ? false : 'cannot verify that the SSH configuration is disposable'
  }
}

class ScriptedModel extends LlmAdapter {
  requests = 0
  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id, context: { contextWindow: 100_000 } }) }
  listModels() { return Promise.resolve([]) }
  async *stream() {
    if (this.requests++ === 0) {
      yield { type: 'tool-call-delta', index: 0, id: 'ssh-fixture-call', name: 'bash', argumentsDelta: JSON.stringify(args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'text-delta', index: 0, text: 'Done.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function harness(t, mode, persistent = false) {
  const dir = mkdtempSync(join(import.meta.dirname, 'automagik-executors-'))
  const workspaceRoot = join(dir, 'workspace')
  const runtimeDirectory = join(dir, 'runtime')
  mkdirSync(workspaceRoot, { mode: 0o700 })
  mkdirSync(runtimeDirectory, { mode: 0o700 })
  const root = new Context()
  t.after(async () => {
    try { await root.fiber.dispose() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.llm.registerAdapter(['native'], new ScriptedModel())
  await mountAgentLoopTestHarness(root)
  await root.plugin(Subprocess)
  await root.plugin(SandboxPolicy, { mode, workspaceRoot })
  await root.plugin(AutomagikSandboxProvider, {})
  root.sandbox.internals.sshConfig = { runtimeDirectory }
  if (persistent) {
    await root.plugin(Terminals)
    await root.plugin(terminalBash, { cols: 240, timeoutMs: 10_000 })
    await root.plugin(persistentBash, { timeoutMs: 10_000 })
  } else {
    await root.plugin(SandboxBashExecutor)
    await root.plugin(shellEnv)
    await root.plugin(bash, { enableRunInBackground: false })
  }
  const agent = await root.agentLoop.create('ssh-fixture', { provider: 'native', model: 'default' }, { cwd: workspaceRoot })
  const invoke = async payload => {
    const { results: [entry] } = await root.tools.execute({
      agent, signal: new AbortController().signal, calls: [{ id: 'ssh-executor', name: 'bash', arguments: JSON.stringify(payload) }],
    })
    return entry.result
  }
  return { dir, root, agent, invoke }
}

function assertEffectiveConfig(result) {
  const text = textOf(result).replaceAll('\r\n', '\n')
  assert.notEqual(result.isError, true, text)
  const host = spawnSync('ssh', dumpArgs, { encoding: 'utf8', timeout: 8000 })
  assert.ifError(host.error)
  assert.equal(host.status, 0, host.stderr)
  const reported = text.match(/^fixture-config-start\n([^]*?)^fixture-config-end$/m)
  assert.ok(reported, text)
  assert.equal(reported[1], host.stdout)
  if (dumpHost === 'vsock/1') assert.match(reported[1], /^proxycommand \/usr\/lib\/systemd\/systemd-ssh-proxy %h %p$/m)
}

const skip = liveSkip()
for (const mode of ['workspace-write', 'read-only']) {
  for (const persistent of [false, true]) {
    test(`${persistent ? 'H2 persistent' : 'H1 one-shot'} Bash respects SSH configuration and write policy in ${mode}`, { skip }, async t => {
      const f = await harness(t, mode, persistent)
      assertEffectiveConfig(await f.invoke(args))
      const denial = await f.invoke({
        description: 'Check that the system SSH configuration is read-only',
        command: `touch ${SYSTEM_CONFIG}/${f.dir.split('/').at(-1)}`,
      })
      const text = textOf(denial)
      assert.match(text, /Read-only file system/i)
      // The one-shot tool adds DSH's classification. The persistent tool reports the shell error and status.
      if (persistent) assert.match(text, /Command finished with exit code [1-9]/)
      else assert.ok(text.includes(sandboxDenialMarker(mode)), text)
    })
  }
}

test('H3 a scripted native AgentLoop turn runs SSH through the registered Bash tool', { skip }, async t => {
  const { root, agent } = await harness(t, 'workspace-write')
  const results = []
  root.on('tools/result', (exec, result) => { if (exec.agent === agent) results.push(result) })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the fixture SSH settings.' }] }))
  await agent.whenIdle()
  assert.equal(results.length, 1)
  assertEffectiveConfig(results[0])
})

test('H4 the ACP mcp__dsh__bash backchannel dispatches to the real Bash service', { skip }, async t => {
  const { Backchannel } = await import('../../acp-dsh/src/host/backchannel.js')
  const { BRIDGE_NAME, mcpName } = await import('../../acp-dsh/src/host/names.js')
  const { root, agent } = await harness(t, 'workspace-write', true)
  root.provide('approval', {
    effectivePolicy: () => 'ask',
    request: async () => 'allowed-once',
  })
  const backchannel = new Backchannel({ ctx: root })
  t.after(() => backchannel.dispose())
  const record = backchannel.mint({ sessionId: agent.session.id, agent, name: 'Offline ACP fixture' })
  backchannel.announce(record)
  const listed = root.tools.definitions(agent).find(tool => mcpName(BRIDGE_NAME, tool.name) === 'mcp__dsh__bash')
  assert.ok(listed)
  // Supply the bridge's JSON request in memory, as its MCP child does after stripping the server prefix.
  const request = Readable.from([Buffer.from(JSON.stringify({ op: 'call', name: listed.name, arguments: args, callId: 'ssh-bridge-fixture' }))])
  Object.assign(request, { method: 'POST', url: record.path, headers: { authorization: `Bearer ${record.credential}` } })
  const chunks = []
  const response = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
  response.writeHead = status => { response.statusCode = status }
  await backchannel.handle(request, response)
  assert.equal(response.statusCode, 200)
  assertEffectiveConfig(JSON.parse(Buffer.concat(chunks).toString('utf8')))
})
