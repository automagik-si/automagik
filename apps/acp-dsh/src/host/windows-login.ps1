# Own the vendor's full Windows process tree, including children of an exited .cmd wrapper.
# Job children cannot break away. An abnormal supervisor exit closes the kill-on-close job.
# Normal stop proves ActiveProcesses=0 before acknowledging it to the parent.
$ErrorActionPreference = 'Stop'
$phase = 'load-system-commands'
try {
  # These commands must not depend on a terminal's PSModulePath or user-installed modules.
  Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
  $phase = 'read-request'
  $json = $env:AUTOMAGIK_LOGIN_JOB
  [Environment]::SetEnvironmentVariable('AUTOMAGIK_LOGIN_JOB', $null, 'Process')
  $request = ConvertFrom-Json -InputObject $json
  if ($request.launch -isnot [string] -or
      $request.launch -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z' -or
      $request.job -cne ('Global\automagik-login-' + $request.launch) -or
      ($request.app -isnot [int] -and $request.app -isnot [long]) -or $request.app -le 1 -or
      ($null -ne $request.appStart -and ($request.appStart -isnot [string] -or
        $request.appStart -cnotmatch '\A[1-9][0-9]{0,18}\z'))) { throw 'Invalid login request.' }
  $phase = 'write-identity'
  $culture = [Globalization.CultureInfo]::InvariantCulture
  $start = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString($culture)
  $identity = '{"pid":' + $PID.ToString($culture) + ',"start":"' + $start + '","launch":"' + $request.launch + '"}'
  [IO.File]::WriteAllText($request.identity + '.tmp', $identity)
  [IO.File]::Move($request.identity + '.tmp', $request.identity)
  $phase = 'compile-supervisor'
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AutomagikLoginJob {
  public static string Phase;
  const int MemberLimit = 64;
  const uint QueryProcess = 0x1000;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Startup {
    public uint cb;
    public string reserved, desktop, title;
    public uint x, y, width, height, charsX, charsY, fill, flags;
    public ushort show, reservedSize;
    public IntPtr reservedPointer, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct StartupEx { public Startup startup; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public long processTime, jobTime;
    public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet;
    public uint activeLimit;
    public UIntPtr affinity;
    public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong reads, writes, other, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public Limits basic;
    public IoCounters io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting {
    public long userTime, kernelTime, periodUserTime, periodKernelTime;
    public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind,
    ref ExtendedLimits info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind,
    out Accounting info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind,
    IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcess(string executable, StringBuilder command,
    IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags,
    IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll")]
  static extern void SetLastError(uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited,
    out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags,
    ref IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
    IntPtr value, IntPtr length, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool MoveFileEx(string source, string destination, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  static void Check(bool ok) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  static IntPtr Standard(int kind) {
    IntPtr handle = GetStdHandle(kind);
    if (handle == IntPtr.Zero || handle == new IntPtr(-1)) {
      throw new InvalidOperationException("Missing login pipe.");
    }
    Check(SetHandleInformation(handle, 1, 1));
    return handle;
  }

  static long CreationTicks(IntPtr handle) {
    long created, exited, kernel, user;
    return GetProcessTimes(handle, out created, out exited, out kernel, out user)
      ? DateTime.FromFileTime(created).ToUniversalTime().Ticks : 0;
  }
  static string Ticks(long ticks) {
    return ticks == 0 ? null : ticks.ToString(CultureInfo.InvariantCulture);
  }
  static bool AppGone(IntPtr app) {
    return WaitForSingleObject(app, 0) != 258; // WAIT_TIMEOUT means the app is still running.
  }
  static Accounting GetAccounting(IntPtr job) {
    Accounting info;
    Check(QueryInformationJobObject(job, 1, out info,
      (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return info;
  }
  static void PublishMembers(string path, string launch, Dictionary<uint, string> members) {
    StringBuilder json = new StringBuilder("{\"launch\":\"").Append(launch).Append('"');
    if (members == null) json.Append(",\"overflow\":true");
    else {
      json.Append(",\"processes\":[");
      bool first = true;
      foreach (KeyValuePair<uint, string> member in members) {
        if (!first) json.Append(',');
        first = false;
        json.Append("{\"pid\":").Append(member.Key.ToString(CultureInfo.InvariantCulture))
          .Append(",\"start\":").Append(member.Value == null ? "null" : "\"" + member.Value + "\"")
          .Append('}');
      }
      json.Append(']');
    }
    File.WriteAllText(path + ".tmp", json.Append('}').ToString());
    Check(MoveFileEx(path + ".tmp", path, 0x9)); // REPLACE_EXISTING | WRITE_THROUGH
  }
  static Dictionary<uint, string> ReadMembers(IntPtr job, IntPtr buffer,
    Dictionary<uint, string> previous) {
    uint size = (uint)(8 + MemberLimit * IntPtr.Size);
    if (!QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 234) return null; // ERROR_MORE_DATA
      throw new Win32Exception(error);
    }
    int assigned = Marshal.ReadInt32(buffer);
    int count = Marshal.ReadInt32(buffer, 4);
    if (assigned > MemberLimit || count > MemberLimit) return null;
    if (count < 0 || count != assigned) throw new InvalidOperationException();
    Dictionary<uint, string> members = new Dictionary<uint, string>();
    for (int i = 0; i < count; i++) {
      uint pid = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
      string start;
      if (!previous.TryGetValue(pid, out start)) {
        IntPtr handle = OpenProcess(QueryProcess, false, pid);
        if (handle == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() == 87) continue; // Exited since the list was read.
        } else {
          try { start = Ticks(CreationTicks(handle)); } finally { CloseHandle(handle); }
        }
      }
      members.Add(pid, start);
    }
    return members;
  }

  public static int Run(string executable, string command, string directory,
    string stop, string done, string nonce, string launch, string name, uint parent,
    string parentStart, string membersFile) {
    IntPtr app = IntPtr.Zero, job = IntPtr.Zero, attributes = IntPtr.Zero;
    IntPtr jobSlot = IntPtr.Zero, memberBuffer = IntPtr.Zero;
    bool initialized = false;
    ProcessInfo process = new ProcessInfo();
    bool assigned = false;
    try {
      // A cancellation during PowerShell startup must never start a vendor process.
      Phase = "stop";
      if (File.Exists(stop)) { File.WriteAllText(done, nonce); return 130; }
      Phase = "open-app";
      app = OpenProcess(0x00100000 | QueryProcess, false, parent);
      if (app == IntPtr.Zero) return 131;
      long appTicks = CreationTicks(app), selfTicks = CreationTicks(GetCurrentProcess());
      // With no recorded birth, wall-clock ordering is a plausibility check for a
      // best-effort parent watch. Reclaim always needs separate proof the supervisor died.
      if (appTicks == 0 || selfTicks == 0 || appTicks >= selfTicks || AppGone(app)
        || (!String.IsNullOrEmpty(parentStart) && Ticks(appTicks) != parentStart)) return 131;

      Phase = "create-job";
      SetLastError(0);
      job = CreateJobObject(IntPtr.Zero, name);
      int createError = Marshal.GetLastWin32Error();
      if (job == IntPtr.Zero) throw new Win32Exception(createError);
      if (createError == 183) {
        Phase = "job-exists";
        throw new Win32Exception(createError);
      }
      ExtendedLimits limits = new ExtendedLimits();
      limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits,
        (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      if (GetAccounting(job).totalProcesses != 0) {
        Phase = "job-exists";
        throw new InvalidOperationException();
      }
      if (AppGone(app)) return 131;

      Phase = "job-list";
      IntPtr length = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref length);
      attributes = Marshal.AllocHGlobal(length);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref length));
      initialized = true;
      jobSlot = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobSlot, job);
      Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x0002000D, jobSlot,
        (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)); // PROC_THREAD_ATTRIBUTE_JOB_LIST
      StartupEx startup = new StartupEx();
      startup.attributes = attributes;
      startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.startup.flags = 0x100; // STARTF_USESTDHANDLES
      startup.startup.input = Standard(-10);
      startup.startup.output = Standard(-11);
      startup.startup.error = Standard(-12);
      // Admit the vendor to the Job at creation and keep it suspended until publication.
      Phase = "create-vendor";
      Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero,
        IntPtr.Zero, true, 0x08080004, IntPtr.Zero, String.IsNullOrEmpty(directory) ? null : directory,
        ref startup, out process));
      bool member;
      Check(IsProcessInJob(process.process, job, out member));
      if (!member) throw new InvalidOperationException();
      assigned = true;
      Phase = "write-members";
      string vendorStart = Ticks(CreationTicks(process.process));
      if (vendorStart == null) throw new InvalidOperationException();
      var members = new Dictionary<uint, string> { { process.pid, vendorStart } };
      PublishMembers(membersFile, launch, members);
      memberBuffer = Marshal.AllocHGlobal(8 + MemberLimit * IntPtr.Size);

      Phase = "resume-vendor";
      bool ending = false;
      bool stopped = false;
      bool orphaned = false;
      if (AppGone(app)) {
        Check(TerminateJobObject(job, 131));
        orphaned = ending = true;
      } else if (File.Exists(stop)) {
        Check(TerminateJobObject(job, 130));
        stopped = ending = true;
      } else Check(ResumeThread(process.thread) != UInt32.MaxValue);
      while (true) {
        Phase = "watch-app";
        if (!orphaned && AppGone(app)) {
          Check(TerminateJobObject(job, 131));
          orphaned = ending = true;
        }
        Phase = "stop";
        if (!ending && File.Exists(stop)) {
          Check(TerminateJobObject(job, 130));
          stopped = ending = true;
        }
        Phase = "write-members";
        if (members != null) {
          var current = ReadMembers(job, memberBuffer, members);
          if (current == null || current.Count != members.Count
            || !new HashSet<uint>(members.Keys).SetEquals(current.Keys)) {
            PublishMembers(membersFile, launch, current);
            members = current;
          }
        }
        Phase = "query-job";
        if (GetAccounting(job).activeProcesses == 0) break;
        Thread.Sleep(20);
      }
      if (orphaned) return 131;
      Phase = "write-done";
      uint code;
      Check(GetExitCodeProcess(process.process, out code));
      // This acknowledgement is produced only after the entire job is empty.
      File.WriteAllText(done, nonce);
      return stopped ? 130 : (int)code;
    } finally {
      // An assignment failure leaves a suspended process; it must never be resumed/leaked.
      if (!assigned && process.process != IntPtr.Zero) TerminateProcess(process.process, 125);
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (app != IntPtr.Zero) CloseHandle(app);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobSlot != IntPtr.Zero) Marshal.FreeHGlobal(jobSlot);
      if (memberBuffer != IntPtr.Zero) Marshal.FreeHGlobal(memberBuffer);
    }
  }
}
'@
  [Environment]::SetEnvironmentVariable('PSModulePath', $request.modulePath, 'Process')
  $phase = 'own-login-job'
  $code = [AutomagikLoginJob]::Run($request.executable, $request.line, $request.cwd,
    $request.stop, $request.done, $request.nonce, $request.launch, $request.job,
    $request.app, $request.appStart, $request.members)
  exit $code
} catch {
  # Never expose paths, command output or vendor account information as diagnostics.
  if (('AutomagikLoginJob' -as [type]) -and [AutomagikLoginJob]::Phase) {
    $phase = [AutomagikLoginJob]::Phase
  }
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $failure = '{0}: {1} (HRESULT {2})' -f $phase, $exception.GetType().FullName,
    $exception.HResult
  [Console]::Error.WriteLine("The login process could not start safely. $failure")
  exit 125
}
