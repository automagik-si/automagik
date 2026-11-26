import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { call as clientCall } from '../src/client/api.js'
import { teamActions } from '../src/client/team-actions.js'
import { assembleLlmStream } from '../src/host/models.js'
import { checkSkill } from '../src/host/skill-check.js'
import * as skills from '../src/host/skill-library.js'
import { SKILL_CHECK_HISTORY } from '../src/host/skill-check-version.js'
import { skillHash, textSkillMd } from '../src/host/skill-library-rules.js'
import { fakeContext } from './fake-ctx.js'

const actor = { id: 'fixture-owner', role: 'owner' }
const form = { name: 'sample-notes', description: 'A sample note.', content: 'Write a short sample note.' }
const clean = '{"findings":[],"overflow":false}'
const delta = text => ({ type: 'text-delta', index: 0, text })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const reply = (file, line, area = 'other') => JSON.stringify({ findings: [
  { file, line, area, severity: 'low', reason: 'Synthetic classification.' },
], overflow: false })
const read = path => JSON.parse(fs.readFileSync(path, 'utf8'))

function home(t) {
  const path = fs.mkdtempSync(join(tmpdir(), 'skill-correction-'))
  t.after(() => fs.rmSync(path, { recursive: true, force: true }))
  return path
}

function fixture(t, { dir = home(t), stream, holdPreexistingTyped } = {}) {
  let calls = 0
  const ctx = { llm: {
    async *stream(request) {
      assert.equal(request.provider, 'fixture-provider')
      assert.equal(request.model, 'fixture-model')
      assert.deepEqual(request.tools, [])
      calls++
      if (stream) yield* stream(request, calls)
      else yield* [delta(clean), stop]
    },
    providerRetryPolicy: () => ({ mode: 'normal', retryableCodes: ['TRANSPORT'], maxRetries: 1,
      initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }),
  } }
  const rt = {
    home: dir, ctx, botOf: id => id === 'b' ? { id } : undefined, readOnly: () => undefined,
    teamCurrent: () => true, teamGeneration: () => 1, sameTeam: value => value === 1,
    skillReviewModel: async () => 'fixture-provider/fixture-model',
    assembleLlm: (request, options) => assembleLlmStream(ctx, request, options),
  }
  const restart = () => skills.install(rt, { holdPreexistingTyped })
  restart()
  const save = (input = form, caller = actor) => rt.skillLibrary.endpoint('skill-library-save', input, caller)
  return { rt, dir, path: join(dir, 'skill-library', 'library.json'), save, restart, calls: () => calls }
}

function putLegacy(dir, name = form.name) {
  const record = { ...form, name, source: { kind: 'text' }, check: { version: 2, fingerprint: SKILL_CHECK_HISTORY[2] } }
  record.hash = skillHash([{ path: 'SKILL.md', bytes: textSkillMd(record) }])
  fs.mkdirSync(join(dir, 'skill-library'), { mode: 0o700 })
  fs.writeFileSync(join(dir, 'skill-library', 'library.json'),
    JSON.stringify({ version: 1, skills: { [name]: record }, active: { b: [name] } }), { mode: 0o600 })
  return record
}

test('1 observes the normal terminal event on the real assembler', async t => {
  const f = fixture(t, { async *stream(_request, call) {
    yield delta(clean)
    if (call === 1) yield stop
  } })
  assert.deepEqual(await f.save(), { saved: true })
  const missing = await f.save({ ...form, name: 'missing-finish' })
  assert.equal(missing.review?.why, 'incomplete')
  assert.equal(missing.refused, true)
  assert.equal(read(f.path).skills['missing-finish'], undefined)
  assert.equal(Object.keys(read(f.path).reviews).length, 1)
})

test('2 commits an observed injection before a same-route retry and blocks it after reload', async t => {
  for (const thrown of [false, true]) {
    let presentBeforeRetry
    const f = fixture(t, { async *stream(_request, call) {
      if (call === 1) {
        yield delta(reply('SKILL.md', 5, 'prompt-injection'))
        const failure = { code: 'TRANSPORT', message: 'Synthetic transient interruption.' }
        if (thrown) throw Object.assign(new Error(failure.message), { failure })
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }
      const hash = skillHash([{ path: 'SKILL.md', bytes: textSkillMd(form) }])
      presentBeforeRetry = fs.existsSync(f.path) && read(f.path).reviewBlocks?.[hash]?.findings[0].area === 'prompt-injection'
      yield* [delta(clean), stop]
    } })
    const result = await f.save()
    assert.equal(presentBeforeRetry, true)
    assert.equal(result.findings[0]?.injection, true)
    assert.equal(result.refused, true)
    assert.equal(f.calls(), 2)
    f.restart()
    assert.match((await f.save()).message, /prompt injection/)
    assert.equal(f.calls(), 2)
    assert.equal(read(f.path).skills[form.name], undefined)
  }
})

test('3 the Save report and receipt retain two distinct frontmatter fields', async t => {
  const f = fixture(t)
  const input = { ...form, source: 'file', fileName: 'notes.md',
    fileBytes: Buffer.from('---\nname: sample-notes\ndescription: A sample note.\nallowed-tools: []\ncontext: sample\n---\nA note.').toString('base64') }
  const before = await f.save(input)
  assert.deepEqual(before.findings.filter(row => row.rule === 'run-or-grant').map(row => row.detail),
    ['allowed-tools', 'context'])
  const source = fileURLToPath(new URL('../src/client/skills-screen.js', import.meta.url))
  const { outputFiles } = await build({
    stdin: { contents: fs.readFileSync(source, 'utf8') + '\nexport { SkillReport }', resolveDir: dirname(source) },
    platform: 'browser', format: 'cjs', bundle: true, write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  const createElement = (type, props, ...children) => ({ type, props, children })
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, require: () => ({ createElement }),
  })
  const report = module.exports.SkillReport({ report: before })
  const rows = report.children.find(row => row?.type === 'ul').children[0]
  assert.equal(rows.length, 2)
  assert.match(rows[0].children[0], /allowed-tools/)
  assert.match(rows[1].children[0], /context/)
  assert.match(before.needsConfirm, /^[0-9a-f]{64}$/)
  assert.deepEqual(await f.save({ ...input, confirm: before.needsConfirm }), { saved: true })
  const reopened = await f.rt.skillLibrary.endpoint('skill-library-get', { name: form.name }, actor)
  assert.deepEqual(reopened.check.findings, before.findings)
})

test('4 an import from the legacy no-key copy path has no local provenance', async t => {
  const source = home(t)
  const dest = home(t)
  fs.writeFileSync(join(source, 'state.json'), '{"version":1}', { mode: 0o600 })
  const record = putLegacy(source)
  // The pre-review importer at 589f62d6f used this copy for a team with no key or transient files.
  const previousMask = process.umask(0o077)
  try { fs.cpSync(source, dest, { recursive: true, force: false }) }
  finally { process.umask(previousMask) }
  assert.equal(fs.existsSync(join(dest, skills.SKILL_IMPORT_MARK)), false)
  const f = fixture(t, { dir: dest, holdPreexistingTyped: false })
  assert.deepEqual(f.rt.skillLibrary.active('b'), [])
  const held = await f.rt.skillLibrary.endpoint('skill-library-get', { name: record.name }, actor)
  assert.equal(held.reviewHash, record.hash)
  assert.deepEqual(await f.save({ name: record.name, edit: true, reviewHash: record.hash }), { saved: true })
  assert.equal(f.rt.skillLibrary.active('b').length, 1)
})

test('5 a fresh Save client and an interrupted response body recover the same write for the actor', async t => {
  const dir = home(t)
  const stored = putLegacy(dir, 'legacy-notes')
  const f = fixture(t, { dir })
  await f.save()
  const requests = []
  let loseBody = false
  let loseFetch = false
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { payload } = JSON.parse(options.body)
    requests.push(payload)
    const value = await f.save(payload)
    if (loseFetch) { loseFetch = false; throw new Error('Synthetic disconnect after dispatch') }
    if (loseBody && value.saved) {
      loseBody = false
      return { ok: true, json: async () => { throw new TypeError('Synthetic interrupted response body') } }
    }
    return Response.json({ ok: true, value })
  })
  const makeActions = () => teamActions({ call: clientCall, after: promise => promise })
  const savedStorage = globalThis.sessionStorage
  const storage = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  } })
  t.after(() => Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: savedStorage }))

  for (const input of [{ ...form, edit: true, content: 'Use the other sample.' },
    { name: stored.name, edit: true, reviewHash: stored.hash }]) {
    const priorCalls = f.calls()
    const begin = requests.length
    loseFetch = true
    await assert.rejects(makeActions().saveSkill(input))
    const operation = requests[begin].operation
    const fresh = makeActions()
    loseBody = true
    await assert.rejects(fresh.saveSkill(input))
    assert.deepEqual(await makeActions().resumeSkillSaves(), [{ status: 'fulfilled', value: { saved: true } }])
    assert.equal(storage.size, 0)
    assert.ok(requests.slice(begin).every(request => request.operation === operation))
    assert.equal(f.calls(), priorCalls + 1)
    const audit = fs.readFileSync(join(f.dir, 'skill-library', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(audit.filter(row => row.target === input.name && row.outcome === 'allowed').length,
      input.name === form.name ? 2 : 1)
    await assert.rejects(f.save({ operation, poll: true }, { id: 'other-actor', role: 'owner' }), { code: 'bot/not-found' })
  }
})

test('6 an interrupted import resumes, refuses foreign destinations and publishes portably', async t => {
  const source = home(t)
  const dest = home(t)
  const foreign = home(t)
  fs.writeFileSync(join(source, 'state.json'), '{"version":1}', { mode: 0o600 })
  putLegacy(source)
  fs.mkdirSync(join(foreign, 'skill-library'), { mode: 0o700 })
  assert.throws(() => createRuntime(fakeContext(), { home: foreign, importHome: source }), /ambiguous Skills/)
  const first = fixture(t)
  assert.deepEqual(await first.save(), { saved: true })

  const realCopy = fs.cpSync
  const copy = t.mock.method(fs, 'cpSync', (from, to, options) => {
    if (to === dest || to.startsWith(dest + '/')) throw new Error('Synthetic interrupted copy')
    return realCopy(from, to, options)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => createRuntime(fakeContext(), { home: dest, importHome: source }), /interrupted copy/)
  } finally { copy.mock.restore(); syncBuiltinESMExports() }
  assert.equal(fs.existsSync(join(dest, skills.SKILL_IMPORT_MARK)), true)
  assert.equal(fs.existsSync(join(dest, 'state.json')), false)
  const otherSource = home(t)
  fs.cpSync(source, otherSource, { recursive: true })
  assert.throws(() => createRuntime(fakeContext(), { home: dest, importHome: otherSource }), /ambiguous Skills/)
  const publish = fs.linkSync
  const link = t.mock.method(fs, 'linkSync', (from, to) => {
    if (to === join(dest, 'state.json')) throw new Error('Synthetic interruption before state publication')
    return publish(from, to)
  })
  try {
    assert.throws(() => createRuntime(fakeContext(), { home: dest, importHome: source }), /before state publication/)
  } finally { link.mock.restore() }
  assert.equal(read(join(dest, 'skill-library', 'library.json')).skills[form.name].name, form.name)
  const resumed = createRuntime(fakeContext(), { home: dest, importHome: source })
  await resumed.load()
  resumed.dispose()
  assert.equal(read(join(dest, 'skill-library', 'library.json')).skills[form.name].name, form.name)

  const winSource = home(t)
  const winDest = home(t)
  const winSave = fixture(t)
  fs.cpSync(source, winSource, { recursive: true })
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const realOpen = fs.openSync
  const open = t.mock.method(fs, 'openSync', (path, flags, mode) => {
    if (typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY)) {
      throw Object.assign(new Error('Synthetic Windows rejects directory handles'), { code: 'EINVAL' })
    }
    return realOpen(path, flags, mode)
  })
  try {
    assert.deepEqual(await winSave.save(), { saved: true })
    const imported = createRuntime(fakeContext(), { home: winDest, importHome: winSource })
    await imported.load()
    imported.dispose()
    assert.equal(fs.existsSync(join(winDest, skills.SKILL_IMPORT_MARK)), true)
  } finally { open.mock.restore(); Object.defineProperty(process, 'platform', platform) }
})

test('7 a finding on the actual redacted frame maps to the original source line', async t => {
  const file = 'references/example.txt'
  const entries = [{ path: 'SKILL.md', bytes: textSkillMd(form) },
    { path: file, bytes: Buffer.from('Bearer\nFIXTURE_SAMPLE\nA note on the original third line.\n') }]
  const f = fixture(t, { async *stream(request) {
    const message = request.messages[0].content[0].text
    const lines = message.split('\n')
    const chunk = lines.findIndex(line => line.includes(' chunk '))
    if (!lines[chunk].endsWith(' path=' + file)) { yield* [delta(clean), stop]; return }
    assert.match(lines[chunk + 1], /^Bearer \[hidden\]$/)
    assert.equal(lines[chunk + 2], 'A note on the original third line.')
    yield* [delta(reply(file, 2)), stop]
  } })
  const check = { ...checkSkill(entries.slice(0, 1)), hash: skillHash(entries) }
  const result = await f.rt.skillLibrary.reviewSkill({ name: form.name, entries, check,
    caller: { identity: actor.id, generation: 1 } })
  assert.equal(result.decision, 'confirm')
  assert.equal(result.findings[0].line, 3)
})
