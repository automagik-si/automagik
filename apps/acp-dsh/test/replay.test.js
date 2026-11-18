// Plan A-5: the chat reaches an agent independent of the bridge. The `dshTools` table, per CLI:
//
// | dshTools | Claude: tools | Claude: replay | Codex: tools        | Codex: replay |
// | absent   | DSH bridge    | yes            | DSH bridge and own  | yes           |
// | true     | DSH bridge    | yes            | DSH bridge and own  | yes           |
// | false    | its own only  | no             | its own only        | no            |
//
// Plus what A-5 adds beyond a crossing: a move off a bridged agent ends its session and the move
// back starts a new one with the chat (Codex -> API -> Codex), a new session in a chat that
// already has answers (a restart), and a Bot part's handoff package reaching the agent on the
// part's first turn. The fake agent stands in for both
// CLIs: Claude is the agent whose adapter drops its own tools (`disableBuiltInTools`), Codex the
// one that forks to refresh (`refresh: 'fork'`). What an agent received is read from its own
// prompt trace, never from its answer.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { AcpAdapter, NOTICE_KIND, promptOf } from '../src/host/adapter.js'
import { Backchannel } from '../src/host/backchannel.js'
import { SYNTHETIC_KIND } from '../src/host/names.js'
import { BOUNDARY_KIND, answered, isHandoff, missedBy, renderMessage, replayBlocks } from '../src/host/switch.js'

const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const ROUTE = 'acp-fake'
const CLIS = {
  claude: { disableBuiltInTools: true },
  codex: { refresh: 'fork' },
}
const secret = text => text.replaceAll('hunter2', '[secret:TOKEN]')

const user = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const answer = (text, provider = 'deepseek-official') => ({ role: 'assistant', source: { kind: 'model', provider, model: 'm' }, content: [{ type: 'text', text }] })
// A Bot part's opening package, as the Bot team writes it (bots-dsh parts.js handoffSource).
const handoff = text => ({ role: 'user', source: { kind: 'bot', form: 'relay', role: 'handoff', senderName: 'Omni', handoff: true, exchangeId: 'x' }, content: [{ type: 'text', text }] })

function fixture({ cli, toolsOn, dir, name = 'fake' }) {
  const trace = join(dir, `${name}.ndjson`)
  const session = Session.create('s1')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 0 })
  const agent = { session, ctx: { tools: { register: () => () => {} } } }
  const ctx = {
    agents: { get: () => agent, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    get: (key) => {
      if (key === 'tools') {
        const definitions = [{ name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: {} } }]
        return { definitions: () => definitions, executable: n => definitions.find(d => d.name === n), execute: async () => ({ results: [] }) }
      }
      if (key === 'approval') return { effectivePolicy: () => 'ask', request: async () => 'allowed-once' }
      if (key === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
      if (key === 'agentPresets') return { presetForSession: () => 'standard' }
      return undefined
    },
    logger: { warn: () => {}, info: () => {} },
  }
  const catalog = { models: async () => [{ id: 'default', name: 'Fake agent' }], model: async () => undefined, ownEffort: () => undefined, dispose() {} }
  const spec = {
    name: 'Fake agent',
    catalog,
    installed: () => true,
    spawn: () => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_TRACE: trace } }),
    ...CLIS[cli],
  }
  const backchannel = new Backchannel({ ctx })
  const make = () => new AcpAdapter(ctx, new Map([[ROUTE, spec]]), { dshTools: () => toolsOn, backchannel, redactor: secret })
  const h = { adapter: make(), spec, session, backchannel, trace }
  // A restart: the adapter goes, the Session and its transcript stay.
  h.restart = () => { h.adapter.dispose(); h.adapter = make() }
  h.close = () => { h.adapter.dispose(); backchannel.dispose() }
  return h
}

async function step(adapter, messages, model = 'default') {
  const chunks = []
  for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: ROUTE, model, sessionId: 's1', messages }))) chunks.push(chunk)
  return chunks
}
const textIn = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
const events = path => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [])
const prompts = h => events(h.trace).filter(event => event.event === 'prompt')
const servers = h => events(h.trace).filter(event => event.event === 'new-session').map(event => event.servers)
const rows = (h, kind) => h.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === kind)

// One agent turn the way DSH logs it: the person's words, then the agent's answer on its route.
async function agentTurn(h, messages, text) {
  messages.push(user(text))
  const chunks = await step(h.adapter, messages)
  assert.equal(chunks.at(-1).reason.kind, 'stop', textIn(chunks))
  messages.push(answer(textIn(chunks), ROUTE))
  return chunks
}

const TABLE = [
  // [cli, dshTools, bridged, replayed]
  ['claude', undefined, true, true],
  ['claude', true, true, true],
  ['claude', false, false, false],
  ['codex', undefined, true, true],
  ['codex', true, true, true],
  ['codex', false, false, false],
]

for (const [cli, toolsOn, bridged, replayed] of TABLE) {
  test(`dshTools ${String(toolsOn)} on ${cli}: ${bridged ? 'the DSH bridge' : 'its own tools'}, ${replayed ? 'the chat replayed' : 'no replay'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-table-'))
    const h = fixture({ cli, toolsOn, dir })
    try {
      assert.equal(h.adapter.bridgeOn(h.spec), bridged)
      assert.equal(h.adapter.replayOn(), replayed)
      // API -> agent, with a chat that already has an answer carrying a stored secret.
      const messages = [user('earlier question'), answer('earlier answer hunter2')]
      await agentTurn(h, messages, 'plain now')
      // Tools: the bridge is handed to the agent's session exactly where the table says.
      assert.deepEqual(servers(h), [bridged ? ['dsh'] : []])
      const [first] = prompts(h)
      if (replayed) {
        assert.match(first.text, /The chat so far, moved from DSH to Fake agent:/)
        assert.match(first.text, /Assistant: earlier answer \[secret:TOKEN\]/)
        assert.equal(first.text.includes('hunter2'), false)
        assert.equal(rows(h, BOUNDARY_KIND).length, 1)
        assert.equal(rows(h, NOTICE_KIND).length, 0)
      } else {
        // The kill switch: the 2026-11-03 path, the person's words only and the notice row.
        assert.equal(first.text, 'plain now')
        assert.equal(rows(h, BOUNDARY_KIND).length, 0)
        assert.equal(rows(h, NOTICE_KIND).length, 1)
      }
    } finally {
      h.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('Codex -> API -> Codex: the move off ends the bridged session, and the new one gets the chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-codex-'))
  const h = fixture({ cli: 'codex', toolsOn: undefined, dir })
  try {
    const messages = []
    await agentTurn(h, messages, 'plain first')
    // #1544: Codex is bridged by default, so a move off ends its agent session and revokes the
    // bridge; the move back starts a new one with the whole chat, not a resumed old session.
    h.adapter.noteEvent(h.session, { type: 'model/selection', data: { provider: 'deepseek-official' } })
    assert.equal(h.adapter.live.size, 0)
    messages.push(user('ask the api'), answer('api answer hunter2'))
    const back = await agentTurn(h, messages, 'plain back')
    assert.match(textIn(back), /turn 1/)
    const last = prompts(h).at(-1)
    assert.match(last.text, /The chat so far, moved from DSH to Fake agent:/)
    assert.match(last.text, /User: ask the api/)
    assert.match(last.text, /Assistant: api answer \[secret:TOKEN\]/)
    assert.equal(last.text.includes('hunter2'), false)
    // One row for the move off (Switching to DSH) and one for the move back.
    assert.equal(rows(h, BOUNDARY_KIND).length, 2)
    assert.match(rows(h, BOUNDARY_KIND)[1].data.source.summary, /Switching to Fake agent \(acp-fake\)/)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a replay whose turn never reached the prompt is still owed on the next turn, with one row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-owed-'))
  const h = fixture({ cli: 'codex', toolsOn: undefined, dir })
  try {
    const messages = [user('earlier question'), answer('earlier answer'), user('plain now')]
    // The agent refuses the model before any prompt: the turn fails, the session stays.
    const refused = await step(h.adapter, messages, 'no-such-model')
    assert.equal(refused.at(-1).reason.kind, 'error')
    assert.equal(prompts(h).length, 0)
    const chunks = await step(h.adapter, messages)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const [first] = prompts(h)
    assert.match(first.text, /The chat so far, moved from DSH to Fake agent:/)
    assert.match(first.text, /Assistant: earlier answer/)
    assert.equal(rows(h, BOUNDARY_KIND).length, 1)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex -> API -> Codex with the kill switch: the old path, the session resumed with no replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-codex-off-'))
  const h = fixture({ cli: 'codex', toolsOn: false, dir })
  try {
    const messages = []
    await agentTurn(h, messages, 'plain first')
    h.adapter.noteEvent(h.session, { type: 'model/selection', data: { provider: 'deepseek-official' } })
    messages.push(user('ask the api'), answer('api answer'))
    const back = await agentTurn(h, messages, 'plain back')
    assert.match(textIn(back), /turn 2/)
    assert.equal(prompts(h).at(-1).text, 'plain back')
    assert.equal(rows(h, BOUNDARY_KIND).length, 0)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Claude -> API -> Claude: the move off ends the session, and the new one gets the chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-claude-'))
  const h = fixture({ cli: 'claude', toolsOn: undefined, dir })
  try {
    const messages = []
    await agentTurn(h, messages, 'plain first')
    h.adapter.noteEvent(h.session, { type: 'model/selection', data: { provider: 'deepseek-official' } })
    assert.equal(h.adapter.live.size, 0)
    messages.push(user('ask the api'), answer('api answer'))
    const back = await agentTurn(h, messages, 'plain back')
    assert.match(textIn(back), /turn 1/)
    const last = prompts(h).at(-1)
    assert.match(last.text, /The chat so far, moved from DSH to Fake agent:/)
    assert.match(last.text, /User: plain first/)
    assert.match(last.text, /Assistant: api answer/)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const cli of ['claude', 'codex']) {
  test(`a restart on ${cli}: the new session in a chat with answers gets the chat, with no row`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-restart-'))
    const h = fixture({ cli, toolsOn: undefined, dir })
    try {
      const messages = []
      await agentTurn(h, messages, 'plain before hunter2')
      h.restart()
      const after = await agentTurn(h, messages, 'plain after')
      // A new agent session (turn 1 again) that still sees the chat before it.
      assert.match(textIn(after), /turn 1/)
      const last = prompts(h).at(-1)
      assert.match(last.text, /The chat so far, before this new Fake agent session:/)
      assert.match(last.text, /User: plain before \[secret:TOKEN\]/)
      assert.equal(last.text.includes('hunter2'), false)
      // The chat stayed on the same provider: no boundary row, and no "does not see" notice.
      assert.equal(rows(h, BOUNDARY_KIND).length, 0)
      assert.equal(rows(h, NOTICE_KIND).length, 0)
    } finally {
      h.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test('a restart with the kill switch: no replay, and the notice says the agent does not see the chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-restart-off-'))
  const h = fixture({ cli: 'claude', toolsOn: false, dir })
  try {
    const messages = []
    await agentTurn(h, messages, 'plain before')
    h.restart()
    await agentTurn(h, messages, 'plain after')
    assert.equal(prompts(h).at(-1).text, 'plain after')
    assert.equal(rows(h, NOTICE_KIND).length, 1)
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const cli of ['claude', 'codex']) {
  test(`a Bot part's handoff reaches ${cli} on the part's first real turn, after the Bot team's own acknowledgement`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-handoff-'))
    const h = fixture({ cli, toolsOn: undefined, dir })
    try {
      // The fresh part opens with its package as a turn of its own, which the Bot team answers
      // itself (HANDOFF_ACK) without reaching the agent; DSH logs that answer on the route.
      const messages = [
        handoff('[Handoff · part 2]\n## Handoff note\nthe deploy key is hunter2; finish the report'),
        answer('Noted. I have my handoff note and carry on from here.', ROUTE),
      ]
      await agentTurn(h, messages, 'plain go on')
      const [first] = prompts(h)
      assert.match(first.text, /Handoff \(not from the user\): \[Handoff · part 2\]/)
      assert.match(first.text, /finish the report/)
      assert.match(first.text, /\[secret:TOKEN\]/)
      assert.equal(first.text.includes('hunter2'), false)
      assert.ok(first.text.endsWith('plain go on'))
      assert.equal(rows(h, NOTICE_KIND).length, 0)
    } finally {
      h.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("a handoff in the turn's own messages stays in the prompt beside the person's words, redacted", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-dsh-a5-handoff-turn-'))
  const h = fixture({ cli: 'codex', toolsOn: false, dir })
  try {
    // A resumed part: the package, then the input the old part held, in one turn. Even with the
    // kill switch this is the turn's prompt, not a replay.
    const messages = [handoff('[Handoff · part 3]\nnote hunter2'), user('plain carried input')]
    const chunks = await step(h.adapter, messages)
    assert.equal(chunks.at(-1).reason.kind, 'stop')
    const [first] = prompts(h)
    assert.match(first.text, /\[Handoff · part 3\]/)
    assert.match(first.text, /note \[secret:TOKEN\]/)
    assert.ok(first.text.endsWith('plain carried input'))
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promptOf keeps a handoff with the person\'s words and drops DSH notes', () => {
  const note = { role: 'user', source: { kind: 'context' }, content: [{ type: 'text', text: 'DSH file policy' }] }
  const relay = { role: 'user', source: { kind: 'bot', form: 'relay' }, content: [{ type: 'text', text: 'another Bot' }] }
  assert.deepEqual(promptOf([handoff('pkg hunter2'), user('hi'), note], secret), [{ type: 'text', text: 'pkg [secret:TOKEN]\n\nhi' }])
  // The person's own words are never redacted here; only the carried package is.
  assert.deepEqual(promptOf([user('my hunter2')], secret), [{ type: 'text', text: 'my hunter2' }])
  // A relay that is not a handoff still gives way to the person's words, as before.
  assert.deepEqual(promptOf([relay, user('hi')]), [{ type: 'text', text: 'hi' }])
  assert.equal(isHandoff(handoff('x')), true)
  assert.equal(isHandoff(relay), false)
})

test('the replay renders a handoff, keeps the 120k cap and drops the oldest first', () => {
  assert.match(renderMessage(handoff('pkg')), /^Handoff \(not from the user\): pkg$/)
  // A handoff is clipped at its own cap, larger than a message's.
  const big = renderMessage(handoff('h'.repeat(70_000)))
  assert.ok(big.length < 61_000 && big.length > 59_000)
  const filler = Array.from({ length: 40 }, (_, i) => user(`${i} ${'x'.repeat(7_000)}`))
  const blocks = replayBlocks([handoff('old package'), ...filler], { redact: text => text, to: 'Fake agent', renewed: true })
  const total = blocks.slice(2).reduce((sum, block) => sum + block.text.length, 0)
  assert.ok(total <= 120_000)
  assert.match(blocks[0].text, /before this new Fake agent session/)
  assert.match(blocks[1].text, /earlier messages? left out here/)
  assert.equal(blocks.some(block => block.text.includes('old package')), false)
})

test('missedBy is what a live session missed: after its own last answer, only when another answered', () => {
  const synthetic = { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', synthetic: SYNTHETIC_KIND }, content: [] }
  assert.equal(missedBy([user('q'), answer('a', ROUTE)], ROUTE), undefined)
  assert.equal(missedBy([user('q'), answer('a', ROUTE), user('unanswered')], ROUTE), undefined)
  // A bridge's synthetic block is not an answer from elsewhere.
  assert.equal(missedBy([user('q'), answer('a', ROUTE), synthetic], ROUTE), undefined)
  const other = [user('q'), answer('a', ROUTE), user('q2'), answer('b'), user('q3')]
  assert.deepEqual(missedBy(other, ROUTE), other.slice(2))
  // Another agent's answer counts as elsewhere too.
  assert.deepEqual(missedBy([answer('c', 'acp-codex')], ROUTE), [answer('c', 'acp-codex')])
  assert.equal(answered([user('q')]), false)
  assert.equal(answered([synthetic]), false)
  assert.equal(answered([answer('a')]), true)
})
