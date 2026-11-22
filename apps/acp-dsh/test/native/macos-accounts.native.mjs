import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import * as inspector from 'node:inspector'
import net from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { debuglog } from 'node:util'

let phase = 'gate'
let assertions = 0
let scratch, terminal, realHome, kc, original, terminalVerified
let CLAUDE, CODEX, USER, service
let pendingBoundary, shimFailure, lastWrite, lastStore
let events = 0

const vendors = ['claude', 'codex']
const ids = { claude: 'acp-claude', codex: 'acp-codex' }
const botEnv = {}
const cleanups = []
const logouts = []
const planted = new Set()
const activeStores = new Set()
const selected = {}
const signInBaseline = {}
const terminalAccount = { email: 'terminal@example.test', plan: 'max', suffix: 'termT' }
const accounts = {
  A: { email: 'bot-a@example.test', plan: 'pro', suffix: 'botAA' },
  B: { email: 'bot-b@example.test', plan: 'team', suffix: 'botBB' },
}
const security = '/usr/bin/security'
const safePath = '/usr/bin:/bin'
const proxy = 'http://127.0.0.1:9'
const maxBuffer = 4 * 1024 * 1024
const defaultArgs = ['default-keychain', '-d', 'user']
const listArgs = ['list-keychains', '-d', 'user']
const noDefault = 'security: SecKeychainCopyDomainDefault user: A default keychain could not be found.'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const hex = size => randomBytes(size).toString('hex')
const json = value => JSON.stringify(value)
const readJson = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, json(value), { mode: 0o600 })
const mkdir = path => mkdirSync(path, { recursive: true, mode: 0o700 })
const codexKey = suffix => 'acp-native-' + hex(24) + suffix
const masked = key => key.slice(0, 8) + '***' + key.slice(-5)
const signedOutCodex = status => status.code === 1 && !status.killed && status.first === 'Not logged in'
const claudeService = dir => 'Claude Code-credentials' + (dir ? '-' + sha256(dir.normalize('NFC')).slice(0, 8) : '')
const codexAcct = home => 'cli|' + sha256(realpathSync(home)).slice(0, 16)
const itemKey = ({ svce, acct }) => svce + '\0' + acct
const currentCwd = env => env.AUTOMAGIK_BOT_CLI_HOME ?? terminal
const codexAuth = home => join(home, 'auth.json')
const claudeCredentials = dir => join(dir, '.credentials.json')
const claudeConfig = dir => join(dir, '.claude.json')
const botFile = vendor => vendor === 'claude'
  ? claudeCredentials(botEnv.claude.CLAUDE_CONFIG_DIR) : codexAuth(botEnv.codex.CODEX_HOME)
const terminalCodexHome = () => join(terminal, '.codex')
const terminalItem = vendor => vendor === 'claude'
  ? { svce: claudeService(), acct: USER }
  : { svce: 'Codex Auth', acct: codexAcct(terminalCodexHome()) }
const botItem = vendor => vendor === 'claude'
  ? { svce: claudeService(botEnv.claude.CLAUDE_SECURESTORAGE_CONFIG_DIR), acct: USER }
  : { svce: 'Codex Auth', acct: codexAcct(botEnv.codex.CODEX_HOME) }

function check(condition, message) {
  assert.ok(condition, message)
  assertions++
}

function safeError(error) {
  return error?.code === 'ERR_ASSERTION' && error.generatedMessage === false
    ? error.message : 'unexpected error'
}

async function step(name, operation) {
  phase = name
  await operation()
  console.log(name)
}

function run(file, args, { env, input, cwd, timeout = 20_000 } = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(file, args, { env, cwd, stdio: 'pipe' })
    } catch {
      resolve({ code: undefined })
      return
    }
    const stdout = [], stderr = []
    let outSize = 0, errSize = 0, killed = false
    const stop = () => {
      killed = true
      child.kill('SIGKILL')
    }
    const timer = setTimeout(stop, timeout)
    child.stdout.on('data', chunk => {
      outSize += chunk.length
      if (outSize > maxBuffer) stop()
      else stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      errSize += chunk.length
      if (errSize > maxBuffer) stop()
      else stderr.push(chunk)
    })
    child.stdin.on('error', () => {})
    child.once('error', () => {
      clearTimeout(timer)
      resolve({ code: undefined })
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ code, killed, stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString() })
    })
    child.stdin.end(input)
  })
}

function sec(args, { home, input }) {
  return run(security, args, {
    env: { HOME: home, USER, PATH: safePath, LANG: 'C' }, input, timeout: 10_000,
  })
}

function secInteractive(commands, home) {
  const lines = commands.map(([command, ...args]) => command + ' ' + args.map(arg => {
    check(!/["\\\r\n]/.test(arg), 'Invalid interactive security argument')
    return '"' + arg + '"'
  }).join(' '))
  return sec(['-i'], { home, input: lines.join('\n') + '\nquit\n' })
}

function stderrLines(text) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function domainPaths({ stdout }) {
  return stdout.split('\n').filter(Boolean).map(line => /^\s*"(\/[^"]+)"$/.exec(line)?.[1])
}

async function domainState(home) {
  const result = await sec(defaultArgs, { home })
  const paths = result.stdout === undefined ? [] : domainPaths(result)
  const absentDefault = result.stdout === '' && ((result.code === 0 && result.stderr === '')
    || (result.code === 1 && stderrLines(result.stderr).join('\n') === noDefault))
  const code = Number.isInteger(result.code) ? result.code : 'unknown'
  check(!result.killed && (absentDefault || (result.code === 0 && paths.length === 1 && paths[0])),
    `keychain domain read was not conclusive (exit ${code})`)
  const listed = await sec(listArgs, { home })
  const list = listed.code === 0 ? domainPaths(listed) : undefined
  check(!listed.killed && list?.every(Boolean), 'keychain search list was not conclusive')
  return { def: paths[0], list }
}

const finder = ({ svce, acct }) => ['-s', svce, '-a', acct]
const header = () => 'keychain: "' + kc + '"'

function itemCommand(command, item, flags = []) {
  check(terminalVerified && existsSync(kc), 'disposable keychain is not available')
  // A failed single-path open can cause security to search the default list.
  return sec([command, ...finder(item), ...flags, kc, kc], { home: terminal })
}

async function found(item) {
  const result = await itemCommand('find-generic-password', item)
  if (!result.killed && result.code === 0 && result.stdout.split('\n', 1)[0] === header()) return true
  check(!result.killed && result.code === 44 && result.stdout === '', 'keychain lookup was not conclusive')
  return false
}

async function absent(item, control = terminalItem('claude')) {
  check(!await found(item), 'Bot keychain item is still present')
  check(await found(control), 'terminal keychain control item is missing')
}

async function deleteItem(item) {
  const result = await itemCommand('delete-generic-password', item)
  check(result.code === 0 && !result.killed, 'disposable keychain item deletion failed')
}

async function records() {
  check(terminalVerified && existsSync(kc), 'disposable keychain is not available')
  const info = await sec(['show-keychain-info', kc], { home: terminal })
  check(info.code === 0 && !info.killed, 'disposable keychain is unavailable for inventory')
  const result = await sec(['dump-keychain', '-r', kc], { home: terminal })
  check(result.code === 0 && !result.killed, 'keychain dump failed')
  if (!result.stdout) return []
  const entries = result.stdout.split(/(?=^keychain: ")/m)
  const items = []
  for (const entry of entries) {
    const lines = entry.split('\n')
    check(lines[0] === header(), 'keychain dump reached another keychain')
    if (!lines.some(line => /^class:\s*"genp"$/.test(line))) continue
    const svce = /^\s*"svce"<blob>="([^"]+)"$/m.exec(entry)?.[1]
    const acct = /^\s*"acct"<blob>="([^"]+)"$/m.exec(entry)?.[1]
    check(svce && acct, 'keychain record has an unexpected service or account format')
    const index = lines.findIndex(line => /^\s*(raw )?data:\s*$/.test(line))
    check(index !== -1 && lines[index + 1]?.trim(), 'keychain record has no stored data')
    items.push({ svce, acct, digest: sha256(entry) })
  }
  return items
}

async function inventory() {
  return (await records()).map(itemKey).sort()
}

async function expectInventory(items, label) {
  check(json(await inventory()) === json(items.map(itemKey).sort()), 'keychain inventory differs at ' + label)
}

async function recordDigest(item) {
  const matches = (await records()).filter(record => itemKey(record) === itemKey(item))
  check(matches.length === 1, 'expected one stored keychain record')
  return matches[0].digest
}

async function secretDigest(item) {
  check(planted.has(itemKey(item)), 'secret digest requires a planted Claude item')
  const result = await itemCommand('find-generic-password', item, ['-w'])
  check(result.code === 0 && !result.killed && result.stdout.length > 0,
    'planted keychain item could not be read')
  return sha256(result.stdout)
}

function claudeJson(plan) {
  return { claudeAiOauth: {
    accessToken: 'acp-native-' + hex(24),
    expiresAt: Date.now() + 30 * 864e5,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: plan,
  } }
}

async function plantClaudeItem(item, plan) {
  check(terminalVerified && existsSync(kc), 'disposable keychain is not available')
  const { svce, acct } = item
  const payload = Buffer.from(json(claudeJson(plan))).toString('hex')
  await secInteractive([['add-generic-password', '-U', '-a', acct, '-s', svce, '-X', payload, kc]], terminal)
  check(await found(item), 'planted Claude item is missing')
  planted.add(itemKey(item))
}

function plantClaudeAccount(file, email) {
  const config = existsSync(file) ? readJson(file) : {}
  writeJson(file, { ...config, hasCompletedOnboarding: true,
    oauthAccount: { emailAddress: email, organizationUuid: randomUUID(), organizationName: 'Invented org' } })
}

function terminalEnv() {
  return { HOME: terminal, USER, LOGNAME: process.env.LOGNAME, TMPDIR: process.env.TMPDIR,
    LANG: 'C', PATH: process.env.PATH, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '' }
}

function cliEnv(env, cli) {
  check(typeof cli === 'string', 'vendor executable was not supplied')
  return { ...env, PATH: dirname(cli) + ':' + env.PATH, NO_COLOR: '1', DISABLE_UPDATES: '1' }
}

async function codexStatus(env) {
  const result = await run(CODEX, ['login', 'status'], { env: cliEnv(env, CODEX), cwd: currentCwd(env) })
  const first = result.stderr?.split('\n', 1)[0]
  return { code: result.code, killed: result.killed, first,
    masked: /^API key configured - (\S+)$/.exec(first)?.[1] }
}

async function claudeStatus(env) {
  const result = await run(CLAUDE, ['auth', 'status', '--json'], {
    env: cliEnv(env, CLAUDE), cwd: currentCwd(env),
  })
  let status
  try { status = JSON.parse(result.stdout) } catch {
    check(false, 'Claude status did not return JSON')
  }
  check(!result.killed && typeof status?.loggedIn === 'boolean', 'Claude status did not report sign-in')
  const { loggedIn, email, subscriptionType } = status
  return { loggedIn, email, subscriptionType }
}

function classifyLogout(lines) {
  if (lines.includes('Successfully logged out') && !lines.some(line => line.startsWith('Error'))) return 'logged-out'
  if (lines.some(line => line.startsWith('Error logging out: ') && line.includes('failed to delete auth from keyring'))) {
    return 'keyring-delete-error'
  }
  if (lines.includes('Not logged in')) return 'not-logged-in'
  return 'other'
}

function classifyStore(lines) {
  if (lines.some(line => line.startsWith('API key saved.')) && !lines.some(line => line.startsWith('Error'))) return 'saved'
  if (lines.some(line => line.startsWith('Error logging in: ') && line.includes('failed to write OAuth tokens to keyring'))) {
    return 'keyring-write-error'
  }
  if (lines.some(line => line.startsWith('Error loading configuration') || line.startsWith('Error parsing -c'))) {
    return 'config-error'
  }
  return 'other'
}

function wrappedLogout(cli, args, options, done) {
  execFile(cli, args, { ...options, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
    logouts.push({ seq: ++events, vendor: cli === CLAUDE ? 'claude' : 'codex', args: [...args],
      home: options.env.HOME, cwd: options.cwd, ok: !error,
      outcome: classifyLogout(stderrLines(String(stderr))) })
    done(error, stdout, stderr)
  })
}

function storeShim(cli, args, { env, cwd }) {
  const vendor = cli === CLAUDE ? 'claude' : 'codex'
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = child.signalCode = null
  const close = code => {
    if (child.exitCode !== null) return
    child.exitCode = code
    queueMicrotask(() => child.emit('close', code))
  }
  child.kill = () => close(0)

  async function store() {
    const captured = botEnv[vendor]
    const names = vendor === 'claude'
      ? ['HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] : ['HOME', 'CODEX_HOME']
    check(captured && names.every(name => env[name] && env[name] === captured[name])
      && cwd === env.AUTOMAGIK_BOT_CLI_HOME, 'sign-in did not use the captured Bot home')
    const hook = pendingBoundary
    pendingBoundary = undefined
    if (hook) {
      check(vendor === hook.vendor, 'switch boundary belongs to another vendor')
      await boundary(vendor, hook.round)
      hook.ran = ++events
    }
    const account = selected[vendor]
    check(account, 'sign-in store was called before selecting an account')
    check(child.exitCode === null, 'sign-in ended before the credential write')
    lastWrite = ++events
    signInBaseline[vendor] = logouts.length
    if (vendor === 'claude') {
      check(json(args) === json(['auth', 'login', '--claudeai']), 'unexpected Claude sign-in command')
      if (account.round === 'K') await plantClaudeItem(botItem(vendor), account.plan)
      else writeJson(claudeCredentials(env.CLAUDE_CONFIG_DIR), claudeJson(account.plan))
      plantClaudeAccount(claudeConfig(env.CLAUDE_CONFIG_DIR), account.email)
      return true
    }
    check(cli === CODEX && json(args) === json(['app-server', '--listen', 'stdio://']),
      'unexpected Codex sign-in command')
    const { code, killed, stderr } = await run(CODEX, ['login', '--with-api-key'], {
      env, cwd, input: account.key,
    })
    lastStore = { code, killed, outcome: stderr === undefined ? 'other' : classifyStore(stderrLines(stderr)) }
    return code === 0 && !killed
  }

  async function storeSafely() {
    try { return await store() } catch (error) {
      shimFailure = safeError(error)
      return false
    }
  }

  function beginStore() {
    const writing = storeSafely()
    activeStores.add(writing)
    void writing.then(() => activeStores.delete(writing))
    return writing
  }

  if (vendor === 'claude') {
    setImmediate(async () => close(await beginStore() ? 0 : 1))
  } else {
    const send = message => child.stdout.write(json(message) + '\n')
    const loginId = 'native-login'
    let buffer = ''
    child.stdin.setEncoding('utf8')
    child.stdin.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        try {
          const request = JSON.parse(line)
          if (request.method === 'initialize') send({ id: request.id, result: {} })
          if (request.method !== 'account/login/start') continue
          check(request.params?.type === 'chatgptDeviceCode', 'unexpected Codex login request')
          void beginStore().then(success => {
            send({ id: request.id, result: { type: 'chatgptDeviceCode', loginId,
              userCode: 'NATV-0001', verificationUrl: 'https://auth.openai.com/codex/device' } })
            send({ method: 'account/login/completed', params: { loginId, success } })
          }).catch(error => {
            shimFailure = safeError(error)
            close(1)
          })
        } catch (error) {
          shimFailure = safeError(error)
          close(1)
        }
      }
    })
  }
  return child
}

function createService({ apply, SERVICE, signedInOf, accountOf, HOME_ENV }) {
  const capture = (read, spec, cli, options) => {
    if (options.env[HOME_ENV]) botEnv[spec.key] = options.env
    return read(spec, cli, options)
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    agents: { list: () => [], get: () => ({ status: 'idle',
      ctx: { tools: { register: () => () => {} } }, session: { header: {} } }) },
    llm: { registerAdapter: () => () => {}, listProviders: () => [],
      listModels: () => new Promise(() => {}) },
    on() {}, get() {}, provide(name, value) { if (name === SERVICE) service = value },
    effect(setup) { cleanups.push(setup()) }, emit() {},
  }
  apply(ctx, {}, {
    store: { home: join(scratch, 'adapters'),
      binOf: () => ({ path: '/fake/adapter', version: '1' }), update: async () => {} },
    cliStore: undefined,
    find: name => ({ claude: CLAUDE, codex: CODEX })[name],
    cliHome: join(scratch, 'bot-root'), installation: join(scratch, 'dsh'),
    signedIn: (spec, cli, options) => capture(signedInOf, spec, cli, options),
    account: (spec, cli, options) => capture(accountOf, spec, cli, options),
    logoutRun: wrappedLogout, loginSpawn: storeShim,
  })
  check(service, 'acp-dsh account service was not provided')
}

async function waitFinal(id, view) {
  const deadline = performance.now() + 30_000
  do {
    const { status } = await service.loginStatus(id, view.attemptId)
    if (status === 'ready' || status === 'failed') return status
    await delay(100)
  } while (performance.now() < deadline)
  check(false, 'acp-dsh sign-in did not finish')
}

const terminalBaseline = {}

async function checkCodexStatus(env, key, message) {
  const status = await codexStatus(env)
  check(status.code === 0 && !status.killed && status.masked === masked(key), message)
}

async function terminalIntact(round) {
  const claude = terminalItem('claude')
  check(await secretDigest(claude) === terminalBaseline.claudeSecret, 'terminal Claude secret changed')
  check(await recordDigest(claude) === terminalBaseline.claudeRecord, 'terminal Claude keychain record changed')
  const status = await claudeStatus(terminalEnv())
  check(status.loggedIn && status.email === terminalAccount.email && status.subscriptionType === terminalAccount.plan,
    'terminal Claude status changed')
  if (service) {
    check((await service.terminalAccount(ids.claude))?.account?.email === terminalAccount.email,
      'acp-dsh terminal Claude account changed')
  }

  const auth = codexAuth(terminalCodexHome())
  if (round === 'K') {
    check(await recordDigest(terminalItem('codex')) === terminalBaseline.codexRecord,
      'terminal Codex keychain record changed')
    check(!existsSync(auth), 'terminal Codex wrote an unexpected auth.json')
  } else {
    check(existsSync(auth) && sha256(readFileSync(auth)) === terminalBaseline.codexFile,
      'terminal Codex auth.json changed')
  }
  await checkCodexStatus(terminalEnv(), terminalAccount.key, 'terminal Codex status changed')
}

function newLogout(vendor) {
  check(logouts.length === signInBaseline[vendor] + 1, 'expected exactly one logout since sign-in')
  const logout = logouts.at(-1)
  const home = botEnv[vendor].HOME
  const args = vendor === 'claude' ? ['auth', 'logout'] : ['logout']
  check(logout.vendor === vendor && json(logout.args) === json(args) && logout.home === home
    && logout.cwd === home, 'logout did not use the Bot command, home and working directory')
  return logout
}

async function boundary(vendor, round) {
  const logout = newLogout(vendor)
  check(logout.ok && (vendor === 'claude' || logout.outcome === 'logged-out'),
    'real CLI logout did not succeed')
  const file = botFile(vendor)
  if (round === 'K') {
    await absent(botItem(vendor))
    check(!existsSync(file), 'Bot has an unexpected plaintext store after logout')
  } else if (vendor === 'claude') {
    const config = claudeConfig(botEnv.claude.CLAUDE_CONFIG_DIR)
    check(!existsSync(file) || !readJson(file).claudeAiOauth?.accessToken, 'Bot Claude credential survived logout')
    check(!existsSync(config) || !Object.hasOwn(readJson(config), 'oauthAccount'), 'Bot Claude account survived logout')
  } else {
    check(!existsSync(file), 'Bot Codex auth.json survived logout')
  }
  const env = botEnv[vendor]
  const signedOut = vendor === 'claude' ? (await claudeStatus(env)).loggedIn === false
    : signedOutCodex(await codexStatus(env))
  check(signedOut, 'real CLI did not report the Bot signed out')
  await terminalIntact(round)
  if (round === 'K') await expectInventory([terminalItem('claude'), terminalItem('codex')], 'logout')
  else await expectInventory([terminalItem('claude')], 'logout')
}

async function login(vendor, round, label, { switching = false, expected = 'ready' } = {}) {
  selected[vendor] = { ...accounts[label], round }
  const beforeWrite = lastWrite ?? 0
  const id = ids[vendor]
  const hook = switching ? { vendor, round, ran: false } : undefined
  pendingBoundary = hook
  shimFailure = undefined
  lastStore = undefined
  const view = switching ? await service.accountSwitch(id, { label: 'native' }) : await service.loginStart(id)
  const status = await waitFinal(id, view)
  check(shimFailure === undefined, shimFailure ?? 'sign-in store failed')
  check(pendingBoundary === undefined, 'sign-in did not consume the switch boundary')
  check(status === expected, 'acp-dsh sign-in reached an unexpected state')
  check(lastWrite > beforeWrite, 'acp-dsh did not run the credential writer')
  if (hook) {
    const logout = logouts[signInBaseline[vendor] - 1]
    check(hook.ran !== false && logout?.seq < hook.ran && hook.ran < lastWrite,
      'switch did not verify logout before writing the next account')
  }
}

function checkSignedOutView(view, id) {
  check(json(view) === json({ id, signedIn: false, authScope: 'isolated' }),
    'acp-dsh did not confirm isolated sign-out')
}

async function signOut(vendor, round) {
  const id = ids[vendor]
  checkSignedOutView(await service.accountSignOut(id), id)
  await boundary(vendor, round)
}

function readCodexFile(file, key) {
  check(existsSync(file), 'expected Codex auth.json')
  const bytes = readFileSync(file)
  check(JSON.parse(bytes).OPENAI_API_KEY === key, 'Codex auth.json does not contain the selected key')
  return sha256(bytes)
}

async function checkBot(vendor, round, label) {
  const account = accounts[label]
  const env = botEnv[vendor]
  const file = botFile(vendor)
  let digest
  if (vendor === 'claude') {
    const status = await claudeStatus(env)
    check(status.loggedIn && status.email === account.email && status.subscriptionType === account.plan,
      'Bot Claude status did not identify the selected account and plan')
    check((await service.account(ids.claude, { fresh: true }))?.account?.email === account.email,
      'acp-dsh Bot Claude account did not identify the selected account')
    if (round === 'P') check(existsSync(file), 'Bot Claude credential file is missing')
  } else {
    await checkCodexStatus(env, account.key, 'Bot Codex status did not identify the selected key')
    if (round === 'P') {
      digest = readCodexFile(file, account.key)
      check((await service.account(ids.codex, { fresh: true }))?.account?.kind === 'key',
        'acp-dsh Bot Codex account did not report an API key')
    }
  }
  if (round === 'K') {
    const item = botItem(vendor)
    check(itemKey(item) !== itemKey(terminalItem(vendor)) && await found(item),
      'Bot does not have its own keychain item')
    digest = await recordDigest(item)
    check(!existsSync(file), 'Bot wrote an unexpected plaintext store')
    await expectInventory([terminalItem('claude'), terminalItem('codex'), item], 'Bot sign-in')
  } else {
    await expectInventory([terminalItem('claude')], 'Bot sign-in')
  }
  check(!existsSync(join(env.HOME, 'Library', 'Keychains')), 'Bot created another keychain directory')
  await terminalIntact(round)
  return digest
}

async function proveClaudeStoreRequired(round) {
  const file = botFile('claude')
  const env = botEnv.claude
  const item = botItem('claude')
  let bytes
  if (round === 'P') {
    bytes = readFileSync(file)
    rmSync(file)
    check(readJson(claudeConfig(env.CLAUDE_CONFIG_DIR)).oauthAccount?.emailAddress === accounts.A.email,
      'Bot Claude account metadata did not survive credential removal')
  } else {
    await deleteItem(item)
    await absent(item)
  }
  check((await claudeStatus(env)).loggedIn === false, 'Claude signed in without its Bot credential')
  await terminalIntact(round)
  if (round === 'P') {
    await expectInventory([terminalItem('claude')], 'Bot Claude credential removal')
    writeFileSync(file, bytes, { mode: 0o600 })
  } else {
    await expectInventory([terminalItem('claude'), terminalItem('codex')], 'Bot Claude item removal')
    await plantClaudeItem(item, accounts.A.plan)
  }
  const status = await claudeStatus(env)
  check(status.loggedIn && status.subscriptionType === accounts.A.plan,
    'Claude did not sign in after restoring its Bot credential')
  await terminalIntact(round)
  if (round === 'P') await expectInventory([terminalItem('claude')], 'Bot Claude credential restored')
  else await expectInventory([terminalItem('claude'), terminalItem('codex'), item], 'Bot Claude item restored')
}

async function exerciseVendor(vendor, round) {
  const keychain = round === 'K'
  const signInPhase = keychain ? 'bot A in its own keychain item, terminal T intact' : 'bot A, terminal T intact'
  let digestA
  await step(`${round}1 ${vendor}: ${signInPhase}`, async () => {
    await login(vendor, round, 'A')
    digestA = await checkBot(vendor, round, 'A')
  })
  if (vendor === 'claude') {
    const removal = keychain ? 'deleting only the Bot item' : 'removing only the Bot credential'
    await step(`${round}1c claude: ${removal} signs the Bot out`, async () => {
      await proveClaudeStoreRequired(round)
      if (keychain) digestA = await recordDigest(botItem(vendor))
    })
  }
  const switchPhase = keychain
    ? "switch to B through acp-dsh; A's item deleted before B is stored" : 'switch to B, A logged out first'
  await step(`${round}2 ${vendor}: ${switchPhase}`, async () => {
    await login(vendor, round, 'B', { switching: true })
    const digestB = await checkBot(vendor, round, 'B')
    if (digestA !== undefined) check(digestA !== digestB, 'Bot stored record did not change between A and B')
  })
  const logoutPhase = keychain ? "sign-out deletes only the Bot's item" : 'sign-out leaves the Bot signed out, terminal T intact'
  await step(`${round}3 ${vendor}: ${logoutPhase}`, () => signOut(vendor, round))
}

function codexConfig(home) {
  return join(home, 'config.toml')
}

function readConfig(home) {
  const file = codexConfig(home)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

function setCodexStore(home, mode, previous) {
  writeFileSync(codexConfig(home), `cli_auth_credentials_store = "${mode}"\n${previous ?? ''}`, { mode: 0o600 })
}

function restoreCodexConfig(home, previous) {
  if (previous === undefined) rmSync(codexConfig(home), { force: true })
  else writeFileSync(codexConfig(home), previous, { mode: 0o600 })
}

async function runPristineRound() {
  phase = 'P-env Bot has no default keychain'
  let pFailure
  for (const vendor of vendors) {
    const { def, list } = await domainState(botEnv[vendor].HOME)
    const primary = def ?? list[0]
    if (primary !== undefined && pFailure === undefined) {
      const kind = primary === original.def ? 'runner-login' : primary === kc ? 'disposable' : 'other'
      pFailure = `pristine Bot HOME reaches a keychain (${kind})`
    }
  }
  if (pFailure) {
    console.log('P skipped: ' + pFailure)
    return pFailure
  }
  console.log(phase)
  for (const vendor of vendors) await exerciseVendor(vendor, 'P')

  const home = botEnv.codex.CODEX_HOME
  const previous = readConfig(home)
  const auth = codexAuth(home)
  await step('P4 codex keyring fails in the pristine Bot HOME', async () => {
    setCodexStore(home, 'keyring', previous)
    await login('codex', 'P', 'A', { expected: 'failed' })
    check(lastStore?.code === 1 && !lastStore.killed && lastStore.outcome === 'keyring-write-error',
      'Codex did not fail with a keyring write error')
    check(!existsSync(auth), 'Codex keyring mode wrote an unexpected auth.json')
    await terminalIntact('P')
    await expectInventory([terminalItem('claude')], 'Codex keyring write failure')
  })
  await step('P5 codex auto: save falls back to the Bot file; sign-out outcome classified', async () => {
    setCodexStore(home, 'auto', previous)
    await login('codex', 'P', 'A')
    check(lastStore?.outcome === 'saved', 'Codex auto mode did not save the selected key')
    await checkCodexStatus(botEnv.codex, accounts.A.key, 'Bot Codex status did not identify the auto-mode key')
    readCodexFile(auth, accounts.A.key)
    await terminalIntact('P')
    await expectInventory([terminalItem('claude')], 'Codex auto save')

    let view, logoutError
    try { view = await service.accountSignOut(ids.codex) } catch (error) { logoutError = error }
    const logout = newLogout('codex')
    if (logout.ok && logout.outcome === 'logged-out') {
      check(!logoutError, 'acp-dsh rejected successful Codex auto-mode logout')
      checkSignedOutView(view, ids.codex)
      await boundary('codex', 'P')
      restoreCodexConfig(home, previous)
      console.log('P5 codex auto sign-out: auto-logout-ok')
    } else {
      check(!logout.ok && logout.outcome === 'keyring-delete-error' && logoutError?.code === 'acp-account/logout',
        'Codex auto-mode logout did not match either expected outcome')
      readCodexFile(auth, accounts.A.key)
      await terminalIntact('P')
      await expectInventory([terminalItem('claude')], 'Codex auto logout error')

      restoreCodexConfig(home, previous)
      const env = botEnv.codex
      const result = await run(CODEX, ['logout'], { env, cwd: currentCwd(env) })
      check(result.code === 0 && !result.killed && classifyLogout(stderrLines(result.stderr)) === 'logged-out'
        && !existsSync(auth), 'Codex file-mode logout could not clear the auto-mode credential')
      const before = logouts.length
      checkSignedOutView(await service.accountSignOut(ids.codex), ids.codex)
      check(logouts.length === before, 'acp-dsh invoked logout again after Codex was signed out')
      check(signedOutCodex(await codexStatus(botEnv.codex)), 'Codex did not stay signed out after recovery')
      await terminalIntact('P')
      await expectInventory([terminalItem('claude')], 'Codex file-mode logout')
      console.log('P5 codex auto sign-out: auto-logout-keyring-error')
    }
  })
  return undefined
}

const disposableDomain = () => ({ def: kc, list: [kc] })

async function bindKeychain(home) {
  mkdir(join(home, 'Library', 'Preferences'))
  const options = { home }
  const setDefault = await sec([...defaultArgs, '-s', kc], options)
  check(setDefault.code === 0 && !setDefault.killed, 'could not bind the disposable default keychain')
  const setList = await sec([...listArgs, '-s', kc], options)
  check(setList.code === 0 && !setList.killed, 'could not bind the disposable keychain search list')
  check(json(await domainState(home)) === json(disposableDomain()), 'scratch HOME does not see only its disposable keychain')
  check(json(await domainState(realHome)) === json(original), 'runner keychain settings were changed')
}

async function runKeychainRound() {
  await step('K-env Bot and terminal see the same disposable keychain', async () => {
    for (const vendor of vendors) {
      await bindKeychain(botEnv[vendor].HOME)
      const read = await run(security, defaultArgs, {
        env: { ...botEnv[vendor], PATH: safePath }, timeout: 10_000,
      })
      check(read.code === 0 && !read.killed && json(domainPaths(read)) === json([kc]),
        'captured Bot environment does not see the disposable keychain')
      await absent(botItem(vendor))
      check(!existsSync(botFile(vendor)), 'Bot has a plaintext credential before the keychain round')
    }
    check(json(await domainState(terminal)) === json(disposableDomain()), 'terminal keychain domain changed')
  })
  await step('K-terminal codex moves to keyring', async () => {
    const termHome = terminalCodexHome()
    const botHome = botEnv.codex.CODEX_HOME
    const termConfig = readConfig(termHome)
    const botConfig = readConfig(botHome)
    check(!termConfig?.includes('secret_auth_storage') && !botConfig?.includes('secret_auth_storage'),
      'unexpected Codex keyring backend configuration')
    setCodexStore(termHome, 'keyring', termConfig)
    const result = await run(CODEX, ['login', '--with-api-key'], {
      env: terminalEnv(), cwd: terminal, input: terminalAccount.key,
    })
    check(result.code === 0 && !result.killed, 'terminal Codex could not write to the keyring')
    check(!existsSync(codexAuth(termHome)), 'terminal Codex retained auth.json after switching to the keyring')
    await expectInventory([terminalItem('claude'), terminalItem('codex')], 'terminal Codex keyring save')
    terminalBaseline.codexRecord = await recordDigest(terminalItem('codex'))
    await terminalIntact('K')
    setCodexStore(botHome, 'keyring', botConfig)
  })
  for (const vendor of vendors) await exerciseVendor(vendor, 'K')
}

function verifyOffline() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '1.1.1.1', port: 443 })
    const finish = denied => {
      clearTimeout(timer)
      socket.destroy()
      resolve(denied)
    }
    const timer = setTimeout(() => finish(false), 5_000)
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish(error.code === 'EPERM'))
  })
}

function executable(file) {
  if (!file || !isAbsolute(file)) return false
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch { return false }
}

async function setup() {
  check(!debuglog('child_process').enabled && !debuglog('stream').enabled && inspector.url() === undefined,
    'Native credential-store checks require child tracing to be off')
  CLAUDE = process.env.ACP_NATIVE_CLAUDE
  CODEX = process.env.ACP_NATIVE_CODEX
  check(executable(CLAUDE) && executable(CODEX), 'Native Claude and Codex executables are required')
  const temp = realpathSync(tmpdir())
  check(process.env.AUTOMAGIK_HOME && realpathSync(process.env.AUTOMAGIK_HOME).startsWith(temp + sep),
    'Native checks require a scratch AUTOMAGIK_HOME from the test preload')

  scratch = realpathSync(mkdtempSync(join(temp, 'acp-macos-accounts-')))
  terminal = join(scratch, 'terminal')
  for (const dir of ['terminal', 'bot-root', 'adapters', 'dsh', 'keychains', 'fakebin']) mkdir(join(scratch, dir))
  const fakebin = join(scratch, 'fakebin')
  for (const name of ['open', 'osascript']) {
    writeFileSync(join(fakebin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  }
  const inherited = new Set(['USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'AUTOMAGIK_HOME', 'ACP_MACOS_NATIVE',
    'ACP_NATIVE_CLAUDE', 'ACP_NATIVE_CODEX'])
  for (const name of Object.keys(process.env)) {
    if (!inherited.has(name)) delete process.env[name]
  }
  Object.assign(process.env, { HOME: terminal, PATH: fakebin + ':/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C',
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '', DO_NOT_TRACK: '1' })
  USER = process.env.USER
  check(typeof USER === 'string' && /^[a-zA-Z0-9._-]+$/.test(USER), 'Invalid runner account name')
  check(await verifyOffline(), 'Outbound network must be denied by the seatbelt profile')

  const { readPins } = await import('./install-clis.mjs')
  const { cliVersion } = await import('../../src/host/clis.js')
  const pins = readPins()
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  const section = readme.split('**Credential stores on macOS (#869).**')[1]?.split('\n**')[0] ?? ''
  check(section.includes('Claude Code ' + pins.claude.version) && section.includes('Codex ' + pins.codex.version),
    'README credential-store versions differ from the native pins')
  check(await cliVersion(CLAUDE) === pins.claude.version && await cliVersion(CODEX) === pins.codex.version,
    'Native CLI versions differ from the pins')
  return pins
}

async function main() {
  check(process.platform === 'darwin' && process.env.ACP_MACOS_NATIVE === '1',
    'Native macOS credential-store checks require macOS and ACP_MACOS_NATIVE=1')
  let pins
  await step('S0 gate, tracing off, env allowlisted, outbound denied', async () => { pins = await setup() })
  const { apply, SERVICE } = await import('../../index.js')
  const { signedInOf, AGENTS } = await import('../../src/host/agents.js')
  const { accountOf } = await import('../../src/host/account.js')
  const { HOME_ENV } = await import('../../src/host/cli-homes.js')
  check(vendors.every(vendor => AGENTS[ids[vendor]]?.key === vendor), 'acp-dsh vendor IDs changed')

  await step('S1 runner keychain snapshot', async () => {
    realHome = userInfo().homedir
    original = await domainState(realHome)
  })
  await step('S2 disposable keychain', async () => {
    kc = join(scratch, 'keychains', 'acp-native.keychain-db')
    const password = hex(32)
    await secInteractive([['create-keychain', '-p', password, kc], ['unlock-keychain', '-p', password, kc]], terminal)
    const settings = await sec(['set-keychain-settings', kc], { home: terminal })
    const info = await sec(['show-keychain-info', kc], { home: terminal })
    check(existsSync(kc) && settings.code === 0 && !settings.killed && info.code === 0 && !info.killed,
      'disposable keychain setup failed')
  })
  await step('S3 terminal sees only the disposable keychain', async () => {
    await bindKeychain(terminal)
    check(existsSync(join(terminal, 'Library', 'Preferences', 'com.apple.security.plist')),
      'terminal keychain preferences were not written under terminal HOME')
    terminalVerified = true
  })

  terminalAccount.key = codexKey(terminalAccount.suffix)
  for (const account of Object.values(accounts)) account.key = codexKey(account.suffix)
  await step('S4 terminal T', async () => {
    const claude = terminalItem('claude')
    await plantClaudeItem(claude, terminalAccount.plan)
    plantClaudeAccount(claudeConfig(terminal), terminalAccount.email)
    const result = await run(CODEX, ['login', '--with-api-key'], {
      env: terminalEnv(), cwd: terminal, input: terminalAccount.key,
    })
    check(result.code === 0 && !result.killed, 'terminal Codex could not write auth.json')
    terminalBaseline.codexFile = readCodexFile(codexAuth(terminalCodexHome()), terminalAccount.key)
    check(!readConfig(terminalCodexHome())?.includes('secret_auth_storage'),
      'unexpected terminal Codex keyring backend configuration')
    await expectInventory([claude], 'terminal file-mode sign-in')
    terminalBaseline.claudeSecret = await secretDigest(claude)
    terminalBaseline.claudeRecord = await recordDigest(claude)
    await terminalIntact('P')
  })
  await step('S5 service', () => createService({ apply, SERVICE, signedInOf, accountOf, HOME_ENV }))
  await step('S5t terminal through acp-dsh', async () => {
    await terminalIntact('P')
    check((await service.terminalAccount(ids.codex))?.account?.kind === 'key',
      'acp-dsh terminal Codex account did not report an API key')
  })
  await step('E0 leak guard', async () => {
    process.env.CODEX_ACCESS_TOKEN = 'invented'
    process.env.ANTHROPIC_API_KEY = 'invented'
    try {
      for (const vendor of vendors) {
        check((await service.inspect(ids[vendor])).signedIn === false, 'Bot inherited terminal authentication')
      }
    } finally {
      delete process.env.CODEX_ACCESS_TOKEN
      delete process.env.ANTHROPIC_API_KEY
    }
    for (const vendor of vendors) {
      const env = botEnv[vendor]
      check(env?.HOME?.startsWith(join(scratch, 'bot-root') + sep) && env[HOME_ENV] === env.HOME,
        'acp-dsh did not supply an isolated Bot HOME')
      check(!existsSync(join(env.HOME, 'Library')), 'Bot HOME already has a Library directory')
    }
  })
  const pFailure = await runPristineRound()
  await runKeychainRound()
  phase = 'P-env Bot has no default keychain'
  check(!pFailure, pFailure ?? 'unexpected pristine Bot HOME result')
  return pins
}

async function cleanup() {
  const failures = []
  async function attempt(label, operation) {
    try { await operation() } catch (error) { failures.push(label + ': ' + safeError(error)) }
  }
  for (const dispose of cleanups) await attempt('service cleanup', dispose)
  if (cleanups.length) {
    await tick()
    await Promise.allSettled(activeStores)
  }

  if (kc) {
    let canDelete = false
    await attempt('disposable keychain verification', async () => {
      check(terminalVerified && dirname(kc) === join(scratch, 'keychains') && existsSync(kc)
        && json(await domainState(terminal)) === json(disposableDomain()),
      'keychain cleanup skipped because the terminal domain was not verified')
      canDelete = true
    })
    if (canDelete) {
      await attempt('terminal Codex cleanup', async () => {
        if (!existsSync(terminalCodexHome()) || !await found(terminalItem('codex'))) return
        const result = await run(CODEX, ['logout'], { env: terminalEnv(), cwd: terminal })
        check(result.code === 0 && !result.killed && !await found(terminalItem('codex')),
          'terminal Codex keyring logout failed during cleanup')
      })
      for (const identity of planted) {
        await attempt('planted Claude cleanup', async () => {
          const [svce, acct] = identity.split('\0')
          const item = { svce, acct }
          if (await found(item)) await deleteItem(item)
          check(!await found(item), 'planted Claude item survived cleanup')
        })
      }
      await attempt('keychain inventory cleanup', async () => {
        if (existsSync(kc)) await expectInventory([], 'cleanup')
      })
      await attempt('keychain file cleanup', async () => {
        const result = await sec(['delete-keychain', kc], { home: terminal })
        check(result.code === 0 && !result.killed && !existsSync(kc), 'disposable keychain deletion failed')
      })
    }
  }

  if (original) {
    await attempt('runner keychain verification', async () => {
      const current = await domainState(realHome)
      if (json(current) === json(original)) return
      const options = { home: realHome }
      await attempt('restore runner search list', async () => {
        const result = await sec([...listArgs, '-s', ...original.list], options)
        check(result.code === 0 && !result.killed, 'could not restore runner keychain search list')
      })
      if (original.def) {
        await attempt('restore runner default keychain', async () => {
          const result = await sec([...defaultArgs, '-s', original.def], options)
          check(result.code === 0 && !result.killed, 'could not restore runner default keychain')
        })
      } else if (current.def) {
        failures.push('runner default keychain was set and could not be unset')
      }
      let restored = false
      await attempt('verify runner keychain restore', async () => {
        restored = json(await domainState(realHome)) === json(original)
      })
      failures.push('runner keychain settings were changed' + (restored ? ' and restored' : ''))
    })
  }
  if (scratch) await attempt('scratch cleanup', () => rmSync(scratch, { recursive: true, force: true }))
  return failures
}

let verifiedPins
await main().then(pins => { verifiedPins = pins }).catch(error => {
  console.error(`macos-accounts: ${phase}: ${safeError(error)}`)
  process.exitCode = 1
}).finally(async () => {
  for (const failure of await cleanup()) {
    console.error('macos-accounts: cleanup: ' + failure)
    process.exitCode = 1
  }
}).catch(() => {
  console.error('macos-accounts: cleanup: unexpected error')
  process.exitCode = 1
})

if (verifiedPins && !process.exitCode) {
  console.log(`Native macOS credential-store checks passed (Claude Code ${verifiedPins.claude.version}, Codex ${verifiedPins.codex.version}): ${assertions} assertions.`)
}
