// Landing captures: boots the real Automagik plugins (the Bot team, the welcome, Genie) on the
// declared DSH runtime in a fixture of its own, seeds the fictional Northwind scenario
// through the plugins' own endpoints and the app's own UI, asserts each intended state, and
// screenshots it. Run from the checkout root: node apps/landing/capture/capture.mjs --run
// (--hold keeps the runtime up after setup, for inspection, until interrupted).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { cli, createFixture, createProcesses, declaredRuntime, here, openBrowser, pinnedSources, prepareHome, redact, root } from './fixture.mjs'

const mode = process.argv[2]
if (process.argv.length !== 3 || !['--run', '--hold'].includes(mode)) {
  console.log('Usage: node apps/landing/capture/capture.mjs --run | --hold')
  process.exit(2)
}
assert.equal(resolve(process.cwd()), root, 'Run from the checkout root')
const runtimeVersion = await declaredRuntime()
const fixture = await createFixture()
const procs = createProcesses()
const results = []
const check = (ok, message, evidence = {}) => {
  results.push({ ok: Boolean(ok), message, ...evidence })
  assert.ok(ok, message)
  console.log(`ok ${message}`)
}
let failed = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void Promise.all(browsers.map(app => app.context.close().catch(() => {}))).then(() => procs.stopAll(fixture)).finally(() => process.exit(mode === '--hold' ? 0 : 130)) })

// The fictional project a Genie works in: a tiny orders report with its own checks.
async function northwind(env) {
  const dir = join(env.HOME, 'projects/northwind')
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'test'), { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: 'northwind-orders', version: '1.4.0', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`)
  await writeFile(join(dir, 'README.md'), '# Northwind orders\n\nThe weekly orders report for Northwind Traders (a fictional company).\n')
  await writeFile(join(dir, 'src/report.js'), "export const orders = [\n  { id: 7, customer: 'Alfreds, Futterkiste', total: 42.5 },\n  { id: 8, customer: 'Berglunds snabbköp', total: 118 },\n  { id: 9, customer: 'Chop-suey Chinese', total: 64.25 },\n]\n\nexport const weeklyTotal = list => list.reduce((sum, order) => sum + order.total, 0)\n")
  await writeFile(join(dir, 'test/report.test.js'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { orders, weeklyTotal } from '../src/report.js'\n\ntest('weekly total adds every order', () => {\n  assert.equal(weeklyTotal(orders), 224.75)\n})\n")
  const run = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' })
  run('init', '-q', '-b', 'dev')
  run('add', '-A')
  run('commit', '-qm', 'feat: weekly orders report')
  return dir
}

const shots = join(root, 'apps/landing/assets/screens')
// Every browser this run opens, closed on every exit path (an orphaned headless Chrome
// would outlive the run).
const browsers = []
const browse = async (...args) => { const app = await openBrowser(...args); browsers.push(app); return app }
// An asserted state: the element is shown within the wait, or the run fails.
async function shows(locator, message) {
  await locator.first().waitFor({ state: 'visible', timeout: 30_000 })
  check(true, message)
}
const bodyText = page => page.locator('body').innerText()
// Nothing of the machine that rendered it: no host paths, user names, tokens or addresses.
const PRIVATE = /\/Users\/|\/home\/|\/private\/|\/tmp\/|\/var\/folders|token=|[\w.+-]+@[\w-]+\.(?!invalid\b)[a-z]{2,}/i
const MAINTAINER = /\/Users\/|\/home\/[a-z]/i
async function private_(page, name) {
  // Anywhere in the page: no real home folder. In the captured viewport: no host path at all
  // (a wish thread's first message names its fixture folder, scrolled out of every capture).
  const all = await bodyText(page)
  check(!MAINTAINER.test(all), `${name}: no real home folder anywhere in the page`)
  // Each match's own characters: on screen only if inside the viewport and every clipping
  // ancestor (a scrolled-away line in a chat stays out of the image).
  const shown = await page.evaluate(source => {
    const pattern = new RegExp(source, 'gi')
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const found = []
    const inside = (box, area) => box.right > area.left && box.left < area.right && box.bottom > area.top && box.top < area.bottom
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.textContent.matchAll(pattern)) {
        const range = document.createRange()
        range.setStart(node, match.index)
        range.setEnd(node, match.index + match[0].length)
        const clips = []
        for (let element = node.parentElement; element; element = element.parentElement) {
          const style = getComputedStyle(element)
          if (style.display === 'none' || style.visibility === 'hidden') { clips.push({ left: 0, right: 0, top: 0, bottom: 0 }); break }
          if (style.overflow !== 'visible') clips.push(element.getBoundingClientRect())
        }
        const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
        if ([...range.getClientRects()].some(box => box.width > 0 && inside(box, view) && clips.every(clip => inside(box, clip)))) found.push(match[0])
      }
    }
    return found.join(' ')
  }, PRIVATE.source)
  check(!PRIVATE.test(shown), `${name}: no host path, token or address in the captured view`, PRIVATE.test(shown) ? { found: PRIVATE.exec(shown)[0] } : {})
}

// One asserted state, pictured twice: the app's light theme, then its dark one (it follows
// the system setting), from the same page without a reload.
async function both(page, name, options = {}) {
  await private_(page, name)
  await page.evaluate(() => document.fonts.ready)
  const seen = {}
  for (const [colorScheme, file] of [['light', `${name}.png`], ['dark', `${name}-dark.png`]]) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.waitForTimeout(700)
    seen[colorScheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await page.screenshot({ path: join(shots, file), ...options })
    check(true, `Captured ${file}`, { background: seen[colorScheme] })
  }
  check(seen.light !== seen.dark, `${name}: the dark picture is the app's dark theme`, seen)
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.waitForTimeout(300)
}

// The fictional person's first run, through the welcome's own steps, then the Northwind wish.
async function scenario({ login, env, project }) {
  await mkdir(shots, { recursive: true })
  const app = await browse(fixture, 'desktop', login, env, { width: 1440, height: 900 })
  const { page, api } = app
  const shoot = (name, options = {}) => both(page, name, options)
  // The app asks once, in each Bot's chat, what that Bot may do on its own. The person keeps
  // the Workspace level it offers and saves.
  const keepWorkspace = async bot => {
    const card = page.getByText(`What may ${bot} do on its own?`)
    await card.waitFor()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await card.waitFor({ state: 'hidden' })
    check(true, `The person saved ${bot}'s Workspace permission level`)
  }
  // Your companion: a bunny named Pip.
  const name = page.getByRole('button', { name: 'Pip', exact: true })
  await name.waitFor()
  await page.locator('.oai-card button[aria-label="bunny"]').click()
  await page.locator('.oai-card button[aria-label="orange"]').click()
  await name.click()
  await page.getByRole('button', { name: 'Hatch Pip' }).click()
  // Your team: Pip leads, Genie is on the team (its plugin is installed), Omni is off.
  await page.getByText('Pip leads. Who comes along?').waitFor()
  await page.getByText('On your team').waitFor()
  const team = await page.locator('.oai-card').first().innerText()
  check(/Grow your team/.test(team) && /Powered off\s+Omni/.test(team) && /Genie\s+On your team/.test(team), 'Team step: Pip leads, Genie on the team, Omni powered off')
  await shoot('team-step')
  // Genie works in Northwind: its working folder, as its settings would set it.
  const state = await api('state')
  const genie = state.bots.find(bot => bot.kind === 'genie')
  check(genie?.name === 'Genie', 'Genie plugin made its Genie Bot')
  await api('update-bot', { id: genie.id, workDir: project })
  await page.getByRole('button', { name: 'Continue with Genie' }).click()
  // Connect AI: DeepSeek is found (the scripted model stands behind its address).
  await page.getByRole('switch', { name: 'DeepSeek' }).waitFor()
  check(await page.getByRole('switch', { name: 'DeepSeek' }).getAttribute('aria-checked') === 'true', 'Connect AI found DeepSeek on')
  await page.getByRole('button', { name: 'Continue →' }).click()
  await page.getByText('What should the team start on?').first().waitFor({ timeout: 60_000 })
  check(true, 'Pip greeted the person as the Main Bot')
  // The request goes to Pip, who hands it to Genie.
  const composer = page.getByRole('textbox').last()
  await composer.click()
  await composer.fill('Customers keep asking for their Northwind orders as a spreadsheet. Can Genie add a CSV export to the orders report?')
  await page.keyboard.press('Enter')
  await page.getByText(/Genie granted it/).first().waitFor({ timeout: 90_000 })
  check(true, 'Pip passed the request to Genie and reported the wish running')
  await keepWorkspace('Pip')
  // The wish ends: its branch is back in the project with one commit, and Genie reports.
  await procs.until('the wish branch in Northwind', () => {
    const branches = execFileSync('git', ['branch', '--list', 'wish/*', '--format=%(refname:short)'], { cwd: project, env, encoding: 'utf8' }).trim()
    if (!branches) return null
    return Number(execFileSync('git', ['rev-list', '--count', `dev..${branches}`], { cwd: project, env, encoding: 'utf8' }).trim()) > 0
  }, 180_000)
  const branch = execFileSync('git', ['branch', '--list', 'wish/*', '--format=%(refname:short)'], { cwd: project, env, encoding: 'utf8' }).trim()
  const log = execFileSync('git', ['log', '--oneline', `dev..${branch}`], { cwd: project, env, encoding: 'utf8' }).trim()
  const files = execFileSync('git', ['diff', '--name-only', `dev...${branch}`], { cwd: project, env, encoding: 'utf8' }).trim().split('\n')
  check(/feat\(report\): export orders as CSV/.test(log) && log.split('\n').length === 1, `Wish branch ${branch} holds one commit`, { branch, log })
  check(['package.json', 'src/csv.js', 'src/export.js', 'test/csv.test.js'].every(file => files.includes(file)), 'The commit adds the export, its test and the script', { files })
  check(execFileSync('git', ['branch', '--show-current'], { cwd: project, env, encoding: 'utf8' }).trim() === 'dev', 'The project stays on dev: nothing merged')
  // The report's claim, checked again here: the branch's tests pass in a fresh checkout of it.
  const verify = join(fixture, 'verify-branch')
  execFileSync('git', ['clone', '-q', '--branch', branch, project, verify], { env })
  const tests = execFileSync('node', ['--test'], { cwd: verify, env, encoding: 'utf8' })
  check(/ℹ pass 2/.test(tests) && /ℹ fail 0/.test(tests), 'The wish branch passes its tests in a fresh clone', { tests: tests.split('\n').filter(line => line.startsWith('ℹ')).join('; ') })
  await page.getByRole('button', { name: /^Genie/ }).first().click()
  await page.getByText(/is done\./).first().waitFor({ timeout: 120_000 })
  check(true, 'Genie reported the finished wish in its chat')
  await keepWorkspace('Genie')

  // The screens, each after asserting what it shows. The window is 1100px wide, close to the
  // size the site shows it at, so its text stays readable; each chat is then pictured again at
  // phone width, from the same page.
  const DESK = { width: 1100, height: 720 }
  const PHONE = { width: 390, height: 844 }
  // At phone width the chat's floating header buttons sit over the messages: start below them.
  const PHONE_CHAT = { x: 0, y: 68, width: 390, height: 776 }
  const resize = async (size, anchor, block = 'nearest') => {
    await page.setViewportSize(size)
    await anchor.evaluate((node, block) => node.scrollIntoView({ block }), block)
  }
  await page.getByRole('button', { name: 'Pip, Orchestrator, Main Bot' }).click()
  const granted = page.getByText(/running as its own thread on/).last()
  await granted.waitFor()
  await page.getByText('Messaged').first().waitFor()
  await page.getByRole('button', { name: 'CSV export, Done' }).waitFor({ timeout: 30_000 })
  check(true, 'Sidebar lists the finished wish under Genie')
  await resize(DESK, granted)
  await shoot('pip-delegates')
  await resize(PHONE, granted)
  await shoot('pip-delegates-phone', { clip: PHONE_CHAT })
  await page.setViewportSize(DESK)
  await page.getByRole('button', { name: /^Genie/ }).first().click()
  const done = page.getByText(/Nothing was pushed or merged\. Look it over/).last()
  await done.waitFor()
  await resize(DESK, done)
  await shoot('genie-report')
  await resize(PHONE, done)
  await shoot('genie-report-phone', { clip: PHONE_CHAT })
  await page.setViewportSize(DESK)
  await page.getByRole('button', { name: 'CSV export, Done' }).click()
  await page.getByRole('heading', { name: 'Report' }).waitFor()
  await shows(page.getByText('Edited 4 files'), 'The wish thread shows its report and the four edited files')
  await page.getByRole('button', { name: /^Completed in/ }).click()
  const ran = page.getByRole('button', { name: /Ran commands/ })
  await ran.nth(2).click()
  await page.getByRole('button', { name: /Run the tests and the export/ }).click()
  const passed = page.getByText('ℹ pass 2').first()
  await passed.waitFor()
  check((await bodyText(page)).includes('ℹ fail 0'), 'The thread\'s own test run shows 2 passing, 0 failing')
  // The bottom status row carries the scripted model's timing; it is not part of the claim,
  // so every picture of the wish thread stops above it.
  await resize(DESK, passed, 'center')
  await shoot('wish-checks', { clip: { x: 0, y: 0, width: 1100, height: 692 } })
  await resize(PHONE, passed, 'center')
  await shoot('wish-checks-phone', { clip: { x: 0, y: 0, width: 390, height: 816 } })
  // The review pane beside the thread, in a wider window.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: 'View changes to src/csv.js' }).click()
  await page.getByText('Created in this turn').waitFor()
  await procs.until('the new src/csv.js in the review pane', async () => (await bodyText(page)).includes('export function toCsv(orders) {'), 30_000)
  check(true, 'The review pane shows the new src/csv.js')
  // The report from its heading down, so the four edited files show under it.
  await page.getByRole('heading', { name: 'Report' }).evaluate(node => node.scrollIntoView({ block: 'start' }))
  await shows(page.getByText('Edited 4 files'), 'The report and its edited files sit beside the review pane')
  await shoot('wish-diff', { clip: { x: 0, y: 0, width: 1280, height: 774 } })
  check(app.blocked.length === 0, 'The browser asked for no origin outside the runtime', { blocked: app.blocked })
  await app.context.close()
}

// What rendered the screens, beside them: the runtime, each plugin's pinned source, the
// checkout and the digest of every image.
async function manifest(sources) {
  const { createHash } = await import('node:crypto')
  const images = {}
  for (const file of (await import('node:fs')).readdirSync(shots).filter(name => name.endsWith('.png')).sort()) images[file] = createHash('sha256').update(await readFile(join(shots, file))).digest('hex')
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  // The records of the captures other scripts made (the theme, Pocket, the pack's share image) stay.
  const { additionalCaptures, themeCapture, pocketCapture } = JSON.parse(await readFile(join(shots, 'manifest.json'), 'utf8').catch(() => '{}'))
  await writeFile(join(shots, 'manifest.json'), `${JSON.stringify({
    capturedBy: 'node apps/landing/capture/capture.mjs --run',
    checkout: git('rev-parse', 'HEAD'),
    captureScriptsClean: git('status', '--porcelain', '--', 'apps/landing/capture') === '',
    runtime: { package: '@deepseek-ai/dsh', version: runtimeVersion },
    model: 'apps/landing/capture/scripted-model.mjs (scripted replies; no AI provider was called)',
    plugins: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { version: source.version, repository: source.url, commit: source.commit, path: source.path, tree: source.tree }])),
    images, additionalCaptures, themeCapture, pocketCapture,
  }, null, 2)}\n`)
  check(Object.keys(images).length >= 7, 'Manifest records every capture', { images: Object.keys(images) })
}

let held
try {
  const sources = await pinnedSources(fixture)
  check(true, `Declared runtime ${runtimeVersion}; plugins at pinned sources`, { runtime: runtimeVersion, sources: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { version: source.version, commit: source.commit, path: source.path, tree: source.tree }])) })
  const modelHome = await prepareHome(fixture, 'model')
  const model = procs.start('model', [join(here, 'scripted-model.mjs')], modelHome.home, { ...modelHome.env, SCRIPT_PORT: '0', SCRIPT_LOG: join(fixture, 'model.jsonl') })
  const modelPort = (await procs.outputMatch(model, /scripted model on http:\/\/127\.0\.0\.1:(\d+)\/v1/))[1]

  const { home, env } = await prepareHome(fixture, 'person')
  // Node and the runtime's own tools, wherever this machine keeps them.
  env.PATH = `${dirname(process.execPath)}:${join(root, 'apps/desktop/runtime/node_modules/.bin')}:${env.PATH}`
  const project = await northwind(env)
  const install = procs.start('plugin-link', [cli, 'plugin', '--profile', 'web', 'add', '--offline', '--ignore-scripts', ...Object.values(sources).map(source => `link:${source.dir}`)], home, env)
  await procs.finished(install, 120_000)
  assert.equal(install.exitCode, 0, `Plugin link failed: ${redact(install.output.slice(-4000))}`)
  const profile = JSON.parse(await readFile(join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'))
  check(Object.keys(sources).every(name => profile.dependencies[name] === `link:${sources[name].dir}`), 'Profile links the Bot team, the welcome and Genie at their pinned sources')

  const patch = join(fixture, 'fixture.patch.yml')
  await writeFile(patch, "- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: '2026-09-28.1'\n- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n")
  // pnpm's store is the plugin install's alone; npm in a wish thread would warn about it.
  const { npm_config_store_dir: _store, ...threadEnv } = env
  const runtimeEnv = { ...threadEnv, DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, DEEPSEEK_API_KEY: 'scripted-key', ADVANCED_FIXTURE_PORTS: modelPort }
  const runtime = procs.start('dsh', [cli, '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], home, runtimeEnv)
  const login = (await procs.outputMatch(runtime, /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*token=\S+)/, 120_000))[1]
  await writeFile(join(fixture, 'session.json'), JSON.stringify({ login, home, project, env: runtimeEnv }, null, 2))
  check(true, 'Runtime is up on loopback')
  await scenario({ login, env: runtimeEnv, project })
  await manifest(sources)
  if (mode === '--hold') {
    console.log(`Holding. Session in ${join(fixture, 'session.json')}`)
    held = new Promise(() => {})
    await held
  }
} catch (error) {
  failed = true
  results.push({ ok: false, message: redact(error.stack ?? error) })
  console.error(redact(error.stack ?? error))
  // Failure diagnostics stay in the fixture, never among the landing's screens.
  for (const [index, app] of browsers.entries()) for (const page of app.context.pages()) await page.screenshot({ path: join(fixture, `failure-${index}.png`), timeout: 5000 }).catch(() => {})
} finally {
  for (const app of browsers) await app.context.close().catch(() => {})
  await procs.stopAll(fixture)
  await writeFile(join(fixture, 'results.json'), JSON.stringify({ passed: !failed, results }, null, 2))
  console.log(`Fixture evidence: ${fixture}`)
}
process.exitCode = failed ? 1 : 0
