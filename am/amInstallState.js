// The files a linked am bootstrap may take over. These readers also run inside the far probe.

export const VERSION = /^3\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
export const PENDING = ".verification-pending";

/** A release's place in the lane's order: 3.N.P as N·10000 + P. */
export function sequenceOf(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`not a release version: ${version}`);
  return Number(match[1]) * 10_000 + Number(match[2]);
}

export function packEntries(appHome, join) {
  return ["am-sidebar", "spaces-agents"].flatMap((mod) =>
    ["automagik-herdr", "automagik-herdr.mjs"].map((name) => join(appHome, "mods", mod, "bin", name)));
}

export function recordSequence(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

export function recordSlot(entry) {
  return entry === null || (entry && typeof entry.version === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(entry.version)
    && typeof (entry.dir ?? entry.version) === "string" && /^[0-9][0-9A-Za-z.+-]{0,79}$/.test(entry.dir ?? entry.version)
    && (entry.signed === true ? VERSION.test(entry.version) && entry.sequence === sequenceOf(entry.version)
      : entry.sequence === null && entry.signed === false || recordSequence(entry.sequence)));
}

export function recordAt(path, fs) {
  let text;
  try {
    if (!fs.lstatSync(path).isFile()) return { state: "damaged", path };
    text = fs.readFileSync(path, "utf8");
  } catch (e) {
    return { state: e.code === "ENOENT" ? "absent" : "denied", path };
  }
  try {
    const r = JSON.parse(text);
    if (r?.schemaVersion === 1 && r.id === "automagik.am" && r.current && recordSlot(r.current) && recordSlot(r.previous)
      && (r.entry === undefined || typeof r.entry === "boolean")
      && (r.seen === null || recordSequence(r.seen))
      && [r.current, r.previous].every((e) => e?.sequence == null || recordSequence(r.seen) && r.seen >= e.sequence)) {
      return { state: "ok", path, text, current: r.current, previous: r.previous, seen: r.seen, entry: r.entry };
    }
  } catch { /* damaged */ }
  return { state: "damaged", path };
}

/** A fresh owner may be between the lock's exclusive create and its first write. */
export function liveInstallLock(owner, mtimeMs, maxAge = 10 * 60_000) {
  const pid = Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner.pid : null;
  if (pid === null) return Date.now() - mtimeMs < 30_000 ? { pid } : null;
  if (maxAge !== Infinity && !(Date.now() - (owner.at ?? 0) < maxAge)) return null;
  try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") return null; }
  return { pid };
}

/** Validate from the am home down, stopping before any path through a link. */
export function storeProblem(store, fs, { dirname }) {
  const parts = dirname(store);
  for (const path of [dirname(parts), parts, store]) {
    try {
      const st = fs.lstatSync(path);
      if (!st.isDirectory()) return { path, why: "must be a real directory (no symlink)" };
      if (st.uid !== process.getuid()) return { path, why: `belongs to uid ${st.uid}, expected ${process.getuid()}` };
    } catch (e) {
      if (e.code === "ENOENT") return null;
      return { path, why: e.message };
    }
  }
  return null;
}

export function sameRealPath(path, want, fs) {
  return fs.realpathSync.native(path) === fs.realpathSync.native(want);
}

export function installState({ home, amHome, appHome }, fs, paths) {
  const { dirname, join, resolve } = paths;
  const store = join(amHome, "parts", "automagik.am");
  const recordPath = join(store, "record.json");
  const unsafeStore = storeProblem(store, fs, paths);
  if (unsafeStore) return { unsafeStore, record: { state: "denied", path: recordPath } };
  const readLink = (path) => {
    try {
      const st = fs.lstatSync(path);
      return st.isSymbolicLink() ? { target: fs.readlinkSync(path), path } : { state: "file", path };
    } catch (e) { return { state: e.code === "ENOENT" ? "absent" : "denied", path }; }
  };
  const storeLink = (name) => {
    const link = readLink(join(store, name));
    if (link.state) return link;
    const to = resolve(store, link.target);
    if (dirname(to) !== store) return { ...link, state: "outside" };
    const dir = paths.basename(to);
    try {
      return fs.lstatSync(to).isDirectory() && sameRealPath(link.path, to, fs)
        ? { ...link, state: "into-store", dir } : { ...link, state: "outside" };
    } catch (e) { return { ...link, state: e.code === "ENOENT" ? "dangling" : "denied", dir }; }
  };
  const record = recordAt(recordPath, fs);
  const pendingPath = join(store, PENDING);
  let pending = null;
  try {
    const marker = fs.lstatSync(pendingPath);
    if (!marker.isFile() || marker.uid !== process.getuid()) return { unsafeStore: { path: pendingPath, why: "invalid verification marker" }, record };
    const text = fs.readFileSync(pendingPath, "utf8");
    if (text === "") pending = {}; // The first installer wrote an empty marker.
    else {
      pending = JSON.parse(text);
      if (!pending || !recordSlot(pending.current) || !recordSlot(pending.previous)) {
        return { unsafeStore: { path: pendingPath, why: "invalid verification marker" }, record };
      }
    }
  } catch (e) { if (e.code !== "ENOENT") return { unsafeStore: { path: pendingPath, why: e.message }, record }; }
  const pack = packEntries(appHome, join);
  const command = (name) => {
    const link = readLink(join(home, ".local", "bin", name));
    if (link.state) return { ...link, state: link.state === "absent" ? "missing" : link.state };
    const to = resolve(dirname(link.path), link.target);
    if (to === store || to.startsWith(`${store}/`)) {
      const want = join(store, "current", "bin", name);
      const owned = to === want || to === join(store, record.current?.dir ?? record.current?.version ?? "current", "bin", name);
      let resolved;
      try { resolved = sameRealPath(link.path, want, fs); }
      catch (e) {
        if (owned && ["ENOENT", "ENOTDIR"].includes(e.code)) return { ...link, state: "am", repair: true };
        return { ...link, state: "dangling" };
      }
      try { fs.accessSync(link.path, fs.constants.X_OK); return { ...link, state: "am", current: resolved }; }
      catch { return { ...link, state: "denied" }; }
    }
    return { ...link, state: pack.includes(to) ? "pack" : "foreign" };
  };
  return { record, pending, current: storeLink("current"), previous: storeLink("previous"),
    am: command("am"), alias: command("automagik-herdr") };
}

/** The probe's state and the action it permits. */
export function classify({ unsafeStore, record, pending, current, previous, am, alias, busy }) {
  const broken = (path, why) => ({ state: "broken", action: "refuse", why: `${path}: ${why}` });
  if (unsafeStore) return broken(unsafeStore.path, unsafeStore.why);
  if (busy) return { state: "busy", action: "refuse", why: `another am${busy.pid ? ` (pid ${busy.pid})` : ""} is installing or updating am: try again once it is done` };
  if (!["absent", "ok"].includes(record.state)) return broken(record.path, `record ${record.state}`);
  for (const [slot, link] of [[record.current, current], [record.previous, previous]]) {
    const agrees = slot ? link.state === "into-store" && link.dir === (slot.dir ?? slot.version) : link.state === "absent";
    const savedTarget = pending && link.state === "dangling" && [pending.current, pending.previous]
      .some((saved) => saved && (saved.dir ?? saved.version) === link.dir);
    if (!agrees && !(pending && (savedTarget || ["into-store", "absent"].includes(link.state)))) {
      return broken(link.path, `${link.state}${link.target ? ` (${link.target})` : ""}; store link disagrees with ${record.path}`);
    }
  }
  for (const link of [am, alias]) {
    if (!["missing", "am", "pack"].includes(link.state)) return broken(link.path, `${link.state}${link.target ? ` (${link.target})` : ""}`);
    if (link.state === "am" && !link.current && !link.repair) return broken(link.path, `its target (${link.target}) does not match current`);
  }
  const version = record.current?.version;
  if (pending) return { state: "incomplete", version, action: "install", why: "launcher verification pending" };
  if (version && [am, alias].some((link) => link.repair) && [am, alias].every((link) => ["am", "missing"].includes(link.state))) {
    return { state: "incomplete", version, action: "install" };
  }
  if ([am, alias].some((link) => link.repair)) return broken(am.repair ? am.path : alias.path, "dangling command link");
  const amCount = [am, alias].filter((link) => link.state === "am").length;
  if (version && amCount === 2) return { state: "installed", version, action: "compare" };
  if (version && amCount === 1 && [am, alias].some((link) => link.state === "missing")) return { state: "incomplete", version, action: "install" };
  if (alias.state === "pack" && ["missing", "pack"].includes(am.state)) return { state: "pack", action: "install" };
  if (am.state === "missing" && alias.state === "missing") return { state: version ? "retained" : "missing", version, action: "install" };
  return broken(am.path, `command links disagree with ${alias.path} or ${record.path}`);
}
