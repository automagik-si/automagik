import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// On macOS dsh's page fills the window, so the desktop shell bar is not the top bar:
// bots-dsh's sidebar top row and the chat header are. This checks the darwin rules that
// keep their controls out of the window's drag region without touching the other platforms.
const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
const headerSource = readFileSync(new URL('../src/client/header.js', import.meta.url), 'utf8')
const MARKER = 'export const SIDEBAR_CSS = `'
const start = source.indexOf(MARKER)
assert.ok(start >= 0, 'sidebar.js exports SIDEBAR_CSS')
const open = start + MARKER.length
const end = source.indexOf('`', open)
assert.ok(end > open, 'SIDEBAR_CSS template literal ends')
// The CSS is a template literal only because its animation timing interpolates a JS
// constant. The checks below read selectors, so a placeholder keeps the braces balanced.
const sidebarCss = source.slice(open, end).replace(/\$\{[^}]*\}/g, '0ms')

// The list the shell's own top bar uses (#845), kept here so a later narrowing of the
// sidebar's copy fails this test. The top row also names its two container surfaces.
const SHELL_NO_DRAG = [
  'a', 'button', 'input', 'label', 'select', 'summary', 'textarea', '[contenteditable]',
  '[role=button]', '[role=checkbox]', '[role=link]', '[role=menu]', '[role=menubar]',
  '[role=menuitem]', '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=option]',
  '[role=radio]', '[role=slider]', '[role=switch]', '[role=tab]',
  '[aria-haspopup]', '[tabindex]', '[data-menu]',
]
const TOP_CONTAINERS = ['.bt-brand']

// The stylesheet is hand-written and compact; these checks only need selectors and the
// app-region declaration, so this reader stays small.
function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const found = []
  let start = 0
  let depth = 0
  let bodyStart = 0
  let prelude = ''
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') {
      if (depth === 0) {
        prelude = clean.slice(start, i).trim()
        bodyStart = i + 1
      }
      depth += 1
    } else if (clean[i] === '}') {
      depth -= 1
      if (depth === 0) {
        if (!prelude.startsWith('@')) found.push({ prelude, body: clean.slice(bodyStart, i) })
        start = i + 1
      }
    }
  }
  return found
}

const rules = cssRules(sidebarCss)
const appRegionOf = rule => rule.body.match(/(?:^|;)\s*(?:-webkit-)?app-region\s*:\s*(drag|no-drag)/)?.[1]

// Split on a comma outside `()` and `[]`, so a `:is(a, b)` stays one selector.
function splitTop(text, separator = ',') {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

// A complex selector as its compounds and the combinators between them.
function complex(selector) {
  const text = selector.trim()
  const tokens = []
  let current = ''
  let depth = 0
  let space = false
  const flush = () => {
    if (current) tokens.push({ compound: current })
    current = ''
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    if (depth === 0 && /\s/.test(char)) {
      flush()
      const last = tokens[tokens.length - 1]
      if (!last || !last.combinator || last.combinator === ' ') space = true
      continue
    }
    if (depth === 0 && (char === '>' || char === '+' || char === '~')) {
      flush()
      tokens.push({ combinator: char })
      space = false
      continue
    }
    if (space) {
      tokens.push({ combinator: ' ' })
      space = false
    }
    current += char
  }
  flush()
  return {
    parts: tokens.filter(token => token.compound).map(token => token.compound),
    combinators: tokens.filter(token => token.combinator).map(token => token.combinator),
  }
}

// The index of the `]` or `)` that closes the bracket at `openIndex`.
function closing(text, openIndex) {
  const open = text[openIndex]
  const close = open === '[' ? ']' : ')'
  let depth = 0
  let quote = ''
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === open) depth += 1
    else if (char === close && --depth === 0) return i
  }
  return -1
}

function matchesCompound(element, raw) {
  let rest = raw.trim()
  if (!rest) return false
  if (rest === '*') return true
  const tag = rest.match(/^[a-zA-Z][\w-]*/)
  if (tag) {
    if (element.tag !== tag[0].toLowerCase()) return false
    rest = rest.slice(tag[0].length)
  }
  while (rest) {
    if (rest[0] === '*') {
      rest = rest.slice(1)
    } else if (rest[0] === '.') {
      const match = rest.match(/^\.([\w-]+)/)
      if (!match || !element.classes.has(match[1])) return false
      rest = rest.slice(match[0].length)
    } else if (rest[0] === '#') {
      const match = rest.match(/^#([\w-]+)/)
      if (!match || element.id !== match[1]) return false
      rest = rest.slice(match[0].length)
    } else if (rest[0] === '[') {
      const end = closing(rest, 0)
      if (end < 0) return false
      const attribute = rest.slice(1, end).trim()
      const match = attribute.match(/^([\w:-]+)(?:\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?$/)
      if (!match || !(match[1] in element.attrs)) return false
      if (match[2] !== undefined) {
        const wanted = match[3] ?? match[4] ?? match[5] ?? ''
        const actual = String(element.attrs[match[1]])
        if (match[2] === '=' && actual !== wanted) return false
        if (match[2] === '*=' && !actual.includes(wanted)) return false
        if (!['=', '*='].includes(match[2])) return false
      }
      rest = rest.slice(end + 1)
    } else if (rest.startsWith(':is(') || rest.startsWith(':where(') || rest.startsWith(':not(')) {
      const name = rest.slice(0, rest.indexOf('('))
      const open = rest.indexOf('(')
      const end = closing(rest, open)
      if (end < 0) return false
      const matched = splitTop(rest.slice(open + 1, end)).some(argument => matchesComplex(element, argument))
      if (name === ':not(' ? matched : !matched) return false
      rest = rest.slice(end + 1)
    } else if (rest.startsWith(':root')) {
      if (element.parent) return false
      rest = rest.slice(':root'.length)
    } else {
      // A state pseudo-class (:hover, :active) or a pseudo-element is not part of the page
      // at rest, so it cannot decide the app region of a control a person can click.
      return false
    }
  }
  return true
}

function matchesComplex(element, selector) {
  const { parts, combinators } = complex(selector)
  if (!parts.length || !matchesCompound(element, parts[parts.length - 1])) return false
  let node = element
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const combinator = combinators[i] ?? ' '
    if (combinator === '>') {
      node = node.parent
      if (!node || !matchesCompound(node, parts[i])) return false
    } else if (combinator === ' ') {
      node = node.parent
      while (node && !matchesCompound(node, parts[i])) node = node.parent
      if (!node) return false
    } else {
      return false
    }
  }
  return true
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const bigger = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])

function compoundSpecificity(raw) {
  let rest = raw.trim()
  let specificity = [0, 0, 0]
  if (rest === '*') return specificity
  const tag = rest.match(/^[a-zA-Z][\w-]*/)
  if (tag) {
    specificity = add(specificity, [0, 0, 1])
    rest = rest.slice(tag[0].length)
  }
  while (rest) {
    if (rest[0] === '#') {
      specificity = add(specificity, [1, 0, 0])
      rest = rest.slice(rest.match(/^#[\w-]+/)[0].length)
    } else if (rest[0] === '.' || rest[0] === '[') {
      specificity = add(specificity, [0, 1, 0])
      rest = rest[0] === '.' ? rest.slice(rest.match(/^\.[\w-]+/)[0].length) : rest.slice(closing(rest, 0) + 1)
    } else if (rest.startsWith(':is(') || rest.startsWith(':not(') || rest.startsWith(':where(')) {
      const name = rest.slice(0, rest.indexOf('('))
      const open = rest.indexOf('(')
      const end = closing(rest, open)
      if (name !== ':where(') {
        const best = splitTop(rest.slice(open + 1, end)).map(specificityOf).reduce((a, b) => (bigger(a, b) >= 0 ? a : b))
        specificity = add(specificity, best)
      }
      rest = rest.slice(end + 1)
    } else if (rest.startsWith(':root')) {
      specificity = add(specificity, [0, 1, 0])
      rest = rest.slice(':root'.length)
    } else {
      rest = rest.slice(1)
    }
  }
  return specificity
}

function specificityOf(selector) {
  return complex(selector).parts.reduce((total, part) => add(total, compoundSpecificity(part)), [0, 0, 0])
}

const compare = (a, b) => {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

// The app-region an element declares itself, by specificity and then source order.
function declaredAppRegion(element) {
  let winner = null
  rules.forEach((rule, index) => {
    const value = appRegionOf(rule)
    if (!value) return
    for (const selector of splitTop(rule.prelude)) {
      if (!matchesComplex(element, selector)) continue
      const score = [...specificityOf(selector), index]
      if (!winner || compare(score, winner.score) >= 0) winner = { value, score }
    }
  })
  return winner?.value
}

// A drag region covers its whole rectangle: a child with no app-region of its own sits in the
// nearest ancestor's region. That is why the empty bar can drag while only its controls opt out.
function appRegion(element) {
  for (let node = element; node; node = node.parent) {
    const declared = declaredAppRegion(node)
    if (declared) return declared
  }
  return undefined
}

function element(tag, attrs = {}, parent = null) {
  const normalized = Object.fromEntries(Object.entries(attrs).map(([name, value]) => [name.toLowerCase(), value]))
  return {
    tag: tag.toLowerCase(),
    attrs: normalized,
    classes: new Set(String(normalized.class ?? '').split(/\s+/).filter(Boolean)),
    id: normalized.id,
    parent,
    children: [],
  }
}

function append(parent, tag, attrs = {}) {
  const node = element(tag, attrs, parent)
  parent.children.push(node)
  return node
}

function walk(node, visit) {
  visit(node)
  for (const child of node.children) walk(child, visit)
}

// The sidebar's top row and chat header as the builders under src/client make them, hung
// under an html element that carries the platform the desktop shell writes.
function sidebarTree(platform) {
  const html = element('html', platform === undefined ? {} : { 'data-automagik-desktop': platform })
  const body = append(html, 'body')
  const side = append(body, 'div', { class: 'bt-side' })
  const top = append(side, 'div', { class: 'bt-side-top' })
  append(top, 'span', { class: 'bt-brand' })
  append(top, 'button', { type: 'button', class: 'bt-round bt-update', 'aria-haspopup': 'dialog' })
  append(top, 'button', { type: 'button', class: 'bt-round', 'aria-label': 'Search' })
  append(top, 'button', { type: 'button', class: 'bt-round', 'aria-label': 'New' })
  append(top, 'button', { type: 'button', class: 'bt-round bt-side-collapse' })
  const header = append(body, 'header', { class: 'pI_x6G_header' })
  const leading = append(header, 'div', { class: 'pI_x6G_headerLeading' })
  append(leading, 'button', { type: 'button', 'data-sidebar-toggle': '' })
  const head = append(header, 'div', { class: 'bt-head' })
  append(head, 'button', { type: 'button', class: 'bt-pill' })
  append(head, 'button', { type: 'button', class: 'bt-head-details' })
  const panel = append(body, 'div', { class: 'bt-panel' })
  append(panel, 'button', { type: 'button', class: 'bt-ptab', role: 'tab' })
  return { html, body, side, top, header, leading, head, panel }
}

function interactive(node) {
  return ['a', 'button', 'input', 'label', 'select', 'summary', 'textarea'].includes(node.tag) ||
    node.classes.has('bt-brand') || 'contenteditable' in node.attrs ||
    ['button', 'checkbox', 'link', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'option', 'radio', 'slider', 'switch', 'tab'].includes(node.attrs.role) ||
    'aria-haspopup' in node.attrs || 'tabindex' in node.attrs || 'data-menu' in node.attrs
}

function noDragArguments(selector) {
  const open = selector.indexOf(':is(')
  assert.ok(open >= 0, `a no-drag selector has an :is() list: ${selector}`)
  const end = closing(selector, open + 3)
  assert.ok(end > open, `the :is() list closes: ${selector}`)
  return splitTop(selector.slice(open + 4, end))
}

test('the darwin top bar and header keep their drag regions and empty space', () => {
  const { top, header, leading } = sidebarTree('darwin')
  assert.equal(appRegion(top), 'drag', 'the sidebar top row drags the window')
  assert.equal(appRegion(header), 'drag', 'the chat header drags the window')
  assert.equal(appRegion(leading), 'drag', 'the header leading area is still in the drag region')
  const emptyTop = append(top, 'div', { class: 'empty-space' })
  const emptyHeader = append(header, 'div', { class: 'empty-space' })
  assert.equal(appRegion(emptyTop), 'drag', 'empty space in the top row still drags')
  assert.equal(appRegion(emptyHeader), 'drag', 'empty space in the header still drags')
})

test('every interactive sidebar top-bar item is no-drag on darwin', () => {
  const { top, header } = sidebarTree('darwin')
  const items = []
  walk(top, node => { if (node !== top && interactive(node)) items.push(node) })
  walk(header, node => { if (node !== header && interactive(node)) items.push(node) })
  assert.ok(items.length >= 8, `the fixture covers the built controls: ${items.length}`)
  assert.ok(items.some(node => node.classes.has('bt-brand')), 'the brand is covered even though the app hides it')
  assert.ok(items.some(node => node.attrs['aria-haspopup'] === 'dialog'), 'the update menu trigger is covered')
  assert.ok(items.some(node => node.attrs['data-sidebar-toggle'] !== undefined), 'the header sidebar toggle is covered')
  for (const item of items) {
    assert.equal(appRegion(item), 'no-drag',
      `darwin: ${item.tag}${item.classes.size ? `.${[...item.classes].join('.')}` : ''} must take clicks`)
  }
})

test('a control added later is no-drag without another rule', () => {
  const added = [
    ['button', {}],
    ['a', { href: '#' }],
    ['input', { type: 'text' }],
    ['label', {}],
    ['select', {}],
    ['summary', {}],
    ['textarea', {}],
    ['div', { contenteditable: 'true' }],
    ...['button', 'checkbox', 'link', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'option', 'radio', 'slider', 'switch', 'tab'].map(role => ['div', { role }]),
    ['div', { 'aria-haspopup': 'menu' }],
    ['div', { tabindex: '0' }],
    ['div', { 'data-menu': 'sidebar' }],
  ]
  for (const platform of ['darwin']) {
    const { top, header } = sidebarTree(platform)
    // A plain wrapper proves the rule reaches nested controls, not only direct children.
    const topWrap = append(top, 'div', { class: 'built-wrapper' })
    const headerWrap = append(header, 'div', { class: 'built-wrapper' })
    for (const [tag, attrs] of added) {
      for (const parent of [topWrap, headerWrap]) {
        const control = append(parent, tag, attrs)
        assert.equal(appRegion(control), 'no-drag',
          `${platform}: a new ${tag}${attrs.role ? ` role=${attrs.role}` : ''} must be no-drag`)
        parent.children.pop()
      }
    }
  }
})

test('the details panel keeps its no-drag surface', () => {
  const { panel } = sidebarTree('darwin')
  assert.equal(appRegion(panel), 'no-drag', 'the panel overlaps the header and must take clicks')
  const control = append(panel, 'button', { type: 'button' })
  assert.equal(appRegion(control), 'no-drag', 'the panel brings its own controls')
})

test('the no-drag lists match the shell top bar list', () => {
  const noDrag = rules.filter(rule => appRegionOf(rule) === 'no-drag')
  const topRule = noDrag.find(rule => splitTop(rule.prelude).some(selector => selector.includes('.bt-side-top')))
  const headerRule = noDrag.find(rule => splitTop(rule.prelude).some(selector => selector.includes('header[class*="_header"]')))
  assert.ok(topRule, 'the sidebar top row has a no-drag rule')
  assert.ok(headerRule, 'the chat header has a no-drag rule')
  const topArgs = noDragArguments(splitTop(topRule.prelude).find(selector => selector.includes('.bt-side-top')))
  const headerArgs = noDragArguments(splitTop(headerRule.prelude).find(selector => selector.includes('header[class*="_header"]')))
  assert.deepEqual([...topArgs].sort(), [...SHELL_NO_DRAG, ...TOP_CONTAINERS].sort(),
    'the top row opts out every shell item and its brand surface')
  assert.deepEqual([...headerArgs].sort(), [...SHELL_NO_DRAG].sort(),
    'the header opts out the same controls as the shell top bar')
})

test('the drag rules stay darwin-scoped and leave Linux alone', () => {
  const appRegionRules = rules.filter(rule => appRegionOf(rule))
  assert.ok(appRegionRules.length >= 5, 'the sidebar stylesheet carries the drag and no-drag rules')
  for (const rule of appRegionRules) {
    for (const selector of splitTop(rule.prelude)) {
      assert.ok(selector.startsWith('html[data-automagik-desktop=darwin]'),
        `a sidebar app-region rule must be darwin-scoped: ${selector}`)
    }
  }
  for (const platform of ['linux', undefined]) {
    const { top, header, panel } = sidebarTree(platform)
    assert.equal(appRegion(top), undefined, `${platform}: the top row has no darwin drag rule`)
    assert.equal(appRegion(header), undefined, `${platform}: the header has no darwin drag rule`)
    assert.equal(appRegion(panel), undefined, `${platform}: the panel has no darwin no-drag rule`)
    const button = append(top, 'button', { type: 'button' })
    assert.equal(appRegion(button), undefined, `${platform}: no-drag must not leak off darwin`)
  }
})

test('the tests exercise the builders this rule depends on', () => {
  assert.match(source, /className: 'bt-side-top'/)
  // RFC 0022 B (Q9): Open Herdr moved onto each Code row; the sidebar builds no WorkCodeSwitch.
  assert.doesNotMatch(source, /h\(WorkCodeSwitch/)
  assert.match(source, /h\(UpdateButton/)
  assert.match(headerSource, /'bt-head'/)
})
