// The real adapters against this plugin's ACP client (#958): the handshake, the session start and
// the bridge, with the adapters npm serves today. Opt-in: CI's pull-request job installs
// neither adapter, so every test here is skipped unless its two paths are named:
//   AUTOMAGIK_TEST_CLAUDE_ACP  claude-agent-acp's dist/index.js
//   AUTOMAGIK_TEST_CLAUDE      a Claude Code executable
//   AUTOMAGIK_TEST_CODEX_ACP   codex-acp's dist/index.js
//   AUTOMAGIK_TEST_CODEX       a Codex executable (the native one, or its launcher)
// Each CLI runs in a throwaway HOME made here: it is never signed in, no model request is sent,
// and nothing of the person's own Claude Code or Codex home is read or written. A signed-out
// CLI may stop at `session/new` with ACP's auth_required: that is a pass for the handshake, and
// the checks that need a session say they did not run.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk/unstable'
import { AgentRun } from '../src/host/acp.js'
import { BRIDGE_PATH } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Backchannel } from '../src/host/backchannel.js'
import { BRIDGE_NAME, CREDENTIAL_ENV, URL_ENV, isAuthRequired } from '../src/host/names.js'
import { writeReceipt } from '../scripts/acp-receipts.mjs'

// The receipt of what this process launched (acp-receipts.mjs): the adapter's own package
// version, the CLI's own --version, never npm's latest. Written only when ACP_RECEIPT_DIR is set.
const SDK_VERSION = JSON.parse(readFileSync(new URL('../node_modules/@agentclientprotocol/sdk/package.json', import.meta.url), 'utf8')).version
function launched(real, spec, env) {
  let adapter
  for (let dir = dirname(real.adapter); dir !== dirname(dir); dir = dirname(dir)) {
    try { adapter = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); if (adapter.name === spec.adapter) break } catch {}
  }
  let cli = 'unknown'
  try { cli = execFileSync(real.cli, ['--version'], { env: { ...process.env, ...env }, timeout: 20_000, encoding: 'utf8' }).trim().split('\n')[0].slice(0, 80) } catch {}
  return { route: real.id, scenario: 'real-unprompted', sdk: SDK_VERSION, adapter: { name: spec.adapter, version: adapter?.name === spec.adapter ? adapter.version : 'unknown' }, cli: { version: cli }, platform: `${process.platform}-${process.arch}`, node: process.version }
}
const advertisedOf = init => ({
  protocolVersion: init?.protocolVersion ?? null,
  agentInfo: init?.agentInfo?.version === undefined ? null : `${init.agentInfo.name ?? ''} ${init.agentInfo.version}`.trim(),
  loadSession: init?.agentCapabilities?.loadSession === true,
  sessionCapabilities: Object.keys(init?.agentCapabilities?.sessionCapabilities ?? {}).filter(key => init.agentCapabilities.sessionCapabilities[key] != null).sort(),
  promptCapabilities: Object.keys(init?.agentCapabilities?.promptCapabilities ?? {}).filter(key => init.agentCapabilities.promptCapabilities[key] === true).sort(),
  authMethods: (init?.authMethods ?? []).map(method => method?.id).filter(Boolean).sort(),
})

const REAL = [
  { id: 'acp-claude', adapter: process.env.AUTOMAGIK_TEST_CLAUDE_ACP, cli: process.env.AUTOMAGIK_TEST_CLAUDE, names: 'AUTOMAGIK_TEST_CLAUDE_ACP and AUTOMAGIK_TEST_CLAUDE' },
  { id: 'acp-codex', adapter: process.env.AUTOMAGIK_TEST_CODEX_ACP, cli: process.env.AUTOMAGIK_TEST_CODEX, names: 'AUTOMAGIK_TEST_CODEX_ACP and AUTOMAGIK_TEST_CODEX' },
]
const TOOLS = [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
const LEVELS = [{ full: true }, { auto: true }, { sandbox: 'read-only' }, {}]

// A throwaway home: no key or config of the person's own reaches the CLI.
function home(t, spec, cli) {
  const root = mkdtempSync(join(tmpdir(), 'acp-real-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['home', 'config', 'cwd']) mkdirSync(join(root, dir))
  const env = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    CODEX_HOME: join(root, 'config'),
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    OPENAI_API_KEY: '',
    CODEX_API_KEY: '',
    CODEX_ACCESS_TOKEN: '',
    DISABLE_UPDATES: '1',
    ...spec.env(cli),
  }
  return { root, env, cwd: join(root, 'cwd') }
}

// The bridge's side, as adapter.js sets it up: a credential, the loopback server, one tool.
async function bridge(t) {
  const session = { id: 'real-adapter-probe', snapshotEvents: () => [] }
  const agent = { session }
  const ctx = { get: name => (name === 'tools' ? { definitions: () => TOOLS, executable: toolName => TOOLS.find(tool => tool.name === toolName) } : name === 'agentPresets' ? { presetForSession: () => 'standard' } : undefined) }
  const backchannel = new Backchannel({ ctx })
  t.after(() => backchannel.dispose())
  await backchannel.listen()
  const record = backchannel.mint({ sessionId: session.id, agent, name: 'Probe' })
  const server = {
    name: BRIDGE_NAME,
    command: process.execPath,
    args: [BRIDGE_PATH],
    env: [{ name: CREDENTIAL_ENV, value: record.credential }, { name: URL_ENV, value: backchannel.urlFor(record) }],
  }
  return { backchannel, record, server }
}

for (const real of REAL) {
  const spec = AGENTS[real.id]
  const skip = real.adapter && real.cli ? false : `set ${real.names} to run against a real ${spec.defaultName}`

  test(`real ${spec.defaultName}: the adapter answers initialize on this client's protocol version`, { skip }, async (t) => {
    const { env, cwd } = home(t, spec, real.cli)
    const run = new AgentRun({ command: process.execPath, args: [real.adapter], env, cwd, name: spec.name, mcpServers: [] })
    t.after(() => run.dispose())
    let failure
    await run.start().catch((error) => { failure = error })
    const receipt = { ...launched(real, spec, env), advertised: advertisedOf(run.init) }
    const initialized = run.init?.protocolVersion === PROTOCOL_VERSION
    writeReceipt(process.env.ACP_RECEIPT_DIR, { ...receipt, phases: { initialize: initialized ? 'passed' : 'failed' } })
    assert.equal(run.init?.protocolVersion, PROTOCOL_VERSION, `initialize answered version ${run.init?.protocolVersion}: ${failure?.message ?? ''}`)
    t.diagnostic(`${real.id}: ${receipt.adapter.name} ${receipt.adapter.version}, CLI ${receipt.cli.version}; advertises load ${receipt.advertised.loadSession}, session ${receipt.advertised.sessionCapabilities.join(',') || 'none'}`)
    // Signed out, `session/new` may stop at the sign-in; anything else is a real failure.
    if (failure !== undefined) {
      writeReceipt(process.env.ACP_RECEIPT_DIR, { ...receipt, phases: { session: isAuthRequired(failure) ? 'auth-required' : 'failed' } })
      assert.equal(isAuthRequired(failure), true, `session/new failed with something other than auth_required: ${failure.message}`)
      t.diagnostic(`${real.id}: signed out, session/new answered auth_required; the session checks did not run`)
      return
    }
    // A session opened in a throwaway home with no sign-in. Nothing is prompted, so no account is
    // used; the receipt claims the session start and nothing a prompt would prove.
    writeReceipt(process.env.ACP_RECEIPT_DIR, { ...receipt, phases: { session: 'passed' } })
    t.diagnostic(`${real.id}: session/new opened a session signed out`)
    assert.equal(typeof run.sessionId, 'string')
    // The conventions catalog.js and agents.js read: a model select, an effort select when the
    // adapter offers one, and the strict mode each level falls back to.
    assert.notEqual(run.option('model'), undefined, 'a `model` select option is offered')
    t.diagnostic(`${real.id}: thought_level ${run.option('thought_level') === undefined ? 'not offered' : 'offered'}; modes ${(run.modes?.availableModes ?? []).map(mode => mode.id).join(', ')}`)
    const offered = new Set((run.modes?.availableModes ?? []).map(mode => mode.id))
    for (const level of LEVELS) {
      const strict = spec.modeFor(level).at(-1)
      assert.equal(offered.has(strict), true, `the strict mode ${strict} is offered`)
    }
  })

  test(`real ${spec.defaultName}: the bridge is spawned and lists its tools, and a fork and a close answer where the agent needs them`, { skip }, async (t) => {
    const { env, cwd } = home(t, spec, real.cli)
    const { backchannel, record, server } = await bridge(t)
    const run = new AgentRun({
      command: process.execPath,
      args: [real.adapter],
      env,
      cwd,
      name: spec.name,
      mcpServers: [server],
      ...(spec.disableBuiltInTools === true ? { sessionMeta: { disableBuiltInTools: true } } : {}),
      dshTools: true,
      onReady: () => backchannel.announce(record),
    })
    t.after(() => run.dispose())
    let failure
    await run.start().catch((error) => { failure = error })
    if (failure !== undefined) {
      assert.equal(isAuthRequired(failure), true, `session/new failed with something other than auth_required: ${failure.message}`)
      t.diagnostic(`${real.id}: signed out, no session: the bridge and fork checks did not run`)
      return
    }
    const deadline = Date.now() + 15_000
    while (!record.listed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(record.listed, true, 'the bridge asked DSH for its tool list (acp_bridge_missing would fire otherwise)')
    if (spec.refresh !== 'fork') return
    const source = run.sessionId
    const forked = await run.fork({ cwd, mcpServers: [] })
    assert.notEqual(forked, source, 'session/fork answered a new session, and session/close took the source')
  })

  // The release decision of native cold continuity (continuity.js): an advertised resume is not
  // enough; the session must come back on a new process and bind a fresh bridge. No prompt is
  // sent, so a session that never held a turn may be refused: that is recorded, not failed.
  test(`real ${spec.defaultName}: a closed session comes back by resume on a new process with a fresh bridge, or says why not`, { skip }, async (t) => {
    const { env, cwd } = home(t, spec, real.cli)
    const meta = spec.disableBuiltInTools === true ? { sessionMeta: { disableBuiltInTools: true } } : {}
    const first = await bridge(t)
    const opened = new AgentRun({ command: process.execPath, args: [real.adapter], env, cwd, name: spec.name, mcpServers: [first.server], ...meta, dshTools: true, onReady: () => first.backchannel.announce(first.record) })
    t.after(() => opened.dispose())
    let failure
    await opened.start().catch((error) => { failure = error })
    const receipt = launched(real, spec, env)
    if (failure !== undefined) {
      writeReceipt(process.env.ACP_RECEIPT_DIR, { ...receipt, phases: { reattach: 'unverified' } })
      assert.equal(isAuthRequired(failure), true, failure.message)
      t.diagnostic(`${real.id}: signed out, no session to take back: reattach unverified`)
      return
    }
    const nativeSessionId = opened.sessionId
    opened.dispose()
    first.backchannel.revoke(first.record)
    const second = await bridge(t)
    const back = new AgentRun({ command: process.execPath, args: [real.adapter], env, cwd, name: spec.name, mcpServers: [second.server], ...meta, dshTools: true,
      continuity: { sessionId: nativeSessionId, methods: ['resume'] }, onReady: () => second.backchannel.announce(second.record) })
    t.after(() => back.dispose())
    await back.start().catch((error) => { failure = error })
    const deadline = Date.now() + 15_000
    while (failure === undefined && !second.record.listed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    const outcome = back.continuity?.outcome
    const reattach = outcome === 'resumed' && second.record.listed === true ? 'passed' : outcome === 'fresh' && back.continuity.reason === 'refused' ? 'refused' : 'failed'
    writeReceipt(process.env.ACP_RECEIPT_DIR, { ...receipt, phases: { reattach }, advertised: { reattachDetail: `${outcome ?? 'none'}${back.continuity?.code === undefined ? '' : ` ${back.continuity.code}`}; fresh bridge listed ${second.record.listed === true}` } })
    t.diagnostic(`${real.id}: reattach ${reattach} (${outcome ?? failure?.message ?? 'no outcome'}${back.continuity?.code === undefined ? '' : `, code ${back.continuity.code}`}); fresh bridge listed ${second.record.listed === true}`)
    assert.notEqual(reattach, 'failed', `resume neither came back with the fresh bridge nor was refused: ${failure?.message ?? outcome}`)
  })
}
