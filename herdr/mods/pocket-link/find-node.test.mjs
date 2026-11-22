// find-node.js against a fake machine: no real Node, shell or files are touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unitArg, xml } from './bridge/service-paths.js'
import { findNode, noNodeMessage, servicePath, servicePaths, version, newEnough, SHELL_PROBE } from './find-node.js'

const HOME = '/home/u'
const MOD = `${HOME}/.config/herdr-app/mods/pocket-link`

// nodes: path → what `--version` prints; files: path → text; dirs: dir → names;
// shell / path: what the login shell and Herdr's PATH say `command -v node` is.
function machine({ platform = 'darwin', nodes = {}, files = {}, dirs = {}, shell = '', path = '' } = {}) {
  const ran = []
  const io = {
    home: HOME,
    platform,
    mod: MOD,
    async exec(cmd, args) {
      ran.push(cmd)
      if (cmd === 'sh') {
        const out = args[1] === SHELL_PROBE ? shell : args[1] === 'command -v node' ? path : null
        if (out === null) throw new Error(`unexpected script ${args[1]}`)
        return { code: out ? 0 : 1, stdout: out, stderr: '' }
      }
      if (!(cmd in nodes)) throw new Error(`spawn ${cmd} ENOENT`)
      return { code: 0, stdout: `${nodes[cmd]}\n`, stderr: '' }
    },
    read: async p => files[p] ?? null,
    list: async d => dirs[d] ?? [],
  }
  return { io, ran }
}

const plist = node => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>dev.herdr.pocket-link</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${MOD}/bridge/bridge.mjs</string><string>serve</string></array>
</dict></plist>`

test('version and newEnough read node --version and folder names', () => {
  assert.deepEqual(version('v22.3.0\n'), [22, 3, 0])
  assert.deepEqual(version('20.3.0'), [20, 3, 0])
  assert.equal(version('node'), null)
  assert.equal(newEnough([20, 3, 0]), true)
  assert.equal(newEnough([20, 2, 9]), false)
  assert.equal(newEnough([9, 11, 2]), false)
  assert.equal(newEnough(null), false)
})

test('servicePath reads the LaunchAgent and the systemd unit', () => {
  assert.equal(servicePath(plist('/opt/n/bin/node')), '/opt/n/bin/node')
  assert.equal(servicePath('[Service]\nExecStart=/usr/bin/node /x/bridge.mjs serve\n'), '/usr/bin/node')
  assert.equal(servicePath(null), null)
  assert.equal(servicePath('ExecStart=node bridge.mjs'), null)
})

test('the LaunchAgent\'s Node comes first', async () => {
  const nvm = `${HOME}/.nvm/versions/node/v22.1.0/bin/node`
  const { io, ran } = machine({
    nodes: { [nvm]: 'v22.1.0', '/opt/homebrew/bin/node': 'v24.0.0' },
    files: { [`${HOME}/Library/LaunchAgents/dev.herdr.pocket-link.plist`]: plist(nvm) },
    shell: '/opt/homebrew/bin/node',
  })
  const r = await findNode(io)
  assert.equal(r.path, nvm)
  assert.equal(r.version, '22.1.0')
  assert.deepEqual(ran, [nvm], 'nothing else is run once the record answers')
})

test('Linux reads the systemd unit, then the recorded .node', async () => {
  const { io } = machine({
    platform: 'linux',
    nodes: { '/srv/node/bin/node': 'v20.3.0' },
    files: {
      [`${HOME}/.config/systemd/user/herdr-pocket-link.service`]: 'ExecStart=/gone/node /x serve\n',
      [`${MOD}/.node`]: '/srv/node/bin/node\n',
    },
  })
  const r = await findNode(io)
  assert.equal(r.path, '/srv/node/bin/node')
  assert.equal(r.from, 'the Node Pocket Link last started with')
})

test('a recorded Node that is too old falls through to the login shell', async () => {
  const { io } = machine({
    nodes: { '/usr/local/bin/node': 'v18.19.0', '/opt/homebrew/bin/node': 'v22.0.0' },
    files: { [`${HOME}/Library/LaunchAgents/dev.herdr.pocket-link.plist`]: plist('/usr/local/bin/node') },
    shell: 'Welcome back!\n/opt/homebrew/bin/node\n',
  })
  const r = await findNode(io)
  assert.equal(r.path, '/opt/homebrew/bin/node')
  assert.equal(r.from, "your login shell's PATH")
})

test('a shell that prints a function name or nothing is skipped', async () => {
  const volta = `${HOME}/.volta/bin/node`
  const { io } = machine({ nodes: { [volta]: 'v20.11.1' }, shell: 'node: aliased to nvm_node', path: '' })
  const r = await findNode(io)
  assert.equal(r.path, volta)
})

test('nvm: the newest version that is new enough, by number not by name', async () => {
  const dir = `${HOME}/.nvm/versions/node`
  const nodes = {}
  for (const v of ['v9.11.2', 'v18.20.0', 'v20.2.0', 'v20.10.0', 'v22.1.0']) nodes[`${dir}/${v}/bin/node`] = v
  const { io, ran } = machine({ nodes, dirs: { [dir]: ['v18.20.0', 'v20.10.0', 'v20.2.0', 'v22.1.0', 'v9.11.2', '.cache'] } })
  const r = await findNode(io)
  assert.equal(r.path, `${dir}/v22.1.0/bin/node`)
  assert.ok(!ran.includes(`${dir}/v9.11.2/bin/node`), 'too-old folders are not run')
})

test('nvm: a newest folder that does not run falls back to the next', async () => {
  const dir = `${HOME}/.nvm/versions/node`
  const { io } = machine({ nodes: { [`${dir}/v20.10.0/bin/node`]: 'v20.10.0' }, dirs: { [dir]: ['v22.1.0', 'v20.10.0'] } })
  assert.equal((await findNode(io)).path, `${dir}/v20.10.0/bin/node`)
})

test('fnm on macOS: its Application Support folder', async () => {
  const fnm = `${HOME}/Library/Application Support/fnm/node-versions`
  const node = `${fnm}/v22.4.0/installation/bin/node`
  const { io } = machine({ nodes: { [node]: 'v22.4.0' }, dirs: { [fnm]: ['v22.4.0'] } })
  assert.equal((await findNode(io)).path, node)
})

test('asdf, then Homebrew', async () => {
  const asdf = `${HOME}/.asdf/shims/node`
  assert.equal((await findNode(machine({ nodes: { [asdf]: 'v21.0.0', '/opt/homebrew/bin/node': 'v22.0.0' } }).io)).path, asdf)
  assert.equal((await findNode(machine({ nodes: { '/usr/local/bin/node': 'v22.0.0' } }).io)).path, '/usr/local/bin/node')
})

test('Herdr\'s PATH is used when the login shell has nothing', async () => {
  const { io } = machine({ platform: 'linux', nodes: { '/usr/bin/node': 'v20.19.0' }, path: '/usr/bin/node' })
  const r = await findNode(io)
  assert.equal(r.path, '/usr/bin/node')
  assert.equal(r.from, "Herdr's PATH")
})

test('no Node anywhere: every place is listed, with the too-old ones', async () => {
  const { io } = machine({ nodes: { '/usr/local/bin/node': 'v18.19.0' } })
  const r = await findNode(io)
  assert.equal(r.path, null)
  assert.deepEqual(r.checked.map(c => c.place), [
    'the login service',
    'the Node Pocket Link last started with',
    "your login shell's PATH",
    "Herdr's PATH",
    '~/.nvm/versions/node',
    '~/.volta/bin',
    '~/.local/share/fnm, ~/Library/Application Support/fnm',
    '~/.asdf/shims',
    '/opt/homebrew/bin, /usr/local/bin',
  ])
  const text = noNodeMessage(r.checked, HOME)
  assert.match(text, /couldn't find one/)
  assert.match(text, /~\/\.nvm\/versions\/node; ~\/\.volta\/bin/)
  assert.match(text, /Too old: \/usr\/local\/bin\/node is v18\.19\.0\./)
  assert.ok(!text.includes(HOME), 'the home folder shows as ~')
})

test('the message without a list still says what to do', () => {
  assert.match(noNodeMessage(null, HOME), /Install Node .* then open Pocket Link again\.$/)
})

// The real probe, run by the real sh (dash on Ubuntu, bash on macOS) with a fake login shell.
test('the login-shell probe answers fast, and kills a slow shell and its children at 3 s', { timeout: 15000 }, async () => {
  const { execFile } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(`${tmpdir()}/find-node-`)
  const shell = (name, body) => { writeFileSync(`${dir}/${name}`, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return `${dir}/${name}` }
  const probe = SHELL => new Promise(resolve => {
    const t = Date.now()
    execFile('sh', ['-c', SHELL_PROBE], { env: { ...process.env, SHELL, PIDFILE: `${dir}/child.pid` } }, (_e, stdout) => resolve({ stdout, ms: Date.now() - t }))
  })

  const fast = await probe(shell('fast', 'echo /fake/bin/node'))
  assert.equal(fast.stdout.trim(), '/fake/bin/node')
  assert.ok(fast.ms < 2000, `fast shell took ${fast.ms} ms`)

  // Ignores TERM, starts a child that would outlive it, and never answers.
  const slow = await probe(shell('slow', 'trap "" TERM\nsleep 20 &\necho $! > "$PIDFILE"\nwait\necho /late/node'))
  assert.equal(slow.stdout.trim(), '')
  assert.ok(slow.ms >= 2500 && slow.ms < 5000, `slow shell took ${slow.ms} ms`)
  const child = Number(readFileSync(`${dir}/child.pid`, 'utf8'))
  const alive = () => { try { process.kill(child, 0); return true } catch { return false } }
  for (let i = 0; i < 20 && alive(); i++) await new Promise(r => setTimeout(r, 50))
  assert.equal(alive(), false, 'the shell\'s child was killed with it')
})

test('the service Node, entry and state paths round-trip both managers', () => {
  const node = String.raw`/home/a & % $$ ' " \ node/bin/node`
  const entry = String.raw`/home/current & % $ \ entry/bridge.mjs`
  const state = String.raw`/home/state < > & % $$ " '\ pairings`
  const darwin = `<plist><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string><string>serve</string></array><key>POCKET_LINK_STATE_DIR</key><string>${xml(state)}</string></plist>`
  const linux = `ExecStart=${unitArg(node, true)} ${unitArg(entry, true)} serve\nEnvironment=${unitArg('POCKET_LINK_STATE_DIR=' + state)}\n`
  for (const body of [darwin, linux]) {
    assert.equal(servicePath(body), node)
    assert.deepEqual(servicePaths(body), { node, entry, state })
  }
})
