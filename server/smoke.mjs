#!/usr/bin/env node
// Smoke the built server image: no network published, so the checks talk to the container the
// way an operator would. It proves the first start seeds /data and nothing was baked there,
// dsh serves the auth fence (401) on 127.0.0.1:3081, the token never reaches the log, the
// container runs as uid 1000, Docker's health check turns healthy, and a restart does not
// reseed the profile.
//
//   node server/smoke.mjs [automagik-server:local]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GATE_VIEW, GATE_VIEW_MOUNT, MEASUREMENT_MARKER, RUN_SECRETS_DIR } from './lib.mjs'
import { BOTS_GUARD_SINCE, compareRelease } from './profile-state.mjs'
import { herdrCoreSocket, SMOKE_HC_SESSION } from './toolchain.mjs'

const run = promisify(execFile)
const image = process.argv[2] || 'automagik-server:local'
const name = `automagik-server-smoke-${process.pid}`
const volume = `${name}-data`
const gateName = `${name}-gate`
const gateVolume = `${name}-gate-data`
const memberName = `${name}-member`
const memberData = `${name}-member-data`
const publicKeys = `${name}-caller-keys`
const signerData = `${name}-signer-data`
const runnerData = `${name}-runner`
const botFiles = `${name}-bot-files`
const START_TIMEOUT_MS = 240_000

const docker = async (args, options = {}) => {
  const { stdout, stderr } = await run('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
  return { stdout, stderr }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const say = (message) => console.log(`[smoke] ${message}`)

async function logsOf() {
  try {
    const { stdout, stderr } = await docker(['logs', name])
    return `${stdout}${stderr}`
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
}

async function healthCode() {
  try {
    const { stdout } = await docker(['exec', name, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs'])
    return stdout.trim()
  } catch (error) {
    return `${error.stdout ?? ''}`.trim() || '000'
  }
}

async function waitForFence() {
  const started = Date.now()
  while (Date.now() - started < START_TIMEOUT_MS) {
    const status = (await docker(['inspect', name, '--format', '{{.State.Status}}'])).stdout.trim()
    check(status === 'running', `container left running (${status})\n${await logsOf()}`)
    const code = await healthCode()
    if (code === '401') return Date.now() - started
    await sleep(500)
  }
  throw new Error(`no 401 within ${START_TIMEOUT_MS} ms\n${await logsOf()}`)
}

async function waitForHealthy() {
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    const status = (await docker(['inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}'])).stdout.trim()
    if (status === 'healthy') return status
    await sleep(1000)
  }
  throw new Error(`Docker's health check did not turn healthy\n${await logsOf()}`)
}

async function smokeMultiuser(content) {
  const runnerUid = 2200, runnerGid = 2201
  const env = {
    AUTOMAGIK_MULTIUSER: '1', AUTOMAGIK_CLI_INSTALL: 'off',
    AUTOMAGIK_CALLER_KEYS: '/caller-keys/caller-keys.json', AUTOMAGIK_INSTANCE_ID: 'member-smoke',
    AUTOMAGIK_BOT_RUNNER_SOCKET: '/bot-runner/socket/runner.sock', AUTOMAGIK_BOT_RUNNER_PROOFS: '/bot-runner/proofs',
    AUTOMAGIK_BOT_RUNNER_UID: String(runnerUid), AUTOMAGIK_BOT_RUNNER_GID: String(runnerGid),
    AUTOMAGIK_BOT_RUNNER_WORK_ROOT: '/bot-runner/work',
  }
  for (const volume of [memberData, publicKeys, signerData, runnerData, botFiles]) await docker(['volume', 'create', volume])
  await docker(['run', '--rm', '--network', 'none', '--user', '0:0',
    '--volume', `${runnerData}:/bot-runner`, '--volume', `${botFiles}:/bot-files`,
    '--entrypoint', '/nodejs/bin/node', image, '--input-type=module', '-e', `
      import fs from 'node:fs'
      import net from 'node:net'
      import { once } from 'node:events'
      const own = (path, uid, gid, mode) => { fs.chownSync(path, uid, gid); fs.chmodSync(path, mode) }
      own('/bot-runner', 0, 0, 0o755)
      for (const [dir, mode] of [['socket', 0o750], ['proofs', 0o1730], ['work', 0o711]]) {
        const path = '/bot-runner/' + dir
        fs.mkdirSync(path)
        own(path, ${runnerUid}, ${runnerGid}, mode)
      }
      own('/bot-files', 1000, 1000, 0o700)
      fs.mkdirSync('/bot-runner/work/nested')
      own('/bot-runner/work/nested', 1000, 1000, 0o700)
      // Leave an inert socket inode. Readiness only checks metadata and effective access.
      const socket = ${JSON.stringify(env.AUTOMAGIK_BOT_RUNNER_SOCKET)}
      const listener = net.createServer()
      listener.listen(socket + '.fixture')
      await once(listener, 'listening')
      fs.renameSync(socket + '.fixture', socket)
      own(socket, ${runnerUid}, ${runnerGid}, 0o660)
      await new Promise(resolve => listener.close(resolve))
    `])
  const wallPatch = `
- id: fs-sandbox
  disabled: true
- insert:
    - id: member-wall-fs
      name: '@automagik/bots-dsh/member-wall/fs'
      config:
        members: true
        bots: true
        membersRoot: /data/members
        principalsFile: /data/dsh/multiuser-dsh/principals.json
        botsRoot: /bot-files
        sharedReadRoots: [/data]
        denyReadRoots: [/data/dsh, /data/secrets, /data/gate-view, ${RUN_SECRETS_DIR}]
`
  const probePatch = `
- insert:
    - id: smoke-file-probe
      name: /data/dsh/smoke-file-probe.mjs
`
  const probe = `
    import { strict as assert } from 'node:assert'
    import { writeFileSync } from 'node:fs'
    import { createRequire } from 'node:module'
    import { dirname, join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    export const inject = ['fs']
    export async function apply(ctx) {
      const fs = ctx.fs
      const file = await fs.resolve('/data/dsh/smoke-file-canary')
      const read = () => fs.readText(file)
      assert.equal(await read(), 'owner canary')
      const require = createRequire('/data/dsh/profiles/automagik-web/package.json')
      const wall = require.resolve('@automagik/bots-dsh/member-wall/fs')
      const { sessionScope } = await import(pathToFileURL(join(dirname(wall), 'principals.js')).href)
      const scoped = () => sessionScope.run({ sessionId: 'smoke-scoped' }, read)
      const mode = process.env.AUTOMAGIK_MULTIUSER
      if (mode === '1') await assert.rejects(scoped, { code: 'FS_NOT_FOUND' })
      else assert.equal(await scoped(), 'owner canary')
      writeFileSync('/data/dsh/smoke-file-result', mode)
    }
  `
  const writePatch = patch => docker(['run', '--rm', '--network', 'none', '--volume', `${memberData}:/data`,
    '--entrypoint', '/nodejs/bin/node', image, '-e',
    `const fs = require('node:fs')
    fs.writeFileSync('/data/dsh/cordis.patch.yml', ${JSON.stringify(patch)})
    fs.writeFileSync('/data/dsh/smoke-file-probe.mjs', ${JSON.stringify(probe)})
    if (!fs.existsSync('/data/dsh/smoke-file-canary')) fs.writeFileSync('/data/dsh/smoke-file-canary', 'owner canary')
    fs.rmSync('/data/dsh/smoke-file-result', { force: true })`])
  const signer = `
    import { createSigner } from '/opt/automagik/gate-caller.mjs'
    const workspace = 'member-smoke'
    const signer = createSigner({ dir: '/data', publicDir: '/caller-keys', instance: () => workspace })
  `
  const helper = (network, code) => docker(['run', '--rm', '--network', network, '--user', '1000:1000',
    '--volume', `${signerData}:/data`, '--volume', `${publicKeys}:/caller-keys`,
    '--entrypoint', '/nodejs/bin/node', image, '--input-type=module', '-e', signer + code], { timeout: 30_000 })
  await helper('none', 'signer.publish()')
  const start = ({ omit, settings = {}, keys = true, nestedBind = false, group = true } = {}) => docker([
    'run', '--detach', '--name', memberName, '--network', 'none', '--volume', `${memberData}:/data`,
    ...(nestedBind ? ['--mount', `type=volume,source=${runnerData},target=/bot-files,volume-subpath=work/nested`] :
      ['--volume', `${botFiles}:/bot-files`]),
    ...(keys ? ['--volume', `${publicKeys}:/caller-keys:ro`] : []),
    '--volume', `${runnerData}:/bot-runner`,
    ...(group ? ['--group-add', String(runnerGid)] : []),
    ...Object.entries({ ...env, ...settings }).filter(([key]) => key !== omit).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--health-interval', '2s', '--health-timeout', '2s', '--health-retries', '60', '--health-start-period', '0s', image,
  ])
  const refuse = async (code, options, extraCode) => {
    await start(options)
    const result = await docker(['wait', memberName], { timeout: 30_000 })
    const { stdout, stderr } = await docker(['logs', memberName])
    const lines = stderr.split('\n').filter(line => line.includes('startup readiness failed'))
    const reasons = [code, ...(extraCode ? [`${extraCode}, ${code}`] : [])]
    check(result.stdout.trim() === '1' && lines.length === 1 &&
      reasons.some(reason => lines[0] === `automagik-web: multiuser is on, but startup readiness failed: ${reason}`) &&
      !/herdr-core|dsh web:|model key/.test(stdout + stderr),
    `multiuser did not refuse with ${code} before either child started\n${stdout}${stderr}`)
    await docker(['rm', memberName])
  }
  const waitForMemberHealth = async () => {
    const started = Date.now()
    while (true) {
      const status = (await docker(['inspect', memberName, '--format', '{{.State.Status}} {{.State.Health.Status}}'])).stdout.trim()
      if (status === 'running healthy') return
      check(status.startsWith('running ') && Date.now() - started < START_TIMEOUT_MS, 'member fixture did not become healthy')
      await sleep(500)
    }
  }
  const checkFileProbe = mode => docker(['exec', memberName, '/nodejs/bin/node', '-e', `
    const fs = require('node:fs')
    if (fs.readFileSync('/data/dsh/smoke-file-result', 'utf8') !== ${JSON.stringify(mode)}) process.exit(1)
  `])
  if (compareRelease(content, BOTS_GUARD_SINCE) < 0) {
    await writePatch(wallPatch)
    await refuse('bots-guard', undefined, 'member-wall-row')
    say(`multiuser: content ${content} refused before launch by the Bots command guard floor`)
    return
  }
  await writePatch(wallPatch + probePatch)
  await start()
  await waitForMemberHealth()
  await checkFileProbe('1')
  const report = JSON.parse((await docker(['exec', memberName, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs', '--json'])).stdout)
  check(report.healthy && report.multiuser?.healthy, 'multiuser report lacks the live carrier')
  await helper(`container:${memberName}`, `
    // The adapter rejects assertions from its first five seconds.
    await new Promise(resolve => setTimeout(resolve, 6000))
    const principal = { issuer: 'https://member.invalid', subject: 'member', roles: ['member'], workspace }
    const assertion = signer.sign({ principal, familyId: 'smoke', method: 'GET', path: '/' })
    const get = () => fetch('http://127.0.0.1:3081/_automagik/caller/', {
      headers: { 'x-automagik-caller': assertion }, redirect: 'manual', signal: AbortSignal.timeout(5000),
    })
    const index = await get()
    if (index.status !== 200 || index.headers.get('cache-control') !== 'no-cache' ||
        !index.headers.get('etag')) throw new Error('member-index')
    await index.body.cancel()
    const replay = await get()
    if (replay.status !== 401) throw new Error('member-replay')
    await replay.body.cancel()
  `)
  await docker(['rm', '--force', memberName])
  // Apply the documented rollback patch to the same populated volume.
  await writePatch(wallPatch + `
- id: member-wall-fs
  disabled: true
- id: fs-sandbox
  disabled: false
` + probePatch)
  await start({ settings: { AUTOMAGIK_MULTIUSER: '0' } })
  await waitForMemberHealth()
  await checkFileProbe('0')
  await docker(['rm', '--force', memberName])
  await writePatch(wallPatch)
  await refuse('caller-keys-config', { omit: 'AUTOMAGIK_CALLER_KEYS' })
  await refuse('caller-keys-mount', { keys: false })
  await refuse('instance-config', { settings: { AUTOMAGIK_INSTANCE_ID: ' ' } })
  await refuse('bot-runner-config', { omit: 'AUTOMAGIK_BOT_RUNNER_SOCKET' })
  const moveSocket = (from, to) => docker(['run', '--rm', '--network', 'none', '--user', '0:0',
    '--volume', `${runnerData}:/bot-runner`, '--entrypoint', '/nodejs/bin/node', image, '-e',
    `require('node:fs').renameSync(${JSON.stringify(from)}, ${JSON.stringify(to)})`])
  const socket = env.AUTOMAGIK_BOT_RUNNER_SOCKET
  await moveSocket(socket, socket + '.saved')
  await refuse('bot-runner-socket')
  await moveSocket(socket + '.saved', socket)
  await refuse('bot-runner-socket', { group: false })
  await refuse('bot-trees-disjoint', { settings: { AUTOMAGIK_BOT_RUNNER_WORK_ROOT: '/bot-files' } })
  await refuse('bot-trees-disjoint', { nestedBind: true })
  await writePatch('[]\n')
  await refuse('member-wall-row')
  say('multiuser: prerequisite refusals, scoped file denied, healthy carrier, member index cache policy, replay refused, owner file read after rollback')
}

async function main() {
  await docker(['image', 'inspect', image, '--format', '{{.Id}}'])

  // Nothing baked into /data: no profile, and the image runs as the non-root uid. Distroless
  // carries no coreutils, so the uid check is node's own.
  await docker(['run', '--rm', '--entrypoint', '/bin/bash', image, '-c', 'test ! -e /data/dsh/profiles'])
  await docker(['run', '--rm', '--entrypoint', '/bin/bash', image, '-c',
    'test ! -e /data/acp'])
  await docker(['run', '--rm', '--entrypoint', '/nodejs/bin/node', image, '-e', 'process.exit(process.getuid() === 1000 ? 0 : 1)'])
  await docker(['run', '--rm', '--entrypoint', '/nodejs/bin/node', image, '-e',
    'process.exit((require("node:fs").lstatSync("/data/dsh").mode & 0o7777) === 0o700 ? 0 : 1)'])
  // The gate view is not baked into /data either: DSH creates it at start (checked below).
  await docker(['run', '--rm', '--entrypoint', '/bin/bash', image, '-c', `test ! -e /data/${GATE_VIEW}`])

  await docker(['volume', 'create', volume])
  // First boot must prepare the profile and am without network access.
  await docker(['run', '--detach', '--name', name, '--network', 'none',
    '--env', `HC_SESSION=${SMOKE_HC_SESSION}`, '--env', 'AUTOMAGIK_CLI_INSTALL=off',
    '--volume', `${volume}:/data`,
    '--health-interval', '2s', '--health-timeout', '2s', '--health-retries', '60', '--health-start-period', '0s', image])

  const startTo401 = await waitForFence()
  await waitForHealthy()
  say(`401 after ${startTo401} ms; Docker health: healthy`)
  // DSH created the gate view before its first healthy check: its own 0700 folder.
  await docker(['exec', name, '/nodejs/bin/node', '-e', `
    const { mode, uid, gid } = require('node:fs').lstatSync('/data/${GATE_VIEW}')
    if ((mode & 0o7777) !== 0o700 || uid !== 1000 || gid !== 1000) process.exit(1)
  `])

  const logs = await logsOf()
  check(/automagik-web: startup: http:\/\/127\.0\.0\.1:3081\//.test(logs), 'no startup line')
  const socket = herdrCoreSocket(SMOKE_HC_SESSION)
  check(logs.includes(`automagik-web: herdr-core: serving on ${socket}`), `herdr-core did not start on ${socket}`)
  check(!/(?<![A-Za-z0-9_])token=(?!<redacted>)\S+/.test(logs), 'the launch token is in the log')
  check(/automagik-web: seeded \/data\/dsh\/profiles\/automagik-web/.test(logs), 'the first start did not seed the profile')
  check(!/gets no per-turn briefing/.test(logs), 'the first boot still warns about the briefing hook')
  check(/automagik-web: profile automagik-web: automagik \d+\.\d+\.\d+, dsh \d+\.\d+\.\d+/.test(logs), 'no version line')
  check(!/failed to import|ERR_MODULE_NOT_FOUND/.test(logs), 'a composed plugin failed to import')
  // The real token from the 0600 launch file must not be in the log, not merely a pattern.
  const launch = (await docker(['exec', name, '/nodejs/bin/node', '-e', 'process.stdout.write(require("fs").readFileSync("/data/dsh/launch-url","utf8"))'])).stdout.trim()
  const token = new URL(launch).searchParams.get('token')
  check(token && token.length >= 16, `launch-url carries no token: ${launch}`)
  check(!logs.includes(token), 'the real launch token is in the log')
  const report = JSON.parse((await docker(['exec', name, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs', '--json'])).stdout)
  check(report.schemaVersion === 1 && report.healthy && report.followsImage && report.reason === 'matching-image', 'fresh image report does not match installed plugins')
  check(Object.values(report.plugins).every(version => version === report.image.version), 'installed versions differ from the image report')
  check(!JSON.stringify(report).includes(token), 'health report contains the launch credential')

  await docker(['exec', name, '/bin/bash', '-c', 'test -f /data/dsh/profiles/automagik-web/package.json'])
  await docker(['exec', name, '/bin/bash', '-c', 'test -f /data/dsh/profiles/automagik-web/node_modules/@automagik/bots-dsh/package.json'])
  await docker(['exec', name, '/bin/bash', '-c', 'test -f /data/dsh/profiles/automagik-web/node_modules/@automagik/welcome-dsh/package.json'])
  await docker(['exec', name, '/bin/bash', '-c', 'test -f /data/dsh/profiles/automagik-web/node_modules/@automagik/acp-dsh/package.json'])
  await docker(['exec', name, '/bin/bash', '-c', 'test -f /data/dsh/profiles/automagik-web/node_modules/@automagik/multiuser-dsh/package.json'])
  await docker(['exec', name, '/bin/bash', '-c', 'test -f /data/dsh/launch-url'])
  const mode = (await docker(['exec', name, '/nodejs/bin/node', '-e', 'process.stdout.write((require("fs").statSync("/data/dsh/launch-url").mode & 0o777).toString(8))'])).stdout.trim()
  check(mode === '600', `launch-url is ${mode}, not 600`)
  const uid = (await docker(['exec', name, '/nodejs/bin/node', '-e', 'process.stdout.write(String(process.getuid()))'])).stdout.trim()
  check(uid === '1000', `runs as uid ${uid}, not 1000`)

  // The pruned runtime must still compose the whole automagik-web tree: the five bundles and
  // the entries DSH pulls in beside them, office-kit included.
  const config = (await docker(['exec', name, 'dsh', '--profile', 'automagik-web', '--dump-config'])).stdout
  const entries = (config.match(/^- id:/gm) ?? []).length
  check(entries >= 190, `composed only ${entries} entries`)
  // dsh-base is a bundle patch, not an entry: it shows only through the entries it adds.
  for (const plugin of ['@automagik/bots-dsh', '@automagik/welcome-dsh', '@automagik/acp-dsh', '@automagik/multiuser-dsh',
    '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-office-kit']) {
    check(config.includes(`name: '${plugin}'`) || config.includes(`name: "${plugin}"`), `${plugin} is not composed`)
  }
  say(`seeded profile, four plugins, 600 launch URL, uid 1000, ${entries} composed entries`)
  for (const line of logs.split('\n').filter((line) => /first boot:|am self install:/.test(line))) {
    say(line.replace(/^automagik-web: /, ''))
  }

  // The toolchain smoke checks the shipped commands, private socket, briefing and CLI store.
  let inImage
  try {
    inImage = (await docker(['exec', name, '/nodejs/bin/node', '/opt/automagik/in-image-smoke.mjs'])).stdout.trim()
  } catch (error) {
    // Capturing the shape is useless if the failed path hides it; print both streams first.
    for (const line of `${error.stdout ?? ''}${error.stderr ?? ''}`.split('\n').filter(Boolean)) {
      say(line.replace(/^\[in-image\] /, ''))
    }
    throw error
  }
  for (const line of inImage.split('\n').filter(Boolean)) say(line.replace(/^\[in-image\] /, ''))

  // The distroless base is older glibc than the builder: exercise both native modules.
  const native = "const k=require('/opt/automagik/runtime/node_modules/koffi');const p=require('/opt/automagik/runtime/node_modules/node-pty');const t=p.spawn('/bin/sh',['-c','echo native-ok'],{name:'xterm',cols:80,rows:24,cwd:'/tmp',env:process.env});let o='';t.onData((d)=>{o+=d});t.onExit(()=>process.exit(o.includes('native-ok')&&typeof k.version==='string'?0:1));setTimeout(()=>process.exit(1),5000)"
  await docker(['exec', name, '/nodejs/bin/node', '-e', native])
  say('native modules: koffi and node-pty load and spawn')

  // Omni verifies downloads itself, then uses tar (which invokes gzip) and find to
  // unpack Postgres/NATS. Exercise real extraction, including the tools' library closure.
  const extract = `
    const fs = await import('node:fs'), cp = await import('node:child_process');
    const { packPlugin } = await import('/opt/automagik/plugin-payload.mjs');
    const dir = fs.mkdtempSync('/tmp/installer-tools-');
    try {
      const source = dir + '/source', out = dir + '/out', archive = dir + '/payload.tgz';
      fs.mkdirSync(source); fs.mkdirSync(out); fs.writeFileSync(source + '/binary', 'verified-payload');
      fs.writeFileSync(archive, packPlugin(source));
      cp.execFileSync('tar', ['-xzf', archive, '-C', out]);
      const found = cp.execFileSync('find', [out, '-name', 'binary', '-type', 'f'], { encoding: 'utf8' }).trim();
      if (fs.readFileSync(found, 'utf8') !== 'verified-payload') throw new Error('installer extraction failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  `
  await docker(['exec', name, '/nodejs/bin/node', '--input-type=module', '-e', extract])
  say('installer tools: tar, gzip and find extract the expected payload')

  // A restart keeps the user's profile: the seed runs only where nothing is.
  await docker(['exec', name, '/nodejs/bin/node', '-e', 'require("node:fs").chmodSync("/data/dsh", 0o755)'])
  await docker(['restart', name])
  const restarted401 = await waitForFence()
  const after = await logsOf()
  check((after.match(/automagik-web: seeded /g) ?? []).length === 1, 'a restart reseeded the profile')
  check(/automagik-web: profile present at \/data\/dsh\/profiles\/automagik-web/.test(after), 'a restart did not find the profile')
  await docker(['exec', '--user', '2200:2200', name, '/nodejs/bin/node', '-e', `
    const assert = require('node:assert/strict'), fs = require('node:fs')
    assert.equal(fs.lstatSync('/data/dsh').mode & 0o7777, 0o700)
    assert.throws(() => fs.accessSync('/data/dsh/launch-url'), { code: 'EACCES' })
    const marker = JSON.parse(fs.readFileSync('/data/${MEASUREMENT_MARKER}', 'utf8'))
    assert.deepEqual(Object.keys(marker).sort(), ['packageSha256', 'release', 'version'])
    assert.match(marker.packageSha256, /^[a-f0-9]{64}$/)
  `])
  say(`restart: 401 after ${restarted401} ms, profile kept`)

  // Plant a saved model credential in DSH before starting the gate as the same uid.
  await docker(['exec', name, '/nodejs/bin/node', '-e', `
    const fs = require('node:fs')
    const path = require('node:path').join(process.env.DSH_HOME, '.credentials.yaml')
    if (fs.existsSync(path)) fs.renameSync(path, path + '.smoke-backup')
    fs.writeFileSync(path, 'deepseek: { apiKey: smoke-only }\\n', { mode: 0o600 })
    fs.accessSync(path, fs.constants.R_OK)
  `])

  // The opt-in gate shares the namespace, never its writable state. No public port.
  await docker(['volume', 'create', gateVolume])
  const viewMount = `type=volume,source=${volume},target=${GATE_VIEW_MOUNT},readonly`
  await docker(['run', '--detach', '--name', gateName, '--network', `container:${name}`,
    '--volume', `${gateVolume}:/data`,
    '--mount', `${viewMount},volume-subpath=${GATE_VIEW}`,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--env', 'AUTOMAGIK_GATE_ENABLED=1', '--env', 'AUTOMAGIK_GATE_ORIGIN=http://localhost:3082',
    '--health-interval', '2s', '--health-start-period', '0s',
    '--entrypoint', '/nodejs/bin/node', image, '/opt/automagik/gate-entrypoint.mjs'])
  const gateDeadline = Date.now() + 30_000
  let gateHealthy = false
  while (Date.now() < gateDeadline) {
    const status = (await docker(['inspect', gateName, '--format', '{{.State.Health.Status}}'])).stdout.trim()
    if (status === 'healthy') { gateHealthy = true; break }
    check((await docker(['inspect', gateName, '--format', '{{.State.Status}}'])).stdout.trim() === 'running', 'gate stopped')
    await sleep(200)
  }
  check(gateHealthy, 'gate health never reached healthy 401')
  const gateConfig = JSON.parse((await docker(['inspect', gateName])).stdout)[0]
  const dshConfig = JSON.parse((await docker(['inspect', name])).stdout)[0]
  check(gateConfig.HostConfig.NetworkMode === `container:${dshConfig.Id}`, 'gate does not share only the DSH network namespace')
  const dshMounts = gateConfig.Mounts.filter(m => m.Name === volume)
  check(dshMounts.length === 1, 'gate must mount the DSH volume exactly once')
  check(dshMounts[0].Destination === GATE_VIEW_MOUNT && !dshMounts[0].RW,
    'gate DSH view must be mounted read-only at /dsh-view')
  // The rest of the DSH volume stays out of the gate's reach: Pocket's chat socket exists in
  // DSH, and the gate (the same uid 1000) can neither see nor connect to it, nor read the key.
  await docker(['exec', name, '/bin/bash', '-c', 'test -S /data/bots/pocket/chat.sock'])
  await docker(['exec', gateName, '/nodejs/bin/node', '--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import net from 'node:net'
    assert.throws(() => fs.lstatSync('/dsh/dsh'), { code: 'ENOENT' })
    if (fs.existsSync('/dsh')) assert.deepEqual(fs.readdirSync('/dsh'), [])
    // DSH's health check rewrites profile-state.json through a temp file and a rename, so one
    // listing can catch that temp file: retry a few times; a lasting extra entry still fails.
    let files = []
    for (let tries = 0; tries < 10; tries += 1) {
      files = fs.readdirSync('${GATE_VIEW_MOUNT}').sort()
      if (files.length === 2) break
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    assert.deepEqual(files, ['launch-url', 'profile-state.json'])
    for (const file of files) {
      const info = fs.lstatSync('${GATE_VIEW_MOUNT}/' + file)
      assert.ok(info.isFile())
      assert.equal(info.mode & 0o7777, 0o600)
    }
    for (const root of ['/dsh', '/dsh/dsh', '${GATE_VIEW_MOUNT}', '/data', '/data/dsh']) {
      assert.throws(() => fs.readFileSync(root + '/.credentials.yaml'), { code: 'ENOENT' })
      await new Promise((resolve, reject) => {
        const socket = net.connect(root + '/bots/pocket/chat.sock')
        socket.on('connect', () => {
          socket.destroy()
          reject(new Error('gate reached the Pocket chat socket'))
        })
        socket.on('error', error => error.code === 'ENOENT' ? resolve() : reject(error))
      })
    }
  `])
  check(gateConfig.Mounts.some(m => m.Name === gateVolume && m.Destination === '/data' && m.RW), 'gate has no separate writable store')
  check(!dshConfig.Mounts.some(m => m.Name === gateVolume), 'DSH mounts the gate store')
  await docker(['exec', gateName, '/nodejs/bin/node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { DshCredentials } from '/opt/automagik/gate-upstream.mjs'
    fs.accessSync('${GATE_VIEW_MOUNT}/launch-url')
    fs.writeFileSync('/data/gate-only', 'private')
    assert.throws(() => fs.writeFileSync('${GATE_VIEW_MOUNT}/gate-write-probe', 'bad'),
      { code: 'EROFS' })
    const credentials = new DshCredentials()
    const cookie = await credentials.cookie()
    assert.equal((await credentials.request('/', { cookie })).statusCode, 200)
  `])
  await docker(['exec', name, '/nodejs/bin/node', '-e', 'const fs=require("fs");try{fs.readFileSync("/data/gate-only");process.exit(1)}catch(e){if(e.code!=="ENOENT")throw e}'])
  await docker(['exec', gateName, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs'])
  const gateReport = JSON.parse((await docker(['exec', gateName, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs', '--json'])).stdout)
  check(gateReport.healthy && gateReport.gate.enabled && gateReport.gate.status === 401 &&
    gateReport.dsh.status === 401 && gateReport.followsImage,
    'gate report did not inspect both fences and the read-only profile state')
  const claimCode = (await docker(['exec', gateName, '/nodejs/bin/node', '-e', 'const fs=require("fs");for(const p of ["/data/claim-code","/data/claim-state.json","/data/control.sock"]){if((fs.statSync(p).mode&0o777)!==0o600)process.exit(1)}process.stdout.write(fs.readFileSync("/data/claim-code","utf8").trim())'])).stdout.trim()
  check(/^[a-f0-9]{32}$/.test(claimCode), 'image claim code is not 128 bits')
  const gateLogs = await docker(['logs', gateName])
  check(!`${gateLogs.stdout}${gateLogs.stderr}`.includes(claimCode), 'image claim code reached the application log')
  const claimBoundary = 'const http=require("http"),fs=require("fs");const code=fs.readFileSync("/data/claim-code","utf8").trim();for(const port of [3082,3083])http.get({host:"127.0.0.1",port,path:"/_gate/claim",headers:{host:"localhost:3082"}},r=>{let text="";r.on("data",c=>text+=c);r.on("end",()=>{if(r.statusCode!==(port===3083?200:404)||text.includes(code)||(port===3083&&!text.includes("Claim with a passkey")))process.exit(1)})}).on("error",()=>process.exit(1))'
  await docker(['exec', gateName, '/nodejs/bin/node', '-e', claimBoundary])
  await docker(['exec', gateName, '/nodejs/bin/node', '/opt/automagik/gate-control.mjs', 'reset'])
  const resetCode = (await docker(['exec', gateName, '/nodejs/bin/node', '-e', 'process.stdout.write(require("fs").readFileSync("/data/claim-code","utf8").trim())'])).stdout.trim()
  check(resetCode !== claimCode && /^[a-f0-9]{32}$/.test(resetCode), 'host reset did not rotate the private image claim code')
  await docker(['exec', gateName, '/nodejs/bin/node', '-e', claimBoundary])
  await docker(['exec', gateName, '/nodejs/bin/node', '/opt/automagik/healthcheck.mjs'])
  say('gate: 401 healthy, separate store invisible to DSH, DSH mount read-only')
  say('claim: private 0600 files/socket, no code in logs or HTTP, local reset works in the image')
  await docker(['rm', '--force', gateName])
  await docker(['exec', name, '/nodejs/bin/node', '-e', `
    const fs = require('node:fs')
    const path = require('node:path').join(process.env.DSH_HOME, '.credentials.yaml')
    const backup = path + '.smoke-backup'
    if (fs.existsSync(backup)) fs.renameSync(backup, path)
    else fs.rmSync(path, { force: true })
  `])

  // The key file: 0400 is taken, anything group- or other-readable stops the start.
  await docker(['exec', name, '/nodejs/bin/node', '-e', 'const fs=require("fs"); fs.writeFileSync("/data/secrets/deepseek-api-key", "sk-smoke\\n", { mode: 0o400 }); fs.chmodSync("/data/secrets/deepseek-api-key", 0o400)'])
  await docker(['restart', name])
  await waitForFence()
  check(/automagik-web: model key from \/data\/secrets\/deepseek-api-key/.test(await logsOf()), 'the 0400 key file was not used')
  await docker(['exec', name, '/nodejs/bin/node', '-e', 'require("fs").chmodSync("/data/secrets/deepseek-api-key", 0o644)'])
  await docker(['restart', name])
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = (await docker(['inspect', name, '--format', '{{.State.Status}}'])).stdout.trim()
    if (status === 'exited') break
    await sleep(200)
  }
  check((await docker(['inspect', name, '--format', '{{.State.Status}}'])).stdout.trim() === 'exited', 'a 0644 key file did not stop the start')
  check(/the key file must be 0400 or 0600/.test(await logsOf()), 'no explanation for the refused key file')
  say('key file: 0400 used, 0644 refused')

  await smokeMultiuser(report.image.version)
  console.log(`SMOKE OK image=${image} health=401 start_to_401_ms=${startTo401} uid=1000`)
}

try {
  await main()
} catch (error) {
  console.error(`[smoke] FAILED: ${error?.stack ?? error}`)
  try {
    console.error(`[smoke] last logs:\n${(await logsOf()).split('\n').slice(-60).join('\n')}`)
  } catch {}
  process.exitCode = 1
} finally {
  await docker(['rm', '--force', memberName]).catch(() => {})
  for (const temp of [memberData, publicKeys, signerData, runnerData, botFiles]) await docker(['volume', 'rm', '--force', temp]).catch(() => {})
  await docker(['rm', '--force', gateName]).catch(() => {})
  await docker(['volume', 'rm', '--force', gateVolume]).catch(() => {})
  await docker(['rm', '--force', name]).catch(() => {})
  await docker(['volume', 'rm', '--force', volume]).catch(() => {})
}
