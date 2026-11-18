// dsh-launch as a process, with the fake DSH (smoke/fake-dsh.mjs) and a small image laid out in a
// temp folder: ready, the ipc relay both ways, the CDP tunnel, open, the stop on stdin's end, and
// the lane's handoff, trial and restore. The image itself is tested in CI (smoke/smoke.mjs).
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { EXIT } from '../lib/launcher.mjs'
import { FakeElectron, RELAY_PORT, TOKEN } from '../smoke/driver.mjs'

const WSLC = fileURLToPath(new URL('..', import.meta.url))
const LAUNCHER = join(WSLC, 'bin', 'dsh-launch.mjs')
const FAKE = join(WSLC, 'smoke', 'fake-dsh.mjs')
const WELCOME = '@automagik/welcome-dsh'
let sockets = 0
// Every launcher a test started: one a failed assertion left running is killed after it.
const children = new Set()
const reap = () => { for (const child of children) try { child.kill('SIGKILL') } catch {} }

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})

// An image as the Dockerfile lays it out, as small as the launcher needs: a profile with the
// welcome in it, the runtime's pnpm, and bin/xdg-open.
function makeImage() {
  const dir = mkdtempSync(join(tmpdir(), 'wslc-'))
  const image = join(dir, 'image')
  const profile = join(image, 'profile')
  mkdirSync(join(profile, 'node_modules', '@automagik', 'welcome-dsh'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'omni-desktop-profile', private: true, dependencies: { [WELCOME]: 'file:vendor/automagik-welcome-dsh-1.0.0.tgz' } }, null, 2))
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profile, 'node_modules', '@automagik', 'welcome-dsh', 'package.json'), JSON.stringify({ name: WELCOME, version: '1.0.0' }))
  writeFileSync(join(profile, '.build-id'), 'test-build\n')
  mkdirSync(join(image, 'runtime', 'node_modules', 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(image, 'runtime', 'node_modules', 'pnpm', 'package.json'), JSON.stringify({ name: 'pnpm', version: '10.34.6' }))
  writeFileSync(join(image, 'runtime', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '')
  mkdirSync(join(image, 'bin'), { recursive: true })
  symlinkSync(join(WSLC, 'bin', 'xdg-open.mjs'), join(image, 'bin', 'xdg-open'))
  mkdirSync(join(dir, 'exchange', 'lane'), { recursive: true })
  mkdirSync(join(dir, 'home'), { recursive: true })
  return { dir, image, exchange: join(dir, 'exchange'), home: join(dir, 'home') }
}

async function launch(box, { env = {} } = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [LAUNCHER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: box.home,
      AUTOMAGIK_HOME: join(box.home, '.automagik'),
      AUTOMAGIK_IMAGE: box.image,
      AUTOMAGIK_EXCHANGE: box.exchange,
      // A short path: a Unix socket's path has a length limit (104 bytes on macOS).
      AUTOMAGIK_OPEN_SOCKET: join(tmpdir(), `wslc-${process.pid}-${++sockets}.sock`),
      DSH_LAUNCH_BIN: FAKE,
      DSH_LAUNCH_PORT: String(port),
      DO_NOT_TRACK: '1',
      ...env,
    },
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  return { electron: new FakeElectron(child), port }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const profileOf = box => join(box.home, '.automagik', 'desktop', 'dsh', 'profiles', 'omni')
const welcomeVersion = box => JSON.parse(readFileSync(join(profileOf(box), 'node_modules', '@automagik', 'welcome-dsh', 'package.json'), 'utf8')).version

test('ready, the ipc relay both ways, the CDP tunnel, open, and the stop on stdin\'s end', async () => {
  const box = makeImage()
  try {
    const { electron, port } = await launch(box)
    const lane = await electron.waitFor(frame => frame.type === 'lane', 15_000, 'the lane frame')
    assert.equal(lane.state, 'none')
    const ready = await electron.waitFor(frame => frame.type === 'ready', 15_000, 'ready')
    assert.equal(ready.v, 1)
    assert.equal(ready.port, port)
    assert.match(ready.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?token=[0-9a-f]{32}$`))
    // The frames came before anything else: stdout carries frames only.
    assert.equal(electron.protocolError, null)

    // DSH's environment: the app's, with the shim as the browser and the image's bin first.
    electron.send({ type: 'ipc', message: { type: 'smoke:env' } })
    const env = await electron.ipc('smoke:env')
    assert.equal(env.BROWSER, join(box.image, 'bin', 'xdg-open'))
    assert.equal(env.PATH.split(':')[0], join(box.image, 'bin'))
    assert.deepEqual(env.argv, ['--profile', 'omni', '--patch', join(box.home, '.automagik', 'desktop', 'privacy.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', String(port)])

    // Electron to DSH and back.
    electron.send({ type: 'ipc', message: { type: 'smoke:echo', payload: { n: 1, text: 'ação' } } })
    assert.deepEqual((await electron.ipc('smoke:echoed')).payload, { n: 1, text: 'ação' })

    // DSH asks for a Bot's browser; the answer names the launcher's own port, and a connection
    // to it reaches the relay through a tunnel.
    electron.send({ type: 'ipc', message: { type: 'smoke:endpoint', botId: 'bot-1' } })
    const result = await electron.ipc('smoke:endpoint-result')
    assert.equal(result.error, undefined)
    const url = new URL(result.url)
    assert.equal(url.hostname, '127.0.0.1')
    assert.notEqual(url.port, String(RELAY_PORT))
    assert.equal(url.pathname, `/devtools/browser/${TOKEN}`)
    assert.equal(result.reply, `relay ${TOKEN}`)
    const request = electron.frames.find(frame => frame.type === 'ipc' && frame.message?.type === 'ds-bot:browser-endpoint')
    assert.equal(request.message.botId, 'bot-1')
    assert.deepEqual(request.message.downloadRoots, ['/home/automagik/Downloads'])
    const open = electron.frames.find(frame => frame.type === 'tunnel' && frame.op === 'open')
    assert.deepEqual([open.host, open.port], ['127.0.0.1', RELAY_PORT])
    await electron.waitFor(frame => frame.type === 'tunnel' && frame.op === 'close' && frame.id === open.id, 5_000, 'the tunnel\'s close')

    // Links out: https: goes to Electron, anything else is refused in the guest.
    const link = 'https://claude.ai/oauth/authorize?redirect_uri=' + encodeURIComponent('http://localhost:54545/callback')
    electron.send({ type: 'ipc', message: { type: 'smoke:open', url: link } })
    assert.equal((await electron.ipc('smoke:open-result')).code, 0)
    const opened = await electron.waitFor(frame => frame.type === 'open', 5_000, 'the open frame')
    assert.equal(opened.url, link)
    assert.equal(opened.callbackPort, 54545)
    electron.frames.length = 0
    electron.send({ type: 'ipc', message: { type: 'smoke:open', url: 'http://example.com/' } })
    const refused = await electron.ipc('smoke:open-result')
    assert.equal(refused.code, 4)
    assert.match(refused.stderr, /only https: URLs open/)
    assert.equal(electron.frames.some(frame => frame.type === 'open'), false)

    // Stdin's end stops DSH (SIGTERM) and the launcher, well within 5 s.
    const stopped = await electron.close()
    assert.equal(stopped.code, EXIT.stopped)
    assert.ok(stopped.ms < 5_000, `${stopped.ms} ms`)
    assert.match(electron.stderr, /fake-dsh: SIGTERM/)
    assert.equal(alive(env.pid), false)
    // DSH's own output is in the volume's log and on stderr.
    const log = readFileSync(join(box.home, '.automagik', 'desktop', 'logs', 'dsh.log'), 'utf8')
    assert.match(log, /fake-dsh: up/)
    assert.match(electron.stderr, /fake-dsh: up/)
  } finally {
    reap()
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a DSH that ignores SIGTERM is killed, and the launcher is still gone within 5 s', async () => {
  const box = makeImage()
  try {
    const { electron } = await launch(box, { env: { FAKE_DSH_IGNORE_TERM: '1' } })
    await electron.waitFor(frame => frame.type === 'ready', 15_000, 'ready')
    electron.send({ type: 'ipc', message: { type: 'smoke:env' } })
    const { pid } = await electron.ipc('smoke:env')
    const stopped = await electron.close()
    assert.equal(stopped.code, EXIT.stopped)
    assert.ok(stopped.ms < 5_000, `${stopped.ms} ms`)
    assert.equal(alive(pid), false)
  } finally {
    reap()
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a line on stdin that is no frame stops everything', async () => {
  const box = makeImage()
  try {
    const { electron } = await launch(box)
    await electron.waitFor(frame => frame.type === 'ready', 15_000, 'ready')
    electron.child.stdin.write('{"v":2,"type":"ipc"}\n')
    const { code } = await electron.exited
    assert.equal(code, EXIT.protocol)
    assert.match(electron.stderr, /protocol 2, not 1/)
  } finally {
    reap()
    rmSync(box.dir, { recursive: true, force: true })
  }
})

// The welcome at `version`, packed as npm packs it (package/), into the exchange's lane/ with the
// handoff naming it, as Electron writes them.
function handOff(box, version, { sequence = 1 } = {}) {
  const work = join(box.dir, `pack-${version}`)
  mkdirSync(join(work, 'package'), { recursive: true })
  writeFileSync(join(work, 'package', 'package.json'), JSON.stringify({ name: WELCOME, version }))
  const file = `automagik-welcome-dsh-${version}.tgz`
  execFileSync('tar', ['-czf', join(box.exchange, 'lane', file), '-C', work, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = readFileSync(join(box.exchange, 'lane', file))
  const handoff = {
    v: 1,
    lanes: { automagik: { version, sequence } },
    plugins: [{
      publisher: 'automagik', name: WELCOME, version, file, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }],
  }
  writeFileSync(join(box.exchange, 'lane', 'handoff.json'), JSON.stringify(handoff))
  return file
}

async function startAndStop(box, after = async () => {}) {
  const { electron } = await launch(box)
  const lane = await electron.waitFor(frame => frame.type === 'lane' && 'state' in frame, 15_000, 'the lane frame')
  await electron.waitFor(frame => frame.type === 'ready', 15_000, 'ready')
  await after(electron)
  const stopped = await electron.close()
  assert.equal(stopped.code, EXIT.stopped)
  return lane
}

test('a handed-off plugin goes in before DSH, and a failed trial puts the previous one back', async () => {
  const box = makeImage()
  try {
    // The first start installs the profile with the welcome at 1.0.0.
    assert.equal((await startAndStop(box)).state, 'none')
    assert.equal(welcomeVersion(box), '1.0.0')

    const file = handOff(box, '1.0.1')
    const lane = await startAndStop(box, async (electron) => {
      assert.equal(welcomeVersion(box), '1.0.1')
      assert.equal(existsSync(join(profileOf(box), 'node_modules', '@automagik', 'welcome-dsh.lane-prev', 'package.json')), true)
      // The profile names the lane's tarball, as pnpm would have installed it (lane.js pinLanePackage).
      const manifest = JSON.parse(readFileSync(join(profileOf(box), 'package.json'), 'utf8'))
      assert.equal(manifest.dependencies[WELCOME], 'file:vendor/automagik-welcome-dsh-1.0.1.tgz')
      assert.equal(existsSync(join(profileOf(box), 'vendor', 'automagik-welcome-dsh-1.0.1.tgz')), true)
      electron.send({ type: 'lane', trial: 'failed' })
      const judged = await electron.waitFor(frame => frame.type === 'lane' && frame.trial === 'failed', 5_000, 'the verdict\'s answer')
      assert.equal(judged.recorded, true)
    })
    assert.deepEqual([lane.state, lane.version, lane.staged], ['applied', '1.0.1', ['automagik@1.0.1']])
    // The handoff and its tarball were taken once.
    assert.equal(existsSync(join(box.exchange, 'lane', 'handoff.json')), false)
    assert.equal(existsSync(join(box.exchange, 'lane', file)), false)

    // The next start, before DSH: the previous plugin is back, and the version is bad here.
    const back = await startAndStop(box)
    assert.equal(back.state, 'restored')
    assert.equal(welcomeVersion(box), '1.0.0')
    assert.equal(existsSync(join(profileOf(box), 'node_modules', '@automagik', 'welcome-dsh.lane-prev')), false)
    assert.equal(JSON.parse(readFileSync(join(profileOf(box), 'package.json'), 'utf8')).dependencies[WELCOME], 'file:vendor/automagik-welcome-dsh-1.0.0.tgz')
    assert.deepEqual(JSON.parse(readFileSync(join(box.home, '.automagik', 'desktop', 'lane', 'bad.json'), 'utf8')), ['automagik@1.0.1'])

    // The same version handed off again is not staged.
    handOff(box, '1.0.1', { sequence: 2 })
    const again = await startAndStop(box)
    assert.deepEqual([again.state, again.skipped], ['none', ['automagik@1.0.1']])
    assert.equal(welcomeVersion(box), '1.0.0')
  } finally {
    reap()
    rmSync(box.dir, { recursive: true, force: true })
  }
})

test('a passed trial drops the previous plugin; a damaged tarball is not staged', async () => {
  const box = makeImage()
  try {
    await startAndStop(box)
    handOff(box, '1.0.2')
    const lane = await startAndStop(box, async (electron) => {
      electron.send({ type: 'lane', trial: 'passed' })
      assert.equal((await electron.waitFor(frame => frame.type === 'lane' && frame.trial === 'passed', 5_000, 'the verdict\'s answer')).recorded, true)
    })
    assert.equal(lane.state, 'applied')
    assert.equal(welcomeVersion(box), '1.0.2')
    assert.equal(existsSync(join(profileOf(box), 'node_modules', '@automagik', 'welcome-dsh.lane-prev')), false)
    assert.equal((await startAndStop(box)).state, 'none')
    assert.equal(welcomeVersion(box), '1.0.2')

    const file = handOff(box, '1.0.3')
    writeFileSync(join(box.exchange, 'lane', file), 'damaged on the way')
    const damaged = await startAndStop(box)
    assert.equal(damaged.state, 'none')
    assert.match(damaged.error, /not the size the lane names|does not match/)
    assert.equal(welcomeVersion(box), '1.0.2')
  } finally {
    reap()
    rmSync(box.dir, { recursive: true, force: true })
  }
})
