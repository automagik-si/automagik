import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { agentsAnswer, agentsProblem, agentsRequest, agentsSystem, applyEdits, hashOf, LEARNING, parseJson, skillProblem, withoutReviewedAgentsRecords } from '../src/host/learning.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 2 },
  },
  rooms: {},
  capabilities: { items: {} },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const ownChat = [
  { event: { seq: 10, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please review this work' }] } } },
  { event: { seq: 11, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'I finished the work.' }] } } } },
]

const createReply = JSON.stringify({
  action: 'create',
  name: 'release-checks',
  description: 'Use when checking a release.',
  content: 'Run the release checks.',
  why: 'The repeated work showed that the checks need to be kept.',
})
const noneReply = JSON.stringify({ action: 'none', reason: 'This work taught nothing reusable.' })

function start({ home = mkdtempSync(join(tmpdir(), 'ds-bot-learning-')), replies = [], config = {}, history = {}, seed = TEAM, learningSeed = {} } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  if (Object.keys(learningSeed).length > 0) {
    mkdirSync(join(home, 'learning'), { recursive: true })
    writeFileSync(join(home, 'learning', 'state.json'), JSON.stringify(learningSeed))
  }
  const ctx = fakeContext()
  const requests = []
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }),
      async* stream(request) {
        requests.push(request)
        const reply = await replies.shift()
        if (reply instanceof Error) throw reply
        const out = typeof reply === 'object' && reply !== null ? reply : { text: reply ?? '' }
        yield { type: 'text-delta', index: 0, text: out.text ?? '' }
        yield { type: 'finish', reason: { kind: out.finish ?? 'stop', ...(out.failure ? { failure: typeof out.failure === 'string' ? { message: out.failure } : out.failure } : {}) } }
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({
        agent: {
          id: sessionId,
          session: {
            id: sessionId,
            seq: (history[sessionId] ?? ownChat).at(-1).event.seq + 1,
            requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
          },
        },
      }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? ownChat).filter(record => beforeSeq === undefined || record.event.seq < beforeSeq)
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => {
    route = options
    return register(options)
  }
  const settings = {
    memoryReviewDelayMs: 60_000,
    ...config,
    learningTimes: { minTurnMs: 0, idleMs: 0, intervalMs: 0, tickMs: 10, ...config.learningTimes },
  }
  const rt = createRuntime(ctx, { home, ...settings })
  const call = async (endpoint, payload = {}) => {
    const response = await route.fetch(new Request('http://localhost/api/omni-ui', {
      method: 'POST',
      body: JSON.stringify({ endpoint, payload }),
    }))
    return response.json()
  }
  const learningPath = join(home, 'learning', 'state.json')
  const learningState = () => existsSync(learningPath) ? JSON.parse(readFileSync(learningPath, 'utf8')) : {}
  const teamState = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, home, call, requests, history, learningPath, learningState, teamState, rt, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function until(check, message = 'condition did not hold within 4 s') {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return
    await settle()
  }
  assert.fail(message)
}

async function startRuntime(options) {
  const runtime = start(options)
  await runtime.call('state')
  return runtime
}

async function finishTurn(ctx, { id = 'b2', duration = 0 } = {}) {
  const { agent } = await ctx.sessionController.resolveAgent(id)
  ctx.emit('agent/status', { agent, status: 'running' })
  if (duration > 0) await new Promise(resolve => setTimeout(resolve, duration))
  ctx.emit('agent/status', { agent, status: 'idle' })
}

function addNextTurn(history) {
  history.b2.push(
    { event: { seq: 12, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please check the release process too.' }] } } },
    { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The release process is checked.' }] } } } },
  )
}

function projectFolder(t, { git = true, agents = '# Project\n- Existing rule\n' } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'ds-bot-project-'))
  if (git) mkdirSync(join(folder, '.git'))
  if (agents !== null) writeFileSync(join(folder, 'AGENTS.md'), agents)
  t.after(() => rmSync(folder, { recursive: true, force: true, maxRetries: 5 }))
  return folder
}

const agentsEdit = JSON.stringify({
  action: 'edit',
  edits: [{ op: 'add', after: '- Existing rule', text: '- Keep the report concise.', why: 'The user corrected the report format more than once.' }],
})

test('private work is skipped at collection and purged from queued reviews while public work still learns', async t => {
  const privateFolder = realpathSync(projectFolder(t))
  const publicFolder = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  Object.assign(seed.bots.b2, { workDir: privateFolder, private: true })
  seed.bots.m1.workDir = publicFolder
  const convention = 'Use the fictional Quartz report convention.'
  const runtime = await startRuntime({
    seed,
    learningSeed: {
      agentsPending: {
        [privateFolder]: { botId: 'b2', records: [{ botId: 'b2', text: convention, time: 1, order: 0 }] },
        [publicFolder]: { botId: 'm1', records: [{ botId: 'b2', text: convention, time: 1, order: 0 }] },
      },
    },
    replies: [createReply, agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  let reloaded
  t.after(() => (reloaded ?? runtime).stop())
  const reads = []
  runtime.rt.partLines = async function* (id) {
    reads.push(id)
    yield { seq: 11, time: 2, who: 'user', text: id === 'b2' ? `User: ${convention}` : 'User: Check the public release.' }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await finishTurn(runtime.ctx, { id: 'm1' })
  await until(() => runtime.learningState().pending?.m1?.includes('m1'))
  assert.equal(runtime.learningState().pending.b2, undefined)
  assert.equal(await runtime.rt.learningRun(), 2)
  assert.deepEqual(runtime.learningState().agentsPending, {})
  assert.deepEqual(runtime.learningState().pending, {})
  assert.deepEqual(reads, ['m1'])
  assert.equal(JSON.stringify(runtime.requests).includes(convention), false)
  assert.equal(readFileSync(runtime.learningPath, 'utf8').includes(convention), false)
  const view = (await runtime.call('state')).value.learning
  assert.equal(view.b2, undefined)
  assert.deepEqual(view.m1.map(proposal => proposal.kind), ['skill', 'agents'])
  assert.equal((await runtime.call('learning-answer', { id: view.m1[0].id, approve: true })).value.applied, true)
  assert.deepEqual(Object.keys(runtime.teamState().capabilities.items), ['release-checks'])
  // Simulate work already queued by an older host (or before a Bot became private).
  const legacy = { pending: { b2: ['b2'] } }
  await runtime.ctx.dispose()
  writeFileSync(runtime.learningPath, JSON.stringify(legacy))
  reloaded = await startRuntime({ home: runtime.home, config: { learningTimes: { tickMs: 100_000 } } })
  reloaded.rt.partLines = runtime.rt.partLines
  assert.equal(await reloaded.rt.learningRun(), 0)
  assert.deepEqual(reloaded.learningState().pending, {})
  assert.deepEqual(reads, ['m1'])
  assert.deepEqual(reloaded.requests, [])
})

test('an open learning proposal cannot be approved after its Bot becomes private', async t => {
  const folder = projectFolder(t)
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({ seed, replies: [createReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  assert.equal(await runtime.rt.learningRun(), 2)
  const proposals = (await runtime.call('state')).value.learning.b2
  // Let approval enter capabilitySave, which waits for its own inputs before publishing.
  const save = runtime.rt.capabilitySave
  runtime.rt.capabilitySave = async (...args) => {
    await runtime.rt.updateBot('b2', { private: true })
    return save(...args)
  }
  for (const { id, kind } of proposals) {
    const answer = await runtime.call('learning-answer', { id, approve: true })
    assert.equal(answer.error?.code, 'bot/refused')
    assert.match(answer.error.message, /private Bot/)
    assert.equal(Boolean(runtime.learningState().proposals[id]), kind === 'skill')
  }
  assert.equal(runtime.teamState().bots.b2.private, true)
  assert.deepEqual(runtime.teamState().capabilities.items, {})
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), '# Project\n- Existing rule\n')
})

test('saving a secret during skill approval cannot publish or settle a scrubbed card', async t => {
  for (const afterSave of [false, true]) await t.test(afterSave ? 'before settling' : 'before library insertion', async t => {
    const value = 'new-skill-fixture-phrase'
    const reply = { ...JSON.parse(createReply), [afterSave ? 'why' : 'content']: `Review the ${value}.` }
    const runtime = await startRuntime({
      replies: [JSON.stringify(reply)],
      config: { learningTimes: { tickMs: 100_000 } },
    })
    t.after(() => runtime.stop())
    await finishTurn(runtime.ctx)
    assert.equal(await runtime.rt.learningRun(), 1)
    const [card] = (await runtime.call('state')).value.learning.b2
    const save = runtime.rt.capabilitySave
    runtime.rt.capabilitySave = async (...args) => {
      const item = afterSave ? await save(...args) : undefined
      assert.equal((await runtime.call('secret-set', { name: 'LEARNING_TEST', value })).ok, true)
      assert.equal(runtime.learningState().proposals[card.id], undefined)
      return afterSave ? item : save(...args)
    }
    const answer = await runtime.call('learning-answer', { id: card.id, approve: true })
    const items = runtime.teamState().capabilities.items
    assert.deepEqual(Object.keys(items), afterSave ? [card.name] : [])
    assert.equal(JSON.stringify(items).includes(value), false)
    assert.deepEqual(runtime.learningState().settled, {})
    assert.equal(readFileSync(runtime.learningPath, 'utf8').includes(value), false)
    assert.equal(answer.error?.code, 'bot/stale')
  })
})

test('queued folder work is invalidated when a different Bot takes the folder private', async t => {
  for (const archived of [false, true]) await t.test(archived ? 'archived owner' : 'live owner', async t => {
    const folder = realpathSync(projectFolder(t))
    const seed = structuredClone(TEAM)
    seed.bots.b2.workDir = folder
    seed.bots.b3 = { ...seed.bots.b2, id: 'b3', sessionId: 'b3', name: 'Coder', workDir: undefined }
    const runtime = await startRuntime({
      seed, replies: [noneReply, new Error('review later'), agentsEdit],
      config: { learningTimes: { tickMs: 100_000 } },
    })
    t.after(() => runtime.stop())
    await finishTurn(runtime.ctx)
    await runtime.rt.learningRun()
    assert.ok(runtime.learningState().agentsPending[folder])
    await runtime.rt.updateBot('b2', { workDir: projectFolder(t) })
    await runtime.rt.updateBot('b3', { workDir: folder, private: true })
    if (archived) assert.equal((await runtime.call('delete-bot', { id: 'b3' })).ok, true)
    assert.notEqual(runtime.rt.botOf('b2').private, true)
    writeFileSync(join(folder, 'AGENTS.md'), '# Private fixture\n- Existing rule\n')
    assert.equal(await runtime.rt.learningRun(), 0)
    assert.equal(runtime.requests.length, 2)
    assert.equal(runtime.learningState().agentsPending[folder], undefined)
  })
})

test('approval invalidates a folder card after another Bot takes ownership of its resolved file', async t => {
  const folder = realpathSync(projectFolder(t))
  const target = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { ...seed.bots.b2, id: 'b3', sessionId: 'b3', name: 'Coder', workDir: target }
  const path = join(folder, 'AGENTS.md')
  const targetFile = join(target, 'AGENTS.md')
  const baseline = readFileSync(targetFile, 'utf8')
  unlinkSync(path)
  symlinkSync(targetFile, path, 'file')
  const runtime = await startRuntime({ seed, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  assert.equal(await runtime.rt.learningRun(), 1)
  const [card] = (await runtime.call('state')).value.learning.b2
  const workFolder = runtime.rt.workFolder
  runtime.rt.workFolder = async (...args) => {
    const result = await workFolder(...args)
    await runtime.rt.updateBot('b3', { private: true })
    return result
  }
  const answer = await runtime.call('learning-answer', { id: card.id, approve: true })
  assert.equal(runtime.rt.botOf('b3').private, true)
  assert.notEqual(runtime.rt.botOf('b2').private, true)
  assert.equal(answer.ok, false)
  assert.equal(readFileSync(path, 'utf8'), baseline)
  assert.equal(readFileSync(targetFile, 'utf8'), baseline)
  assert.equal(realpathSync(path), targetFile)
  assert.equal((await runtime.call('state')).value.learning.b2, undefined)
  assert.equal(runtime.learningState().proposals[card.id], undefined)
})

test('declined folder edits stay out of reviews after a contributor becomes private', async t => {
  const folder = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { ...seed.bots.b2, id: 'b3', sessionId: 'b3', name: 'Coder' }
  const history = { b2: [...ownChat], b3: [...ownChat] }
  const runtime = await startRuntime({
    seed, history, replies: [noneReply, noneReply, agentsEdit, noneReply, noneReply],
    learningSeed: { declined: [
      { kind: 'agents', folder, edits: [{ op: 'add', text: '- Omit this legacy decline' }] },
      { kind: 'agents', folder, contributors: ['b2'], edits: [{ op: 'add', text: '- Keep this public decline' }] },
    ] },
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await finishTurn(runtime.ctx, { id: 'b3' })
  assert.equal(await runtime.rt.learningRun(), 1)
  const [card] = Object.values(runtime.learningState().proposals)
  assert.deepEqual(card.contributors, ['b2', 'b3'])
  assert.equal((await runtime.call('learning-answer', { id: card.id })).ok, true)

  await runtime.rt.updateBot('b3', { workDir: projectFolder(t), private: true })
  addNextTurn(history)
  await finishTurn(runtime.ctx)
  assert.equal(await runtime.rt.learningRun(), 0)
  const request = runtime.requests.at(-1).messages[0].content[0].text
  assert.match(request, /Keep this public decline/)
  assert.doesNotMatch(request, /Keep the report concise|Omit this legacy decline/)
  assert.deepEqual(runtime.learningState().declined.at(-1).contributors, ['b2', 'b3'])
})

test('agentsProblem validates edit safety and whole-line matches', () => {
  const current = '# Project\n- Existing rule\n'
  assert.equal(agentsProblem({ action: 'none' }, current), undefined)
  const replace = (old, text = '- New rule') => ({ action: 'edit', edits: [{ op: 'replace', old, text, why: 'Repeated correction.' }] })
  assert.match(agentsProblem(replace('- Missing'), current), /exactly once/)
  assert.match(agentsProblem(replace('- Existing rule'), `${current}- Existing rule\n`), /exactly once/)
  assert.match(agentsProblem(replace('Existing rule'), current), /exactly once/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: '- Task #123 happened 2026-10-28 v2.1', why: 'Repeated correction.' }] }, current), /number, date, or version/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: '- Password is hunter2', why: 'Repeated correction.' }] }, current), /secret/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: '- Keep this rule.', why: 'The password is hunter2.' }] }, current), /secret/)
  const anchor = '- Key sk-examplefixture1234567890'
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: anchor, text: '- Keep this rule.', why: 'Repeated correction.' }] }, `${current}${anchor}\n`), /secret/)
  assert.match(agentsProblem(replace(anchor), `${current}${anchor}\n`), /secret/)
  assert.match(agentsProblem(replace('- Existing rule'), undefined), /only add lines/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'add', after: '', text: 'x'.repeat(LEARNING.agentsEditMax + 1), why: 'Repeated correction.' }] }, current), /at most/)
  assert.match(agentsProblem({ action: 'edit', edits: [{ op: 'replace', old: '- Existing rule', text: '- Existing rule', why: 'Repeated correction.' }] }, current), /change nothing/)
  const long = `# ${'x'.repeat(3997)}`
  const large = { action: 'edit', edits: [1, 2, 3].map(index => ({ op: 'add', after: '', text: `- ${index}${'y'.repeat(397)}`, why: 'Repeated correction.' })) }
  assert.match(agentsProblem(large, long), /too large/)
})

test('AGENTS review guidance keeps credentials out of every retained edit field', () => {
  assert.match(agentsSystem(), /Keep credentials out of every edit field, including quoted old text, add anchors, and reasons/)
})

test('agentsAnswer reads an edit written as the answer, an empty replacement, and lines apart as edits', () => {
  const current = '# Project\n- Use yarn.\n- Do not edit vendor/.\n- Run `yarn test`.\n'
  const why = 'The user moved the project to pnpm.'
  const answer = value => agentsAnswer(JSON.stringify(value), current)
  const flat = answer({ action: 'replace', old: '- Use yarn.', text: '- Use pnpm.', why })
  assert.deepEqual(flat, { action: 'edit', edits: [{ op: 'replace', old: '- Use yarn.', text: '- Use pnpm.', why }] })
  assert.equal(agentsProblem(flat, current), undefined)
  assert.deepEqual(answer({ action: 'edit', edits: [{ op: 'replace', old: '- Use yarn.', text: ' ', why }] }).edits, [{ op: 'remove', old: '- Use yarn.', why }])
  const apart = answer({ action: 'edit', edits: [{ op: 'replace', old: '- Use yarn.\n- Run `yarn test`.', text: '- Use pnpm.\n- Run `pnpm test`.', why }] })
  assert.deepEqual(apart.edits.map(edit => [edit.old, edit.text]), [['- Use yarn.', '- Use pnpm.'], ['- Run `yarn test`.', '- Run `pnpm test`.']])
  assert.equal(applyEdits(current, apart.edits), '# Project\n- Use pnpm.\n- Do not edit vendor/.\n- Run `pnpm test`.\n')
  assert.equal(answer({ action: 'edit', edits: [{ op: 'remove', old: '- Use yarn.\n- Run `yarn test`.', why }] }).edits.length, 2)
  // Lines apart with a different number of new lines stay one edit, and the check refuses it.
  const uneven = answer({ action: 'edit', edits: [{ op: 'replace', old: '- Use yarn.\n- Run `yarn test`.', text: '- Use pnpm.', why }] })
  assert.match(agentsProblem(uneven, current), /exactly once/)
  assert.deepEqual(answer({ action: 'none', reason: 'Routine work.' }), { action: 'none', reason: 'Routine work.' })
  assert.equal(agentsAnswer('no JSON here', current), undefined)
})

test('applyEdits supports end and anchored add, replace, remove, and a new file', () => {
  const current = '# Project\n- Existing rule\n'
  assert.equal(applyEdits(current, [{ op: 'add', after: '', text: '- End rule' }]), '# Project\n- Existing rule\n- End rule\n')
  assert.equal(applyEdits(current, [{ op: 'add', after: '# Project', text: '- Before rule' }]), '# Project\n- Before rule\n- Existing rule\n')
  assert.equal(applyEdits(current, [{ op: 'replace', old: '- Existing rule', text: '- Updated rule' }]), '# Project\n- Updated rule\n')
  assert.equal(applyEdits(current, [{ op: 'remove', old: '- Existing rule' }]), '# Project\n')
  assert.equal(applyEdits(undefined, [{ op: 'add', after: '', text: '# Project\n- New rule' }]), '# Project\n- New rule\n')
})

test('AGENTS review keeps records appended while its model is running', () => {
  const reviewed = [{ text: 'User: Earlier work', order: 0 }]
  const queued = [...reviewed, { text: 'User: New work', order: 1 }]
  assert.deepEqual(withoutReviewedAgentsRecords(queued, reviewed.map(item => item.order)), [{ text: 'User: New work', order: 1 }])
})

test('agentsRequest includes only the declined edits for its folder', () => {
  const request = agentsRequest({
    folder: '/project', current: undefined, lines: ['User: Keep reports short.'],
    declined: [{ kind: 'agents', folder: '/project', edits: [{ op: 'add', text: '- Keep reports short.' }] }, { kind: 'agents', folder: '/other', edits: [{ op: 'add', text: '- Other' }] }],
  })
  assert.match(request, /There is no AGENTS.md yet/)
  assert.match(request, /Keep reports short/)
  assert.doesNotMatch(request, /Other/)
})

test('a Git folder with pending work gets one AGENTS proposal and approval writes it atomically', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({ seed, history: { b2: [...ownChat] }, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* () {
    for (let seq = 30; seq > 0; seq -= 1) yield { seq, time: seq, who: 'bot', text: `Bot: ${'x'.repeat(1_200)}` }
    yield { seq: 0, time: 0, who: 'user', text: 'User: Keep the early correction after long Bot output.' }
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.kind, 'agents')
  assert.equal(proposal.folder, await runtime.rt.real(folder))
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Keep the early correction after long Bot output/)
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), '# Project\n- Existing rule\n- Keep the report concise.\n')
  assert.deepEqual(readdirSync(folder).filter(name => name.endsWith('.tmp')), [])
})

test('a failed work-folder check keeps an AGENTS proposal open', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({ seed, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  const workFolder = runtime.rt.workFolder
  runtime.rt.workFolder = async () => { throw new Error('folder is no longer available') }
  const failed = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(failed.ok, false)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)
  runtime.rt.workFolder = workFolder
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: true })).value.applied, true)
})

test('a Git folder without AGENTS.md can get a new file approved', async t => {
  const folder = projectFolder(t, { agents: null })
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const reply = JSON.stringify({ action: 'edit', edits: [{ op: 'add', after: '', text: '# Project\n- New rule', why: 'The user corrected this repeatedly.' }] })
  const runtime = await startRuntime({ seed, history: { b2: [...ownChat] }, replies: [noneReply, reply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.exists, false)
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: true })).value.applied, true)
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), '# Project\n- New rule\n')
})

test('a folder is reviewed once with the pending work from every Bot that used it', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    replies: [noneReply, noneReply, agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    yield { seq: 11, time: sessionId === 'b2' ? 1 : 2, who: 'user', text: `User: Work from ${sessionId}` }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await finishTurn(runtime.ctx, { id: 'b3' })
  await runtime.rt.learningRun()
  assert.equal(runtime.requests.length, 3)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Work from b2/)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Work from b3/)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)
})

test('work for a folder with an open proposal stays queued until the card is declined', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    replies: [noneReply, agentsEdit, noneReply, agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    yield { seq: 11, time: 1, who: 'user', text: `User: Work from ${sessionId}` }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  await finishTurn(runtime.ctx, { id: 'b3' })
  await runtime.rt.learningRun()
  const queued = runtime.learningState().agentsPending[await runtime.rt.real(folder)]
  assert.match(queued.records.map(item => item.text).join('\n'), /Work from b3/)
  assert.equal(runtime.requests.length, 3)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)

  await runtime.call('learning-answer', { id: proposal.id, approve: false })
  await runtime.rt.learningRun()
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /Work from b3/)
  assert.equal(runtime.learningState().agentsPending[await runtime.rt.real(folder)], undefined)
})

test('a failed AGENTS model call keeps its folder work for the next pass with credentials redacted', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const config = { learningTimes: { tickMs: 100_000, userLineMax: 42 } }
  const key = 'sk-examplefixture1234567890'
  const secret = 'stored-test-value-37'
  const keyLine = `User: Key ${'x'.repeat(20)} ${key}`
  const secretLine = `User: Another saved value: ${secret}`
  const runtime = await startRuntime({
    seed,
    replies: [createReply, new Error('AGENTS model failed')],
    config,
  })
  let reloaded
  t.after(() => (reloaded ?? runtime).stop())
  assert.equal((await runtime.call('secret-set', { name: 'LEARNING_TEST', value: secret })).ok, true)
  runtime.rt.partLines = async function* () {
    yield { seq: 13, time: 3, who: 'user', text: secretLine }
    yield { seq: 12, time: 2, who: 'user', text: keyLine }
    yield { seq: 11, time: 1, who: 'user', text: 'User: Keep the same folder work' }
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const folderKey = await runtime.rt.real(folder)
  assert.match(runtime.learningState().agentsPending[folderKey].records[0].text, /same folder work/)
  assert.equal((await runtime.call('state')).value.learning.b2[0].kind, 'skill')
  const firstRequest = runtime.requests.at(-1).messages[0].content[0].text
  const assertSafe = (runtime, requests) => {
    const persisted = readFileSync(runtime.learningPath, 'utf8')
    for (const text of [persisted, JSON.stringify(requests)]) {
      assert.equal(text.includes(key.slice(0, 10)), false)
      assert.equal(text.includes(secret), false)
    }
  }
  assertSafe(runtime, runtime.requests)
  assert.match(firstRequest, /\[hidden\]/)

  await runtime.ctx.dispose()
  // The old writer clipped raw lines before persisting them, including partial credentials.
  const legacy = runtime.learningState()
  const [, keyRecord, secretRecord] = legacy.agentsPending[folderKey].records
  keyRecord.text = `${keyLine.slice(0, config.learningTimes.userLineMax)} […]`
  secretRecord.text = `${secretLine.slice(0, config.learningTimes.userLineMax)} […]`
  assert.ok(secretRecord.text.includes(secret.slice(0, 12)))
  assert.ok(!secretRecord.text.includes(secret))
  legacy.agentsPending[folderKey].records.push({ ...secretRecord, order: 3, text: `User: Save ${secret}` })
  writeFileSync(runtime.learningPath, JSON.stringify(legacy))
  reloaded = await startRuntime({ home: runtime.home, replies: [agentsEdit], config })
  assert.deepEqual(reloaded.learningState().agentsPending[folderKey].records.map(item => item.text), ['User: Keep the same folder work', 'User: [hidden]'])
  assertSafe(reloaded, [])
  await reloaded.rt.learningRun()
  assertSafe(reloaded, reloaded.requests)
  const reloadedRequest = reloaded.requests.at(-1).messages[0].content[0].text
  assert.match(reloadedRequest, /same folder work/)
  assert.equal(reloadedRequest.includes(secret.slice(0, 12)), false)
  assert.equal(reloaded.learningState().agentsPending[folderKey], undefined)
  assert.ok((await reloaded.call('state')).value.learning.b2.some(proposal => proposal.kind === 'agents'))
})

test('saving a secret scrubs queued folder work before the next review in the same process', async t => {
  const folder = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const secret = 'newly-saved-fixture-37'
  const runtime = await startRuntime({
    seed, replies: [noneReply, new Error('review later'), agentsEdit],
    config: { learningTimes: { tickMs: 100_000, userLineMax: 55 } },
  })
  t.after(() => runtime.stop())
  const clippedValue = 'another-stored-fixture-42'
  runtime.rt.partLines = async function* () {
    yield { seq: 12, time: 3, who: 'user', text: `User: Someone else has to check the value: ${clippedValue}` }
    yield { seq: 11, time: 2, who: 'user', text: `User: Keep this value ${secret}` }
    yield { seq: 10, time: 1, who: 'user', text: 'User: Keep the same folder work' }
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(readFileSync(runtime.learningPath, 'utf8').includes(secret), true)
  assert.ok(readFileSync(runtime.learningPath, 'utf8').includes(clippedValue.slice(0, 10)))
  assert.equal((await runtime.call('secret-set', { name: 'LEARNING_TEST', value: secret })).ok, true)
  assert.equal((await runtime.call('secret-set', { name: 'CLIPPED_TEST', value: clippedValue })).ok, true)
  const savedText = readFileSync(runtime.learningPath, 'utf8')
  assert.equal(savedText.includes(secret), false)
  assert.equal(savedText.includes(clippedValue.slice(0, 10)), false)
  assert.equal(await runtime.rt.learningRun(), 1)
  const request = runtime.requests.at(-1).messages[0].content[0].text
  assert.equal(request.includes(secret), false)
  assert.match(request, /same folder work/)
  assert.match(request, /\[hidden\]/)
})

test('saving a secret scrubs an unopened learning file and retries a failed cleanup write', async t => {
  for (const failWrite of [false, true]) await t.test(failWrite ? 'failed write and retry' : 'before state is opened', async t => {
    const folder = realpathSync(projectFolder(t))
    const value = 'new-learning-fixture-phrase'
    const runtime = start({
      learningSeed: {
        agentsPending: {
          [folder]: { botId: 'b2', records: [
            { text: `User: Use this value ${value}`, order: 0 },
            { text: 'User: Keep the public work.', order: 1 },
          ] },
        },
      },
      config: { learningTimes: { tickMs: 100_000 } },
    })
    t.after(() => runtime.stop())
    const before = readFileSync(runtime.learningPath, 'utf8')
    const temp = `${runtime.learningPath}.${process.pid}.tmp`
    if (failWrite) mkdirSync(temp)
    const result = await runtime.call('secret-set', { name: 'LEARNING_TEST', value })
    assert.ok(readFileSync(join(runtime.home, 'secrets.json'), 'utf8').includes(value))
    if (failWrite) {
      assert.equal(result.ok, false)
      assert.match(result.error.message, /EISDIR|EPERM|EACCES/)
      assert.equal(readFileSync(runtime.learningPath, 'utf8'), before)
      rmSync(temp, { recursive: true })
      assert.equal((await runtime.call('state')).ok, true)
    } else {
      assert.equal(result.ok, true)
    }
    assert.deepEqual(runtime.learningState().agentsPending[folder].records.map(record => record.text), [
      'User: [hidden]', 'User: Keep the public work.',
    ])
    assert.equal(readFileSync(runtime.learningPath, 'utf8').includes(value), false)
  })
})

test('a learning file read failure is reported on secret save and retried on the next state poll', async t => {
  const folder = realpathSync(projectFolder(t))
  const value = 'new-learning-fixture-phrase'
  const runtime = start({
    learningSeed: { agentsPending: { [folder]: { botId: 'b2', records: [
      { text: `User: Use ${value}`, order: 0 },
      { text: 'User: Keep the public work.', order: 1 },
    ] } } },
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  const backup = `${runtime.learningPath}.backup`
  renameSync(runtime.learningPath, backup)
  mkdirSync(runtime.learningPath)
  const result = await runtime.call('secret-set', { name: 'LEARNING_TEST', value })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /learning state.*EISDIR/i)
  assert.ok(readFileSync(join(runtime.home, 'secrets.json'), 'utf8').includes(value))
  rmSync(runtime.learningPath, { recursive: true })
  renameSync(backup, runtime.learningPath)
  assert.equal((await runtime.call('state')).ok, true)
  assert.deepEqual(runtime.learningState().agentsPending[folder].records.map(record => record.text), [
    'User: [hidden]', 'User: Keep the public work.',
  ])
})

test('a failed private folder purge is retried on the next state poll', async t => {
  const folder = realpathSync(projectFolder(t))
  const other = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const card = { id: 'open', kind: 'agents', botId: 'b2', folder, path: join(folder, 'AGENTS.md'),
    contributors: ['b2'], content: '- Keep the report concise.' }
  const publicQueue = { botId: 'm1', records: [{ botId: 'm1', text: 'User: Keep the public work.', order: 0 }] }
  const runtime = await startRuntime({
    seed, learningSeed: { proposals: { open: card }, agentsPending: { [other]: publicQueue } },
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await runtime.rt.updateBot('b2', { private: true })
  const temp = `${runtime.learningPath}.${process.pid}.tmp`
  mkdirSync(temp)
  assert.equal((await runtime.call('state')).ok, false)
  assert.ok(runtime.learningState().proposals[card.id])
  rmSync(temp, { recursive: true })
  assert.equal((await runtime.call('state')).ok, true)
  assert.equal(runtime.learningState().proposals[card.id], undefined)
  assert.deepEqual(runtime.learningState().agentsPending[other], publicQueue)
})

test('restart removes sensitive learning cards and decline edits and regenerates an ownerless folder card', async t => {
  const folder = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const secret = 'stored-restart-fixture-37'
  const key = 'sk-examplefixture1234567890'
  const config = { learningTimes: { tickMs: 100_000 } }
  const runtime = await startRuntime({ seed, config })
  let reloaded
  t.after(() => (reloaded ?? runtime).stop())
  assert.equal((await runtime.call('secret-set', { name: 'LEARNING_TEST', value: secret })).ok, true)
  await runtime.ctx.dispose()
  const card = { kind: 'agents', botId: 'b2', folder, path: join(folder, 'AGENTS.md'), edits: JSON.parse(agentsEdit).edits, content: '- Public rule\n' }
  const settled = { ...card, contributors: ['b2'], outcome: 'declined', sessionId: 'b2' }
  const learningSeed = {
    proposals: {
      open: { ...card, id: 'open', contributors: ['b2'], content: `- Local setup: ${key}\n` },
      legacy: { ...card, id: 'legacy' },
    },
    settled: {
      unsafe: { ...settled, id: 'unsafe', content: `- Local setup: ${secret}\n` },
      clean: { ...settled, id: 'clean' },
    },
    declined: [
      { kind: 'agents', folder, edits: [{ op: 'remove', old: secret }] },
      { kind: 'agents', folder, contributors: ['b2'], edits: [{ op: 'add', text: '- Keep the public wording' }] },
    ],
    agentsPending: { [folder]: { botId: 'b2', records: [{ botId: 'b2', text: 'User: Current public work', order: 0 }] } },
  }
  reloaded = start({ home: runtime.home, learningSeed, replies: [agentsEdit], config })
  const { value } = await reloaded.call('state')
  for (const text of [JSON.stringify(value), readFileSync(reloaded.learningPath, 'utf8')]) {
    assert.equal(text.includes(secret), false)
    assert.equal(text.includes(key), false)
  }
  assert.deepEqual(value.learning, {})
  assert.deepEqual(value.learningSettled.b2.map(entry => entry.id), ['clean'])
  assert.deepEqual(reloaded.learningState().proposals, {})
  assert.deepEqual(Object.keys(reloaded.learningState().settled), ['clean'])
  assert.equal(reloaded.learningState().declined.length, 1)
  assert.equal(await reloaded.rt.learningRun(), 1)
  assert.match(JSON.stringify(reloaded.requests), /Current public work/)
  assert.match(JSON.stringify(reloaded.requests), /Keep the public wording/)
  assert.equal(JSON.stringify(reloaded.requests).includes(secret), false)
  const [regenerated] = (await reloaded.call('state')).value.learning.b2
  assert.deepEqual(regenerated.contributors, ['b2'])
  assert.equal((await reloaded.call('learning-answer', { id: regenerated.id, approve: true })).value.applied, true)
})

test('upgrade recovers a clean folder card from reviewed public work with an empty queue', async t => {
  const folder = realpathSync(projectFolder(t))
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { ...seed.bots.b2, id: 'b3', sessionId: 'b3', name: 'Coder', workDir: projectFolder(t), private: true }
  const config = { learningTimes: { tickMs: 100_000 } }
  const first = await startRuntime({
    seed, config,
    learningSeed: {
      proposals: { legacy: { id: 'legacy', kind: 'agents', botId: 'b2', folder, path: join(folder, 'AGENTS.md'),
        at: 100, content: '- Keep the report concise.', edits: JSON.parse(agentsEdit).edits } },
      cursors: { b2: 11, b3: 11 },
      pending: {}, agentsPending: {},
    },
  })
  let runtime
  t.after(() => (runtime ?? first).stop())
  await first.ctx.dispose()
  runtime = await startRuntime({ home: first.home, replies: [agentsEdit], config })
  const resolve = runtime.ctx.sessionController.resolveAgent
  runtime.ctx.sessionController.resolveAgent = async id => {
    const result = await resolve(id)
    result.agent.session.header = { cwd: folder }
    return result
  }
  const reads = []
  runtime.rt.partLines = async function* (sessionId) {
    reads.push(sessionId)
    yield { seq: 12, time: 101, who: 'user', text: 'User: New unreviewed work.' }
    yield { seq: 11, time: 99, who: 'user', text: 'User: Review the public report format.' }
  }
  assert.deepEqual((await runtime.call('state')).value.learning, {})
  assert.equal(await runtime.rt.learningRun(), 1)
  assert.deepEqual(reads, ['b2'])
  assert.equal(runtime.requests.length, 1)
  const request = JSON.stringify(runtime.requests)
  assert.match(request, /Review the public report format/)
  assert.doesNotMatch(request, /New unreviewed work/)
  assert.deepEqual(runtime.learningState().cursors, { b2: 11, b3: 11 })
  assert.deepEqual(runtime.learningState().agentsPending, {})
  const [card] = (await runtime.call('state')).value.learning.b2
  assert.deepEqual(card.contributors, ['b2'])
  assert.equal((await runtime.call('learning-answer', { id: card.id, approve: true })).value.applied, true)
})

test('AGENTS review falls back to another contributor when its Bot is deleted', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    replies: [noneReply, new Error('retry this folder later'), noneReply, new Error('retry after Bot C adds work'), agentsEdit],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  const folderPath = await runtime.rt.real(folder)
  runtime.rt.partLines = async function* (sessionId) {
    yield { seq: 11, time: 1, who: 'user', text: `User: Work from ${sessionId}` }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath].botId, 'b2')
  assert.deepEqual(runtime.learningState().agentsPending[folderPath].records.map(item => item.botId), ['b2'])

  await finishTurn(runtime.ctx, { id: 'b3' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath].botId, 'b2')
  assert.deepEqual(runtime.learningState().agentsPending[folderPath].records.map(item => item.botId), ['b2', 'b3'])

  await runtime.call('delete-bot', { id: 'b2' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath], undefined)
  const view = (await runtime.call('state')).value.learning
  assert.ok(view.b3.some(proposal => proposal.kind === 'agents'))
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /Work from b2/)
  assert.match(runtime.requests.at(-1).messages[0].content[0].text, /Work from b3/)
})

test('AGENTS folder queue is removed when all contributing Bots are deleted', async t => {
  const folder = projectFolder(t)
  const folderPath = realpathSync(folder)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], workDir: folder, createdAt: 3 }
  const runtime = await startRuntime({
    seed,
    learningSeed: {
      agentsPending: {
        [folderPath]: {
          botId: 'b2',
          records: [
            { botId: 'b2', text: 'User: Work from b2', time: 1, order: 0 },
            { botId: 'b3', text: 'User: Work from b3', time: 2, order: 1 },
          ],
        },
      },
    },
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await runtime.call('delete-bot', { id: 'b2' })
  await runtime.call('delete-bot', { id: 'b3' })
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().agentsPending[folderPath], undefined)
  assert.equal(runtime.requests.length, 0)
})

test('agentsMd false keeps folder queues and does not schedule a review', async t => {
  const folder = projectFolder(t)
  const folderPath = realpathSync(folder)
  const runtime = await startRuntime({
    learningSeed: {
      agentsPending: {
        [folderPath]: { botId: 'b2', records: [{ text: 'User: Keep this queued', time: 1, order: 0 }] },
      },
    },
    config: { agentsMd: false, learningTimes: { idleMs: 0, intervalMs: 0, tickMs: 10 } },
  })
  t.after(() => runtime.stop())
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(runtime.learningState().lastRun, undefined)
  assert.deepEqual(runtime.learningState().agentsPending[folderPath].records, [{ text: 'User: Keep this queued', time: 1, order: 0 }])
  assert.equal(runtime.requests.length, 0)
})

test('a changed AGENTS proposal stays open, can be declined, and is included in the next folder request', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({ seed, history, replies: [noneReply, agentsEdit, noneReply, noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  writeFileSync(join(folder, 'AGENTS.md'), '# Project\n- Changed by the user\n')
  const stale = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.match(JSON.stringify(stale), /AGENTS.md changed since this was proposed/)
  assert.equal((await runtime.call('state')).value.learning.b2.length, 1)
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: false })).value.applied, false)
  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Changes the user turned down before/)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Keep the report concise/)
})

test('folders without a project marker, DSH data folders, and agentsMd:false are not reviewed', async t => {
  const cases = [
    { folder: projectFolder(t, { git: false, agents: null }), config: {} },
    { folder: projectFolder(t, { agents: `# ${'x'.repeat(16_000)}` }), config: {} },
    { folder: undefined, config: {} },
    { folder: projectFolder(t), config: { agentsMd: false } },
  ]
  for (const item of cases) {
    const seed = JSON.parse(JSON.stringify(TEAM))
    const options = { replies: [noneReply], config: { learningTimes: { tickMs: 100_000 }, ...item.config } }
    const runtimeOptions = item.folder
      ? { ...options, seed: { ...seed, bots: { ...seed.bots, b2: { ...seed.bots.b2, workDir: item.folder } } } }
      : options
    const runtime = await startRuntime(runtimeOptions)
    t.after(() => runtime.stop())
    if (!item.folder) runtime.rt.botOf('b2').workDir = runtime.home
    await finishTurn(runtime.ctx)
    await runtime.rt.learningRun()
    assert.equal(runtime.requests.length, 1)
    assert.deepEqual((await runtime.call('state')).value.learning ?? {}, {})
  }
})

test('a disposed learning pass cannot overwrite the next host state with a late model reply', async t => {
  for (const kind of ['skill', 'agents']) await t.test(kind, async t => {
    let finishModel
    const reply = new Promise(resolve => { finishModel = resolve })
    const folder = kind === 'agents' ? projectFolder(t) : undefined
    const seed = folder ? { ...TEAM, bots: { ...TEAM.bots, b2: { ...TEAM.bots.b2, workDir: folder } } } : TEAM
    const runtime = await startRuntime({ seed, replies: kind === 'agents' ? [noneReply, reply] : [reply], config: { learningTimes: { tickMs: 100_000 } } })
    t.after(() => runtime.stop())
    await finishTurn(runtime.ctx)
    await until(() => runtime.learningState().pending?.b2?.includes('b2'))
    const pass = runtime.rt.learningRun()
    const calls = kind === 'agents' ? 2 : 1
    await until(() => runtime.requests.length === calls)
    await runtime.ctx.dispose()

    const next = { pending: { m1: ['m1'] }, proposals: { next: { id: 'next', botId: 'm1', name: 'next-host-skill' } } }
    writeFileSync(runtime.learningPath, JSON.stringify(next))
    finishModel(kind === 'agents' ? agentsEdit : createReply)
    await pass
    assert.deepEqual(runtime.learningState(), next)
    assert.deepEqual(runtime.rt.learningView(), {})
    assert.equal(await runtime.rt.learningRun(), 0)
    assert.equal(runtime.requests.length, calls)
  })
})

test('parseJson accepts fenced and unfenced objects and ignores garbage', () => {
  assert.deepEqual(parseJson('```json\n{"action":"none"}\n```'), { action: 'none' })
  assert.deepEqual(parseJson('Answer: {"action":"none"}'), { action: 'none' })
  const answer = JSON.stringify({ action: 'create', content: 'Use this:\n```js\nvalue\n```' })
  const expected = JSON.parse(answer)
  assert.deepEqual(parseJson(answer), expected)
  assert.deepEqual(parseJson('```json\n' + answer + '\n```'), expected)
  assert.equal(parseJson('No JSON was returned.'), undefined)
  assert.equal(parseJson('```json\n{"action":\n```'), undefined)
})

test('skillProblem validates actions, learned-skill limits, and secret-looking content', () => {
  const proposal = {
    action: 'create',
    name: 'release-checks',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  }
  assert.equal(skillProblem({ action: 'none' }, { skills: {}, learned: [] }), undefined)
  assert.match(skillProblem({ ...proposal, name: 'Bad_Name' }, { skills: {}, learned: [] }), /capability name/)
  assert.match(skillProblem(proposal, { skills: { 'release-checks': { kind: 'skill' } }, learned: [] }), /already exists/)
  assert.match(skillProblem(proposal, { skills: {}, learned: ['one', 'two'], limit: 2 }), /learned skills/)
  assert.match(skillProblem({ ...proposal, action: 'update' }, { skills: { 'release-checks': { kind: 'skill', content: 'Old', description: 'Old' } }, learned: [] }), /not a learned skill/)
  assert.match(skillProblem({ ...proposal, action: 'update' }, {
    skills: { 'release-checks': { kind: 'skill', content: proposal.content, description: proposal.description } },
    learned: ['release-checks'],
  }), /changes nothing/)
  assert.match(skillProblem({ ...proposal, content: 'The root password is hunter2' }, { skills: {}, learned: [] }), /secret/)
  assert.match(skillProblem({ ...proposal, why: 'The root password is hunter2' }, { skills: {}, learned: [] }), /secret/)
  assert.equal(skillProblem({ ...proposal, content: 'Compare `password == input` with a timing-safe check' }, { skills: {}, learned: [] }), undefined)
  assert.match(skillProblem({ ...proposal, description: 'x'.repeat(LEARNING.descriptionMax + 1) }, { skills: {}, learned: [] }), /description/)
})

test('short turns do not mark a Bot chat; a longer turn marks it for review', async t => {
  const short = await startRuntime({ config: { learningTimes: { minTurnMs: 60_000, idleMs: 60_000 } } })
  t.after(() => short.stop())
  await finishTurn(short.ctx)
  await settle()
  assert.equal(existsSync(short.learningPath), false)

  const long = await startRuntime({ config: { learningTimes: { minTurnMs: 5, idleMs: 60_000 } } })
  t.after(() => long.stop())
  await finishTurn(long.ctx, { duration: 15 })
  await until(() => long.learningState().pending?.b2?.includes('b2'))
  assert.deepEqual(long.learningState().pending.b2, ['b2'])
})

test('a none reply makes no proposal and advances the chat cursor', async t => {
  const runtime = await startRuntime({ replies: [noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().cursors?.b2 === 11 && runtime.learningState().pending?.b2 === undefined)
  assert.equal(runtime.requests.length, 1)
  assert.deepEqual((await runtime.call('state')).value.learning ?? {}, {})
})

test('a folder lookup failure does not repeat the skill proposal', async t => {
  const runtime = await startRuntime({ config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  runtime.rt.partLines = async function* () {
    yield { seq: 10, time: 1, who: 'user', text: 'User: Please review this work' }
    yield { seq: 11, time: 2, who: 'assistant', text: 'Bot: I finished the work.' }
  }
  runtime.rt.botShot = async () => createReply
  runtime.rt.resolveAgent = async () => { throw new Error('folder lookup failed') }

  await runtime.rt.learningRun()

  assert.equal(Object.keys(runtime.learningState().proposals ?? {}).length, 1)
  assert.equal(runtime.learningState().pending?.b2, undefined)
  await runtime.rt.learningRun()
  assert.equal(Object.keys(runtime.learningState().proposals ?? {}).length, 1)
})

test('long turns ending during review remain pending for the next pass', async t => {
  const history = { b2: [...ownChat], b3: [...ownChat] }
  const runtime = await startRuntime({
    history,
    replies: [noneReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  // Every load and save rebuilds the owner maps from the roster, and the startup model sync
  // saves while the test runs: b3 is put back after each of them.
  const owned = () => { runtime.rt.chatOwners.set('b3', 'b2') }
  const load = runtime.rt.load
  runtime.rt.load = async (...args) => {
    const result = await load(...args)
    owned()
    return result
  }
  const save = runtime.rt.save
  runtime.rt.save = (...args) => {
    const result = save(...args)
    owned()
    return result
  }
  owned()
  const b3Statuses = []
  runtime.ctx.on('agent/status', ({ agent, status }) => {
    if (agent?.id === 'b3') b3Statuses.push(status)
  })
  assert.equal(runtime.rt.chatOwners.get('b3'), 'b2')
  assert.equal(runtime.rt.isBotSession('b3'), true)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))

  const botShot = runtime.rt.botShot
  let endedDuringReview = false
  runtime.rt.botShot = async (...args) => {
    if (!endedDuringReview) {
      endedDuringReview = true
      addNextTurn(history)
      history.b3.push(
        { event: { seq: 12, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Please keep this new work too.' }] } } },
        { event: { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'The second chat has new work.' }] } } } },
      )
      await finishTurn(runtime.ctx, { id: 'b2' })
      await finishTurn(runtime.ctx, { id: 'b3' })
      assert.deepEqual(b3Statuses, ['running', 'idle'])
    }
    return botShot(...args)
  }

  await runtime.rt.learningRun()

  assert.deepEqual(runtime.learningState().pending.b2, ['b2', 'b3'])
  assert.equal(runtime.learningState().cursors.b2, 11)

  await runtime.rt.learningRun()

  assert.equal(runtime.requests.length, 2)
  const request = runtime.requests[1].messages[0].content[0].text
  assert.match(request, /Please check the release process too\./)
  assert.match(request, /Please keep this new work too\./)
  assert.equal(runtime.learningState().pending.b2, undefined)
})

test('approval ownership survives a normal skill edit and remains learned on review', async t => {
  const history = { b2: [...ownChat] }
  const updateReply = JSON.stringify({
    action: 'update',
    name: 'release-checks',
    description: 'Use when checking any release.',
    content: 'Run the release checks.',
    why: 'The work showed the scope should be broader.',
  })
  const runtime = await startRuntime({
    history,
    replies: [createReply, updateReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal(proposal.name, 'release-checks')

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  await settle()
  assert.equal(runtime.requests.length, 1)
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release candidate.',
    content: 'Run the release checks.',
  })
  await runtime.rt.learningRun()
  await until(() => runtime.requests.length === 2)
  await until(() => Object.values(runtime.learningState().proposals ?? {}).some(entry => entry.action === 'update'))
  const saved = runtime.teamState()
  assert.equal(saved.capabilities.items['release-checks'].learned, undefined)
  assert.ok(saved.bots.b2.capabilities.includes('release-checks'))
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])
  assert.match(runtime.requests[1].messages[0].content[0].text, /This Bot's learned skills[\s\S]*Use when checking a release candidate\./)
})

test('a failed create attachment can be retried without resaving or losing the proposal', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const attach = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (...args) => {
    if (fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return attach(...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  assert.ok(runtime.learningState().learned.b2.includes('release-checks'))
  assert.ok(runtime.learningState().proposals[proposal.id])

  const second = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(second.value.applied, true)
  assert.equal(runtime.learningState().proposals[proposal.id], undefined)
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))
})

test('a recreated approved skill is learned when its saved proposal is retried', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const endpoint = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (name, body, ...args) => {
    if (name === 'bot-capability' && fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return endpoint(name, body, ...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])

  const deleted = await runtime.call('capability-delete', { name: 'release-checks' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(runtime.learningState().learned.b2, [])
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  })

  const retry = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(retry.value.applied, true)
  assert.equal(runtime.learningState().proposals[proposal.id], undefined)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))
})

test('a failed create retry refuses a skill edited after it was saved', async t => {
  const runtime = await startRuntime({ replies: [createReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const endpoint = runtime.rt.capabilityEndpoint
  let fail = true
  runtime.rt.capabilityEndpoint = async (name, body, ...args) => {
    if (name === 'bot-capability' && fail) {
      fail = false
      throw new Error('temporary attachment failure')
    }
    return endpoint(name, body, ...args)
  }

  const first = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(first.ok, false)
  assert.equal(runtime.learningState().proposals[proposal.id].saved, true)
  const edit = await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the revised release checks.',
  })
  assert.equal(edit.ok, true)

  const retry = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(retry.ok, false)
  assert.match(JSON.stringify(retry), /release-checks changed since this was proposed/)
  assert.ok(runtime.learningState().proposals[proposal.id])
  assert.equal(runtime.teamState().capabilities.items['release-checks'].content, 'Run the revised release checks.')
  assert.equal(runtime.teamState().bots.b2.capabilities.includes('release-checks'), false)
})

test('deleting a learned skill clears ownership before a same-name skill is recreated', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({
    history,
    replies: [createReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = Object.values(runtime.learningState().proposals)[0]
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.value.applied, true)
  assert.deepEqual(runtime.learningState().learned.b2, ['release-checks'])

  const deleted = await runtime.call('capability-delete', { name: 'release-checks' })
  assert.equal(deleted.ok, true)
  assert.deepEqual(runtime.learningState().learned.b2, [])
  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the release checks.',
  })
  await runtime.call('bot-capability', { botId: 'b2', name: 'release-checks', attached: true })
  assert.ok(runtime.teamState().bots.b2.capabilities.includes('release-checks'))

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(runtime.requests.length, 2)
  const request = runtime.requests[1].messages[0].content[0].text
  assert.match(request, /This Bot has no learned skills yet\./)
  assert.match(request, /Other skills on the team:\n- release-checks:/)
  assert.deepEqual(runtime.learningState().learned.b2, [])
})

test('declined proposals are recorded and included in the next skill request', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({ history, replies: [createReply, noneReply] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().pending?.b2?.includes('b2'))
  await settle()
  assert.equal(runtime.requests.length, 1)

  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(answer.value.applied, false)
  await until(() => runtime.learningState().cursors?.b2 === 13 && runtime.learningState().pending?.b2 === undefined)
  assert.equal(runtime.teamState().capabilities.items['release-checks'], undefined)
  assert.equal(runtime.learningState().declined[0].name, 'release-checks')
  assert.match(runtime.requests[1].messages[0].content[0].text, /Proposals the user declined[\s\S]*- release-checks: Use when checking a release\./)
  // The declined card stays in the chat part it was answered in, read-only.
  const view = (await runtime.call('state')).value
  assert.equal(view.learning.b2, undefined)
  assert.deepEqual(view.learningSettled.b2.map(entry => [entry.id, entry.name, entry.outcome, entry.sessionId]), [[proposal.id, 'release-checks', 'declined', 'b2']])
  assert.equal(typeof view.learningSettled.b2[0].settledAt, 'number')
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: true })).ok, false)
})

test('declined skill descriptions reach only the originating Bot and ownerless entries are skipped', async t => {
  const history = { b2: [...ownChat] }
  const runtime = await startRuntime({
    history,
    learningSeed: { declined: [{ name: 'old-skill', description: 'Legacy description with unknown ownership.' }] },
    replies: [createReply, noneReply, noneReply],
    config: { learningTimes: { tickMs: 100_000 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  const proposal = (await runtime.call('state')).value.learning.b2[0]
  assert.equal((await runtime.call('learning-answer', { id: proposal.id, approve: false })).value.applied, false)
  await finishTurn(runtime.ctx, { id: 'm1' })
  addNextTurn(history)
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(runtime.learningState().declined.at(-1).botId, 'b2')
  assert.doesNotMatch(JSON.stringify(runtime.requests), /Legacy description/)
  assert.doesNotMatch(runtime.requests[1].messages[0].content[0].text, /Use when checking a release/)
  assert.match(runtime.requests[2].messages[0].content[0].text, /Use when checking a release/)
})

test('an update approval fails if the learned skill description alone changed', async t => {
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.capabilities = ['release-checks']
  seed.capabilities.items['release-checks'] = {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release.',
    content: 'Run the original release checks.',
    createdBy: 'b2',
    createdAt: 3,
    updatedAt: 3,
    learned: true,
  }
  const updateReply = JSON.stringify({
    action: 'update',
    name: 'release-checks',
    description: 'Use when checking a release.',
    content: 'Run the new release checks.',
    why: 'The work showed an additional step.',
  })
  const runtime = await startRuntime({ seed, replies: [updateReply], learningSeed: { learned: { b2: ['release-checks'] } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await until(() => Object.keys(runtime.learningState().proposals ?? {}).length === 1)
  const proposal = (await runtime.call('state')).value.learning.b2[0]

  await runtime.call('capability-save', {
    name: 'release-checks',
    kind: 'skill',
    description: 'Use when checking a release candidate.',
    content: 'Run the original release checks.',
  })
  const answer = await runtime.call('learning-answer', { id: proposal.id, approve: true })
  assert.equal(answer.ok, false)
  assert.match(JSON.stringify(answer), /release-checks changed since this was proposed/)
  assert.equal(runtime.teamState().capabilities.items['release-checks'].description, 'Use when checking a release candidate.')
  assert.equal(Object.keys(runtime.learningState().proposals).length, 1)
  const declined = await runtime.call('learning-answer', { id: proposal.id, approve: false })
  assert.equal(declined.ok, true)
  assert.equal(Object.keys(runtime.learningState().proposals).length, 0)
})

test('a saved secret in a proposed skill is not shown as a proposal', async t => {
  const secretValue = 'saved-secret-value-37'
  const runtime = await startRuntime({
    replies: [JSON.stringify({
      action: 'create',
      name: 'release-checks',
      description: 'Use when checking a release.',
      content: `Run with ${secretValue}.`,
      why: 'The work showed it is needed.',
    })],
  })
  t.after(() => runtime.stop())
  await runtime.call('secret-set', { name: 'LEARNING_TEST', value: secretValue })
  await finishTurn(runtime.ctx)
  await until(() => runtime.learningState().cursors?.b2 === 11)
  assert.deepEqual(runtime.learningState().proposals, {})
})

test('fresh skill cards reject credentials in all retained skill text', async t => {
  const skill = JSON.parse(createReply)
  const cases = [
    { field: 'name', reply: skill, value: skill.name },
    { field: 'description', reply: { ...skill, description: 'Use the fixtureabcdevalue when checking releases.' }, value: 'abcde' },
    { field: 'content', reply: { ...skill, content: `Use Basic ${Buffer.from('fixture:fake').toString('base64')}.` } },
    { field: 'why', reply: { ...skill, why: 'See https://example.test/?signature=fixture-proof.' } },
    { field: 'previous', reply: { ...skill, action: 'update' }, previous: 'See https://example.test/?signature=fixture-proof.' },
  ]
  for (const { field, reply, value, previous } of cases) await t.test(field, async t => {
    const seed = structuredClone(TEAM)
    if (previous) {
      seed.bots.b2.capabilities.push(skill.name)
      seed.capabilities.items[skill.name] = { ...skill, kind: 'skill', content: previous, createdBy: 'b2' }
    }
    const runtime = await startRuntime({
      seed, replies: [JSON.stringify(reply)], learningSeed: { learned: previous ? { b2: [skill.name] } : {} },
      config: { learningTimes: { tickMs: 100_000 } },
    })
    t.after(() => runtime.stop())
    if (value) assert.equal((await runtime.call('secret-set', { name: 'LEARNING_TEST', value })).ok, true)
    await finishTurn(runtime.ctx)
    assert.equal(await runtime.rt.learningRun(), 0)
    assert.deepEqual((await runtime.call('state')).value.learning, {})
    assert.deepEqual(runtime.learningState().proposals, {})
  })
})

test('an AGENTS edit containing a saved secret is not shown as a proposal', async t => {
  const folder = projectFolder(t)
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b2.workDir = folder
  const secretValue = 'agents-saved-secret-42'
  const reply = JSON.stringify({
    action: 'edit',
    edits: [{ op: 'add', after: '- Existing rule', text: `- Use ${secretValue}.`, why: 'The user corrected this repeatedly.' }],
  })
  const runtime = await startRuntime({ seed, replies: [noneReply, reply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await runtime.call('secret-set', { name: 'AGENTS_TEST', value: secretValue })
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.equal(Object.values(runtime.learningState().proposals ?? {}).length, 0)
  assert.equal(Object.keys(runtime.learningState().agentsPending ?? {}).length, 0)
})

test('a credential-bearing AGENTS baseline never reaches a review or learning state', async t => {
  const key = 'sk-examplefixture1234567890'
  const secret = 'agents-stored-fixture-37'
  const basic = `Basic ${Buffer.from('fixture:fake').toString('base64')}`
  for (const value of [key, secret, basic]) {
    const baseline = `# Project\n- Existing rule\n- Local setup: ${value}\n`
    const folder = projectFolder(t, { agents: baseline })
    const seed = structuredClone(TEAM)
    seed.bots.b2.workDir = folder
    const runtime = await startRuntime({ seed, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
    t.after(() => runtime.stop())
    assert.equal((await runtime.call('secret-set', { name: 'AGENTS_TEST', value: secret })).ok, true)
    await finishTurn(runtime.ctx)
    assert.equal(await runtime.rt.learningRun(), 0)
    assert.equal(runtime.requests.length, 1)
    assert.equal(JSON.stringify(runtime.requests).includes(value), false)
    assert.equal(readFileSync(runtime.learningPath, 'utf8').includes(value), false)
    assert.deepEqual(runtime.learningState().proposals, {})
    assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), baseline)
  }
})

test('a Basic commands heading allows review and approval of an unrelated AGENTS edit', async t => {
  const baseline = '## Basic commands\n- Existing rule\n'
  const folder = projectFolder(t, { agents: baseline })
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const runtime = await startRuntime({ seed, replies: [noneReply, agentsEdit], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  assert.equal(await runtime.rt.learningRun(), 1)
  assert.match(JSON.stringify(runtime.requests.at(-1)), /## Basic commands/)
  const [card] = (await runtime.call('state')).value.learning.b2
  assert.equal((await runtime.call('learning-answer', { id: card.id, approve: true })).value.applied, true)
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), `${baseline}- Keep the report concise.\n`)
})

test('a clean AGENTS edit survives review, restart, and approval when its baseline hash resembles an ID', async t => {
  const baseline = 'Run the 485 project checks.\n'
  assert.equal(hashOf(baseline), '416768226897123c')
  const folder = projectFolder(t, { agents: baseline })
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const edit = { op: 'add', after: '', text: '- Keep the report concise.', why: 'The user corrected the report format more than once.' }
  const config = { learningTimes: { tickMs: 100_000 } }
  let runtime = await startRuntime({ seed, config, replies: [noneReply, JSON.stringify({ action: 'edit', edits: [edit] })] })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  assert.equal(await runtime.rt.learningRun(), 1)
  assert.deepEqual(runtime.learningState().agentsPending, {})
  assert.match(JSON.stringify(runtime.requests.at(-1)), /Run the 485 project checks/)
  const [card] = (await runtime.call('state')).value.learning.b2
  await runtime.ctx.dispose()
  runtime = await startRuntime({ home: runtime.home, config })
  assert.ok(runtime.learningState().proposals[card.id])
  assert.equal((await runtime.call('learning-answer', { id: card.id, approve: true })).value.applied, true)
  assert.equal(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), `${baseline}${edit.text}\n`)
  await runtime.ctx.dispose()
  runtime = await startRuntime({ home: runtime.home, config })
  assert.equal(runtime.learningState().settled[card.id].outcome, 'approved')
})

test('AGENTS review rejects a saved secret in an edit field that does not affect the diff', async t => {
  const secret = 'agents-unused-fixture-37'
  const folder = projectFolder(t)
  const seed = structuredClone(TEAM)
  seed.bots.b2.workDir = folder
  const reply = JSON.parse(agentsEdit)
  reply.edits[0].old = secret
  const runtime = await startRuntime({ seed, replies: [noneReply, JSON.stringify(reply)], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  assert.equal((await runtime.call('secret-set', { name: 'AGENTS_TEST', value: secret })).ok, true)
  await finishTurn(runtime.ctx)
  assert.equal(await runtime.rt.learningRun(), 0)
  assert.equal(runtime.requests.length, 2)
  assert.equal(readFileSync(runtime.learningPath, 'utf8').includes(secret), false)
})

test('user corrections remain in long chat reviews after the text budget', async t => {
  const runtime = await startRuntime({ replies: [noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  const lines = Array.from({ length: 30 }, (_, index) => ({
    seq: 41 - index,
    who: 'assistant',
    text: `Bot: ${'x'.repeat(1_200)}`,
  }))
  lines.push({ seq: 10, who: 'user', text: 'User: Keep the correction even when the Bot writes a long answer.' })
  runtime.rt.partLines = async function* () {
    yield* lines
  }
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()
  assert.match(runtime.requests[0].messages[0].content[0].text, /User: Keep the correction even when the Bot writes a long answer\./)
})

test('a failed chat read keeps that Bot pending while other Bots are reviewed', async t => {
  const seed = JSON.parse(JSON.stringify(TEAM))
  seed.bots.b3 = { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Coding', model: 'deepseek/v4', instructions: '', capabilities: [], createdAt: 3 }
  const runtime = await startRuntime({ seed, replies: [noneReply], config: { learningTimes: { tickMs: 100_000 } } })
  t.after(() => runtime.stop())
  runtime.rt.partLines = async function* (sessionId) {
    if (sessionId === 'b2') throw new Error('session read failed')
    yield { seq: 11, who: 'user', text: 'User: Review this work' }
  }
  await finishTurn(runtime.ctx, { id: 'b2' })
  await finishTurn(runtime.ctx, { id: 'b3' })
  await until(() => runtime.learningState().pending?.b2?.length && runtime.learningState().pending?.b3?.length)

  await runtime.rt.learningRun()

  assert.deepEqual(runtime.learningState().pending.b2, ['b2'])
  assert.equal(runtime.learningState().pending.b3, undefined)
  assert.equal(runtime.learningState().cursors.b3, 11)
  assert.equal(runtime.requests.length, 1)
})

test('a learning review retries TRANSPORT and TIMEOUT failures on the same route and discards partial text', async t => {
  const runtime = await startRuntime({
    replies: [
      { text: '{"action":"create","name":"half', finish: 'error', failure: { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' } },
      { text: '', finish: 'error', failure: { code: 'TIMEOUT', message: 'DeepSeek Messages stream idle timeout' } },
      createReply,
    ],
    config: { learningTimes: { tickMs: 100_000 }, llmRetryBackoff: { initialDelayMs: 1, maxDelayMs: 5 } },
  })
  t.after(() => runtime.stop())
  await finishTurn(runtime.ctx)
  await runtime.rt.learningRun()

  assert.equal(runtime.requests.length, 3)
  const proposals = Object.values(runtime.learningState().proposals ?? {})
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0].name, 'release-checks')
  assert.equal(runtime.learningState().pending?.b2, undefined)
})

test('learning rebuilds its skill request when a secret is saved before retry or fallback', async t => {
  for (const code of ['TRANSPORT', 'AUTH']) await t.test(code, async t => {
    const value = 'newly-saved-retry-fixture'
    const first = Promise.withResolvers()
    const runtime = await startRuntime({
      replies: [first.promise, createReply],
      config: { learningTimes: { tickMs: 100_000 }, llmRetryBackoff: { initialDelayMs: 1, maxDelayMs: 5 } },
    })
    t.after(() => runtime.stop())
    runtime.rt.desiredModel = async () => 'fallback/v4'
    runtime.rt.answersAside = () => true
    runtime.rt.partLines = async function* () {
      yield { seq: 11, who: 'user', text: `User: Use ${value}.` }
      yield { seq: 10, who: 'user', text: 'User: Keep public release work.' }
    }
    await finishTurn(runtime.ctx)
    const waiting = runtime.rt.learningRun()
    await until(() => runtime.requests.length === 1)
    assert.match(JSON.stringify(runtime.requests[0]), /newly-saved-retry-fixture/)
    try {
      assert.equal((await runtime.call('secret-set', { name: 'LEARNING_TEST', value })).ok, true)
    } finally {
      first.resolve({ text: '', finish: 'error', failure: { code, message: 'fixture error' } })
    }
    assert.equal(await waiting, 0)
    assert.equal(runtime.requests.length, 1)
    assert.deepEqual(runtime.learningState().pending.b2, ['b2'])
    assert.equal(await runtime.rt.learningRun(), 1)
    assert.equal(runtime.requests.length, 2)
    const request = JSON.stringify(runtime.requests[1])
    assert.match(request, /Keep public release work/)
    assert.doesNotMatch(request, /newly-saved-retry-fixture/)
  })
})

test('folder learning rechecks path privacy after model selection and before retry', async t => {
  for (const retry of [false, true]) await t.test(retry ? 'transport retry' : 'model selection', async t => {
    const folder = realpathSync(projectFolder(t))
    const seed = structuredClone(TEAM)
    seed.bots.b2.workDir = folder
    seed.bots.b3 = { ...seed.bots.b2, id: 'b3', sessionId: 'b3', name: 'Coder', workDir: undefined }
    const runtime = await startRuntime({
      seed, replies: [noneReply, { text: '', finish: 'error', failure: { code: 'TRANSPORT', message: 'fixture error' } }, agentsEdit],
      config: { learningTimes: { tickMs: 100_000 }, llmRetryBackoff: { initialDelayMs: 1, maxDelayMs: 5 } },
    })
    t.after(() => runtime.stop())
    const makePrivate = async () => {
      await runtime.rt.updateBot('b2', { workDir: projectFolder(t) })
      await runtime.rt.updateBot('b3', { workDir: folder, private: true })
    }
    if (retry) {
      const stream = runtime.ctx.llm.stream
      runtime.ctx.llm.stream = async function* (request) {
        yield* stream(request)
        if (runtime.requests.length === 2) await makePrivate()
      }
    } else {
      const model = runtime.rt.backgroundModel
      runtime.rt.backgroundModel = async (...args) => {
        if (runtime.requests.length === 1) await makePrivate()
        return model(...args)
      }
    }
    await finishTurn(runtime.ctx)
    assert.equal(await runtime.rt.learningRun(), 0)
    assert.equal(runtime.requests.length, retry ? 2 : 1)
    assert.deepEqual((await runtime.call('state')).value.learning, {})
    assert.deepEqual(runtime.learningState().agentsPending, {})
  })
})

