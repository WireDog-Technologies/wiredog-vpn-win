using System.Runtime.InteropServices;

namespace WireDog.Service.Tunnel;

/// <summary>
/// Entry point for /tunnel mode - runs the AmneziaWG tunnel service
/// This is called when the AmneziaWGTunnel$WireDog child service starts
/// </summary>
public static class TunnelServiceRunner
{
    // AWG WireGuardTunnelService takes config CONTENT (not a file path) as first arg
    [DllImport("tunnel.dll", EntryPoint = "WireGuardTunnelService", CallingConvention = CallingConvention.Cdecl, SetLastError = true)]
    private static extern bool WireGuardTunnelService(
        [MarshalAs(UnmanagedType.LPWStr)] string configContent,
        [MarshalAs(UnmanagedType.LPWStr)] string tunnelName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryW(string lpFileName);

    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "WireDog", "logs", "tunnel-child.log");

    private static void Log(string msg)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(LogPath, $"{DateTime.Now:HH:mm:ss.fff} {msg}\n");
        }
        catch { /* best-effort */ }
    }

    /// <summary>
    /// Run the tunnel service with the given config file path
    /// </summary>
    public static int Run(string configFile)
    {
        Log($"[INF] TunnelServiceRunner.Run started. ConfigFile={configFile}");
        try
        {
            if (!File.Exists(configFile))
            {
                Log($"[ERR] Config file not found: {configFile}");
                Console.Error.WriteLine($"Config file not found: {configFile}");
                return 1;
            }

            // Pre-load wintun.dll explicitly so tunnel.dll goroutines find it already loaded
            var exeDir = AppContext.BaseDirectory;
            var wintunPath = Path.Combine(exeDir, "wintun.dll");
            LoadLibraryW(wintunPath);

            // AWG expects config CONTENT as first parameter, not a file path
            var configContent = File.ReadAllText(configFile);
            Log($"[INF] Config content read ({configContent.Length} chars). Calling WireGuardTunnelService...");

            // AWG tunnel.dll is non-blocking: starts tunnel in background goroutines and returns.
            // Thread.Sleep keeps this process alive so those goroutines can run.
            var result = WireGuardTunnelService(configContent, "WireDog");
            var lastError = Marshal.GetLastWin32Error();

            Log($"[INF] WireGuardTunnelService returned: result={result}, LastWin32Error={lastError}");

            if (!result)
                return lastError != 0 ? lastError : 1;

            Log($"[INF] Tunnel started in background - blocking to keep process alive");
            System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
            return 0;
        }
        catch (Exception ex)
        {
            Log($"[ERR] Exception: {ex}");
            Console.Error.WriteLine($"Tunnel service error: {ex.Message}");
            return 1;
        }
    }
}
