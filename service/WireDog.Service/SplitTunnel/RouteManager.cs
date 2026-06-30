using System.Diagnostics;
using System.Net;

namespace WireDog.Service.SplitTunnel;

/// <summary>
/// Manages Windows routing table entries for IP-based split tunneling.
/// Wraps 'route' (IPv4) and 'netsh interface ipv6' (IPv6) commands.
/// Tracks all managed routes for cleanup on disconnect.
/// </summary>
public class RouteManager
{
    private readonly ILogger<RouteManager> _logger;
    private readonly List<ManagedRoute> _managedRoutes = new();
    private readonly object _lock = new();

    public RouteManager(ILogger<RouteManager> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Add a route to the Windows routing table.
    /// </summary>
    /// <param name="destination">Destination IP or CIDR (e.g., "8.8.8.8" or "10.0.0.0/24")</param>
    /// <param name="gateway">Gateway IP address</param>
    /// <param name="interfaceIndex">Network interface index</param>
    /// <param name="metric">Route metric (lower = higher priority)</param>
    /// <returns>True if route was added successfully</returns>
    public bool AddRoute(string destination, string gateway, int interfaceIndex, int metric)
    {
        var parsed = ParseCidr(destination);
        if (parsed == null)
        {
            _logger.LogWarning("[RouteManager] Failed to parse destination: {Dest}", destination);
            return false;
        }

        var (ip, prefixLen, isIpv6) = parsed.Value;
        bool success;

        if (isIpv6)
        {
            success = RunIpv6RouteAdd(ip, prefixLen, gateway, interfaceIndex, metric);
        }
        else
        {
            success = RunIpv4RouteAdd(ip, prefixLen, gateway, interfaceIndex, metric);
        }

        if (success)
        {
            lock (_lock)
            {
                _managedRoutes.Add(new ManagedRoute
                {
                    Destination = ip,
                    PrefixLength = prefixLen,
                    Gateway = gateway,
                    InterfaceIndex = interfaceIndex,
                    IsIpv6 = isIpv6,
                });
            }
            _logger.LogInformation("[RouteManager] Added route: {Dest}/{Prefix} via {GW} if={IF} metric={Metric}",
                ip, prefixLen, gateway, interfaceIndex, metric);
        }

        return success;
    }

    /// <summary>
    /// Delete a specific route from the Windows routing table.
    /// </summary>
    public bool DeleteRoute(string destination, string gateway, int interfaceIndex, bool isIpv6)
    {
        var parsed = ParseCidr(destination);
        string ip = parsed?.ip ?? destination;
        int prefixLen = parsed?.prefixLen ?? (isIpv6 ? 128 : 32);

        bool success;
        if (isIpv6)
        {
            success = RunIpv6RouteDelete(ip, prefixLen, interfaceIndex);
        }
        else
        {
            success = RunIpv4RouteDelete(ip, prefixLen, gateway);
        }

        if (success)
        {
            _logger.LogInformation("[RouteManager] Deleted route: {Dest}/{Prefix}", ip, prefixLen);
        }

        return success;
    }

    /// <summary>
    /// Delete an IPv4 route by destination and interface index (no gateway needed).
    /// Used to remove WireGuard's routes where we don't know the exact gateway.
    /// </summary>
    public bool DeleteIpv4RouteByInterface(string destination, int prefixLen, int interfaceIndex)
    {
        string mask = PrefixLenToSubnetMask(prefixLen);
        return RunCommand("route", $"delete {destination} mask {mask} if {interfaceIndex}");
    }

    /// <summary>
    /// Remove all routes that were added by this manager.
    /// </summary>
    public void DeleteAllManagedRoutes()
    {
        List<ManagedRoute> routes;
        lock (_lock)
        {
            routes = new List<ManagedRoute>(_managedRoutes);
            _managedRoutes.Clear();
        }

        foreach (var route in routes)
        {
            try
            {
                if (route.IsIpv6)
                {
                    RunIpv6RouteDelete(route.Destination, route.PrefixLength, route.InterfaceIndex);
                }
                else
                {
                    RunIpv4RouteDelete(route.Destination, route.PrefixLength, route.Gateway);
                }

                _logger.LogInformation("[RouteManager] Cleaned up route: {Dest}/{Prefix}",
                    route.Destination, route.PrefixLength);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[RouteManager] Failed to clean up route: {Dest}/{Prefix}",
                    route.Destination, route.PrefixLength);
            }
        }

        _logger.LogInformation("[RouteManager] Cleaned up {Count} managed routes", routes.Count);
    }

    // ========== IPv4 Commands ==========

    private bool RunIpv4RouteAdd(string ip, int prefixLen, string gateway, int interfaceIndex, int metric)
    {
        string mask = PrefixLenToSubnetMask(prefixLen);
        return RunCommand("route", $"add {ip} mask {mask} {gateway} metric {metric} if {interfaceIndex}");
    }

    private bool RunIpv4RouteDelete(string ip, int prefixLen, string gateway)
    {
        string mask = PrefixLenToSubnetMask(prefixLen);
        return RunCommand("route", $"delete {ip} mask {mask} {gateway}");
    }

    // ========== IPv6 Commands ==========

    private bool RunIpv6RouteAdd(string ip, int prefixLen, string gateway, int interfaceIndex, int metric)
    {
        string prefix = $"{ip}/{prefixLen}";
        string args = $"interface ipv6 add route {prefix} interface={interfaceIndex} nexthop={gateway} metric={metric}";
        return RunCommand("netsh", args);
    }

    private bool RunIpv6RouteDelete(string ip, int prefixLen, int interfaceIndex)
    {
        string prefix = $"{ip}/{prefixLen}";
        string args = $"interface ipv6 delete route {prefix} interface={interfaceIndex}";
        return RunCommand("netsh", args);
    }

    // ========== Helpers ==========

    private bool RunCommand(string fileName, string arguments)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };

            using var process = Process.Start(psi);
            if (process == null)
            {
                _logger.LogError("[RouteManager] Failed to start process: {Cmd} {Args}", fileName, arguments);
                return false;
            }

            process.WaitForExit(5000);
            if (process.ExitCode != 0)
            {
                var stderr = process.StandardError.ReadToEnd().Trim();
                _logger.LogWarning("[RouteManager] Command failed (exit={Code}): {Cmd} {Args} — {Err}",
                    process.ExitCode, fileName, arguments, stderr);
                return false;
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[RouteManager] Exception running: {Cmd} {Args}", fileName, arguments);
            return false;
        }
    }

    /// <summary>
    /// Parse "ip" or "ip/prefix" into components. Returns null if invalid.
    /// </summary>
    private static (string ip, int prefixLen, bool isIpv6)? ParseCidr(string cidr)
    {
        var trimmed = cidr.Trim();
        bool isIpv6 = trimmed.Contains(':');

        int slashIdx = trimmed.IndexOf('/');
        string ipPart;
        int prefixLen;

        if (slashIdx >= 0)
        {
            ipPart = trimmed[..slashIdx];
            if (!int.TryParse(trimmed[(slashIdx + 1)..], out prefixLen))
                return null;
        }
        else
        {
            ipPart = trimmed;
            prefixLen = isIpv6 ? 128 : 32;
        }

        if (!IPAddress.TryParse(ipPart, out _))
            return null;

        return (ipPart, prefixLen, isIpv6);
    }

    /// <summary>
    /// Convert prefix length to dotted subnet mask (e.g., 24 → "255.255.255.0").
    /// </summary>
    private static string PrefixLenToSubnetMask(int prefixLen)
    {
        if (prefixLen <= 0) return "0.0.0.0";
        if (prefixLen >= 32) return "255.255.255.255";

        uint mask = ~((1u << (32 - prefixLen)) - 1);
        return $"{(mask >> 24) & 0xFF}.{(mask >> 16) & 0xFF}.{(mask >> 8) & 0xFF}.{mask & 0xFF}";
    }

    private class ManagedRoute
    {
        public string Destination { get; init; } = "";
        public int PrefixLength { get; init; }
        public string Gateway { get; init; } = "";
        public int InterfaceIndex { get; init; }
        public bool IsIpv6 { get; init; }
    }
}
