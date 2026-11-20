#!/usr/bin/env node
// A network-free rehearsal of the shipped CLI store: import the store and the agent specs from
// the seeded profile, call the store's own installCli for every agent with an official package,
// and give it a runner that records the command instead of downloading. The in-image smoke uses
// this to prove the image's pnpm path and registry wiring without installing a vendor CLI.
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PNPM_PATH } from './toolchain.mjs'

const REGISTRY = 'https://registry.npmjs.org'

const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Run the shipped store's install path with a recording runner. Returns the commands it would
 * have run and the packages each install asked for; throws on a missing store, a non-executable
 * pnpm, a package that is not the official one, or a command that does not name the registry.
 */
export async function dryRunVendorClis({
  acpDshDir,
  env = process.env,
  platform = Object.freeze({ platform: 'linux', arch: 'x64', musl: false }),
  log = console.log,
} = {}) {
  const pnpm = env.AUTOMAGIK_PNPM || PNPM_PATH
  if (!isExecutable(pnpm)) throw new Error(`AUTOMAGIK_PNPM is not an executable: ${pnpm}`)
  const clisFile = join(acpDshDir, 'src', 'host', 'clis.js')
  const agentsFile = join(acpDshDir, 'src', 'host', 'agents.js')
  const { installCli } = await import(pathToFileURL(clisFile).href)
  const { AGENTS } = await import(pathToFileURL(agentsFile).href)
  const calls = []
  const agents = []
  const record = async (command, args, options) => { calls.push({ command, args, cwd: options?.cwd }) }
  for (const [id, spec] of Object.entries(AGENTS)) {
    if (!spec.cliPackage) continue
    const dir = mkdtempSync(join(tmpdir(), 'automagik-cli-dry-run-'))
    try {
      await installCli(dir, spec, '0.0.0-smoke', { ...env, AUTOMAGIK_PNPM: pnpm }, { platform, run: record })
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const npmrc = readFileSync(join(dir, '.npmrc'), 'utf8')
      if (pkg.dependencies?.[spec.cliPackage] !== '0.0.0-smoke') throw new Error(`${id}: package.json does not pin ${spec.cliPackage}`)
      if (!npmrc.includes(`registry=${REGISTRY}`)) throw new Error(`${id}: .npmrc does not name ${REGISTRY}`)
      agents.push({ id, name: spec.defaultName, package: spec.cliPackage, dependencies: Object.keys(pkg.dependencies) })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (agents.length === 0) throw new Error('the shipped CLI store names no installable agent')
  if (calls.length !== agents.length) throw new Error(`${agents.length} agents but ${calls.length} install commands`)
  for (const call of calls) {
    if (call.command !== pnpm) throw new Error(`the store ran ${call.command}, not AUTOMAGIK_PNPM ${pnpm}`)
    if (!call.args.includes(`--config.registry=${REGISTRY}`)) throw new Error('the store did not force registry.npmjs.org')
    if (!call.args.includes('--ignore-scripts')) throw new Error('the store would run install scripts')
  }
  log(`cli store dry run: ${agents.map((agent) => agent.package).join(', ')} through ${pnpm} (registry.npmjs.org; no download)`)
  return { pnpm, registry: REGISTRY, agents, calls }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const acpDshDir = process.argv[2] || join(process.env.DSH_HOME || '/data/dsh', 'profiles', 'automagik-web', 'node_modules', '@automagik', 'acp-dsh')
  dryRunVendorClis({ acpDshDir }).catch((error) => {
    console.error(`cli-store dry run: ${error?.stack ?? error}`)
    process.exit(1)
  })
}
