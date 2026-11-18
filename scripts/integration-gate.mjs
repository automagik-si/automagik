#!/usr/bin/env node
/**
 * Exact integration coverage from per-file node:test events, never console output. Apache-2.0.
 * Plain Node 22.7+, no dependencies. Optional groups describe gaps without claiming coverage.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync, createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultManifest = resolve(root, "scripts/integration-groups.json");
/** A group's cwd is relative to the folder that holds the manifest's scripts/ folder. */
const baseOf = (manifestPath) => dirname(dirname(resolve(manifestPath)));
const statuses = new Set(["required", "unprovisioned", "optional", "prerequisite-enforced"]);
const countKeys = ["tests", "pass", "skip", "todo", "fail", "cancelled", "top"];
const summaryKeys = {
  tests: "tests", pass: "passed", fail: "failed", cancelled: "cancelled",
  skip: "skipped", todo: "todo", top: "topLevel",
};
const emptyCounts = () => Object.fromEntries(countKeys.map((key) => [key, 0]));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value) => Array.isArray(value) && value.every((s) => typeof s === "string" && s);

function inside(base, file) {
  const path = relative(base, resolve(base, file));
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") &&
    !isAbsolute(path) && !isAbsolute(file);
}

export function validateManifest(manifest) {
  if (!object(manifest) || !Array.isArray(manifest.groups)) {
    throw new Error("invalid manifest: groups must be an array");
  }
  const ids = new Set();
  for (const group of manifest.groups) {
    if (!object(group) || typeof group.id !== "string" || !group.id || ids.has(group.id)) {
      throw new Error("invalid manifest: group ids must be non-empty and unique");
    }
    ids.add(group.id);
    const invalid = (message) => { throw new Error(`invalid manifest: ${group.id}: ${message}`); };
    if (typeof group.cwd !== "string" || !group.cwd || !inside(root, group.cwd)) {
      invalid("cwd must be a relative repository path");
    }
    if (!strings(group.files) || new Set(group.files).size !== group.files.length ||
        group.files.some((file) => !inside(resolve(root, group.cwd), file))) {
      invalid("files must be unique relative paths under cwd");
    }
    if (!strings(group.env)) invalid("env must be an array of prerequisite names");
    if (!object(group.jobs) || Object.keys(group.jobs).length === 0 ||
        Object.entries(group.jobs).some(([job, status]) => !job || !statuses.has(status))) {
      invalid("jobs must name known statuses");
    }
    if (Object.values(group.jobs).includes("required")) {
      const expected = group.expect;
      if (group.files.length === 0 || !object(expected) ||
          ![expected.tests, expected.pass, expected.top].every(Number.isSafeInteger) ||
          expected.tests <= 0 || expected.tests !== expected.pass || expected.top <= 0) {
        invalid("required groups need files and expect with tests == pass > 0 and top > 0");
      }
    }
  }
  return manifest;
}

export function loadManifest(path = defaultManifest) {
  return validateManifest(JSON.parse(readFileSync(path, "utf8")));
}

function unknownFiles(group) {
  return group.files.map((file) => ({ file, complete: false, counts: null }));
}

/** Accept JSONL text or an array of JSONL lines. No global summary supplies counts. */
export function judge(ledgerLines, group, repoRoot = root) {
  const problems = [];
  const files = unknownFiles(group);
  let events;
  try {
    const lines = typeof ledgerLines === "string" ? ledgerLines.split("\n") : ledgerLines;
    events = lines.filter((line) => typeof line !== "string" || line.trim()).map((line) => {
      const event = typeof line === "string" ? JSON.parse(line) : line;
      if (!object(event) || !["test:pass", "test:fail", "test:plan", "test:summary"]
        .includes(event.type)) throw new Error("invalid event");
      return { ...event, ...(event.data ?? {}) };
    });
    if (events.length === 0) throw new Error("empty ledger");
  } catch {
    return { ok: false, problems: ["no complete test results"], counts: null, files };
  }
  const cwd = resolve(repoRoot, group.cwd);
  const records = new Map(files.map((entry) => [resolve(cwd, entry.file), {
    entry, summaries: [], counts: emptyCounts(),
  }]));
  for (const event of events) {
    // Node emits file-less plans and a global summary. Neither proves any file complete.
    if (!event.file && ["test:plan", "test:summary"].includes(event.type)) continue;
    const record = records.get(event.file);
    if (!record) {
      problems.push(`unexpected event file: ${event.file ?? "unknown"}`);
      continue;
    }
    if (event.type === "test:summary") {
      record.summaries.push(event);
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { counts } = record;
    // The runner wraps each file in an entry named after the file, outside its own results.
    if (event.nesting === 0 && typeof event.name === "string" &&
        resolve(cwd, event.name) === event.file) continue;
    counts.tests++;
    if (event.nesting === 0) counts.top++;
    if (!Number.isSafeInteger(event.nesting) || event.nesting < 0) {
      problems.push(`${record.entry.file}: invalid result nesting`);
    }
    if (event.skip) counts.skip++;
    else if (event.todo) counts.todo++;
    else if (["cancelledByParent", "testTimeoutFailure", "testAborted"]
      .includes(event.failureType ?? event.details?.error?.failureType)) counts.cancelled++;
    else if (event.type === "test:pass") counts.pass++;
    else counts.fail++;
  }
  const counts = emptyCounts();
  for (const { entry, summaries, counts: observed } of records.values()) {
    entry.counts = observed;
    entry.complete = summaries.length === 1;
    if (summaries.length === 0) {
      problems.push(`${entry.file}: no end-of-file summary (empty, or exited before the end)`);
    } else if (summaries.length !== 1) {
      problems.push(`${entry.file}: expected one end-of-file summary, saw ${summaries.length}`);
    } else {
      const summary = summaries[0];
      for (const [key, summaryKey] of Object.entries(summaryKeys)) {
        if (summary.counts?.[summaryKey] !== observed[key]) {
          problems.push(`${entry.file}: summary ${summaryKey} ${summary.counts?.[summaryKey]}` +
            ` does not match events ${observed[key]}`);
        }
      }
      if (summary.success !== true) problems.push(`${entry.file}: summary did not report success`);
    }
    if (observed.tests - observed.skip - observed.todo === 0) {
      problems.push(`${entry.file}: no executed tests`);
    }
    for (const key of countKeys) counts[key] += observed[key];
  }
  for (const key of ["skip", "todo", "fail", "cancelled"]) {
    if (counts[key] !== 0) problems.push(`expected ${key} 0, saw ${counts[key]}`);
  }
  for (const key of ["tests", "pass", "top"]) {
    if (counts[key] !== group.expect[key]) {
      problems.push(`expected ${key} ${group.expect[key]}, saw ${counts[key]}`);
    }
  }
  return { ok: problems.length === 0, problems, counts, files };
}

const meanings = {
  optional: "intentional skip, not coverage",
  unprovisioned: "uncovered in PR CI until provisioned, not claimed",
  "prerequisite-enforced":
    "the test fails without its prerequisite; counts not verified by this gate",
};
const cell = (value) => String(value).replaceAll("|", "\\|").replace(/[\r\n]/g, " ");

/** Environment presence describes this process, never the process that produced a verdict. */
export function renderSummary(manifest, job, verdict = null, artifactUrl = "", env = {}) {
  validateManifest(manifest);
  const groups = manifest.groups.filter((group) => Object.hasOwn(group.jobs, job));
  if (groups.length === 0) throw new Error(`job is in no integration group: ${job}`);
  const lines = [
    `## Integration coverage: ${cell(job)}`, "",
    "| Group | Status | Executed | Pass | Skipped | Todo | Failed | Verdict |" +
      " Prerequisites / meaning |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const group of groups) {
    const status = group.jobs[job];
    const result = verdict?.group === group.id ? verdict : null;
    const c = result?.counts;
    // Executed excludes skips and todos, so the two are never read as one number.
    const executed = c ? c.tests - c.skip - c.todo : "unknown";
    const numbers = [executed, ...["pass", "skip", "todo", "fail"]
      .map((key) => c?.[key] ?? "unknown")];
    const outcome = status === "required" ? (result?.ok === true ? "pass" : "FAIL") :
      "not run here";
    const observed = group.env.map((name) => `${name} ${env[name] ? "present" : "absent"}`);
    const detail = status === "required" ? (result?.problems ?? []).join("; ") :
      [...observed, meanings[status], group.note, ...(group.details ?? [])]
        .filter(Boolean).join("; ");
    const row = [group.id, status, ...numbers, outcome, detail];
    lines.push(`| ${row.map(cell).join(" | ")} |`);
  }
  if (artifactUrl) lines.push("", `[Integration results](${artifactUrl})`);
  return `${lines.join("\n")}\n`;
}

async function runChild(group, out, base) {
  const ledger = resolve(out, "ledger.jsonl");
  // A failed rerun must never inherit evidence from an earlier invocation in this directory.
  rmSync(ledger, { force: true });
  const log = createWriteStream(resolve(out, "run.log"));
  let logError;
  const logged = new Promise((fulfill) => {
    log.on("finish", fulfill);
    log.on("error", (error) => { logError = error; fulfill(); });
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = [
    "--test", "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${new URL("./integration-gate-reporter.mjs", import.meta.url).href}`,
    `--test-reporter-destination=${ledger}`, ...group.files,
  ];
  const child = spawn(process.execPath, args, {
    cwd: resolve(base, group.cwd), env, stdio: ["inherit", "pipe", "pipe"],
  });
  const forward = (signal) => child.kill(signal);
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let error;
  child.on("error", (cause) => { error = cause; });
  try {
    const result = await new Promise((fulfill) => {
      child.on("close", (code, signal) => fulfill({ code, signal }));
    });
    log.end();
    await logged;
    return { ...result, error: error ?? logError };
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  }
}

async function runGroup(id, output, manifestPath = defaultManifest) {
  const base = baseOf(manifestPath);
  const out = resolve(output);
  mkdirSync(out, { recursive: true });
  let verdict = { group: id, jobs: {}, ok: false, problems: [], counts: null, files: [] };
  try {
    const group = loadManifest(manifestPath).groups.find((entry) => entry.id === id);
    if (!group) throw new Error(`unknown group: ${id}`);
    verdict.jobs = group.jobs;
    verdict.files = unknownFiles(group);
    if (!Object.values(group.jobs).includes("required")) {
      throw new Error("not a required group");
    }
    const missing = group.env.filter((name) => !process.env[name]);
    if (missing.length) throw new Error(`missing prerequisites: ${missing.join(", ")}`);
    for (const file of group.files) {
      try {
        if (!statSync(resolve(base, group.cwd, file)).isFile()) throw new Error("not a file");
      } catch {
        throw new Error(`${file}: test file missing under ${group.cwd}`);
      }
    }
    const result = await runChild(group, out, base);
    let ledger;
    try { ledger = readFileSync(resolve(out, "ledger.jsonl"), "utf8"); } catch { /* judged */ }
    verdict = { ...verdict, ...judge(ledger, group, base) };
    if (result.error) verdict.problems.push(`runner error: ${result.error.message}`);
    if (result.code !== 0 || result.signal) {
      verdict.problems.push(`runner ${result.signal ? `signal ${result.signal}` :
        `exit code ${result.code}`}`);
    }
  } catch (error) {
    verdict.problems.push(error.message);
  }
  verdict.ok = verdict.problems.length === 0;
  writeFileSync(resolve(out, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  for (const problem of verdict.problems) {
    console.error(`integration-gate: ${id}: ${problem}`);
  }
  return verdict.ok ? 0 : 1;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" }, job: { type: "string" },
      verdict: { type: "string" }, "artifact-url": { type: "string" },
      manifest: { type: "string" },
    },
  });
  if (positionals[0] === "run" && positionals.length === 2 && values.out) {
    return runGroup(positionals[1], values.out, values.manifest ?? defaultManifest);
  }
  if (positionals[0] === "summary" && positionals.length === 1 && values.job) {
    let verdict = null;
    if (values.verdict) {
      try { verdict = JSON.parse(readFileSync(values.verdict, "utf8")); } catch { /* unknown */ }
    }
    const manifest = loadManifest(values.manifest ?? defaultManifest);
    const markdown = renderSummary(manifest, values.job, verdict, values["artifact-url"],
      process.env);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    else process.stdout.write(markdown);
    return 0;
  }
  throw new Error("usage: integration-gate.mjs run <group> --out <dir> | summary --job <job>" +
    " (either takes --manifest <file>)");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`integration-gate: ${error.message}`);
    process.exitCode = 1;
  });
}
