// The real connectors and CLIs end to end on a synthetic model backend (dev/model-stub.mjs): the
// shipped connector (claude-agent-acp, codex-acp) runs the real CLI, which keeps its own session
// store in a throwaway home and talks only to a loopback stub with a dummy key, behind a dead
// proxy for anything else. No account, no paid call, no network: what this proves is the
// transport, the CLI's own history, the bridge and its credential, never a model's behaviour.
//
// Opt-in, as test/real-adapters.test.js: set AUTOMAGIK_TEST_CLAUDE_ACP and AUTOMAGIK_TEST_CLAUDE
// (or the CODEX pair). The scenario, for each:
//   1. a prompt tells the agent a marker; a second makes it call a DSH tool through the bridge:
//      one execution, its result back to the CLI;
//   2. the process ends and the bridge is revoked: its credential is refused from then on;
//   3. a new process takes the native session back by resume with a fresh bridge offering
//      another tool set (one removed, one added);
//   4. a prompt that names no marker gets it back: the CLI sent its own earlier turn to the
//      backend (the stub saw it), DSH sent none; the removed tool is not offered, the added one
//      runs once.
// Each step writes a receipt (scenario `synthetic-backend`, backend `loopback-stub`) when
// ACP_RECEIPT_DIR is set: scripts/acp-qualify.mjs reads them, and nothing here can stand for a
// signed-in run.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { BRIDGE_PATH } from '../src/host/adapter.js'
import { AGENTS } from '../src/host/agents.js'
import { Backchannel } from '../src/host/backchannel.js'
import { BRIDGE_NAME, CREDENTIAL_ENV, URL_ENV } from '../src/host/names.js'
import { writeReceipt } from '../scripts/acp-receipts.mjs'
import { startModelStub } from '../dev/model-stub.mjs'

const SDK_VERSION = JSON.parse(readFileSync(new URL('../node_modules/@agentclientprotocol/sdk/package.json', import.meta.url), 'utf8')).version
const REAL = [
  { id: 'acp-claude', adapter: process.env.AUTOMAGIK_TEST_CLAUDE_ACP, cli: process.env.AUTOMAGIK_TEST_CLAUDE, names: 'AUTOMAGIK_TEST_CLAUDE_ACP and AUTOMAGIK_TEST_CLAUDE' },
  { id: 'acp-codex', adapter: process.env.AUTOMAGIK_TEST_CODEX_ACP, cli: process.env.AUTOMAGIK_TEST_CODEX, names: 'AUTOMAGIK_TEST_CODEX_ACP and AUTOMAGIK_TEST_CODEX' },
]
const tool = name => ({ name, description: `The ${name} probe`, parameters: { type: 'object', properties: {} } })

/** What was launched, read from the launched files (never a registry's latest). */
export function launchedTuple(real, spec, env) {
  let adapter
  for (let dir = dirname(real.adapter); dir !== dirname(dir); dir = dirname(dir)) {
    try { adapter = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); if (adapter.name === spec.adapter) break } catch {}
  }
  let cli = 'unknown'
  try { cli = execFileSync(real.cli, ['--version'], { env: { ...process.env, ...env }, timeout: 20_000, encoding: 'utf8' }).trim().split('\n')[0].slice(0, 80) } catch {}
  return { route: real.id, sdk: SDK_VERSION, adapter: { name: spec.adapter, version: adapter?.name === spec.adapter ? adapter.version : 'unknown' }, cli: { version: cli }, platform: `${process.platform}-${process.arch}`, node: process.version }
}

/** A throwaway home whose CLI talks only to the stub: a dummy key, a dead proxy for the rest. */
export function stubHome(root, id, stubUrl, cli) {
  for (const dir of ['home', 'config', 'cwd']) mkdirSync(join(root, dir), { recursive: true })
  const dead = 'http://127.0.0.1:9'
  const env = {
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
    CLAUDE_CONFIG_DIR: join(root, 'config'), CODEX_HOME: join(root, 'config'),
    HTTPS_PROXY: dead, HTTP_PROXY: dead, ALL_PROXY: dead, https_proxy: dead, http_proxy: dead, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', CODEX_ACCESS_TOKEN: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_UPDATES: '1',
    ...AGENTS[id].env(cli),
  }
  if (id === 'acp-claude') Object.assign(env, { ANTHROPIC_BASE_URL: stubUrl, ANTHROPIC_API_KEY: 'sk-ant-stub-not-a-key', OPENAI_API_KEY: '' })
  else {
    Object.assign(env, { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', STUB_API_KEY: 'stub-not-a-key' })
    writeFileSync(join(root, 'config', 'config.toml'), [
      'model = "stub-model"', 'model_provider = "stub"', '',
      '[model_providers.stub]', 'name = "Loopback stub"', `base_url = "${stubUrl}/v1"`, 'env_key = "STUB_API_KEY"', 'wire_api = "responses"', '',
    ].join('\n'))
  }
  return { env, cwd: join(root, 'cwd') }
}

/** A bridge as adapter.js mints it: a credential, the loopback server, `names` as DSH's tools. */
export async function stubBridge(backchannel, names, counts) {
  const tools = names.map(tool)
  const session = { id: `stub-${randomBytes(4).toString('hex')}`, snapshotEvents: () => [] }
  backchannel.ctx = {
    get: name => (name === 'tools'
      ? {
          definitions: () => tools, executable: toolName => tools.find(entry => entry.name === toolName),
          execute: async ({ calls }) => {
            counts.executed.push(...calls.map(call => call.name))
            return { results: calls.map(call => ({ id: call.id, result: { content: [{ type: 'text', text: `ran ${call.name}` }] } })) }
          },
        }
      // DSH's approval, as the person answers it: allow once, counted.
      : name === 'approval' ? { effectivePolicy: () => 'ask', request: async () => { counts.dshApprovals += 1; return 'allowed-once' } }
        : name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) }
          : name === 'agentPresets' ? { presetForSession: () => 'standard' } : undefined),
    on: () => () => {},
  }
  const record = backchannel.mint({ sessionId: session.id, agent: { session }, name: 'Probe' })
  const server = { name: BRIDGE_NAME, command: process.execPath, args: [BRIDGE_PATH], env: [{ name: CREDENTIAL_ENV, value: record.credential }, { name: URL_ENV, value: backchannel.urlFor(record) }] }
  return { record, server }
}

/** One prompt to the end, every question answered allow-once (counted). */
export async function promptOnce(run, text, counts) {
  const said = []
  const done = run.prompt([{ type: 'text', text }])
  for (;;) {
    const event = await run.next()
    if (process.env.ACP_REAL_TRACE === '1') process.stderr.write(`  event ${event.type} ${JSON.stringify(event).slice(0, 160)}\n`)
    if (event.type === 'text') said.push(event.text)
    if (event.type === 'tool') {
      const watch = async () => {
        for (let i = 0; i < 400; i += 1) {
          const permission = run.tools.get(event.id)?.permission
          if (permission !== undefined) {
            counts.approvals += 1
            const allow = permission.options.find(option => option.kind === 'allow_once') ?? permission.options[0]
            permission.answer({ outcome: { outcome: 'selected', optionId: allow.optionId } })
            return
          }
          if (run.promptEnded) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      void watch()
    }
    if (event.type === 'end' || event.type === 'error') {
      await done.catch(() => {})
      return { said: said.join(''), end: event }
    }
  }
}

const refused = async (backchannel, record) => {
  const response = await fetch(backchannel.urlFor(record), { method: 'POST', headers: { authorization: `Bearer ${record.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'list' }) })
  return response.status === 401
}

for (const real of REAL) {
  const spec = AGENTS[real.id]
  const skip = real.adapter && real.cli ? false : `set ${real.names} to run the real ${spec.defaultName} on the loopback model stub`

  test(`real ${spec.defaultName} on a synthetic backend: native history and a fresh bridge survive a restart`, { skip, timeout: 240_000 }, async (t) => {
    const stub = await startModelStub()
    t.after(() => stub.close())
    const root = mkdtempSync(join(tmpdir(), 'acp-real-backend-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const { env, cwd } = stubHome(root, real.id, stub.url, real.cli)
    const tuple = launchedTuple(real, spec, env)
    const receipt = phases => writeReceipt(process.env.ACP_RECEIPT_DIR, { ...tuple, scenario: 'synthetic-backend', backend: 'loopback-stub', phases })
    const backchannel = new Backchannel({ ctx: { get: () => undefined } })
    t.after(() => backchannel.dispose())
    await backchannel.listen()
    const counts = { approvals: 0, dshApprovals: 0, executed: [] }
    const meta = spec.disableBuiltInTools === true ? { sessionMeta: { disableBuiltInTools: true } } : {}
    const open = (bridge, continuity) => new AgentRun({
      command: process.execPath, args: [real.adapter], env, cwd, name: spec.name, provider: real.id, mcpServers: [bridge.server], ...meta, dshTools: true,
      ...(continuity === undefined ? {} : { continuity }), onReady: () => backchannel.announce(bridge.record),
    })
    const step = what => { if (process.env.ACP_REAL_TRACE === '1') process.stderr.write(`[real-backend ${real.id}] ${what} (stub ${stub.requests.length})\n`) }
    const marker = `MK-${randomBytes(3).toString('hex').toUpperCase()}`

    // 1. The marker, then one DSH tool call through the bridge.
    const first = await stubBridge(backchannel, ['probe_alpha'], counts)
    const before = open(first)
    t.after(() => before.dispose())
    await before.start()
    // The level that asks (the strict mode the adapter maps a chat's default to): Auto's
    // server-side check cannot run on a loopback backend.
    await before.setMode(spec.modeFor({}))
    receipt({ initialize: 'passed', session: 'passed' })
    step('const told = await')
    const told = await promptOnce(before, `REMEMBER ${marker}`, counts)
    assert.equal(told.end.type, 'end', JSON.stringify(told.end))
    assert.match(told.said, /Noted/)
    step('const ran = await')
    const ran = await promptOnce(before, 'CALL probe_alpha', counts)
    if (!/Done/.test(ran.said)) t.diagnostic(JSON.stringify(stub.requests.slice(-3).map(request => ({ last: request.lastUser.slice(0, 300), tools: request.tools, texts: request.texts.slice(-3).map(text => text.slice(0, 200)) }))))
    assert.match(ran.said, /Done:[\s\S]*ran probe_alpha/, ran.said)
    assert.deepEqual(counts.executed, ['probe_alpha'], 'one call, one execution')
    assert.equal(counts.dshApprovals, 1, 'one DSH approval for one call')
    receipt({ prompt: 'passed', toolApproval: 'passed', usage: before.promptUsage?.completeness === 'complete' ? 'passed' : 'unverified' })
    const nativeSessionId = before.sessionId

    // 2. The restart: the process ends, the bridge's credential stops working.
    step('before.dispose()')
    before.dispose()
    backchannel.revoke(first.record)
    assert.equal(await refused(backchannel, first.record), true, 'the old bridge credential is refused')

    // 3. The same native session on a new process, with a fresh bridge and another tool set.
    const second = await stubBridge(backchannel, ['probe_beta'], counts)
    step('const after = open(')
    const after = open(second, { sessionId: nativeSessionId, methods: ['resume'] })
    t.after(() => after.dispose())
    await after.start()
    await after.setMode(spec.modeFor({}), { force: true })
    const deadline = Date.now() + 20_000
    while (!second.record.listed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    const reattached = after.continuity?.outcome === 'resumed' && second.record.listed === true
    receipt({ reattach: reattached ? 'passed' : 'failed' })
    assert.equal(after.continuity?.outcome, 'resumed', JSON.stringify(after.continuity))
    assert.equal(second.record.listed, true, 'the fresh bridge listed its tools')

    // 4. Remembered from the CLI's own history: DSH's prompt names no marker.
    const seen = stub.requests.length
    step('const recalled = await')
    const recalled = await promptOnce(after, 'RECALL', counts)
    step(`recalled: ${recalled.said}; requests ${JSON.stringify(stub.requests.slice(seen).map(request => [request.command, request.tools, request.texts.filter(text => text.includes(marker)).length]))}`)
    assert.match(recalled.said, new RegExp(marker), recalled.said)
    const sent = stub.requests.slice(seen).filter(request => request.command === 'RECALL')
    assert.ok(sent.length > 0, 'the recall reached the backend')
    assert.ok(sent.some(request => request.texts.some(text => text.includes(marker))), 'the CLI sent its own earlier turn')
    // The CLI's own tools stay off (the session switches are sent again on resume), and the
    // fresh bridge's tool is offered. The CLI may still list a removed bridge tool it knew from
    // its history: calling it must never run it.
    const offered = sent.at(-1).tools
    const builtIns = names => names.filter(name => !name.startsWith('mcp__') && name !== 'DeferredToolPlaceholder').sort()
    const firstOffered = stub.requests.find(request => request.command === 'CALL probe_alpha')?.tools ?? []
    assert.deepEqual(builtIns(offered), builtIns(firstOffered), 'the CLI\'s own tools are as they were before the restart')
    if (spec.disableBuiltInTools === true) assert.deepEqual(builtIns(offered), [], `no built-in tool is offered: ${offered.join(',')}`)
    assert.equal(offered.some(name => name.endsWith('probe_beta')), true, `the added tool is offered: ${offered.join(',')}`)
    // The removed tool, asked of the fresh bridge by its own credential, is not DSH's to run.
    const asked = await fetch(backchannel.urlFor(second.record), { method: 'POST', headers: { authorization: `Bearer ${second.record.credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'call', name: 'probe_alpha', arguments: {} }) })
    const answer = await asked.json().catch(() => ({}))
    assert.equal(counts.executed.includes('probe_alpha') && counts.executed.length === 1, true, JSON.stringify(answer))
    assert.match(JSON.stringify(answer), /not offered|refused/, JSON.stringify(answer))
    t.diagnostic(`${real.id}: after resume the CLI still lists ${offered.filter(name => name.endsWith('probe_alpha')).join(',') || 'no'} removed bridge tool from its own history`)
    step('const added = await')
    const added = await promptOnce(after, 'CALL probe_beta', counts)
    assert.match(added.said, /Done:[\s\S]*ran probe_beta/, added.said)
    assert.deepEqual(counts.executed, ['probe_alpha', 'probe_beta'], 'the added tool ran once')
    assert.equal(counts.dshApprovals, 2, 'with one approval')
    receipt({ continuity: 'passed' })
    // Nothing left loopback: every model request the CLI made reached the stub.
    assert.ok(stub.requests.every(request => request.path.startsWith('/v1/')), JSON.stringify(stub.requests.map(request => request.path)))
    t.diagnostic(`${real.id}: ${tuple.adapter.name} ${tuple.adapter.version}, CLI ${tuple.cli.version}; ${stub.requests.length} stub requests; agent questions ${counts.approvals}, DSH approvals ${counts.dshApprovals}`)
  })
}
