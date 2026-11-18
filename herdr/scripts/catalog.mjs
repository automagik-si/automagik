// Our own marketplace: this file builds the index the mod manager reads. Same shape as the one
// herdr.dev publishes, so the manager needs no special case for us.
//
//   node scripts/catalog.mjs             build catalog/index.json from this checkout
//   node scripts/catalog.mjs --refresh   re-read stars/pushedAt/head/licence from GitHub first
//   node scripts/catalog.mjs --check      verify only: nothing written, exit 1 when stale
//
// Strict by policy: a mod of ours missing RECIPE.md or LICENSE, a curated repo without a licence
// or a RECIPE, and a mod name claimed twice are refusals, not warnings — a refused repo does not
// enter the index. The run prints every refusal.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "catalog", "index.json");
const REPOS = join(ROOT, "catalog", "repos.json");
const argv = process.argv.slice(2);
const KNOWN = new Set(["--refresh", "--check", "--help", "-h"]);
const unknown = argv.filter((a) => !KNOWN.has(a));
const USAGE = [
  "catalog.mjs — build, refresh or verify catalog/index.json",
  "",
  "  (no flag)   build the index from this checkout; the only mode that writes it",
  "  --refresh   re-read stars/pushedAt/headCommit/licence/RECIPE from GitHub first, then build",
  "  --check     verify the committed index against this checkout; writes nothing",
  "  --help, -h  this text",
  "",
  "--check compares what the repository itself determines: the pack's mods and their metadata,",
  "and the curated entries as repos.json pins them. Upstream facts — stars, pushedAt, headCommit,",
  "generatedAt — are reported as stale notes, never failures, so a committed index passes in CI.",
].join("\n") + "\n";
const usage = (out) => out.write(USAGE);
if (argv.includes("--help") || argv.includes("-h")) {
  usage(process.stdout);
  process.exit(0);
}
if (unknown.length) {
  process.stderr.write(`catalog.mjs: unknown flag ${unknown.map((a) => JSON.stringify(a)).join(" ")}\n\n`);
  usage(process.stderr);
  process.exit(2);
}
const REFRESH = argv.includes("--refresh");
const CHECK = argv.includes("--check");
const STALE_DAYS = 7;

const git = (args, cwd = ROOT) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

// owner/repo from the origin remote, whatever its ssh or https spelling.
function remote() {
  const url = git(["remote", "get-url", "origin"]);
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
  return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
}

// A mod's one-line pitch: its RECIPE's first paragraph, else README's, else its title.
function blurbFor(dir) {
  for (const name of ["RECIPE.md", "README.md"]) {
    try {
      const text = readFileSync(join(dir, name), "utf8");
      const body = text.replace(/^#[^\n]*\n+/, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
      const para = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).find((p) => p && !p.startsWith("#"));
      if (para) return para.slice(0, 280);
    } catch {}
  }
  return "";
}

function titleOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "mod.json"), "utf8")).title ?? "";
  } catch {
    return "";
  }
}

// Every folder under mods/ with a main.js is a mod the pack installs, but Pocket Link: it is Pocket's
// (apps/pocket, the monorepo's AGENTS.md), never in PACK_MODS, and its catalog row stays the external
// one in repos.json. Each pack mod must carry its own RECIPE.md and LICENSE, or the pack is not
// publishable.
const NOT_THE_PACKS = new Set(["pocket-link"]);
function localMods() {
  const modsDir = join(ROOT, "mods");
  let names = [];
  try {
    names = readdirSync(modsDir).sort();
  } catch {
    return { mods: [], problems: ["mods/ is missing"] };
  }
  const mods = [];
  const problems = [];
  for (const name of names) {
    const dir = join(modsDir, name);
    if (NOT_THE_PACKS.has(name) || !statSync(dir).isDirectory()) continue;
    const has = (file) => existsSync(join(dir, file));
    if (!has("main.js")) {
      problems.push(`mods/${name}: no main.js`);
      continue;
    }
    for (const file of ["mod.json", "RECIPE.md", "LICENSE"]) {
      if (!has(file)) problems.push(`mods/${name}: no ${file}`);
    }
    mods.push({ name, title: titleOf(dir) || name, blurb: blurbFor(dir) });
  }
  return { mods, problems };
}

// GitHub, through `gh` (logged in) and `git ls-remote` (no auth needed).
function ghRepo(fullName) {
  try {
    const raw = execFileSync("gh", ["api", `repos/${fullName}`], { encoding: "utf8" });
    const j = JSON.parse(raw);
    return {
      stars: j.stargazers_count ?? 0,
      pushedAt: j.pushed_at ?? "",
      defaultBranch: j.default_branch ?? "main",
      license: j.license?.spdx_id ?? "",
    };
  } catch (error) {
    return { error: String(error.message ?? error).split("\n")[0] };
  }
}

// The upstream RECIPE.md's size, or 0 when the repo has none: the gate refuses a repo without one.
function recipeBytesOf(fullName, path) {
  const at = `${fullName}/contents/${path ? `${path}/` : ""}RECIPE.md`;
  try {
    const raw = execFileSync("gh", ["api", `repos/${at}`, "--jq", ".size"], { encoding: "utf8" }).trim();
    const size = Number(raw);
    return Number.isFinite(size) ? size : 0;
  } catch {
    return 0;
  }
}

function headOf(fullName, branch) {
  try {
    const out = execFileSync("git", ["ls-remote", `https://github.com/${fullName}.git`, `refs/heads/${branch}`], {
      encoding: "utf8",
    });
    return out.trim().split(/\s+/)[0] || "";
  } catch {
    return "";
  }
}

const { owner, repo } = remote();
const fullName = owner && repo ? `${owner}/${repo}` : "";
// The pack's own entry names the monorepo even in a checkout whose origin is a local mirror, so
// regenerating there keeps a valid url instead of blanking it (#215).
const packFullName = fullName || "automagik-si/automagik";
// The pack's folder in its repository: herdr/ in the Automagik monorepo (its mods are at
// <path>/mods/<name> there), empty when the pack is a repository of its own.
const packPath = git(["rev-parse", "--show-prefix"]).replace(/\/+$/, "");
const { mods, problems } = localMods();
// The pack's branch is fixed by the wish (dev); its headCommit is deliberately not pinned to a
// local commit, so a committed index does not go stale the moment it lands.
const branch = "dev";
const recent = git(["log", "-1", "--format=%cI", "--", "."]);
// Our own entry's pushedAt: the newest release tag's date, not the working tree's head. The tag a
// release creates is newer only after the release commit, so that commit never rewrites it (#215).
const releasePushedAt = () => {
  const tag = git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  return tag ? git(["log", "-1", "--format=%cI", `${tag}^{commit}`]) : "";
};
// The committed index as it was, read before this run so its volatile stamps can be kept.
const previousIndex = (() => {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return null;
  }
})();
const dirty = git(["status", "--porcelain"]).length > 0;
const readme = (() => {
  try {
    return readFileSync(join(ROOT, "README.md"), "utf8");
  } catch {
    return "";
  }
})();
const packName = (/^#\s+(.+)$/m.exec(readme)?.[1] ?? "automagik-herdr").trim();
const packBlurb = (/^#\s+.+\n+([^\n#][^\n]*)/m.exec(readme)?.[1] ?? "").trim();

if (problems.length) {
  console.error("pack problems — nothing written:");
  for (const line of problems) console.error(`  ✗ ${line}`);
  process.exit(1);
}
if (!mods.length) {
  console.error("mods/ holds no mod (a folder with main.js)");
  process.exit(1);
}

// ---- curated repositories ----
let curated = [];
try {
  curated = JSON.parse(readFileSync(REPOS, "utf8"))?.repos ?? [];
} catch {}

const refusals = [];
if (REFRESH) {
  for (const entry of curated) {
    if (entry.external) continue;   // a link to someone else's installer: no recipe, no head
    const live = ghRepo(entry.fullName);
    if (live.error) {
      refusals.push(`${entry.fullName}: could not read it from GitHub (${live.error}) — kept as it was`);
      continue;
    }
    entry.stars = live.stars;
    entry.pushedAt = live.pushedAt;
    entry.defaultBranch = live.defaultBranch;
    entry.license = live.license;
    entry.headCommit = headOf(entry.fullName, entry.defaultBranch) || entry.headCommit || "";
    entry.recipeBytes = recipeBytesOf(entry.fullName, entry.path ?? "");
  }
  if (!CHECK) writeFileSync(REPOS, JSON.stringify({ repos: curated }, null, 2) + "\n");
}

// One mod, one owner: our pack is first, then the repos in the order curated. A repo left with
// nothing to install does not enter the index, and the run says why.
const claimed = new Map();
const entries = [];

const entryForPack = {
  owner: owner || "automagik-si",
  repo: repo || "automagik",
  fullName: packFullName,
  url: `https://github.com/${packFullName}`,
  defaultBranch: branch,
  stars: 0,
  pushedAt: releasePushedAt() || recent,
  headCommit: "",
  path: packPath,
  name: packName,
  blurb: packBlurb,
  modNames: mods.map((m) => m.name),
  hasKeys: existsSync(join(ROOT, "keys.json")),
  hasPreview: existsSync(join(ROOT, "preview.png")),
  recipeBytes: (() => {
    try {
      return statSync(join(ROOT, "RECIPE.md")).size;
    } catch {
      return 0;
    }
  })(),
  previewUrl: "",
  license: (() => {
    try {
      const first = readFileSync(join(ROOT, "LICENSE"), "utf8").split("\n")[0].trim();
      return /apache/i.test(first) ? "Apache-2.0" : /mit/i.test(first) ? "MIT" : "";
    } catch {
      return "";
    }
  })(),
  mods: mods.map((m) => ({ name: m.name, title: m.title, blurb: m.blurb })),
};
for (const name of entryForPack.modNames) claimed.set(name, entryForPack.fullName);
entries.push(entryForPack);

for (const entry of curated) {
  if (!entry?.fullName) {
    refusals.push(`an entry without fullName`);
    continue;
  }
  // An external entry installs nothing here: it is a labelled link to the repo that owns the mod,
  // so it carries no modNames, no path and no mod rows.
  if (entry.external) {
    const [eo, er] = entry.fullName.split("/");
    entries.push({
      owner: entry.owner ?? eo,
      repo: entry.repo ?? er,
      fullName: entry.fullName,
      url: `https://github.com/${entry.fullName}`,
      defaultBranch: entry.defaultBranch ?? "main",
      stars: entry.stars ?? 0,
      pushedAt: entry.pushedAt ?? "",
      name: entry.name ?? er,
      blurb: entry.blurb ?? "",
      license: entry.license ?? "",
      modNames: [],
      external: true,
    });
    continue;
  }
  const names = (entry.modNames ?? []).filter((name) => !claimed.has(name));
  if (!names.length) {
    refusals.push(`${entry.fullName}: every mod it installs is already claimed (${(entry.modNames ?? []).join(", ") || "none listed"})`);
    continue;
  }
  if (!entry.license) {
    refusals.push(`${entry.fullName}: no licence, not listed (run --refresh if it never was read)`);
    continue;
  }
  if (!entry.recipeBytes) {
    refusals.push(`${entry.fullName}: no RECIPE.md upstream, not listed`);
    continue;
  }
  for (const name of names) claimed.set(name, entry.fullName);
  const [o, r] = entry.fullName.split("/");
  entries.push({
    owner: entry.owner ?? o,
    repo: entry.repo ?? r,
    fullName: entry.fullName,
    url: `https://github.com/${entry.fullName}`,
    defaultBranch: entry.defaultBranch ?? "main",
    stars: entry.stars ?? 0,
    pushedAt: entry.pushedAt ?? "",
    headCommit: entry.headCommit ?? "",
    path: entry.path ?? "",
    name: entry.name ?? r,
    blurb: entry.blurb ?? "",
    modNames: names,
    hasKeys: Boolean(entry.hasKeys),
    hasPreview: Boolean(entry.hasPreview),
    recipeBytes: entry.recipeBytes ?? 0,
    previewUrl: entry.previewUrl ?? "",
    license: entry.license ?? "",
    mods: names.map((name) => ({ name, title: name, blurb: "" })),
  });
}

// What the index describes, without its two volatile stamps: the run's clock and our own entry's
// pushedAt. An unchanged tree keeps the committed values, so a release commit never rewrites this
// file and no catalog pull request conflicts with dev (#215).
const contentKey = (doc) => JSON.stringify({
  ...doc,
  generatedAt: "",
  mods: (doc.mods ?? []).map((e, i) => (i === 0 ? { ...e, pushedAt: "" } : e)),
});

const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  modCount: entries.reduce((n, e) => n + e.modNames.length, 0),
  repositoryCount: entries.length,
  source: "automagik-herdr",
  mods: entries,
};

if (previousIndex && contentKey(previousIndex) === contentKey(index)) {
  index.generatedAt = previousIndex.generatedAt;
  if (index.mods[0] && previousIndex.mods?.[0]) index.mods[0].pushedAt = previousIndex.mods[0].pushedAt;
}

const stale = (() => {
  const age = (Date.now() - Date.parse(previousIndex?.generatedAt)) / 86400000;
  return Number.isFinite(age) ? age : null;
})();

if (CHECK) {
  // Fields the repository itself determines. Upstream facts (stars, pushedAt, headCommit) and
  // generatedAt are noted when stale, never failed: a committed index would otherwise be unable
  // to pass a minute after it was written.
  const CONTENT = ["fullName", "path", "name", "blurb", "modNames", "license", "recipeBytes", "hasKeys", "hasPreview", "external"];
  // Upstream facts and the index's age are notes. headCommit is not compared at all: the pack entry
  // does not pin one (a committed index would go stale on the next commit).
  const UPSTREAM = ["stars", "pushedAt"];
  const problems = [];
  const staleNotes = [];
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    problems.push("catalog/index.json is missing or unreadable");
  }
  if (previous) {
    if (previous.schemaVersion !== index.schemaVersion) problems.push(`schemaVersion ${previous.schemaVersion} → ${index.schemaVersion}`);
    const key = (e) => `${e.fullName}\u0000${e.path ?? ""}`;
    const before = new Map((previous.mods ?? []).map((e) => [key(e), e]));
    for (const entry of entries) {
      const old = before.get(key(entry));
      if (!old) {
        problems.push(`${entry.fullName}: in this checkout, not in the index — regenerate`);
        continue;
      }
      for (const field of CONTENT) {
        if (JSON.stringify(old[field]) !== JSON.stringify(entry[field]))
          problems.push(`${entry.fullName}: ${field} ${JSON.stringify(old[field])} → ${JSON.stringify(entry[field])}`);
      }
      for (const field of UPSTREAM) {
        if (JSON.stringify(old[field]) !== JSON.stringify(entry[field]))
          staleNotes.push(`${entry.fullName}: ${field} moved upstream (${JSON.stringify(old[field])} → ${JSON.stringify(entry[field])}) — run --refresh when it matters`);
      }
      before.delete(key(entry));
    }
    for (const gone of before.keys()) problems.push(`${gone}: in the index, not in this checkout — regenerate`);
    if (previous.modCount !== index.modCount) problems.push(`modCount ${previous.modCount} → ${index.modCount}`);
    if (previous.repositoryCount !== index.repositoryCount) problems.push(`repositoryCount ${previous.repositoryCount} → ${index.repositoryCount}`);
    if (stale !== null && stale > STALE_DAYS) staleNotes.push(`index is ${stale.toFixed(1)} days old — --refresh brings upstream facts up to date`);
  }
  if (dirty) console.log("note: the checkout has uncommitted changes; the pack entry describes the committed tree, not the working copy");
  for (const line of refusals) console.log(`refused: ${line}`);
  for (const line of staleNotes) console.log(`stale: ${line}`);
  if (problems.length) {
    console.error("index disagrees with the checkout:");
    for (const line of problems) console.error(`  ✗ ${line}`);
    process.exit(1);
  }
  console.log(`catalog matches the checkout: ${index.repositoryCount} repo(s), ${index.modCount} mod(s)`);
  process.exit(0);
}

writeFileSync(OUT, JSON.stringify(index, null, 2) + "\n");
console.log(`catalog: ${index.repositoryCount} repo(s), ${index.modCount} mod(s) → ${OUT}`);
for (const e of entries) console.log(`  ${e.fullName}${e.path ? "/" + e.path : ""}  ${e.license || "?"}  ${e.modNames.join(", ")}`);
for (const line of refusals) console.log(`  refused: ${line}`);
