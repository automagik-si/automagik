import { spawn as spawnChild } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import net from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { HERMES_DEADLINES } from './hermes-transport.js'
import { redactSshText } from './hermes-redact.js'
import { sshNames } from './hermes-ssh-names.js'

// The oldest Hermes release this adapter speaks to, proven by real runs and kept in one
// place: the contract file. The start script refuses an older one before it starts serve.
export const HERMES_MINIMUM = JSON.parse(readFileSync(new URL('./hermes-contract.json', import.meta.url), 'utf8')).minimumRelease

// One kind per stage that can stop an SSH connection. A kind names what the person can
// do next; `unknown` is only what none of them explains.
const messages = Object.freeze({
  'host-key-unknown': 'This computer has not connected to this SSH host before. Check its host key and trust it before connecting again.',
  'host-key-changed': 'The SSH host key has changed. Verify the host in a terminal before trying again.',
  'auth-failed': 'SSH key authentication failed. Check the SSH alias or identity file and load your key into your SSH agent.',
  'interactive-auth': 'SSH requires an interactive check. Complete it once in a terminal, then try this connection again.',
  'hermes-not-found': 'Hermes was not found on the remote computer through its login shell (bash -lc “command -v hermes”). Install it there or check the Hermes executable path.',
  'serve-not-running': 'Hermes is not running on the remote computer. Start it there with “hermes serve”, then try again.',
  'serve-gateway-running': 'Hermes is running there as a gateway, but no “hermes serve” is running. Start “hermes serve” there, then try again.',
  'serve-gateway': 'Hermes is running there as a gateway that owns its sessions. Start “hermes serve” there, then try again.',
  'serve-record': 'Hermes is not running there: its connection record or private token is stale. Start “hermes serve” there, then try again.',
  'serve-profiles': 'Hermes is running there, but its profiles could not be read. Run “hermes profile list” there, then try again.',
  'update-required': `Update Hermes on the remote computer to v${HERMES_MINIMUM} or newer. This connection cannot use an older Hermes.`,
  'version-unknown': `Hermes on the remote computer did not report a release number. This connection needs v${HERMES_MINIMUM} or newer.`,
  'unsupported-platform': 'This SSH connection requires a Linux or macOS remote with Python 3 and an existing Hermes installation.',
  'hermes-exited': 'Hermes stopped on the remote computer before it was ready.',
  'not-ready': 'Hermes started on the remote computer but was not ready within the connection deadline.',
  'port-missing': 'Hermes started on the remote computer but did not report the port it listens on.',
  handshake: 'The private start handshake with the remote computer failed.',
  tunnel: 'The SSH tunnel to the remote Hermes did not start listening.',
  'forward-conflict': 'A port forward from this host’s own SSH config could not start, so SSH closed the tunnel.',
  'remote-script': 'The start script stopped on the remote computer.',
  'invalid-details': 'Enter valid SSH details.',
  timeout: 'SSH did not become ready within the connection deadline. Check the remote computer and try again.',
  unreachable: 'SSH could not reach the remote computer. Check the SSH alias, network, port, and installed SSH client.',
  unknown: 'SSH could not start the remote Hermes connection. Check the connection details and try again.',
})
const publicCodes = {
  'host-key-unknown': 'bot/hermes-ssh-host-key-unknown', 'host-key-changed': 'bot/hermes-ssh-host-key', 'auth-failed': 'bot/hermes-ssh-auth',
  'hermes-not-found': 'bot/hermes-ssh-missing', 'interactive-auth': 'bot/hermes-ssh-interactive', 'update-required': 'bot/hermes-ssh-update', 'version-unknown': 'bot/hermes-ssh-version',
  'unsupported-platform': 'bot/hermes-ssh-platform', 'hermes-exited': 'bot/hermes-ssh-exited', 'not-ready': 'bot/hermes-ssh-not-ready',
  'port-missing': 'bot/hermes-ssh-port', handshake: 'bot/hermes-ssh-handshake', tunnel: 'bot/hermes-ssh-tunnel',
  'forward-conflict': 'bot/hermes-ssh-forward', 'remote-script': 'bot/hermes-ssh-script', 'invalid-details': 'bot/hermes-ssh-details',
  timeout: 'bot/hermes-ssh-timeout', unreachable: 'bot/hermes-ssh-unreachable', cleanup: 'bot/hermes-ssh-cleanup',
  'serve-not-running': 'bot/hermes-attach-not-running', 'serve-gateway': 'bot/hermes-attach-gateway',
  'serve-gateway-running': 'bot/hermes-attach-gateway-running',
  'serve-record': 'bot/hermes-attach-record', 'serve-profiles': 'bot/hermes-attach-profiles',
}
/** Every public SSH code, for the callers that pass a known kind through unchanged. */
export const HERMES_SSH_CODES = Object.freeze(['bot/hermes-ssh', ...Object.values(publicCodes)])
// The kinds the remote start script may report. Sign-in and host-key verdicts are this
// computer's own: a remote can never claim one.
const REMOTE_KINDS = new Set(['hermes-not-found', 'update-required', 'version-unknown', 'unsupported-platform', 'hermes-exited', 'not-ready', 'port-missing', 'handshake', 'remote-script', 'timeout', 'unknown'])
const REMOTE_STAGES = new Set(['remote-start', 'hermes-start'])
const cleanupMessage = 'Remote Hermes cleanup could not be confirmed. Check the remote computer before connecting again; background remote work may continue.'
const failure = (kind, text = messages[kind] ?? messages.unknown, detail) => Object.assign(new Error(text), { code: publicCodes[kind] ?? 'bot/hermes-ssh', sshError: kind, ...(detail ? { sshDetail: detail } : {}) })

const LINE_MAX = 240
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/
export { redactSshText }
const lineList = (value, secrets, max) => (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/))
  .filter(line => typeof line === 'string').map(line => redactSshText(line, secrets).trim().slice(0, LINE_MAX)).filter(Boolean).slice(-max)
// SSH's own verdict lines, never its debug trace (which repeats the start script).
const plainLines = stderr => String(stderr ?? '').split(/\r?\n/).filter(line => line.trim() && !/^debug\d+:/.test(line))
const sshTail = (stderr, secrets) => {
  const plain = plainLines(stderr)
  return lineList(plain.length ? plain : String(stderr ?? '').split(/\r?\n/).filter(line => line.trim() && !/Sending command:/.test(line)).slice(-2), secrets, 3)
}
// The host and user of a failed connection stay on the error, host side only and never
// on its detail: they are what a stored diagnostics line must not repeat.
const named = (error, names) => Object.defineProperty(error, 'sshNames', { value: names, enumerable: false, configurable: true })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  // Startup can be cancelled before its next stage begins awaiting this promise.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const safeField = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)

function destination(input) {
  if (!input || typeof input !== 'object') throw failure('invalid-details', 'Enter an SSH host or config alias.')
  let host = typeof input.host === 'string' ? input.host.trim() : ''
  let user = typeof input.user === 'string' ? input.user.trim() : ''
  if (host.includes('@')) {
    const parts = host.split('@')
    if (parts.length !== 2) throw failure('invalid-details', 'Enter a valid SSH host or config alias.')
    user ||= parts[0]
    host = parts[1]
  }
  if (!host || host.startsWith('-') || !/^[a-zA-Z0-9_.:[\]-]+$/.test(host)
    || (user && (!/^[a-zA-Z0-9_.-]+$/.test(user) || user.startsWith('-')))) throw failure('invalid-details', 'Enter a valid SSH host or config alias and user.')
  const args = []
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    if (!/^\d+$/.test(String(input.port)) || !Number.isSafeInteger(Number(input.port)) || Number(input.port) < 1 || Number(input.port) > 65535) throw failure('invalid-details', 'Enter a valid SSH port.')
    args.push('-p', String(Number(input.port)))
  }
  for (const name of ['identityFile', 'hermesPath']) if (input[name] !== undefined && input[name] !== '' && !safeField(input[name])) throw failure('invalid-details', 'Enter a valid identity file or remote Hermes path.')
  if (input.recordDir !== undefined && input.recordDir !== '' && (!safeField(input.recordDir) || !input.recordDir.startsWith('/') || input.recordDir.split('/').includes('..'))) throw failure('invalid-details', 'The serve record folder must be an absolute remote folder.')
  if (input.identityFile) {
    if (input.identityFile.startsWith('-')) throw failure('invalid-details', 'Enter a valid identity file path.')
    args.push('-i', input.identityFile)
  }
  if (input.hermesHome && (!safeField(input.hermesHome) || !input.hermesHome.startsWith('/') || input.hermesHome.split('/').some(part => part === '..' || part === '.'))) throw failure('invalid-details', 'Hermes home must be an absolute remote folder.')
  return { args, target: user ? `${user}@${host}` : host, hermesPath: input.hermesPath || '', hermesHome: input.hermesHome || '', recordDir: input.recordDir || '' }
}

// This is our POSIX remote supervisor, not upstream code. Its private stdin owns the
// lease: EOF, close, a signal or expired heartbeats stops the child it launched.
// Never forward Hermes output: only bounded protocol records reach the local host.
const supervisor = String.raw`
import json, os, re, select, shutil, signal, subprocess, sys, time
class Stop(Exception): pass
class Fault(Exception):
    def __init__(self, code, **detail):
        self.code = code
        self.detail = detail
child = None
folder = None
nonce = ""
token = ""
clean = True
last_ping = time.monotonic()
control = 15.0
grace = 2.0
cancel = 3.5

def emit(kind, **values):
    try:
        print(json.dumps(dict(type=kind, nonce=nonce, **values)), flush=True)
    except (BrokenPipeError, OSError):
        pass

def interrupted(signum, frame): raise Stop()
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(sig, interrupted)

def check_input():
    global last_ping
    while select.select([sys.stdin.fileno()], [], [], 0)[0]:
        data = os.read(sys.stdin.fileno(), 8192)
        if not data or b"close" in data: raise Stop()
        last_ping = time.monotonic()
    if time.monotonic() - last_ping > control: raise Stop()

def can_observe():
    return all(hasattr(os, name) for name in ("waitid", "WNOWAIT", "P_PID", "WEXITED", "WNOHANG"))

def child_status():
    # Observe without reaping: the owned leader, even a zombie, pins this group ID
    # until the last signal. Never signal a numeric group after releasing that pin.
    # The answer is its exit code (a signal as a negative number), or None while it runs.
    if can_observe():
        info = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if info is None: return None
        return info.si_status if info.si_code == getattr(os, "CLD_EXITED", 1) else -info.si_status
    # Older macOS Python lacks WNOWAIT: retain the unreaped leader until
    # private control EOF/close or the heartbeat deadline instead of polling it.
    return None

def tail(data):
    # The last lines Hermes wrote, for a failed start only: never this connection's
    # token or nonce, and the home folder by its short name. All of it is cleaned before the
    # end is taken: a cut inside a token or a home would leave the rest of it unrecognised.
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", data.decode("utf-8", "replace"))
    for secret in (token, nonce):
        if isinstance(secret, str) and secret: text = text.replace(secret, "[hidden]")
    home = os.path.expanduser("~")
    if len(home) > 1: text = text.replace(home, "~")
    lines = [re.sub(r"[\x00-\x1f\x7f]", " ", line).strip()[:240] for line in text[-8192:].splitlines()]
    return [line for line in lines if line][-8:]

def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False

def probe(argv):
    check_input()
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=control, check=False)
    except subprocess.TimeoutExpired:
        raise Fault("timeout")
    check_input()
    return result.stdout[:65536].decode("utf-8", "replace").strip() if result.returncode == 0 else ""

try:
    initial = bytearray()
    while not initial.endswith(b"\n"):
        part = os.read(sys.stdin.fileno(), 1)
        if not part: raise Stop()
        initial.extend(part)
        if len(initial) > 16384: raise Fault("handshake")
    try:
        options = json.loads(initial)
        nonce = options["nonce"]
        token = options["credential"]
        shaped = isinstance(nonce, str) and isinstance(token, str) and re.fullmatch(r"[0-9a-f]{16}", nonce) and re.fullmatch(r"[0-9a-f]{64}", token)
    except (ValueError, KeyError, TypeError):
        shaped = False
    if not shaped:
        token = ""
        raise Fault("handshake")
    emit("stage", name="remote-start")
    control = max(0.05, float(options["controlMs"]) / 1000)
    grace = max(0.01, float(options["cancelMs"]) / 1000 * 0.4)
    cancel = max(0.05, float(options["cancelMs"]) / 1000 * 0.7)
    until = time.monotonic() + float(options["startMs"]) / 1000
    wanted = options.get("minVersion")
    if not isinstance(wanted, str) or not re.fullmatch(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", wanted): raise Fault("handshake")
    minimum = tuple(int(part) for part in wanted.split("."))
    if sys.platform not in ("linux", "darwin"): raise Fault("unsupported-platform")
    explicit = options.get("hermesPath", "")
    if explicit:
        candidates = [os.path.expanduser(explicit)]
    else:
        located = probe(["bash", "-lc", "command -v hermes"])
        candidates = ([located.splitlines()[-1]] if located else []) + [os.path.expanduser("~/.local/bin/hermes"), "/usr/local/bin/hermes", os.path.expanduser("~/.hermes/hermes-agent/venv/bin/hermes")]
    hermes = next((p for p in candidates if os.path.isfile(p) and os.access(p, os.X_OK)), None)
    if not hermes: raise Fault("hermes-not-found")
    # The release Hermes itself reports, before anything is started: "hermes --version"
    # prints "Hermes Agent v<major>.<minor>.<patch>...". A build that names no release (a
    # checkout without tags) is reported as it is, never taken for a new or an old one.
    shown = probe([hermes, "--version"])
    method = re.search(r"^Install method: ([a-z0-9-]{1,32})[ \t]*$", shown, re.M)
    facts = dict(minimum=wanted, method=method.group(1) if method else "")
    release = re.search(r"^Hermes Agent v([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})(?![0-9.])", shown, re.M)
    if not release: raise Fault("version-unknown", tail=tail(shown.split("\n", 1)[0].encode("utf-8", "replace")), **facts)
    facts["version"] = ".".join(str(int(part)) for part in release.groups())
    if tuple(int(part) for part in release.groups()) < minimum: raise Fault("update-required", **facts)
    help_text = probe([hermes, "serve", "--help"])
    if "--ssh-session-token-file" not in help_text or "--ssh-owner-nonce" not in help_text: raise Fault("update-required", **facts)
    check_input()
    # Hermes reads its one-shot token only from its own runtime folder, and refuses any
    # other path: ~/.hermes/desktop-ssh/<32 hex>/<16 hex>.token, the folder this user's
    # alone (0700). Hermes removes the token once read; the folder goes with this script.
    home = options.get("hermesHome") or os.path.expanduser("~/.hermes")
    if not isinstance(home, str) or not os.path.isabs(home): raise Fault("handshake")
    if options.get("hermesHome") and not os.path.isfile(os.path.join(home, "config.yaml")): raise Fault("hermes-not-found")
    root = os.path.join(home, "desktop-ssh")
    os.makedirs(root, mode=0o700, exist_ok=True)
    made = os.path.join(root, os.urandom(16).hex())
    os.mkdir(made, 0o700)
    folder = made
    os.chmod(folder, 0o700)
    token_path = os.path.join(folder, nonce + ".token")
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w") as handle: handle.write(token)
    env = os.environ.copy()
    env["HERMES_HOME"] = home
    env.pop("HERMES_PROFILE", None)
    env["HERMES_DESKTOP"] = "1"
    env.pop("HERMES_DESKTOP_DEV_SERVER", None)
    check_input()
    emit("stage", name="hermes-start")
    child = subprocess.Popen([hermes, "--profile", "default", "serve", "--isolated", "--host", "127.0.0.1", "--port", "0", "--ssh-session-token-file", token_path, "--ssh-owner-nonce", nonce], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env)
    output = b""
    ready = False
    output_open = True
    output_ended = None
    status = None
    while True:
        status = child_status()
        if status is not None: break
        check_input()
        if not ready and time.monotonic() >= until: raise Fault("not-ready", tail=tail(output))
        # Its output closed before the ready line: where the exit cannot be observed
        # that is the exit; where it can, Hermes is still running without a port.
        if not ready and output_ended is not None and time.monotonic() - output_ended > 1.0:
            raise Fault("port-missing" if can_observe() else "hermes-exited", tail=tail(output))
        readable, _, _ = select.select([sys.stdin] + ([child.stdout] if output_open else []), [], [], min(control / 4, 0.25))
        if sys.stdin in readable: check_input()
        if child.stdout in readable:
            data = os.read(child.stdout.fileno(), 8192)
            if not data:
                output_open = False
                output_ended = time.monotonic()
            output = (output + data)[-65536:]
            if not ready:
                found = re.search(rb"HERMES_(?:BACKEND|DASHBOARD)_READY port=([0-9]+)(?:\r?\n)", output)
                if found:
                    port = int(found.group(1))
                    if not 0 < port < 65536: raise Fault("port-missing", tail=tail(output))
                    ready = True
                    emit("ready", port=port)
    if not ready: raise Fault("hermes-exited", exit=status, tail=tail(output))
except Stop:
    pass
except Fault as error:
    emit("error", code=error.code, **error.detail)
except Exception as error:
    # The kind of the fault and where this script stopped: never its message.
    step = error.__traceback__
    while step.tb_next is not None and step.tb_next.tb_frame.f_code.co_filename == step.tb_frame.f_code.co_filename: step = step.tb_next
    emit("error", code="remote-script", name=type(error).__name__, errno=getattr(error, "errno", None), line=step.tb_lineno)
finally:
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT): signal.signal(sig, signal.SIG_IGN)
    if child is not None:
        stop_until = time.monotonic() + cancel
        try:
            # The unreaped leader stays owned even when it exited before close or
            # on TERM. Descendants can outlive it and still need the group KILL.
            os.killpg(child.pid, signal.SIGTERM)
            term_until = min(stop_until, time.monotonic() + grace)
            while time.monotonic() < term_until:
                time.sleep(min(0.01, max(0, term_until - time.monotonic())))
            os.killpg(child.pid, signal.SIGKILL)
        except OSError:
            clean = False
        try:
            child.wait(timeout=max(0.001, stop_until - time.monotonic()))
            # The ownership pin has now been released. Only observe from here:
            # another process may reuse this numeric ID; never signal it again.
            while group_exists(child.pid) and time.monotonic() < stop_until:
                time.sleep(min(0.01, max(0, stop_until - time.monotonic())))
            clean = clean and not group_exists(child.pid)
        except (OSError, subprocess.TimeoutExpired):
            clean = False
    if folder:
        try: shutil.rmtree(folder)
        except OSError: clean = False
    emit("closed", clean=clean)
`

const CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* has changed|Offending .*key in|host key .*revoked/i
const FORWARD = /cannot listen to port|Could not request local forwarding|remote port forwarding failed|Address already in use/i

// The server's key as SSH's own trace names it, and the identity files it offered.
function offered(stderr) {
  const key = /^debug1: Server host key: ([a-z0-9@.-]{3,64}) (SHA256:[A-Za-z0-9+/]{43})\s*$/m.exec(stderr)
  const identities = [], seen = new Set()
  let agentKeys = 0
  for (const line of String(stderr).split(/\r?\n/)) {
    const found = /^debug1: (?:Offering public key|Trying private key): (.+)$/.exec(line)
    if (!found) continue
    if (/ agent\s*$/.test(found[1])) { agentKeys++; continue }
    const path = found[1].replace(/ [A-Z0-9-]+ SHA256:\S+.*$/, '').trim()
    const name = path.split(/[/\\]/).at(-1)
    if (!/^[~/]|^[A-Za-z]:\\/.test(path) || !/^[\w.@+-]{1,64}$/.test(name) || seen.has(name)) continue
    seen.add(name)
    if (identities.length < 6) identities.push(name)
  }
  return { key: key ? { keyType: key[1], fingerprint: key[2] } : undefined, identities, agentKeys }
}

// SSH's verdict comes from its own lines, never its debug trace: the trace of a
// successful sign-in also says "keyboard-interactive" and "timeout".
function sshFailure(stderr, { role = 'supervisor', exit, started = false, localPort } = {}) {
  const plain = plainLines(stderr).join('\n'), facts = offered(stderr)
  if (CHANGED.test(plain)) return failure('host-key-changed')
  if (/No (?:\S+ )?host key is known/i.test(plain)) return failure('host-key-unknown', undefined, facts.key)
  // A refused key with neither line is treated as changed: it is never offered for trust.
  if (/Host key verification failed|strict checking/i.test(plain)) return failure('host-key-changed')
  if (/interactive|verification|two.factor|tailscale.*check/i.test(plain)) return failure('interactive-auth')
  if (/Permission denied|Authentication failed|no supported authentication|Too many authentication failures/i.test(plain)) return failure('auth-failed', undefined, { identities: facts.identities, agentKeys: facts.agentKeys })
  if (/python3.*(not found|not recognized)|No such file.*python3|command not found: python3/i.test(plain)) return failure('unsupported-platform')
  if (FORWARD.test(plain)) {
    const port = Number(/(?:cannot listen to port:?|listen port|\]:)\s*(\d{1,5})\b/.exec(plainLines(stderr).filter(line => FORWARD.test(line)).join('\n'))?.[1])
    const own = role === 'tunnel' && (!port || port === localPort)
    return failure(own ? 'tunnel' : 'forward-conflict', undefined, port && !own ? { port } : undefined)
  }
  if (/timed out|timeout/i.test(plain)) return failure('timeout')
  if (/resolve hostname|Connection refused|Network is unreachable|No route to host|ENOENT/i.test(plain)) return failure('unreachable')
  if (role === 'tunnel') return failure('tunnel')
  // The start script ended by itself: its exit status is the remote command's, not SSH's.
  if (started && Number.isSafeInteger(exit) && exit !== 255) return failure('remote-script', undefined, { exit })
  return failure('unknown')
}

async function allocateLoopbackPort() {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    return server.address().port
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)) }
}

/** A trusted factory: callers may allow its numeric-loopback HTTP address only. */
export async function startHermesSsh(ssh, {
  signal, deadlines = HERMES_DEADLINES, spawn = spawnChild, allocatePort = allocateLoopbackPort,
  sshCommand = 'ssh', env = process.env, randomBytes = cryptoRandomBytes, minimum = HERMES_MINIMUM,
} = {}) {
  let config
  try { config = destination(ssh) } catch (error) { throw Object.assign(error, { sshStage: 'details' }) }
  const limits = { ...HERMES_DEADLINES, ...deadlines }
  const until = Date.now() + limits.start
  const credential = randomBytes(32).toString('hex'), nonce = randomBytes(8).toString('hex')
  const ready = deferred(), forwarded = deferred(), cancelled = deferred()
  const children = []
  let remote, tunnel, heartbeat, closing, stopping = false, clean = false, sawProtocol = false, noRemote = false
  let inputSent = false, readySeen = false, stage = 'ssh-sign-in', remoteEntry, tunnelEntry
  const secrets = [credential, nonce]
  // The stage a failure stopped at is fixed when it happens: closing moves nothing.
  const at = error => { if (error && typeof error === 'object') error.sshStage ??= stage; return error }
  const common = ['-T', '-v', '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ConnectionAttempts=1', '-o', `ConnectTimeout=${Math.max(1, Math.ceil(limits.control / 1000))}`, '-o', `ServerAliveInterval=${Math.max(1, Math.floor(limits.control / 3000))}`, '-o', 'ServerAliveCountMax=2', ...config.args]
  const bounded = async (promise, ms, interruptible = true) => {
    let timer
    try { return await Promise.race([promise, ...(interruptible ? [cancelled.promise] : []), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('timeout')), Math.max(1, ms)) })]) }
    finally { clearTimeout(timer) }
  }
  const fail = error => {
    at(error)
    cancelled.reject(error); ready.reject(error); forwarded.reject(error)
    if (!stopping) void close().catch(() => {})
  }
  const launch = args => {
    const child = spawn(sshCommand, args, { env: { ...env, LC_ALL: 'C' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const ended = deferred()
    const entry = { child, ended: ended.promise, stderr: '', commandSent: false, edge: '' }
    children.push(entry)
    child.on('error', () => { noRemote ||= child === remote && !child.pid; if (!child.pid) ended.resolve(); fail(failure('unreachable')) })
    child.on('close', code => {
      ended.resolve()
      if (!stopping) {
        const error = sshFailure(entry.stderr, { role: child === tunnel ? 'tunnel' : 'supervisor', exit: code, started: entry.commandSent || sawProtocol, localPort: entry.localPort })
        // No start script ran, so nothing remote is left to clean: SSH itself gave up before
        // it sent the command (255, whatever its reason), or the command ended by itself
        // without one record (no Python, a script that never started), its exit status
        // delivered after all its output.
        if (child === remote && !sawProtocol && Number.isSafeInteger(code) && (code !== 255 || !entry.commandSent)) noRemote = true
        fail(error)
      }
    })
    // Authentication failure can close stdin before SSH's actionable stderr/exit.
    // The close handler (or the bounded stage deadline) owns that verdict.
    child.stdin.on('error', () => {})
    child.stderr.on('data', data => {
      const text = String(data)
      // The marker may be split between two chunks of the trace.
      entry.commandSent ||= /Sending command:/.test(entry.edge + text)
      entry.edge = text.slice(-32)
      entry.stderr = (entry.stderr + text).slice(-65536)
      if (child === tunnel && /Local forwarding listening on 127\.0\.0\.1 port (\d+)\./.test(entry.stderr)) {
        const port = Number(/Local forwarding listening on 127\.0\.0\.1 port (\d+)\./.exec(entry.stderr)[1])
        if (port === entry.localPort) forwarded.resolve()
      }
    })
    return entry
  }
  const exit = () => {
    try { remote?.stdin.destroy(); remote?.kill('SIGTERM'); tunnel?.kill('SIGTERM') } catch {}
  }
  function close() {
    if (closing) return closing
    stopping = true
    clearInterval(heartbeat)
    signal?.removeEventListener('abort', abort)
    process.removeListener('exit', exit)
    closing = (async () => {
      try { remote?.stdin.end('close\n') } catch {}
      try { tunnel?.kill('SIGTERM') } catch {}
      const stopUntil = Date.now() + limits.cancel
      const ended = Promise.all(children.map(entry => entry.ended))
      let stopped = false
      try { await bounded(ended, limits.cancel * 0.8, false); stopped = true } catch {}
      if (!stopped) {
        for (const entry of children) { try { entry.child.kill('SIGKILL') } catch {} }
        try { await bounded(ended, stopUntil - Date.now(), false); stopped = true } catch {}
      }
      if (!stopped || (inputSent && !clean && !noRemote)) throw Object.assign(failure('cleanup', cleanupMessage), { cleanupUnknown: true, localClosed: ended })
    })()
    return closing
  }
  const abort = () => { fail(failure('unknown', 'SSH connection was cancelled.')) }
  if (signal?.aborted) throw failure('unknown', 'SSH connection was cancelled.')
  signal?.addEventListener('abort', abort, { once: true })
  process.once('exit', exit)
  try {
    // This connection only runs the start script: a port forward from the host's own
    // SSH config belongs to the person's terminal sessions, and one already in use
    // there would otherwise end this connection (ExitOnForwardFailure).
    remoteEntry = launch([...common, '-o', 'ClearAllForwardings=yes', '--', config.target, `exec python3 -u -c ${quote(supervisor)}`])
    remote = remoteEntry.child
    let carry = ''
    remote.stdout.on('data', chunk => {
      carry += String(chunk)
      if (Buffer.byteLength(carry) > 65536) { carry = ''; fail(failure('handshake')); return }
      let newline
      while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
        let frame
        try { frame = JSON.parse(line) } catch { continue } // Ignore login-shell banners.
        // A banner line can be valid JSON (a number, a quoted word): only an object is a record.
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue
        if (frame.nonce !== nonce) { fail(failure('handshake')); return }
        sawProtocol = true
        if (stage === 'ssh-sign-in') stage = 'remote-start'
        if (frame.type === 'ready' && !readySeen && Number.isSafeInteger(frame.port) && frame.port > 0 && frame.port < 65536) { readySeen = true; stage = 'tunnel'; ready.resolve(frame.port) }
        else if (frame.type === 'stage' && REMOTE_STAGES.has(frame.name)) { if (!readySeen) stage = frame.name }
        else if (frame.type === 'closed' && typeof frame.clean === 'boolean') clean = frame.clean
        else if (frame.type === 'error' && REMOTE_KINDS.has(frame.code)) {
          // Only bounded, shaped facts: an exit code, the fault's class, and Hermes's last
          // lines with this connection's secrets, credential shapes and home paths removed.
          const detail = {}
          if (Number.isSafeInteger(frame.exit) && Math.abs(frame.exit) < 1024) detail.exit = frame.exit
          if (Array.isArray(frame.tail)) detail.hermes = lineList(frame.tail.slice(-8), secrets, 8)
          if (typeof frame.name === 'string' && /^[A-Za-z_]\w{0,40}$/.test(frame.name)) detail.fault = frame.name
          if (Number.isSafeInteger(frame.errno) && frame.errno >= 0 && frame.errno < 4096) detail.errno = frame.errno
          if (Number.isSafeInteger(frame.line) && frame.line > 0 && frame.line < 10000) detail.line = frame.line
          // The release Hermes reported, the one this adapter needs, and how it was installed.
          for (const key of ['version', 'minimum']) if (typeof frame[key] === 'string' && RELEASE.test(frame[key])) detail[key] = frame[key]
          if (typeof frame.method === 'string' && /^[a-z0-9-]{1,32}$/.test(frame.method)) detail.install = frame.method
          fail(failure(frame.code, undefined, detail))
        }
        else { fail(failure('handshake')); return }
      }
    })
    inputSent = true
    // Hermes's own deadline ends a little before this computer's, so a slow start is
    // reported by the start script, with Hermes's last lines, not by a bare timeout here.
    const startMs = Math.max(1, Math.floor(limits.start - Math.min(limits.control / 2, limits.start * 0.15)))
    remote.stdin.write(`${JSON.stringify({ nonce, credential, hermesPath: config.hermesPath, hermesHome: config.hermesHome, minVersion: minimum, startMs, controlMs: limits.control, cancelMs: limits.cancel })}\n`)
    heartbeat = setInterval(() => { if (!stopping) { try { remote.stdin.write('ping\n') } catch { fail(failure('unknown')) } } }, Math.max(10, Math.floor(limits.control / 3)))
    const remotePort = await bounded(ready.promise, until - Date.now())
    const localPort = await bounded(Promise.resolve(allocatePort()), Math.min(limits.control, until - Date.now()))
    if (stopping || signal?.aborted) throw failure('unknown', 'SSH connection was cancelled.')
    if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65535) throw failure('tunnel')
    tunnelEntry = launch([...common, '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', config.target])
    tunnel = tunnelEntry.child
    tunnelEntry.localPort = localPort
    tunnel.stdout.resume()
    // The forward is proven by SSH's own listening line: no line in time is no tunnel.
    await bounded(forwarded.promise, Math.min(limits.control, until - Date.now())).catch(error => { throw error?.sshError === 'timeout' && !stopping ? failure('tunnel') : error })
    if (stopping || remote.exitCode !== null || tunnel.exitCode !== null) throw failure(remote.exitCode !== null ? 'unknown' : 'tunnel')
    return { address: `http://127.0.0.1:${localPort}`, credential, close }
  } catch (error) {
    at(error)
    let cleanupError
    try { await close() } catch (failure) { cleanupError = failure }
    const safe = error?.code?.startsWith('bot/hermes-ssh') ? error : at(failure('unknown'))
    // SSH's last own lines, for the diagnostics line and the person's screen: the
    // tunnel's when it is what failed, with this connection's secrets removed.
    const said = ['tunnel', 'forward-conflict'].includes(safe.sshError) && tunnelEntry ? tunnelEntry.stderr : remoteEntry?.stderr
    const lines = sshTail(said, secrets)
    safe.sshDetail = { ...safe.sshDetail, ...(lines.length ? { ssh: lines } : {}) }
    named(safe, sshNames(`${remoteEntry?.stderr ?? ''}\n${tunnelEntry?.stderr ?? ''}`))
    if (cleanupError) { safe.message += ` ${cleanupMessage}`; safe.cleanupUnknown = true; safe.localClosed = cleanupError.localClosed }
    throw safe
  }
}

const KEY_TYPE = /^[a-z0-9@.-]{3,64}$/
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
const fingerprintOf = blob => `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`

function collect(spawn, command, args, { env, signal, ms }) {
  return new Promise((resolve, reject) => {
    let child, timer, stdout = '', stderr = '', settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (error) { try { child?.kill('SIGKILL') } catch {} reject(error) } else resolve(value)
    }
    const abort = () => finish(failure('unknown', 'SSH connection was cancelled.'))
    if (signal?.aborted) { abort(); return }
    try { child = spawn(command, args, { env: { ...env, LC_ALL: 'C' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch { finish(failure('unreachable')); return }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(failure('timeout')), Math.max(1, ms))
    child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-65536) })
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-65536) })
    child.on('error', () => finish(failure('unreachable')))
    child.on('close', code => finish(undefined, { code, stdout, stderr }))
  })
}

/**
 * Trust one new host key: exactly the key whose type and fingerprint the person was shown.
 * SSH itself writes the key it is offered into a throwaway file, in its own known-hosts
 * form; only a line whose key matches is copied to the person's file. The person's files
 * stay listed, so SSH still refuses a host whose key differs from one already saved, and
 * nothing signs in: every sign-in method is off and the command is `true`.
 */
export async function trustHermesSshHostKey(ssh, expected, {
  signal, deadlines = HERMES_DEADLINES, spawn = spawnChild, sshCommand = 'ssh', env = process.env, home = homedir(), temp = tmpdir(),
} = {}) {
  const stage = 'host-key'
  // Filled as SSH names them: its config's host and user, then its trace's.
  const names = { hosts: [], users: [] }
  const stop = (kind, text, detail) => named(Object.assign(failure(kind, text, detail), { sshStage: stage }), names)
  let config
  try { config = destination(ssh) } catch (error) { throw Object.assign(error, { sshStage: 'details' }) }
  if (!KEY_TYPE.test(expected?.keyType ?? '') || !FINGERPRINT.test(expected?.fingerprint ?? '')) throw stop('invalid-details', 'This host key cannot be trusted from here. Connect again.')
  const limits = { ...HERMES_DEADLINES, ...deadlines }
  const options = { env, signal, ms: limits.control }
  // Where this host's own config keeps the person's known hosts.
  const shown = await collect(spawn, sshCommand, ['-G', ...config.args, '--', config.target], options)
  Object.assign(names, sshNames('', shown.stdout))
  const listed = /^userknownhostsfile\s+(.+)$/im.exec(shown.stdout)?.[1].trim().split(/\s+/) ?? []
  const files = (listed.length ? listed : ['~/.ssh/known_hosts', '~/.ssh/known_hosts2']).map(path => path.replace(/^~(?=\/|$)/, home).replaceAll('%d', home))
  if (files.some(path => /^(?:none|\/dev\/null)$/i.test(path))) throw stop('host-key-unknown', undefined, { unsaved: true })
  if (files.some(path => !isAbsolute(path) || /["%\x00-\x1f\x7f]/.test(path))) throw stop('host-key-unknown', undefined, { unsaved: true })
  const folder = await mkdtemp(join(temp, 'automagik-host-key-'))
  try {
    const scratch = join(folder, 'known_hosts')
    if (/["\x00-\x1f\x7f]/.test(scratch)) throw stop('unknown')
    const pathWord = path => /\s/.test(path) ? `"${path}"` : path
    const probe = await collect(spawn, sshCommand, ['-T', '-v', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${[scratch, ...files].map(pathWord).join(' ')}`, '-o', 'UpdateHostKeys=no',
      '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ConnectionAttempts=1',
      '-o', `ConnectTimeout=${Math.max(1, Math.ceil(limits.control / 1000))}`, ...config.args, '--', config.target, 'true'], options)
    const detail = { ssh: sshTail(probe.stderr, []) }
    const traced = sshNames(probe.stderr)
    Object.assign(names, { hosts: [...names.hosts, ...traced.hosts], users: [...names.users, ...traced.users] })
    const plain = plainLines(probe.stderr).join('\n')
    if (CHANGED.test(plain)) throw stop('host-key-changed', undefined, detail)
    const text = await readFile(scratch, 'utf8').catch(() => '')
    if (Buffer.byteLength(text) > 65536) throw stop('host-key-changed', undefined, detail)
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    const kept = []
    for (const line of lines) {
      const [hosts, type, blob] = line.split(/\s+/)
      // A marker line or any other key than the one shown: nothing is trusted.
      if (!hosts || hosts.startsWith('@') || type !== expected.keyType || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob ?? '') || fingerprintOf(blob) !== expected.fingerprint) {
        throw stop('host-key-changed', 'This SSH host now presents a different key than the one shown. Verify the host in a terminal before trying again.', { ...detail, mismatch: true })
      }
      kept.push(`${hosts} ${type} ${blob}`)
    }
    if (!kept.length) {
      // SSH saved nothing. A refused sign-in (every method is off) or a clean exit means
      // the key is already known, trusted meanwhile; anything else is its own failure.
      const error = sshFailure(probe.stderr)
      if (probe.code === 0 || error.sshError === 'auth-failed') return { trusted: true, added: 0 }
      throw named(Object.assign(error, { sshStage: stage, sshDetail: { ...error.sshDetail, ...detail } }), names)
    }
    const target = files[0]
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    const before = await readFile(target, 'utf8').catch(() => '')
    await appendFile(target, `${before && !before.endsWith('\n') ? '\n' : ''}${kept.join('\n')}\n`, { mode: 0o600 })
    return { trusted: true, added: kept.length }
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}

// Shared with the attach path: the same SSH details, the same one SSH command, and the
// same failure vocabulary. Nothing here starts or stops anything on the remote.
export {
  destination as hermesSshDestination,
  failure as hermesSshFailure,
  sshFailure as hermesSshFailureFromStderr,
  named as hermesSshNamed,
  sshTail as hermesSshTail,
  allocateLoopbackPort as hermesSshAllocatePort,
  quote as hermesSshQuote,
}
