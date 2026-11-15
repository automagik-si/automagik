// One image drawn by the Codex CLI, on the person's own Codex sign-in (owner decision D-g): a
// one-off codex-acp session that asks Codex's built-in image tool for one picture and ends.
//
// Codex has no allow-list of tools, and its `read-only` mode can read the disk. So the run is
// held by what can be checked, and stops when a check does not hold (#870):
// - before anything starts, the Codex the run would start is asked, through codex-acp's `cli`
//   passthrough and with the run's own overrides, which features it knows (`features list`) and
//   which tools it would offer the model (`debug prompt-input`: nothing is sent to a model;
//   the checks read the Bot's isolated Codex home, signed in or not, as the session will). A
//   feature the run relies on that Codex does not list, or does not turn off, stops the draw;
//   so does any offered tool that is not on a fixed list (a command, a file read, image
//   viewing, an MCP tool, a name this version does not know), and a tool list in a form this
//   code does not know. Nothing rests on a feature name alone: Codex takes an unknown
//   `features.<name>` without a word;
// - the same overrides, from the same object, go to the session through codex-acp's
//   CODEX_CONFIG. CODEX_HOME is the Bot's isolated Codex home, supplied by cli-homes.js;
// - a fresh permission profile requests scratch reads only. Codex's filesystem helper adds
//   runtime read grants: this is containment, not a scratch-only boundary (README, #870).
//   An adapter without that mode falls back to read-only with a warning;
// - the agent starts in an empty scratch folder with no MCP servers. The checks
//   run in that same folder, trusted the way codex-acp trusts it for the session. Every
//   permission the agent asks for is cancelled, and one that is not about the image call
//   refuses the draw (codex-acp asks none for an image). ACP's server list is
//   empty; the person's own servers are each turned off by name
//   (`mcp_servers.<name>.enabled = false`), the names read first through Codex's own
//   `codex mcp list --json` (names only: nothing else of that answer is kept or logged). An
//   empty `mcp_servers` table would not do it: Codex merges overrides into the config's tables,
//   so the person's entries would stay. Codex's bundled skills and the person's own (by name)
//   are turned off too, so nothing invites the agent to open a file;
// - the image comes back only when the turn has ended with exactly one call reported, the
//   image call. Any other call the agent reports (a command, a read, a patch, a sub-agent, an
//   MCP tool), before or after the image, ends the turn and refuses the draw;
// - the PNG is taken from the tool call's own content (an ACP image block) or its
//   `rawOutput.result`, never from the file Codex saves under its home (`rawOutput.savedPath`),
//   and is refused when it is not a PNG or is too large;
// - neither the prompt nor what the agent says is logged or kept.
// What this does not close is in the README ("Images through Codex", residual risk): first of
// all that the read-only fallback leaves the image tool's local-file input unrestricted.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRun } from './acp.js'
import { batchSafe } from './batch-spawn.js'
import { isAuthRequired } from './names.js'

// codex-acp's title for Codex's image tool (ImageGenerationReporter), of kind `other`.
export const IMAGE_TITLE = 'Image generation'
export const IMAGE_TIMEOUT_MS = 120_000
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
// Codex's features the run cannot go without: each one's switch is seen to take its tools off
// the list Codex offers (the shell tool: commands and their input; image viewing: opening a
// picture file). A Codex that does not list one, lists it as removed, or leaves it on stops
// the draw before it starts.
export const IMAGE_FEATURES_OFF = Object.freeze(['shell_tool', 'view_image'])
// Other tool sources, turned off when the installed Codex lists them and never sent when it
// does not, or when it lists them as removed (a removed switch does nothing, on or off). None
// is counted as protection: several change nothing in the tools a current Codex offers, and
// what stays on is judged by the offered-tools check, not by these names.
export const IMAGE_FEATURES_ALSO_OFF = Object.freeze(['unified_exec', 'code_mode', 'js_repl', 'apply_patch_freeform', 'multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'sleep_tool', 'skill_search', 'tool_suggest'])
export const IMAGE_FEATURE_ON = 'image_generation'
// The tools a locked-down Codex may still offer the model: its image tool, and the ones no
// switch of a current Codex takes away. None of them reads a file or runs a command by itself:
// `exec` is a JavaScript isolate with no file system, network or environment, the patch tool
// asks first (and is cancelled), and sub-agents get the same tools. Anything else stops the draw.
export const IMAGE_TOOLS_ALLOWED = Object.freeze(['functions.exec', 'functions.wait', 'functions.request_user_input', 'functions.request_user_input_async', 'clock.sleep', 'collaboration.followup_task', 'collaboration.interrupt_agent', 'collaboration.list_agents', 'collaboration.send_message', 'collaboration.spawn_agent', 'collaboration.wait_agent'])
// The tools `exec` may reach from inside its isolate.
export const IMAGE_NESTED_ALLOWED = Object.freeze(['apply_patch', 'clock__curr_time', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
// Codex's image tool: its own namespace, or the provider's hosted tool (which has no name).
const IMAGE_NAMESPACE = 'image_gen'
const IMAGE_HOSTED_TYPE = 'image_generation'
const PROMPT_ITEMS = new Set(['additional_tools', 'message'])
const FEATURE_ROW = /^([A-Za-z0-9_.-]+)\s+(\S(?:.*\S)?)\s+(true|false)$/
const TOOL_NAME = /^[A-Za-z0-9_.$-]{1,128}$/
const SKILL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/
const MAX_SKILLS = 500

const off = names => Object.fromEntries(names.map(name => [name, false]))
/**
 * The run's config overrides, as one object: the image feature on, the tool sources off, web
 * search disabled, each of the person's own MCP servers and skills turned off by name. It is
 * the one source of both the session's CODEX_CONFIG (`imageConfig`) and the `-c` arguments the
 * checks run with (`configArgs`).
 * `project` is the run's scratch folder: codex-acp trusts a session's folder as a project, so
 * the checks are made with the same trust (codex-acp then writes the same entry itself).
 * @param {{ servers?: readonly string[], extras?: readonly string[], skills?: readonly string[], project?: string }} [names]
 */
export function imageOverrides({ servers = [], extras = [], skills = [], project } = {}) {
  return {
    features: { [IMAGE_FEATURE_ON]: true, ...off(IMAGE_FEATURES_OFF), ...off(extras) },
    web_search: 'disabled',
    mcp_servers: Object.fromEntries(servers.map(name => [name, { enabled: false }])),
    skills: { bundled: { enabled: false }, config: skills.map(name => ({ name, enabled: false })) },
    ...(project === undefined ? {} : { projects: { [project]: { trust_level: 'trusted' } } }),
  }
}
/**
 * The JSON codex-acp reads as config overrides for the Codex it starts (startAcpServer), for this
 * process only.
 * @param {readonly string[]} [servers] the person's own MCP servers
 * @param {readonly string[]} [extras] the also-off features the installed Codex lists
 * @param {readonly string[]} [skills] the person's own skills
 * @param {string} [project] the run's scratch folder
 */
export function imageConfig(servers = [], extras = [], skills = [], project = undefined) {
  return JSON.stringify(imageOverrides({ servers, extras, skills, project }))
}
export const IMAGE_CONFIG = imageConfig()

const BARE_KEY = /^[A-Za-z0-9_-]+$/
// A TOML literal string where it can be one: no `"` then reaches a command line.
const tomlString = text => (/^[\w .:@/+\\-]*$/.test(text) ? `'${text}'` : JSON.stringify(text))
/** A JSON value as inline TOML, the way codex-acp writes its own `-c` overrides. */
export function toToml(value) {
  if (Array.isArray(value)) return `[${value.map(toToml).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${BARE_KEY.test(key) ? key : tomlString(key)} = ${toToml(item)}`)
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`
  }
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return String(value)
  throw new Error('a config override that TOML cannot hold')
}
/** The overrides as Codex's own `-c key=value` arguments, one per top-level key. */
export const configArgs = overrides => Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${toToml(value)}`])

export const MCP_LIST_TIMEOUT_MS = 15_000
// All the checks of one draw together.
export const IMAGE_CHECKS_TIMEOUT_MS = 40_000
const MCP_NAME = /^[A-Za-z0-9_.-]{1,128}$/
export const IMAGE_MODE = 'read-only'
// Owner policy: keep drawing on adapters that cannot select the narrow profile.
const ALLOW_IMAGE_READ_ONLY_FALLBACK = true

// The config omits network, inherited profiles and minimal roots. Codex's filesystem helper
// still adds :minimal and helper-executable reads; omitting them here cannot deny those reads.
/** The scratch project's entire config, before Codex adds its runtime grants. */
export function imageProfile(id = `automagik-image-${randomBytes(16).toString('hex')}`) {
  return {
    id,
    mode: `permission-profile:${id}`,
    config: [
      `default_permissions = ${toToml(id)}`,
      `[permissions.${toToml(id)}]`,
      `description = ${toToml('Draw one image in the scratch folder')}`,
      `[permissions.${toToml(id)}.filesystem]`,
      `${toToml(':root')} = ${toToml('deny')}`,
      `${toToml(':workspace_roots')} = ${toToml('read')}`,
      '',
    ].join('\n'),
  }
}

async function imageMode(run, profile, log, signal) {
  if (signal?.aborted || run.disposed) throw stoppedCheck()
  let reason = profile ? 'profile mode not offered' : 'profile config refused'
  if (profile && run.modes?.availableModes?.some(mode => mode.id === profile.mode)) {
    try {
      // A successful setMode response is the adapter's acknowledgement.
      await run.setMode(profile.mode, { force: true, signal })
      return true
    } catch (error) {
      if (signal?.aborted || run.disposed) throw error
      reason = 'profile mode selection rejected'
    }
  }
  if (!ALLOW_IMAGE_READ_ONLY_FALLBACK) throw notIsolated()
  try { log?.(`the Codex image run is not isolated (${reason}); falling back to read-only`) } catch {}
  await run.setMode(IMAGE_MODE, { force: true, signal })
  return false
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const SIZE_WORDS = {
  '1024x1024': 'square (1024x1024)',
  '1536x1024': 'landscape (1536x1024)',
  '1024x1536': 'portrait (1024x1536)',
}
const QUALITY_WORDS = { low: 'quick, low detail', medium: 'medium detail', high: 'high detail' }

// Why a check did not hold. `kind` says what the person can do about it: `unsupported` (this
// Codex does not take the lockdown: an update of Automagik is needed), `config` (Codex could
// not load its own configuration), `unreadable` (the check itself broke: try again). `passing`
// marks a failure that says nothing lasting about this Codex (a check that ran out of time or
// was stopped).
const checkError = (kind, message, more) => Object.assign(new Error(message), { kind }, more)
const CONFIG_BROKEN = /failed to load bootstrap configuration|TOML parse error/i
const stoppedCheck = () => checkError('unreadable', 'the check was stopped', { passing: true, stopped: true })

/**
 * One Codex CLI command through codex-acp's `cli` passthrough (the Codex the run will start),
 * in `cwd` (the run's scratch folder; a folder that is no project by default). Resolves its
 * standard output; nothing of it is logged. Past `timeoutMs`, or when `signal` aborts, the
 * command and the Codex it started are killed together and the answer does not wait for them.
 */
function codexCli(launch, args, { run = execFile, timeoutMs = MCP_LIST_TIMEOUT_MS, what, refusal = 'unreadable', cwd = tmpdir(), signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stoppedCheck())
    let child
    let timer
    let done = false
    // The passthrough starts Codex as its own child: both go, as one process group where the
    // platform has them.
    const kill = () => {
      try {
        if (process.platform !== 'win32' && Number.isInteger(child?.pid)) process.kill(-child.pid, 'SIGKILL')
        else child?.kill?.('SIGKILL')
      } catch {
        try { child?.kill?.('SIGKILL') } catch {}
      }
    }
    const end = (settle, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      settle(value)
    }
    const onAbort = () => { kill(); end(reject, stoppedCheck()) }
    try {
      const env = {
        ...(launch.env?.AUTOMAGIK_BOT_CLI_HOME ? launch.env : { ...process.env, ...launch.env }),
        NO_COLOR: '1', DISABLE_UPDATES: '1',
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => { kill(); end(reject, checkError('unreadable', `${what} could not be read in time`, { passing: true })) }, timeoutMs)
      child = run(...batchSafe(launch.command, [...(launch.args ?? []), 'cli', ...args], { env, cwd, maxBuffer: 8 << 20, windowsHide: true, detached: process.platform !== 'win32' }), (error, stdout, stderr) => {
        if (/Invalid configuration/i.test(String(stderr ?? ''))) return end(reject, checkError('config', `${what} could not be read: Codex could not load its configuration`))
        if (!error) return end(resolve, String(stdout ?? ''))
        if (CONFIG_BROKEN.test(String(stderr ?? '')) && refusal === 'unreadable') return end(reject, checkError('config', `${what} could not be read: Codex could not load its configuration`))
        // Codex answered and said no (an exit code, not a kill or a spawn failure).
        const answered = typeof error.code === 'number' && error.killed !== true
        end(reject, checkError(answered ? refusal : 'unreadable', `${what} could not be read`, error.killed === true ? { passing: true } : undefined))
      })
    } catch {
      end(reject, checkError('unreadable', `${what} could not be read`))
    }
  })
}

/**
 * The names of the MCP servers the person's Codex config lists, through codex-acp's `cli`
 * passthrough (`codex mcp list --json`, the Codex the run will start). Names only: the rest of
 * the answer is dropped unread and never logged. Rejects when the list cannot be read.
 * @param {{ command: string, args?: string[], env?: Record<string, string> }} launch
 */
export async function mcpServerNames(launch, { run = execFile, timeoutMs = MCP_LIST_TIMEOUT_MS, cwd, signal } = {}) {
  // In the run's folder, with the trust the session will give it: a server that folder's own
  // config would add is listed too.
  const trust = cwd === undefined ? [] : configArgs({ projects: imageOverrides({ project: cwd }).projects })
  const stdout = await codexCli(launch, ['mcp', 'list', '--json', ...trust], { run, timeoutMs, cwd, signal, what: 'the MCP server list' })
  let listed
  try {
    listed = JSON.parse(stdout.trim() || '[]')
  } catch {
    throw checkError('unreadable', 'the MCP server list was not JSON')
  }
  const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.servers) ? listed.servers : Array.isArray(listed?.data) ? listed.data : undefined
  if (rows === undefined) throw checkError('unreadable', 'the MCP server list was not a list')
  const names = rows.map(row => row?.name)
  if (names.some(name => typeof name !== 'string' || !MCP_NAME.test(name))) throw checkError('unreadable', 'the MCP server list named a server that cannot be turned off')
  return [...new Set(names)]
}

/**
 * The rows of `codex features list`: name -> { stage, on }. A stage may hold spaces ("under
 * development"), a name dots, and a removed feature may read `true`. Any line that is not a
 * row, or no row at all, is a format this code does not know.
 */
export function readFeatures(stdout) {
  const rows = new Map()
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const row = FEATURE_ROW.exec(line.trim())
    if (row === null) throw checkError('unsupported', 'the feature list had a line that is not a feature')
    rows.set(row[1], { stage: row[2], on: row[3] === 'true' })
  }
  if (rows.size === 0) throw checkError('unsupported', 'the feature list was empty')
  return rows
}

/**
 * Whether the installed Codex took the run's switches: every required feature listed, not
 * removed and off; the image feature listed, not removed and on. Answers the also-off names
 * this Codex lists (and has not removed), the only ones the run then sends.
 * @param {Map<string, { stage: string, on: boolean }>} rows read with the required overrides
 */
export function checkFeatures(rows, { required = IMAGE_FEATURES_OFF, also = IMAGE_FEATURES_ALSO_OFF } = {}) {
  const live = name => rows.has(name) && rows.get(name).stage !== 'removed'
  for (const name of required) {
    if (!live(name)) throw checkError('unsupported', `Codex does not know the feature ${name}`)
    if (rows.get(name).on) throw checkError('unsupported', `Codex did not turn the feature ${name} off`)
  }
  if (!live(IMAGE_FEATURE_ON) || !rows.get(IMAGE_FEATURE_ON).on) throw checkError('unsupported', `Codex did not turn the feature ${IMAGE_FEATURE_ON} on`)
  return also.filter(name => live(name) && !required.includes(name))
}

const shown = name => String(name).slice(0, 80).replace(/[^A-Za-z0-9_.$:-]/g, '?')

// The fields a current Codex gives each kind of offered tool. A field this code does not know
// (a list of further tools, say) is a form it cannot judge.
const ENTRY_KEYS = {
  namespace: ['type', 'name', 'description', 'tools'],
  function: ['type', 'name', 'description', 'parameters', 'strict'],
  custom: ['type', 'name', 'description', 'format'],
}
const EXEC_TOOL = 'functions.exec'
const DECLARATION = /\bdeclare const tools: \{ ([A-Za-z_$][\w$]*)\(/g
const SIGNATURE = /\b([A-Za-z_$][\w$]*)\s*\(\s*(?:args|input)\s*:/g
const HEADING = /^#{1,6}[ \t]*`([^`\n]*)`[ \t]*$/gm
const CLOSERS = { '{': '}', '(': ')', '[': ']' }

/**
 * Whether the TypeScript object type opening at `text[from]` (a `{`) holds exactly one member
 * and closes: comments and quoted strings are skipped, brackets must pair.
 */
function oneMember(text, from) {
  const open = []
  let members = 0
  let blank = true
  for (let at = from; at < text.length; at += 1) {
    const char = text[at]
    if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at)
      if (end === -1) return false
      at = end
      continue
    }
    if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      if (end === -1) return false
      at = end + 1
      continue
    }
    if (char === '"' || char === '\'' || char === '`') {
      let end = at + 1
      while (end < text.length && text[end] !== char && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
      if (text[end] !== char) return false
      at = end
      if (open.length === 1) blank = false
      continue
    }
    if (CLOSERS[char] !== undefined) {
      if (open.length === 1) blank = false
      open.push(CLOSERS[char])
      continue
    }
    if (char === '}' || char === ')' || char === ']') {
      if (open.pop() !== char) return false
      if (open.length === 0) return members + (blank ? 0 : 1) === 1
      continue
    }
    if (open.length !== 1) continue
    if (char === ';' || char === ',') {
      if (!blank) members += 1
      blank = true
    } else if (!/\s/.test(char)) blank = false
  }
  return false
}

/**
 * The tools a description says `exec` reaches from inside its isolate. Codex writes each as
 * one TypeScript declaration, `declare const tools: { name(args: …): …; };`, under a heading
 * of its name. Rejects any other form: a `declare` of another shape, a block with more than
 * one member or that does not close, a signature or a heading with no declaration of its own.
 */
export function nestedTools(description) {
  const text = typeof description === 'string' ? description : ''
  const unreadable = () => checkError('unsupported', 'a nested tool this code cannot read')
  const blocks = [...text.matchAll(DECLARATION)]
  if ((text.match(/\bdeclare\b/g)?.length ?? 0) !== blocks.length) throw unreadable()
  const names = blocks.map(block => block[1])
  if (new Set(names).size !== names.length) throw unreadable()
  for (const block of blocks) if (!oneMember(text, block.index + block[0].indexOf('{'))) throw unreadable()
  if ([...text.matchAll(SIGNATURE)].some(match => !names.includes(match[1]))) throw unreadable()
  for (const [, title] of text.matchAll(HEADING)) if (!names.includes(title)) throw unreadable()
  return names
}

/**
 * What `codex debug prompt-input` says the model would be given: the tools offered (a
 * namespaced one as `namespace.name`, a hosted one with no name as `type:<its type>`), the
 * tools `exec` reaches from inside its isolate, and the names of the skills advertised.
 * Rejects when the answer is not that list, holds a kind of item or of tool this code does not
 * know, a tool with a field it does not know, an `exec` that names no tool it reaches, or no
 * tool block at all (a Codex that sends its tools another way shows none here).
 */
export function readOffered(stdout) {
  let items
  try {
    items = JSON.parse(String(stdout ?? ''))
  } catch {
    throw checkError('unsupported', 'the offered tools were not JSON')
  }
  if (!Array.isArray(items)) throw checkError('unsupported', 'the offered tools were not a list')
  const tools = []
  const nested = []
  const skills = []
  let blocks = 0
  const walk = (entries, namespace) => {
    if (!Array.isArray(entries)) throw checkError('unsupported', 'a tool block was not a list')
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw checkError('unsupported', 'an offered tool was not an object')
      const hosted = entry.name === undefined && namespace === undefined && typeof entry.type === 'string' && entry.tools === undefined
      if (!hosted) {
        if (typeof entry.name !== 'string' || !TOOL_NAME.test(entry.name)) throw checkError('unsupported', 'an offered tool with no readable name')
        const unknown = ENTRY_KEYS[entry.type] === undefined ? 'type' : Object.keys(entry).find(key => !ENTRY_KEYS[entry.type].includes(key))
        if (unknown !== undefined) throw checkError('unsupported', `an offered tool in a form this code does not know (${shown(entry.name)}: ${shown(unknown)})`)
      }
      if (entry.type === 'namespace' && !hosted) {
        if (namespace !== undefined || !Array.isArray(entry.tools)) throw checkError('unsupported', 'a tool namespace this code cannot read')
        if (nestedTools(entry.description).length > 0) throw checkError('unsupported', 'a nested tool this code cannot read')
        walk(entry.tools, entry.name)
        continue
      }
      const name = hosted ? `type:${entry.type}` : namespace === undefined ? entry.name : `${namespace}.${entry.name}`
      tools.push(name)
      // `exec` describes each tool it can reach as a TypeScript declaration.
      const reached = nestedTools(entry.description)
      if (name === EXEC_TOOL && reached.length === 0) throw checkError('unsupported', 'exec names no tool it reaches')
      nested.push(...reached)
    }
  }
  for (const item of items) {
    if (!PROMPT_ITEMS.has(item?.type)) throw checkError('unsupported', `a prompt item of an unknown kind (${shown(item?.type)})`)
    if (item.type === 'additional_tools') {
      blocks += 1
      walk(item.tools)
      continue
    }
    for (const part of Array.isArray(item.content) ? item.content : []) {
      const text = typeof part?.text === 'string' ? part.text : ''
      const from = text.indexOf('<skills_instructions>')
      if (from === -1) continue
      for (const line of text.slice(from).split('\n')) {
        const name = /^- (\S+): /.exec(line)?.[1]
        if (name !== undefined && SKILL_NAME.test(name)) skills.push(name)
      }
    }
  }
  if (blocks === 0) throw checkError('unsupported', 'Codex showed no tool block')
  return { tools: [...new Set(tools)], nested: [...new Set(nested)], skills: [...new Set(skills)].slice(0, MAX_SKILLS) }
}

/** Refuses any offered tool that is not on the fixed list or the image tool's own. */
export function checkOffered({ tools, nested }) {
  for (const name of tools) {
    if (IMAGE_TOOLS_ALLOWED.includes(name) || name === `type:${IMAGE_HOSTED_TYPE}` || name.startsWith(`${IMAGE_NAMESPACE}.`)) continue
    throw checkError('unsupported', `Codex offers a tool the image run does not allow (${shown(name)})`)
  }
  for (const name of nested) {
    if (IMAGE_NESTED_ALLOWED.includes(name) || name.startsWith(`${IMAGE_NAMESPACE}__`)) continue
    throw checkError('unsupported', `Codex offers a nested tool the image run does not allow (${shown(name)})`)
  }
}

/**
 * The checks a draw rests on, against the Codex the run would start; nothing is started and
 * nothing is sent to a model. They read the Bot's isolated Codex home, signed in or not, as the
 * session will, from `cwd` (the run's scratch folder, which the overrides then trust as
 * codex-acp does). Resolves the names the run turns off and its overrides ({ servers, extras,
 * skills, overrides }); rejects with a `kind` (see checkError) when a check does not hold, is
 * stopped by `signal`, or all of them together take longer than `deadlineMs`.
 * @param {{ command: string, args?: string[], env?: Record<string, string> }} launch
 */
export async function imageSetup(launch, { run = execFile, timeoutMs = MCP_LIST_TIMEOUT_MS, deadlineMs = IMAGE_CHECKS_TIMEOUT_MS, now = Date.now, cwd, signal, listServers = mcpServerNames, required = IMAGE_FEATURES_OFF, also = IMAGE_FEATURES_ALSO_OFF } = {}) {
  // Codex resolves a folder before it matches it against `projects`, while codex-acp keys the
  // session's trust by the cwd it is given. Resolve once, so the checks, the trust entry and the
  // session name the same folder (the macOS temp folder is reached through a symlink).
  const project = cwd === undefined ? undefined : await realpath(cwd)
  const until = now() + deadlineMs
  // What one more check may take: never past the deadline, and none once the draw is stopped.
  const left = () => {
    if (signal?.aborted) throw stoppedCheck()
    const ms = Math.min(timeoutMs, until - now())
    if (ms <= 0) throw checkError('unreadable', 'the checks could not be made in time', { passing: true })
    return ms
  }
  // The person's own MCP servers, each turned off for this run.
  const servers = await listServers(launch, { run, timeoutMs: left(), cwd: project, signal })
  const cli = (args, what) => codexCli(launch, args, { run, timeoutMs: left(), cwd: project, signal, what, refusal: 'unsupported' })
  // The features, read with the required switches set: the list answers the effective values.
  const rows = readFeatures(await cli(['features', 'list', ...configArgs({ features: { [IMAGE_FEATURE_ON]: true, ...off(required) } })], 'the feature list'))
  const extras = checkFeatures(rows, { required, also })
  // The tools offered under the run's whole config. A first pass names the person's own
  // skills; they are turned off by name and the tools are read again under that config.
  let skills = []
  for (let pass = 0; ; pass += 1) {
    const overrides = imageOverrides({ servers, extras, skills, project })
    const offered = readOffered(await cli(['debug', 'prompt-input', ...configArgs(overrides)], 'the offered tools'))
    checkOffered(offered)
    const more = offered.skills.filter(name => !skills.includes(name))
    if (more.length === 0 || pass === 1) return { servers, extras, skills, overrides }
    skills = [...skills, ...more]
  }
}

/**
 * Whether the installed Codex takes the lockdown, remembered per Codex and adapter (their
 * paths and change times) for `ttlMs`: `{ ok: true }`, or `{ ok: false, reason }` where
 * `reason` is the check's kind (`unsupported`: an update is needed; `config`: Codex cannot
 * load its configuration; `unreadable`: the check keeps breaking). A check that only ran out
 * of time answers `{ ok: undefined }` and is never remembered. A draw runs its own check every
 * time; this answer is for saying beforehand whether Codex can draw.
 */
export function imageSupport({ setup = imageSetup, ttlMs = 5 * 60_000, now = Date.now, log } = {}) {
  let held
  let pending
  const changed = (file) => {
    try {
      const stat = statSync(file)
      return [stat.mtimeMs, stat.size]
    } catch {
      return null
    }
  }
  return async function supported(launch) {
    const files = [launch.command, ...(launch.args ?? []), launch.env?.CODEX_PATH].filter(file => typeof file === 'string')
    const key = JSON.stringify(files.map(file => [file, changed(file)]))
    if (held !== undefined && held.key === key && now() - held.at < ttlMs) return held.verdict
    if (pending?.key === key) return pending.verdict
    const verdict = (async () => {
      try {
        await setup(launch)
        held = { key, at: now(), verdict: { ok: true } }
      } catch (error) {
        if (error?.passing === true) return { ok: undefined }
        const reason = CHECK_TEXT[error?.kind] === undefined ? 'unreadable' : error.kind
        try {
          log?.(`Codex cannot draw images (${reason}): ${String(error?.message ?? '').slice(0, 200)}`)
        } catch {}
        held = { key, at: now(), verdict: { ok: false, reason } }
      } finally {
        pending = undefined
      }
      return held.verdict
    })()
    pending = { key, verdict }
    return verdict
  }
}

/** A refusal the caller shows as it is: `code` says which. */
export const imageRefusal = (code, message) => Object.assign(new Error(message), { code })
export const SIGNED_OUT = 'acp/image-signed-out'
export const USAGE_LIMIT = 'acp/image-usage-limit'
export const TIMED_OUT = 'acp/image-timeout'
export const UNAVAILABLE = 'acp/image-unavailable'
export const FAILED = 'acp/image-failed'
export const STOPPED = 'acp/image-stopped'
export const REFUSED = 'acp/image-refused'

const signedOut = () => imageRefusal(SIGNED_OUT, 'Codex is not signed in. Sign in to Codex from a Bot\'s chat, or add an OpenAI key, then try again.')
const usageLimit = () => imageRefusal(USAGE_LIMIT, 'Codex has reached its usage limit on this ChatGPT plan. Try again when the limit resets, or add an OpenAI key.')
const USAGE_TEXT = /usage limit|usage_limit|quota/i

/** What the agent is asked: one call of its image tool, the size and background in words. */
export function imagePrompt({ prompt, size, quality, background } = {}) {
  const lines = [
    'Use your image generation tool exactly once to draw the image described below. Do not run commands, read or write files, or browse; do not ask questions; do not describe the image afterwards.',
  ]
  if (SIZE_WORDS[size]) lines.push(`Size: ${SIZE_WORDS[size]}.`)
  if (QUALITY_WORDS[quality]) lines.push(`Detail: ${QUALITY_WORDS[quality]}.`)
  if (background === 'transparent') lines.push('Background: transparent, a cut-out with no backdrop.')
  else if (background === 'opaque') lines.push('Background: opaque, filled to the edges.')
  lines.push('', 'The image:', String(prompt ?? ''))
  return lines.join('\n')
}

const isImageCall = tool => tool?.title === IMAGE_TITLE

/** The PNG of a finished image call, as base64, from its content or its raw output; never its saved file. */
export function imageOf(tool) {
  // Output only: Codex has already read its inputs. No input path passes through this function.
  if (!isImageCall(tool)) return undefined
  for (const item of Array.isArray(tool.content) ? tool.content : []) {
    const block = item?.type === 'content' ? item.content : item
    if (block?.type === 'image' && typeof block.data === 'string' && block.data !== '') return block.data
  }
  const result = tool.rawOutput?.result
  return typeof result === 'string' && result !== '' ? result : undefined
}

/** Whether base64 holds a PNG. */
export const isPng = (base64) => {
  try {
    return Buffer.from(String(base64).slice(0, 16), 'base64').subarray(0, 4).equals(PNG_MAGIC)
  } catch {
    return false
  }
}

// The run, with its own answers to the agent: nothing it asks for is allowed.
class ImageRun extends AgentRun {
  // codex-acp asks permission for a command, a file change or wider access, never for an image:
  // every request is cancelled, and one that is not about a call already seen as the image
  // call (a title alone does not make it one) refuses the draw.
  onPermission(params) {
    if (!this.acceptsPermission(params)) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    if (!isImageCall(this.tools.get(params?.toolCall?.toolCallId))) this.spec.onAsked?.()
    return Promise.resolve({ outcome: { outcome: 'cancelled' } })
  }

  // Every call the agent reports, new or changed, is seen: a call that never asked still shows.
  seeTool(update) {
    const fresh = !this.tools.has(update?.toolCallId)
    const tool = super.seeTool(update)
    if (fresh && tool !== undefined && tool.retired !== true) this.spec.onTool?.(tool)
    return tool
  }

  changeTool(tool, update) {
    super.changeTool(tool, update)
    this.spec.onTool?.(tool)
  }
}

/** The refusal of a Codex that does not take the lockdown, for a caller that knew beforehand. */
export const unsupported = () => imageRefusal(UNAVAILABLE, CHECK_TEXT.unsupported)
const notIsolated = () => imageRefusal(UNAVAILABLE, 'The Codex image run could not be isolated, so the image was not started. Update Automagik, or add an OpenAI key.')
const CHECK_TEXT = {
  unsupported: 'Codex here offers tools the image run could not turn off, so the image was not started. Update Automagik, or add an OpenAI key.',
  config: 'Codex could not load its own configuration, so the image was not started. Fix Codex\'s config file, or add an OpenAI key.',
  unreadable: 'Codex could not be checked for safe drawing, so the image was not started. Try again.',
}

/**
 * Draws one image with Codex. `spawn()` is the acp-codex launch ({ command, args, env }), and
 * may throw when its connector is not installed yet. Resolves { base64, mimeType }; rejects with
 * an `imageRefusal` (signed out, usage limit, timeout, stopped, failed, refused, unavailable).
 * `log` is told, in one line with no private content, why a check stopped the draw.
 * @param {{ spawn: () => { command: string, args?: string[], env?: Record<string, string> }, prompt: string, size?: string, quality?: string, background?: string, signal?: AbortSignal, timeoutMs?: number, checkTimeoutMs?: number, name?: string, scratch?: () => Promise<string>, Run?: typeof AgentRun, listServers?: typeof mcpServerNames, log?: (line: string) => void }} request
 */
export async function drawImage({ spawn, prompt, size, quality, background, signal, timeoutMs = IMAGE_TIMEOUT_MS, checkTimeoutMs = MCP_LIST_TIMEOUT_MS, name = 'Codex', scratch = async () => realpath(await mkdtemp(join(tmpdir(), 'automagik-image-'))), Run = ImageRun, listServers = mcpServerNames, log }) {
  if (signal?.aborted) throw imageRefusal(STOPPED, 'The image was stopped before it was started.')
  // The draw holds the event loop from start to cleanup: the run lets go of it once a turn ends,
  // and its close and cancel guards must not be cut short by a process with nothing else alive.
  const keepAlive = setInterval(() => {}, 1 << 30)
  try {
    return await draw({ spawn, prompt, size, quality, background, signal, timeoutMs, checkTimeoutMs, name, scratch, Run, listServers, log })
  } finally {
    clearInterval(keepAlive)
  }
}

async function draw({ spawn, prompt, size, quality, background, signal, timeoutMs, checkTimeoutMs, name, scratch, Run, listServers, log }) {
  let launch
  try {
    launch = spawn()
  } catch (error) {
    throw imageRefusal(UNAVAILABLE, `Codex cannot draw yet: ${String(error?.message ?? error).slice(0, 200)}`)
  }
  // The lockdown is checked against this Codex before anything of it starts, in the folder
  // the session would get: no session and no model request exist when a check does not hold.
  const dir = await scratch()
  let profile = imageProfile()
  let setup
  let listed = false
  try {
    await mkdir(join(dir, '.codex'), { mode: 0o700 })
    await writeFile(join(dir, '.codex', 'config.toml'), profile.config, { mode: 0o600, flag: 'wx' })
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    if (signal?.aborted) throw imageRefusal(STOPPED, 'The image was stopped before it was started.')
    try { log?.('the Codex image run was not started: the scratch folder could not be prepared') } catch {}
    throw imageRefusal(UNAVAILABLE, 'The scratch folder could not be prepared, so the image was not started. Try again.')
  }
  try {
    const check = () => imageSetup(launch, { timeoutMs: checkTimeoutMs, cwd: dir, signal, listServers: async (...args) => { const names = await listServers(...args); listed = true; return names } })
    try {
      setup = await check()
    } catch (error) {
      if (signal?.aborted || error?.stopped || error?.kind !== 'config') throw error
      if (!ALLOW_IMAGE_READ_ONLY_FALLBACK) throw notIsolated()
      await rm(join(dir, '.codex'), { recursive: true, force: true })
      profile = undefined
      listed = false
      setup = await check()
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    if (signal?.aborted || error?.stopped === true) throw imageRefusal(STOPPED, 'The image was stopped before it was started.')
    if (error?.code === UNAVAILABLE) throw error
    if (!listed && error?.kind !== 'config') throw imageRefusal(UNAVAILABLE, 'Codex\'s MCP servers could not be listed, so the image was not started (none of them may run while it draws). Try again.')
    const kind = CHECK_TEXT[error?.kind] === undefined ? 'unreadable' : error.kind
    try {
      log?.(`the Codex image run was not started (${kind}): ${String(error?.message ?? '').slice(0, 200)}`)
    } catch {}
    throw imageRefusal(UNAVAILABLE, CHECK_TEXT[kind])
  }
  if (signal?.aborted) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    throw imageRefusal(STOPPED, 'The image was stopped before it was started.')
  }
  let found
  let foundError
  let wake
  const settled = new Promise((resolve) => { wake = resolve })
  const refuse = () => {
    if (foundError?.code === REFUSED) return
    foundError = imageRefusal(REFUSED, 'Codex tried to do something other than draw (a command, a file or a tool), so the image was stopped. Try again, or describe it differently.')
    wake()
  }
  // The one image call of the turn, by its id.
  let imageCall
  const run = new Run({
    ...launch,
    env: { ...launch.env, CODEX_CONFIG: JSON.stringify(setup.overrides) },
    cwd: dir,
    name,
    mcpServers: [],
    onAsked: () => refuse(),
    onRejected: () => refuse(),
    onIgnored: log,
    // Every call the agent reports is judged, to the end of the turn: one that is not the image
    // call, or a second image call, refuses the draw whether it comes before or after the image.
    onTool: (tool) => {
      if (!isImageCall(tool)) return refuse()
      imageCall ??= tool.id
      if (tool.id !== imageCall) return refuse()
      if (found !== undefined || foundError !== undefined) return
      const base64 = imageOf(tool)
      // The image is held until the turn ends; nothing wakes the draw for it.
      if (base64 !== undefined) found = base64
      else if (tool.status === 'failed') {
        foundError = imageRefusal(FAILED, 'Codex could not draw this image. Try again, or describe it differently.')
        wake()
      }
    },
  })
  let timer
  const starting = new AbortController()
  const modeSignal = signal ? AbortSignal.any([signal, starting.signal]) : starting.signal
  const onAbort = () => wake()
  try {
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => wake(), timeoutMs)
    timer.unref?.()
    let isolated = false
    const started = run.start().then(async () => { isolated = await imageMode(run, profile, log, modeSignal) })
    started.catch(() => {})
    try {
      await Promise.race([started, settled.then(() => { throw undefined })])
    } catch (error) {
      if (signal?.aborted) throw imageRefusal(STOPPED, 'The image was stopped before it was finished.')
      if (error === undefined) throw imageRefusal(TIMED_OUT, 'Codex did not start in time. Try again.')
      if (isAuthRequired(error)) throw signedOut()
      if (error?.code === UNAVAILABLE) throw error
      throw imageRefusal(UNAVAILABLE, `Codex did not start: ${String(error?.message ?? error).slice(0, 200)}`)
    }
    let said = ''
    let ended
    const prompting = run.prompt([{ type: 'text', text: imagePrompt({ prompt, size, quality, background }) }])
    // The agent's words are read only for a usage-limit notice; they are kept nowhere.
    const reading = (async () => {
      for (;;) {
        const event = await run.next()
        if (event.type === 'text') said = (said + event.text).slice(-2000)
        if (event.type === 'end' || event.type === 'error' || event.type === 'aborted') {
          ended = event
          wake()
          return
        }
      }
    })()
    reading.catch(() => {})
    void prompting
    await settled
    if (foundError?.code === REFUSED) throw foundError
    // Only a turn that ended by itself gives its image back: until then another call may still
    // be reported.
    if (found !== undefined && ended?.type === 'end' && !signal?.aborted) {
      if (!isPng(found)) throw imageRefusal(FAILED, 'Codex answered with something that is not a PNG image. Try again.')
      if (Math.floor(found.length * 3 / 4) > MAX_IMAGE_BYTES) throw imageRefusal(FAILED, 'Codex answered with an image too large to keep. Try again.')
      // `isolated` records profile acknowledgement, not proof of scratch-only reads.
      // Internal status stays out of the image payload copied by callers.
      return Object.defineProperty({ base64: found, mimeType: 'image/png' }, 'isolated', { value: isolated })
    }
    if (signal?.aborted) throw imageRefusal(STOPPED, 'The image was stopped before it was finished.')
    if (foundError !== undefined) throw foundError
    if (ended === undefined) throw imageRefusal(TIMED_OUT, `Codex did not finish the image within ${Math.round(timeoutMs / 1000)} seconds. Try again.`)
    if (ended.type === 'error' && isAuthRequired(ended)) throw signedOut()
    if (USAGE_TEXT.test(said) || (ended.type === 'error' && USAGE_TEXT.test(String(ended.message ?? '')))) throw usageLimit()
    throw imageRefusal(FAILED, 'Codex ended without drawing an image. Try again.')
  } finally {
    starting.abort()
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (run.busy) await Promise.race([run.cancel(), new Promise(resolve => setTimeout(resolve, 2000).unref?.())])
    if (run.sessionId !== undefined && typeof run.conn?.closeSession === 'function' && run.alive) {
      await Promise.race([run.conn.closeSession({ sessionId: run.sessionId }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000).unref?.())])
    }
    run.dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
