import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { ACP_USAGE_LIMIT_CODES, CLAUDE_USAGE_LIMIT_PREFIXES, usageLimitOf } from '../src/host/usage-limit.js'

const banner = "You've hit your usage limit. Try again later."

test('usage limit codes and the Claude SDK prefixes are fixed', () => {
  assert.equal(Object.isFrozen(ACP_USAGE_LIMIT_CODES), true)
  assert.deepEqual(ACP_USAGE_LIMIT_CODES, {
    'acp-claude': 'ACP_CLAUDE_USAGE_LIMIT',
    'acp-codex': 'ACP_CODEX_USAGE_LIMIT',
  })
  assert.equal(Object.isFrozen(CLAUDE_USAGE_LIMIT_PREFIXES), true)
  assert.deepEqual(CLAUDE_USAGE_LIMIT_PREFIXES, [
    "You've hit your", "You've reached your", "You're out of usage credits",
    'Your org is out of usage · add funds to continue',
    'Your org is out of usage · contact your admin',
    "Your seat type doesn't include usage credits", "Your seat type doesn't include usage",
    'Your usage allocation has been disabled by your admin',
    "Your group's usage limit is set to $0", 'Fable 5 requires usage credits',
    "You're out of extra usage", "Your seat type doesn't include extra usage",
  ])
})

test('Codex reads only structured usage limit information', () => {
  const inherited = Object.create({ usageLimitExceeded: {} })
  const array = Object.assign([], { usageLimitExceeded: {} })
  for (const [info, expected] of [
    ['usageLimitExceeded', true],
    [{ usageLimitExceeded: {} }, true],
    [{ usageLimitExceeded: null }, true],
    ['other', false],
    [{ other: {} }, false],
    [inherited, false],
    [array, false],
    [null, false],
  ]) assert.equal(usageLimitOf('acp-codex', { data: { codexErrorInfo: info }, message: banner }), expected)
})

test('Claude checks the rejection status and gives explicit non-quota errors precedence', () => {
  for (const [data, message, expected] of [
    [{ errorKind: 'rate_limit', rateLimit: { status: 'rejected' } }, 'Internal error', true],
    [{ errorKind: 'rate_limit', rateLimit: { status: 'allowed_warning' } }, 'A warning', false],
    [{ errorKind: 'rate_limit' }, banner, true],
    [{ errorKind: 'rate_limit' }, 'Internal error', false],
    [{ errorKind: 'authentication_failed', rateLimit: { status: 'rejected' } }, banner, false],
    [{ rateLimit: { status: 'rejected' } }, 'Internal error', false],
    [{ codexErrorInfo: 'usageLimitExceeded' }, 'Internal error', false],
  ]) assert.equal(usageLimitOf('acp-claude', { data, message }), expected)
})

test('the Claude text fallback checks the start of the message after one wrapper', () => {
  for (const prefix of CLAUDE_USAGE_LIMIT_PREFIXES) {
    assert.equal(usageLimitOf('acp-claude', { message: ` ${prefix} with more detail. ` }), true, prefix)
    assert.equal(usageLimitOf('acp-claude', { message: `Internal error:  ${prefix} with more detail.` }), true, prefix)
    assert.equal(usageLimitOf('acp-claude', { message: `Example: ${prefix}` }), false, prefix)
  }
  assert.equal(usageLimitOf('acp-claude', { message: `Internal error: Internal error: ${banner}` }), false)
})

test('garbage errors are safe and the classifier is scoped to the two providers', () => {
  for (const provider of ['acp-codex', 'acp-claude']) {
    for (const data of [null, undefined, 'garbage', 17, []]) {
      assert.equal(usageLimitOf(provider, { data, message: 'Internal error' }), false)
    }
    assert.equal(usageLimitOf(provider, null), false)
    assert.equal(usageLimitOf(provider, { get data() { throw new Error('bad data') } }), false)
    assert.equal(usageLimitOf(provider, { message: 17 }), false)
  }
  assert.equal(usageLimitOf('acp-claude', { data: null, message: banner }), true)
  assert.equal(usageLimitOf('acp-probe', { data: { codexErrorInfo: 'usageLimitExceeded', errorKind: 'rate_limit', rateLimit: { status: 'rejected' } }, message: banner }), false)
})

test('the prompt boundary forwards only the usage signal, never raw error data', async t => {
  const run = new AgentRun({ name: 'Probe agent', cwd: process.cwd(), provider: 'acp-codex' })
  t.after(() => run.dispose())
  run.sessionId = 'probe-session'
  run.gone = new Promise(() => {})
  run.conn = { prompt: async () => { throw Object.assign(new Error('Internal error'), {
    code: -32603,
    data: { codexErrorInfo: 'usageLimitExceeded', privateAccount: 'secret@example.test' },
  }) } }
  await run.prompt([{ type: 'text', text: 'hello' }])
  const [event] = run.queue
  assert.deepEqual(event, { type: 'error', message: 'Internal error', code: -32603, usageLimit: true })
  assert.deepEqual(run.queue, [event])
  assert.equal(JSON.stringify(event).includes('privateAccount'), false)
})

// A fake agent answers one prompt over stdio, as in failure-text.test.js.
async function turnOn(t, provider, error, message) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-usage-limit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'agent.mjs')
  writeFileSync(script, `
import { createInterface } from 'node:readline'
const send = body => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\\n')
const sessionId = 'probe-session'
const error = ${JSON.stringify(error)}
const text = ${JSON.stringify(message)}
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: {} } })
  if (method === 'session/new') return send({ id, result: { sessionId } })
  if (method === 'session/prompt') {
    if (text) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    return send(error ? { id, error } : { id, result: { stopReason: 'end_turn' } })
  }
  send({ id, error: { code: -32601, message: 'Method not found' } })
})
`)
  const dshAgent = { session: { id: 's1', header: { cwd: dir } }, ctx: { tools: { register: () => () => {} } } }
  const ctx = { agents: { get: id => id === 's1' ? dshAgent : undefined }, get: () => undefined }
  const agent = {
    name: 'Probe agent',
    catalog: { models: async () => [{ id: 'default', name: 'Probe agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} },
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [script] }),
  }
  const adapter = new AcpAdapter(ctx, new Map([[provider, agent]]), { dshTools: () => false })
  t.after(() => adapter.dispose())
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({
    provider, model: 'default', sessionId: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }],
  }))) chunks.push(chunk)
  return chunks.at(-1).reason
}

const internalError = data => ({ code: -32603, message: 'Internal error', data })
for (const [name, provider, error, message, kind, code] of [
  ['Codex usage limit', 'acp-codex', internalError({ codexErrorInfo: 'usageLimitExceeded' }), banner, 'error', 'ACP_CODEX_USAGE_LIMIT'],
  ['Claude usage limit', 'acp-claude', internalError({ errorKind: 'rate_limit', rateLimit: { status: 'rejected' } }), undefined, 'error', 'ACP_CLAUDE_USAGE_LIMIT'],
  ['a successful turn quoting a banner', 'acp-claude', undefined, `The message said "${banner}"`, 'stop', undefined],
  ['a plain internal error', 'acp-codex', internalError(), undefined, 'error', 'ACP_AGENT'],
  ['auth_required', 'acp-claude', { code: -32000, message: 'Authentication required', data: { errorKind: 'rate_limit', rateLimit: { status: 'rejected' } } }, undefined, 'error', 'MODEL_ACCESS_REQUIRED'],
]) {
  test(`the ACP wire reports ${name}`, async t => {
    const reason = await turnOn(t, provider, error, message)
    assert.equal(reason.kind, kind, reason.failure?.message)
    assert.equal(reason.failure?.code, code, reason.failure?.message)
    if (code === 'ACP_AGENT') assert.equal(reason.failure.message, 'Probe agent: Internal error')
  })
}
