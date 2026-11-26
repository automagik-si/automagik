// docs/brand's components stylesheet is the site's own stylesheet with its token declarations
// taken out, made by scripts/brand-bundle.mjs. It fell behind the site twice when it was made by
// hand; this keeps the two together.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
// @ts-expect-error: a plain JavaScript module, with no types.
import { bundle, SOURCE, TARGET } from './brand-bundle.mjs'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('docs/brand components stylesheet', () => {
  test('bundle.css is what scripts/brand-bundle.mjs makes from the site stylesheet (run it after a change there)', () => {
    const made = bundle(read(SOURCE)).split('\n'), kept = read(TARGET).split('\n')
    const at = made.findIndex((line: string, index: number) => line !== kept[index])
    expect([at === -1 && made.length === kept.length, at + 1, kept[at]?.slice(0, 120)]).toEqual([true, 0, undefined])
  })

  test('on the way, a theme rule is also given under data-theme, the font file rule goes, and nothing else changes', () => {
    const site = read(SOURCE)
    const start = site.indexOf('\n', site.indexOf('*,*::before,*::after{')) + 1
    const add = (css: string) => site.slice(0, start) + css + site.slice(start)
    const rule = '.x{color:red}\n'
    // A rule of the reader's dark setting: picked by data-theme, or by the setting when no theme is picked.
    expect(bundle(add(`@media (prefers-color-scheme:dark){.a,.b:is(.c,.d){color:red}}\n${rule}`)).split('\n')).toEqual(expect.arrayContaining([
      '[data-theme="dark"] .a,[data-theme="dark"] .b:is(.c,.d){color:red}',
      '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .a,:root:not([data-theme="light"]) .b:is(.c,.d){color:red}}',
    ]))
    expect(bundle(add(`@font-face{font-family:"X";src:url("x.woff2")}\n${rule}`))).toBe(bundle(add(rule)))
    // A theme rule in a form it does not know, or a change to the stylesheet's head, stops it.
    expect(() => bundle(add('@media (prefers-color-scheme:dark) and (max-width:480px){.a{color:red}}\n'))).toThrow('does not know')
    expect(() => bundle(site.replace(':root{--bg:', ':root{--new:0;--bg:'))).toThrow('its head changed')
  })

  test('every custom property bundle.css reads is defined in the token file or by the bundle itself', () => {
    const css = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '')
    const bundleCss = css(TARGET)
    const readVars = new Set([...bundleCss.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map(match => match[1]))
    const tokenVars = new Set([...css('docs/brand/tokens/tokens.css').matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map(match => match[1]))
    const ownVars = new Set([...bundleCss.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map(match => match[1]))
    // The family drawer is a byte copy loaded beside the bundle on its page; it declares this one
    // host value itself (apps/landing/assets/family/family.css), and no component preview matches
    // its rule. Every other read must resolve from the token file or from the bundle itself.
    const fromFamilyPiece = '--fam-clear'
    expect(read('apps/landing/assets/family/family.css')).toContain(`${fromFamilyPiece}:`)
    expect(readVars.has(fromFamilyPiece)).toBe(true)
    for (const n of [1, 2, 3]) expect(readVars.has(`--heading-${n}-letter-spacing`)).toBe(true)
    const missing = [...readVars].filter(name => !tokenVars.has(name) && !ownVars.has(name) && name !== fromFamilyPiece).sort()
    expect(missing).toEqual([])
  })
})
