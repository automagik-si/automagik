// node --test chat/dialog.test.mjs: input rows and approval dialogs read from the screen.
// fixtures/screens/ are synthetic, rebuilt from recordings' layouts (Claude Code, Codex, omp,
// 2026-11-03) with no recorded content.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BOTTOM_ROWS, readDialog, readInput, statusTool } from './dialog.js'

const screen = (name) => readFileSync(new URL(`./fixtures/screens/${name}.txt`, import.meta.url), 'utf8')

test('an empty input row, its placeholder included, reads as empty for each agent', () => {
  for (const agent of ['claude', 'codex', 'omp']) {
    assert.deepEqual(readInput(agent, screen(`${agent}-idle`)), { found: true, draft: '' }, agent)
  }
  // Claude's placeholder rotates; any `Try "…"` is one.
  assert.deepEqual(readInput('claude', screen('claude-idle').replace('how does <filepath> work?', 'fix typecheck errors')), { found: true, draft: '' })
})

test('a half-typed draft is read as a draft for each agent', () => {
  for (const agent of ['claude', 'codex', 'omp']) {
    assert.deepEqual(readInput(agent, screen(`${agent}-draft`)), { found: true, draft: 'half typed words' }, agent)
  }
})

test('an earlier message in the history is not the input row', () => {
  // Claude and Codex draw past messages with the same prompt mark; only the bottom input row counts.
  assert.equal(readInput('claude', screen('claude-idle')).draft, '')
  assert.equal(readInput('codex', screen('codex-idle')).draft, '')
})

test('an input row that cannot be seen is not found (the sender then holds the message)', () => {
  assert.deepEqual(readInput('claude', screen('claude-dialog')), { found: false })
  assert.deepEqual(readInput('omp', 'output with no input row\n'), { found: false })
  assert.deepEqual(readInput('codex', ''), { found: false })
  assert.deepEqual(readInput('gemini', screen('claude-idle')), { found: false })
  // omp: a tool box's bottom border is not the input row.
  assert.deepEqual(readInput('omp', '╭─── bash\n│ x\n╰─── Wall: 0.01s ─────\n'), { found: false })
})

test("Claude's approval dialog at the bottom: tool, command and options", () => {
  assert.deepEqual(readDialog('claude', screen('claude-dialog')), {
    kind: 'permission', tool: 'Bash', command: 'ls -la /home/u/proj',
    options: ['Yes', 'Yes, and don’t ask again for: ls *', 'Yes, and switch to auto mode', 'No']
  })
})

test('a dialog with anything drawn after its footer is not the live one (a fake one mid-screen)', () => {
  const printed = `${screen('claude-dialog')}⏺ More output after the dialog.\n`
  assert.equal(readDialog('claude', printed), null)
  const thenIdle = screen('claude-dialog') + screen('claude-idle')
  assert.equal(readDialog('claude', thenIdle), null)
})

test('a dialog higher than the bottom rows read is not taken', () => {
  const pushedUp = screen('claude-dialog').replace(' Bash command', ` Bash command\n${'filler\n'.repeat(BOTTOM_ROWS)}`)
  assert.equal(readDialog('claude', pushedUp), null)
})

test('a broken layout gets no dialog: no rule, no command, one option, no question', () => {
  const d = screen('claude-dialog')
  assert.equal(readDialog('claude', d.replace(/─{8,}/, 'not a rule')), null)
  assert.equal(readDialog('claude', d.replaceAll(/╌{8,}/g, '')), null)
  assert.equal(readDialog('claude', d.replace(/ {3}2\..*\n {3}3\..*\n {3}4\..*\n/, '')), null)
  assert.equal(readDialog('claude', d.replace('Do you want to proceed?', 'Something else')), null)
})

test('Codex and omp have no dialog reader: no buttons, whatever the screen shows', () => {
  assert.equal(readDialog('codex', screen('claude-dialog')), null)
  assert.equal(readDialog('omp', screen('claude-dialog')), null)
})

test('the tool a blocked Claude names in its status message', () => {
  assert.equal(statusTool('approve Bash: ls -la /home/u/proj'), 'Bash')
  assert.equal(statusTool('approve mcp__srv__tool: x'), 'mcp__srv__tool')
  assert.equal(statusTool('Thinking'), null)
  assert.equal(statusTool(null), null)
})

test('a dialog without its footer as the last row is not taken (printed options alone)', () => {
  const noFooter = screen('claude-dialog').replace(' Esc to cancel · Tab to amend\n', '')
  assert.equal(readDialog('claude', noFooter), null)
})

test('the recorded layout exactly: two dashed rules, and Yes first', () => {
  const d = screen('claude-dialog')
  const three = d.replace(' This command requires approval', ` ${'╌'.repeat(40)}\n This command requires approval`)
  assert.equal(readDialog('claude', three), null, 'a third dashed rule')
  const notYes = d.replace(' ❯ 1. Yes', ' ❯ 1. No').replace('   4. No', '   4. Yes')
  assert.equal(readDialog('claude', notYes), null, 'option 1 is not Yes')
})

test('a long option wrapped onto an indented line is read as one option (recorded)', () => {
  const wrapped = screen('claude-dialog').replace('   2. Yes, and don’t ask again for: ls *\n', '   2. Yes, and always allow access to /home/u/proj\n      from this project\n')
  assert.deepEqual(readDialog('claude', wrapped)?.options, ['Yes', 'Yes, and always allow access to /home/u/proj from this project', 'Yes, and switch to auto mode', 'No'])
})

test('anything but options between the question and the footer: no dialog', () => {
  const d = screen('claude-dialog')
  assert.equal(readDialog('claude', d.replace('   3. Yes, and switch to auto mode\n', 'unindented text\n')), null)
  assert.equal(readDialog('claude', d.replace(' ❯ 1. Yes\n', '   from nothing\n ❯ 1. Yes\n')), null, 'a continuation line with no option above it')
})
