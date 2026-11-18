// The pack's Antigravity model cache (modelCache.js, #793): what `agy models`' table and the
// cache text mean, and the one refresh that fills the cache from a fake agy (never the real
// CLI). No file or program is touched: read/write/exec are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AG_MODELS_FILE, agModelsCacheText, agModelsPath, parseAgModelsCache, parseAgModelsOutput,
} from "../mods/am-sidebar/models.js";
import { AG_MODELS_TTL_MS, agModelsFresh, agModelsSpawnResult, refreshAgModels, refreshAgModelsSync } from "../mods/am-sidebar/modelCache.js";

const MODELS = readFileSync(new URL("./fixtures/agy/models-1.5.3.txt", import.meta.url), "utf8");
const IDS = MODELS.trim().split("\n").map((line) => line.split("\t")[0]);
const NOW = Date.parse("2026-11-09T12:00:00Z");

test("parseAgModelsOutput: the fixture table's ids and labels, noise and duplicates skipped", () => {
  const models = parseAgModelsOutput(MODELS);
  assert.deepEqual(models.map((m) => m.id), IDS);
  assert.equal(models.length, 13);
  assert.deepEqual(models[0], { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" });
  assert.deepEqual(models.at(-1), { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" });
  // agy prints its log lines on stderr; a stray line without a separator is not a model.
  assert.deepEqual(parseAgModelsOutput("INFO starting\nNot a model\nok-id\tOk\n"), [{ id: "ok-id", label: "Ok" }]);
  // A run of spaces between id and label reads as the same table.
  assert.deepEqual(parseAgModelsOutput("spaced-id  Two words\n"), [{ id: "spaced-id", label: "Two words" }]);
  // A model id that isn't one word (or starts with a dash) is never a pin.
  assert.deepEqual(parseAgModelsOutput("-x\tBad\nhas space\tBad\n--model\tBad\ngood\tGood\n"), [{ id: "good", label: "Good" }]);
  assert.deepEqual(parseAgModelsOutput("same\tOne\nsame\tTwo\n"), [{ id: "same", label: "One" }]);
  assert.deepEqual(parseAgModelsOutput(""), []);
  assert.deepEqual(parseAgModelsOutput(null), []);
});

test("cache text: the fixture list round-trips with its time and source; malformed text is no cache", () => {
  const at = new Date(NOW).toISOString();
  const text = agModelsCacheText(parseAgModelsOutput(MODELS), NOW);
  const cache = parseAgModelsCache(text);
  assert.equal(cache.at, at);
  assert.deepEqual(cache.models, parseAgModelsOutput(MODELS));
  assert.match(text, /"source": "agy models"/);
  assert.equal(agModelsFresh(cache, NOW + AG_MODELS_TTL_MS - 1), true);
  assert.equal(agModelsFresh(cache, NOW + AG_MODELS_TTL_MS), false, "a day old is stale");
  assert.equal(agModelsFresh(cache, NOW + 1), true, "a little clock skew is still fresh");
  // A hand-edited or older cache: bare ids still read, bad ids don't, no list is no cache.
  assert.deepEqual(parseAgModelsCache('{"models":["a","b"]}')?.models, [{ id: "a", label: "" }, { id: "b", label: "" }]);
  assert.equal(parseAgModelsCache('{"models":[]}'), null);
  assert.equal(parseAgModelsCache('{"models":["-x"]}'), null);
  assert.equal(parseAgModelsCache("{not json"), null);
  assert.equal(parseAgModelsCache(null), null);
  assert.equal(agModelsFresh(null, NOW), false);
  assert.equal(agModelsPath("/app/"), `/app/${AG_MODELS_FILE}`);
});

test("refreshAgModels: a fresh cache is used without running agy", async () => {
  const text = agModelsCacheText(parseAgModelsOutput(MODELS), NOW);
  let writes = 0, execs = 0;
  const r = await refreshAgModels({
    appHome: "/app", read: () => text, write: () => { writes += 1; }, now: NOW + 1000,
    exec: () => { execs += 1; return { code: 0, stdout: MODELS, stderr: "" }; },
  });
  assert.deepEqual([execs, writes, r.refreshed], [0, 0, false]);
  assert.equal(r.text, text);
  assert.equal(r.cache.models.length, 13);
});

test("refreshAgModels: a missing cache runs `agy models` once, writes the table and never throws", async () => {
  let written = null;
  const r = await refreshAgModels({
    appHome: "/app", read: () => null, write: (path, text) => { written = { path, text }; }, now: NOW,
    exec: (command, args, options) => {
      assert.deepEqual([command, args], ["agy", ["models"]]);
      assert.ok(options.timeout > 0);
      return { code: 0, stdout: MODELS, stderr: "INFO noise" };
    },
  });
  assert.equal(r.refreshed, true);
  assert.equal(r.why, null);
  assert.equal(written.path, `/app/${AG_MODELS_FILE}`);
  assert.deepEqual(parseAgModelsCache(written.text).models.map((m) => m.id), IDS);
  assert.equal(r.text, written.text);
});

test("refreshAgModels renames its own temp file into place and removes it on failure", async () => {
  const path = agModelsPath("/app");
  const stale = agModelsCacheText(parseAgModelsOutput(MODELS), NOW - AG_MODELS_TTL_MS - 1);
  const options = { appHome: "/app", now: NOW, exec: () => ({ code: 0, stdout: MODELS, stderr: "" }) };
  const why = "the model cache couldn't be written";
  const tempName = new RegExp(`^${path.replaceAll(".", "\\.")}\\.tmp-${NOW}-\\d+-[a-z0-9]+$`);
  for (const refresh of [refreshAgModels, refreshAgModelsSync]) {
    const names = new Set();
    for (const failure of [null, "write", "rename", "remove"]) {
      const label = `${refresh.name}: ${failure ?? "success"}`;
      const calls = [];
      const result = await refresh({
        ...options,
        read: () => failure ? stale : null,
        write: (p, text) => {
          calls.push(["write", p]);
          assert.match(text, /"source": "agy models"/);
          if (failure === "write") throw new Error("disk full");
        },
        rename: (from, to) => {
          calls.push(["rename", from, to]);
          if (failure) throw new Error("no rename");
        },
        remove: (p) => {
          calls.push(["remove", p]);
          if (failure === "remove") throw new Error("no unlink");
        },
      });
      const tmp = calls[0][1];
      assert.match(tmp, tempName, label);
      names.add(tmp);
      const expected = [["write", tmp]];
      if (failure !== "write") expected.push(["rename", tmp, path]);
      if (failure) expected.push(["remove", tmp]);
      assert.deepEqual(calls, expected, label);
      assert.equal(result.refreshed, !failure, label);
      if (failure) assert.deepEqual([result.text, result.cache.models.length, result.why], [stale, 13, why], label);
    }
    assert.equal(names.size, 4, `${refresh.name}: distinct temp names at the same time`);

    const directCalls = [];
    const direct = await refresh({
      ...options,
      read: () => stale,
      write: (p) => { directCalls.push(["write", p]); throw new Error("disk full"); },
      remove: (p) => { directCalls.push(["remove", p]); },
    });
    assert.deepEqual([direct.refreshed, direct.text, direct.why], [false, stale, why]);
    assert.deepEqual(directCalls, [["write", path]], "a failed direct write leaves the cache alone");
  }

  // Keep the first refresh's temp live while another refresh at the same clock value fails.
  const files = new Map([[path, stale]]);
  const atRename = Promise.withResolvers();
  const finishRename = Promise.withResolvers();
  const first = refreshAgModels({
    ...options,
    read: (p) => files.get(p),
    write: (p, text) => { files.set(p, text); },
    rename: async (from, to) => {
      atRename.resolve(from);
      await finishRename.promise;
      if (!files.has(from)) throw new Error("temp is gone");
      files.set(to, files.get(from));
      files.delete(from);
    },
  });
  const live = await Promise.race([atRename.promise, first.then(() => assert.fail("the first refresh did not reach rename"))]);
  try {
    const originalTemp = files.get(live);
    for (const failure of ["write", "rename"]) {
      const failed = await refreshAgModels({
        ...options,
        read: (p) => files.get(p),
        write: async (p) => {
          files.set(p, "failed refresh's temp contents");
          if (failure === "write") throw new Error("disk full");
        },
        rename: async () => { throw new Error("no rename"); },
        remove: async (p) => {
          await new Promise((resolve) => setImmediate(resolve));
          files.delete(p);
        },
      });
      assert.deepEqual([failed.refreshed, failed.text, failed.why], [false, stale, why], failure);
      assert.deepEqual([...files], [[path, stale], [live, originalTemp]], failure);
    }
  } finally {
    finishRename.resolve();
    await first;
  }
  const refreshed = await first;
  assert.equal(refreshed.refreshed, true);
  assert.deepEqual([...files], [[path, refreshed.text]]);
});

test("refreshAgModels: agy missing or failing keeps the last list and says why; no list stays none", async () => {
  const stale = agModelsCacheText(parseAgModelsOutput(MODELS), NOW - AG_MODELS_TTL_MS - 1);
  const missing = await refreshAgModels({
    appHome: "/app", read: () => stale, write: () => { throw new Error("must not write"); }, now: NOW,
    exec: () => { throw Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" }); },
  });
  assert.deepEqual([missing.refreshed, missing.cache.models.length], [false, 13], "the stale list survives");
  assert.match(missing.why, /agy models couldn't run/);
  assert.equal(missing.text, stale);
  const none = await refreshAgModels({
    appHome: "/app", read: () => null, write: () => {}, now: NOW,
    exec: () => { throw new Error("spawn agy ENOENT"); },
  });
  assert.deepEqual([none.text, none.cache, none.refreshed], [null, null, false]);
  assert.match(none.why, /ENOENT/);
  const failed = await refreshAgModels({
    appHome: "/app", read: () => null, write: () => {}, now: NOW,
    exec: () => ({ code: 1, stdout: "", stderr: "not logged in\n" }),
  });
  assert.equal(failed.why, "agy models failed (not logged in)");
  const empty = await refreshAgModels({
    appHome: "/app", read: () => null, write: () => {}, now: NOW,
    exec: () => ({ code: 0, stdout: "INFO nothing\n", stderr: "" }),
  });
  assert.equal(empty.why, "agy models listed no models");
  assert.equal(empty.text, null);
});

test("agModelsSpawnResult: a killed agy is a failed refresh, never a silent exit 0", () => {
  assert.deepEqual(agModelsSpawnResult({ status: 0, stdout: "x", stderr: "" }), { code: 0, stdout: "x", stderr: "" });
  assert.deepEqual(agModelsSpawnResult({ status: 2, stdout: "", stderr: "bad" }), { code: 2, stdout: "", stderr: "bad" });
  // spawnSync: killed by a signal -> status null, signal set (no error).
  assert.deepEqual(agModelsSpawnResult({ status: null, signal: "SIGKILL", stdout: "" }),
    { code: 1, stdout: "", stderr: "agy models was killed by SIGKILL" });
  const stale = agModelsCacheText(parseAgModelsOutput(MODELS), NOW - AG_MODELS_TTL_MS - 1);
  const kept = refreshAgModelsSync({ appHome: "/app", read: () => stale, write: () => {}, now: NOW,
    exec: () => agModelsSpawnResult({ status: null, signal: "SIGTERM" }) });
  assert.deepEqual([kept.refreshed, kept.cache.models.length], [false, 13]);
  assert.match(kept.why, /killed by SIGTERM/);
});

test("refreshAgModelsSync: the CLI's synchronous path reads fresh, refreshes old, keeps a failed list", () => {
  const fresh = agModelsCacheText(parseAgModelsOutput(MODELS), NOW);
  let execs = 0;
  const used = refreshAgModelsSync({ appHome: "/app", read: () => fresh, write: () => {}, now: NOW + 1,
    exec: () => { execs += 1; return { code: 0, stdout: MODELS, stderr: "" }; } });
  assert.deepEqual([execs, used.refreshed, used.cache.models.length], [0, false, 13]);
  let written = null;
  const filled = refreshAgModelsSync({ appHome: "/app", read: () => null, write: (path, text) => { written = { path, text }; }, now: NOW,
    exec: () => ({ code: 0, stdout: MODELS, stderr: "" }) });
  assert.equal(filled.refreshed, true);
  assert.match(written.path, /antigravity-models\.json$/);
  const stale = agModelsCacheText(parseAgModelsOutput(MODELS), NOW - AG_MODELS_TTL_MS - 1);
  const kept = refreshAgModelsSync({ appHome: "/app", read: () => stale, write: () => {}, now: NOW,
    exec: () => ({ code: 1, stdout: "", stderr: "offline" }) });
  assert.deepEqual([kept.refreshed, kept.cache.models.length], [false, 13]);
  assert.match(kept.why, /offline/);
});
