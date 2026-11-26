import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createRuntime } from '../index.js'
import { call } from '../src/client/api.js'
import { teamActions } from '../src/client/team-actions.js'
import { assembleLlmStream } from '../src/host/models.js'
import * as skills from '../src/host/skill-library.js'
import { SKILL_CHECK_HISTORY } from '../src/host/skill-check-version.js'
import { skillHash, textSkillMd } from '../src/host/skill-library-rules.js'
import { fakeContext } from './fake-ctx.js'
import { browser, bundle, load, manualTimeouts, react, reply, refusal, tick, viewerReply } from './viewer-fixture.js'

const actor = { id: 'fixture-owner', role: 'owner' }
const form = { name: 'sample-notes', description: 'A sample note.', content: 'Write a sample note.' }
const clean = '{"findings":[],"overflow":false}'
const delta = text => ({ type: 'text-delta', index: 0, text })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const finding = (area, file = 'SKILL.md') => JSON.stringify({ file, line: null, area, severity: 'low', reason: 'Synthetic classification.' })
const report = area => `{"findings":[${finding(area)}],"overflow":false}`
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'))

function home(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'skill-exception-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function fixture(t, { dir = home(t), llm, stream } = {}) {
  let calls = 0
  let generation = 1
  const ctx = { llm: llm ?? { async *stream(request) {
    calls++
    if (stream) yield* stream(request, calls)
    else yield* [delta(clean), stop]
  } } }
  const rt = {
    home: dir, ctx, botOf: id => id === 'b' ? { id } : undefined, readOnly: () => undefined,
    teamCurrent: () => true, teamGeneration: () => generation, sameTeam: value => value === generation,
    skillReviewModel: async () => 'fixture-provider/fixture-model',
    assembleLlm: (request, options) => assembleLlmStream(ctx, request, options),
  }
  const restart = () => skills.install(rt)
  restart()
  const endpoint = (name, payload, caller = actor) => rt.skillLibrary.endpoint(name, payload, caller)
  return { rt, path: join(dir, 'skill-library', 'library.json'), endpoint, restart,
    save: (input = form, caller = actor) => endpoint('skill-library-save', input, caller),
    calls: () => calls, switchTeam: () => { generation++ },
    writes: name => fs.readFileSync(join(dir, 'skill-library', 'audit.jsonl'), 'utf8').trim().split('\n')
      .map(JSON.parse).filter(row => row.target === name && row.outcome === 'allowed').length }
}

function putLegacy(dir, name = 'legacy-notes') {
  const record = { ...form, name, source: { kind: 'text' }, check: { version: 2, fingerprint: SKILL_CHECK_HISTORY[2] } }
  record.hash = skillHash([{ path: 'SKILL.md', bytes: textSkillMd(record) }])
  fs.mkdirSync(join(dir, 'skill-library'), { mode: 0o700 })
  fs.writeFileSync(join(dir, 'skill-library', 'library.json'), JSON.stringify({ version: 1, skills: { [name]: record }, active: { b: [name] } }), { mode: 0o600 })
  return record
}

const transportModel = { provider: 'fixture-provider', id: 'fixture-model', name: 'Fixture', api: 'openai-completions',
  baseUrl: 'https://provider.invalid/v1', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsFinishReason: false } }

test('exception 1 requires a provider finish reason through actual pi-ai compatibility streaming', async t => {
  // Both pi-ai and the DSH adapter run as installed from the test harness pin.
  const { openAICompletionsApi } = await import(new URL('node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js', `file://${process.env.DSH_HARNESS}/`))
  const api = openAICompletionsApi()
  const profile = { provider: transportModel.provider, streamIdleTimeoutMs: 3000, modelErrors: new Map(), configuredMaxTokens: new Map() }
  const adapter = new PiAiAdapter({ profiles: () => new Map([[transportModel.provider, profile]]), resolveApiKey: async () => 'fixture-key' })
  const snapshot = { profiles: new Map([[transportModel.provider, profile]]), models: {
    getModel: () => transportModel,
    streamSimple: (model, context, options) => api.streamSimple(model, context, options),
  } }
  t.mock.method(adapter, 'current', () => snapshot)
  const root = new Context()
  const llm = new LlmRuntime(root)
  llm.registerAdapter([transportModel.provider], adapter)
  t.after(() => root.fiber.dispose())
  let finished = true
  let requests = 0
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://provider.invalid/v1/chat/completions')
    requests++
    const frame = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: transportModel.id }
    const row = (value, finish_reason) => 'data: ' + JSON.stringify({ ...frame, choices: [{ index: 0, delta: value, finish_reason }] }) + '\n\n'
    return new Response(row({ content: clean }, null) + (finished ? row({}, 'stop') : '') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  })
  const f = fixture(t, { llm })
  assert.deepEqual(await f.save(), { saved: true })
  finished = false
  const result = await f.save({ ...form, name: 'missing-finish' })
  assert.equal(requests, 2)
  assert.equal(result.refused, true, 'an inferred compatibility stop must not sign a review')
  assert.equal(read(f.path).skills['missing-finish'], undefined)
  assert.equal(Object.keys(read(f.path).reviews).length, 1)
  const ordinary = await assembleLlmStream({ llm }, { provider: transportModel.provider, model: transportModel.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A fixture request.' }] }], tools: [] })
  assert.equal(ordinary.observedFinish?.kind, 'stop')
  assert.deepEqual(transportModel.compat, { supportsFinishReason: false })
})

for (const mode of ['aborted', 'timeout', 'sibling', 'error']) {
  test(`exception 2 keeps a complete safety row across ${mode}`, async t => {
    const sent = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.after(release.resolve)
    if (mode === 'timeout') t.mock.method(AbortSignal, 'timeout', () => {
      const deadline = new AbortController()
      void sent.promise.then(() => deadline.abort(new DOMException('Fixture deadline', 'TimeoutError')))
      return deadline.signal
    })
    let interrupted = true
    const f = fixture(t, { async *stream(request) {
      if (!interrupted) { yield* [delta(clean), stop]; return }
      if (request.messages[0].content[0].text.includes(' chunk ') && / chunk .* path=notes\.txt\n/.test(request.messages[0].content[0].text)) {
        await sent.promise
        yield delta('incomplete fixture response')
        yield stop
        return
      }
      const row = finding('prompt-injection')
      if (mode === 'timeout') yield delta(report('prompt-injection'))
      else {
        yield delta('{"overflow":false,"findings":[' + finding('prompt-injection', 'wrong.txt') + ',')
        yield delta(row.slice(0, 25))
        yield delta(row.slice(25) + ',{"file":')
      }
      sent.resolve()
      if (mode === 'timeout' || mode === 'sibling') await release.promise
      else yield { type: 'finish', reason: mode === 'aborted' ? { kind: 'aborted' } : { kind: 'error', failure: { code: 'FIXTURE', message: 'Fixture interruption' } } }
    } })
    const entries = [{ path: 'SKILL.md', bytes: textSkillMd(form) }]
    if (mode === 'sibling') entries.push({ path: 'notes.txt', bytes: Buffer.from('A local note.') })
    const hash = skillHash(entries)
    const run = () => mode === 'sibling'
      ? f.rt.skillLibrary.reviewSkill({ name: form.name, entries, check: { hash, injection: [], verdict: 'pass', findings: [], counts: {} },
        caller: { identity: actor.id, generation: 1 } })
      : f.save()
    try {
      const result = await run()
      assert.equal(result.findings?.length, 1, 'only the complete safety row for this frame is retained')
      assert.equal(result.findings[0].area, 'prompt-injection')
      assert.equal(read(f.path).reviewBlocks[hash].findings[0].area, 'prompt-injection')
      const calls = f.calls()
      interrupted = false
      f.restart()
      assert.equal((await run()).findings[0].area, 'prompt-injection')
      assert.equal(f.calls(), calls)
      assert.equal(read(f.path).skills[form.name], undefined)
    } finally { release.resolve() }
  })
}

for (const stored of [false, true]) {
  test(`carried 5 preserves operation ID and one write for ${stored ? 'stored bytes' : 'ordinary Edit'}`, async t => {
    const dir = home(t)
    const legacy = putLegacy(dir)
    const f = fixture(t, { dir })
    assert.deepEqual(await f.save(), { saved: true })
    const input = stored ? { name: legacy.name, edit: true, reviewHash: legacy.hash }
      : { ...form, edit: true, content: 'A different sample note.' }
    const priorCalls = f.calls()
    const priorWrites = f.writes(input.name)
    const requests = []
    let lose = 'request'
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const { payload } = JSON.parse(options.body)
      requests.push(payload)
      const result = await f.save(payload).then(reply, error => refusal(error.code, error.message))
      if (lose === 'request') { lose = 'none'; throw new Error('Fixture disconnect after dispatch') }
      if (lose === 'body') {
        lose = 'none'
        return { ok: true, json: async () => { throw new TypeError('Fixture interrupted body') } }
      }
      return result
    })
    const { sessionStorage: skillStorage } = browser()
    const client = () => teamActions({ call, after: promise => promise, skillStorage })
    await assert.rejects(client().saveSkill(input), { code: 'NETWORK' })
    await waitForCommit(() => f.save({ operation: requests[0].operation, poll: true }))
    lose = 'body'
    const fresh = client()
    await assert.rejects(fresh.saveSkill(input), error => error.code === 'NETWORK' || error.cause === undefined && error instanceof TypeError)
    assert.equal(lose, 'none', 'the fresh client reached and consumed the response body')
    const operation = requests[0].operation
    await waitForCommit(() => f.save({ operation: requests.at(-1).operation, poll: true })).catch(error => {
      if (error.code !== 'bot/refused') throw error
    })
    // Record both comparisons before failing, so the original parent exercises
    // the write-count check as well as the operation check on both routes.
    const counts = () => ({ ids: new Set(requests.map(request => request.operation)).size,
      writes: f.writes(input.name) - priorWrites, reviews: f.calls() - priorCalls })
    assert.deepEqual(counts(), { ids: 1, writes: 1, reviews: 1 }, 'fresh client operation and commit counts after both interruptions')
    assert.match(operation, /^[a-f0-9]{32}$/)
    assert.deepEqual(await client().resumeSkillSaves(), [{ status: 'fulfilled', value: { saved: true } }])
    assert.deepEqual(counts(), { ids: 1, writes: 1, reviews: 1 })
    assert.equal(skillStorage.length, 0)
    await assert.rejects(f.save({ operation, poll: true }, { ...actor, id: 'other-actor' }), { code: 'bot/not-found' })
  })
}

for (const warn of [false, true]) {
  test(`exception 3 recovers ${warn ? 'the warning and exact form' : 'one committed Edit'} after a same-viewer remount`, async t => {
    const f = fixture(t, { async *stream(_request, count) { yield* [delta(warn && count > 1 ? report('other') : clean), stop] } })
    await f.save()
    const input = { ...form, edit: true, content: 'A second sample note.' }
    const code = await bundle(`
      export { startViewer } from './src/client/viewer.js'
      export { call } from './src/client/api.js'
      export { teamActions } from './src/client/team-actions.js'
      export { SkillsScreen } from './src/client/skills-screen.js'
    `)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.after(release.resolve)
    const boot = { version: 1, role: 'owner' }
    let operation
    let first = true
    const { hooks, mountComponent } = componentFixture(t)
    const web = browser({ boot, hooks, async fetch({ body }) {
      if (body.endpoint === 'whoami') return viewerReply('owner', actor.id)
      assert.equal(body.viewer, actor.id)
      const result = await f.endpoint(body.endpoint, body.payload)
      if (first) {
        first = false
        operation = body.payload.operation
        entered.resolve()
        await release.promise
      }
      return reply(result)
    } })
    web.window.AbortController = AbortController
    Object.assign(web.globals, { crypto: globalThis.crypto, TextEncoder })
    const api = load(code, web.globals)
    const mount = new AbortController()
    const replacement = new AbortController()
    t.after(() => { mount.abort(); replacement.abort() })
    const client = () => api.teamActions({ call: api.call, after: promise => promise })
    await api.startViewer(boot, mount.signal)
    const saving = client().saveSkill(input)
    const retired = assert.rejects(saving, { code: 'bot/retired' })
    await entered.promise
    mount.abort()
    release.resolve()
    await retired
    await api.startViewer(boot, replacement.signal)
    const priorWrites = warn ? 1 : 2
    const host = await waitForCommit(() => f.save({ operation, poll: true }))
    assert.equal(f.writes(form.name), priorWrites)
    const replacementActions = client()
    const resuming = replacementActions.resumeSkillSaves()
    const retrying = warn ? undefined : replacementActions.saveSkill(input)
    const recovered = await resuming
    assert.equal(recovered.length, 1, JSON.stringify({ hostSaved: !!host.saved, hostAwaitingConfirmation: !!host.needsConfirm,
      writes: f.writes(form.name), replacementOperations: recovered.length }))
    assert.equal(recovered[0].status, 'fulfilled')
    if (!warn) {
      assert.deepEqual(recovered[0].value, { saved: true })
      assert.deepEqual(await retrying, { saved: true })
      assert.ok(web.calls.filter(row => row.body.endpoint === 'skill-library-save').every(row => row.body.payload.operation === operation))
      assert.equal(f.writes(form.name), 2)
      return
    }
    const warning = recovered[0].value
    assert.equal(warning.needsConfirm, host.needsConfirm)
    assert.deepEqual(warning.form, input)
    const altered = await f.save({ ...input, content: 'Another sample.', confirm: warning.needsConfirm })
    assert.ok(altered.needsConfirm)
    assert.equal(f.writes(form.name), 1)
    const owner = api.SkillsScreen({ actions: { ...replacementActions, resumeSkillSaves: async () => recovered },
      rosterSource: { subscribe() {}, getSnapshot: () => ({}) } })
    const screen = mountComponent(owner)
    screen()
    await tick()
    const formView = screen().props.children.find(child => child?.type?.name === 'SkillForm')
    assert.equal(formView.props.report.needsConfirm, warning.needsConfirm)
    const renderForm = mountComponent(formView)
    const rendered = renderForm()
    const instructions = rendered.props.children.find(child => child?.props?.label === 'Skill instructions')
    assert.equal(instructions.props.value, input.content)
    await rendered.props.onSubmit({ preventDefault() {} })
    const submitted = web.calls.findLast(row => row.body.endpoint === 'skill-library-save' && !row.body.payload.poll)
    assert.equal(submitted.body.payload.confirm, warning.needsConfirm)
    assert.equal((await f.endpoint('skill-library-get', { name: form.name })).content, input.content)
    assert.equal(f.writes(form.name), 2)
    await assert.rejects(f.save({ operation, poll: true, recover: true }, { ...actor, id: 'other-actor' }), { code: 'bot/not-found' })
    f.switchTeam()
    await assert.rejects(f.save({ operation, poll: true, recover: true }), { code: 'bot/not-found' })
  })
}

function componentFixture(t) {
  let slots
  let cursor
  const hooks = { ...react,
    useState(initial) {
      const state = slots
      const index = cursor++
      if (!Object.hasOwn(state, index)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useEffect(effect) {
      if (slots[cursor++]) return
      slots[cursor - 1] = true
      queueMicrotask(() => { const cleanup = effect(); if (cleanup) t.after(cleanup) })
    },
  }
  const mountComponent = element => {
    const state = []
    return () => {
      slots = state
      cursor = 0
      return element.type(element.props)
    }
  }
  return { hooks, mountComponent }
}

async function waitForCommit(poll) {
  const deadline = Date.now() + 3000
  for (;;) {
    const result = await poll()
    if (!result.pending) return result
    assert.ok(Date.now() < deadline, 'fixture save did not settle')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('exception 4 case-insensitive state is visible only after the staged library can recover', async t => {
  const src = home(t)
  const dest = home(t)
  putLegacy(src)
  fs.writeFileSync(join(src, 'STATE.JSON'), '{"version":1}', { mode: 0o600 })
  const realExists = fs.existsSync
  const realRead = fs.readFileSync
  const realCopy = fs.cpSync
  const realStat = fs.statSync
  let interrupt = true
  const filesystemPath = path => typeof path === 'string' && path.endsWith('/state.json') &&
    [src, dest].some(dir => path === join(dir, 'state.json')) && !realExists(path) && realExists(join(path, '../STATE.JSON'))
    ? join(path, '../STATE.JSON') : path
  const mocks = [
    t.mock.method(fs, 'existsSync', path => realExists(filesystemPath(path))),
    t.mock.method(fs, 'readFileSync', (path, ...args) => realRead(filesystemPath(path), ...args)),
    t.mock.method(fs, 'statSync', (path, ...args) => realStat(filesystemPath(path), ...args)),
    t.mock.method(fs, 'cpSync', (from, to, options) => {
      if (interrupt && from === join(src, 'skill-library')) throw new Error('Fixture interrupted Skills staging')
      return realCopy(from, to, options)
    }),
  ]
  syncBuiltinESMExports()
  try {
    assert.throws(() => createRuntime(fakeContext(), { home: dest, importHome: src }), /interrupted Skills staging/)
    interrupt = false
    const publishedEarly = fs.existsSync(join(dest, 'state.json'))
    const resumed = createRuntime(fakeContext(), { home: dest, importHome: src })
    await resumed.load()
    resumed.dispose()
    assert.deepEqual({ publishedEarly, recovered: fs.existsSync(join(dest, 'skill-library', 'library.json')) },
      { publishedEarly: false, recovered: true })
    assert.equal(read(join(dest, 'skill-library', 'library.json')).skills['legacy-notes'].name, 'legacy-notes')
  } finally {
    for (const mock of mocks) mock.mock.restore()
    syncBuiltinESMExports()
  }
})

test('final exception 1 preserves a native failure behind a normalized stop', async t => {
  const { openAICompletionsApi } = await import(new URL('node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js', `file://${process.env.DSH_HARNESS}/`))
  const api = openAICompletionsApi()
  // The pinned transport detects OpenRouter compatibility from the provider ID.
  const model = { ...transportModel, provider: 'openrouter' }
  const profile = { provider: model.provider, streamIdleTimeoutMs: 3000, modelErrors: new Map(), configuredMaxTokens: new Map() }
  const profiles = new Map([[model.provider, profile]])
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => 'fixture-key' })
  t.mock.method(adapter, 'current', () => ({ profiles, models: { getModel: () => model, streamSimple: api.streamSimple } }))
  const root = new Context()
  const llm = new LlmRuntime(root)
  llm.registerAdapter([model.provider], adapter)
  t.after(() => root.fiber.dispose())
  let native = 'end_turn'
  let requests = 0
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(String(url), 'https://provider.invalid/v1/chat/completions')
    requests++
    const frame = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: model.id }
    const row = choice => 'data: ' + JSON.stringify({ ...frame, choices: [{ index: 0, ...choice }] }) + '\n\n'
    return new Response(row({ delta: { content: clean }, finish_reason: null }) +
      row({ delta: {}, finish_reason: 'stop', native_finish_reason: native }) + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
  })
  const f = fixture(t, { llm })
  f.rt.skillReviewModel = async () => model.provider + '/' + model.id
  assert.deepEqual(await f.save(), { saved: true })
  native = 'MALFORMED_RESPONSE'
  const input = { ...form, name: 'interrupted-notes' }
  const refused = await f.save(input)
  const direct = await assembleLlmStream({ llm }, { provider: model.provider, model: model.id,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'A fixture request.' }] }], tools: [] }, { requireProviderFinish: true })
  const state = read(f.path)
  assert.deepEqual({ refused: !!refused.refused, skill: state.skills[input.name], seals: Object.keys(state.reviews).length,
    finish: direct.finish.kind, observed: direct.observedFinish?.kind, requests },
  { refused: true, skill: undefined, seals: 1, finish: 'error', observed: 'error', requests: 3 })
})

for (const mode of ['aborted', 'sibling', 'cut report']) {
  test(`final exception 2 retains independently valid rows before ${mode}`, async t => {
    const sent = Promise.withResolvers()
    const release = Promise.withResolvers()
    t.after(release.resolve)
    // Entries and classifications are synthetic. Nested and quoted rows are inert fixture values.
    const row = finding('prompt-injection')
    const prefix = '{"findings":[null,32,' + JSON.stringify(row) + ',[' + row + '],' +
      finding('prompt-injection', 'wrong.txt') + ','
    let interrupted = true
    const f = fixture(t, { async *stream(request) {
      if (!interrupted) { yield* [delta(clean), stop]; return }
      if (/ chunk .* path=notes\.txt\n/.test(request.messages[0].content[0].text)) {
        await sent.promise
        yield delta('Incomplete fixture report.')
        yield stop
        return
      }
      yield delta(prefix)
      yield delta(row.slice(0, 25))
      yield delta(row.slice(25) + ',{"file":')
      sent.resolve()
      if (mode === 'sibling') await release.promise
      else yield mode === 'aborted' ? { type: 'finish', reason: { kind: 'aborted' } } : stop
    } })
    const entries = [{ path: 'SKILL.md', bytes: textSkillMd(form) }]
    if (mode === 'sibling') entries.push({ path: 'notes.txt', bytes: Buffer.from('A local note.') })
    const hash = skillHash(entries)
    const run = () => mode === 'sibling'
      ? f.rt.skillLibrary.reviewSkill({ name: form.name, entries, check: { hash, injection: [], verdict: 'pass', findings: [], counts: {} },
        caller: { identity: actor.id, generation: 1 } })
      : f.save()
    const result = await run()
    const recorded = fs.existsSync(f.path) ? read(f.path).reviewBlocks?.[hash]?.findings : undefined
    const calls = f.calls()
    interrupted = false
    f.restart()
    const afterReload = await run()
    const reasons = findings => findings?.map(({ area, reason }) => ({ area, reason }))
    const expected = [{ area: 'prompt-injection', reason: 'Synthetic classification.' }]
    assert.deepEqual({ refused: reasons(result.findings), recorded: reasons(recorded), later: reasons(afterReload.findings),
      additionalCalls: f.calls() - calls, saved: read(f.path).skills[form.name]?.name },
    { refused: expected, recorded: expected, later: expected, additionalCalls: 0, saved: undefined })
  })
}

async function assertCancelledReviewBlocked(t, ...chunks) {
  const sent = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(release.resolve)
  let cancelledSignal
  let interrupted = true
  const f = fixture(t, { async *stream(request) {
    if (!interrupted) { yield* [delta(clean), stop]; return }
    if (/ chunk .* path=notes\.txt\n/.test(request.messages[0].content[0].text)) {
      await sent.promise
      yield* [delta('Incomplete fixture report.'), stop]
      return
    }
    cancelledSignal = request.signal
    for (const chunk of chunks) yield delta(chunk)
    sent.resolve()
    await release.promise
  } })
  const entries = [{ path: 'SKILL.md', bytes: textSkillMd(form) }, { path: 'notes.txt', bytes: Buffer.from('A local note.') }]
  const hash = skillHash(entries)
  const run = () => f.rt.skillLibrary.reviewSkill({ name: form.name, entries,
    check: { hash, injection: [], verdict: 'pass', findings: [], counts: {} },
    caller: { identity: actor.id, generation: 1 } })

  const cancelled = await run()
  assert.equal(cancelledSignal.aborted, true)
  assert.equal(cancelled.decision, 'refuse')
  const recorded = fs.existsSync(f.path) ? read(f.path).reviewBlocks?.[hash] : undefined
  const calls = f.calls()
  interrupted = false
  f.restart()
  const reloaded = await run()
  const expected = [JSON.parse(finding('prompt-injection'))]
  assert.deepEqual({ recorded: recorded?.findings, decision: reloaded.decision, why: reloaded.why, calls: f.calls() - calls },
    { recorded: expected, decision: 'refuse', why: 'injection', calls: 0 }, 'the cancelled review durably blocks the same hash')
}

test('shared review parser keeps a complete safety finding blocked across cancellation and reload', t => {
  return assertCancelledReviewBlocked(t, String.raw`{"overfl\u006fw":false,"f\u0069ndings":[`, finding('prompt-injection') + ',{"file":')
})

test('shared review parser uses the last repeated findings property across cancellation and reload', t => {
  return assertCancelledReviewBlocked(t, `{"findings":[],"findings":[${finding('prompt-injection')}],"overflow":false}`)
})

for (const remountFirst of [false, true]) {
  test(`final exception 3 preserves the initiating Save between polls (replacement first: ${remountFirst})`, async t => {
    const f = fixture(t)
    await f.save()
    const input = { ...form, edit: true, content: 'A newer sample note.' }
    const code = await bundle(`
      export { startViewer } from './src/client/viewer.js'
      export { call } from './src/client/api.js'
      export { teamActions } from './src/client/team-actions.js'
    `)
    const timers = manualTimeouts()
    const boot = { version: 1, role: 'owner' }
    let initial
    const web = browser({ boot, timers: timers.timers, async fetch({ body }) {
      if (body.endpoint === 'whoami') return viewerReply('owner', actor.id)
      assert.equal(body.viewer, actor.id)
      const result = await f.save(body.payload)
      if (!body.payload.poll) {
        assert.equal(result.pending, true)
        initial = body.payload.operation
      }
      return reply(result)
    } })
    Object.assign(web.globals, { crypto: globalThis.crypto, TextEncoder })
    const api = load(code, web.globals)
    const mount = new AbortController()
    const replacement = new AbortController()
    t.after(() => { mount.abort(); replacement.abort() })
    const client = () => api.teamActions({ call: api.call, after: promise => promise })
    await api.startViewer(boot, mount.signal)
    const old = client().saveSkill(input).then(result => ({ result }), error => ({ code: error.code }))
    await waitForCommit(async () => ({ pending: initial === undefined }))
    await tick()
    assert.equal(web.calls.filter(({ body }) => body.endpoint === 'skill-library-save').length, 1)
    mount.abort()
    if (remountFirst) await api.startViewer(boot, replacement.signal)
    assert.deepEqual(await waitForCommit(() => f.save({ operation: initial, poll: true })), { saved: true })
    timers.advance(750)
    const retired = await old
    if (!remountFirst) await api.startViewer(boot, replacement.signal)
    const recovered = await client().resumeSkillSaves()
    const ids = web.calls.filter(({ body }) => body.endpoint === 'skill-library-save').map(({ body }) => body.payload.operation)
    assert.deepEqual({ error: retired.code, recovered: Array.from(recovered, row => row.status === 'fulfilled' && row.value.saved),
      ids: [...new Set(ids)], reviews: f.calls() - 1, writes: f.writes(form.name) - 1 },
    { error: 'bot/retired', recovered: [true], ids: [initial], reviews: 1, writes: 1 })
    assert.equal((await f.endpoint('skill-library-get', { name: form.name })).content, input.content)
  })
}

test('final exception 4 publishes canonical state only after mixed-case filesystem staging', async t => {
  const src = home(t)
  const dest = home(t)
  putLegacy(src)
  fs.writeFileSync(join(src, 'state.json'), '{"version":1,"fixture":"canonical"}', { mode: 0o600 })
  fs.writeFileSync(join(src, 'STATE.JSON'), '{"version":1,"fixture":"alias"}', { mode: 0o600 })
  assert.notEqual(fs.statSync(join(src, 'STATE.JSON')).ino, fs.statSync(join(src, 'state.json')).ino)
  const realExists = fs.existsSync
  const realCopy = fs.cpSync
  let interrupt = true
  const mocks = [
    t.mock.method(fs, 'existsSync', path => realExists(path) ||
      (path === join(dest, 'state.json') && realExists(join(dest, 'STATE.JSON')))),
    t.mock.method(fs, 'cpSync', (from, to, options) => {
      if (interrupt && from === join(src, 'skill-library')) throw new Error('Fixture interrupted mixed-case staging')
      return realCopy(from, to, options)
    }),
  ]
  syncBuiltinESMExports()
  try {
    assert.throws(() => createRuntime(fakeContext(), { home: dest, importHome: src }), /interrupted mixed-case staging/)
    const publishedEarly = fs.existsSync(join(dest, 'state.json'))
    interrupt = false
    const resumed = createRuntime(fakeContext(), { home: dest, importHome: src })
    try {
      const recovered = realExists(join(dest, 'skill-library', 'library.json'))
      const canonical = join(dest, 'state.json')
      assert.deepEqual({ publishedEarly, recovered, state: realExists(canonical) ? read(canonical).fixture : undefined },
        { publishedEarly: false, recovered: true, state: 'canonical' })
    } finally {
      try { await resumed.load() } finally { resumed.dispose() }
    }
  } finally {
    for (const mock of mocks) mock.mock.restore()
    syncBuiltinESMExports()
  }
})
