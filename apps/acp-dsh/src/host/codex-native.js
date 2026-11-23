// Codex with its own tools off (#1564 PR B; RFC 0003, Amendment: Codex native tools). OFF means
// Codex works with DSH's tools through the bridge and has none of its own: it is not Read only,
// and DSH's tools keep the Session's permission level. A config checked on every spawn removes
// every Codex tool but the bridge's transport (`exec`, `wait` and the three MCP resource
// readers); a spawn whose check does not hold is refused, never opened unchecked (LQ1).
//
// What the config cannot change it removes through the model catalog: `apply_patch` comes only
// from a model's `apply_patch_tool_type` (Codex spec_plan.rs), so the process gets a generated
// copy of `codex debug models` with that field cleared. Each model in the copy is checked once
// per spawn; one that fails is not offered while OFF. A model on the agent row's
// `nativeKeptModels` (Codex shows its tools for it nowhere a check can read) never reaches this
// path: it launches as today, with Codex's own tools.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkFeatures, checkOffered, codexCli, configArgs, MCP_LIST_TIMEOUT_MS, mcpServerNames, readFeatures, readOffered } from './image.js'
import { BRIDGE_NAME } from './names.js'

/** Listed, not removed and off, each proven by its effect on every spawn. */
export const NATIVE_OFF_REQUIRED = Object.freeze(['shell_tool', 'view_image'])
/** Sent only when this Codex lists them and has not removed them. */
export const NATIVE_OFF_ALSO = Object.freeze(['unified_exec', 'image_generation', 'multi_agent', 'apps', 'plugins',
  'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'skill_search',
  'tool_suggest', 'goals', 'code_mode', 'js_repl', 'sleep_tool', 'apply_patch_freeform', 'send_message_to_user_async',
  'request_permissions_tool', 'default_mode_request_user_input', 'standalone_web_search'])
/** The tools an OFF Codex may offer, exactly: the bridge's transport. */
export const NATIVE_OFF_TOOLS = Object.freeze(['functions.exec', 'functions.wait'])
/** The tools `exec` may reach: Codex's MCP resource readers (DSH's bridge serves none). */
export const NATIVE_OFF_NESTED = Object.freeze(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
/** Dropped from each model's `experimental_supported_tools` in the catalog copy. */
export const CATALOG_DROPS = Object.freeze(['send_message_to_user_async', 'clock'])
export const NATIVE_OFF_UNAVAILABLE = 'acp/native-off-unavailable'
export const NATIVE_OFF_DEADLINE_MS = 60_000
export const CATALOG_MAX_AGE_MS = 24 * 3600_000

const off = names => Object.fromEntries(names.map(name => [name, false]))
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CATALOG_FILE = /^models-[0-9a-f]{64}\.json$/

/** A refusal of the OFF spawn: the turn shows the unavailable text with `reason`. */
export function unavailable(reason, cause) {
  const text = String(reason ?? 'the check failed').slice(0, 200)
  return Object.assign(new Error(text), { code: NATIVE_OFF_UNAVAILABLE, reason: text, ...(cause?.stopped === true ? { stopped: true } : {}) })
}

/**
 * The catalog slug of a codex-acp `model` option value. codex-acp 2.9.0 offers bare slugs
 * (test/fixtures/codex-acp-2.9.0-models.json), so a bare slug is its own; any other shape is
 * undefined: not checked, never kept.
 */
export function modelPart(value) {
  return typeof value === 'string' && SLUG.test(value) ? value : undefined
}

/** Whether a slug is on the agent row's kept list (the one source of "unverifiable"). */
export function keptModel(agent, slug) {
  return Array.isArray(agent?.nativeKeptModels) && typeof slug === 'string' && agent.nativeKeptModels.includes(slug)
}

/** The config overrides of an OFF process, one object for both CODEX_CONFIG and the checks. */
export function nativeOffOverrides({ servers = [], extras = [], skills = [], project, catalog } = {}) {
  return {
    features: { ...off(NATIVE_OFF_REQUIRED), ...off(extras), multi_agent_v2: { enabled: false, disable_native_tools: true } },
    tools: { experimental_request_user_input: { enabled: false } },
    web_search: 'disabled',
    ...(catalog === undefined ? {} : { model_catalog_json: catalog }),
    mcp_servers: Object.fromEntries(servers.map(name => [name, { enabled: false }])),
    skills: { bundled: { enabled: false }, config: skills.map(name => ({ name, enabled: false })) },
    ...(project === undefined ? {} : { projects: { [project]: { trust_level: 'trusted' } } }),
  }
}

/**
 * The OFF copy of `codex debug models`: every model's `apply_patch_tool_type` cleared, the
 * catalog drops taken out of its `experimental_supported_tools`, and the slugs of `drop` (the
 * kept models) removed. Throws when the catalog is not a model list or nothing is left.
 */
export function offCatalog(json, { drop = [] } = {}) {
  const list = Array.isArray(json) ? json : json?.models
  if (!Array.isArray(list) || list.length === 0) throw unavailable('the model catalog could not be read')
  if (!list.every(model => model !== null && typeof model === 'object' && typeof model.slug === 'string' && SLUG.test(model.slug))) {
    throw unavailable('the model catalog could not be read')
  }
  const models = list.filter(model => !drop.includes(model.slug)).map(model => ({
    ...model,
    apply_patch_tool_type: null,
    ...(Array.isArray(model.experimental_supported_tools)
      ? { experimental_supported_tools: model.experimental_supported_tools.filter(name => !CATALOG_DROPS.includes(name)) }
      : {}),
  }))
  if (models.length === 0) throw unavailable('no model is left to check')
  return Array.isArray(json) ? { models } : { ...json, models }
}

/** Write bytes to `path` with mode 0600 through a private temp file and an atomic rename. */
export function writePrivate(path, bytes) {
  const posix = process.platform !== 'win32'
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    if (posix) chmodSync(temp, 0o600)
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Write one catalog copy into `dir`, named by its own sha256, and answer where and what. */
export function writeCatalog(dir, copy) {
  const bytes = `${JSON.stringify(copy)}\n`
  const digest = sha256(bytes)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = resolve(dir, `models-${digest}.json`)
  writePrivate(path, bytes)
  return { path, bytes, sha256: digest }
}

/**
 * The checked catalog is where a fork reads it: missing or changed, its exact bytes are
 * written back first. Throws when that write fails.
 */
export function ensureCatalog(catalog) {
  if (catalog === undefined || typeof catalog.path !== 'string' || typeof catalog.bytes !== 'string') throw unavailable('the checked model catalog is gone')
  let same = false
  try { same = sha256(readFileSync(catalog.path)) === catalog.sha256 } catch {}
  if (same) return
  writePrivate(catalog.path, catalog.bytes)
}

/**
 * Remove catalog copies older than `maxAgeMs` from `dir`, never `keepPath`. Files of other
 * names are left alone. Never throws.
 */
export function pruneCatalogs(dir, { now = Date.now, keepPath, maxAgeMs = CATALOG_MAX_AGE_MS } = {}) {
  let names
  try { names = readdirSync(dir) } catch { return }
  const keep = keepPath === undefined ? undefined : resolve(keepPath)
  for (const name of names) {
    if (!CATALOG_FILE.test(name)) continue
    const path = resolve(dir, name)
    if (path === keep) continue
    try {
      if (now() - statSync(path).mtimeMs > maxAgeMs) unlinkSync(path)
    } catch {}
  }
}

// Each removal, undone alone, must offer the tools it removes: a removal Codex ignores stops OFF.
const EFFECTS = Object.freeze([
  { name: 'shell_tool', undo: o => ({ ...o, features: { ...o.features, shell_tool: true } }), gains: /(^|[._])(exec_command|write_stdin|shell|local_shell|unified_exec)$/ },
  { name: 'view_image', undo: o => ({ ...o, features: { ...o.features, view_image: true } }), gains: /(^|[._])view_image$/ },
  { name: 'model_catalog_json', undo: ({ model_catalog_json: _, ...o }) => o, gains: /(^|[._])apply_patch$/ },
  { name: 'disable_native_tools', undo: o => ({ ...o, features: { ...o.features, multi_agent_v2: { enabled: false, disable_native_tools: false } } }), gains: /^collaboration\./ },
  { name: 'experimental_request_user_input', undo: o => ({ ...o, tools: { ...o.tools, experimental_request_user_input: { enabled: true } } }), gains: /(^|[._])request_user_input(_async)?$/ },
])

const gained = (base, shown, pattern) => [...shown.tools, ...shown.nested]
  .filter(name => !base.tools.includes(name) && !base.nested.includes(name))
  .some(name => pattern.test(name))

const OFF_RULES = { tools: NATIVE_OFF_TOOLS, nested: NATIVE_OFF_NESTED, hosted: false, run: 'Codex with its own tools off' }

/** The models `codex debug models` lists (JSON), or a refusal. */
function readModels(stdout) {
  try { return JSON.parse(String(stdout ?? '')) } catch { throw unavailable('the model catalog was not JSON') }
}

async function setupOnce(launch, { cwd, dir, kept = [], signal, run = execFile, now = Date.now, listServers = mcpServerNames, deadlineMs = NATIVE_OFF_DEADLINE_MS, timeoutMs = MCP_LIST_TIMEOUT_MS, log = () => {} } = {}) {
  if (typeof dir !== 'string' || dir === '') throw unavailable('it has no settings folder')
  let project
  try { project = await realpath(cwd) } catch { throw unavailable('its folder could not be resolved') }
  const until = now() + deadlineMs
  const left = () => {
    if (signal?.aborted) throw unavailable('the check was stopped', { stopped: true })
    const ms = Math.min(timeoutMs, until - now())
    if (ms <= 0) throw unavailable('the checks could not be made in time')
    return ms
  }
  // 1. The person's own MCP servers, each turned off by name. One named like the bridge would
  // replace it (codex-acp skips a session server whose name the home already defines).
  const servers = await listServers(launch, { run, timeoutMs: left(), cwd: project, signal })
  if (servers.includes(BRIDGE_NAME)) throw unavailable(`its Codex settings define a server named ${BRIDGE_NAME}`)
  // One CLI call at a time (B1-5): never two against the shared Codex home.
  const cli = (args, what, config) => codexCli(launch, [...args, ...configArgs(config)], { run, timeoutMs: left(), cwd: project, signal, what, refusal: 'unsupported' })
  // 2. The features, read with the required switches set.
  const extras = checkFeatures(readFeatures(await cli(['features', 'list'], 'the feature list', { features: off(NATIVE_OFF_REQUIRED) })),
    { required: NATIVE_OFF_REQUIRED, also: NATIVE_OFF_ALSO, on: null })
  // 3. The catalog copy, kept models removed: they never reach an OFF process.
  const listed = readModels(await cli(['debug', 'models'], 'the model catalog', nativeOffOverrides({ servers, extras, project })))
  const listedCount = (Array.isArray(listed) ? listed : listed?.models)?.length ?? 0
  let copy = offCatalog(listed, { drop: kept })
  let catalog = writeCatalog(dir, copy)
  // 4. The person's own skills, from two reads of the default model's prompt, each off by name.
  let skills = []
  for (let pass = 0; pass < 2; pass += 1) {
    const offered = readOffered(await cli(['debug', 'prompt-input'], 'the offered tools', nativeOffOverrides({ servers, extras, skills, project, catalog: catalog.path })))
    const more = offered.skills.filter(name => !skills.includes(name))
    if (more.length === 0) break
    skills = [...skills, ...more]
  }
  // 5. Every model in the copy, under the whole config with that model. One that offers anything
  // but the transport, or shows no tool block, is not offered while OFF (LQ1).
  const models = []
  for (const model of copy.models) {
    const config = { ...nativeOffOverrides({ servers, extras, skills, project, catalog: catalog.path }), model: model.slug }
    let fine = false
    try {
      checkOffered(readOffered(await cli(['debug', 'prompt-input'], `the offered tools of ${model.slug}`, config)), OFF_RULES)
      fine = true
    } catch (error) {
      if (error?.kind !== 'unsupported' && error?.code !== NATIVE_OFF_UNAVAILABLE) throw error
      if (signal?.aborted) throw unavailable('the check was stopped', { stopped: true })
    }
    if (fine) models.push(model.slug)
    else log(`acp-dsh: Codex model ${model.slug} could not be checked with its own tools off; it is not offered while they are off`)
  }
  if (models.length === 0) throw unavailable('no model could be checked with its own tools off')
  // 6. The final copy holds the checked models only; older copies go after a day.
  if (models.length !== copy.models.length) {
    copy = { ...copy, models: copy.models.filter(model => models.includes(model.slug)) }
    catalog = writeCatalog(dir, copy)
  }
  pruneCatalogs(dir, { now, keepPath: catalog.path })
  // 7. The default model under the final config, and the switches under it.
  const overrides = nativeOffOverrides({ servers, extras, skills, project, catalog: catalog.path })
  const offered = readOffered(await cli(['debug', 'prompt-input'], 'the offered tools', overrides))
  checkOffered(offered, OFF_RULES)
  checkFeatures(readFeatures(await cli(['features', 'list'], 'the feature list', overrides)), { required: NATIVE_OFF_REQUIRED, also: [], on: null })
  // 8. Each removal proven by its effect.
  for (const effect of EFFECTS) {
    const shown = readOffered(await cli(['debug', 'prompt-input'], `the ${effect.name} switch`, effect.undo(overrides)))
    if (!gained(offered, shown, effect.gains)) throw unavailable(`Codex ignores ${effect.name}`)
  }
  log(`acp-dsh: Codex runs with its own tools off; it offers ${offered.tools.join(', ')} (exec reaches ${offered.nested.join(', ')}); models ${models.length}/${listedCount}`)
  return { overrides, offered, models, catalog }
}

// One setup at a time per Codex home: several OFF spawns at once never run their CLI calls
// side by side against it. A setup's deadline starts when it is its turn; its Stop works while
// it waits.
const chains = new Map()

/**
 * The checks an OFF spawn rests on, against the Codex this spawn starts (its env, its home)
 * from the Session's real folder. Nothing is cached: every spawn checks again. Resolves
 * `{ overrides, offered, models, catalog: { path, bytes, sha256 } }`; rejects with
 * `code: 'acp/native-off-unavailable'` and the reason.
 * @param {{ command: string, args?: string[], env?: Record<string, string> }} launch
 */
export function nativeOffSetup(launch, options = {}) {
  const key = String(launch?.env?.CODEX_HOME ?? '')
  const previous = chains.get(key) ?? Promise.resolve()
  let release
  const mine = new Promise(done => { release = done })
  const tail = previous.then(() => mine)
  chains.set(key, tail)
  const { signal } = options
  return (async () => {
    try {
      await new Promise((done, fail) => {
        if (signal?.aborted) return fail(unavailable('the check was stopped', { stopped: true }))
        const onAbort = () => fail(unavailable('the check was stopped', { stopped: true }))
        signal?.addEventListener('abort', onAbort, { once: true })
        previous.then(() => { signal?.removeEventListener('abort', onAbort); done() })
      })
      return await setupOnce(launch, options)
    } catch (error) {
      if (error?.code === NATIVE_OFF_UNAVAILABLE) throw error
      throw unavailable(error?.message ?? error, error)
    } finally {
      release()
      if (chains.get(key) === tail) chains.delete(key)
    }
  })()
}

/**
 * The launch of an OFF Codex process: the checked overrides as its CODEX_CONFIG, and what the
 * adapter verifies before it starts it (the folder the checks ran in, the checked models and
 * the catalog bytes a fork may need again).
 */
export async function nativeOffLaunch(launch, { cwd, ...options }) {
  const { overrides, models, catalog } = await nativeOffSetup(launch, { cwd, ...options })
  return {
    command: launch.command, args: launch.args, env: { ...launch.env, CODEX_CONFIG: JSON.stringify(overrides) },
    nativeOff: true, checkedCwd: cwd, models, offCatalog: catalog,
  }
}
