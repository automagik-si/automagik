// Which exact connector builds may take a native session back after a restart (continuity.js).
// An advertised `session/resume` is not enough (docs/research/t3-code-acp-integration.md,
// recommendation 2): a route is qualified only by a run of the real connector and CLI that
// proved, in a throwaway home, that the session comes back on a new process with a fresh bridge,
// the old credential refused and the agent remembering what only its own history held
// (test/real-backend.test.js, run by scripts/acp-qualify.mjs). The record is per exact tuple:
//
//   <AUTOMAGIK_HOME>/acp-continuity.json
//   { v: 1, entries: [{ route, adapter: { name, version }, cli: { version }, platform,
//                       policy: 'bridged', backend, method: 'resume', qualifiedAt, phases }] }
//
// `backend` says what the run talked to: `loopback-stub` is the synthetic model backend (no
// account); a signed-in run would say so. The app takes a native session back only when its
// `continuity` setting is `qualified` (off by default) AND the launched route, adapter version,
// CLI version and platform equal one entry. Anything else, an unreadable file included, is the
// fresh session it always was. `revoke` removes entries; the same tuple qualified again
// replaces its entry, so a re-run changes nothing but its time.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const QUALIFICATION_FILE = 'acp-continuity.json'
export const REQUIRED_PHASES = Object.freeze(['session', 'prompt', 'toolApproval', 'reattach', 'continuity'])
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

export const qualificationPath = home => join(home, QUALIFICATION_FILE)

/** The CLI's version out of its `--version` line ("2.1.332 (Claude Code)", "codex-cli 0.170.0"). */
export function cliVersionOf(line) {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(line ?? ''))?.[1]
}

const tupleKey = entry => JSON.stringify([entry.route, entry.adapter?.name, entry.adapter?.version, entry.cli?.version, entry.platform, entry.policy])

/** The entries on disk, or [] for a missing or unreadable file (fails closed). */
export function readQualification(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data?.v !== 1 || !Array.isArray(data.entries)) return []
    return data.entries.filter(entry => typeof entry?.route === 'string' && VERSION.test(entry?.adapter?.version ?? '')
      && VERSION.test(entry?.cli?.version ?? '') && typeof entry.platform === 'string' && entry.policy === 'bridged' && entry.method === 'resume')
  } catch {
    return []
  }
}

function write(file, entries) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify({ v: 1, entries }, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * The qualification a run's receipts make, or `{ refused }` with the phases that did not pass.
 * Receipts are acp-receipts.mjs records of one route and launched tuple.
 */
export function qualificationOf(receipts, { route, backend, now = () => new Date().toISOString() }) {
  const mine = receipts.filter(receipt => receipt.route === route && receipt.scenario === 'synthetic-backend')
  if (mine.length === 0) return { refused: ['no receipt'] }
  const tuple = mine[0]
  if (mine.some(receipt => receipt.adapter?.version !== tuple.adapter?.version || receipt.cli?.version !== tuple.cli?.version)) return { refused: ['mixed tuples'] }
  const phases = Object.assign({}, ...mine.map(receipt => receipt.phases))
  const missing = REQUIRED_PHASES.filter(phase => phases[phase] !== 'passed')
  const cli = cliVersionOf(tuple.cli?.version)
  if (!VERSION.test(tuple.adapter?.version ?? '')) missing.push('adapter version')
  if (cli === undefined) missing.push('cli version')
  if (missing.length > 0) return { refused: missing }
  return {
    entry: {
      route, adapter: { name: tuple.adapter.name, version: tuple.adapter.version }, cli: { version: cli }, platform: tuple.platform,
      policy: 'bridged', backend: backend ?? tuple.backend ?? 'unknown', method: 'resume', qualifiedAt: now(), phases,
    },
  }
}

/** Adds (or replaces, for the same tuple) one entry. */
export function recordQualification(file, entry) {
  const entries = readQualification(file).filter(held => tupleKey(held) !== tupleKey(entry))
  write(file, [...entries, entry])
  return entry
}

/** Removes the entries of `route` (all of them, or one adapter version's); answers how many went. */
export function revokeQualification(file, { route, adapterVersion } = {}) {
  const entries = readQualification(file)
  const kept = entries.filter(entry => !(entry.route === route && (adapterVersion === undefined || entry.adapter.version === adapterVersion)))
  if (kept.length !== entries.length) write(file, kept)
  return entries.length - kept.length
}

/**
 * The continuity a launch gets: `{ methods: ['resume'] }` when the setting is `qualified` and
 * one entry equals this exact tuple, else undefined.
 */
export function continuityFor(entries, { setting, route, adapterVersion, cliVersion, platform = `${process.platform}-${process.arch}` }) {
  if (setting !== 'qualified' || adapterVersion === undefined || cliVersion === undefined) return undefined
  const held = entries.find(entry => entry.route === route && entry.adapter.version === adapterVersion && entry.cli.version === cliVersion && entry.platform === platform)
  return held === undefined ? undefined : { methods: ['resume'] }
}
