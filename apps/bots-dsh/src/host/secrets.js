// Secrets: keys the user types into a card for a Bot. A value lives only in
// secrets.json (mode 600) and in this process; Bots use it as $DSH_SECRET_<NAME> in
// their shell, tool results lose it before they are saved, and every model request
// has it replaced by [secret:<NAME>] before it leaves.
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { refusal } from './refusal.js'
import { chmodSync, copyFileSync, readFileSync } from 'node:fs'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GITHUB_TOKEN_DAYS, GITHUB_WORK, cleanGitHubWork, githubPermissions, isGitHubTokenName } from '../shared/github-token.js'
import { replaceFile } from './files.js'
import { output } from './tools.js'

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
export const ENV_PREFIX = 'DSH_SECRET_'
// A short value (a PIN, a short password) would also hit ordinary words if it were
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where it
// stands alone: no letter or digit right before or after it.
export const MIN_VALUE = 4
export const WHOLE_VALUE = 8
// A piece of a secret left at a cut edge: shorter pieces (a path segment, a host
// name) are too short to tell from ordinary text.
export const EDGE_MIN = 12
const STDERR = '[stderr]\n'
const TRUNCATED = '\n[output truncated'
export const MAX_VALUE = 16384
const MAX_REQUESTS = 20
const USED_SAVE_MS = 5000

export const envName = name => `${ENV_PREFIX}${name}`
export const canUse = (secret, botId) => secret !== undefined && botId !== undefined
  && (secret.scope === 'all' || (Array.isArray(secret.scope) && secret.scope.includes(botId)))

// A value below the write floor can only reach the store by hand-editing secrets.json, and
// nothing can use it safely: the redactor cannot match a 1-3 character value (it sits inside
// ordinary words), so it would leak wherever it appeared. Such an entry is held instead of
// dropped: it stays in the file and in the list (with a warning naming the floor) and no path
// hands it out, so a hand-edited secret cannot ride along unredactable. Trimming matches the
// write path, which stores the trimmed value.
const held = secret => secret !== undefined && typeof secret.value === 'string' && secret.value.trim().length < MIN_VALUE
const heldReason = name => `Secret ${name} is held: its saved value is shorter than ${MIN_VALUE} characters, so it is never used. Save a new value with at least ${MIN_VALUE} characters.`

export function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/^\$(env:)?/i, '').replace(/^DSH_SECRET_/i, '').replace(/[\s-]+/g, '_').toUpperCase()
}

// encodeURIComponent leaves ' as is, but new URL() turns it into %27 in a query, so the
// URL sent out would hold a form the redactor does not know. Encoding these characters
// too keeps the sent URL equal to the text the redactor looks for.
export const encodeUrlComponent = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const quotePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Consume escaped backslashes together: \\u is literal text, not a JSON escape.
const formTokens = /%[0-9a-fA-F]{2}|\\(?:u[0-9a-fA-F]{4}|\\)|[\s\S]/g
const hexToken = token => token.length === 3 && token[0] === '%' || token.length === 6 && token.startsWith('\\u')
const hexTokens = /%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\\\/g
// Lower-cases only the hex digits of %XX and real \uXXXX escapes; the length never changes,
// so an offset in the key is an offset in the text.
const formKey = value => value.replace(hexTokens, token => token === '\\\\' ? token : token.toLowerCase())
const formPattern = value => value.replace(formTokens, token => hexToken(token)
  ? quotePattern(token).replace(/[a-fA-F]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`)
  : quotePattern(token))
// A match that opens with a backslash is real only after an even run of backslashes:
// after an odd one, its backslash is the second half of an escaped `\\`.
const escapedAt = (text, index) => {
  let run = 0
  while (index - run > 0 && text[index - run - 1] === '\\') run++
  return run % 2 === 1
}
// Cut pieces of an encoded form may start or end inside a %XX or \uXXXX token, where
// the token cannot be recognized, so their hex letters are compared in one case.
const foldHex = text => text.replace(/[A-F]/g, c => c.toLowerCase())
// KMP: the longest suffix of `text` that is a proper prefix of `form`, in linear time.
const failure = (form) => {
  const table = new Int32Array(form.length)
  for (let i = 1, k = 0; i < form.length; i++) {
    while (k && form[i] !== form[k]) k = table[k - 1]
    if (form[i] === form[k]) k++
    table[i] = k
  }
  return table
}
const overlap = (form, table, text) => {
  let k = 0
  for (let i = 0; i < text.length; i++) {
    while (k && text[i] !== form[k]) k = table[k - 1]
    if (text[i] === form[k]) k++
    if (k === form.length) k = table[k - 1]
  }
  return k
}
const reverse = text => text.split('').reverse().join('')

// One function that replaces every known value in a string, longest first so a value
// that contains another is replaced whole. JSON-escaped and URL-encoded forms are covered too.
// `wholeWords: false` matches a short value inside a word as well: the global policy keeps the
// lookarounds so a PIN does not hit ordinary words, while a caller that renders only a small,
// already-quoted answer (the capability probe) pays over-redaction instead of leaking an edge.
export function redactor(entries, { wholeWords = true } = {}) {
  const pairs = []
  for (const { name, value } of entries) {
    if (typeof value !== 'string' || value.length < MIN_VALUE) continue
    const label = `[secret:${name}]`
    const short = value.length < WHOLE_VALUE
    const escaped = JSON.stringify(value).slice(1, -1)
    const forms = new Set([value, escaped, escaped.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)])
    // encodeURIComponent throws on a lone surrogate; it cannot sit in a URL anyway.
    if (value.isWellFormed()) {
      forms.add(encodeURIComponent(value))
      forms.add(encodeUrlComponent(value))
    }
    for (const form of forms) pairs.push([form, label, short, form === value])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  if (pairs.length === 0) return text => text
  const labels = new Map()
  // An escape-led form (JSON or ASCII JSON starting with `\uXXXX`, `\"`...) is real only
  // after an even run of backslashes; the raw value is taken as it stands.
  const escapeLed = new Set()
  const sources = []
  for (const [value, label, short, raw] of pairs) {
    const key = formKey(value)
    if (!labels.has(key)) labels.set(key, label)
    if (!raw && value.startsWith('\\')) escapeLed.add(key)
    const source = formPattern(value)
    sources.push(short && wholeWords ? `(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])` : source)
  }
  // Compiled on first use, so text without a secret never builds it. A pattern too large
  // for the engine falls back to one pattern per form, longest first; its error is never
  // let out, since its message quotes the secrets.
  let patterns
  // V8 compiles a pattern on its first run, so a test run is part of building one.
  const build = (source) => {
    const pattern = new RegExp(source, 'gu')
    pattern.test('')
    return pattern
  }
  const compile = () => {
    if (patterns) return patterns
    try { patterns = [build(sources.join('|'))] } catch {
      // A form whose own pattern is too large is searched literally, in its exact case
      // and with its hex in one case (formKey keeps offsets).
      patterns = sources.map((source, i) => {
        try { return build(source) } catch { return pairs[i][0] }
      })
    }
    return patterns
  }
  const rejected = (text, start, match) => match.startsWith('\\') && escapedAt(text, start) && escapeLed.has(formKey(match))
  // Every whole match as [start, end, label], in text order, never overlapping.
  const wholeMatches = (text) => {
    const found = []
    const list = compile()
    const single = list.length === 1 && typeof list[0] !== 'string'
    const take = (start, end, match) => {
      if (!single && found.some(([from, to]) => from < end && start < to)) return
      found.push([start, end, labels.get(formKey(match))])
    }
    let textKey
    for (const pattern of list) {
      if (typeof pattern === 'string') {
        const literal = (source, form) => {
          for (let at = source.indexOf(form); at !== -1; at = source.indexOf(form, at + 1)) {
            const match = text.slice(at, at + form.length)
            if (!rejected(text, at, match)) take(at, at + form.length, match)
          }
        }
        literal(text, pattern)
        textKey ??= formKey(text)
        if (formKey(pattern) !== pattern || textKey !== text) literal(textKey, formKey(pattern))
        continue
      }
      pattern.lastIndex = 0
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        // A rejected escape may hide a secret inside it: search again one step on.
        if (rejected(text, match.index, match[0])) { pattern.lastIndex = match.index + 1; continue }
        take(match.index, match.index + match[0].length, match[0])
      }
    }
    return found.sort((x, y) => x[0] - y[0])
  }
  const rawForms = [...new Set(pairs.map(([form]) => form))]
  const keys = [...labels.keys()]
  // Literal precheck: an exact form, or a form with its hex in another case.
  const present = (text) => {
    if (rawForms.some(form => text.includes(form))) return true
    if (!text.includes('%') && !text.includes('\\')) return false
    const key = formKey(text)
    return keys.some(form => key.includes(form))
  }
  // One edge per exact form: two secrets whose forms differ only in case keep both.
  const edges = [...new Map(pairs.filter(([form, , short]) => !short && form.length > EDGE_MIN)
    .map(([form, label, , raw]) => {
      const folded = formKey(form) !== form || /%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/.test(form)
      const key = folded ? foldHex(form) : form
      // Hex digits inside the form's %XX and \uXXXX tokens: the only places a cut piece
      // may differ from the form in case.
      const hex = new Uint8Array(form.length)
      for (const token of form.matchAll(/%[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\\\/g)) {
        if (token[0] !== '\\\\') for (let i = token.index + (token[0][0] === '%' ? 1 : 2); i < token.index + token[0].length; i++) hex[i] = 1
      }
      return [form, { key, form, label, raw, folded, hex, rev: reverse(key) }]
    })).values()]
  const anchors = new Set(edges.flatMap(({ key }) => [key.slice(0, EDGE_MIN), key.slice(-EDGE_MIN)]))
  // Literal anchors, no `u` flag, so an anchor cut inside a surrogate pair still matches.
  const anchorPattern = anchors.size ? new RegExp([...anchors].map(quotePattern).join('|')) : null
  // Every region to replace: whole matches, plus cut pieces at the edges of a cut text.
  // Overlapping regions merge into one, labelled by every secret in it, and text outside
  // them is never reprocessed, so word boundaries stay as they were.
  const regions = (text, cut) => {
    const found = present(text) ? wholeMatches(text) : []
    const foldedText = cut ? foldHex(text) : ''
    if (cut && anchorPattern.test(text) || cut && anchorPattern.test(foldedText)) {
      const labelsIn = Array.from(text.matchAll(/\[secret:[^\]\r\n]*\]/g), match => [match.index, match.index + match[0].length])
      // Only where a cut lands: DSH keeps a stream's tail, so a suffix piece opens the
      // text (or the stream after `[stderr]`); a head cut leaves a prefix piece at the
      // end (or before DSH's truncation notice). A byte cut inside a character decodes
      // to up to three U+FFFD first. Pieces elsewhere are ordinary text.
      const starts = [0], ends = [text.length]
      for (let at = text.indexOf(STDERR); at !== -1; at = text.indexOf(STDERR, at + 1)) starts.push(at + STDERR.length)
      for (let at = text.indexOf(TRUNCATED); at !== -1; at = text.indexOf(TRUNCATED, at + 1)) ends.push(at)
      for (let i = 0; i < starts.length; i++) {
        for (let n = 0; n < 3 && text[starts[i]] === '\uFFFD'; n++) starts[i]++
      }
      // Folding matched the piece; outside hex tokens it must match in exact case.
      const exact = (edge, start, size, at) => {
        if (!edge.folded) return true
        for (let i = 0; i < size; i++) {
          if (text[start + i] !== edge.form[at + i] && !edge.hex[at + i]) return false
        }
        return true
      }
      const offer = (start, end, edge) => {
        if (end - start < EDGE_MIN) return
        if (!edge.raw && text[start] === '\\' && escapedAt(text, start)) return
        if (labelsIn.some(([from, to]) => from < end && start < to)) return
        found.push([start, end, edge.label])
      }
      for (const edge of edges) {
        const source = edge.folded ? foldedText : text
        const length = edge.key.length
        for (const from of starts) {
          const window = source.slice(from, from + length - 1)
          if (!window.includes(edge.key.slice(-EDGE_MIN))) continue
          edge.revTable ??= failure(edge.rev)
          // A border that fails the exact check gives way to the next shorter one.
          let size = overlap(edge.rev, edge.revTable, reverse(window))
          while (size >= EDGE_MIN && !exact(edge, from, size, length - size)) size = edge.revTable[size - 1]
          offer(from, from + size, edge)
        }
        for (const to of ends) {
          const window = source.slice(Math.max(0, to - length + 1), to)
          if (!window.includes(edge.key.slice(0, EDGE_MIN))) continue
          edge.table ??= failure(edge.key)
          let size = overlap(edge.key, edge.table, window)
          while (size >= EDGE_MIN && !exact(edge, to - size, size, 0)) size = edge.table[size - 1]
          offer(to - size, to, edge)
        }
      }
    }
    found.sort((x, y) => x[0] - y[0] || y[1] - x[1])
    const merged = []
    for (const [start, end, label] of found) {
      const last = merged.at(-1)
      if (last && start < last[1]) {
        // A region inside another adds nothing; one running past it adds its label.
        if (end > last[1]) {
          last[1] = end
          if (!last[2].includes(label)) last[2].push(label)
        }
      } else merged.push([start, end, [label]])
    }
    return merged
  }
  // Edges count only in text known to be cut: a rendered DSH result carries its notice,
  // and `cut` serves a stream's `{ text, truncated: true }` (see redactDeep).
  const apply = (text, cut) => {
    if (typeof text !== 'string') return text
    const found = regions(text, Boolean(anchorPattern) && (cut || text.includes(TRUNCATED)))
    if (found.length === 0) return text
    const chunks = []
    let cursor = 0
    for (const [start, end, names] of found) {
      chunks.push(text.slice(cursor, start), names.join(''))
      cursor = end
    }
    chunks.push(text.slice(cursor))
    return chunks.join('')
  }
  const redact = text => apply(text, false)
  redact.cut = text => apply(text, true)
  return redact
}

// Maps/sets (including weak), dates, regexps, buffers/views, promises, boxed
// primitives, WeakRefs and functions are opaque, including their subclasses.
const opaquePrototypes = new Set([
  Map, Set, WeakMap, WeakSet, Date, RegExp, ArrayBuffer, SharedArrayBuffer,
  Promise, String, Number, Boolean, BigInt, Symbol, WeakRef, DataView,
].map(type => type.prototype))
opaquePrototypes.add(Object.getPrototypeOf(Uint8Array.prototype))
const opaqueObject = value => types.isMap(value) || types.isSet(value) || types.isWeakMap(value)
  || types.isWeakSet(value) || types.isDate(value) || types.isRegExp(value)
  || types.isAnyArrayBuffer(value) || types.isArrayBufferView(value)
  || types.isPromise(value) || types.isBoxedPrimitive(value)
const errorFields = new Set(['message', 'stack', 'cause', 'errors'])
const FAST = Object.freeze({ enumerable: true })
const REDACTION_FAILED = '[redacted: redaction failed]'
const arrayIndex = /^(0|[1-9][0-9]{0,9})$/
const isIndex = key => arrayIndex.test(key) && Number(key) < 0xffffffff

// Returns the same reference when nothing changed, so callers can tell cheaply.
export function redactDeep(value, redact) {
  // A redactor that fails must not hand the text back: it may hold a secret.
  const replace = (text, cut = false) => {
    try {
      const result = cut && typeof redact.cut === 'function' ? redact.cut(text) : redact(text)
      return typeof result === 'string' ? result : REDACTION_FAILED
    } catch { return REDACTION_FAILED }
  }
  if (typeof value === 'string') return replace(value)
  const records = new Map()
  const pending = []
  const visit = node => {
    if (node === null || typeof node !== 'object') return null
    if (records.has(node)) return records.get(node)
    const record = { node, parents: [], props: [], dirty: false }
    records.set(node, record)
    pending.push(record)
    return record
  }
  const root = visit(value)
  if (!root) return value
  for (let i = 0; i < pending.length; i++) {
    const record = pending[i]
    const node = record.node
    let props
    try {
      record.proto = Object.getPrototypeOf(node)
      // A native Error stays an Error whatever its prototype was set to.
      record.error = types.isNativeError(node)
      // A native Map, Date... stays opaque even with a null prototype. Plain objects
      // (most of every payload) skip the check.
      if (!record.error && record.proto !== Object.prototype && !Array.isArray(node) && opaqueObject(node)) continue
      if (record.proto !== Object.prototype && record.proto !== Array.prototype && record.proto !== null) {
        const seen = new Set()
        for (let proto = record.proto; proto !== null; proto = Object.getPrototypeOf(proto)) {
          if (opaquePrototypes.has(proto) || seen.has(proto)) throw new TypeError('opaque prototype')
          seen.add(proto)
          if (proto === Error.prototype) record.error = true
        }
      }
      record.array = Array.isArray(node)
      // Plain data (not a Proxy) is read like JSON: own enumerable keys and their
      // values. Full descriptors are taken only for a node that gets copied.
      if (!record.error && !types.isProxy(node) && (record.proto === Object.prototype || record.proto === Array.prototype || record.proto === null)) {
        record.fast = true
        // Arrays serialize every index, enumerable or not.
        const names = record.array
          ? Object.getOwnPropertyNames(node).filter(key => key !== 'length' && (isIndex(key) || Object.prototype.propertyIsEnumerable.call(node, key)))
          : Object.keys(node)
        props = names.map(key => ({ key, descriptor: FAST }))
      } else props = Reflect.ownKeys(node).map(key => ({ key, descriptor: Object.getOwnPropertyDescriptor(node, key) }))
      // A proxy may remove a key between ownKeys and descriptor inspection.
      props = props.filter(prop => prop.descriptor)
      if (record.array && !record.fast) {
        record.length = props.find(prop => prop.key === 'length').descriptor
        if (!Number.isInteger(record.length.value) || record.length.value < 0 || record.length.value > 0xffffffff) continue
      }
    } catch { continue }
    record.props = props
    // A DSH output stream `{ text, truncated: true }` was cut, so its text edges count.
    let cut = false
    try { cut = props.some(prop => prop.key === 'truncated') && node.truncated === true } catch {}
    for (const prop of props) {
      const { key, descriptor } = prop
      prop.nextKey = key
      if (typeof key !== 'string' || !(descriptor.enumerable || record.error && errorFields.has(key) || record.array && isIndex(key))) continue
      // Array indices stay: renaming one would drop the element.
      prop.nextKey = record.array && isIndex(key) ? key : replace(key)
      if (prop.nextKey !== key) record.dirty = true
      let item
      try { item = descriptor === FAST ? node[key] : 'value' in descriptor ? descriptor.value : descriptor.get ? Reflect.apply(descriptor.get, node, []) : undefined } catch { continue }
      prop.read = true
      prop.value = typeof item === 'string' ? replace(item, cut && key === 'text') : item
      if (typeof item === 'string' && prop.value !== item) record.dirty = true
      prop.child = visit(item)
      if (prop.child) prop.child.parents.push(record)
    }
  }
  // Propagate through reverse edges before allocating: cycles copy as a unit.
  const dirty = pending.filter(record => record.dirty)
  for (let i = 0; i < dirty.length; i++) {
    for (const parent of dirty[i].parents) {
      if (parent.dirty) continue
      parent.dirty = true
      dirty.push(parent)
    }
  }
  if (!root.dirty) return value
  for (const record of dirty) {
    if (!record.fast) continue
    const node = record.node
    const walked = new Map(record.props.map(prop => [prop.key, prop]))
    record.props = Reflect.ownKeys(node).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      let prop = walked.get(key)
      if (!prop) {
        prop = { key, nextKey: key }
        // A key that appeared after the walk (a getter that caches) is redacted on its own.
        if (typeof key === 'string' && descriptor && 'value' in descriptor && (descriptor.enumerable || record.array && isIndex(key))) {
          prop.nextKey = record.array && isIndex(key) ? key : replace(key)
          prop.read = true
          prop.value = typeof descriptor.value === 'string' ? replace(descriptor.value) : redactDeep(descriptor.value, redact)
        }
      }
      prop.descriptor = descriptor
      return prop
    })
    if (record.array) record.length = Object.getOwnPropertyDescriptor(node, 'length')
  }
  for (const record of dirty) {
    if (record.array) {
      record.copy = new Array(record.length.value)
      // An Array subclass keeps its prototype (and so its methods).
      if (record.proto !== Array.prototype) Object.setPrototypeOf(record.copy, record.proto)
    }
    else if (record.error) {
      record.copy = new Error()
      for (const key of Reflect.ownKeys(record.copy)) Reflect.deleteProperty(record.copy, key)
      Object.setPrototypeOf(record.copy, record.proto)
    } else record.copy = Object.create(record.proto)
  }
  for (const record of dirty) {
    const used = new Set(record.array ? ['length'] : [])
    for (const prop of record.props) {
      if (record.array && prop.key === 'length') continue
      let key = prop.nextKey
      if (typeof key === 'string') {
        let suffix = 2
        const outside = record.array && /^(0|[1-9][0-9]*)$/.test(key)
          && Number(key) < 0xffffffff && Number(key) >= record.length.value
        if (outside) key = `${prop.nextKey}#${suffix++}`
        while (used.has(key)) key = `${prop.nextKey}#${suffix++}`
      }
      used.add(key)
      let descriptor = prop.descriptor
      if (prop.read) descriptor = {
        value: prop.child?.dirty ? prop.child.copy : prop.value,
        enumerable: descriptor.enumerable, configurable: descriptor.configurable,
        writable: 'writable' in descriptor ? descriptor.writable : true,
      }
      Object.defineProperty(record.copy, key, descriptor)
    }
    if (record.array) Object.defineProperty(record.copy, 'length', record.length)
  }
  return root.copy
}

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'secrets.json')

  /** @type {Map<string, {name:string, value:string, purpose:string, scope:'all'|string[], requestedBy:string|null, createdAt:number, updatedAt:number, lastUsedAt?:number}>} */
  const secrets = new Map()
  let loaded = null
  let writing = Promise.resolve()
  let redact = text => text
  let redactAnywhere = text => text
  let refreshEnv = () => {}
  let stopped = false

  const changed = () => {
    const entries = [...secrets.values()]
    redact = redactor(entries)
    redactAnywhere = redactor(entries, { wholeWords: false })
    refreshEnv()
    rt.secretsChanged?.()
  }

  // Error messages from JSON.parse quote the file, so only the code or name is logged.
  const reason = error => error?.code ?? error?.name ?? 'error'

  // While another dsh holds the team, that host writes secrets.json, so a reading host
  // reads it again each time; a copy read then is also read again after taking over,
  // before this host saves anything.
  let loadedReadOnly = false
  // An existing secrets file that cannot be read is not an empty one: writing over it
  // would lose every key in it. While `blocked` holds the reason nothing is written,
  // and each load reads the file again (a busy file may only be briefly unreadable).
  let blocked
  // A reading host reloads on every request, so a held value is reported once per change,
  // not once per read.
  let heldWarned = ''
  const loadSecrets = () => {
    if (loaded !== null && (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined)) loaded = null
    return loaded ??= readSecrets()
  }
  // Shell environments resolve synchronously, so loading must fill the map and
  // register its variables before the first shell call after startup.
  const readSecrets = async () => {
    loadedReadOnly = rt.readOnly() !== undefined
    let contents
    try {
      contents = readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        blocked = undefined
        secrets.clear()
        heldWarned = ''
      } else {
        blocked = reason(error)
        rt.warn('ds-bot: unreadable secrets file %s (%s)', path, blocked)
      }
      changed()
      return
    }
    let parsed
    try {
      parsed = JSON.parse(contents)
    } catch {
      parsed = null
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.secrets)) {
      // A file that is not a secrets file is kept aside, like a broken state.json, then
      // the store goes on with an empty one.
      const backup = `${path}.broken-${Date.now()}`
      try {
        copyFileSync(path, backup)
        blocked = undefined
        secrets.clear()
        heldWarned = ''
        rt.warn('ds-bot: unreadable secrets file %s; backed up as %s', path, backup)
      } catch (error) {
        blocked = reason(error)
        rt.warn('ds-bot: unreadable secrets file %s; backup failed: %s', path, error)
      }
      changed()
      return
    }
    blocked = undefined
    secrets.clear()
    const heldNames = []
    for (const entry of parsed.secrets) {
      if (!SECRET_NAME.test(entry?.name ?? '') || typeof entry.value !== 'string') continue
      // Named, not silently dropped: the entry stays in the map (and the file) but is used
      // nowhere until a value of at least MIN_VALUE characters is saved.
      if (held(entry)) heldNames.push(entry.name)
      secrets.set(entry.name, {
        name: entry.name,
        value: entry.value,
        purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
        scope: entry.scope === 'all' ? 'all' : Array.isArray(entry.scope) ? entry.scope.filter(id => typeof id === 'string') : 'all',
        requestedBy: typeof entry.requestedBy === 'string' ? entry.requestedBy : null,
        createdAt: Number(entry.createdAt) || Date.now(),
        updatedAt: Number(entry.updatedAt) || Date.now(),
        ...(Number.isFinite(entry.lastUsedAt) ? { lastUsedAt: entry.lastUsedAt } : {}),
      })
    }
    if (!loadedReadOnly) try { chmodSync(path, 0o600) } catch {}
    const heldNotice = heldNames.join(',')
    if (heldNotice !== heldWarned) {
      heldWarned = heldNotice
      for (const name of heldNames) rt.warn('ds-bot: secret %s in %s is held: its saved value is shorter than the %d-character minimum; nothing uses it until a longer value is saved', name, path, MIN_VALUE)
    }
    changed()
  }

  // Resolves once secrets.json holds the current map; rejects when the write failed.
  const persist = () => {
    if (blocked !== undefined) return Promise.reject(refusal(`The secrets file could not be read (${blocked}). Omni does not change it; fix or move it and reload.`))
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) return Promise.reject(refusal(readOnly))
    const snapshot = JSON.stringify({ version: 1, secrets: [...secrets.values()] }, null, 2)
    const job = writing.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await chmod(temp, 0o600)
        await replaceFile(temp, path)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = job.catch(error => rt.warn('ds-bot: secrets write failed (%s)', reason(error)))
    return job
  }

  let usedTimer = null
  const noteUsed = () => {
    if (usedTimer !== null) return
    usedTimer = setTimeout(() => {
      usedTimer = null
      if (loadedReadOnly || rt.readOnly() !== undefined || blocked !== undefined) return
      void persist().then(() => rt.save()).catch(() => {})
    }, USED_SAVE_MS)
    usedTimer.unref?.()
  }

  // A Bot's pending secret cards, keyed by its id. A key that is not a real Bot (and
  // never an inherited name like "__proto__", which a plain assignment would not even
  // set as a key) gets a throwaway list instead of a stored one.
  const requestsOf = (botId) => {
    const requests = (state.secretRequests ??= {})
    if (!Object.hasOwn(requests, botId) && rt.botOf(botId) === undefined) return []
    return (requests[botId] ??= [])
  }
  const findRequest = (id) => {
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      const request = list.find(entry => entry.id === id)
      if (request !== undefined) return { botId, request }
    }
    return undefined
  }
  const trimRequests = (list) => {
    while (list.length > MAX_REQUESTS) {
      const settled = list.findIndex(entry => entry.status !== 'pending')
      list.splice(settled === -1 ? 0 : settled, 1)
    }
  }

  const scopeText = (scope) => {
    if (scope === 'all') return 'every Bot'
    const names = scope.map(id => rt.botOf(id)?.name).filter(Boolean)
    return names.length === 0 ? 'no Bot' : names.join(', ')
  }
  const usage = name => `$${envName(name)} in bash, or $env:${envName(name)} in PowerShell`

  async function tell(botId, text) {
    if (rt.botOf(botId) === undefined) return
    await rt.deliver({ toId: botId, role: 'secret', text })
      .catch(error => rt.warn('ds-bot: secret note to %s failed: %s', botId, error))
  }
  const savedNote = (name, lead) => [
    `${lead} Use it as ${usage(name)}.`,
    'You cannot see the value. Never print, echo, or log it, and never ask the user to paste it into the chat. Carry on with what you needed it for.',
  ].join(' ')

  function settle(botId, request, status) {
    request.status = status
    request.settledAt = Date.now()
    if (status === 'saved' || status === 'allowed') request.scope = secrets.get(request.name)?.scope ?? 'all'
  }

  // After any change to `name`, every pending card for it either resolves (its Bot can
  // use the key now) or shows the form that still applies.
  function reconcile(name, notes, except) {
    const secret = secrets.get(name)
    for (const [botId, list] of Object.entries(state.secretRequests ?? {})) {
      for (const request of list) {
        if (request.status !== 'pending' || request.name !== name || request === except) continue
        if (canUse(secret, botId) && !held(secret)) {
          settle(botId, request, 'saved')
          notes.push([botId, savedNote(name, `The user saved ${name}, and you may use it now.`)])
        } else {
          request.kind = secret ? 'allow' : 'fill'
        }
      }
    }
  }

  async function commit(notes) {
    changed()
    await persist()
    await rt.save()
    for (const [botId, text] of notes) await tell(botId, text)
  }

  const cleanValue = (raw) => {
    if (typeof raw !== 'string') throw refusal('Type the key first')
    const value = raw.trim()
    if (value.length < MIN_VALUE) throw refusal(`A key must have at least ${MIN_VALUE} characters`)
    if (value.length > MAX_VALUE) throw refusal(`A key can have at most ${MAX_VALUE} characters`)
    return value
  }
  const cleanScope = (raw) => {
    if (raw === 'all') return 'all'
    if (!Array.isArray(raw)) throw refusal('Choose every Bot or a list of Bots')
    return [...new Set(raw.filter(id => typeof id === 'string' && rt.botOf(id) !== undefined))]
  }
  const pendingRequest = (id) => {
    const found = findRequest(String(id ?? ''))
    if (found === undefined) throw refusal('This request is gone')
    if (found.request.status !== 'pending') throw refusal('This request was already answered')
    return found
  }

  const secretView = secret => ({
    name: secret.name,
    purpose: secret.purpose,
    scope: secret.scope,
    requestedBy: secret.requestedBy,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    ...(secret.lastUsedAt !== undefined ? { lastUsedAt: secret.lastUsedAt } : {}),
    ...(held(secret) ? { held: true } : {}),
  })
  const secretsView = () => [...secrets.values()].sort((a, b) => a.name.localeCompare(b.name)).map(secretView)

  const endpoints = {
    // From a card (requestId) or from the settings page (name).
    async 'secret-set'(body) {
      const value = cleanValue(body.value)
      const now = Date.now()
      const notes = []
      if (body.requestId !== undefined) {
        const { botId, request } = pendingRequest(body.requestId)
        const existing = secrets.get(request.name)
        let scope
        if (existing === undefined || request.kind === 'fill') scope = body.scope === 'bot' ? [botId] : 'all'
        else scope = existing.scope === 'all' ? 'all' : [...new Set([...existing.scope, botId])]
        secrets.set(request.name, {
          name: request.name,
          value,
          purpose: existing?.purpose || request.purpose,
          scope,
          requestedBy: existing?.requestedBy ?? botId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
        })
        settle(botId, request, 'saved')
        notes.push([botId, savedNote(request.name, `The user saved ${request.name} for ${scopeText(scope)}.`)])
        reconcile(request.name, notes, request)
        await commit(notes)
        return secretView(secrets.get(request.name))
      }
      const name = normalizeName(body.name)
      if (!SECRET_NAME.test(name)) throw refusal('A name uses capitals, digits, and underscores, and starts with a letter')
      const existing = secrets.get(name)
      secrets.set(name, {
        name,
        value,
        purpose: typeof body.purpose === 'string' && body.purpose.trim() !== '' ? body.purpose.trim().slice(0, 300) : existing?.purpose ?? '',
        scope: body.scope !== undefined ? cleanScope(body.scope) : existing?.scope ?? 'all',
        requestedBy: existing?.requestedBy ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
      })
      reconcile(name, notes)
      await commit(notes)
      return secretView(secrets.get(name))
    },
    async 'secret-allow'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      const secret = secrets.get(request.name)
      if (secret === undefined) throw refusal(`${request.name} is not saved yet`)
      if (held(secret)) throw refusal(heldReason(request.name))
      if (!canUse(secret, botId)) secret.scope = [...new Set([...secret.scope, botId])]
      secret.updatedAt = Date.now()
      settle(botId, request, 'allowed')
      const notes = [[botId, savedNote(request.name, `The user let you use ${request.name}.`)]]
      reconcile(request.name, notes, request)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-cancel'(body) {
      const { botId, request } = pendingRequest(body.requestId)
      settle(botId, request, 'canceled')
      await rt.save()
      await tell(botId, `The user canceled your request for ${request.name}. Do not ask for it again unless the user brings it up; carry on without it, or tell the user what you cannot do without it.`)
      return true
    },
    async 'secret-update'(body) {
      const secret = secrets.get(normalizeName(body.name))
      if (secret === undefined) throw refusal('No such key')
      if (body.scope !== undefined) secret.scope = cleanScope(body.scope)
      if (typeof body.purpose === 'string') secret.purpose = body.purpose.trim().slice(0, 300)
      secret.updatedAt = Date.now()
      const notes = []
      reconcile(secret.name, notes)
      await commit(notes)
      return secretView(secret)
    },
    async 'secret-delete'(body) {
      const name = normalizeName(body.name)
      if (!secrets.delete(name)) throw refusal('No such key')
      const notes = []
      reconcile(name, notes)
      await commit(notes)
      return true
    },
  }

  async function secretEndpoint(endpoint, body) {
    await loadSecrets()
    return endpoints[endpoint](body ?? {})
  }

  // Internal cleanup only: the comparison and existing endpoint's map.delete run
  // in one synchronous segment after loading, so a newer value cannot be deleted
  // across secretEndpoint's load await. The existing commit owns durable writes.
  async function deleteSecretIfUnchanged(name, expectedValue) {
    if (stopped || typeof name !== 'string' || !SECRET_NAME.test(name) || typeof expectedValue !== 'string') return false
    try {
      await loadSecrets()
      if (stopped || blocked !== undefined || loadedReadOnly || rt.readOnly() !== undefined) return false
    } catch { return false }
    if (secrets.get(name)?.value !== expectedValue) return false
    return endpoints['secret-delete']({ name })
  }

  // A deleted Bot leaves every list it was on, and its cards go with it.
  async function forgetBotSecrets(botId) {
    await loadSecrets()
    if (state.secretRequests !== undefined) delete state.secretRequests[botId]
    let touched = false
    for (const secret of secrets.values()) {
      if (Array.isArray(secret.scope) && secret.scope.includes(botId)) {
        secret.scope = secret.scope.filter(id => id !== botId)
        touched = true
      }
    }
    if (touched) {
      changed()
      await persist().catch(() => {})
    }
  }

  // What the card asks GitHub for, so the Bot words the same ask and never a broader one.
  const githubAsk = work => work.length === 0 ? ''
    : ` It shows the steps to make a fine-grained GitHub token with ${githubPermissions(work).map(entry => `${entry.label}: ${entry.access}`).join(', ')}, for ${GITHUB_TOKEN_DAYS} days. Do not ask for other permissions.`

  const callerOf = exec => rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id)

  ctx.tools.register(defineTool({
    name: 'request_secret',
    description: 'Ask the user for a key, token, or password through a secure card in your own chat. The user types it into the card; you never see the value. It reaches your shell as an environment variable. When the key is already saved for you, this only tells you its variable. Showing a card ends your turn; a note arrives when the user saves or cancels.',
    parameters: {
      name: { type: 'string', required: true, description: 'Key name in capitals, digits, and underscores, e.g. GITHUB_TOKEN' },
      purpose: { type: 'string', required: true, description: 'One short line for the user: what you need it for. For GitHub, leave the permissions out: the card lists them' },
      github: { type: 'array', items: { type: 'string', enum: Object.keys(GITHUB_WORK) }, description: 'For a GitHub token (GITHUB_TOKEN, GH_TOKEN), required: the work you will do with it. edit_code to push commits, open_prs to open or update pull requests, read_code, read_prs, read_issues, edit_issues. The card shows the user how to make a fine-grained token with only the permissions this work needs' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      await loadSecrets()
      const id = exec.agent?.id
      const bot = rt.botOf(callerOf(exec))
      if (bot === undefined) return 'Only Bots on the team can use request_secret.'
      const name = normalizeName(args.name)
      if (!SECRET_NAME.test(name)) return 'Name the key with capitals, digits, and underscores, starting with a letter (for example GITHUB_TOKEN).'
      const { work, unknown } = cleanGitHubWork(args.github)
      if (unknown.length > 0) return `Unknown GitHub work: ${unknown.join(', ')}. Pass github with ${Object.keys(GITHUB_WORK).join(', ')}.`
      const stored = secrets.get(name)
      // A held entry is invisible to a Bot: asking again shows the fill card, so the user
      // can replace the unredactable value.
      const secret = held(stored) ? undefined : stored
      if (canUse(secret, bot.id)) return `${name} is already saved and you may use it: ${usage(name)}. You cannot see the value; never print it.`
      // A new GitHub token is made for declared work only (#316), so the card never asks for a
      // broader one; a saved key is only allowed or replaced.
      if (secret === undefined && work.length === 0 && isGitHubTokenName(name)) return `Say what you will do with ${name}: pass github with ${Object.keys(GITHUB_WORK).join(', ')} (edit_code and open_prs to push commits and open pull requests). The card then asks for only the permissions that work needs.`
      if (rt.groupOwners.has(id)) return 'Secret cards only work in your own chat. Tell the group you will ask the user in your own chat, and call request_secret there.'
      if (!rt.chatOwners.has(id)) return 'Secret cards only work in your current own chat.'
      const readOnly = rt.readOnly()
      if (readOnly !== undefined) return `No card can be shown now. ${readOnly}`
      const list = requestsOf(bot.id)
      const now = Date.now()
      for (const request of list) {
        if (request.status === 'pending' && request.name === name) {
          request.status = 'canceled'
          request.settledAt = now
        }
      }
      list.push({
        id: randomUUID(),
        ...(exec.callId ? { callId: exec.callId } : {}),
        sessionId: id,
        name,
        purpose: String(args.purpose ?? '').trim().slice(0, 300),
        kind: secret ? 'allow' : 'fill',
        ...(work.length > 0 ? { github: work } : {}),
        status: 'pending',
        askedAt: now,
      })
      trimRequests(list)
      await rt.save()
      exec.concludeTurn?.()
      return secret
        ? `The card asking the user to let you use ${name} is on screen. A note arrives when the user answers; you will not see the value.`
        : `The card asking the user for ${name} is on screen.${githubAsk(work)} A note arrives when the user saves or cancels; you will not see the value.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_secrets',
    description: 'List the keys the user saved for the team: name, purpose, which Bots may use them, and whether you may. Values are never shown.',
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      await loadSecrets()
      const self = callerOf(exec)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can use list_secrets.'
      if (secrets.size === 0) return 'No keys are saved yet. Ask for one with request_secret.'
      return [
        'Saved keys (values are never shown):',
        ...secretsView().map((secret) => {
          const stored = secrets.get(secret.name)
          const use = held(stored)
            ? `held: its saved value is shorter than ${MIN_VALUE} characters, so nothing uses it; save a new value`
            : canUse(stored, self) ? `you may use it as $${envName(secret.name)}` : 'you may not use it; ask with request_secret'
          return `- ${secret.name}${secret.purpose ? ` — ${secret.purpose}` : ''} — for ${scopeText(secret.scope)} — ${use}`
        }),
      ].join('\n')
    },
  }))

  // Keep the whole result for wrappers that read content before the registry
  // re-renders it. Auxiliary fields must lose secrets before they can be saved too.
  ctx.on('tools/execute', async (exec, next) => {
    const result = await next()
    if (secrets.size === 0 || result === null || typeof result !== 'object') return result
    return redactDeep(result, redact)
  })

  // Anything that still carries a value (the user pasted it, an earlier part kept it)
  // is replaced before the request leaves. `next` cannot take new options, so the
  // request starts over; it then carries no value and passes through here.
  // A value that is part of its own label would be replaced again on every pass, so a
  // request this listener rewrote passes straight through.
  const rewritten = new WeakSet()
  ctx.on('llm/stream', (options, next) => {
    if (secrets.size === 0 || rewritten.has(options.messages)) return next()
    const messages = redactDeep(options.messages, redact)
    const system = redactDeep(options.system, redact)
    if (messages === options.messages && system === options.system) return next()
    const fresh = [...(messages ?? [])]
    rewritten.add(fresh)
    rt.carryUsageTag(options.messages, fresh)
    return ctx.llm.stream({ ...options, messages: fresh, ...(system !== undefined ? { system } : {}) })
  })

  function resolveEnv(execution) {
    const botId = rt.selfOf(execution?.agent?.session?.header?.id ?? execution?.agent?.id)
    if (rt.botOf(botId) === undefined) return {}
    const command = typeof execution.arguments?.command === 'string' ? execution.arguments.command : ''
    const values = {}
    let used = false
    for (const secret of secrets.values()) {
      if (held(secret) || !canUse(secret, botId)) continue
      values[envName(secret.name)] = secret.value
      if (command.includes(envName(secret.name))) {
        secret.lastUsedAt = Date.now()
        used = true
      }
    }
    if (used) noteUsed()
    return values
  }

  // Keys must be declared up front, so the contribution is registered again whenever
  // the set of names (or a purpose, which describes the key) changes.
  function attachShellEnv(sub) {
    let unregister = null
    let declared = ''
    refreshEnv = () => {
      const list = [...secrets.values()].filter(secret => !held(secret)).sort((a, b) => a.name.localeCompare(b.name))
      const key = list.map(secret => `${secret.name}\u0000${secret.purpose}`).join('\n')
      if (key === declared) return
      unregister?.()
      unregister = null
      declared = key
      if (list.length === 0) return
      try {
        unregister = sub.shellEnv.register({
          name: 'ds-bot-secrets',
          variables: Object.fromEntries(list.map(secret => [envName(secret.name), { description: `Omni secret ${secret.name}${secret.purpose ? `: ${secret.purpose}` : ''}` }])),
          resolve: resolveEnv,
        })
      } catch (error) {
        declared = ''
        rt.warn('ds-bot: secrets not offered to the shell: %s', error?.message ?? error)
      }
    }
    refreshEnv()
    sub.effect(() => () => {
      unregister?.()
      unregister = null
      declared = ''
      refreshEnv = () => {}
    }, 'ds-bot: secrets shell env')
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['shellEnv'], sub => attachShellEnv(sub))
  } else if (ctx.get?.('shellEnv') !== undefined) {
    attachShellEnv({ shellEnv: ctx.get('shellEnv'), effect: (execute, label) => ctx.effect(execute, label) })
  }

  ctx.effect(() => {
    void loadSecrets()
    return () => { stopped = true; if (usedTimer !== null) clearTimeout(usedTimer) }
  }, 'ds-bot: load secrets')

  Object.assign(rt, {
    secretsView,
    secretValue: name => (held(secrets.get(name)) ? undefined : secrets.get(name)?.value),
    canUseSecret: (name, botId) => !held(secrets.get(name)) && canUse(secrets.get(name), botId),
    secretHeldReason: name => (held(secrets.get(name)) ? heldReason(name) : undefined),
    secretEndpoint,
    deleteSecretIfUnchanged,
    forgetBotSecrets,
    loadSecrets,
    redactSecrets: text => redact(text),
    redactSecretsAnywhere: text => redactAnywhere(text),
  })
}
