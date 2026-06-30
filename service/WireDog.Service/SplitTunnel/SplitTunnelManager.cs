using System.Net.NetworkInformation;
using System.Net.Sockets;
using WireDog.Service.Ipc;

namespace WireDog.Service.SplitTunnel;

/// <summary>
/// Manages split tunneling configuration.
/// - IP-based: Manipulates Windows routing table
/// - App-based: Communicates with callout driver via DriverClient
/// </summary>
public class SplitTunnelManager
{
    private const int INCLUDE_MODE_DEFAULT_ROUTE_METRIC = 9000;
    private const int INCLUDE_MODE_ROUTE_METRIC = 100;
    private const int EXCLUDE_MODE_ROUTE_METRIC = 5;

    private readonly ILogger<SplitTunnelManager> _logger;
    private readonly DriverClient _driverClient;
    private readonly RouteManager _routeManager;
    private bool _driverActive;
    private bool _ipRoutesActive;
    private int _physInterfaceIndex;

    public int PhysicalInterfaceIndex => _physInterfaceIndex;

    public void DumpDriverState()
    {
        try
        {
            if (!_driverClient.IsConnected)
            {
                _logger.LogWarning("[DIAG] Driver not connected");
                return;
            }

            var state = _driverClient.GetState();
            if (state == null)
            {
                _logger.LogWarning("[DIAG] Failed to query driver state");
                return;
            }

            _logger.LogInformation("[DIAG] Driver state: init={Init}, mode={Mode}, apps={Apps}, filters={Filters}, classify={Classify}, match={Match}, redirectOK={OK}, redirectErr={Err}",
                state.Initialized, state.Mode, state.AppCount, state.ActiveFilterCount,
                state.ClassifyCallCount, state.ClassifyMatchCount,
                state.RedirectSuccessCount, state.RedirectErrorCount);
            _logger.LogInformation("[DIAG] V6 counters: classifyV6={ClassifyV6}, matchV6={MatchV6}, redirectOK_V6={OKV6}, redirectErr_V6={ErrV6}",
                state.ClassifyCallCountV6, state.ClassifyMatchCountV6, state.RedirectSuccessCountV6, state.RedirectErrorCountV6);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[DIAG] Driver state dump failed");
        }
    }

    public SplitTunnelManager(ILogger<SplitTunnelManager> logger, DriverClient driverClient, RouteManager routeManager)
    {
        _logger = logger;
        _driverClient = driverClient;
        _routeManager = routeManager;
    }

    /// <summary>
    /// Check if IP-based split tunneling is configured.
    /// </summary>
    public bool HasIpRules(SplitTunnelingParams? splitTunneling)
    {
        return splitTunneling is { Enabled: true, Ips.Count: > 0 };
    }

    /// <summary>
    /// Check if app-based split tunneling is configured.
    /// </summary>
    public bool HasAppRules(SplitTunnelingParams? splitTunneling)
    {
        return splitTunneling is { Enabled: true, Apps.Count: > 0 };
    }

    /// <summary>
    /// Enable app-based split tunneling via the callout driver.
    /// Call after WireGuard tunnel is established.
    /// The driver creates per-app WFP filters using FWPM_CONDITION_ALE_APP_ID
    /// so only matched apps trigger the redirect callout.
    /// </summary>
    public bool EnableAppSplitTunneling(SplitTunnelingParams splitTunneling, string tunnelIp, string physicalAdapterIp, string? physicalAdapterIpV6 = null, int tunnelInterfaceIndex = 0)
    {
        if (!HasAppRules(splitTunneling))
            return false;

        _logger.LogInformation("[SplitTunnel] Enabling app-based split tunneling: mode={Mode}, {Count} apps",
            splitTunneling.Mode, splitTunneling.Apps.Count);

        if (!_driverClient.Connect())
        {
            _logger.LogError("[SplitTunnel] Failed to connect to callout driver. Is the driver installed?");
            return false;
        }

        if (!_driverClient.Initialize())
        {
            _logger.LogError("[SplitTunnel] Failed to initialize driver");
            _driverClient.Disconnect();
            return false;
        }

        // Get the physical interface index for AUTH filters
        var (_, _, physIfIndex) = GetAdapterInfo(physicalAdapterIp);
        _physInterfaceIndex = physIfIndex;
        _logger.LogInformation("[SplitTunnel] Physical interface index for driver: {IfIndex}", physIfIndex);
        _logger.LogInformation("[SplitTunnel] Tunnel interface index for driver: {IfIndex}", tunnelInterfaceIndex);

        // Register IPs first so the driver knows where to redirect
        if (!_driverClient.RegisterIpAddresses(tunnelIp, physicalAdapterIp, physicalAdapterIpV6, (uint)physIfIndex, (uint)tunnelInterfaceIndex))
        {
            _logger.LogError("[SplitTunnel] Failed to register IP addresses with driver");
            _driverClient.ClearConfiguration();
            _driverClient.Disconnect();
            return false;
        }

        // Set configuration (mode + app paths) — this triggers per-app WFP filter creation in the driver
        var appPaths = splitTunneling.Apps.Select(a => a.ExePath).ToList();

        // In include mode, automatically include svchost.exe so the Windows DNS Client service
        // stays on the tunnel. Without this, DNS queries get redirected to physical and either
        // leak to ISP (if DNS leak protection is off) or fail entirely (if it's on).
        if (splitTunneling.Mode == "include")
        {
            var svchostPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "svchost.exe");
            if (!appPaths.Any(p => p.Equals(svchostPath, StringComparison.OrdinalIgnoreCase)))
            {
                _logger.LogInformation("[SplitTunnel] Include mode: auto-adding svchost.exe for DNS protection ({Path})", svchostPath);
                appPaths.Add(svchostPath);
            }
        }
        foreach (var path in appPaths)
        {
            _logger.LogInformation("[SplitTunnel] App path (Win32): {Path}", path);
        }
        if (!_driverClient.SetConfiguration(splitTunneling.Mode, appPaths))
        {
            _logger.LogError("[SplitTunnel] Failed to set driver configuration");
            _driverClient.ClearConfiguration();
            _driverClient.Disconnect();
            return false;
        }

        _driverActive = true;
        _logger.LogInformation("[SplitTunnel] App-based split tunneling enabled successfully");

        // Diagnostic: log driver state
        DumpDriverState();

        return true;
    }

    /// <summary>
    /// Disable app-based split tunneling (call on VPN disconnect).
    /// </summary>
    public void DisableAppSplitTunneling()
    {
        if (!_driverActive) return;

        _logger.LogInformation("[SplitTunnel] Disabling app-based split tunneling");

        // Dump driver state before cleanup so we can see redirect counters after browsing
        DumpDriverState();

        try
        {
            if (_driverClient.IsConnected)
            {
                _driverClient.ClearConfiguration();
                _driverClient.Disconnect();
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[SplitTunnel] Error during driver cleanup");
        }

        _driverActive = false;
    }

    /// <summary>
    /// Enable IP-based split tunneling by manipulating the Windows routing table.
    /// Call after WireGuard tunnel is established.
    /// - Exclude mode: Add routes for excluded IPs through the physical adapter gateway
    /// - Include mode: Lower WireGuard default route priority, add specific routes for included IPs through tunnel
    /// </summary>
    public bool EnableIpSplitTunneling(
        SplitTunnelingParams splitTunneling,
        string physicalAdapterIp,
        int tunnelInterfaceIndex,
        string tunnelGatewayIp,
        string? tunnelGatewayIpV6 = null)
    {
        if (!HasIpRules(splitTunneling))
            return false;

        _logger.LogInformation("[SplitTunnel] Enabling IP-based split tunneling: mode={Mode}, {Count} IPs",
            splitTunneling.Mode, splitTunneling.Ips.Count);

        // Get physical adapter gateway and interface index
        var (physGateway, physGatewayV6, physIfIndex) = GetAdapterInfo(physicalAdapterIp);
        _physInterfaceIndex = physIfIndex;

        if (physGateway == null)
        {
            _logger.LogError("[SplitTunnel] Could not determine physical adapter gateway for IP routing");
            return false;
        }

        _logger.LogInformation("[SplitTunnel] Physical: gateway={GW}, gatewayV6={GWv6}, ifIndex={IF}",
            physGateway, physGatewayV6 ?? "none", physIfIndex);
        _logger.LogInformation("[SplitTunnel] Tunnel: ifIndex={IF}, gatewayIp={GW}",
            tunnelInterfaceIndex, tunnelGatewayIp);

        if (splitTunneling.Mode == "exclude")
        {
            EnableExcludeModeRoutes(splitTunneling.Ips, physGateway, physGatewayV6, physIfIndex);
        }
        else // include
        {
            EnableIncludeModeRoutes(splitTunneling.Ips, tunnelInterfaceIndex, tunnelGatewayIp, tunnelGatewayIpV6);
        }

        _ipRoutesActive = true;
        _logger.LogInformation("[SplitTunnel] IP-based split tunneling enabled successfully");
        return true;
    }

    /// <summary>
    /// Disable IP-based split tunneling (clean up routes).
    /// </summary>
    public void DisableIpSplitTunneling()
    {
        if (!_ipRoutesActive) return;

        _logger.LogInformation("[SplitTunnel] Disabling IP-based split tunneling (cleaning up routes)");
        _routeManager.DeleteAllManagedRoutes();
        _ipRoutesActive = false;
    }

    /// <summary>
    /// Exclude mode: Add routes for each excluded IP through the physical adapter.
    /// Traffic to these IPs will bypass the VPN tunnel.
    /// </summary>
    private void EnableExcludeModeRoutes(List<string> ips, string physGateway, string? physGatewayV6, int physIfIndex)
    {
        foreach (var ip in ips)
        {
            var trimmed = ip.Trim();
            if (string.IsNullOrEmpty(trimmed)) continue;

            bool isIpv6 = trimmed.Contains(':');
            if (isIpv6)
            {
                if (physGatewayV6 != null)
                {
                    _routeManager.AddRoute(trimmed, physGatewayV6, physIfIndex, EXCLUDE_MODE_ROUTE_METRIC);
                }
                else
                {
                    _logger.LogWarning("[SplitTunnel] Skipping IPv6 excluded IP {IP} — no physical IPv6 gateway", trimmed);
                }
            }
            else
            {
                _routeManager.AddRoute(trimmed, physGateway, physIfIndex, EXCLUDE_MODE_ROUTE_METRIC);
            }
        }
    }

    /// <summary>
    /// Include mode:
    ///   1. Delete WireGuard's /1 routes
    ///   2. Re-add 0.0.0.0/0 through tunnel with high metric (fallback)
    ///   3. Add specific routes for included IPs through tunnel
    /// The driver (when active) binds included apps to the tunnel IP, so strong host
    /// model routes their traffic through the tunnel interface regardless of /1 routes.
    /// Non-included traffic (including ICMP/tracert) follows routing → physical /0 wins.
    /// </summary>
    private void EnableIncludeModeRoutes(List<string> ips, int tunnelIfIndex, string tunnelGatewayIp, string? tunnelGatewayIpV6)
    {
        // Delete /1 routes so physical adapter's /0 wins for general traffic.
        // When app rules are active, the driver explicitly binds included apps to the tunnel IP,
        // so strong host model forces their traffic through the tunnel interface — /1 routes not needed.
        _logger.LogInformation("[SplitTunnel] Include mode: removing WireGuard catch-all /1 routes");

        _routeManager.DeleteIpv4RouteByInterface("0.0.0.0", 1, tunnelIfIndex);
        _routeManager.DeleteIpv4RouteByInterface("128.0.0.0", 1, tunnelIfIndex);

        if (tunnelGatewayIpV6 != null)
        {
            _routeManager.DeleteRoute("::/1", tunnelGatewayIpV6, tunnelIfIndex, isIpv6: true);
            _routeManager.DeleteRoute("8000::/1", tunnelGatewayIpV6, tunnelIfIndex, isIpv6: true);
        }

        // Re-add default route through tunnel with HIGH metric (low priority fallback).
        _logger.LogInformation("[SplitTunnel] Include mode: re-adding default route through tunnel with metric {Metric}",
            INCLUDE_MODE_DEFAULT_ROUTE_METRIC);

        _routeManager.AddRoute("0.0.0.0/0", tunnelGatewayIp, tunnelIfIndex, INCLUDE_MODE_DEFAULT_ROUTE_METRIC);

        if (tunnelGatewayIpV6 != null)
        {
            _routeManager.AddRoute("::/0", tunnelGatewayIpV6, tunnelIfIndex, INCLUDE_MODE_DEFAULT_ROUTE_METRIC);
        }

        // Add specific routes for each included IP through the tunnel.
        // These are more specific than /1 (and /0), so they always win.
        foreach (var ip in ips)
        {
            var trimmed = ip.Trim();
            if (string.IsNullOrEmpty(trimmed)) continue;

            bool isIpv6 = trimmed.Contains(':');
            string gateway = (isIpv6 && tunnelGatewayIpV6 != null) ? tunnelGatewayIpV6 : tunnelGatewayIp;
            _routeManager.AddRoute(trimmed, gateway, tunnelIfIndex, INCLUDE_MODE_ROUTE_METRIC);
        }
    }

    /// <summary>
    /// Get the current driver state (for diagnostics).
    /// </summary>
    public DriverState? GetDriverState()
    {
        if (!_driverClient.IsConnected) return null;
        return _driverClient.GetState();
    }

    /// <summary>
    /// Find the gateway and interface index for an adapter by its IP address.
    /// </summary>
    private (string? gateway, string? gatewayV6, int ifIndex) GetAdapterInfo(string adapterIp, bool isWireGuard = false)
    {
        var interfaces = NetworkInterface.GetAllNetworkInterfaces();
        foreach (var iface in interfaces)
        {
            if (iface.OperationalStatus != OperationalStatus.Up)
                continue;
            if (iface.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                continue;

            bool isWg = iface.Name.Contains("WireGuard", StringComparison.OrdinalIgnoreCase) ||
                        iface.Description.Contains("WireGuard", StringComparison.OrdinalIgnoreCase);

            if (isWireGuard != isWg)
                continue;

            var props = iface.GetIPProperties();

            bool hasMatchingIp = props.UnicastAddresses.Any(a =>
                a.Address.AddressFamily == AddressFamily.InterNetwork &&
                a.Address.ToString() == adapterIp);

            if (!hasMatchingIp)
                continue;

            var gateway = props.GatewayAddresses
                .FirstOrDefault(g => g.Address.AddressFamily == AddressFamily.InterNetwork)?
                .Address.ToString();

            var gatewayV6 = props.GatewayAddresses
                .FirstOrDefault(g => g.Address.AddressFamily == AddressFamily.InterNetworkV6)?
                .Address.ToString();

            var ipv4Props = props.GetIPv4Properties();
            return (gateway, gatewayV6, ipv4Props.Index);
        }

        return (null, null, 0);
    }
}
