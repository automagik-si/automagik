import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { POINTER_VAR } from "../mods/am-sidebar/loginRecord.js";

/** Write the pointer first and the record last, in the layout ACP uses. */
export function loginFixture(root, vendor, generation = "11111111-1111-4111-8111-111111111111") {
  const current = join(root, "current");
  const dir = join(root, "homes", vendor, generation, `.${vendor}`);
  const pointer = join(current, vendor);
  const recordPath = join(current, "generation.json");
  mkdirSync(current, { recursive: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let record = { version: 1, sequence: 0, claude: null, codex: null };
  try { record = JSON.parse(readFileSync(recordPath, "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  record.sequence += 1;
  record[vendor] = { generation, [vendor === "claude" ? "configDir" : "home"]: dir };
  const text = JSON.stringify(record);
  writeFileSync(pointer, generation);
  writeFileSync(recordPath, text);
  return { dir, pointer, recordPath, text, env: { [POINTER_VAR]: pointer, AUTOMAGIK_NATIVE_WORKER_LOGIN: "", DSH_HOME: "" } };
}
