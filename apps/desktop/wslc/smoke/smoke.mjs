#!/usr/bin/env node
// The Linux image's smoke (RFC 0016 delivery 2's check), on a CI runner with Docker, never on a
// person's machine. It plays Electron (driver.mjs) against dsh-launch run in the container with
// `docker exec -i`, as the WSLC helper will, and proves five things:
//   1. the image starts: one long-lived container, as user automagik (uid 1000), with its tools;
//   2. dsh-launch prints a valid `ready` (protocol major 1) carrying DSH's own launch URL on
//      41700, and that URL signs a browser in (303 with DSH's cookie, then the page) while the
//      bare page refuses one without it (401);
//   3. a scripted browser-endpoint request goes round trip: an ipc frame to DSH (the fake DSH,
//      which sends the Bot team's own ds-bot:browser-endpoint request), the framed answer back
//      to it on the launcher's own port, and a connection there through the CDP tunnel; with the
//      relay's echo and `open` (https: only) on the same run;
//   4. closing stdin stops DSH within 5 s (the real DSH; and the fake);
//   5. a staged plugin tarball handed over in the exchange's lane/ is in the profile before DSH
//      starts, with .lane-prev beside it, and a failed trial puts the previous one back.
// Each check has a container and a volume of its own, so no DSH, port, lock or profile of one
// check reaches the next. Within a check, one launcher runs at a time; after each the check waits
// for the launcher and its DSH to be gone and 41700 to be free. Every container is removed at the
// end of its check, whatever happened.
// Usage: node smoke.mjs <image>
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeElectron, RELAY_PORT, TOKEN } from './driver.mjs'
import { launchUrlMismatch, maskUrl as masked } from './launch-url.mjs'
import { createLineMasker } from './redact.mjs'

const IMAGE = process.argv[2]
if (!IMAGE) throw new Error('usage: node smoke.mjs <image>')
const SMOKE = dirname(fileURLToPath(import.meta.url))
const HOME = '/home/automagik'
const DESKTOP = `${HOME}/.automagik/desktop`
const PROFILE = `${DESKTOP}/dsh/profiles/omni`
const WELCOME = '@automagik/welcome-dsh'
const DSH_PROCESS = '@deepseek-ai/dsh/lib/bin.js'
const FAKE_PROCESS = '/opt/smoke/fake-dsh.mjs'
const READY_MS = 240_000
const STOP_LIMIT_MS = 5_000
// How long a launcher that was asked to stop may take before the check kills it and fails.
const REAP_MS = 10_000
// dsh.js launchUrlOf's pattern, for port 41700.
const LAUNCH_URL = /^http:\/\/127\.0\.0\.1:41700\/\S*token=\S+$/

const say = line => console.log(`[smoke] ${line}`)
const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
const expect = (condition, message) => { if (!condition) throw new Error(message) }
const work = mkdtempSync(join(tmpdir(), 'automagik-smoke-'))
const results = []

// One container on a volume of its own, with its own exchange folder, as WSLC will hold one.
class Guest {
  constructor(label) {
    this.name = `automagik-smoke-${process.pid}-${label}`
    this.volume = `${this.name}-home`
    this.exchange = join(work, label, 'exchange')
    for (const dir of [this.exchange, join(this.exchange, 'lane'), join(this.exchange, 'downloads')]) {
      mkdirSync(dir, { recursive: true })
      // The runner's user is not the guest's (uid 1000): the guest must write here too, as it
      // will on the virtiofs mount.
      chmodSync(dir, 0o777)
    }
    this.launches = new Set()
    docker(['volume', 'create', this.volume])
    docker(['run', '-d', '--name', this.name,
      '-v', `${this.volume}:${HOME}`,
      '-v', `${this.exchange}:/mnt/automagik-exchange`,
      '-v', `${SMOKE}:/opt/smoke:ro`,
      IMAGE])
  }

  run(...command) { return docker(['exec', this.name, ...command]).trim() }
  ok(...command) { try { this.run(...command); return true } catch { return false } }
  running(pattern) { return this.ok('pgrep', '-f', pattern) }
  // Whether something accepts connections on the container's 127.0.0.1:41700.
  portTaken() {
    return this.run('node', '-e', `require('net').connect(41700, '127.0.0.1').on('connect', () => { console.log('taken'); process.exit(0) }).on('error', e => { console.log(e.code); process.exit(0) })`) === 'taken'
  }

  // One run of dsh-launch, as the helper runs it: `docker exec -i` with piped stdio. Only one at a
  // time: a second is refused here rather than left to collide on the port.
  launch({ fake = false } = {}) {
    expect([...this.launches].every(electron => electron.done), 'a launcher still runs in this container')
    const args = ['exec', '-i', ...(fake ? ['-e', `DSH_LAUNCH_BIN=${FAKE_PROCESS}`] : []), this.name, '/opt/automagik/bin/dsh-launch']
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const electron = new FakeElectron(child)
    electron.done = false
    void electron.exited.then(() => { electron.done = true })
    const log = createLineMasker(fake ? '  [fake dsh] ' : '  [dsh] ')
    child.stderr.on('data', chunk => process.stderr.write(log.push(chunk)))
    child.once('close', () => process.stderr.write(log.flush()))
    this.launches.add(electron)
    return electron
  }

  /**
   * Closes `electron`'s stdin and checks the stop: the launcher exits 0 within STOP_LIMIT_MS, no
   * process matching `pattern` is left, and 41700 is free. Answers how long the stop took.
   */
  async stop(electron, pattern) {
    const { code, signal, ms } = await electron.close()
    expect(code === 0, `dsh-launch exited with ${signal ?? code}, not 0`)
    expect(ms < STOP_LIMIT_MS, `dsh-launch took ${ms} ms to stop, not under ${STOP_LIMIT_MS}`)
    expect(!this.running(pattern), `a process matching ${pattern} still runs in the container`)
    expect(!this.portTaken(), '127.0.0.1:41700 is still taken in the container after the stop')
    return ms
  }

  // The end of a check: a launcher still running is asked to stop and, past REAP_MS, killed;
  // then the container and its volume go. Answers what had to be forced, for the check's result.
  async remove() {
    const forced = []
    for (const electron of this.launches) {
      if (electron.done) continue
      electron.child.stdin.end()
      const stopped = await Promise.race([electron.exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), REAP_MS))])
      if (!stopped) {
        forced.push('a launcher did not stop within 10 s of its stdin closing')
        electron.child.kill('SIGKILL')
      }
    }
    try { say(`${this.name} log:\n${docker(['logs', this.name])}`) } catch {}
    try { docker(['rm', '-f', this.name]) } catch {}
    try { docker(['volume', 'rm', '-f', this.volume]) } catch {}
    return forced
  }
}

// A check that cannot run because the check before it never reached its run answers this, rather
// than failing on the state that check would have set: the artefact is not this check's.
const skipped = reason => ({ skip: reason })
const isSkip = outcome => typeof outcome === 'object' && outcome !== null && 'skip' in outcome

async function check(number, name, run) {
  const started = Date.now()
  let guest
  try {
    guest = new Guest(`check${number}`)
    const outcome = await run(guest)
    const forced = await guest.remove()
    guest = null
    expect(forced.length === 0, forced.join('; '))
    if (isSkip(outcome)) {
      results.push({ number, name, ok: true, skipped: true, detail: outcome.skip })
      say(`CHECK ${number} SKIP (${Date.now() - started} ms): ${name}: ${outcome.skip}`)
      return
    }
    results.push({ number, name, ok: true, detail: outcome })
    say(`CHECK ${number} PASS (${Date.now() - started} ms): ${name}: ${outcome}`)
  } catch (error) {
    if (guest) await guest.remove().catch(() => {})
    results.push({ number, name, ok: false, detail: error.message })
    say(`CHECK ${number} FAIL (${Date.now() - started} ms): ${name}: ${error.stack}`)
  }
}

const readyOf = electron => electron.waitFor(frame => frame.type === 'ready', READY_MS, 'ready')
const laneOf = electron => electron.waitFor(frame => frame.type === 'lane' && 'state' in frame, READY_MS, 'the lane frame')
const welcomeVersion = (guest, dir = `${PROFILE}/node_modules/@automagik/welcome-dsh`) => JSON.parse(guest.run('cat', `${dir}/package.json`)).version

// The launch URL as a browser takes it, from inside the container: the URL verbatim, with no
// redirect followed, must answer 303 with DSH's dsh-auth- cookie (dsh-client-connection
// authorizeIndex); the page it points to answers 200 with that cookie and 401 without it.
const SIGN_IN = `
const url = process.argv[1]
const page = new URL('./', url).href
const main = async () => {
  const first = await fetch(url, { redirect: 'manual' })
  const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]
  const signedIn = await fetch(page, { redirect: 'manual', headers: cookie ? { cookie } : {} })
  const bare = await fetch(page, { redirect: 'manual' })
  console.log(JSON.stringify({ first: first.status, location: first.headers.get('location'), cookie: cookie.split('=')[0], signedIn: signedIn.status, bare: bare.status }))
}
main().catch(error => { console.log(JSON.stringify({ error: error.message })) })
`

async function signIn(guest, url) {
  const answer = JSON.parse(guest.run('node', '-e', SIGN_IN, url))
  const shape = `${masked(url)} -> ${JSON.stringify(answer)}`
  expect(!answer.error, `the launch URL could not be fetched: ${shape}`)
  expect(answer.first === 303 && /^dsh-auth-/.test(answer.cookie), `the launch URL did not sign in (303 with a dsh-auth- cookie): ${shape}`)
  expect(answer.signedIn === 200, `the page did not answer 200 with the cookie: ${shape}`)
  expect(answer.bare === 401, `the page did not refuse a request with no cookie: ${shape}`)
  return answer
}

let realStop
let fakeStop
try {
  await check(1, 'the image starts', async (guest) => {
    const user = `${guest.run('id', '-un')} ${guest.run('id', '-u')}`
    expect(user === 'automagik 1000', `the guest user is ${user}, not automagik 1000`)
    const node = guest.run('node', '--version')
    const [major, minor] = node.slice(1).split('.').map(Number)
    expect(major > 22 || (major === 22 && minor >= 19), `Node ${node} is older than 22.19`)
    const pnpm = guest.run('pnpm', '--version')
    expect(/^10\./.test(pnpm), `pnpm ${pnpm} is not pnpm 10`)
    const tools = {
      hc: guest.run('hc', '--version'),
      git: guest.run('git', '--version'),
      bash: guest.run('bash', '-c', 'echo $BASH_VERSION'),
      rg: guest.run('rg', '--version').split('\n')[0],
      bwrap: guest.run('bwrap', '--version'),
      ssh: guest.run('sh', '-c', 'ssh -V 2>&1'),
      tini: guest.run('sh', '-c', 'command -v tini'),
      certificates: guest.run('sh', '-c', 'test -s /etc/ssl/certs/ca-certificates.crt && echo present'),
    }
    expect(guest.ok('test', '-x', '/opt/automagik/bin/dsh-launch'), 'no /opt/automagik/bin/dsh-launch')
    expect(guest.run('sh', '-c', 'command -v xdg-open') === '/opt/automagik/bin/xdg-open', 'xdg-open is not the shim')
    expect(guest.ok('test', '-w', HOME), `${HOME} is not writable`)
    expect(guest.ok('test', '-d', '/mnt/automagik-exchange/lane'), 'no exchange lane/')
    const versions = guest.run('cat', '/opt/automagik/versions.json').replace(/\s+/g, ' ')
    return `${user}; node ${node}; pnpm ${pnpm}; ${Object.entries(tools).map(([name, value]) => `${name}: ${value}`).join('; ')}; versions ${versions}`
  })

  await check(2, 'dsh-launch prints a valid ready for the real DSH', async (guest) => {
    const electron = guest.launch()
    const lane = await laneOf(electron)
    expect(lane.v === 1 && lane.state === 'none', `the first start's lane frame is ${JSON.stringify(lane)}`)
    const ready = await readyOf(electron)
    expect(ready.v === 1, `ready's v is ${ready.v}`)
    expect(ready.port === 41700, `ready's port is ${ready.port}`)
    expect(LAUNCH_URL.test(ready.url), `ready's url ${masked(ready.url)} is not DSH's launch URL on 41700`)
    expect(electron.protocolError === null, `stdout carried something that is no frame: ${electron.protocolError?.message}`)
    const answer = await signIn(guest, ready.url)
    realStop = await guest.stop(electron, DSH_PROCESS)
    // The stop waits for 'close', both pipes drained: DSH's launch line can no longer still be in
    // flight when its url is compared with the ready frame's. Both sides are raw, so the token is
    // part of the evidence; only the message masks it.
    const mismatch = launchUrlMismatch(ready.url, electron.stderr)
    expect(mismatch === null, mismatch)
    const log = guest.run('cat', `${DESKTOP}/logs/dsh.log`)
    expect(log.includes(`dsh web: ${ready.url}`), 'the volume\'s dsh.log lacks DSH\'s launch line')
    return `ready {v: 1, port: 41700, url: ${masked(ready.url)}} = DSH's launch line; launch URL ${answer.first} -> ${answer.location} with ${answer.cookie}…, page ${answer.signedIn} signed in, ${answer.bare} without; dsh.log in the volume and on stderr; stopped in ${realStop} ms`
  })

  await check(3, 'a scripted browser-endpoint request goes round trip (ipc relay, CDP tunnel, open)', async (guest) => {
    const electron = guest.launch({ fake: true })
    await readyOf(electron)
    electron.send({ type: 'ipc', message: { type: 'smoke:echo', payload: { text: 'ação', n: 3 } } })
    const echoed = await electron.ipc('smoke:echoed')
    expect(JSON.stringify(echoed.payload) === JSON.stringify({ text: 'ação', n: 3 }), `echo came back as ${JSON.stringify(echoed)}`)
    electron.send({ type: 'ipc', message: { type: 'smoke:endpoint', botId: 'bot-smoke' } })
    const result = await electron.ipc('smoke:endpoint-result', 30_000)
    expect(!result.error, `the endpoint failed: ${result.error}`)
    const url = new URL(result.url)
    expect(url.hostname === '127.0.0.1' && url.port !== String(RELAY_PORT) && url.pathname === `/devtools/browser/${TOKEN}`, `DSH got ${result.url}`)
    expect(result.reply === `relay ${TOKEN}`, `through the tunnel came ${JSON.stringify(result.reply)}`)
    const opened = electron.frames.find(frame => frame.type === 'tunnel' && frame.op === 'open')
    expect(opened?.port === RELAY_PORT, `the tunnel opened to ${JSON.stringify(opened)}`)
    const link = 'https://example.com/sign-in?state=smoke'
    electron.send({ type: 'ipc', message: { type: 'smoke:open', url: link } })
    const shim = await electron.ipc('smoke:open-result')
    expect(shim.code === 0, `xdg-open ${link} exited ${shim.code}: ${shim.stderr}`)
    const open = await electron.waitFor(frame => frame.type === 'open', 10_000, 'the open frame')
    expect(open.url === link, `the open frame is ${JSON.stringify(open)}`)
    const before = electron.frames.filter(frame => frame.type === 'open').length
    electron.send({ type: 'ipc', message: { type: 'smoke:open', url: 'http://example.com/' } })
    const refused = await electron.waitFor(frame => frame.type === 'ipc' && frame.message?.type === 'smoke:open-result' && frame.message.url === 'http://example.com/', 10_000, 'the refused open')
    expect(refused.message.code === 4, `xdg-open http: exited ${refused.message.code}`)
    expect(electron.frames.filter(frame => frame.type === 'open').length === before, 'an http: link reached Electron')
    fakeStop = await guest.stop(electron, FAKE_PROCESS)
    return `ipc echo both ways; DSH's endpoint ${url.protocol}//127.0.0.1:${url.port}${url.pathname.replace(TOKEN, '<token>')}; tunnel to ${RELAY_PORT} replied; https: opened, http: refused (exit 4); stopped in ${fakeStop} ms`
  })

  await check(4, 'closing stdin stops DSH within 5 s', async () => {
    const missing = [
      realStop === undefined && 'CHECK 2',
      fakeStop === undefined && 'CHECK 3',
    ].filter(Boolean)
    // A check's failure is reported there; its stop value is absent here, and that is not this
    // check's verdict. Never report the absence as a timing or state failure of the stop itself.
    if (missing.length > 0) return skipped(`skipped: ${missing.join(' and ')} did not reach a run`)
    return `real DSH ${realStop} ms, fake DSH ${fakeStop} ms, limit ${STOP_LIMIT_MS} ms; no DSH process left and 41700 free after each`
  })

  await check(5, 'a staged plugin tarball is unpacked into the profile; a failed trial restores it', async (guest) => {
    // The first start installs the profile in this check's volume.
    const first = guest.launch({ fake: true })
    expect((await laneOf(first)).state === 'none', 'the first start had a lane state')
    await readyOf(first)
    await guest.stop(first, FAKE_PROCESS)

    const before = welcomeVersion(guest)
    const [major, minor, patch] = before.split('-')[0].split('.').map(Number)
    const next = `${major}.${minor}.${patch + 1}`
    const file = `automagik-welcome-dsh-${next}.tgz`
    // The welcome as the profile has it, at the next patch version, packed as npm packs it.
    guest.run('sh', '-c', [
      'set -e', 'd=$(mktemp -d)',
      `cp -rL ${PROFILE}/node_modules/@automagik/welcome-dsh "$d/package"`,
      `node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2))' "$d/package/package.json" ${next}`,
      `tar -czf /mnt/automagik-exchange/lane/${file} -C "$d" package`, 'rm -rf "$d"',
    ].join('; '))
    const bytes = readFileSync(join(guest.exchange, 'lane', file))
    const handoff = {
      v: 1,
      lanes: { automagik: { version: next, sequence: 1 } },
      plugins: [{
        publisher: 'automagik', name: WELCOME, version: next, file, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      }],
    }
    // Electron writes the handoff last, whole.
    writeFileSync(join(guest.exchange, 'lane', 'handoff.json.tmp'), JSON.stringify(handoff))
    execFileSync('mv', [join(guest.exchange, 'lane', 'handoff.json.tmp'), join(guest.exchange, 'lane', 'handoff.json')])

    // The trial start, on the real DSH.
    const trial = guest.launch()
    const lane = await laneOf(trial)
    expect(lane.state === 'applied' && lane.version === next, `the lane frame is ${JSON.stringify(lane)}`)
    expect(welcomeVersion(guest) === next, `the profile's welcome is ${welcomeVersion(guest)}, not ${next}`)
    expect(welcomeVersion(guest, `${PROFILE}/node_modules/@automagik/welcome-dsh.lane-prev`) === before, 'no .lane-prev with the previous welcome')
    expect(!guest.ok('test', '-e', '/mnt/automagik-exchange/lane/handoff.json'), 'the handoff was not taken')
    const ready = await readyOf(trial)
    expect(LAUNCH_URL.test(ready.url), `the trial's ready url ${masked(ready.url)} is not DSH's launch URL`)
    trial.send({ type: 'lane', trial: 'failed' })
    const judged = await trial.waitFor(frame => frame.type === 'lane' && frame.trial === 'failed', 10_000, 'the verdict\'s answer')
    expect(judged.recorded === true, `the failed trial was not recorded: ${JSON.stringify(judged)}`)
    const trialStop = await guest.stop(trial, DSH_PROCESS)

    // The next start puts the previous welcome back before DSH.
    const after = guest.launch({ fake: true })
    const back = await laneOf(after)
    expect(back.state === 'restored', `the next start's lane frame is ${JSON.stringify(back)}`)
    expect(welcomeVersion(guest) === before, `the profile's welcome is ${welcomeVersion(guest)} after the restore, not ${before}`)
    expect(!guest.ok('test', '-e', `${PROFILE}/node_modules/@automagik/welcome-dsh.lane-prev`), '.lane-prev is still there after the restore')
    await readyOf(after)
    await guest.stop(after, FAKE_PROCESS)
    return `${before} -> ${next} applied before DSH (.lane-prev kept, handoff taken), real DSH ready on it, stopped in ${trialStop} ms; trial failed -> restored to ${before}, .lane-prev gone`
  })
} finally {
  rmSync(work, { recursive: true, force: true })
}

const lines = results.map(({ number, name, ok, skipped, detail }) => {
  const state = !ok ? 'FAIL' : skipped ? 'SKIP' : 'PASS'
  return `CHECK ${number}/5 ${state}: ${name} — ${detail.split('\n')[0]}`
})
say(`summary\n${lines.join('\n')}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Linux image smoke\n\n${lines.map(line => `- ${line}`).join('\n')}\n`)
}
const passed = results.filter(result => result.ok && !result.skipped).length
const skips = results.filter(result => result.skipped).length
if (!results.every(result => result.ok) || results.length !== 5) {
  console.error(`[smoke] ${passed} of 5 checks passed${skips > 0 ? `, ${skips} skipped` : ''}`)
  process.exit(1)
}
