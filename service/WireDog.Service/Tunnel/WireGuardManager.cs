using System.Net.NetworkInformation;
using WireDog.Service.Ipc;

namespace WireDog.Service.Tunnel;

/// <summary>
/// Result of a WireGuard connection
/// </summary>
public class ConnectResult
{
    public string AssignedIp { get; set; } = "";
    public int InterfaceIndex { get; set; }
}

/// <summary>
/// WireGuard connection statistics
/// </summary>
public class WireGuardStats
{
    public long BytesReceived { get; set; }
    public long BytesSent { get; set; }
}

/// <summary>
/// Manages WireGuard tunnel lifecycle using official tunnel.dll service
/// </summary>
public class WireGuardManager : IDisposable
{
    private readonly ILogger<WireGuardManager> _logger;
    private readonly ILoggerFactory _loggerFactory;
    private readonly string _tunnelName = "WireDog";
    private TunnelConfig? _currentConfig;
    private TunnelServiceManager? _tunnelService;
    private TunnelAdapter? _adapter;
    private bool _disposed;
    private CancellationTokenSource? _monitorCts;

    public bool IsConnected { get; private set; }
    public event EventHandler? ConnectionLost;

    public WireGuardManager(ILogger<WireGuardManager> logger, ILoggerFactory loggerFactory)
    {
        _logger = logger;
        _loggerFactory = loggerFactory;
        _logger.LogInformation("WireGuardManager initialized (tunnel.dll mode)");
    }

    /// <summary>
    /// Connect to VPN using WireGuard (tunnel.dll service)
    /// </summary>
    public async Task<ConnectResult> ConnectAsync(WireGuardConfigParams configParams, CancellationToken cancellationToken)
    {
        var config = TunnelConfig.FromParams(configParams);
        _currentConfig = config;

        _logger.LogInformation("Connecting to WireGuard tunnel (Endpoint: {Endpoint})", config.Endpoint);

        _tunnelService = new TunnelServiceManager(_loggerFactory.CreateLogger<TunnelServiceManager>());

        try
        {
            // Write config file
            var configPath = ConfigFileWriter.WriteConfig(config);
            _logger.LogDebug("Config file written to {Path}", configPath);

            // Add /32 host route for the VPN server endpoint before starting AWG.
            // AWG only adds this exception route automatically when AllowedIPs = 0.0.0.0/0.
            // With /1 pairs, the server IP falls inside the tunnel routes and AWG rebinds
            // its WireGuard UDP socket to the tunnel interface after route setup — causing
            // a loop where TX flows but no RX ever arrives.
            AddServerEndpointRoute(config.GetServerIp());

            // Start tunnel service
            if (!_tunnelService.InstallAndStart(configPath))
            {
                throw new InvalidOperationException("Failed to install/start tunnel service");
            }

            // Give the child service 1s to either crash or start running stably
            await Task.Delay(1000, cancellationToken);
            if (!_tunnelService.IsRunning(out int win32Exit, out int svcExit))
                _logger.LogWarning("[AWG] Child service stopped immediately — Win32ExitCode={Win32}, ServiceSpecificExitCode={Svc}. Check C:\\ProgramData\\WireDog\\logs\\tunnel-child.log for details.",
                    win32Exit, svcExit);

            // Wait for adapter to appear
            await WaitForAdapterAsync(cancellationToken);

            // AWG does not set static DNS on the tunnel interface — set it explicitly
            SetTunnelDns(config.Dns);

            // Open adapter for stats monitoring
            _adapter = new TunnelAdapter(_tunnelName, _loggerFactory.CreateLogger<TunnelAdapter>());
            if (!_adapter.Open())
            {
                _logger.LogWarning("Failed to open adapter for stats monitoring, continuing...");
            }

            // Wait for handshake
            await WaitForHandshakeAsync(cancellationToken);

            IsConnected = true;
            StartHealthMonitor();

            _logger.LogInformation("Connected to WireGuard tunnel (IP: {Ip})",
                config.GetAssignedIp());

            return new ConnectResult
            {
                AssignedIp = config.GetAssignedIp(),
                InterfaceIndex = 0  // Will be updated when we query the adapter
            };
        }
        catch (Exception)
        {
            // Clean up on failure
            RemoveServerEndpointRoute(config.GetServerIp());
            _tunnelService?.Stop();
            _adapter?.Dispose();
            _tunnelService = null;
            _adapter = null;
            throw;
        }
    }

    /// <summary>
    /// Disconnect from VPN
    /// </summary>
    public Task DisconnectAsync(CancellationToken cancellationToken)
    {
        _logger.LogInformation("Disconnecting WireGuard tunnel");

        StopHealthMonitor();
        _adapter?.Dispose();
        _tunnelService?.Stop();

        if (_currentConfig != null)
            RemoveServerEndpointRoute(_currentConfig.GetServerIp());

        ConfigFileWriter.DeleteConfig();

        _adapter = null;
        _tunnelService = null;
        _currentConfig = null;
        IsConnected = false;

        _logger.LogInformation("Disconnected from WireGuard tunnel");
        return Task.CompletedTask;
    }

    /// <summary>
    /// Get the interface index of the WireGuard tunnel
    /// </summary>
    public async Task<int> GetInterfaceIndexAsync(CancellationToken cancellationToken)
    {
        // Wait a bit for interface to be fully up
        await Task.Delay(500, cancellationToken);

        // Search by adapter name
        var interfaces = NetworkInterface.GetAllNetworkInterfaces();
        var wgInterface = interfaces.FirstOrDefault(i =>
            i.Name.Equals(_tunnelName, StringComparison.OrdinalIgnoreCase));

        if (wgInterface != null)
        {
            var props = wgInterface.GetIPProperties();
            if (props.GetIPv4Properties() != null)
            {
                return props.GetIPv4Properties().Index;
            }
        }

        _logger.LogWarning("Could not find WireGuard interface index");
        return 0;
    }

    /// <summary>
    /// Get connection statistics
    /// </summary>
    public Task<WireGuardStats> GetStatsAsync(CancellationToken cancellationToken)
    {
        if (!IsConnected || _adapter == null)
        {
            return Task.FromResult(new WireGuardStats());
        }

        try
        {
            // Get stats from tunnel adapter
            if (_adapter.ReadStats())
            {
                return Task.FromResult(new WireGuardStats
                {
                    BytesReceived = (long)_adapter.RxBytes,
                    BytesSent = (long)_adapter.TxBytes
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to get stats");
        }

        return Task.FromResult(new WireGuardStats());
    }

    /// <summary>
    /// Check WireGuard handshake status
    /// </summary>
    public Task<bool> CheckHandshakeStatusAsync(CancellationToken cancellationToken)
    {
        if (_adapter == null)
        {
            _logger.LogWarning("[HANDSHAKE] Adapter not initialized");
            return Task.FromResult(false);
        }

        try
        {
            if (_adapter.ReadStats())
            {
                if (_adapter.LastHandshake != null)
                {
                    var elapsed = DateTime.UtcNow - _adapter.LastHandshake.Value;
                    _logger.LogInformation("[HANDSHAKE] Last handshake: {Time} ({Elapsed} ago)",
                        _adapter.LastHandshake.Value, elapsed);
                    _logger.LogInformation("[HANDSHAKE] Stats - TX: {Tx}, RX: {Rx}",
                        FormatBytes(_adapter.TxBytes), FormatBytes(_adapter.RxBytes));

                    if (elapsed.TotalMinutes < 3)
                    {
                        _logger.LogInformation("[HANDSHAKE] ✓ Handshake SUCCESSFUL");
                        return Task.FromResult(true);
                    }
                }

                _logger.LogWarning("[HANDSHAKE] ✗ NO recent handshake detected");
                return Task.FromResult(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[HANDSHAKE] Failed to check handshake status");
        }

        return Task.FromResult(false);
    }

    /// <summary>
    /// Start background health monitor that checks adapter presence and handshake freshness
    /// </summary>
    private void StartHealthMonitor()
    {
        StopHealthMonitor();
        _monitorCts = new CancellationTokenSource();
        var token = _monitorCts.Token;
        _ = Task.Run(() => HealthMonitorLoopAsync(token), token);
        _logger.LogInformation("[HEALTH] Connection health monitor started");
    }

    /// <summary>
    /// Stop the health monitor (called on intentional disconnect)
    /// </summary>
    private void StopHealthMonitor()
    {
        if (_monitorCts != null)
        {
            _monitorCts.Cancel();
            _monitorCts.Dispose();
            _monitorCts = null;
            _logger.LogInformation("[HEALTH] Connection health monitor stopped");
        }
    }

    private async Task HealthMonitorLoopAsync(CancellationToken cancellationToken)
    {
        // Initial delay — let the connection stabilize before monitoring
        await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);

        int consecutiveFailures = 0;
        const int failureThreshold = 2; // Require 2 consecutive failures (10 seconds) to avoid false positives

        while (!cancellationToken.IsCancellationRequested && IsConnected)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);

                // Check 1: Does the adapter still exist?
                var interfaces = NetworkInterface.GetAllNetworkInterfaces();
                var adapterExists = interfaces.Any(i =>
                    i.Name.Equals(_tunnelName, StringComparison.OrdinalIgnoreCase) &&
                    i.OperationalStatus == OperationalStatus.Up);

                if (!adapterExists)
                {
                    consecutiveFailures++;
                    _logger.LogWarning("[HEALTH] Adapter not found or not up (failure {Count}/{Threshold})",
                        consecutiveFailures, failureThreshold);

                    if (consecutiveFailures >= failureThreshold)
                    {
                        _logger.LogError("[HEALTH] Adapter gone — firing ConnectionLost");
                        IsConnected = false;
                        ConnectionLost?.Invoke(this, EventArgs.Empty);
                        return;
                    }
                    continue;
                }

                // Check 2: Is the handshake still fresh? (WireGuard sends keepalives every ~25s)
                bool handshakeFresh = false;
                try
                {
                    if (_adapter != null && _adapter.ReadStats() && _adapter.LastHandshake != null)
                    {
                        var elapsed = DateTime.UtcNow - _adapter.LastHandshake.Value;
                        handshakeFresh = elapsed.TotalMinutes < 3;
                    }
                }
                catch
                {
                    // ReadStats can fail if adapter handle is stale
                }

                if (!handshakeFresh)
                {
                    consecutiveFailures++;
                    _logger.LogWarning("[HEALTH] Handshake stale (failure {Count}/{Threshold})",
                        consecutiveFailures, failureThreshold);

                    if (consecutiveFailures >= failureThreshold)
                    {
                        _logger.LogError("[HEALTH] Handshake stale too long — firing ConnectionLost");
                        IsConnected = false;
                        ConnectionLost?.Invoke(this, EventArgs.Empty);
                        return;
                    }
                    continue;
                }

                // All healthy — reset counter
                consecutiveFailures = 0;
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[HEALTH] Monitor check error");
            }
        }
    }

    private async Task WaitForAdapterAsync(CancellationToken cancellationToken)
    {
        var timeout = TimeSpan.FromSeconds(10);
        var start = DateTime.UtcNow;

        _logger.LogDebug("Waiting for network adapter to appear...");

        while (DateTime.UtcNow - start < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var interfaces = NetworkInterface.GetAllNetworkInterfaces();
            if (interfaces.Any(i => i.Name.Equals(_tunnelName, StringComparison.OrdinalIgnoreCase)))
            {
                _logger.LogDebug("Adapter appeared");
                return;
            }

            await Task.Delay(500, cancellationToken);
        }

        // Log all current interface names so we can see what the tunnel adapter is actually called
        var allNames = NetworkInterface.GetAllNetworkInterfaces()
            .Select(i => $"{i.Name} ({i.NetworkInterfaceType}, {i.OperationalStatus})")
            .ToArray();
        _logger.LogWarning("Adapter '{Name}' did not appear within timeout. All interfaces: [{Interfaces}]",
            _tunnelName, string.Join(", ", allNames));
    }

    private async Task WaitForHandshakeAsync(CancellationToken cancellationToken)
    {
        var timeout = TimeSpan.FromSeconds(15);
        var start = DateTime.UtcNow;

        _logger.LogDebug("Waiting for WireGuard handshake...");

        while (DateTime.UtcNow - start < timeout)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (_adapter != null && _adapter.ReadStats() && _adapter.LastHandshake != null)
            {
                var elapsed = DateTime.UtcNow - _adapter.LastHandshake.Value;
                if (elapsed.TotalMinutes < 3)
                {
                    _logger.LogDebug("Handshake confirmed");
                    return;
                }
            }

            await Task.Delay(500, cancellationToken);
        }

        // Don't throw - some servers may be slow, let the connection continue
        _logger.LogWarning("Handshake not confirmed within timeout, but continuing...");
    }

    private static string FormatBytes(ulong bytes)
    {
        string[] suffixes = { "B", "KiB", "MiB", "GiB", "TiB" };
        int suffixIndex = 0;
        double value = bytes;

        while (value >= 1024 && suffixIndex < suffixes.Length - 1)
        {
            value /= 1024;
            suffixIndex++;
        }

        return $"{value:F2} {suffixes[suffixIndex]}";
    }

    private void AddServerEndpointRoute(string serverIp)
    {
        var gateway = GetDefaultGateway();
        if (gateway == null)
        {
            _logger.LogWarning("[ROUTE] No default gateway found; skipping server endpoint route");
            return;
        }

        var psi = new System.Diagnostics.ProcessStartInfo("route",
            $"add {serverIp} mask 255.255.255.255 {gateway}")
        {
            CreateNoWindow = true,
            UseShellExecute = false
        };
        System.Diagnostics.Process.Start(psi)?.WaitForExit();
        _logger.LogInformation("[ROUTE] Added server endpoint route: {Ip}/32 via {Gw}", serverIp, gateway);
    }

    private void RemoveServerEndpointRoute(string serverIp)
    {
        var psi = new System.Diagnostics.ProcessStartInfo("route",
            $"delete {serverIp} mask 255.255.255.255")
        {
            CreateNoWindow = true,
            UseShellExecute = false
        };
        System.Diagnostics.Process.Start(psi)?.WaitForExit();
        _logger.LogInformation("[ROUTE] Removed server endpoint route: {Ip}/32", serverIp);
    }

    private string? GetDefaultGateway()
    {
        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up) continue;
            if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            if (ni.Name.Equals(_tunnelName, StringComparison.OrdinalIgnoreCase)) continue;

            foreach (var gw in ni.GetIPProperties().GatewayAddresses)
            {
                if (gw.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                    return gw.Address.ToString();
            }
        }
        return null;
    }

    private void SetTunnelDns(string dnsConfig)
    {
        if (string.IsNullOrWhiteSpace(dnsConfig))
            return;

        var servers = dnsConfig.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (servers.Length == 0)
            return;

        try
        {
            // Set primary DNS
            var psi = new System.Diagnostics.ProcessStartInfo("netsh",
                $"interface ip set dns name=\"{_tunnelName}\" source=static address={servers[0]} register=primary")
            {
                CreateNoWindow = true,
                UseShellExecute = false
            };
            System.Diagnostics.Process.Start(psi)?.WaitForExit();
            _logger.LogInformation("[DNS] Set primary DNS {Dns} on interface {Name}", servers[0], _tunnelName);

            // Add secondary servers
            for (int i = 1; i < servers.Length; i++)
            {
                psi = new System.Diagnostics.ProcessStartInfo("netsh",
                    $"interface ip add dns name=\"{_tunnelName}\" address={servers[i]} index={i + 1}")
                {
                    CreateNoWindow = true,
                    UseShellExecute = false
                };
                System.Diagnostics.Process.Start(psi)?.WaitForExit();
                _logger.LogInformation("[DNS] Added secondary DNS {Dns} on interface {Name}", servers[i], _tunnelName);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[DNS] Failed to set tunnel DNS");
        }
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        StopHealthMonitor();
        _adapter?.Dispose();
        _tunnelService?.Dispose();
        _disposed = true;
    }
}
