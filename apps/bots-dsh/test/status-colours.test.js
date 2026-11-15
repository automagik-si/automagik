import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// The status colours are the brand's. docs/brand/tokens/tokens.json records them, chosen so that
// red-blind, green-blind and blue-blind sight can tell them apart; both theme sheets carry the same
// values, light and dark, so a status looks the same whichever theme is on.
const tokens = JSON.parse(readFileSync(new URL('../../../docs/brand/tokens/tokens.json', import.meta.url), 'utf8'))
const names = ['st-ok', 'st-okdot', 'st-bad', 'st-warn', 'st-warndot', 'st-work', 'bt-danger', 'bt-green']
const brand = (name, theme) => {
  const value = tokens.color.tokens.find(token => token.name === name)?.value[theme]
  assert.match(value ?? '', /^#[0-9a-f]{6}$/, `docs/brand/tokens/tokens.json has no ${theme} colour for ${name}`)
  return value
}
const blocks = sheet => {
  // The sheets are template strings: a `${name}` inside a block is not the block's end.
  const text = readFileSync(new URL(`../src/client/${sheet}`, import.meta.url), 'utf8').replace(/\$\{[^}]*\}/g, '')
  return {
    light: /\nhtml body\{([\s\S]*?)\}/.exec(text)[1],
    dark: /\nhtml body\[data-ds-dark-theme\]\{([\s\S]*?)\}/.exec(text)[1],
  }
}
const set = (block, name) => [...block.matchAll(new RegExp(`--${name}:([^;}]+)`, 'g'))].map(match => match[1])

for (const sheet of ['stage.js', 'clay.js']) {
  test(`${sheet}: every status colour is the brand's, light and dark`, () => {
    for (const [theme, block] of Object.entries(blocks(sheet))) {
      for (const name of names) assert.deepEqual(set(block, name), [brand(name, theme)], `${sheet}, ${theme}: --${name} is not the value docs/brand/tokens/tokens.json records`)
    }
  })
}

// The clay theme paints its done and failed marks with its own two names: they are the same green and red.
test("clay.js: the theme's own green and red are the status green and red", () => {
  for (const [theme, block] of Object.entries(blocks('clay.js'))) {
    assert.deepEqual(set(block, 'clay-ok'), [brand('st-ok', theme)], `clay.js, ${theme}: --clay-ok is not the brand's st-ok`)
    assert.deepEqual(set(block, 'clay-bad'), [brand('st-bad', theme)], `clay.js, ${theme}: --clay-bad is not the brand's st-bad`)
  }
})

// Text stays readable: 4.5 to 1 or more (WCAG) on the grounds it sits on. Some status texts sit on
// grounds where the brand's own values fall short, so each theme sheet carries a stronger shade for
// text alone: amber for the sidebar's "asks you" line (on the stage, on Clay's sidebar and on its
// selected lilac row), and red for text on any ground that is not a plain card or page: a red tint,
// the lilac of a selected option or a pressed segment, a field, a row under the pointer. The dark
// red has only 4.7 to 1 on the card, so every lighter ground needs the strong shade. Dots keep the
// brand's values.
const channel = value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
const parts = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16))
const luminance = hex => { const [r, g, b] = parts(hex).map(part => channel(part / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const tint = (colour, share, ground) => `#${parts(colour).map((part, index) => Math.round(part * share + parts(ground)[index] * (1 - share)).toString(16).padStart(2, '0')).join('')}`
// A see-through colour (rgba) laid over an opaque ground.
const over = (rgba, ground) => {
  const [r, g, b, a] = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(rgba).slice(1).map(Number)
  return `#${[r, g, b].map((part, index) => Math.round(part * a + parts(ground)[index] * (1 - a)).toString(16).padStart(2, '0')).join('')}`
}
const one = (block, name) => { const found = set(block, name); assert.equal(found.length, 1, `--${name} is set ${found.length} times`); return found[0] }
const palette = (sheet, name) => Object.fromEntries([...new RegExp(`${name} = Object\\.freeze\\(\\{([^}]*)\\}`).exec(readFileSync(new URL(`../src/client/${sheet}`, import.meta.url), 'utf8'))[1].matchAll(/(\w+): '(#[0-9a-f]{6})'/g)].map(match => [match[1], match[2]]))

test('the strong amber and the strong red read at 4.5 to 1 or more on the coloured grounds they sit on', () => {
  const grounds = {
    'stage.js': { light: palette('stage.js', 'STAGE_LIGHT'), dark: palette('stage.js', 'STAGE_DARK') },
    'clay.js': { light: palette('clay.js', 'CLAY_LIGHT'), dark: palette('clay.js', 'CLAY_DARK') },
  }
  for (const sheet of ['stage.js', 'clay.js']) {
    for (const [theme, block] of Object.entries(blocks(sheet))) {
      const amber = one(block, 'st-warn-strong')
      const red = one(block, 'st-bad-strong')
      // The "asks you" line: on the stage's three colours, or on Clay's sidebar and its selected lilac row.
      const under = sheet === 'stage.js' ? one(block, 'st-stage').match(/#[0-9a-f]{6}/g) : [grounds[sheet][theme].sidebar, one(block, 'clay-lilac')]
      assert.ok(under.length >= 2, `${sheet}, ${theme}: no grounds found for the "asks you" line`)
      for (const ground of under) assert.ok(contrast(amber, ground) >= 4.5, `${sheet}, ${theme}: --st-warn-strong ${amber} on ${ground} is ${contrast(amber, ground).toFixed(2)} to 1`)
      // Red text off the plain card. A tenth of the status red over the card (a confirm button, the
      // Hermes error note); the lilac of the selected permission option and of Clay's pressed
      // segment; a field (the hover wash over the card), and the same field open or under the
      // pointer (the active wash over that); the Delete Bot row's confirm tint under the pointer.
      const card = grounds[sheet][theme].card
      const field = over(one(block, 'bt-hover'), card)
      const lifted = {
        'a tenth of the red over the card': tint(one(block, 'bt-danger'), 0.1, card),
        'the selected lilac': one(block, sheet === 'stage.js' ? 'st-lilac' : 'clay-lilac'),
        'a field': field,
        'a field, open or under the pointer': over(one(block, 'bt-active'), field),
        'the confirm tint under the pointer': tint(one(block, 'bt-danger'), 0.12, field),
      }
      for (const [name, ground] of Object.entries(lifted)) assert.ok(contrast(red, ground) >= 4.5, `${sheet}, ${theme}: --st-bad-strong ${red} on ${name} (${ground}) is ${contrast(red, ground).toFixed(2)} to 1`)
    }
  }
})

test('the texts on coloured, selected and lifted grounds read the strong shade', () => {
  const source = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
  assert.ok(source('styles.js').includes('.bt-row-preview-ask{color:var(--st-warn-strong,var(--st-warn,var(--bt-ink-2)));'))
  // Each theme recolours a row's preview line with a more specific rule; the "asks you" line keeps its amber through it.
  assert.ok(source('stage.js').includes('html body .bt-row .bt-row-preview-ask,html body .bt-row[aria-current=page] .bt-row-preview-ask{color:var(--st-warn-strong)}'))
  assert.ok(source('clay.js').includes('html body .bt-row[aria-current=page] .bt-row-preview-ask{color:var(--st-warn-strong)}'))
  assert.ok(source('styles.js').includes('.bt-mem-remove[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--st-bad-strong,var(--bt-danger));'))
  assert.ok(source('schedules.js').includes('.bt-task-remove[data-confirm]{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--st-bad-strong,var(--bt-danger))}'))
  assert.ok(source('hermes-remote.js').includes('.bt-hw-error-note{background:color-mix(in srgb,var(--bt-danger) 10%,var(--bt-card));border-color:transparent;color:var(--st-bad-strong,var(--bt-danger))}'))
  // Red text that a selected, pressed or hovered ground can sit under: the Full access option and
  // its field, a red menu item, the pressed Full access segment, Delete Bot, a secret's Delete,
  // the model field's "no model" line.
  const strong = 'color:var(--st-bad-strong,var(--bt-danger))'
  assert.ok(source('styles.js').includes(`\n.bt-danger{${strong}}`))
  assert.ok(source('styles.js').includes(`.bt-menu .bt-danger{${strong}}`))
  assert.ok(source('styles.js').includes(`.bt-seg button.bt-perm-danger,.bt-seg button.bt-perm-danger[aria-pressed=true],.bt-kv span.bt-perm-danger{${strong}}`))
  assert.ok(source('bot-settings.js').includes(`.bt-bs-danger .bt-bs-label{${strong}}`))
  assert.ok(source('secret-card.js').includes(`.bt-secret-danger{${strong};`))
  assert.ok(source('model-menu.js').includes(`.bt-model-trigger[data-missing] .bt-model-provider{${strong}}`))
})

test('every red text reads the strong shade, so a card never shows two text reds', () => {
  // Dots, fills and tints keep the brand's red. A `color` that reads the red is text, and reads
  // the strong shade first; the two marks that are icons, not text, are named here.
  const marks = ['.bt-hw-failed .bt-hw-result-icon', '.bt-mem-changes li svg']
  const red = /var\(--(?:bt-danger|st-bad|clay-bad)(?![-\w])/
  const plain = []
  let strong = 0
  for (const name of readdirSync(new URL('../src/client/', import.meta.url)).filter(name => name.endsWith('.js'))) {
    const text = readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8').replace(/\$\{[^}]*\}/g, '')
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const line of body.split(';')) {
        const value = /^\s*color:(.*)$/s.exec(line)?.[1]
        if (!value || !red.test(value) || marks.includes(selector.trim())) continue
        if (value.includes('var(--st-bad-strong,var(--bt-danger')) strong += 1
        else plain.push(`${name}: ${selector.trim()}`)
      }
    }
  }
  assert.deepEqual(plain, [], 'these texts read the plain red; read var(--st-bad-strong,var(--bt-danger)) instead')
  assert.ok(strong >= 25, `the scan found only ${strong} red texts; it no longer reads the sheets`)
})
