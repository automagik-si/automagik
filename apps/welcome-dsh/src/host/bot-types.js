// The Bot types the team step offers, as this DSH has them. Omni comes as three DSH
// plugins: the desktop app ships them, a plain DSH installs them when Omni is switched on,
// through DSH's own plugin manager (the same installBundle its Plugins page runs). Genie
// is one plugin (@automagik/genie-dsh), installed the same way when Genie is switched on,
// in the desktop app too. Unfold is its plugin (@automagik/unfold-bot-dsh) with its defaults,
// versioned together in this repository; this repository's releases carry no Unfold plugin
// (Refs marketplace/unfold): Unfold's own release ships them, and its own instance has them all
// bundled. What a type starts with (its
// model, plugins, tools, skills, folder and permissions) is read from the live services where
// they run, and from this list where they do not yet.
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { hostOf } from './host.js'
import { BotTypePayload, parse } from './payloads.js'
import { RELEASES, checkedTarballs } from './release-lane.js'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

// The desktop app and the welcome share the same Omni pin. follow-omni.yml keeps it at
// the newest Omni release whose channels plugin accepts npm's newest Omni server.
export const OMNI_RELEASE = Object.freeze({ ...PKG.automagik.omni })

// The Omni plugins, in install order: each one after the first needs the ones before it.
// The Bot team is Automagik's, beside this plugin (`dir` in this repository, this version);
// it was @automagik/omni-dsh, and a DSH that has it under that name has the team. The
// channels and canvases come from Omni's repository.
export const OMNI_PLUGINS = Object.freeze([
  { name: '@automagik/bots-dsh', formerly: '@automagik/omni-dsh', dir: 'bots-dsh', from: 'automagik', title: 'Bot team', what: 'Bots, their chats, memory and settings' },
  { name: '@automagik/omni-channels-dsh', dir: 'omni-channels-dsh', from: 'omni', title: 'Omni channels', what: 'Your channels and the chats on them' },
  { name: '@automagik/omni-canvas-dsh', dir: 'omni-canvas-dsh', from: 'omni', title: 'Omni canvases', what: 'Live views drawn in the chat' },
])

// Genie's fallback pin (automagik.genie) also sets the minimum version taken from its lane.
// The plugin makes the Genie Bot itself, the first time it runs.
export const GENIE_RELEASE = Object.freeze({ ...PKG.automagik.genie })
export const GENIE_PLUGIN = Object.freeze({ name: '@automagik/genie-dsh', title: 'Genie', what: 'Genie, and a Task for each wish' })
export const GENIE_KIND = 'genie'
export const genieSpec = (genie = GENIE_RELEASE) => `git+${genie.repository.replace(/\.git$/, '')}.git#${genie.commit}&path:/${genie.path}`

const pinChoice = ({ version, commit }, plugins) => ({
  from: 'pin', release: version, commit, plugins: plugins.map(({ name }) => ({ name, version })),
})
export const OMNI_PIN_CHOICE = pinChoice(OMNI_RELEASE, OMNI_PLUGINS.slice(1))
export const GENIE_PIN_CHOICE = pinChoice(GENIE_RELEASE, [GENIE_PLUGIN])

// The Unfold Bot type: its plugin, which makes the Unfold Bot, and its defaults, in install
// order after the Bot team. Copied from apps/unfold-bot-dsh src/host/unfold.js (UNFOLD_PLUGINS),
// not imported: this plugin installs on its own. A test keeps the two lists the same. Unfold's
// own instance brings every one bundled; this repository's release carries none of them.
export const UNFOLD_PLUGINS = Object.freeze([
  { name: '@automagik/unfold-bridge-dsh', dir: 'unfold-bridge-dsh', title: 'Unfold bridge', what: 'Unfold watches this DSH' },
  { name: '@automagik/unfold-events-dsh', dir: 'unfold-events-dsh', title: 'Unfold events', what: 'What Unfold did, as a timeline' },
  { name: '@automagik/unfold-capabilities-dsh', dir: 'unfold-capabilities-dsh', title: 'Unfold capabilities', what: 'What Unfold can do now' },
  { name: '@automagik/unfold-settings-dsh', dir: 'unfold-settings-dsh', title: 'Unfold settings', what: 'Unfold\'s settings, to read' },
  { name: '@automagik/unfold-mind-dsh', dir: 'unfold-mind-dsh', title: 'Unfold Mind', what: 'What Unfold is thinking' },
  { name: '@automagik/unfold-trajectory-dsh', dir: 'unfold-trajectory-dsh', title: 'Unfold trajectory', what: 'Each run, step by step' },
  { name: '@automagik/unfold-session-dsh', dir: 'unfold-session-dsh', title: 'Unfold session', what: 'Unfold\'s own session, in DSH' },
])
export const UNFOLD_PLUGIN = Object.freeze({ name: '@automagik/unfold-bot-dsh', dir: 'unfold-bot-dsh', title: 'Unfold', what: 'The Unfold Bot, Unfold inside DSH' })
export const UNFOLD_KIND = 'unfold'

/** The first executable `name` on the PATH in `env`, or null: a command line a pack brought. */
export function onPath(name, env = process.env) {
  for (const dir of String(env?.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      accessSync(file, fsConstants.X_OK)
      return file
    } catch { /* not here */ }
  }
  return null
}

// How long Genie's command line has to answer `--version` before the card counts it as missing.
export const GENIE_VERSION_TIMEOUT_MS = 2000
let genieChecked = null // { key, answer } for the last file asked, until that file changes

/**
 * Genie's command line on the PATH in `env`, or null: the first `genie` there, kept only if
 * `genie --version` exits 0 within GENIE_VERSION_TIMEOUT_MS. An app that embeds DSH may put a
 * stand-in named genie on the PATH that refuses to run; its path is not Genie's command line. No
 * shell, no output kept, and the answer stands until the file changes.
 */
export async function genieOnPath(env = process.env, { timeout = GENIE_VERSION_TIMEOUT_MS } = {}) {
  const file = onPath('genie', env)
  if (file === null) return null
  let key
  try {
    const { mtimeMs, size } = statSync(file)
    key = `${file}:${mtimeMs}:${size}`
  } catch { return null }
  if (genieChecked?.key !== key) {
    const answers = await new Promise((resolve) => {
      const child = spawn(file, ['--version'], { env, stdio: 'ignore', timeout, killSignal: 'SIGKILL' })
      child.once('error', () => resolve(false))
      child.once('exit', code => resolve(code === 0))
    })
    genieChecked = { key, answer: answers ? file : null }
  }
  return genieChecked.answer
}

const succeeds = (command, args) => new Promise((resolve) => {
  execFile(command, args, { timeout: 5000 }, error => resolve(error === null))
})
/**
 * Why this machine cannot take Genie, or null. Genie comes from a git source and works in
 * git, so it needs git. On macOS /usr/bin/git only opens Apple's installer until the command
 * line tools are there, so those are asked for before git is ever run.
 */
export async function gitProblem({ platform = process.platform, run = succeeds } = {}) {
  if (platform === 'darwin' && !(await run('xcode-select', ['-p']))) return 'Genie needs Apple\'s command line tools. Open Terminal and run this one line: xcode-select --install. Then power Genie on again.'
  if (!(await run('git', ['--version']))) return 'Genie needs git. Install git, then power Genie on again.'
  return null
}

/** The version an install of `plugin` brings. */
export const versionOf = (plugin, version = PKG.version, omni = OMNI_RELEASE) => (plugin.from === 'omni' ? omni.version : version)

// The tools the Omni plugins register (omni-channels-dsh src/host/omni-api.js, omni-canvas-dsh
// src/host/canvas.js), grouped by what the person can switch. `read` is what Omni is for,
// so it stays on; `computer` is DSH's own shell and file tools, which Omni starts without.
export const OMNI_TOOLS = Object.freeze([
  { id: 'read', label: 'Read channels and chats', tools: ['omni_channels', 'omni_chats', 'omni_messages'], on: true, locked: true },
  { id: 'send', label: 'Send, react and delete', detail: 'Asks you before it writes to a person', tools: ['omni_send', 'omni_react', 'omni_media', 'omni_delete'], on: true },
  { id: 'connect', label: 'Connect a channel', detail: 'Shows the QR code to scan', tools: ['omni_connect'], on: true },
  { id: 'api', label: 'Any Omni operation', detail: 'Finds and runs the rest of Omni\'s API', tools: ['omni_endpoints', 'omni_call'], on: true },
  { id: 'canvases', label: 'Live canvases', tools: ['show_canvas'], on: true },
  { id: 'computer', label: 'Shell and files', detail: 'DSH\'s own tools; one-off work goes to Tasks', tools: ['bash', 'read', 'write', 'edit'], on: false },
])

const failure = (code, message) => Object.assign(new Error(message), { code })
const refused = message => failure('omni-ai/refused', message)
const invalid = message => failure('omni-ai/invalid', message)

const service = (ctx, name) => {
  try {
    return ctx.get?.(name) ?? undefined
  } catch {
    return undefined
  }
}
const quietly = async (read, fallback) => {
  try {
    return (await read()) ?? fallback
  } catch {
    return fallback
  }
}
const tilde = path => path.replace(/^\/(?:home|Users)\/[^/]+(?=\/)/, '~')

// What installs one Omni plugin. The Bot team: the source this plugin came from, pointed at
// its sibling (a git commit's path, or a linked checkout), so both are one release; else that
// release tarball. Omni's: its repository at the pinned release, as a DSH git spec.
export function installTargetOf(plugin, ownSource, version = PKG.version, omni = OMNI_RELEASE) {
  if (plugin.from === 'omni') {
    return { spec: `git+${omni.repository.replace(/\.git$/, '')}.git#${omni.commit}&path:/apps/${plugin.dir}`, options: {} }
  }
  const own = 'apps/welcome-dsh'
  if (typeof ownSource === 'string' && ownSource.includes(own)) return { spec: ownSource.replace(own, `apps/${plugin.dir}`), options: {} }
  return { spec: `https://github.com/automagik-si/automagik/releases/download/v${version}/automagik-${plugin.dir}-${version}.tgz`, options: {} }
}

// A plugin's row in the profile: under its name, else under its former one.
const rowOf = (rows, plugin) => rows?.find(bundle => bundle.name === plugin.name)
  ?? (plugin.formerly ? rows?.find(bundle => bundle.name === plugin.formerly && bundle.availability !== 'missing') : undefined)
const present = row => row !== undefined && row.availability !== 'missing'
const missing = (rows, plugin) => !present(rowOf(rows, plugin))

export function teamVersion(rows) {
  const [team] = OMNI_PLUGINS
  const row = rows.find(bundle => bundle.name === team.name && present(bundle))
  if (row) return row.version
  return rows.some(bundle => bundle.name === team.formerly && present(bundle)) ? null : PKG.version
}

const chosenVersion = (choice, name) => choice?.plugins.find(plugin => plugin.name === name)?.version
const refusedResolved = error => ['incompatible-version', 'unexpected-package'].includes(error?.code)
const publicChoice = ({ from, release, commit, plugins, pair, server }) => ({
  from, release, commit, plugins, ...(pair !== undefined ? { pair } : {}), ...(server !== undefined ? { server } : {}),
})

// The Genie install's own lines in its terminal, between pnpm's (ANSI: cyan, green, red).
export const GENIE_LOG_MAX = 48_000
const step = text => `\x1b[36m›\x1b[0m ${text}…\n`
const ok = text => `\x1b[32m✓\x1b[0m ${text}\n`
const failedLine = text => `\x1b[31m✗\x1b[0m ${text}\n`

const resultProblem = (result) => {
  if (result?.error) return result.error.diagnostic ?? result.error.code
  if (!['applied', 'restart-required'].includes(result?.application)) return `install ${result?.application ?? 'failed'}`
  return null
}

// Genie's skills (/wish and the rest) come with its command line: its installer writes them to
// ~/.agents/skills, which DSH reads, once it finds DSH (genie#3173). The card offers the one
// line that installs it while they are missing.
export const GENIE_CLI_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/automagik-si/genie/main/install.sh | GENIE_CHANNEL=dev bash'
export const hasGenieSkills = (home = homedir()) => existsSync(join(home, '.agents', 'skills', 'wish', 'SKILL.md'))

// What an install in Unfold's instance says when a plugin its pack brings is not there.
export const BUNDLED_MISSING = 'Unfold brings this plugin, and it is missing from this instance.'

export function createBotTypeActions(ctx, { team, omniProjectOf, env = process.env, checkGit = gitProblem, genieSkills = hasGenieSkills, genieCli = () => genieOnPath(env), release = {}, releases = null, offersUnfold = hostOf(env) === 'unfold' }) {
  const manager = () => service(ctx, 'pluginManager')
  // Unfold's own instance brings its plugins and Genie's command line with it: the card names
  // that command line, never the line that installs one, and nothing here installs a plugin.
  // A genie on the PATH that does not answer --version is no command line: the card says none.
  const bundled = hostOf(env) === 'unfold'
  // `{ phase, current, done, error, restart }` once an install started.
  let job = null
  // Genie's own: `{ phase, error, restart, requestId, log }`.
  let genieJob = null
  // What the Genie install printed, for the terminal on Genie's card: its own steps, then
  // pnpm's output for the installs it asked for (the plugin manager streams each run's
  // output as install-log, by the request id the install passed). The tail is kept.
  const say = (text) => {
    if (genieJob !== null) genieJob.log = `${genieJob.log}${text}`.slice(-GENIE_LOG_MAX)
  }
  ctx.on?.('plugin-manager/install-log', (chunk) => {
    if (genieJob !== null && chunk?.requestId === genieJob.requestId && typeof chunk.text === 'string') say(chunk.text)
  })

  async function bundles() {
    const rows = await quietly(() => manager()?.listBundles?.(), null)
    return Array.isArray(rows) ? rows : null
  }

  async function plugins() {
    const rows = await bundles()
    return OMNI_PLUGINS.map((plugin) => {
      const row = rowOf(rows, plugin)
      return {
        name: plugin.name,
        title: plugin.title,
        what: plugin.what,
        version: row?.version ?? null,
        installed: rows === null ? null : row !== undefined && row.availability !== 'missing',
        enabled: row?.enabled ?? null,
      }
    })
  }

  // Ready: the Omni team service runs here (the page then finds the channels' endpoints on
  // its own route). A DSH without a plugin manager reports what runs.
  async function status() {
    // The install as it was before the listing, so a finished one never shows stale rows.
    const install = job === null ? null : { ...job, done: [...job.done] }
    const rt = team()
    const list = await plugins()
    const running = rt !== undefined
    const installed = list.every(row => row.installed === true && row.enabled !== false)
    return {
      plugins: list,
      ready: running && (installed || list.some(row => row.installed === null)),
      installed: list.some(row => row.installed === null) ? running : installed,
      canInstall: typeof manager()?.installBundle === 'function',
      version: PKG.version,
      install,
    }
  }

  // One plugin in place and on: left alone when it is, switched on when it is off, else
  // installed from `target`. Says whether it was already there, and whether DSH must restart.
  // In Unfold's instance a plugin comes only with Unfold's pack: one that is missing is an
  // error, never an install from npm or git.
  async function ensure(plugin, rows, target) {
    const row = rowOf(rows, plugin)
    const there = present(row)
    if (there && row.enabled !== false) return { there: true, restart: false }
    if (!there && bundled) throw new Error(`${plugin.title}: ${BUNDLED_MISSING}`)
    const service = manager()
    target.onStart?.(there ? 'enable' : 'install')
    const result = there ? await service.setBundleEnabled(row.name, true) : await service.installBundle(target.spec, { enabled: true, ...target.options })
    const problem = resultProblem(result)
    if (problem !== null) throw failure(result?.error?.code, `${plugin.title}: ${problem}`)
    return { there: false, restart: result.application === 'restart-required' }
  }

  // The network wait can outlast another install. Recheck the inventory, using the
  // manifests already in hand to choose for the team and sibling that are now present.
  async function resolveMissing(publisher, list, pin) {
    const initial = await bundles()
    if (releases === null || bundled) return { rows: initial ?? [], choice: null }
    const needed = rows => list.some(plugin => missing(rows, plugin))
    if (initial === null) return { rows: [], choice: pin }
    if (!needed(initial)) return { rows: initial, choice: null }
    const selected = await releases[publisher](initial, teamVersion(initial))
    const rows = await bundles()
    if (rows === null) return { rows: initial, choice: pin }
    if (!needed(rows)) return { rows, choice: null }
    const choice = selected?.rechoose ? selected.rechoose(rows, teamVersion(rows)) : selected
    return { rows, choice: choice ?? pin }
  }

  // Where each of `list` installs from. The ones about to be installed from this release's
  // tarballs are first all checked against the release's signed lane, and then install from the
  // checked copies (release-lane.js); one that fails stops the install before anything is installed.
  async function targetsOf(list, rows, ownSource, choice) {
    const targets = list.map((plugin) => {
      if (plugin.from !== 'omni' || !choice || choice.from === 'pin') return installTargetOf(plugin, ownSource)
      const { spec } = installTargetOf(plugin, ownSource, PKG.version, { ...OMNI_RELEASE, commit: choice.commit })
      return { spec, options: { expected: { name: plugin.name, version: chosenVersion(choice, plugin.name) } } }
    })
    const wanted = list.flatMap((plugin, i) => (!bundled && missing(rows, plugin) && targets[i].spec.startsWith(RELEASES) ? [{ name: plugin.name, url: targets[i].spec }] : []))
    const paths = await checkedTarballs(wanted, { version: PKG.version, env, ...release })
    return targets.map((target, i) => (paths[list[i].name] ? { ...target, spec: paths[list[i].name] } : target))
  }

  async function runInstall() {
    const plan = await resolveMissing('omni', OMNI_PLUGINS.slice(1), OMNI_PIN_CHOICE)
    const { rows } = plan
    let { choice } = plan
    if (choice) job.release = publicChoice(choice)
    const ownSource = rows.find(bundle => bundle.name === PKG.name)?.source
    const targets = await targetsOf(OMNI_PLUGINS, rows, ownSource, choice)
    let installedOmni = false
    for (const [i, plugin] of OMNI_PLUGINS.entries()) {
      const row = rowOf(rows, plugin)
      const installing = !present(row)
      if (installing || row.enabled === false) job.current = plugin.name
      const target = targets[i].options.expected && choice?.from === 'pin' ? installTargetOf(plugin, ownSource) : targets[i]
      let result
      try {
        result = await ensure(plugin, rows, target)
      } catch (error) {
        if (!installing || !target.options.expected || !refusedResolved(error)) throw error
        if (installedOmni) throw new Error(`Omni's plugins stopped half way: ${plugin.title} was refused (${error.code}). Power Omni on again to finish.`)
        choice = { ...OMNI_PIN_CHOICE, server: choice.server }
        job.release = publicChoice(choice)
        result = await ensure(plugin, rows, installTargetOf(plugin, ownSource))
      }
      const { restart } = result
      if (restart) job.restart = true
      if (installing && plugin.from === 'omni') installedOmni = true
      job.done.push(plugin.name)
    }
    if (installedOmni && choice?.from === 'lane') releases.recordTaken('omni', choice.sequence)
    job.current = null
    job.phase = job.restart ? 'restart' : 'done'
  }

  function startInstall() {
    if (job?.phase === 'installing') return
    if (typeof manager()?.installBundle !== 'function') throw refused('This DSH has no plugin manager to install Omni with. Add the Omni plugins on its Plugins page, then come back.')
    job = { phase: 'installing', current: null, done: [], error: null, restart: false }
    const running = job
    void runInstall().catch((error) => {
      ctx.logger?.warn?.('omni-ai: installing the Omni plugins failed: %s', error?.message ?? error)
      Object.assign(running, { phase: 'failed', current: null, error: String(error?.message ?? error) })
    })
  }

  // Ready: the Genie Bot is on the team, which the plugin makes once it runs here.
  async function genieStatus() {
    const install = genieJob === null ? null : { ...genieJob, done: [...genieJob.done] }
    const rows = await bundles()
    const row = rows?.find(bundle => bundle.name === GENIE_PLUGIN.name)
    const rt = team()
    if (rt !== undefined) await quietly(() => rt.load?.(), undefined)
    const bot = rt === undefined ? undefined : Object.values(rt.state?.bots ?? {}).find(entry => entry.kind === GENIE_KIND)
    return {
      plugin: {
        name: GENIE_PLUGIN.name,
        title: GENIE_PLUGIN.title,
        what: GENIE_PLUGIN.what,
        version: (!present(row) ? chosenVersion(genieJob?.release ?? releases?.cachedGenie(), GENIE_PLUGIN.name) : undefined)
          ?? row?.version ?? GENIE_RELEASE.version,
        installed: rows === null ? null : row !== undefined && row.availability !== 'missing',
        enabled: row?.enabled ?? null,
      },
      ready: bot !== undefined,
      bot: bot === undefined ? null : { id: bot.id, name: bot.name },
      canInstall: typeof manager()?.installBundle === 'function',
      install,
      skills: genieSkills(),
      cli: bundled ? await genieCli() : GENIE_CLI_INSTALL,
      ...(bundled ? { cliBundled: true } : {}),
    }
  }

  // Genie runs on the Bot team, so a plain DSH that lacks it gets it first, from where the
  // Omni install would take it (a peer pnpm could not find on npm otherwise).
  async function ensureGenie(rows, choice, requestId) {
    const resolved = choice?.from === 'lane'
    const release = resolved ? { ...GENIE_RELEASE, commit: choice.commit, version: chosenVersion(choice, GENIE_PLUGIN.name) } : GENIE_RELEASE
    const expected = resolved ? { expected: { name: GENIE_PLUGIN.name, version: release.version } } : {}
    return ensure(GENIE_PLUGIN, rows, {
      spec: genieSpec(release),
      options: { requestId, ...expected },
      onStart: what => say(step(what === 'install' ? `Installing Genie (${GENIE_PLUGIN.name} ${release.version}, ${release.repository.replace(/^https:\/\/github\.com\//, '')}@${release.commit.slice(0, 7)})` : 'Switching Genie on')),
    })
  }

  async function runGenieInstall() {
    // In Unfold's instance nothing comes from git, so git is not asked for.
    // Each step as it runs ({ steps, current, done }), for the sidebar's "2 of 3".
    const at = (id) => { genieJob.current = id }
    const passed = (id) => { genieJob.done.push(id) }
    if (!bundled) {
      at('git')
      say(step('Checking git'))
      const problem = await checkGit()
      if (problem !== null) throw new Error(problem)
      say(ok('git is here'))
      passed('git')
    }
    const { rows, choice } = await resolveMissing('genie', [GENIE_PLUGIN], GENIE_PIN_CHOICE)
    if (choice) genieJob.release = publicChoice(choice)
    const ownSource = rows.find(bundle => bundle.name === PKG.name)?.source
    const [botTeam] = OMNI_PLUGINS
    const { requestId } = genieJob
    const [teamTarget] = await targetsOf([botTeam], rows, ownSource)
    at('team')
    const teamStep = await ensure(botTeam, rows, { ...teamTarget, options: { ...teamTarget.options, requestId }, onStart: what => say(step(`${what === 'install' ? 'Installing' : 'Switching on'} the Bot team (${botTeam.name})`)) })
    if (teamStep.there) say(ok('The Bot team is here'))
    passed('team')
    at('genie')
    let genieStep
    try {
      genieStep = await ensureGenie(rows, choice, requestId)
    } catch (error) {
      if (choice?.from !== 'lane' || !refusedResolved(error)) throw error
      genieJob.release = publicChoice(GENIE_PIN_CHOICE)
      genieStep = await ensureGenie(rows, GENIE_PIN_CHOICE, requestId)
    }
    if (genieJob.release?.from === 'lane') releases.recordTaken('genie', choice.sequence)
    passed('genie')
    genieJob.current = null
    genieJob.restart = teamStep.restart || genieStep.restart
    say(ok(genieJob.restart ? 'Genie is installed: DSH starts it after a restart' : 'Genie is installed'))
    genieJob.phase = genieJob.restart ? 'restart' : 'done'
  }

  function startGenieInstall() {
    if (genieJob?.phase === 'installing') return
    if (typeof manager()?.installBundle !== 'function') throw refused('This DSH has no plugin manager to install Genie with. Add @automagik/genie-dsh on its Plugins page, then come back.')
    genieJob = { phase: 'installing', error: null, restart: false, requestId: `genie-${Date.now()}`, log: '', steps: bundled ? ['team', 'genie'] : ['git', 'team', 'genie'], current: null, done: [] }
    const running = genieJob
    void runGenieInstall().catch((error) => {
      ctx.logger?.warn?.('omni-ai: installing Genie failed: %s', error?.message ?? error)
      if (genieJob === running) say(failedLine(String(error?.message ?? error)))
      Object.assign(running, { phase: 'failed', error: String(error?.message ?? error) })
    })
  }

  // Unfold's: the Bot team, Unfold's defaults and its own plugin, in that order. In Unfold's own
  // instance all of them come bundled in its profile, and this repository's release carries none
  // of the Unfold set (Refs marketplace/unfold), so its lane is never asked for one. None comes
  // from git, so nothing asks for git. Ready once the plugin has made the Unfold Bot.
  const UNFOLD_ALL = [OMNI_PLUGINS[0], ...UNFOLD_PLUGINS, UNFOLD_PLUGIN]
  let unfoldJob = null

  async function unfoldStatus() {
    const install = unfoldJob === null ? null : { ...unfoldJob, done: [...unfoldJob.done] }
    const rows = await bundles()
    const rt = team()
    if (rt !== undefined) await quietly(() => rt.load?.(), undefined)
    const bot = rt === undefined ? undefined : Object.values(rt.state?.bots ?? {}).find(entry => entry.kind === UNFOLD_KIND)
    return {
      plugins: UNFOLD_ALL.map((plugin) => {
        const row = rowOf(rows, plugin)
        return {
          name: plugin.name,
          title: plugin.title,
          what: plugin.what,
          version: row?.version ?? versionOf(plugin),
          installed: rows === null ? null : row !== undefined && row.availability !== 'missing',
          enabled: row?.enabled ?? null,
        }
      }),
      ready: bot !== undefined,
      bot: bot === undefined ? null : { id: bot.id, name: bot.name },
      canInstall: offersUnfold && typeof manager()?.installBundle === 'function',
      install,
    }
  }

  async function runUnfoldInstall() {
    const rows = await bundles() ?? []
    const ownSource = rows.find(bundle => bundle.name === PKG.name)?.source
    const targets = await targetsOf(UNFOLD_ALL, rows, ownSource)
    for (const [i, plugin] of UNFOLD_ALL.entries()) {
      unfoldJob.current = plugin.name
      const { restart } = await ensure(plugin, rows, targets[i])
      if (restart) unfoldJob.restart = true
      unfoldJob.done.push(plugin.name)
    }
    unfoldJob.current = null
    unfoldJob.phase = unfoldJob.restart ? 'restart' : 'done'
  }

  function startUnfoldInstall() {
    // Unfold is offered only in Unfold's own instance: anywhere else nothing of Unfold's installs.
    if (!offersUnfold) throw refused('Unfold is not offered here: it comes with Unfold\'s own instance.')
    if (unfoldJob?.phase === 'installing') return
    if (typeof manager()?.installBundle !== 'function') throw refused('This DSH has no plugin manager to install Unfold with. Add @automagik/unfold-bot-dsh on its Plugins page, then come back.')
    unfoldJob = { phase: 'installing', current: null, done: [], error: null, restart: false }
    const running = unfoldJob
    void runUnfoldInstall().catch((error) => {
      ctx.logger?.warn?.('omni-ai: installing Unfold failed: %s', error?.message ?? error)
      Object.assign(running, { phase: 'failed', current: null, error: String(error?.message ?? error) })
    })
  }

  // The DSH default model, and its thinking level, which a new Bot is offered first.
  async function model() {
    const chosen = await quietly(() => service(ctx, 'agentDefaultModel')?.currentSelection?.(), undefined)
    if (!chosen?.provider || !chosen?.model) return { ref: null, thinking: null }
    const info = await quietly(() => service(ctx, 'llm')?.resolveModelInfo?.(chosen.provider, chosen.model), undefined)
    const effortId = info?.reasoning?.defaultEffort
    const effort = (info?.reasoning?.efforts ?? []).find(row => row.id === effortId)
    return { ref: `${chosen.provider}/${chosen.model}`, name: info?.name ?? chosen.model, thinking: effort?.name ?? effortId ?? null }
  }

  // The tools served in this DSH now, by name, or null before the Omni plugins run.
  function servedTools() {
    const tools = service(ctx, 'tools')
    try {
      const schemas = tools?.schemas?.()
      return Array.isArray(schemas) ? new Set(schemas.map(schema => schema?.name)) : null
    } catch {
      return null
    }
  }

  async function skills(cwd) {
    const rows = await quietly(() => service(ctx, 'skills')?.list?.(cwd ? { cwd } : {}), [])
    return (Array.isArray(rows) ? rows : []).slice(0, 12).map(skill => ({ id: skill.name, label: skill.name, detail: typeof skill.description === 'string' ? skill.description.slice(0, 120) : undefined }))
  }

  async function permission() {
    const catalog = await quietly(() => service(ctx, 'permissionPresets')?.catalog?.(), null)
    if (!catalog) return null
    const option = (catalog.options ?? []).find(row => row.value === catalog.defaultPreset)
    return option?.name ?? catalog.defaultPreset ?? null
  }

  // Omni's preloaded setup, group by group, with a switch where it is the person's to set.
  async function omniType() {
    const rt = team()
    const [pluginRows, modelInfo, preset] = await Promise.all([plugins(), model(), permission()])
    const project = rt === undefined ? undefined : await quietly(() => omniProjectOf(rt), undefined)
    const served = servedTools()
    const skillRows = await skills(project)
    return {
      type: 'omni',
      groups: [
        { id: 'model', label: 'Model', rows: [
          { id: 'model', label: modelInfo.ref ? modelInfo.name : 'Your DSH default', detail: modelInfo.ref ? `${modelInfo.ref} · you confirm it in Omni's first chat` : 'You pick it in Omni\'s first chat' },
          { id: 'thinking', label: 'Thinking', detail: modelInfo.thinking ?? 'The model\'s default' },
        ] },
        { id: 'plugins', label: 'Plugins', rows: pluginRows.map(row => ({
          id: row.name, label: row.title, detail: row.what,
          version: row.installed === false
            ? chosenVersion(job?.release ?? releases?.cachedOmni(), row.name) ?? row.version ?? versionOf(OMNI_PLUGINS.find(plugin => plugin.name === row.name))
            : row.version,
          installed: row.installed,
        })) },
        { id: 'tools', label: 'Tools', rows: OMNI_TOOLS.map(group => ({
          id: group.id, label: group.label, detail: group.detail, tools: group.tools,
          on: group.on, locked: group.locked === true,
          ...(served && group.id !== 'computer' ? { served: group.tools.some(name => served.has(name)) } : {}),
        })) },
        { id: 'skills', label: 'Skills', rows: skillRows, empty: 'None preloaded. Skills you add to DSH, or teach Omni later, show here.' },
        { id: 'setup', label: 'Setup', rows: [
          { id: 'folder', label: 'Folder', ...(project ? { detail: tilde(project), path: true } : { detail: 'Its own, in your team workspace' }) },
          { id: 'permission', label: 'Permissions', detail: preset ? `${preset} (DSH's default)` : 'DSH\'s default' },
        ] },
      ],
    }
  }

  return {
    'omni-plugins': () => status(),
    async 'omni-plugins-install'() {
      startInstall()
      return status()
    },
    'genie-plugin': () => genieStatus(),
    async 'genie-plugin-install'() {
      startGenieInstall()
      return genieStatus()
    },
    'unfold-plugin': () => unfoldStatus(),
    async 'unfold-plugin-install'() {
      startUnfoldInstall()
      return unfoldStatus()
    },
    async 'bot-type'(payload) {
      const fields = parse(BotTypePayload, payload)
      if (fields === undefined) throw invalid('Name a Bot type.')
      return omniType()
    },
  }
}
