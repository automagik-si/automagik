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
const sessionId = 'skill-fixture-chat'
const route = { provider: 'fixture-native', model: 'fixture-model' }
const skill = { name: 'mint-notes', description: 'Write a concise mint note.', content: 'Write the note with marker MINT-BODY-42.' }
const inactive = { name: 'amber-notes', description: 'Write a concise amber note.', content: 'Write the note with marker AMBER-BODY-73.' }
const explicit = `/${skill.name}`
const automatic = 'Choose a workflow for the note.'
const afterRemove = `Try /${skill.name} again.`
const afterRemoveForModel = 'Try again.'
const catalogLine = `${skill.name}: ${skill.description}`
const notice = `The skill ${skill.name} is not active on this Bot. Add it in the Bot's Details, under Skills.`

const texts = row => row?.content?.filter(part => part.type === 'text').map(part => part.text) ?? []
const personRow = messages => messages.findLast(row => row.source?.kind === 'user')
const toolRow = (messages, id) => messages.find(row => row.role === 'tool' && row.toolCallId === id)
const catalogSections = messages => messages.filter(row => row.role === 'system').flatMap(texts)
  .filter(text => text.includes(skill.description) || text.includes(inactive.description)).map(text => text.trim())

// Compare message identities as well as content. History may carry a delivered body forward.
function bodyLocations(messages) {
  return messages.flatMap(row => texts(row).flatMap((text, index) =>
    text.includes(skill.content) ? [{ id: row.id, role: row.role, index, text }] : []))
}

test('Skills v2 owner and Bot flow from checked creation to removal', { timeout: 15_000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network fetch in Skills fixture') })
  const home = mkdtempSync(join(tmpdir(), 'skills-v2-e2e-'))
  const root = new Context()
  t.after(async () => {
    try { await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [botId],
    bots: { [botId]: { id: botId, sessionId, name: 'Fixture Bot', createdAt: 1, role: 'Helper',
      model: `${route.provider}/${route.model}`, appliedModel: `${route.provider}/${route.model}` } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: {},
  }))

  const requests = []
  class FakeModel extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }

    async *stream({ provider, model, sessionId, messages, tools }) {
      requests.push({ provider, model, sessionId, messages: structuredClone(messages), tools: tools.map(tool => tool.name) })
      const row = personRow(messages)
      const [prompt] = texts(row)
      let reply
      if (prompt === explicit) {
        reply = texts(row).includes(skill.content) ? 'Explicit skill applied.' : 'Explicit skill missing.'
      } else {
        const id = prompt === automatic ? 'automatic-load' : 'removed-load'
        const called = messages.some(row => row.role === 'assistant' && row.content.some(part => part.type === 'tool-call' && part.id === id))
        if (!called && (prompt === afterRemoveForModel || catalogSections(messages).includes(catalogLine))) {
          yield { type: 'tool-call-delta', index: 0, id, name: 'load_skill', argumentsDelta: JSON.stringify({ name: skill.name }) }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const loaded = texts(toolRow(messages, id)).includes(skill.content)
        reply = loaded ? 'Automatic skill applied.' : 'No active skill was loaded.'
      }
      yield { type: 'text-delta', index: 0, text: reply }
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
  // In-process DSH transport. Prompts enter and pages read the same production Agent Session.
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

  const owner = async (endpoint, payload) => {
    const response = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui', {
      method: 'POST', body: JSON.stringify({ endpoint, payload }),
    }))
    assert.equal(response.status, 200, endpoint)
    const result = await response.json()
    assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result)}`)
    return result.value
  }

  assert.deepEqual(await owner('skill-library-save', skill), { saved: true })
  const fileName = `${inactive.name}.md`
  const fileBytes = Buffer.from(`---\nname: ${inactive.name}\ndescription: ${inactive.description}\n---\n${inactive.content}\n`).toString('base64')
  assert.deepEqual(await owner('skill-library-save', { name: inactive.name, description: inactive.description,
    source: 'file', fileName, fileBytes }), { saved: true })
  for (const [form, source] of [[skill, { kind: 'text' }], [inactive, { kind: 'file', fileName }]]) {
    const saved = await owner('skill-library-get', { name: form.name })
    assert.deepEqual({ name: saved.name, description: saved.description, content: saved.content }, form)
    assert.deepEqual(saved.source, source)
    assert.equal(saved.check.verdict, 'pass')
    assert.deepEqual(saved.check.findings, [])
  }

  const assignment = { id: botId, name: skill.name }
  assert.deepEqual(await owner('bot-skill-add', assignment), { saved: true })
  assert.deepEqual((await owner('skill-library', {})).active[botId], [{ name: skill.name, mode: 'manual' }])

  const bot = await harness.create(sessionId, route, { cwd: home })
  const turn = async (prompt, reply, steps) => {
    const from = requests.length
    assert.equal(await owner('send', { sessionId: botId, text: prompt }), true)
    await bot.whenIdle()
    // Let the host's deferred idle observers finish before reading the chat or disposing the host.
    await setImmediate()
    assert.deepEqual(bot.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason,
      { kind: 'completed' }, 'Bot turn finished on the fixture model')
    const sent = requests.slice(from)
    assert.equal(sent.length, steps)
    for (const request of sent) {
      assert.equal(request.provider, route.provider)
      assert.equal(request.model, route.model)
      assert.equal(request.sessionId, sessionId)
      const payload = JSON.stringify(request.messages)
      for (const text of [inactive.name, inactive.description, inactive.content, notice]) {
        assert.ok(!payload.includes(text), `private text reached the model: ${text}`)
      }
    }
    const chat = await owner('chat', { botId })
    assert.equal(chat.sessionId, sessionId)
    assert.equal(chat.items.findLast(item => item.kind === 'user')?.text, prompt)
    assert.equal(chat.items.findLast(item => item.kind === 'bot')?.text, reply)
    return sent
  }

  const [called] = await turn(explicit, 'Explicit skill applied.', 1)
  assert.deepEqual(texts(personRow(called.messages)), [explicit, skill.content])
  assert.deepEqual(catalogSections(called.messages), [], 'the default call-only assignment is absent from the catalog')

  assert.deepEqual(await owner('bot-skill-mode', { ...assignment, mode: 'automatic' }), { saved: true })
  assert.deepEqual((await owner('skill-library', {})).active[botId], [{ name: skill.name, mode: 'automatic' }])
  const [offered, loaded] = await turn(automatic, 'Automatic skill applied.', 2)
  assert.deepEqual(texts(personRow(offered.messages)), [automatic])
  assert.ok(offered.tools.includes('load_skill'))
  for (const request of [offered, loaded]) {
    assert.deepEqual([...new Set(catalogSections(request.messages))], [catalogLine])
    assert.ok(!request.messages.some(row => row.role === 'system' && texts(row).join('\n').includes(skill.content)))
  }
  assert.deepEqual(bodyLocations(offered.messages), bodyLocations(called.messages), 'the catalog alone carries no fresh body')
  assert.deepEqual(texts(toolRow(loaded.messages, 'automatic-load')), [skill.content])
  const delivered = bodyLocations(loaded.messages)
  assert.equal(delivered.length, 2)

  assert.deepEqual(await owner('bot-skill-remove', assignment), { saved: true })
  const library = await owner('skill-library', {})
  assert.deepEqual(library.active[botId] ?? [], [])
  assert.ok(library.skills.some(record => record.name === skill.name), 'Remove leaves the skill in the library')
  const [removed, refused] = await turn(afterRemove, 'No active skill was loaded.', 2)
  for (const request of [removed, refused]) {
    assert.ok(!JSON.stringify(request.messages).includes(skill.description))
    assert.deepEqual(texts(personRow(request.messages)), [afterRemoveForModel])
    assert.deepEqual(bodyLocations(request.messages), delivered, 'only the two delivered history blocks remain')
  }
  const staleResult = toolRow(refused.messages, 'removed-load')
  assert.ok(staleResult, 'the stale tool call reached the Bot tool boundary')
  assert.deepEqual(staleResult.content, [], 'the removed skill returned no fresh body')
  assert.equal(staleResult.isError, true)

  const notices = bot.session.surface.nodes.map(seq => bot.session.eventAt(seq))
    .filter(event => event.type === 'user/message' && event.data.source?.kind === 'automagik-skill-notice')
  assert.equal(notices.length, 1)
  assert.equal(notices[0].data.source.form, 'notice')
  assert.equal(notices[0].data.source.summary, notice)
  assert.deepEqual(texts(notices[0].data), [notice])
  assert.deepEqual((await owner('chat', { botId })).items.filter(item => item.kind === 'automagik-skill-notice')
    .map(item => item.text), [notice])
})
