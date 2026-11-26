// read_own_chat's `before` (RFC 0030, Handoff note, #2061): an agent that took a chat over can
// page the whole chat back to its first message, across the parts another agent ran.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/chat-index.js'
import { historyEntry } from '../src/host/parts.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { CREDENTIALS } from '../src/host/redact.js'
import { redactor } from '../src/host/secrets.js'

// Two parts, `p1` and `p2`, each a user message and an answer per exchange.
function chat(t, { perPart = 10, index = true, messages = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'own-chat-before-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = index ? dir : join(dir, 'index-unavailable')
  if (!index) writeFileSync(home, '')
  const logs = new Map()
  for (const [id, base] of [['p1', 0], ['p2', perPart]]) {
    const events = []
    for (let at = 0; at < perPart; at += 1) {
      events.push({ seq: events.length, time: 1000 + base + at, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `question ${base + at + 1}` }] } })
      events.push({ seq: events.length, time: 1000 + base + at, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `answer ${base + at + 1}` }] } } })
    }
    logs.set(id, events)
  }
  const older = logs.get('p1')
  for (const text of messages) {
    older.push({ seq: older.length, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
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
    async* partLines(id) {
      for (const event of [...logs.get(id)].reverse()) {
        const text = historyEntry(event, false)?.text
        if (text) yield { text, time: event.time }
      }
    },
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

test('D2D-4 search and anchor excerpts mask complete history lines before matching or slicing', async t => {
  const shapeInterior = 'ShapeInteriorFixture'
  const savedInterior = 'SavedInteriorFixture'
  const shaped = `ghp_${shapeInterior.repeat(600)}`
  const saved = `VALUE${savedInterior.repeat(600)}END`
  const messages = [`${shaped} shape-marker`, `${saved} saved-marker`]
  const maskSaved = redactor([{ name: 'FIXTURE', value: saved }])
  const db = chat(t, { messages })
  // Index the earlier part before the value is saved, then change the current redactor.
  await db.searchOwnChat('b1', 'saved-marker')
  db.connectorDiagnosticRedactor = () => maskSaved
  const scan = chat(t, { index: false, messages })
  scan.connectorDiagnosticRedactor = () => maskSaved
  for (const rt of [db, scan]) {
    for (const [marker, interior] of [['shape-marker', shapeInterior], ['saved-marker', savedInterior]]) {
      const { lines } = await rt.searchOwnChat('b1', marker)
      assert.equal(lines.length, 1)
      assert.ok(lines[0].includes(marker))
      assert.ok(!lines[0].includes(interior))
      assert.deepEqual((await rt.searchOwnChat('b1', interior)).lines, [])
    }
  }
  const around = await db.aroundOwnChat('b1', 'part 1 #20')
  assert.equal(around.exact, true)
  assert.ok(around.lines.some(line => line.includes('[hidden] shape-marker')))
  assert.ok(around.lines.some(line => line.includes('[secret:FIXTURE] saved-marker')))
  assert.ok(!around.lines.some(line => line.includes(shapeInterior) || line.includes(savedInterior)))
})

test('D2E-5 overlapping vault and credential ranges are masked as a union', async t => {
  const left = 'PrivateLeftFixture'
  const inner = 'ghp_CredentialShapeFixture123'
  const right = 'PrivateRightFixture'
  const saved = `${left}:${inner}:${right}`
  const mask = redactor([{ name: 'OVERLAP', value: saved }])
  const tail = 'PrivateTailFixture'
  const messages = [`before ${saved} after visible-marker`, `password=password= ${tail} overlap-marker`]
  for (const index of [true, false]) {
    const rt = chat(t, { index, messages })
    rt.connectorDiagnosticRedactor = () => mask
    const { lines } = await rt.searchOwnChat('b1', 'visible-marker')
    assert.equal(lines.length, 1)
    assert.ok(lines[0].includes('visible-marker'))
    for (const fragment of [left, inner, right]) {
      assert.ok(!lines[0].includes(fragment), `excerpt contains ${fragment}`)
      assert.deepEqual((await rt.searchOwnChat('b1', fragment)).lines, [])
    }
    const nested = (await rt.searchOwnChat('b1', 'overlap-marker')).lines
    assert.equal(nested.length, 1)
    assert.ok(!nested[0].includes(tail), 'excerpt contains the tail of an overlapping credential')
    assert.deepEqual((await rt.searchOwnChat('b1', tail)).lines, [])
    if (index) {
      const around = await rt.aroundOwnChat('b1', 'part 1 #20')
      assert.ok(around.lines.some(line => line.includes('before [hidden] after visible-marker')))
      assert.ok(around.lines.some(line => line.includes('[hidden] overlap-marker')))
    }
  }
})

test('D2E-6 fallback discards excerpts when the vault redactor changes during a scan', async t => {
  const entered = Promise.withResolvers()
  const page = Promise.withResolvers()
  const rt = chat(t, { index: false })
  const value = `PrivateFixture${'newly saved words '.repeat(300)}end`
  const line = { text: `User: ${value} visible-marker`, time: 1000 }
  let mask
  rt.connectorDiagnosticRedactor = () => mask
  rt.partLines = async function* (id) {
    if (id !== 'p2') return
    yield line
    entered.resolve()
    await page.promise
    yield { text: 'User: ordinary text', time: 999 }
  }
  const pending = rt.searchOwnChat('b1', 'visible-marker')
  await entered.promise
  mask = redactor([{ name: 'RECENT', value }])
  page.resolve()
  assert.deepEqual((await pending).lines, [], 'a scan must discard excerpts collected under the old vault mask')
  const fresh = await rt.searchOwnChat('b1', 'visible-marker')
  assert.equal(fresh.lines.length, 1)
  assert.ok(fresh.lines[0].includes('visible-marker'))
  assert.ok(!fresh.lines[0].includes('newly saved words'))
})

test('D2a latest and before mask complete lines before the preview cuts them', async t => {
  const savedPiece = 'SavedPreviewFixture'
  const shapePiece = 'ShapePreviewFixture'
  const saved = `VALUE${savedPiece.repeat(60)}END`
  const messages = [
    `saved-preview-marker ${saved} saved-tail`,
    `shape-preview-marker ${'x'.repeat(345)} ghp_${shapePiece.repeat(30)} shape-tail`,
  ]
  const mask = redactor([{ name: 'PREVIEW', value: saved }])
  const indexed = chat(t, { perPart: 0, messages })
  const scan = chat(t, { index: false, perPart: 0, messages })
  indexed.connectorDiagnosticRedactor = scan.connectorDiagnosticRedactor = () => mask

  const before = await indexed.beforeOwnChat('b1', 'part 2 #0')
  for (const [path, lines] of [
    ['indexed latest', await indexed.latestOwnChat('b1')],
    ['scan latest', await scan.latestOwnChat('b1')],
    ['indexed before', before.lines],
  ]) {
    assert.equal(lines.length, 2, path)
    assert.ok(lines[0].includes('[secret:PREVIEW] saved-tail'), `${path} must mask the saved value`)
    assert.ok(lines[1].includes('[hidden] shape-tail'), `${path} must mask the credential shape`)
    assert.ok(!lines.some(line => line.includes(savedPiece) || line.includes(shapePiece)), path)
  }
})

// The unbudgeted overlap loop from before D2G.
function referenceMaskLine(text, mask) {
  const ranges = mask?.ranges?.(text) ?? []
  for (const [pattern, replacement] of CREDENTIALS) {
    const overlapping = new RegExp(pattern)
    for (let match; (match = overlapping.exec(text)) !== null;) {
      const label = typeof replacement === 'function' ? replacement(...match)
        : replacement.replace('$1', () => match[1])
      if (label !== match[0]) ranges.push([match.index, match.index + match[0].length, label])
      overlapping.lastIndex = match.index + (text.codePointAt(match.index) > 0xFFFF ? 2 : 1)
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous !== undefined && range[0] < previous[1]) {
      previous[1] = Math.max(previous[1], range[1])
      previous[2] = '[hidden]'
    } else merged.push(range)
  }
  let cursor = 0
  let masked = ''
  for (const [start, end, label] of merged) {
    masked += text.slice(cursor, start) + label
    cursor = end
  }
  return masked + text.slice(cursor)
}

test('D2G-1 the budget preserves the old mask on a seeded corpus of ordinary lines', async t => {
  const saved = 'SavedValueFixture'
  const pieces = [
    'visible', 'café', '日本語', '😀', 'password=', 'token=', '"', "'",
    'private_', 'service.', 'password=OrdinaryFixture', '"client-secret": "abcdef123"',
    'Basic dXNlcjpwYXNz', 'Bearer abcdefghijkl', 'ghp_ABCDEFGHIJKLMNOPQRST',
    'sk-abcdef123456', 'npm_config__authToken=abc', 'https://user:p@ss@host.test/path',
    'https://x.test/a?token=abc&key=def#sig=zz', 'eyJhbGci.eyJzdWIi.c2lnbmF0', saved,
  ]
  const messages = [
    'export my_very_long_service_name_api_key=abcdefghijk # set in CI',
    'config.payments.stripe.client_secret=abcdefghijkl # still visible',
    '😀password=😀secret123 ghp_ABCDEFGHIJKLMNOPQRST😀',
  ]
  const separators = ['', ' ', '.', '_', '-']
  let seed = 2061
  const random = size => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) % size
  }
  for (let i = 0; i < 2048; i += 1) {
    const parts = Array.from({ length: 1 + random(6) }, () => pieces[random(pieces.length)])
    const prefix = (i % 4 === 0 ? 'service_' : 'stage.').repeat(random(24))
    const body = i % 2 === 0 ? prefix + 'password=OrdinaryFixture' : parts.join(separators[random(separators.length)])
    messages.push('before ' + body + ' after ' + saved)
  }

  const rt = chat(t, { index: false, perPart: 0, messages })
  for (const mask of [undefined, redactor([{ name: 'FIXTURE', value: saved }])]) {
    rt.connectorDiagnosticRedactor = () => mask
    const lines = await rt.latestOwnChat('b1', { limit: messages.length })
    assert.equal(lines.length, messages.length)
    for (const [i, message] of messages.entries()) {
      assert.equal(lines[i].replace(/^\[[^\]]*\] /, ''), referenceMaskLine(message, mask), 'corpus line ' + i)
    }
  }
})

test('D2G-1 overlapping history masks bound rescans and hide the suffix on exhaustion', async t => {
  const tail = 'PrivateBudgetTailFixture'
  const pathological = `bounded-marker password=FirstFixture bridge ${'password='.repeat(4096)}${'@'.repeat(8192)} ${tail}`
  const ordinary = 'ordinary-marker password=OrdinaryFixture still-visible'
  const passwordRule = CREDENTIALS.at(-1)[0].source
  const exec = RegExp.prototype.exec
  let scanned = 0
  t.mock.method(RegExp.prototype, 'exec', function (text) {
    const from = this.lastIndex
    const match = exec.call(this, text)
    if (match !== null && text === pathological && this.source === passwordRule) {
      scanned += this.lastIndex - from
      // Allow the budget plus one match that crosses it. Fail early on the old loop.
      assert.ok(scanned <= 257 * pathological.length, 'credential rule exceeded the linear scan bound')
    }
    return match
  })

  for (const index of [true, false]) {
    const rt = chat(t, { index, perPart: 0, messages: [pathological, ordinary] })
    scanned = 0
    const lines = await rt.latestOwnChat('b1')
    assert.deepEqual(lines.map(line => line.replace(/^\[[^\]]*\] (?:User: )?/, '')), [
      'bounded-marker [hidden]',
      'ordinary-marker password=[hidden] still-visible',
    ])
    scanned = 0
    assert.deepEqual((await rt.searchOwnChat('b1', tail)).lines, [])
  }
})

test('D2G-1 masks a 1 MiB pathological history line within the timing budget', async t => {
  const prefix = `bounded-marker password=FirstFixture bridge ${'password='.repeat(96 * 1024)}`
  const suffix = ' PrivateBudgetTailFixture'
  const pathological = prefix + '@'.repeat(1024 * 1024 - prefix.length - suffix.length) + suffix
  const rt = chat(t, { index: false, perPart: 0, messages: [pathological] })

  const start = performance.now()
  const lines = await rt.latestOwnChat('b1')
  const elapsed = performance.now() - start

  assert.ok(elapsed < 2000, `masking a 1 MiB pathological line stays under 2 s on CI (${elapsed.toFixed(1)} ms)`)
  assert.equal(lines[0].replace(/^\[[^\]]*\] /, ''), 'bounded-marker [hidden]')
})
