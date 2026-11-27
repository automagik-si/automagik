// Compatibility receipts (docs/research/t3-code-acp-integration.md recommendation 1): what the
// process that launched an adapter saw, phase by phase, written where ACP_RECEIPT_DIR says.
// `acp-drift.mjs --record --receipts <dir>` builds dev/acp-compat.json from them, so the record
// names the versions that actually ran and how far each got, never npm's latest at record time.
//
// One receipt per route and scenario:
//   { v, route, scenario, sdk, adapter: { name, version }, cli: { version }, agentInfo,
//     platform, node, advertised, phases: { <phase>: <outcome> }, at }
// scenario: 'synthetic-replay' (the fake agent, deterministic), 'real-unprompted' (a real
// adapter and CLI in a throwaway home, never sent a prompt, so no account is used) or
// 'real-signed-in' (never written by this repository's tests). An unprompted run can prove the
// handshake, the session start (or that it stops at auth_required) and `reattach`: whether a
// closed session comes back by resume and binds a fresh bridge. Everything a prompt is needed
// for stays 'unverified', and a session the adapter opens with no sign-in is
// 'opened-not-exercised' when nothing more was checked on it.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RECEIPT_VERSION = 1
export const SCENARIOS = new Set(['synthetic-replay', 'real-unprompted', 'real-signed-in'])
export const OUTCOMES = new Set(['passed', 'failed', 'auth-required', 'unverified', 'skipped', 'refused', 'opened-not-exercised'])
// The phases of a turn a person cares about, in order. A receipt names each one. `reattach` is
// the session coming back with a fresh bridge; `continuity` is the agent remembering across it.
export const PHASES = ['initialize', 'session', 'reattach', 'prompt', 'toolApproval', 'stop', 'recovery', 'continuity', 'plan', 'usage']
const UNPROMPTED_PROVABLE = new Set(['initialize', 'session', 'reattach'])

/** A receipt's problems, or [] when it is whole. */
export function receiptProblems(receipt) {
  const problems = []
  if (receipt?.v !== RECEIPT_VERSION) problems.push('not a version 1 receipt')
  if (typeof receipt?.route !== 'string' || receipt.route === '') problems.push('no route')
  if (!SCENARIOS.has(receipt?.scenario)) problems.push(`unknown scenario ${receipt?.scenario}`)
  if (typeof receipt?.sdk !== 'string') problems.push('no SDK version')
  for (const phase of PHASES) {
    if (!OUTCOMES.has(receipt?.phases?.[phase])) problems.push(`phase ${phase} has no outcome`)
  }
  if (receipt?.scenario === 'real-unprompted') {
    if (typeof receipt.adapter?.version !== 'string' || receipt.adapter.version === 'unknown') problems.push('a real run names no adapter version')
    // No prompt was sent: nothing a prompt proves can have passed.
    for (const phase of PHASES) {
      if (!UNPROMPTED_PROVABLE.has(phase) && receipt.phases?.[phase] === 'passed') problems.push(`an unprompted run cannot pass ${phase}`)
    }
  }
  return problems
}

/** The receipt with every phase it does not name marked unverified. */
export function completeReceipt(receipt) {
  return { v: RECEIPT_VERSION, ...receipt, phases: Object.fromEntries(PHASES.map(phase => [phase, receipt.phases?.[phase] ?? 'unverified'])), at: receipt.at ?? new Date().toISOString() }
}

/** Write (or merge into) the receipt of one route and scenario. No directory, no receipt. */
export function writeReceipt(dir, receipt) {
  if (typeof dir !== 'string' || dir === '') return undefined
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${receipt.route}.${receipt.scenario}.json`)
  let held = {}
  try { held = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const merged = completeReceipt({ ...held, ...receipt, phases: { ...held.phases, ...receipt.phases }, advertised: { ...held.advertised, ...receipt.advertised } })
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/** Every receipt in `dir`, with its problems. */
export function readReceipts(dir) {
  let names = []
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort() } catch { return [] }
  return names.map((name) => {
    let receipt
    try { receipt = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return { name, receipt: undefined, problems: ['unreadable'] } }
    return { name, receipt, problems: receiptProblems(receipt) }
  })
}
