param([string]$Mode, [string]$Id)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class HoldLoginJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  public static void Run(string mode, string id) {
    string name = "Global\\automagik-login-" + id;
    IntPtr job = mode == "create" ? CreateJobObject(IntPtr.Zero, name)
      : OpenJobObject(0x0004, false, name);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Console.WriteLine("held");
      Console.In.ReadToEnd();
    } finally { CloseHandle(job); }
  }
}
'@
[HoldLoginJob]::Run($Mode, $Id)
