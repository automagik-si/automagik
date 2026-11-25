import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AcpAdapter } from '../../acp-dsh/src/host/adapter.js'
import { Backchannel } from '../../acp-dsh/src/host/backchannel.js'
import { rowsOf } from '../src/host/pocket-chat.js'
import { install, skillTool } from '../src/host/skill-library-call.js'

const fake = new URL('../../acp-dsh/dev/fake-agent.mjs', import.meta.url).pathname
const doc = (name, mode) => ({ name, mode, description: 'Description for ' + name, content: 'Checked contents of ' + name, hash: name })
const inactive = doc('amber-fixture', 'automatic')
const automatic = doc('cobalt-fixture', 'automatic')
const manual = doc('mint-fixture', 'manual')
const uncalled = doc('ochre-fixture', 'manual')
const revoke = doc('indigo-fixture', 'automatic')
const unknown = 'unknown-fixture'
const user = (text, ...parts) => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text }, ...parts],
})
const refusal = 'No skill with that name is available to this Bot.'
const result = (text, isError) => ({ content: [{ type: 'text', text }], isError })

async function fixture(t, provider) {
  const claude = provider === 'acp-claude'
  const root = new Context()
  const dir = mkdtempSync(join(tmpdir(), 'inactive-acp-'))
  const trace = join(dir, 'trace.ndjson')
  const fileName = 'ordinary-attachment.txt'
  const filePath = join(dir, fileName)
  const bytes = Buffer.from('Fixture file')
  const attachment = {
    attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'text/plain', name: fileName, bytes: bytes.length,
  }
  writeFileSync(filePath, bytes, { mode: 0o400 })
  const active = [automatic, manual, uncalled]
  const approvals = []
  const executions = []
  const requests = []
  const turns = [
    { text: 'Probe unavailable loads', loads: [inactive.name, unknown, uncalled.name], retryEmpty: true,
      native: claude ? [inactive.name, unknown, uncalled.name, 'separate-native-skill'] : [] },
    { text: 'Probe duplicate load', loads: [inactive.name, inactive.name] },
    { text: 'Probe checked load', loads: [automatic.name] },
    { text: 'Probe reassignment', loads: [revoke.name], retryEmpty: true },
  ]
  t.after(async () => {
    try { adapter.dispose(); bridge.dispose(); await root.fiber.dispose() }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.provide('attachments', { fileHostPath: ref => ref.attachmentId === attachment.attachmentId ? filePath : undefined })
  root.provide('approval', {
    effectivePolicy: () => 'ask',
    async request(request) { approvals.push(request); return 'allowed-once' },
  })
  const rt = {
    ctx: root, load: async () => {}, selfOf: id => id, botOf: id => id === 'bot-a' ? { id } : undefined,
    skillLibrary: { active: id => id === 'bot-a' ? active : [] },
  }
  install(rt)
  root.provide('omniTeam', rt)
  root.tools.register(skillTool(rt))
  root.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'load_skill') return next()
    executions.push(exec.arguments.name)
    const value = await next()
    if (exec.arguments.name === revoke.name) active.splice(active.indexOf(revoke), 1)
    return value
  })
  const bridge = new Backchannel({ ctx: root })
  const adapter = new AcpAdapter(root, new Map([[provider, {
    name: 'Fixture ACP', bridge: claude, disableBuiltInTools: false,
    catalog: { models: async () => [{ id: 'default', name: 'Fixture ACP' }], dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [fake],
      env: { PATH: process.env.PATH, HOME: dir, FAKE_ACP_TRACE: trace,
        FAKE_ACP_SKILLS_PROBE: JSON.stringify({ claude, turns }) } }),
  }]]), { backchannel: bridge, dshTools: () => undefined })
  const stream = adapter.stream.bind(adapter)
  adapter.stream = options => { requests.push(options); return stream(options) }
  root.llm.registerAdapter([provider], adapter)
  const harness = await mountAgentLoopTestHarness(root)
  const agent = await harness.create('bot-a', { provider, model: 'default' }, { cwd: dir })
  const events = kind => (existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
    .filter(event => kind === undefined || event.event === kind)
  const turn = async (...inputs) => {
    const from = agent.session.seq
    for (const input of inputs.slice(0, -1)) agent.inject(input)
    agent.followup(inputs.at(-1))
    await agent.whenIdle()
    return agent.session.snapshotEvents().slice(from)
  }
  const visibleNotices = records => records.flatMap(event => rowsOf(event, { sessionId: agent.id, calls: new Map() }))
    .filter(row => row.state === 'notice')
  return { active, agent, adapter, approvals, executions, requests, events, turn, visibleNotices, attachment, filePath }
}

function privateFree(prompts) {
  assert.ok(prompts.length > 0)
  for (const { prompt } of prompts) {
    assert.ok(Array.isArray(prompt), 'the trace contains the exact ACP prompt blocks')
    const wire = JSON.stringify(prompt)
    for (const text of [inactive.name, inactive.description, inactive.content, unknown,
      uncalled.name, uncalled.description, uncalled.content, 'is not active on this Bot', 'under Skills', refusal]) {
      assert.ok(!wire.includes(text), 'private text reached ACP: ' + text + '\n' + wire)
    }
  }
}

for (const provider of ['acp-claude', 'acp-codex']) {
  for (const gesture of ['/', 'use the skill ']) {
    test(`${provider}: pure ${gesture.trim()} inactive call ends visibly on the host`, { timeout: 15_000 }, async t => {
      const f = await fixture(t, provider)
      const records = await f.turn(user(gesture + inactive.name))
      const notices = f.visibleNotices(records)
      assert.equal(notices.length, 1)
      assert.match(notices[0].msg, /amber-fixture is not active on this Bot.*Details, under Skills/)
      assert.deepEqual(f.events('prompt').map(event => event.text), [], 'zero outgoing ACP requests')
      assert.deepEqual(f.requests, [], 'zero model dispatches')
      assert.deepEqual(f.executions, [])
      assert.deepEqual(f.approvals, [])
      assert.equal(records.some(event => event.type === 'tool/call'), false)
      assert.deepEqual(records.at(-1).data.reason, { kind: 'completed' })
    })
  }

  test(`${provider}: mixed input preserves ordinary work, attachment, other inputs and active manual use`, { timeout: 20_000 }, async t => {
    const f = await fixture(t, provider)
    const file = { type: 'file', attachment: f.attachment }
    const records = await f.turn(
      user(`Prepare the summary / please /${inactive.name} /${manual.name}`, file),
      user('Keep the queued instructions.'),
      user('use the skill ' + inactive.name),
    )
    const prompts = f.events('prompt')
    privateFree(prompts)
    const wire = prompts.map(event => event.text).join('\n')
    assert.equal([...wire.matchAll(/Prepare the summary \/ please \/mint-fixture/g)].length, 1)
    assert.match(wire, /ordinary-attachment\.txt/)
    assert.ok(wire.includes(f.filePath), 'the durable file still has a readable provider handle')
    assert.equal([...wire.matchAll(/Keep the queued instructions\./g)].length, 1)
    assert.match(wire, /Checked contents of mint-fixture/)
    assert.match(wire, /cobalt-fixture: Description for cobalt-fixture/)
    assert.doesNotMatch(wire, /Description for mint-fixture|Checked contents of cobalt-fixture/)
    assert.ok(records.some(event => event.type === 'user/message'
      && event.data.content.some(part => part.attachment?.attachmentId === file.attachment.attachmentId)))
    assert.equal(f.visibleNotices(records).length, 2, 'each inactive input gets its own human remedy')
    f.adapter.endSession(f.agent.id)
    await f.turn(user('Continue ordinary work.'))
    const replay = f.events('prompt').at(-1)
    privateFree([replay])
    assert.match(replay.text, /Prepare the summary/)
    assert.match(replay.text, /Continue ordinary work/)
    assert.match(replay.text, /Checked contents of mint-fixture/)
  })

  test(`${provider}: unavailable loads are terminal before approval and on delivery`, { timeout: 25_000 }, async t => {
    const f = await fixture(t, provider)
    await f.turn(user('Probe unavailable loads'))
    await t.test('all unavailable names yield the same error and stop retrying', () => {
      const loads = f.events('skills-load')
      assert.deepEqual(loads.map(({ answer }) => answer), Array(3).fill(result(refusal, true)))
      assert.deepEqual(loads.map(({ retry }) => retry), [false, false, false])
    })
    await t.test('unavailable loads and matching native Skill attempts raise zero approvals', () => {
      assert.deepEqual(f.executions, [], 'unavailable calls never enter the tool executor')
      if (provider === 'acp-claude') {
        assert.deepEqual(f.events('native-skill-permission').map(({ outcome }) => outcome.optionId), ['no', 'no', 'no', 'yes'])
        assert.deepEqual(f.approvals.map(request => request.mirrorCall?.input?.skill), ['separate-native-skill'])
      } else assert.deepEqual(f.approvals, [])
    })
    await t.test('even an explicit repeated call never executes or asks again', async () => {
      const before = f.events('skills-load').length
      const approvals = f.approvals.length
      await f.turn(user('Probe duplicate load'))
      assert.deepEqual(f.events('skills-load').slice(before).map(({ answer }) => answer), Array(2).fill(result(refusal, true)))
      assert.equal(f.approvals.length, approvals)
      assert.deepEqual(f.executions, [])
    })
    await t.test('active Automatic content is delivered once with its normal approval', async () => {
      const approvals = f.approvals.length
      await f.turn(user('Probe checked load'))
      assert.deepEqual(f.events('skills-load').at(-1)?.answer, result(automatic.content, false))
      assert.deepEqual(f.executions.slice(-1), [automatic.name])
      assert.deepEqual(f.approvals.slice(approvals).map(request => request.toolName), ['load_skill'])
    })
    await t.test('revocation during execution returns the same terminal refusal', async () => {
      f.active.push(revoke)
      const before = f.events('skills-load').length
      const approvals = f.approvals.length
      await f.turn(user('Probe reassignment'))
      assert.deepEqual(f.events('skills-load').slice(before).map(({ answer }) => answer), [result(refusal, true)])
      assert.deepEqual(f.executions.slice(-1), [revoke.name])
      assert.deepEqual(f.approvals.slice(approvals).map(request => request.toolName), ['load_skill'])
    })
    await t.test('outgoing prompts keep private data out even on replay', async () => {
      f.adapter.endSession(f.agent.id)
      await f.turn(user('Continue after the probes.'))
      privateFree(f.events('prompt'))
    })
  })
}
