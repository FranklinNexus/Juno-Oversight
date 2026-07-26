[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$RootPid
)

$ErrorActionPreference = "Stop"
$NativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class JunoNativeProcessTree
{
    private const uint SnapshotProcesses = 0x00000002;
    private const uint ProcessTerminate = 0x0001;
    private const uint Synchronize = 0x00100000;
    private const uint WaitObject0 = 0;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Executable;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static uint[] PostOrder(uint root)
    {
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == new IntPtr(-1))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (Process32FirstW(snapshot, ref entry))
            {
                do
                {
                    parents[entry.ProcessId] = entry.ParentProcessId;
                    entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                }
                while (Process32NextW(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }

        var ordered = new List<uint>();
        ordered.Add(root);
        for (int index = 0; index < ordered.Count; index++)
        {
            uint parent = ordered[index];
            foreach (var pair in parents)
            {
                if (pair.Value == parent && !ordered.Contains(pair.Key)) ordered.Add(pair.Key);
            }
        }
        ordered.Reverse();
        return ordered.ToArray();
    }

    public static bool TerminateAndWait(uint processId, uint timeoutMs)
    {
        IntPtr handle = OpenProcess(ProcessTerminate | Synchronize, false, processId);
        if (handle == IntPtr.Zero)
        {
            try
            {
                Process.GetProcessById((int)processId);
                return false;
            }
            catch (ArgumentException)
            {
                return true;
            }
        }
        try
        {
            if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != WaitObject0)
                return false;
            return WaitForSingleObject(handle, timeoutMs) == WaitObject0;
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
'@

Add-Type -TypeDefinition $NativeSource -Language CSharp
$OrderedPids = [JunoNativeProcessTree]::PostOrder([uint32]$RootPid)
if ($OrderedPids -contains [uint32]$PID) {
  throw "Refusing to terminate the process-tree helper itself"
}
foreach ($ProcessId in $OrderedPids) {
  if (-not [JunoNativeProcessTree]::TerminateAndWait($ProcessId, 3000)) {
    throw "Process-tree termination could not be confirmed for PID $ProcessId"
  }
}
