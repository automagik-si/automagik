import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { projectListing, resolveScheduler, runScheduler } from '../src/host/automations.js'
import { automationFixture, automationHost, DIGEST, fixturePath } from './fixtures/automations-host.mjs'

const LIST = 'automations-list', PUT = 'automations-put', REMOVE = 'automations-remove'
const SENTINEL = 'do-not-display-this-test-sentinel'
const DEFAULT_ENTRY = { name: 'Morning review', cron: '0 9 * * 1-5', agent: 'claude', workspace: 'root', prompt: 'Summarize this folder.' }
const next = '2099-06-01T09:00:00Z'
const entryAt = repo => ({ ...DEFAULT_ENTRY, repo })
const toolOptions = [
  { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } },
  { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' },
]
const valueOf = async (host, endpoint, payload, options) => {
  const reply = await host.call(endpoint, payload, options)
  assert.equal(reply.ok, true)
  assert.equal(JSON.stringify(reply).includes(SENTINEL), false)
  return reply.value
}

test('the real dispatcher refuses agents, share viewers and unmarked owners without a CLI call', async t => {
  const f = automationFixture(t)
  const host = automationHost(t, f)
  for (const endpoint of [LIST, PUT, REMOVE]) {
    for (const principal of toolOptions) {
      assert.equal((await host.request(endpoint, {}, { peer: { principal } })).status, 403)
    }
    for (const marker of [null, DIGEST, 'bad-marker']) {
      assert.deepEqual(await valueOf(host, endpoint, {}, { marker }), { reason: 'desktop-only' })
    }
  }
  assert.deepEqual(f.calls(), [])
})

test('a marked owner on a read-only host can list, and mutations including Preview never reach the CLI', async t => {
  const f = automationFixture(t)
  const host = automationHost(t, f, { readOnly: 'This host is read only' })
  for (const [endpoint, payload] of [[PUT, { entry: entryAt(f.root), dryRun: true }], [PUT, { entry: entryAt(f.root) }], [REMOVE, { name: 'Sample', rev: 'a'.repeat(16) }]]) {
    assert.equal((await host.call(endpoint, payload)).error.code, 'bot/read-only')
  }
  assert.deepEqual(f.calls(), [])
  assert.equal((await valueOf(host, LIST)).installed, true)
  assert.deepEqual(f.calls().map(row => row.argv), [['version'], ['ls', '--json']])
})

for (const shape of ['pinned', 'current']) {
  test(`lists the ${shape} shape with display fields and fixed diagnostics only`, async t => {
    const f = automationFixture(t, {
      paused: true,
      automations: [
        { ...entryAt('r'.repeat(350)), next, last: { status: 'failed', at: next, error: SENTINEL, stderr: SENTINEL }, prompt: SENTINEL, agent_args: [SENTINEL] },
        { name: 'Workflow', workflow: SENTINEL, workspace: 'existing', template: 'sample-template', disabled: true, last: null },
        { name: 'Command', command: { argv: [SENTINEL], env: { SECRET: SENTINEL } }, last: null },
        { name: 'Target', target: SENTINEL, last: null },
        { name: '-unsafe' }, { name: 'a'.repeat(65) }, { name: 'control\u0001' },
      ],
      invalid: [{ name: 'Broken', line: 12, message: SENTINEL }],
      unknown: { value: SENTINEL },
    })
    if (shape === 'current') {
      f.env.FAKE_AUTOMATIONS_SHAPE = 'current'
      f.env.FAKE_AUTOMATIONS_VERSION = '0.13.0'
    } else delete f.env.FAKE_AUTOMATIONS_SHAPE
    const view = await valueOf(automationHost(t, f), LIST)
    assert.equal(view.ours, shape === 'pinned')
    assert.equal(view.version, shape === 'pinned' ? '0.12.1-am.1-fake' : '0.13.0')
    assert.equal(view.paused, true)
    assert.equal(view.schedulerRunning, true)
    assert.deepEqual(view.automations.slice(0, 4).map(row => row.kind), ['prompt', 'workflow', 'command', 'prompt'])
    assert.deepEqual(view.automations[0], {
      name: DEFAULT_ENTRY.name, removeName: DEFAULT_ENTRY.name, rev: view.automations[0].rev,
      cron: DEFAULT_ENTRY.cron, repo: 'r'.repeat(300), workspace: 'root', agent: 'claude', model: '', template: '',
      kind: 'prompt', hasTarget: false, disabled: false, next, last: { status: 'failed', at: next },
    })
    assert.equal(view.automations[1].template, 'sample-template')
    assert.equal(view.automations[1].last, null)
    assert.equal(view.automations[3].hasTarget, true)
    assert.ok(view.automations.slice(4).every(row => !Object.hasOwn(row, 'removeName')))
    assert.deepEqual(view.invalid, [{ name: 'Broken', removeName: 'Broken', rev: view.invalid[0].rev, line: 12,
      message: "This entry does not load. Fix it in the scheduler's file (line 12)." }])
  })
}

test('Preview and Save send explicit agent defaults and only create fields, with Preview preserving the original bytes', async t => {
  const f = automationFixture(t, { control: { checkPut: true } })
  const host = automationHost(t, f)
  const entry = { ...entryAt(f.root), name: 'Review: morning', prompt: 'First line\n\tMore detail.', close_workspace: 'on-success',
    agent_args: ['--dangerously-skip-permissions'], command: { argv: ['false'] }, model: 'other', target: 'worker:unknown' }
  const bytes = f.bytes()
  assert.equal((await valueOf(host, PUT, { entry, dryRun: true })).next[0], next)
  assert.deepEqual(f.bytes(), bytes)
  assert.equal((await valueOf(host, PUT, { entry })).next[0], next)
  assert.deepEqual(f.read().automations.map(({ line, next, disabled, last, ...saved }) => saved), [
    { ...entryAt(f.root), name: entry.name, prompt: entry.prompt, agent_args: [], timeout_minutes: 60 },
  ])
  for (const dryRun of [true, false]) {
    assert.deepEqual(await valueOf(host, PUT, { entry, dryRun }), { problem: 'An automation with this name already exists.' })
  }
  assert.deepEqual(f.calls().filter(call => call.argv[0] === 'put'), [
    { argv: ['put', '--dry-run'], stdin: true }, { argv: ['put'], stdin: true },
    { argv: ['put', '--dry-run'], stdin: true }, { argv: ['put'], stdin: true },
  ])
})

test('create validation precedes every scheduler call, and checks worktree HEAD for Preview and Save', async t => {
  const f = automationFixture(t)
  const host = automationHost(t, f, { loginTextMatches: text => text.includes(SENTINEL) })
  const entry = entryAt(f.root)
  const bad = [
    ...['', ' ', '-flag', '--json', 'a'.repeat(65), 'line\nbreak', 'control\u0085'].map(name => ({ name })),
    ...['', '  ', ' \n--flag', 'Text\0', 'Text\r', 'Text\x1b', 'Text\u007f', 'a'.repeat(8001), SENTINEL].map(prompt => ({ prompt })),
    { agent: 'pi' }, { agent: 'constructor' }, { cron: '  ' },
    { repo: '.' }, { repo: fixturePath }, { repo: join(f.root, 'missing') }, { workspace: 'existing' },
    { timeout_minutes: 0 }, { timeout_minutes: 1.5 }, { workspace: 'worktree' }, { original: 'old' },
  ]
  for (const patch of bad) {
    for (const dryRun of [true, false]) assert.equal(typeof (await valueOf(host, PUT, { entry: { ...entry, ...patch }, dryRun })).problem, 'string')
  }
  assert.match((await valueOf(host, PUT, { entry: { ...entry, prompt: SENTINEL } })).problem, /sign-in code/)
  assert.match((await valueOf(host, PUT, { entry, original: 'old' })).problem, /Only new/)
  assert.match((await valueOf(host, PUT, { entry, dryRun: 'true' })).problem, /Only new/)
  for (const [agent, words] of Object.entries({
    codex: 'exec e resume login logout mcp mcp-server app-server apply a completion debug sandbox cloud help proto generate-ts',
    claude: 'config mcp migrate-installer setup-token doctor update install help',
  })) {
    for (const word of words.split(' ')) {
      assert.deepEqual(await valueOf(host, PUT, { entry: { ...entry, agent, prompt: ` \t${word.toUpperCase()}\nargument` }, dryRun: true }),
        { problem: "Start the prompt with words, not a command name like 'resume'." })
    }
  }
  assert.deepEqual(f.calls(), [])
  const worktree = { ...entry, workspace: 'worktree', repo: fileURLToPath(new URL('../../..', import.meta.url)) }
  assert.equal((await valueOf(host, PUT, { entry: worktree, dryRun: true })).next[0], next)
  assert.equal((await valueOf(host, PUT, { entry: worktree })).next[0], next)
})

test('scheduler problems and CLI failures use fixed text in every response', async t => {
  const f = automationFixture(t)
  const host = automationHost(t, f)
  const entry = { ...entryAt(f.root), name: 'Review: morning' }
  for (const [problem, message] of [
    [`${entry.name}: missing repo ${SENTINEL}`, 'Choose a folder.'],
    [`${entry.name}: invalid cron "${SENTINEL}"`, 'The schedule is not a valid cron expression.'],
    [SENTINEL, 'The scheduler refused this automation.'],
  ]) {
    f.write({ ...f.read(), control: { put: { problem } } })
    for (const dryRun of [true, false]) assert.deepEqual(await valueOf(host, PUT, { entry, dryRun }), { problem: message })
  }
  for (const [fault, reason, message] of [
    [{ stderr: SENTINEL, exit: 5 }, 'cli-error', 'The scheduler could not do this.'],
    [{ text: SENTINEL }, 'cli-protocol', 'The scheduler returned an unexpected reply.'],
    [{ text: '{}' }, 'cli-protocol', 'The scheduler returned an unexpected reply.'],
    [{ stderr: SENTINEL, overflow: 2 * 1024 * 1024 + 1 }, 'cli-overflow', 'The scheduler returned too much data.'],
  ]) {
    f.write({ ...f.read(), control: { ls: fault } })
    assert.deepEqual(await valueOf(host, LIST), { reason, message })
  }
  f.write({ ...f.read(), control: { ls: { delay: 3000 } } })
  await assert.rejects(runScheduler(fixturePath, ['ls', '--json'], { env: f.env, timeoutMs: 100 }), { cause: 'cli-timeout', message: 'The scheduler took too long to reply.' })
})

test('version, Preview, Save and Remove failures expose no scheduler output', async t => {
  const f = automationFixture(t)
  const host = automationHost(t, f)
  const entry = entryAt(f.root)
  f.write({ ...f.read(), control: { version: { stderr: SENTINEL, exit: 4 } } })
  assert.deepEqual(await valueOf(host, LIST), { reason: 'cli-error', message: 'The scheduler could not do this.' })
  for (const dryRun of [true, false]) {
    f.write({ ...f.read(), control: { put: { stderr: SENTINEL, exit: 4 } } })
    assert.deepEqual(await valueOf(host, PUT, { entry, dryRun }), { reason: 'cli-error', message: 'The scheduler could not do this.' })
  }
  f.write({ ...f.read(), automations: [entry], control: {} })
  const [row] = (await valueOf(host, LIST)).automations
  f.write({ ...f.read(), control: { rm: { stderr: SENTINEL, exit: 4 } } })
  assert.deepEqual(await valueOf(host, REMOVE, { name: row.removeName, rev: row.rev }),
    { reason: 'cli-error', message: 'The scheduler could not do this.' })
  assert.deepEqual(f.read().automations, [entry])
})

test('removal checks the exact name and stable digest across run updates, duplicates, missing and changed entries', async t => {
  const name = ' Morning review  '
  const f = automationFixture(t, { automations: [{ name, prompt: 'Original', extra: { b: 2, a: 1 } }] })
  const host = automationHost(t, f)
  const [row] = (await valueOf(host, LIST)).automations
  const expected = createHash('sha256').update(JSON.stringify({ extra: { a: 1, b: 2 }, name, prompt: 'Original' })).digest('hex').slice(0, 16)
  assert.equal(row.rev, expected)
  const request = { name: row.removeName, rev: row.rev }
  assert.equal((await valueOf(host, REMOVE, { ...request, name: name.trim() })).reason, 'gone')
  const stable = { name, prompt: 'Original', extra: { a: 1, b: 2 }, last: { status: 'running' }, next, line: 55 }
  f.write({ ...f.read(), automations: [stable], invalid: [{ name, line: 7, message: SENTINEL }] })
  assert.equal((await valueOf(host, REMOVE, request)).reason, 'changed')
  f.write({ ...f.read(), automations: [{ ...stable, prompt: 'Changed' }], invalid: [] })
  assert.equal((await valueOf(host, REMOVE, request)).reason, 'changed')
  assert.equal(f.calls().some(call => call.argv[0] === 'rm'), false)
  f.write({ ...f.read(), automations: [stable] })
  assert.deepEqual(await valueOf(host, REMOVE, request), { removed: true })
  assert.deepEqual(f.calls().at(-1), { argv: ['rm', name], stdin: false })
  assert.equal((await valueOf(host, REMOVE, request)).reason, 'gone')

  f.write({ ...f.read(), invalid: [{ name: 'Broken', line: 9, message: 'bad cron' }] })
  const [broken] = (await valueOf(host, LIST)).invalid
  assert.deepEqual(await valueOf(host, REMOVE, { name: broken.removeName, rev: broken.rev }), { removed: true })
  assert.deepEqual(f.read().invalid, [])
  for (const name of ['-unsafe', '--json', 'control\x1b', 'a'.repeat(65)]) {
    const count = f.calls().length
    assert.equal((await valueOf(host, REMOVE, { name, rev: row.rev })).reason, 'changed')
    assert.equal(f.calls().length, count)
  }
  const [before] = projectListing({ ...f.read(), automations: [stable] }).automations
  assert.equal(before.rev, expected)
})

test('concurrent creates are serialized through the scheduler and report a duplicate', async t => {
  const f = automationFixture(t, { control: { put: { delay: 100 } } })
  const host = automationHost(t, f)
  const entry = entryAt(f.root)
  const answers = await Promise.all([valueOf(host, PUT, { entry }), valueOf(host, PUT, { entry })])
  assert.equal(answers.filter(answer => answer.next?.[0] === next).length, 1)
  assert.equal(answers.filter(answer => answer.problem === 'An automation with this name already exists.').length, 1)
  assert.deepEqual(f.calls().map(call => call.argv[0]), ['version', 'put', 'version', 'put'])
})

test('discovery trusts the install folders and an invalid exclusive override never falls through', async t => {
  const f = automationFixture(t)
  const pathDirectory = join(f.root, 'path')
  const installDirectory = join(f.root, '.local/bin')
  mkdirSync(pathDirectory)
  mkdirSync(installDirectory, { recursive: true })
  const pathOnly = join(pathDirectory, 'herdr-automations')
  const local = join(installDirectory, 'herdr-automations')
  copyFileSync(fixturePath, pathOnly)
  const { HERDR_AUTOMATIONS, ...discovery } = f.env
  discovery.PATH = pathDirectory
  assert.notEqual(resolveScheduler(discovery), pathOnly)
  copyFileSync(fixturePath, local)
  assert.equal(resolveScheduler(discovery), local)
  assert.equal(resolveScheduler(f.env), fixturePath)
  const nonExecutable = join(f.root, 'non-executable')
  writeFileSync(nonExecutable, '')
  chmodSync(nonExecutable, 0o644)
  const host = automationHost(t, f)
  for (const override of ['', '.', pathDirectory, join(f.root, 'missing'), nonExecutable]) {
    f.env.HERDR_AUTOMATIONS = override
    assert.equal((await valueOf(host, LIST)).reason, 'not-installed')
  }
  assert.deepEqual(f.calls(), [])
})
