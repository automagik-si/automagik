import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// #845: on macOS dsh's page fills the window, so the sidebar's top row and the chat
// header are the title bar. The desktop shell writes data-automagik-desktop=darwin on
// <html>, and the sidebar must keep the row's empty space draggable while every control
// in it takes clicks. This file checks that split on its own: it reads SIDEBAR_CSS, parses
// the rules, and resolves the cascade against a small DOM. The list is the shell top
// bar's #878 rule (apps/desktop/src/shell.css on fix/845-topbar-draggable). Base dev still
// ships the pre-#878 shell list, so the canonical copy lives here; keep it in step with
// the shell rule rather than with any narrowing in the sidebar.

const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
const css = extractSidebarCss(source)
const rules = parseRules(stripComments(css))
const APP_REGION = new Set(['-webkit-app-region', 'app-region'])

// The interactive kinds in the shell bar's no-drag list. The shell rule also names its
// own `.brand` and `.controls` surfaces. The sidebar's `.bt-brand` is compared separately.
const SHELL_NO_DRAG = [
  'a', 'button', 'input', 'label', 'select', 'summary', 'textarea', '[contenteditable]',
  '[role=button]', '[role=checkbox]', '[role=link]', '[role=menu]', '[role=menubar]',
  '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=option]',
  '[role=radio]', '[role=slider]', '[role=switch]', '[role=tab]', '[aria-haspopup]',
  '[tabindex]', '[data-menu]',
]
const TOP_SURFACES = ['.bt-brand']
const ROLES = [
  'button', 'checkbox', 'link', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'slider', 'switch', 'tab',
]
const KINDS = [
  { label: 'link', tag: 'a', attrs: { href: '#' }, selector: 'a' },
  { label: 'button', tag: 'button', attrs: { type: 'button' }, selector: 'button' },
  { label: 'input', tag: 'input', attrs: { type: 'text' }, selector: 'input' },
  { label: 'label', tag: 'label', attrs: {}, selector: 'label' },
  { label: 'select', tag: 'select', attrs: {}, selector: 'select' },
  { label: 'summary', tag: 'summary', attrs: {}, selector: 'summary' },
  { label: 'textarea', tag: 'textarea', attrs: {}, selector: 'textarea' },
  {
    label: 'contenteditable', tag: 'div', attrs: { contenteditable: 'true' },
    selector: '[contenteditable]',
  },
  ...ROLES.map(role => ({
    label: `role=${role}`, tag: 'div', attrs: { role }, selector: `[role=${role}]`,
  })),
  {
    label: 'aria-haspopup', tag: 'div', attrs: { 'aria-haspopup': 'menu' },
    selector: '[aria-haspopup]',
  },
  { label: 'tabindex', tag: 'div', attrs: { tabindex: '0' }, selector: '[tabindex]' },
  { label: 'data-menu', tag: 'div', attrs: { 'data-menu': 'sidebar' }, selector: '[data-menu]' },
]

// `-webkit-app-region` is not inherited. A drag container covers the descendants in its
// rectangle, so a control opts out only when a no-drag rule matches the control itself; a
// no-drag wrapper cannot shelter a control the container rule never named. That is why the
// rules are descendant selectors, not a `*` exception on the container's direct children.
function effectiveRegion(element) {
  const own = declaredRegion(element)
  if (own) return regionValue(own)
  for (let node = element.parent; node; node = node.parent) {
    const ancestor = declaredRegion(node)
    if (ancestor && regionValue(ancestor) === 'drag') return 'drag'
  }
  return undefined
}

// The winning app-region declaration that matches this element itself.
function declaredRegion(element) {
  let winner = null
  rules.forEach((rule, order) => {
    const declaration = appRegionDeclaration(rule)
    if (!declaration) return
    for (const selector of parseSelectorList(rule.prelude)) {
      if (!matchesComplex(element, selector)) continue
      const candidate = {
        value: declaration.value,
        important: declaration.important,
        specificity: specificityOf(selector),
        order,
        selector,
        rule,
      }
      if (!winner || beats(candidate, winner)) winner = candidate
    }
  })
  return winner
}

function beats(candidate, winner) {
  if (candidate.important !== winner.important) return candidate.important
  for (let index = 0; index < 3; index += 1) {
    if (candidate.specificity[index] !== winner.specificity[index]) {
      return candidate.specificity[index] > winner.specificity[index]
    }
  }
  return candidate.order >= winner.order
}

function regionValue(declaration) {
  assert.ok(
    declaration.value === 'drag' || declaration.value === 'no-drag',
    `app-region value is drag or no-drag: ${declaration.value}`,
  )
  return declaration.value
}

function appRegionDeclaration(rule) {
  return rule.declarations.find(declaration => APP_REGION.has(declaration.property))
}

// The no-drag rule that names a container's controls with :is(...), and its argument list.
function noDragListFor(container) {
  for (const rule of rules) {
    if (rule.ancestors.length) continue
    const declaration = appRegionDeclaration(rule)
    if (!declaration || regionValue(declaration) !== 'no-drag') continue
    for (const selector of parseSelectorList(rule.prelude)) {
      const last = selector.parts[selector.parts.length - 1]
      const target = selector.parts[selector.parts.length - 2]
      if (!last || !target || !containerMatches(target, container)) continue
      const pseudo = last.pseudos.find(entry => entry.name === 'is' || entry.name === 'where')
      if (!pseudo) continue
      return {
        rule,
        selector,
        args: pseudo.args.map(argument => normalizeSelector(argument.raw)),
      }
    }
  }
  return null
}

function containerMatches(compound, container) {
  if (container === 'top') return compound.classes.includes('bt-side-top')
  return compound.tag === 'header' && compound.attributes.some(attribute =>
    attribute.name === 'class' && attribute.operator === '*=' && attribute.value === '_header')
}

function assertDarwinGated(selector) {
  const gate = selector.parts[0]
  assert.equal(gate?.tag, 'html', `the selector starts at <html>: ${selector.text}`)
  const desktop = gate.attributes.find(attribute =>
    attribute.name === 'data-automagik-desktop')
  assert.ok(desktop, `the selector names the desktop platform: ${selector.text}`)
  assert.equal(desktop.operator, '=', `the platform attribute is exact: ${selector.text}`)
  assert.equal(desktop.value, 'darwin', `the selector is darwin-scoped: ${selector.text}`)
}

function normalizeSelector(selector) {
  return selector
    .replace(/\s+/g, '')
    .replace(/\[([\w-]+)=["']([^"']*)["']\]/g, '[$1=$2]')
}

// --- stylesheet reader ---------------------------------------------------------

function extractSidebarCss(text) {
  const marker = 'export const SIDEBAR_CSS = `'
  const at = text.indexOf(marker)
  assert.ok(at >= 0, 'sidebar.js exports SIDEBAR_CSS')
  let output = ''
  let index = at + marker.length
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      output += text.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '`') return output
    if (char === '$' && text[index + 1] === '{') {
      index = skipInterpolation(text, index)
      output += '0ms'
      continue
    }
    output += char
    index += 1
  }
  assert.fail('SIDEBAR_CSS template literal closes')
}

function skipInterpolation(text, at) {
  let depth = 0
  let quote = ''
  for (let index = at + 1; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return index + 1
  }
  assert.fail('a SIDEBAR_CSS interpolation closes')
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseRules(text, from = 0, to = text.length, ancestors = []) {
  const found = []
  let index = from
  while (index < to) {
    const open = findOpenBrace(text, index, to)
    if (open < 0) break
    const close = matchingBrace(text, open, to)
    assert.ok(close > open, `a CSS block closes near: ${text.slice(index, open).trim()}`)
    const prelude = text.slice(index, open).trim()
    const body = text.slice(open + 1, close)
    if (prelude.startsWith('@')) {
      found.push(...parseRules(body, 0, body.length, [...ancestors, prelude]))
    } else if (prelude) {
      found.push({ prelude, declarations: parseDeclarations(body), ancestors })
    }
    index = close + 1
  }
  return found
}

function findOpenBrace(text, from, to) {
  let quote = ''
  for (let index = from; index < to; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{') return index
  }
  return -1
}

function matchingBrace(text, open, to) {
  let depth = 0
  let quote = ''
  for (let index = open; index < to; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '{') depth += 1
    else if (char === '}' && --depth === 0) return index
  }
  return -1
}

function parseDeclarations(body) {
  const declarations = []
  for (const chunk of splitTopLevel(body, ';')) {
    const colon = chunk.indexOf(':')
    if (colon < 0) continue
    let value = chunk.slice(colon + 1).trim()
    let important = false
    if (/!\s*important$/i.test(value)) {
      important = true
      value = value.replace(/!\s*important$/i, '').trim()
    }
    declarations.push({
      property: chunk.slice(0, colon).trim().toLowerCase(),
      value,
      important,
    })
  }
  return declarations
}

// Split on a separator outside (), [] and quotes.
function splitTopLevel(text, separator) {
  const parts = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

// --- selectors -----------------------------------------------------------------

function parseSelectorList(text) {
  return splitTopLevel(text, ',').map(parseComplex)
}

function parseComplex(text) {
  const parts = []
  const combinators = []
  let buffer = ''
  let depth = 0
  let space = false
  const flush = () => {
    if (!buffer) return
    parts.push(parseCompound(buffer))
    buffer = ''
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (depth === 0 && /\s/.test(char)) {
      if (buffer) {
        flush()
        space = true
      }
      continue
    }
    if (depth === 0 && (char === '>' || char === '+' || char === '~')) {
      flush()
      combinators.push(char)
      space = false
      continue
    }
    if (space) {
      if (combinators.length < parts.length) combinators.push(' ')
      space = false
    }
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    buffer += char
  }
  flush()
  assert.equal(combinators.length, parts.length - 1, `the selector parses: ${text}`)
  return { parts, combinators, text }
}

function parseCompound(text) {
  let rest = text.trim()
  assert.ok(rest, 'a selector compound is not empty')
  const compound = {
    tag: null, id: null, classes: [], attributes: [], pseudos: [],
  }
  if (rest[0] === '*') {
    rest = rest.slice(1)
  } else {
    const tag = /^[a-zA-Z][\w-]*/.exec(rest)
    if (tag) {
      compound.tag = tag[0].toLowerCase()
      rest = rest.slice(tag[0].length)
    }
  }
  while (rest) {
    if (rest[0] === '.') {
      const match = /^\.([\w-]+)/.exec(rest)
      assert.ok(match, `a class selector parses: ${rest}`)
      compound.classes.push(match[1])
      rest = rest.slice(match[0].length)
    } else if (rest[0] === '#') {
      const match = /^#([\w-]+)/.exec(rest)
      assert.ok(match, `an id selector parses: ${rest}`)
      compound.id = match[1]
      rest = rest.slice(match[0].length)
    } else if (rest[0] === '[') {
      const close = closingIndex(rest, 0)
      assert.ok(close > 0, `an attribute selector closes: ${rest}`)
      compound.attributes.push(parseAttribute(rest.slice(1, close)))
      rest = rest.slice(close + 1)
    } else if (/^:(is|where|not)\(/.test(rest)) {
      const name = /^:(\w+)\(/.exec(rest)[1]
      const open = rest.indexOf('(')
      const close = closingIndex(rest, open)
      assert.ok(close > 0, `:${name}() closes: ${rest}`)
      const args = splitTopLevel(rest.slice(open + 1, close), ',').map(raw => ({
        raw,
        complex: parseComplex(raw),
      }))
      compound.pseudos.push({ name, args })
      rest = rest.slice(close + 1)
    } else if (rest.startsWith(':root')) {
      compound.pseudos.push({ name: 'root', args: [] })
      rest = rest.slice(':root'.length)
    } else {
      assert.fail(`the selector syntax is supported: ${rest} in ${text}`)
    }
  }
  return compound
}

function closingIndex(text, openIndex) {
  const open = text[openIndex]
  const close = open === '[' ? ']' : ')'
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === open) depth += 1
    else if (char === close && --depth === 0) return index
  }
  return -1
}

function parseAttribute(text) {
  const match = /^([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/
    .exec(text.trim())
  assert.ok(match, `an attribute selector parses: [${text}]`)
  return {
    name: match[1].toLowerCase(),
    operator: match[2] ?? null,
    value: match[3] ?? match[4] ?? match[5] ?? '',
  }
}

function matchesComplex(element, selector) {
  const last = selector.parts[selector.parts.length - 1]
  if (!last || !matchesCompound(element, last)) return false
  let node = element
  for (let index = selector.parts.length - 2; index >= 0; index -= 1) {
    const combinator = selector.combinators[index]
    if (combinator === '>') {
      node = node.parent
      if (!node || !matchesCompound(node, selector.parts[index])) return false
    } else if (combinator === ' ') {
      node = node.parent
      while (node && !matchesCompound(node, selector.parts[index])) node = node.parent
      if (!node) return false
    } else {
      assert.fail(`the combinator is supported: ${combinator} in ${selector.text}`)
    }
  }
  return true
}

function matchesCompound(element, compound) {
  if (compound.tag && compound.tag !== element.tag) return false
  if (compound.id && compound.id !== element.attrs.id) return false
  for (const name of compound.classes) if (!element.classes.has(name)) return false
  for (const attribute of compound.attributes) {
    if (!(attribute.name in element.attrs)) return false
    if (attribute.operator === null) continue
    const actual = String(element.attrs[attribute.name])
    if (attribute.operator === '=' && actual !== attribute.value) return false
    if (attribute.operator === '*=' && !actual.includes(attribute.value)) return false
    if (attribute.operator === '^=' && !actual.startsWith(attribute.value)) return false
    if (attribute.operator === '$=' && !actual.endsWith(attribute.value)) return false
    if (attribute.operator === '~=' && !actual.split(/\s+/).includes(attribute.value)) return false
    if (attribute.operator === '|=' &&
      actual !== attribute.value && !actual.startsWith(`${attribute.value}-`)) return false
  }
  for (const pseudo of compound.pseudos) {
    if (pseudo.name === 'root') {
      if (element.parent) return false
    } else if (pseudo.name === 'is' || pseudo.name === 'where') {
      if (!pseudo.args.some(argument => matchesComplex(element, argument.complex))) return false
    } else if (pseudo.name === 'not') {
      if (pseudo.args.some(argument => matchesComplex(element, argument.complex))) return false
    }
  }
  return true
}

// --- specificity and cascade ---------------------------------------------------

function specificityOf(selector) {
  return selector.parts.reduce((total, part) => add(total, compoundSpecificity(part)),
    [0, 0, 0])
}

function compoundSpecificity(compound) {
  let result = [0, 0, 0]
  if (compound.id) result[0] += 1
  result[1] += compound.classes.length + compound.attributes.length
  if (compound.tag) result[2] += 1
  for (const pseudo of compound.pseudos) {
    if (pseudo.name === 'root') {
      result[1] += 1
    } else if (pseudo.name === 'is' || pseudo.name === 'not') {
      const best = pseudo.args
        .map(argument => specificityOf(argument.complex))
        .reduce((left, right) => (bigger(left, right) >= 0 ? left : right))
      result = add(result, best)
    }
  }
  return result
}

function add(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

function bigger(left, right) {
  return (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2])
}

// --- the small DOM -------------------------------------------------------------

function element(tag, attrs = {}, parent = null) {
  const normalized = {}
  for (const [name, value] of Object.entries(attrs)) {
    normalized[name.toLowerCase()] = String(value)
  }
  return {
    tag: tag.toLowerCase(),
    attrs: normalized,
    classes: new Set(String(normalized.class ?? '').split(/\s+/).filter(Boolean)),
    parent,
    children: [],
  }
}

function append(parent, tag, attrs = {}) {
  const child = element(tag, attrs, parent)
  parent.children.push(child)
  return child
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

function describe(element) {
  const classes = element.attrs.class ? `.${element.attrs.class.split(/\s+/).join('.')}` : ''
  return `${element.tag}${classes}`
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'label', 'select', 'summary',
  'textarea'])

function isInteractive(element) {
  return INTERACTIVE_TAGS.has(element.tag) ||
    element.classes.has('bt-brand') ||
    'contenteditable' in element.attrs ||
    ROLES.includes(element.attrs.role) ||
    'aria-haspopup' in element.attrs ||
    'tabindex' in element.attrs ||
    'data-menu' in element.attrs
}

// The sidebar's top row and the shell header as src/client builds them, hung under an
// <html> that carries the platform the desktop shell writes.
function sidebarTree(platform) {
  const html = element('html', platform === undefined ? {} : {
    'data-automagik-desktop': platform,
  })
  const body = append(html, 'body')
  const side = append(body, 'div', { class: 'bt-side' })
  const top = append(side, 'div', { class: 'bt-side-top' })
  const brand = append(top, 'span', { class: 'bt-brand' })
  append(top, 'button', {
    type: 'button', class: 'bt-round bt-update', 'aria-haspopup': 'dialog',
  })
  append(top, 'button', { type: 'button', class: 'bt-round', 'aria-label': 'Search' })
  append(top, 'button', { type: 'button', class: 'bt-round', 'aria-label': 'New' })
  append(top, 'button', { type: 'button', class: 'bt-round bt-side-collapse' })
  const header = append(body, 'header', { class: 'pI_x6G_header' })
  const leading = append(header, 'div', { class: 'pI_x6G_headerLeading' })
  append(leading, 'button', { type: 'button', 'data-sidebar-toggle': '' })
  const head = append(header, 'div', { class: 'bt-head' })
  append(head, 'button', { type: 'button', class: 'bt-pill' })
  append(head, 'button', {
    type: 'button', class: 'bt-head-details', 'aria-haspopup': 'menu',
  })
  const panel = append(body, 'div', { class: 'bt-panel' })
  append(panel, 'button', { type: 'button', class: 'bt-ptab', role: 'tab' })
  return { html, body, top, header, leading, head, panel, brand }
}

// --- rows ----------------------------------------------------------------------

test('the darwin top row names every shell kind plus its brand', () => {
  const found = noDragListFor('top')
  assert.ok(found, 'the darwin top row has a no-drag :is(...) list')
  assertDarwinGated(found.selector)
  const missing = SHELL_NO_DRAG.filter(kind => !found.args.includes(kind))
  assert.deepEqual(missing, [], `the top row no-drag list misses: ${missing.join(', ')}`)
  for (const surface of TOP_SURFACES) {
    assert.ok(found.args.includes(surface), `the top row opts out ${surface}`)
  }
})

test('the darwin header names every shell kind', () => {
  const found = noDragListFor('header')
  assert.ok(found, 'the darwin header has a no-drag :is(...) list')
  assertDarwinGated(found.selector)
  const missing = SHELL_NO_DRAG.filter(kind => !found.args.includes(kind))
  assert.deepEqual(missing, [], `the header no-drag list misses: ${missing.join(', ')}`)
})

test('the built darwin top-row and header controls take clicks', () => {
  const { top, header } = sidebarTree('darwin')
  const controls = []
  for (const container of [top, header]) {
    walk(container, node => {
      if (node !== container && isInteractive(node)) controls.push(node)
    })
  }
  assert.ok(controls.length >= 8, `the fixture covers the built controls: ${controls.length}`)
  for (const control of controls) {
    assert.equal(effectiveRegion(control), 'no-drag',
      `darwin ${describe(control)} must take clicks, not drag the window`)
  }
})

test('every shell kind nested in a wrapper takes clicks', () => {
  const { top, header } = sidebarTree('darwin')
  const wrappers = [
    ['top row', append(top, 'div', { class: 'bt-kind-wrap' })],
    ['header', append(header, 'div', { class: 'bt-kind-wrap' })],
  ]
  for (const [where, wrapper] of wrappers) {
    for (const kind of KINDS) {
      const control = append(wrapper, kind.tag, kind.attrs)
      assert.equal(effectiveRegion(control), 'no-drag',
        `${where}: a nested ${kind.label} must take clicks`)
      wrapper.children.pop()
    }
  }
})

test('empty bar and header space still drags, including a control in a wrapper', () => {
  const { top, header } = sidebarTree('darwin')
  assert.equal(effectiveRegion(top), 'drag', 'the sidebar top row drags the window')
  assert.equal(effectiveRegion(header), 'drag', 'the chat header drags the window')
  for (const [where, container] of [['top row', top], ['header', header]]) {
    const wrapper = append(container, 'div', { class: 'bt-gap-wrap' })
    const control = append(wrapper, 'button', { type: 'button' })
    assert.equal(effectiveRegion(control), 'no-drag',
      `${where}: a control nested in the wrapper takes clicks`)
    assert.equal(effectiveRegion(wrapper), 'drag', `${where}: a bare wrapper is empty space`)
    const gap = append(container, 'div', { class: 'bt-gap' })
    assert.equal(effectiveRegion(gap), 'drag', `${where}: empty space drags`)
  }
})

test('the details panel keeps its no-drag surface', () => {
  const { panel } = sidebarTree('darwin')
  assert.equal(effectiveRegion(panel), 'no-drag',
    'the panel overlaps the header and must take clicks')
})

test('every app-region rule is darwin-scoped and Linux keeps none', () => {
  const scoped = rules.filter(rule => appRegionDeclaration(rule))
  assert.ok(scoped.length >= 5, `the drag wiring is present: ${scoped.length} rules`)
  for (const rule of scoped) {
    assert.deepEqual(rule.ancestors, [],
      `an app-region rule is top-level: ${rule.prelude}`)
    const declaration = appRegionDeclaration(rule)
    regionValue(declaration)
    for (const selector of parseSelectorList(rule.prelude)) assertDarwinGated(selector)
  }
  for (const platform of ['linux', undefined]) {
    const tree = sidebarTree(platform)
    for (const node of [tree.top, tree.header, tree.panel]) {
      assert.equal(effectiveRegion(node), undefined,
        `${platform ?? 'no platform'}: no darwin app-region may apply`)
    }
    const control = append(tree.top, 'button', { type: 'button' })
    assert.equal(effectiveRegion(control), undefined,
      `${platform ?? 'no platform'}: no-drag must not leak off darwin`)
  }
})

test('a control of every kind added later is no-drag without another rule', () => {
  const topFound = noDragListFor('top')
  const headerFound = noDragListFor('header')
  assert.ok(topFound, 'the shared top-row no-drag rule exists')
  assert.ok(headerFound, 'the shared header no-drag rule exists')
  const { top, header } = sidebarTree('darwin')
  const containers = [
    ['top row', top, topFound.rule],
    ['header', header, headerFound.rule],
  ]
  for (const [where, container, expected] of containers) {
    const wrapper = append(container, 'div', { class: 'bt-late-wrap' })
    for (const kind of KINDS) {
      const control = append(wrapper, kind.tag, kind.attrs)
      const declared = declaredRegion(control)
      assert.ok(declared, `${where}: a later ${kind.label} must resolve to a no-drag rule`)
      assert.equal(regionValue(declared), 'no-drag',
        `${where}: a later ${kind.label} must take clicks`)
      assert.equal(declared.rule, expected,
        `${where}: a later ${kind.label} is covered by the shared rule, no new rule`)
      wrapper.children.pop()
    }
  }
})

test('the bots-dsh lists match the shell top bar list as #878 lands it', () => {
  const topFound = noDragListFor('top')
  const headerFound = noDragListFor('header')
  assert.ok(topFound, 'the top row no-drag list is readable')
  assert.ok(headerFound, 'the header no-drag list is readable')
  assert.deepEqual([...headerFound.args].sort(), [...SHELL_NO_DRAG].sort(),
    'the header opts out exactly the shell bar kinds')
  assert.deepEqual([...topFound.args].sort(), [...SHELL_NO_DRAG, ...TOP_SURFACES].sort(),
    'the top row opts out the shell bar kinds and its brand')
})
