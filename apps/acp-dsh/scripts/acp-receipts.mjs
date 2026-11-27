// Compatibility receipts (docs/research/t3-code-acp-integration.md recommendation 1): what the
// process that launched an adapter saw, phase by phase, written where ACP_RECEIPT_DIR says.
// `acp-drift.mjs --record --receipts <dir>` builds dev/acp-compat.json from them, so the record
// names the versions that actually ran and how far each got, never npm's latest at record time.
//
// One receipt per route and scenario:
//   { v, route, scenario, sdk, adapter: { name, version }, cli: { version }, agentInfo,
//     platform, node, backend?, run?, advertised, phases: { <phase>: <outcome> }, at }
// Several test files (and processes) write phases of one receipt: each write merges under a lock
// beside the file, and only into a receipt of the same launch identity (SDK, adapter, CLI,
// platform, Node, backend and `run`, ACP_RECEIPT_RUN): a receipt left by another launch or run
// is replaced, never topped up, so its phases never stand for this one.
// scenario: 'synthetic-replay' (the fake agent, deterministic), 'real-unprompted' (a real
// adapter and CLI in a throwaway home, never sent a prompt, so no account is used) or
// 'real-signed-in' (never written by this repository's tests). An unprompted run can prove the
// handshake, the session start (or that it stops at auth_required) and `reattach`: whether a
// closed session comes back by resume and binds a fresh bridge. Everything a prompt is needed
// for stays 'unverified', and a session the adapter opens with no sign-in is
// 'opened-not-exercised' when nothing more was checked on it. 'synthetic-backend' is the real
// adapter and CLI on the loopback model stub (dev/model-stub.mjs, test/real-backend.test.js):
// everything runs for real but the model, so it names its `backend` and never stands for a
// signed-in run.
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RECEIPT_VERSION = 1
export const SCENARIOS = new Set(['synthetic-replay', 'real-unprompted', 'synthetic-backend', 'real-signed-in'])
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
  if (receipt?.scenario === 'synthetic-backend' && (typeof receipt.backend !== 'string' || receipt.backend === '')) problems.push('a synthetic-backend run names no backend')
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

/** What makes two receipts the same launch: phases merge only between equal identities. */
export function launchIdentity(receipt) {
  const text = value => (value === undefined || value === null ? null : value)
  return JSON.stringify([receipt?.sdk, text(receipt?.adapter?.name), text(receipt?.adapter?.version), text(receipt?.cli?.version), receipt?.platform, receipt?.node, text(receipt?.backend), text(receipt?.run)].map(text))
}

const LOCK_WAIT_MS = 10_000
// A lock older than this belongs to a writer that died holding it (a write takes milliseconds).
const LOCK_STALE_MS = 30_000
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Runs `body` holding `lock` (a file made exclusively): bounded, and a dead writer's lock is broken. */
export function withLock(lock, body, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, now = Date.now } = {}) {
  const until = now() + waitMs
  for (;;) {
    let fd
    try { fd = openSync(lock, 'wx') } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let age = 0
      try { age = now() - statSync(lock).mtimeMs } catch { continue }
      if (age > staleMs) { try { rmSync(lock, { force: true }) } catch {} continue }
      if (now() > until) throw new Error(`the receipt lock ${lock} is held: another writer has not let go in ${waitMs} ms`)
      pause(5)
      continue
    }
    try {
      writeFileSync(fd, String(process.pid))
      return body()
    } finally {
      closeSync(fd)
      rmSync(lock, { force: true })
    }
  }
}

/**
 * Write (or merge into) the receipt of one route and scenario. No directory, no receipt. The read,
 * merge and write hold the receipt's lock, and the file is replaced whole (rename), so concurrent
 * writers never lose each other's phases; a held receipt of another launch identity is replaced.
 */
export function writeReceipt(dir, receipt) {
  if (typeof dir !== 'string' || dir === '') return undefined
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${receipt.route}.${receipt.scenario}.json`)
  const run = receipt.run ?? (process.env.ACP_RECEIPT_RUN || undefined)
  const incoming = run === undefined ? receipt : { ...receipt, run }
  return withLock(`${file}.lock`, () => {
    let held = {}
    try { held = JSON.parse(readFileSync(file, 'utf8')) } catch {}
    if (launchIdentity(held) !== launchIdentity(incoming)) held = {}
    const merged = completeReceipt({ ...held, ...incoming, at: undefined, phases: { ...held.phases, ...incoming.phases }, advertised: { ...held.advertised, ...incoming.advertised } })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`)
    renameSync(temporary, file)
    return merged
  })
}

/** Every receipt in `dir`, with its problems. */
export function readReceipts(dir) {
  let names = []
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort() } catch { return [] }
  // (`.lock` and `.tmp` files of a writer are not receipts.)
  return names.map((name) => {
    let receipt
    try { receipt = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return { name, receipt: undefined, problems: ['unreadable'] } }
    return { name, receipt, problems: receiptProblems(receipt) }
  })
}
