// The ACP drift check (#958). The plugin pins `@agentclientprotocol/sdk` exactly, and the app
// installs the newest adapters at run time, so the pin can fall behind what the adapters are
// built on without anything failing. This reads npm's latest for the SDK and for each adapter
// and compares them with the pin and with dev/acp-compat.json, the record of the versions the
// suite last passed against.
//
//   node scripts/acp-drift.mjs            fail when the pin is more than one minor behind
//                                         npm's latest (a new major is always more); print
//                                         each adapter that moved past the record
//   node scripts/acp-drift.mjs --offline  no network: the record names the pin (the check CI
//                                         runs on every pull request)
//   node scripts/acp-drift.mjs --record   write the record's pin, keeping its adapters as they are
//   node scripts/acp-drift.mjs --record --receipts <dir>
//                                         write the record from the receipts the suite's own
//                                         launches wrote (ACP_RECEIPT_DIR, acp-receipts.mjs):
//                                         each adapter at the version that actually ran, with
//                                         its scenario and how far each phase got. npm's latest
//                                         is never written into the record.
//   node scripts/acp-drift.mjs --json     the report as JSON on stdout
//
// It exits 1 on drift, 2 when npm could not be read (not drift: the next run decides).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENTS } from '../src/host/agents.js'
import { readReceipts } from './acp-receipts.mjs'

const PLUGIN = resolve(import.meta.dirname, '..')
export const SDK = '@agentclientprotocol/sdk'
export const RECORD_PATH = join(PLUGIN, 'dev', 'acp-compat.json')
const REGISTRY = 'https://registry.npmjs.org'

/** `major.minor.patch` of an exact version, or undefined for anything else (a range, a tag). */
export function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''))
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * How far a pin is behind the latest release: `ok` within one minor of it, `behind` past that
 * or on an older major, `invalid` when either is not an exact version.
 * @returns {{ state: 'ok' | 'behind' | 'invalid', reason: string }}
 */
export function pinDrift(pin, latest) {
  const have = parse(pin)
  const newest = parse(latest)
  if (have === undefined) return { state: 'invalid', reason: `the pin "${pin}" is not an exact version` }
  if (newest === undefined) return { state: 'invalid', reason: `npm's latest "${latest}" is not a plain version` }
  if (newest.major > have.major) return { state: 'behind', reason: `the pin ${pin} is a major behind npm's latest ${latest}` }
  if (newest.major === have.major && newest.minor - have.minor > 1) {
    return { state: 'behind', reason: `the pin ${pin} is ${newest.minor - have.minor} minors behind npm's latest ${latest}` }
  }
  return { state: 'ok', reason: pin === latest ? `the pin ${pin} is npm's latest` : `the pin ${pin} is within one minor of npm's latest ${latest}` }
}

/** Whether `latest` is past `recorded` (major, then minor, then patch). */
export function isNewer(latest, recorded) {
  const a = parse(latest)
  const b = parse(recorded)
  if (a === undefined) return false
  if (b === undefined) return true
  return a.major !== b.major ? a.major > b.major : a.minor !== b.minor ? a.minor > b.minor : a.patch > b.patch
}

/** The adapter packages the app installs, from the agent table. */
export const adapterPackages = () => [...new Set(Object.values(AGENTS).map(agent => agent.adapter).filter(name => typeof name === 'string'))].sort()

export const readPin = (root = PLUGIN) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies?.[SDK]

export function readRecord(path = RECORD_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** npm's latest version of one package. */
export async function latestOf(name, fetcher = fetch) {
  const response = await fetcher(`${REGISTRY}/${name.replace('/', '%2F')}/latest`, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`npm answered ${response.status} for ${name}`)
  const version = (await response.json())?.version
  if (parse(version) === undefined) throw new Error(`npm named no plain version for ${name}`)
  return version
}

/**
 * The whole report: the pin against npm, the record against the pin, each adapter against the
 * record. `failures` is what makes the check fail; `notes` is what moved without failing it.
 */
export function report({ pin, record, latest }) {
  const failures = []
  const notes = []
  const sdk = pinDrift(pin, latest.sdk)
  if (sdk.state !== 'ok') failures.push(sdk.reason)
  else notes.push(sdk.reason)
  if (record === undefined) failures.push('dev/acp-compat.json is missing or unreadable')
  else if (record.sdk !== pin) failures.push(`dev/acp-compat.json records the suite passing on SDK ${record.sdk}, not the pin ${pin}`)
  const adapters = {}
  for (const [name, version] of Object.entries(latest.adapters)) {
    const recorded = record?.adapters?.[name]
    adapters[name] = { latest: version, recorded: recorded ?? null, moved: isNewer(version, recorded) }
    if (adapters[name].moved) notes.push(`${name} ${version} is newer than the ${recorded ?? 'nothing'} the suite last passed against`)
  }
  return { ok: failures.length === 0, pin, latest: latest.sdk, adapters, failures, notes }
}

/**
 * The record a set of receipts makes: the pin, each adapter at the version a real launch ran
 * (the receipt's own, from the launched package), and every receipt's phases. An adapter with no
 * real receipt keeps the version the old record had; a receipt with problems, or one for another
 * SDK, fails the record instead of being written.
 */
export function recordFromReceipts({ pin, previous, receipts, packages = adapterPackages(), today = new Date().toISOString().slice(0, 10) }) {
  const failures = []
  const adapters = { ...previous?.adapters }
  const kept = []
  for (const { name, receipt, problems } of receipts) {
    if (problems.length > 0) { failures.push(`${name}: ${problems.join('; ')}`); continue }
    if (receipt.sdk !== pin) { failures.push(`${name} ran on SDK ${receipt.sdk}, not the pin ${pin}`); continue }
    if (receipt.scenario !== 'synthetic-replay') {
      if (!packages.includes(receipt.adapter?.name)) { failures.push(`${name} names an adapter the app does not install`); continue }
      if (receipt.phases.initialize !== 'passed') { failures.push(`${name}: initialize did not pass`); continue }
      adapters[receipt.adapter.name] = receipt.adapter.version
    }
    kept.push({
      route: receipt.route, scenario: receipt.scenario,
      ...(receipt.backend === undefined ? {} : { backend: receipt.backend }),
      ...(receipt.adapter === undefined ? {} : { adapter: receipt.adapter }),
      ...(receipt.cli === undefined ? {} : { cli: receipt.cli }),
      platform: receipt.platform, node: receipt.node, phases: receipt.phases,
      ...(receipt.advertised === undefined ? {} : { advertised: receipt.advertised }),
    })
  }
  if (receipts.length === 0) failures.push('no receipts: run the suite with ACP_RECEIPT_DIR set')
  return { ok: failures.length === 0, failures, record: { sdk: pin, adapters, passed: today, receipts: kept } }
}

/** The offline half: the record exists, names the pin, and names every adapter the app installs. */
export function offline({ pin, record, packages = adapterPackages() }) {
  const failures = []
  if (parse(pin) === undefined) failures.push(`the pin "${pin}" is not an exact version`)
  if (record === undefined) failures.push('dev/acp-compat.json is missing or unreadable')
  else {
    if (record.sdk !== pin) failures.push(`dev/acp-compat.json records the suite passing on SDK ${record.sdk}, not the pin ${pin}: run the suite, then node scripts/acp-drift.mjs --record`)
    for (const name of packages) {
      if (parse(record.adapters?.[name]) === undefined) failures.push(`dev/acp-compat.json records no version for ${name}`)
    }
  }
  return { ok: failures.length === 0, pin, failures, notes: [] }
}

async function main(argv) {
  const json = argv.includes('--json')
  const pin = readPin()
  const print = (result) => {
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      for (const line of result.notes) console.log(`acp-drift: ${line}`)
      for (const line of result.failures) console.error(`acp-drift: ${line}`)
    }
    return result.ok ? 0 : 1
  }
  if (argv.includes('--offline')) return print(offline({ pin, record: readRecord() }))
  if (argv.includes('--record')) {
    const at = argv.indexOf('--receipts')
    const previous = readRecord()
    if (at < 0) {
      // The pin moves; the adapters stay what a launch last proved (a bump runs the suite next).
      const record = { ...previous, sdk: pin, adapters: previous?.adapters ?? {}, passed: new Date().toISOString().slice(0, 10) }
      writeFileSync(RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`)
      console.log(`acp-drift: recorded SDK ${pin}; adapters unchanged until receipts record them`)
      return 0
    }
    const made = recordFromReceipts({ pin, previous, receipts: readReceipts(resolve(argv[at + 1] ?? '')) })
    if (!made.ok) return print({ ok: false, failures: made.failures, notes: [] })
    writeFileSync(RECORD_PATH, `${JSON.stringify(made.record, null, 2)}\n`)
    console.log(`acp-drift: recorded SDK ${pin} with ${Object.entries(made.record.adapters).map(([name, version]) => `${name} ${version}`).join(', ')} from ${made.record.receipts.length} receipts`)
    return 0
  }
  let latest
  try {
    const packages = adapterPackages()
    const versions = await Promise.all([SDK, ...packages].map(name => latestOf(name)))
    latest = { sdk: versions[0], adapters: Object.fromEntries(packages.map((name, index) => [name, versions[index + 1]])) }
  } catch (error) {
    console.error(`acp-drift: npm could not be read: ${error?.message ?? error}`)
    return 2
  }
  return print(report({ pin, record: readRecord(), latest }))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2))
}
