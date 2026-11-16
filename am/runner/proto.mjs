// The member runner's one request line: a JSON object naming the member, the command, the folder
// to run it in, a timeout and a short environment allowlist. Nothing else reaches the child.
// Apache-2.0.
//
// A request is refused, never repaired: an unknown field, a wrong type, a member slug outside the
// plain shape, an environment name not on the allowlist and a timeout past the cap each raise a
// Refusal with the error code the reply frame carries.

/** One refusal of the runner, with the protocol error code the reply names. */
export class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "Refusal";
    this.code = code;
  }
}

/** The one plain line a caught error becomes: never a stack trace. */
export function plain(error) {
  if (error instanceof Refusal) return error.message;
  const message = typeof error?.message === "string" && error.message !== "" ? error.message : String(error);
  const code = typeof error?.code === "string" ? error.code : "";
  return code && !message.startsWith(code) ? `${code}: ${message}` : message;
}

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_REQUEST_WAIT_MS = 5000;
export const MAX_ARGV = 1024;
export const MEMBER_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** The short environment allowlist: the request may carry only these names. */
export const DEFAULT_ENV_ALLOW = ["PATH", "LANG", "LC_ALL", "TERM", "TZ"];

/** Fields the runner sets itself, or never passes on: a request may not name any of them. */
export const RESERVED_ENV = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PWD",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
]);

const REQUEST_KEYS = new Set(["v", "member", "argv", "cwd", "env", "timeoutMs"]);

const noNul = (value) => typeof value === "string" && !value.includes("\0");

/**
 * Parses and checks one request line. `config` carries `envAllow` (a Set or an array of names) and
 * `maxTimeoutMs`. Returns { member, argv, cwd, env, timeoutMs } with only allowed environment.
 */
export function parseRequest(line, config) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    throw new Refusal("BAD_REQUEST", "the request is not JSON");
  }
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    throw new Refusal("BAD_REQUEST", "the request is not an object");
  }
  for (const key of Object.keys(req)) {
    if (!REQUEST_KEYS.has(key)) throw new Refusal("BAD_REQUEST", `unknown field ${key}`);
  }
  if (req.v !== PROTOCOL_VERSION) throw new Refusal("BAD_VERSION", `v must be ${PROTOCOL_VERSION}`);
  if (typeof req.member !== "string" || !MEMBER_RE.test(req.member)) {
    throw new Refusal("BAD_REQUEST", "member must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  if (
    !Array.isArray(req.argv) ||
    req.argv.length < 1 ||
    req.argv.length > MAX_ARGV ||
    !req.argv.every(noNul) ||
    req.argv[0] === ""
  ) {
    throw new Refusal("BAD_REQUEST", `argv must be 1 to ${MAX_ARGV} strings, the first not empty, no NUL`);
  }
  if (req.argv[0].startsWith("-")) throw new Refusal("BAD_REQUEST", "argv[0] must not begin with a dash");
  if (!noNul(req.cwd) || !req.cwd.startsWith("/")) {
    throw new Refusal("BAD_REQUEST", "cwd must be an absolute path");
  }
  const env = req.env ?? {};
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Refusal("BAD_REQUEST", "env must be an object");
  }
  const allow = config.envAllow instanceof Set ? config.envAllow : new Set(config.envAllow ?? DEFAULT_ENV_ALLOW);
  const allowed = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) throw new Refusal("BAD_REQUEST", `env ${key} is not an environment name`);
    if (RESERVED_ENV.has(key) || !allow.has(key)) {
      throw new Refusal("ENV_NOT_ALLOWED", `env ${key} is not on the runner's allowlist`);
    }
    if (!noNul(value) || value.length > 32 * 1024) {
      throw new Refusal("BAD_REQUEST", `env ${key} must be a string up to 32 KiB, no NUL`);
    }
    allowed[key] = value;
  }
  const maxTimeout = config.maxTimeoutMs;
  if (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > maxTimeout) {
    throw new Refusal("BAD_REQUEST", `timeoutMs must be a whole number from 1 to ${maxTimeout}`);
  }
  return { member: req.member, argv: req.argv, cwd: req.cwd, env: allowed, timeoutMs: req.timeoutMs };
}
