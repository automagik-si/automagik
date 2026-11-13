// The new left bar's sheet (left-bar-css.js): its sizes and skins are tokens, so another skin or
// the owner's answer on sizes is a change of tokens. Every token a rule reads is set, both skins
// set the same names, the stage is the default, and round 1.1's sizes are the values.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parts } from './left-bar-load.js'

const { LEFT_BAR_CSS, LEFT_BAR_SKIN, LEFT_BAR_SKINS, LEFT_BAR_TOKENS, tokenCss } = parts

test('every --lb- token the sheet reads is set; both skins name the same tokens', () => {
  const read = new Set([...LEFT_BAR_CSS.matchAll(/var\((--lb-[\w-]+)/g)].map(match => match[1]))
  // The two insets are optional: a rule falls back to the art's own sum when they are not set.
  const optional = new Set(['--lb-inset', '--lb-chat-inset'])
  const unset = [...read].filter(name => !(name in LEFT_BAR_TOKENS) && !optional.has(name))
  assert.deepEqual(unset, [])
  assert.deepEqual(Object.keys(LEFT_BAR_SKINS.flat).sort(), Object.keys(LEFT_BAR_SKINS.stage).sort())
})

test('the stage is the default skin; flat and stage are token sets under data-lb-skin', () => {
  assert.equal(LEFT_BAR_SKIN, 'stage')
  for (const [name, value] of Object.entries(LEFT_BAR_SKINS.stage)) assert.equal(LEFT_BAR_TOKENS[name], value)
  assert.ok(LEFT_BAR_CSS.includes(tokenCss('[data-lb-skin=flat]', LEFT_BAR_SKINS.flat)))
  assert.ok(LEFT_BAR_CSS.includes(tokenCss('[data-lb-skin=stage]', LEFT_BAR_SKINS.stage)))
  assert.equal(tokenCss('.x', { '--lb-row-h': '38px', '--lb-art': '32px' }), '.x{--lb-row-h:38px;--lb-art:32px}')
})

test('the sizes are round 1.1 values', () => {
  const sizes = {
    '--lb-rail-w': '56px', '--lb-list-w': '264px', '--lb-tile': '36px', '--lb-tile-r': '12px', '--lb-rail-gap': '10px',
    '--lb-row-h': '34px', '--lb-channel-h': '26px', '--lb-chat-h': '25px', '--lb-label-h': '26px', '--lb-label-first-gap': '8px',
    '--lb-art': '28px', '--lb-art-gap': '10px', '--lb-duo-art': '19px', '--lb-glyph': '16px', '--lb-mark': '12px',
  }
  for (const [name, value] of Object.entries(sizes)) assert.equal(LEFT_BAR_TOKENS[name], value, name)
  assert.equal(LEFT_BAR_SKINS.stage['--lb-panel-gap'], '8px')
  assert.equal(LEFT_BAR_SKINS.flat['--lb-panel-gap'], '0px')
  assert.match(LEFT_BAR_SKINS.stage['--lb-ground'], /--st-stage.* top \/ 100% 160% no-repeat/, 'the stage shows its first 62%')
  assert.match(LEFT_BAR_SKINS.stage['--lb-muted'], /84%/)
  assert.match(LEFT_BAR_SKINS.stage['--lb-needs-ink'], /--st-warn.* 70%,var\(--bt-ink\)/)
})

test('the working ring rests when motion is turned down', () => {
  assert.match(LEFT_BAR_CSS, /body\[data-bt-motion=quiet\] \.lb-mark-arc\{animation:none\}/)
  assert.match(LEFT_BAR_CSS, /@media \(prefers-reduced-motion:reduce\)\{\.lb-mark-arc\{animation:none\}\}/)
})

test('a scroll edge is a full line and a short fade of the rows, in either direction', () => {
  assert.equal(LEFT_BAR_TOKENS['--lb-edge-fade'], '12px')
  const fade = selector => new RegExp(`${selector.replace(/[.[\]]/g, '\\$&')} \\.lb-rows\\{-webkit-mask-image:(linear-gradient\\([^;]+\\));mask-image:\\1\\}`).exec(LEFT_BAR_CSS)?.[1]
  assert.equal(fade('.lb-scroll[data-more]'), 'linear-gradient(to bottom,#000 calc(100% - var(--lb-edge-fade)),transparent)')
  assert.equal(fade('.lb-scroll[data-above]'), 'linear-gradient(to bottom,transparent,#000 var(--lb-edge-fade))')
  assert.equal(fade('.lb-scroll[data-above][data-more]'), 'linear-gradient(to bottom,transparent,#000 var(--lb-edge-fade),#000 calc(100% - var(--lb-edge-fade)),transparent)')
  assert.match(LEFT_BAR_CSS, /\.lb-scroll\[data-more\]::after\{left:0;right:0;border-bottom-color:/, 'the line stays, the list\'s whole width')
  assert.match(LEFT_BAR_CSS, /\.lb-scroll\[data-above\]::before\{left:0;right:0;border-top:1px solid /)
  assert.doesNotMatch(LEFT_BAR_CSS, /--lb-edge-shade/, 'no shade is cast on the rows')
})
