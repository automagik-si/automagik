#!/usr/bin/env node
// Boots the plugins for real: a DSH web profile with this checkout's Bot team and welcome and
// Omni's channels and canvases (from the Omni release apps/desktop/omni.json pins, or
// OMNI_SOURCE) and the add-ons apps/desktop/profile pins, installed the way DSH installs any
// plugin (`dsh plugin install`, pnpm), on the DSH the Bot team is tested on. Headless Chromium
// then opens it and checks that the web UI comes up with every plugin active: DSH refuses to
// boot the whole UI when one plugin's client import misses, so this is where a renamed package
// that another plugin imports, or an add-on pinned to a development build, would show.
//
//   node scripts/boot-check.mjs [--keep <dir>] [--shot <png>] [--acp-shots <dir>] [--acp-ready] [--port <n>]
//
// It also reads acp-dsh's acpAgents service through the welcome and flips one switch live
// (read back, then put back); --acp-shots screenshots the Claude Code and Codex rows in each
// state, in Connect AI and in Settings, from fixtures the page's acp calls get; --acp-ready
// waits for a real connector to land (it downloads) and checks its model is listed.
//
// Needs the Bot team's harness (`bun run harness` in apps/bots-dsh), git, and a Chromium:
// CHROME_BIN, else google-chrome or chromium on PATH, else Playwright's headless shell.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(ROOT, 'package.json'))
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []))
// The welcome's onboarding steps (welcome-dsh host endpoint.js FLAGS): marking each done is what
// finishing it does, so the second page is the app after onboarding.
const DONE_STEPS = ['omni-companion', 'omni-team', 'omni-welcome', 'omni-migrate', 'omni-connect', 'omni-connect-ai']
const say = line => console.log(`[boot-check] ${line}`)
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const env = { ...process.env, DO_NOT_TRACK: '1', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_update_notifier: 'false' }

const work = args.keep ? resolve(args.keep) : mkdtempSync(join(tmpdir(), 'automagik-boot-'))
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const DSH_BIN = join(ROOT, 'apps', 'bots-dsh', 'dev', 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(DSH_BIN)) throw new Error('no DSH: run `bun run harness` in apps/bots-dsh first')

// Omni at the pinned release: only its plugin folders.
const OMNI = readJson(join(ROOT, 'apps', 'desktop', 'omni.json'))
let omniDir = process.env.OMNI_SOURCE ? resolve(process.env.OMNI_SOURCE) : join(work, 'omni')
if (!process.env.OMNI_SOURCE) {
  say(`fetching Omni ${OMNI.version} (${OMNI.commit.slice(0, 9)})`)
  mkdirSync(omniDir, { recursive: true })
  const git = argv => execFileSync('git', argv, { cwd: omniDir, env, stdio: ['ignore', 'pipe', 'inherit'] })
  git(['init', '-q'])
  git(['remote', 'add', 'origin', OMNI.repository])
  git(['sparse-checkout', 'set', '--no-cone', '/apps/omni-channels-dsh/', '/apps/omni-canvas-dsh/'])
  git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', OMNI.commit])
  git(['checkout', '-q', 'FETCH_HEAD'])
}
omniDir = resolve(omniDir)

const folders = [join(ROOT, 'apps', 'bots-dsh'), join(omniDir, 'apps', 'omni-channels-dsh'), join(omniDir, 'apps', 'omni-canvas-dsh'), join(ROOT, 'apps', 'welcome-dsh'), join(ROOT, 'apps', 'acp-dsh')]
const dshHome = join(work, 'dsh')
const profileDir = join(dshHome, 'profiles', 'boot')
mkdirSync(join(profileDir, 'vendor'), { recursive: true })
const packed = folders.map((dir) => {
  const [info] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', join(profileDir, 'vendor')], { cwd: dir, env, encoding: 'utf8' }))
  // A plugin with no browser half (acp-dsh) is never in the client graph; it must still activate.
  return { name: info.name, version: info.version, file: info.filename, client: readJson(join(dir, 'package.json')).dsh?.client !== undefined }
})
say(`packed ${packed.map(pkg => `${pkg.name}@${pkg.version}`).join(', ')}`)
// The add-ons the desktop profile pins (dsh-subscriptions), at those very pins:
// they are in the same client graph, and one bad client fails the whole UI (v3.53.0).
const desktopProfile = readJson(join(ROOT, 'apps', 'desktop', 'profile', 'package.json'))
const addons = Object.entries(desktopProfile.dependencies).filter(([name]) => !packed.some(pkg => pkg.name === name) && !name.startsWith('@automagik/'))
say(`add-ons ${addons.map(([name, spec]) => `${name}@${spec}`).join(', ')}`)
writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'automagik-boot-check',
  private: true,
  dependencies: { ...Object.fromEntries(packed.map(pkg => [pkg.name, `file:vendor/${pkg.file}`])), ...Object.fromEntries(addons) },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...packed.map(pkg => pkg.name), ...addons.map(([name]) => name)] } },
}, null, 2)}\n`)
cpSync(join(ROOT, 'apps', 'desktop', 'profile', 'pnpm-workspace.yaml'), join(profileDir, 'pnpm-workspace.yaml'))
// DSH's plugin manager runs pnpm: the release the desktop app ships.
const shims = join(work, 'bin')
mkdirSync(shims, { recursive: true })
writeFileSync(join(shims, 'pnpm'), '#!/bin/sh\nexec npx --yes pnpm@10.34.6 "$@"\n', { mode: 0o755 })
const dshEnv = { ...env, DSH_HOME: dshHome, AUTOMAGIK_HOME: join(work, 'automagik-home'), OMNI_HOME: join(work, 'omni-home'), PATH: `${shims}:${env.PATH}` }
execFileSync(process.execPath, [DSH_BIN, 'plugin', '--profile', 'boot', 'install', '--prod', '--ignore-scripts'], { cwd: profileDir, env: dshEnv, stdio: ['ignore', 'inherit', 'inherit'] })

function chrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { encoding: 'utf8' }).trim()
    } catch {}
  }
  const cache = join(homedir(), '.cache', 'ms-playwright')
  const shell = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium_headless_shell-')).sort().at(-1) : undefined
  if (shell) return join(cache, shell, 'chrome-headless-shell-linux64', 'chrome-headless-shell')
  throw new Error('no Chromium: set CHROME_BIN')
}

// The welcome's host endpoint, called from the page with its session cookie.
const omniAi = (page, endpoint, payload) => page.evaluate(async ([endpoint, payload]) => {
  const response = await fetch('api/omni-ai', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload }) })
  return response.json()
}, [endpoint, payload ?? null])

// acp-dsh's acpAgents service, read through the welcome's host, and one switch written to
// acp-dsh's live settings and read back (then put back): no restart, no agent turn.
async function checkAcp(page, problems) {
  const first = await omniAi(page, 'acp', { refresh: true })
  if (first?.value?.available !== true) return problems.push(`acp: the welcome cannot read acp-dsh's acpAgents service: ${JSON.stringify(first).slice(0, 300)}`)
  say(`acp: ${first.value.agents.map(agent => `${agent.id} ${agent.on ? 'on' : 'off'}, cli ${agent.cli.found ? 'found' : 'missing'}, connector ${agent.connector.state}${agent.listed ? ' (in the picker)' : ''}${agent.signedIn === undefined ? '' : agent.signedIn ? ', signed in' : ', signed out'}`).join('; ')}`)
  const before = first.value.agents.find(agent => agent.id === 'acp-codex')
  const readBack = async (on) => {
    for (let i = 0; i < 20; i++) {
      const now = (await omniAi(page, 'acp'))?.value?.agents?.find(agent => agent.id === 'acp-codex')
      if (now?.on === on) return now
      await page.waitForTimeout(250)
    }
    return undefined
  }
  for (const on of [!before.on, before.on]) {
    const wrote = await omniAi(page, 'acp-switch', { id: 'acp-codex', on })
    if (wrote?.ok !== true) return problems.push(`acp: the switch was refused: ${JSON.stringify(wrote).slice(0, 300)}`)
    const now = await readBack(on)
    if (now === undefined) return problems.push(`acp: acp-codex did not read back ${on ? 'on' : 'off'} after its switch`)
    say(`acp: acp-codex switched ${on ? 'on' : 'off'} live, connector ${now.connector.state}${now.listed ? ' (in the picker)' : ''}`)
  }
  // --acp-ready: a connector that lands while DSH runs is in DSH's model registry, no restart.
  if (!('acp-ready' in args)) return
  for (let i = 0; i < 90; i++) {
    const ready = (await omniAi(page, 'acp'))?.value?.agents?.filter(agent => agent.on && agent.connector.state === 'ready') ?? []
    if (ready.length > 0) {
      for (const agent of ready) {
        if (agent.listed !== true) problems.push(`acp: ${agent.id}'s connector is ready but its model is not listed`)
        else say(`acp: ${agent.id}'s connector landed (${agent.connector.version}); its model is listed with no restart`)
      }
      return
    }
    await page.waitForTimeout(2000)
  }
  problems.push('acp: no connector landed within 3 minutes')
}

// The Claude Code and Codex rows in each state, from fixtures the page's acp calls get (the
// rest of the host is real): Connect AI, then the Settings page. --acp-shots <dir>.
const row = (id, over) => ({ id, key: id === 'acp-claude' ? 'claude' : 'codex', name: id === 'acp-claude' ? 'Claude Code' : 'Codex', on: true, cli: { found: true, installUrl: id === 'acp-claude' ? 'https://code.claude.com/docs/en/setup' : 'https://developers.openai.com/codex/cli' }, connector: { state: 'ready', version: '0.31.0' }, signedIn: true, listed: true, restartNeeded: false, ...over })
const ACP_STATES = {
  'not-installed': [row('acp-claude', { cli: { found: false, installUrl: 'https://code.claude.com/docs/en/setup' }, connector: { state: 'no-cli' }, signedIn: undefined, listed: false }), row('acp-codex', { cli: { found: false, installUrl: 'https://developers.openai.com/codex/cli' }, connector: { state: 'no-cli' }, signedIn: undefined, listed: false })],
  'installing': [row('acp-claude', { connector: { state: 'installing' }, listed: false }), row('acp-codex', { on: false, connector: { state: 'off' }, listed: false })],
  'failed': [row('acp-claude', { connector: { state: 'failed', error: 'npm answered 503 for @agentclientprotocol/claude-agent-acp' }, listed: false }), row('acp-codex', { connector: { state: 'installing' }, signedIn: false, listed: false })],
  'ready': [row('acp-claude'), row('acp-codex', { signedIn: false })],
  'restart-needed': [row('acp-claude', { listed: false, restartNeeded: true }), row('acp-codex')],
}
const SAYS = {
  'not-installed': /The claude CLI is not on this computer[\s\S]*Install Claude Code[\s\S]*The codex CLI is not on this computer/,
  'installing': /Installing its connector in the background[\s\S]*Off\. Turn it on to use Codex/,
  'failed': /The connector did not install: npm answered 503[\s\S]*Retry[\s\S]*Not signed in\. Run codex login/,
  'ready': /Ready: pick Claude Code in the model picker[\s\S]*Ready: pick Codex in the model picker/,
  'restart-needed': /Restart DSH to see Claude Code in the model picker/,
  'without-acp-dsh': /^(?![\s\S]*coding agents)[\s\S]*turn on your ais/i,
}
const visible = value => (Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)))

async function acpShots(browser, url, dir, problems) {
  mkdirSync(dir, { recursive: true })
  const open = async (agents, flags) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } })
    await page.route('**/api/omni-ai', async (route) => {
      const body = route.request().postDataJSON() ?? {}
      if (body.endpoint === 'acp') return route.fulfill({ json: { ok: true, value: agents ? { available: true, agents: agents.map(visible) } : { available: false, agents: [] } } })
      if (body.endpoint === 'acp-switch' || body.endpoint === 'acp-retry') return route.fulfill({ json: { ok: true, value: { available: true, agents: agents.map(visible) } } })
      if (body.endpoint === 'state') {
        const real = await (await route.fetch()).json()
        return route.fulfill({ json: { ...real, value: { ...real.value, ...flags } } })
      }
      return route.continue()
    })
    await page.goto(url)
    return page
  }
  // Connect AI is the step shown: the ones before it are done.
  const before = { companionDone: true, teamDone: true, connectOmniSkipped: true, connectAiDone: false }
  for (const [state, agents] of [...Object.entries(ACP_STATES), ['without-acp-dsh', null]]) {
    const page = await open(agents, before)
    try {
      await page.getByText('Turn on your AIs').first().waitFor({ timeout: 90_000 })
      if (agents) await page.locator('.oai-acp').first().waitFor({ timeout: 30_000 })
      else await page.waitForTimeout(2000)
      // Each shot is checked against what its state must say.
      const text = await page.locator('.oai-card').first().innerText()
      if (!SAYS[state].test(text)) problems.push(`acp shot ${state}: the card does not say ${SAYS[state]}`)
      const file = join(dir, `connect-ai-${state}.png`)
      await page.locator('.oai-card').first().screenshot({ path: file })
      say(`shot ${file}`)
    } catch (error) {
      problems.push(`acp shot ${state}: ${error.message.split('\n')[0]}`)
    } finally {
      await page.close()
    }
  }
  // After onboarding: Settings → Claude Code and Codex.
  const page = await open(ACP_STATES.ready, { companionDone: true, teamDone: true, connectOmniSkipped: true, connectAiDone: true, welcomeDone: true })
  try {
    await page.locator('.lb-row').first().waitFor({ timeout: 90_000 })
    await page.waitForTimeout(3000)
    // DSH's own onboarding steps (its Preview Notice, a DeepSeek sign-in) go first.
    for (let i = 0; i < 4; i++) {
      const next = page.getByRole('button', { name: /^(Continue|Skip|Skip for now|Not now|Later)$/ }).first()
      if (!(await next.isVisible().catch(() => false))) break
      await next.click()
      await page.waitForTimeout(800)
    }
    // The Bot team's Account menu → Bot settings, which lists the pages plugins add; else
    // DSH's own settings.open shortcut (as the Bot team presses it).
    const entry = page.getByText('Claude Code and Codex', { exact: true }).first()
    const botSettings = async () => {
      await page.locator('button[aria-label="Account"]').first().click({ timeout: 5000 })
      await page.getByText('Bot settings', { exact: true }).first().click({ timeout: 5000 })
    }
    for (const open of [botSettings, () => page.keyboard.press('Meta+Comma'), () => page.keyboard.press('Control+Comma')]) {
      await open().catch(() => {})
      await page.waitForTimeout(1500)
      if (await entry.isVisible().catch(() => false)) break
    }
    await entry.click({ timeout: 10_000 })
    await page.locator('.oai-acp-page .oai-acp').first().waitFor({ timeout: 15_000 })
    const file = join(dir, 'settings-ready.png')
    await page.screenshot({ path: file })
    say(`shot ${file}`)
  } catch (error) {
    await page.screenshot({ path: join(dir, 'settings-debug.png') }).catch(() => {})
    say(`settings buttons: ${(await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.innerText.trim()).filter(Boolean).slice(0, 60).join(' | ')).catch(() => '')).slice(0, 1500)}`)
    say(`settings page text: ${(await page.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 1200)}`)
    problems.push(`acp shot settings: ${error.message.split('\n')[0]}`)
  } finally {
    await page.close()
  }
}

const port = String(args.port ?? 39400 + Math.floor(Math.random() * 500))
// DSH leads its own process group, so what it starts stops with it. acp-dsh's background adapter
// install (an npm or pnpm writing into AUTOMAGIK_HOME under `work`) is not in it: it leads a group
// of its own, which only DSH's dispose stops. DSH disposes on SIGTERM, so DSH gets a SIGTERM and a
// moment before any SIGKILL, or the install would still be writing when `work` is removed.
const dsh = spawn(process.execPath, [DSH_BIN, '--profile', 'boot', '--no-open', '--host', '127.0.0.1', '--port', port], { cwd: work, env: dshEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const signalGroup = (signal) => {
  try {
    process.kill(-dsh.pid, signal)
    return true
  } catch {
    return false
  }
}
// One stop for both ways out, the end of the run and a signal: DSH takes a second SIGTERM as
// "exit now" and would skip its dispose. SIGTERM, DSH's exit (its dispose done) or `graceMs`, then
// whatever is left in DSH's group goes too, and is gone before `work` is.
let stopping
const stopDsh = graceMs => stopping ??= (async () => {
  signalGroup('SIGTERM')
  await new Promise((done) => {
    if (dsh.exitCode !== null || dsh.signalCode !== null) return done()
    const timer = setTimeout(done, graceMs)
    dsh.once('exit', () => {
      clearTimeout(timer)
      done()
    })
  })
  signalGroup('SIGKILL')
  for (let i = 0; i < 50 && signalGroup(0); i++) await new Promise(done => setTimeout(done, 100))
})()
// The verdict is the checks': a folder that will not go is reported, never a failure.
const removeWork = () => {
  if (args.keep) return
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    say(`cleanup: ${work} was not removed (${error.code ?? error.message}); the result above stands`)
  }
}
// Out of this terminal's group, DSH would outlive a Ctrl-C or a closed terminal here: stop it too,
// SIGTERM first (up to 3 s) so its dispose stops the install. A second Ctrl-C quits at once.
let interrupted
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, async () => {
    interrupted = code
    await stopDsh(3000)
    removeWork()
    process.exit(code)
  })
}
let log = ''
let failed = true
try {
  const url = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`dsh did not start:\n${log.slice(-3000)}`)), 180_000)
    const onData = (chunk) => {
      log += chunk
      const match = log.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*token=\S+)/)
      if (match) {
        clearTimeout(timer)
        done(match[1])
      }
    }
    dsh.stdout.on('data', onData)
    dsh.stderr.on('data', onData)
    dsh.once('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`dsh exited ${code}:\n${log.slice(-3000)}`))
    })
  })
  say(`dsh up on ${port}`)
  const { chromium } = require('playwright-core')
  // The signals are this script's (above): Playwright's own SIGINT handler would exit at once,
  // before DSH has disposed. Its exit hook still kills the browser.
  const browser = await chromium.launch({ executablePath: chrome(), handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const problems = []
    page.on('pageerror', error => problems.push(`page error: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error' && /client-modules|did not activate|not loaded because/.test(message.text())) problems.push(`console: ${message.text()}`)
    })
    await page.goto(url)
    // Two pages, each checked on its own. First run: the welcome's stage (stage.js, every
    // onboarding step). scripts/boot-check-selectors.test.ts keeps every class waited on here
    // drawn by a client, so a rename fails a test, not the boot.
    await page.locator('.oai-stage').first().waitFor({ timeout: 90_000 }).catch(() => problems.push('the first-run welcome did not show'))
    await page.waitForTimeout(3000)
    const entries = await page.evaluate(() => (window.__DSH_BOOT__?.entries ?? []).map(row => row.id ?? row.name))
    const body = await page.evaluate(() => document.body.innerText)
    if (/did not activate|Failed to load plugins/i.test(body)) problems.push(`the web UI did not boot: ${body.slice(0, 600)}`)
    for (const name of [...packed.filter(pkg => pkg.client).map(pkg => pkg.name), ...addons.map(([addon]) => addon)]) if (!entries.includes(name)) problems.push(`${name} is not in the client graph`)
    if (args.shot) await page.screenshot({ path: resolve(args.shot) })
    say(`client graph: ${entries.filter(id => id.startsWith('@automagik/')).join(', ')}`)
    await checkAcp(page, problems)
    if (args['acp-shots']) await acpShots(browser, url, resolve(args['acp-shots']), problems)
    // After onboarding: every step marked done through the welcome's own call (stage.js
    // request('done'), what finishing a step sends), in this run's scratch home; then the open
    // sidebar must show the team's rows in the new left bar (the window is wide, so the narrow
    // rail is not drawn).
    const marked = await page.evaluate(ids => Promise.all(ids.map(stepId => fetch('api/omni-ai', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'done', payload: { stepId } }),
    }).then(response => response.json()).then(answer => answer.ok === true, () => false))), DONE_STEPS)
    if (!marked.every(Boolean)) problems.push(`onboarding could not be marked done: ${DONE_STEPS.filter((_, i) => !marked[i]).join(', ')}`)
    await page.reload()
    const team = await page.locator('.lb-row').first().waitFor({ timeout: 90_000 }).then(() => true, () => false)
    if (!team) problems.push('after onboarding the Bot team did not show')
    await page.waitForTimeout(1500)
    if (await page.locator('.oai-stage').count() > 0) problems.push('after onboarding the welcome still shows')
    if (args.shot) await page.screenshot({ path: resolve(args.shot).replace(/(\.png)?$/, '-team.png') })
    if (team) say('after onboarding: the Bot team showed')
    // A host-only plugin shows no trace in the page when its apply throws; DSH's log does.
    for (const line of log.split('\n')) if (/acp-dsh/.test(line) && /error|fail|throw/i.test(line)) problems.push(`dsh log: ${line.trim().slice(0, 300)}`)
    for (const problem of problems) say(`FAIL ${problem}`)
    failed = problems.length > 0
    if (!failed) say('PASS: the web UI booted with every plugin')
  } finally {
    await browser.close()
  }
} finally {
  // The adapter install is not in DSH's group: DSH's dispose, on this SIGTERM, stops it.
  await stopDsh(8000)
  removeWork()
}
process.exit(interrupted ?? (failed ? 1 : 0))
