import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, bundle, load, nodes, react, refusal, reply, text, tick, viewerReply } from './viewer-fixture.js'
import { fixture as hostFixture, member, serviceStub, stranger } from './caller-fixture.js'

const code = await bundle(`
export { PeopleCard } from './src/client/people-card.js'
export { bootView, startViewer } from './src/client/viewer.js'
`)
const bot = { id: 'b', name: 'Writer' }
const owners = { mode: 'owners', allow: [] }
const allowlist = { mode: 'allowlist', allow: [] }
const workspace = { mode: 'workspace', allow: [] }
const people = [
  { issuer: 'https://id.invalid', subject: 'long-subject-00001', roles: ['guest'], lastSeen: Date.now() },
  { issuer: 'https://id.invalid', subject: 'long-subject-00002', roles: ['member'], lastSeen: Date.now() },
]

// The card has one stateful owner component. Render its returned element tree
// without mounting unrelated Bot settings or relying on browser timing.
function hooks(t) {
  const values = [], effects = new Map()
  let index = 0
  const api = {
    ...react,
    useState(initial) {
      const key = index++
      if (!(key in values)) values[key] = initial
      return [values[key], next => { values[key] = typeof next === 'function' ? next(values[key]) : next }]
    },
    useRef(initial) {
      const key = index++
      return values[key] ??= { current: initial }
    },
    useEffect(effect, dependencies) {
      const key = index++
      const previous = effects.get(key)
      if (previous && dependencies.every((value, i) => value === previous.dependencies[i])) return
      previous?.dispose?.()
      effects.set(key, { dependencies, dispose: effect() })
    },
  }
  t.after(() => { for (const entry of effects.values()) entry.dispose?.() })
  return { api, render: node => { index = 0; return node.type(node.props) } }
}

async function fixture(t, { off = false, main = false, refused = false, initial = workspace, state = 'open', host } = {}) {
  let committed = initial, save
  const calls = [], results = []
  const h = hooks(t)
  const f = browser({ hooks: h.api, boot: off ? undefined : { version: 1, role: 'owner' }, fetch: ({ body }) => {
    if (body.endpoint === 'whoami') return viewerReply('owner')
    if (body.endpoint === 'people-seen') return refused ? refusal('bot/refused', 'Not available') : reply(people)
    if (host && body.endpoint === 'people-share') return { ok: true, json: () => host.call(body.endpoint, body.payload) }
    if (body.endpoint === 'people-share') return reply({ state, people: committed })
    if (body.endpoint === 'update-bot') {
      calls.push(body.payload)
      if (host) {
        const result = host.call(body.endpoint, body.payload)
        results.push(result)
        return { ok: true, json: () => result }
      }
      if (save) return save(body.payload)
      committed = body.payload.people
      return reply({ id: bot.id, people: committed })
    }
    assert.fail(body.endpoint)
  } })
  const client = load(code, f.globals)
  if (!off) await client.startViewer(client.bootView())
  const form = client.PeopleCard({ bot, roster: { mainBotIds: main ? [bot.id] : [] } })
  const draw = () => form ? h.render(form) : null
  draw()
  await tick()
  return { draw, calls, results, requests: f.calls, mockSave: fn => { save = fn },
    current: next => { committed = next } }
}

const controls = tree => nodes(tree).filter(node => node.type === 'button' && Object.hasOwn(node.props, 'aria-pressed'))
const named = (tree, name) => nodes(tree).find(node => node.props.children.includes(name))

test('PC1 desktop issues no request and a refusal leaves the card hidden', async t => {
  const off = await fixture(t, { off: true })
  assert.equal(off.draw(), null)
  assert.deepEqual(off.requests, [])
  const gated = await fixture(t, { refused: true })
  assert.equal(gated.draw(), null)
  assert.deepEqual(gated.requests.map(call => call.body.endpoint), ['whoami', 'people-seen', 'people-share'])
})

test('PC2 the share modes omit workspace for a Main Bot and people appear in named and workspace modes', async t => {
  for (const [main, initial, expected] of [[false, workspace, 3], [true, allowlist, 2], [false, owners, 3]]) {
    const f = await fixture(t, { main, initial })
    const tree = f.draw()
    assert.equal(controls(tree).length, expected)
    assert.equal(nodes(tree).some(node => node.props.label === 'Guests and named people'), initial !== owners)
  }
})

test('PC3 mode, addition and removal each save once with the committed expectation', async t => {
  const f = await fixture(t)
  named(f.draw(), 'People you choose').props.onClick()
  await tick()
  assert.deepEqual(f.calls, [{ id: 'b', people: allowlist, expect: workspace }])
  const picker = nodes(f.draw()).find(node => node.type === 'select')
  const options = nodes(picker).filter(node => node.type === 'option' && node.props.value)
  for (const person of people) assert.ok(text(picker).some(label => label.includes(person.subject)))
  picker.props.onChange({ target: { value: options[0].props.value } })
  await tick()
  const [first] = people
  const chosen = { mode: 'allowlist', allow: [{ issuer: first.issuer, subject: first.subject, role: 'guest' }] }
  assert.deepEqual(f.calls[1], { id: 'b', people: chosen, expect: allowlist })
  named(f.draw(), 'Remove').props.onClick()
  await tick()
  assert.deepEqual(f.calls[2], { id: 'b', people: allowlist, expect: chosen })
  assert.equal(f.calls.length, 3)
})

test('PC4 in-flight and refused edits keep the committed mode, then stale refresh picks up the saved mode', async t => {
  const f = await fixture(t)
  const pending = Promise.withResolvers()
  f.mockSave(() => pending.promise)
  named(f.draw(), 'People you choose').props.onClick()
  const saving = f.draw()
  assert.ok(controls(saving).every(node => node.props.disabled))
  assert.equal(named(saving, 'Anyone in the workspace').props['aria-pressed'], true)
  pending.resolve(refusal('bot/refused', 'Wait for Writer to finish, then share it.'))
  await tick()
  assert.equal(named(f.draw(), 'Anyone in the workspace').props['aria-pressed'], true)
  assert.ok(text(f.draw()).includes('Wait for Writer to finish, then share it.'))
  f.mockSave(() => {
    f.current(owners)
    return refusal('bot/stale', 'server named stale')
  })
  named(f.draw(), 'People you choose').props.onClick()
  await tick()
  assert.equal(named(f.draw(), 'Only you and admins').props['aria-pressed'], true)
  assert.ok(text(f.draw()).includes('Who may talk to this Bot changed in another window; check it and save again.'))
  for (const [state, message] of [
    ['opening', 'Starting a new part of this chat for sharing…'],
    ['open', 'Shared: people you add read this chat from its new part on.'],
    ['spoiled', 'Sharing did not start because something moved into the new part; stop sharing and share again.'],
  ]) {
    const status = await fixture(t, { state })
    assert.ok(text(status.draw()).includes(message))
  }
})

test('PC5 a second window applies the real card narrowing with a stale guest list', async t => {
  for (const [mode, label] of [['owners', 'Only you and admins'], ['allowlist', 'People you choose']]) {
    const service = serviceStub()
    service.seen = () => [stranger.person]
    const host = hostFixture(t, { service })
    await host.start()
    const { issuer, subject } = stranger.person
    const previous = { mode: 'workspace', allow: [{ issuer, subject, role: 'guest' }] }
    await host.open('b', previous)
    const first = await fixture(t, { host })
    const second = await fixture(t, { host })
    named(first.draw(), 'Remove').props.onClick()
    assert.equal((await first.results[0]).ok, true)
    assert.equal(host.service.visibleBotIds(member).has('b'), true)
    assert.equal(host.service.visibleBotIds(stranger).has('b'), false)
    named(second.draw(), label).props.onClick()
    await tick()
    assert.deepEqual(second.calls, [{ id: 'b', people: { ...previous, mode }, expect: previous }])
    assert.equal((await second.results[0]).ok, true)
    assert.deepEqual(host.saved().bots.b.people, { mode, allow: [] })
    assert.equal(host.service.visibleBotIds(member).has('b'), false)
    assert.equal(host.service.visibleBotIds(stranger).has('b'), false)
  }
})
