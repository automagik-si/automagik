// node --test chat/find.test.mjs: which agent, and where its transcript is. Temp homes only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentOf, claudeSlug, findTranscript, ompSlug } from './find.js'
import { fakeTerminal } from './fake-hc.mjs'

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'chat-find-')))
  const file = (rel, text = '', mtime) => {
    const p = join(home, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
    if (mtime) utimesSync(p, mtime / 1000, mtime / 1000)
    return p
  }
  return { home, file, appHome: join(home, '.config/herdr-app') }
}

test('agentOf reads status.app first, then the foreground program, then argv', () => {
  assert.equal(agentOf({ status: { app: 'claude-code' } }), 'claude')
  assert.equal(agentOf({ status: { app: 'codex' } }), 'codex')
  assert.equal(agentOf({ status: { app: 'omp' } }), 'omp')
  assert.equal(agentOf({ argv: ['zsh'], foreground: { name: 'codex', argv: ['/opt/bin/codex'] } }), 'codex')
  assert.equal(agentOf({ argv: ['/usr/local/bin/omp'], foreground: { name: 'bun', argv: ['bun'] } }), 'omp')
  assert.equal(agentOf({ argv: ['zsh'], foreground: { name: 'vim', argv: ['vim'] }, status: { app: 'gemini' } }), null)
  assert.equal(agentOf({ status: { app: 'toString' }, argv: ['__proto__'] }), null)
})

test('folder slugs match Claude and omp', () => {
  assert.equal(claudeSlug('/home/u/workspace/repo/.claude/worktrees/a_b'), '-home-u-workspace-repo--claude-worktrees-a-b')
  assert.equal(ompSlug('/home/u/workspace/repo/.claude/worktrees/x', '/home/u'), '-workspace-repo-.claude-worktrees-x')
  assert.equal(ompSlug('/home/u', '/home/u/'), '-')
  assert.equal(ompSlug('/srv/data', '/home/u'), '-srv-data')
})

test('1. the agent.transcript label wins, through the folder rule', () => {
  const { home, file } = sandbox()
  const p = file('.claude/projects/p/s1.jsonl')
  const t = fakeTerminal('t1', { labels: { 'agent.transcript': p, 'agent.session': 'other' } })
  assert.deepEqual(findTranscript(t, { home }), { agent: 'claude', source: 'label', local: p })
})

test('a label outside the folder is refused, logged once by folder and never with its path', () => {
  const { home, file } = sandbox()
  const key = file('.ssh/id_ed25519.jsonl')
  const lines = []
  const refused = new Set()
  const t = fakeTerminal('t1', { labels: { 'agent.transcript': key } })
  assert.equal(findTranscript(t, { home, log: (l) => lines.push(l), refused }).source, 'none')
  assert.equal(findTranscript(t, { home, log: (l) => lines.push(l), refused }).source, 'none')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\.claude\/projects/)
  assert.ok(!lines[0].includes('.ssh') && !lines[0].includes(home))
})

test('2. the workers ledger, last session row for the terminal with a transcript', () => {
  const { home, file, appHome } = sandbox()
  const a = file('.claude/projects/p/a.jsonl')
  const b = file('.claude/projects/p/b.jsonl')
  file('.config/herdr-app/automagik-herdr/workers.jsonl', [
    { event: 'session', terminal: 't1', session: 'a', transcript: a, at: '2026-11-03T10:00:00Z' },
    { event: 'start', terminal: 't1' },
    { event: 'session', terminal: 't2', session: 'x', transcript: a, at: '2026-11-03T10:01:00Z' },
    'not json',
    { event: 'session', terminal: 't1', session: 'b', transcript: b, at: '2026-11-03T10:02:00Z' },
    { event: 'session', terminal: 't1', session: 'c', transcript: null, at: '2026-11-03T10:03:00Z' }
  ].map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')
  assert.deepEqual(findTranscript(fakeTerminal('t1'), { home, appHome }), { agent: 'claude', source: 'ledger', local: b })
})

test('3. derived from agent.session for Claude, in the folder for the pane cwd', () => {
  const { home, file } = sandbox()
  const cwd = join(home, 'proj')
  const p = file(`.claude/projects/${claudeSlug(cwd)}/00000000-0000-4000-8000-000000000001.jsonl`)
  const t = fakeTerminal('t1', { cwd, labels: { 'agent.session': '00000000-0000-4000-8000-000000000001' } })
  assert.deepEqual(findTranscript(t, { home }), { agent: 'claude', source: 'derived', local: p })
  const bad = fakeTerminal('t1', { cwd, labels: { 'agent.session': '../../.ssh/id' } })
  // Not derived from a session id that is not one; with discovery off (a sibling pane), nothing.
  assert.deepEqual(findTranscript(bad, { home, siblings: 1 }), { agent: 'claude', source: 'none', reason: 'shared-folder' })
})

test('4. discovery: exactly one fresh transcript for the cwd, never a guess', () => {
  const { home, file } = sandbox()
  const cwd = join(home, 'proj')
  const dir = `.claude/projects/${claudeSlug(cwd)}`
  file(`${dir}/old.jsonl`, '', 1_000_000)
  const fresh = file(`${dir}/new.jsonl`, '', 3_000_000)
  const t = fakeTerminal('t1', { cwd, created: 2_000_000 })
  assert.deepEqual(findTranscript(t, { home }), { agent: 'claude', source: 'discovered', local: fresh })
  assert.deepEqual(findTranscript(t, { home, siblings: 1 }), { agent: 'claude', source: 'none', reason: 'shared-folder' })
  file(`${dir}/second.jsonl`, '', 3_500_000)
  assert.deepEqual(findTranscript(t, { home }), { agent: 'claude', source: 'none', reason: 'ambiguous' })
})

test('4. discovery for Codex reads the rollout cwd, for omp the session record', () => {
  const { home, file } = sandbox()
  const cwd = join(home, 'proj')
  const now = Date.UTC(2026, 10, 3, 12)
  const d = new Date(now)
  const day = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  const meta = (c) => JSON.stringify({ type: 'session_meta', payload: { cwd: c } }) + '\n'
  const mine = file(`.codex/sessions/${day}/rollout-a.jsonl`, meta(cwd), now)
  file(`.codex/sessions/${day}/rollout-b.jsonl`, meta(join(home, 'other')), now)
  const codex = fakeTerminal('t1', { app: 'codex', argv: ['codex'], cwd, created: now - 60_000 })
  assert.deepEqual(findTranscript(codex, { home, now }), { agent: 'codex', source: 'discovered', local: mine })

  const session = (c) => [JSON.stringify({ type: 'title', title: 'x' }), JSON.stringify({ type: 'session', cwd: c })].join('\n') + '\n'
  const omp = file(`.omp/agent/sessions/${ompSlug(cwd, home)}/2026-11-03_a.jsonl`, session(cwd), now)
  const ompTerminal = fakeTerminal('t2', { app: 'omp', argv: ['omp'], cwd, created: now - 60_000 })
  assert.deepEqual(findTranscript(ompTerminal, { home, now }), { agent: 'omp', source: 'discovered', local: omp })
})

test('a discovered file that is a link out of the folder is refused', () => {
  const { home, file } = sandbox()
  const cwd = join(home, 'proj')
  const secret = file('secret.jsonl')
  const dir = join(home, `.claude/projects/${claudeSlug(cwd)}`)
  mkdirSync(dir, { recursive: true })
  symlinkSync(secret, join(dir, 'evil.jsonl'))
  const t = fakeTerminal('t1', { cwd, created: 1 })
  assert.deepEqual(findTranscript(t, { home }), { agent: 'claude', source: 'none', reason: 'refused' })
})

test('5. none: an agent with no decoder, or nothing found', () => {
  const { home } = sandbox()
  assert.deepEqual(findTranscript(fakeTerminal('t1', { app: 'gemini', argv: ['gemini'] }), { home }), { agent: null, source: 'none', reason: 'no-decoder' })
  assert.deepEqual(findTranscript(fakeTerminal('t1', { cwd: join(home, 'x') }), { home }), { agent: 'claude', source: 'none', reason: 'not-found' })
})

test('another machine: label or derived, as a home-relative path read with on from the address', () => {
  const { home } = sandbox()
  const labelled = fakeTerminal('box/t3', { labels: { 'agent.transcript': '/home/u/.claude/projects/p/s.jsonl' } })
  assert.deepEqual(findTranscript(labelled, { home }), { agent: 'claude', source: 'label', remote: { on: 'box', path: '.claude/projects/p/s.jsonl' } })
  const derived = fakeTerminal('box/t3', { cwd: '/home/u/proj', labels: { 'agent.session': 'abc-123' } })
  assert.deepEqual(findTranscript(derived, { home }), { agent: 'claude', source: 'derived', remote: { on: 'box', path: '.claude/projects/-home-u-proj/abc-123.jsonl' } })
  const escape = fakeTerminal('box/t3', { labels: { 'agent.transcript': '/home/u/.claude/projects/../../.ssh/k.jsonl' } })
  assert.deepEqual(findTranscript(escape, { home }), { agent: 'claude', source: 'none', reason: 'remote-unlabelled' })
  const bare = fakeTerminal('box/t3')
  assert.deepEqual(findTranscript(bare, { home }), { agent: 'claude', source: 'none', reason: 'remote-unlabelled' })
  const wrongFolder = fakeTerminal('box/t3', { labels: { 'agent.transcript': '/home/u/.ssh/s.jsonl' } })
  assert.equal(findTranscript(wrongFolder, { home }).source, 'none')
})

test('no discovery without when the pane started: every file would look fresh', () => {
  const { home, file } = sandbox()
  const cwd = join(home, 'proj')
  file(`.claude/projects/${claudeSlug(cwd)}/s.jsonl`)
  for (const created of [undefined, 0, -5, Number.NaN, '2026']) {
    const t = { ...fakeTerminal('t1', { cwd }), created_ms: created }
    assert.deepEqual(findTranscript(t, { home }), { agent: 'claude', source: 'none', reason: 'no-start' }, String(created))
  }
})
