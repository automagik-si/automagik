// A16: the labels a bot pane carries for the event envelope (launchArgs.js), over plain data.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  paneLabels, roleOf, labelWords, relabelWords, detachWords, relabelPlan, startArgs, SQUAD_MARK,
  relabel, relabelWarning, leadPane, attachWords,
} from "../mods/am-sidebar/launchArgs.js";
import { parseBots, effectiveCategory } from "../mods/am-sidebar/model.js";

const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", test: "b-dddddddddd", plan: "b-eeeeeeeeee", pm: "b-ffffffffff" };
const bot = (id, kind, extra = {}) => ({ id, name: id.slice(2, 5), kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "", agent: "claude", ...extra });
const FILE = {
  version: 1,
  categories: [{ id: "eng", title: "Engineering" }, { id: "shared", title: "Shared" }],
  bots: [
    bot(ID.main, "main", { rank: "owner" }),
    bot(ID.cap, "member", { category: "eng", rank: "dev" }),
    bot(ID.dev, "member", { lead: ID.cap, rank: "dev", category: "shared" }), // a deeper member ignores its own category
    bot(ID.test, "member", { lead: ID.cap }),
    bot(ID.pm, "member", { category: "gone", rank: "pm" }),
    bot(ID.plan, "member", { agent: undefined, planned: { wave: 2 }, rank: "tester" }),
  ],
};
const file = (f = FILE) => parseBots(JSON.stringify(f)).file;

test("roleOf: main for the main bot, captain for a bot that leads, else the rank, else none", () => {
  const f = file();
  assert.equal(roleOf(f, ID.main), "main"); // its rank (owner) doesn't count
  assert.equal(roleOf(f, ID.cap), "captain"); // leads dev and test; its rank (dev) doesn't count
  assert.equal(roleOf(f, ID.dev), "dev");
  assert.equal(roleOf(f, ID.test), null);
  assert.equal(roleOf(f, "b-nonenonene"), null);
});

test("effectiveCategory: a direct report's own; a deeper member takes its chain's; unknown and main: none", () => {
  const f = file();
  assert.equal(effectiveCategory(f, ID.cap), "eng");
  assert.equal(effectiveCategory(f, ID.dev), "eng");
  assert.equal(effectiveCategory(f, ID.test), "eng");
  assert.equal(effectiveCategory(f, ID.pm), null);
  assert.equal(effectiveCategory(f, ID.main), null);
});

test("paneLabels: bot, role, category; a pane's squad is kept; else the lead pane's is copied and marked", () => {
  const f = file();
  assert.deepEqual(paneLabels(f, ID.main), { bot: ID.main, role: "main" });
  assert.deepEqual(paneLabels(f, ID.cap), { bot: ID.cap, role: "captain", category: "eng" });
  assert.deepEqual(paneLabels(f, ID.dev), { bot: ID.dev, role: "dev", category: "eng" });
  assert.deepEqual(paneLabels(f, ID.test), { bot: ID.test, category: "eng" }); // no rank: no role
  assert.deepEqual(paneLabels(f, ID.pm), { bot: ID.pm, role: "pm" }); // unknown category: none
  // Squad from the lead's pane, marked as copied; never over the pane's own.
  assert.deepEqual(paneLabels(f, ID.dev, {}, { squad: "memory" }), { bot: ID.dev, role: "dev", category: "eng", squad: "memory", [SQUAD_MARK]: "memory" });
  assert.deepEqual(paneLabels(f, ID.dev, { squad: "infra" }, { squad: "memory" }), { bot: ID.dev, role: "dev", category: "eng" });
  assert.deepEqual(paneLabels(f, ID.dev, {}, { role: "captain" }), { bot: ID.dev, role: "dev", category: "eng" }); // the lead has none
});

test("startArgs carries the labels after the bot label, skipping empty ones", () => {
  const args = startArgs({ botId: ID.dev, name: "dev", cwd: "/p", parent: ["--no-parent"], argv: ["claude"],
    labels: { bot: ID.dev, role: "dev", category: "", squad: "memory", [SQUAD_MARK]: "memory" } });
  assert.deepEqual(args.slice(args.indexOf("--cwd")), ["--cwd", "/p", "--label", `bot=${ID.dev}`, "--label", "role=dev",
    "--label", "squad=memory", "--label", `${SQUAD_MARK}=memory`, "--no-parent", "--", "claude"]);
});

test("labelWords sets what differs; detachWords takes off bot, role, category and only a copied squad", () => {
  assert.deepEqual(labelWords({ bot: ID.dev, role: "dev", category: "eng" }, { bot: ID.dev, role: "pm" }), ["role=dev", "category=eng"]);
  assert.deepEqual(labelWords({ bot: ID.dev }, { bot: ID.dev }), []);
  assert.deepEqual(detachWords({ bot: ID.dev, role: "dev", category: "eng", squad: "infra" }), ["bot=", "role=", "category="]);
  assert.deepEqual(detachWords({ bot: ID.dev, squad: "memory", [SQUAD_MARK]: "memory" }), ["bot=", "squad=", `${SQUAD_MARK}=`]);
  // A squad set after the copy (the helper's) differs from the mark: kept; the mark goes.
  assert.deepEqual(detachWords({ bot: ID.dev, squad: "infra", [SQUAD_MARK]: "memory" }), ["bot=", `${SQUAD_MARK}=`]);
  assert.deepEqual(detachWords(), ["bot="]);
});

test("relabelPlan + relabelWords: rank, lead and category edits, and a lead's captain status", () => {
  const before = file();
  // Test moves from the captain to the main bot (into shared); dev gets rank reviewer.
  const edited = JSON.parse(JSON.stringify(FILE));
  const t = edited.bots.find((b) => b.id === ID.test);
  delete t.lead; t.category = "shared";
  edited.bots.find((b) => b.id === ID.dev).rank = "reviewer";
  let plan = relabelPlan(before, file(edited));
  assert.deepEqual(plan.map((p) => p.id).sort(), [ID.dev, ID.test].sort());
  const test_ = plan.find((p) => p.id === ID.test);
  assert.equal(test_.leadChanged, true);
  assert.deepEqual(relabelWords(test_.before, test_.after, { bot: ID.test, category: "eng" }), ["category=shared"]);
  // Dev leaves too: the captain leads nobody, so its role falls back to its rank.
  delete edited.bots.find((b) => b.id === ID.dev).lead;
  plan = relabelPlan(before, file(edited));
  const cap = plan.find((p) => p.id === ID.cap);
  assert.deepEqual([cap.before.role, cap.after.role], ["captain", "dev"]);
  assert.deepEqual(relabelWords(cap.before, cap.after, { bot: ID.cap, role: "captain", category: "eng" }), ["role=dev"]);
  // A rank cleared: the role the old file gave comes off, a role someone else set stays.
  const cleared = JSON.parse(JSON.stringify(FILE));
  delete cleared.bots.find((b) => b.id === ID.pm).rank;
  const pm = relabelPlan(before, file(cleared)).find((p) => p.id === ID.pm);
  assert.deepEqual(relabelWords(pm.before, pm.after, { bot: ID.pm, role: "pm" }), ["role="]);
  assert.deepEqual(relabelWords(pm.before, pm.after, { bot: ID.pm, role: "owner" }), []);
  // A squad is only ever added.
  assert.deepEqual(relabelWords({ bot: ID.dev }, { bot: ID.dev }, { bot: ID.dev }, { leadSquad: "memory" }), ["squad=memory", `${SQUAD_MARK}=memory`]);
  // Nothing changed, nothing planned; planned bots never.
  assert.deepEqual(relabelPlan(before, file()), []);
  const planned = JSON.parse(JSON.stringify(FILE));
  planned.bots.find((b) => b.id === ID.plan).rank = "pm";
  assert.deepEqual(relabelPlan(before, file(planned)), []);
});

test("the copied squad follows a lead change: the new lead's, or off when it has none; an unmarked squad never moves", () => {
  const before = { bot: ID.dev }, after = { bot: ID.dev };
  const copied = { bot: ID.dev, squad: "memory", [SQUAD_MARK]: "memory" };
  assert.deepEqual(relabelWords(before, after, copied, { leadChanged: true, leadSquad: "infra" }), ["squad=infra", `${SQUAD_MARK}=infra`]);
  assert.deepEqual(relabelWords(before, after, copied, { leadChanged: true, leadSquad: null }), ["squad=", `${SQUAD_MARK}=`]);
  assert.deepEqual(relabelWords(before, after, copied, { leadChanged: true, leadSquad: "memory" }), []);
  assert.deepEqual(relabelWords(before, after, copied, { leadChanged: false, leadSquad: "infra" }), []); // no lead change
  const own = { bot: ID.dev, squad: "ops" };
  assert.deepEqual(relabelWords(before, after, own, { leadChanged: true, leadSquad: "infra" }), []);
  const overwritten = { bot: ID.dev, squad: "ops", [SQUAD_MARK]: "memory" }; // the helper set it after the copy
  assert.deepEqual(relabelWords(before, after, overwritten, { leadChanged: true, leadSquad: null }), []);
});

test("leadPane: the live one with an agent in front, newest by created_ms, from rows or hc get answers", () => {
  assert.equal(leadPane([]), null);
  const rows = [
    { address: "t1", state: "live", created_ms: 5, program: { agent: true }, labels: { squad: "a" } },
    { address: "t2", state: "live", created_ms: 9, program: { agent: false }, labels: { squad: "b" } }, // a shell in front
    { address: "t3", state: "live", created_ms: 7, foreground: { argv: ["claude"] }, labels: { squad: "c" } },
    { address: "t4", state: "finished", created_ms: 99, program: { agent: true } },
  ];
  assert.equal(leadPane(rows).address, "t3");
  assert.equal(leadPane([{ address: "t9", state: "live", program: { agent: true } }]).address, "t9"); // no created_ms
  // The program table says shell but an agent is in the foreground: it counts.
  const shellSays = { address: "t8", state: "live", created_ms: 50, program: { agent: false }, foreground: { argv: ["claude"] } };
  assert.equal(leadPane([...rows, shellSays]).address, "t8");
  // Attach copies from that pane.
  assert.deepEqual(attachWords(file(), ID.dev, { bot: ID.dev }, rows), ["role=dev", "category=eng", "squad=c", `${SQUAD_MARK}=c`]);
});

test("relabel(plan, io): labels each live pane; a failed label is failed, a failed lookup unchecked", async () => {
  const before = file();
  const edited = JSON.parse(JSON.stringify(FILE));
  edited.bots.find((b) => b.id === ID.test).rank = "tester";
  edited.bots.find((b) => b.id === ID.pm).rank = "reviewer";
  const plan = relabelPlan(before, file(edited));
  const calls = [];
  const io = {
    rows: async (id) => {
      if (id === ID.pm) throw new Error("hc down");
      if (id === ID.test) return [{ address: "t4", state: "live", labels: { bot: ID.test } }, { address: "t5", state: "live", labels: { bot: ID.test } }];
      if (id === ID.cap) return [{ address: "t2", state: "live", program: { agent: true }, labels: { bot: ID.cap, squad: "memory" } }];
      return [];
    },
    label: async (address, words) => { calls.push([address, ...words]); return address !== "t5"; },
  };
  const out = await relabel(plan, io);
  assert.deepEqual(out, { done: ["t4"], failed: ["t5"], unchecked: [ID.pm] });
  assert.equal(relabelWarning(out), `Saved, but these panes' labels weren't updated: t5; these bots' panes could not be checked: ${ID.pm}.`);
  assert.equal(relabelWarning({ failed: [], unchecked: [ID.pm] }), `Saved, but these bots' panes could not be checked: ${ID.pm}.`);
  assert.equal(relabelWarning({ done: ["t4"], failed: [], unchecked: [] }), null);
  // The pane had no category yet: set too (relabelWords sets whatever differs from the new file).
  const words = ["role=tester", "category=eng", "squad=memory", `${SQUAD_MARK}=memory`];
  assert.deepEqual(calls, [["t4", ...words], ["t5", ...words]]);
});

test("a category id that isn't a slug never reaches a label", () => {
  const f = file({ ...FILE, categories: [{ id: "Eng Team", title: "Engineering" }], bots: FILE.bots.map((b) => (b.category === "eng" ? { ...b, category: "Eng Team" } : b)) });
  assert.equal(effectiveCategory(f, ID.cap), null);
  assert.deepEqual(paneLabels(f, ID.cap), { bot: ID.cap, role: "captain" });
});

test("rank captain is allowed and main is not a rank: role=main is the main bot's alone", () => {
  const f = file({ ...FILE, bots: [...FILE.bots.filter((b) => b.id !== ID.test), bot(ID.test, "member", { rank: "captain" })] });
  assert.equal(roleOf(f, ID.test), "captain");
  const m = parseBots(JSON.stringify({ ...FILE, bots: [...FILE.bots.filter((b) => b.id !== ID.test), bot(ID.test, "member", { rank: "main" })] }));
  assert.equal(roleOf(m.file, ID.test), null);
  assert.ok(m.warnings.some((w) => /unknown rank "main"/.test(w)));
});

test("attachWords: the pane ends up matching paneLabels; only a marked squad follows the lead", () => {
  const f = file();
  const lead = [{ address: "t2", state: "live", program: { agent: true }, labels: { bot: ID.cap, squad: "memory" } }];
  // Test has no rank: a stale role comes off; a wrong category is replaced.
  assert.deepEqual(attachWords(f, ID.test, { bot: ID.test, role: "captain", category: "shared", squad: "ops" }, lead), ["category=eng", "role="]);
  // PM's category isn't known: a category on the pane comes off.
  assert.deepEqual(attachWords(f, ID.pm, { bot: ID.pm, role: "pm", category: "eng" }, []), ["category="]);
  // A squad this pack copied takes the lead's, or comes off with its mark.
  const copied = { bot: ID.test, category: "eng", squad: "old", [SQUAD_MARK]: "old" };
  assert.deepEqual(attachWords(f, ID.test, copied, lead), ["squad=memory", `${SQUAD_MARK}=memory`]);
  assert.deepEqual(attachWords(f, ID.test, copied, []), ["squad=", `${SQUAD_MARK}=`]);
  assert.deepEqual(attachWords(f, ID.test, { bot: ID.test, category: "eng" }, lead), ["squad=memory", `${SQUAD_MARK}=memory`]);
});

test("#628 r3 L1 launch labels omit widening roles and keep ordinary roles", () => {
  for (const rank of ["reviewer", "fixer", "tester"]) {
    const edited = structuredClone(FILE);
    edited.bots.find((b) => b.id === ID.dev).rank = rank;
    const roster = file(edited);
    assert.equal(paneLabels(roster, ID.dev).role, rank === "tester" ? rank : undefined);
    assert.equal(paneLabels(roster, ID.cap).role, "captain");
    assert.equal(paneLabels(roster, ID.main).role, "main");
  }
});

test("#628 r3 L2 attach and edit leave an existing grant alone", () => {
  for (const rank of ["tester", undefined, "fixer"]) {
    const edited = structuredClone(FILE);
    edited.bots.find((b) => b.id === ID.dev).rank = rank;
    const roster = file(edited);
    const have = { bot: ID.dev, role: "reviewer", category: "eng" };
    assert.deepEqual(attachWords(roster, ID.dev, have, []), []);
    assert.deepEqual(relabelWords({ role: "reviewer", category: "eng" }, { role: rank, category: "eng" }, have), []);
  }
});

test("#628 r3 L3 grant words never replace or clear either existing grant", async () => {
  const { grantWords } = await import("../mods/am-sidebar/launchArgs.js");
  assert.equal(typeof grantWords, "function");
  for (const role of ["reviewer", "fixer"]) {
    assert.deepEqual(grantWords(role), [`role=${role}`]);
    assert.deepEqual(grantWords(role, { role: "tester" }), [`role=${role}`]);
    for (const held of ["reviewer", "fixer"]) assert.deepEqual(grantWords(role, { role: held }), []);
  }
  for (const role of [undefined, "tester", "Reviewer", "fixer "]) assert.deepEqual(grantWords(role), []);
});
