// Loaded only by the fake core's login environment. Keep ps off the host's process table.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const execFile = childProcess.execFile;
childProcess.execFile = function (program, args, opts, callback) {
  if (program !== "/bin/ps") return execFile(program, args, opts, callback);
  assert.deepEqual(args, ["-axww", "-o", "pid=", "-o", "ppid=", "-o", "stat=", "-o", "command="]);
  const token = JSON.parse(process.argv[1])[3];
  const rows = process.env.HC_FAKE_REPORT_PROCESSES.replaceAll("<token>", token);
  queueMicrotask(() => callback(null, rows, ""));
};
syncBuiltinESMExports();
