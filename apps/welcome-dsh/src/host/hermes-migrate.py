# Hermes's side of the welcome's "From another tool" step: report where its Telegram channel
# stands, hand its bot key to the host (only when asked), switch that one channel off in
# config.yaml, and report the gateway so the host can wait for the adapter to go.
#
# This file is run by hermes-migrate.js on the Hermes host itself -- this computer, or the
# Remote Hermes computer over SSH -- with stdin carrying the whole program. It writes one JSON
# object and nothing else: no path, no file line and no key ever reaches stderr or a log. The
# job arrives in JOB_B64 (base64 JSON) so no shell quoting can change it.
#
# Read and write only what Hermes itself reads: $HERMES_HOME/config.yaml and $HERMES_HOME/.env,
# and gateway_state.json for the running gateway's own verdict. An explicit
# platforms.telegram.enabled: false is Hermes's documented per-platform switch and it beats a
# token in the environment (gateway/config.py, "Messaging status"); the host restarts the
# gateway afterwards so the running adapter stops. config.yaml is copied beside itself before
# it is written, and the copy goes back if the edit does not verify.
import base64
import copy
import datetime
import json
import os
import re
import shutil
import sys

JOB_B64 = "__OMNI_HERMES_JOB__"
JOB = json.loads(base64.b64decode(JOB_B64 or "e30=").decode("utf-8") or "{}")

# The shape of a Telegram bot key, assembled here so the check itself is not a value.
KEY_SHAPE = re.compile("^" + r"\d{6,12}" + ":" + r"[A-Za-z0-9_-]{30,}$")
BACKUP_PREFIX = "config.yaml.bak-omni-"
BACKUP_KEEP = 1


def answer(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.exit(0)


def fail(code, message):
    answer({"ok": False, "error": code, "message": message})


def home_of():
    raw = JOB.get("home") or os.environ.get("HERMES_HOME") or "~/.hermes"
    return os.path.abspath(os.path.expanduser(os.path.expandvars(str(raw))))


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except FileNotFoundError:
        return None
    except OSError:
        return None


def load_yaml():
    try:
        import yaml
        return yaml
    except Exception:
        return None


def parse_config(text, yaml):
    if text is None:
        return {}
    if yaml is None:
        fail("yaml-missing", "Hermes's Python has no YAML reader here, so its config cannot be read safely.")
    try:
        data = yaml.safe_load(text)
    except Exception:
        fail("config-unreadable", "Hermes's config.yaml could not be read as YAML, so nothing was changed.")
    return data if isinstance(data, dict) else {}


def dotenv(text):
    values = {}
    if not text:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        values[key] = value
    return values


def mapping_of(node, yaml):
    return node if isinstance(node, yaml.MappingNode) else None


def platform_block(cfg):
    """(platforms mapping or {}, telegram mapping or None), the shapes Hermes reads."""
    platforms = cfg.get("platforms")
    platforms = platforms if isinstance(platforms, dict) else {}
    telegram = platforms.get("telegram")
    telegram = telegram if isinstance(telegram, dict) else None
    return platforms, telegram


def explicit_enabled(cfg):
    """platforms.telegram.enabled, else a top-level telegram.enabled, else None."""
    _, telegram = platform_block(cfg)
    if telegram is not None and isinstance(telegram.get("enabled"), bool):
        return telegram["enabled"]
    top = cfg.get("telegram")
    if isinstance(top, dict) and isinstance(top.get("enabled"), bool):
        return top["enabled"]
    gateway = cfg.get("gateway")
    gateway_platforms = gateway.get("platforms") if isinstance(gateway, dict) else None
    nested = gateway_platforms.get("telegram") if isinstance(gateway_platforms, dict) else None
    if isinstance(nested, dict) and isinstance(nested.get("enabled"), bool):
        return nested["enabled"]
    return None


def token_of(cfg, env):
    """The token Hermes would start with: the environment first (it wins over config.yaml)."""
    candidates = []
    if env.get("TELEGRAM_BOT_TOKEN"):
        candidates.append(("env", env["TELEGRAM_BOT_TOKEN"]))
    _, telegram = platform_block(cfg)
    if telegram is not None and isinstance(telegram.get("token"), str):
        candidates.append(("config", telegram["token"]))
    top = cfg.get("telegram")
    if isinstance(top, dict) and isinstance(top.get("token"), str):
        candidates.append(("config", top["token"]))
    gateway = cfg.get("gateway")
    gateway_platforms = gateway.get("platforms") if isinstance(gateway, dict) else None
    nested = gateway_platforms.get("telegram") if isinstance(gateway_platforms, dict) else None
    if isinstance(nested, dict) and isinstance(nested.get("token"), str):
        candidates.append(("config", nested["token"]))
    for source, raw in candidates:
        value = raw.strip()
        if KEY_SHAPE.match(value):
            return source, value
    return None, None


def gateway_of(home):
    text = read_text(os.path.join(home, "gateway_state.json"))
    data = {}
    if text:
        try:
            data = json.loads(text)
        except Exception:
            data = {}
    pid = data.get("pid") if isinstance(data.get("pid"), int) and data.get("pid") > 0 else None
    platforms = data.get("platforms") if isinstance(data.get("platforms"), dict) else {}
    telegram = platforms.get("telegram") if isinstance(platforms.get("telegram"), dict) else None
    state = telegram.get("state") if isinstance(telegram, dict) and isinstance(telegram.get("state"), str) else None
    alive = None
    if pid is not None:
        try:
            os.kill(pid, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        except PermissionError:
            alive = True
        except OSError:
            alive = None
    return {
        "pid": pid,
        "pidAlive": alive,
        "telegram": state,
        "updatedAt": data.get("updated_at") if isinstance(data.get("updated_at"), str) else None,
    }


def channel_of(cfg, env, token, gateway):
    """'on', 'off' (the explicit disable), 'none', or 'unknown' (on, but unreadable here)."""
    explicit = explicit_enabled(cfg)
    if explicit is False:
        return "off"
    if token is not None:
        return "on"
    running = gateway.get("telegram")
    if isinstance(running, str) and running.strip().lower() in (
        "connected", "connecting", "reconnecting", "qr", "pending", "starting",
    ):
        return "on"
    if explicit is True:
        return "unknown"
    return "none"


def probe(with_token):
    home = home_of()
    exists = os.path.isdir(home)
    config_text = read_text(os.path.join(home, "config.yaml"))
    env_text = read_text(os.path.join(home, ".env"))
    if not exists and config_text is None:
        return {
            "ok": True,
            "hermes": {"found": False, "channel": "none", "key": "missing"},
            "gateway": {"pid": None, "pidAlive": None, "telegram": None, "updatedAt": None},
        }
    yaml = load_yaml()
    cfg = parse_config(config_text, yaml)
    env = dotenv(env_text)
    source, token = token_of(cfg, env)
    gateway = gateway_of(home)
    channel = channel_of(cfg, env, token, gateway)
    result = {
        "ok": True,
        "hermes": {
            "found": config_text is not None or env_text is not None,
            "channel": channel,
            "key": "available" if token is not None else "missing",
        },
        "gateway": gateway,
    }
    if with_token:
        if token is None:
            fail("no-key", "Hermes did not have a Telegram bot key this wizard can read.")
        result["token"] = token
        result["tokenSource"] = source
    return result


def find_key(mapping, name, yaml):
    for key_node, value_node in mapping.value:
        if isinstance(key_node, yaml.ScalarNode) and key_node.value == name:
            return key_node, value_node
    return None, None


def child_indent(mapping, yaml):
    if mapping.value:
        return mapping.value[0][0].start_mark.column
    return mapping.start_mark.column + 2


def append_block(text):
    ending = "" if text == "" or text.endswith("\n") else "\n"
    return text + ending + "platforms:\n  telegram:\n    enabled: false\n"


def edit_disable(text, yaml):
    """The same text with platforms.telegram.enabled: false, and nothing else moved."""
    root = yaml.compose(text)
    if root is None:
        return append_block(text)
    if not isinstance(root, yaml.MappingNode):
        fail("config-shape", "Hermes's config.yaml is not a mapping, so nothing was changed.")
    platforms_key, platforms_value = find_key(root, "platforms", yaml)
    if platforms_key is None:
        return append_block(text)
    if not isinstance(platforms_value, yaml.MappingNode):
        # `platforms:` with nothing under it: give it the one entry.
        if isinstance(platforms_value, yaml.ScalarNode) and platforms_value.value in ("", "null", "~"):
            indent = platforms_key.start_mark.column + 2
            return text[:platforms_value.start_mark.index] + "\n" + " " * indent + "telegram:\n" + " " * (indent + 2) + "enabled: false" + text[platforms_value.end_mark.index:]
        fail("config-shape", "Hermes's platforms setting is not a mapping, so nothing was changed.")
    if platforms_value.flow_style:
        fail("config-shape", "Hermes's platforms setting is written inline, so it was left alone.")
    telegram_key, telegram_value = find_key(platforms_value, "telegram", yaml)
    if telegram_key is None:
        indent = child_indent(platforms_value, yaml)
        block = "\n" + " " * indent + "telegram:" + "\n" + " " * (indent + 2) + "enabled: false"
        return text[:platforms_value.end_mark.index] + block + text[platforms_value.end_mark.index:]
    if not isinstance(telegram_value, yaml.MappingNode):
        if isinstance(telegram_value, yaml.ScalarNode) and telegram_value.value in ("", "null", "~"):
            indent = telegram_key.start_mark.column + 2
            return text[:telegram_value.start_mark.index] + "\n" + " " * indent + "enabled: false" + text[telegram_value.end_mark.index:]
        fail("config-shape", "Hermes's telegram setting is not a mapping, so nothing was changed.")
    if telegram_value.flow_style:
        fail("config-shape", "Hermes's telegram setting is written inline, so it was left alone.")
    enabled_key, enabled_value = find_key(telegram_value, "enabled", yaml)
    if enabled_key is not None:
        return text[:enabled_value.start_mark.index] + "false" + text[enabled_value.end_mark.index:]
    indent = child_indent(telegram_value, yaml)
    block = "\n" + " " * indent + "enabled: false"
    return text[:telegram_value.end_mark.index] + block + text[telegram_value.end_mark.index:]


def strip_switch(cfg):
    out = copy.deepcopy(cfg)
    platforms = out.get("platforms")
    if isinstance(platforms, dict):
        telegram = platforms.get("telegram")
        if isinstance(telegram, dict):
            telegram.pop("enabled", None)
            if not telegram:
                platforms.pop("telegram", None)
        if not platforms:
            out.pop("platforms", None)
    return out


def same_except_switch(before, after):
    return strip_switch(before) == strip_switch(after)


def backup_config(config_path):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    name = BACKUP_PREFIX + stamp
    target = os.path.join(os.path.dirname(config_path), name)
    shutil.copy2(config_path, target)
    os.chmod(target, os.stat(config_path).st_mode & 0o777)
    # Keep the newest few; an old backup of a config that no longer matches is not a restore.
    stale = sorted(name for name in os.listdir(os.path.dirname(config_path)) if name.startswith(BACKUP_PREFIX))
    for old in stale[:-BACKUP_KEEP]:
        try:
            os.unlink(os.path.join(os.path.dirname(config_path), old))
        except OSError:
            pass
    return name


def write_atomic(path, text):
    size = os.stat(path)
    temp = path + ".omni-" + str(os.getpid()) + ".tmp"
    try:
        with open(temp, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, size.st_mode & 0o777)
        os.replace(temp, path)
    finally:
        try:
            if os.path.exists(temp):
                os.unlink(temp)
        except OSError:
            pass


def disable():
    home = home_of()
    config_path = os.path.join(home, "config.yaml")
    text = read_text(config_path)
    if text is None:
        fail("no-config", "Hermes has no config.yaml here, so there is no Telegram channel to switch off.")
    if os.path.islink(config_path):
        fail("config-link", "Hermes's config.yaml is a link, so it was left alone.")
    yaml = load_yaml()
    before = parse_config(text, yaml)
    if explicit_enabled(before) is False:
        return {"ok": True, "changed": False, "channel": "off"}
    edited = edit_disable(text, yaml)
    after = parse_config(edited, yaml)
    if explicit_enabled(after) is not False or not same_except_switch(before, after):
        fail("edit-check", "The change to Hermes's config could not be checked, so nothing was written.")
    backup = backup_config(config_path)
    write_atomic(config_path, edited)
    written = parse_config(read_text(config_path), yaml)
    if explicit_enabled(written) is not False or not same_except_switch(before, written):
        shutil.copy2(os.path.join(home, backup), config_path)
        fail("write-check", "Hermes's config did not come back as expected; the copy made before the change was put back.")
    return {"ok": True, "changed": True, "channel": "off", "backup": backup}


def restore():
    home = home_of()
    name = JOB.get("backup")
    if not isinstance(name, str) or not name.startswith(BACKUP_PREFIX) or "/" in name or name in (".", ".."):
        fail("restore-name", "No config copy to put back.")
    source = os.path.join(home, name)
    target = os.path.join(home, "config.yaml")
    if not os.path.isfile(source):
        fail("restore-missing", "The config copy made before the change is not there any more.")
    shutil.copy2(source, target)
    os.chmod(target, os.stat(source).st_mode & 0o777)
    return {"ok": True, "restored": True}


def main():
    mode = JOB.get("mode")
    if mode == "probe":
        answer(probe(False))
    if mode == "read":
        answer(probe(True))
    if mode == "disable":
        answer(disable())
    if mode == "restore":
        answer(restore())
    if mode == "gateway":
        home = home_of()
        answer({"ok": True, "gateway": gateway_of(home)})
    fail("mode", "Unknown Hermes step.")


try:
    main()
except SystemExit:
    raise
except Exception as error:
    # No exception text: a YAML error quotes the line it choked on, and that line may hold the key.
    fail("script", "Hermes's own files could not be handled here (" + type(error).__name__ + ").")
