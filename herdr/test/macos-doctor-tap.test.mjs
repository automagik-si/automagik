import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const validator = fileURLToPath(new URL("../scripts/macos-doctor-tap.mjs", import.meta.url));
const fixtures = new URL("./fixtures/macos-doctor-tap/", import.meta.url);
const files = readdirSync(fixtures).filter((file) => file.endsWith(".tap")).sort();
assert.ok(files.length, "the validator needs TAP fixtures");

for (const file of files) {
  test(file, () => {
    const statuses = /\.node-(\d+)\.expect-([01])\.tap$/.exec(file);
    assert.ok(statuses, "fixture filename must give the Node and validator exit statuses");
    const [, nodeStatus, expectedStatus] = statuses;
    const tap = fileURLToPath(new URL(file, fixtures));
    const result = spawnSync(process.execPath, [validator, tap, nodeStatus], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, Number(expectedStatus), result.stderr || result.stdout);
    if (expectedStatus === "0") {
      assert.equal(result.stdout, "macOS doctor rows passed natively: 5\n");
    } else {
      assert.match(result.stderr, /^macOS doctor TAP: [^\r\n]+\n$/);
    }
  });
}
