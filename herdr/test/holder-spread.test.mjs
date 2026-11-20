// #1432 item 3: the holder pool's policy, pure and independent of hc. A holder is an hc
// session's core on this computer; one holder's loss ends every pane it held, so a new pane
// goes to the holder with the fewest pack agents, under a per-holder limit. The default is one
// local holder (today's behaviour), and the limit's default is documented in README.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_HOLDER_LIMIT, MAX_HOLDER_LIMIT, chooseHolder, holderRows, holdersText, lossEvent, lossLine,
  parseHolders, sameLoss, spreadSummary } from "../mods/am-sidebar/holderSpread.mjs";

const pool = (names, limit = 2) => ({ limit, holders: names.map((name) => ({ name, machine: name === "local" ? null : name, session: name === "local" ? null : `am-holder-${name}` })) });
const counts = (pairs) => new Map(pairs);

test("the default pool is one local holder and the documented limit", () => {
  const c = parseHolders(null);
  assert.equal(c.limit, DEFAULT_HOLDER_LIMIT);
  assert.deepEqual(c.holders, [{ name: "local", machine: null, session: null }]);
  assert.deepEqual(parseHolders("").holders, c.holders);
  assert.equal(parseHolders("{not json").holders.length, 1);
  assert.match(parseHolders("{not json").warnings[0], /isn't JSON/);
});

test("the limit and holder names are validated, and bad entries are said and left out", () => {
  const c = parseHolders(JSON.stringify({ limit: 999, holders: [
    { name: "h2" }, "h3", { name: "../bad" }, { name: "h2" }, { name: "local" }, { name: "h4", machine: "x/y" },
  ] }));
  assert.equal(c.limit, DEFAULT_HOLDER_LIMIT);
  assert.deepEqual(c.holders.map((h) => h.name), ["local", "h2", "h3"]);
  assert.ok(c.warnings.length >= 2);
  assert.equal(parseHolders(JSON.stringify({ limit: 1 })).limit, 1);
  assert.equal(parseHolders(JSON.stringify({ limit: MAX_HOLDER_LIMIT })).limit, MAX_HOLDER_LIMIT);
  assert.equal(parseHolders(JSON.stringify({ limit: 0 })).limit, DEFAULT_HOLDER_LIMIT);
  assert.equal(parseHolders(JSON.stringify({ limit: "4" })).limit, 4);
});

test("the file keeps local implicit and round-trips the rest", () => {
  const c = pool(["local", "h2"], 3);
  const again = parseHolders(holdersText(c));
  assert.equal(again.limit, 3);
  assert.deepEqual(again.holders.map((h) => h.name), ["local", "h2"]);
  assert.equal(again.holders[1].machine, "h2");
  assert.match(holdersText(c), /"limit": 3/);
  assert.doesNotMatch(holdersText(c), /"name": "local"/);
});

test("a start goes to the least loaded holder, and never leaves every agent in one", () => {
  for (let h = 2; h <= 4; h += 1) {
    for (let limit = 1; limit <= 6; limit += 1) {
      const config = pool(["local", ...Array.from({ length: h - 1 }, (_, i) => `h${i + 2}`)], limit);
      const live = counts(config.holders.map((x) => [x.name, 0]));
      for (let n = 1; n <= 30; n += 1) {
        const pick = chooseHolder({ config, counts: live });
        assert.equal(pick.error, undefined);
        live.set(pick.name, live.get(pick.name) + 1);
        const summary = spreadSummary({ config, counts: live });
        assert.equal(summary.total, n);
        assert.ok(summary.largest <= Math.ceil(n / h), `N=${n} H=${h} L=${limit} largest ${summary.largest}`);
        if (n > limit) assert.ok(summary.used.length >= 2, `N=${n} H=${h} L=${limit} used ${summary.used}`);
        if (n <= h) assert.ok(summary.largest <= 1, `N=${n} H=${h} L=${limit} spreads from the first start`);
      }
    }
  }
});

test("a named holder wins, an unknown one is a usage problem, and a disconnected one is left out", () => {
  const config = pool(["local", "h2", "h3"], 2);
  assert.equal(chooseHolder({ config, counts: counts([["local", 2], ["h2", 1], ["h3", 0]]), holder: "local" }).name, "local");
  assert.match(chooseHolder({ config, holder: "nope" }).error, /no holder "nope"/);
  const disconnected = chooseHolder({ config, counts: counts([["local", 1], ["h2", 0], ["h3", 0]]),
    connected: new Map([["h2", false], ["h3", true]]) });
  assert.equal(disconnected.name, "h3");
  // Every machine away: this computer's holder still takes it, rather than refusing the start.
  const allAway = chooseHolder({ config, counts: counts([["local", 1], ["h2", 0], ["h3", 0]]),
    connected: new Map([["h2", false], ["h3", false]]) });
  assert.equal(allAway.name, "local");
});

test("a holder at its limit is full; only one above it is over the limit", () => {
  // #1881: `holderRows` and `chooseHolder` used `count > limit` and `count >= limit` for the
  // same `overLimit` name. One meaning now, in both: `atLimit` (`count >= limit`) is full,
  // which is when the next start moves on; `overLimit` (`count > limit`) is strictly above.
  const config = pool(["local", "h2"], 1);
  const rows = holderRows({ config, counts: counts([["local", 2], ["h2", 1]]) });
  assert.deepEqual(rows.map((r) => [r.name, r.count, r.atLimit, r.overLimit]),
    [["local", 2, true, true], ["h2", 1, true, false]]);
  // Both at the limit: the least loaded (h2) still takes it, and says it is full.
  const room = chooseHolder({ config, counts: counts([["local", 1], ["h2", 0]]) });
  assert.equal(room.name, "h2");
  assert.equal(room.atLimit, false, "0/1 has room");
  const full = chooseHolder({ config, counts: counts([["local", 1], ["h2", 1]]) });
  assert.equal(full.name, "local", "a tie keeps the pool's order");
  assert.equal(full.atLimit, true);
  assert.equal(full.overLimit, false, "exactly at the limit is full, not over");
  const over = chooseHolder({ config, counts: counts([["local", 2], ["h2", 2]]) });
  assert.equal(over.atLimit, true);
  assert.equal(over.overLimit, true);
});

test("reserved seats count for the choice, so two starts in flight spread", () => {
  // #1881: the pure half of the concurrency repair. A start already chosen but not attached is
  // in `reserved`; the next choice must see that seat. Without it two starts both read 0/0 and
  // both pick local.
  const config = pool(["local", "h2"], 1);
  const none = chooseHolder({ config, counts: counts([["local", 0], ["h2", 0]]) });
  assert.equal(none.name, "local");
  const first = chooseHolder({ config, counts: counts([["local", 0], ["h2", 0]]), reserved: counts([["local", 1]]) });
  assert.equal(first.name, "h2", "local's seat is reserved by the first start");
  const both = chooseHolder({ config, counts: counts([["local", 0], ["h2", 0]]), reserved: counts([["local", 1], ["h2", 1]]) });
  assert.equal(both.name, "local", "every holder full: the least loaded (a tie) takes it");
  assert.equal(both.count, 1, "the returned count includes the other starts' seats");
  assert.equal(both.atLimit, true);
});

test("a loss record names the holder and the bots it took, and nothing else", () => {
  const e = lossEvent({ at: "2026-11-16T10:00:00.000Z", holder: "h2", agents: ["b-two", "b-one", "b-two", null] });
  assert.deepEqual(e, { v: 1, at: "2026-11-16T10:00:00.000Z", holder: "h2", reason: "holder_lost", agents: ["b-one", "b-two"] });
  assert.equal(JSON.stringify(e).includes("/"), false, "no path or address");
  assert.equal(lossLine(e), 'holder lost: 2 agents in holder "h2" (b-one, b-two)');
  assert.equal(lossLine(lossEvent({ agents: ["b-one"], reason: "holder_unreachable" })),
    'holder unreachable: 1 agent in holder "local" (b-one)');
  assert.equal(sameLoss(e, { ...e }), true);
  assert.equal(sameLoss(e, { ...e, agents: ["b-one"] }), false);
  assert.equal(sameLoss(e, { ...e, at: "2026-11-16T10:00:01.000Z" }), false);
});
