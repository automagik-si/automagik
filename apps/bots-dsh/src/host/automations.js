import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CODE_REFUSED } from './cli-login.js'
import { fromWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'
import { compareVersions } from './lane-verify.js'

const LOCAL_BINS = ['/opt/homebrew/bin', '/usr/local/bin']
const AGENT_COMMANDS = {
  codex: new Set('exec e resume login logout mcp mcp-server app-server apply a completion debug sandbox cloud help proto generate-ts'.split(' ')),
  claude: new Set('config mcp migrate-installer setup-token doctor update install help'.split(' ')),
}
const REV = /^[0-9a-f]{16}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const RUN_TIME = /^(\d{4})-(\d\d)-(\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
const STATUSES = new Set(['scheduled', 'running', 'done', 'failed', 'skipped', 'missed', 'invalid', 'cancelled'])
const TRIGGERS = new Set(['cron', 'catchup', 'manual'])
const EDIT_KEYS = ['cron', 'repo', 'workspace', 'prompt', 'timeout_minutes']
const ENTRY_KEYS = ['name', 'agent', ...EDIT_KEYS]
const ONLY_NEW = 'Only new automations can be created here.'
const EDIT_VERSION = 'Editing needs scheduler 0.12 or later. Update the Herdr pack.'
const FAILURES = {
  'not-installed': "The scheduler is not installed on this computer. The Herdr pack's installer sets it up.",
  'cli-error': 'The scheduler could not do this.',
  'cli-timeout': 'The scheduler took too long to reply.',
  'cli-overflow': 'The scheduler returned too much data.',
  'cli-protocol': 'The scheduler returned an unexpected reply.',
}

const failure = (reason, message = FAILURES[reason]) => ({ reason, message })
const cliFailure = reason => new Error(FAILURES[reason], { cause: reason })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' ? value.slice(0, 300) : ''
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? text(value) : null
const nonempty = value => typeof value === 'string' && value.length > 0
const validName = name => typeof name === 'string' && name.length <= 64 && name.trim() !== ''
  && !name.startsWith('-') && !/\p{Cc}/u.test(name)
const validRevision = rev => typeof rev === 'string' && REV.test(rev)
const exactKeys = (body, keys) => record(body) && Object.keys(body).length === keys.length
  && keys.every(key => Object.hasOwn(body, key))
const validBinding = (body, keys = ['name', 'rev']) => exactKeys(body, keys) && validName(body.name) && validRevision(body.rev)
function keepsKeys(version) {
  const v = version.replace(/^v/, '')
  return SEMVER.test(v) && compareVersions(v, '0.12.0') >= 0
}

function runTime(value) {
  if (typeof value !== 'string') return null
  const match = RUN_TIME.exec(value)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  if (year === 1 || month < 1 || month > 12 || day < 1) return null
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= daysInMonth[month - 1] ? date(value) : null
}
function projectRun(row) {
  const started = runTime(row.started)
  const at = runTime(row.at)
  return {
    status: STATUSES.has(row.status) ? row.status : 'unknown',
    trigger: TRIGGERS.has(row.trigger) ? row.trigger : null,
    started, at,
    seconds: started && at && Number.isSafeInteger(row.seconds) && row.seconds >= 0 ? row.seconds : null,
    exitCode: Number.isSafeInteger(row.exit_code) ? row.exit_code : null,
  }
}

function directory(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  try { return statSync(path).isDirectory() } catch { return false }
}

function executable(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

export function resolveScheduler(env = process.env) {
  if (Object.hasOwn(env, 'HERDR_AUTOMATIONS')) {
    return executable(env.HERDR_AUTOMATIONS) ? env.HERDR_AUTOMATIONS : undefined
  }
  const home = env.HOME ?? homedir()
  const bins = isAbsolute(home) ? [join(home, '.local/bin'), ...LOCAL_BINS] : LOCAL_BINS
  return bins.map(bin => join(bin, 'herdr-automations')).find(executable)
}

export function runScheduler(path, args, { stdin, timeoutMs = 15_000, maxBytes = 2 * 1024 * 1024, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(path, args, { encoding: 'buffer', env, timeout: timeoutMs, maxBuffer: maxBytes, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || stdout.length + stderr.length > maxBytes) reject(cliFailure('cli-overflow'))
      else if (error?.killed) reject(cliFailure('cli-timeout'))
      else if (error) reject(cliFailure('cli-error'))
      else resolve(stdout.toString('utf8'))
    })
    // A CLI refusal can close stdin before the write finishes. Its exit status is authoritative.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

function parseJSON(output) {
  try { return JSON.parse(output) } catch { throw cliFailure('cli-protocol') }
}

function listingOf(output) {
  const raw = parseJSON(output)
  if (!record(raw) || typeof raw.paused !== 'boolean' || !Number.isInteger(raw.scheduler)
      || !Array.isArray(raw.automations) || !raw.automations.every(row => record(row) && typeof row.name === 'string')
      || !Array.isArray(raw.invalid) || !raw.invalid.every(record)) throw cliFailure('cli-protocol')
  return raw
}

function sortedJSON(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(',')}]`
  if (!record(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sortedJSON(value[key])}`).join(',')}}`
}

function revision({ next, last, line, ...stable }) {
  return createHash('sha256').update(sortedJSON(stable)).digest('hex').slice(0, 16)
}

function identity(row) {
  return { name: text(row.name), rev: revision(row), ...(validName(row.name) ? { removeName: row.name } : {}) }
}

function bound({ automations, invalid }, name, rev, { allowInvalid = false } = {}) {
  const matches = [...automations, ...invalid].filter(row => row.name === name)
  if (matches.length === 0) return failure('gone')
  const [row] = matches
  if (matches.length !== 1 || (!allowInvalid && !automations.includes(row)) || revision(row) !== rev) return failure('changed')
  return { row }
}

// YAML writes look up the raw name. An unnamed diagnostic can hide that lookup's first match.
const writeTargetKnown = listing => listing.invalid.every(row => nonempty(row.name))

function editable(row, rt) {
  return typeof row.agent === 'string' && Object.hasOwn(AGENT_COMMANDS, row.agent)
    && !promptProblem(row.prompt, row.agent) && rt.loginTextMatches?.(row.prompt) !== true
    && !row.command && !row.workflow && !row.template && !row.target && !row.target_when_busy && !row.workspace_id
    && (row.workspace === 'worktree' || row.workspace === 'root')
    && nonempty(row.cron) && nonempty(row.repo) && isAbsolute(row.repo)
    && Number.isSafeInteger(row.timeout_minutes) && row.timeout_minutes >= 1
}

export function projectListing(raw, version = '', rt = {}) {
  const counts = new Map()
  for (const { name } of [...raw.automations, ...raw.invalid]) counts.set(name, (counts.get(name) ?? 0) + 1)
  const targetsKnown = writeTargetKnown(raw)
  const canEdit = keepsKeys(version)
  const details = []
  return {
    paused: raw.paused,
    schedulerRunning: raw.scheduler > 0,
    automations: raw.automations.map(row => {
      const last = record(row.last) ? projectRun(row.last) : null
      const run = validName(row.name) && counts.get(row.name) === 1
      const pause = run && targetsKnown
      details.push({ run, pause, edit: pause && canEdit && editable(row, rt), lastTrigger: last?.trigger ?? null })
      return {
        ...identity(row),
        cron: text(row.cron), repo: text(row.repo), workspace: text(row.workspace),
        agent: text(row.agent), model: text(row.model), template: text(row.template),
        kind: row.command ? 'command' : row.workflow ? 'workflow' : 'prompt',
        hasTarget: Boolean(row.target), disabled: row.disabled === true, next: date(row.next),
        last: last ? { status: last.status, at: last.at } : null,
      }
    }),
    invalid: raw.invalid.map(row => {
      const line = Number.isSafeInteger(row.line) && row.line > 0 ? row.line : 0
      return { ...identity(row), line, message: `This entry does not load. Fix it in the scheduler's file (line ${line}).` }
    }),
    details,
  }
}

function putResult(output, name) {
  const answer = parseJSON(output)
  if (!record(answer) || (answer.problem !== undefined && typeof answer.problem !== 'string')
      || (answer.next !== undefined && (!Array.isArray(answer.next) || !answer.next.every(date)))) throw cliFailure('cli-protocol')
  if (!answer.problem) return { next: answer.next?.map(date) ?? [] }
  const prefix = `${name}: `
  const problem = answer.problem.startsWith(prefix) ? answer.problem.slice(prefix.length) : answer.problem
  if (/already exists/i.test(problem)) return { problem: 'An automation with this name already exists.' }
  if (/missing repo/i.test(problem)) return { problem: 'Choose a folder.' }
  if (/^(?:invalid|missing) cron\b/i.test(problem)) return { problem: 'The schedule is not a valid cron expression.' }
  return { problem: 'The scheduler refused this automation.' }
}

function promptProblem(prompt, agent) {
  if (typeof prompt !== 'string' || prompt.length > 8000 || !prompt.trim() || prompt.trimStart().startsWith('-')
      || /\p{Cc}/u.test(prompt.replace(/[\t\n]/g, ''))) {
    return 'Enter a prompt of up to 8,000 characters without control characters or a leading dash.'
  }
  if (AGENT_COMMANDS[agent].has(prompt.trimStart().split(/\s/, 1)[0].toLowerCase())) {
    return "Start the prompt with words, not a command name like 'resume'."
  }
}

async function checkFields(entry, rt, env) {
  const { name, cron, repo, workspace, agent, prompt, timeout_minutes } = entry
  if (!validName(name)) return { problem: 'Enter a name of 1 to 64 characters without control characters or a leading dash.' }
  if (typeof cron !== 'string' || cron.trim() === '') return { problem: 'The schedule is not a valid cron expression.' }
  if (typeof agent !== 'string' || !Object.hasOwn(AGENT_COMMANDS, agent)) return { problem: 'Choose Claude Code or Codex.' }
  const problem = promptProblem(prompt, agent)
  if (problem) return { problem }
  if (rt.loginTextMatches?.(prompt) === true) return { problem: CODE_REFUSED }
  if (!directory(repo)) return { problem: 'Choose an absolute path to an existing folder.' }
  if (workspace !== 'worktree' && workspace !== 'root') return { problem: 'Choose where the automation runs.' }
  if (!Number.isSafeInteger(timeout_minutes) || timeout_minutes < 1) return { problem: 'Enter a positive whole number of minutes.' }
  if (workspace === 'worktree') {
    const git = ['/usr/bin', ...LOCAL_BINS].map(bin => join(bin, 'git')).find(executable)
    if (!git) return { problem: 'Could not check this folder: git was not found.' }
    // Check both conditions. rev-parse --verify HEAD also succeeds in a bare repository.
    const { GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, ...gitEnv } = env
    const gitOutput = await runScheduler(git, ['-C', repo, 'rev-parse', '--is-inside-work-tree', '--verify', 'HEAD'],
      { env: gitEnv, timeoutMs: 5000 }).catch(() => '')
    if (!/^true\r?\n/.test(gitOutput)) return { problem: 'Choose a Git work tree with at least one commit.' }
  }
  return { entry: { name, cron, repo, workspace, agent, prompt, timeout_minutes } }
}

export function install(rt, { env = process.env } = {}) {
  let pending = Promise.resolve()
  const enqueue = fn => {
    const next = pending.then(fn)
    pending = next.catch(() => {})
    return next
  }

  const endpoint = (name, fn, { read = false } = {}) => windowEndpoint(rt, name, async (body, _signal, windowSeen) => {
    if (!fromWindow(windowSeen)) return { reason: 'desktop-only' }
    try {
      return await (read ? fn(body) : enqueue(() => fn(body)))
    } catch (error) {
      // Only fixed failures leave this module. Child errors can carry argv and output.
      const reason = error?.cause
      return failure(Object.hasOwn(FAILURES, reason) ? reason : 'cli-error')
    }
  }, { read })

  const withScheduler = async (fn, invalidVersion) => {
    const path = resolveScheduler(env)
    if (!path) return { installed: false, ...failure('not-installed') }
    const run = (args, stdin) => runScheduler(path, args, { stdin, env })
    const version = (await run(['version'])).trim()
    if (!/^(?:dev|v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)$/.test(version) || version.length > 300) {
      if (invalidVersion) return invalidVersion
      throw cliFailure('cli-protocol')
    }
    return fn(run, version)
  }
  const readListing = async run => listingOf(await run(['ls', '--json']))

  const offList = endpoint('automations-list', () => withScheduler(async (run, version) => ({
    installed: true, ours: version.includes('-am.'), version, ...projectListing(await readListing(run), version, rt),
  })), { read: true })

  const offPut = endpoint('automations-put', async body => {
    if (!record(body)) return { problem: ONLY_NEW }
    const { entry, dryRun, original } = body
    const edit = Object.hasOwn(body, 'original')
    if (!record(entry) || Object.hasOwn(entry, 'original') || (edit && !record(original))
        || (dryRun !== undefined && typeof dryRun !== 'boolean')) return { problem: ONLY_NEW }
    if (edit && !validBinding(original)) return failure('changed')
    if (edit && !ENTRY_KEYS.every(key => Object.hasOwn(entry, key))) return failure('changed')
    const input = await checkFields(edit ? entry : { timeout_minutes: 60, ...entry }, rt, env)
    if (input.problem) return input
    const { name, agent } = input.entry
    return withScheduler(async (run, version) => {
      const argv = ['put']
      let wire = { ...input.entry, agent_args: [] }
      if (edit) {
        if (!keepsKeys(version)) return { problem: EDIT_VERSION }
        const listing = await readListing(run)
        const match = bound(listing, original.name, original.rev)
        if (match.reason) return match
        if (!writeTargetKnown(listing)) return failure('changed')
        const { row } = match
        if (!editable(row, rt)) return failure('not-editable')
        if (agent !== row.agent) return { problem: 'The agent can be changed in the Herdr panel.' }
        const diff = EDIT_KEYS.filter(key => input.entry[key] !== row[key])
        if (!dryRun && name === row.name && diff.length === 0) return { next: [], unchanged: true }
        wire = { name, ...Object.fromEntries(diff.map(key => [key, input.entry[key]])) }
        argv.push('--original', original.name)
      }
      if (dryRun) argv.push('--dry-run')
      // The CLI has no compare-and-write verb. An external writer can race this call.
      return putResult(await run(argv, JSON.stringify(wire)), name)
    }, edit ? { problem: EDIT_VERSION } : undefined)
  })

  const offHistory = endpoint('automations-history', body => {
    if (!exactKeys(body, ['name']) || !validName(body.name)) return failure('changed')
    return withScheduler(async run => {
      const rows = parseJSON(await run(['history', body.name, '--json']))
      if (!Array.isArray(rows)) throw cliFailure('cli-protocol')
      return { runs: rows.filter(row => record(row) && row.automation === body.name).slice(0, 20).map(projectRun) }
    })
  }, { read: true })

  const offEntry = endpoint('automations-entry', body => {
    if (!validBinding(body)) return failure('changed')
    return withScheduler(async (run, version) => {
      const listing = await readListing(run)
      const match = bound(listing, body.name, body.rev)
      if (match.reason) return match
      const { row } = match
      if (!writeTargetKnown(listing) || !keepsKeys(version) || !editable(row, rt)) return failure('not-editable')
      return {
        entry: Object.fromEntries(ENTRY_KEYS.map(key => [key, row[key]])),
        ownArgs: (Array.isArray(row.agent_args) && row.agent_args.length > 0) || nonempty(row.mcp_config),
      }
    })
  }, { read: true })

  const offRun = endpoint('automations-run', body => {
    if (!validBinding(body)) return failure('changed')
    return withScheduler(async run => {
      const match = bound(await readListing(run), body.name, body.rev)
      if (match.reason) return match
      await run(['run', body.name, '--bg'])
      return { requested: true }
    })
  })

  const offPause = endpoint('automations-pause', body => {
    if (!validBinding(body, ['name', 'rev', 'paused']) || typeof body.paused !== 'boolean') return failure('changed')
    return withScheduler(async run => {
      const listing = await readListing(run)
      const match = bound(listing, body.name, body.rev)
      if (match.reason) return match
      if (!writeTargetKnown(listing)) return failure('changed')
      await run([body.paused ? 'pause' : 'resume', body.name])
      return { done: true }
    })
  })

  const offRemove = endpoint('automations-remove', ({ name, rev }) => {
    if (!validName(name) || !validRevision(rev)) return failure('changed')
    return withScheduler(async run => {
      const match = bound(await readListing(run), name, rev, { allowInvalid: true })
      if (match.reason) return match
      // The CLI has no compare-and-remove verb. An external writer can still race this call.
      await run(['rm', name])
      return { removed: true }
    })
  })

  return () => { offList(); offPut(); offHistory(); offEntry(); offRun(); offPause(); offRemove() }
}
