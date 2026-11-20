import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CODE_REFUSED } from './cli-login.js'
import { fromWindow } from './desktop-window.js'
import { windowEndpoint } from './extend.js'

const LOCAL_BINS = ['/opt/homebrew/bin', '/usr/local/bin']
const AGENT_COMMANDS = {
  codex: new Set('exec e resume login logout mcp mcp-server app-server apply a completion debug sandbox cloud help proto generate-ts'.split(' ')),
  claude: new Set('config mcp migrate-installer setup-token doctor update install help'.split(' ')),
}
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
const validName = name => typeof name === 'string' && name.length <= 64 && name.trim() !== ''
  && !name.startsWith('-') && !/\p{Cc}/u.test(name)

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
  const names = rows => Array.isArray(rows) && rows.every(row => record(row) && typeof row.name === 'string')
  if (!record(raw) || typeof raw.paused !== 'boolean' || !Number.isInteger(raw.scheduler)
      || !names(raw.automations) || !names(raw.invalid)) throw cliFailure('cli-protocol')
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

export function projectListing(raw) {
  return {
    paused: raw.paused,
    schedulerRunning: raw.scheduler > 0,
    automations: raw.automations.map(row => ({
      ...identity(row),
      cron: text(row.cron), repo: text(row.repo), workspace: text(row.workspace),
      agent: text(row.agent), model: text(row.model), template: text(row.template),
      kind: row.command ? 'command' : row.workflow ? 'workflow' : 'prompt',
      hasTarget: Boolean(row.target), disabled: row.disabled === true, next: date(row.next),
      last: record(row.last) ? { status: text(row.last.status), at: date(row.last.at) } : null,
    })),
    invalid: raw.invalid.map(row => {
      const line = Number.isSafeInteger(row.line) && row.line > 0 ? row.line : 0
      return { ...identity(row), line, message: `This entry does not load. Fix it in the scheduler's file (line ${line}).` }
    }),
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

async function createEntry(body, rt, env) {
  const { entry, dryRun } = body
  if (!record(entry) || Object.hasOwn(body, 'original') || Object.hasOwn(entry, 'original')
      || (dryRun !== undefined && typeof dryRun !== 'boolean')) return { problem: 'Only new automations can be created here.' }
  const { name, cron, repo, workspace, agent, prompt, timeout_minutes = 60 } = entry
  if (!validName(name)) return { problem: 'Enter a name of 1 to 64 characters without control characters or a leading dash.' }
  if (typeof cron !== 'string' || cron.trim() === '') return { problem: 'The schedule is not a valid cron expression.' }
  if (typeof agent !== 'string' || !Object.hasOwn(AGENT_COMMANDS, agent)) return { problem: 'Choose Claude Code or Codex.' }
  if (typeof prompt !== 'string' || prompt.length > 8000 || !prompt.trim() || prompt.trimStart().startsWith('-')
      || /\p{Cc}/u.test(prompt.replace(/[\t\n]/g, ''))) {
    return { problem: 'Enter a prompt of up to 8,000 characters without control characters or a leading dash.' }
  }
  if (AGENT_COMMANDS[agent].has(prompt.trimStart().split(/\s/, 1)[0].toLowerCase())) {
    return { problem: "Start the prompt with words, not a command name like 'resume'." }
  }
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
  return { entry: { name, cron, repo, workspace, agent, prompt, timeout_minutes, agent_args: [] } }
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

  const withScheduler = async fn => {
    const path = resolveScheduler(env)
    if (!path) return { installed: false, ...failure('not-installed') }
    const run = (args, stdin) => runScheduler(path, args, { stdin, env })
    const version = (await run(['version'])).trim()
    if (!/^(?:dev|v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?)$/.test(version) || version.length > 300) throw cliFailure('cli-protocol')
    return fn(run, version)
  }
  const readListing = async run => listingOf(await run(['ls', '--json']))

  const offList = endpoint('automations-list', () => withScheduler(async (run, version) => ({
    installed: true, ours: version.includes('-am.'), version, ...projectListing(await readListing(run)),
  })), { read: true })

  const offPut = endpoint('automations-put', async body => {
    const input = await createEntry(body, rt, env)
    if (input.problem) return { problem: input.problem }
    return withScheduler(async run => putResult(await run(body.dryRun ? ['put', '--dry-run'] : ['put'], JSON.stringify(input.entry)), input.entry.name))
  })

  const offRemove = endpoint('automations-remove', ({ name, rev }) => {
    if (!validName(name) || typeof rev !== 'string' || !/^[0-9a-f]{16}$/.test(rev)) return failure('changed')
    return withScheduler(async run => {
      const { automations, invalid } = await readListing(run)
      const matches = [...automations, ...invalid].filter(row => row.name === name)
      if (matches.length === 0) return failure('gone')
      if (matches.length !== 1 || revision(matches[0]) !== rev) return failure('changed')
      // The CLI has no compare-and-remove verb. An external writer can still race this call.
      await run(['rm', name])
      return { removed: true }
    })
  })

  return () => { offList(); offPut(); offRemove() }
}
