// A stand-in for herdr-core behind the chat seam (hc.js), for tests only: never a live Herdr.
// Terminals, screens and files are in memory; every call is recorded so a test can check what
// was asked (a remote read's `on`, that no `cwd` was sent). file.read follows herdr-core (checked
// against a real one): lines from `offset` (1-based), at most `limit` (0: none, just the count),
// line ends kept, how many lines the file has, and invalid_params for an offset past the last line.

/**
 * @param {{ terminals?: object[], screens?: Record<string, string>, files?: Record<string, Record<string, string>> }} [state]
 *   files: { [machine or '']: { [path]: text } } ('' is this computer)
 */
export function createFakeHc({ terminals = [], screens = {}, files = {}, readCap = 8 * 1024 * 1024 } = {}) {
  const calls = []
  const subs = new Set()
  let seq = 1
  const byAddress = new Map(terminals.map((t) => [t.address, structuredClone(t)]))
  const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

  const methods = {
    'terminal.get'({ terminal }) {
      const t = byAddress.get(terminal)
      if (!t) throw Object.assign(new Error('not_found'), { kind: 'not_found' })
      return structuredClone(t)
    },
    'terminal.list'() {
      return { terminals: [...byAddress.values()].map((t) => structuredClone(t)), hidden_finished: 0, machines: [] }
    },
    'terminal.read'({ terminal }) {
      if (!byAddress.has(terminal)) throw Object.assign(new Error('not_found'), { kind: 'not_found' })
      return { text: screens[terminal] ?? '', complete: true, how: 'screen' }
    },
    'file.read'({ path, on = null, offset = 1, limit = null }) {
      const text = files[on ?? '']?.[path]
      if (text === undefined) throw Object.assign(new Error('not_found'), { kind: 'not_found' })
      const all = splitLines(text)
      const first = Math.max(1, offset ?? 1)
      // As herdr-core: offset 1 is always valid; past the last line is invalid_params.
      if (first > 1 && first > all.length) throw Object.assign(new Error(`offset ${first}: the file has ${all.length} lines`), { kind: 'invalid_params' })
      const wanted = all.slice(first - 1, limit == null ? undefined : first - 1 + limit)
      // As herdr-core: a read stops before the line that would pass its cap (8 MB).
      const given = []
      let bytes = 0
      for (const l of wanted) {
        bytes += Buffer.byteLength(l)
        if (bytes > readCap) break
        given.push(l)
      }
      return { text: given.join(''), first, last: first + given.length - 1, lines: all.length }
    }
  }

  // Write methods, as herdr-core: send refuses a blocked program unless forced, and a status that
  // is not exactly `if`; keys and interrupt answer like it. `react` lets a test change the terminal
  // after a key or a send (a dialog going away, a turn starting).
  const reactions = []
  const react = (method, params) => { for (const r of reactions) r(method, params) }
  Object.assign(methods, {
    'terminal.send'(params) {
      const t = byAddress.get(params.terminal)
      if (!t) throw Object.assign(new Error('not_found'), { kind: 'not_found' })
      const state = t.status?.state ?? null
      if (state === 'blocked' && !params.force) throw Object.assign(new Error('blocked'), { kind: 'blocked' })
      if (params.if != null && params.if !== state) throw Object.assign(new Error('status_mismatch'), { kind: 'status_mismatch' })
      react('terminal.send', params)
      return { started: true, status: state, turn: t.turn ?? 0 }
    },
    'terminal.keys'(params) {
      const t = byAddress.get(params.terminal)
      if (!t) throw Object.assign(new Error('not_found'), { kind: 'not_found' })
      // As herdr-core: the status and turn when the key went in, before the program reacts.
      const typed = { status: t.status?.state ?? null, turn: t.turn ?? 0 }
      react('terminal.keys', params)
      return typed
    },
    'terminal.interrupt'(params) {
      const t = byAddress.get(params.terminal)
      if (!t) throw Object.assign(new Error('not_found'), { kind: 'not_found' })
      react('terminal.interrupt', params)
      return { outcome: 'stopped', key: t.status ? 'esc' : 'ctrl+c' }
    }
  })

  return {
    calls,
    files,
    screens,
    /** Run `fn(method, params)` after each send, keys or interrupt. */
    onWrite(fn) { reactions.push(fn) },
    /** Set a terminal's facts without an event (as if read fresh). */
    set(address, data) { Object.assign(byAddress.get(address), data) },
    async call(method, params = {}) {
      calls.push({ method, params: structuredClone(params) })
      const fn = methods[method]
      if (!fn) throw new Error(`fake hc: no ${method}`)
      return fn(params)
    },
    subscribe(params, onMessage) {
      calls.push({ method: 'events.subscribe', params: structuredClone(params) })
      const sub = { params, onMessage, open: true }
      subs.add(sub)
      queueMicrotask(() => sub.open && onMessage({ type: 'snapshot', seq, terminals: [...byAddress.values()].map((t) => structuredClone(t)) }))
      return { close: () => { sub.open = false; subs.delete(sub) } }
    },
    close() { for (const s of subs) s.open = false; subs.clear() },

    // ---- test controls

    /** Change a terminal's facts and send the event herdr-core would. */
    change(address, kind, data) {
      const t = byAddress.get(address)
      if (t) Object.assign(t, data)
      seq += 1
      for (const s of subs) if (s.open) s.onMessage({ type: 'event', terminal: address, seq, kind, data: structuredClone(data) })
    },
    heartbeat() { for (const s of subs) if (s.open) s.onMessage({ type: 'heartbeat', seq }) },
    missed() {
      seq += 1
      for (const s of subs) if (s.open) s.onMessage({ type: 'missed', seq, terminals: [...byAddress.values()].map((t) => structuredClone(t)) })
    },
    drop(reason = 'hc exited') { for (const s of subs) { if (s.open) { s.open = false; s.onMessage({ type: 'closed', reason }) } } subs.clear() },
    append(on, path, text) { files[on ?? ''] ??= {}; files[on ?? ''][path] = (files[on ?? ''][path] ?? '') + text },
    get subscriptions() { return subs.size }
  }
}

/** A terminal record shaped like herdr-core's `Terminal` (only the fields the chat reads). */
export function fakeTerminal(address, { app = 'claude-code', argv = ['claude'], cwd = '/home/u/proj', labels = {}, state = 'idle', kind = null, created = 1_000, turn = 0 } = {}) {
  return {
    address, argv, cwd, labels, created_ms: created, turn, state: 'live', title: '', screen: '', cols: 120, rows: 40,
    foreground: { pid: 1, name: argv[0], argv, cwd },
    status: { app, state, ...(kind ? { kind } : {}), msg: '' }
  }
}
