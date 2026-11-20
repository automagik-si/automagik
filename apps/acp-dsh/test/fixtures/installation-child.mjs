import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { apply, SERVICE } from '../../index.js'
import { POINTER_ENV } from '../../src/host/cli-generations.js'

const [shared] = process.argv.slice(2)
const store = { home: join(shared, 'acp', 'adapters'), binOf: () => undefined,
  update: async () => {} }
const ids = ['acp-claude', 'acp-codex']
const file = (vendor, env) => join(vendor === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME, 'fake-auth')
const vendorOf = cli => cli.endsWith('claude') ? 'claude' : 'codex'
const roots = {}
const cleanups = []
let service, nextAccount

function spawnLogin(cli, args, { env }) {
  const vendor = vendorOf(cli)
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = child.signalCode = null
  child.kill = () => {
    if (child.exitCode !== null) return
    child.exitCode = 0
    queueMicrotask(() => child.emit('close', 0))
  }
  const complete = () => writeFileSync(file(vendor, env), nextAccount)
  if (vendor === 'claude') {
    void setImmediate().then(() => { complete(); child.kill() })
  } else {
    const send = message => child.stdout.write(`${JSON.stringify(message)}\n`)
    child.stdin.on('data', line => {
      const request = JSON.parse(String(line))
      if (request.method === 'initialize') send({ id: request.id, result: {} })
      if (request.method === 'account/login/start') {
        complete()
        send({ id: request.id, result: { type: 'chatgptDeviceCode', loginId: 'fake-login',
          userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' } })
        send({ method: 'account/login/completed', params: { loginId: 'fake-login', success: true } })
      }
    })
  }
  return child
}

apply({
  llm: { registerAdapter: () => () => {}, listProviders: () => [] },
  agents: { list: () => [] },
  provide(name, value) { if (name === SERVICE) service = value },
  effect(setup) { cleanups.push(setup()) },
}, {}, {
  store,
  find: name => `/fake/${name}`,
  signedIn: async (spec, cli, { env }) => {
    roots[spec.key] = dirname(dirname(env[POINTER_ENV]))
    return existsSync(file(spec.key, env))
  },
  account: async (spec, cli, { env }) => {
    const auth = file(spec.key, env)
    if (!existsSync(auth)) return undefined
    const email = readFileSync(auth, 'utf8')
    return { kind: 'account', id: email, facets: { kind: 'account', email }, email }
  },
  loginSpawn: spawnLogin,
  logoutRun(cli, args, { env }, done) {
    rmSync(file(vendorOf(cli), env), { force: true })
    done(null)
  },
})

const read = id => service.account(id, { fresh: true })
async function handle({ action, id, email }) {
  if (action === 'ready') {
    for (const agent of ids) await read(agent)
    return { acpHome: dirname(store.home), roots }
  }
  if (action === 'read') return read(id)
  if (action === 'sign-out') return service.accountSignOut(id)
  nextAccount = email
  const attempt = await (action === 'login' ? service.loginStart(id) : service.accountSwitch(id))
  for (let i = 0; i < 30; i++) {
    await setImmediate()
    if (service.loginStatus(id, attempt.attemptId).status === 'ready') return read(id)
  }
  throw new Error('Fake sign-in did not finish')
}

process.on('message', async request => {
  try { process.send({ value: await handle(request) }) } catch (error) {
    process.send({ error: { message: error.message, code: error.code } })
  }
})
process.once('disconnect', () => { for (const cleanup of cleanups) cleanup() })
