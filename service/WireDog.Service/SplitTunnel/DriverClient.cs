using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using WireDog.Service.Native;

namespace WireDog.Service.SplitTunnel;

// -------------------------------------------------------
// Structs matching driver's common.h definitions
// -------------------------------------------------------

/// <summary>
/// User-mode client for communicating with the WireDog Split Tunnel callout driver
/// via DeviceIoControl (IOCTLs). Sends binary structs matching the driver's C definitions.
/// </summary>
public class DriverClient : IDisposable
{
    private readonly ILogger<DriverClient> _logger;
    private const string DevicePath = @"\\.\WireDogSplitTunnel";

    // Must match driver common.h
    private const int MAX_APPS = 64;
    private const int MAX_APP_PATH = 520;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StAppEntry
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MAX_APP_PATH)]
        public string Path;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StConfiguration
    {
        public uint Mode;
        public uint AppCount;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = MAX_APPS)]
        public StAppEntry[] Apps;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StIpAddresses
    {
        public uint TunnelIpV4;
        public uint PhysicalIpV4;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] TunnelIpV6;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        public byte[] PhysicalIpV6;
        [MarshalAs(UnmanagedType.U1)]
        public bool HasV6;
        public uint PhysicalInterfaceIndex;
        public uint TunnelInterfaceIndex;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StState
    {
        [MarshalAs(UnmanagedType.U1)]
        public bool Initialized;
        public uint Mode;
        public uint AppCount;
        public uint ActiveFilterCount;
        public uint ClassifyCallCount;
        public uint ClassifyMatchCount;
        public uint RedirectSuccessCount;
        public uint RedirectErrorCount;
        public uint ClassifyCallCountV6;
        public uint ClassifyMatchCountV6;
        public uint RedirectSuccessCountV6;
        public uint RedirectErrorCountV6;
    }
    private IntPtr _deviceHandle = IntPtr.Zero;
    private bool _disposed;

    // IOCTL codes — must match driver common.h
    private const uint FILE_DEVICE_UNKNOWN = 0x00000022;
    private const uint METHOD_BUFFERED = 0;
    private const uint FILE_ANY_ACCESS = 0;

    private static uint CTL_CODE(uint deviceType, uint function, uint method, uint access)
        => (deviceType << 16) | (access << 14) | (function << 2) | method;

    public static readonly uint IOCTL_ST_INITIALIZE = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x800, METHOD_BUFFERED, FILE_ANY_ACCESS);
    public static readonly uint IOCTL_ST_SET_CONFIGURATION = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS);
    public static readonly uint IOCTL_ST_REGISTER_IP_ADDRESSES = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS);
    public static readonly uint IOCTL_ST_GET_STATE = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS);
    public static readonly uint IOCTL_ST_CLEAR_CONFIGURATION = CTL_CODE(FILE_DEVICE_UNKNOWN, 0x804, METHOD_BUFFERED, FILE_ANY_ACCESS);

    // Split tunnel modes (must match driver)
    public const uint ST_MODE_EXCLUDE = 0;
    public const uint ST_MODE_INCLUDE = 1;

    // Win32
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(
        IntPtr hDevice, uint dwIoControlCode,
        byte[]? lpInBuffer, uint nInBufferSize,
        byte[]? lpOutBuffer, uint nOutBufferSize,
        out uint lpBytesReturned, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint QueryDosDeviceW(string lpDeviceName, StringBuilder lpTargetPath, uint ucchMax);

    public DriverClient(ILogger<DriverClient> logger)
    {
        _logger = logger;
    }

    public bool IsConnected => _deviceHandle != IntPtr.Zero && _deviceHandle != INVALID_HANDLE_VALUE;

    public bool Connect()
    {
        if (IsConnected) return true;

        // Start the kernel driver service if it isn't running yet.
        // The driver is installed as demand-start, so SCM won't start it automatically.
        if (!EnsureDriverStarted())
        {
            _logger.LogError("[DriverClient] Failed to start WireDogSplitTunnel driver service");
            return false;
        }

        _deviceHandle = CreateFileW(
            DevicePath,
            GENERIC_READ | GENERIC_WRITE,
            0, IntPtr.Zero, OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);

        if (_deviceHandle == INVALID_HANDLE_VALUE)
        {
            var error = Marshal.GetLastWin32Error();
            _logger.LogWarning("[DriverClient] Failed to open device {Path}, error={Error}", DevicePath, error);
            _deviceHandle = IntPtr.Zero;
            return false;
        }

        _logger.LogInformation("[DriverClient] Connected to driver at {Path}", DevicePath);
        return true;
    }

    private bool EnsureDriverStarted()
    {
        const string driverServiceName = "WireDogSplitTunnel";

        var scm = ServiceControlManager.OpenSCManager(null, null,
            ServiceControlManager.ScmAccessRights.Connect);
        if (scm == IntPtr.Zero)
        {
            _logger.LogWarning("[DriverClient] Cannot open SCM (error={Error})", Marshal.GetLastWin32Error());
            return false;
        }

        try
        {
            var svc = ServiceControlManager.OpenService(scm, driverServiceName,
                ServiceControlManager.ServiceAccessRights.QueryStatus |
                ServiceControlManager.ServiceAccessRights.Start);
            if (svc == IntPtr.Zero)
            {
                _logger.LogWarning("[DriverClient] Driver service '{Name}' not found (error={Error}). Is it installed?",
                    driverServiceName, Marshal.GetLastWin32Error());
                return false;
            }

            try
            {
                var status = new ServiceControlManager.ServiceStatus();
                ServiceControlManager.QueryServiceStatus(svc, status);

                if (status.dwCurrentState == ServiceControlManager.ServiceState.Running)
                {
                    _logger.LogInformation("[DriverClient] Driver service already running");
                    return true;
                }

                _logger.LogInformation("[DriverClient] Starting driver service (current state={State})...",
                    status.dwCurrentState);

                if (!ServiceControlManager.StartService(svc, 0, null))
                {
                    var error = Marshal.GetLastWin32Error();
                    // ERROR_SERVICE_ALREADY_RUNNING (1056) is fine
                    if (error != 1056)
                    {
                        _logger.LogWarning("[DriverClient] StartService failed (error={Error}). Test signing enabled?", error);
                        return false;
                    }
                }

                // Wait up to 3 seconds for the driver to reach Running state
                for (int i = 0; i < 15; i++)
                {
                    Thread.Sleep(200);
                    ServiceControlManager.QueryServiceStatus(svc, status);
                    if (status.dwCurrentState == ServiceControlManager.ServiceState.Running)
                    {
                        _logger.LogInformation("[DriverClient] Driver service started successfully");
                        return true;
                    }
                }

                _logger.LogWarning("[DriverClient] Driver service did not reach Running state in time (state={State})",
                    status.dwCurrentState);
                return false;
            }
            finally
            {
                ServiceControlManager.CloseServiceHandle(svc);
            }
        }
        finally
        {
            ServiceControlManager.CloseServiceHandle(scm);
        }
    }

    public void Disconnect()
    {
        if (_deviceHandle != IntPtr.Zero && _deviceHandle != INVALID_HANDLE_VALUE)
        {
            CloseHandle(_deviceHandle);
            _logger.LogInformation("[DriverClient] Disconnected from driver");
        }
        _deviceHandle = IntPtr.Zero;
    }

    public bool Initialize()
    {
        return SendIoctl(IOCTL_ST_INITIALIZE, null, out _);
    }

    /// <summary>
    /// Send app configuration to the driver as a binary ST_CONFIGURATION struct.
    /// </summary>
    public bool SetConfiguration(string mode, List<string> appPaths)
    {
        var config = new StConfiguration
        {
            Mode = mode == "include" ? ST_MODE_INCLUDE : ST_MODE_EXCLUDE,
            AppCount = (uint)Math.Min(appPaths.Count, MAX_APPS),
            Apps = new StAppEntry[MAX_APPS]
        };

        for (int i = 0; i < config.AppCount; i++)
        {
            config.Apps[i].Path = ConvertToNtPath(appPaths[i]);
        }
        // Zero-init remaining entries
        for (int i = (int)config.AppCount; i < MAX_APPS; i++)
        {
            config.Apps[i].Path = string.Empty;
        }

        var buffer = StructToBytes(config);
        return SendIoctl(IOCTL_ST_SET_CONFIGURATION, buffer, out _);
    }

    /// <summary>
    /// Register tunnel and physical adapter IP addresses with the driver.
    /// </summary>
    public bool RegisterIpAddresses(string tunnelIp, string physicalAdapterIp, string? physicalAdapterIpV6 = null, uint physicalInterfaceIndex = 0, uint tunnelInterfaceIndex = 0)
    {
        var ips = new StIpAddresses
        {
            TunnelIpV6 = new byte[16],
            PhysicalIpV6 = new byte[16],
            HasV6 = false,
            PhysicalInterfaceIndex = physicalInterfaceIndex,
            TunnelInterfaceIndex = tunnelInterfaceIndex
        };

        // Parse IPv4 addresses to network byte order
        if (IPAddress.TryParse(tunnelIp, out var tunnelAddr) && tunnelAddr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var bytes = tunnelAddr.GetAddressBytes();
            ips.TunnelIpV4 = BitConverter.ToUInt32(bytes, 0); // Already network byte order
        }

        if (IPAddress.TryParse(physicalAdapterIp, out var physAddr) && physAddr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var bytes = physAddr.GetAddressBytes();
            ips.PhysicalIpV4 = BitConverter.ToUInt32(bytes, 0);
        }

        // Parse IPv6 physical adapter address if available
        if (!string.IsNullOrEmpty(physicalAdapterIpV6) &&
            IPAddress.TryParse(physicalAdapterIpV6, out var physV6Addr) &&
            physV6Addr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            ips.PhysicalIpV6 = physV6Addr.GetAddressBytes();
            ips.HasV6 = true;
        }

        var buffer = StructToBytes(ips);
        return SendIoctl(IOCTL_ST_REGISTER_IP_ADDRESSES, buffer, out _);
    }

    public bool ClearConfiguration()
    {
        return SendIoctl(IOCTL_ST_CLEAR_CONFIGURATION, null, out _);
    }

    /// <summary>
    /// Query driver state as a binary ST_STATE struct.
    /// </summary>
    public DriverState? GetState()
    {
        var outputSize = Marshal.SizeOf<StState>();
        var outputBuffer = new byte[outputSize];

        if (!SendIoctl(IOCTL_ST_GET_STATE, null, out var bytesReturned, outputBuffer))
            return null;

        if (bytesReturned < outputSize) return null;

        var state = BytesToStruct<StState>(outputBuffer);
        return new DriverState
        {
            Initialized = state.Initialized,
            Mode = state.Mode == ST_MODE_INCLUDE ? "include" : "exclude",
            AppCount = (int)state.AppCount,
            ActiveFilterCount = (int)state.ActiveFilterCount,
            ClassifyCallCount = (int)state.ClassifyCallCount,
            ClassifyMatchCount = (int)state.ClassifyMatchCount,
            RedirectSuccessCount = (int)state.RedirectSuccessCount,
            RedirectErrorCount = (int)state.RedirectErrorCount,
            ClassifyCallCountV6 = (int)state.ClassifyCallCountV6,
            ClassifyMatchCountV6 = (int)state.ClassifyMatchCountV6,
            RedirectSuccessCountV6 = (int)state.RedirectSuccessCountV6,
            RedirectErrorCountV6 = (int)state.RedirectErrorCountV6,
        };
    }

    private bool SendIoctl(uint ioctlCode, byte[]? inputBuffer, out uint bytesReturned, byte[]? outputBuffer = null)
    {
        bytesReturned = 0;

        if (!IsConnected)
        {
            _logger.LogWarning("[DriverClient] Not connected, cannot send IOCTL 0x{Code:X8}", ioctlCode);
            return false;
        }

        var success = DeviceIoControl(
            _deviceHandle, ioctlCode,
            inputBuffer, (uint)(inputBuffer?.Length ?? 0),
            outputBuffer, (uint)(outputBuffer?.Length ?? 0),
            out bytesReturned, IntPtr.Zero);

        if (!success)
        {
            var error = Marshal.GetLastWin32Error();
            _logger.LogError("[DriverClient] IOCTL 0x{Code:X8} failed, error={Error}", ioctlCode, error);
        }

        return success;
    }

    private static byte[] StructToBytes<T>(T structure) where T : struct
    {
        int size = Marshal.SizeOf<T>();
        var buffer = new byte[size];
        var ptr = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(structure, ptr, false);
            Marshal.Copy(ptr, buffer, 0, size);
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
        return buffer;
    }

    private static T BytesToStruct<T>(byte[] buffer) where T : struct
    {
        var ptr = Marshal.AllocHGlobal(buffer.Length);
        try
        {
            Marshal.Copy(buffer, 0, ptr, buffer.Length);
            return Marshal.PtrToStructure<T>(ptr);
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    /// <summary>
    /// Convert a Win32 path (e.g. C:\Program Files\...) to the NT device path format
    /// (e.g. \Device\HarddiskVolume3\Program Files\...) that matches what the kernel's
    /// PsSetCreateProcessNotifyRoutineEx provides in ImageFileName.
    /// </summary>
    private string ConvertToNtPath(string win32Path)
    {
        if (string.IsNullOrEmpty(win32Path))
            return win32Path;

        // Already in NT format
        if (win32Path.StartsWith(@"\Device\"))
            return win32Path;

        // Reject UNC paths (\\server\share\...) — only local drives are valid for split tunneling
        if (win32Path.StartsWith(@"\\"))
        {
            _logger.LogWarning("[DriverClient] Rejecting UNC path: {Path}", win32Path);
            throw new ArgumentException($"UNC paths are not supported for split tunneling: {win32Path}");
        }

        // Resolve symlinks/junctions to real path before converting
        win32Path = Path.GetFullPath(win32Path);

        // Convert drive letter (C:\...) to NT device path (\Device\HarddiskVolume3\...)
        if (win32Path.Length >= 2 && win32Path[1] == ':')
        {
            string driveLetter = win32Path[..2]; // "C:"
            var sb = new StringBuilder(260);
            uint result = QueryDosDeviceW(driveLetter, sb, 260);
            if (result > 0)
            {
                // QueryDosDeviceW returns "\Device\HarddiskVolume3"
                string ntPrefix = sb.ToString();
                var ntPath = ntPrefix + win32Path[2..];
                _logger.LogInformation("[DriverClient] Path converted: {Win32} -> {Nt}", win32Path, ntPath);
                return ntPath;
            }
            _logger.LogWarning("[DriverClient] QueryDosDeviceW failed for {Drive}, falling back", driveLetter);
        }

        // Fallback: \??\ prefix (less reliable but better than raw Win32 path)
        var fallbackPath = @"\??\" + win32Path;
        _logger.LogInformation("[DriverClient] Path converted (fallback): {Win32} -> {Nt}", win32Path, fallbackPath);
        return fallbackPath;
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            Disconnect();
            _disposed = true;
        }
        GC.SuppressFinalize(this);
    }

    ~DriverClient() => Dispose();
}

/// <summary>
/// Driver state (user-friendly wrapper around StState)
/// </summary>
public class DriverState
{
    public bool Initialized { get; set; }
    public string Mode { get; set; } = "";
    public int AppCount { get; set; }
    public int ActiveFilterCount { get; set; }
    public int ClassifyCallCount { get; set; }
    public int ClassifyMatchCount { get; set; }
    public int RedirectSuccessCount { get; set; }
    public int RedirectErrorCount { get; set; }
    public int ClassifyCallCountV6 { get; set; }
    public int ClassifyMatchCountV6 { get; set; }
    public int RedirectSuccessCountV6 { get; set; }
    public int RedirectErrorCountV6 { get; set; }
}
