import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { apply } from '../index.js'

const botId = 'b-aaaaaaaaaa'
const sessionId = 'skills-solver-auto'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const instruction = 'Work alone until delivered.'
const skill = { name: 'auto-words', description: 'A checked phrase to consider.', content: instruction }
const denied = 'Work alone /unassigned-skill until delivered.'
const texts = row => row?.content?.filter(part => part.type === 'text').map(part => part.text) ?? []

test('Skills projection cannot supply Solver Auto authorization', { timeout: 15_000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network fetch in Solver Skills fixture') })
  const cases = [
    { name: 'denied gesture', prompt: denied, personText: [instruction], direct: true, auto: false },
    { name: 'checked person call', prompt: `/${skill.name}`, personText: [`/${skill.name}`, skill.content], checked: true, auto: false },
    { name: 'checked tool load', prompt: 'Choose a workflow.', personText: ['Choose a workflow.'], checked: true, load: true, auto: false },
    { name: 'genuine person instruction', prompt: instruction, personText: [instruction], direct: true, auto: true },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async sub => {
      const home = mkdtempSync(join(tmpdir(), 'skills-solver-auto-'))
      const root = new Context()
      sub.after(async () => {
        try { await root.fiber.dispose() }
        finally { rmSync(home, { recursive: true, force: true }) }
      })
      const model = `${route.provider}/${route.model}`
      // Set the stored route that uses direct, host-owned Auto, while sending all
      // requests to the in-process fixture adapter to observe the projected bytes.
      writeFileSync(join(home, 'state.json'), JSON.stringify({
        version: 1, revision: 1, mainBotIds: [botId],
        bots: { [botId]: { id: botId, sessionId, name: 'Fixture Solver', createdAt: 1, role: 'Solver',
          model, appliedModel: scenario.direct ? 'acp-omp/fixture-model' : model } },
        rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: {},
      }))

      const requests = []
      let quoteResult
      let rt
      const progress = () => rt.botOf(botId).reviewTrack?.solver
      const loadId = 'fixture-skill-load'
      class FakeModel extends LlmAdapter {
        async resolveModel(provider, id) {
          return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
        }
        async *stream({ messages }) {
          requests.push(structuredClone(messages))
          if (scenario.load && requests.length === 1) {
            yield { type: 'tool-call-delta', index: 0, id: loadId, name: 'load_skill',
              argumentsDelta: JSON.stringify({ name: skill.name }) }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          if (scenario.checked) {
            const tool = rt.teamTools.find(entry => entry.name === 'solver_progress')
            quoteResult = await tool.execute({ action: 'auto', request: progress().request, quote: instruction },
              { agent: root.agents.get(sessionId) })
          }
          yield { type: 'text-delta', index: 0, text: 'Fixture response.' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }

      await mountAgentLoopTestDependencies(root, { workingDirectory: true })
      root.llm.registerAdapter([route.provider], new FakeModel())
      const harness = await mountAgentLoopTestHarness(root)
      const routes = new Map()
      root.provide('connection', { fetch: { register: route => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      } } })
      root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'fixture-workspace', path }) })
      root.provide('sessionTitle', { rename: async () => {} })
      root.provide('sessionController', {
        resolveAgent: async id => ({ agent: root.agents.get(id) }),
        async prompt({ sessionId, requestId, mode, content }) {
          assert.equal(mode, 'queue')
          root.agents.get(sessionId).followup(createUserMessage({ content, source: { kind: 'user', requestId } }))
        },
        async page({ address, throughSeq, beforeSeq, maxMessages }) {
          const events = root.agents.get(address.sessionId)?.session.snapshotEvents() ?? []
          const visible = events.filter(event => (throughSeq === undefined || event.seq <= throughSeq)
            && (beforeSeq === undefined || event.seq < beforeSeq))
          return { records: visible.slice(-maxMessages).map(event => ({ event })), hasMore: visible.length > maxMessages }
        },
      })
      apply(root, { home, github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
      rt = root.get('omniTeam')

      const owner = async (endpoint, payload) => {
        const response = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui', {
          method: 'POST', body: JSON.stringify({ endpoint, payload }),
        }))
        const result = await response.json()
        assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result)}`)
        return result.value
      }
      if (scenario.checked) {
        assert.deepEqual(await owner('skill-library-save', skill), { saved: true })
        assert.equal((await owner('skill-library-get', { name: skill.name })).check.verdict, 'pass')
        assert.deepEqual(await owner('bot-skill-add', { id: botId, name: skill.name, mode: 'automatic' }), { saved: true })
      }
      const agent = await harness.create(sessionId, route, { cwd: home })
      assert.equal(await owner('send', { sessionId: botId, text: scenario.prompt }), true)
      await agent.whenIdle()
      await setImmediate()
      const events = agent.session.snapshotEvents()
      assert.deepEqual(events.findLast(event => event.type === 'turn/end')?.data.reason, { kind: 'completed' })
      assert.equal(requests.length, scenario.load ? 2 : 1)
      for (const messages of requests) {
        assert.deepEqual(texts(messages.findLast(row => row.source?.kind === 'user')), scenario.personText)
        assert.doesNotMatch(JSON.stringify(messages), /unassigned-skill|automagikSkillOriginalText|is not active on this Bot/)
      }
      if (scenario.prompt === denied) {
        const person = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
        assert.equal(person.data.source.automagikSkillOriginalText[0], denied)
        assert.deepEqual(texts(person.data), [instruction])
      }
      if (scenario.checked) assert.match(quoteResult, /Auto needs the person's own words asking for it/)
      if (scenario.load) assert.deepEqual(texts(requests.at(-1).find(row => row.toolCallId === loadId)), [skill.content])
      assert.equal(progress().auto === true, scenario.auto, 'Only the genuine person instruction grants Solver Auto')
    })
  }
})
