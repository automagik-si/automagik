// Missing-module evidence stays private and repairs only the connector folder that failed.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { apply } from '../index.js'
import { AgentRun } from '../src/host/acp.js'
import { AcpAdapter } from '../src/host/adapter.js'
import { Catalog } from '../src/host/catalog.js'

// A credential-shaped string, built at run time so no key-shaped literal sits in the source.
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-')
const FAKE = join(import.meta.dirname, '..', 'dev', 'fake-agent.mjs')
const sentence = ' Its connector looks damaged, so it is being reinstalled: send this again in a minute.'
function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'acp-repair-start-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}
function failingScript(dir, text) {
  const file = join(dir, 'broken.mjs')
  writeFileSync(file, `process.stderr.write(${JSON.stringify(text)}, () => process.exit(1))\n`)
  return file
}

for (const diagnostic of [
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'lost' imported from /adapters/pkg/1.0.0/dist/index.js",
  "Error: Cannot find module 'lost'\nRequire stack:\n- /adapters/pkg/1.0.0/dist/index.js\ncode: 'MODULE_NOT_FOUND'",
  'MODULE_NOT_FOUND\nRequire stack:\n- /adapters/pkg/1.0.0/dist/index.js',
  "Cannot find package 'lost' imported from /adapters/pkg/1.0.0/dist/index.js",
]) {
  test(`startup exit keeps bounded evidence for ${diagnostic.split('\n')[0]}`, async (t) => {
    const home = scratch(t)
    const text = `Node diagnostic\n${diagnostic}\n${'x'.repeat(2400)}\n}\n\nNode.js test\n`
    const script = failingScript(home, text)
    const run = new AgentRun({ name: 'Probe', command: process.execPath, args: [script], cwd: home })
    t.after(() => run.dispose())
    await assert.rejects(run.start(), (error) => {
      assert.match(error.message, /^Probe exited \(1\): }  Node.js test$/)
      assert.equal(error.missingModule.length, 2000)
      assert.match(error.missingModule, /^(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Cannot find package)/)
      assert.ok(error.missingModule.includes('/adapters/pkg/1.0.0'))
      assert.equal(error.message.includes('/adapters'), false)
      return true
    })
  })
}

test('an ordinary startup crash carries no missing-module evidence', async (t) => {
  const home = scratch(t)
  const run = new AgentRun({ name: 'Probe', command: process.execPath, args: [failingScript(home, 'TypeError: ordinary crash\n')], cwd: home })
  t.after(() => run.dispose())
  await assert.rejects(run.start(), error => error.missingModule === undefined && /ordinary crash/.test(error.message))
})

function turnHost(t, { rollback = false, repair = () => true, error } = {}) {
  const home = scratch(t)
  const broken = failingScript(home, "Error: Cannot find module 'lost'\nRequire stack:\n- /adapters/pkg/1.0.0/dist/index.js\n}\n\nNode.js test\n")
  const world = { back: false, repairs: [], rolled: [], warnings: [] }
  const dshAgent = { session: { id: 's1', header: { cwd: home } }, ctx: { tools: { register: () => () => {} } } }
  const ctx = { agents: { get: () => dshAgent }, get: () => undefined, logger: { warn: line => world.warnings.push(line) } }
  const agent = {
    name: 'Probe agent',
    catalog: new Catalog({ id: 'acp-probe', name: 'Probe agent', defaultName: 'Probe agent', fallback: [{ id: 'default', name: 'Probe agent' }], key: () => undefined, spawn: () => ({ command: process.execPath, args: [FAKE] }), log: () => {} }),
    spawn: () => {
      if (error) throw error
      return { command: process.execPath, args: [world.back ? FAKE : broken] }
    },
    rollback: reason => { world.rolled.push(reason); world.back = rollback; return rollback },
    repair: reason => { world.repairs.push(reason); return repair(reason) },
  }
  const adapter = new AcpAdapter(ctx, new Map([['acp-probe', agent]]), { dshTools: () => false })
  t.after(() => adapter.dispose())
  world.turn = async () => {
    const chunks = []
    for await (const chunk of adapter.stream(markAgentLoopRequest({ provider: 'acp-probe', model: 'default', sessionId: 's1', messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }] }))) chunks.push(chunk)
    return chunks
  }
  return world
}

test('a failed startup requests repair and adds exactly the promised sentence', async (t) => {
  const w = turnHost(t)
  const chunks = await w.turn()
  assert.equal(w.repairs.length, 1)
  assert.equal(w.rolled.length, 1)
  assert.ok(w.repairs[0].missingModule.includes('/adapters/pkg/1.0.0'))
  assert.equal(chunks.at(-1).reason.failure.message, `Probe agent did not start: ${w.repairs[0].message}${sentence}`)
  assert.equal(w.warnings.some(line => line.includes('/adapters/pkg')), false)
})

test('successful rollback takes priority and never requests repair', async (t) => {
  const w = turnHost(t, { rollback: true })
  const chunks = await w.turn()
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(w.rolled.length, 1)
  assert.deepEqual(w.repairs, [])
})

for (const repair of [() => false, () => { throw new Error('repair unavailable') }]) {
  test('a repair declined or throwing adds no promise to the failed turn', async (t) => {
    const w = turnHost(t, { repair })
    const chunks = await w.turn()
    assert.equal(w.repairs.length, 1)
    assert.equal(chunks.at(-1).reason.failure.message, `Probe agent did not start: ${w.repairs[0].message}`)
  })
}

for (const [code, message] of [
  ['acp_bridge_missing', 'missing bridge'],
  ['acp-account/busy', 'account busy'],
  ['acp_stopped', 'stopped'],
  ['acp_unanswered', 'unanswered'],
  [-32000, 'Authentication required'],
]) {
  test(`startup exclusion ${code} does not request repair`, async (t) => {
    const error = Object.assign(new Error(message), { code, missingModule: 'MODULE_NOT_FOUND /adapters/pkg/1.0.0', ms: 1000 })
    const w = turnHost(t, { error })
    await w.turn()
    assert.deepEqual(w.repairs, [])
    assert.deepEqual(w.rolled, [])
  })
}

function plugin(t, { legacy = false, windows = false } = {}) {
  const w = { repairs: [], updates: [], warnings: [], published: 0 }
  const base = windows ? 'C:\\adapters\\pkg\\1.0.0' : '/adapters/pkg/1.0.0'
  const entry = windows ? '\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js' : '/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
  w.installed = { path: base + entry, version: '1.0.0' }
  const store = {
    binOf: () => w.installed,
    update: async (...args) => { w.updates.push(args) },
    ...(legacy ? {} : { repair: async (...args) => { w.repairs.push(args); await w.wait; if (w.next) w.installed = w.next } }),
  }
  w.store = store
  const ctx = {
    llm: {
      registerAdapter: (ids, adapter) => {
        w.adapter = adapter
        const unregister = () => {}
        unregister.replace = () => { w.published++ }
        return unregister
      },
      listProviders: () => [],
    },
    agents: { get: () => undefined }, get: () => undefined,
    provide: (name, value) => { if (name === 'acpAgents') w.service = value },
    on: () => {}, effect: fn => { t.after(fn()) },
    logger: { warn: line => w.warnings.push(line), info: () => {} },
  }
  apply(ctx, { dshTools: false, hermes: true }, {
    store, find: name => ['claude', 'hermes'].includes(name) ? `/bin/${name}` : undefined,
    signedIn: async () => undefined,
  })
  w.agent = w.adapter.agents.get('acp-claude')
  return w
}

for (const windows of [false, true]) {
  test(`automatic repair requires the selected folder, once per release (${windows ? 'Windows' : 'POSIX'})`, async (t) => {
    const w = plugin(t, { windows })
    assert.equal(w.agent.repair(new Error('MODULE_NOT_FOUND')), false)
    assert.equal(w.agent.repair({ missingModule: 'Cannot find module in /external/cli' }), false)
    assert.equal(w.agent.repair({ missingModule: 'Cannot find module in /adapters/pkg/1.0.01/node_modules/x' }), false)
    const opposite = windows ? w.installed.path.replace(/\\/g, '/') : w.installed.path.replace(/\//g, '\\')
    const error = { missingModule: `Cannot find module 'lost'\nRequire stack:\n- ${opposite}` }
    assert.equal(w.agent.repair(error), true)
    assert.equal(w.agent.repair(error), false)
    assert.equal(w.repairs.length, 1)
    assert.equal(w.warnings.filter(line => line.includes('looks damaged')).length, 1)
    assert.equal(w.warnings.some(line => line.includes('Require stack')), false)
    assert.equal(w.adapter.agents.get('acp-hermes').repair, undefined)
    // A repaired folder of the same release that still fails is not reinstalled by every turn.
    w.installed = { ...w.installed, path: w.installed.path.replace('1.0.0', '1.0.0_r2000') }
    assert.equal(w.agent.repair({ missingModule: `Cannot find package 'x' imported from ${w.installed.path}` }), false)
    // Another release is repaired once again; ESM names the importing file on its own line.
    w.installed = { path: w.installed.path.replace('1.0.0_r2000', '1.1.0'), version: '1.1.0' }
    assert.equal(w.agent.repair({ missingModule: `ERR_MODULE_NOT_FOUND]: Cannot find package 'x' imported from ${w.installed.path}` }), true)
    assert.equal(w.repairs.length, 2)
  })
}

test('Retry reinstalls a connector whose start failed, and a changed path republishes it', async (t) => {
  const w = plugin(t)
  // Nothing failed: Retry (pressed for a CLI error, say) checks for a release as before.
  await w.service.retry('acp-claude')
  assert.equal(w.repairs.length, 0)
  assert.equal(w.updates.length, 1)
  // A start that failed with no evidence of damage starts no repair, but Retry then reinstalls.
  assert.equal(w.agent.repair(new Error('it exited (1)')), false)
  let finish
  w.wait = new Promise(resolve => { finish = resolve })
  const key = w.agent.catalog.spec.key()
  w.next = { ...w.installed, path: w.installed.path.replace('1.0.0', '1.0.0_r2000') }
  await w.service.retry('acp-claude')
  assert.equal(w.repairs.length, 1)
  assert.equal(w.published, 0)
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(w.published, 1)
  assert.notEqual(w.agent.catalog.spec.key(), key)
  // A repair that landed clears the failed start: the next Retry checks for a release again.
  await w.service.retry('acp-claude')
  assert.equal(w.repairs.length, 1)
  assert.equal(w.updates.length, 2)
  // Retry is not limited the way the automatic repair is: another failed start, another repair.
  w.agent.repair(new Error('it exited (1)'))
  await w.service.retry('acp-claude')
  assert.equal(w.repairs.length, 2)
  // A session that opened clears it too.
  await new Promise(resolve => setImmediate(resolve))
  w.agent.repair(new Error('it exited (1)'))
  w.agent.proven()
  await w.service.retry('acp-claude')
  assert.equal(w.repairs.length, 2)
  assert.equal(w.updates.length, 3)
})

test('the adapter folder in a stack frame alone is no evidence of damage', (t) => {
  const w = plugin(t)
  const frame = w.installed.path
  assert.equal(w.agent.repair({ missingModule: `Error: Cannot find module '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'\n    at Module._resolveFilename (node:internal)\n    at run (${frame}:10:3)` }), false)
  assert.equal(w.agent.repair({ missingModule: `Error: Cannot find module 'x'\nRequire stack:\n- /usr/lib/node_modules/other/index.js\n- ${frame}` }), false)
  assert.equal(w.repairs.length, 0)
})

test('Retry falls back to force update for an older store', async (t) => {
  const w = plugin(t, { legacy: true })
  w.agent.repair(new Error('it exited (1)'))
  await w.service.retry('acp-claude')
  assert.equal(w.updates.length, 1)
  assert.deepEqual(w.updates[0].slice(2), [{ force: true }])
})

test('a connector whose start failed says why in the status until a repair or a session clears it', async (t) => {
  const w = plugin(t)
  const connector = async () => (await w.service.status()).agents.find(agent => agent.id === 'acp-claude').connector
  assert.equal((await connector()).startError, undefined)
  w.agent.repair(new Error(`Claude exited (1): token ${FAKE_KEY}\nmore`))
  const failed = await connector()
  assert.equal(failed.state, 'ready')
  assert.match(failed.startError, /^Claude exited \(1\)/)
  assert.doesNotMatch(failed.startError, new RegExp(`${FAKE_KEY}|more`))
  // Retry reinstalls it; meanwhile the connector reads as installing, and a good repair clears it.
  let finish
  w.wait = new Promise(resolve => { finish = resolve })
  w.store.busy = () => true
  w.store.repairing = new Set(['@agentclientprotocol/claude-agent-acp'])
  await w.service.retry('acp-claude')
  assert.equal((await connector()).state, 'installing')
  w.store.busy = () => false
  w.store.repairing.clear()
  finish()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await connector()).startError, undefined)
  // A session that opened clears it too.
  w.agent.repair(new Error('it exited (1)'))
  w.agent.proven()
  assert.equal((await connector()).startError, undefined)
})
