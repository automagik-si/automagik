import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIRST_BOOT_MARKER, installSkill, runFirstBoot, seedRegistry, sha256File, skillProblems } from '../first-boot.mjs'
import { SKILL_NAME, SKILL_SHA256 } from '../toolchain.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SOURCE = join(ROOT, 'server', 'skills')
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

function fakeSeed(profile, body) {
  const dir = join(profile, 'node_modules', '@automagik', 'bots-dsh', 'src', 'shared')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'registry-seed.js'), body)
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

test('a missing seed path is pending #1424, not a registry written by hand', () => {
  const home = temp()
  const workspace = temp()
  const profile = temp()
  const warnings = []
  const result = seedRegistry({ home, workspace, profile, log: () => {}, warn: (message) => warnings.push(message) })
  assert.equal(result.state, 'pending')
  assert.match(result.script, /node_modules\/@automagik\/bots-dsh\/src\/shared\/registry-seed\.js$/)
  assert.match(warnings.join('\n'), /assumed interface: --home <team home> --workspace <folder>/)
  assert.equal(existsSync(join(home, 'bots', 'bots.json')), false)
})

test('the seed is called with the team home and workspace and its home file is accepted', () => {
  const home = temp()
  const workspace = temp()
  const profile = temp()
  fakeSeed(profile, `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const home = args[args.indexOf('--home') + 1], workspace = args[args.indexOf('--workspace') + 1];
if (!home || !workspace) process.exit(9);
fs.mkdirSync(path.join(home, 'bots'), { recursive: true });
fs.writeFileSync(path.join(home, 'bots', 'bots.json'), JSON.stringify({ version: 2, bots: [] }, null, 2) + '\\n');
fs.writeFileSync(path.join(workspace, 'called'), 'yes\\n');
`)
  const result = seedRegistry({ home, workspace, profile, log: () => {}, warn: () => {} })
  assert.equal(result.state, 'seeded')
  assert.equal(JSON.parse(readFileSync(join(home, 'bots', 'bots.json'), 'utf8')).version, 2)
  assert.equal(readFileSync(join(workspace, 'called'), 'utf8'), 'yes\n')
  assert.equal(seedRegistry({ home, workspace, profile, log: () => {}, warn: () => {} }).state, 'present')
})

test('exit 3 means there is no v1 roster, not a seed failure', () => {
  const profile = temp()
  fakeSeed(profile, 'process.exit(3)\n')
  const result = seedRegistry({ home: temp(), workspace: temp(), profile, log: () => {}, warn: () => {} })
  assert.equal(result.state, 'no-source')
})

test('a seed that returns 0 without writing the home file is a failure', () => {
  const profile = temp()
  fakeSeed(profile, 'process.exit(0)\n')
  const warnings = []
  const result = seedRegistry({ home: temp(), workspace: temp(), profile, log: () => {}, warn: (message) => warnings.push(message) })
  assert.equal(result.state, 'failed')
  assert.match(warnings.join('\n'), /returned 0 but wrote no/)
})

test('first boot installs the skill and records the seed state once', () => {
  const home = temp()
  const workspace = temp()
  const profile = temp()
  fakeSeed(profile, `
const fs = require('node:fs'), path = require('node:path');
const home = process.argv[process.argv.indexOf('--home') + 1];
fs.mkdirSync(path.join(home, 'bots'), { recursive: true });
fs.writeFileSync(path.join(home, 'bots', 'bots.json'), JSON.stringify({ version: 2, bots: [] }, null, 2));
`)
  const first = runFirstBoot({ home, workspace, profile, version: '3.149.2', source: SOURCE, ...silence })
  assert.equal(first.fresh, true)
  assert.equal(first.skill.state, 'installed')
  assert.equal(first.registry.state, 'seeded')
  const marker = JSON.parse(readFileSync(join(home, FIRST_BOOT_MARKER), 'utf8'))
  assert.equal(marker.version, '3.149.2')
  assert.equal(marker.skill, 'installed')
  assert.equal(marker.registry, 'seeded')
  const second = runFirstBoot({ home, workspace, profile, version: '3.149.2', source: SOURCE, ...silence })
  assert.equal(second.fresh, false)
  assert.equal(second.registry.state, 'present')
  assert.equal(existsSync(join(home, 'bots', 'bots.json')), true)
})

test('the pinned hashes are the reviewed bytes', () => {
  assert.equal(createHash('sha256').update(readFileSync(join(SOURCE, SKILL_NAME, 'SKILL.md'))).digest('hex'), SKILL_SHA256['SKILL.md'])
  assert.equal(createHash('sha256').update(readFileSync(join(SOURCE, SKILL_NAME, 'references', 'packet.md'))).digest('hex'), SKILL_SHA256['references/packet.md'])
})
