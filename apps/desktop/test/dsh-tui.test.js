// The desktop's DSH-in-Herdr setup (#561): the shared installer's module path, the child
// runner's one-JSON answer, the setup and PATH dialogs, and an end-to-end run of the runner
// against a temp HOME and a fake dsh. The installer's own rules are herdr/test/dsh-tui.test.mjs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SKIP, findDsh, panePathOf } from '../../../am/dshTui.mjs'
import {
  DSH_TUI_FILES, DSH_TUI_PACKAGE, ensurePathLine, formatDoctor, pathActionOf, pathDoneView,
  pathView, resultView, runDshTui, setupView, dshTuiModuleDir, dshTuiRunnerOf, dshTuiSourceDir,
  dshTuiSupported,
} from '../src/dsh-tui.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const APP = resolve(HERE, '..')
const AM = dshTuiSourceDir({ appPath: APP })
const RUNNER = fileURLToPath(new URL('../src/dsh-tui-run.mjs', import.meta.url))
const PIN = '@deepseek-harness-tui/dsh-tui@0.19.0'
const SCRATCH = () => mkdtempSync(join(tmpdir(), 'automagik-dsh-tui-desktop-'))
const posixOnly = { skip: process.platform === 'win32' ? 'the fake dsh is a sh script' : false }

test('the shipped module is the existing installer and every local module it imports', () => {
  assert.deepEqual([...DSH_TUI_FILES], [
    'dshTui.mjs', 'approved.js', 'workers.js', 'models.js', 'model.js', 'logins.js', 'loginWords.js',
    'hermesPair.js',
    'retired.js', 'layoutSafe.mjs', 'release.js', 'bin/dsh-sandbox.mjs', 'bin/hc-socket-mask.mjs',
  ])
  for (const file of DSH_TUI_FILES) {
    assert.ok(existsSync(join(AM, file)), `${file} is missing from am/`)
  }
  // prepare-runtime copies this exact list: a local import outside it would break the packaged app.
  for (const file of DSH_TUI_FILES) {
    const text = readFileSync(join(AM, file), 'utf8')
    for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const shipped = match[1].replace(/^\.\//, '')
      assert.ok(DSH_TUI_FILES.includes(shipped),
        `${file} imports ${match[1]}, which is not shipped`)
    }
  }
  assert.match(readFileSync(join(AM, 'dshTui.mjs'), 'utf8'),
    /export const DSH_TUI = Object\.freeze/)
})

test('the shipped module folder loads as ESM with no package file above it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'automagik-dsh-tui-ship-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'dsh-tui')
  mkdirSync(dir)
  for (const file of DSH_TUI_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    copyFileSync(join(AM, file), join(dir, file))
  }
  writeFileSync(join(dir, 'package.json'), DSH_TUI_PACKAGE)
  const mod = await import(pathToFileURL(join(dir, 'dshTui.mjs')).href)
  assert.equal(mod.PIN, PIN)
  assert.equal(mod.PROFILE, 'dsh-tui')
})

test('the packaged app reads the resource folder, a checkout reads am/', () => {
  assert.equal(
    dshTuiModuleDir({
      packaged: true, resourcesPath: join('/opt', 'Automagik', 'resources'), appPath: '/x',
    }),
    join('/opt', 'Automagik', 'resources', 'dsh-tui'),
  )
  assert.equal(dshTuiModuleDir({ packaged: false, resourcesPath: '/x', appPath: APP }), AM)
  assert.equal(
    dshTuiRunnerOf({ packaged: true, resourcesPath: '/opt/Automagik/resources', appPath: '/x' }),
    join('/opt/Automagik/resources', 'dsh-tui', 'dsh-tui-run.mjs'),
  )
  assert.equal(dshTuiRunnerOf({ packaged: false, resourcesPath: '/x', appPath: APP }),
    join(APP, 'src', 'dsh-tui-run.mjs'))
  assert.ok(existsSync(join(APP, 'src', 'dsh-tui-run.mjs')))
  assert.match(readFileSync(join(APP, 'scripts', 'prepare-runtime.mjs'), 'utf8'),
    /dsh-tui-run\.mjs/)
  assert.deepEqual(JSON.parse(DSH_TUI_PACKAGE), { type: 'module', private: true })
  assert.equal(dshTuiSupported('darwin'), true)
  assert.equal(dshTuiSupported('linux'), true)
  assert.equal(dshTuiSupported('win32'), false)
})

test('the doctor is printed as the module CLI prints it, fixes included', () => {
  const text = formatDoctor([
    { check: 'dsh', ok: true, detail: '/opt/dsh/bin/dsh', fix: null },
    { check: 'dsh-tui-shim', ok: false, detail: 'missing', fix: 'automagik-herdr dsh-tui install' },
  ])
  assert.equal(text, 'ok   dsh: /opt/dsh/bin/dsh\n'
    + 'FAIL dsh-tui-shim: missing (fix: automagik-herdr dsh-tui install)')
})

// A doctor answer as the runner builds it: the shared checks, the presence facts and the pin.
function answerOf({ code = 2, profile = false, shim = false, pinned = false, skip = null } = {}) {
  const check = (name, ok, detail) => ({
    check: name, ok, detail, fix: ok ? null : 'automagik-herdr dsh-tui install',
  })
  return {
    ok: true,
    pin: PIN,
    profile: 'dsh-tui',
    skip,
    presence: { profile, shimExists: shim, pinned },
    result: {
      code,
      checks: [
        check('dsh', true, '/opt/dsh/bin/dsh'),
        check('dsh-tui-profile', profile && pinned,
          profile ? `${PIN}, integrity ok` : 'not installed'),
        check('dsh-tui-shim', shim, shim ? '/opt/dsh/bin/dsh-tui' : 'not installed'),
      ],
    },
  }
}

test('no DSH: the exact skip line, and only Close; nothing offers an install', () => {
  const view = setupView({ answer: answerOf({ skip: SKIP }), platform: 'linux' })
  assert.equal(view.message, 'DSH is not installed')
  assert.ok(view.detail.startsWith(SKIP))
  assert.match(view.detail, /FAIL dsh-tui-profile/)
  assert.deepEqual(view.buttons.map(button => button.id), ['close'])
  assert.equal(view.buttons[0].label, 'Close')
})

test('not installed: Install names the pin and says what is written and what is not', () => {
  const view = setupView({ answer: answerOf(), platform: 'linux' })
  assert.equal(view.message, 'DSH in Herdr')
  assert.deepEqual(view.buttons.map(button => button.id), ['install', 'close'])
  assert.match(view.buttons[0].label, /Install dsh-TUI 0\.19\.0/)
  assert.match(view.detail, /dsh-tui DSH profile \(never the reserved desktop profile\)/)
  assert.match(view.detail, /user bin folder/)
  assert.match(view.detail, /never writes DSH's credentials/)
  assert.match(view.detail, /\/model \(DeepSeek Account\) or \/auth/)
  assert.match(view.detail, /Sessions land in your DSH home.*no live refresh/s)
})

test('set up: Reinstall / update and Uninstall; broken: Repair; both keep sessions', () => {
  const healthy = setupView({
    answer: answerOf({ code: 0, profile: true, shim: true, pinned: true }), platform: 'linux',
  })
  assert.equal(healthy.message, 'DSH in Herdr is set up')
  assert.deepEqual(healthy.buttons.map(button => button.id), ['install', 'uninstall', 'close'])
  assert.equal(healthy.buttons[0].label, 'Reinstall / update')
  assert.match(healthy.detail, /keeps the dsh-tui profile on dsh-TUI 0\.19\.0/)
  assert.match(healthy.detail, /sessions and dsh-TUI's state stay/)
  const broken = setupView({
    answer: answerOf({ code: 1, profile: true, shim: true }), platform: 'linux',
  })
  assert.equal(broken.message, 'DSH in Herdr needs repair')
  assert.equal(broken.buttons[0].label, 'Repair dsh-TUI')
  assert.match(broken.detail, /FAIL dsh-tui-profile/)
})

test('a failed doctor and Windows say so, and offer nothing to run', () => {
  const failed = setupView({ answer: { ok: false, error: 'runner failed' }, platform: 'linux' })
  assert.equal(failed.type, 'warning')
  assert.match(failed.detail, /runner failed/)
  assert.deepEqual(failed.buttons.map(button => button.id), ['close'])
  const windows = setupView({ answer: answerOf(), platform: 'win32' })
  assert.equal(windows.message, 'DSH in Herdr is not available here')
  assert.match(windows.detail, /POSIX shell script/)
  assert.deepEqual(windows.buttons.map(button => button.id), ['close'])
})

test('an install result carries the module lines, and a skip carries the exact line', () => {
  const installed = resultView({
    action: 'install',
    answer: {
      ok: true,
      result: { status: 'installed', lines: ['installed the pin', 'Sessions go to your DSH home'] },
    },
  })
  assert.equal(installed.message, 'dsh-TUI is set up')
  assert.equal(installed.detail, 'installed the pin\nSessions go to your DSH home')
  const skipped = resultView({
    action: 'install',
    answer: { ok: true, result: { status: 'skipped', lines: [SKIP], detail: SKIP } },
  })
  assert.equal(skipped.message, 'DSH is not installed')
  assert.equal(skipped.detail, SKIP)
  const failed = resultView({
    action: 'install',
    answer: { ok: true, result: { status: 'failed', detail: 'pnpm said no', lines: [] } },
  })
  assert.equal(failed.type, 'warning')
  assert.match(failed.detail, /pnpm said no/)
  const removed = resultView({
    action: 'uninstall',
    answer: { ok: true, result: { status: 'removed', lines: ['removed'] } },
  })
  assert.equal(removed.message, 'dsh-TUI removed')
})

test('PATH: only when the user bin folder is missing, with the right line', () => {
  const home = resolve(tmpdir(), 'automagik-home')
  const binDir = join(home, '.local', 'bin')
  const pane = {
    shell: '/bin/zsh', config: join(home, '.zshrc'),
    path: ['/usr/bin', '/bin'].join(delimiter), login: true,
  }
  const action = pathActionOf({ pane, home, platform: 'linux' })
  assert.equal(action.binDir, binDir)
  assert.equal(action.config, join(home, '.zshrc'))
  assert.match(action.line, /^export PATH=".*:\$PATH"$/)
  assert.match(action.mark, /dsh-tui shim/)
  const withBin = { ...pane, path: ['/usr/bin', binDir].join(delimiter) }
  assert.equal(pathActionOf({ pane: withBin, home, platform: 'linux' }), null)
  const fishPane = { ...pane, shell: '/usr/local/bin/fish', config: join(home, 'config.fish') }
  const fish = pathActionOf({ pane: fishPane, home, platform: 'linux' })
  assert.match(fish.line, /^fish_add_path "/)
  assert.equal(pathActionOf({ pane, home, platform: 'win32' }), null)
  assert.equal(pathActionOf({ pane: null, home, platform: 'linux' }), null)
  assert.match(pathView(action).detail, /Add this line to/)
  assert.match(pathDoneView(action).detail, /Restart Herdr/)
})

test('the PATH line is written once, keeping the file, and never over one that has it', (t) => {
  const root = SCRATCH()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, '.zshrc')
  writeFileSync(config, 'alias ll="ls -l"')
  const binDir = join(root, '.local', 'bin')
  const action = { binDir, config, shell: '/bin/zsh',
    line: `export PATH="${binDir}:$PATH"`, mark: '# Automagik: the dsh-tui shim' }
  const first = ensurePathLine({ action })
  assert.equal(first.changed, true)
  const text = readFileSync(config, 'utf8')
  assert.ok(text.startsWith('alias ll="ls -l"\n# Automagik: the dsh-tui shim\n'))
  assert.equal(text.split(action.line).length - 1, 1)
  assert.equal(ensurePathLine({ action }).changed, false)
  assert.equal(readFileSync(config, 'utf8'), text)
  // A file that already names the folder, under either spelling, is left exactly as it is.
  const already = [
    `${action.line}\n`,
    `export PATH="${action.binDir}:$PATH"\n`,
  ]
  for (const line of already) {
    writeFileSync(config, line)
    assert.equal(ensurePathLine({ action }).changed, false)
    assert.equal(readFileSync(config, 'utf8'), line)
  }
  // A config folder that does not exist yet (fish) is made.
  const fish = {
    ...action,
    config: join(root, '.config', 'fish', 'config.fish'),
    line: `fish_add_path "${action.binDir}"`,
  }
  assert.equal(ensurePathLine({ action: fish }).changed, true)
  assert.match(readFileSync(fish.config, 'utf8'), /^# Automagik: the dsh-tui shim\nfish_add_path/)
})

test('the runner is a child of this Electron as Node, and its answer is read', async () => {
  let seen
  const execFile = (file, args, options, done) => {
    seen = { file, args, options }
    done(null, 'some login shell noise\n{"action":"doctor","result":{"code":2}}\n', '')
  }
  const answer = await runDshTui({
    action: 'doctor', moduleDir: '/repo/am', execFile, node: '/electron', env: { PATH: '/bin' },
  })
  assert.equal(seen.file, '/electron')
  assert.deepEqual(seen.args, [RUNNER, 'doctor'])
  assert.equal(seen.options.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(seen.options.env.AUTOMAGIK_DSH_TUI_MODULE, '/repo/am')
  assert.equal(seen.options.env.PATH, '/bin')
  assert.equal(answer.ok, true)
  assert.equal(answer.action, 'doctor')
  assert.equal(answer.result.code, 2)
})

test('a runner error is one honest line, never a silent failure', async () => {
  const failure = (error, stdout, stderr) => (file, args, options, done) =>
    done(error, stdout, stderr)
  const spawnFailed = await runDshTui({
    action: 'install', moduleDir: '/x', execFile: failure(new Error('ENOENT'), '', ''),
  })
  assert.equal(spawnFailed.ok, false)
  assert.match(spawnFailed.error, /ENOENT/)
  const explained = await runDshTui({ action: 'install', moduleDir: '/x',
    execFile: failure(null, '{"error":"dsh is missing"}', '') })
  assert.equal(explained.ok, false)
  assert.equal(explained.error, 'dsh is missing')
  const noisy = await runDshTui({ action: 'install', moduleDir: '/x',
    execFile: failure(new Error('exited 1'), 'not json', 'a login shell line\nlast line\n') })
  assert.equal(noisy.ok, false)
  assert.equal(noisy.error, 'last line')
})

// A fake `dsh` that initializes the dsh-tui profile the way DSH 0.2.2 does: base + the TUI bundle,
// the exact pin and its lockfile integrity. Every argv goes to DSH_LOG.
function scene(t) {
  const root = mkdtempSync(join(tmpdir(), 'automagik-dsh-tui-e2e-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const log = join(root, 'dsh.log')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(log, '')
  const localBin = join(home, '.local', 'bin')
  // The login shell's PATH is the scene's, set outright and never appended to the machine's
  // login PATH, so the fake dsh is the only one a test can reach.
  const scenePath = `${bin}:${localBin}:/usr/bin:/bin`
  writeFileSync(join(home, '.profile'), `export PATH="${scenePath}"\n`)
  const helper = join(root, 'fake-dsh.cjs')
  writeFileSync(helper, `
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
const dshHome = process.env.DSH_HOME || path.join(process.env.HOME, '.dsh')
const TUI = '@deepseek-harness-tui/dsh-tui', VERSION = '0.19.0'
const INTEGRITY = 'sha512-4TAPhsTqfL+oG1H39Fbj13tfaVVGnwV9N33dV8Acn/'
  + 'YBoZT/YgXwF+ZnbhvRi0l55bNc6X6loKkngxrNL8NX3w=='
fs.appendFileSync(process.env.DSH_LOG, args.join(' ') + '\\n')
const dir = path.join(dshHome, 'profiles', 'dsh-tui')
const pkg = path.join(dir, 'node_modules', '@deepseek-harness-tui', 'dsh-tui')
const ours = args[0] === 'plugin' && args[1] === '--profile' && args[2] === 'dsh-tui'
if (ours && args[3] === 'add') {
  fs.mkdirSync(pkg, { recursive: true })
  const manifest = { name: 'dsh-profile-dsh-tui', dependencies: { [TUI]: VERSION },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', TUI] } } }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest) + '\\n')
  const exclude = "minimumReleaseAgeExclude:\\n  - '" + TUI + '@' + VERSION + "'\\n"
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), exclude)
  const lock = 'packages:\\n\\n  ' + "'" + TUI + '@' + VERSION + "':\\n"
    + '    resolution: {integrity: ' + INTEGRITY + '}\\n\\n'
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), lock)
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: VERSION }) + '\\n')
} else if (ours && args[3] === 'remove') {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  delete manifest.dependencies[TUI]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== TUI)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest) + '\\n')
  fs.rmSync(pkg, { recursive: true, force: true })
}
`)
  const dsh = join(bin, 'dsh')
  writeFileSync(dsh, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`)
  chmodSync(dsh, 0o755)
  const env = {
    HOME: home, SHELL: process.env.DSH_TUI_TEST_SHELL || '/bin/sh', PATH: scenePath,
    DSH_HOME: '', DSH_LOG: log, AUTOMAGIK_DSH_TUI_MODULE: AM,
    AUTOMAGIK_HERDR_DSH_TUI_PUBLISHED: new Date(Date.now() - 3600e3).toISOString(),
  }
  const pane = panePathOf({ env })
  assert.equal(pane.login, true, 'the login shell answered')
  assert.equal(pane.path, env.PATH, "the login shell gives the pane exactly the scene's PATH")
  assert.equal(pane.config, '~/.profile')
  const runner = (action, extra = {}) => {
    const result = spawnSync(process.execPath, [RUNNER, action], {
      cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { root, home, bin, env, pane, runner, calls, dsh }
}

test('end to end: the runner installs, doctors, updates and uninstalls', posixOnly, (t) => {
  const s = scene(t)
  const installed = s.runner('install')
  assert.equal(installed.result.status, 'installed', JSON.stringify(installed.result))
  assert.equal(installed.pin, PIN)
  assert.equal(installed.profile, 'dsh-tui')
  assert.equal(installed.presence.profile, true)
  assert.equal(installed.presence.pinned, true)
  assert.equal(installed.presence.owned, true)
  assert.equal(installed.presence.shimExists, true)
  const shim = join(s.home, '.local', 'bin', 'dsh-tui')
  assert.match(readFileSync(shim, 'utf8'), /^exec dsh --profile dsh-tui "\$@"$/m)
  assert.ok(!readFileSync(shim, 'utf8').includes('--profile tui'))
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, '.dsh-tui', 'onboarding.json'), 'utf8')),
    { completed: true, version: 1 })
  const workspace = readFileSync(
    join(s.home, '.dsh', 'profiles', 'dsh-tui', 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace,
    /minimumReleaseAgeExclude:\n {2}- '@deepseek-harness-tui\/dsh-tui@0\.19\.0'/)
  assert.deepEqual(s.calls(), [`plugin --profile dsh-tui add ${PIN} --save-exact`])

  const doctor = s.runner('doctor')
  assert.equal(doctor.result.code, 0, JSON.stringify(doctor.result.checks))
  assert.equal(doctor.result.skip, null)
  assert.ok(doctor.result.checks.every(check => check.ok))
  assert.equal(doctor.pane.login, true, 'the login shell answered')
  assert.equal(doctor.pane.path, s.env.PATH, "the login shell gives the pane exactly the scene's PATH")
  assert.ok(doctor.pane.path.split(delimiter).includes(join(s.home, '.local', 'bin')))

  const updated = s.runner('install')
  assert.equal(updated.result.status, 'installed')
  assert.match(updated.result.lines[0], /already installed/)

  const removed = s.runner('uninstall')
  assert.equal(removed.result.status, 'removed')
  assert.equal(existsSync(shim), false)
  assert.equal(s.calls().at(-1), 'plugin --profile dsh-tui remove @deepseek-harness-tui/dsh-tui')
  const manifest = JSON.parse(readFileSync(
    join(s.home, '.dsh', 'profiles', 'dsh-tui', 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dependencies, {})
})

test('plain install accepts a temp/project data root; proxy approve refuses it', posixOnly, (t) => {
  const s = scene(t)
  mkdirSync(join(s.root, '.herdr'))
  writeFileSync(join(s.root, '.herdr', 'bots.json'),
    JSON.stringify({ version: 1, categories: [], bots: [] }))
  const installed = s.runner('install')
  assert.equal(installed.error, undefined, JSON.stringify(installed))
  assert.equal(installed.result.status, 'installed', JSON.stringify(installed.result))
  const approved = spawnSync(process.execPath,
    [join(AM, 'bin', 'automagik-herdr.mjs'), 'proxy', 'approve', '--project', s.root],
    { cwd: s.root, env: s.env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(approved.status, 1, approved.stderr)
  assert.match(approved.stderr, /approved data root .* is inside the project/)
  assert.equal(existsSync(join(s.home, '.local', 'share', 'automagik-herdr', 'approved')), false)
})

test('end to end: a dsh only the app sees is skipped', posixOnly, (t) => {
  const s = scene(t)
  writeFileSync(join(s.home, '.profile'), 'export PATH="/usr/bin:/bin"\n')
  const pane = panePathOf({ env: s.env })
  assert.equal(pane.login, true, 'the login shell answered')
  assert.equal(pane.path, '/usr/bin:/bin')
  assert.equal(pane.config, '~/.profile')
  assert.equal(findDsh({ ...s.env, PATH: pane.path }), null, 'the login shell PATH has no dsh')
  const doctor = s.runner('doctor', { PATH: `${s.bin}:/usr/bin:/bin` })
  assert.equal(doctor.result.skip, SKIP)
  assert.equal(doctor.pane.path, '/usr/bin:/bin')
  const dsh = doctor.result.checks.find(check => check.check === 'dsh')
  assert.match(dsh.detail, /is on this process's PATH/)
  const installed = s.runner('install', { PATH: `${s.bin}:/usr/bin:/bin` })
  assert.equal(installed.result.status, 'skipped')
  assert.deepEqual(installed.result.lines, [SKIP])
  assert.equal(existsSync(join(s.home, '.local')), false)
})

test('end to end: no dsh is the exact skip line, and nothing is written', posixOnly, (t) => {
  const s = scene(t)
  rmSync(s.dsh)
  // No scene bin either: the pane PATH has no dsh entry at all, so a real machine dsh cannot leak in.
  writeFileSync(join(s.home, '.profile'), 'export PATH="/usr/bin:/bin"\n')
  const pane = panePathOf({ env: s.env })
  assert.equal(pane.login, true, 'the login shell answered')
  assert.equal(pane.path, '/usr/bin:/bin')
  assert.equal(pane.config, '~/.profile')
  assert.equal(findDsh({ ...s.env, PATH: pane.path }), null, 'no dsh on the scene pane PATH')
  const installed = s.runner('install')
  assert.equal(installed.result.status, 'skipped')
  assert.deepEqual(installed.result.lines, [SKIP])
  const doctor = s.runner('doctor')
  assert.equal(doctor.result.code, 2)
  assert.equal(doctor.result.skip, SKIP)
  assert.equal(doctor.pane.path, '/usr/bin:/bin')
  assert.equal(existsSync(join(s.home, '.local')), false)
  assert.equal(existsSync(join(s.home, '.dsh-tui')), false)
  assert.equal(existsSync(join(s.home, '.dsh')), false)
  assert.deepEqual(s.calls(), [])
})
