#!/usr/bin/env node
// docs/brand/components/bundle.css is the site's own stylesheet, apps/landing/styles.css, with its
// token declarations taken out: tokens.css holds those. This file makes it from the stylesheet.
//
//   node scripts/brand-bundle.mjs           writes bundle.css
//   node scripts/brand-bundle.mjs --check   exits 1 when bundle.css is not what the stylesheet makes
//
// On the way three things change, and nothing else. The stylesheet's head, which sets its short
// names from the site's theme, gives way to HEAD below, which keeps only what a token cannot hold.
// A rule for the reader's light or dark system setting is also given under data-theme, so a page
// can pick its theme. The font file rule goes: tokens.css loads the fonts. The brand tests run
// --check, so a change to the stylesheet comes here in the same pull request.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SOURCE = 'apps/landing/styles.css'
export const TARGET = 'docs/brand/components/bundle.css'

// The stylesheet's head (after its first comment, up to the box-sizing rule) that HEAD stands
// for. When that head changes, this stops matching: carry the change into HEAD, or into
// tokens.css for a token, and put the new sha256 here.
const HEAD_OF = '384e744c7a949eece15a9519076a6e14c785bd039c17864d79a385e5866de0a2'
const HEAD = `/* Automagik: the site's components. This is the site's own stylesheet (apps/landing/styles.css), made by
   scripts/brand-bundle.mjs with its token declarations taken out: colours, shadows, radii and fonts come from tokens.css.
   What a token cannot hold stays here: the stage gradient, the tile colour mixes and the font short names. Dark values
   apply under data-theme="dark", and under the reader's dark system setting when no data-theme is set. */
:root{--bt-font:var(--font-body);--bt-head-font:var(--font-head);--st-stage:linear-gradient(170deg,#d3eff4 0%,#e4dcf5 55%,#f7d9ea 100%);--head:var(--bt-head-font);--body:var(--bt-font);--tile-lilac:color-mix(in srgb,var(--st-lilac) 72%,var(--st-paper));--tile-cyan:color-mix(in srgb,var(--st-cyan) 34%,var(--st-paper));--tile-pink:color-mix(in srgb,var(--bt-user) 70%,var(--st-paper))}
[data-theme="dark"]{--st-stage:linear-gradient(170deg,#173840 0%,#2a2440 55%,#3d2234 100%);--tile-cyan:color-mix(in srgb,var(--st-cyan) 22%,var(--st-paper));--tile-pink:color-mix(in srgb,var(--bt-user) 55%,var(--st-paper))}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]):not([data-theme="dark"]){--st-stage:linear-gradient(170deg,#173840 0%,#2a2440 55%,#3d2234 100%);--tile-cyan:color-mix(in srgb,var(--st-cyan) 22%,var(--st-paper));--tile-pink:color-mix(in srgb,var(--bt-user) 55%,var(--st-paper))}}
`

// A selector list, each selector put under the given prefix.
const under = (prefix, list) => {
  const parts = []
  let depth = 0, from = 0
  for (let at = 0; at < list.length; at++) {
    if (list[at] === '(') depth++
    else if (list[at] === ')') depth--
    else if (list[at] === ',' && depth === 0) { parts.push(list.slice(from, at)); from = at + 1 }
  }
  parts.push(list.slice(from))
  return parts.map(part => `${prefix} ${part.trim()}`).join(',')
}

export function bundle(css) {
  const start = css.indexOf('*/\n') + 3, end = css.indexOf('*,*::before,*::after{')
  if (start < 3 || end < start) throw new Error(`${SOURCE}: no head to replace (its first comment, then the box-sizing rule)`)
  const head = createHash('sha256').update(css.slice(start, end)).digest('hex')
  if (head !== HEAD_OF) throw new Error(`${SOURCE}: its head changed (sha256 ${head}); carry the change into HEAD in scripts/brand-bundle.mjs, or into tokens.css for a token, and update HEAD_OF`)
  let body = css.slice(end).replace(/^@font-face\{[^\n]*\}\n/gm, '')
  // Each theme rule: @media (prefers-color-scheme:dark|light){ plain rules }, at a line's start.
  const known = /^@media \(prefers-color-scheme:(dark|light)\)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\n/gm
  if ((body.match(/prefers-color-scheme/g) ?? []).length !== (body.match(known) ?? []).length) throw new Error(`${SOURCE}: a theme rule in a form this script does not know`)
  body = body.replace(known, (block, theme, rules) => {
    const other = theme === 'dark' ? 'light' : 'dark'
    if (rules.replace(/[^{}]+\{[^{}]*\}/g, '').trim()) throw new Error(`${SOURCE}: a theme rule holds more than plain rules: ${block.slice(0, 80)}`)
    const picked = [...rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, list, values]) => `${under(`[data-theme="${theme}"]`, list)}{${values}}\n`).join('')
    return picked + block.replace(/([^{}]+)(\{[^{}]*\})/g, (rule, list, values) => rule.startsWith('@media') ? rule : `${list.match(/^\s*/)[0]}${under(`:root:not([data-theme="${other}"])`, list)}${values}`)
  })
  return css.slice(0, start) + HEAD + body
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const made = bundle(readFileSync(root + SOURCE, 'utf8'))
  if (process.argv.includes('--check')) {
    const kept = readFileSync(root + TARGET, 'utf8').split('\n'), lines = made.split('\n')
    const at = lines.findIndex((line, index) => line !== kept[index])
    if (at !== -1 || lines.length !== kept.length) {
      console.error(`${TARGET} is not what ${SOURCE} makes (line ${at === -1 ? lines.length + 1 : at + 1}): run node scripts/brand-bundle.mjs`)
      process.exit(1)
    }
    console.log(`${TARGET}: made from ${SOURCE}`)
  } else {
    writeFileSync(root + TARGET, made)
    console.log(`${TARGET}: written from ${SOURCE}`)
  }
}
