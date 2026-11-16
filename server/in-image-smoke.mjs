#!/usr/bin/env node
// The smoke that runs inside the built image: the four commands an operator expects on PATH
// (am, hc, pnpm, node), the shipped CLI store's install path without a download, and the
// first-boot hook (skill + v2 registry seed) in a temporary home. Run by server/smoke.mjs with
// `docker exec`; it never starts a service or writes outside /tmp and the data volume.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dryRunVendorClis } from './cli-store.mjs'
import { FIRST_BOOT_MARKER, runFirstBoot, seedRegistry, sha256File, SKILL_LINKS } from './first-boot.mjs'
import { profileDirOf } from './lib.mjs'
import { HERDR_CORE_VERSION, PNPM_PATH, SKILL_NAME, SKILL_ROOT, SKILL_SHA256 } from './toolchain.mjs'

const ROOT = '/opt/automagik'
const HOME = process.env.AUTOMAGIK_HOME || '/data'
const DSH_HOME = process.env.DSH_HOME || '/data/dsh'
const PROFILE = profileDirOf(DSH_HOME)
const VERSIONS = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'))

const say = (message) => console.log(`[in-image] ${message}`)
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const command = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
}).trim()
const versionIn = (text) => /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text)?.[1]
const checkVersion = (label, output, expected) => {
  const actual = versionIn(output)
  check(actual, `${label} --version printed no version: ${output}`)
  if (expected) check(actual === expected, `${label} is ${actual}, not the image's ${expected}`)
  return actual
}

async function main() {
  // The commands. am is the release tarball's command through its literal path; hc and
  // herdr-core are the same pinned binary (hc is the link); pnpm is the literal absolute path
  // AUTOMAGIK_PNPM names; node is the distroless runtime.
  check(process.env.AUTOMAGIK_PNPM === PNPM_PATH, `AUTOMAGIK_PNPM is ${process.env.AUTOMAGIK_PNPM ?? 'unset'}, not ${PNPM_PATH}`)
  const am = checkVersion('am', command('am', ['--version']), VERSIONS.am?.version)
  const hc = checkVersion('hc', command('hc', ['--version']), VERSIONS.herdrCore?.version || HERDR_CORE_VERSION)
  checkVersion('herdr-core', command('herdr-core', ['--version']), VERSIONS.herdrCore?.version || HERDR_CORE_VERSION)
  const pnpm = checkVersion('pnpm', command('pnpm', ['--version']), String(VERSIONS.pnpm ?? ''))
  const node = command('node', ['--version'])
  check(/^v\d+\.\d+\.\d+/.test(node), `node --version printed ${node}`)
  check(node === process.version, `node on PATH is ${node}, this process is ${process.version}`)
  say(`am ${am}, hc ${hc}, herdr-core ${VERSIONS.herdrCore?.version || HERDR_CORE_VERSION}, pnpm ${pnpm}, node ${node}`)

  // The reviewed skill is installed read-only in the shared agents folder and linked for both
  // agents on first boot. Both the image payload and the volume copy must match the pins.
  for (const [relative, expected] of Object.entries(SKILL_SHA256)) {
    const imageCopy = join(SKILL_ROOT, SKILL_NAME, relative)
    const homeCopy = join(HOME, '.agents', 'skills', SKILL_NAME, relative)
    check(sha256File(imageCopy) === expected, `image skill payload ${relative} does not match its pin`)
    check(sha256File(homeCopy) === expected, `installed skill ${relative} does not match its pin`)
  }
  for (const vendor of SKILL_LINKS) {
    const link = join(HOME, vendor, 'skills', SKILL_NAME)
    check(lstatSync(link).isSymbolicLink(), `${link} is not a symlink`)
    check(readlinkSync(link) === join('..', '..', '.agents', 'skills', SKILL_NAME), `${link} points at ${readlinkSync(link)}`)
  }
  const marker = JSON.parse(readFileSync(join(HOME, FIRST_BOOT_MARKER), 'utf8'))
  check(['installed', 'present'].includes(marker.skill), `first boot recorded skill ${marker.skill}`)
  say(`skill ${SKILL_NAME}: pinned payload, shared copy and both agent links match`)

  // The shipped CLI store, called with a recording runner: no vendor CLI is downloaded and no
  // package manager command runs, but the real install path, pnpm path and registry are proved.
  const acpDsh = join(PROFILE, 'node_modules', '@automagik', 'acp-dsh')
  check(existsSync(acpDsh), `the seeded profile has no @automagik/acp-dsh at ${acpDsh}`)
  const dry = await dryRunVendorClis({ acpDshDir: acpDsh, env: { ...process.env, AUTOMAGIK_PNPM: PNPM_PATH } })
  check(dry.pnpm === PNPM_PATH, `the CLI store used ${dry.pnpm}, not ${PNPM_PATH}`)
  check(dry.registry === 'https://registry.npmjs.org', `the CLI store used ${dry.registry}`)

  // The seed in a temporary home. While #1424 is unmerged the documented path is absent, so
  // the fixture beside the shipped registry module stands in for its CLI and proves the
  // interface the first-boot hook calls: --home <team home> --workspace <folder>.
  const temp = mkdtempSync(join(tmpdir(), 'automagik-in-image-'))
  try {
    const home = join(temp, 'home')
    const workspace = join(temp, 'workspace')
    const profile = join(temp, 'profile')
    mkdirSync(join(workspace, '.herdr'), { recursive: true })
    writeFileSync(join(workspace, '.herdr', 'bots.json'), `${JSON.stringify({
      version: 1,
      bots: [{ id: 'b-aaaaaaaaaa', name: 'Smoke', kind: 'main', agent: 'claude', instructions: 'Seed smoke' }],
    }, null, 2)}\n`)
    const bots = join(profile, 'node_modules', '@automagik', 'bots-dsh')
    const shared = join(bots, 'src', 'shared')
    mkdirSync(shared, { recursive: true })
    writeFileSync(join(bots, 'package.json'), '{"type":"module"}\n')
    copyFileSync(join(PROFILE, 'node_modules', '@automagik', 'bots-dsh', 'src', 'shared', 'registry.js'), join(shared, 'registry.js'))
    writeFileSync(join(shared, 'registry-seed.js'), `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromHerdrV1, writeRegistry } from './registry.js'
const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1]
const home = value('--home')
const workspace = value('--workspace')
const { file } = fromHerdrV1(readFileSync(join(workspace, '.herdr', 'bots.json'), 'utf8'))
await writeRegistry(join(home, 'bots', 'bots.json'), { ...file, projects: [{ folder: workspace }], shown: [] }, null, { kind: 'home' })
await writeRegistry(join(workspace, '.automagik', 'bots', 'bots.json'), file, null, { kind: 'repo' })
console.log('fixture seed: wrote the home and repo registries')
`)
    const first = runFirstBoot({
      home, workspace, profile, version: VERSIONS.automagik,
      source: join(ROOT, 'skills'), log: (message) => say(message), warn: (message) => say(`warning: ${message}`),
    })
    check(first.fresh, 'the temporary home was not first boot')
    check(first.registry.state === 'seeded', `the seed in a temporary home was ${first.registry.state}`)
    check(first.skill?.state === 'installed', `the skill in a temporary home was ${first.skill?.state}`)
    const registry = JSON.parse(readFileSync(join(home, 'bots', 'bots.json'), 'utf8'))
    check(registry.version === 2 && registry.bots?.some((bot) => bot.id === 'b-aaaaaaaaaa'), 'the seed did not write the v2 home registry')
    check(existsSync(join(workspace, '.automagik', 'bots', 'bots.json')), 'the seed did not write the v2 repo registry')
    const marker = JSON.parse(readFileSync(join(home, FIRST_BOOT_MARKER), 'utf8'))
    check(marker.registry === 'seeded' && marker.skill === 'installed', 'the temporary first-boot marker does not record the seed and skill')
    const pending = seedRegistry({ home: join(temp, 'empty'), workspace, profile: join(temp, 'missing'), log: () => {}, warn: () => {} })
    check(pending.state === 'pending', `a profile without the seed reported ${pending.state}, not pending`)
    say('seed: first boot wrote the v2 home and repo registries in a temporary home; a missing seed is pending #1424')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  console.log(`IN-IMAGE SMOKE OK am=${am} hc=${hc} pnpm=${pnpm} node=${node} seed=temp-home cli-store=dry-run`)
}

main().catch((error) => {
  console.error(`[in-image] FAILED: ${error?.stack ?? error}`)
  process.exitCode = 1
})
