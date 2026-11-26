import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { build } from 'esbuild'
import { apply } from '../index.js'
import { SKILL_CHECK_FINGERPRINT, SKILL_CHECK_HISTORY, SKILL_CHECK_VERSION } from '../src/host/skill-check-version.js'
import { install as installLibrary } from '../src/host/skill-library.js'
import { skillHash } from '../src/host/skill-library-rules.js'
import { fakeLocale } from '../../locale-pt-br-dsh/test/fake-locale.js'
import { member, serviceStub } from './caller-fixture.js'
import { stubSkillReviewer } from './fixtures/skill-review-model.js'
import { browser } from './viewer-fixture.js'

const { outputFiles } = await build({
  stdin: { contents: `
    export { AccountLauncher } from './src/client/sidebar.js'
    export { SkillsScreen, skillFileBytes } from './src/client/skills-screen.js'
    export { BotSkills } from './src/client/bot-skills.js'
    export { hostText, installLocale } from './src/client/i18n.js'
    export { teamActions } from './src/client/team-actions.js'
    export { startViewer } from './src/client/viewer.js'
  `, resolveDir: new URL('..', import.meta.url).pathname },
  format: 'cjs', platform: 'browser', bundle: true, write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const walk = (node, pred) => {
  if (Array.isArray(node)) return node.flatMap(child => walk(child, pred))
  if (!node || typeof node !== 'object') return []
  return [...(pred(node) ? [node] : []), ...walk(node.props?.children, pred)]
}
const text = node => Array.isArray(node) ? node.map(text).join('')
  : typeof node === 'string' ? node : node?.props ? text(node.props.children) : ''
const match = (node, label) => walk(node, entry => entry.props?.['aria-label'] === label ||
  (entry.type === 'button' && text(entry) === label))[0]
const group = () => ({ skills: [], active: {} })
const flush = () => new Promise(resolve => setImmediate(resolve))
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

function fixture(t, role, fetch) {
  let slots, position
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    createContext: value => ({ value }), useContext: ctx => ctx.value, Component: class {},
    Fragment: Symbol('fragment'),
    useState(initial) {
      const i = position++
      const state = slots
      if (!Object.hasOwn(state, i)) state[i] = typeof initial === 'function' ? initial() : initial
      return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useRef(initial) {
      const i = position++
      return slots[i] ??= { current: initial }
    },
    useEffect(effect) {
      const i = position++
      if (slots[i]) return
      slots[i] = true
      if (effect) queueMicrotask(() => { const close = effect(); if (close) t.after(close) })
    },
    useLayoutEffect() {},
    useMemo: fn => fn(), useCallback: fn => fn, useSyncExternalStore: (_, read) => read(),
  }
  const module = { exports: {} }
  const boot = role === undefined ? undefined : { version: 1, role }
  const { globals } = browser({ boot, fetch, hooks: react })
  Object.assign(globals.window, { AbortController, innerHeight: 800 })
  runInNewContext(outputFiles[0].text, {
    ...globals, module, exports: module.exports, Uint8Array, btoa, crypto: globalThis.crypto, TextEncoder,
  })
  const mount = (component, props) => {
    const current = []
    return () => {
      position = 0
      slots = current
      return component(props)
    }
  }
  return { ...module.exports, mount }
}

test('the Account menu opens the keyed Skills screen for the owner', t => {
  for (const role of ['owner', 'member']) {
    const { AccountLauncher, mount } = fixture(t, role)
    const selected = []
    const render = mount(AccountLauncher, { seat: false, actions: {
      selectPanel: id => selected.push(id), signInEntry: () => null,
    } })
    const button = match(render(), 'Account')
    button.props.ref.current = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) }
    button.props.onClick()
    const item = match(render(), 'Skills')
    if (role === 'owner') item.props.onClick()
    else assert.equal(item, undefined)
    assert.deepEqual(selected, role === 'owner' ? ['automagik-skills'] : [])
  }
})

test('the Skills screen submits text and the original file bytes', async t => {
  const f = fixture(t)
  const inputs = []
  const list = group()
  const props = {
    actions: { skillLibrary: async () => list, saveSkill: async body => { inputs.push(body); return { saved: true } } },
    rosterSource: { subscribe() {}, getSnapshot: () => ({}) },
  }
  const owner = f.mount(f.SkillsScreen, props)()
  const render = f.mount(owner.type, owner.props)
  render()
  await flush()
  match(render(), 'New skill').props.onClick()
  const form = walk(render(), entry => typeof entry.type === 'function' && entry.type.name === 'SkillForm')[0]
  const renderForm = f.mount(form.type, form.props)
  const fields = () => walk(renderForm(), entry => typeof entry.type === 'function' && entry.type.name === 'Field')
  for (const [label, value] of [['Name', 'fixture'], ['One-line description', 'Fixture description'], ['Skill instructions', 'Fixture body']]) {
    fields().find(field => field.props.label === label).props.onChange(value)
  }
  const submit = () => renderForm().props.onSubmit({ preventDefault() {} })
  await submit()
  assert.equal(inputs[0].content, 'Fixture body')
  const file = new Uint8Array([0x80, 0x0a])
  await walk(renderForm(), entry => entry.props?.type === 'file')[0].props.onChange({
    target: { files: [{ name: 'fixture.md', size: file.length, arrayBuffer: async () => file.buffer }] },
  })
  await submit()
  assert.equal(inputs[1].source, 'file')
  assert.equal(inputs[1].fileName, 'fixture.md')
  assert.deepEqual(Buffer.from(inputs[1].fileBytes, 'base64'), Buffer.from(file))
})

test('Bot and Solver Details both add and remove and show a nonblocking warning', async t => {
  for (const role of ['Helper', 'Solver']) {
    const f = fixture(t)
    const active = []
    const warning = 'Many active skills use more of the model’s context.'
    const changes = []
    const props = { bot: { id: 'a', role }, roster: {}, actions: {
      skillLibrary: async () => ({ skills: [{ name: 'fixture' }], active: { a: [...active] } }),
      setBotSkill: async (id, name, attached, mode) => {
        changes.push([id, name, attached, mode])
        if (attached) active.push({ name, mode })
        else active.splice(active.findIndex(item => item.name === name), 1)
        return {}
      },
      setBotSkillMode: async (id, name, mode) => {
        changes.push([id, name, mode])
        active.find(item => item.name === name).mode = mode
        return { warning }
      },
    } }
    const card = f.mount(f.BotSkills, props)()
    const render = f.mount(card.type, card.props)
    render()
    await flush()
    const modeInput = (tree, label) => walk(tree, node => typeof node.type === 'function' && node.props.label === label)[0]
    assert.equal(modeInput(render(), 'New skill mode').props.mode, 'manual')
    match(render(), 'Add skill').props.onChange({ target: { value: 'fixture' } })
    await flush()
    assert.doesNotMatch(text(render()), /Many active skills/)
    modeInput(render(), 'Mode for fixture').props.onChange('automatic')
    await flush()
    assert.match(text(render()), /Many active skills/)
    match(render(), 'Remove').props.onClick()
    await flush()
    assert.deepEqual(changes, [['a', 'fixture', true, 'manual'], ['a', 'fixture', 'automatic'], ['a', 'fixture', false, undefined]])
  }
})

test('Antigravity OFF localizes the nonblocking warning beside Add skill and active skills', async t => {
  const f = fixture(t)
  const locale = fakeLocale()
  locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
  locale.register('omni-ui', 'pt-BR', JSON.parse(readFileSync(
    new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8')))
  locale.setLocale('pt-BR')
  t.after(f.installLocale(locale))
  const guidance = 'Ative as ferramentas nativas para usar skills automáticas no Antigravity.'
  assert.equal(f.hostText('Skills cannot be loaded in Antigravity with native tools off on this version'),
    'Nesta versão do Antigravity, não é possível carregar skills com as ferramentas nativas desligadas')
  const active = [{ name: 'first', mode: 'manual' }]
  const changed = []
  const props = {
    bot: { id: 'a', model: 'acp-antigravity/default', nativeToolsSkillsUnavailable: true },
    roster: {},
    actions: {
      skillLibrary: async () => ({ skills: [{ name: 'first' }, { name: 'second' }], active: { a: [...active] } }),
      setBotSkill: async (id, name, attached, mode) => {
        changed.push([id, name, attached, mode])
        active.push({ name, mode })
        return {}
      },
    },
  }
  const card = f.mount(f.BotSkills, props)()
  const render = f.mount(card.type, card.props)
  render()
  await flush()
  const warnings = tree => walk(tree, node => node.props?.role === 'status' && text(node) === guidance)
  const tree = render()
  const [before, after] = warnings(tree)
  assert.equal(warnings(tree).length, 2)
  const add = match(tree, locale.bind('omni-ui')('Add skill'))
  const children = tree.props.children
  assert.equal(children.indexOf(before), children.findIndex(node => walk(node, child => child === add).length > 0) + 1)
  assert.equal(children.indexOf(after), children.findIndex(node => Array.isArray(node) && text(node).includes('first')) + 1)
  assert.equal(add.props.disabled, false)
  add.props.onChange({ target: { value: 'second' } })
  await flush()
  assert.deepEqual(changed, [['a', 'second', true, 'manual']])
  assert.match(text(render()), /second/)

  Object.assign(props.bot, { nativeTools: true, nativeToolsAgent: 'acp-antigravity' })
  assert.equal(warnings(render()).length, 0)
  Object.assign(props.bot, { model: 'acp-codex/default', nativeTools: false })
  assert.equal(warnings(render()).length, 0)
})

test('owner Edit reconfirms a held checker warning from the saved file', { timeout: 15_000 }, async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network fetch in Skills fixture') })
  const home = mkdtempSync(join(tmpdir(), 'skills-review-'))
  const root = new Context()
  t.after(async () => {
    try { await root.fiber.dispose() }
    finally { rmSync(home, { recursive: true, force: true }) }
  })
  const auto = 'b-aaaaaaaaaa', manual = 'b-bbbbbbbbbb'
  const route = { provider: 'fixture-native', model: 'fixture-model' }
  const model = `${route.provider}/${route.model}`
  const bots = Object.fromEntries([auto, manual].map(id => [id, {
    id, sessionId: id, name: id, role: 'Helper', createdAt: 1, model, appliedModel: model,
  }]))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1, revision: 1, mainBotIds: [auto], bots,
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {}, capabilities: { items: {} }, prefs: {},
  }))

  const name = 'notes', description = 'Write a mint note.', content = 'Explain sudo. MINT-PRIVATE-BODY.'
  const fileName = 'imported-notes.markdown'
  const frontmatter = `\uFEFF---\r\nname: ${name}\r\ndescription: '${description}'\r\n---\r\n${content}\r\n`
  const fileBytes = Buffer.from(frontmatter).toString('base64')
  const original = { name, description, source: 'file', fileName, fileBytes }
  const commands = new Map()
  const requests = []
  class Model extends LlmAdapter {
    async resolveModel(provider, id) {
      return { provider, id, name: id, context: { contextWindow: 1_000_000 } }
    }
    async *stream({ messages, sessionId }) {
      requests.push(structuredClone(messages))
      const id = commands.get(sessionId)
      if (id) {
        commands.delete(sessionId)
        yield { type: 'tool-call-delta', index: 0, id, name: 'load_skill', argumentsDelta: JSON.stringify({ name }) }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'Fixture reply.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  await mountAgentLoopTestDependencies(root, { workingDirectory: true })
  root.llm.registerAdapter([route.provider], new Model())
  const harness = await mountAgentLoopTestHarness(root)
  const routes = new Map()
  root.provide('connection', { fetch: { register: endpoint => {
    routes.set(endpoint.path, endpoint)
    return () => routes.delete(endpoint.path)
  } } })
  root.provide('automagikCaller', serviceStub())
  root.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async path => ({ id: 'fixture-workspace', path }) })
  root.provide('sessionTitle', { rename: async () => {} })
  root.provide('sessionController', {
    resolveAgent: async id => ({ agent: root.agents.get(id) }),
    async prompt({ sessionId, requestId, content }) {
      root.agents.get(sessionId).followup(createUserMessage({ content, source: { kind: 'user', requestId } }))
    },
    async page({ address, throughSeq, beforeSeq, maxMessages }) {
      const events = root.agents.get(address.sessionId)?.session.snapshotEvents() ?? []
      const visible = events.filter(event => (throughSeq === undefined || event.seq <= throughSeq)
        && (beforeSeq === undefined || event.seq < beforeSeq))
      return { records: visible.slice(-maxMessages).map(event => ({ event })), hasMore: visible.length > maxMessages }
    },
  })
  apply(root, { home, github: false, memory: false, browser: false, diagnosticsFile: false, updateCheck: false })
  const rt = root.get('omniTeam')
  stubSkillReviewer(rt)
  const post = async (endpoint, payload, viewer, role = 'owner') => {
    const principal = Buffer.from(JSON.stringify({ ...member.person, roles: [role] })).toString('base64url')
    const response = await routes.get('/api/omni-ui').fetch(new Request('http://fixture.invalid/api/omni-ui', {
      method: 'POST', headers: { 'x-automagik-principal': principal },
      body: JSON.stringify({ endpoint, payload, viewer }),
    }))
    if (endpoint.startsWith('skill-library')) assert.equal(response.headers.get('cache-control'), 'no-store')
    return await response.json()
  }
  const { value: { viewer: { id: owner } } } = await post('whoami')
  const submissions = []
  let lastPayload
  const call = async (endpoint, payload) => {
    const result = await post(endpoint, payload, owner)
    assert.equal(result.ok, true, `${endpoint}: ${JSON.stringify(result)}`)
    if (endpoint === 'skill-library-save' && payload.poll !== true) lastPayload = payload
    if (endpoint === 'skill-library-save' && !result.value.pending) submissions.push({ payload: lastPayload, value: result.value })
    return result.value
  }
  const first = await call('skill-library-save', original)
  assert.ok(first.findings.some(finding => finding.rule === 'sudo' && finding.level === 'warn'))
  assert.deepEqual(await call('skill-library-save', { ...original, confirm: first.needsConfirm }), { saved: true })
  for (const [id, mode] of [[auto, 'automatic'], [manual, 'manual']]) {
    await call('bot-skill-add', { id, name, mode })
  }

  const path = join(home, 'skill-library', 'library.json')
  const read = () => JSON.parse(readFileSync(path, 'utf8'))
  const legacy = read()
  const stored = legacy.skills[name]
  assert.equal(stored.frontmatter, frontmatter)
  assert.equal(stored.accepted, stored.hash)
  assert.match(stored.workerRevision, UUID)
  Object.assign(stored.check, { version: 1, fingerprint: SKILL_CHECK_HISTORY[1], findings: [] })
  delete legacy.reviews
  for (const key of ['review', 'reviewSeal', 'acceptedReview', 'acceptanceSeal']) delete stored[key]
  const write = data => writeFileSync(path, JSON.stringify(data))
  write(legacy)
  installLibrary(rt) // A new service has its own confirmation key.
  const agents = new Map(await Promise.all([auto, manual].map(async id => [id, await harness.create(id, route, { cwd: home })])))
  const turn = async (id, prompt, load) => {
    if (load) commands.set(id, load)
    const from = requests.length
    assert.equal(await call('send', { sessionId: id, text: prompt }), true)
    await agents.get(id).whenIdle()
    await flush()
    const sent = requests.slice(from)
    assert.equal(sent.length, load ? 2 : 1, JSON.stringify(agents.get(id).session.snapshotEvents()))
    return sent
  }
  const toolResult = (sent, id) => sent.at(-1).find(row => row.role === 'tool' && row.toolCallId === id)
  const modelText = rows => JSON.stringify(rows)
  const catalog = rows => modelText(rows.filter(row => row.role === 'system'))
  const heldList = await call('skill-library', {})
  const heldView = heldList.skills.find(skill => skill.name === name)
  assert.equal(heldView.reviewHash, stored.hash)
  assert.equal(heldView.content, undefined)
  assert.match(heldView.held, /has not reviewed/)
  assert.equal((await post('skill-library-get', { name }, owner, 'member')).error.code, 'bot/viewer-changed')
  const blockedTurn = await turn(auto, 'Try /notes again.', 'held-load')
  for (const rows of blockedTurn) {
    assert.ok(!modelText(rows).includes(content))
    assert.ok(!catalog(rows).includes(description))
  }
  assert.deepEqual(toolResult(blockedTurn, 'held-load').content, [])
  assert.equal(toolResult(blockedTurn, 'held-load').isError, true)

  const ui = fixture(t, 'owner', ({ body }) => {
    assert.equal(body.endpoint, 'whoami')
    return { ok: true, json: () => post('whoami') }
  })
  const viewer = new AbortController()
  t.after(() => viewer.abort())
  assert.equal((await ui.startViewer({ version: 1, role: 'owner' }, viewer.signal)).id, owner)
  const team = ui.teamActions({ call, after: pending => pending })
  // A caller can still have a copy of the file in its draft. The Save request must omit it.
  const actions = { ...team, saveSkill: input => team.saveSkill({ ...input, fileBytes }) }
  const props = { actions, rosterSource: { subscribe() {}, getSnapshot: () => ({}) } }
  const screen = ui.mount(ui.SkillsScreen, props)()
  const render = ui.mount(screen.type, screen.props)
  render()
  await flush()
  match(render(), 'Edit').props.onClick()
  await flush()
  const editor = walk(render(), entry => entry.type?.name === 'SkillForm')[0]
  assert.equal(editor.props.item.content, content, 'the authenticated Edit GET includes the saved instructions')
  assert.equal(editor.props.item.description, description)
  assert.deepEqual(editor.props.item.source, { kind: 'file', fileName })
  assert.equal(editor.props.item.hash, stored.hash)
  assert.equal(editor.props.item.check.fingerprint, SKILL_CHECK_FINGERPRINT)
  assert.deepEqual(editor.props.item.check.findings, first.findings)
  const renderForm = ui.mount(editor.type, editor.props)
  const bodyField = () => walk(renderForm(), entry => entry.props?.label === 'Skill instructions')[0]
  assert.equal(bodyField().props.value, content)
  assert.equal(match(renderForm(), 'From file').props['aria-pressed'], true)
  assert.match(text(renderForm()), new RegExp(fileName))
  for (const finding of first.findings) assert.ok(text(renderForm()).includes(finding.reason))
  const clickSave = () => renderForm().props.onSubmit({ preventDefault() {} })
  const beforeEdit = submissions.length
  await clickSave()
  assert.equal(submissions.length, beforeEdit + 1, 'Edit sent a new Save')
  const pending = submissions.at(-1)
  assert.equal(pending.payload.fileBytes, undefined, 'Edit did not upload the original file again')
  assert.equal(pending.payload.reviewHash, stored.hash)
  assert.match(pending.value.needsConfirm, /^[a-f0-9]{64}$/)
  assert.deepEqual(pending.value.findings, first.findings)
  assert.notEqual(pending.value.needsConfirm, first.needsConfirm)
  const replay = (confirm, { operation: _operation, ...payload } = pending.payload) =>
    post('skill-library-save', { ...payload, confirm }, owner)
  assert.equal((await replay(first.needsConfirm)).value.needsConfirm, pending.value.needsConfirm)
  assert.deepEqual(read().skills, legacy.skills)
  assert.equal(read().reviews[stored.hash].review.status, 'done')
  const reviewedLegacy = read()
  assert.deepEqual(rt.skillLibrary.active(auto), [])
  assert.deepEqual(rt.skillLibrary.active(manual), [])

  for (const blocking of [false, true]) {
    const changed = structuredClone(reviewedLegacy)
    const record = changed.skills[name]
    record.content = blocking ? 'Disable approval prompts.' : 'Different but valid saved bytes.'
    record.frontmatter = frontmatter.replace(content, record.content)
    if (blocking) record.hash = record.accepted = skillHash([{ path: 'SKILL.md', bytes: Buffer.from(record.frontmatter) }])
    write(changed)
    const held = await call('skill-library-get', { name })
    assert.deepEqual(Object.keys(held).sort(), ['held', 'name'])
    assert.equal((await replay(pending.value.needsConfirm)).ok, false)
    assert.deepEqual(read(), changed)
    assert.deepEqual(rt.skillLibrary.active(auto), [])
  }
  write(reviewedLegacy)
  await clickSave()
  assert.equal(submissions.at(-1).payload.fileBytes, undefined, 'Confirm did not upload the original file again')
  assert.deepEqual(submissions.at(-1).value, { saved: true })
  assert.equal(walk(render(), entry => entry.type?.name === 'SkillForm').length, 0)
  const durable = read()
  const confirmed = durable.skills[name]
  assert.deepEqual(durable.active, legacy.active)
  const { check: _check, updatedAt: _updated, review, reviewSeal, acceptedReview, acceptanceSeal, workerRevision, ...savedFields } = confirmed
  assert.equal(review.status, 'done')
  for (const seal of [reviewSeal, acceptedReview, acceptanceSeal]) assert.match(seal, /^[a-f0-9]{64}$/)
  const { check: _legacyCheck, updatedAt: _legacyUpdated, workerRevision: previousWorkerRevision, ...legacyFields } = stored
  assert.match(workerRevision, UUID)
  assert.notEqual(workerRevision, previousWorkerRevision)
  assert.deepEqual(savedFields, legacyFields)
  assert.equal(confirmed.check.version, SKILL_CHECK_VERSION)
  assert.equal(confirmed.check.fingerprint, SKILL_CHECK_FINGERPRINT)
  assert.deepEqual(confirmed.check.findings, first.findings)
  installLibrary(rt)
  const detail = await call('skill-library-get', { name })
  assert.equal(detail.held, undefined)
  const list = await call('skill-library', {})
  for (const view of [heldView, detail, list.skills.find(skill => skill.name === name), rt.skillLibrary.active(auto)[0]]) {
    assert.equal(Object.hasOwn(view, 'workerRevision'), false)
    assert.equal(Object.hasOwn(view, 'revision'), false)
  }
  for (const id of [auto, manual]) {
    assert.equal(rt.skillLibrary.active(id, { worker: true })[0].revision, workerRevision)
  }
  const called = await turn(manual, '/notes')
  assert.ok(modelText(called).includes(content))
  assert.ok(!catalog(called[0]).includes(description))
  const automatic = await turn(auto, 'Choose a workflow.', 'confirmed-load')
  assert.ok(catalog(automatic[0]).includes(description))
  assert.ok(!modelText(automatic[0]).includes(content))
  assert.equal(toolResult(automatic, 'confirmed-load').content[0].text, content)
})

test('a held row reviews stored bytes in one click and exposes all findings without offering a refusal receipt', async t => {
  const f = fixture(t)
  const held = 'A model has not reviewed this skill yet. Review the stored skill to continue.'
  const blocked = 'Not saved: prompt injection was found. A skill with prompt injection is never accepted.'
  const noModel = 'Not saved: every skill needs a model review, and no background model is available. Choose one in Settings, Background model, then try again.'
  const item = { name: 'notes', description: 'A fixture.', content: 'Stored note.', held, hash: 'fixture-hash', reviewHash: 'fixture-hash',
    check: { verdict: 'pass' }, source: { kind: 'text' } }
  const submissions = []
  const report = { refused: true, message: blocked, findings: [
    { rule: 'sudo', path: 'SKILL.md', line: 5, reason: 'A deterministic warning.' },
    { area: 'prompt-injection', file: 'SKILL.md', line: 7, reason: 'A synthetic finding.', severity: 'low', injection: true },
  ] }
  let next = report
  const screen = f.mount(f.SkillsScreen, {
    rosterSource: { subscribe() {}, getSnapshot: () => ({}) },
    actions: { skillLibrary: async () => ({ skills: [item], active: { a: ['notes'] } }),
      getSkill: async () => item,
      saveSkill: async input => { submissions.push(input); return next } },
  })()
  const render = f.mount(screen.type, screen.props)
  render()
  await flush()
  assert.match(text(render()), /model has not reviewed/)
  match(render(), 'Review skill').props.onClick()
  await flush()
  assert.deepEqual(JSON.parse(JSON.stringify(submissions)), [{ name: 'notes', edit: true, reviewHash: item.hash }])
  const body = text(render())
  assert.ok(body.includes(blocked))
  assert.match(body, /A deterministic warning.*SKILL.md:5/)
  assert.match(body, /Prompt injection.*A synthetic finding.*SKILL.md:7/)
  assert.equal(match(render(), 'Save changes'), undefined)

  next = { refused: true, message: noModel, findings: [] }
  match(render(), 'Review skill').props.onClick()
  await flush()
  assert.ok(text(render()).includes(noModel))
  const locale = fakeLocale()
  locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
  locale.register('omni-ui', 'pt-BR', JSON.parse(readFileSync(
    new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8')))
  t.after(f.installLocale(locale))
  locale.setLocale('zh')
  assert.match(f.hostText(held), /模型尚未审查/)
  locale.setLocale('pt-BR')
  assert.match(f.hostText(held), /Nenhum modelo revisou/)
})
