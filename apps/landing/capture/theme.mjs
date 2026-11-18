// Real app theme evidence, without a model, live profile, channel or fabricated UI.
// Runs only the released Bot plugin in an isolated DSH profile and creates fictional Bots
// through its supported API. Screens are raw browser captures; no injected DOM or styles.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { cli, createFixture, createProcesses, declaredRuntime, openBrowser, pinnedSources, prepareHome, root } from './fixture.mjs'
import { STAGE_LIGHT, STAGE_DARK } from '../../bots-dsh/src/client/stage.js'

assert.equal(process.argv[2], '--run', 'Usage: node apps/landing/capture/theme.mjs --run')
assert.equal(resolve(process.cwd()), root)
const fixture = await createFixture()
const procs = createProcesses()
const browsers = []
const output = join(root, 'apps/landing/assets/screens')
try {
  const runtime = await declaredRuntime()
  const all = await pinnedSources(fixture, { includeGenie: false })
  const source = all['@automagik/bots-dsh']
  const { home, env } = await prepareHome(fixture, 'theme-demo')
  env.PATH = `${dirname(process.execPath)}:${join(root, 'apps/desktop/runtime/node_modules/.bin')}:${env.PATH}`
  const install = procs.start('plugin-link', [cli, 'plugin', '--profile', 'web', 'add', '--offline', '--ignore-scripts', `link:${source.dir}`], home, env)
  await procs.finished(install)
  assert.equal(install.exitCode, 0, install.output.slice(-2000))
  const patch = join(fixture, 'theme.patch.yml')
  await writeFile(patch, "- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: '2026-09-28.1'\n- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n")
  const app = procs.start('dsh', [cli, '--profile', 'web', '--patch', patch, '--no-open', '--host', '127.0.0.1', '--port', '0'], home, env)
  const login = (await procs.outputMatch(app, /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*token=\S+)/, 120_000))[1]
  const desktop = await openBrowser(fixture, 'theme-desktop', login, env, { width: 1440, height: 900 })
  browsers.push(desktop)
  const { page, api } = desktop
  const state = await api('state')
  const main = state.bots.find(bot => bot.id === state.mainBotId)
  assert.ok(main)
  await api('update-bot', { id: main.id, name: 'Pip', role: 'Your companion', color: 'orange', avatar: { shape: 'bunny' } })
  await api('create-bot', { name: 'Rowan', role: 'Writing and research', color: 'cyan', avatar: { shape: 'octopus' } })
  await api('create-bot', { name: 'Sage', role: 'Plans and reviews', color: 'pink', avatar: { shape: 'ghost' } })
  await page.reload()
  await page.locator(`.bt-row[data-bot-id="${main.id}"]`).click()
  const images = {}
  const reports = []
  await mkdir(output, { recursive: true })
  for (const [colorScheme, tokens] of [['light', STAGE_LIGHT], ['dark', STAGE_DARK]]) {
    await page.emulateMedia({ colorScheme })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForFunction(expected => getComputedStyle(document.body).getPropertyValue('--bt-main').trim() === expected, tokens.bg)
      await page.waitForTimeout(500)
      const content = await page.locator('body').innerText()
      assert.doesNotMatch(content, /(?:\/Users\/|\/home\/|\/tmp\/|sk-[A-Za-z0-9]{20}|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i)
      const name = `app-stage-${colorScheme}-${width}.png`
      await page.screenshot({ path: join(output, name) })
      images[name] = createHash('sha256').update(await readFile(join(output, name))).digest('hex')
      reports.push({ name, colorScheme, width, background: tokens.bg, viewport: { width, height: 900 } })
      console.log(`Captured ${name}`)
    }
  }
  assert.deepEqual(desktop.blocked, [])
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  Object.assign(manifest.images, images)
  manifest.themeCapture = {
    capturedBy: 'node apps/landing/capture/theme.mjs --run',
    runtime: { package: '@deepseek-ai/dsh', version: runtime },
    plugin: { version: source.version, repository: source.url, commit: source.commit, path: source.path, tree: source.tree },
    scenario: 'Fictional Pip, Rowan and Sage created through the real Bot API. No AI model, channel, messages or work result is simulated. The real app shows its model connection prompt.',
    themeSource: 'apps/bots-dsh/src/client/stage.js', reports,
  }
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
} finally {
  for (const app of browsers) await app.context.close().catch(() => {})
  await procs.stopAll(fixture)
  console.log(`Isolated fixture evidence: ${fixture}`)
}
