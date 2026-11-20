import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, loadClient, nodes, reply, text, tick, viewerReply } from './viewer-fixture.js'

function slotsOf(t, f, member) {
  const registered = [], effects = [], disposers = []
  let panel = 'other-panel'
  const panelListeners = new Set()
  const forbidden = new Proxy({}, { get(_target, key) { assert.fail('Member UI read a native surface: ' + String(key)) } })
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      if (member && !/styles|theme|interface copy/.test(label)) disposers.push(fn())
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
    sessions: member ? forbidden : { list: {} },
    uiConversation: member ? forbidden : {},
    uiWorkspace: member ? forbidden : {},
    get: () => undefined, inject: () => () => {},
  }
  t.after(() => { for (const dispose of disposers.reverse()) dispose?.() })
  const client = loadClient(f.globals)
  client.apply(ctx)
  return { ctx, registered, effects, panel: () => panel, get: name => registered.find(row => row.options.name === name) }
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
    assert.deepEqual(feeds.map(feed => feed.url), ['api/omni-ui/feed'])
    assert.deepEqual(f.writes, [['automagik.viewer', 'viewer-id']])
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
