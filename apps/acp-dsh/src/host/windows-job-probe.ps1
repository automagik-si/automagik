$ErrorActionPreference = 'Stop'
try {
  $json = $env:AUTOMAGIK_LOGIN_PROBE
  [Environment]::SetEnvironmentVariable('AUTOMAGIK_LOGIN_PROBE', $null, 'Process')
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
  $request = ConvertFrom-Json -InputObject $json
  if ($request.job -isnot [string] -or
      $request.job -cnotmatch '\AGlobal\\automagik-login-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z' -or
      $request.processes -isnot [array] -or $request.processes.Length -gt 66) { exit 125 }
  $pids = [uint32[]]::new($request.processes.Length)
  $starts = [string[]]::new($request.processes.Length)
  for ($i = 0; $i -lt $request.processes.Length; $i++) {
    $entry = $request.processes[$i]
    if (($entry.pid -isnot [int] -and $entry.pid -isnot [long]) -or $entry.pid -le 1 -or
        ($null -ne $entry.start -and
          ($entry.start -isnot [string] -or $entry.start -cnotmatch '\A[1-9][0-9]{0,18}\z'))) {
      exit 125
    }
    $pids[$i] = [uint32]$entry.pid
    $starts[$i] = $entry.start
  }
  Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class AutomagikLoginProbe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited,
    out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  static string ProcessState(uint pid, string start) {
    IntPtr handle = OpenProcess(0x00101000, false, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "dead" : "unknown";
    try {
      uint wait = WaitForSingleObject(handle, 0);
      if (wait == 0) return "dead";
      long created, exited, kernel, user;
      if (wait != 258 || String.IsNullOrEmpty(start)
          || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) return "unknown";
      string actual = DateTime.FromFileTime(created).ToUniversalTime().Ticks
        .ToString(CultureInfo.InvariantCulture);
      return actual == start ? "live" : "dead";
    } finally { CloseHandle(handle); }
  }

  public static string Read(string name, uint[] pids, string[] starts) {
    StringBuilder json = new StringBuilder("{\"processes\":[");
    for (int i = 0; i < pids.Length; i++) {
      if (i > 0) json.Append(',');
      json.Append('"').Append(ProcessState(pids[i], starts[i])).Append('"');
    }
    IntPtr job = OpenJobObjectW(0x0004, false, name); // JOB_OBJECT_QUERY
    int code = Marshal.GetLastWin32Error();
    if (job != IntPtr.Zero) { CloseHandle(job); code = 0; }
    string state = code == 0 && job != IntPtr.Zero ? "present" : code == 2 ? "absent" : "unknown";
    return json.Append("],\"job\":\"").Append(state).Append("\",\"code\":")
      .Append(code.ToString(CultureInfo.InvariantCulture)).Append('}').ToString();
  }
}
'@
  [Console]::WriteLine([AutomagikLoginProbe]::Read($request.job, $pids, $starts))
  exit 0
} catch { exit 125 }
