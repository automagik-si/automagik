// A small answer about this machine. Only the fields checked by checkHere leave the machine.
import { askBare, CREDENTIAL_VARS, DEFAULT_LOGIN, loginsPath, probeLogin, readRecord, slotStates } from "./loginProbe.js";
import { chooseLogin } from "./logins.js";
import { PROJECTS_FILE, MAX_LISTED_PROJECTS, listedProjects } from "./model.js";
import { bytesOf, checkHere, HERE_KIND, HERE_MAX_BYTES, HERE_V, matches, pathOkay, REFRESH, ROUTE_CODES, versionOkay, accountFingerprint } from "./accountsRows.js";

export { HERE_KIND, HERE_MAX_BYTES, HERE_V };
export const HERE_BUDGET_MS = 15_000;
export const HERE_CHECK_MS = 7_000;
export const CODEX_MAX_BYTES = 1 << 20;

const trim = (path) => path.replace(/\/+$/, "");
const absent = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";
const size = (bytes) => typeof bytes === "string" ? bytesOf(bytes) : bytes.byteLength;

export function codexHome(env, home) {
  const given = env.CODEX_HOME?.trim();
  const dir = given === "~" ? home : given?.startsWith("~/") ? `${trim(home)}${given.slice(1)}` : given;
  return { home: (dir ? trim(dir) : `${trim(home)}/.codex`) || "/", from: given ? "env" : "default" };
}

export function readCodex(io) {
  const result = { ...codexHome(io.env, io.home), file: "unreadable", account: null, accountId: "absent",
    lastRefresh: null, generation: null };
  let bytes;
  try { bytes = io.readBytes(`${trim(result.home)}/auth.json`, CODEX_MAX_BYTES); } catch (e) {
    return { ...result, file: absent(e) ? "absent" : "unreadable" };
  }
  if (size(bytes) > CODEX_MAX_BYTES) return result;
  const text = String(bytes);
  const account = accountFingerprint(text);
  let refresh;
  try { refresh = JSON.parse(text)?.last_refresh; } catch { /* The file is still present. */ }
  return { ...result, file: "present", account, accountId: account ? "present" : "absent",
    lastRefresh: matches(REFRESH, refresh) ? refresh : null, generation: io.sha256(bytes) };
}

async function until(tasks, deadline, now) {
  let timer;
  try {
    await Promise.race([Promise.allSettled(tasks), new Promise((done) => { timer = setTimeout(done, Math.max(0, deadline - now())); })]);
  } finally {
    clearTimeout(timer);
  }
}

// The read probes the slot inventory through the shipped claude command. It never runs a
// configured launcher. Any other configured run leaves the record route unresolved and the
// machine's effective account unknown.
export async function readClaude(io, deadline) {
  let bytes, error;
  try { bytes = io.readBytes(loginsPath(io.appHome)); } catch (e) { error = e; }
  const captured = () => { if (error) throw error; return String(bytes); };
  const r = await readRecord(io.appHome, () => absent(error) ? null : captured());
  const record = r.problem ? "bad" : r.text === null ? "absent" : "ok";
  const selected = record === "ok" ? r.use : DEFAULT_LOGIN;
  const effective = chooseLogin(io.appHome, { read: captured, realpath: io.realpath, isDir: io.isDir, home: io.home }).id;
  const probes = [{ id: DEFAULT_LOGIN, dir: null }, ...r.logins].map((slot) => ({ ...slot, code: "timeout", status: { state: "late" } }));
  const where = await io.bareWhere;
  const opts = { exec: io.exec, home: io.home, where, ms: HERE_CHECK_MS,
    readTextFile: async (path) => String(io.readBytes(path)) };
  const vars = CREDENTIAL_VARS.filter((name) => io.env?.[name] !== undefined);
  let bare = { state: "late" };
  await until([
    ...probes.map((slot, i) => probeLogin(slot, opts).then((p) => { probes[i] = p; }, () => {
      probes[i] = { ...slot, code: null, status: { state: "unread" } };
    })),
    Promise.resolve(io.bareWhere).then((where) => askBare({ ...opts, where })).then((status) => { bare = status; }, () => { bare = { state: "unread" }; }),
  ], deadline, io.now);
  const slots = slotStates(probes, { vars, home: io.home });
  const chosen = slots.find((s) => s.id === effective) ?? slots[0];
  const route = io.recordRoute ?? "shipped";
  const recordRoute = route === "own" ? { email: null, state: "unresolved" }
    : route === "unread" ? { email: null, state: "failed" }
    : { email: chosen.state === "eligible" ? chosen.email : null,
        state: chosen.state === "eligible" || ROUTE_CODES.includes(chosen.state) ? chosen.state : "failed" };
  const bareEmail = bare.state === "in" ? bare.email?.toLowerCase() ?? null : null;
  const bareRoute = { email: bareEmail, state: bareEmail ? "eligible" : ({ out: "not-signed-in", late: "timeout" })[bare.state] ?? "failed" };
  return { record, snapshot: bytes === undefined ? null : io.sha256(bytes), selected, effective, slots,
    slotsComplete: record !== "bad" && !slots.some((s) => ["timeout", "failed"].includes(s.state)),
    email: route === "shipped" && chosen.state === "eligible" ? chosen.email : null,
    state: route === "shipped" ? chosen.state : route === "own" ? "unresolved" : "failed",
    routes: { record: recordRoute, bare: bareRoute },
    routesDiffer: Boolean(bareEmail && recordRoute.email && bareEmail !== recordRoute.email) };
}

const textAt = (io, path) => {
  try { return String(io.readBytes(path)); } catch { return null; }
};

export function exceptions(io, boundProjects) {
  let shared = [];
  try {
    const data = JSON.parse(textAt(io, `${io.appHome}/shared.json`));
    const entries = data?.["am.sidebar.projects"] ?? data?.["spaces-agents.projects"];
    if (Array.isArray(entries)) shared = entries.map((p) => typeof p === "string" ? p : !p?.machine ? p?.key : null);
  } catch { /* No list to read. */ }
  const bound = new Set(boundProjects.filter(pathOkay).map((p) => trim(p) || "/"));
  const listed = [PROJECTS_FILE, "automagik-herdr/projects.json"].flatMap((file) => listedProjects(textAt(io, `${io.appHome}/${file}`)));
  const projects = [...new Set([...bound, ...[...listed, ...shared].filter(pathOkay).map((p) => trim(p) || "/")])].slice(0, MAX_LISTED_PROJECTS);
  const result = { bound: [], list: [], more: 0 };
  for (const project of projects) {
    let why;
    try {
      const bytes = io.readBytes(`${trim(project)}/.herdr/pane-env`, 4096);
      if (size(bytes) > 4096) throw new Error();
      const { appHome, prepend, error } = io.paneEnvOf(String(bytes));
      if (error) why = "unread";
      else if (appHome && trim(appHome) !== trim(io.appHome)) why = "own-app-home";
      else if (prepend) why = "own-path";
    } catch (e) {
      if (!absent(e)) why = "unread";
    }
    if (why && bound.has(project)) result.bound.push({ project, why });
    else if (why && why !== "unread") result.list.push({ project, why });
  }
  result.list.sort((a, b) => a.project < b.project ? -1 : a.project > b.project ? 1 : 0);
  result.more = Math.max(0, result.list.length - 20);
  result.list = result.list.slice(0, 20);
  return result;
}

export function versions(io) {
  const version = (file) => {
    const line = textAt(io, file)?.split(/\r?\n/, 1)[0];
    return versionOkay(line) ? line : null;
  };
  return { pack: version(`${io.appHome}/mods/am-sidebar/VERSION`), am: version(`${io.amStore}/current/VERSION`) };
}

export function panelState(io) {
  const folder = (path) => {
    try { return io.isDir(`${io.appHome}/${path}/am-quota`); } catch { return false; }
  };
  return folder("mods") ? "on" : folder("mods-disabled") ? "off" : "absent";
}

export async function hereAnswer(io, boundProjects = [], deadline = io.now() + HERE_BUDGET_MS) {
  let codex = null, claude = null;
  try { codex = readCodex(io); } catch { /* This tool could not be read. */ }
  try { claude = await readClaude(io, deadline); } catch { /* This tool could not be read. */ }
  const answer = checkHere({ v: HERE_V, kind: HERE_KIND, versions: versions(io), panel: panelState(io),
    codex, claude, exceptions: exceptions(io, boundProjects) }, { source: true });
  if (answer && bytesOf(JSON.stringify(answer)) + 1 > HERE_MAX_BYTES) {
    if (answer.claude) {
      const { slots, effective } = answer.claude;
      answer.claude.slots = slots.slice(0, 16);
      if (!answer.claude.slots.some((s) => s.id === effective)) {
        answer.claude.slots[15] = slots.find((s) => s.id === effective);
      }
      answer.claude.slotsComplete = false;
    }
    answer.exceptions.more += answer.exceptions.list.length;
    answer.exceptions.list = [];
  }
  return answer;
}
