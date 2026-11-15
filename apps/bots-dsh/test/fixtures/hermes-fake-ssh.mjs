// Executed only as a disposable executable named ssh by hermes-ssh.test.js.
// It never opens a socket or runs an SSH client/Hermes installation.
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
const scenario = process.env.HERMES_SSH_SCENARIO || 'ready'
const role = args.includes('-G') ? 'config' : args.includes('StrictHostKeyChecking=accept-new') ? 'trust' : args.includes('-N') ? 'tunnel' : 'supervisor'
// The sample host key this fake presents: a per-run blob the test made, never a real key.
const hostKey = process.env.HERMES_SSH_HOST_KEY || ''
const fingerprint = blob => `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`
const target = args[args.indexOf('--') + 1]
const record = fields => appendFileSync(process.env.HERMES_SSH_RECORD, `${JSON.stringify({ role, pid: process.pid, ...fields })}\n`, { mode: 0o600 })
record({ event: 'spawn', args })
// The fake app-exit test closes the parent's stdout reader before remote cleanup.
process.stdout.on('error', () => {})
let nonce, runtime, closed = false, received = ''
const emit = frame => process.stdout.write(`${JSON.stringify({ nonce, ...frame })}\n`)
const finish = () => {
  if (closed || scenario === 'ignore-close') return
  if (runtime) { runtime.stdin.end(); return }
  closed = true
  record({ event: 'closed' })
  if (role === 'supervisor' && nonce) emit({ type: 'closed', clean: !scenario.endsWith('unclean') })
  process.exit(0)
}
process.on('SIGTERM', finish)
if (role === 'config') {
  // ssh -G: only the line the trust step reads, pointing at the test's own folder.
  // A config entry that resolves the alias to another name and user: sample values.
  const resolved = scenario === 'host-key-gone' ? 'hostname sample-remote.example.invalid\nuser sample-user\n' : `hostname ${target}\n`
  process.stdout.write(`${resolved}userknownhostsfile ${process.env.HERMES_SSH_KNOWN_HOSTS || '/dev/null'}\n`)
  process.exit(0)
}
if (role === 'trust') {
  // What ssh does with accept-new: a host whose saved key differs is refused and nothing
  // is written; a new host's key goes to the first listed file; a known host adds nothing.
  // The host went away between the screen and the button: no key is written, SSH fails.
  if (scenario === 'host-key-gone') { process.stderr.write(`kex_exchange_identification: sample-remote.example.invalid closed the connection for sample-user\nssh: Could not resolve hostname ${target}: Name or service not known\n`); process.exit(255) }
  const option = args.find(arg => arg.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length)
  const files = [...option.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2])
  const presented = scenario === 'trust-swapped' ? process.env.HERMES_SSH_SWAPPED_KEY : hostKey
  const saved = files.slice(1).flatMap(file => { try { return readFileSync(file, 'utf8').split('\n') } catch { return [] } })
    .map(line => line.trim().split(/\s+/)).filter(fields => fields[0] === target)
  process.stderr.write(`debug1: Server host key: ssh-ed25519 ${fingerprint(presented)}\n`)
  if (saved.some(fields => fields[2] !== presented)) process.stderr.write('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n')
  else {
    if (!saved.length) { appendFileSync(files[0], `${target} ssh-ed25519 ${presented}\n`); process.stderr.write(`Warning: Permanently added '${target}' (ED25519) to the list of known hosts.\n`) }
    process.stderr.write(`sample@${target}: Permission denied (publickey).\n`)
  }
  process.exit(255)
}
// What a -v trace says of where and as whom SSH connects: sample names and the
// documentation address ranges only.
const whoTrace = "debug1: Connecting to sample-remote.example.invalid [192.0.2.44] port 22.\ndebug1: Authenticating to sample-remote.example.invalid:22 as 'sample-user'\n"
if (['host-key', 'changed-key', 'auth', 'auth-delayed', 'interactive', 'unreachable', 'python-missing', 'unclassified', 'named-tail', 'host-key-gone'].includes(scenario)) {
  // SSH's own lines, as its -v trace gives them: the trace of every sign-in names
  // "keyboard-interactive" and a timeout, which no verdict may be read from.
  const trace = `debug1: Server host key: ssh-ed25519 ${fingerprint(hostKey)}\ndebug1: Authentications that can continue: publickey,keyboard-interactive\ndebug1: ServerAliveInterval timeout 5\n`
  const offered = 'debug1: Will attempt key: /sample/home/.ssh/id_sample ED25519 SHA256:sampleSampleSampleSampleSampleSampleSample1 explicit\ndebug1: Offering public key: /sample/home/.ssh/id_sample ED25519 SHA256:sampleSampleSampleSampleSampleSampleSample1 explicit\ndebug1: Offering public key: sample@example.invalid ED25519 SHA256:sampleSampleSampleSampleSampleSampleSample2 agent\ndebug1: Trying private key: /sample/home/.ssh/id_other\n'
  const unknownKey = `${trace}No ED25519 host key is known for ${target} and you have requested strict checking.\nHost key verification failed.\n`
  process.stderr.write({
    'host-key': unknownKey, 'host-key-gone': unknownKey,
    'changed-key': `${trace}@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n`,
    auth: `${trace}${offered}sample@${target}: Permission denied (publickey).\n`, 'auth-delayed': `${trace}${offered}sample@${target}: Permission denied (publickey).\n`,
    interactive: `${trace}interactive verification required\n`, unreachable: 'ssh: Could not resolve hostname\n', 'python-missing': `${trace}zsh:1: command not found: python3\n`,
    unclassified: `${trace}A sample line SSH said, with /home/sample-person/.ssh/id_sample in it\n`,
    // Last lines that name the user, the resolved host, both address families and the alias.
    'named-tail': `${trace}${whoTrace}Warning: Permanently added the ED25519 host key for IP address '2001:db8::7:1' to the list of known hosts.\nsample-user reached sample-remote.example.invalid through ${target} at 192.0.2.44 and [2001:db8::7:2]:22\nsample-user@sample-remote.example.invalid: Connection closed by 192.0.2.44 port 22\n`,
  }[scenario])
  if (scenario === 'auth-delayed') { process.stdin.destroy(); setTimeout(() => process.exit(255), 50) }
  else process.exit(scenario === 'python-missing' ? 127 : 255)
}
if (role === 'tunnel') {
  if (scenario === 'tunnel-failure') { process.stderr.write('forwarding failed: address already in use'); process.exit(255) }
  // A forward from the host's own config entry, busy on this computer: not the tunnel's port.
  if (scenario === 'forward-conflict') { process.stderr.write('bind [127.0.0.1]:8080: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 8080\nCould not request local forwarding.\n'); process.exit(255) }
  const spec = args[args.indexOf('-L') + 1]
  const port = Number(spec.split(':')[1])
  if (scenario !== 'tunnel-silent') process.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${port}.\n`)
} else if (scenario.startsWith('runtime-')) {
  // Execute only Automagik's supervisor against an explicit disposable fake Hermes.
  // No upstream code, real SSH client or network listener is involved.
  const command = scenario.includes('no-waitid') ? args.at(-1).replace('class Stop(Exception)', 'del os.waitid\nclass Stop(Exception)') : scenario === 'runtime-unsupported-platform' ? args.at(-1).replace('class Stop(Exception)', 'sys.platform = "unsupported"\nclass Stop(Exception)')
    // A fault inside the start script itself: its token folder cannot be made.
    : scenario === 'runtime-script-fault' ? args.at(-1).replace('class Stop(Exception)', 'os.makedirs = None\nclass Stop(Exception)') : args.at(-1)
  runtime = spawn('/bin/sh', ['-c', command], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  if (scenario === 'runtime-bad-token') {
    // The start script is handed a token of the wrong shape: it must refuse the handshake.
    let first = ''
    const hand = chunk => {
      first += String(chunk)
      const end = first.indexOf('\n')
      if (end < 0) return
      process.stdin.off('data', hand)
      runtime.stdin.write(`${JSON.stringify({ ...JSON.parse(first.slice(0, end)), credential: 'short' })}\n${first.slice(end + 1)}`)
      process.stdin.pipe(runtime.stdin)
    }
    process.stdin.on('data', hand)
  } else process.stdin.pipe(runtime.stdin)
  runtime.stdout.pipe(process.stdout)
  runtime.stderr.pipe(process.stderr)
  runtime.stdin.on('error', () => {})
  runtime.on('error', () => process.exit(1))
  runtime.on('close', code => { record({ event: 'closed' }); process.exit(code ?? 1) })
} else {
  process.stdin.on('data', chunk => {
    received += String(chunk)
    let newline
    while ((newline = received.indexOf('\n')) >= 0) {
      const line = received.slice(0, newline); received = received.slice(newline + 1)
      if (!nonce) {
        const options = JSON.parse(line)
        nonce = options.nonce
        record({ event: 'input', hermesPath: options.hermesPath, startMs: options.startMs, controlMs: options.controlMs, cancelMs: options.cancelMs })
        if (scenario === 'missing') { emit({ type: 'error', code: 'hermes-not-found' }); finish(); return }
        if (scenario === 'old-contract') { emit({ type: 'error', code: 'update-required' }); finish(); return }
        if (scenario === 'wrong-nonce') { emit({ type: 'ready', nonce: 'unrelated', port: Number(process.env.HERMES_SSH_REMOTE_PORT) }); return }
        if (scenario === 'bad-frame') { process.stdout.write(`${JSON.stringify({ nonce, type: 'ready', port: options.credential })}\n`); return }
        if (scenario === 'oversized') { process.stdout.write(options.credential.repeat(2048)); return }
        if (scenario === 'stalled-start') { emit({ type: 'stage', name: 'remote-start' }); emit({ type: 'stage', name: 'hermes-start' }); return }
        if (scenario === 'frame-exit') { emit({ type: 'error', code: 'hermes-exited', exit: 2, tail: ['sample start failure', `echoed ${options.credential} ${options.nonce}`, 'config at /home/sample-person/.hermes/config.yaml'] }); finish(); return }
        if (scenario.startsWith('frame-exit-named')) { process.stderr.write(whoTrace); emit({ type: 'error', code: 'hermes-exited', exit: 2, tail: ['serving sample-user on sample-remote.example.invalid', `bound 192.0.2.44:8642 and [2001:db8::7:1]:8642 for ${target}`] }); finish(); return }
        if (scenario === 'frame-host-key') { emit({ type: 'error', code: 'host-key-unknown', keyType: 'ssh-ed25519', fingerprint: fingerprint(hostKey) }); return }
        if (scenario !== 'timeout') {
          // A login banner may be valid JSON without being a record: a number, a word.
          process.stdout.write('A sample login banner\n42\n"sample"\n[1]\n')
          // What the real start script reads from the remote's own settings before serve.
          // `HERMES_SSH_MODEL=none` is a Hermes that cannot say its model.
          if (process.env.HERMES_SSH_MODEL !== 'none') emit({ type: 'model', ...JSON.parse(process.env.HERMES_SSH_MODEL ?? '{"provider":"openai-codex","model":"gpt-6-astra"}') })
          emit({ type: 'ready', port: Number(process.env.HERMES_SSH_REMOTE_PORT) })
          if (scenario === 'drop') setTimeout(() => process.exit(255), 150)
        }
      } else if (line === 'close') { finish() }
    }
  })
  process.stdin.on('end', finish)
}
setInterval(() => {}, 1000)
