// Reading an agent's input row and its approval dialog from the screen (RFC 0015, "Screen
// fallback" and "Input"). Ours, from recordings of Claude Code, Codex and omp (2026-11-03): the
// layouts below are what those versions draw. herdr-core's terminal.read is plain text, with no
// cursor and no styles, so only the bottom rows are read, and anything not recognized is read in
// the safe direction: an input row that cannot be told empty counts as a draft (the message is
// held, never typed over it), and a dialog not recognized gets no buttons ("Answer in the
// terminal").
//
// Input rows:   Claude `❯ <text>` between two `─` rules (empty: a `Try "…"` placeholder);
//               Codex `› <text>` (empty: a placeholder such as `Ask Codex to do anything`);
//               omp `╰─ <text>` (empty: `╰─` alone).
// Dialogs:      Claude only. At an approval it reports blocked/permission and draws, at the very
//               bottom: a `─` rule, a header (`Bash command`), the command between `╌` rules,
//               `Do you want to proceed?`, numbered options (`1. Yes` … `N. No`) and the footer
//               `Esc to cancel`. Codex and omp asked for nothing in the recordings: no reader.
import { stripScrollbackAnsi } from './screen.js'

/** How many rows from the bottom are read. A dialog or input row higher up is not taken. */
export const BOTTOM_ROWS = 40

const CLAUDE_PLACEHOLDER = /^Try ".*"$/
const CODEX_PLACEHOLDERS = new Set(['Ask Codex to do anything'])
const RULE = /^─{8,}$/
const DASHED = /^╌{8,}$/
const OPTION = /^(?:❯\s*)?(\d+)\.\s+(.+)$/

/** The screen's last BOTTOM_ROWS rows, ANSI-free and right-trimmed, with trailing blank rows dropped. */
export function bottomRows(text) {
  const rows = stripScrollbackAnsi(typeof text === 'string' ? text : '').split('\n').map((r) => r.replace(/\s+$/, ''))
  while (rows.length && rows.at(-1) === '') rows.pop()
  return rows.slice(-BOTTOM_ROWS)
}

/**
 * The input row: { found: true, draft: '' } when it is empty, { found: true, draft } when it holds
 * text the person typed, { found: false } when it cannot be seen (treated like a draft).
 * @param {string | null} agent  'claude' | 'codex' | 'omp'
 * @param {string} text          terminal.read's text
 * @returns {{ found: false } | { found: true, draft: string }}
 */
export function readInput(agent, text) {
  const rows = bottomRows(text)
  if (agent === 'claude') {
    for (let i = rows.length - 2; i >= 1; i--) {
      if (!rows[i].startsWith('❯') || !RULE.test(rows[i - 1].trim())) continue
      const lines = []
      for (let j = i; j < rows.length && !RULE.test(rows[j].trim()); j++) lines.push(j === i ? rows[j].replace(/^❯\s?/, '') : rows[j].trim())
      const draft = lines.join('\n').trim()
      return { found: true, draft: CLAUDE_PLACEHOLDER.test(draft) ? '' : draft }
    }
    return { found: false }
  }
  if (agent === 'codex') {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!rows[i].startsWith('›')) continue
      const draft = rows[i].replace(/^›\s?/, '').trim()
      return { found: true, draft: CODEX_PLACEHOLDERS.has(draft) ? '' : draft }
    }
    return { found: false }
  }
  if (agent === 'omp') {
    // The input row is the last row; a tool box's bottom (`╰───…`) is not it.
    const last = rows.at(-1) ?? ''
    if (/^╰─(?!─)/.test(last)) return { found: true, draft: last.replace(/^╰─/, '').trim() }
    return { found: false }
  }
  return { found: false }
}

/**
 * An approval dialog at the bottom of the screen, or null. Claude only (see above); the dialog
 * must end the screen: anything drawn after its footer means it is not the live one.
 * @returns {{ kind: 'permission', tool: string, command: string, options: string[] } | null}
 */
export function readDialog(agent, text) {
  if (agent !== 'claude') return null
  const rows = bottomRows(text)
  const footer = rows.length - 1
  if (footer < 0 || !rows[footer].trim().startsWith('Esc to cancel')) return null
  // The question, then only numbered options up to the footer. A long option wraps onto indented
  // lines under it (recorded: "Yes, and always allow access to <folder>" + "from this project").
  let i = footer - 1
  while (i >= 0 && !/^Do you want to /.test(rows[i].trim())) i--
  if (i < 0) return null
  const options = []
  for (const r of rows.slice(i + 1, footer)) {
    const m = r.trim().match(OPTION)
    if (m) options.push(m[2])
    else if (options.length && /^\s{3,}\S/.test(r) && !RULE.test(r.trim()) && !DASHED.test(r.trim())) options[options.length - 1] += ` ${r.trim()}`
    else return null
  }
  // As recorded: the first option is Yes (what `1` answers).
  if (options.length < 2 || options[0] !== 'Yes') return null
  // Up to the `─` rule that opens the dialog: the header follows it, the command sits between `╌` rules.
  let top = i
  while (top >= 0 && !RULE.test(rows[top].trim())) top--
  if (top < 0) return null
  const body = rows.slice(top + 1, i).map((r) => r.trim())
  const header = body.find((r) => r !== '') ?? ''
  const tool = header.split(/\s+/)[0] ?? ''
  // Exactly two dashed rules: the command between them. More or fewer is not the recorded layout.
  const dashed = body.flatMap((r, k) => (DASHED.test(r) ? [k] : []))
  if (!tool || dashed.length !== 2) return null
  const [open, close] = dashed
  const command = body.slice(open + 1, close).join(' ').replace(/\s+/g, ' ').trim()
  return { kind: 'permission', tool, command, options }
}

/** The tool a blocked Claude names in its status message (`approve Bash: …`), or null. */
export function statusTool(msg) {
  const m = typeof msg === 'string' ? /^approve ([A-Za-z0-9_.:-]+):/.exec(msg) : null
  return m ? m[1] : null
}
