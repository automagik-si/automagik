// Preloaded only by the worker scene. Move hc's answer forward in virtual time, checking the
// actual timeout the CLI passed to execFile. Other calls and the real timeout tests use Node.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const execFile = childProcess.execFile;
childProcess.execFile = function (command, args, options, callback) {
  if (basename(command) === "hc" && args[0] === "run") {
    const elapsed = Number(process.env.HC_TEST_ANSWER_MS);
    if (!(elapsed > 0 && options.timeout > elapsed)) {
      throw new Error(`hc run deadline ${options.timeout} precedes the answer at ${elapsed} ms`);
    }
    writeFileSync(process.env.HC_TEST_CLOCK_FILE, String(elapsed));
  }
  return execFile.apply(this, arguments);
};
syncBuiltinESMExports();
