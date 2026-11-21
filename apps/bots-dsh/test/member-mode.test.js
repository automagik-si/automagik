import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, loadClient, nodes, reply, text, tick, viewerReply } from './viewer-fixture.js'

function slotsOf(t, f, member, { ownerEffects = [], sessions } = {}) {
  const registered = [], effects = [], disposers = []
  let surfaceDisposals = 0
  let panel = 'other-panel'
  const panelListeners = new Set()
  const forbidden = new Proxy({}, { get(_target, key) { assert.fail('Member UI read a native surface: ' + String(key)) } })
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      if ((member && !/styles|theme|interface copy/.test(label)) || ownerEffects.includes(label)) disposers.push(fn())
      return () => {}
    },
    slots: {
      entries: () => [],
      inject: (_name, fn) => fn(),
      register(options, component) { registered.push({ options, component }); return () => {} },
    },
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: panel }),
        subscribe: fn => { panelListeners.add(fn); return () => panelListeners.delete(fn) },
      },
      selectPanel(id) { panel = id; for (const fn of panelListeners) fn() },
    },
    sessions: member ? forbidden : sessions ?? { list: {} },
    uiConversation: member ? forbidden : {},
    uiWorkspace: member ? forbidden : {},
    get: () => undefined,
    inject(deps, apply) {
      if (deps.length !== 0) return
      const scoped = []
      apply({ ...ctx, effect(fn, label) {
        effects.push(label)
        if ((member && !/styles|theme|interface copy/.test(label)) || ownerEffects.includes(label)) scoped.push(fn())
      } })
      const dispose = () => {
        surfaceDisposals++
        for (const cleanup of scoped.splice(0).reverse()) cleanup?.()
      }
      disposers.push(dispose)
      return { dispose }
    },
  }
  t.after(() => { for (const dispose of disposers.reverse()) dispose?.() })
  const client = loadClient(f.globals)
  client.apply(ctx)
  return { ctx, client, registered, effects, surfaceDisposals: () => surfaceDisposals,
    panel: () => panel, get: name => registered.find(row => row.options.name === name) }
}

function feedFixture(f) {
  const feeds = []
  f.globals.EventSource = class {
    static CLOSED = 2
    constructor(url) { this.url = url; this.events = new Map(); this.readyState = 1; feeds.push(this) }
    addEventListener(name, fn) { this.events.set(name, fn) }
    emit(name, data) { this.events.get(name)?.({ data: JSON.stringify(data) }) }
    close() { this.readyState = 2 }
  }
  return feeds
}
const bots = [{ id: 'a', name: 'Allowed Bot' }]
const render = entry => entry.component(entry.options.inject?.() ?? {})

test('MM1 member and guest use only caller requests, read-only slots and the viewer storage key', async t => {
  for (const role of ['guest', 'member']) {
    const boot = Promise.withResolvers()
    const f = browser({ boot: { version: 1, role }, fetch: ({ body }) => {
      if (body.endpoint === 'whoami') return boot.promise
      if (body.endpoint === 'state') return reply({ revision: 1, bots })
      if (body.endpoint === 'chat') return reply({ items: [{ kind: 'bot', text: 'latest' }], cursor: 'opaque-next' })
      if (body.endpoint === 'earlier') return reply({ items: [{ kind: 'user', text: 'earlier' }], cursor: null })
      assert.fail(body.endpoint)
    } })
    const feeds = feedFixture(f)
    const app = slotsOf(t, f, true)
    assert.deepEqual(app.registered, [])
    assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
    assert.deepEqual(feeds, [])
    boot.resolve(viewerReply(role))
    await tick()
    const main = app.get('main')
    assert.equal(main.component.name, 'MemberRoot')
    assert.equal(main.options.key, 'conversation')
    assert.equal(app.get('sidebar.workspaces').component.name, 'MemberSidebar')
    for (const name of ['settings.trigger', 'settings.launcher']) assert.equal(app.get(name).component.name, 'Nothing')
    assert.equal(app.panel(), null)
    app.ctx.layout.selectPanel('later-panel')
    assert.equal(app.panel(), null)
    assert.deepEqual(feeds.map(feed => feed.url.split('?')[0]), ['api/omni-ui/feed'])
    assert.equal(feeds[0].url, `api/omni-ui/feed?viewer=viewer-id.${role}`)
    assert.deepEqual(f.writes, [['automagik.viewer', 'viewer-id']])
    feeds[0].emit('hello')
    await tick()
    const tree = render(main)
    const line = 'You can read this chat, but not send messages.'
    assert.ok(text(tree).includes(line))
    const rows = nodes(tree).find(node => node.type.name === 'MemberRows')
    assert.ok(rows)
    assert.match(JSON.stringify(rows.props.pages), /latest/)
    const earlier = nodes(tree).find(node => node.props.children.includes('Load earlier'))
    earlier.props.onClick()
    await tick()
    assert.deepEqual(f.calls.at(-1).body, { endpoint: 'earlier', payload: { botId: 'a', cursor: 'opaque-next' }, viewer: 'viewer-id' })
    assert.ok(f.calls.every(call => call.url === 'api/omni-ui' && call.method === 'POST' &&
      ['whoami', 'state', 'chat', 'earlier'].includes(call.body.endpoint)))
    const rendered = nodes(render(main)).map(node => String(node.type.name ?? node.type))
    assert.ok(rendered.every(name => !/Composer|Card|Thinking|textarea|input/.test(name)))
    feeds[0].emit('changed', { botId: 'a' })
    await tick()
    assert.doesNotMatch(JSON.stringify(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages), /earlier/)
    feeds[0].emit('error')
    assert.equal(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages.length, 0)
    feeds[0].emit('hello')
    await tick()
    assert.equal(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages.length, 1)
    f.window.emit('storage', { key: 'automagik.viewer', newValue: 'another' })
    assert.equal(feeds[0].readyState, 2)
    assert.equal(nodes(render(main)).find(node => node.type.name === 'MemberRows').props.pages.length, 0)
  }
})

test('MM2 desktop takes the synchronous owner path without a viewer call', t => {
  const f = browser()
  const app = slotsOf(t, f, false)
  assert.ok(app.effects.includes('ds-bot: roster poll'))
  assert.ok(app.registered.some(({ component }) => component.name === 'BotReturn'))
  assert.ok(app.registered.every(({ component }) => !component.name.startsWith('Member')))
  assert.deepEqual(f.calls, [])
})

test('MM3 gated owner waits for whoami before mounting the owner path', async t => {
  const pending = Promise.withResolvers()
  const f = browser({ boot: { version: 1, role: 'owner' }, fetch: () => pending.promise })
  const app = slotsOf(t, f, false)
  assert.deepEqual(app.registered, [])
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
  assert.ok(!app.effects.includes('ds-bot: roster poll'))
  pending.resolve(viewerReply('admin'))
  await tick()
  assert.ok(app.effects.includes('ds-bot: roster poll'))
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
})

test('MM4 owner retirement clears rendered content, drafts and state even when reload cannot happen', async t => {
  for (const blocked of ['storage throws', 'reload latch']) {
    const pending = Promise.withResolvers()
    const f = browser({ boot: { version: 1, role: 'owner' }, fetch: ({ body }) => {
      if (body.endpoint === 'whoami') return viewerReply('owner')
      return pending.promise
    } })
    let draft = 'private draft'
    const app = slotsOf(t, f, false, {
      ownerEffects: ['ds-bot: clear owner state on retirement', 'ds-bot: retire gated surface'],
      sessions: { list: { getSnapshot: () => ({ byId: { 'private-chat': {} } }) },
        binding: () => ({ props: { inputActions: { setDraft(value) { draft = value } } } }) },
    })
    await tick()
    const { hooks } = app.client.omni.face()
    hooks.roster.set({ bots: [{ name: 'Private Bot' }] })
    hooks.ui.set({ quote: 'private quote' })
    f.document.body.replaceChildren({ text: 'private transcript' }, { value: 'private draft' })
    if (blocked === 'storage throws') {
      f.localStorage.key = () => { throw new Error('local storage blocked') }
      f.sessionStorage.getItem = () => { throw new Error('session storage blocked') }
    } else f.sessionStorage.setItem('automagik.retired', '1')
    const late = app.client.omni.call('state')
    f.window.emit('storage', { key: 'automagik.viewer', newValue: 'another' })
    assert.deepEqual(f.document.body.children, [])
    assert.equal(draft, '')
    assert.equal(app.client.omni.face(), null)
    assert.deepEqual(Array.from(hooks.roster.getSnapshot().bots), [])
    assert.equal(hooks.ui.getSnapshot().quote, null)
    assert.deepEqual(f.reloads, [])
    pending.resolve(reply({ bots: [{ name: 'late private Bot' }] }))
    await assert.rejects(late, { code: 'bot/retired' })
    assert.equal(app.surfaceDisposals(), 1)
  }
})

test('MM5 feed loss hides the roster and header until a fresh state authorizes the selection', async t => {
  let state = bots
  const f = browser({ boot: { version: 1, role: 'member' }, fetch: ({ body }) => {
    if (body.endpoint === 'whoami') return viewerReply('member')
    if (body.endpoint === 'state') return state ? reply({ bots: state }) : { ok: false, status: 503 }
    return reply({ items: [], cursor: null })
  } })
  const feeds = feedFixture(f)
  const app = slotsOf(t, f, true)
  await tick()
  feeds[0].emit('hello')
  await tick()
  const main = app.get('main'), sidebar = app.get('sidebar.workspaces')
  assert.ok(text(render(main)).includes(bots[0].name))
  assert.ok(text(render(sidebar)).includes(bots[0].name))
  feeds[0].emit('error')
  assert.ok(!text(render(main)).includes(bots[0].name))
  assert.ok(!nodes(render(main)).some(node => node.type === 'header'))
  assert.ok(!text(render(sidebar)).includes(bots[0].name))
  state = undefined
  feeds[0].emit('hello')
  await tick()
  assert.ok(!text(render(main)).includes(bots[0].name))
  assert.ok(!text(render(sidebar)).includes(bots[0].name))
  state = bots
  feeds[0].emit('revision')
  await tick()
  assert.ok(text(render(main)).includes(bots[0].name))
  assert.ok(text(render(sidebar)).includes(bots[0].name))
})

test('MM6 withdrawal before a delayed feed hello never displays the old roster or chat', async t => {
  let shared = true
  const f = browser({ boot: { version: 1, role: 'member' }, fetch: ({ body }) => {
    if (body.endpoint === 'whoami') return viewerReply('member')
    if (body.endpoint === 'state') return reply({ bots: shared ? bots : [] })
    return reply({ items: [{ kind: 'bot', text: 'withdrawn chat' }], cursor: null })
  } })
  const feeds = feedFixture(f)
  const app = slotsOf(t, f, true)
  await tick()
  feeds[0].emit('revision')
  await tick()
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami'])
  shared = false
  feeds[0].emit('hello')
  await tick()
  assert.deepEqual(f.calls.map(call => call.body.endpoint), ['whoami', 'state'])
  assert.doesNotMatch(text(render(app.get('sidebar.workspaces'))).join(' '), /Allowed Bot/)
  assert.deepEqual(Array.from(nodes(render(app.get('main'))).find(node => node.type.name === 'MemberRows').props.pages), [])
})
