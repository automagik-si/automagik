import { readFileSync } from "node:fs";

const REQUIRED = [
  "macOS doctor warns on approved on with working on or off, and names the inspected project",
  "macOS doctor keeps existing observations for approval controls",
  "macOS doctor keeps the bound pane's proxy health and rollback warning",
  "macOS doctor's project word escapes a newline and ESC",
  "macOS doctor renders the warning in JSON and text with invariant exit codes",
];
const PREFIX = "macOS doctor";
const FILTER_NOTE = "test name does not match pattern";
const RESULT = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)(?: (.*))?)?$/;

function validate(tap) {
  const passed = new Set();
  let selectedBlock = false;
  for (const line of tap.split(/\r?\n/)) {
    if (line.startsWith("# Subtest: ")) {
      selectedBlock = line.slice("# Subtest: ".length).startsWith(PREFIX);
      continue;
    }

    const result = RESULT.exec(line);
    if (!result) continue;
    const [, indent, outcome, escapedName, directive, reason] = result;
    const name = escapedName.replace(/\\([#\\])/g, "$1");
    const parent = indent === "";
    const selected = parent ? name.startsWith(PREFIX) : selectedBlock;

    if (outcome === "not ok") throw new Error(`TAP failure: ${name}`);
    if (directive && !(parent && !selected && directive === "SKIP" && reason === FILTER_NOTE)) {
      throw new Error(`${directive}${selected ? " in a macOS doctor row" : ""}: ${name}`);
    }

    if (!parent) continue;
    selectedBlock = false;
    if (!selected) continue;
    if (!REQUIRED.includes(name)) throw new Error(`unexpected parent: ${name} (update REQUIRED)`);
    if (passed.has(name)) throw new Error(`duplicate parent: ${name}`);
    passed.add(name);
  }

  const missing = REQUIRED.filter((name) => !passed.has(name));
  if (missing.length) throw new Error(`missing required passes: ${missing.join("; ")}`);
  return passed.size;
}

try {
  const [file, status] = process.argv.slice(2);
  if (!file || status === undefined) {
    throw new Error("usage: node scripts/macos-doctor-tap.mjs <tap-file> <node-exit-status>");
  }
  if (status !== "0") throw new Error(`Node exited with status ${status}`);
  const passed = validate(readFileSync(file, "utf8"));
  console.log(`macOS doctor rows passed natively: ${passed}`);
} catch (error) {
  console.error(`macOS doctor TAP: ${error.message.replace(/\s+/g, " ")}`);
  process.exitCode = 1;
}
