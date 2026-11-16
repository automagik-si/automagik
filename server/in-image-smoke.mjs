#!/usr/bin/env node
// The smoke that runs inside the built image: the four commands an operator expects on PATH
// (am, hc, pnpm, node), the shipped CLI store's install path without a download, the real
// #1424 seed against the real first-boot team and against a copy of that v1 roster, and the
// skill hashes. Run by server/smoke.mjs with `docker exec`; it writes only under /tmp.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dryRunVendorClis } from './cli-store.mjs'
import { FIRST_BOOT_MARKER, TRIAD, runFirstBoot, seedRegistry, seedScript, sha256File, SKILL_LINKS, verifySurfaces } from './first-boot.mjs'
import { profileDirOf } from './lib.mjs'
import { HC_RUNTIME, HERDR_APP_HOME, HERDR_CORE_VERSION, PNPM_PATH, REGISTRY_SEED_SHA256, REGISTRY_SEED_VENDOR, SKILL_NAME, SKILL_ROOT, SKILL_SHA256, SMOKE_HC_SESSION, XDG_RUNTIME_DIR, herdrCoreSocket } from './toolchain.mjs'

const ROOT = '/opt/automagik'
const HOME = process.env.AUTOMAGIK_HOME || '/data'
const DSH_HOME = process.env.DSH_HOME || '/data/dsh'
const WORKSPACE = process.env.AUTOMAGIK_WORKSPACE || '/data/workspace'
const PROFILE = profileDirOf(DSH_HOME)
const VENDOR = join(ROOT, 'registry-seed')
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
  // docker exec inherits the container-creation env, not the entrypoint's later mutations.
  // hc resolves the core socket from HC_SOCKET, then the config socket, then
  // $XDG_RUNTIME_DIR/herdr-core/$HC_SESSION.sock; the smoke container sets the last two.
  // Derive that session path here for the socket check and export HC_TERMINAL_SOCKET for the
  // pane/proxy validation paths; it is not hc's destination override.
  const coreSession = process.env.HC_SESSION || SMOKE_HC_SESSION
  const coreRuntime = process.env.HC_RUNTIME || HC_RUNTIME
  const coreSocket = herdrCoreSocket(coreSession, coreRuntime)
  process.env.HC_TERMINAL_SOCKET = coreSocket
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

  // The Code side's terminals live in the supervised herdr-core on the contract socket. The
  // same env reaches dsh, am and hc; here the core must answer both its status and its list.
  check(process.env.HERDR_APP_HOME === HERDR_APP_HOME, `HERDR_APP_HOME is ${process.env.HERDR_APP_HOME ?? 'unset'}, not ${HERDR_APP_HOME}`)
  check(process.env.XDG_RUNTIME_DIR === XDG_RUNTIME_DIR, `XDG_RUNTIME_DIR is ${process.env.XDG_RUNTIME_DIR ?? 'unset'}, not ${XDG_RUNTIME_DIR}`)
  check(coreSession === SMOKE_HC_SESSION, `HC_SESSION is ${coreSession}, not ${SMOKE_HC_SESSION}`)
  check(coreRuntime === HC_RUNTIME, `HC_RUNTIME is ${coreRuntime}, not ${HC_RUNTIME}`)
  const runtime = lstatSync(XDG_RUNTIME_DIR)
  check(runtime.isDirectory() && (runtime.mode & 0o777) === 0o700, `${XDG_RUNTIME_DIR} is not a 0700 directory`)
  check(lstatSync(coreSocket).isSocket(), `${coreSocket} is not a Unix socket`)
  const coreStatus = command('hc', ['server', 'status', '--json'])
  check(coreStatus.trim().length > 0, 'hc server status printed nothing')
  const coreList = command('hc', ['ls', '--json'])
  check(coreList.trim().length > 0, 'hc ls printed nothing')
  const listed = JSON.parse(coreList)
  check(Array.isArray(listed), 'hc ls --json did not print a list')
  const amList = JSON.parse(command('am', ['ls', '--project', WORKSPACE, '--json']))
  const seenBots = (amList?.projects ?? []).flatMap((project) => project.bots ?? [])
  check(amList?.projects?.[0]?.hcError === undefined, `am ls could not see the core: ${amList?.projects?.[0]?.hcError}`)
  check(seenBots.length === TRIAD.length, `am ls sees ${seenBots.length} bots, not ${TRIAD.length}`)
  say(`herdr-core: ${coreSocket} answered server status and ls; am sees ${seenBots.length} team bots`)

  // The reviewed skill is installed read-only in the shared agents folder and linked for both
  // agents on first boot. Both the image payload and the volume copy must match the pins.
  for (const [relative, expected] of Object.entries(SKILL_SHA256)) {
    check(sha256File(join(SKILL_ROOT, SKILL_NAME, relative)) === expected, `image skill payload ${relative} does not match its pin`)
    check(sha256File(join(HOME, '.agents', 'skills', SKILL_NAME, relative)) === expected, `installed skill ${relative} does not match its pin`)
  }
  for (const vendor of SKILL_LINKS) {
    const link = join(HOME, vendor, 'skills', SKILL_NAME)
    check(lstatSync(link).isSymbolicLink(), `${link} is not a symlink`)
    check(readlinkSync(link) === join('..', '..', '.agents', 'skills', SKILL_NAME), `${link} points at ${readlinkSync(link)}`)
  }
  say(`skill ${SKILL_NAME}: pinned payload, shared copy and both agent links match`)

  // The vendored #1424 seed is the published PR head, byte-pinned. The real first boot used it
  // (or an installed plugin carrying it) to create and read back both version 2 surfaces.
  for (const [relative, expected] of Object.entries(REGISTRY_SEED_SHA256)) {
    check(sha256File(join(VENDOR, relative)) === expected, `vendored seed ${relative} does not match its pin`)
  }
  const seed = seedScript({ profile: PROFILE, vendorRoot: VENDOR })
  say(`registry seed: ${seed.source}${seed.commit ? ` @ ${seed.commit}` : ''} at ${seed.path}`)
  const marker = JSON.parse(readFileSync(join(HOME, FIRST_BOOT_MARKER), 'utf8'))
  check(['installed', 'present'].includes(marker.skill), `first boot recorded skill ${marker.skill}`)
  check(marker.team?.state === 'created', `first boot recorded team ${marker.team?.state}`)
  check(marker.registry === 'seeded', `first boot recorded registry ${marker.registry}`)
  const surfaces = verifySurfaces({ home: HOME, workspace: WORKSPACE })
  check(surfaces.v1.bots === TRIAD.length && surfaces.v1.mains === 1, `first boot v1 has ${surfaces.v1.bots} bots, ${surfaces.v1.mains} main`)
  check(surfaces.home.bots === 1 && surfaces.home.projects === 1, `first boot v2 home has ${surfaces.home.bots} bots, ${surfaces.home.projects} projects`)
  check(surfaces.repo.bots === TRIAD.length && surfaces.repo.mains === 1, `first boot v2 repo has ${surfaces.repo.bots} bots, ${surfaces.repo.mains} main`)
  check(new Set(surfaces.bots.map((bot) => bot.id)).size === TRIAD.length, 'first boot reused a Bot id')
  const v1Registry = JSON.parse(readFileSync(join(WORKSPACE, '.herdr', 'bots.json'), 'utf8'))
  const homeRegistry = JSON.parse(readFileSync(join(HOME, 'bots', 'bots.json'), 'utf8'))
  const repoRegistry = JSON.parse(readFileSync(join(WORKSPACE, '.automagik', 'bots', 'bots.json'), 'utf8'))
  const v1Ids = v1Registry.bots.map((bot) => bot.id).sort()
  const repoIds = repoRegistry.bots.map((bot) => bot.id).sort()
  check(JSON.stringify(v1Ids) === JSON.stringify(repoIds), `cross-surface ids differ: v1 [${v1Ids.join(' ')}], repo [${repoIds.join(' ')}]`)
  const v1Main = v1Registry.bots.find((bot) => bot.kind === 'main')
  const homeMain = homeRegistry.bots.find((bot) => bot.main === true && bot.folder === WORKSPACE)
  check(homeMain?.id === v1Main?.id, `home main ${homeMain?.id} is not v1 main ${v1Main?.id}`)
  check(homeRegistry.projects.some((project) => project.folder === WORKSPACE), `home has no project ${WORKSPACE}`)
  for (const bot of v1Registry.bots) {
    const other = repoRegistry.bots.find((candidate) => candidate.id === bot.id)
    check(other, `repo has no Bot ${bot.id}`)
    check(other.name === bot.name && other.role === bot.role && other.agent === bot.agent && other.model === bot.model,
      `repo Bot ${bot.id} identity differs from v1`)
  }
  check(homeMain.name === v1Main.name && homeMain.role === v1Main.role && homeMain.agent === v1Main.agent && homeMain.model === v1Main.model,
    'home main identity differs from the v1 main')
  say(`first boot: team ${surfaces.bots.map((bot) => `${bot.name} ${bot.id}`).join(', ')}`)
  say(`first boot: v1 ${surfaces.v1.file} (${surfaces.v1.bots} bots, ${surfaces.v1.mains} main); v2 home ${surfaces.home.file} (${surfaces.home.bots} bots, ${surfaces.home.projects} project); v2 repo ${surfaces.repo.file} (${surfaces.repo.bots} bots, ${surfaces.repo.mains} main)`)
  say(`first boot: cross-surface ids ${v1Ids.join(' ')} agree; home main ${homeMain.id} matches v1 main`)
  const pendingFile = join(HOME, 'bots', 'pending-model-pins.json')
  const pendingPins = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')).pins ?? [] : []
  if (pendingPins.length) {
    check(v1Registry.bots.every((bot) => /model pin pending/i.test(bot.instructions)), 'a pending team has a Bot without the model pin pending marker')
    check(repoRegistry.bots.every((bot) => /model pin pending/i.test(bot.instructions)), 'the v2 repo lacks the model pin pending marker')
    check(/model pin pending/i.test(homeMain.instructions), 'the v2 home main lacks the model pin pending marker')
    check(marker.pins === 'pending', `first boot marker says pins ${marker.pins}, not pending`)
    say(`model pins: pending (${pendingPins.map((pin) => `${pin.name ?? pin.id} ${pin.model}`).join(', ')})`)
  } else {
    check(v1Registry.bots.every((bot) => !/model pin pending/i.test(bot.instructions)), 'an applied team still says model pin pending')
    say('model pins: applied')
  }

  // The shipped CLI store, called with a recording runner: no vendor CLI is downloaded and no
  // package manager command runs, but the real install path, pnpm path and registry are proved.
  const acpDsh = join(PROFILE, 'node_modules', '@automagik', 'acp-dsh')
  check(existsSync(acpDsh), `the seeded profile has no @automagik/acp-dsh at ${acpDsh}`)
  const dry = await dryRunVendorClis({ acpDshDir: acpDsh, env: { ...process.env, AUTOMAGIK_PNPM: PNPM_PATH } })
  check(dry.pnpm === PNPM_PATH, `the CLI store used ${dry.pnpm}, not ${PNPM_PATH}`)
  check(dry.registry === 'https://registry.npmjs.org', `the CLI store used ${dry.registry}`)

  // A whole first boot in a temporary home: the real am creates the triad, the real seed writes
  // both files, and the verifier reads them back. The same seed then runs on a copy of the real
  // first-boot v1 roster, so a roster made by am is exercised twice from different homes.
  const temp = mkdtempSync(join(tmpdir(), 'automagik-in-image-'))
  try {
    const user = join(temp, 'user')
    const home = join(temp, 'home')
    const workspace = join(temp, 'workspace')
    const profile = join(temp, 'profile')
    const env = { ...process.env, HOME: user, HERDR_APP_HOME: join(temp, 'herdr-app'), AUTOMAGIK_HOME: home, AUTOMAGIK_WORKSPACE: workspace }
    const first = runFirstBoot({
      home, workspace, profile, env, vendorRoot: VENDOR, version: VERSIONS.automagik,
      source: join(ROOT, 'skills'), log: (message) => say(message), warn: (message) => say(`warning: ${message}`),
    })
    check(first.fresh, 'the temporary home was not first boot')
    check(first.team?.state === 'created', `the temporary team was ${first.team?.state}`)
    check(first.registry?.state === 'seeded', `the temporary seed was ${first.registry?.state}`)
    check(first.surfaces?.v1.bots === TRIAD.length, 'the temporary first boot did not verify the v1 roster')
    check(first.skill?.state === 'installed', `the skill in a temporary home was ${first.skill?.state}`)
    const tempMarker = JSON.parse(readFileSync(join(home, FIRST_BOOT_MARKER), 'utf8'))
    check(tempMarker.team?.bots?.length === TRIAD.length && tempMarker.registry === 'seeded', 'the temporary first-boot marker does not record the team and seed')
    const again = seedRegistry({ home, workspace, profile, env, vendorRoot: VENDOR, log: () => {}, warn: () => {} })
    check(again.stdout.includes('unchanged'), 'an identical re-run did not report both files unchanged')
    say('seed: a real am-created triad seeded both surfaces; an identical re-run reported unchanged')

    const copyProject = join(temp, 'copy-project')
    const copyHome = join(temp, 'copy-home')
    mkdirSync(join(copyProject, '.herdr'), { recursive: true })
    copyFileSync(join(WORKSPACE, '.herdr', 'bots.json'), join(copyProject, '.herdr', 'bots.json'))
    const copied = seedRegistry({ home: copyHome, workspace: copyProject, profile, env, vendorRoot: VENDOR, log: () => {}, warn: () => {} })
    check(copied.state === 'seeded', 'a copy of the real v1 roster did not seed')
    const copySurfaces = verifySurfaces({ home: copyHome, workspace: copyProject })
    check(copySurfaces.v1.bots === TRIAD.length && copySurfaces.repo.bots === TRIAD.length, 'the copied roster did not produce all three Bots')
    say('seed: a copy of the real first-boot v1 roster produced both version 2 surfaces')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  console.log(`IN-IMAGE SMOKE OK am=${am} hc=${hc} pnpm=${pnpm} node=${node} seed=real cli-store=dry-run`)
}

main().catch((error) => {
  console.error(`[in-image] FAILED: ${error?.stack ?? error}`)
  process.exitCode = 1
})
