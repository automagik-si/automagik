import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: { contents: `
    export { AccountLauncher } from './src/client/sidebar.js'
    export { SkillsScreen, skillFileBytes } from './src/client/skills-screen.js'
    export { BotSkills } from './src/client/bot-skills.js'
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

function fixture(t, boot) {
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
  runInNewContext(outputFiles[0].text, {
    module, exports: module.exports,
    require: name => name === 'react' ? react : name === 'react-dom' ? { createPortal: child => child } : {},
    AbortController, Uint8Array, btoa,
    window: { AbortController, innerHeight: 800, addEventListener() {}, removeEventListener() {} }, document: { body: {} },
    ...(boot ? { __AUTOMAGIK_VIEW__: { version: 1, role: boot } } : {}),
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
