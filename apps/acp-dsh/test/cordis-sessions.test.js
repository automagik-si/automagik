import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import * as acp from '../index.js'

test('the mounted ACP plugin can send its first prompt with the DSH sessions service', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-cordis-sessions-'))
  const host = new Context()
  t.after(async () => {
    await host.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const trace = join(dir, 'trace.ndjson')
  const fake = join(dir, 'fake.mjs')
  writeFileSync(fake, [
    'process.env.FAKE_ACP_TRACE = ' + JSON.stringify(trace),
    'await import(' + JSON.stringify(new URL('../dev/fake-agent.mjs', import.meta.url).href) + ')',
  ].join('\n'))

  const session = Session.create('cordis-chat', undefined, { id: 'cordis-chat', version: 4, cwd: dir, isSeeded: false, createdAt: 0 })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const agent = { id: session.id, session, ctx: { tools: { register: () => () => {} } } }
  let adapter
  await host.plugin({ name: 'fake-dsh-services', apply(ctx) {
    ctx.provide('llm', { registerAdapter(providers, registered) {
      assert.deepEqual(providers, ['acp-fake'])
      adapter = registered
      return () => {}
    } })
    ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
    ctx.provide('sessions', { get: id => id === session.id ? session : undefined })
  } })

  const plugin = host.plugin(acp, { fakeAgent: fake, claude: false, codex: false, dshTools: false })
  await plugin
  assert.ok(plugin.runtime)
  assert.notEqual(plugin.ctx, host)
  assert.equal(adapter?.ctx, plugin.ctx)

  const prompt = 'plain Cordis first prompt'
  const messages = [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })]
  const chunks = []
  let failure
  try {
    for await (const chunk of adapter.stream(markAgentLoopRequest({
      sessionId: session.id, provider: 'acp-fake', model: 'default', messages,
    }))) chunks.push(chunk)
  } catch (error) {
    failure = error
  }
  const events = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const prompts = events.filter(row => row.event === 'prompt').map(row => row.text)
  t.diagnostic(JSON.stringify({ prompts, failure: failure?.message, finish: chunks.at(-1)?.reason }))
  assert.ifError(failure)
  assert.deepEqual(prompts, [prompt])
  assert.equal(chunks.at(-1)?.reason.kind, 'stop')
})
