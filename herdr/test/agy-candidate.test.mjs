import { test } from "node:test";
import assert from "node:assert/strict";
import { agyCandidate, coreStatusOf, reportAppOf } from "../mods/am-sidebar/agyPrompt.js";

const APP = "synthetic-agy";
const APPS = [APP, "gemini"];
const KEEP = ["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh"];
const records = (extra, app = APP) => [
  { address: "t1", created_ms: 1, state: "live", status: "working", report: { app }, ...extra },
  { address: "box/t1", created_ms: 1, state: "live", status: { app, state: "working" }, ...extra },
];
const check = (extra, expected, app = APP) => {
  for (const record of records(extra, app)) assert.equal(agyCandidate(record, APPS), expected);
};
const front = (argv) => ({ foreground: { argv } });

test("foreground agy is Antigravity", () => {
  for (const argv of [["agy", "-i"], ["/opt/x/agy"]]) check(front(argv), true, "other");
});

test("agy under hc's keep wrapper, then the shell it leaves behind", () => {
  for (const record of records(front([...KEEP, "agy"]))) {
    assert.equal(agyCandidate(record, APPS), true);
    assert.equal(agyCandidate({ ...record, ...front(["zsh", "-i"]) }, APPS), false);
  }
});

test("any other foreground wins over a stale Antigravity report", () => {
  for (const argv of [["sh"], ["claude"], [...KEEP, "sh"], ["sh", "-c", "wrapper"]]) check(front(argv), false);
});

test("a gemini report or foreground is not evidence", () => {
  check({}, null, "gemini");
  check(front(["gemini"]), false);
});

test("a listed report name without foreground is Antigravity", () => {
  check(front([]), true);
  check({}, true);
  check({}, null, "SYNTHETIC-AGY");
  check({}, null, "");
  for (const record of records()) assert.equal(agyCandidate(record), null);
});

test("a script, an hc template and a helper go by their live evidence", () => {
  check(front(["bash", "run.sh"]), false);
  check(front(["/usr/bin/env", "PATH=/x", "agy", "-i", "task"]), true, "other");
  check(front(["node", "/x/helper.mjs"]), false);
});

test("no full address or no created_ms is unknown", () => {
  for (const address of ["", "nick", "box/", " t1", "box/t1/x", undefined, 1]) check({ ...front(["agy"]), address }, null);
  for (const created_ms of [undefined, NaN, Infinity]) check({ ...front(["agy"]), created_ms }, null);
  assert.equal(agyCandidate(null, APPS), null);
});

test("a finished terminal is never a candidate", () => {
  check({ ...front(["agy"]), state: "exited" }, false);
});

test("the launch argv is never evidence", () => {
  check({ argv: ["agy"] }, null, "");
});

test("coreStatusOf and reportAppOf read both record forms", () => {
  for (const record of records()) {
    assert.equal(coreStatusOf(record), "working");
    assert.equal(reportAppOf(record), APP);
  }
  assert.equal(coreStatusOf({ status: { app: APP } }), null);
  assert.equal(reportAppOf({ report: { app: "" }, status: { app: APP } }), APP);
  assert.equal(reportAppOf({ report: { app: APP }, status: { app: "other" } }), APP);
  assert.equal(reportAppOf(null), null);
});
