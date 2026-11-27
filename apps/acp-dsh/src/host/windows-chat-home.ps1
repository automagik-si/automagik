$ErrorActionPreference = 'Stop'
try {
  $homePath = $env:AUTOMAGIK_CHAT_HOME_PROBE
  [Environment]::SetEnvironmentVariable('AUTOMAGIK_CHAT_HOME_PROBE', $null, 'Process')
  if ([string]::IsNullOrEmpty($homePath) -or ![IO.Path]::IsPathRooted($homePath)) { exit 125 }
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class AutomagikChatHomeProbe {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsWow64Process2(IntPtr process, out ushort machine, out ushort host);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr process, IntPtr address, [Out] byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int kind, [Out] byte[] buffer, int size, out int read);

  static byte[] Read(IntPtr process, long address, int length) {
    byte[] bytes = new byte[length];
    IntPtr read;
    if (address <= 0 || !ReadProcessMemory(process, new IntPtr(address), bytes, new IntPtr(length), out read)
        || read.ToInt64() != length) throw new IOException();
    return bytes;
  }

  static long Pointer(byte[] bytes, int offset, int width) {
    return width == 4 ? BitConverter.ToUInt32(bytes, offset) : BitConverter.ToInt64(bytes, offset);
  }

  static long Peb(IntPtr process, int width) {
    bool wow = width < IntPtr.Size;
    byte[] bytes = new byte[IntPtr.Size * (wow ? 1 : 6)];
    int read;
    if (NtQueryInformationProcess(process, wow ? 26 : 0, bytes, bytes.Length, out read) != 0) throw new IOException();
    return Pointer(bytes, wow ? 0 : IntPtr.Size, IntPtr.Size);
  }

  static bool Uses(string value, string home) {
    string path = value.Trim('"').Replace('/', '\\');
    if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path.Substring(8);
    else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
    return path.Equals(home, StringComparison.OrdinalIgnoreCase)
      || path.StartsWith(home + "\\", StringComparison.OrdinalIgnoreCase);
  }

  static bool EnvironmentUses(IntPtr process, long address, string home) {
    // Read one page at a time, bounded, and retain only the current string. No
    // environment values leave this helper.
    StringBuilder entry = new StringBuilder();
    for (int total = 0; total < 256 * 1024;) {
      int size = 4096 - (int)(address % 4096);
      byte[] page = Read(process, address, size);
      for (int i = 0; i < size; i += 2) {
        char c = (char)BitConverter.ToUInt16(page, i);
        if (c != '\0') { entry.Append(c); continue; }
        if (entry.Length == 0) return false;
        string text = entry.ToString();
        int equals = text.IndexOf('=', 1);
        if (equals > 0 && Uses(text.Substring(equals + 1), home)) return true;
        entry.Length = 0;
      }
      address += size;
      total += size;
    }
    throw new IOException();
  }

  static string PathValue(IntPtr process, byte[] parameters, int offset, int width) {
    int size = BitConverter.ToUInt16(parameters, offset);
    if (size == 0) return "";
    return Encoding.Unicode.GetString(Read(process, Pointer(parameters, offset + width, width), size));
  }

  static bool UsesHome(IntPtr process, string home) {
    ushort machine, host;
    if (!IsWow64Process2(process, out machine, out host)) throw new IOException();
    int width = machine == 0x014c || machine == 0x01c4 || IntPtr.Size == 4 ? 4 : 8;
    // RTL_USER_PROCESS_PARAMETERS layout for the target's pointer width.
    long peb = Peb(process, width);
    long slot = peb + (width == 4 ? 0x10 : 0x20);
    long address = Pointer(Read(process, slot, width), 0, width);
    byte[] parameters = Read(process, address, width == 4 ? 0x4c : 0x88);
    if (Uses(PathValue(process, parameters, width == 4 ? 0x24 : 0x38, width).TrimEnd('\\'), home)) return true;
    return EnvironmentUses(process, Pointer(parameters, width == 4 ? 0x48 : 0x80, width), home);
  }

  public static string Scan(string path) {
    string home = Path.GetFullPath(path).TrimEnd('\\');
    int self = Process.GetCurrentProcess().Id;
    int session = Process.GetCurrentProcess().SessionId;
    SecurityIdentifier user;
    using (WindowsIdentity identity = WindowsIdentity.GetCurrent()) user = identity.User;
    bool unknown = false;
    foreach (Process candidate in Process.GetProcesses()) using (candidate) {
      if (candidate.Id == self || candidate.Id <= 4) continue;
      try { if (session != 0 && candidate.SessionId == 0) continue; }
      catch (InvalidOperationException) { continue; } // Exited during enumeration.
      catch (Win32Exception) { if (!candidate.HasExited) unknown = true; continue; }
      IntPtr process = OpenProcess(0x00101000, false, candidate.Id); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
      // A protected system process is outside the app's normal same-user launch boundary.
      if (process == IntPtr.Zero) continue;
      try {
        IntPtr token;
        if (WaitForSingleObject(process, 0) == 0) continue;
        if (!OpenProcessToken(process, 8, out token)) { unknown = true; continue; }
        try {
          using (WindowsIdentity identity = new WindowsIdentity(token)) {
            if (!user.Equals(identity.User)) continue;
          }
        } finally { CloseHandle(token); }
        IntPtr memory = OpenProcess(0x0410, false, candidate.Id); // QUERY_INFORMATION | VM_READ
        try {
          if (memory == IntPtr.Zero) throw new IOException();
          if (UsesHome(memory, home)) return "in-use";
        } catch (IOException) {
          if (WaitForSingleObject(process, 0) != 0) unknown = true;
        } finally { if (memory != IntPtr.Zero) CloseHandle(memory); }
      } finally { CloseHandle(process); }
    }
    return unknown ? "unknown" : "unused";
  }
}
'@
  [Console]::WriteLine([AutomagikChatHomeProbe]::Scan($homePath))
  exit 0
} catch { exit 125 }
