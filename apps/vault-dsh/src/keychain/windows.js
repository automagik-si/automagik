import { win32 } from 'node:path'

// The script is constant. Credential data enters only through the redirected pipe.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

public static class AutomagikCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
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
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);

  private const uint Generic = 1;
  private const uint LocalMachine = 2;
  private const int MaxBlob = 2560;

  private static int FixedError() {
    switch (Marshal.GetLastWin32Error()) {
      case 1168: return 10; // ERROR_NOT_FOUND
      case 1312: return 11; // ERROR_NO_SUCH_LOGON_SESSION
      case 5: return 12; // ERROR_ACCESS_DENIED
      default: return 13;
    }
  }

  private static int Store(string id, byte[] blob) {
    if (blob.Length == 0 || blob.Length > MaxBlob) return 13;
    var pointer = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, pointer, blob.Length);
      var entry = new Credential {
        Type = Generic, Persist = LocalMachine, TargetName = id,
        CredentialBlob = pointer, CredentialBlobSize = (uint)blob.Length
      };
      return CredWriteW(ref entry, 0) ? 0 : FixedError();
    } finally {
      for (int i = 0; i < blob.Length; i++) Marshal.WriteByte(pointer, i, 0);
      Marshal.FreeHGlobal(pointer);
    }
  }

  private static int Read(string id, bool presenceOnly) {
    IntPtr pointer;
    if (!CredReadW(id, Generic, 0, out pointer)) return FixedError();
    try {
      if (presenceOnly) return 0;
      var entry = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (entry.CredentialBlobSize == 0 || entry.CredentialBlobSize > MaxBlob) return 13;
      var bytes = new byte[entry.CredentialBlobSize];
      Marshal.Copy(entry.CredentialBlob, bytes, 0, bytes.Length);
      Console.Out.Write(Encoding.ASCII.GetString(bytes));
      return 0;
    } finally { CredFree(pointer); }
  }

  private static int Delete(string id) {
    return CredDeleteW(id, Generic, 0) ? 0 : FixedError();
  }

  public static int Run() {
    var input = new char[4097];
    int count = Console.In.ReadBlock(input, 0, input.Length);
    if (count == input.Length) return 13;
    string[] request = new string(input, 0, count).Split('\n');
    if (request.Length != 3 || !Regex.IsMatch(request[1], @"\Aautomagik-vault:v1:[a-f0-9]{32}\z")) return 13;
    switch (request[0]) {
      case "store":
        if (!Regex.IsMatch(request[2], @"\A[A-Za-z0-9+/]+={0,2}\z")) return 13;
        return Store(request[1], Encoding.ASCII.GetBytes(request[2]));
      case "lookup": return request[2].Length == 0 ? Read(request[1], false) : 13;
      case "exists": return request[2].Length == 0 ? Read(request[1], true) : 13;
      case "clear": return request[2].Length == 0 ? Delete(request[1]) : 13;
      default: return 13;
    }
  }
}
'@
  exit ([AutomagikCredential]::Run())
} catch { exit 13 }
`
const encoded = Buffer.from(script, 'utf16le').toString('base64')

export const WINDOWS_BLOB_BYTES = 2560

export function resolvePowerShell({ env, exists }) {
  const root = Object.entries(env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1]
  if (root && win32.isAbsolute(root)) {
    const file = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(file)) return { file, prefix: [] }
  }
}

export function windowsCommand(operation, id, blob) {
  return {
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    stdin: [operation, id, blob ?? ''].join('\n'),
  }
}
