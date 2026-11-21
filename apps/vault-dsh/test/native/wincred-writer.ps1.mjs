import { spawn } from 'node:child_process'
import { taskkill } from '../../src/windows-credential/run.js'
import { encodedArgs, windowsScript } from '../../src/windows-credential/script.js'

// This helper is only used by the disposable native CI job.
const writer = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeFixture {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool CredDeleteW(string target, uint type, uint flags);

  public static int Run() {
    var input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
    string[] fields = input.ReadToEnd().TrimEnd('\n').Split(' ');
    string target = Encoding.UTF8.GetString(Convert.FromBase64String(fields[1]));
    if (!target.StartsWith("automagik-ci-", StringComparison.Ordinal)) return 13;
    if (fields[0] == "D" && fields.Length == 2) {
      return CredDeleteW(target, 1, 0) || Marshal.GetLastWin32Error() == 1168 ? 0 : 13;
    }
    if (fields[0] != "W" || fields.Length != 5) return 13;
    var payload = Convert.FromBase64String(fields[4]);
    var blob = fields[3] == "text" ? Encoding.Unicode.GetBytes(new UTF8Encoding(false, true).GetString(payload)) : payload;
    var pointer = blob.Length == 0 ? IntPtr.Zero : Marshal.AllocHGlobal(blob.Length);
    try {
      if (blob.Length != 0) Marshal.Copy(blob, 0, pointer, blob.Length);
      var entry = new Credential {
        Type = 1, Persist = 2, TargetName = target,
        UserName = Encoding.UTF8.GetString(Convert.FromBase64String(fields[2])),
        CredentialBlob = pointer, CredentialBlobSize = (uint)blob.Length
      };
      return CredWriteW(ref entry, 0) ? 0 : 13;
    } finally {
      for (int i = 0; i < blob.Length; i++) Marshal.WriteByte(pointer, i, 0);
      if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
      Array.Clear(blob, 0, blob.Length);
    }
  }
}
`

export const writerArgs = encodedArgs(windowsScript(writer, '[NativeFixture]::Run()'))

const deadlineMs = 30_000

// All fixture commands have bounded I/O. A writer must be known to have exited
// before cleanup can verify that its target is absent.
export function invokeFixture(file, args, {
  cwd, env, stdin, split = false, spawnChild = spawn, timers = globalThis,
} = {}) {
  return new Promise(resolve => {
    const child = spawnChild(file, args, { cwd, env, windowsHide: true, stdio: 'pipe' })
    const stdout = [], stderr = []
    let timedOut = false
    let killDeadline, killer
    let exited = false
    const finish = (code, error = false) => {
      timers.clearTimeout(deadline)
      timers.clearTimeout(killDeadline)
      resolve({
        code: timedOut || error ? undefined : code, exited: exited || !child.pid,
        pid: child.pid, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
      })
    }
    const deadline = timers.setTimeout(() => {
      timedOut = true
      if (!exited && child.pid && child.exitCode == null && child.signalCode == null) {
        try {
          killer = spawnChild(taskkill, ['/T', '/F', '/PID', String(child.pid)], { cwd, env, windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => {})
        } catch {}
      }
      killDeadline = timers.setTimeout(() => {
        try { if (killer?.exitCode === null && killer.signalCode === null) killer.kill() } catch {}
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(undefined, true)
      }, 5000)
    }, deadlineMs)
    child.stdout.on('data', bytes => stdout.push(bytes))
    child.stderr.on('data', bytes => stderr.push(bytes))
    child.stdin.on('error', () => {})
    child.once('error', () => finish(undefined, true))
    child.once('exit', () => { exited = true })
    child.once('close', code => {
      try { if (timedOut && killer?.exitCode === null && killer.signalCode === null) killer.kill() } catch {}
      finish(code)
    })
    if (split) {
      child.stdin.write(stdin.subarray(0, 2))
      setImmediate(() => child.stdin.end(stdin.subarray(2)))
    } else child.stdin.end(stdin)
  })
}

export async function cleanupTargets(targets, { remove, absent }) {
  let clean = true
  for (const [target, exited] of targets) {
    const removed = await Promise.resolve().then(() => remove(target)).catch(() => false)
    // An unconfirmed writer could create this target after a successful absence check.
    const gone = exited && await Promise.resolve().then(() => absent(target)).catch(() => false)
    clean = removed && gone && clean
  }
  return clean
}
