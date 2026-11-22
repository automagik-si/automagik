// Every mod the pack ships is loaded by Herdr's mod runtime (gpui-shell 0.7.1), which provides
// exactly the modules gpui-kit.d.ts declares and no `node:` prefix. A specifier outside that
// surface fails the whole mod at load ("am-sidebar did not load: cannot load module node:url",
// #624), so walk every shipped mod's import graph and hold every file to the runtime's names. A
// dynamic `import()` is followed when it names one plain quoted literal (its target joins the
// graph; a comment after the literal is read past); a computed target is refused, because the
// module it names cannot be checked. It checks
// the small named surfaces too: `url` exports only URL and URLSearchParams, so changing the
// specifier to `"url"` while importing fileURLToPath still fails. The runtime also hands a mod a
// bare `import.meta.url` path with a `?v=1` cache buster, not a `file:` URL, so a top-level
// `new URL(..., import.meta.url)` throws at load; only `guardDirOf` (workers.js) or a shared safe
// helper may read it, called bare (`helpers.guardDirOf(` is not it), and a bare top-level
// `import.meta` (an alias or `["url"]`) is refused. This
// is the #652 check, generalised from am-sidebar to every PACK_MODS folder; its entry comes from
// that mod's mod.json, never from guessing main.js.
//
// A known blind spot (#694): the scan blanks template literals whole, so code inside a `${}`
// substitution is not read. An `import()` whose target is a template with a substitution is
// refused as computed, which is where it matters; an `import.meta` or an `import()` written inside
// a substitution, and a URL or specifier a template builds, are not seen and not resolved.
// Apache-2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PACK_MODS, POCKET_LINK } from "../mods/am-sidebar/release.js";
import { GUARD_DIR, guardDirOf } from "../mods/am-sidebar/workers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MODS = join(ROOT, "mods");
const FIXTURES = join(HERE, "fixtures", "mod-imports");

// gpui-shell 0.7.1's modules, exactly the `declare module "<name>"` names of the gpui-kit.d.ts
// (gpui-kit 0.7.1) the Herdr app writes into a mod folder. This is the one list: the clean-pack
// row also compares it with an installed gpui-kit.d.ts whenever one is readable from this checkout.
const RUNTIME = "gpui-shell 0.7.1";
const RUNTIME_MODULES = new Set([
  "gpui-kit", "gpui", "gpui-base", "gpui-component", "gpui-shell", "gpui-fps",
  "buffer", "path", "url", "crypto", "zlib", "console", "process", "os", "fs/promises",
  "net", "websocket", "herdr",
]);

// The runtime modules with a small named surface, as gpui-kit.d.ts declares them. `url` is the
// load-time trap: URL and URLSearchParams exist there, fileURLToPath does not (and both are
// globals, so importing nothing from url is safest). Namespace and default imports of url are
// refused outright: a namespace has no declared use beyond those two names, and url has no
// default export.
const SURFACES = new Map([
  ["url", new Set(["URL", "URLSearchParams"])],
  ["fs/promises", new Set(["readFile", "writeFile", "readdir", "exists", "unlink", "rmdir", "mkdir"])],
  ["path", new Set(["join", "resolve", "dirname", "basename"])],
  ["os", new Set(["platform", "arch", "EOL"])],
  ["process", new Set(["run", "exit", "nextTick", "platform", "arch"])],
  ["crypto", new Set(["createHash", "randomBytes", "randomUUID", "webcrypto"])],
  ["zlib", new Set(["deflateSync", "inflateSync", "gzipSync", "gunzipSync"])],
  ["buffer", new Set(["Buffer"])],
]);
const DEFAULT_EXPORTS = new Set(["path", "console", "process", "os", "net"]);

// The helpers that may take `import.meta.url`: workers.js's guardDirOf turns the runtime's bare
// `?v=1` path and Node's `file:` URL into the same guard folder. A new safe helper joins this set.
const SAFE_META_HELPERS = new Set(["guardDirOf"]);
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with"]);
const DECL = /^[ \t]*(import|export)\s+([^;]*);/gm;

/** The names of an import or export list: `{ a, b as c }` -> ["a", "b"]. */
function namesOf(block) {
  return block.replace(/^\{/, "").replace(/\}[\s\S]*$/, "").split(",")
    .map((s) => s.trim().replace(/\s+as\s+[\s\S]+$/, "")).filter(Boolean);
}

/** One declaration's binding: its specifier, and whether it is a namespace/default/named one. */
function declarationOf(clause) {
  const out = { sideEffect: false, namespace: false, defaultImport: false, named: [] };
  const side = clause.match(/^["']([^"']+)["']$/);
  if (side) return { ...out, sideEffect: true, specifier: side[1] };
  const from = clause.match(/\bfrom\s*["']([^"']+)["']\s*$/);
  if (!from) return null;
  out.specifier = from[1];
  let bind = clause.slice(0, from.index).trim();
  if (!bind) return { ...out, sideEffect: true };
  if (bind.startsWith("*")) return { ...out, namespace: true };
  if (bind.startsWith("{")) return { ...out, named: namesOf(bind) };
  const comma = bind.indexOf(",");
  if (comma === -1) return { ...out, defaultImport: true };
  out.defaultImport = true;
  bind = bind.slice(comma + 1).trim();
  if (bind.startsWith("*")) out.namespace = true;
  else if (bind.startsWith("{")) out.named = namesOf(bind);
  return out;
}

/**
 * `text` with comments, strings, template literals and regex literals blanked out, newlines and
 * every index kept. The scan below needs code positions, not prose: an `import` line in a
 * comment or an `import.meta.url` in a template must not count. Regex literals are recognised by
 * what precedes the slash; a division is left as it is.
 */
function blankLiterals(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
  };
  const regexAllowed = (prev) => prev === "" || "([{=,:;!&|?+-*%^~<>".includes(prev);
  let i = 0;
  let prev = "";
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      const stop = end === -1 ? text.length : end;
      blank(i, stop); i = stop; continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === quote) { j++; break; }
        if (quote !== "`" && text[j] === "\n") { j++; break; }
        j++;
      }
      blank(i, j); i = j; prev = quote; continue;
    }
    if (c === "/" && regexAllowed(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        else if (text[j] === "/" && !inClass) { j++; break; }
        else if (text[j] === "\n") break;
        j++;
      }
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      blank(i, j); i = j; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** Whether the `{` at `index` opens a function body (`function`, `=>`, a method), not a block. */
function isFunctionBrace(code, index) {
  const before = code.slice(Math.max(0, index - 240), index).trimEnd();
  if (before.endsWith("=>")) return true;
  if (!before.endsWith(")")) return false;
  let depth = 0;
  let j = before.length - 1;
  for (; j >= 0; j--) {
    if (before[j] === ")") depth++;
    else if (before[j] === "(") { depth--; if (depth === 0) break; }
  }
  const head = before.slice(0, j).trimEnd();
  const word = (head.match(/([A-Za-z_$][\w$]*)$/) || [])[1] ?? "";
  return !CONTROL.has(word);
}

/**
 * The `import.meta` positions that run while the module is evaluated, outside every function body,
 * and are not handed to a safe helper. A use inside a function does not run at load, so it is not
 * this rule's concern; anything else does, and the runtime's bare path cannot be a URL base. The
 * same rule catches a bare `import.meta`, so an alias (`const m = import.meta;`) or
 * `import.meta["url"]` cannot slip past a literal `.url` scan. The scan is lexical: it knows
 * blocks and function bodies, not a full syntax tree.
 *
 * A function body is a braced one (`function`, a method, `=> {`) or an expression-bodied arrow
 * (`{ f: () => import.meta.url }`, #694). An expression body ends at the first `,` or `;` at its
 * own bracket depth, at the bracket that closes around it, or at a line end there once the body
 * has begun: a body continued on a next line outside brackets is read as ended, so the rule fails
 * closed. The helper must be called bare: `helpers.guardDirOf(` is some other function.
 */
function topLevelMetaUses(code) {
  const uses = [];
  const functions = [];
  // Each open expression-bodied arrow: the bracket depth it began at, and whether its body began.
  const arrows = [];
  let depth = 0;
  const endArrows = (ended) => { while (arrows.length && ended(arrows.at(-1))) arrows.pop(); };
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "\n") { endArrows((a) => a.depth === depth && a.begun); continue; }
    if (/\s/.test(c)) continue;
    if (c === "," || c === ";") { endArrows((a) => a.depth === depth); continue; }
    if (c === ")" || c === "]" || c === "}") {
      if (c === "}") functions.pop();
      depth--;
      endArrows((a) => a.depth > depth);
      continue;
    }
    for (const arrow of arrows) arrow.begun = true;
    if (c === "(" || c === "[") { depth++; continue; }
    if (c === "{") { functions.push(isFunctionBrace(code, i)); depth++; continue; }
    if (c === "=" && code[i + 1] === ">") {
      let j = i + 2;
      while (j < code.length && /\s/.test(code[j])) j++;
      if (code[j] !== "{") arrows.push({ depth, begun: false });
      i++;
      continue;
    }
    if (!code.startsWith("import.meta", i)) continue;
    if (!functions.some(Boolean) && arrows.length === 0) {
      const before = code.slice(Math.max(0, i - 64), i);
      const call = before.match(/([A-Za-z_$][\w$]*)\s*\(\s*$/);
      const bare = call && !before.slice(0, call.index).trimEnd().endsWith(".");
      if (!bare || !SAFE_META_HELPERS.has(call[1])) uses.push(i);
    }
    i += "import.meta".length - 1;
  }
  return uses;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * The plain string a dynamic `import(` at `index` names, or null. Only one quoted literal, alone as
 * the target (a following `)` or the options comma) and with no escape or template substitution,
 * is read: a computed target, even one that starts with a literal, is refused, never guessed.
 * What follows the literal is read in `code` (blankLiterals of `text`), so a comment between the
 * literal and its `)` or comma is read past (#694), a block comment or a line comment.
 */
function dynamicSpecifier(text, code, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i++;
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = text.indexOf(quote, i + 1);
  if (end === -1) return null;
  let after = end + 1;
  while (/\s/.test(code[after] ?? "")) after++;
  if (code[after] !== ")" && code[after] !== ",") return null;
  const value = text.slice(i + 1, end);
  if (value.includes("\\") || (quote === "`" && value.includes("${"))) return null;
  return value;
}

/** One entry file's import graph, with every specifier and load-time meta use checked. */
function walkGraph(entry, root, problems, seen) {
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) { problems.push(`${relative(root, file)}: imported but missing`); continue; }
    const text = readFileSync(file, "utf8");
    const code = blankLiterals(text);
    for (const m of code.matchAll(/\bimport\s*\(/g)) {
      const where = `${relative(root, file)}:${lineOf(text, m.index)}`;
      const spec = dynamicSpecifier(text, code, m.index + m[0].length);
      if (spec === null) {
        problems.push(`${where}: dynamic import() without a plain string target`);
      } else if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
      } else if (!RUNTIME_MODULES.has(spec)) {
        problems.push(`${where}: dynamic import("${spec}"): not a ${RUNTIME} module`);
      }
    }
    for (const index of topLevelMetaUses(code)) {
      problems.push(`${relative(root, file)}:${lineOf(text, index)}: top-level import.meta ` +
        "(the runtime's is a bare path with ?v=1; pass it to guardDirOf)");
    }
    const declarationLines = new Set();
    for (const m of text.matchAll(DECL)) {
      const keywordIndex = m.index + m[0].indexOf(m[1]);
      // A declaration that starts inside a comment, string or template is not a declaration.
      if (!code.startsWith(m[1], keywordIndex)) continue;
      declarationLines.add(lineOf(text, keywordIndex));
      const d = declarationOf(m[2].trim());
      if (!d?.specifier) continue;
      const spec = d.specifier;
      const where = `${relative(root, file)}:${lineOf(text, keywordIndex)}: ${m[1]} "${spec}"`;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      if (!RUNTIME_MODULES.has(spec)) {
        problems.push(`${where}: not a ${RUNTIME} module`);
        continue;
      }
      if (m[1] === "import" && spec === "url" && (d.namespace || d.defaultImport)) {
        problems.push(`${where}: import URL or URLSearchParams by name`);
      }
      if (m[1] === "import" && SURFACES.has(spec) && d.defaultImport && !DEFAULT_EXPORTS.has(spec)) {
        problems.push(`${where}: no default export`);
      }
      if (SURFACES.has(spec)) for (const name of d.named) {
        if (!SURFACES.get(spec).has(name)) problems.push(`${where}: ${name} is not exported`);
      }
    }
    // An import or export-from without a semicolon would slip past DECL, leaving a hole in the
    // graph; name it as a declaration the walk could not read instead of passing it silently.
    const codeLines = code.split("\n");
    const textLines = text.split("\n");
    for (let n = 0; n < codeLines.length; n++) {
      const start = codeLines[n].match(/^[ \t]*(import|export)\s+(?!\()/);
      if (!start || declarationLines.has(n + 1)) continue;
      if (start[1] === "export" && !/\bfrom\s*["']/.test(textLines.slice(n, n + 12).join("\n"))) continue;
      problems.push(`${relative(root, file)}:${n + 1}: unparsed ${start[1]} declaration (end it with a semicolon)`);
    }
  }
}

/**
 * Every mod under `modsDir` (or just `names`) read from its mod.json: the entry it declares is
 * the graph's root, so a mod whose entry is not main.js is walked like any other.
 */
function walkMods(modsDir, names) {
  const problems = [];
  const seen = new Set();
  const root = dirname(modsDir);
  const listed = names ?? readdirSync(modsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(modsDir, e.name, "mod.json")))
    .map((e) => e.name).sort();
  const walked = [];
  for (const name of listed) {
    const dir = join(modsDir, name);
    const manifestPath = join(dir, "mod.json");
    if (!existsSync(manifestPath)) { problems.push(`mods/${name}: no mod.json`); continue; }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      problems.push(`mods/${name}/mod.json: ${error.message}`);
      continue;
    }
    const entry = manifest.entry;
    if (typeof entry !== "string" || !entry) {
      problems.push(`mods/${name}/mod.json: no entry`);
      continue;
    }
    const entryPath = resolve(dir, entry);
    if (!entryPath.startsWith(dir + sep)) {
      problems.push(`mods/${name}/mod.json: entry escapes the mod folder`);
      continue;
    }
    if (!existsSync(entryPath)) {
      problems.push(`${relative(root, entryPath)}: entry is missing`);
      continue;
    }
    walked.push(name);
    walkGraph(entryPath, root, problems, seen);
  }
  return { problems, seen, mods: walked };
}

/** The gpui-kit.d.ts a Herdr app installed, when one is readable from this checkout: a pack
 * mod's own copy, the app home HERDR_APP_HOME names, and the person's real ~/.config/herdr-app
 * only with AUTOMAGIK_HERDR_APP_CHECK=1 (a test never reads a live app home by default). */
function installedDeclaration() {
  const candidates = [
    ...PACK_MODS.map((mod) => join(MODS, mod, "gpui-kit.d.ts")),
    process.env.HERDR_APP_HOME && join(process.env.HERDR_APP_HOME, "mods/am-sidebar/gpui-kit.d.ts"),
    process.env.AUTOMAGIK_HERDR_APP_CHECK === "1" && join(homedir(), ".config/herdr-app/mods/am-sidebar/gpui-kit.d.ts"),
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path)) ?? null;
}

test("the pack is every mods/<mod>/ with a mod.json, and each declares main.js for Herdr", () => {
  // Pocket Link is Pocket's (mods/pocket-link, never in PACK_MODS), so the pack's set is every
  // other folder with a mod.json. A new pack mod that forgets its mod.json fails here;
  // scripts/parts.mjs checks its part.
  const found = readdirSync(MODS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(MODS, e.name, "mod.json")))
    .map((e) => e.name).filter((name) => name !== POCKET_LINK).sort();
  assert.deepEqual(found, [...PACK_MODS].sort(), "herdr/mods' mod.json folders must be PACK_MODS");
  for (const mod of PACK_MODS) {
    const manifest = JSON.parse(readFileSync(join(MODS, mod, "mod.json"), "utf8"));
    // Herdr's loader requires main.js (herdr-app src/mods.rs scan_dir); the pack declares the
    // same entry its own gate reads, so the walk below never checks a file the runtime skips.
    assert.equal(manifest.entry, "main.js", `mods/${mod}/mod.json must declare entry main.js`);
  }
});

test("every shipped mod's import graph fits gpui-shell 0.7.1", () => {
  const { problems, seen, mods } = walkMods(MODS, PACK_MODS);
  assert.deepEqual([...mods].sort(), [...PACK_MODS].sort(), "every PACK_MODS mod must be walked");
  assert.ok(seen.size >= 40, `walked only ${seen.size} modules: the import scanner missed the graph`);
  assert.ok(seen.has(join(MODS, "am-sidebar/workers.js")), "the graph must reach workers.js, where GUARD_DIR lives");
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("an installed gpui-kit.d.ts declares exactly the runtime modules the walk allows", (t) => {
  const dts = installedDeclaration();
  if (!dts) {
    t.skip("no gpui-kit.d.ts: set HERDR_APP_HOME to a Herdr app home, or AUTOMAGIK_HERDR_APP_CHECK=1 to read ~/.config/herdr-app");
    return;
  }
  const declared = [...readFileSync(dts, "utf8").matchAll(/^declare module "([^"]+)"/gm)]
    .map((m) => m[1]).sort();
  assert.deepEqual(declared, [...RUNTIME_MODULES].sort(), `${dts} declares a different module set`);
});

test("a fixture mod importing node:url fails", () => {
  const { problems } = walkMods(join(FIXTURES, "node-url", "mods"));
  assert.match(problems.join("\n"), /entry\.js:\d+: import "node:url": not a gpui-shell 0\.7\.1 module/);
});

test('a fixture importing fileURLToPath from "url" fails', () => {
  const { problems } = walkMods(join(FIXTURES, "url-surface", "mods"));
  assert.match(problems.join("\n"), /entry\.js:\d+: import "url": fileURLToPath is not exported/);
});

test("a fixture with a top-level new URL(x, import.meta.url) fails", () => {
  const { problems } = walkMods(join(FIXTURES, "meta-url", "mods"));
  assert.match(problems.join("\n"), /entry\.js:\d+: top-level import\.meta/);
});

test("a fixture with an aliased top-level import.meta fails", () => {
  const { problems } = walkMods(join(FIXTURES, "meta-alias", "mods"));
  assert.match(problems.join("\n"), /entry\.js:1: top-level import\.meta/);
});

test('a fixture with a top-level import.meta["url"] fails', () => {
  const { problems } = walkMods(join(FIXTURES, "meta-bracket", "mods"));
  assert.match(problems.join("\n"), /entry\.js:1: top-level import\.meta/);
});

test("a fixture handing import.meta to guardDirOf passes", () => {
  const { problems } = walkMods(join(FIXTURES, "meta-helper", "mods"));
  assert.deepEqual(problems, []);
});

test("a fixture handing import.meta to a member named guardDirOf fails: the helper is called bare", () => {
  const { problems } = walkMods(join(FIXTURES, "meta-helper-member", "mods"));
  assert.match(problems.join("\n"), /entry\.js:3: top-level import\.meta/);
  assert.equal(problems.length, 1, problems.join("\n"));
});

test("a fixture's expression-bodied arrows may read import.meta; what follows one is still top level", () => {
  const { problems } = walkMods(join(FIXTURES, "meta-arrow", "mods"));
  // Lines 1 to 6 are arrow bodies, which run only when called. The rest runs at load: after the
  // comma that ends an arrow (8), after the line that ends one (10) and after its bracket (11).
  assert.deepEqual(problems.map((line) => line.replace(/: top-level import\.meta.*$/, "")), [
    "mods/meta-arrow/entry.js:8", "mods/meta-arrow/entry.js:10", "mods/meta-arrow/entry.js:11",
  ], problems.join("\n"));
});

test("a fixture mod whose entry is not main.js is still walked", () => {
  const { problems, seen } = walkMods(join(FIXTURES, "other-entry", "mods"));
  assert.ok(seen.has(join(FIXTURES, "other-entry", "mods/other-entry/boot.js")), "boot.js must be the walked entry");
  assert.match(problems.join("\n"), /mods\/other-entry\/boot\.js:\d+: import "node:url": not a gpui-shell 0\.7\.1 module/);
});

test("a fixture re-exporting node:url fails (export-from is walked)", () => {
  const { problems } = walkMods(join(FIXTURES, "export-from", "mods"));
  assert.match(problems.join("\n"), /entry\.js:\d+: export "node:url": not a gpui-shell 0\.7\.1 module/);
});

test("a fixture with a computed dynamic import() fails", () => {
  const { problems } = walkMods(join(FIXTURES, "dynamic-import", "mods"));
  assert.match(problems.join("\n"), /entry\.js:\d+: dynamic import\(\) without a plain string target/);
});

test("a fixture's literal dynamic import() target is walked", () => {
  const { problems, seen } = walkMods(join(FIXTURES, "dynamic-import-target", "mods"));
  const target = join(FIXTURES, "dynamic-import-target", "mods/dynamic-import-target/target.js");
  assert.ok(seen.has(target), "the literal import() target must join the graph");
  assert.match(problems.join("\n"), /target\.js:\d+: import "node:url": not a gpui-shell 0\.7\.1 module/);
});

test("a fixture's literal dynamic import() target followed by a comment is walked", () => {
  const { problems, seen } = walkMods(join(FIXTURES, "dynamic-import-comment", "mods"));
  const dir = join(FIXTURES, "dynamic-import-comment", "mods/dynamic-import-comment");
  assert.ok(seen.has(join(dir, "target.js")), "a block comment after the literal is read past");
  assert.ok(seen.has(join(dir, "other.js")), "a line comment after the literal is read past");
  assert.deepEqual(problems.map((line) => line.replace(/^.*\/entry\.js/, "entry.js")), [
    "entry.js:6: dynamic import() without a plain string target",
  ], "a literal followed by more than a comment is still computed");
});

test("guardDirOf: the guard folder beside the module, from either runtime's meta URL", () => {
  const MOD = join(MODS, "am-sidebar");
  assert.equal(GUARD_DIR, join(MOD, "guard"), "Node's file: URL still gives the same path");
  assert.equal(guardDirOf("file:///opt/herdr/mods/am-sidebar/workers.js"),
    "/opt/herdr/mods/am-sidebar/guard");
  assert.equal(guardDirOf("file:///opt/herdr/mods/am-sidebar/workers.js?v=1"),
    "/opt/herdr/mods/am-sidebar/guard");
  assert.equal(guardDirOf("file:///tmp/a%20b/workers.js?v=1"), "/tmp/a b/guard");
  assert.equal(guardDirOf("/Users/me/.config/herdr-app/mods/am-sidebar/workers.js?v=1"),
    "/Users/me/.config/herdr-app/mods/am-sidebar/guard", "the mod runtime's bare path plus ?v=1");
  assert.equal(guardDirOf("/tmp/a b/workers.js?v=1#frag"), "/tmp/a b/guard", "query and hash are stripped");
  assert.equal(guardDirOf("/tmp/a%20b/workers.js?v=1"), "/tmp/a%20b/guard", "a bare path is already a path");
  assert.equal(guardDirOf("C:/x/am-sidebar/workers.js?v=1"), "C:/x/am-sidebar/guard",
    "a drive-letter path is bare: new URL would read C: as a scheme and drop it");
  assert.equal(guardDirOf("C:\\x\\am-sidebar\\workers.js?v=1"), "C:\\x\\am-sidebar\\guard",
    "a backslash drive-letter path keeps its separator (#694)");
  assert.equal(guardDirOf("C:\\x\\am-sidebar/workers.js?v=1"), "C:\\x\\am-sidebar\\guard",
    "a drive-letter path with both separators comes back with one (#694)");
  assert.equal(guardDirOf("/tmp/a\\b/workers.js?v=1"), "/tmp/a\\b/guard",
    "off a drive letter a backslash is a file-name character and stays");
  assert.equal(guardDirOf("file:///tmp/a%/workers.js?v=1"), "/tmp/a%/guard",
    "a lone % keeps the undecoded pathname, never the raw file: string");
  assert.equal(guardDirOf("/tmp/a/workers.js?v=1/2"), "/tmp/a/guard",
    "a query with a / is stripped before the folder is taken");
});

test("workers.js loads with the runtime's bare import.meta.url and keeps the guard path", async () => {
  const file = join(MODS, "am-sidebar/workers.js");
  const bare = `${file}?v=1`;
  const runtimeUrl = `${pathToFileURL(file).href}?v=1`;
  const hook = registerHooks({
    load: (url, context, next) => {
      if (url !== runtimeUrl) return next(url, context);
      const source = readFileSync(file, "utf8");
      const transformed = source.replace("guardDirOf(import.meta.url)", `guardDirOf(${JSON.stringify(bare)})`);
      assert.notEqual(transformed, source, "the load must exercise a bare import.meta.url");
      return { format: "module", source: transformed, shortCircuit: true };
    },
  });
  try {
    const runtime = await import(runtimeUrl);
    assert.equal(runtime.GUARD_DIR, join(MODS, "am-sidebar/guard"));
    assert.equal(runtime.GUARD_DIR, GUARD_DIR);
  } finally {
    hook.deregister();
  }
});
