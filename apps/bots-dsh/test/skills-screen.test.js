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
import { assembledReview, stubSkillReviewer } from './fixtures/skill-review-model.js'
import { directLink, publicResolver, response, skillMd } from './fixtures/skill-link-fixtures.js'
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
  let slots, position, cleanups
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
      const mounted = cleanups
      if (effect) queueMicrotask(() => { const close = effect(); if (close) mounted.add(close) })
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
    const effects = new Set()
    const unmount = () => {
      for (const close of effects) close()
      effects.clear()
    }
    t.after(unmount)
    const render = () => {
      position = 0
      slots = current
      cleanups = effects
      return component(props)
    }
    return Object.assign(render, { unmount })
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

test('#2078 Skills shows owner folders, both tree reports, and submits only a token on Save', async t => {
  const f = fixture(t, 'owner')
  const calls = []
  const scripts = [{ path: 'scripts/run.sh', interpreter: 'bash' }]
  const references = ['references/guide.md']
  const tree = [
    { path: 'SKILL.md', size: 64 },
    { path: references[0], size: 16 },
    { path: scripts[0].path, size: 20 },
  ]
  const gate = { rule: 'script', line: 1, reason: 'A deterministic warning.', path: scripts[0].path }
  const model = { area: 'other', line: 1, reason: 'A synthetic finding.', file: references[0], severity: 'low' }
  let next = { preview: true, name: 'notes', description: 'Fixture notes.', tree, scripts, references, skipped: 1,
    findings: [gate, model], token: 'fixture-preview-token', needsConfirm: 'fixture-receipt' }
  const actions = {
    skillLibrary: async () => group(),
    folders: async () => ({ picker: 'browse' }),
    saveSkill: async payload => { calls.push(JSON.parse(JSON.stringify(payload))); return payload.token ? { saved: true } : next },
  }
  const props = { actions, rosterSource: { subscribe() {}, getSnapshot: () => ({}) } }
  const owner = f.mount(f.SkillsScreen, props)()
  const screen = f.mount(owner.type, owner.props)
  screen()
  await flush()
  match(screen(), 'New skill').props.onClick()
  const form = walk(screen(), node => node.type?.name === 'SkillForm')[0]
  const render = f.mount(form.type, form.props)
  const file = walk(render(), node => node.props?.type === 'file')[0]
  assert.equal(file.props.accept, '.md,.markdown,.txt,.zip,.tar.gz,.tgz')
  await match(render(), 'From folder').props.onClick()
  const picker = walk(render(), node => node.type?.name === 'FolderPath')[0]
  const entry = picker.type(picker.props)
  walk(entry, node => node.type?.name === 'Field')[0].props.onChange('/fixture/notes')
  const path = walk(render(), node => node.type?.name === 'FolderPath')[0]
  await match(path.type(path.props), 'Use this folder').props.onClick()
  const expand = render => {
    const preview = render()
    assert.equal(preview.type?.name, 'TreePreview')
    return preview.type(preview.props)
  }
  const preview = expand(render)
  const detail = walk(preview, node => node.type?.name === 'TreeDetails')[0]
  const detailText = text(detail.type(detail.props))
  assert.match(detailText, /scripts\/run\.sh.*bash/)
  assert.match(detailText, /references\/guide\.md.*Reference file/)
  assert.match(detailText, /Skipped files: 1/)
  assert.match(detailText, /A Bot receives only the SKILL.md text/)
  const report = walk(preview, node => node.type?.name === 'SkillReport')[0]
  assert.match(text(report.type(report.props)), /A deterministic warning.*A synthetic finding/)
  await match(preview, 'Save').props.onClick()
  assert.deepEqual(calls, [
    { source: 'folder', path: '/fixture/notes', preview: true },
    { token: 'fixture-preview-token', name: 'notes', confirm: 'fixture-receipt' },
  ])

  next = { ...next, token: undefined, needsConfirm: undefined, refused: true,
    message: 'Not saved: prompt injection was found. A skill with prompt injection is never accepted.',
    findings: [{ ...model, injection: true }],
    diff: { findings: { new: [model], gone: [gate] }, files: { added: [], removed: [],
      changed: [{ path: references[0], beforeText: 'old guide', afterText: 'new guide' }] } },
  }
  const replace = { ...form.props, item: { name: 'notes', source: { kind: 'archive' }, tree, scripts, references } }
  const row = { ...replace.item, review: { status: 'done' } }
  actions.skillLibrary = async () => ({ skills: [row], active: {} })
  actions.getSkill = async () => row
  const second = f.mount(owner.type, owner.props)
  second()
  await flush()
  match(second(), 'Edit').props.onClick()
  await flush()
  const edit = walk(second(), node => node.type?.name === 'TreeForm')[0]
  const renderEdit = f.mount(edit.type, edit.props)
  const input = walk(renderEdit(), node => node.props?.type === 'file')[0]
  const bytes = Uint8Array.from([1, 2, 3, 4])
  await input.props.onChange({ target: { value: '', files: [{ name: 'fixture.zip', size: bytes.length, arrayBuffer: async () => bytes.buffer }] } })
  assert.deepEqual(calls.at(-1), { source: 'archive', fileName: 'fixture.zip', fileBytes: 'AQIDBA==', preview: true, edit: true, name: 'notes' })
  const refused = expand(renderEdit)
  assert.equal(match(refused, 'Save'), undefined)
  const refusal = walk(refused, node => node.type?.name === 'SkillReport')[0]
  assert.match(text(refusal.type(refusal.props)), /Not saved: prompt injection.*Prompt injection/)
  const diff = walk(refused, node => node.type?.name === 'TreeDiff')[0]
  const renderedDiff = diff.type(diff.props)
  assert.match(text(renderedDiff), /Changed files.*- old guide\n\+ new guide/)
  assert.deepEqual(walk(renderedDiff, node => node.type?.name === 'SkillReport').map(node => node.props.title), ['New findings', 'Gone findings'])

  const locale = fakeLocale()
  locale.addLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' })
  locale.register('omni-ui', 'pt-BR', JSON.parse(readFileSync(
    new URL('../../locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json', import.meta.url), 'utf8')))
  t.after(f.installLocale(locale))
  locale.setLocale('zh')
  assert.match(text(second()), /Bot 只会收到 SKILL.md 的正文/)
  locale.setLocale('pt-BR')
  assert.match(text(second()), /O Bot recebe só o texto do SKILL.md/)
})

test('#2078 Skills presents archive upload to admins and keeps the folder picker owner-only', async t => {
  const f = fixture(t, 'owner', ({ body }) => {
    assert.equal(body.endpoint, 'whoami')
    return { ok: true, json: async () => ({
      ok: true, value: { role: 'owner', multiuser: true, viewer: { id: 'fixture-admin', role: 'admin' } },
    }) }
  })
  const abort = new AbortController()
  t.after(() => abort.abort())
  assert.equal((await f.startViewer({ version: 1, role: 'owner' }, abort.signal)).role, 'admin')
  const owner = f.mount(f.SkillsScreen, { actions: { skillLibrary: async () => group() },
    rosterSource: { subscribe() {}, getSnapshot: () => ({}) } })()
  const screen = f.mount(owner.type, owner.props)
  screen()
  await flush()
  match(screen(), 'New skill').props.onClick()
  const form = walk(screen(), node => node.type?.name === 'SkillForm')[0]
  const tree = f.mount(form.type, form.props)()
  assert.equal(match(tree, 'From folder'), undefined)
  assert.match(walk(tree, node => node.props?.type === 'file')[0].props.accept, /\.zip/)
})

function linkScreen(t, { recovered, row, save } = {}) {
  const ui = fixture(t, 'owner')
  const requests = []
  let reads = 0
  const owner = ui.mount(ui.SkillsScreen, {
    rosterSource: { subscribe() {}, getSnapshot: () => ({}) },
    actions: {
      skillLibrary: async () => { reads++; return { skills: row ? [row] : [], active: {} } },
      getSkill: async () => row,
      saveSkill: async input => { requests.push(JSON.parse(JSON.stringify(input))); return save?.(input) },
      ...(recovered ? { resumeSkillSaves: async () => [{ status: 'fulfilled', value: recovered }] } : {}),
    },
  })()
  const render = ui.mount(owner.type, owner.props)
  const child = name => {
    const node = walk(render(), entry => entry.type?.name === name)[0]
    assert.ok(node, name)
    return ui.mount(node.type, node.props)
  }
  return { render, child, requests, reads: () => reads }
}

const linkSource = { kind: 'link', url: 'https://github.com/automagik-si/automagik/tree/main/skills/link-folder',
  ref: 'refs/heads/main', revision: 'a'.repeat(40), host: 'raw.githubusercontent.com', fetchedAt: 1_790_000_000_000 }
const linkRow = { name: 'link-notes', source: linkSource, checkable: true,
  held: 'Held: prompt injection was found. A skill with prompt injection is never accepted.' }
const linkReport = { name: linkRow.name, token: 'original-token', source: { ...linkSource, revision: 'b'.repeat(40) },
  previousSource: linkSource, usedBy: [{ id: 'a', name: 'Fixture Bot', mode: 'manual' }],
  endpoints: { new: [{ host: 'api.changed.example' }], gone: [] },
  scriptChanges: { new: [{ path: 'scripts/run.sh', interpreter: 'bash' }], gone: [] },
  diff: { files: { added: [{ path: 'scripts/run.sh', text: 'fixture' }], removed: [], changed: [], omitted: { count: 0 } },
    findings: { new: [], gone: [] } }, findings: [] }
const recoverLink = (data, stale = false) => ({ ...data, form: { kind: 'check', target: linkRow.name }, stale })

test('#2079 Skills previews a link and keeps URL and provenance out of its Save claim', async t => {
  const ui = linkScreen(t, { save: input => input.token ? { saved: true }
    : { preview: true, name: linkRow.name, source: linkSource, token: 'preview-token' } })
  ui.render()
  await flush()
  match(ui.render(), 'New skill').props.onClick()
  const form = ui.child('SkillForm')
  match(form(), 'From link').props.onClick()
  const field = walk(form(), node => node.props?.label === 'Link')[0]
  assert.ok(field)
  field.props.onChange(linkSource.url)
  await match(form(), 'Preview').props.onClick()
  const preview = walk(form(), node => node.type?.name === 'TreePreview')[0]
  assert.ok(preview)
  assert.deepEqual(ui.requests, [{ preview: true, source: 'link', url: linkSource.url }])
  assert.deepEqual(preview.props.tree.view.source, linkSource)
  await preview.props.tree.save()
  assert.deepEqual(ui.requests[1], { token: 'preview-token', name: linkRow.name })
})

test('#2079 F1a recovers a clean update card, applies its original token and drops a stale result', async t => {
  const ui = linkScreen(t, { recovered: recoverLink(linkReport), row: linkRow, save: () => ({ saved: true }) })
  ui.render()
  await flush()
  assert.match(text(ui.render()), /Held: prompt injection/)
  const update = ui.child('LinkUpdate')
  const card = update()
  assert.match(text(card), /New endpoints.*api\.changed\.example.*New scripts.*scripts\/run\.sh.*Fixture Bot/)
  assert.ok(walk(card, node => node.type?.name === 'TreeDiff')[0])
  await match(card, 'Apply').props.onClick()
  assert.deepEqual(ui.requests, [{ update: 'apply', token: 'original-token', name: linkRow.name }])

  const stale = linkScreen(t, { recovered: recoverLink(linkReport, true), row: linkRow })
  stale.render()
  await flush()
  assert.ok(stale.reads() >= 2)
  assert.equal(walk(stale.render(), node => node.type?.name === 'LinkUpdate').length, 0)
  assert.deepEqual(stale.requests, [])
})

test('#2079 F1a recovers Up to date on a held link and keeps Check without re-accept', async t => {
  const ui = linkScreen(t, { recovered: recoverLink({ upToDate: true, held: linkRow.held, checkedAt: linkSource.fetchedAt }), row: linkRow })
  ui.render()
  await flush()
  assert.match(text(ui.render()), /Up to date.*checked/)
  assert.match(text(ui.render()), /Held: prompt injection/)
  assert.ok(match(ui.render(), 'Check for update'))
  assert.ok(match(ui.render(), 'Delete'))
  assert.equal(match(ui.render(), 'Review skill'), undefined)
  assert.deepEqual(ui.requests, [])
})

test('#2079 Skills shows every refusal finding, never Apply, and Cancel sends nothing', async t => {
  const refused = { ...linkReport, token: undefined, refused: true, message: 'A synthetic refusal.',
    findings: [{ rule: 'endpoint', path: 'SKILL.md', line: 1, reason: 'Synthetic gate finding.' },
      { area: 'prompt-injection', file: 'SKILL.md', line: 2, severity: 'low', injection: true, reason: 'Synthetic model finding.' }] }
  const ui = linkScreen(t, { recovered: recoverLink(refused), row: linkRow })
  ui.render()
  await flush()
  const card = ui.child('LinkUpdate')()
  const review = walk(card, node => node.type?.name === 'SkillReport')[0]
  assert.ok(review)
  assert.deepEqual(review.props.report.findings, refused.findings)
  assert.equal(match(card, 'Apply'), undefined)
  match(card, 'Cancel').props.onClick()
  assert.deepEqual(ui.requests, [])
})

test('#2079 F4 recovered expiry copy uses the tombstone kind and starts no new operation', async t => {
  for (const [kind, message] of [['check', 'Check for update again.'], ['apply', 'Check for update again.'],
    ['preview', 'Save the skill again.']]) {
    const ui = linkScreen(t, { recovered: { expired: true, kind }, row: linkRow })
    ui.render()
    await flush()
    const alerts = walk(ui.render(), node => node.props?.role === 'alert').map(text)
    assert.deepEqual(alerts, ['This result is no longer available. ' + message])
    assert.deepEqual(ui.requests, [])
  }
})

function linkedPanel(t) {
  const home = mkdtempSync(join(tmpdir(), 'linked-skills-panel-'))
  t.after(() => rmSync(home, { recursive: true }))
  const path = join(home, 'skill-library', 'library.json')
  const rt = { home, ctx: {}, readOnly: () => undefined, teamGeneration: () => 1,
    sameTeam: generation => generation === 1, teamCurrent: () => true, botOf: () => undefined }
  let fetches = 0, reviews = 0, content = 'LINK-BODY-1', waitForOpen
  stubSkillReviewer(rt)
  rt.assembleLlm = async () => { reviews++; return assembledReview() }
  installLibrary(rt, { linkTransport: {
    resolve: publicResolver,
    async open(url) {
      assert.equal(url.href, directLink)
      fetches++
      await waitForOpen?.()
      return response(skillMd(content))
    },
  } })
  const call = (action, input) => rt.skillLibrary.endpoint(action, input, { role: 'owner', id: 'owner' })
  const complete = async (id, recover = false) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await call('skill-library-save', { operation: id, poll: true, recover })
      if (!result.pending) return result
      await flush()
    }
    assert.fail('Pending skill operation did not finish')
  }
  const name = 'link-notes'
  const previewInput = { preview: true, source: 'link', url: directLink }
  const seed = async () => {
    const operation = '1'.repeat(32)
    await call('skill-library-save', { ...previewInput, operation })
    const { token } = await complete(operation)
    await call('skill-library-save', { token, name, operation: '2'.repeat(32) })
    assert.deepEqual(await complete('2'.repeat(32)), { saved: true })
  }
  const ui = fixture(t)
  const requests = []
  const actions = ui.teamActions({ after: promise => promise, call: async (action, input, signal) => {
    signal?.throwIfAborted()
    if (action === 'skill-library-save') requests.push(input)
    return call(action, input)
  } })
  const panel = () => {
    const owner = ui.mount(ui.SkillsScreen, { actions, rosterSource: { subscribe() {}, getSnapshot: () => ({}) },
      onBack: () => render.unmount() })()
    const render = ui.mount(owner.type, owner.props)
    render()
    return render
  }
  return { ui, panel, requests, path, name, seed, complete, call, counts: () => [fetches, reviews],
    upstream: next => { content = next }, delayOpen: gate => { waitForOpen = gate } }
}

test('#2079 source damaged link Check renders the verified files and Apply writes them', async t => {
  const f = linkedPanel(t)
  await f.seed()
  const stored = JSON.parse(readFileSync(f.path, 'utf8'))
  stored.skills[f.name].content = 'DAMAGED OLD CONTENT'
  writeFileSync(f.path, JSON.stringify(stored))
  f.upstream('LINK-BODY-2')
  const render = f.panel()
  await flush()
  await match(render(), 'Check for update').props.onClick()
  const update = walk(render(), node => node.type?.name === 'LinkUpdate')[0]
  assert.ok(update)
  const card = f.ui.mount(update.type, update.props)()
  assert.match(text(card), /The saved version could not be verified.*checked new content/)
  const tree = walk(card, node => node.type?.name === 'TreeDetails')[0]
  assert.match(text(tree.type(tree.props)), /SKILL\.md.*bytes/)
  assert.doesNotMatch(text(card), /DAMAGED OLD CONTENT/)
  await match(card, 'Apply').props.onClick()
  const saved = await f.call('skill-library-get', { name: f.name })
  assert.match(saved.content, /LINK-BODY-2/)
  assert.equal(saved.held, undefined)
  assert.deepEqual(f.counts(), [2, 2])
})

test('#2079 source Check completed with the panel closed recovers its original token', async t => {
  const f = linkedPanel(t)
  await f.seed()
  f.upstream('LINK-BODY-2')
  const opened = Promise.withResolvers(), release = Promise.withResolvers()
  f.delayOpen(() => { opened.resolve(); return release.promise })
  const first = f.panel()
  await flush()
  const checking = match(first(), 'Check for update').props.onClick()
  await opened.promise
  const id = f.requests.find(request => request.update === 'check').operation
  match(first(), 'Back').props.onClick()
  release.resolve()
  const completed = await f.complete(id)
  assert.ok(completed.token)
  await checking
  const before = f.counts()
  const reopened = f.panel()
  await flush()
  const update = walk(reopened(), node => node.type?.name === 'LinkUpdate')[0]
  assert.ok(update, 'The reopened Skills panel recovered the completed Check')
  assert.equal(update.props.report.token, completed.token)
  assert.deepEqual(f.counts(), before)
  assert.equal(f.requests.filter(request => request.update === 'check').length, 1)
  assert.equal(f.requests.filter(request => request.poll).length, 1)
  assert.equal(f.requests.at(-1).operation, id)
  assert.equal(f.requests.at(-1).recover, true)
  const card = f.ui.mount(update.type, update.props)()
  await match(card, 'Apply').props.onClick()
  assert.match((await f.call('skill-library-get', { name: f.name })).content, /LINK-BODY-2/)
  assert.deepEqual(f.counts(), before)
})

test('#2079 source link create preview renders declared key names before Save', async t => {
  const f = linkedPanel(t)
  f.upstream('Read $DSH_SECRET_FIXTURE_KEY when needed.')
  const render = f.panel()
  await flush()
  match(render(), 'New skill').props.onClick()
  const entry = walk(render(), node => node.type?.name === 'SkillForm')[0]
  const form = f.ui.mount(entry.type, entry.props)
  match(form(), 'From link').props.onClick()
  walk(form(), node => node.props?.label === 'Link')[0].props.onChange(directLink)
  await match(form(), 'Preview').props.onClick()
  const preview = form()
  const card = preview.type(preview.props)
  assert.match(text(card), /Declared key names.*FIXTURE_KEY/)
  assert.ok(match(card, 'Save'))
})

test('2160 fallback review names the model in the library row and confirmation report', async t => {
  const f = fixture(t, 'owner')
  const fallback = { status: 'done', via: 'fallback', model: 'fixture/model', modelName: 'Fixture Model' }
  const owner = f.mount(f.SkillsScreen, {
    actions: {
      skillLibrary: async () => ({ active: {}, skills: [
        { name: 'fallback-item', description: 'Fixture.', review: fallback },
        { name: 'background-item', description: 'Fixture.', review: { status: 'done', model: 'fixture/background' } },
      ] }),
      saveSkill: async () => ({ needsConfirm: 'fixture-receipt', findings: [{ severity: 'medium', reason: 'Fixture warning.' }], review: fallback }),
    },
    rosterSource: { subscribe() {}, getSnapshot: () => ({}) },
  })()
  const render = f.mount(owner.type, owner.props)
  render()
  await flush()
  assert.match(text(render()), /Reviewed by Fixture Model \(fallback\)/)
  assert.match(text(render()), /Reviewed by a model/)
  match(render(), 'New skill').props.onClick()
  const form = walk(render(), node => node.type?.name === 'SkillForm')[0]
  const renderForm = f.mount(form.type, form.props)
  await renderForm().props.onSubmit({ preventDefault() {} })
  assert.match(text(renderForm()), /Reviewed by Fixture Model \(fallback\)/)
  assert.match(text(renderForm()), /Fixture warning/)
})
