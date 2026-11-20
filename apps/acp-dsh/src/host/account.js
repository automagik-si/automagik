// Which account a CLI is signed in to (#869): read from the CLI's own status, for the consent
// record (consent.js) and for the DSH owner's confirm step. Never a token, a key or a credential
// file: Claude Code's `auth status --json` and Codex's app-server `account/read` name the
// account and nothing else is taken from them. The sign-in check itself (agents.js `signIn`)
// still reads nothing past `loggedIn`; this is a separate read, made only for a CLI that said it
// is signed in.
//
// The answer is { kind, id, facets, email?, org?, plan? } or undefined when the CLI does not say
// (an older CLI, a timeout, an output this module does not know). `kind` is `account` (a
// person's sign-in), `key` (an API key or another provider in the environment) or `token` (a
// subscription token in the environment, such as CLAUDE_CODE_OAUTH_TOKEN: a person's plan, not
// an API key, but the CLI names nobody). For `key` and `token` there is no person to name, so
// only the source is told apart: another key or token from the same source reads as the same
// account, a known limit. `email`, `org` and `plan` are what
// the owner's confirm step shows. `facets` is what the consent record digests, one value per
// thing that names the account ({ kind, email?, org?, source? }): two reads are another account
// only when a facet both of them have differs, so a CLI release that starts or stops printing a
// field never reads as a change of account. `id` joins them, to name one read (the card's `ref`).
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { delimiter, dirname } from 'node:path'
import { batchSafe } from './batch-spawn.js'
import { claudeReservation, codexReservation } from './reservation-evidence.js'

export const ACCOUNT_TIMEOUT_MS = 8000
const OUTPUT_LIMIT = 256 * 1024

// One shown value: a single line, no control characters, bounded.
const clean = (value, max = 120) => {
  if (typeof value !== 'string') return undefined
  const text = [...value].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim().slice(0, max)
  return text === '' ? undefined : text
}

/** The account in Claude Code's `auth status --json` output, or undefined. */
export function claudeAccount(stdout) {
  let seen
  try { seen = JSON.parse(stdout) } catch { return undefined }
  if (seen === null || typeof seen !== 'object' || Array.isArray(seen) || seen.loggedIn !== true) return undefined
  const email = clean(seen.email, 254)
  const orgId = clean(seen.orgId)
  const org = clean(seen.orgName)
  const plan = clean(seen.subscriptionType, 40)
  if (email !== undefined || orgId !== undefined) {
    const facets = { kind: 'account', ...(email ? { email: email.toLowerCase() } : {}), ...(orgId ? { org: orgId } : {}) }
    return { kind: 'account', id: ['claude', orgId ?? '', (email ?? '').toLowerCase()].join('\n'), facets, ...(email ? { email } : {}), ...(org ? { org } : {}), ...(plan ? { plan } : {}) }
  }
  // No person: a key or a token from the environment, or another provider (Bedrock, Vertex).
  const source = clean(seen.apiKeySource, 80)
  const method = clean(seen.authMethod, 40)
  const provider = clean(seen.apiProvider, 40)
  const keyed = (what, value, kind = 'key') => ({ kind, id: ['claude', what, value].join('\n'), facets: { kind: 'key', source: `${what}:${value}` } })
  if (source !== undefined) return keyed('key', source)
  // A token is a subscription sign-in, never shown as an API key (accountView).
  if (method !== undefined && /key|token/i.test(method)) return keyed('key', method, /key/i.test(method) ? 'key' : 'token')
  if (provider !== undefined && provider !== 'firstParty') return keyed('provider', provider)
  return undefined
}

/** The account in the result of Codex's app-server `account/read`, or undefined. */
export function codexAccount(result) {
  const account = result?.account
  if (account === null || typeof account !== 'object' || Array.isArray(account)) return undefined
  if (account.type === 'apiKey') return { kind: 'key', id: ['codex', 'key'].join('\n'), facets: { kind: 'key' } }
  if (account.type !== 'chatgpt') return undefined
  const email = clean(account.email, 254)
  if (email === undefined) return undefined
  const plan = clean(account.planType, 40)
  return { kind: 'account', id: ['codex', 'chatgpt', email.toLowerCase()].join('\n'), facets: { kind: 'account', email: email.toLowerCase() }, email, ...(plan ? { plan } : {}) }
}

const cliEnv = (cli, env) => ({ ...env, PATH: [dirname(cli), env.PATH].filter(Boolean).join(delimiter), NO_COLOR: '1', DISABLE_UPDATES: '1' })

function readClaude(cli, { env, run, timeoutMs }) {
  return new Promise((done) => {
    try {
      // A signed-out CLI exits 1 and still prints its JSON: the output decides, not the code.
      run(...batchSafe(cli, ['auth', 'status', '--json'], {
        env: cliEnv(cli, env), cwd: env.AUTOMAGIK_BOT_CLI_HOME,
        timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true,
      }), (error, stdout) => {
        try {
          const output = String(stdout ?? '')
          done({ account: claudeAccount(output), evidence: error?.killed ? undefined : claudeReservation(output) })
        } catch { done(undefined) }
      })
    } catch {
      done(undefined)
    }
  })
}

// A short-lived app-server over stdio: initialize, then one `account/read` that refreshes
// nothing, then the process ends. Its stderr is never read (it may hold paths or diagnostics).
function readCodex(cli, { env, spawn, timeoutMs }) {
  return new Promise((done) => {
    let child
    let settled = false
    let buffer = ''
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child?.stdin?.end() } catch {}
      try { child?.kill('SIGTERM') } catch {}
      done(value)
    }
    try {
      child = spawn(...batchSafe(cli, ['app-server', '--listen', 'stdio://'], {
        env: cliEnv(cli, env), cwd: env.AUTOMAGIK_BOT_CLI_HOME,
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      }))
    } catch {
      return finish(undefined)
    }
    timer = setTimeout(() => finish(undefined), timeoutMs)
    timer.unref?.()
    const send = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`, () => {}) } catch { finish(undefined) } }
    child.on('error', () => finish(undefined))
    child.on('close', () => finish(undefined))
    child.stdin.on('error', () => finish(undefined))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (settled) return
      buffer += chunk
      if (buffer.length > OUTPUT_LIMIT) return finish(undefined)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message === null || typeof message !== 'object') continue
        if (message.id === 1) {
          if (message.error) return finish(undefined)
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/read', params: { refreshToken: false } })
        } else if (message.id === 2) {
          if (message.error) return finish(undefined)
          const result = message.result
          const answered = result && (Object.hasOwn(result, 'account') || typeof result.requiresOpenaiAuth === 'boolean')
          return finish({ account: codexAccount(result), evidence: answered ? codexReservation(result) : undefined })
        }
      }
      return undefined
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'automagik-cli-account', version: '1' }, capabilities: { experimentalApi: false } } })
    return undefined
  })
}

const READERS = { claude: readClaude, codex: readCodex }

/**
 * The account `spec`'s CLI is signed in to, as the CLI itself says, or undefined when it does
 * not say. Never throws and never rejects. Runs no agent turn and starts no sign-in.
 * @param {{ key: string }} spec an entry of AGENTS
 * @param {string | undefined} cli
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof execFile, spawn?: typeof spawnProcess, timeoutMs?: number }} [options]
 */
export async function accountOf(spec, cli, options) {
  return (await accountEvidenceOf(spec, cli, options)).account
}

/** The consent account and private reservation evidence from one vendor answer. */
export async function accountEvidenceOf(spec, cli, { env = process.env, run = execFile, spawn = spawnProcess, timeoutMs = ACCOUNT_TIMEOUT_MS } = {}) {
  const read = Object.hasOwn(READERS, spec?.key) ? READERS[spec.key] : undefined
  if (read !== undefined && typeof cli === 'string' && cli !== '') {
    const answer = await read(cli, { env, run, spawn, timeoutMs }).catch(() => undefined)
    if (answer !== undefined) return answer
  }
  return { account: undefined, evidence: undefined }
}

/**
 * What the owner's confirm step may show of an account: never its `id` or `facets`. A token
 * shows as a sign-in whose account the CLI does not say.
 */
export function accountView(account) {
  if (account === undefined || account === null) return undefined
  return {
    kind: account.kind === 'key' ? 'key' : 'account',
    ...(account.email ? { email: account.email } : {}),
    ...(account.org ? { org: account.org } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
  }
}
