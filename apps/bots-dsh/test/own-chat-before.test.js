// read_own_chat's `before` (RFC 0030, Handoff note, #2061): an agent that took a chat over can
// page the whole chat back to its first message, across the parts another agent ran.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/chat-index.js'
import { historyEntry } from '../src/host/parts.js'
import { SOURCE_KIND } from '../src/host/constants.js'

// Two parts, `p1` and `p2`, each a user message and an answer per exchange.
function chat(t, { perPart = 10 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'own-chat-before-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const logs = new Map()
  for (const [id, base] of [['p1', 0], ['p2', perPart]]) {
    const events = []
    for (let at = 0; at < perPart; at += 1) {
      events.push({ seq: events.length, time: 1000 + base + at, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `question ${base + at + 1}` }] } })
      events.push({ seq: events.length, time: 1000 + base + at, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer ${base + at + 1}` }] } } })
    }
    logs.set(id, events)
  }
  const disposers = []
  const rt = {
    home,
    ctx: {
      effect: execute => { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose) },
      sessionController: {
        page: async ({ address, beforeSeq }) => {
          const events = (logs.get(address.sessionId) ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq)
          return { records: events.map(event => ({ event })), hasMore: false }
        },
      },
    },
    resolveAgent: async id => ({ session: { seq: logs.get(id)?.length ?? 0 } }),
    partsOf: () => [
      { sessionId: 'p1', number: 1, startedAt: 1, endedAt: 2, switchedTo: 'acp-claude/default' },
      { sessionId: 'p2', number: 2, startedAt: 2, switchedIn: 'acp-claude/default' },
    ],
    historyEntry,
    clock: time => String(time),
    warn() {},
  }
  install(rt)
  t.after(() => { for (const dispose of disposers.splice(0)) dispose() })
  return rt
}

test('before pages back across parts to the first message, with the next page\'s anchor', async t => {
  const rt = chat(t, { perPart: 5 })
  // The current part's first message: what precedes it is the earlier part, another agent's.
  const first = await rt.beforeOwnChat('b1', 'part 2 #0', { limit: 6 })
  assert.equal(first.error, undefined)
  assert.deepEqual(first.lines.map(line => line.replace(/^\[[^\]]*\] /, '')), [
    'User: question 3', 'You: answer 3', 'User: question 4', 'You: answer 4', 'User: question 5', 'You: answer 5',
  ])
  assert.equal(first.older, 'part 1 #4')
  const next = await rt.beforeOwnChat('b1', first.older, { limit: 6 })
  assert.deepEqual(next.lines.map(line => line.replace(/^\[[^\]]*\] /, '')), ['User: question 1', 'You: answer 1', 'User: question 2', 'You: answer 2'])
  assert.equal(next.older, undefined)
})

test('before refuses what is not an anchor or a part of this chat', async t => {
  const rt = chat(t)
  assert.match((await rt.beforeOwnChat('b1', 'yesterday')).error, /is not an anchor/)
  assert.match((await rt.beforeOwnChat('b1', 'part 7 #1')).error, /no part 7/)
})

// The outgoing agent's handoff-note request and its answer are Omni's, never a chat line.
test('historyEntry drops a handoff-note request and the note written for it', () => {
  const request = historyEntry({ type: 'user/message', data: { source: { kind: SOURCE_KIND, role: 'handoff-note', exchangeId: 'e1' }, content: [{ type: 'text', text: 'write a handoff note' }] } })
  assert.deepEqual(request, { answer: false, who: 'bot', text: '', keepAnswers: false })
})
