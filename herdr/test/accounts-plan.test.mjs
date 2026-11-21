import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LOCAL, LOCAL_CLAIM_MS, LOCAL_FENCE_MS, PREVIEW_TTL_MS, cmp, emptyPlan, entryDigest,
  idDigest, isProxyId, linkedDue, localDue, machineOrder, parsePlan, planText, proxyId,
  recoverable, routeManaged, snapshotOf,
} from "../mods/am-sidebar/accountsPlanRecord.js";
import {
  buildPreview, close, commitPreview, fence, finishUnpin, goneLinked, markRead, markTried, observed, place,
  placeOne, rebalance, settle, startAttempt, suspend, viewsFrom,
} from "../mods/am-sidebar/accountsPlan.js";
import { openUrl } from "../mods/am-quota/view.js";

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const at = (ms = 0) => new Date(Date.UTC(2026, 10, 20) + ms).toISOString();
const A = "ana@example.test", B = "bo@example.test", C = "cy@example.test", D = "di@example.test";
const [L, M1, M2, M3, M4, M5] = [LOCAL, "core-one", "core-two", "core-three", "core-four", "core-five"];
// Core identifiers in the RFC fixtures are m1, m2, … in increasing order.
const cores = [L, "m1", "m2", "m3", "m4", "m5"];
const home = (id) => "/scratch/app-" + id;
const snapshot = sha256Hex("synthetic login record");
const owner = "a".repeat(32);
const proxy = "https://proxy.example.test";
const key = "codex-one";
const codexLocal = { home: "/scratch/codex", account: "01abcdef", generation: sha256Hex("synthetic generation"), proxy };
const localInput = { codexLocal, active: { name: key, fingerprint: codexLocal.account }, codexUsable: [key, "codex-two"] };
const absent = { state: "absent", rev: 0, digest: null };
const details = (email) => ({ email, state: email ? "eligible" : "not-signed-in" });

function view(id, email, keys = [A, B, C], overrides = {}) {
  const claude = {
    record: "ok", snapshot, selected: "default",
    effective: keys.indexOf(email) > 0 ? `slot-${keys.indexOf(email)}` : "default", email, state: details(email).state,
    slots: keys.map((email, i) => ({ id: i === 0 ? "default" : "slot-" + i, ...details(email) })),
    slotsComplete: true, nextSlot: "/scratch/claude-second",
    routes: { bare: details(email), record: details(email) }, routesDiffer: false,
  };
  return { id, name: id === L ? L : "vm-" + id, away: false, read: true, readAt: at(10), from: "fleet",
    appHome: home(id), qualified: true, claude, codex: null, exceptions: [], ...overrides };
}

function planFor(assign, { ids = Object.keys(assign), pins = {}, mode = "spread", account = null } = {}) {
  const plan = emptyPlan(at());
  plan.rev = 1;
  plan.claude.mode = mode;
  plan.claude.account = account;
  plan.claude.assign = { ...assign };
  plan.claude.pin = { ...pins };
  for (const id of ids) {
    if (id !== L) plan.names[id] = "vm-" + id;
    plan.claude.members[id] = { since: at(), home: home(id) };
    plan.claude.seen[id] = { home: home(id), snapshot, email: assign[id] ?? null };
    if (assign[id]) plan.claude.progress[id] = { state: "done", why: null, at: at(), tried: null, attempt: null, read: null };
  }
  return plan;
}

function baseFor(plan) {
  return plan ? { state: "ok", rev: plan.rev, digest: sha256Hex(planText(plan)) } : absent;
}
function preview(plan, views, request, { base = baseFor(plan), now = at(20), input } = {}) {
  return buildPreview({ plan, base, views, request: { v: 1, ...request }, input, now, id: "b".repeat(32), sha256Hex });
}
function commit(plan, built, { base = baseFor(plan), expectRev = built.base.rev, now = at(21) } = {}) {
  return commitPreview(plan, base, built, { expectRev, now, sha256Hex });
}
function approved(plan, views, request, options) {
  const result = preview(plan, views, request, options);
  assert.ok(result.preview, result.error);
  const saved = commit(plan, result.preview, options);
  assert.ok(saved.plan, saved.error);
  return { ...saved, ...result };
}
function * permutations(values) {
  if (!values.length) {
    yield [];
    return;
  }
  for (let i = 0; i < values.length; i++) {
    for (const rest of permutations(values.filter((_, position) => position !== i))) yield [values[i], ...rest];
  }
}
const assignment = (keys) => Object.fromEntries(keys.map((key, i) => [cores[i], key]));
const flag = (preview, machine, code) => preview.flags.some((f) => f.machine === machine && f.code === code);
const clause = (kind, rest = {}) => ({ kind, tool: "claude", ...rest });

test("RFC fixtures: one and one pin give exact maps in every machine order", () => {
  for (const pin of [false, true]) {
    const plan = planFor(assignment([C, B, B]), { pins: pin ? { m2: B } : {} });
    const views = cores.slice(0, 3).map((id) => view(id, plan.claude.assign[id]));
    for (const shuffled of permutations(views)) {
      const saved = approved(plan, shuffled, clause("mode", { mode: "one", account: A }));
      assert.deepEqual(saved.plan.claude.assign, assignment([A, A, pin ? B : A]));
    }
  }
});

test("RFC fixtures: three over two and four over three are placed in order for every permutation", () => {
  for (const [keys, expected] of [[[A, B], [A, B, A]], [[A, B, C], [A, B, C, A]]]) {
    const ids = cores.slice(0, expected.length);
    const { claude } = planFor({}, { ids });
    for (const shuffled of permutations(ids)) {
      const views = shuffled.map((id) => view(id, null, keys));
      assert.deepEqual(place(claude, views, {}, shuffled), assignment(expected));
    }
  }
});

test("RFC fixtures: exact rebalance maps and flags survive every permutation", () => {
  const cases = [
    { current: [A, A, B, B], want: [A, A, B, C] },
    { current: [A, A, A, B, B, C], keys: [[A], [A], [A, B], [B], [B, C], [C]], want: [A, A, B, B, C, C] },
    { current: [A, A, A], keys: [[A, B], [A, B], [A, B]], pin: { m1: C }, want: [A, A, B], code: ["m1", "pin-not-eligible"] },
    { current: [A, A, A], keys: [[A, B], [A, B], []], want: [A, B, A], code: ["m2", "nothing-eligible"] },
    { current: [A, A, A], keys: [[A, B], [A, B], [A, B]], away: "m2", want: [A, B, A], code: ["m2", "away"] },
  ];
  for (const { current, keys, pin, away, want, code } of cases) {
    const { claude } = planFor(assignment(current), { pins: pin });
    const views = current.map((key, i) => view(cores[i], key, keys?.[i], { away: cores[i] === away }));
    for (const shuffled of permutations(views)) {
      const members = Object.fromEntries(shuffled.map(({ id }) => [id, claude.members[id]]));
      const result = rebalance({ ...claude, members }, shuffled, {});
      assert.deepEqual(result.assign, assignment(want));
      assert.deepEqual(result.flags.map((f) => [f.machine, f.code]), code ? [code] : []);
    }
  }
});

test("Unicode code points and local first break ties", () => {
  assert.equal(cmp("😀", "～"), 1);
  assert.equal(cmp("B", "a"), -1);
  assert.deepEqual(machineOrder(["😀", "core", L, "～", "Z"]), [L, "Z", "core", "～", "😀"]);
  assert.equal(placeOne({}, ["😀", "～"]), "～");
  assert.equal(placeOne(new Map([["B", 0], ["a", 0]]), ["a", "B"]), "B");
});

test("rebalance freezes all pins, away and suspended assignments and counts zero-use accounts", () => {
  let plan = planFor(assignment([A, A, A, A, A]), { pins: { m1: D, m2: B } });
  plan = suspend(plan, "claude", "m3", "changed", at(1));
  const views = [
    view(L, A, [A, C]), view("m1", A, [A, B, C]), view("m2", A, [A, B, C]),
    view("m3", B, [A, B, C]), view("m4", C, [A, B, C], { away: true }),
  ];
  const result = rebalance(plan.claude, views, {});
  assert.deepEqual(result.assign, assignment([C, A, B, A, A]));
  assert.ok(flag(result, "m1", "pin-not-eligible"));
  assert.ok(flag(result, "m4", "away"));
});

function oracle(section, rows) {
  const ids = machineOrder(Object.keys(section.members));
  const universe = [...new Set(rows.flatMap(({ claude }) => claude.slots.map(({ email }) => email))
    .concat(Object.values(section.assign)))];
  const options = ids.map((id) => {
    const row = rows.find((row) => row.id === id);
    const pin = section.pin[id], current = section.assign[id] ?? null;
    const keys = row.claude.slots.map(({ email }) => email);
    if (row.away || section.progress[id]?.state === "suspended") return [current];
    if (pin) return [keys.includes(pin) ? pin : current];
    return keys.length ? keys : [current];
  });
  let best = null;
  function consider(accounts) {
    if (accounts.length < ids.length) {
      for (const account of options[accounts.length]) consider([...accounts, account]);
      return;
    }
    const loads = universe.map((key) => accounts.filter((value) => key === value).length).sort((a, b) => b - a);
    const moves = accounts.filter((account, i) => account !== (section.assign[ids[i]] ?? null)).length;
    const vector = [...loads, moves, ...accounts.map((a) => a ?? "")];
    const difference = best ? vector.findIndex((key, i) => key !== best.vector[i]) : -1;
    if (!best || difference >= 0 && vector[difference] < best.vector[difference]) best = { accounts, vector };
  }
  consider([]);
  return Object.fromEntries(ids.flatMap((id, i) => best.accounts[i] ? [[id, best.accounts[i]]] : []));
}

test("exact spread matches a brute-force oracle on 300 seeded fleets", () => {
  let seed = 424438;
  const rand = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 2 ** 32 * n);
  };
  const keys = [A, B, C, D];
  for (let i = 0; i < 300; i++) {
    const ids = cores.slice(0, 1 + rand(5));
    const assign = {}, pins = {};
    const views = ids.map((id) => {
      const present = rand(4) > 0;
      if (present) assign[id] = keys[rand(keys.length)];
      if (!rand(4)) pins[id] = keys[rand(keys.length)];
      return view(id, assign[id] ?? null, keys.filter(() => rand(4) > 0), { away: !rand(6) });
    });
    const plan = planFor(assign, { ids, pins });
    const result = rebalance(plan.claude, views.slice().reverse(), {});
    assert.deepEqual(result.assign, oracle(plan.claude, views), "fleet " + i);
  }
});

function freshSpread(machines, accounts) {
  const ids = [L, ...Array.from({ length: machines - 1 }, (_, i) => "m" + String(i + 1).padStart(2, "0"))];
  const keys = Array.from({ length: accounts }, (_, i) => "login" + String(i).padStart(2, "0") + "@example.test");
  return { ids, keys, views: ids.map((id) => view(id, null, keys)) };
}

test("fresh seven over twelve stays under 10,000 nodes for every shuffle", () => {
  const { ids, keys, views } = freshSpread(7, 12);
  const { claude } = planFor({}, { ids });
  const expected = Object.fromEntries(ids.map((id, i) => [id, keys[i]]));
  for (const shuffled of permutations(views)) {
    const members = Object.fromEntries(shuffled.map(({ id }) => [id, claude.members[id]]));
    assert.deepEqual(rebalance({ ...claude, members }, shuffled, {}, { maxNodes: 9_999 }).assign, expected);
  }
});

test("six over eight and ten over four finish; a fleet above the search limit returns too-many", () => {
  for (const [machines, accounts] of [[6, 8], [10, 4], [12, 6]]) {
    const { ids, keys, views } = freshSpread(machines, accounts);
    const current = Object.fromEntries(ids.map((id, i) => [id, keys[i % accounts]]));
    const result = rebalance(planFor(current, { ids }).claude, views, {});
    if (machines === 12) assert.deepEqual(result, { error: "too-many" });
    else assert.deepEqual(result.assign, current);
  }
});

test("placing several machines leaves unrelated assignments alone", () => {
  const plan = planFor({ [M1]: A, [M2]: C }, { ids: [L, M1, M2, M3] });
  const views = [view(M3, null), view(L, null), view(M2, C), view(M1, A)];
  assert.deepEqual(place(plan.claude, views, {}, [M3, L]), { [L]: B, [M1]: A, [M2]: C, [M3]: A });
  assert.deepEqual(plan.claude.assign, { [M1]: A, [M2]: C });
});

test("spread pin and unpin affect only that machine (Q7)", () => {
  const plan = planFor({ [L]: A, [M1]: A, [M2]: B });
  const views = [view(L, A), view(M1, A), view(M2, B)];
  let saved = approved(plan, views, clause("pin", { machine: M1, account: B }));
  assert.deepEqual(saved.plan.claude.assign, { [L]: A, [M1]: B, [M2]: B });
  assert.deepEqual(saved.preview.moves.map((m) => m.machine), [M1]);
  saved = approved(saved.plan, views, clause("unpin", { machine: M1 }));
  assert.deepEqual(saved.plan.claude.assign, { [L]: A, [M1]: C, [M2]: B });
  assert.deepEqual(saved.plan.claude.pin, {});
  const invalid = approved(plan, views, clause("pin", { machine: M1, account: D }));
  assert.equal(invalid.plan.claude.pin[M1], D);
  assert.equal(invalid.plan.claude.assign[M1], A);
  assert.ok(flag(invalid.preview, M1, "pin-not-eligible"));
});

test("one records the wanted account even where no login exists (Q8)", () => {
  const plan = planFor({ [M1]: A, [M2]: A });
  const saved = approved(plan, [view(M1, A, [A, B]), view(M2, A, [A])], clause("mode", { mode: "one", account: B }));
  assert.deepEqual(saved.plan.claude.assign, { [M1]: B, [M2]: B });
  assert.equal(saved.plan.claude.seen[M2].email, A);
  assert.equal(saved.plan.claude.progress[M2].why, "no-login");
  assert.ok(flag(saved.preview, M2, "no-login"));
});

function fleetRow(v, extra = {}) {
  const { id, name, claude, appHome, readAt, codex } = v;
  return { name: id === L ? null : name, core: id === L ? "core-local" : id, state: "read", at: readAt,
    appHome, writer: { confirmed: true }, write: true, exceptions: { bound: [], list: [], more: 0 },
    claude: claude ? { ...claude, readAt } : null, codex, ...extra };
}

test("Manage pins proven Claude reads and leaves local Codex observed even with one matching name", () => {
  const views = [
    view(L, A), view(M1, A), view(M2, A, [A], { appHome: null }),
    view(M3, A, [A], { read: false }), view(M4, A, [A], { away: true }), view(M5, A),
    view("core-bad", A), view("core-incomplete", A), view("core-ambiguous", A),
  ];
  views.find((v) => v.id === M5).claude = { ...view(M5, B).claude, record: "absent", snapshot: null };
  views.find((v) => v.id === "core-bad").claude.record = "bad";
  views.find((v) => v.id === "core-incomplete").claude.slotsComplete = false;
  views.find((v) => v.id === "core-ambiguous").claude.state = "ambiguous";
  const { plan, preview: built } = approved(null, views, { kind: "manage", ...localInput, codexAccounts: [key] });
  assert.deepEqual(plan.claude.assign, { [L]: A, [M1]: A, [M5]: B });
  assert.deepEqual(plan.codex.assign, {});
  assert.deepEqual(plan.codex.pin, {});
  assert.deepEqual(plan.codex.members, {});
  assert.ok(built.flags.some(({ tool, machine, code }) => tool === "codex" && machine === L && code === "unmanaged"));
  assert.deepEqual(built.moves, []);
  assert.ok(flag(built, M3, "unmanaged"));
  for (const core of [undefined, null, M2]) {
    const unbound = viewsFrom({ machines: { [M1]: fleetRow(view(M1, A), { core }) } }, null, () => true);
    assert.equal(unbound[0].read, false);
    assert.deepEqual(approved(null, unbound, { kind: "manage" }).plan.claude.assign, {});
  }
  for (const account of [null, "76543210"]) {
    assert.deepEqual(approved(null, views, { kind: "manage", ...localInput,
      codexLocal: { ...codexLocal, account } }).plan.codex.assign, {});
  }
  for (const generation of [null, sha256Hex("refreshed or independent synthetic sign-in")]) {
    const result = approved(null, views, { kind: "manage", ...localInput, codexLocal: { ...codexLocal, generation },
      active: { ...localInput.active, name: "codex-alias" } });
    assert.deepEqual(result.plan.codex.assign, {});
    assert.ok(result.preview.flags.some(({ tool, machine, code }) => tool === "codex" && machine === L && code === "unmanaged"));
  }
  const known = approved(null, views, { kind: "manage", ...localInput, codexUsable: [], codexAccounts: [key] });
  assert.equal(known.plan.codex.assign[L], undefined);
});

test("a fresh pin preview cannot absorb pending Claude drift before apply", () => {
  const before = planFor({ [M1]: A });
  const original = view(M1, A, [A, B, C, D]);
  const { plan } = approved(before, [original], clause("pin", { machine: M1, account: B }));
  const changed = view(M1, C, [A, B, C, D], { readAt: at(30) });
  changed.claude.snapshot = sha256Hex("changed on target");
  for (const pending of [plan, startAttempt(plan, "claude", M1, { rev: plan.rev, slot: "slot-1",
    slotDigest: idDigest("slot-1", B, sha256Hex), before: snapshot, eff: A, effDigest: idDigest("default", A, sha256Hex),
    home: home(M1), core: M1, now: at(24) })]) {
    const { preview: next } = preview(pending, [changed], clause("pin", { machine: M1, account: D }), { now: at(32) });
    assert.ok(flag(next, M1, "suspended-stays"));
    assert.deepEqual(next.moves, []);
    assert.deepEqual(next.patch.entries, []);
  }
  const next = approved(plan, [changed], clause("adopt", { machine: M1 }), { now: at(32) });
  assert.equal(next.plan.claude.assign[M1], C);
});

test("Spread again counts a reachable invalid pin on its observed account and retires the pending move", () => {
  const plan = planFor({ [M1]: B, [M2]: A }, { pins: { [M1]: C } });
  plan.claude.seen[M1].email = A;
  plan.claude.progress[M1].state = "pending";
  const views = [view(M1, A, [A, B]), view(M2, A, [A, B])];
  for (const shuffled of permutations(views)) {
    const result = approved(plan, shuffled, clause("spread-again"));
    assert.deepEqual(result.plan.claude.assign, { [M1]: A, [M2]: B });
    assert.equal(result.plan.claude.progress[M1].state, "done");
    assert.equal(result.plan.claude.pin[M1], C);
    assert.ok(flag(result.preview, M1, "pin-not-eligible"));
    assert.deepEqual(result.preview.moves.map(({ machine }) => machine), [M2]);
  }
});

test("moving a One group keeps its new account as the wanted login on unpinned members", () => {
  const plan = planFor({ [M1]: A, [M2]: A, [M3]: A }, { mode: "one", account: A, pins: { [M3]: A } });
  const result = approved(plan, [view(M1, A, [A, C]), view(M2, A, [A, B]), view(M3, A, [A, B])],
    clause("move-off", { account: A, to: C, include: [M3] }));
  assert.deepEqual(result.plan.claude.assign, { [M1]: C, [M2]: C, [M3]: B });
  assert.deepEqual(result.plan.claude.pin, { [M3]: B });
  assert.equal(result.plan.claude.account, C);
  assert.equal(result.plan.claude.progress[M2].why, "no-login");
  assert.ok(flag(result.preview, M2, "no-login"));
});

test("Codex requests are local only and enrollment places a fresh usable choice", () => {
  const v = view(L, A);
  const plan = planFor({});
  const codex = (kind, rest = {}) => ({ kind, tool: "codex", ...rest });
  for (const [kind, extra] of [["add", { account: key }], ["pin", { account: key }],
    ["unpin", {}], ["adopt", {}], ["reapply", {}], ["move-off", { account: key }]]) {
    assert.deepEqual(preview(plan, [v], codex(kind, { machine: M1, ...extra })), { error: "held" });
  }
  assert.deepEqual(preview(plan, [v], codex("move-off", { account: key, include: [M1] })), { error: "held" });
  const placed = approved(plan, [v], codex("add", { account: key, machine: L, ...localInput }));
  assert.deepEqual(placed.plan.codex.machines, []);
  assert.equal(placed.plan.codex.progress[L].state, "pending");
  assert.equal(placed.plan.codex.seen[L].placed, null);
  assert.equal(placed.plan.codex.assign[L], key);
  assert.deepEqual(placed.preview.moves, []);
  assert.deepEqual(placed.preview.changes[0].assign, [null, key]);
  const bad = preview(plan, [v], codex("add", { account: "codex-unusable", machine: L, ...localInput })).preview;
  assert.ok(flag(bad, L, "not-eligible"));
  assert.equal(bad.patch.entries.length, 0);
  assert.deepEqual(preview(plan, [v], codex("add", { account: key, machine: L, codexLocal })), { error: "bad-request" });
  for (const [kind, extra] of [["spread-again", {}], ["move-off", { account: key }]]) {
    assert.deepEqual(preview(placed.plan, [v], codex(kind, extra)), { error: "bad-request" });
    assert.ok(preview(placed.plan, [v], codex(kind, { ...extra, ...localInput })).preview);
  }
  for (const [kind, extra] of [["mode", { mode: "one", account: key }], ["pin", { machine: L, account: key }],
    ["unpin", { machine: L }]]) {
    assert.ok(preview(placed.plan, [v], codex(kind, { ...extra, ...localInput })).preview);
  }
  for (const input of Object.keys(localInput)) {
    assert.deepEqual(preview(plan, [v], clause("mode", { mode: "spread", [input]: localInput[input] })), { error: "bad-request" });
  }
  for (const kind of ["adopt", "reapply"]) {
    const suspended = suspend(placed.plan, "codex", L, "changed", at(15));
    assert.ok(preview(suspended, [v], codex(kind, { machine: L, ...localInput })).preview);
    assert.deepEqual(preview(suspended, [v], codex(kind, { machine: L, codexLocal })), { error: "bad-request" });
  }
  const managed = structuredClone(placed.plan);
  managed.codex.seen[L].placed = { ...codexLocal, name: "codex-placed", at: at() };
  assert.equal(observed("codex", v, localInput, managed), "codex-placed");
  const newProxy = { ...localInput, codexLocal: { ...codexLocal, proxy: "https://other.example.test" } };
  assert.equal(observed("codex", v, newProxy, managed), key);
  const adopted = approved(suspend(managed, "codex", L, "changed", at(15)), [v],
    codex("adopt", { machine: L, ...newProxy }));
  assert.equal(adopted.plan.codex.seen[L].placed, null);
});

test("a fresh Codex pin cannot absorb another account, but a same-account refresh keeps unknown origin", () => {
  const local = view(L, A);
  const plan = approved(planFor({}), [local], { kind: "add", tool: "codex", machine: L, account: key, ...localInput }).plan;
  const edit = (kind, read, extra = {}) => ({ kind, tool: "codex", machine: L, ...localInput, codexLocal: read, ...extra });
  const changed = { ...codexLocal, account: "02abcdef", generation: sha256Hex("signed in outside the panel") };
  for (const state of ["done", "pending"]) {
    plan.codex.progress[L].state = state;
    const got = preview(plan, [local], edit("pin", changed, { account: "codex-two" })).preview;
    assert.ok(flag(got, L, "suspended-stays"));
    assert.deepEqual(got.patch.entries, []);
    assert.equal(preview(plan, [local], edit("reapply", changed)).preview.changes.length, 1);
  }
  plan.codex.progress[L].state = "done";
  const refresh = { ...codexLocal, generation: sha256Hex("refreshed the same account") };
  assert.equal(preview(plan, [local], edit("pin", refresh, { account: "codex-two" })).preview.changes.length, 1);
});

test("unpin before dispatch in Pinned mode retires the queued Claude assignment", () => {
  const initial = planFor({ [M1]: A }, { mode: "pinned", pins: { [M1]: A } });
  const current = view(M1, A);
  const queued = approved(initial, [current], clause("pin", { machine: M1, account: B })).plan;
  assert.equal(queued.claude.progress[M1].state, "pending");
  const { plan, preview: result } = approved(queued, [current], clause("unpin", { machine: M1 }));
  assert.ok(flag(result, M1, "no-pin"));
  assert.deepEqual(result.changes[0].assign, [B, null]);
  assert.deepEqual(result.moves, []);
  assert.equal(plan.claude.pin[M1], undefined);
  assert.equal(plan.claude.assign[M1], undefined);
  assert.equal(plan.claude.progress[M1], undefined);
  assert.deepEqual(linkedDue(plan, { now: at(22), retry: false }), []);
});

test("Pinned Unpin keeps the newer bound read for the next One preview", () => {
  const initial = planFor({ [M1]: A }, { mode: "pinned", pins: { [M1]: A } });
  const read = readAt(M1, A, 15, { snapshot: sha256Hex("newer login record") });
  const done = markRead(initial, "claude", M1, read, read.at);
  const fleet = { machines: { [M1]: fleetRow(view(M1, B)) } };
  const unpinned = approved(done, viewsFrom(fleet, done), clause("unpin", { machine: M1 })).plan;
  assert.deepEqual(unpinned.claude.progress[M1], { read });
  assert.equal(unpinned.claude.assign[M1], undefined);
  assert.deepEqual(linkedDue(unpinned, { now: at(22), retry: false }), []);

  const settings = approved(unpinned, viewsFrom(fleet, unpinned), { kind: "second-login", machine: M1, allow: true }).plan;
  assert.deepEqual(settings.claude.progress[M1], { read });
  const next = approved(settings, viewsFrom(fleet, settings), clause("mode", { mode: "one", account: C }));
  assert.deepEqual(next.preview.moves.map(({ from, to }) => [from, to]), [[A, C]]);
  assert.deepEqual(next.plan.claude.seen[M1], { home: read.home, snapshot: read.snapshot, email: A });
});

test("finishing a deferred Unpin keeps the bound read for a new pin", () => {
  const initial = planFor({ [M1]: B }, { mode: "pinned", pins: { [M1]: B } });
  const read = readAt(M1, A, 15);
  const pending = markRead(tryClaude(initial, M1), "claude", M1, read, read.at);
  pending.claude.progress[M1].state = "pending";
  const fleet = { machines: { [M1]: fleetRow(view(M1, B)) } };
  const cancelling = approved(pending, viewsFrom(fleet, pending), clause("unpin", { machine: M1 })).plan;
  assert.equal(cancelling.claude.progress[M1].cancel, true);
  const unpinned = finishUnpin(cancelling, M1, at(22));
  assert.deepEqual(unpinned.claude.progress[M1], { read });
  const next = approved(unpinned, viewsFrom(fleet, unpinned), clause("pin", { machine: M1, account: C }));
  assert.equal(next.preview.changes[0].observed, A);
  assert.equal(next.plan.claude.seen[M1].email, A);
});

test("parsePlan validates all entries, ignores unknown fields and protects newer plans", () => {
  assert.deepEqual(parsePlan(null), { state: "absent", plan: null });
  const plan = planFor({ [M1]: A, [L]: B });
  assert.deepEqual(parsePlan(planText(plan)), { state: "ok", plan });
  assert.equal(planText(parsePlan(planText(plan)).plan), planText(plan));
  assert.equal(parsePlan("<bad").state, "corrupt");
  assert.equal(parsePlan("{}").state, "corrupt");
  assert.equal(parsePlan('{"v":2}').state, "newer");
  for (const change of [
    (p) => { p.v = "1"; },
    (p) => { p.rev = -1; },
    (p) => { p.names["bad id"] = "vm-one"; },
    (p) => { p.claude.members[M1].home = "relative"; },
    (p) => { p.claude.members[M1].since = "now"; },
    (p) => { p.claude.assign[M1] = "ANA@example.test"; },
    (p) => { p.claude.seen[M1].snapshot = "short"; },
    (p) => { p.claude.progress[M1].why = "no-login"; },
    (p) => { p.claude.progress[M1].attempt = {}; },
    (p) => { delete p.claude.members[M1]; },
    (p) => { p.claude.secondLogin[M1] = false; },
    (p) => { p.codex.machines = [L]; },
  ]) {
    const damaged = structuredClone(plan);
    change(damaged);
    assert.equal(parsePlan(JSON.stringify(damaged)).state, "corrupt");
  }
  for (const map of ["machines", "members", "assign", "pin", "seen", "progress"]) {
    const newer = structuredClone(plan);
    newer.codex[map] = map === "machines" ? [M1] : { [M1]: null };
    assert.equal(parsePlan(JSON.stringify(newer)).state, "newer");
  }
  const extended = structuredClone(plan);
  extended.unlisted = "CANARY-PLAN-0043";
  extended.claude.seen[M1].unlisted = "CANARY-PLAN-0043";
  assert.deepEqual(parsePlan(JSON.stringify(extended)).plan, plan);
  assert.equal(planText(extended).includes("CANARY-PLAN-0043"), false);
  assert.equal(snapshotOf({ record: "ok", snapshot }), snapshot);
  assert.equal(snapshotOf({ record: "absent", snapshot: null }), "none");
  for (const value of [null, snapshot]) assert.equal(snapshotOf({ record: "bad", snapshot: value }), null);
  assert.equal(idDigest("default", A, sha256Hex), sha256Hex("default\n" + A));
});

test("proxy identities match Open on plain URLs and refuse credentials, parameters and fragments", () => {
  for (const url of ["HTTP://proxy.example.test/", " https://proxy.example.test:3443/path/// ",
    "https://[::1]:8000/one/two", "https://proxy.example.test/a@b", "https://proxy.example.test"]) {
    assert.equal(proxyId(url), openUrl({ url }));
    assert.ok(isProxyId(proxyId(url)));
  }
  for (const url of ["https://ana:CANARY-PLAN-0043@proxy.example.test/path",
    "https://proxy.example.test/?key=CANARY-PLAN-0043", "https://proxy.example.test/path#",
    "https://proxy.example.test/a b", "https://proxy.example.test/" + "é".repeat(260)]) {
    assert.equal(proxyId(url), null);
    assert.equal(isProxyId(url), false);
  }
});

function tryClaude(plan, id, now = at(12)) {
  return startAttempt(plan, "claude", id, { rev: plan.rev, slot: "slot-1", slotDigest: idDigest("slot-1", plan.claude.assign[id], sha256Hex),
    before: snapshot, eff: A, effDigest: idDigest("default", A, sha256Hex), home: home(id),
    core: id === L ? null : id, owner: id === L ? owner : null, now });
}

function readAt(id, email, ms, extra = {}) {
  const obs = view(id, email).claude;
  const { routes, routesDiffer, ...claude } = obs;
  return { at: at(ms), core: id === L ? null : id, home: home(id), ...claude, effective: "default", ...extra };
}

test("commit checks the revision and expiry and merges only fields the preview changes", () => {
  let plan = planFor({ [M1]: A, [M2]: A });
  plan = markRead(plan, "claude", M1, readAt(M1, A, 5), at(5));
  plan = tryClaude(plan, M1, at(6));
  plan = close(plan, "claude", M1, 1, "failed");
  const v = [view(M1, A), view(M2, A)];
  const setting = preview(plan, v, { kind: "second-login", machine: M1, allow: true }).preview;
  assert.deepEqual(commit(plan, setting, { expectRev: 500 }), { error: "stale" });
  assert.deepEqual(commit({ ...plan, rev: 2 }, setting), { error: "stale" });
  assert.deepEqual(commit(plan, setting, { now: at(20 + PREVIEW_TTL_MS) }), { error: "expired" });
  const tried = markTried(plan, "claude", M1, at(17));
  assert.equal(entryDigest(plan, "claude", M1, sha256Hex), entryDigest(tried, "claude", M1, sha256Hex));
  assert.equal(entryDigest(plan, "claude", M1, sha256Hex),
    entryDigest(parsePlan(planText(plan)).plan, "claude", M1, sha256Hex));
  const advanced = settle(tried, "claude", M2, { state: "pending", why: "lost", now: at(18) });
  assert.equal(advanced.rev, plan.rev);
  assert.notEqual(baseFor(advanced).digest, baseFor(plan).digest);
  const fresh = commit(advanced, setting).plan;
  assert.equal(fresh.rev, plan.rev + 1);
  assert.deepEqual(fresh.claude.progress, advanced.claude.progress);
  assert.equal(fresh.claude.secondLogin[M1], true);
  const pinned = preview(plan, v, clause("pin", { machine: M1, account: B })).preview;
  const changed = commit(advanced, pinned).plan;
  assert.equal(changed.claude.assign[M1], B);
  assert.deepEqual(changed.claude.seen[M1], { email: A, snapshot, home: home(M1) });
  assert.equal(changed.claude.progress[M1].attempt, null);
  assert.deepEqual(changed.claude.progress[M1].read, plan.claude.progress[M1].read);
});

test("same-revision attempts, suspensions, progress and name changes invalidate affected previews", () => {
  const plan = planFor({ [M1]: A, [M2]: A });
  const old = preview(plan, [view(M1, A)], clause("pin", { machine: M1, account: B })).preview;
  for (const changed of [
    tryClaude(plan, M1),
    suspend(plan, "claude", M1, "changed", at(12)),
    settle(plan, "claude", M1, { state: "pending", why: "lost", now: at(12) }),
  ]) assert.deepEqual(commit(changed, old), { error: "stale" });
  const suspended = suspend(plan, "claude", M1, "changed", at(12));
  const result = approved(suspended, [view(M1, A), view(M2, A)], clause("mode", { mode: "one", account: B }));
  assert.ok(flag(result.preview, M1, "suspended-stays"));
  assert.deepEqual(result.plan.claude.progress[M1], suspended.claude.progress[M1]);
  assert.equal(result.plan.claude.assign[M1], A);
  const rename = preview(plan, [view(M1, A, [A, B], { name: "vm-new" })], clause("pin", { machine: M1, account: B })).preview;
  assert.deepEqual(rename.patch.names.set[M1], ["vm-" + M1, "vm-new"]);
  assert.deepEqual(commit({ ...plan, names: { ...plan.names, [M1]: "vm-other" } }, rename), { error: "stale" });
});

test("corrupt or newer records need the exact permitted replacement", () => {
  const corrupt = { state: "corrupt", rev: 0, digest: sha256Hex("synthetic corrupt data") };
  const newer = { ...corrupt, state: "newer" };
  const views = [view(M1, A)];
  const rebuild = preview(null, views, { kind: "manage" }, { base: corrupt }).preview;
  assert.deepEqual(preview(null, views, clause("mode", { mode: "spread" }), { base: corrupt }), { error: "no-plan" });
  assert.ok(commit(null, rebuild, { base: corrupt }).plan);
  assert.deepEqual(commit(null, rebuild, { base: { ...corrupt, digest: sha256Hex("other bytes") } }), { error: "stale" });
  assert.deepEqual(commit(null, rebuild, { base: newer }), { error: "newer-plan" });
  assert.deepEqual(preview(null, views, { kind: "manage" }, { base: newer }), { error: "newer-plan" });
  const first = preview(null, views, { kind: "manage" }).preview;
  assert.deepEqual(commit(null, first, { base: corrupt }), { error: "stale" });
});

test("Adopt, Re-apply, Rebind and Forget respect the machine's suspension and core", () => {
  const current = view(M1, B);
  for (const [mode, pins, expectedPin] of [["one", {}, B], ["pinned", {}, B], ["spread", { [M1]: A }, B], ["spread", {}, undefined]]) {
    const plan = suspend(planFor({ [M1]: A }, { mode, account: mode === "one" ? A : null, pins }), "claude", M1, "changed", at(9));
    const adopted = approved(plan, [current], clause("adopt", { machine: M1 })).plan;
    assert.equal(adopted.claude.assign[M1], B);
    assert.equal(adopted.claude.pin[M1], expectedPin);
    assert.equal(adopted.claude.progress[M1].state, "done");
    const reapplied = approved(plan, [current], clause("reapply", { machine: M1 })).plan;
    assert.equal(reapplied.claude.assign[M1], A);
    assert.equal(reapplied.claude.seen[M1].email, B);
    assert.equal(reapplied.claude.progress[M1].state, "pending");
    assert.deepEqual(preview(plan, [current], { kind: "forget", machine: M1 }), { error: "not-gone" });
  }
  let plan = planFor({ [L]: B, [M1]: A, [M2]: B }, { pins: { [M1]: A } });
  plan.claude.secondLogin[M1] = true;
  assert.deepEqual(preview(plan, [], { kind: "forget", machine: M1 }), { error: "not-gone" });
  plan = suspend(plan, "claude", M1, "gone", at(11));
  const rebound = approved(plan, [view(M3, B)], { kind: "rebind", from: M1, to: M3 });
  assert.equal(rebound.preview.request.from, M1);
  assert.deepEqual(rebound.plan.claude.assign, { [L]: B, [M2]: B, [M3]: A });
  assert.deepEqual(rebound.plan.claude.pin, { [M3]: A });
  assert.deepEqual(rebound.plan.claude.secondLogin, { [M3]: true });
  assert.equal(rebound.plan.claude.members[M3].home, home(M3));
  assert.equal(rebound.plan.claude.seen[M3].email, B);
  assert.equal(rebound.plan.claude.progress[M3].attempt, null);
  assert.equal(rebound.plan.names[M1], undefined);
  assert.deepEqual(rebound.plan.codex, plan.codex);
  const forgotten = approved(plan, [], { kind: "forget", machine: M1 }).plan;
  assert.deepEqual(forgotten.claude.assign, { [L]: B, [M2]: B });
  assert.deepEqual(forgotten.claude.secondLogin, {});
  assert.deepEqual(forgotten.codex, plan.codex);
  for (const options of [{ from: M1, to: L }, { from: L, to: M3 }, { to: M3 }]) {
    assert.deepEqual(preview(plan, [], { kind: "rebind", ...options }), { error: "bad-request" });
  }
  assert.deepEqual(preview(plan, [], { kind: "rebind", from: M1, to: M2 }), { error: "member" });
  assert.deepEqual(preview(plan, [], { kind: "forget", machine: L }), { error: "bad-request" });
});

test("complete membership checks compare linked Claude cores only", () => {
  const plan = approved(null, [view(L, A), view(M1, A), view(M2, B)], { kind: "manage", ...localInput, codexAccounts: [key] }).plan;
  assert.deepEqual(goneLinked(plan, null), []);
  assert.deepEqual(goneLinked(plan, { complete: false, list: [] }), []);
  assert.deepEqual(goneLinked(plan, { complete: true, list: [{ id: M1 }] }), [M2]);
  assert.equal(plan.claude.progress[L].state, "done");
  assert.equal(plan.codex.progress[L], undefined);
});

test("Move off leaves pins unless included, updates included pins and scopes the move", () => {
  const views = [view(L, A), view(M1, A), view(M2, A), view(M3, B)];
  const plan = planFor({ [L]: A, [M1]: A, [M2]: A, [M3]: B }, { mode: "one", account: A, pins: { [M1]: A } });
  assert.deepEqual(preview(plan, views, clause("move-off", { account: A })), { error: "bad-request" });
  const left = approved(plan, views, clause("move-off", { account: A, to: C }));
  assert.equal(left.plan.claude.account, C);
  assert.deepEqual(left.plan.claude.assign, { [L]: C, [M1]: A, [M2]: C, [M3]: B });
  assert.ok(flag(left.preview, M1, "pinned-stays"));
  const included = approved(plan, views, clause("move-off", { account: A, to: C, include: [M1] }));
  assert.deepEqual(included.plan.claude.assign, { [L]: C, [M1]: C, [M2]: C, [M3]: B });
  assert.equal(included.plan.claude.pin[M1], C);
  const pinned = approved(included.plan, views, clause("mode", { mode: "pinned" })).plan;
  assert.deepEqual(pinned.claude.assign, included.plan.claude.assign);
  const only = approved(plan, views, clause("move-off", { account: A, to: C, machine: M2 })).plan;
  assert.deepEqual(only.claude.assign, { [L]: A, [M1]: A, [M2]: C, [M3]: B });
  const fallback = approved({ ...plan, claude: { ...plan.claude, mode: "spread", account: null } },
    [view(L, A, [A]), view(M1, A), view(M2, A, [A, B]), view(M3, B)],
    clause("move-off", { account: A, to: C }));
  assert.deepEqual(fallback.plan.claude.assign, { [L]: A, [M1]: A, [M2]: B, [M3]: B });
  assert.ok(flag(fallback.preview, L, "nothing-eligible"));
});

test("linked due selection paces retries, no-login and read-only drift independently", () => {
  const now = 3_600_000;
  let plan = planFor({ [L]: A, [M1]: A, [M2]: A, [M3]: A, [M4]: A, [M5]: A });
  for (const id of [L, M1, M2, M3]) plan = settle(plan, "claude", id, {
    state: "pending", why: id === M3 ? "no-login" : "lost", now: at(1),
  });
  plan = markTried(plan, "claude", M1, at(now - 300_000));
  plan = markTried(plan, "claude", M2, at(now - 299_999));
  plan = markTried(plan, "claude", M3, at(1));
  plan = suspend(plan, "claude", M4, "changed", at(1));
  const due = (time, retry = true, fleet = null) => linkedDue(plan, { now: at(time), retry, fleet }).map((d) => d.machine);
  assert.deepEqual(due(now), [M5, M1]);
  assert.deepEqual(due(now, false), [M5, M1, M2]);
  assert.deepEqual(due(now + 1), [M5, M1, M3, M2]);
  plan = markRead(plan, "claude", M5, readAt(M5, A, 100), at(101));
  assert.deepEqual(due(now), [M1]);
  for (const [email, ms, core] of [[B, 100, M5], [B, 102, null], [B, 102, M1], [A, 102, M5], [B, 102, M5]]) {
    const fleet = { machines: { [M5]: fleetRow(view(M5, email, [A, B], { readAt: at(ms) }), { core }) } };
    assert.deepEqual(due(now, true, fleet), email === B && ms === 102 && core === M5 ? [M5, M1] : [M1]);
  }
  assert.ok(due(now + 101).includes(M5));
});

test("local due and recovery respect the owner, claim age and fence", () => {
  const result = approved(planFor({}), [view(L, A)], { kind: "add", tool: "codex", machine: L, account: key, ...localInput });
  const plan = result.plan;
  const due = (p, ms, who = owner) => localDue(p, "codex", at(ms), who);
  const other = "b".repeat(32);
  assert.equal(due(plan, 30), "apply");
  const start = startAttempt(plan, "codex", L, { rev: plan.rev, before: codexLocal.generation,
    home: codexLocal.home, owner, proxy, now: at(30) });
  assert.equal(due(start, 30), "read-back");
  assert.equal(due(start, 30 + LOCAL_CLAIM_MS - 1, other), "wait");
  assert.equal(due(start, 30 + LOCAL_CLAIM_MS, other), "read-back");
  const active = fence(start, "codex", L, 1, { intended: snapshot, now: at(50) });
  assert.equal(active.codex.progress[L].attempt.intended, snapshot);
  assert.equal(due(active, 50 + LOCAL_FENCE_MS - 1), "wait");
  assert.equal(due(active, 50 + LOCAL_FENCE_MS, other), "wait");
  assert.equal(due(active, 50 + LOCAL_FENCE_MS), "read-back");
  assert.ok(recoverable(active.codex.progress[L].attempt, at(30 + LOCAL_CLAIM_MS)));
  assert.equal(due(close(active, "codex", L, 1, "lost"), 600), "apply");
  const unusuallyLateFence = { ...active.codex.progress[L].attempt, fencedAt: at(LOCAL_CLAIM_MS) };
  assert.equal(recoverable(unusuallyLateFence, at(LOCAL_CLAIM_MS + LOCAL_FENCE_MS - 1)), false);
  const request = { kind: "add", tool: "codex", machine: L, account: key, ...localInput };
  const built = preview(active, [view(L, A)], request, { now: at(60) }).preview;
  assert.deepEqual(commit(active, built, { now: at(61) }), { error: "busy-local" });
  const resumed = commit(active, built, { now: at(30 + LOCAL_CLAIM_MS) }).plan;
  assert.equal(resumed.codex.progress[L].attempt.outcome, "lost");
  assert.equal(resumed.codex.progress[L].state, "pending");
});

test("route previews use the managed record after apply and preserve project exceptions", () => {
  const inherited = view(M1, A, [A, B]);
  inherited.claude.routes.bare = details(B);
  inherited.claude.routesDiffer = true;
  inherited.exceptions = [{ project: "/scratch/own-path", why: "own-path" },
    { project: "/scratch/own-home", why: "own-app-home" }, { project: "/scratch/unread", why: "unread" }];
  const pin = approved(planFor({ [M1]: A }), [inherited], clause("pin", { machine: M1, account: B })).preview;
  assert.deepEqual(pin.changes[0].routes, { now: { start: B, tree: A }, next: { start: B, tree: B } });
  assert.deepEqual(pin.changes[0].exceptions, inherited.exceptions);
  assert.ok(flag(pin, M1, "unmanaged-home"));
  for (const { why } of inherited.exceptions) assert.equal(routeManaged(why), false);
  assert.equal(routeManaged(null), true);

  const join = approved(planFor({}, { mode: "one", account: C }), [inherited],
    clause("add", { machine: M1 })).preview;
  assert.deepEqual(join.changes[0].routes, { now: { start: B, tree: A }, next: { start: A, tree: A } });
  assert.ok(flag(join, M1, "no-login"));

  inherited.claude.routes.bare = { state: "unresolved", email: null };
  const unresolved = approved(planFor({ [M1]: A }), [inherited], clause("pin", { machine: M1, account: B })).preview;
  assert.deepEqual(unresolved.changes[0].routes.next, { start: "unresolved", tree: B });
});

test("a custom target launcher leaves the tree route unresolved even with an eligible slot", () => {
  const remote = view(M1, null, [A, B]);
  remote.claude.state = "unresolved";
  remote.claude.routes = { bare: details(A), record: { state: "unresolved", email: null } };
  const initial = planFor({ [M1]: A });
  const { preview: change } = approved(initial, [remote], clause("pin", { machine: M1, account: B }));
  assert.deepEqual(change.changes[0].routes, { now: { start: A, tree: "unresolved" }, next: { start: A, tree: "unresolved" } });
  remote.claude.state = "eligible";
  remote.claude.routes.record = details(A);
  remote.qualified = false;
  const { preview: unqualified } = approved(initial, [remote], clause("pin", { machine: M1, account: B }));
  assert.ok(flag(unqualified, M1, "update-first"));
  assert.deepEqual(unqualified.changes[0].routes.next, { start: A, tree: A });
});

test("a preview predicts accounts only on eligible Claude launch routes", () => {
  const initial = planFor({ [M1]: A });
  for (const state of ["failed", "timeout", "not-signed-in", "unresolved"]) {
    const remote = view(M1, A, [A, B]);
    remote.claude.routes.record = { state, email: null };
    const change = approved(initial, [remote], clause("pin", { machine: M1, account: B })).preview;
    assert.deepEqual(change.changes[0].routes.next, { start: A, tree: state });
    remote.claude.routes = { bare: { state, email: null }, record: details(A) };
    const other = approved(initial, [remote], clause("pin", { machine: M1, account: B })).preview;
    assert.deepEqual(other.changes[0].routes.next, { start: state === "not-signed-in" ? B : state, tree: B });
  }
});

test("preview views use the newest bound read and reject stale or incomplete inventories", () => {
  let plan = planFor({ [M1]: A, [M2]: A, [M3]: A });
  plan = markRead(plan, "claude", M1, readAt(M1, B, 15), at(15));
  plan = suspend(plan, "claude", M1, "changed", at(15));
  const older = fleetRow(view(M1, A), {
    unwanted: "CANARY-PLAN-0043", versions: { pack: "ignored" },
    codex: { account: codexLocal.account, generation: snapshot, home: "/scratch/codex", unwanted: "CANARY-PLAN-0043" },
  });
  const fleet = { machines: { [M1]: older, [M2]: fleetRow(view(M2, A), { core: M1 }) } };
  const qualify = (writer, installed) => writer?.confirmed && installed;
  const views = viewsFrom(fleet, plan, qualify);
  assert.equal(views.find((v) => v.id === M2).read, false);
  assert.equal(views.find((v) => v.id === M3).read, false);
  assert.equal(JSON.stringify(views).includes("CANARY-PLAN-0043"), false);
  assert.equal(views[0].claude.email, B);
  assert.equal(views[0].from, "apply");
  assert.equal(views[0].qualified, true);
  for (const record of [fleet, null]) {
    const fresh = viewsFrom(record, plan, qualify);
    const adopted = approved(plan, fresh, clause("adopt", { machine: M1 })).plan;
    assert.equal(adopted.claude.assign[M1], B);
  }
  const ingest = (entry) => viewsFrom({ machines: { [M1]: entry } }, plan, qualify).find((v) => v.id === M1);
  assert.equal(ingest({ ...older, state: "away", at: at(14) }).read, true);
  const away = ingest({ ...older, state: "away", at: at(16) });
  assert.equal(away.read, false);
  assert.equal(away.away, true);
  const newest = fleetRow(view(M1, C, [A, B, C], { readAt: at(17) }));
  assert.equal(ingest(newest).claude.email, C);
  newest.claude.slotsComplete = false;
  const unread = preview(plan, [ingest(newest)], clause("adopt", { machine: M1 })).preview;
  assert.ok(flag(unread, M1, "read-again"));
  assert.deepEqual(unread.patch.entries, []);

  const stale = suspend(plan, "claude", M2, "changed", at(15));
  const noFreshRead = preview(stale, [view(M2, B)], clause("reapply", { machine: M2 })).preview;
  assert.ok(flag(noFreshRead, M2, "read-again"));
  assert.deepEqual(noFreshRead.patch.entries, []);
});

test("Spread again counts the frozen assignment of a machine with an incomplete inventory", () => {
  const plan = planFor({ [L]: A, [M1]: A, [M2]: A, [M3]: B });
  const incomplete = view(M2, A, [A, B, C]);
  incomplete.claude.slotsComplete = false;
  const views = [view(L, A, [A]), view(M1, A, [A, C]), incomplete, view(M3, B, [B])];
  const saved = approved(plan, views, clause("spread-again"));
  assert.deepEqual(saved.plan.claude.assign, { [L]: A, [M1]: C, [M2]: A, [M3]: B });
  assert.ok(flag(saved.preview, M2, "read-again"));
  assert.deepEqual(saved.preview.patch.entries.map(({ machine }) => machine), [M1]);
});

test("Codex records placement only after a fenced read-back of the intended bytes", () => {
  const { plan } = approved(planFor({}), [view(L, A)], { kind: "add", tool: "codex", machine: L, account: key, ...localInput });
  const attempt = startAttempt(plan, "codex", L, { rev: plan.rev, before: codexLocal.generation,
    home: codexLocal.home, owner, proxy, now: at(30) });
  const installed = { ...codexLocal, generation: snapshot };
  const placed = { name: key, proxy, account: installed.account, generation: snapshot, at: at(60) };
  const read = { at: at(60), ...installed };
  const done = (source, evidence = read) => settle(source, "codex", L,
    { state: "done", seen: evidence, read: evidence, placed, now: at(60) });
  assert.equal(done(attempt).codex.seen[L].placed, null);
  const fenced = fence(attempt, "codex", L, 1, { intended: snapshot, now: at(50) });
  assert.equal(done(fenced, { ...read, generation: codexLocal.generation }).codex.seen[L].placed, null);
  assert.deepEqual(done(fenced).codex.seen[L].placed, placed);
  assert.equal(parsePlan(planText(done(fenced))).state, "ok");
});

test("account plan record in am-quota is byte-equal to the sidebar source", () => {
  const read = (url) => readFileSync(new URL(url, import.meta.url));
  assert.deepEqual(read("../mods/am-quota/accountsPlanRecord.js"), read("../mods/am-sidebar/accountsPlanRecord.js"));
});

test("Spread minimizes switches against fresh observations when assignments differ", () => {
  const { claude } = planFor({ [L]: A, m1: A });
  const views = [view(L, B, [A, B]), view("m1", A, [A, B])];
  assert.deepEqual(rebalance(claude, views, {}).assign, { [L]: B, m1: A });
});

test("fresh fleet drift blocks ordinary edits and immediately offers Adopt and Re-apply", () => {
  const plan = planFor({ [M1]: A, [M2]: A });
  const views = viewsFrom({ machines: { [M1]: fleetRow(view(M1, B)), [M2]: fleetRow(view(M2, A)) } }, plan);
  for (const request of [clause("pin", { machine: M1, account: C }), clause("mode", { mode: "one", account: C }),
    clause("spread-again")]) {
    const result = preview(plan, views, request).preview;
    assert.ok(flag(result, M1, "suspended-stays"));
    assert.equal(result.patch.entries.some(({ machine }) => machine === M1), false);
  }
  const saved = approved(plan, views, clause("adopt", { machine: M1 })).plan;
  assert.equal(saved.claude.assign[M1], B);
  const reapplied = approved(plan, views, clause("reapply", { machine: M1 })).plan;
  assert.equal(reapplied.claude.assign[M1], A);
  assert.equal(reapplied.claude.seen[M1].email, B);
  assert.equal(reapplied.claude.progress[M1].state, "pending");
});

test("one refuses a partial account commit while an unpinned machine is away and succeeds after its return", () => {
  const plan = planFor({ [M1]: A, [M2]: A }, { mode: "one", account: A });
  const request = clause("account", { account: B });
  const away = [view(M1, A), view(M2, A, [A, B], { away: true, read: false })];
  const blocked = preview(plan, away, request).preview;
  assert.ok(flag(blocked, M2, "read-again"));
  assert.ok(flag(blocked, M2, "away"));
  assert.deepEqual(blocked.patch.entries, []);
  assert.deepEqual(commit(plan, blocked), { error: "read-again" });
  assert.equal(plan.claude.account, A);
  const saved = approved(plan, [away[0], view(M2, A)], request).plan;
  assert.equal(saved.claude.account, B);
  assert.deepEqual(saved.claude.assign, { [M1]: B, [M2]: B });
  assert.equal(saved.claude.progress[M2].state, "pending");
});

test("moving off the one account needs all unpinned reads unless it is a single-machine override", () => {
  const plan = planFor({ [M1]: A, [M2]: A }, { mode: "one", account: A });
  const views = [view(M1, A), view(M2, A, [A, B], { away: true, read: false })];
  const request = clause("move-off", { account: A, to: B });
  const blocked = preview(plan, views, request).preview;
  assert.deepEqual(commit(plan, blocked), { error: "read-again" });
  const { plan: override } = approved(plan, views, { ...request, machine: M1 });
  assert.equal(override.claude.account, A);
  assert.deepEqual(override.claude.pin, { [M1]: B });
  assert.deepEqual(override.claude.assign, { [M1]: B, [M2]: A });
});
