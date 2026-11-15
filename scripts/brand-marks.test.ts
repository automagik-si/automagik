// docs/brand's rules on marks, where agents read them: the triskle is Automagik's alone, the
// Genie and Omni lockups that carry it are retired and stay as files, and Genie, Omni and Mykes
// each show with their own approved mark, whose files are byte copies of the handed-over ones.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const at = (path: string) => new URL(`../${path}`, import.meta.url)
const read = (path: string) => readFileSync(at(path), 'utf8')
const flat = (path: string) => read(path).replace(/\s+/g, ' ')
const section = (text: string, title: string) => text.split(`\n## ${title}\n`)[1]?.split('\n## ')[0] ?? ''

const README = 'docs/brand/README.md'
const LOGO = 'docs/brand/logo/README.md'
const SKILL = '.claude/skills/automagik-brand/SKILL.md'
const rules = section(read(README), 'The rules')
const rows = section(read(README), 'Which logo file').split('\n').filter(line => line.startsWith('| '))
// The lines of a text that name both retired sets of files.
const naming = (path: string) => read(path).split('\n').filter(line => line.includes('genie-lockup-*') && line.includes('omni-lockup-*'))

describe("docs/brand's marks", () => {
  test("the triskle is Automagik's alone: the rules, the logo's note and the skill say so", () => {
    expect(rules).toContain("1. **The triskle is Automagik's mark, and Automagik's alone.** Genie, Omni and Mykes do not carry it")
    expect(rules).not.toContain('all carry the same mark')
    expect(rules).toContain("2. **Automagik's triskle is always in colour.**")
    expect(read(LOGO).split('\n')[2]).toStartWith("The triskle is Automagik's mark, and Automagik's alone.")
    expect(flat(SKILL)).toContain("The triskle is Automagik's mark alone. Genie, Omni and Mykes do not carry it")
  })

  test('the Genie and Omni lockups are retired in the README, the logo note and the skill, and the files stay', () => {
    for (const path of [README, LOGO, SKILL]) {
      const parts = naming(path)
      expect([path, parts.length > 0, parts.every(part => part.includes('RETIRED'))]).toEqual([path, true, true])
    }
    for (const name of ['genie', 'omni']) {
      for (const kind of ['three-colours-ink', 'three-colours-cream', 'ink', 'cream']) {
        for (const size of ['', '-header']) {
          const file = `docs/brand/logo/lockups/${name}-lockup-${kind}${size}.svg`
          expect([file, existsSync(at(file))]).toEqual([file, true])
        }
      }
    }
  })

  test('"Which logo file" sends each product to its own lockup, and to a triskle lockup only to say it is retired', () => {
    for (const row of rows) if (/(genie|omni|mykes)-lockup/.test(row)) expect(row).toContain('RETIRED')
    const row = (start: string) => rows.find(line => line.startsWith(`| ${start} |`)) ?? ''
    expect(row('Genie')).toContain('`logo/lockups/genie-lamp-lockup-ink.svg`')
    expect(row('Omni, in a header or anywhere under about 56px high')).toContain('`logo/lockups/omni-mark-lockup-ink-header.svg`')
    expect(row('Omni, 56px high or more')).toContain('`logo/lockups/omni-mark-lockup-ink.svg`')
    expect(row('Mykes')).toContain('`logo/lockups/mykes-clean-lockup-ink.svg`')
    expect(row("Omni's mark alone under about 56px")).toContain('`logo/svg/omni-mark-ink-32.svg`')
    for (const mark of ['genie-lamp', 'omni-mark', 'mykes-clean']) {
      expect(row("Genie's, Omni's or Mykes's mark alone")).toContain(`\`logo/svg/${mark}-ink.svg\``)
    }
    // Every file the table names is here.
    for (const [, path] of rows.join('\n').matchAll(/`((?:logo|favicon)\/[^`*<]+\.(?:svg|ico|png))`/g)) {
      expect([path, existsSync(at(`docs/brand/${path}`))]).toEqual([path, true])
    }
    for (const name of ['genie', 'omni']) expect(row("Genie's or Omni's name without the mark")).toContain(`\`logo/wordmark/${name}-wordmark-ink.svg\``)
    for (const name of ['genie', 'omni']) {
      for (const tone of ['ink', 'cream']) {
        const file = `docs/brand/logo/wordmark/${name}-wordmark-${tone}.svg`
        expect([file, existsSync(at(file))]).toEqual([file, true])
      }
    }
  })

  test('the two later rules are written: a flat one-colour mark, approved for the three, and a product with its own mark', () => {
    expect(rules).toContain("9. **Every mark that is not Automagik's is flat and one colour.** The sparkle of its word is its only colour")
    expect(rules).toContain("Genie's mark is a flat lamp, Omni's is a tentacle vortex and Mykes's is the cords")
    expect(rules).toContain('The owner approved the lamp and the vortex on 12 November 2026 and confirmed it on 13 November 2026, in his words: "Yes, I approved them".')
    expect(rules).toContain('the owner picked the redrawn Mykes drawing on 13 November 2026. None carries the triskle.')
    expect(rules).toContain('10. **A product shows as its own mark with its word.** Genie, Omni and Mykes each have a lockup')
    expect(rules).toContain('ended for the three with the approval in rule 9')
    expect(rules).toContain('the plain words "Coming soon." stand')
    expect(rules).toContain('never the triskle, never a pet, never another drawing')
    // The word-only rule is gone from every place an agent reads.
    for (const path of [README, LOGO, SKILL]) {
      for (const old of ['Until the owner approves its mark', 'show as their word', 'a product shows as its word', 'with no mark beside it', 'None is approved', 'neither is drawn or approved']) {
        expect([path, old, flat(path).includes(old)]).toEqual([path, old, false])
      }
    }
    expect(flat(SKILL)).toContain('Genie, Omni and Mykes each have their own mark: a flat lamp, a tentacle vortex, the cords.')
    // No text an agent reads calls Mykes's mark the other drawing, except to say that one is not here.
    for (const path of [README, SKILL]) expect([path, /clean forks|forks/i.test(read(path))]).toEqual([path, false])
    expect(read(LOGO).split('\n').filter(line => /forks/i.test(line))).toEqual([expect.stringContaining('("clean forks", 219.77 wide), which is not here')])
    expect(flat(SKILL)).toContain('flat and one colour, with its word\'s sparkle as the only colour')
  })

  test("Genie's, Omni's and Mykes's files are byte copies: each has the sha256 the logo note records", () => {
    const record = section(read(LOGO), "Where Genie's, Omni's and Mykes's files came from")
    const listed = [...record.matchAll(/^\| `((?:svg|lockups)\/[^`]+\.svg)` \| `[^`]+` \| `([0-9a-f]{64})` \|$/gm)]
    expect(listed.map(([, path]) => path).sort()).toEqual(
      [
        ...['genie-lamp', 'omni-mark', 'mykes-clean'].flatMap(mark => ['ink', 'cream'].flatMap(tone => [`svg/${mark}-${tone}.svg`, `lockups/${mark}-lockup-${tone}.svg`])),
        ...['ink', 'cream'].flatMap(tone => [`svg/omni-mark-${tone}-32.svg`, `lockups/omni-mark-lockup-${tone}-header.svg`]),
      ].sort(),
    )
    for (const [, path, sha256] of listed) {
      const bytes = readFileSync(at(`docs/brand/logo/${path}`))
      expect([path, createHash('sha256').update(bytes).digest('hex')]).toEqual([path, sha256])
    }
  })

  test("the triskle's two small pictures are the ones the logo note records: 64 and 128 pixels square, by sha256", () => {
    const listed = [...read(LOGO).matchAll(/^ *\| `(png\/[^`]+\.png)` \| `svg\/triskle-three-colours-32\.svg`, (\d+)px high \| `([0-9a-f]{64})` \|$/gm)]
    expect(listed.map(([, path, size]) => [path, size])).toEqual([
      ['png/triskle-three-colours-64.png', '64'],
      ['png/triskle-three-colours-128.png', '128'],
    ])
    for (const [, path, size, sha256] of listed) {
      const bytes = readFileSync(at(`docs/brand/logo/${path}`))
      // A PNG's header: its width and height are the two numbers after "IHDR".
      expect([path, bytes.subarray(12, 16).toString('latin1'), bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([path, 'IHDR', Number(size), Number(size)])
      expect([path, createHash('sha256').update(bytes).digest('hex')]).toEqual([path, sha256])
      expect(read(README)).toContain(`\`logo/${path}\``)
    }
  })

  test("Omni's files are the vortex on curves: the same count of shapes, one outline in the marks and their lockups", () => {
    const outline = (path: string) => / d="([^"]+)"/.exec(read(path))?.[1] ?? ''
    for (const [size, lockup, shapes] of [['', '', 48], ['-32', '-header', 8]] as const) {
      const ink = outline(`docs/brand/logo/svg/omni-mark-ink${size}.svg`)
      expect([size, ink.match(/M/g)?.length, ink.match(/Z/g)?.length, /c/.test(ink), /L/.test(ink)]).toEqual([size, shapes, shapes, true, false])
      for (const tone of ['ink', 'cream']) {
        for (const file of [`svg/omni-mark-${tone}${size}.svg`, `lockups/omni-mark-lockup-${tone}${lockup}.svg`]) {
          expect([file, outline(`docs/brand/logo/${file}`) === ink]).toEqual([file, true])
        }
      }
    }
    const note = section(read(LOGO), "Omni's vortex on curves")
    expect(note).toContain('the same drawing as the one first handed over, with its outline written on curves')
    expect(note).toContain('0.9996 (the large drawing) and 0.9977 (the small drawing)')
  })

  test("the lockup's 28px floor has one exception: 24px in the family drawer's phone layout", () => {
    const notes = section(read(README), 'Which logo file')
    expect(notes).toContain('- Do not set the lockup under 28px high.')
    expect(notes).toContain("One exception: lockups may be set at 24px in the family drawer's phone layout (480px wide and under), as in the drawer the owner approved. The 28px floor stands everywhere else.")
  })

  test("Mykes's mark is the redrawn drawing the owner picked: its frame is 219.93 wide and its outline has straight lines", () => {
    for (const tone of ['ink', 'cream']) {
      const svg = read(`docs/brand/logo/svg/mykes-clean-${tone}.svg`)
      const outline = / d="([^"]+)"/.exec(svg)?.[1] ?? ''
      expect([tone, /viewBox="([^"]+)"/.exec(svg)?.[1], outline.match(/L/g)?.length]).toEqual([tone, '0 -186.24 219.93 222.42', 24])
    }
  })

  test('each of the three marks is one flat shape in one colour, and its lockup adds only the sparkle and never the triskle', () => {
    const tones = { ink: '#3c3049', cream: '#f3e9dd' }
    const sparkle: Record<string, string[]> = { 'genie-lamp': ['#ee5496'], 'omni-mark': ['#15bde0'], 'mykes-clean': [] }
    const colours = (svg: string) => [...new Set([...svg.matchAll(/(?:fill|stroke|color|stop-color)="([^"]+)"/g)].map(([, value]) => value))].sort()
    for (const [tone, colour] of Object.entries(tones)) {
      for (const mark of ['genie-lamp', 'omni-mark', 'mykes-clean']) {
        for (const size of mark === 'omni-mark' ? ['', '-32'] : ['']) {
          const svg = read(`docs/brand/logo/svg/${mark}-${tone}${size}.svg`)
          expect([mark, tone, size, colours(svg), svg.match(/<path/g)?.length]).toEqual([mark, tone, size, [colour], 1])
          expect(/<(mask|filter|linearGradient|radialGradient|image|script|use)\b|opacity/.test(svg)).toBe(false)
        }
        for (const size of mark === 'omni-mark' ? ['', '-header'] : ['']) {
          const svg = read(`docs/brand/logo/lockups/${mark}-lockup-${tone}${size}.svg`)
          expect([mark, tone, size, colours(svg)]).toEqual([mark, tone, size, [colour, 'currentColor', ...sparkle[mark]].sort()])
          expect(/<(mask|filter|linearGradient|radialGradient|image|script|use)\b|opacity/.test(svg)).toBe(false)
          expect(/viewBox="0 -186 [0-9.]+ 264"/.test(svg)).toBe(true)
        }
      }
    }
  })
})
