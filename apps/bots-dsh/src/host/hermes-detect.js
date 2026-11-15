import { spawn as spawnChild } from 'node:child_process'
import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { HERMES_DEADLINES } from './hermes-transport.js'
import {
  hermesSshDestination, hermesSshFailure, hermesSshFailureFromStderr, hermesSshNamed, hermesSshQuote, hermesSshTail,
} from './hermes-ssh.js'

// Detection is read-only over the same SSH path as attach. It finds every Hermes home the
// OS user has a config for, each home's own serve record (a serve keeps its record in its
// own state folder, so one home never masks another), and each home's profiles through
// `hermes profile list`. It opens config.yaml and `host-serve.json` records and nothing
// else: never .env, auth.json, a token, a key. It starts, stops or signals nothing.
const supervisor = String.raw`
import json, os, re, shlex, socket, subprocess, sys, time
class Fault(Exception):
    def __init__(self, code, **detail):
        self.code = code
        self.detail = detail
nonce = ""

def emit(kind, **values):
    try:
        print(json.dumps(dict(type=kind, nonce=nonce, **values)), flush=True)
    except (BrokenPipeError, OSError):
        pass

def run(argv, timeout, env=None):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=max(0.2, timeout), check=False, env=env)
    except (OSError, subprocess.TimeoutExpired):
        return None, "", ""
    return (result.returncode,
            result.stdout[:262144].decode("utf-8", "replace"),
            result.stderr[-8192:].decode("utf-8", "replace"))

def text(value, limit=200):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", " ", value).strip()[:limit]

def locate(hermes_path, timeout):
    if hermes_path:
        candidates = [os.path.expanduser(hermes_path)]
    else:
        code, out, _ = run(["bash", "-lc", "command -v hermes"], timeout)
        located = out.strip().splitlines()[-1] if code == 0 and out.strip() else ""
        root = os.path.expanduser("~")
        candidates = ([located] if located else []) + [
            os.path.join(root, ".local", "bin", "hermes"),
            "/usr/local/bin/hermes",
            os.path.join(root, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
        ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    return ""

SKIP = {".git", ".venv", "venv", "node_modules", "sessions", "logs", "cache", "backups",
        "hermes-agent", "plugins", "skills", "dist", "build", "__pycache__"}

def walk_records(home, timeout):
    """host-serve.json files under this home itself: the sandbox's own record is read where it is."""
    found, seen, deadline = [], 0, time.monotonic() + timeout
    stack = [(home, 0)]
    while stack and seen < 4000 and time.monotonic() < deadline:
        folder, depth = stack.pop()
        seen += 1
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_file(follow_symlinks=False) and entry.name == "host-serve.json":
                    found.append(folder)
                elif depth < 6 and entry.is_dir(follow_symlinks=False) and entry.name not in SKIP:
                    stack.append((entry.path, depth + 1))
            except OSError:
                continue
    return found

def read_record(folder):
    path = os.path.join(folder, "host-serve.json")
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > 65536:
            return None
        with open(path, "r", encoding="utf-8-sig") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(record, dict) or record.get("role") != "serve":
        return None
    port, pid = record.get("port"), record.get("pid")
    if not isinstance(port, int) or isinstance(port, bool) or port <= 0 or port >= 65536:
        return None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    profiles = [value for value in (record.get("profiles") or [])
                if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value)]
    home = record.get("home") if isinstance(record.get("home"), str) else ""
    return {"port": port, "pid": pid, "profiles": profiles, "home": home,
            "recordDir": folder}

def read_text(path, limit=524288):
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > limit:
            return ""
        with open(path, "r", encoding="utf-8-sig", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return ""

def scalar(raw):
    value = raw.strip()
    if value[:1] in "\"'":
        quote = value[0]
        end = value.find(quote, 1)
        return value[1:end].strip() if end > 0 else value[1:].strip()
    return re.split(r"\s+#", value, 1)[0].strip()

def yaml_model(source):
    """The profile's own model from config.yaml fields: default (or model) and provider."""
    try:
        import yaml
        data = yaml.safe_load(source)
        if isinstance(data, dict):
            model = data.get("model")
            if isinstance(model, str):
                return model.strip(), ""
            if isinstance(model, dict):
                return (str(model.get("default") or model.get("model") or "").strip(),
                        str(model.get("provider") or "").strip())
    except Exception:
        pass
    model = provider = ""
    inside = False
    for raw in source.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            inside = bool(re.match(r"^model\s*:", line))
            if inside:
                rest = line.split(":", 1)[1].strip()
                value = scalar(rest) if rest and not rest.startswith(("{", "|", ">")) else ""
                if value:
                    return value, ""
            continue
        if not inside:
            continue
        found = re.match(r"^\s+(default|model|provider)\s*:\s*(.+?)\s*$", line)
        if not found:
            continue
        if found.group(1) == "provider":
            provider = scalar(found.group(2))
        elif not model:
            model = scalar(found.group(2))
    return model, provider

def config_model(home, ident):
    base = home if ident == "default" else os.path.join(home, "profiles", ident)
    return yaml_model(read_text(os.path.join(base, "config.yaml")))

def parse_list(source):
    rows = {}
    for line in source.splitlines():
        raw = line.rstrip()
        stripped = raw.strip()
        if not stripped or stripped.startswith("No profiles found"):
            continue
        if "Model" in stripped and stripped.startswith("Profile"):
            continue
        if set(stripped) <= set("-─ "):
            continue
        found = re.match(
            r"^\s*(?P<marker>◆)?\s*(?P<label>.+?)\s+(?P<model>\S+)\s+(?P<gateway>running|stopped)\s+(?P<alias>\S+)\s+(?P<dist>\S.*?)\s*$",
            raw)
        if not found:
            continue
        label = found.group("label").strip()
        alias = found.group("alias").strip()
        named = re.match(r"^(?P<display>.+?)\s+\((?P<id>[^()]+)\)$", label)
        if named:
            ident, name = named.group("id").strip(), named.group("display").strip()
        elif re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", alias):
            ident, name = alias, label
        else:
            ident, name = label, label
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", ident):
            continue
        model = "" if found.group("model") == "—" else found.group("model")
        rows[ident] = {"id": ident, "name": text(name, 100) or ident,
                       "model": text(model, 200), "gateway": found.group("gateway") == "running"}
    return rows

def profiles_of(hermes, home, timeout):
    if not hermes:
        return {}
    env = os.environ.copy()
    env["HERMES_HOME"] = home
    code, out, _ = run([hermes, "profile", "list"], timeout, env)
    return parse_list(out) if code == 0 else {}

def status_pids(hermes, home, timeout):
    """Live serve PIDs from hermes serve --status; None when that scan is unavailable."""
    if not hermes:
        return None
    env = os.environ.copy()
    env["HERMES_HOME"] = home
    code, out, _ = run([hermes, "serve", "--status"], timeout, env)
    if code != 0:
        return None
    pids = set()
    for line in out.splitlines():
        found = re.match(r"^\s*PID\s+(\d+)\s+\[\s*serve\s*\]", line)
        if found:
            pids.add(int(found.group(1)))
    return pids

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def listening(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False

def same(left, right):
    try:
        return os.path.realpath(left) == os.path.realpath(right)
    except OSError:
        return left == right

def inside(folder, home):
    try:
        return os.path.commonpath([os.path.realpath(folder), os.path.realpath(home)]) == os.path.realpath(home)
    except (OSError, ValueError):
        return False

def start_command(home, ident, has_record):
    default = os.path.join(os.path.expanduser("~"), ".hermes")
    if same(home, default):
        return default_start(ident, has_record)
    if has_record:
        # This home's serve already runs: this profile joins it by name.
        return "hermes --profile %s serve" % shlex.quote(ident)
    return "HERMES_HOME=%s hermes serve" % shlex.quote(home)


def default_start(ident, has_record):
    if has_record:
        return "hermes --profile %s serve" % shlex.quote(ident)
    return "hermes serve"

def user_lock_dirs():
    folders = []
    def add(path):
        if isinstance(path, str) and path.startswith("/") and path not in folders:
            folders.append(path)
    override = os.environ.get("HERMES_GATEWAY_LOCK_DIR", "").strip()
    if override:
        add(override)
    state = os.environ.get("XDG_STATE_HOME", "").strip()
    if not os.path.isabs(state):
        state = os.path.join(os.path.expanduser("~"), ".local", "state")
    add(os.path.join(state, "hermes", "gateway-locks"))
    return folders

def home_lock_dirs(home):
    return [os.path.join(home, relative) for relative in (
        "gateway-locks",
        os.path.join(".local", "state", "hermes", "gateway-locks"),
        os.path.join("state", "hermes", "gateway-locks"),
        os.path.join(".state", "hermes", "gateway-locks"),
    )]

def beside_dir(home):
    """The record folder next to the home: <parent>/gateway-locks, a sibling."""
    return os.path.join(os.path.dirname(os.path.normpath(home)), "gateway-locks")

def candidate_homes(explicit, extra=()):
    homes = []
    def add(path):
        if not isinstance(path, str) or not path.startswith("/") or path in homes:
            return
        if not os.path.isdir(path):
            return
        if os.path.isfile(os.path.join(path, "config.yaml")) or walk_records(path, 2.0):
            homes.append(path)
    add(explicit)
    for path in extra:
        add(path)
    add(os.environ.get("HERMES_HOME", "").strip())
    add(os.path.join(os.path.expanduser("~"), ".hermes"))
    share = os.path.join(os.path.expanduser("~"), ".local", "share")
    try:
        for entry in sorted(os.listdir(share)):
            add(os.path.join(share, entry, "hermes"))
    except OSError:
        pass
    return homes

try:
    initial = bytearray()
    while not initial.endswith(b"\n"):
        part = os.read(0, 1)
        if not part:
            raise Fault("handshake")
        initial.extend(part)
        if len(initial) > 16384:
            raise Fault("handshake")
    try:
        options = json.loads(bytes(initial))
        nonce = options["nonce"]
        hermes_path = options.get("hermesPath", "")
        control = max(0.05, float(options["controlMs"]) / 1000)
        deadline = time.monotonic() + max(0.05, float(options["startMs"]) / 1000)
        shaped = isinstance(nonce, str) and re.fullmatch(r"[0-9a-f]{16}", nonce)
    except (ValueError, KeyError, TypeError):
        shaped = False
    if not shaped or not isinstance(hermes_path, str):
        raise Fault("handshake")
    if sys.platform not in ("linux", "darwin"):
        raise Fault("unsupported-platform")
    emit("stage", name="detect-homes")
    hermes = locate(hermes_path, control)
    extra = options.get("extraHomes")
    extra_homes = []
    if isinstance(extra, list):
        for value in extra[:20]:
            if isinstance(value, str) and value.startswith("/") and ".." not in value.split("/"):
                extra_homes.append(value)
    homes = candidate_homes(options.get("hermesHome", ""), extra_homes)
    records, seen = {}, set()
    def remember(folder, owner=""):
        """Read one record folder; owner is the home whose own tree holds it.

        A record found in a home's own state tree BELONGS to that home. The home field
        inside it is the serve's own report and may be a sandbox path that also exists on
        the host; it never credits the record to that host folder.
        """
        try:
            key = os.path.realpath(folder)
        except OSError:
            key = folder
        if key in seen:
            existing = records.get(key)
            if existing is None or existing.get("owner") or not owner:
                return
        seen.add(key)
        record = read_record(folder)
        if record is None:
            return
        record["owner"] = owner
        records[key] = record
    for folder in user_lock_dirs():
        remember(folder)
    # A beside folder is the same path for every home under one parent. It belongs to
    # the only home with that parent; with two homes there it is ambiguous and no home
    # takes it, so the answer never depends on the order the homes were found.
    beside_owners = {}
    for home in list(homes):
        try:
            key = os.path.realpath(beside_dir(home))
        except OSError:
            key = beside_dir(home)
        beside_owners.setdefault(key, []).append(home)
    for home in list(homes):
        for folder in home_lock_dirs(home):
            remember(folder, home)
        try:
            key = os.path.realpath(beside_dir(home))
        except OSError:
            key = beside_dir(home)
        if len(beside_owners.get(key, [])) == 1:
            remember(beside_dir(home), home)
        for folder in walk_records(home, min(3.0, control)):
            remember(folder, home)
    # Hermes's serve writes no home field (0.23.x and current main), so a nameless
    # record in the account folder is the DEFAULT home's own serve. A record that names
    # another existing home is left for attribution (a home owning a different serve
    # keeps it). The default home is the one Hermes uses with no HERMES_HOME override.
    # Only the login environment decides the default home: a saved pick must never change it.
    default_home = os.environ.get("HERMES_HOME", "").strip()
    if not isinstance(default_home, str) or not default_home.startswith("/"):
        default_home = os.path.join(os.path.expanduser("~"), ".hermes")
    shared_keys = set()
    for folder in user_lock_dirs():
        try:
            shared_keys.add(os.path.realpath(folder))
        except OSError:
            shared_keys.add(folder)
    for key, record in records.items():
        if record.get("owner") or key not in shared_keys:
            continue
        named = record.get("home") or ""
        if named.startswith("/") and os.path.isdir(named) and not same(named, default_home):
            continue
        if default_home in homes:
            owned = [item for item in records.values() if item.get("owner") == default_home]
            if not owned or any(item["pid"] == record["pid"] for item in owned):
                record["owner"] = default_home
    record_dirs = list(records.values())
    # Only a record in the shared account folder may name a home to ask: a structural
    # record's reported home is its sandbox's own path and must not add a host home.
    for record in record_dirs:
        if record.get("owner"):
            continue
        named = record.get("home") or ""
        if named.startswith("/") and os.path.isdir(named) and named not in homes and len(homes) < 12:
            homes.append(named)
    if len(homes) > 12:
        homes = homes[:12]
    emit("stage", name="detect-profiles")
    profiles = {}
    for home in homes:
        budget = min(20.0, control, max(0.2, deadline - time.monotonic()))
        profiles[home] = profiles_of(hermes, home, budget) if time.monotonic() < deadline else {}
        if not profiles[home] and os.path.isfile(os.path.join(home, "config.yaml")):
            model, provider = config_model(home, "default")
            profiles[home] = {"default": {"id": "default", "name": "default", "model": model,
                                          "provider": provider, "gateway": False}}
    emit("stage", name="detect-serves")
    attributed = dict((home, []) for home in homes)
    for record in record_dirs:
        target = record.get("owner") or ""
        if target and target not in attributed:
            target = ""
        if not target:
            # The record lives in the shared account folder; its own report may name the
            # home that wrote it. A home already served by a distinct record is not re-owned.
            named = record.get("home") or ""
            if named.startswith("/") and os.path.isdir(named):
                if named not in attributed and len(homes) < 12:
                    homes.append(named)
                    attributed[named] = []
                    profiles[named] = profiles_of(hermes, named, min(20.0, control))
                owned = [item for item in record_dirs if item.get("owner") == named]
                if named in attributed and (not owned or any(item["pid"] == record["pid"] for item in owned)):
                    target = named
            if not target:
                served = set(record.get("profiles") or [])
                matches = [home for home in homes if served and served <= set(profiles[home].keys())]
                if len(matches) == 1:
                    target = matches[0]
        # A record no home owns is not shown as a bot: a row under someone else's home
        # path or id could replace that home's own bot and take another serve's token.
        if target and not any(item["recordDir"] == record["recordDir"] for item in attributed[target]):
            attributed[target].append(record)
    emitted = 0
    for home in homes:
        budget = min(20.0, control, max(0.2, deadline - time.monotonic()))
        pids = status_pids(hermes, home, budget) if time.monotonic() < deadline else None
        live = []
        for record in attributed[home]:
            running = alive(record["pid"]) and listening(record["port"])
            if running and pids:
                running = record["pid"] in pids
            record["running"] = running
            if running:
                live.append(record)
        rows = dict(profiles.get(home) or {})
        for record in attributed[home]:
            for ident in record.get("profiles") or []:
                rows.setdefault(ident, {"id": ident, "name": ident, "model": "", "gateway": False})
        sandbox = any(record.get("home") and not same(record["home"], home) for record in attributed[home])
        emit("home", home=home, state="running" if live else "stopped", sandbox=sandbox,
             serve={"port": live[0]["port"], "recordDir": live[0]["recordDir"],
                    "served": live[0].get("profiles") or []} if live else None)
        for ident in list(rows.keys())[:50]:
            row = rows[ident]
            served_by = [record for record in live
                         if not record.get("profiles") or ident in record["profiles"]]
            model, provider = config_model(home, ident)
            model = model or row.get("model") or ""
            running = bool(served_by)
            emit("bot", home=home, id=ident, name=text(row.get("name"), 100) or ident,
                 model=text(model, 200), provider=text(provider, 100), running=running,
                 recordDir=served_by[0]["recordDir"] if running else "",
                 port=served_by[0]["port"] if running else 0,
                 start=start_command(home, ident, bool(attributed[home])))
            emitted += 1
    emit("ready", homes=len(homes), bots=emitted, hermes=bool(hermes))
except Fault as error:
    emit("error", code=error.code, **error.detail)
except Exception as error:
    step = error.__traceback__
    while step.tb_next is not None and step.tb_next.tb_frame.f_code.co_filename == step.tb_frame.f_code.co_filename:
        step = step.tb_next
    emit("error", code="remote-script", name=type(error).__name__, line=step.tb_lineno)
`

const DETECT_KINDS = new Set(['hermes-not-found', 'unsupported-platform', 'handshake', 'timeout', 'remote-script', 'unknown'])
const HOME_LIMIT = 12, BOT_LIMIT = 60
const clean = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const homePath = value => clean(value, 4096) && value.startsWith('/')
const recordFolder = value => clean(value, 4096) && value.startsWith('/') && !value.split('/').includes('..')

function botOf(value) {
  if (!value || typeof value !== 'object') return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.id ?? '')) return undefined
  if (!homePath(value.home)) return undefined
  const running = value.running === true
  const chosen = running && recordFolder(value.recordDir) && Number.isSafeInteger(value.port) && value.port > 0 && value.port < 65536
  // A running bot without its own record folder and port is not a shape this reader emits.
  if (running && !chosen) return undefined
  return {
    home: value.home, id: value.id,
    name: clean(value.name, 100) ? value.name : value.id,
    model: clean(value.model, 200) ? value.model : '',
    provider: clean(value.provider, 100) ? value.provider : '',
    running,
    recordDir: chosen ? value.recordDir : '', port: chosen ? value.port : 0,
    start: clean(value.start, 500) ? value.start : '',
  }
}

/**
 * Detect every Hermes bot this SSH host offers, read-only.
 *
 * The remote reader opens each home's `config.yaml`, each `host-serve.json` record it finds
 * under that home (or the account's own lock folder), and runs only `hermes profile list`,
 * `hermes serve --status` and the login shell's `command -v hermes`. It never opens .env,
 * auth files or a token, and never starts, stops or signals a Hermes process.
 */
export async function detectHermesBots(ssh, {
  signal, deadlines = HERMES_DEADLINES, spawn = undefined, sshCommand = 'ssh', env = process.env,
  randomBytes, onProgress = () => {}, extraHomes = [],
} = {}) {
  randomBytes ??= cryptoRandomBytes
  spawn ??= spawnChild
  let config
  try { config = hermesSshDestination(ssh) } catch (error) { throw Object.assign(error, { sshStage: 'details' }) }
  const limits = { ...HERMES_DEADLINES, ...deadlines }
  const until = Date.now() + limits.start
  const nonce = randomBytes(8).toString('hex')
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    void promise.catch(() => {})
    return { promise, resolve, reject }
  }
  const ready = deferred(), ended = deferred()
  let child, closing, stopping = false, expected = false, stage = 'ssh-sign-in'
  const at = error => { if (error && typeof error === 'object') error.sshStage ??= stage; return error }
  const common = ['-T', '-v', '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ConnectionAttempts=1', '-o', `ConnectTimeout=${Math.max(1, Math.ceil(limits.control / 1000))}`, '-o', `ServerAliveInterval=${Math.max(1, Math.floor(limits.control / 3000))}`, '-o', 'ServerAliveCountMax=2', ...config.args]
  const timer = setTimeout(() => fail(hermesSshFailure('timeout')), limits.start)
  function fail(error) {
    at(error)
    ready.reject(error); ended.reject(error)
    if (!stopping) void close().catch(() => {})
  }
  function close() {
    if (closing) return closing
    stopping = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    closing = (async () => {
      try { child?.stdin.end() } catch {}
      try { child?.kill('SIGTERM') } catch {}
      try { await Promise.race([ended.promise, new Promise(resolve => setTimeout(resolve, Math.max(1, limits.cancel * 0.8)))]) } catch {}
    })()
    return closing
  }
  const abort = () => fail(hermesSshFailure('unknown', 'SSH connection was cancelled.'))
  if (signal?.aborted) throw hermesSshFailure('unknown', 'SSH connection was cancelled.')
  signal?.addEventListener('abort', abort, { once: true })
  const homes = new Map(), bots = new Map()
  const said = { stderr: '' }
  try {
    child = spawn(sshCommand, [...common, '-o', 'ClearAllForwardings=yes', '--', config.target, `exec python3 -u -c ${hermesSshQuote(supervisor)}`], {
      env: { ...env, LC_ALL: 'C' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', () => { if (!child.pid) { ended.resolve(); fail(hermesSshFailure('unreachable')) } })
    child.on('close', code => {
      ended.resolve()
      if (stopping || expected) return
      fail(hermesSshFailureFromStderr(said.stderr, { role: 'supervisor', exit: code, started: true }))
    })
    child.stdin.on('error', () => {})
    child.stderr.on('data', data => { said.stderr = (said.stderr + String(data)).slice(-65536) })
    let carry = ''
    child.stdout.on('data', chunk => {
      carry += String(chunk)
      if (Buffer.byteLength(carry) > 2 * 1024 * 1024) { fail(hermesSshFailure('handshake')); return }
      let newline
      while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue
        if (frame.nonce !== nonce) { fail(hermesSshFailure('handshake')); return }
        if (stage === 'ssh-sign-in') stage = 'detect-homes'
        if (frame.type === 'stage' && ['detect-homes', 'detect-profiles', 'detect-serves'].includes(frame.name)) {
          stage = frame.name
          onProgress(frame.name === 'detect-homes' ? 'homes' : frame.name === 'detect-profiles' ? 'profiles' : 'serves')
          continue
        }
        if (frame.type === 'home') {
          if (!homePath(frame.home) || homes.size >= HOME_LIMIT) { fail(hermesSshFailure('handshake')); return }
          const serve = frame.serve && typeof frame.serve === 'object' && recordFolder(frame.serve.recordDir)
            && Number.isSafeInteger(frame.serve.port) && frame.serve.port > 0 && frame.serve.port < 65536
            ? { port: frame.serve.port, recordDir: frame.serve.recordDir,
              served: Array.isArray(frame.serve.served) ? frame.serve.served.filter(item => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item)).slice(0, 50) : [] }
            : undefined
          if (!homes.has(frame.home)) homes.set(frame.home, { home: frame.home, state: frame.state === 'running' ? 'running' : 'stopped', sandbox: frame.sandbox === true, serve })
          continue
        }
        if (frame.type === 'bot') {
          const bot = botOf(frame)
          if (!bot || !homes.has(bot.home) || bots.size >= BOT_LIMIT) { fail(hermesSshFailure('handshake')); return }
          // First row wins: a refused record appended later can never replace a home's bot.
          const key = `${bot.home}\n${bot.id}`
          if (!bots.has(key)) bots.set(key, bot)
          continue
        }
        if (frame.type === 'ready') { stage = 'ready'; expected = true; ready.resolve(); continue }
        if (frame.type === 'error' && DETECT_KINDS.has(frame.code)) {
          const detail = {}
          if (Array.isArray(frame.tail)) detail.ssh = frame.tail.slice(-3).map(value => clean(value, 240)).filter(Boolean)
          if (typeof frame.name === 'string' && /^[A-Za-z_]\w{0,40}$/.test(frame.name)) detail.fault = frame.name
          if (Number.isSafeInteger(frame.line) && frame.line > 0 && frame.line < 10000) detail.line = frame.line
          fail(hermesSshFailure(frame.code, undefined, detail))
          return
        }
        fail(hermesSshFailure('handshake'))
        return
      }
    })
    const startMs = Math.max(1, Math.floor(limits.start - Math.min(limits.control / 2, limits.start * 0.15)))
    const extras = (Array.isArray(extraHomes) ? extraHomes : []).slice(0, 20).filter(value => homePath(value) && !value.split('/').includes('..'))
    child.stdin.write(`${JSON.stringify({ nonce, hermesPath: config.hermesPath, hermesHome: config.hermesHome, extraHomes: extras, startMs, controlMs: limits.control })}\n`)
    await Promise.race([ready.promise, new Promise((_, reject) => setTimeout(() => reject(hermesSshFailure('timeout')), Math.max(1, until - Date.now())))])
    if (stopping) throw hermesSshFailure('unknown', 'SSH connection was cancelled.')
    return { homes: [...homes.values()], bots: [...bots.values()] }
  } catch (error) {
    at(error)
    try { await close() } catch {}
    const safe = error?.code?.startsWith('bot/hermes') ? error : at(hermesSshFailure('unknown'))
    const lines = hermesSshTail(said?.stderr ?? '', [nonce])
    safe.sshDetail = { ...safe.sshDetail, ...(lines.length ? { ssh: lines } : {}) }
    hermesSshNamed(safe, { hosts: [], users: [] })
    throw safe
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    try { await close() } catch {}
  }
}

export { supervisor as detectSupervisor }
