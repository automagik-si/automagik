import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { receiptPng } from './support/upload-admission.js'

async function prompt(t, { marked = true, authorized = true, changedSource = false, resumed = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'review-upload-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const session = Session.create('reviewer')
  session.header = { ...session.header, cwd: folder }
  const agent = { id: session.id, session, ctx: { tools: { register: () => () => {} } } }
  const bytes = receiptPng()
  const attachmentId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const attachment = { attachmentId, mediaType: 'image/png', bytes: bytes.length, width: 622, height: 251, name: 'result.png' }
  const content = [{ type: 'text', text: 'Verify result' }, { type: 'image', attachment }]
  const row = createUserMessage({ content, source: {
    kind: 'bot', form: 'relay', role: 'request', exchangeId: 'review', senderSessionId: 'solver',
    ...(marked ? { resultReview: { v: 1 } } : {}), ...(resumed ? { resumed: true } : {}),
  } })
  session.append('user/message', row, { surfaceOp: 'append' })
  // Mirror the real Bots projection. Only the text around the durable attachment changes.
  const projected = { ...row, content: [...content, { type: 'text', text: '[Saved picture: local copy]' }],
    ...(changedSource ? { source: { ...row.source, senderSessionId: 'different' } } : {}) }
  const team = {
    resultReviewImages: (id, exchange) => authorized && id === session.id && exchange === 'review' ? [attachmentId] : undefined,
  }
  const services = { omniTeam: team, attachments: { readImage: async ref => ({ ref, data: bytes }) } }
  const provider = 'acp-review-fixture'
  const adapter = new AcpAdapter({ agents: { get: () => agent }, get: name => services[name] },
    new Map([[provider, { name: 'Fake reviewer', spawn: () => assert.fail('no live process') }]]))
  const run = new AgentRun({ name: 'Fake reviewer' })
  run.child = {}
  run.sessionId = 'remote-review'
  run.init = { agentCapabilities: { promptCapabilities: { image: true } } }
  run.gone = new Promise(() => {})
  const sends = []
  run.conn = { prompt: async params => { sends.push(params); return { stopReason: 'end_turn' } } }
  run.dispose = () => run.letGo(true)
  t.after(() => adapter.dispose())
  adapter.live.set(session.id, { run, provider, name: 'Fake reviewer', dshAgent: agent, open: false, asks: false, calls: new Set() })
  const chunks = await Array.fromAsync(adapter.stream({ provider, model: 'default', sessionId: session.id, messages: [projected] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(sends.length, 1)
  return { sent: sends[0].prompt, bytes }
}

test('2133 ACP admits the verified designated image across appended copy text', async t => {
  const { sent, bytes } = await prompt(t)
  const image = sent.find(block => block.type === 'image')
  assert.ok(image, 'the verified result picture reaches the ACP prompt as an image')
  assert.ok(Buffer.from(image.data, 'base64').equals(bytes), 'the receiving ACP prompt holds the original PNG bytes')
  assert.ok(sent.some(block => block.type === 'text' && block.text.includes('Saved picture')))
})

for (const change of [{ marked: false }, { authorized: false }, { changedSource: true }, { resumed: true }]) {
  test(`2133 ACP keeps the picture as text for ${Object.keys(change)[0]}`, async t => {
    const { sent } = await prompt(t, change)
    assert.equal(sent.some(block => block.type === 'image'), false)
    assert.ok(sent.some(block => block.type === 'text' && block.text.includes('Verify result')))
  })
}
