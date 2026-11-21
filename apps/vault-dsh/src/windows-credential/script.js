// Test harnesses compile this same source. The production script only reads generic credentials.
export const readerSource = String.raw`
using System;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class AutomagikWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  internal struct Credential {
    public uint Flags, Type;
    public string TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);

  private const uint Generic = 1;
  private const int MaxBlob = 2560;
  private const int MaxRequest = 2048;
  private static readonly Encoding Utf8 = new UTF8Encoding(false, true);

  internal static bool ValidTarget(string target) {
    return target != null && target.Length >= 4 && target.Length <= 256 && target.IndexOf('*') < 0 &&
      !target.StartsWith("automagik-vault:", StringComparison.OrdinalIgnoreCase) && SafeText(target);
  }

  private static bool SafeText(string text) {
    for (int i = 0; i < text.Length; i++) {
      if (Char.IsSurrogate(text[i]) && !Char.IsSurrogatePair(text, i)) return false;
      var cat = CharUnicodeInfo.GetUnicodeCategory(text, i);
      if (cat == UnicodeCategory.Control || cat == UnicodeCategory.Format ||
          cat == UnicodeCategory.LineSeparator || cat == UnicodeCategory.ParagraphSeparator) return false;
      if (Char.IsHighSurrogate(text[i])) i++;
    }
    return true;
  }

  private static int FixedError(int error) {
    switch (error) {
      case 1168: return 10;
      case 1312: return 11;
      case 5: return 12;
      default: return 13;
    }
  }

  private static void Frame(Stream output, string prefix, byte[] bytes) {
    byte[] frame = Encoding.ASCII.GetBytes(prefix + Convert.ToBase64String(bytes) + "\n");
    try { output.Write(frame, 0, frame.Length); }
    finally { Array.Clear(frame, 0, frame.Length); }
  }

  internal static int Record(Credential entry, string target, bool meta, Stream output,
      Action<IntPtr, byte[], int, int> copy) {
    if (entry.Type != Generic || entry.Flags != 0 || entry.Persist < 1 || entry.Persist > 3 ||
        !ValidTarget(entry.TargetName) || !String.Equals(entry.TargetName, target, StringComparison.OrdinalIgnoreCase) ||
        entry.CredentialBlobSize > MaxBlob ||
        (entry.CredentialBlobSize != 0 && entry.CredentialBlob == IntPtr.Zero)) return 13;
    if (meta) {
      string name = entry.UserName ?? "";
      byte[] userName = SafeText(name) && Utf8.GetByteCount(name) <= MaxBlob ? Utf8.GetBytes(name) : new byte[0];
      Frame(output, "M ", userName);
    } else if (entry.CredentialBlobSize == 0) {
      output.WriteByte((byte)'Z');
      output.WriteByte(10);
    } else {
      byte[] bytes = new byte[entry.CredentialBlobSize];
      try {
        copy(entry.CredentialBlob, bytes, 0, bytes.Length);
        Frame(output, "V ", bytes);
      } finally { Array.Clear(bytes, 0, bytes.Length); }
    }
    return 0;
  }

  private static int Read(string target, bool meta, Stream output) {
    IntPtr pointer;
    if (!CredReadW(target, Generic, 0, out pointer)) return FixedError(Marshal.GetLastWin32Error());
    if (pointer == IntPtr.Zero) return 13;
    try {
      var entry = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      return Record(entry, target, meta, output, Marshal.Copy);
    } finally { CredFree(pointer); }
  }

  internal static bool Request(Stream input, out string op, out string target) {
    op = target = null;
    byte[] bytes = new byte[MaxRequest + 1];
    int size = 0;
    while (size < bytes.Length) {
      int count = input.Read(bytes, size, bytes.Length - size);
      if (count == 0) break;
      size += count;
    }
    if (size == 0 || size > MaxRequest || bytes[size - 1] != 10) return false;
    for (int i = 0; i < size - 1; i++) if (bytes[i] < 32 || bytes[i] > 126) return false;
    string frame = Encoding.ASCII.GetString(bytes, 0, size - 1);
    int space = frame.IndexOf(' ');
    if (space < 0) return false;
    op = frame.Substring(0, space);
    string b64 = frame.Substring(space + 1);
    if (op == "probe") return b64 == "";
    if (op != "meta" && op != "read") return false;
    try {
      byte[] decoded = Convert.FromBase64String(b64);
      if (Convert.ToBase64String(decoded) != b64) return false;
      target = Utf8.GetString(decoded);
      return ValidTarget(target);
    } catch (FormatException) { return false; }
      catch (DecoderFallbackException) { return false; }
  }

  public static int Run() {
    string op, target;
    if (!Request(Console.OpenStandardInput(), out op, out target)) return 13;
    return op == "probe" ? 0 : Read(target, op == "meta", Console.OpenStandardOutput());
  }
}
`

export function encodedArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

export function windowsScript(source, invocation) {
  return `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
  if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
      $PSVersionTable.PSVersion.Minor -ne 1 -or -not [Environment]::Is64BitProcess) { exit 14 }
  Add-Type -TypeDefinition @'
${source}
'@
} catch { exit 14 }
try {
  # Windows PowerShell populates these variables at startup.
  $env:PSModulePath = $null
  $env:PATHEXT = $null
  exit (${invocation})
} catch { exit 13 }
`
}

export const readerArgs = Object.freeze(encodedArgs(windowsScript(readerSource, '[AutomagikWinCred]::Run()')))
