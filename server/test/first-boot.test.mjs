import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import {
  FIRST_BOOT_MARKER, managedProgram, runFirstBoot, writeProgramsBridge,
} from '../first-boot.mjs'

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

test('first boot reinstalls am on image upgrades and when the briefing link is missing', () => {
  const home = temp()
  const appHome = join(home, 'herdr-app')
  const link = join(appHome, 'automagik-herdr', 'briefing.mjs')
  const marker = join(home, FIRST_BOOT_MARKER)
  const at = '2026-11-20T00:00:00.000Z'
  const calls = []
  const run = (bin, args, options) => {
    calls.push({ bin, args, cwd: options.cwd })
    mkdirSync(dirname(link), { recursive: true })
    writeFileSync(link, '')
  }
  const boot = (version) => runFirstBoot({
    home, env: { HOME: home }, am: 'am', version, now: () => at, run, ...silence,
  })

  assert.equal(boot('1.2.3').amSelf.state, 'installed')
  assert.equal(boot('1.2.3').amSelf.state, 'present')
  assert.equal(calls.length, 1)
  assert.equal(boot('1.2.4').amSelf.state, 'installed')
  assert.equal(boot('1.2.4').amSelf.state, 'present')
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
    schemaVersion: 1, version: '1.2.4', at, amSelf: 'installed',
  })
  rmSync(link)
  assert.equal(boot('1.2.4').amSelf.state, 'installed')
  assert.deepEqual(calls, Array(3).fill({ bin: 'am', args: ['self', 'install'], cwd: home }))
})

test('a failed am upgrade is retried with the old briefing still present', () => {
  const home = temp()
  const link = join(home, 'herdr-app', 'automagik-herdr', 'briefing.mjs')
  mkdirSync(dirname(link), { recursive: true })
  writeFileSync(link, '')
  const marker = join(home, FIRST_BOOT_MARKER)
  writeFileSync(marker, JSON.stringify({ version: '1.2.3', amSelf: 'installed' }))
  const options = { home, env: {}, version: '1.2.4', ...silence }
  const run = () => { throw new Error('am failed') }
  assert.equal(runFirstBoot({ ...options, run }).amSelf.state, 'failed')
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).amSelf, 'failed')
  assert.equal(runFirstBoot({ ...options, run: () => {} }).amSelf.state, 'installed')
})
