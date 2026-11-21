import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const plugin = fileURLToPath(new URL('../', import.meta.url))

export const element = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
export const react = {
  createElement: element, createContext: value => ({ value }), Component: class {}, Fragment: Symbol('Fragment'), memo: fn => fn, forwardRef: fn => fn,
  useEffect() {}, useLayoutEffect() {}, useMemo: fn => fn(), useCallback: fn => fn, useId: () => 'fixture',
  useRef: current => ({ current }), useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
}
export function imports(name, hooks = react) {
  if (name === 'react') return hooks
  if (name === 'react-dom') return { createPortal: node => node }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
  assert.fail('Unexpected client dependency: ' + name)
}
export const tick = () => new Promise(resolve => setImmediate(resolve))
export const reply = value => ({ ok: true, json: async () => ({ ok: true, value }) })
export const refusal = (code, message) => ({ ok: true, json: async () => ({ ok: false, error: { code, message } }) })
export const viewerReply = (role, id = 'viewer-id') => reply({
  multiuser: true, role: role === 'admin' ? 'owner' : role, viewer: { id, role },
})

function storage(values = new Map(), writes = []) {
  const data = {
    get length() { return values.size },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    values,
  }
  Object.setPrototypeOf(data, {
    setItem(key, value) { values.set(key, value); writes.push([key, value]) },
    removeItem: key => values.delete(key),
  })
  return data
}

function events(props = {}) {
  const listeners = new Map()
  return Object.assign(props, {
    listeners,
    addEventListener(name, fn) {
      const list = listeners.get(name) ?? new Set()
      list.add(fn)
      listeners.set(name, list)
    },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    emit: (name, event) => { for (const fn of listeners.get(name) ?? []) fn(event) },
  })
}

export function browser({ boot, fetch, session, local, hooks = react, timers = {} } = {}) {
  const calls = [], writes = [], reloads = [], intervals = new Set()
  const req = (url, args) => {
    const call = { url, method: args?.method ?? 'GET', body: typeof args?.body === 'string' ? JSON.parse(args.body) : args?.body,
      signal: args?.signal, headers: args?.headers }
    calls.push(call)
    return fetch ? fetch(call) : viewerReply(boot?.role)
  }
  const window = events()
  const styles = new Map()
  const body = {
    inert: false,
    children: [],
    replaceChildren(...children) { this.children = children },
    style: {
      setProperty(name, value, priority) { styles.set(name, { value, priority }) },
      getPropertyValue: name => styles.get(name)?.value ?? '',
      getPropertyPriority: name => styles.get(name)?.priority ?? '',
    },
  }
  const document = events({ body, visibilityState: 'visible' })
  const localStorage = storage(local ?? new Map([['dsh.conversation.a', 'draft'], ['dsh.conversation.b', 'draft'], ['keep', 'yes']]), writes)
  const sessionStorage = storage(session)
  const globals = {
    window, document, location: { reload: () => reloads.push(true) },
    localStorage, sessionStorage, fetch: req, AbortController, URL, URLSearchParams, Blob, console,
    setTimeout, clearTimeout, setInterval: fn => { intervals.add(fn); return fn }, clearInterval: fn => intervals.delete(fn), ...timers,
    require: name => imports(name, hooks),
  }
  if (boot !== undefined) globals.__AUTOMAGIK_VIEW__ = boot
  return { globals, calls, reloads, window, document, writes, localStorage, sessionStorage, intervals }
}

export async function bundle(source) {
  const { outputFiles } = await build({
    stdin: { contents: source, resolveDir: plugin },
    bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  return outputFiles[0].text
}

export function load(code, globals) {
  const module = { exports: {} }
  runInNewContext(code, { ...globals, module, exports: module.exports })
  return module.exports
}

export function loadClient(globals) {
  let client
  const request = globals.require
  request.async ??= async name => {
    assert.equal(name, './client.gated.js')
    let chunk
    const loader = globals.window.__ModuleLoader__
    globals.window.__ModuleLoader__ = { load: entry => {
      assert.equal(entry.chunk, 'client.gated.js')
      chunk = entry.factory(request)
    } }
    try { runInNewContext(readFileSync(new URL('../client.gated.js', import.meta.url), 'utf8'), globals) }
    finally { globals.window.__ModuleLoader__ = loader }
    return chunk
  }
  globals.window.__ModuleLoader__ = { load: entry => { client = entry.factory(request) } }
  runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), globals)
  return client
}

export function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props.children)]
}

export function text(tree) {
  if (Array.isArray(tree)) return tree.flatMap(text)
  if (typeof tree === 'string') return [tree]
  return tree && typeof tree === 'object' ? text(tree.props.children) : []
}
