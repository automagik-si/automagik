import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browser, bundle, load, nodes, text } from './viewer-fixture.js'

const code = await bundle("export { MemberRows } from './src/client/member-root.js'")
const expand = node => Array.isArray(node) ? node.map(expand)
  : typeof node?.type === 'function' ? expand(node.type(node.props))
    : node?.props ? { ...node, props: { ...node.props, children: expand(node.props.children) } } : node

test('MR1 member rows render literal text and inert Bot marks without any requests or actions', () => {
  const f = browser({ fetch: () => assert.fail('render fetched a resource') })
  const { MemberRows } = load(code, f.globals)
  const bots = [
    { id: 'a', name: 'Bot A', avatar: { pet: { id: 'fixture', source: 'team', version: 2 } } },
    { id: 'b', name: 'Bot B', kind: 'genie' },
  ]
  const roster = { bots, byId: Object.fromEntries(bots.map(bot => [bot.id, bot])) }
  const prose = '@Bot A\n![photo](https://media.invalid/a) [link](https://media.invalid/b)\n<canvas>program</canvas>'
  for (const bot of bots) {
    const tree = expand(MemberRows({ roster, botId: bot.id, pages: [[{ kind: 'user', text: prose }, { kind: 'bot', text: prose }]] }))
    for (const line of prose.split('\n')) assert.equal(text(tree).filter(word => word === line).length, 2)
    assert.ok(nodes(tree).every(node => node.type !== 'a' && node.type !== 'img' && !node.props.href && !node.props.onClick))
  }
  assert.deepEqual(f.calls, [])
})
