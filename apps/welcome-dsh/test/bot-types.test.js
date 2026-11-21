import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { install } from '../src/host/endpoint.js'
import { GENIE_PLUGIN, GENIE_RELEASE, OMNI_PLUGINS, OMNI_RELEASE, OMNI_TOOLS, genieSpec, gitProblem, installTargetOf, versionOf } from '../src/host/bot-types.js'
import { fakeContext } from './fake-ctx.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const OWN_LINK = 'link:/home/someone/automagik/apps/welcome-dsh'
const OMNI_GIT = dir => `git+https://github.com/automagik-si/omni.git#${OMNI_RELEASE.commit}&path:/apps/${dir}`
const expectedSpec = plugin => (plugin.from === 'omni' ? OMNI_GIT(plugin.dir) : `link:/home/someone/automagik/apps/${plugin.dir}`)

// DSH's plugin manager, as far as the team step uses it: a profile's bundles, and installs
// that add one (after `settle`, so a test sees the install while it runs).
function fakeManager({ bundles = [{ name: PKG.name, availability: 'profile', enabled: true, source: OWN_LINK, version: PKG.version }], answer = () => ({ application: 'applied', changed: true }) } = {}) {
  const calls = []
  let release = () => {}
  const gate = { held: false }
  const manager = {
    calls,
    bundles,
    hold() {
      gate.held = true
      return () => { gate.held = false; release() }
    },
    async listBundles() { return structuredClone(bundles) },
    async installBundle(spec, options) {
      calls.push(['install', spec, options])
      if (gate.held) await new Promise((resolve) => { release = resolve })
      const plugin = spec.includes('genie-dsh') ? GENIE_PLUGIN : OMNI_PLUGINS.find(row => spec.includes(row.dir) || spec.startsWith(row.name))
      const result = answer(plugin)
      if (result.application === 'applied' || result.application === 'restart-required') bundles.push({ name: plugin.name, availability: 'profile', enabled: true, version: PKG.version })
      return result
    },
    async setBundleEnabled(name, enabled) {
      calls.push(['enable', name, enabled])
      bundles.find(row => row.name === name).enabled = enabled
      return { application: 'applied', changed: true }
    },
  }
  return manager
}

function host({ manager, team, services = {}, checkGit = async () => null, genieSkills = () => true } = {}) {
  const fake = fakeContext({ entries: { 'omni-ai': {} }, services: { ...(manager ? { pluginManager: manager } : {}), ...(team ? { omniTeam: team } : {}), ...services } })
  const { handle } = install(fake.ctx, { checkGit, genieSkills })
  return { ...fake, handle }
}
const value = async (fake, endpoint, payload) => {
  const reply = await fake.handle(endpoint, payload)
  assert.equal(reply.ok, true, JSON.stringify(reply.error))
  return reply.value
}
const settle = async (fake) => {
  for (let i = 0; i < 50; i++) {
    const status = await value(fake, 'omni-plugins')
    if (status.install?.phase !== 'installing') return status
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('the install never finished')
}

test('the Bot team installs from the source this plugin came from, else its release; Omni\'s from the pinned Omni release', () => {
  const [team, channels, canvas] = OMNI_PLUGINS
  assert.deepEqual(installTargetOf(team, OWN_LINK), { spec: 'link:/home/someone/automagik/apps/bots-dsh', options: {} })
  const git = 'git+https://github.com/automagik-dev/automagik.git#21bcd8f&path:/apps/welcome-dsh'
  assert.equal(installTargetOf(team, git).spec, 'git+https://github.com/automagik-dev/automagik.git#21bcd8f&path:/apps/bots-dsh')
  assert.deepEqual(installTargetOf(team, '3.261024.1', '3.261024.1'), { spec: 'https://github.com/automagik-si/automagik/releases/download/v3.261024.1/automagik-bots-dsh-3.261024.1.tgz', options: {} })
  assert.deepEqual(installTargetOf(team, undefined, '3.1.0'), { spec: 'https://github.com/automagik-si/automagik/releases/download/v3.1.0/automagik-bots-dsh-3.1.0.tgz', options: {} })
  // Omni's channels and canvases live in Omni's repository, at Omni's version, whatever this
  // plugin came from.
  const omni = { repository: 'https://github.com/automagik-si/omni', version: '2.261023.32', commit: 'c'.repeat(40) }
  for (const own of [OWN_LINK, git, undefined]) {
    assert.deepEqual(installTargetOf(channels, own, '3.1.0', omni), { spec: `git+https://github.com/automagik-si/omni.git#${'c'.repeat(40)}&path:/apps/omni-channels-dsh`, options: {} })
  }
  assert.equal(installTargetOf(canvas, undefined).spec, OMNI_GIT('omni-canvas-dsh'))
  assert.equal(versionOf(channels), OMNI_RELEASE.version)
  assert.equal(versionOf(team), PKG.version)
})

test('the welcome installs Omni\'s plugins from the Omni release the desktop app carries', () => {
  const desktop = JSON.parse(readFileSync(new URL('../../desktop/omni.json', import.meta.url), 'utf8'))
  const { tree, ...release } = OMNI_RELEASE
  assert.deepEqual(release, { repository: desktop.repository, version: desktop.version, commit: desktop.commit })
  assert.match(OMNI_RELEASE.commit, /^[0-9a-f]{40}$/)
  assert.match(tree, /^[0-9a-f]{40}$/)
})

test('a plain DSH reports the Omni plugins missing, and installs them in order through its plugin manager', async () => {
  const manager = fakeManager()
  const fake = host({ manager })
  const before = await value(fake, 'omni-plugins')
  assert.equal(before.ready, false)
  assert.equal(before.installed, false)
  assert.equal(before.canInstall, true)
  assert.deepEqual(before.plugins.map(row => [row.name, row.installed]), OMNI_PLUGINS.map(plugin => [plugin.name, false]))

  const release = manager.hold()
  const started = await value(fake, 'omni-plugins-install')
  assert.equal(started.install.phase, 'installing')
  // A second press while it runs starts nothing new, and shows which one installs now.
  assert.equal((await value(fake, 'omni-plugins-install')).install.current, '@automagik/bots-dsh')
  release()
  const after = await settle(fake)
  assert.equal(after.install.phase, 'done')
  assert.deepEqual(after.install.done, OMNI_PLUGINS.map(plugin => plugin.name))
  assert.deepEqual(manager.calls, OMNI_PLUGINS.map(plugin => ['install', expectedSpec(plugin), { enabled: true }]))
  assert.equal(after.installed, true)
})

test('installed but switched-off plugins are switched on, installed ones are left alone', async () => {
  const bundles = [
    { name: PKG.name, availability: 'profile', enabled: true, source: OWN_LINK },
    { name: '@automagik/bots-dsh', availability: 'installation', enabled: true, version: '3.0.0' },
    { name: '@automagik/omni-channels-dsh', availability: 'installation', enabled: false, version: '2.0.0' },
  ]
  const manager = fakeManager({ bundles })
  const fake = host({ manager })
  await value(fake, 'omni-plugins-install')
  await settle(fake)
  assert.deepEqual(manager.calls, [['enable', '@automagik/omni-channels-dsh', true], ['install', OMNI_GIT('omni-canvas-dsh'), { enabled: true }]])
})

// A DSH that installed the team before it moved to Automagik has it as @automagik/omni-dsh:
// that is the team (it shares the plugin id); the Bot team is not installed beside it.
test('the team under its former name counts as the team, and is switched on rather than installed over', async () => {
  const bundles = [
    { name: PKG.name, availability: 'profile', enabled: true, source: OWN_LINK },
    { name: '@automagik/omni-dsh', availability: 'profile', enabled: false, version: '2.261023.32' },
    { name: '@automagik/omni-channels-dsh', availability: 'profile', enabled: true, version: '2.261023.32' },
    { name: '@automagik/omni-canvas-dsh', availability: 'profile', enabled: true, version: '2.261023.32' },
  ]
  const manager = fakeManager({ bundles })
  const fake = host({ manager })
  const before = await value(fake, 'omni-plugins')
  assert.deepEqual(before.plugins.map(row => [row.name, row.installed, row.version]), [['@automagik/bots-dsh', true, '2.261023.32'], ['@automagik/omni-channels-dsh', true, '2.261023.32'], ['@automagik/omni-canvas-dsh', true, '2.261023.32']])
  await value(fake, 'omni-plugins-install')
  await settle(fake)
  assert.deepEqual(manager.calls, [['enable', '@automagik/omni-dsh', true]])
  // A former name that is missing from disk is not the team.
  const gone = fakeManager({ bundles: [{ name: PKG.name, availability: 'profile', enabled: true, source: OWN_LINK }, { name: '@automagik/omni-dsh', availability: 'missing', enabled: true }] })
  assert.equal((await value(host({ manager: gone }), 'omni-plugins')).plugins[0].installed, false)
})

test('an install the manager refuses fails with its reason; one that needs a restart says so', async () => {
  const refused = host({ manager: fakeManager({ answer: () => ({ application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm could not reach the registry' } }) }) })
  await value(refused, 'omni-plugins-install')
  const failed = await settle(refused)
  assert.equal(failed.install.phase, 'failed')
  assert.match(failed.install.error, /Bot team: pnpm could not reach the registry/)

  const restart = host({ manager: fakeManager({ answer: () => ({ application: 'restart-required', restartReason: 'no-hmr' }) }) })
  await value(restart, 'omni-plugins-install')
  assert.equal((await settle(restart)).install.phase, 'restart')

  const none = host()
  assert.equal((await none.handle('omni-plugins-install')).error.code, 'omni-ai/refused')
})

test('the desktop app, which runs the Omni plugins, is ready at once', async () => {
  const team = { omniDiscoverEndpoint: () => {}, teamFolder: () => '/home/someone/.omni/team', async load() {} }
  const bundles = [{ name: PKG.name, availability: 'installation', enabled: true }, ...OMNI_PLUGINS.map(plugin => ({ name: plugin.name, availability: 'installation', enabled: true, version: '2.261023.28' }))]
  const status = await value(host({ manager: fakeManager({ bundles }), team }), 'omni-plugins')
  assert.equal(status.ready, true)
  assert.equal(status.installed, true)
  assert.deepEqual(status.plugins.map(row => row.version), ['2.261023.28', '2.261023.28', '2.261023.28'])
})

test('Omni\'s Bot type lists its model, plugins, tools, skills and setup from this DSH', async () => {
  const team = { omniDiscoverEndpoint: () => {}, teamFolder: () => '/home/someone/.omni/team', async load() {} }
  const bundles = [{ name: PKG.name, availability: 'profile', enabled: true }, { name: '@automagik/bots-dsh', availability: 'profile', enabled: true, version: '3.261024.1' }]
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'juice', model: 'gpt-5.5' }) },
    llm: { resolveModelInfo: async () => ({ name: 'GPT-5.5', reasoning: { defaultEffort: 'medium', efforts: [{ id: 'medium', name: 'Medium' }] } }) },
    tools: { schemas: () => [{ name: 'omni_channels' }, { name: 'omni_chats' }, { name: 'show_canvas' }] },
    skills: { list: async ({ cwd }) => (cwd === '/home/someone/.omni/team/omni' ? [{ name: 'channel-triage', description: 'Sort a busy chat' }] : []) },
    permissionPresets: { catalog: () => ({ options: [{ value: 'ask', name: 'Ask first' }], defaultPreset: 'ask' }) },
  }
  const type = await value(host({ manager: fakeManager({ bundles }), team, services }), 'bot-type', { type: 'omni' })
  const group = id => type.groups.find(row => row.id === id)
  assert.deepEqual(type.groups.map(row => row.id), ['model', 'plugins', 'tools', 'skills', 'setup'])
  assert.equal(group('model').rows[0].label, 'GPT-5.5')
  assert.match(group('model').rows[0].detail, /^juice\/gpt-5\.5/)
  assert.equal(group('model').rows[1].detail, 'Medium')
  assert.deepEqual(group('plugins').rows.map(row => [row.label, row.version]), [['Bot team', '3.261024.1'], ['Omni channels', OMNI_RELEASE.version], ['Omni canvases', OMNI_RELEASE.version]])
  const tools = Object.fromEntries(group('tools').rows.map(row => [row.id, row]))
  assert.equal(tools.read.locked, true)
  assert.equal(tools.read.served, true)
  assert.equal(tools.send.served, false)
  assert.equal(tools.canvases.served, true)
  assert.equal(tools.computer.on, false)
  assert.deepEqual(group('skills').rows, [{ id: 'channel-triage', label: 'channel-triage', detail: 'Sort a busy chat' }])
  assert.deepEqual(group('setup').rows.map(row => row.detail), ['~/.omni/team/omni', 'Ask first (DSH\'s default)'])
  assert.equal(group('setup').rows[0].path, true)
})

test('without the Omni plugins the Bot type still lists what Omni brings', async () => {
  const type = await value(host(), 'bot-type', { type: 'omni' })
  const tools = type.groups.find(row => row.id === 'tools').rows
  assert.deepEqual(tools.map(row => row.id), OMNI_TOOLS.map(row => row.id))
  assert.ok(tools.every(row => row.served === undefined))
  assert.equal(type.groups.find(row => row.id === 'model').rows[0].label, 'Your DSH default')
  assert.equal(type.groups.find(row => row.id === 'skills').rows.length, 0)
  assert.equal((await host().handle('bot-type', { type: 'robot' })).error.code, 'omni-ai/invalid')
})

// Omni's channels and canvases live in Omni's repository: an Omni checkout at the pinned
// release (OMNI_CHECKOUT; CI fetches one) holds the tools they register.
const omniCheckout = process.env.OMNI_CHECKOUT
test('the tools Omni lists are the ones its plugins register', { skip: omniCheckout ? false : 'OMNI_CHECKOUT is not set: no Omni checkout to read the channels and canvas plugins from' }, () => {
  const apps = new URL(`file://${omniCheckout.replace(/\/$/, '')}/apps/`)
  const sources = ['omni-channels-dsh/src/host/omni-api.js', 'omni-canvas-dsh/src/host/canvas.js']
    .map(path => readFileSync(new URL(path, apps), 'utf8')).join('\n')
  const registered = new Set([...sources.matchAll(/^\s+name: '([a-z_]+)',$/gm)].map(match => match[1]))
  const listed = OMNI_TOOLS.filter(row => row.id !== 'computer').flatMap(row => row.tools)
  assert.deepEqual([...registered].filter(name => !listed.includes(name)), [], 'a tool the Omni plugins register is missing from OMNI_TOOLS')
  assert.deepEqual(listed.filter(name => !registered.has(name)), [], 'OMNI_TOOLS names a tool no Omni plugin registers')
  const names = OMNI_PLUGINS.map(plugin => JSON.parse(readFileSync(plugin.from === 'omni' ? new URL(`${plugin.dir}/package.json`, apps) : new URL(`../../${plugin.dir}/package.json`, import.meta.url), 'utf8')).name)
  assert.deepEqual(names, OMNI_PLUGINS.map(plugin => plugin.name))
  // Each Omni plugin carries the Omni release of its own last change (omni#1356): at or below
  // the pinned release, never above it.
  const parts = version => version.split('.').map(Number)
  const atOrBelow = (a, b) => { const d = parts(a).map((n, i) => n - parts(b)[i]).find(n => n !== 0); return d === undefined || d < 0 }
  for (const plugin of OMNI_PLUGINS.filter(row => row.from === 'omni')) {
    const { version } = JSON.parse(readFileSync(new URL(`${plugin.dir}/package.json`, apps), 'utf8'))
    assert.ok(atOrBelow(version, OMNI_RELEASE.version), `${plugin.name} ${version} is above Omni ${OMNI_RELEASE.version}`)
  }
})

const settleGenie = async (fake) => {
  for (let i = 0; i < 50; i++) {
    const status = await value(fake, 'genie-plugin')
    if (status.install?.phase !== 'installing') return status
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error('the Genie install never finished')
}

test('Genie installs from the pinned genie commit, after the Bot team when a plain DSH lacks it', async () => {
  assert.equal(genieSpec(), `git+https://github.com/automagik-si/genie.git#${GENIE_RELEASE.commit}&path:/plugins/genie-dsh`)
  assert.match(GENIE_RELEASE.commit, /^[0-9a-f]{40}$/)
  const manager = fakeManager()
  const fake = host({ manager })
  const before = await value(fake, 'genie-plugin')
  assert.equal(before.ready, false)
  assert.equal(before.plugin.installed, false)
  assert.equal(before.plugin.version, GENIE_RELEASE.version)
  await value(fake, 'genie-plugin-install')
  const after = await settleGenie(fake)
  assert.equal(after.install.phase, 'done')
  const requestId = manager.calls[0][2].requestId
  assert.match(requestId, /^genie-\d+$/)
  assert.deepEqual(manager.calls, [
    ['install', 'link:/home/someone/automagik/apps/bots-dsh', { enabled: true, requestId }],
    ['install', genieSpec(), { enabled: true, requestId }],
  ])
})

test('Genie\'s install keeps what it did and what pnpm printed, for the terminal on its card', async () => {
  const manager = fakeManager()
  const fake = host({ manager })
  const install = manager.installBundle
  manager.installBundle = async (spec, options) => {
    fake.ctx.emit('plugin-manager/install-log', { requestId: options.requestId, jobId: 'j1', argv: ['add'], cwd: '/p', stream: 'stdout', text: `Progress: resolved 1, added 1 (${spec.includes('genie') ? 'genie' : 'team'})\n` })
    // Another install's output is not Genie's.
    fake.ctx.emit('plugin-manager/install-log', { requestId: 'someone-else', jobId: 'j2', argv: ['add'], cwd: '/p', stream: 'stdout', text: 'not this\n' })
    return install.call(manager, spec, options)
  }
  await value(fake, 'genie-plugin-install')
  const { install: done } = await settleGenie(fake)
  assert.equal(done.phase, 'done')
  const lines = done.log.replace(/\x1b\[\d+m/g, '').trim().split('\n')
  assert.deepEqual(lines, [
    '› Checking git…',
    '✓ git is here',
    '› Installing the Bot team (@automagik/bots-dsh)…',
    'Progress: resolved 1, added 1 (team)',
    `› Installing Genie (@automagik/genie-dsh ${GENIE_RELEASE.version}, automagik-si/genie@${GENIE_RELEASE.commit.slice(0, 7)})…`,
    'Progress: resolved 1, added 1 (genie)',
    '✓ Genie is installed',
  ])
  // Its steps, for the sidebar's "Installing Genie · 2 of 3": all three done, none running.
  assert.deepEqual([done.steps, done.current, done.done], [['git', 'team', 'genie'], null, ['git', 'team', 'genie']])
})

test('Genie\'s install says which of its steps runs now', async () => {
  const manager = fakeManager()
  const fake = host({ manager })
  const install = manager.installBundle
  const seen = []
  manager.installBundle = async (spec, options) => {
    const { install: now } = await value(fake, 'genie-plugin')
    seen.push([now.current, now.done])
    return install.call(manager, spec, options)
  }
  await value(fake, 'genie-plugin-install')
  await settleGenie(fake)
  assert.deepEqual(seen, [['team', ['git']], ['genie', ['git', 'team']]])
})

test('Genie is ready once its Bot is on the team; a team already here is left alone', async () => {
  const bundles = [
    { name: PKG.name, availability: 'profile', enabled: true, source: OWN_LINK, version: PKG.version },
    { name: '@automagik/bots-dsh', availability: 'profile', enabled: true, version: PKG.version },
  ]
  const manager = fakeManager({ bundles })
  const team = { state: { bots: {} }, async load() {} }
  const fake = host({ manager, team })
  await value(fake, 'genie-plugin-install')
  await settleGenie(fake)
  assert.deepEqual(manager.calls, [['install', genieSpec(), { enabled: true, requestId: manager.calls[0][2].requestId }]])
  assert.equal((await value(fake, 'genie-plugin')).ready, false)
  team.state.bots.g1 = { id: 'g1', name: 'Genie', kind: 'genie' }
  const ready = await value(fake, 'genie-plugin')
  assert.equal(ready.ready, true)
  assert.deepEqual(ready.bot, { id: 'g1', name: 'Genie' })
})

test('without git, Genie\'s install fails with what to run, before anything is installed', async () => {
  const manager = fakeManager()
  const fake = host({ manager, checkGit: () => gitProblem({ platform: 'darwin', run: async () => false }) })
  await value(fake, 'genie-plugin-install')
  const status = await settleGenie(fake)
  assert.equal(status.install.phase, 'failed')
  assert.match(status.install.error, /xcode-select --install/)
  assert.deepEqual(manager.calls, [])
  assert.deepEqual([status.install.current, status.install.done], ['git', []])
  assert.match(status.install.log, /Checking git…\n.*✗.*xcode-select --install/s)
  assert.match(await gitProblem({ platform: 'linux', run: async () => false }), /needs git/)
  assert.equal(await gitProblem({ platform: 'darwin', run: async () => true }), null)
  // On macOS git itself is never run without the command line tools.
  const ran = []
  await gitProblem({ platform: 'darwin', run: async (command) => { ran.push(command); return false } })
  assert.deepEqual(ran, ['xcode-select'])
})

test('Genie\'s card says whether its skills are installed, and the one line that installs them', async () => {
  const missing = await value(host({ manager: fakeManager(), genieSkills: () => false }), 'genie-plugin')
  assert.equal(missing.skills, false)
  assert.equal(missing.cli, 'curl -fsSL https://raw.githubusercontent.com/automagik-si/genie/main/install.sh | GENIE_CHANNEL=dev bash')
  // The environment goes on bash, which runs the script; on curl it would not reach it.
  assert.match(missing.cli, /\| GENIE_CHANNEL=dev bash$/)
  assert.equal((await value(host({ manager: fakeManager(), genieSkills: () => true }), 'genie-plugin')).skills, true)
})
