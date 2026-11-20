// Bot discovery's schedule (bots.js discoverProjects), with no Herdr in it so it can be tested
// and timed apart: each machine's lookups run on their own, at most `limit` at once, this
// computer's first; a project is shown as soon as its read has answered, and a machine
// that is slow or away holds back only its own projects. Apache-2.0.

/** Lookups in flight at once on one machine. */
export const DISCOVER_LIMIT = 8;
/** How long a discovery call may wait for an answer. */
export const CALL_TIMEOUT_MS = 5000;

/** The rejection of a call that took longer than its time (within). */
export class TimedOut extends Error {
  constructor(ms) { super(`no answer in ${ms} ms`); this.name = "TimedOut"; }
}

const id = (machine, key) => JSON.stringify([machine ?? null, key]);

/** A runner that starts at most `limit` of the functions handed to it at once, in that order. */
export function limiter(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < limit && queue.length) {
      const { fn, done, fail } = queue.shift();
      active += 1;
      Promise.resolve().then(fn).then(done, fail).finally(() => { active -= 1; next(); });
    }
  };
  return (fn) => new Promise((done, fail) => { queue.push({ fn, done, fail }); next(); });
}

/**
 * `p` (a promise or a value), or a TimedOut rejection once `sleep(ms)` resolves first (no
 * sleep, or no ms: no limit). `p` keeps running; its late rejection is swallowed.
 */
export function within(p, ms, sleep) {
  p = Promise.resolve(p);
  if (!sleep || !(ms > 0)) return p;
  p.catch(() => {});
  return Promise.race([p, sleep(ms).then(() => { throw new TimedOut(ms); })]);
}

/**
 * Every call to one machine, across discoveries and the background: at most `limit`
 * running at once. With `sleep` (the caller's timer), a call that waits or runs
 * longer than `ms` rejects TimedOut: one that hadn't started never starts, one that had
 * counts as stuck until it settles, and while `limit` are stuck every call rejects TimedOut
 * at once, so a machine that has stopped answering is never sent more than `limit` calls.
 * `answered` turns true at the first call that succeeds; `away` is true from a call to
 * another machine that failed or gave up until one succeeds.
 */
export function machineGate(limit = DISCOVER_LIMIT, ms = CALL_TIMEOUT_MS) {
  const run = limiter(limit);
  const gate = { stuck: 0, answered: false, away: false, inFlight: 0 };
  gate.call = (ask, { sleep = null, remote = false } = {}) => {
    if ((sleep || remote) && gate.stuck >= limit) {
      if (remote) gate.away = true;
      return Promise.reject(new TimedOut(ms));
    }
    let state = "queued"; // -> running -> done | stuck -> done; queued -> dropped
    const p = run(() => {
      if (state === "dropped") return Promise.reject(new TimedOut(ms));
      state = "running";
      gate.inFlight += 1;
      return Promise.resolve().then(ask).then((v) => { gate.answered = true; gate.away = false; return v; }).finally(() => {
        gate.inFlight -= 1;
        if (state === "stuck") gate.stuck -= 1;
        state = "done";
      });
    });
    if (!sleep && !remote) return p;
    return within(p, ms, sleep).catch((e) => {
      if (remote) gate.away = true;
      if (e instanceof TimedOut) {
        if (state === "queued") state = "dropped";
        else if (state === "running") { state = "stuck"; gate.stuck += 1; }
      }
      throw e;
    });
  };
  return gate;
}

/**
 * Every project with definitions, as bots.js discoverProjects returns them:
 * [{ key, machine, spaces, file, warnings }], in the order of the spaces (sidebar order),
 * then the remembered projects, then `listed` (this computer's); `spaces` the ids of the
 * spaces keyed to the project, in sidebar order.
 *   spaces: [{ id, folder, machine }], folder null: skipped (another machine's home);
 *   remembered: [{ key, machine }];
 *   io.provisional() -> optional local keys to show while the CLI listing is unknown;
 *   io.listed() -> keys on this computer, or a TimedOut rejection;
 *   io.cachedKey(folder, machine) -> { key, fresh } known for the folder, without asking, or
 *     undefined; a known key places the space at once, and one not fresh is looked up again;
 *   io.keyOf(folder, machine) -> key; a rejection keeps the known key, else skips the space
 *     this time. When the lookup finds another key, the space moves to it in this discovery;
 *   io.read({ key, machine, remembered }) -> { file, warnings }, or null (not shown);
 *     rejects when the machine can't answer;
 *   io.last({ key, machine }) -> what to show when a read rejects: { file, warnings, ... }
 *     or undefined.
 * io bounds its own calls' time. On a remote machine, TimedOut skips the remaining queued
 * calls this time. `onUpdate(list)` gets the list after each read and when a machine other
 * than the last finishes. A pending read shows io.last; the final list is returned.
 */
export async function discover({ spaces, remembered = [] }, io, { limit = DISCOVER_LIMIT, onUpdate = null } = {}) {
  const keyed = new Map(); // space index -> project key
  const read = new Map(); // project id -> { file, warnings } | null
  const provisional = new Set(io.provisional?.() ?? []);
  let listed = provisional;

  const assemble = () => {
    const found = new Map();
    const add = (key, machine, space) => {
      const k = id(machine, key);
      const p = found.get(k) ?? { key, machine: machine ?? null, spaces: [] };
      if (space) p.spaces.push(space);
      found.set(k, p);
    };
    spaces.forEach((s, i) => { if (keyed.has(i)) add(keyed.get(i), s.machine, s.id); });
    for (const p of remembered) add(p.key, p.machine, null);
    for (const key of listed) add(key, null, null);
    const out = [];
    for (const [k, p] of found) {
      const r = read.get(k);
      const visible = r === undefined ? io.last(p) : r;
      if (visible) out.push({ key: p.key, machine: p.machine, spaces: p.spaces, ...visible });
    }
    return out;
  };

  const publish = () => {
    if (onUpdate) try { onUpdate(assemble()); } catch {}
  };

  const machines = [null, ...new Set([...spaces, ...remembered].map((s) => s.machine).filter(Boolean))];
  let left = machines.length;
  const side = async (machine) => {
    const run = limiter(limit);
    let away = false;
    // One call: its answer, else `fallback()` (the machine away, slow or saying no).
    const call = (ask, fallback) => run(async () => {
      if (away) return fallback();
      try { return await ask(); } catch (e) {
        if (machine && e instanceof TimedOut) away = true;
        return fallback();
      }
    });
    // Each project read once, as soon as its key is known (a slow lookup holds back no other
    // project's read).
    const kept = new Set(remembered.filter((p) => (p.machine ?? null) === machine).map((p) => p.key));
    const asked = new Set();
    const reads = [];
    const want = (key) => {
      const k = id(machine, key);
      if (asked.has(k)) return;
      asked.add(k);
      const p = { key, machine, remembered: kept.has(key) };
      reads.push(call(() => io.read(p), () => undefined).then((r) => {
        read.set(k, r);
        publish();
      }));
    };
    for (const key of kept) want(key);
    const cli = machine ? null : call(() => io.listed(), () => undefined).then((keys) => {
      if (keys === undefined) return;
      listed = keys;
      for (const key of keys) want(key);
    });
    const lookups = [];
    spaces.forEach((s, i) => {
      if ((s.machine ?? null) !== machine || !s.folder) return;
      const known = io.cachedKey?.(s.folder, machine);
      if (known) {
        keyed.set(i, known.key);
        want(known.key);
        if (known.fresh) return;
      }
      lookups.push(call(() => io.keyOf(s.folder, machine), () => known?.key).then((key) => {
        if (typeof key === "string" && key !== known?.key) {
          if (!machine && known) provisional.delete(known.key);
          keyed.set(i, key);
          want(key);
        }
      }));
    });
    await Promise.all([cli, ...lookups]);
    await Promise.all(reads);
    left -= 1;
    if (left > 0) publish();
  };
  await Promise.all(machines.map(side));
  return assemble();
}
