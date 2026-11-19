// Antigravity's per-launch permission list (#823): the rules agy 1.5.3 takes, the effective
// allow and deny lists by scope and role, the deterministic settings file under the app home,
// the launch words, and the host's terminal-sandbox evidence. Pure: no program runs, no file is
// read from the real home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGY_FIXED_DENY, AGY_KILL_DENY, AGY_READ_ALLOW, AGY_SHELL_READ, AGY_WRITE_ALLOW,
  agyPermissionPlan, agyRuleProblem, agySandbox, agySettingsArgs, agySettingsDir, agySettingsFile, agySettingsPlan,
  agyTrustedWorkspaces, normalizeAgyPermissions, withAgySettings, withoutAgySettings,
} from "../mods/am-sidebar/models.js";
import { checkBots, parseBots } from "../mods/am-sidebar/model.js";
import { helperPlan, restartPlan } from "../mods/am-sidebar/restart.js";

const BOT = Object.freeze({ id: "b-aaaaaaaaaa", name: "Genie", agent: "antigravity" });
const SEAT = "/work/proj";
const APP = "/home/u/.config/herdr-app";
const SETTINGS = agySettingsDir(APP);
const SHELL_READ = Object.freeze([
  "ls", "cat", "head", "tail", "grep", "wc", "diff", "pwd", "echo", "cut", "tr", "jq", "printf",
  "basename", "dirname", "true", "which", "stat", "realpath", "readlink", "date", "nl", "comm",
  "column",
]);
const WRITER_ONLY_SHELL = Object.freeze([
  "command(mkdir)", "command(chmod)", "command(rg)", "command(sort)", "command(uniq)", "command(sed -n)",
]);
const READ_HC_RULES = Object.freeze([
  "command(hc ls)", "command(hc get)", "command(hc read)", "command(hc wait)", "command(hc send)",
]);
const FORBIDDEN_SHELL = Object.freeze([
  "command(bash)", "command(sh)", "command(env)", "command(xargs)",
  "command(find)", "command(awk)", "command(tee)", "command(sed)",
]);

test("agyRuleProblem: command and write_file rules, never junk", () => {
  for (const rule of ["command(hc)", "command(gh pr view)", "write_file(/work/proj)", "write_file(/)"]) {
    assert.equal(agyRuleProblem(rule), null, rule);
  }
  assert.match(agyRuleProblem(""), /a rule is text/);
  assert.match(agyRuleProblem(42), /a rule is text/);
  assert.match(agyRuleProblem("hc"), /isn't a rule/);
  assert.match(agyRuleProblem("exec(hc)"), /unknown rule type exec/);
  assert.match(agyRuleProblem("command()"), /no command/);
  assert.match(agyRuleProblem("write_file(relative/path)"), /absolute folder/);
  assert.match(agyRuleProblem("write_file(/a)b)"), /can't hold/);
  assert.match(agyRuleProblem("command(hc)\ncommand(git)"), /line break/);
});

test("normalizeAgyPermissions: trims, dedupes, keeps the good rules and says what it dropped", () => {
  const ok = normalizeAgyPermissions({ allow: [" command(hc) ", "command(npm)", "command(hc)"], deny: ["command(gh release)"] });
  assert.deepEqual([ok.allow, ok.deny, ok.problems], [["command(hc)", "command(npm)"], ["command(gh release)"], []]);
  const bad = normalizeAgyPermissions({ allow: ["command(hc)", "nope"], deny: "command(git)", extra: 1 });
  assert.deepEqual(bad.allow, ["command(hc)"]);
  assert.deepEqual(bad.deny, []);
  assert.equal(bad.problems.length, 3);
  assert.match(bad.problems.join("\n"), /"nope" isn't a rule/);
  assert.match(bad.problems.join("\n"), /deny is not a list/);
  assert.match(bad.problems.join("\n"), /extra isn't allow or deny/);
  assert.match(normalizeAgyPermissions(null).problems[0], /not an object/);
});

test("agyTrustedWorkspaces (#879): only the launch's own absolute folder, trailing slashes stripped, never the root", () => {
  assert.deepEqual(agyTrustedWorkspaces(SEAT), [SEAT]);
  assert.deepEqual(agyTrustedWorkspaces(`  ${SEAT}/  `), [SEAT], "trimmed, trailing slashes stripped");
  assert.deepEqual(agyTrustedWorkspaces(`${SEAT}//`), [SEAT]);
  assert.deepEqual(agyTrustedWorkspaces("/a"), ["/a"]);
  for (const bad of [null, undefined, "", "/", "///", "work/proj", "./proj", 42, ["/work/proj"],
    "/work/a\n/work/b", "/work/a\r", "/work/a\0b"]) {
    assert.deepEqual(agyTrustedWorkspaces(bad), [], JSON.stringify(bad) ?? String(bad));
  }
});

test("agyPermissionPlan: a writer seat gets its project's write_file, tools, gates, PR-writing gh verbs and every fixed deny", () => {
  const plan = agyPermissionPlan({ bot: BOT, scope: "seat", folder: SEAT });
  for (const rule of ["command(hc)", "command(git)", "command(node)", "command(bun)", ...WRITER_ONLY_SHELL,
    "command(gh pr view)", "command(gh pr create)", "command(gh pr edit)", "command(gh pr comment)",
    "command(node --test)", "command(node --check)", "command(bun test)", "command(node scripts/privacy-check.mjs)",
    "command(node ../scripts/am-copies.mjs)", `write_file(${SEAT})`]) {
    assert.ok(plan.allow.includes(rule), rule);
  }
  for (const tool of SHELL_READ) assert.ok(plan.allow.includes(`command(${tool})`), `writer allow command(${tool})`);
  for (const bad of FORBIDDEN_SHELL) assert.equal(plan.allow.includes(bad), false, `writer never allows ${bad}`);
  assert.ok(!plan.allow.includes("command(gh pr merge)"), "merge is never allowed by the defaults");
  assert.ok(!plan.allow.includes("command(gh release view)"), "the fixed gh release deny would shadow it");
  for (const rule of AGY_FIXED_DENY) assert.equal(plan.allow.includes(rule), false, `no allow shadowed by ${rule}`);
  assert.deepEqual(plan.deny, [...AGY_FIXED_DENY, ...AGY_KILL_DENY], "the fixed denies, all of them");
  for (const rule of ["command(git push --force)", "command(git push --force-with-lease)", "command(git push -f)",
    "command(git push origin --force)", "command(git push origin -f)",
    "command(git push --mirror)", "command(git push --delete)", "command(git reset --hard)",
    "command(git branch -D)", "command(git clean)", "command(git rebase)", "command(git stash)",
    "command(git checkout --)", "command(git -C)", "command(rm -rf)", "command(gh pr merge)",
    "command(gh release)"]) assert.ok(plan.deny.includes(rule), rule);
  assert.deepEqual(plan.warnings, []);
});

test("agyPermissionPlan: a reviewer seat and a review worker are read-only: no write_file, no writer shell", () => {
  const seat = agyPermissionPlan({ bot: { ...BOT, rank: "reviewer" }, scope: "seat", folder: SEAT });
  const worker = agyPermissionPlan({ bot: BOT, scope: "worker", role: "review", folder: "/work/wt" });
  for (const plan of [seat, worker]) {
    assert.equal(plan.allow.some((r) => r.startsWith("write_file(")), false, "nothing writable");
    for (const rule of READ_HC_RULES) assert.ok(plan.allow.includes(rule), `read-only hc ${rule}`);
    for (const rule of ["command(hc)", "command(hc run)", "command(hc exec)"]) {
      assert.equal(plan.allow.includes(rule), false, `read-only excludes ${rule}`);
    }
    for (const tool of SHELL_READ) assert.ok(plan.allow.includes(`command(${tool})`), `read-only allow command(${tool})`);
    for (const bad of FORBIDDEN_SHELL) assert.equal(plan.allow.includes(bad), false, `read-only never allows ${bad}`);
    assert.ok(plan.allow.includes("command(git diff)"));
    assert.ok(!plan.allow.includes("command(git)"), "no git subcommand at all");
    assert.ok(!plan.allow.includes("command(node)"), "no generic node");
    for (const rule of WRITER_ONLY_SHELL) {
      assert.equal(plan.allow.includes(rule), false, `no ${rule} on read-only roles`);
    }
    assert.ok(plan.allow.includes("command(node --test)"), "the test runners stay: they read");
    assert.ok(plan.allow.includes("command(bun test)"));
    assert.ok(plan.allow.includes("command(gh pr view)"), "reads stay");
    for (const rule of ["command(gh pr create)", "command(gh pr edit)", "command(gh pr comment)", "command(gh release view)"]) {
      assert.equal(plan.allow.includes(rule), false, `a read-only launch never gets ${rule}`);
    }
    assert.deepEqual(plan.deny, [...AGY_FIXED_DENY, ...AGY_KILL_DENY]);
  }
  // The writer roles keep write_file, bare command(hc), and the writer-only shell tools; the review role doesn't.
  for (const role of ["dev", "test", "fix"]) {
    const w = agyPermissionPlan({ bot: BOT, scope: "worker", role, folder: "/work/wt" });
    assert.ok(w.allow.includes("write_file(/work/wt)"), role);
    assert.ok(w.allow.includes("command(hc)"), `${role} gets command(hc)`);
    for (const rule of WRITER_ONLY_SHELL) assert.ok(w.allow.includes(rule), `${role} gets ${rule}`);
    for (const tool of SHELL_READ) assert.ok(w.allow.includes(`command(${tool})`), `${role} gets command(${tool})`);
    for (const bad of FORBIDDEN_SHELL) assert.equal(w.allow.includes(bad), false, `${role} excludes ${bad}`);
  }
});

test("agyPermissionPlan and agySettingsPlan (#879): a writer launch trusts its own folder only, never a parent or the home", () => {
  const plan = agyPermissionPlan({ bot: BOT, scope: "seat", folder: SEAT });
  assert.deepEqual(plan.trustedWorkspaces, [SEAT], "the project folder, exact");
  const settings = agySettingsPlan({ bot: BOT, scope: "seat", folder: `${SEAT}/`, settingsDir: SETTINGS });
  assert.deepEqual(settings.trustedWorkspaces, [SEAT]);
  const data = JSON.parse(settings.text);
  assert.deepEqual(data.trustedWorkspaces, [SEAT], "the file agy reads lists the launch's own folder");
  for (const wrong of ["/work", "/", "/home", "/home/u", APP]) {
    assert.equal(data.trustedWorkspaces.includes(wrong), false, `never ${wrong}`);
  }
});

test("agyPermissionPlan and agySettingsPlan (#879): a writer worker role trusts its worktree only", () => {
  for (const role of ["dev", "test", "fix"]) {
    const plan = agyPermissionPlan({ bot: BOT, scope: "worker", role, folder: "/work/wt" });
    assert.deepEqual(plan.trustedWorkspaces, ["/work/wt"], role);
    const data = JSON.parse(agySettingsPlan({ bot: BOT, scope: "worker", role, folder: "/work/wt", settingsDir: SETTINGS }).text);
    assert.deepEqual(data.trustedWorkspaces, ["/work/wt"], role);
    for (const wrong of ["/work", "/", "/home/u", APP]) {
      assert.equal(data.trustedWorkspaces.includes(wrong), false, `${role} never trusts ${wrong}`);
    }
  }
});

test("agyPermissionPlan and agySettingsPlan (#1046): a review launch trusts its own folder, still read-only", () => {
  // #1046: a review launch is trusted for its own folder like any other, so an unattended
  // `--role review` worker never hangs at agy's first-run trust question. Its allow list stays
  // the read-only one: no write_file and no writer shell tools.
  const reviewer = { ...BOT, rank: "reviewer" };
  const seat = agyPermissionPlan({ bot: reviewer, scope: "seat", folder: SEAT });
  assert.deepEqual(seat.trustedWorkspaces, [SEAT], "a reviewer seat trusts its project");
  assert.deepEqual([...seat.allow], [...AGY_READ_ALLOW], "its allow list is the read-only one");
  assert.equal(seat.allow.some((rule) => rule.startsWith("write_file(")), false, "and writes nothing");
  const seatFile = JSON.parse(agySettingsPlan({ bot: reviewer, scope: "seat", folder: SEAT, settingsDir: SETTINGS }).text);
  assert.deepEqual(seatFile.trustedWorkspaces, [SEAT], "its file names the project");
  assert.equal(seatFile.permissions.allow.some((rule) => rule.startsWith("write_file(")), false, "and writes nothing there");
  const review = agyPermissionPlan({ bot: BOT, scope: "worker", role: "review", folder: "/work/wt" });
  assert.deepEqual(review.trustedWorkspaces, ["/work/wt"], "a review worker trusts its worktree");
  assert.deepEqual([...review.allow], [...AGY_READ_ALLOW], "its allow list is the read-only one");
  const reviewFile = JSON.parse(agySettingsPlan({ bot: BOT, scope: "worker", role: "review", folder: "/work/wt",
    settingsDir: SETTINGS }).text);
  assert.deepEqual(reviewFile.trustedWorkspaces, ["/work/wt"], "its file names the worktree");
  // The scope's role, not the rank, decides a worker: a reviewer bot's dev worker writes and
  // trusts its worktree, and a dev bot's review worker trusts its worktree without writing.
  assert.deepEqual(agyPermissionPlan({ bot: reviewer, scope: "worker", role: "dev", folder: "/work/wt" }).trustedWorkspaces,
    ["/work/wt"]);
  assert.deepEqual(agyPermissionPlan({ bot: BOT, scope: "worker", role: "review", folder: SEAT }).trustedWorkspaces, [SEAT]);
});

test("agyPermissionPlan and agySettingsPlan (#884): a symlinked folder is trusted and written by its realpath", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-agy-real-")));
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    const plan = agyPermissionPlan({ bot: BOT, scope: "worker", role: "dev", folder: link, realpath: realpathSync });
    assert.deepEqual(plan.trustedWorkspaces, [target], "the folder it really is, not the link");
    assert.ok(plan.allow.includes(`write_file(${target})`), "write_file names the realpath");
    assert.equal(plan.allow.includes(`write_file(${link})`), false, "never the symlink");
    const file = JSON.parse(agySettingsPlan({ bot: BOT, scope: "seat", folder: link, settingsDir: SETTINGS,
      realpath: realpathSync }).text);
    assert.deepEqual(file.trustedWorkspaces, [target]);
    assert.ok(file.permissions.allow.includes(`write_file(${target})`));
    // Without the callback, or with one that throws (ENOENT on a synthetic test path), the
    // folder is used as given: the pure default every test above relies on.
    assert.deepEqual(agyTrustedWorkspaces(link), [link]);
    const enoent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    assert.deepEqual(agyTrustedWorkspaces("/work/wt", enoent), ["/work/wt"]);
    assert.deepEqual(agyPermissionPlan({ bot: BOT, scope: "worker", role: "dev", folder: "/work/wt", realpath: enoent }).trustedWorkspaces,
      ["/work/wt"]);
    // The same resolution applies to homeDir: a link to the home folder, or the home folder
    // itself, trusts nothing.
    assert.deepEqual(agyTrustedWorkspaces(link, realpathSync, target), [], "a link to the home folder is home");
    assert.deepEqual(agyTrustedWorkspaces(target, realpathSync, link), [], "a link as home settles the same");
    assert.deepEqual(agyTrustedWorkspaces(target, realpathSync, `${target}/`), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agyTrustedWorkspaces (#884 Low A): the home folder is never trusted, however it is written", () => {
  assert.deepEqual(agyTrustedWorkspaces("/home/u", null, "/home/u"), []);
  assert.deepEqual(agyTrustedWorkspaces("/home/u/", null, "/home/u/"), [], "both normalized");
  assert.deepEqual(agyTrustedWorkspaces("/home/u", null, "/home/u///"), []);
  assert.deepEqual(agyTrustedWorkspaces("/home/u/proj", null, "/home/u"), ["/home/u/proj"], "a project under home is fine");
  assert.deepEqual(agyTrustedWorkspaces("/home/u", null, ""), ["/home/u"], "no home given: unchanged");
  assert.deepEqual(agyTrustedWorkspaces("/home/u", null, null), ["/home/u"]);
  const plan = agyPermissionPlan({ bot: BOT, scope: "seat", folder: "/home/u", homeDir: "/home/u" });
  assert.deepEqual(plan.trustedWorkspaces, [], "the plan trusts nothing at home");
  assert.ok(plan.allow.includes("write_file(/home/u)"), "the writer rule itself is unchanged");
  const settings = agySettingsPlan({ bot: BOT, scope: "seat", folder: "/home/u", homeDir: "/home/u/", settingsDir: SETTINGS });
  assert.deepEqual(settings.trustedWorkspaces, []);
  assert.equal("trustedWorkspaces" in JSON.parse(settings.text), false, "the file leaves the key out");
  // A reviewer seat at a project under home is trusted for that project, and still read-only;
  // at the home folder itself it trusts nothing and its file leaves the key out.
  const reviewer = { ...BOT, rank: "reviewer" };
  assert.deepEqual(agyPermissionPlan({ bot: reviewer, scope: "seat", folder: "/home/u/proj", homeDir: "/home/u" }).trustedWorkspaces,
    ["/home/u/proj"], "a review project under home is trusted");
  assert.deepEqual(agyPermissionPlan({ bot: reviewer, scope: "seat", folder: "/home/u", homeDir: "/home/u" }).trustedWorkspaces, []);
  const reviewHome = JSON.parse(agySettingsPlan({ bot: reviewer, scope: "seat", folder: "/home/u", homeDir: "/home/u",
    settingsDir: SETTINGS }).text);
  assert.equal("trustedWorkspaces" in reviewHome, false, "a review launch at home leaves the key out");
});

test("agyPermissionPlan (#879): the root and an empty or absent folder trust nothing", () => {
  for (const folder of ["/", "///", "", null, undefined, 42]) {
    const seat = agyPermissionPlan({ bot: BOT, scope: "seat", folder });
    assert.deepEqual(seat.trustedWorkspaces, [], JSON.stringify(folder) ?? String(folder));
    const review = agyPermissionPlan({ bot: BOT, scope: "worker", role: "review", folder });
    assert.deepEqual(review.trustedWorkspaces, [], `review ${JSON.stringify(folder) ?? String(folder)}`);
    const data = JSON.parse(agySettingsPlan({ bot: BOT, scope: "seat", folder, settingsDir: SETTINGS }).text);
    assert.equal("trustedWorkspaces" in data, false, `settings ${JSON.stringify(folder) ?? String(folder)}`);
  }
});

test("agySettingsPlan is Antigravity's alone: Claude, Codex and dsh-tui launches never get its words", () => {
  for (const agent of ["claude", "codex", "dsh-tui"]) {
    assert.deepEqual(agySettingsArgs(agent, "/app/x.json"), [], agent);
    const plan = restartPlan({ bot: { agent }, run: [agent], runningAgent: agent, fresh: true });
    assert.equal(plan.agySettings, null, agent);
    assert.equal(plan.argv.includes("--settings"), false, agent);
    assert.deepEqual(plan.argv, [agent], `${agent}'s launch argv is byte-identical`);
  }
});

test("AGY_SHELL_READ (#840): 24 read-only shell tools in both default allow lists; writer-only tools and launchers excluded", () => {
  assert.deepEqual(AGY_SHELL_READ, SHELL_READ);
  assert.ok(AGY_WRITE_ALLOW.includes("command(hc)"));
  for (const rule of READ_HC_RULES) assert.ok(AGY_READ_ALLOW.includes(rule), `AGY_READ_ALLOW includes ${rule}`);
  for (const rule of ["command(hc)", "command(hc run)", "command(hc exec)"]) {
    assert.equal(AGY_READ_ALLOW.includes(rule), false, `AGY_READ_ALLOW excludes ${rule}`);
  }
  for (const tool of SHELL_READ) {
    assert.ok(AGY_WRITE_ALLOW.includes(`command(${tool})`), `AGY_WRITE_ALLOW includes command(${tool})`);
    assert.ok(AGY_READ_ALLOW.includes(`command(${tool})`), `AGY_READ_ALLOW includes command(${tool})`);
  }
  for (const bad of FORBIDDEN_SHELL) {
    assert.equal(AGY_WRITE_ALLOW.includes(bad), false, `AGY_WRITE_ALLOW excludes ${bad}`);
    assert.equal(AGY_READ_ALLOW.includes(bad), false, `AGY_READ_ALLOW excludes ${bad}`);
  }
  for (const rule of WRITER_ONLY_SHELL) {
    assert.ok(AGY_WRITE_ALLOW.includes(rule), `AGY_WRITE_ALLOW includes ${rule}`);
    assert.equal(AGY_READ_ALLOW.includes(rule), false, `AGY_READ_ALLOW excludes ${rule}`);
  }
});

test("README (#955): Antigravity's section says what runs without a prompt, that allow rules do nothing under the flag, and where the boundary is", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  // What --dangerously-skip-permissions lets through, said plainly (#998 review).
  assert.match(readme, /The allow rules do nothing under the flag\./);
  assert.match(readme, /agy asks nothing and runs no classifier/);
  for (const what of ["`python3 -c`", "`node -e`", "`bash -c`", "`sh`", "`env`", "`curl`", "`ssh`", "`cat x | sh`", "a child agent started by hand",
    "a write to the launch's own settings file", "`gh api <endpoint> -X PUT ...`", "anything else no deny rule names"]) {
    assert.ok(readme.includes(what), what);
  }
  assert.match(readme, /a plain \(non-force\) `git push`, to `dev` or `main` too/);
  assert.match(readme, /The real boundary is the hc-proxy sandbox/);
  assert.match(readme, /read-only by its brief only/);
  // #876: the read-only role's test runners and hc send, named plainly beside the other
  // program-running forms (the list is a guardrail, not a boundary).
  assert.match(readme, /`node --test` and `bun test` run any test file they are given/);
  assert.match(readme, /`hc send` \(an agent's prompt or a\s+shell's, as that pane decides\)/);
  // The paragraphs that claimed the narrow allow list or the per-command sh guard still hold are gone.
  assert.doesNotMatch(readme, /still needs `sh` to be allowed/);
  assert.doesNotMatch(readme, /The allow list is as narrow as the launch\s+needs/);
  assert.doesNotMatch(readme, /are left out of every default list/);
  // The deny list's additions and the verb that replaces hc kill for a lead.
  for (const rule of ["`am edit`", "`am restart`", "`am rm`", "`am create`", "`rm -fr`", "`rm -r -f`", "`rm -Rf`", "`git -c`", "`git --git-dir`",
    "`git restore .`", "`git checkout -f`", "`git branch --delete --force`"]) assert.ok(readme.includes(rule), rule);
  assert.match(readme, /automagik-herdr worker kill <pane> {5}# or: am worker kill <pane>/);
  // The owner's rule and its honest reach: enforced for dsh-TUI and Antigravity, not for Claude Code or Codex.
  assert.match(readme, /`hc kill` is for the seat of a project's main bot only/);
  assert.match(readme, /\| Claude Code, Codex, Antigravity and every other agent \(the `hc kill` shim is first on its PATH\) \| refused by the shim in every flag order/);
  assert.match(readme, /\*\*The boundary is the hc-proxy sandbox, never the shim\.\*\*/);
  assert.doesNotMatch(readme, /\*\*not enforced\.\*\*/, "the shim covers every agent's pane now");
  // #879/#1046: the file lists every launch's own folder, review launches included.
  assert.match(readme, /"trustedWorkspaces": \["<folder>"\]/);
  assert.match(readme, /`agy` 1\.5\.3 reads\s+`TrustedWorkspaces \[\]string json:"trustedWorkspaces,omitempty"` as a\s+top-level key of\s+`--settings`/s);
  assert.match(readme, /Never a parent\s+folder and never the home folder is listed/);
  assert.match(readme, /the project folder for a\s+seat, the worker's worktree for a worker \(a review worker included\), the helper's folder for a\s+helper/s);
  // #1046: what trusting a folder loads, and that a review launch is trusted for its own folder.
  assert.match(readme, /Trusting a folder lets agy load that\s+folder's project\s+customizations/);
  assert.match(readme, /review launch \(a worker with `role: "review"`, a seat with `rank: "reviewer"`\) is trusted the\s+same way \(#1046\)/);
  assert.match(readme, /never hangs at startup on the trust\s+question/);
  assert.match(readme, /leaves\s+`trustedWorkspaces` out entirely/);
});

test("agySettingsPlan: a roster allow identical to a fixed deny never cancels the deny", () => {
  const bot = { ...BOT, agyPermissions: { allow: ["command(git stash)", "command(git clean)"], deny: [] } };
  const plan = agySettingsPlan({ bot, scope: "seat", folder: SEAT, settingsDir: SETTINGS });
  const data = JSON.parse(plan.text).permissions;
  for (const rule of ["command(git stash)", "command(git clean)"]) {
    assert.ok(data.deny.includes(rule), `the fixed deny stays: ${rule}`);
    assert.ok(data.allow.includes(rule), "the roster's allow is carried beside it (agy's deny still wins)");
  }
});

test("agyPermissionPlan: the roster adds rules and can never drop a fixed deny", () => {
  const bot = { ...BOT, agyPermissions: { allow: ["command(npm publish)", "command(hc)", "command(gh release)"], deny: ["command(git stash)", "command(gh release)"] } };
  const plan = agyPermissionPlan({ bot, scope: "seat", folder: SEAT });
  assert.ok(plan.allow.includes("command(npm publish)"), "a roster rule is added");
  assert.equal(plan.allow.filter((r) => r === "command(hc)").length, 1, "a repeated rule is deduped");
  assert.ok(plan.allow.includes("command(gh release)"), "an allow can't drop a fixed deny (agy's deny wins)");
  assert.ok(plan.deny.includes("command(git stash)"), "a roster deny is added");
  assert.deepEqual(plan.deny.filter((r) => r === "command(gh release)").length, 1);
  for (const rule of AGY_FIXED_DENY) assert.ok(plan.deny.includes(rule), `kept ${rule}`);
});

test("agyPermissionPlan: a folder a rule can't hold leaves the write_file out with a plain warning", () => {
  const plan = agyPermissionPlan({ bot: BOT, scope: "worker", role: "dev", folder: "/work/a)b" });
  assert.equal(plan.allow.some((r) => r.startsWith("write_file(")), false);
  assert.match(plan.warnings.join("\n"), /Genie: .*can't hold/);
});

test("agySettingsFile: deterministic from the bot, scope, role and worktree; the folder's slash isn't doubled", () => {
  const seat = agySettingsFile(`${SETTINGS}/`, BOT.id);
  assert.equal(seat, `${SETTINGS}/${BOT.id}-seat.json`);
  assert.equal(agySettingsFile(SETTINGS, BOT.id, "seat"), seat, "same inputs, same path");
  const one = agySettingsFile(SETTINGS, BOT.id, "worker", "dev", "/work/a");
  assert.equal(agySettingsFile(SETTINGS, BOT.id, "worker", "dev", "/work/a"), one, "a restart of the same worker names the same file");
  assert.notEqual(agySettingsFile(SETTINGS, BOT.id, "worker", "dev", "/work/b"), one, "another worktree, another file");
  assert.notEqual(agySettingsFile(SETTINGS, BOT.id, "worker", "review", "/work/a"), one, "another role, another file");
  assert.ok(!one.includes("/work/a"), "the worktree is a tag, not a path in the name");
});

test("agySettingsPlan: the JSON agy reads, both arrays in full, private path under the app home", () => {
  const bot = { ...BOT, agyPermissions: { allow: ["command(npm publish)"], deny: [] } };
  const plan = agySettingsPlan({ bot, scope: "seat", folder: SEAT, settingsDir: SETTINGS });
  assert.equal(plan.path, agySettingsFile(SETTINGS, bot.id));
  const data = JSON.parse(plan.text);
  assert.deepEqual(Object.keys(data), ["permissions", "trustedWorkspaces"]);
  assert.deepEqual(Object.keys(data.permissions), ["allow", "deny"]);
  assert.deepEqual(data.trustedWorkspaces, [SEAT], "the launch's own folder, the only trusted one");
  assert.ok(data.permissions.allow.includes("command(npm publish)"));
  assert.ok(data.permissions.allow.includes(`write_file(${SEAT})`));
  assert.deepEqual(data.permissions.deny, [...AGY_FIXED_DENY, ...AGY_KILL_DENY]);
  assert.equal(plan.allow.length, data.permissions.allow.length);
  assert.equal(agySettingsPlan({ bot: BOT, settingsDir: null }), null, "no folder, no file");
  assert.equal(agySettingsPlan({ bot: { name: "no id" }, settingsDir: SETTINGS }), null);
});

test("agySettingsArgs, withoutAgySettings, withAgySettings: only agy changes, right after its program", () => {
  const path = "/app/automagik-herdr/agy-settings/b-seat.json";
  assert.deepEqual(agySettingsArgs("antigravity", path), ["--settings", path]);
  assert.deepEqual(agySettingsArgs("claude", path), []);
  assert.deepEqual(agySettingsArgs("antigravity", null), []);
  assert.deepEqual(withoutAgySettings("antigravity", ["agy", "--mode", "auto", "--settings", "/old.json", "-i", "t"]),
    ["agy", "--mode", "auto", "-i", "t"]);
  assert.deepEqual(withoutAgySettings("antigravity", ["agy", "--settings=/old.json", "--continue"]), ["agy", "--continue"]);
  assert.deepEqual(withoutAgySettings("claude", ["claude", "--settings", "x"]), ["claude", "--settings", "x"], "not agy's flag");
  assert.deepEqual(withAgySettings("antigravity", ["agy", "--mode", "auto", "--continue"], path),
    ["agy", "--settings", path, "--mode", "auto", "--continue"]);
  assert.deepEqual(withAgySettings("antigravity", ["agy", "--settings", "/old.json", "--mode", "plan"], path),
    ["agy", "--settings", path, "--mode", "plan"], "the old file is replaced, never doubled");
  const claude = ["claude", "--model", "m"];
  assert.deepEqual(withAgySettings("claude", claude, path), claude, "another agent's launch line is byte-identical");
  assert.deepEqual(withAgySettings("antigravity", ["sh", "-c", "agy --mode auto"], path), ["sh", "-c", "agy --mode auto"],
    "a shell command is left to its own builder");
});

test("agySandbox: Linux restrictions are a warning, unknown evidence only a note, other platforms unknown", () => {
  const read = (map) => (path) => (path in map ? map[path] : null);
  const clone = "/proc/sys/kernel/unprivileged_userns_clone";
  const max = "/proc/sys/user/max_user_namespaces";
  const apparmor = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  assert.equal(agySandbox({ platform: "linux", read: read({ [max]: "0\n" }) }).state, "missing");
  assert.equal(agySandbox({ platform: "linux", read: read({ [clone]: "0" }) }).state, "missing");
  assert.equal(agySandbox({ platform: "linux", read: read({ [apparmor]: "1\n" }) }).state, "missing");
  const open = agySandbox({ platform: "linux", read: read({ [max]: "15000\n", [apparmor]: "0\n" }) });
  assert.equal(open.state, "available");
  assert.match(open.detail, /not restricted/);
  const unknown = agySandbox({ platform: "linux", read: (path) => (path === max ? "15000" : undefined) });
  assert.equal(unknown.state, "unknown", "some controls unreadable, none restricted: a note");
  assert.equal(agySandbox({ platform: "linux", read: () => undefined }).state, "missing", "every control unreadable is evidence");
  assert.equal(agySandbox({ platform: "darwin", read: read({ "/usr/bin/sandbox-exec": "Mach-O" }) }).state, "available");
  assert.equal(agySandbox({ platform: "darwin", read: () => null }).state, "missing");
  assert.equal(agySandbox({ platform: "darwin", read: () => undefined }).state, "unknown");
  assert.equal(agySandbox({ platform: "win32", read: () => null }).state, "unknown");
  assert.equal(agySandbox({ platform: "linux", read: () => { throw new Error("nope"); } }).state, "missing",
    "a read that throws is unreadable evidence");
});

test("parseBots and checkBots: agyPermissions is normalized on load, refused by name on a save", () => {
  const text = JSON.stringify({ version: 1, categories: [], bots: [{ id: BOT.id, name: "A", kind: "main",
    look: { character: "star", colour: "blue" }, role: "", instructions: "", agent: "antigravity",
    agyPermissions: { allow: [" command(npm) ", "nope"], deny: ["command(git stash)"] } }] });
  const parsed = parseBots(text);
  assert.deepEqual(parsed.file.bots[0].agyPermissions, { allow: ["command(npm)"], deny: ["command(git stash)"] });
  assert.match(parsed.warnings.join("\n"), /agyPermissions: "nope" isn't a rule/);
  const empty = parseBots(JSON.stringify({ version: 1, categories: [], bots: [{ ...parsed.file.bots[0], agyPermissions: { allow: [] } }] }));
  assert.equal(empty.file.bots[0].agyPermissions, undefined, "no rules at all: no field");
  const badShape = parseBots(JSON.stringify({ version: 1, categories: [], bots: [{ ...parsed.file.bots[0], agyPermissions: "yolo" }] }));
  assert.equal(badShape.file.bots[0].agyPermissions, undefined);
  assert.match(badShape.warnings.join("\n"), /agyPermissions is not an object/);
  assert.deepEqual(checkBots(parsed.file), []);
  const errors = checkBots({ ...parsed.file, bots: [{ ...parsed.file.bots[0], agyPermissions: { allow: ["nope"], exec: [] } }] });
  assert.match(errors.join("\n"), /agyPermissions allow: "nope" isn't a rule/);
  assert.match(errors.join("\n"), /agyPermissions exec isn't allow or deny/);
});

test("restartPlan with the launch's file: --settings on the agent's row, its text in agySettings", () => {
  const bot = { id: BOT.id, agent: "antigravity", rank: "dev", agyPermissions: { allow: ["command(npm)"], deny: [] } };
  const plan = restartPlan({ bot, run: ["agy"], runningAgent: "antigravity", session: null, agy: { appHomeDir: APP, folder: SEAT } });
  const path = agySettingsFile(SETTINGS, BOT.id);
  assert.deepEqual(plan.argv, ["agy", "--mode", "auto", "--settings", path, "--continue"]);
  assert.equal(plan.agySettings.path, path);
  assert.deepEqual(plan.source, ["agy", "--mode", "auto"], "the comparison source names no settings file");
  assert.deepEqual(JSON.parse(plan.agySettings.text).permissions.allow.includes("command(npm)"), true);
  const claude = restartPlan({ bot: { agent: "claude" }, run: ["claude"], runningAgent: "claude" });
  assert.deepEqual(claude.argv, ["claude", "--continue"], "another agent's line is untouched");
  assert.equal(claude.agySettings, null);
});

test("helperPlan with the launch's file: a worker gets its worktree rule and file, a reused command's old file is replaced", () => {
  const agents = { antigravity: { run: ["agy"] } };
  const bot = { id: BOT.id, name: "Genie", agent: "antigravity", rank: "dev" };
  const worker = helperPlan({ get: { address: "t7", name: "w", cwd: SEAT, labels: { "worker.of": BOT.id, "worker.role": "dev" } },
    worker: { botId: BOT.id, worktree: SEAT, agent: "antigravity" }, session: null, agents,
    agy: { appHomeDir: APP, bot } });
  const path = agySettingsFile(SETTINGS, BOT.id, "worker", "dev", SEAT);
  assert.deepEqual(worker.argv, ["agy", "--dangerously-skip-permissions", "--mode", "auto", "--settings", path, "--continue"]);
  assert.equal(worker.agySettings.path, path);
  assert.ok(JSON.parse(worker.agySettings.text).permissions.allow.includes(`write_file(${SEAT})`));
  // A non-worker pane's command is reused, its older permission file replaced, never doubled.
  const old = ["agy", "--mode", "plan", "--settings", "/old.json", "--continue"];
  const pane = helperPlan({ get: { address: "t9", name: "p", cwd: SEAT, argv: old, foreground: { argv: old } },
    session: null, agents, agy: { appHomeDir: APP, bot } });
  assert.deepEqual(pane.argv, ["agy", "--mode", "plan", "--settings", agySettingsFile(SETTINGS, BOT.id, "helper", null, SEAT), "--continue"]);
  assert.equal(pane.agySettings.path, agySettingsFile(SETTINGS, BOT.id, "helper", null, SEAT), "its own file, never the seat's");
  // A shell template that can't take words runs without the list, and the note says so.
  const shell = ["sh", "-c", "agy --mode auto; # no words"];
  const broken = helperPlan({ get: { address: "t10", name: "t", cwd: SEAT, argv: shell, foreground: { argv: ["agy"] } },
    session: null, agents, fresh: null, agy: { appHomeDir: APP, bot } });
  assert.equal(broken.agySettings, null);
  assert.equal(broken.argv.includes("--settings"), false);
  assert.match(broken.note, /permission list/);
});

test("restartPlan: a template that can take the words gets the permission list; one that can't says why and leaves it out", () => {
  const bot = { id: BOT.id, agent: "antigravity" };
  const template = { name: "agy-sol", command: "agy --mode auto" };
  const plan = restartPlan({ bot, run: ["agy"], runningAgent: "antigravity", fresh: true, template, agy: { appHomeDir: APP, folder: SEAT } });
  const path = agySettingsFile(SETTINGS, BOT.id);
  assert.deepEqual(plan.argv, ["sh", "-c", `agy --mode auto "$@"`, "sh", "--settings", path]);
  assert.equal(plan.agySettings.path, path);
  const blocked = restartPlan({ bot, run: ["agy"], runningAgent: "antigravity", fresh: false,
    template: { name: "agy-sol", command: "agy --mode auto; # no words" }, agy: { appHomeDir: APP, folder: SEAT } });
  assert.equal(blocked.agySettings, null);
  assert.ok(!blocked.argv.includes("--settings"));
  assert.match(blocked.note, /separator or a comment.*permission list can't be added/);
});
