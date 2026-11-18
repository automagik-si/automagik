// The pack's cache of the models `agy models` lists for Antigravity (#793), and the one refresh
// that fills it. agy keeps no model list of its own to read (its cache folder holds
// conversations and onboarding, and `agy models` starts its language server and asks the
// service), so the pack keeps the last answer in its app home: the form and the CLI then read
// one small local file per render or pin check, never a network call. Callers refresh at most
// once a session, and a refresh that fails (agy isn't installed, isn't signed in, or printed no
// table) keeps the last list even when it is old. The cache's path and format live in models.js,
// where its list does; this file owns only the refresh, and models.js never imports it (the
// desktop ships models.js without it).
// Pure: no `fs` or `child_process`; the caller injects `read`, `write` and `exec`. Apache-2.0.

import { agModelsCacheText, agModelsPath, parseAgModelsCache, parseAgModelsOutput } from "./models.js";

/** A cache younger than this is used as it is: one `agy models` a day at most, and never per render. */
export const AG_MODELS_TTL_MS = 24 * 60 * 60 * 1000;
/** How long one `agy models` may take before the refresh is given up on (it starts a server). */
export const AG_MODELS_TIMEOUT_MS = 30_000;

const oneLine = (text) => String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";

/**
 * A `spawnSync("agy", ["models"])` result as the refresh's `{ code, stdout, stderr }`: a process
 * killed by a signal has status null and a signal, and is a failed refresh (code 1), never a
 * silent exit 0; a spawn error (agy missing) is one too, its message on stderr.
 */
export function agModelsSpawnResult(r) {
  const signal = r?.signal ?? null;
  return {
    code: typeof r?.status === "number" ? r.status : 1,
    stdout: r?.stdout ?? "",
    stderr: r?.stderr || (signal ? `agy models was killed by ${signal}` : r?.error ? String(r.error.message ?? r.error) : ""),
  };
}

/** True when `cache` (parseAgModelsCache) was written less than AG_MODELS_TTL_MS before `now`. */
export function agModelsFresh(cache, now = Date.now()) {
  const at = Date.parse(cache?.at ?? "");
  return Number.isFinite(at) && now - at < AG_MODELS_TTL_MS;
}

const cached = (text) => parseAgModelsCache(text);

// What a failed refresh says for a person: one line, no stack, no home path of agy's own log.
const failure = (e) => `agy models couldn't run (${oneLine(e?.message ?? e) || "no answer"})`;
const refused = (r) => `agy models failed (${oneLine(r?.stderr || r?.stdout) || `exit ${r?.code ?? "?"}`})`;

/**
 * The cache under `appHome`, refreshed by running `agy models` when it is missing or older than
 * AG_MODELS_TTL_MS. `read(path)`/`write(path, text)` may be sync or async; `exec(command, args,
 * options)` must resolve `{ code, stdout, stderr }` (an `ENOENT` for a missing agy rejects).
 * With `rename(from, to)`, the write goes to a temp file beside the cache and is renamed into
 * place, so a reader never sees half a cache; without it the write is direct. `remove(path)`
 * clears a temp file a failed rename left behind (the last list is kept either way, #809).
 * Resolves { text (the cache text, the new one when written), cache, refreshed, why (the
 * fallback reason, else null) }. A failed refresh never throws and never drops a list already
 * cached; when agy is missing and nothing is cached, `text` stays null and `why` says so.
 */
export async function refreshAgModels({ appHome, read, write, rename, remove, exec, now = Date.now() }) {
  const path = agModelsPath(appHome);
  let text = null;
  try { text = await read(path); } catch { text = null; }
  const before = cached(text);
  if (before && agModelsFresh(before, now)) return { text, cache: before, refreshed: false, why: null };
  if (typeof exec !== "function") return { text, cache: before, refreshed: false, why: before ? "agy models was not run: the last list is kept" : null };
  let r;
  try { r = await exec("agy", ["models"], { timeout: AG_MODELS_TIMEOUT_MS }); } catch (e) {
    return { text, cache: before, refreshed: false, why: failure(e) };
  }
  if (r?.code !== 0) return { text, cache: before, refreshed: false, why: refused(r) };
  const models = parseAgModelsOutput(r?.stdout);
  if (!models.length) return { text, cache: before, refreshed: false, why: "agy models listed no models" };
  const next = agModelsCacheText(models, now);
  const tmp = `${path}.tmp-${now}`;
  try {
    if (typeof rename === "function") { await write(tmp, next); await rename(tmp, path); }
    else await write(path, next);
  } catch {
    if (typeof rename === "function" && typeof remove === "function") {
      try { await remove(tmp); } catch { /* already gone */ }
    }
    return { text, cache: before, refreshed: false, why: "the model cache couldn't be written" };
  }
  return { text: next, cache: cached(next), refreshed: true, why: null };
}

/**
 * refreshAgModels over synchronous `read`/`write`/`rename`/`exec` (the CLI, whose pin checks
 * are sync). Same contract; `exec` returns `{ code, stdout, stderr }` and may throw for a missing
 * agy.
 */
export function refreshAgModelsSync({ appHome, read, write, rename, remove, exec, now = Date.now() }) {
  const path = agModelsPath(appHome);
  let text = null;
  try { text = read(path); } catch { text = null; }
  const before = cached(text);
  if (before && agModelsFresh(before, now)) return { text, cache: before, refreshed: false, why: null };
  if (typeof exec !== "function") return { text, cache: before, refreshed: false, why: before ? "agy models was not run: the last list is kept" : null };
  let r;
  try { r = exec("agy", ["models"], { timeout: AG_MODELS_TIMEOUT_MS }); } catch (e) {
    return { text, cache: before, refreshed: false, why: failure(e) };
  }
  if (r?.code !== 0) return { text, cache: before, refreshed: false, why: refused(r) };
  const models = parseAgModelsOutput(r?.stdout);
  if (!models.length) return { text, cache: before, refreshed: false, why: "agy models listed no models" };
  const next = agModelsCacheText(models, now);
  const tmp = `${path}.tmp-${now}`;
  try {
    if (typeof rename === "function") { write(tmp, next); rename(tmp, path); }
    else write(path, next);
  } catch {
    if (typeof rename === "function" && typeof remove === "function") {
      try { remove(tmp); } catch { /* already gone */ }
    }
    return { text, cache: before, refreshed: false, why: "the model cache couldn't be written" };
  }
  return { text: next, cache: cached(next), refreshed: true, why: null };
}
