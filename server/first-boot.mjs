// Install the bundled am briefing on a fresh volume or after an image upgrade.
// DSH installs the vendor CLIs in the background. Observe its store and bridge ready binaries.
import { execFileSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENTS_RELATIVE, CLI_STORE_RELATIVE, PNPM_PATH, toolchainChildEnv } from './toolchain.mjs'

export const FIRST_BOOT_MARKER = '.automagik-first-boot.json'

/** Install the briefing link using am's CLI-only install. Retry failures on a later boot. */
function installAmSelf({ home, appHome, env, am, run, log, warn, current }) {
  const link = join(appHome, 'automagik-herdr', 'briefing.mjs')
  if (current && existsSync(link)) return { state: 'present', link }

  try {
    run(am, ['self', 'install'], {
      cwd: home,
      env: toolchainChildEnv({
        ...env, HOME: env.HOME || home, AUTOMAGIK_HOME: home, HERDR_APP_HOME: appHome,
      }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    if (existsSync(link)) {
      log(`am self install: briefing link ${link}`)
      return { state: 'installed', link }
    }
    warn('am self install: briefing link not created')
    return { state: 'missing-link', link }
  } catch (error) {
    warn(`am self install failed: ${error?.stderr?.trim() || error?.message || error}`)
    return { state: 'failed', link }
  }
}

export function runFirstBoot({
  home,
  version = 'unknown',
  env = process.env,
  am = env.AUTOMAGIK_AM || 'am',
  run = execFileSync,
  now = () => new Date().toISOString(),
  log = console.log,
  warn = console.warn,
} = {}) {
  const marker = join(home, FIRST_BOOT_MARKER)
  const fresh = !existsSync(marker)
  let previous
  if (!fresh) {
    try {
      previous = JSON.parse(readFileSync(marker, 'utf8'))
    } catch (error) {
      warn(`first boot: could not read ${marker}: ${error.message}`)
    }
  }
  const current = previous?.version === version
    && ['installed', 'present'].includes(previous.amSelf)
  const appHome = env.HERDR_APP_HOME || join(home, 'herdr-app')
  const amSelf = installAmSelf({ home, appHome, env, am, run, log, warn, current })
  if (amSelf.state !== 'present') {
    const record = { schemaVersion: 1, version, at: now(), amSelf: amSelf.state }
    try {
      writeFileSync(marker, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      warn(`first boot: could not write ${marker}: ${error.message}`)
    }
  }
  return { fresh, marker, amSelf }
}

/**
 * The supported launch bridge: a `programs.json` run override in the app home. am reads it
 * through withOverrides (am/models.js), so a store-installed absolute binary is what a Bot
 * starts. Only an entry whose run points into this instance's CLI store is managed here; a
 * person's own override is never deleted or rewritten. The file stays under the data volume.
 */
export function writeProgramsBridge({
  home,
  appHome = join(home, 'herdr-app'),
  agent,
  path,
  log = console.log,
  warn = console.warn,
} = {}) {
  const storeRoot = `${resolve(join(home, 'acp', 'clis'))}${sep}`
  const target = resolve(path ?? '')
  if (!target.startsWith(storeRoot) || !isAbsolute(target)) {
    throw new Error(`programs.json bridge path is not in this instance's CLI store: ${path}`)
  }
  const file = join(appHome, 'programs.json')
  let current = {}
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      warn(`programs.json: ${file} is not JSON (${error?.message ?? error}); left as it is`)
      return { file, changed: false, reason: 'invalid' }
    }
  }
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    warn(`programs.json: ${file} is not an object; left as it is`)
    return { file, changed: false, reason: 'invalid' }
  }
  const programs = current.programs === undefined ? {} : current.programs
  if (programs === null || typeof programs !== 'object' || Array.isArray(programs)) {
    warn(`programs.json: ${file}: programs is not an object; left as it is`)
    return { file, changed: false, reason: 'invalid' }
  }
  const existing = programs[agent]
  if (existing !== undefined) {
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      warn(`programs.json: ${file}: ${agent} is not an object; left as it is`)
      return { file, changed: false, reason: 'personal' }
    }
    const run = existing.run
    const managed = Array.isArray(run) && run.length === 1 && typeof run[0] === 'string'
      && isAbsolute(run[0]) && `${resolve(run[0])}${sep}`.startsWith(storeRoot)
    if (!managed) {
      warn(`programs.json: ${file}: ${agent} is a person's own override; left as it is`)
      return { file, changed: false, reason: 'personal' }
    }
  }
  const next = {
    ...current,
    programs: { ...programs, [agent]: { ...(existing ?? {}), run: [target] } },
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return { file, changed: false, reason: 'current' }
  mkdirSync(appHome, { recursive: true })
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o644
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode })
  renameSync(tmp, file)
  log(`programs.json: ${agent} -> ${target}`)
  return { file, changed: true, reason: 'written' }
}

/** Whether a run entry is this instance's managed CLI store path. */
export const managedProgram = (run, home) => Array.isArray(run) && run.length === 1 && typeof run[0] === 'string'
  && isAbsolute(run[0]) && `${resolve(run[0])}${sep}`.startsWith(`${resolve(join(home, 'acp', 'clis'))}${sep}`)

/**
 * DSH's own CliStore is the product installer: its startup `required()`/`refresh()` installs
 * both vendors. The entrypoint must not duplicate that install. It observes the shared store,
 * waits for the binaries, and writes the programs.json bridge. One owner, one admission queue.
 */
export async function installVendorClis({
  home,
  profile,
  env = process.env,
  log = console.log,
  warn = console.warn,
  timeout = 1_900_000,
  failureFor = () => undefined,
} = {}) {
  const clisFile = join(profile, CLI_STORE_RELATIVE)
  const agentsFile = join(profile, AGENTS_RELATIVE)
  if (!existsSync(clisFile) || !existsSync(agentsFile)) {
    warn(`vendor CLIs: the shipped CLI store is not in ${profile}; left for the ACP plugin`)
    return { state: 'unavailable', results: {} }
  }
  const { CliStore } = await import(pathToFileURL(clisFile).href)
  const { AGENTS } = await import(pathToFileURL(agentsFile).href)
  const store = new CliStore({
    env: { ...env, AUTOMAGIK_HOME: home, AUTOMAGIK_PNPM: env.AUTOMAGIK_PNPM || PNPM_PATH },
    log: (message) => log(`vendor CLIs: ${message}`),
  })
  const stateFile = join(home, 'vendor-clis-state.json')
  const results = {}
  const writeState = () => {
    writeFileSync(stateFile, `${JSON.stringify({ version: 1, at: new Date().toISOString(), results }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(stateFile, 0o600)
  }
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  try {
    for (const [id, spec] of Object.entries(AGENTS)) {
      if (!spec.cliPackage) continue
      const startedAt = new Date().toISOString()
      log(`vendor CLIs: observing the DSH-owned install of ${spec.defaultName} (${startedAt})`)
      let found
      const started = Date.now()
      let reported
      while (!found && Date.now() - started < timeout) {
        found = store.binOf(spec.cliPackage, spec)
        if (found) break
        reported = failureFor(spec)
        if (reported) break
        await sleep(2000)
      }
      const endedAt = new Date().toISOString()
      if (reported) {
        results[id] = { state: 'failed', startedAt, endedAt, error: String(reported) }
        warn(`vendor CLIs: ${spec.defaultName} failed: ${reported}`)
        writeState()
        continue
      }
      if (found) {
        results[id] = { state: 'ready', version: found.version, path: found.path, managed: Boolean(found.managed), startedAt, endedAt }
        log(`vendor CLIs: observed ${spec.defaultName} ${found.version} at ${found.path}`)
        if (found.managed) {
          const bridge = writeProgramsBridge({
            home, appHome: env.HERDR_APP_HOME || join(home, 'herdr-app'),
            agent: spec.key, path: found.path, log, warn,
          })
          results[id].bridge = bridge.reason
        }
      } else {
        let error = 'the DSH-owned CLI store did not install it within the observation window; see pnpm-admission.log'
        try {
          const refusal = JSON.parse(readFileSync('/data/run/pnpm-admission-refusal', 'utf8'))
          if (typeof refusal.message === 'string' && refusal.message.length > 0) error = refusal.message
        } catch { /* no refusal record */ }
        results[id] = { state: 'failed', startedAt, endedAt, error }
        warn(`vendor CLIs: ${spec.defaultName} failed: ${error}`)
      }
      writeState()
    }
  } finally {
    store.dispose?.()
  }
  const states = Object.values(results).map((entry) => entry.state)
  return { state: states.length > 0 && states.every((state) => state === 'ready') ? 'ready' : 'failed', results, stateFile }
}
