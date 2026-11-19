// An unavailable stand-in keeps form CLI checks away from every installed hc.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function noCoreEnv(root, path = process.env.PATH || "") {
  const bin = join(root, "no-core-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "hc"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HC_UNAVAILABLE_LOG"\necho "hc: not available" >&2\nexit 1\n');
  chmodSync(join(bin, "hc"), 0o755);
  return { PATH: `${bin}:${path}`, XDG_STATE_HOME: join(root, "state"), AUTOMAGIK_HERDR_CORE_SOCKET: join(root, "no-core.sock"),
    AUTOMAGIK_HERDR_TEST_ROOTS: root, HC_UNAVAILABLE_LOG: join(root, "hc-unavailable.log"),
    HC_SOCKET: "", HC_SESSION: "", HC_TERMINAL_SOCKET: "", XDG_RUNTIME_DIR: "" };
}
