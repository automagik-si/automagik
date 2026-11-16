import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FIRST_BOOT_MARKER, TRIAD, applyPendingPins, ensureTeam, installSkill, managedProgram, runFirstBoot, seedRegistry, seedScript,
  sha256File, skillProblems, verifySurfaces, writeProgramsBridge,
} from '../first-boot.mjs'
import { REGISTRY_SEED_COMMIT, REGISTRY_SEED_SHA256, SKILL_NAME, SKILL_SHA256 } from '../toolchain.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE = join(ROOT, 'server', 'skills')
const VENDOR = join(ROOT, 'server', 'vendor', 'registry-seed')
const temps = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-first-boot-'))
  temps.push(dir)
  return dir
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const silence = { log: () => {}, warn: () => {} }

/** A stand-in for `am create`: writes the same v1 shape with a fresh id per name. */
function fakeAm() {
  const dir = temp()
  const bin = join(dir, 'am')
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const value = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const command = args[0];
const noList = process.env.FAKE_AM_NO_MODEL_LIST === '1';
const project = value('--project');
const chars = 'abcdefghijklmnopqrstuvwxyz234567';
const file = path.join(project, '.herdr', 'bots.json');
let raw = { version: 1, categories: [], bots: [] };
try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
if (command === 'edit') {
  const ref = args[1];
  const bot = raw.bots.find((candidate) => candidate.id === ref || candidate.name === ref);
  if (!bot) { process.stderr.write('am: no such Bot\\n'); process.exit(2); }
  const model = value('--model');
  if (model && noList) { process.stderr.write('am: There is no list of codex models to pin from; leave the model unpinned (the running one is detected)\\n'); process.exit(1); }
  if (model) bot.model = model;
  if (value('--instructions') !== undefined) bot.instructions = value('--instructions');
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\\n');
  process.stdout.write(JSON.stringify({ id: bot.id }) + '\\n');
  process.exit(0);
}
const name = value('--name');
if (value('--model') && noList) { process.stderr.write('am: There is no list of codex models to pin from; leave the model unpinned (the running one is detected)\\n'); process.exit(1); }
let h = 0; for (const c of name) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
let id = 'b-'; for (let i = 0; i < 10; i += 1) id += chars[(h >>> (i * 3)) % 32];
raw.bots.push({ id, kind: value('--kind'), name, role: value('--role'), instructions: value('--instructions'),
  agent: value('--agent'), model: value('--model'), ...(value('--lead') ? { lead: value('--lead') } : {}) });
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\\n');
process.stdout.write(JSON.stringify({ id }) + '\\n');
`)
  chmodSync(bin, 0o755)
  return bin
}

function envAt(dir, home, workspace) {
  return { ...process.env, HOME: join(dir, 'user'), HERDR_APP_HOME: join(dir, 'herdr-app'), AUTOMAGIK_HOME: home, AUTOMAGIK_WORKSPACE: workspace }
}

test('the reviewed skill is copied to the shared folder and linked for both agents', () => {
  const home = temp()
  const result = installSkill({ home, source: SOURCE, ...silence })
  assert.equal(result.state, 'installed')
  assert.deepEqual(skillProblems(join(home, '.agents', 'skills', SKILL_NAME)), [])
  for (const [relative, expected] of Object.entries(SKILL_SHA256)) {
    assert.equal(sha256File(join(home, '.agents', 'skills', SKILL_NAME, relative)), expected)
    assert.equal(lstatSync(join(home, '.agents', 'skills', SKILL_NAME, relative)).mode & 0o777, 0o444)
  }
  for (const vendor of ['.claude', '.codex']) {
    const link = join(home, vendor, 'skills', SKILL_NAME)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readlinkSync(link), join('..', '..', '.agents', 'skills', SKILL_NAME))
  }
  assert.equal(installSkill({ home, source: SOURCE, ...silence }).state, 'present')
})

test('an existing skill with other bytes is never overwritten', () => {
  const home = temp()
  const target = join(home, '.agents', 'skills', SKILL_NAME)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'SKILL.md'), 'the person edited this\n')
  const warnings = []
  const result = installSkill({ home, source: SOURCE, log: () => {}, warn: (message) => warnings.push(message) })
  assert.equal(result.state, 'conflict')
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'the person edited this\n')
  assert.match(warnings.join('\n'), /exists with other bytes/)
})

test('the triad is created through am with fresh ids and one main', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const first = ensureTeam({ home, workspace, env: envAt(dir, home, workspace), am, ...silence })
  assert.equal(first.state, 'created')
  assert.equal(first.bots.length, TRIAD.length)
  assert.equal(new Set(first.bots.map((bot) => bot.id)).size, TRIAD.length)
  const v1 = JSON.parse(readFileSync(join(workspace, '.herdr', 'bots.json'), 'utf8'))
  assert.equal(v1.version, 1)
  assert.equal(v1.bots.filter((bot) => bot.kind === 'main').length, 1)
  assert.equal(v1.bots.find((bot) => bot.kind === 'main').name, 'Purpose')
  assert.equal(v1.bots.find((bot) => bot.name === 'Dogfooder').lead, first.mainId)
  const models = Object.fromEntries(v1.bots.map((bot) => [bot.name, bot.model]))
  assert.deepEqual(models, { Purpose: 'gpt-6-astra', Dogfooder: 'gpt-6.1-terra', Fixer: 'gpt-6.1-sol' })
  assert.ok(v1.bots.every((bot) => bot.agent === 'codex'))
  for (const bot of v1.bots) {
    assert.equal(bot.effort, undefined, `${bot.name} carries an effort field`)
    assert.equal(bot.tier, undefined, `${bot.name} carries a tier field`)
    assert.equal(bot.service_tier, undefined, `${bot.name} carries a service_tier field`)
    assert.ok(!/"fast"/.test(JSON.stringify(bot)), `${bot.name} carries Fast`)
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'server', 'first-boot.mjs'), 'utf8'), /service_tier|serviceTier/)
  assert.equal(ensureTeam({ home, workspace, env: envAt(dir, home, workspace), am, ...silence }).state, 'present')
})

test('the vendored seed is the published #1424 commit', () => {
  assert.equal(REGISTRY_SEED_COMMIT, '92fe5ef7486556cad42e6b5e789aef5d07c08f49')
  for (const [relative, expected] of Object.entries(REGISTRY_SEED_SHA256)) {
    assert.equal(sha256File(join(VENDOR, relative)), expected)
  }
  assert.equal(seedScript({ profile: join(temp(), 'profile'), vendorRoot: VENDOR }).source, 'vendored')
})

test('the vendored seed runs from a folder outside the repository', () => {
  const dir = temp()
  const vendor = join(dir, 'registry-seed')
  cpSync(VENDOR, vendor, { recursive: true })
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = envAt(dir, home, workspace)
  ensureTeam({ home, workspace, env, am, ...silence })
  assert.equal(seedRegistry({ home, workspace, profile: join(dir, 'profile'), env, vendorRoot: vendor, ...silence }).state, 'seeded')
  assert.equal(verifySurfaces({ home, workspace }).v1.bots, 3)
})

test('the real seed writes both version 2 files from a real am-created roster', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = envAt(dir, home, workspace)
  ensureTeam({ home, workspace, env, am, ...silence })
  const seeded = seedRegistry({ home, workspace, profile: join(dir, 'profile'), env, vendorRoot: VENDOR, ...silence })
  assert.equal(seeded.state, 'seeded')
  assert.match(seeded.stdout, /seed-registry: home /)
  assert.match(seeded.stdout, /seed-registry: repo /)
  const surfaces = verifySurfaces({ home, workspace })
  assert.equal(surfaces.v1.bots, 3)
  assert.equal(surfaces.v1.mains, 1)
  assert.equal(surfaces.home.bots, 1)
  assert.equal(surfaces.home.projects, 1)
  assert.equal(surfaces.repo.bots, 3)
  assert.equal(surfaces.repo.mains, 1)
  const v2 = JSON.parse(readFileSync(join(workspace, '.automagik', 'bots', 'bots.json'), 'utf8'))
  assert.equal(v2.version, 2)
  assert.equal(v2.bots.length, 3)
  assert.equal(v2.bots.filter((bot) => bot.main === true).length, 1)
  assert.deepEqual(Object.fromEntries(v2.bots.map((bot) => [bot.name, bot.model])), { Purpose: 'gpt-6-astra', Dogfooder: 'gpt-6.1-terra', Fixer: 'gpt-6.1-sol' })
  assert.ok(v2.bots.every((bot) => bot.agent === 'codex'))
})

test('the real seed refuses a missing v1 roster and writes nothing', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  assert.throws(() => seedRegistry({ home, workspace, profile: join(dir, 'profile'), vendorRoot: VENDOR, ...silence }), /no version 1 roster/i)
  assert.equal(existsSync(join(home, 'bots', 'bots.json')), false)
  assert.equal(existsSync(join(workspace, '.automagik')), false)
})

test('a seed refusal after the roster is a real failure with its stderr', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = envAt(dir, home, workspace)
  ensureTeam({ home, workspace, env, am, ...silence })
  mkdirSync(join(workspace, '.automagik', 'bots'), { recursive: true })
  writeFileSync(join(workspace, '.automagik', 'bots', 'bots.json'), '{"version":2,"bots":[{"id":"b-aaaaaaaaaa","name":"Other","main":true}]}\n')
  assert.throws(() => seedRegistry({ home, workspace, profile: join(dir, 'profile'), env, vendorRoot: VENDOR, ...silence }), /registry seed .* failed with exit 1: .*different project roster/s)
  assert.equal(existsSync(join(home, 'bots', 'bots.json')), false)
})

test('mutant FIRST_BOOT_PRESENT_HOME_SKIPS_VERIFY is killed: a partial home is not accepted on retry', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = envAt(dir, home, workspace)
  const first = runFirstBoot({
    home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE,
    vendorRoot: VENDOR, env, am, ...silence,
  })
  assert.equal(first.fresh, true)
  assert.equal(first.team.state, 'created')
  assert.equal(first.registry.state, 'seeded')
  assert.equal(first.registry.script.source, 'vendored')
  assert.equal(first.surfaces.v1.bots, 3)
  const markerFile = join(home, FIRST_BOOT_MARKER)
  const marker = JSON.parse(readFileSync(markerFile, 'utf8'))
  assert.equal(marker.version, '3.149.2')
  assert.equal(marker.team.state, 'created')
  assert.equal(marker.team.bots.length, 3)
  assert.equal(marker.registry, 'seeded')
  assert.equal(marker.seedCommit, REGISTRY_SEED_COMMIT)

  // The recovery state g9 reproduced: a home file, no v1 roster, no repo v2, no marker.
  // The present-home early return would accept it and write a marker for the unchecked state.
  const homeFile = join(home, 'bots', 'bots.json')
  const homeBefore = readFileSync(homeFile, 'utf8')
  rmSync(join(workspace, '.herdr', 'bots.json'), { force: true })
  rmSync(join(workspace, '.automagik'), { recursive: true, force: true })
  rmSync(markerFile, { force: true })
  const failed = runFirstBoot({ home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE, vendorRoot: VENDOR, env, am, ...silence })
  assert.equal(failed.team.state, 'failed')
  assert.match(failed.error, /registry verifier failed: missing/)
  assert.equal(existsSync(markerFile), false, 'no marker is written for a partial state')
  assert.equal(readFileSync(homeFile, 'utf8'), homeBefore, 'the home file is preserved')
  assert.equal(existsSync(join(workspace, '.herdr', 'bots.json')), false, 'no ids are recreated')
  assert.equal(existsSync(join(workspace, '.automagik', 'bots', 'bots.json')), false, 'no repo file is recreated')
})

test('mutant VERIFY_MEMBER_IDS_SKIPPED is killed: the verifier refuses a Session key and a member-id mismatch', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = envAt(dir, home, workspace)
  ensureTeam({ home, workspace, env, am, ...silence })
  seedRegistry({ home, workspace, profile: join(dir, 'profile'), env, vendorRoot: VENDOR, ...silence })
  const file = join(workspace, '.automagik', 'bots', 'bots.json')
  const v2 = JSON.parse(readFileSync(file, 'utf8'))
  v2.bots[0].sessionId = 'session-00000000-0000-0000-0000-000000000000'
  writeFileSync(file, `${JSON.stringify(v2, null, 2)}\n`)
  assert.throws(() => verifySurfaces({ home, workspace }), /sessionId is a Session key/)
  delete v2.bots[0].sessionId
  v2.bots[1].id = 'b-zzzzzzzzzz'
  writeFileSync(file, `${JSON.stringify(v2, null, 2)}\n`)
  assert.throws(() => verifySurfaces({ home, workspace }), /v1 ids .* and v2 repo ids .* differ/)
})

test('mutants VERIFY_FIXED_TRIO_COUNT and VERIFY_HOME_EQUAL_COUNTS are killed: 6- and 9-Bot expansions verify with a one-Bot home index', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = envAt(dir, home, workspace)
  ensureTeam({ home, workspace, env, am, ...silence })
  seedRegistry({ home, workspace, profile: join(dir, 'profile'), env, vendorRoot: VENDOR, ...silence })
  const v1File = join(workspace, '.herdr', 'bots.json')
  const repoFile = join(workspace, '.automagik', 'bots', 'bots.json')
  const expand = (from, count) => {
    const v1 = JSON.parse(readFileSync(v1File, 'utf8'))
    const repo = JSON.parse(readFileSync(repoFile, 'utf8'))
    for (let index = 0; index < count; index += 1) {
      const name = `Expansion ${from + index}`
      const id = `b-${'mnopqr'[(from + index) % 6]}${'m'.repeat(9)}`
      const identity = { id, name, role: 'Expand the team', instructions: 'A legitimate later expansion.', agent: 'codex', model: 'gpt-6-astra' }
      v1.bots.push({ ...identity, kind: 'member' })
      repo.bots.push({ ...identity, main: false })
    }
    writeFileSync(v1File, `${JSON.stringify(v1, null, 2)}\n`)
    writeFileSync(repoFile, `${JSON.stringify(repo, null, 2)}\n`)
  }
  expand(0, 3)
  const six = verifySurfaces({ home, workspace })
  assert.equal(six.v1.bots, 6)
  assert.equal(six.home.bots, 1)
  expand(3, 3)
  const nine = verifySurfaces({ home, workspace })
  assert.equal(nine.v1.bots, 9)
  assert.equal(nine.home.bots, 1)
})

test('the role briefs carry the Claude-only UI and opposite-provider review rules', () => {
  assert.ok(TRIAD.every((role) => role.instructions.includes('approved Claude route')))
  assert.ok(TRIAD.filter((role) => role.kind === 'member').every((role) => /Opus for critical work, never Terra reviewing Sol/.test(role.instructions)))
})

test('the pinned skill hashes are the reviewed bytes', () => {
  assert.equal(createHash('sha256').update(readFileSync(join(SOURCE, SKILL_NAME, 'SKILL.md'))).digest('hex'), SKILL_SHA256['SKILL.md'])
  assert.equal(createHash('sha256').update(readFileSync(join(SOURCE, SKILL_NAME, 'references', 'packet.md'))).digest('hex'), SKILL_SHA256['references/packet.md'])
})

const storeBinary = (home, agent, version) => join(home, 'acp', 'clis', agent === 'claude' ? '@anthropic-ai__claude-code' : '@openai__codex', `${version}-00000000-0000-0000-0000-000000000000`, 'node_modules', agent === 'claude' ? 'claude' : 'codex')

test('mutant WRITER_SKIPS_MANAGED_ENTRY is killed: the managed entries point at the store', () => {
  const home = temp()
  const appHome = join(home, 'herdr-app')
  const claude = storeBinary(home, 'claude', '1.2.3')
  const codex = storeBinary(home, 'codex', '4.5.6')
  assert.equal(writeProgramsBridge({ home, appHome, agent: 'claude', path: claude, ...silence }).changed, true)
  assert.equal(writeProgramsBridge({ home, appHome, agent: 'codex', path: codex, ...silence }).changed, true)
  const programs = JSON.parse(readFileSync(join(appHome, 'programs.json'), 'utf8')).programs
  assert.deepEqual(programs.claude.run, [claude])
  assert.deepEqual(programs.codex.run, [codex])
  assert.equal(managedProgram(programs.claude.run, home), true)
  assert.equal(managedProgram(programs.codex.run, home), true)
})

test('mutants WRITER_DROPS_PERSONAL_OVERRIDES and WRITER_OVERWRITES_PERSONAL_RUN are killed: a person\'s overrides survive', () => {
  const home = temp()
  const appHome = join(home, 'herdr-app')
  mkdirSync(appHome, { recursive: true })
  const personal = {
    programs: {
      claude: { run: ['/opt/person/claude'] },
      hermes: { run: ['hermes', '--tui'] },
    },
    keep: 'me',
  }
  writeFileSync(join(appHome, 'programs.json'), `${JSON.stringify(personal, null, 2)}\n`)
  const warnings = []
  const claude = writeProgramsBridge({ home, appHome, agent: 'claude', path: storeBinary(home, 'claude', '1.2.3'), log: () => {}, warn: (message) => warnings.push(message) })
  assert.equal(claude.changed, false)
  assert.match(warnings.join('\n'), /person's own override/)
  writeProgramsBridge({ home, appHome, agent: 'codex', path: storeBinary(home, 'codex', '4.5.6'), ...silence })
  const after = JSON.parse(readFileSync(join(appHome, 'programs.json'), 'utf8'))
  assert.deepEqual(after.programs.claude, { run: ['/opt/person/claude'] })
  assert.deepEqual(after.programs.hermes, { run: ['hermes', '--tui'] })
  assert.equal(after.keep, 'me')
  assert.deepEqual(after.programs.codex.run, [storeBinary(home, 'codex', '4.5.6')])
})

test('mutant WRITER_STALE_VERSION is killed: a version-id change refreshes the managed entry', () => {
  const home = temp()
  const appHome = join(home, 'herdr-app')
  const first = storeBinary(home, 'claude', '1.2.3')
  const next = storeBinary(home, 'claude', '1.2.4')
  writeProgramsBridge({ home, appHome, agent: 'claude', path: first, ...silence })
  const refreshed = writeProgramsBridge({ home, appHome, agent: 'claude', path: next, ...silence })
  assert.equal(refreshed.changed, true)
  const programs = JSON.parse(readFileSync(join(appHome, 'programs.json'), 'utf8')).programs
  assert.deepEqual(programs.claude.run, [next])
  assert.equal(writeProgramsBridge({ home, appHome, agent: 'claude', path: next, ...silence }).changed, false)
})

test('mutant WRITER_WRITES_UNMANAGED_PATH is killed: a path outside the store is refused', () => {
  const home = temp()
  assert.throws(() => writeProgramsBridge({ home, appHome: join(home, 'herdr-app'), agent: 'claude', path: '/opt/person/claude', ...silence }), /not in this instance's CLI store/)
  assert.equal(existsSync(join(home, 'herdr-app', 'programs.json')), false)
})

const PENDING_PINS = join('bots', 'pending-model-pins.json')

test('no Codex catalogue: the team is created unpinned and says "model pin pending" per Bot', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const env = { ...envAt(dir, home, workspace), FAKE_AM_NO_MODEL_LIST: '1' }
  const first = runFirstBoot({ home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE, vendorRoot: VENDOR, env, am, ...silence })
  assert.equal(first.team.state, 'created')
  assert.equal(first.team.pinned, false)
  assert.equal(first.team.pendingPins.length, TRIAD.length)
  assert.equal(first.pins.state, 'pending')
  const v1 = JSON.parse(readFileSync(join(workspace, '.herdr', 'bots.json'), 'utf8'))
  assert.ok(v1.bots.every((bot) => bot.model === undefined))
  assert.ok(v1.bots.every((bot) => /model pin pending/i.test(bot.instructions)))
  const pending = JSON.parse(readFileSync(join(home, PENDING_PINS), 'utf8'))
  assert.equal(pending.pins.length, TRIAD.length)
  assert.deepEqual(Object.fromEntries(pending.pins.map((pin) => [pin.name, pin.model])), { Purpose: 'gpt-6-astra', Dogfooder: 'gpt-6.1-terra', Fixer: 'gpt-6.1-sol' })
  const repo = JSON.parse(readFileSync(join(workspace, '.automagik', 'bots', 'bots.json'), 'utf8'))
  assert.ok(repo.bots.every((bot) => bot.model === undefined && /model pin pending/i.test(bot.instructions)))
  const homeRegistry = JSON.parse(readFileSync(join(home, 'bots', 'bots.json'), 'utf8'))
  const homeMain = homeRegistry.bots.find((bot) => bot.main === true)
  assert.equal(homeMain.model, undefined)
  assert.match(homeMain.instructions, /model pin pending/i)
  const marker = JSON.parse(readFileSync(join(home, FIRST_BOOT_MARKER), 'utf8'))
  assert.equal(marker.pins, 'pending')
  assert.equal(marker.pendingPins.length, TRIAD.length)
})

test('a later boot with a catalogue applies all three pins, then a second apply is a no-op', () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const noList = { ...envAt(dir, home, workspace), FAKE_AM_NO_MODEL_LIST: '1' }
  runFirstBoot({ home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE, vendorRoot: VENDOR, env: noList, am, ...silence })
  const env = envAt(dir, home, workspace)
  const second = runFirstBoot({ home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE, vendorRoot: VENDOR, env, am, ...silence })
  assert.equal(second.pins.state, 'pinned')
  assert.equal(second.pins.applied.length, TRIAD.length)
  assert.equal(existsSync(join(home, PENDING_PINS)), false)
  const v1 = JSON.parse(readFileSync(join(workspace, '.herdr', 'bots.json'), 'utf8'))
  assert.deepEqual(Object.fromEntries(v1.bots.map((bot) => [bot.name, bot.model])), { Purpose: 'gpt-6-astra', Dogfooder: 'gpt-6.1-terra', Fixer: 'gpt-6.1-sol' })
  assert.ok(v1.bots.every((bot) => !/model pin pending/i.test(bot.instructions)))
  const repo = JSON.parse(readFileSync(join(workspace, '.automagik', 'bots', 'bots.json'), 'utf8'))
  assert.deepEqual(Object.fromEntries(repo.bots.map((bot) => [bot.name, bot.model])), { Purpose: 'gpt-6-astra', Dogfooder: 'gpt-6.1-terra', Fixer: 'gpt-6.1-sol' })
  assert.ok(repo.bots.every((bot) => !/model pin pending/i.test(bot.instructions)))
  const homeRegistry = JSON.parse(readFileSync(join(home, 'bots', 'bots.json'), 'utf8'))
  assert.equal(homeRegistry.bots.find((bot) => bot.main === true).model, 'gpt-6-astra')
  const marker = JSON.parse(readFileSync(join(home, FIRST_BOOT_MARKER), 'utf8'))
  assert.equal(marker.pins, 'pinned')
  const before = readFileSync(join(workspace, '.herdr', 'bots.json'), 'utf8')
  assert.equal(applyPendingPins({ home, workspace, env, am, ...silence }).state, 'none')
  assert.equal(readFileSync(join(workspace, '.herdr', 'bots.json'), 'utf8'), before)
})

test("a person's model is never overwritten; the reviewed pin is reported superseded", () => {
  const dir = temp()
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const am = fakeAm()
  const noList = { ...envAt(dir, home, workspace), FAKE_AM_NO_MODEL_LIST: '1' }
  runFirstBoot({ home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE, vendorRoot: VENDOR, env: noList, am, ...silence })
  const file = join(workspace, '.herdr', 'bots.json')
  const v1 = JSON.parse(readFileSync(file, 'utf8'))
  const dogfooder = v1.bots.find((bot) => bot.name === 'Dogfooder')
  dogfooder.model = 'gpt-6.1-sol'
  writeFileSync(file, `${JSON.stringify(v1, null, 2)}\n`)
  const env = envAt(dir, home, workspace)
  const second = runFirstBoot({ home, workspace, profile: join(dir, 'profile'), version: '3.149.2', source: SOURCE, vendorRoot: VENDOR, env, am, ...silence })
  assert.equal(second.pins.superseded.length, 1)
  assert.equal(second.pins.superseded[0].model, 'gpt-6.1-sol')
  assert.equal(second.pins.superseded[0].pin.model, 'gpt-6.1-terra')
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.bots.find((bot) => bot.name === 'Dogfooder').model, 'gpt-6.1-sol')
  assert.ok(after.bots.every((bot) => !/model pin pending/i.test(bot.instructions)))
  assert.equal(existsSync(join(home, PENDING_PINS)), false)
  const repo = JSON.parse(readFileSync(join(workspace, '.automagik', 'bots', 'bots.json'), 'utf8'))
  assert.equal(repo.bots.find((bot) => bot.name === 'Dogfooder').model, 'gpt-6.1-sol')
})
