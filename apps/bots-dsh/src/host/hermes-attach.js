import { spawn as spawnChild } from 'node:child_process'
import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import { HERMES_DEADLINES } from './hermes-transport.js'
import {
  HERMES_MINIMUM, redactSshText, hermesSshAllocatePort, hermesSshDestination, hermesSshFailure,
  hermesSshFailureFromStderr, hermesSshNamed, hermesSshQuote, hermesSshTail,
} from './hermes-ssh.js'

// Attach never starts, restarts or stops Hermes. Its one remote command reads the record
// and private token a running `hermes serve` wrote for this OS user's clients, proves the
// recorded owner answers with that token, reads the profiles, and exits. The only live
// process afterwards is this computer's SSH tunnel. Closing it speaks to no Hermes process.
const supervisor = String.raw`
import hashlib, json, os, re, socket, stat, subprocess, sys, time, urllib.request
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
            result.stdout[:131072].decode("utf-8", "replace"),
            result.stderr[-8192:].decode("utf-8", "replace"))

def tail(text, secret=""):
    # The exact host token is removed here, before the frame leaves the remote: an error
    # tail can reach this computer before the token frame does, so shape masking alone is
    # not enough.
    if isinstance(secret, str) and secret:
        text = text.replace(secret, "[hidden]")
    lines = [re.sub(r"[\x00-\x1f\x7f]", " ", line).strip()[:240] for line in text.splitlines()]
    return [line for line in lines if line][-3:]

def locate(hermes_path, timeout):
    if hermes_path:
        candidates = [os.path.expanduser(hermes_path)]
    else:
        code, out, _ = run(["bash", "-lc", "command -v hermes"], timeout)
        located = out.strip().splitlines()[-1] if code == 0 and out.strip() else ""
        home = os.path.expanduser("~")
        candidates = ([located] if located else []) + [
            os.path.join(home, ".local", "bin", "hermes"),
            "/usr/local/bin/hermes",
            os.path.join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes"),
        ]
    for path in candidates:
        if path and os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise Fault("hermes-not-found")

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

def records_of(folder):
    """(record, why) for one folder; why names a gateway record or a home mismatch."""
    try:
        with open(os.path.join(folder, "host-serve.json"), "r", encoding="utf-8-sig") as handle:
            record = json.load(handle)
    except (OSError, ValueError, TypeError):
        record = None
    if not isinstance(record, dict):
        # Only a running serve publishes this record. A gateway's record is not read: this
        # app opens host-serve.json and host-serve.token, and nothing else in that folder.
        return None, ""
    if record.get("role") == "gateway":
        return None, "gateway"
    if record.get("role") != "serve":
        return None, ""
    port = record.get("port")
    pid = record.get("pid")
    if not isinstance(port, int) or port <= 0 or port >= 65536 or not isinstance(pid, int) or pid <= 0:
        return None, ""
    return record, ""

def inside(folder, home):
    if not isinstance(folder, str) or not folder or not isinstance(home, str) or not home:
        return False
    try:
        return os.path.commonpath([os.path.realpath(folder), os.path.realpath(home)]) == os.path.realpath(home)
    except (OSError, ValueError):
        return False

def same_home(record, launch_home):
    """Strict: the record names THIS existing home. A nameless or unknown path is none."""
    recorded = record.get("home")
    if not isinstance(recorded, str) or not recorded.startswith("/") or not launch_home:
        return False
    if not isinstance(launch_home, str) or not launch_home.startswith("/"):
        return False
    # A sandbox names a path inside itself; it cannot be compared to a host home, so a
    # record that does not name this host path is never used without a picked folder.
    if not os.path.isdir(recorded) or not os.path.isdir(launch_home):
        return False
    return os.path.realpath(recorded) == os.path.realpath(launch_home)

def default_home():
    env = os.environ.get("HERMES_HOME", "").strip()
    if env.startswith("/"):
        return env
    return os.path.join(os.path.expanduser("~"), ".hermes")

def is_default_home(home):
    if not isinstance(home, str) or not home.startswith("/"):
        return False
    try:
        return os.path.realpath(home) == os.path.realpath(default_home())
    except OSError:
        return home == default_home()

def is_hermes_home(path):
    # A Hermes home by its own marks, never by a generic folder alone:
    # (i) SOUL.md, seeded by initialize_home -> _ensure_default_soul_md on every load;
    # (ii) config.yaml plus at least two of Hermes's skeleton folders (sessions, memories,
    #      cron, logs), which initialize_home creates even for a fresh home;
    # (iii) config.yaml plus state.db, Hermes's own state file (_HERMES_HOME_MARKERS).
    # A bare config.yaml, a bare gateway-locks, or config.yaml plus one generic folder is an
    # unrelated tool and never makes a beside folder ambiguous.
    if not os.path.isdir(path):
        return False
    if os.path.isfile(os.path.join(path, "SOUL.md")):
        return True
    if not os.path.isfile(os.path.join(path, "config.yaml")):
        return False
    skeleton = sum(1 for name in ("sessions", "memories", "cron", "logs")
                   if os.path.isdir(os.path.join(path, name)))
    return skeleton >= 2 or os.path.isfile(os.path.join(path, "state.db"))

def has_hermes_sibling(home):
    """Any other Hermes home in the same parent, following links.

    The same on-disk fact detection uses: beside a home that shares its parent with
    another Hermes home, gateway-locks is ambiguous and is never this home's record.
    """
    path = os.path.normpath(home)
    parent, name = os.path.dirname(path), os.path.basename(path)
    try:
        entries = list(os.scandir(parent))
        own = os.path.realpath(path)
    except OSError:
        return False
    for entry in entries:
        if entry.name == name:
            continue
        try:
            if not is_hermes_home(entry.path):
                continue
            if os.path.realpath(entry.path) != own:
                return True
        except OSError:
            continue
    return False

def serve_pids(hermes_bin, home, timeout):
    """Live serve PIDs for one home, or None when its own status cannot be read."""
    if not hermes_bin:
        return None
    env = os.environ.copy()
    env["HERMES_HOME"] = home
    code, out, _ = run([hermes_bin, "serve", "--status"], timeout, env)
    if code != 0:
        return None
    pids = set()
    for line in out.splitlines():
        found = re.match(r"^\s*PID\s+(\d+)\s+\[\s*serve\s*\]", line)
        if found:
            pids.add(int(found.group(1)))
    return pids

def home_spellings(launch_home):
    written = os.path.normpath(launch_home)
    homes = [written]
    try:
        real = os.path.realpath(written)
    except OSError:
        real = written
    if real not in homes:
        homes.append(real)
    return homes

def beside_spellings(folder, launch_home):
    """The spellings of this home whose own parent holds this beside folder."""
    folder = os.path.normpath(folder)
    if os.path.basename(folder) != "gateway-locks":
        return []
    matches = []
    try:
        own = os.path.realpath(launch_home)
    except OSError:
        own = ""
    for home in home_spellings(launch_home):
        if os.path.dirname(folder) == os.path.dirname(home) and home not in matches:
            matches.append(home)
    # A hand-made call may name the real path while the folder is beside a LINK to it.
    try:
        for entry in os.scandir(os.path.dirname(folder)):
            try:
                if entry.is_symlink() and own and os.path.realpath(entry.path) == own:
                    if entry.path not in matches:
                        matches.append(entry.path)
            except OSError:
                continue
    except OSError:
        pass
    return matches


def normalized_home(path):
    """One spelling per home: resolve, drop trailing/double/dot segments, follow symlinks."""
    if not isinstance(path, str) or not path.startswith("/"):
        return ""
    value = os.path.normpath(path)
    try:
        if os.path.exists(value):
            value = os.path.realpath(value)
    except OSError:
        pass
    return value

def candidate_homes(explicit, extra=()):
    homes, seen, spellings = [], set(), {}
    def add(path):
        if not isinstance(path, str) or not path.startswith("/"):
            return
        spelled = os.path.normpath(path)
        home = normalized_home(spelled)
        if not home:
            return
        if home in seen:
            if spelled not in spellings.get(home, []):
                spellings.setdefault(home, []).append(spelled)
            return
        if not os.path.isdir(home):
            return
        seen.add(home)
        if os.path.isfile(os.path.join(home, "config.yaml")) or walk_records(home, 2.0):
            homes.append(home)
            spellings.setdefault(home, []).append(spelled)
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
    return homes, spellings

def home_lock_dirs(home):
    return [os.path.join(home, relative) for relative in (
        "gateway-locks",
        os.path.join(".local", "state", "hermes", "gateway-locks"),
        os.path.join("state", "hermes", "gateway-locks"),
        os.path.join(".state", "hermes", "gateway-locks"),
    )]


def state_folder(explicit, launch_home, extra=()):
    """The chosen serve's own record folder.

    An explicit folder must belong to the picked home before its token is read.
    Without one, the home's own state folders win over shared account folders.
    """
    candidates = None
    def candidates_of():
        nonlocal candidates
        if candidates is None:
            candidates = candidate_homes(launch_home, extra)
        return candidates
    def shares_beside(folder, home):
        homes, spellings = candidates_of()
        own, target = os.path.realpath(home), os.path.realpath(folder)
        for candidate in homes:
            if os.path.realpath(candidate) == own:
                continue
            for spelled in set((spellings.get(candidate) or []) + home_spellings(candidate)):
                beside = os.path.join(os.path.dirname(spelled), "gateway-locks")
                if os.path.realpath(beside) == target:
                    return True
        return False
    def proven_beside(record, home):
        """A shared beside record is this home's only when its own serve status names the
        recorded pid and no other candidate home's does. Two claimants prove nothing."""
        until = min(start_until, time.monotonic() + control)
        claimants = []
        for candidate in candidates_of()[0][:12]:
            budget = min(20.0, until - time.monotonic())
            if budget < 0.2:
                return False
            pids = serve_pids(hermes, candidate, budget)
            if pids is not None and record.get("pid") in pids:
                claimants.append(candidate)
        return len(claimants) == 1 and os.path.realpath(claimants[0]) == os.path.realpath(home)
    if explicit:
        if not isinstance(explicit, str) or not explicit.startswith("/"):
            raise Fault("serve-record")
        record, why = records_of(explicit)
        if record is None and why == "gateway":
            raise Fault("serve-gateway")
        if record is None:
            raise Fault("serve-not-running", absent=True)
        home = launch_home if isinstance(launch_home, str) and launch_home.startswith("/") else default_home()
        folder = os.path.normpath(explicit)
        # Conventional folders belong to the picked home even when they link elsewhere.
        if any(folder in home_lock_dirs(spelled) for spelled in home_spellings(home)) or inside(folder, home):
            return explicit, record
        beside = beside_spellings(folder, home)
        if beside:
            shared = any(has_hermes_sibling(spelled) for spelled in beside) or shares_beside(folder, home)
            if shared and not proven_beside(record, home):
                raise Fault("serve-record")
            return explicit, record
        homes, spellings = candidates_of()
        other_homes = {os.path.realpath(candidate) for candidate in homes}
        own_chain = set()
        ancestor = os.path.realpath(home)
        while ancestor not in own_chain:
            own_chain.add(ancestor)
            ancestor = os.path.dirname(ancestor)
        ancestor = os.path.dirname(os.path.realpath(folder))
        while True:
            if ancestor not in own_chain and (ancestor in other_homes or is_hermes_home(ancestor)):
                raise Fault("serve-record")
            parent = os.path.dirname(ancestor)
            if parent == ancestor:
                break
            ancestor = parent
        named = record.get("home")
        if isinstance(named, str) and named.startswith("/") and os.path.isdir(named):
            if same_home(record, home):
                return explicit, record
            raise Fault("serve-record")
        default = normalized_home(default_home())
        if default in homes or os.path.realpath(home) == os.path.realpath(default):
            own_folders = []
            for spelled in set((spellings.get(default) or []) + home_spellings(default)):
                own_folders.extend(home_lock_dirs(spelled))
                beside = os.path.join(os.path.dirname(spelled), "gateway-locks")
                if not has_hermes_sibling(spelled) and not shares_beside(beside, default):
                    own_folders.append(beside)
            owned = [records_of(owned_folder)[0] for owned_folder in own_folders]
            if not any(item is not None and item["pid"] != record["pid"] for item in owned):
                if os.path.realpath(home) == os.path.realpath(default):
                    return explicit, record
                raise Fault("serve-record")
        served = {value for value in (record.get("profiles") or [])
                  if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value)}
        if not served:
            raise Fault("serve-record")
        matches = []
        until = min(start_until, time.monotonic() + control)
        for candidate in homes[:12]:
            budget = min(20.0, until - time.monotonic())
            if budget < 0.2:
                raise Fault("serve-record")
            env = os.environ.copy()
            env["HERMES_HOME"] = candidate
            code, out, _ = run([hermes, "profile", "list"], budget, env)
            if time.monotonic() >= until:
                raise Fault("serve-record")
            ids = {row["id"] for row in parse_list(out)} if code == 0 else set()
            if not ids and os.path.isfile(os.path.join(candidate, "config.yaml")):
                ids = {"default"}
            if served <= ids:
                matches.append(candidate)
        if len(matches) == 1 and os.path.realpath(matches[0]) == os.path.realpath(home):
            return explicit, record
        raise Fault("serve-record")
    own, shared = [], []
    def add(folder, target):
        if isinstance(folder, str) and folder.startswith("/") and folder not in target:
            target.append(folder)
    if isinstance(launch_home, str) and launch_home.startswith("/"):
        # The home as written and, when it is a symlink, the home it points at. A
        # home moved to another disk keeps its record beside the link, and a real
        # home keeps its own beside folder; each is taken only when it is the single
        # Hermes home under that parent.
        for home in home_spellings(launch_home):
            if not has_hermes_sibling(home) and not shares_beside(os.path.join(os.path.dirname(home), "gateway-locks"), launch_home):
                add(os.path.join(os.path.dirname(home), "gateway-locks"), own)
            add(os.path.join(home, "gateway-locks"), own)
            add(os.path.join(home, ".local", "state", "hermes", "gateway-locks"), own)
            add(os.path.join(home, "state", "hermes", "gateway-locks"), own)
            add(os.path.join(home, ".state", "hermes", "gateway-locks"), own)
    root = os.environ.get("HERMES_GATEWAY_LOCK_DIR", "").strip()
    if root:
        add(root, own if inside(root, launch_home) else shared)
    home = os.path.expanduser("~")
    state = os.environ.get("XDG_STATE_HOME", "").strip()
    if not state.startswith("/"):
        state = os.path.join(home, ".local", "state")
    account = os.path.join(state, "hermes", "gateway-locks")
    add(account, own if inside(account, launch_home) else shared)
    gateway = False
    # The home's own valid record always wins, even if a shared folder is listed first.
    for folder in own:
        record, why = records_of(folder)
        gateway = gateway or why == "gateway"
        if record is not None:
            return folder, record
    for folder in shared:
        if isinstance(launch_home, str) and launch_home.startswith("/"):
            spellings = beside_spellings(folder, launch_home)
            if spellings and (any(has_hermes_sibling(home) for home in spellings) or shares_beside(folder, launch_home)):
                continue
        record, why = records_of(folder)
        gateway = gateway or why == "gateway"
        if record is None:
            continue
        if not launch_home or same_home(record, launch_home):
            return folder, record
        # The serve writes no home field; a nameless (or sandbox-only) record in the
        # shared account folder belongs to the DEFAULT home, never to another one.
        named = record.get("home")
        unknown = not (isinstance(named, str) and named.startswith("/") and os.path.isdir(named))
        if unknown and is_default_home(launch_home):
            return folder, record
    if gateway:
        raise Fault("serve-gateway")
    raise Fault("serve-not-running", absent=True)

def read_token(folder, record):
    path = os.path.join(folder, "host-serve.token")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        raise Fault("serve-record")
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or (info.st_mode & 0o077) != 0:
            raise Fault("serve-record")
        token = os.read(fd, 4096).decode("utf-8-sig", "replace").strip()
    except (OSError, UnicodeDecodeError):
        raise Fault("serve-record")
    finally:
        os.close(fd)
    # The whole host's token, printable and bounded: never a path, never a control byte.
    if not re.fullmatch(r"[!-~]{16,512}", token):
        raise Fault("serve-record")
    expected = record.get("tokenFingerprint")
    # Hermes publishes the first 16 hex characters of the token's SHA-256; accept a full
    # digest too, so a record from either shape is checked rather than guessed.
    if isinstance(expected, str) and expected:
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        if digest[:len(expected)] != expected.lower():
            raise Fault("serve-record")
    return token

def prove_owner(port, pid, token):
    """Dial the recorded port and require the recorded owner to answer as itself."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass
    except OSError:
        raise Fault("serve-not-running")
    request = urllib.request.Request(
        "http://127.0.0.1:%d/api/host/identity" % port,
        headers={"Authorization": "Bearer " + token, "X-Hermes-Token": token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=2) as response:
            if response.status != 200:
                raise Fault("serve-not-running")
            payload = json.loads(response.read(65536).decode("utf-8", "replace"))
    except Fault:
        raise
    except Exception:
        raise Fault("serve-not-running")
    if not isinstance(payload, dict):
        raise Fault("serve-not-running")
    if payload.get("role") != "serve":
        raise Fault("serve-gateway")
    if payload.get("pid") != pid:
        raise Fault("serve-record")

def parse_list(text):
    rows = []
    for line in text.splitlines():
        raw = line.rstrip()
        stripped = raw.strip()
        if not stripped or stripped.startswith("No profiles found"):
            continue
        if "Model" in stripped and stripped.startswith("Profile"):
            continue
        if stripped and set(stripped) <= set("-─ "):
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
            ident, display = named.group("id").strip(), named.group("display").strip()
        elif re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", alias):
            # A display-only label borrows its profile id from the table alias, never
            # from the display name (which may contain spaces or be a person's label).
            ident, display = alias, label
        else:
            ident, display = label, label
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", ident):
            continue
        rows.append({"id": ident, "name": display or ident, "active": bool(found.group("marker")),
                     "running": found.group("gateway") == "running", "model": "" if found.group("model") == "—" else found.group("model"),
                     "provider": ""})
    return rows

def gateway_running(hermes, env, timeout):
    # Hermes's own Gateway column is the diagnosis; no CLI output leaves the remote.
    code, out, _ = run([hermes, "profile", "list"], timeout, env)
    return code == 0 and any(row.get("running") is True for row in parse_list(out))

def config_model(hermes, ident, timeout, env=None):
    code, out, _ = run([hermes, "-p", ident, "config", "get", "model", "--json"], timeout, env)
    if code == 0 and out.strip():
        try:
            value = json.loads(out.strip())
        except ValueError:
            value = None
        if isinstance(value, dict):
            model = value.get("default") or value.get("model")
            provider = value.get("provider")
            return (model if isinstance(model, str) else "", provider if isinstance(provider, str) else "")
        if isinstance(value, str):
            return value, ""
    # A release without --json prints the same fields as YAML (or one scalar). Read the
    # fields, never a joined provider:model string (colons and slashes occur inside ids).
    code, out, _ = run([hermes, "-p", ident, "config", "get", "model"], timeout, env)
    model = provider = ""
    lines = [line.strip() for line in out.splitlines() if line.strip()] if code == 0 else []
    for line in lines:
        found = re.match(r"^(default|model|provider)\s*:\s*(.+?)\s*$", line)
        if not found:
            continue
        value = found.group(2).strip().strip("\"'")
        if found.group(1) == "provider":
            provider = value
        elif not model:
            model = value
    # A bare scalar (no --json on an older release) is the model whole, colon and all:
    # llama9:70b-q4 and openrouter/auto are ids, not provider:model pairs. A field line
    # was already read above, so only a non-field single line falls through to here.
    if not model and not provider and len(lines) == 1 and not re.match(r"^(default|model|provider)\s*:", lines[0]):
        model = lines[0].strip("\"'")
    return model, provider

def show_profile(hermes, ident, timeout, env=None):
    """Display name, running state and model fields from the CLI's own profile show."""
    code, out, _ = run([hermes, "profile", "show", ident], timeout, env)
    if code != 0:
        return None
    display, running, model, provider = "", None, "", ""
    for line in out.splitlines():
        profile = re.match(r"^\s*Profile:\s*(.+?)\s*$", line)
        if profile:
            label = profile.group(1).strip()
            named = re.match(r"^(?P<display>.+?)\s+\((?P<id>[^()]+)\)$", label)
            display = named.group("display").strip() if named else label
        gateway = re.match(r"^\s*Gateway:\s*(running|stopped)\s*$", line)
        if gateway:
            running = gateway.group(1) == "running"
        shown_model = re.match(r"^\s*Model:\s*(.+?)\s*$", line)
        if shown_model:
            value = shown_model.group(1).strip()
            named_model = re.match(r"^(?P<model>.+?)\s+\((?P<provider>[^()]+)\)$", value)
            if named_model:
                model, provider = named_model.group("model").strip(), named_model.group("provider").strip()
            else:
                model = value
    return {"name": display, "running": running, "model": model, "provider": provider}

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
        start_until = time.monotonic() + max(0.05, float(options["startMs"]) / 1000)
        wanted = options["minVersion"]
        shaped = isinstance(nonce, str) and re.fullmatch(r"[0-9a-f]{16}", nonce)
    except (ValueError, KeyError, TypeError):
        shaped = False
    if not shaped:
        raise Fault("handshake")
    if sys.platform not in ("linux", "darwin"):
        raise Fault("unsupported-platform")
    if not isinstance(hermes_path, str):
        raise Fault("handshake")
    if not isinstance(wanted, str) or not re.fullmatch(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", wanted):
        raise Fault("handshake")
    minimum = tuple(int(part) for part in wanted.split("."))
    emit("stage", name="attach-record")
    hermes = locate(hermes_path, control)
    shown_code, shown, _ = run([hermes, "--version"], min(control, max(0.2, start_until - time.monotonic())))
    if shown_code != 0:
        raise Fault("version-unknown")
    release = re.search(r"^Hermes Agent v([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})(?![0-9.])", shown, re.M)
    if not release:
        raise Fault("version-unknown", tail=tail(shown.split("\n", 1)[0]))
    version = ".".join(str(int(part)) for part in release.groups())
    if tuple(int(part) for part in release.groups()) < minimum:
        raise Fault("update-required", version=version, minimum=wanted)
    try:
        extra = options.get("extraHomes")
        extra_homes = []
        if isinstance(extra, list):
            for value in extra[:20]:
                if isinstance(value, str) and value.startswith("/") and ".." not in value.split("/"):
                    extra_homes.append(value)
        folder, record = state_folder(options.get("stateDir"), options.get("hermesHome"), extra_homes)
    except Fault as error:
        if error.code != "serve-not-running" or error.detail.get("absent") is not True:
            raise
        # Only a missing record can be a gateway-only home. A failed owner or token
        # check must keep its own failure, and an explicit folder cannot guess a home.
        home = options.get("hermesHome")
        known_home = isinstance(home, str) and home.startswith("/") and os.path.isdir(home)
        cli_env = os.environ.copy()
        if known_home:
            cli_env["HERMES_HOME"] = home
        budget = min(control, start_until - time.monotonic() - 0.5)
        if (known_home or (not home and not options.get("stateDir"))) and budget >= 0.5:
            if gateway_running(hermes, cli_env, budget):
                raise Fault("serve-not-running", gateway=True)
        raise Fault("serve-not-running")
    token = read_token(folder, record)
    # The CLI must read the same data root the owner was launched from: the record says
    # which HERMES_HOME that is, and every read below is scoped to it.
    cli_env = os.environ.copy()
    launch_home = options.get("hermesHome") or record.get("home")
    if isinstance(launch_home, str) and launch_home.startswith("/") and os.path.isdir(launch_home):
        cli_env["HERMES_HOME"] = launch_home
    prove_owner(record["port"], record["pid"], token)
    emit("stage", name="attach-profiles")
    profile_budget = min(30.0, max(control, start_until - time.monotonic()))
    listed_code, listing, listing_err = run([hermes, "profile", "list"], profile_budget, cli_env)
    listed_rows = parse_list(listing) if listed_code == 0 else []
    # The record's served set is the authoritative id list; the human table is only the
    # active marker and a fallback for a release that publishes no set. A profile is never
    # silently dropped: a failed show or config leaves its id, and a late deadline is an
    # explicit refusal, not a shorter list.
    recorded = [value for value in (record.get("profiles") or [])
                if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value)]
    ids = recorded or [row["id"] for row in listed_rows]
    if not ids:
        raise Fault("serve-profiles", tail=tail(listing_err or listing, token))
    if len(ids) > 50:
        raise Fault("serve-profiles", tail=["more than 50 profiles"])
    rows = {row["id"]: row for row in listed_rows}
    kept = []
    for ident in ids:
        if time.monotonic() >= start_until:
            raise Fault("serve-profiles", tail=["profile reads exceeded the deadline"])
        budget = min(30.0, max(control, start_until - time.monotonic()))
        row = rows.get(ident, {"id": ident, "name": ident, "model": "", "provider": "", "running": False, "active": False})
        shown_profile = show_profile(hermes, ident, budget, cli_env)
        model, provider = config_model(hermes, ident, budget, cli_env)
        shown_running = (shown_profile or {}).get("running")
        kept.append({
            "id": ident,
            "name": (shown_profile or {}).get("name") or row["name"],
            "model": model or (shown_profile or {}).get("model") or row["model"],
            "provider": provider or (shown_profile or {}).get("provider") or row["provider"],
            "running": bool(shown_running if shown_running is not None else row["running"]),
            "active": bool(row.get("active")),
        })
    if not kept:
        raise Fault("serve-profiles")
    active = next((row["id"] for row in kept if row["active"]), kept[0]["id"])
    emit("record", port=record["port"], pid=record["pid"], version=version, host=record.get("host") or "",
         profiles=[{key: row[key] for key in ("id", "name", "model", "provider", "running")} for row in kept],
         active=active)
    emit("token", value=token)
    emit("ready", port=record["port"])
except Fault as error:
    error.detail.pop("absent", None)
    emit("error", code=error.code, **error.detail)
except Exception as error:
    step = error.__traceback__
    while step.tb_next is not None and step.tb_next.tb_frame.f_code.co_filename == step.tb_frame.f_code.co_filename:
        step = step.tb_next
    emit("error", code="remote-script", name=type(error).__name__, line=step.tb_lineno)
`

const ATTACH_KINDS = new Set(['hermes-not-found', 'update-required', 'version-unknown', 'unsupported-platform', 'serve-not-running', 'serve-gateway', 'serve-record', 'serve-profiles', 'handshake', 'timeout', 'remote-script', 'unknown'])
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const LINE = 240
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)

function profilesOf(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return []
  const rows = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || !PROFILE_ID.test(item.id ?? '')) continue
    const model = text(item.model) ? item.model.trim().slice(0, 200) : ''
    const provider = text(item.provider) ? item.provider.trim().slice(0, 100) : ''
    if (model && !/^[\x20-\x7e]+$/.test(model)) continue
    // A serve may name the profile model's capacity (camelCase here, snake_case from the
    // remote record). It is forwarded when present; attachedModelOf supplies the floor.
    const contextWindow = Number.isInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow
      : Number.isInteger(item.context_window) && item.context_window > 0 ? item.context_window : undefined
    rows.push({
      id: item.id,
      name: text(item.name) && item.name.trim() ? item.name.trim().slice(0, 100) : item.id,
      model, provider, running: item.running === true,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    })
  }
  return rows
}

/**
 * Attach to the machine-level `hermes serve` this SSH host already runs.
 *
 * The remote command only reads: the host rendezvous record and its 0600 token, the
 * recorded owner's own identity answer, and its profiles through `hermes profile list`,
 * `profile show` and `config get model`. It never starts, restarts, stops or cleans
 * Hermes, and leaves no remote process behind: closing this connection only ends the
 * local SSH tunnel. The token lives in memory here and in the app's secret store, never
 * in a URL path, a message, a detail line or a log.
 */
export async function startHermesAttach(ssh, {
  signal, deadlines = HERMES_DEADLINES, spawn = undefined, allocatePort = hermesSshAllocatePort,
  sshCommand = 'ssh', env = process.env, randomBytes, minimum = HERMES_MINIMUM, onProgress = () => {}, extraHomes = [],
} = {}) {
  randomBytes ??= cryptoRandomBytes
  spawn ??= spawnChild
  let config
  try { config = hermesSshDestination(ssh) } catch (error) { throw Object.assign(error, { sshStage: 'details' }) }
  const limits = { ...HERMES_DEADLINES, ...deadlines }
  const until = Date.now() + limits.start
  const nonce = randomBytes(8).toString('hex')
  const ready = deferred(), forwarded = deferred(), cancelled = deferred()
  const children = []
  let remote, tunnel, closing, stopping = false
  let credential, remotePort, profiles = [], active, version
  let stage = 'ssh-sign-in', remoteEntry, tunnelEntry
  const secrets = [nonce]
  const at = error => { if (error && typeof error === 'object') error.sshStage ??= stage; return error }
  const common = ['-T', '-v', '-o', 'BatchMode=yes', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey', '-o', 'StrictHostKeyChecking=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ConnectionAttempts=1', '-o', `ConnectTimeout=${Math.max(1, Math.ceil(limits.control / 1000))}`, '-o', `ServerAliveInterval=${Math.max(1, Math.floor(limits.control / 3000))}`, '-o', 'ServerAliveCountMax=2', ...config.args]
  const bounded = async (promise, ms, interruptible = true) => {
    let timer
    try { return await Promise.race([promise, ...(interruptible ? [cancelled.promise] : []), new Promise((_, reject) => { timer = setTimeout(() => reject(hermesSshFailure('timeout')), Math.max(1, ms)) })]) }
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
    const entry = { child, ended: ended.promise, stderr: '', edge: '', expected: false, commandSent: false }
    children.push(entry)
    child.on('error', () => { if (!child.pid) ended.resolve(); fail(hermesSshFailure('unreachable')) })
    child.on('close', code => {
      ended.resolve()
      if (stopping || entry.expected) return
      const error = hermesSshFailureFromStderr(entry.stderr, { role: child === tunnel ? 'tunnel' : 'supervisor', exit: code, started: entry.commandSent, localPort: entry.localPort })
      fail(error)
    })
    child.stdin.on('error', () => {})
    child.stderr.on('data', data => {
      const chunk = String(data)
      entry.commandSent ||= /Sending command:/.test(entry.edge + chunk)
      entry.edge = chunk.slice(-32)
      entry.stderr = (entry.stderr + chunk).slice(-65536)
      if (child === tunnel && /Local forwarding listening on 127\.0\.0\.1 port (\d+)\./.test(entry.stderr)) {
        const port = Number(/Local forwarding listening on 127\.0\.0\.1 port (\d+)\./.exec(entry.stderr)[1])
        if (port === entry.localPort) forwarded.resolve()
      }
    })
    return entry
  }
  const exit = () => { try { remote?.stdin.destroy(); remote?.kill('SIGTERM'); tunnel?.kill('SIGTERM') } catch {} }
  function close() {
    if (closing) return closing
    stopping = true
    signal?.removeEventListener('abort', abort)
    process.removeListener('exit', exit)
    closing = (async () => {
      try { remote?.stdin.end() } catch {}
      try { tunnel?.kill('SIGTERM') } catch {}
      const ended = Promise.all(children.map(entry => entry.ended))
      try { await bounded(ended, limits.cancel * 0.8, false) } catch {
        for (const entry of children) { try { entry.child.kill('SIGKILL') } catch {} }
        try { await bounded(ended, Math.max(1, limits.cancel * 0.2), false) } catch {}
      }
    })()
    return closing
  }
  const abort = () => { fail(hermesSshFailure('unknown', 'SSH connection was cancelled.')) }
  if (signal?.aborted) throw hermesSshFailure('unknown', 'SSH connection was cancelled.')
  signal?.addEventListener('abort', abort, { once: true })
  process.once('exit', exit)
  try {
    // One command, read-only on the remote: the same SSH details and host-key rules as
    // the app-owned connection, but a script that never launches Hermes.
    remoteEntry = launch([...common, '-o', 'ClearAllForwardings=yes', '--', config.target, `exec python3 -u -c ${hermesSshQuote(supervisor)}`])
    remote = remoteEntry.child
    let carry = ''
    remote.stdout.on('data', chunk => {
      carry += String(chunk)
      if (Buffer.byteLength(carry) > 65536) { carry = ''; fail(hermesSshFailure('handshake')); return }
      let newline
      while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue
        if (frame.nonce !== nonce) { fail(hermesSshFailure('handshake')); return }
        if (stage === 'ssh-sign-in') stage = 'attach-record'
        if (frame.type === 'stage' && (frame.name === 'attach-record' || frame.name === 'attach-profiles')) {
          stage = frame.name
          onProgress(frame.name === 'attach-record' ? 'ssh' : 'profiles')
          continue
        }
        if (frame.type === 'record') {
          if (!Number.isSafeInteger(frame.port) || frame.port <= 0 || frame.port >= 65536) { fail(hermesSshFailure('serve-record')); return }
          const rows = profilesOf(frame.profiles)
          if (!rows.length) { fail(hermesSshFailure('serve-profiles')); return }
          remotePort = frame.port
          profiles = rows
          active = rows.some(row => row.id === frame.active) ? frame.active : rows[0].id
          version = typeof frame.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(frame.version) ? frame.version : undefined
          continue
        }
        if (frame.type === 'token') {
          if (!text(frame.value) || frame.value.length < 16 || frame.value.length > 512 || !/^[!-~]+$/.test(frame.value)) { fail(hermesSshFailure('serve-record')); return }
          credential = frame.value
          secrets.push(credential)
          continue
        }
        if (frame.type === 'ready') {
          if (!Number.isSafeInteger(frame.port) || frame.port !== remotePort || !credential) { fail(hermesSshFailure('handshake')); return }
          remoteEntry.expected = true
          ready.resolve(frame.port)
          continue
        }
        if (frame.type === 'error' && ATTACH_KINDS.has(frame.code)) {
          const detail = {}
          if (Number.isSafeInteger(frame.exit) && Math.abs(frame.exit) < 1024) detail.exit = frame.exit
          if (Array.isArray(frame.tail)) detail.ssh = frame.tail.slice(-3).map(value => redactSshText(String(value ?? ''), secrets).slice(0, LINE)).filter(Boolean)
          if (typeof frame.name === 'string' && /^[A-Za-z_]\w{0,40}$/.test(frame.name)) detail.fault = frame.name
          if (Number.isSafeInteger(frame.line) && frame.line > 0 && frame.line < 10000) detail.line = frame.line
          for (const key of ['version', 'minimum']) if (typeof frame[key] === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(frame[key])) detail[key] = frame[key]
          const kind = frame.code === 'serve-not-running' && frame.gateway === true ? 'serve-gateway-running' : frame.code
          fail(hermesSshFailure(kind, undefined, detail))
          return
        }
        fail(hermesSshFailure('handshake'))
        return
      }
    })
    const startMs = Math.max(1, Math.floor(limits.start - Math.min(limits.control / 2, limits.start * 0.15)))
    const extras = (Array.isArray(extraHomes) ? extraHomes : []).slice(0, 20).filter(value => text(value) && value.startsWith('/') && !value.split('/').includes('..'))
    remote.stdin.write(`${JSON.stringify({ nonce, hermesPath: config.hermesPath, hermesHome: config.hermesHome, extraHomes: extras, stateDir: config.recordDir, minVersion: minimum, startMs, controlMs: limits.control })}\n`)
    const port = await bounded(ready.promise, until - Date.now())
    if (!credential || !profiles.length) throw hermesSshFailure('serve-profiles')
    const localPort = await bounded(Promise.resolve(allocatePort()), Math.min(limits.control, until - Date.now()))
    if (stopping || signal?.aborted) throw hermesSshFailure('unknown', 'SSH connection was cancelled.')
    if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65535) throw hermesSshFailure('tunnel')
    tunnelEntry = launch([...common, '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${port}`, '--', config.target])
    tunnel = tunnelEntry.child
    tunnelEntry.localPort = localPort
    tunnel.stdout.resume()
    await bounded(forwarded.promise, Math.min(limits.control, until - Date.now())).catch(error => { throw error?.sshError === 'timeout' && !stopping ? hermesSshFailure('tunnel') : error })
    if (stopping || tunnel.exitCode !== null) throw hermesSshFailure('tunnel')
    return {
      attached: true,
      address: `http://127.0.0.1:${localPort}`,
      credential,
      authHeaders: { Authorization: `Bearer ${credential}` },
      profiles,
      defaultProfile: active,
      version,
      close,
    }
  } catch (error) {
    at(error)
    try { await close() } catch {}
    const safe = error?.code?.startsWith('bot/hermes') ? error : at(hermesSshFailure('unknown'))
    const said = tunnelEntry?.stderr || remoteEntry?.stderr
    const lines = hermesSshTail(said, secrets)
    safe.sshDetail = { ...safe.sshDetail, ...(lines.length ? { ssh: lines } : {}) }
    hermesSshNamed(safe, { hosts: [], users: [] })
    throw safe
  }
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

// The read-only remote reader, exported for the token-file tests that run it against a
// scratch state folder and a fake Hermes. It contains no start, stop or signal path.
export { supervisor as attachSupervisor }
