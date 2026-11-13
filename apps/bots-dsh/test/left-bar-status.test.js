// The new left bar's status marks (left-bar-status.js): one shape per status, a hover title and an
// accessible name on every mark that stands alone, a word only for "needs you", and nothing for
// a quiet Bot. Round 1.1's marks are the reference (r1.1 NOTES, "The status marks").
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findAll, parts, render, textOf } from './left-bar-load.js'

const { STATUSES, OWED_WORDS, Status, StatusMark, installLocale, stateOfStatus, statusOfState, statusOr, word, worstStatus } = parts

const zh = () => {
  const dicts = new Map()
  return installLocale({
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => key => dicts.get(`${ns}:zh`)?.[key] ?? key,
    getLocale: () => ({ active: 'zh' }),
  })
}

test('every status has a mark with its own shape, its name and its title', () => {
  const shapes = new Set()
  for (const status of STATUSES) {
    const mark = render(StatusMark({ status }))
    assert.equal(mark.props.role, 'img', `${status}: the mark is an image`)
    assert.equal(mark.props['aria-label'], word(status), `${status}: the mark is named`)
    assert.equal(mark.props.title, word(status), `${status}: the mark has a hover title`)
    assert.equal(mark.props['data-status'], status)
    const svg = mark.children[0]
    assert.equal(svg.props['aria-hidden'], true, `${status}: the drawing itself is hidden`)
    shapes.add(JSON.stringify(svg.children.map(({ type, props }) => [type, props.d ?? props.r ?? props.rx])))
  }
  // idle and off share the hollow ring: off is told by its grey row, not by its mark.
  assert.equal(shapes.size, STATUSES.length - 1, 'working, needs you, error and idle each have a shape of their own')
})

test('the marks are drawn to round 1.1 sizes', () => {
  const svg = status => render(StatusMark({ status })).children[0]
  const working = svg('working')
  assert.equal(working.props.viewBox, '0 0 12 12')
  // An 11 px ring, line 2: its track at 30% and a half arc in full that turns.
  const [track, arc] = working.children
  assert.equal(track.props.r * 2 + track.props.strokeWidth, 11)
  assert.equal(track.props.strokeOpacity, 0.3)
  assert.equal(arc.props.className, 'lb-mark-arc')
  // A 12 px disc with a "!".
  const [disc, bang] = svg('needs').children
  assert.equal(disc.props.r * 2, 12)
  assert.equal(bang.props.className, 'lb-mark-glyph')
  // A 9 px ring, line 1.5.
  const [ring] = svg('idle').children
  assert.equal(ring.props.r * 2 + ring.props.strokeWidth, 9)
  assert.equal(ring.props.strokeWidth, 1.5)
})

test('a row shows nothing when idle, the word only for needs you, and the mark alone else', () => {
  assert.equal(render(Status({ status: 'idle' })), null)
  assert.equal(render(Status({ status: 'nonsense' })), null, 'an unknown status is idle')
  for (const status of ['working', 'error', 'off']) {
    const shown = render(Status({ status }))
    assert.equal(shown.props.role, 'img', `${status}: the mark alone`)
    assert.equal(textOf(shown), '', `${status}: no word on the row`)
  }
  const needs = render(Status({ status: 'needs' }))
  assert.equal(needs.props.className, 'lb-st lb-st-needs')
  assert.equal(textOf(needs), 'Needs you', 'needs you keeps its word')
  // Beside its word the mark is not read twice.
  const [mark] = findAll(needs, node => node.props?.['data-status'] === 'needs' && node.type === 'span' && node !== needs)
  assert.equal(mark.props['aria-hidden'], true)
  assert.equal(mark.props.role, undefined)
  // Which statuses show a word, and which are quiet, are the caller's to change.
  assert.equal(textOf(render(Status({ status: 'error', worded: ['needs', 'error'] }))), 'Error')
  assert.equal(render(Status({ status: 'working', quiet: ['idle', 'working'] })), null)
})

test('one status for several: needs you first, then error, then working', () => {
  assert.equal(worstStatus(['working', 'needs', 'error']), 'needs')
  assert.equal(worstStatus(['working', 'error', 'idle']), 'error')
  assert.equal(worstStatus(['idle', 'working']), 'working')
  assert.equal(worstStatus(['idle', 'off']), 'idle')
  assert.equal(worstStatus([]), 'idle')
})

test('the mascot states and the bar statuses map both ways', () => {
  assert.equal(statusOr('working'), 'working')
  assert.equal(statusOr(undefined), 'idle')
  assert.equal(statusOfState('alert'), 'needs')
  assert.equal(statusOfState('failed'), 'error')
  for (const state of ['thinking', 'searching', 'working', 'sending', 'orbit', 'waiting']) assert.equal(statusOfState(state), 'working', state)
  assert.equal(statusOfState('idle'), 'idle')
  assert.equal(statusOfState('sleeping'), 'idle')
  assert.equal(stateOfStatus('needs'), 'alert')
  assert.equal(stateOfStatus('error'), 'failed')
  assert.equal(stateOfStatus('working'), 'working')
  assert.equal(stateOfStatus('off'), 'idle')
})

test('the words the dictionary has are translated; the owed ones read English until the switch', () => {
  // These go into i18n.js with the switch to the new bar: i18n.js is one of the files the
  // DS Bot 0.3.6 merge rewrites, so this branch does not touch it.
  assert.deepEqual({ ...OWED_WORDS }, { idle: 'Idle', off: 'Not running', team: 'Team', projects: 'Projects', add: 'Add a project' })
  const off = zh()
  try {
    assert.equal(word('working'), '工作中')
    assert.equal(word('needs'), '需要你')
    assert.equal(word('error'), '错误')
    for (const [name, english] of Object.entries(OWED_WORDS)) assert.equal(word(name), english, `${name} is owed a translation`)
  } finally {
    off()
  }
})
