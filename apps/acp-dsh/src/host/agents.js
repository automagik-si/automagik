// The agents this plugin offers and where they come from. Each runs the person's own CLI
// or a verified desktop-managed copy, through the newest release of its ACP adapter
// (installed in the background by install.js, never fetched when a Session starts).
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { delimiter, dirname, join } from 'node:path'
import { batchSafe } from './batch-spawn.js'

// Efforts as DSH lists them, from least to most.
const efforts = (...ids) => Object.freeze({ efforts: Object.freeze(ids.map(id => Object.freeze({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }))) })

export const CLAUDE_HARD_ASK = Object.freeze([
  'Bash(rm -r*)',
  'Bash(rm -R*)',
  'Bash(rm -fr*)',
  'Bash(rm -fR*)',
  'Bash(rm --recursive*)',
  'Bash(rm * -r*)',
  'Bash(rm * -R*)',
  'Bash(rm * -fr*)',
  'Bash(rm * -fR*)',
  'Bash(rm * --recursive*)',
  'Bash(find * -delete*)',
  'Bash(git push *--force*)',
  'Bash(git push -f*)',
  'Bash(git push * -f*)',
  'Bash(git push * +*)',
  'Bash(git push *--delete*)',
  'Bash(git push -d*)',
  'Bash(git push * -d*)',
  'Bash(git reset *--hard*)',
  'Bash(git clean *-*f*)',
  'Bash(terraform *destroy*)',
  'Bash(tofu *destroy*)',
  'Bash(pulumi *destroy*)',
  'Bash(cdk *destroy*)',
  'Bash(kubectl *delete*)',
  'Bash(helm *uninstall*)',
  'Bash(helm *delete*)',
  'Bash(docker *prune*)',
  'Bash(docker volume rm*)',
  'Bash(dropdb*)',
  'Bash(*DROP TABLE*)',
  'Bash(*drop table*)',
  'Bash(*DROP DATABASE*)',
  'Bash(*drop database*)',
  'Bash(*DROP SCHEMA*)',
  'Bash(*drop schema*)',
  'Bash(*TRUNCATE TABLE*)',
  'Bash(*truncate table*)',
  'Bash(*FLUSHALL*)',
  'Bash(*flushall*)',
  'Bash(*FLUSHDB*)',
  'Bash(*flushdb*)',
  'Bash(gh auth token*)',
  'Bash(* .env)',
  'Bash(*/.env)',
  'Bash(*.git-credentials*)',
  'Bash(*/.ssh/id_*)',
  'Bash(*aws/credentials*)',
  'Bash(security find-*-password*)',
  'Bash(printenv)',
  'Bash(printenv *TOKEN*)',
  'Bash(printenv *SECRET*)',
  'Bash(printenv *PASSWORD*)',
  'Bash(printenv *KEY*)',
  'Read(**/.env)',
  'Read(**/.git-credentials)',
  // Wildcards also ask for public id_*.pub keys; acceptable for this session-only rule.
  'Read(~/.ssh/id_*)',
  'Read(~/.ssh/*.pem)',
  'Read(~/.ssh/*.key)',
  'Read(~/.aws/credentials)',
  'Bash(sendmail*)',
  'Bash(mail *)',
  'Bash(gh issue comment*)',
  'Bash(gh pr comment*)',
  'Bash(gh pr create*)',
  'Bash(git push)',
  'Bash(git push origin)',
  'Bash(git push * main)',
  'Bash(git push * master)',
  'Bash(git push * dev)',
  'Bash(git push * develop)',
  'Bash(git push *:main*)',
  'Bash(git push *:master*)',
  'Bash(git push --all*)',
  'Bash(git push --mirror*)',
  ...(process.platform === 'win32' ? [
    'PowerShell(Remove-Item *-Recurse*)', 'PowerShell(git push *--force*)', 'PowerShell(git push * -f*)',
    'PowerShell(git reset *--hard*)', 'PowerShell(git clean *-*f*)',
  ] : []),
])

export const AGENTS = Object.freeze({
  'acp-claude': Object.freeze({
    // Explicit ask rules apply even in bypassPermissions, so never write them to a CLI home.
    // claude-agent-acp passes this session's settings to the SDK; lists merge with the person's
    // settings, and Bash rules check subcommands too, including in auto mode.
    hardAsk: () => ({ claudeCode: { options: { settings: { permissions: { ask: [...CLAUDE_HARD_ASK] } } } } }),
    // RFC 0031: asked only through acpAgents.ownMode.
    ownMode: 'auto',
    key: 'claude',
    name: 'Claude Code (ACP)',
    // The models and efforts come from the agent itself (catalog.js). Until it has answered once,
    // these stand in: names its adapter accepts and the efforts every one of them takes.
    defaultName: 'Claude Code',
    fallback: Object.freeze(['default', 'opus', 'sonnet', 'haiku'].map(id => Object.freeze({ id, name: id === 'default' ? 'Claude Code' : id.charAt(0).toUpperCase() + id.slice(1), reasoning: efforts('low', 'medium', 'high') }))),
    cli: 'claude',
    cliPackage: '@anthropic-ai/claude-code',
    // Where the person gets the CLI when it is not on this computer.
    installUrl: 'https://code.claude.com/docs/en/setup',
    // `claude auth status --json` answers { loggedIn } (and who: never read past loggedIn).
    signIn: Object.freeze({ args: ['auth', 'status', '--json'], read: ({ stdout }) => { try { const { loggedIn } = JSON.parse(stdout); return typeof loggedIn === 'boolean' ? loggedIn : undefined } catch { return undefined } } }),
    adapter: '@agentclientprotocol/claude-agent-acp',
    bin: 'dist/index.js',
    // The adapter's own Claude Agent SDK would run the CLI it bundles; this runs the person's.
    env: cli => ({ CLAUDE_CODE_EXECUTABLE: cli }),
    // DSH's level, as the agent's own permission mode, most wanted first. Manual is Claude
    // Code's `default` mode, whatever default mode the person's settings name. With `dshTools`
    // off, Claude Code still loads the person's own settings (allow rules, hooks) and asks DSH
    // only for what those leave as "ask". With it on, those rules still answer Claude Code's own
    // permission request and can never skip the bridge's DSH approval. DSH's Auto is Claude
    // Code's own auto mode, never bypassPermissions (RFC 0003, Retired). The last mode of each
    // list is the strict one: an agent that does not offer it fails the turn (acp.js setMode).
    modeFor: level => (level.full ? ['bypassPermissions', 'default'] : level.auto ? ['auto', 'default'] : ['default']),
    // With dshTools on: `_meta.disableBuiltInTools: true` leaves DSH's tools working and removes
    // the built-in file tools (and Bash, read from the adapter's bundle), so a structured call
    // that is not an MCP name is drift. A changed tool list is announced, not forked.
    disableBuiltInTools: true,
    // Claude Code reads images DSH's tools return over the bridge (read_image), so DSH must
    // see its models as taking image input.
    imageInput: true,
    drift: true,
    refresh: 'list',
  }),
  'acp-codex': Object.freeze({
    // RFC 0031: asked only through acpAgents.ownMode.
    ownMode: 'agent',
    key: 'codex',
    name: 'Codex (ACP)',
    defaultName: 'Codex',
    fallback: Object.freeze([Object.freeze({ id: 'default', name: 'Codex', reasoning: efforts('low', 'medium', 'high') })]),
    cli: 'codex',
    cliPackage: '@openai/codex',
    installUrl: 'https://developers.openai.com/codex/cli',
    // `codex login status` exits 0 when signed in, 1 when not.
    signIn: Object.freeze({ args: ['login', 'status'], read: ({ code }) => (code === 0 ? true : code === 1 ? false : undefined) }),
    adapter: '@agentclientprotocol/codex-acp',
    bin: 'dist/index.js',
    // CODEX_PATH wins over the Codex the adapter depends on (codex-acp startCodexConnection).
    env: cli => ({ CODEX_PATH: cli }),
    // index.js supplies the chat profile modes after writing the isolated home's profiles.
    // DSH's Auto is Codex's auto review. Most wanted first, the strict mode last (see above).
    modeFor: level => (level.full ? ['agent-full-access', 'workspace-write'] : level.auto ? ['agent', 'workspace-write'] : level.sandbox === 'read-only' ? ['read-only'] : ['workspace-write']),
    // codex-acp has no switch for its built-in tools, so they stay and are named in the turn;
    // it ignores `tools/list_changed` and a new server list on resume, so a changed tool set
    // arrives by fork (session/fork with the new servers, then session/close on the source).
    refresh: 'fork',
  }),
  // Agents whose CLI is itself an ACP server (#959): `launch` is how it starts (kind `native`,
  // the CLI with these arguments), and there is no adapter package, so nothing is installed for
  // them. With no `cliPackage`, Automagik never installs these CLIs either: one that is not on
  // this computer is shown with its install page. Their sign-in is the CLI's own, made in a
  // terminal (`signInHint`, the command a signed-out turn names); whether it holds is what the
  // agent's own ACP session says (catalog.js `signedIn`), since none of the three has a status
  // command that names one sign-in. They are off until the person turns one on, which is their
  // word that Automagik may use the sign-in that CLI has on this computer (index.js).
  //
  // Each is put in its own `default` mode, the one that asks, whatever DSH's level: what it asks
  // is answered by DSH's approval under the Session's level. Its own permission settings still
  // decide what it asks about. No bridge: DSH's tools reach none of them, even with `dshTools`
  // on, until that agent's tool naming is proven as Claude Code's was (adapter.js bridgeOn).
  'acp-hermes': Object.freeze({
    key: 'hermes',
    name: 'Hermes (ACP)',
    defaultName: 'Hermes',
    // Hermes names its models `provider:model`, from the providers the person set up: only its
    // own setting can stand in.
    fallback: Object.freeze([Object.freeze({ id: 'default', name: 'Hermes' })]),
    cli: 'hermes',
    installUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    // `hermes acp` (its help: "Run Hermes Agent as an ACP (Agent Client Protocol) server").
    launch: Object.freeze({ kind: 'native', args: Object.freeze(['acp']) }),
    // Its ACP `authMethods` names this terminal step (`hermes-setup`, args `--setup`).
    signInHint: 'hermes acp --setup',
    modeFor: () => ['default'],
  }),
  'acp-antigravity': Object.freeze({
    key: 'antigravity',
    name: 'Antigravity (ACP)',
    defaultName: 'Antigravity',
    fallback: Object.freeze([Object.freeze({ id: 'default', name: 'Antigravity', reasoning: efforts('low', 'medium', 'high') })]),
    cli: 'agy',
    installUrl: 'https://antigravity.google/docs',
    // `agy acp` (its help: "Start the Agent Client Protocol (ACP) stdio server").
    launch: Object.freeze({ kind: 'native', args: Object.freeze(['acp']) }),
    // `agy acp --login`: "Log in with Google interactively, then exit (ACP terminal auth)".
    signInHint: 'agy acp --login',
    modeFor: () => ['default'],
  }),
  'acp-omp': Object.freeze({
    key: 'omp',
    name: 'omp (ACP)',
    defaultName: 'omp',
    fallback: Object.freeze([Object.freeze({ id: 'default', name: 'omp' })]),
    cli: 'omp',
    installUrl: 'https://github.com/can1357/oh-my-pi',
    // `omp acp` (its help: "Run omp as an ACP (Agent Client Protocol) server over stdio").
    launch: Object.freeze({ kind: 'native', args: Object.freeze(['acp']) }),
    // `omp login`: "Log in to a model provider (terminal counterpart of /login)".
    signInHint: 'omp login',
    modeFor: () => ['default'],
  }),
})

/** Whether `spec`'s CLI is itself the ACP server: no adapter package, nothing to install. */
export const isNative = spec => spec?.launch?.kind === 'native'

/**
 * How an agent is started, of either kind: { command, args, env, ready, version?, key }.
 * `ready` is false while an adapter is not installed (a native agent is ready as soon as its
 * CLI is found); `key` names what would run, for the model catalog. The adapter kind runs
 * `node` on the installed adapter with the CLI in its environment; the native kind runs the CLI
 * itself, its own folder leading PATH so a CLI that is a script finds the runtime it was
 * installed with. A Windows batch file is handled where it is spawned (acp.js, batchSafe).
 * @param {object} spec an entry of AGENTS
 * @param {string} cli
 * @param {{ store?: any, node?: { command: string, env: object }, cliEnv?: object, env?: NodeJS.ProcessEnv, stamp?: (cli: string) => string }} [options]
 */
export function launchOf(spec, cli, { store, node = { command: process.execPath, env: {} }, cliEnv = {}, env = process.env, stamp = value => value } = {}) {
  if (isNative(spec)) {
    return { command: cli, args: [...spec.launch.args], env: { ...cliEnv, PATH: [dirname(cli), env.PATH].filter(Boolean).join(delimiter) }, ready: true, key: `native ${stamp(cli)}` }
  }
  const bin = store?.binOf(spec.adapter, spec.bin)
  if (bin === undefined) return { ready: false }
  return { command: node.command, args: [bin.path],
    env: { ...cliEnv, ...node.env, ...spec.env(cli) }, ready: true,
    version: bin.version, key: `${bin.path} ${stamp(cli)}` }
}

// Where the CLIs' own installers put them, for a DSH started from the desktop with a short PATH.
export function searchPath(env = process.env, home = homedir()) {
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean)
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]
  return [...new Set([...dirs, ...extra])]
}

/** Whether `path` is a file this user can run. */
export const isExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first executable named `name` on the search path, or undefined. */
export function findCommand(name, { env = process.env, home = homedir() } = {}) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of searchPath(env, home)) {
    for (const file of names) {
      const path = join(dir, file)
      if (isExecutable(path)) return path
    }
  }
  return undefined
}

export const SIGN_IN_TIMEOUT_MS = 8000

/**
 * Whether the person is signed in to `spec`'s CLI, as the CLI itself says: true, false, or
 * undefined when it cannot tell (an old CLI, a timeout). Runs no agent turn. The CLI's own
 * folder leads PATH, so a CLI that is a Node script finds the Node it was installed with.
 * `onUnknown` is told why a check that ran could not tell (#971): `timeout` when Node ended the
 * CLI at SIGN_IN_TIMEOUT_MS (however the CLI then exited), `unreadable` when it could not be
 * run or its answer was not one this reads. It is not called when there was nothing to check
 * (no CLI, no status command). The answer itself is what it always was.
 */
export function signedInOf(spec, cli, { env = process.env, run = execFile, onUnknown } = {}) {
  if (spec.signIn === undefined || cli === undefined) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const done = (answer, why) => {
      if (answer === undefined) try { onUnknown?.(why) } catch {}
      resolve(answer)
    }
    // The process as `run` hands it back: Node marks the one it ended (`killed`).
    let child
    try {
      // A CLI npm installed on Windows is a batch file (codex.cmd): through cmd.exe (batch-spawn.js).
      // DISABLE_UPDATES, as for --version (clis.js): a status check never updates the CLI itself.
      child = run(...batchSafe(cli, spec.signIn.args, {
        env: { ...env, PATH: [dirname(cli), env.PATH].filter(Boolean).join(delimiter),
          NO_COLOR: '1', DISABLE_UPDATES: '1' },
        cwd: env.AUTOMAGIK_BOT_CLI_HOME,
        timeout: SIGN_IN_TIMEOUT_MS, maxBuffer: 1 << 20, windowsHide: true,
      }), (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : undefined) : 0
        // Node ends a CLI still running at the timeout and says so (`killed`): on the error
        // when the CLI died of the signal or exited with a code of its own, and on the process
        // alone when the CLI caught the signal and exited 0. It also ends one that wrote too
        // much, which is not a timeout.
        const ended = error ? error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : child?.killed === true
        const why = ended ? 'timeout' : 'unreadable'
        if (error && code === undefined) return done(undefined, why)
        let answer
        try { answer = spec.signIn.read({ code, stdout: String(stdout ?? '') }) } catch {}
        done(answer, why)
      })
    } catch {
      done(undefined, 'unreadable')
    }
  })
}
