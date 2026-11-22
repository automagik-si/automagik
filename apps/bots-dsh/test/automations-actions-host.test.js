import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { automationFixture, automationHost, DIGEST } from './fixtures/automations-host.mjs'

const LIST = 'automations-list', ENTRY = 'automations-entry', PUT = 'automations-put'
const RUN = 'automations-run', PAUSE = 'automations-pause', HISTORY = 'automations-history'
const AT = '2099-06-01T09:00:00Z', STARTED = '2099-06-01T08:58:55.000000001Z'
const NAME = ' Morning review  '
const SECRET = 'synthetic-private-field'
const agents = [
  { kind: 'share-viewer', shareId: 'share', actor: { providerId: 'p', tenantId: 't', subjectId: 's' } },
  { kind: 'agent', sessionId: 'session-341a3de3-87c4-4dda-b228-67efca79821b' },
]
const draft = (repo, name = NAME) => ({
  name, cron: '0 9 * * 1-5', repo, workspace: 'root', agent: 'codex', prompt: 'Summarize the folder.', timeout_minutes: 60,
})
const entryAt = (repo, name) => ({
  ...draft(repo, name), catch_up_minutes: 120, blocked_grace_minutes: 2, disabled: false, line: 2, next: AT, last: null,
})
const binding = row => ({ name: row.removeName, rev: row.rev })
const matchingCalls = (f, ...verbs) => f.calls().filter(({ argv }) => verbs.includes(argv[0]))
const read = async (host, endpoint, payload, options) => {
  const result = await host.call(endpoint, payload, options)
  assert.equal(result.ok, true)
  return result.value
}
function setup(t, extra = {}, options) {
  const f = automationFixture(t)
  f.env.FAKE_AUTOMATIONS_SHAPE = 'am2'
  f.env.FAKE_AUTOMATIONS_VERSION = '0.12.1-am.2'
  const seed = entryAt(f.root)
  f.write({ ...f.read(), automations: [seed], ...extra })
  const host = automationHost(t, f, options)
  const call = (endpoint, payload) => read(host, endpoint, payload)
  const list = () => call(LIST)
  const original = async () => binding((await list()).automations[0])
  const put = (original, patch = {}, dryRun = false) => call(PUT, { original, dryRun, entry: { ...draft(f.root), ...patch } })
  return { f, host, seed, call, list, original, put }
}

test('only a marked owner window may reach any new scheduler action', async t => {
  const { f, host } = setup(t)
  const original = { name: NAME, rev: 'a'.repeat(16) }
  for (const [endpoint, payload] of [
    [ENTRY, original], [RUN, original], [PAUSE, { ...original, paused: true }], [HISTORY, { name: NAME }],
    [PUT, { original, entry: draft(f.root) }],
  ]) {
    for (const principal of agents) assert.equal((await host.request(endpoint, payload, { peer: { principal } })).status, 403)
    for (const marker of [null, DIGEST, 'bad-marker']) {
      assert.deepEqual(await read(host, endpoint, payload, { marker }), { reason: 'desktop-only' })
    }
  }
  assert.deepEqual(f.calls(), [])
})

test('a read-only owner can fetch history and edit fields but cannot run, pause, preview or save', async t => {
  const { f, host, call, original } = setup(t, {}, { readOnly: 'read only' })
  const bound = await original()
  assert.deepEqual(await call(HISTORY, { name: NAME }), { runs: [] })
  assert.deepEqual((await call(ENTRY, bound)).entry, draft(f.root))
  const count = f.calls().length
  for (const [endpoint, payload] of [
    [RUN, bound], [PAUSE, { ...bound, paused: true }], [PAUSE, { ...bound, paused: false }],
    ...[true, false].map(dryRun => [PUT, { original: bound, entry: draft(f.root), dryRun }]),
  ]) assert.equal((await host.call(endpoint, payload)).error.code, 'bot/read-only')
  assert.equal(f.calls().length, count)
})

test('am.2 listing adds aligned details and keeps the projected row contract', async t => {
  const { f, seed, list, call } = setup(t, {}, { loginTextMatches: prompt => prompt === SECRET })
  const kinds = {
    Command: { command: { argv: [SECRET] } }, Workflow: { workflow: SECRET }, Template: { template: 'daily' },
    Target: { target: 'worker:one' }, Busy: { target_when_busy: 'queue' },
    Existing: { workspace: 'existing', workspace_id: 'workspace-1' }, 'Workspace id': { workspace_id: 'workspace-1' },
    Oversize: { prompt: 'x'.repeat(8001) }, Dash: { prompt: ' -a' }, CommandWord: { prompt: 'Resume this' },
    Control: { prompt: 'Text\x1b' }, SignIn: { prompt: SECRET }, OtherAgent: { agent: 'pi' }, Duplicate: {}, '-unsafe': {},
  }
  f.write({
    ...f.read(),
    automations: [
      { ...seed, last: { status: 'failed', at: AT, trigger: 'cron', stderr: SECRET } },
      { ...seed, name: 'Later', last: { status: SECRET, at: '2099-06-01', trigger: SECRET } },
      ...Object.entries(kinds).map(([name, patch]) => ({ ...seed, ...patch, name })),
    ],
    invalid: [{ name: 'Duplicate', line: 20 }],
  })
  const view = await list()
  assert.deepEqual(view.automations[0], {
    name: NAME, removeName: NAME, rev: view.automations[0].rev, cron: seed.cron, repo: f.root,
    workspace: 'root', agent: 'codex', model: '', template: '', kind: 'prompt',
    hasTarget: false, disabled: false, next: AT, last: { status: 'failed', at: AT },
  })
  assert.deepEqual(view.automations[1].last, { status: 'unknown', at: null })
  assert.equal(JSON.stringify(view).includes(SECRET), false)
  assert.deepEqual(view.details, view.automations.map(({ name }, i) => ({
    run: !['Duplicate', '-unsafe'].includes(name), pause: !['Duplicate', '-unsafe'].includes(name),
    edit: i < 2, lastTrigger: i === 0 ? 'cron' : null,
  })))
  for (const row of view.automations.slice(2, -2)) {
    assert.deepEqual(await call(ENTRY, binding(row)), { reason: 'not-editable' })
  }
})

test('scheduler versions gate edit consistently for listing, entry and put', async t => {
  const { f, list, call, put } = setup(t)
  for (const [version, editable] of [
    ['dev', false], ['0.11.9', false], ['0.12.0-rc.1', false], ['0.12.1-am_bad', false],
    ['0.12.0+build..x', false], ['01.12.0', false],
    ['0.12.0', true], ['v0.12.0+build', true], ['0.12.1-am.2', true],
  ]) {
    f.env.FAKE_AUTOMATIONS_VERSION = version
    const view = await list()
    const original = binding(view.automations[0])
    assert.deepEqual(view.details[0], { run: true, pause: true, edit: editable, lastTrigger: null })
    assert.equal(Boolean((await call(ENTRY, original)).entry), editable)
    const result = await put(original)
    if (editable) assert.deepEqual(result, { next: [], unchanged: true })
    else assert.match(result.problem, /Editing needs scheduler 0.12 or later/)
  }
  f.env.FAKE_AUTOMATIONS_VERSION = 'malformed'
  assert.equal((await list()).reason, 'cli-protocol')
  assert.equal((await call(ENTRY, { name: NAME, rev: 'a'.repeat(16) })).reason, 'cli-protocol')
  assert.match((await put({ name: NAME, rev: 'a'.repeat(16) })).problem, /Editing needs scheduler 0.12 or later/)
  assert.deepEqual(matchingCalls(f, 'put'), [])
})

test('listing and history reject impossible run timestamps', async t => {
  const { f, call, list } = setup(t)
  const invalidDates = [
    '2026-02-30T09:00:00Z', '2100-02-29T09:00:00Z', '2026-04-31T09:00:00Z',
    '2026-01-00T09:00:00Z', '2026-00-01T09:00:00Z', '2026-13-01T09:00:00Z',
    '2026-02-28T24:00:00Z', '2026-02-28T09:60:00Z', '2026-02-28T09:00:60Z',
    '2026-02-28T09:00:00+24:00', '2026-02-28T09:00:00-00:60',
  ]
  const leapDay = '2000-02-29T23:59:59.123456789+23:59'
  const run = { automation: NAME, status: 'done', trigger: 'cron', started: STARTED, seconds: 65 }
  const history = [
    ...invalidDates.map(at => ({ ...run, at })),
    { ...run, at: AT, started: invalidDates[0] },
    { ...run, at: leapDay, started: '2000-02-29T23:58:54.123456789+23:59' },
  ]
  f.write({ ...f.read(), history })
  assert.deepEqual((await list()).automations[0].last, { status: 'done', at: null })
  const { runs } = await call(HISTORY, { name: NAME })
  assert.deepEqual(runs.map(({ at, started, seconds }) => [at, started, seconds]), [
    ...invalidDates.map(() => [null, STARTED, null]),
    [AT, null, null],
    [leapDay, history.at(-1).started, 65],
  ])
})

test('history filters before capping, preserves order and projects only run summaries', async t => {
  const { f, call } = setup(t)
  const full = {
    automation: NAME, status: 'failed', trigger: 'manual', at: AT, started: STARTED, seconds: 65, exit_code: 0,
    run_id: SECRET, error: SECRET, result: SECRET, stderr: SECRET, space: SECRET, terminal: SECRET,
    target: SECRET, notified: SECRET, seen: true,
  }
  const invalid = { ...full, status: SECRET, trigger: SECRET, started: '0001-01-01T00:00:00Z', at: '09:00', exit_code: '2' }
  const rows = [null, { ...full, automation: 'Another' }, full, invalid,
    { ...full, trigger: undefined, started: AT, at: '2099-06-01', exit_code: -1 },
    ...Array.from({ length: 22 }, (_, exit_code) => ({ ...full, status: 'done', trigger: 'catchup', exit_code })),
  ]
  f.write({ ...f.read(), control: { history: { text: JSON.stringify(rows) } } })
  const { runs } = await call(HISTORY, { name: NAME })
  assert.equal(runs.length, 20)
  assert.deepEqual(runs.slice(0, 3), [
    { status: 'failed', trigger: 'manual', started: STARTED, at: AT, seconds: 65, exitCode: 0 },
    { status: 'unknown', trigger: null, started: null, at: null, seconds: null, exitCode: null },
    { status: 'failed', trigger: null, started: AT, at: null, seconds: null, exitCode: -1 },
  ])
  assert.deepEqual(runs.slice(3).map(run => run.exitCode), Array.from({ length: 17 }, (_, i) => i))
  assert.deepEqual(f.calls().at(-1).argv, ['history', NAME, '--json'])
  assert.equal(JSON.stringify(runs).includes(SECRET), false)
  for (const [fault, reason, message] of [
    [{ text: '{}' }, 'cli-protocol', 'The scheduler returned an unexpected reply.'],
    [{ exit: 5, stderr: SECRET }, 'cli-error', 'The scheduler could not do this.'],
  ]) {
    f.write({ ...f.read(), control: { history: fault } })
    assert.deepEqual(await call(HISTORY, { name: NAME }), { reason, message })
  }
})

test('bad names, revisions and shapes make zero CLI calls', async t => {
  const { f, call, put } = setup(t)
  const rev = 'a'.repeat(16)
  for (const name of ['', '-x', '--all', '--json', '--bg', '--dry-run', 'a'.repeat(65), 'x\ny']) {
    assert.equal((await call(HISTORY, { name })).reason, 'changed')
    assert.equal((await call(RUN, { name, rev })).reason, 'changed')
    assert.equal((await call(PAUSE, { name, rev, paused: true })).reason, 'changed')
    assert.equal((await put({ name, rev })).reason, 'changed')
  }
  for (const body of [{ name: NAME, rev: 'x' }, { name: NAME, rev, extra: true }, []]) {
    assert.equal((await call(ENTRY, body)).reason, 'changed')
    assert.equal((await call(RUN, body)).reason, 'changed')
  }
  for (const body of [{ all: true, paused: true }, { name: NAME, rev, paused: 'yes' }, { name: NAME, rev, paused: true, all: false }]) {
    assert.equal((await call(PAUSE, body)).reason, 'changed')
  }
  assert.equal((await put({ name: NAME, rev: 'x' })).reason, 'changed')
  assert.equal((await call(HISTORY, { name: NAME, extra: true })).reason, 'changed')
  const entry = draft(f.root)
  for (const key of Object.keys(entry)) {
    const missing = { ...entry }
    delete missing[key]
    assert.equal((await call(PUT, { original: { name: NAME, rev }, entry: missing })).reason, 'changed')
  }
  for (const patch of [{ cron: '' }, { name: '--json' }, { prompt: 'x'.repeat(8001) }]) {
    assert.equal(typeof (await put({ name: NAME, rev }, patch)).problem, 'string')
  }
  assert.deepEqual(f.calls(), [])
})

test('edit rejects malformed originals and dry-run flags before discovery', async t => {
  const { f, call } = setup(t)
  const entry = draft(f.root)
  const original = { name: NAME, rev: 'a'.repeat(16) }
  for (const bad of [null, [], { ...original, extra: true }, { name: NAME }, { name: NAME, rev: 'x' }]) {
    const result = await call(PUT, { original: bad, entry, dryRun: false })
    if (bad === null || Array.isArray(bad)) assert.deepEqual(result, { problem: 'Only new automations can be created here.' })
    else assert.deepEqual(result, { reason: 'changed' })
  }
  for (const dryRun of ['false', 0, null]) {
    assert.deepEqual(await call(PUT, { original, entry, dryRun }), { problem: 'Only new automations can be created here.' })
  }
  assert.deepEqual(f.calls(), [])
})

test('run and pause bind the exact name and read state back independently of scheduling', async t => {
  const { f, seed, list, call, original } = setup(t, { paused: true, scheduler: 0, history: [] })
  assert.deepEqual(await call(RUN, await original()), { requested: true })
  assert.deepEqual(f.calls().at(-1).argv, ['run', NAME, '--bg'])
  assert.deepEqual(f.read().history, [])
  f.write({ ...f.read(), control: { runAppends: { automation: NAME, status: 'skipped', trigger: 'cron', at: AT } } })
  assert.deepEqual(await call(RUN, await original()), { requested: true })
  const view = await list()
  assert.deepEqual(view.automations[0].last, { status: 'skipped', at: AT })
  assert.equal(view.details[0].lastTrigger, 'cron')
  for (const paused of [true, false]) {
    assert.deepEqual(await call(PAUSE, { ...await original(), paused }), { done: true })
    assert.deepEqual(f.calls().at(-1).argv, [paused ? 'pause' : 'resume', NAME])
    const refreshed = await list()
    assert.equal(refreshed.automations[0].disabled, paused)
    assert.equal(refreshed.paused, true)
  }
  const others = [
    { command: { argv: ['sample'] } }, { workflow: 'daily' }, { template: 'daily' },
    { target: 'worker:one' }, { workspace: 'existing', workspace_id: 'test' }, { disabled: true },
  ]
  f.write({ ...f.read(), control: {}, automations: others.map((patch, i) => ({ ...seed, ...patch, name: 'Other ' + i })) })
  for (const row of (await list()).automations) {
    assert.deepEqual(await call(RUN, binding(row)), { requested: true })
    assert.deepEqual(await call(PAUSE, { ...binding(row), paused: !row.disabled }), { done: true })
  }
  assert.equal(f.calls().some(({ argv }) => argv.includes('--all')), false)
})

test('all bound actions reject stale or duplicate rows, and unnamed diagnostics block YAML writes', async t => {
  const { f, seed, original, call, list, put } = setup(t)
  const id = await original()
  for (const [automations, invalid, reason] of [
    [[], [], 'gone'], [[{ ...seed, prompt: 'Changed.' }], [], 'changed'],
    [[], [{ name: NAME, line: 3 }], 'changed'],
    [[{ ...seed, line: 3 }], [{ name: NAME, line: 4 }], 'changed'],
    [[{ ...seed, line: 4 }], [{ name: NAME, line: 3 }], 'changed'],
  ]) {
    f.write({ ...f.read(), automations, invalid })
    assert.equal((await call(ENTRY, id)).reason, reason)
    assert.equal((await call(RUN, id)).reason, reason)
    assert.equal((await call(PAUSE, { ...id, paused: true })).reason, reason)
    assert.equal((await put(id)).reason, reason)
  }
  for (const name of ['', null, 3, undefined]) {
    f.write({ ...f.read(), automations: [seed], invalid: [{ name, line: 3 }] })
    assert.deepEqual((await list()).details, [{ run: true, pause: false, edit: false, lastTrigger: null }])
    assert.equal((await call(ENTRY, id)).reason, 'not-editable')
    assert.equal((await call(PAUSE, { ...id, paused: true })).reason, 'changed')
    assert.equal((await put(id, { prompt: 'New text.' })).reason, 'changed')
  }
  assert.deepEqual(matchingCalls(f, 'run', 'pause', 'resume', 'put'), [])
  assert.deepEqual(await call(RUN, id), { requested: true })
})

test('entry returns one full draft, a boolean for own arguments, and no-store', async t => {
  const { f, seed, host, original, call } = setup(t)
  const shown = { ...draft('/' + 'r'.repeat(599)), prompt: 'p'.repeat(8000) }
  for (const [extra, ownArgs] of [
    [{}, false], [{ agent_args: [] }, false], [{ agent_args: [SECRET] }, true], [{ mcp_config: SECRET }, true],
  ]) {
    f.write({ ...f.read(), automations: [{ ...seed, ...shown, ...extra, model: SECRET }, { ...seed, name: 'Other', prompt: SECRET }] })
    const id = await original()
    const response = await host.request(ENTRY, id)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const result = (await response.json()).value
    assert.deepEqual(result.entry, shown)
    assert.equal(result.ownArgs, ownArgs)
    assert.equal(JSON.stringify(result).includes(SECRET), false)
  }
  f.write({ ...f.read(), automations: [{ ...seed, prompt: 'x'.repeat(8001) }] })
  assert.deepEqual(await call(ENTRY, await original()), { reason: 'not-editable' })
})

test('edit sends just changed fields, checks the agent, and preserves hidden values and key presence', async t => {
  const { f, seed, original, put } = setup(t)
  const hidden = { model: 'custom', mcp_config: 'configuration', close_workspace: 'on-success', catch_up_minutes: -1 }
  for (const args of [{}, { agent_args: [] }, { agent_args: ['--sandbox', 'read-only'] }, { agent_args: ['--dangerously-skip-permissions'] }]) {
    const saved = { ...seed, ...hidden, ...args }
    const cron = '0 13 * * *'
    f.write({ ...f.read(), automations: [saved], control: { checkEdit: ['name'] } })
    const id = await original()
    const before = f.bytes()
    const count = matchingCalls(f, 'put').length
    assert.deepEqual(await put(id), { next: [], unchanged: true })
    assert.equal(matchingCalls(f, 'put').length, count)
    assert.match((await put(id, { agent: 'claude' })).problem, /agent can be changed/)
    assert.equal(matchingCalls(f, 'put').length, count)
    assert.ok((await put(id, {}, true)).next.length)
    assert.deepEqual(f.calls().at(-1), { argv: ['put', '--original', NAME, '--dry-run'], stdin: true, keys: ['name'] })
    assert.deepEqual(f.bytes(), before)
    f.write({ ...f.read(), control: { checkEdit: ['name', 'cron'] } })
    const bytes = f.bytes()
    assert.ok((await put(id, { cron }, true)).next.length)
    assert.deepEqual(f.bytes(), bytes)
    assert.ok((await put(id, { cron })).next.length)
    assert.deepEqual(f.calls().at(-1), { argv: ['put', '--original', NAME], stdin: true, keys: ['cron', 'name'] })
    assert.deepEqual(f.read().automations[0], { ...saved, cron })
  }
  const prompt = 'x'.repeat(8001)
  f.write({ ...f.read(), automations: [{ ...seed, prompt }] })
  assert.deepEqual(await put(await original(), { prompt: 'Use a shorter prompt.' }), { reason: 'not-editable' })
  assert.equal(f.read().automations[0].prompt === prompt, true)
})

test('rename preserves both names verbatim on the wire and history under its recorded name', async t => {
  const { f, seed, original, call, put } = setup(t)
  const name = ' After lunch  '
  f.write({
    ...f.read(), automations: [seed, { ...seed, name: 'Valid' }], invalid: [{ name: 'Invalid', line: 4 }],
    control: { checkEdit: ['name'] }, history: [{ automation: NAME, status: 'done', trigger: 'manual', at: AT }],
  })
  const id = await original()
  for (const duplicate of ['Valid', 'Invalid']) {
    assert.deepEqual(await put(id, { name: duplicate }), { problem: 'An automation with this name already exists.' })
  }
  assert.ok((await put(id, { name })).next.length)
  assert.deepEqual(f.calls().at(-1), { argv: ['put', '--original', NAME], stdin: true, keys: ['name'] })
  assert.equal(f.read().automations[0].name, name)
  assert.equal((await call(HISTORY, { name: NAME })).runs.length, 1)
  assert.deepEqual(await call(HISTORY, { name }), { runs: [] })
})

test('workspace changes send only name and workspace, and preserve the remaining fields', async t => {
  const { f, seed, original, put } = setup(t)
  const saved = { ...seed, workspace: 'worktree', agent_args: ['--sandbox', 'read-only'], close_workspace: 'on-success', session: 'custom' }
  f.write({ ...f.read(), automations: [saved], control: { checkEdit: ['name', 'workspace'] } })
  assert.ok((await put(await original())).next.length)
  const root = { ...saved, workspace: 'root' }
  assert.deepEqual(f.read().automations[0], root)
  assert.deepEqual(f.calls().at(-1).keys, ['name', 'workspace'])
  const id = await original()
  const count = f.calls().length
  assert.deepEqual(await put(id, { workspace: 'worktree' }), { problem: 'Choose a Git work tree with at least one commit.' })
  assert.equal(f.calls().length, count)
  const repo = fileURLToPath(new URL('../../..', import.meta.url))
  f.write({ ...f.read(), automations: [{ ...root, repo }] })
  assert.ok((await put(await original(), { repo, workspace: 'worktree' })).next.length)
  assert.deepEqual(f.calls().at(-1).keys, ['name', 'workspace'])
  assert.deepEqual(f.read().automations[0], { ...saved, repo })
})
