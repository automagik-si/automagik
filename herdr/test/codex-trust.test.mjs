// #1420: a Codex worker's per-launch folder trust, the pure part (models.js). Apache-2.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_MODE_ARGS, codexClean, codexProjectTrust, codexRunTrustBlock, codexTrustArgs, codexTrustKeptWarning,
  codexTrustPlan, codexTrustWarning, withCodexGrants, withCodexTrust } from "../mods/am-sidebar/models.js";
import { codexCommandCheck } from "../mods/am-sidebar/workers.js";

const word = (folder) => `projects={"${folder}"={trust_level="trusted"}}`;

test("codexTrustArgs: one inline-table -c word for exactly the folder, a dot in the path kept literal", () => {
  assert.deepEqual(codexTrustArgs("/home/u/.cache/wt/feat-x"), ["-c", word("/home/u/.cache/wt/feat-x")]);
  assert.deepEqual(codexTrustArgs("/p/wt"), ["-c", word("/p/wt")]);
  // A backslash and a double quote are escaped as TOML basic-string escapes; other text stays as written.
  assert.deepEqual(codexTrustArgs('/p/a"b\\c'), ["-c", 'projects={"/p/a\\"b\\\\c"={trust_level="trusted"}}']);
  assert.deepEqual(codexTrustArgs("/p/ção é/wt"), ["-c", word("/p/ção é/wt")]);
  assert.deepEqual(codexTrustArgs("/p/it's"), ["-c", word("/p/it's")]);
});

test("codexTrustArgs: no word for a relative path, the root, a control character, DEL or a non-string", () => {
  for (const bad of ["p/wt", "./wt", "", "/", "//", "/p/a\nb", "/p/a\tb", "/p/a\u0000b", "/p/a\u007fb", "/p/a\u001bb", null, undefined, 7, ["/p"]]) {
    assert.deepEqual(codexTrustArgs(bad), [], JSON.stringify(bad));
  }
});

test("withCodexTrust: the word goes right after the pack's mode words, before grants, model, subcommand and task", () => {
  const argv = ["codex", ...CODEX_MODE_ARGS, "--model", "gpt-6", "fix it"];
  assert.deepEqual(withCodexTrust(argv, "/p/wt"), ["codex", ...CODEX_MODE_ARGS, "-c", word("/p/wt"), "--model", "gpt-6", "fix it"]);
  const granted = withCodexGrants(argv, ["/p/.git"]);
  assert.deepEqual(withCodexTrust(granted, "/p/wt"),
    ["codex", ...CODEX_MODE_ARGS, "-c", word("/p/wt"), "--add-dir", "/p/.git", "--model", "gpt-6", "fix it"]);
  // A resume subcommand after the mode words stays after the word.
  assert.deepEqual(withCodexTrust(["codex", ...CODEX_MODE_ARGS, "resume", "abc"], "/p/wt"),
    ["codex", ...CODEX_MODE_ARGS, "-c", word("/p/wt"), "resume", "abc"]);
});

test("withCodexTrust: a copy unchanged without the mode words or a valid folder; the input is never changed", () => {
  const other = ["claude", "--permission-mode", "auto", "x"];
  const out = withCodexTrust(other, "/p/wt");
  assert.deepEqual(out, other);
  assert.notEqual(out, other);
  const argv = ["codex", ...CODEX_MODE_ARGS, "x"];
  assert.deepEqual(withCodexTrust(argv, "rel/wt"), argv);
  assert.deepEqual(withCodexTrust(argv, "/"), argv);
  assert.deepEqual(withCodexTrust(["codex", "x"], "/p/wt"), ["codex", "x"], "a template's own command has no anchor");
  assert.deepEqual(withCodexTrust(null, "/p/wt"), []);
  withCodexTrust(argv, "/p/wt");
  assert.deepEqual(argv, ["codex", ...CODEX_MODE_ARGS, "x"]);
});

test("the trust word passes the pack's own Codex readers untouched: codexClean keeps it, codexCommandCheck names no conflict", () => {
  const argv = withCodexTrust(["codex", ...CODEX_MODE_ARGS, "x"], "/p/.cache/wt");
  const cleaned = codexClean(argv);
  assert.deepEqual(cleaned.dropped, []);
  assert.ok(cleaned.argv.includes(word("/p/.cache/wt")));
  const check = codexCommandCheck(argv.join(" ").replace(word("/p/.cache/wt"), `'${word("/p/.cache/wt")}'`));
  assert.deepEqual(check?.conflicts ?? [], []);
});

test("codexProjectTrust: table headers, dotted keys, [projects] tables and quoted keys, decoded", () => {
  const text = [
    "model = \"gpt-6\"",
    "[projects.\"/a/wt\"]",
    "trust_level = \"untrusted\"",
    "[projects]",
    "\"/b\".trust_level = 'trusted'",
    "[projects.'/c.d']",
    "trust_level = \"\\u0075ntrusted\"",
    "[tui]",
    "x = 1",
  ].join("\n");
  const r = codexProjectTrust(text);
  assert.equal(r.unsure, false);
  assert.deepEqual([...r.entries], [["/a/wt", "untrusted"], ["/b", "trusted"], ["/c.d", "untrusted"]]);
  const dotted = codexProjectTrust("projects.\"/e\".trust_level = \"untrusted\"\nprojects.\"/f\\u002eg\".trust_level = \"trusted\"\n");
  assert.deepEqual([...dotted.entries], [["/e", "untrusted"], ["/f.g", "trusted"]]);
  assert.equal(dotted.unsure, false);
});

test("codexProjectTrust: comments and multi-line strings never count; empty text is no entries", () => {
  const r = codexProjectTrust([
    "# [projects.\"/a\"]",
    "# trust_level = \"untrusted\"",
    "notes = \"\"\"",
    "[projects.\"/b\"]",
    "trust_level = \"untrusted\"",
    "\"\"\"",
    "[projects.\"/c\"] # trusted here",
    "trust_level = \"trusted\" # not untrusted",
  ].join("\n"));
  assert.equal(r.unsure, false);
  assert.deepEqual([...r.entries], [["/c", "trusted"]]);
  for (const empty of [null, undefined, ""]) assert.deepEqual(codexProjectTrust(empty), { entries: new Map(), unsure: false });
});

test("codexProjectTrust: what the narrow reader can't prove is unsure", () => {
  for (const text of [
    "projects = { \"/a\" = { trust_level = \"untrusted\" } }",
    "[projects]\n\"/a\" = { trust_level = \"untrusted\" }",
    "projects.\"/a\" = { trust_level = \"trusted\" }",
    "[[projects]]\npath = \"/a\"",
    "[projects.\"/a\"]\ntrust_level = 1",
    "[projects.\"/a\"]\ntrust_level = [\"trusted\"]",
    "[projects.\"/a\"]\ntrust_level = \"trusted\"\n[projects.\"/a\"]\ntrust_level = \"untrusted\"",
    "project_root_markers = [\".hg\"]",
    "[project_root_markers]",
    "model = \"open",
    "notes = '''never closed",
  ]) assert.equal(codexProjectTrust(text).unsure, true, text);
});

test("codexRunTrustBlock: a run that picks its own folder, profile or projects, or a wrapper, blocks the word", () => {
  for (const run of [["codex", "-C", "/x"], ["codex", "--cd", "/x"], ["codex", "--cd=/x"], ["codex", "-C/x"],
    ["codex", "--profile", "r"], ["codex", "-p", "r"], ["codex", "--profile=r"], ["codex", "-pr"]]) {
    assert.match(codexRunTrustBlock(run) ?? "", /folder|profile/, JSON.stringify(run));
  }
  for (const run of [["codex", "-c", 'projects={"/x"={trust_level="untrusted"}}'], ["codex", "-c", '"projects"."/p".trust_level="untrusted"'],
    ["codex", "--config", "projects.x.trust_level=untrusted"], ["codex", "--config=projects={}"], ["codex", "-cprojects={}"],
    ["codex", "-c", "project_root_markers=[]"]]) {
    assert.equal(codexRunTrustBlock(run), "projects", JSON.stringify(run));
  }
  for (const run of [["env", "CODEX_HOME=/x", "codex"], ["node", "/x/codex.js"], ["sh", "-c", "codex"], [], null]) {
    assert.equal(codexRunTrustBlock(run), "wrapper", JSON.stringify(run));
  }
  for (const run of [["codex"], ["/usr/local/bin/codex"], ["codex", "-m", "gpt-6"], ["codex", "-c", "model=\"gpt-6\""],
    ["codex", "-m", "-C"], ["codex", "--", "-C", "/x"]]) {
    assert.equal(codexRunTrustBlock(run), null, JSON.stringify(run));
  }
});

test("codexTrustPlan: the word when nothing refuses it; a trusted entry for the folder or root never blocks", () => {
  const base = { folder: "/p/.wt/feat", roots: ["/p"], run: ["codex"], home: "/home/u" };
  assert.deepEqual(codexTrustPlan(base), { args: ["-c", word("/p/.wt/feat")], withheld: null });
  assert.equal(codexTrustPlan({ ...base, configs: [{ error: { code: "ENOENT" } }, { text: "" }] }).withheld, null);
  const trusted = "[projects.\"/p\"]\ntrust_level = \"trusted\"\n[projects.\"/p/.wt/feat\"]\ntrust_level = \"trusted\"\n";
  assert.equal(codexTrustPlan({ ...base, configs: [{ text: trusted }] }).withheld, null);
  // Another project's refusal in the same file is that project's alone.
  const other = "[projects.\"/p\"]\ntrust_level = \"trusted\"\n[projects.\"/q\"]\ntrust_level = \"untrusted\"\n";
  assert.equal(codexTrustPlan({ ...base, configs: [{ text: other }] }).withheld, null);
  // A parent marked untrusted is not one Codex consults: it doesn't block either.
  assert.equal(codexTrustPlan({ ...base, configs: [{ text: "[projects.\"/\"]\ntrust_level = \"untrusted\"\n" }] }).withheld, null);
});

test("codexTrustPlan: each refusal withholds the word, in order", () => {
  const base = { folder: "/p/.wt/feat", roots: ["/p"], run: ["codex"], home: "/home/u" };
  const no = (over) => codexTrustPlan({ ...base, ...over });
  assert.deepEqual(no({ folder: "rel" }), { args: [], withheld: "folder" });
  assert.equal(no({ folder: "/" }).withheld, "folder");
  assert.equal(no({ folder: "/home/u" }).withheld, "home");
  assert.equal(no({ folder: "/home/u/" }).withheld, "home");
  assert.equal(no({ run: ["codex", "-C", "/x"] }).withheld, "command");
  assert.equal(no({ run: ["env", "CODEX_HOME=/x", "codex"] }).withheld, "command");
  assert.equal(no({ roots: null }).withheld, "root");
  assert.equal(no({ roots: [] }).withheld, "root");
  assert.equal(no({ configs: [{ error: { code: "EACCES" } }] }).withheld, "unreadable");
  assert.equal(no({ configs: [{ error: { code: "EISDIR" } }] }).withheld, "unreadable");
  assert.equal(no({ configs: [{ text: "projects = {}" }] }).withheld, "unsure");
  for (const [path, level] of [["/p/.wt/feat", "untrusted"], ["/p/.wt/feat/", "untrusted"], ["/p", "untrusted"], ["/p", "\\u0075ntrusted"],
    ["/p", "Trusted"], ["/p", ""]]) {
    const text = `[projects."${path}"]\ntrust_level = "${level}"\n`;
    assert.equal(no({ configs: [{ text }] }).withheld, "untrusted", text);
  }
  // Any layer refusing is enough: the system file, the managed file, the person's.
  assert.equal(no({ configs: [{ text: "" }, { text: "[projects.\"/p\"]\ntrust_level = \"untrusted\"\n" }, { text: "" }] }).withheld, "untrusted");
});

test("codexTrustPlan: paths compare as written and through realpath (a symlinked home or root)", () => {
  const real = { "/link/home": "/real/home", "/link/p": "/real/p", "/real/home": "/real/home", "/real/p": "/real/p" };
  const realpath = (p) => real[p] ?? null;
  assert.equal(codexTrustPlan({ folder: "/real/home", roots: ["/real/p"], run: ["codex"], home: "/link/home", realpath }).withheld, "home");
  const text = "[projects.\"/link/p\"]\ntrust_level = \"untrusted\"\n";
  assert.equal(codexTrustPlan({ folder: "/real/p/wt", roots: ["/real/p"], configs: [{ text }], run: ["codex"], home: "/h", realpath }).withheld, "untrusted");
  // A realpath that throws keeps the written comparison.
  const throws = () => { throw new Error("no"); };
  assert.equal(codexTrustPlan({ folder: "/p/wt", roots: ["/p"], configs: [{ text: "[projects.\"/p\"]\ntrust_level = \"untrusted\"\n" }],
    run: ["codex"], home: "/h", realpath: throws }).withheld, "untrusted");
  assert.equal(codexTrustPlan({ folder: "/p/wt", roots: ["/p"], run: ["codex"], home: "/h", realpath: throws }).withheld, null);
});

test("the warnings say why, that the folder wasn't pre-trusted and that Codex may stop; one line, no config text", () => {
  for (const why of ["folder", "home", "command", "root", "unreadable", "unsure", "untrusted", "something-new"]) {
    const line = codexTrustWarning("Dev's Codex worker", why);
    assert.match(line, /^Dev's Codex worker: .+, so its folder wasn't pre-trusted and Codex may stop at its folder-trust prompt until a person answers it in the worker's pane\.$/);
    assert.doesNotMatch(line, /\n/);
  }
  assert.match(codexTrustWarning("W", "untrusted"), /settings mark the worktree or its repository untrusted/);
  assert.match(codexTrustWarning("W", "unreadable"), /settings can't be read/);
  assert.match(codexTrustWarning("W", "command"), /picks its own folder, profile or projects/);
  assert.match(codexTrustKeptWarning("W", "proxy"), /^W: starts through the hc proxy, so its folder wasn't pre-trusted/);
  assert.match(codexTrustKeptWarning("W", "template dev-sol owns its command"), /^W: template dev-sol owns its command, so its folder/);
  assert.doesNotMatch(codexTrustKeptWarning("W", "a\nb"), /\n/);
});
