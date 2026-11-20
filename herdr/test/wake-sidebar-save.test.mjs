// Drive the Edit and Prompt saves through the same Herdr and gpui stubs as create.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { test } from "node:test";

import { hcFileOps } from "./hc-file-ops.mjs";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const stubs = {
  herdr: new URL("./form-herdr-stub.mjs", import.meta.url).href,
  "fs/promises": new URL("./fs-stub.mjs", import.meta.url).href,
  "gpui-kit": new URL("./gpui-stub.mjs", import.meta.url).href,
  "gpui-base": new URL("./gpui-stub.mjs", import.meta.url).href,
};
registerHooks({
  resolve: (specifier, context, next) => stubs[specifier] && context.parentURL?.includes("/mods/am-sidebar/")
    ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context),
});
const { state } = await import(stubs.herdr);
const { index, nodes } = await import(stubs["gpui-kit"]);
const { BotForm } = await import("../mods/am-sidebar/create.js");

const BOT = {
  id: "b-aaaaaaaaaa", name: "Research", kind: "main", agent: "claude",
  role: "", instructions: "old words", look: { character: "star", colour: "blue" },
};

function scene(t, machine, wake) {
  const root = scratchRoot(t, "hb-wake-sidebar-");
  const project = scratchProject(root, "project", {
    isGit: false,
    bots: { version: 1, categories: [], bots: [{ ...BOT, wake }] },
  });
  Object.assign(state, {
    appHome: join(root, "app"), notes: [], closed: [], runs: [], spaces: [], focused: null, pickFolder: null,
    terminals: [], agents: [{ key: "claude", name: "Claude Code", installed: true }],
    offline: new Set(), calls: [], hcCalls: [], trimExec: false, hcAnswer: hcFileOps(state),
  });
  const path = join(project, ".herdr/bots.json");
  return { project, machine, read: () => readFileSync(path, "utf8") };
}

async function open({ project, machine }, form) {
  const pending = [];
  const cx = {
    spawn(fn) { const p = Promise.resolve().then(() => fn(cx)); pending.push(p); return p; },
    notify() {},
    stop_propagation() {},
  };
  const settle = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };
  const popup = new BotForm({ overlay: "o9", form, project, machine, bot: BOT.id, name: BOT.name, planned: false }, cx);
  await settle();
  const click = async (id) => { index(popup.render(cx)); nodes.get(id).click(null, cx); await settle(); };
  return { popup, cx, click };
}

for (const machine of [null, "vm"]) {
  for (const [kind, wake] of [["valid", "daily@09:30"], ["malformed", " daily@9:30 "], ["null", null], ["empty", ""]]) {
    test(`sidebar Edit and Prompt preserve the ${kind} wake on ${machine ?? "this computer"}`, async (t) => {
      const s = scene(t, machine, wake);
      const wakeLine = (text) => text.split("\n").find((line) => line.includes('"wake":'));
      const before = wakeLine(s.read());
      assert.ok(before);

      const edit = await open(s, "edit");
      edit.popup.inputs.role.type("new role", edit.cx);
      await edit.click("bot-save");
      assert.equal(edit.popup.error, null);
      assert.equal(JSON.parse(s.read()).bots[0].role, "new role");
      assert.equal(wakeLine(s.read()), before);

      const menu = await open(s, "menu");
      await menu.click("menu-prompt");
      menu.popup.prompt.type("new words\nline two", menu.cx);
      await menu.click("menu-prompt-save");
      assert.equal(menu.popup.error, null);
      assert.equal(JSON.parse(s.read()).bots[0].instructions, "new words\nline two");
      assert.equal(wakeLine(s.read()), before);
      if (machine) {
        assert.equal(state.hcCalls.filter((a) => a[0] === "file" && a[1] === "edit" && a.includes(machine)).length, 2);
        assert.equal(state.calls.filter((c) => c.kind === "write").length, 0);
      }
    });
  }
}
