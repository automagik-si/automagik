// Test-only command entry: a scratch scene supplies forbidden roots as an options object.
// The installed CLI accepts no flag or environment switch to bypass its root checks.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { assertScratchProject } from "./scratch-project.mjs";

const root = process.cwd();
assertScratchProject(join(root, "proj"), { ceiling: root });
const forbiddenRoots = [
  ["the project", join(root, "proj")],
  ["the app home", join(root, "app")],
  ["the temp folder", join(root, "pane-tmp")],
  ["the runtime folder", join(root, "run")],
];
const marker = process.env.AM_TEST_LINK_MARKER;
const repairCliLinks = marker ? () => writeFileSync(marker, "") : undefined;
const approvedWriteOptions = process.env.AM_TEST_APPROVAL_RENAME_FAIL === "1" ? {
  rename() { throw new Error("injected approval rename failure"); },
} : undefined;
process.exitCode = await main(process.argv.slice(2), { forbiddenRoots, repairCliLinks, approvedWriteOptions });
