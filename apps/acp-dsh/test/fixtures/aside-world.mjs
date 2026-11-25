import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, SERVICE } from '../../index.js'
import { AGY_OFF_CHECKED } from '../../src/host/agy-off.js'
import { nativeOffLaunch } from '../../src/host/codex-native.js'
import { CHECKED, fakeCodex } from './codex-native-world.js'

const wire = join(import.meta.dirname, 'fake-aside-agent.mjs')
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"

export function asideWorld(t, options = {}) {
  const { provider = 'acp-codex', start = CHECKED[0], version = AGY_OFF_CHECKED,
    system = false, transform, onEvent, reply = {}, permissionMode, confirm = true } = options
  const dir = mkdtempSync(join(tmpdir(), 'acp-test-aside-'))
  const traceFile = join(dir, 'trace.ndjson')
  const replyFile = join(dir, 'reply.json')
  const setReply = value => writeFileSync(replyFile, JSON.stringify(value))
  setReply(reply)
  const argv = [wire, traceFile, replyFile, version, permissionMode ??
    (provider === 'acp-codex' ? 'read-only' : 'default'), start, system ? 'on' : 'off']
  const fakeCli = join(dir, 'fake-cli')
  writeFileSync(fakeCli, '#!/bin/sh\nexec ' + [process.execPath, ...argv].map(shellQuote).join(' ')
    + ' "$@"\n', { mode: 0o700 })
  const lookups = []
  const handles = []
  const log = []
  let adapter
  let service
  const ctx = {
    llm: {
      listProviders: () => [],
      registerAdapter(routes, value) {
        adapter = value
        return Object.assign(() => {}, { replace() {} })
      },
    },
    get: () => undefined,
    on: () => () => {},
    emit: (...args) => onEvent?.(...args),
    effect: fn => handles.push(fn()),
    provide: (name, value) => { if (name === SERVICE) service = value },
    agents: { get: id => { lookups.push(id) }, list: () => [] },
    logger: { info: (...args) => log.push(args.join(' ')), warn: () => {} },
  }
  const providers = { 'acp-antigravity': 'agy', 'acp-omp': 'omp', 'acp-hermes': 'hermes',
    'acp-codex': 'codex', 'acp-claude': 'claude' }
  const config = { codex: false, claude: false,
    ...(providers[provider] === undefined ? {} : { [provider.slice(4)]: true }) }
  let signedIn = true
  const cliHome = join(dir, 'homes')
  apply(ctx, config, {
    catalogHome: join(dir, 'catalog'), cliHome, installation: dir,
    find: name => name === providers[provider] ? fakeCli : undefined,
    store: { binOf: () => ({ path: wire, version: 'test' }), stateOf: () => ({ version: 'test' }),
      busy: () => false, update: async () => {}, settle: () => {} },
    signedIn: async () => signedIn,
    account: async () => ({ id: 'fictitious-account', facets: { email: 'fixture@example.test' } }),
    logoutRun: (command, args, options, callback) => {
      signedIn = false
      queueMicrotask(() => callback(null, '', ''))
      return { once() {}, unref() {} }
    },
  })
  t.after(() => {
    for (const handle of handles.reverse()) handle?.()
    rmSync(dir, { recursive: true, force: true })
  })
  const cli = adapter?.agents.get(provider)
  const fake = fakeCodex()
  const contexts = []
  if (provider === 'acp-codex' && cli) {
    const spawn = cli.spawn
    cli.spawn = async (context) => {
      contexts.push(context)
      if (!context?.nativeOff) return spawn(context)
      const launch = await nativeOffLaunch({ command: process.execPath, args: argv,
        env: { CODEX_PATH: fakeCli, CODEX_HOME: join(dir, 'codex') } },
      { ...context, dir: join(dir, 'native-off'), run: fake.run })
      return transform?.(launch, context) ?? launch
    }
  }
  const events = () => (existsSync(traceFile)
    ? readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [])
  const ready = async () => {
    if (provider === 'acp-codex' && confirm) await service.accountConfirm(provider)
  }
  return { provider, service, ready, setReply, events, lookups, fake, contexts, log, dir, cli, ctx }
}
