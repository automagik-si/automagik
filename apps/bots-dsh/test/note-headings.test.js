// #2061 (PLAN-S6R O2): an outgoing ACP agent's handoff note is not thrown away over the way
// its headings are written; the parse is per line, so a long line costs linear time.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { missingHeadings, tolerantHeadings } from '../src/host/parts.js'

const NAMES = ['Goals', 'Constraints and preferences', 'Progress', 'Decisions', 'Facts to keep', 'Open threads', 'Next step', 'Where to look']
const PT = ['Objetivos', 'Restrições e preferências', 'Progresso', 'Decisões', 'Fatos a manter', 'Pendências', 'Próximo passo', 'Onde procurar']
const CANONICAL = NAMES.flatMap(name => [`## ${name}`, `- about ${name.toLowerCase()}`]).join('\n')
// A note with each heading written by `form`, the bodies as in CANONICAL; `extra(n)` adds body lines.
const noteWith = (form, headings = NAMES, extra = () => []) => headings
  .flatMap((name, n) => [form(name, n), `- about ${NAMES[n].toLowerCase()}`, ...extra(n)]).join('\n')
const translated = (form = name => `## ${name}`, extra) => noteWith(form, PT, extra)
const boldLabel = n => [`**Rótulo ${n + 1}:**`]
const missing = note => missingHeadings(note, NAMES)

test('N1 English headings written another way become "## <name>"', () => {
  const forms = [name => `**${name}**`, name => `**${name}:**`, name => `**${name}**:`, name => `__${name}__`,
    (name, n) => `## ${n + 1}. ${name}`, (name, n) => `**${n + 1}) ${name}**`, (name, n) => `### ${n + 1}. ${name}:`,
    name => `## ${name.toUpperCase()}`, name => `  # ${name} ##`]
  for (const form of forms) {
    const out = tolerantHeadings(noteWith(form), NAMES)
    assert.equal(out, CANONICAL, form('Goals', 0))
  }
  // A shape the note check already takes ("### Goals") comes back as written.
  const level3 = noteWith(name => `### ${name}`)
  assert.deepEqual(missing(level3), [])
  assert.equal(tolerantHeadings(level3, NAMES), level3)
})

test('N1 a canonical note, and a passing note with a heading-like line in a fence, are byte-equal', () => {
  assert.equal(tolerantHeadings(CANONICAL, NAMES), CANONICAL)
  const fenced = CANONICAL.replace('- about facts to keep', '- about facts to keep\n```\n# Progress\n**Goals**\n```')
  assert.equal(missing(fenced).length, 0)
  assert.equal(tolerantHeadings(fenced, NAMES), fenced)
  // A fence is never rewritten, even when the note needs the parse.
  const bold = noteWith(name => `**${name}**`).replace('- about decisions', '- about decisions\n~~~\n## Goals\n**Progress**\n~~~')
  const out = tolerantHeadings(bold, NAMES)
  assert.equal(missing(out).length, 0)
  assert.match(out, /\n~~~\n## Goals\n\*\*Progress\*\*\n~~~\n/)
})

test('N1 an English note with a title and an extra heading in the middle keeps every section', () => {
  const note = `# Handoff note\n${noteWith(name => `**${name}**`, NAMES, n => (n === 3 ? ['### Side remark', '- x'] : []))}`
  const out = tolerantHeadings(note, NAMES)
  assert.deepEqual(missing(out), [])
  assert.match(out, /^# Handoff note\n## Goals\n/)
  assert.match(out, /\n### Side remark\n- x\n/)
})

test('N1 translated headings: in order, with a title that has no body, or as the one bold group', () => {
  const expected = CANONICAL
  assert.equal(tolerantHeadings(translated(), NAMES), expected)
  // The repro shape: a title with no body right before the first section.
  assert.equal(tolerantHeadings(`## Nota de passagem\n\n${translated()}`, NAMES), `## Nota de passagem\n\n${expected}`)
  // Today's accepted shape: 8 "##" sections with whole-bold lines in their bodies.
  const labelled = translated(undefined, boldLabel)
  assert.equal(tolerantHeadings(labelled, NAMES), noteWith(name => `## ${name}`, NAMES, boldLabel))
  // 8 bold headings and no "#" at all; and under a "#" title.
  assert.equal(tolerantHeadings(translated(name => `**${name}**`), NAMES), expected)
  assert.equal(tolerantHeadings(`# Nota\n${translated(name => `**${name}**`)}`, NAMES), `# Nota\n${expected}`)
  // A "##" title with no body, 8 "##" sections and 8 bold body labels: the "##" group.
  assert.equal(tolerantHeadings(`## Nota\n${translated(undefined, boldLabel)}`, NAMES),
    `## Nota\n${noteWith(name => `## ${name}`, NAMES, boldLabel)}`)
  // 8 "###" sections with 8 bold body labels: the "###" group.
  assert.equal(tolerantHeadings(translated(name => `### ${name}`, boldLabel), NAMES), noteWith(name => `## ${name}`, NAMES, boldLabel))
})

test('N1 any other shape is left as it is: the sections it lacks are still reported', () => {
  const unchanged = [
    // A trailing extra heading, no title.
    `${translated()}\n## Notas\n- x`,
    // A first heading that has a body, then the 8 sections.
    `## Nota de passagem\nTexto.\n\n${translated()}`,
    // A first "##" with a body, then 8 "##" sections each with a bold label.
    `## Intro\n- body\n${translated(undefined, boldLabel)}`,
    // 7 "##" sections with 8 bold body labels (one extra in Progress): no shifted carry.
    noteWith(name => `## ${name}`, PT.filter((_, n) => n !== 4), n => (n === 2 ? ['**Feito:**', '**Bloqueado:**'] : [`**Rótulo ${n}:**`])),
    // 7 "##" sections with 8 "###" sub-headings.
    noteWith(name => `## ${name}`, PT.filter((_, n) => n !== 4), n => (n === 2 ? ['### a', '### b'] : [`### c${n}`])),
  ]
  for (const note of unchanged) {
    assert.equal(tolerantHeadings(note, NAMES), note)
    assert.ok(missing(note).length > 0)
  }
  // A known name out of its place: only the English rewrite, no shifted carry.
  const swapped = translated().replace('## Objetivos', '## Progress').replace('## Progresso', '## Objetivos')
  const out = tolerantHeadings(swapped, NAMES)
  assert.equal(out, swapped)
  assert.deepEqual(missing(out), NAMES.filter(name => name !== 'Progress'))
})

test('N1 a bullet with a bold label is never a heading', () => {
  const note = noteWith(name => `**${name}**`, NAMES, n => (n === 2 ? ['- **Done:** x', '- **Blocked:** y'] : []))
  const out = tolerantHeadings(note, NAMES)
  assert.deepEqual(missing(out), [])
  assert.match(out, /\n- \*\*Done:\*\* x\n- \*\*Blocked:\*\* y\n/)
})

test('N1 missingHeadings answers as the old pattern did', () => {
  const matches = (note, expected) => assert.deepEqual(missingHeadings(note, ['X']), expected ? [] : ['X'], JSON.stringify(note))
  for (const note of ['# X', '## X:', '#### X :  ', '#X', '# x', '#\nX', '# X\n:\n']) matches(note, true)
  for (const note of ['##### X', '# X x']) matches(note, false)
})

test('N1 a 100,000-character line is parsed in linear time', () => {
  const spaces = ' '.repeat(100_000)
  for (const line of [`# Goals${spaces}x`, `**${spaces}x`, `**${spaces}x**`, `**x${spaces}y**`]) {
    for (const run of [() => tolerantHeadings(line, NAMES), () => missingHeadings(line, NAMES)]) {
      const at = performance.now()
      run()
      const took = performance.now() - at
      assert.ok(took < 200, `${JSON.stringify(line.slice(0, 12))}: ${took.toFixed(1)} ms`)
    }
  }
})
