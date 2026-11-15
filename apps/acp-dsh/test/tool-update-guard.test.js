import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentRun } from '../src/host/acp.js'
import { CANCELLED, OPTIONS, probe, soon } from './support/state-probe.js'

test('bad ids never enter the map or queue, including with review accounting active', async t => {
  const noted = []
  const asked = []
  const p = probe(t, { dshTools: true, onToolCall: tool => noted.push(tool), onAsked: tool => asked.push(tool) })
  const end = p.begin()
  for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
    for (const toolCallId of [undefined, 42, '']) {
      await p.run.onUpdate({ sessionUpdate, toolCallId, rawOutput: { review: { status: 'denied' } } })
      assert.equal(p.run.seeTool({ toolCallId }), undefined)
      assert.deepEqual(await soon(p.run.onPermission({ toolCall: { toolCallId, name: 'mcp__dsh__bash' }, options: OPTIONS })), CANCELLED)
    }
  }
  assert.deepEqual(await soon(p.run.onPermission({ options: OPTIONS })), CANCELLED)
  assert.equal(p.run.tools.size, 0)
  assert.equal(p.run.turn.size, 0)
  assert.deepEqual(p.run.queue, [])
  assert.deepEqual(noted.map(tool => tool.structuredName), Array(6).fill('mcp__dsh__bash'))
  assert.deepEqual(asked, [])
  assert.equal(p.run.reviews.denied, 0)
  await p.see('guardian_assessment:valid')
  await p.run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'guardian_assessment:valid', rawOutput: { review: { status: 'denied' } } })
  assert.equal(p.run.reviews.denied, 1)
  assert.deepEqual(p.run.queue, [{ type: 'tool', id: 'guardian_assessment:valid' }])
  await end()
})

test('foreign sessions cannot change tools, reviews, text, configuration or questions', async t => {
  const asked = []
  const p = probe(t, { onAsked: tool => asked.push(tool) })
  const end = p.begin()
  await p.see('same')
  const tool = p.run.tools.get('same')
  const original = structuredClone(tool)
  p.run.queue = []
  p.run.modes = { currentModeId: 'safe' }
  p.run.options = []
  for (const sessionUpdate of ['tool_call', 'tool_call_update', 'agent_message_chunk', 'agent_thought_chunk', 'current_mode_update', 'config_option_update']) {
    await p.run.onUpdate({ sessionUpdate, toolCallId: 'same', title: 'Changed', rawInput: { private: true }, content: { type: 'text', text: 'foreign' }, currentModeId: 'unsafe', configOptions: [{ id: 'foreign' }] }, 'source')
  }
  assert.deepEqual(await soon(p.ask('same', { sessionId: 'source' })), CANCELLED)
  assert.deepEqual(tool, original)
  assert.deepEqual(asked, [])
  assert.deepEqual(p.run.queue, [])
  assert.deepEqual(p.run.modes, { currentModeId: 'safe' })
  assert.deepEqual(p.run.options, [])
  await p.run.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'same', title: 'Accepted' }, 'current')
  assert.equal(tool.title, 'Accepted')
  await p.run.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'current' } }, 'current')
  assert.deepEqual(p.run.queue, [{ type: 'text', text: 'current' }])
  await end()
  await p.run.fork({ cwd: process.cwd(), mcpServers: [] })
  assert.equal(p.run.turn.size, 0)
  await p.run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'source-call' }, 'current')
  assert.equal(p.run.tools.size, 0)
  await p.run.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'fork-call' }, 'forked')
  assert.ok(p.run.tools.has('fork-call'))
})

test('rejected tool traffic still reaches drift checks without storing or queuing a call', async t => {
  const noted = []
  const p = probe(t, { onToolCall: tool => { noted.push(tool); throw new Error('observer gone') } })
  for (const sessionUpdate of ['tool_call', 'tool_call_update']) {
    for (const [toolCallId, sessionId] of [['', 'current'], [undefined, 'current'], [42, 'current'], ['foreign-call', 'foreign'], ['', 'foreign']]) {
      const payload = { sessionUpdate, toolCallId, _meta: { claudeCode: { toolName: 'Bash' } } }
      for (const send of [() => p.run.onUpdate(payload, sessionId), () => p.run.onPermission({ sessionId, toolCall: payload, options: OPTIONS })]) {
        const before = noted.length
        const answer = await soon(send())
        if (answer !== undefined) assert.deepEqual(answer, CANCELLED)
        assert.equal(noted.length, before + 1)
        assert.equal(noted.at(-1).structuredName, 'Bash')
        assert.equal(noted.at(-1).title, 'Tool')
        assert.equal(noted.at(-1).listeners.size, 0)
        assert.equal(p.run.tools.size, 0)
        assert.equal(p.run.turn.size, 0)
        assert.equal(p.run.retired.size, 0)
        assert.deepEqual(p.run.queue, [])
      }
    }
  }
  const before = noted.length
  await p.run.onUpdate({ sessionUpdate: 'agent_message_chunk', _meta: { claudeCode: { toolName: 'Bash' } } }, 'foreign')
  assert.equal(noted.length, before, 'non-tool updates are not drift probes')
  const end = p.begin()
  await p.see('retired', { _meta: { claudeCode: { toolName: 'Bash' } } })
  await end()
  const finish = p.begin()
  assert.equal(p.run.tools.get('retired').retired, true)
  for (const sessionId of ['current', 'foreign']) {
    const payload = { sessionUpdate: 'tool_call_update', toolCallId: 'retired', _meta: { claudeCode: { toolName: 'Bash' } } }
    await p.run.onUpdate(payload, sessionId)
    assert.deepEqual(await soon(p.run.onPermission({ sessionId, toolCall: payload, options: OPTIONS })), CANCELLED)
  }
  assert.equal(noted.length, before + 1, 'retired calls were already judged')
  await finish()
})

test('every rejection is reported but warns once per run, even across prompts, a fork and throwing callbacks', async t => {
  const warnings = []
  const rejected = []
  const spec = {
    onIgnored: message => { warnings.push(message); throw new Error('logger gone') },
    onRejected: what => { rejected.push(what); throw new Error('observer gone') },
  }
  const p = probe(t, spec)
  for (let i = 0; i < 3; i++) {
    const end = p.begin()
    await p.see('')
    await p.run.onUpdate({ sessionUpdate: 'agent_message_chunk' }, 'foreign')
    assert.deepEqual(await soon(p.ask(0)), CANCELLED)
    await end()
  }
  await p.run.fork({ cwd: process.cwd(), mcpServers: [] })
  await p.see(undefined)
  assert.deepEqual(rejected, [...Array(3).fill(['a tool update', 'an update', 'a permission request']).flat(), 'a tool update'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Probe agent.*no usable call id or for another session/)
  const other = probe(t, spec)
  await other.see('')
  assert.equal(warnings.length, 2)
  assert.equal(rejected.length, 11)
})

test('fork cancels a source question before clearing its records and indexes', async t => {
  const p = probe(t)
  const question = p.ask('source-question')
  await p.run.fork({ cwd: process.cwd(), mcpServers: [] })
  assert.deepEqual(await soon(question), CANCELLED)
  assert.equal(p.run.tools.size, 0)
  assert.equal(p.run.turn.size, 0)
  assert.equal(p.run.retired.size, 0)
})

test('the stdio notification handler forwards the session id to the run', async t => {
  const run = new AgentRun({ command: process.execPath, args: [join(import.meta.dirname, '../dev/fake-agent.mjs')], cwd: process.cwd(), name: 'Fake agent' })
  t.after(() => run.dispose())
  const seen = []
  const onUpdate = run.onUpdate.bind(run)
  run.onUpdate = (update, sessionId) => {
    seen.push(sessionId)
    return onUpdate(update, sessionId)
  }
  await run.start()
  await soon(run.prompt([{ type: 'text', text: 'plain' }]))
  assert.ok(seen.length > 0)
  assert.ok(seen.every(id => id === run.sessionId))
})
